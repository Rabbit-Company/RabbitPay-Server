import type { SQL } from "bun";
import Database from "../database/database";
import { Logger } from "../logger";
import { convertMinor } from "../invoicing";
import { SETTLED_PAYMENT_STATUSES } from "../payments/ledger";
import { fiscalParts } from "../invoice-numbers";
import { openCredentials } from "../furs/credentials";
import { FursRejected, FursUnavailable, fursEndpoint, submitInvoice, type FiscalInvoice, type TaxesPerSeller } from "../furs/client";
import { fursTime, protectedId, verificationCode } from "../furs/zoi";
import { activeFiscal, FISCAL_PROCESSORS, isFiscalCountry, placeFor, type ActiveFiscal, type FiscalPlace } from "./config";
import { projectOwnerIssuer, resolveInvoiceIssuer } from "../invoice-issuer";
import type { CreditNoteItemRow, CreditNoteRow, FiscalDocumentRow, InvoiceItemRow, InvoiceRow, ProjectRow } from "../database/models";

export const RETRY_BASE_SECONDS = 30;
export const RETRY_CAP_SECONDS = 1800;
const IMMEDIATE_WINDOW_MS = 60 * 60 * 1000;
const LEASE_MS = 2 * 60 * 1000;
const BATCH_SIZE = 20;

export function retryDelay(attempts: number): number {
	return Math.min(RETRY_BASE_SECONDS * Math.pow(2, Math.max(attempts - 1, 0)), RETRY_CAP_SECONDS) * 1000;
}

export function workingDaysAfter(timestamp: number, days: number): number {
	const date = new Date(timestamp);
	let remaining = days;
	while (remaining > 0) {
		date.setUTCDate(date.getUTCDate() + 1);
		const weekday = date.getUTCDay();
		if (weekday !== 0 && weekday !== 6) remaining--;
	}
	date.setUTCHours(21, 59, 59, 0);
	return date.getTime();
}

interface TaxLine {
	rate: number;
	treatment: string | null;
	net: number;
	tax: number;
}

type Euro = (amount: number) => number;

function euroConverter(document: { currency: string }, invoice: InvoiceRow): Euro | null {
	if (document.currency === "EUR") return (amount) => amount;
	if (invoice.tax_currency === "EUR" && invoice.tax_exchange_rate !== null) {
		const rate = invoice.tax_exchange_rate;
		return (amount) => convertMinor(amount, document.currency, rate, "EUR");
	}
	return null;
}

function major(minor: number): number {
	return Math.round(minor) / 100;
}

export function taxesFor(lines: TaxLine[], vatStatus: string | null, euro: Euro): TaxesPerSeller {
	const vat = new Map<number, { net: number; tax: number }>();
	let exempt = 0;
	let reverse = 0;
	let nontaxable = 0;
	let special = 0;
	const registered = vatStatus !== "small_business" && vatStatus !== "not_registered";

	for (const line of lines) {
		if (!registered) {
			nontaxable += line.net + line.tax;
			continue;
		}
		switch (line.treatment) {
			case "reverse_charge":
				reverse += line.net;
				break;
			case "exempt":
			case "export":
			case "intra_eu_goods":
				exempt += line.net;
				break;
			case "outside_scope":
				nontaxable += line.net;
				break;
			case "oss":
				special += line.net + line.tax;
				break;
			default: {
				const current = vat.get(line.rate) ?? { net: 0, tax: 0 };
				current.net += line.net;
				current.tax += line.tax;
				vat.set(line.rate, current);
			}
		}
	}

	const taxes: TaxesPerSeller = {};
	if (vat.size > 0) {
		taxes.VAT = [...vat.entries()]
			.sort(([a], [b]) => b - a)
			.map(([rate, amounts]) => ({ TaxRate: rate, TaxableAmount: major(euro(amounts.net)), TaxAmount: major(euro(amounts.tax)) }));
	}
	if (exempt !== 0) taxes.ExemptVATTaxableAmount = major(euro(exempt));
	if (reverse !== 0) taxes.ReverseVATTaxableAmount = major(euro(reverse));
	if (nontaxable !== 0) taxes.NontaxableAmount = major(euro(nontaxable));
	if (special !== 0) taxes.SpecialTaxRulesAmount = major(euro(special));
	return taxes;
}

export function identifierFor(reference: string, fallback: FiscalPlace): { premise: string; device: string; number: string } {
	const parts = fiscalParts(reference);
	if (parts) return parts;
	return { premise: fallback.premise, device: fallback.device, number: reference.slice(0, 20) };
}

interface Prepared {
	identifier: { premise: string; device: string; number: string };
	amount: number;
	operator: FiscalOperator;
	payload: FiscalInvoice;
}

export interface FiscalOperator {
	name: string | null;
	taxNumber: number | null;
}

export async function fiscalOperator(sql: SQL, projectId: string, username: string | null, fallbackTaxNumber: number | null): Promise<FiscalOperator> {
	const person = username ?? (await projectOwnerIssuer(sql, projectId))?.username ?? null;
	if (!person) return { name: null, taxNumber: fallbackTaxNumber };
	const issuer = await resolveInvoiceIssuer(sql, projectId, person);
	const [row] = (await sql`SELECT tax_number FROM fiscal_operators WHERE project = ${projectId} AND username = ${person}`) as { tax_number: number }[];
	return { name: issuer?.name ?? person, taxNumber: row ? Number(row.tax_number) : fallbackTaxNumber };
}

function prepare(
	fiscal: ActiveFiscal,
	credentials: ReturnType<typeof openCredentials>,
	identifier: { premise: string; device: string; number: string },
	issuedAt: number,
	amountEur: number,
	taxes: TaxesPerSeller,
	operator: FiscalOperator,
	extra: Partial<FiscalInvoice>
): Prepared {
	const zoi = protectedId(credentials.privateKey, {
		taxNumber: fiscal.taxNumber,
		issuedAt,
		invoiceNumber: identifier.number,
		premise: identifier.premise,
		device: identifier.device,
		amount: amountEur,
	});
	const payload: FiscalInvoice = {
		TaxNumber: fiscal.taxNumber,
		IssueDateTime: fursTime(issuedAt).iso,
		NumberingStructure: "B",
		InvoiceIdentifier: { BusinessPremiseID: identifier.premise, ElectronicDeviceID: identifier.device, InvoiceNumber: identifier.number },
		InvoiceAmount: major(amountEur),
		PaymentAmount: major(amountEur),
		TaxesPerSeller: [taxes],
		...(operator.taxNumber ? { OperatorTaxNumber: operator.taxNumber } : {}),
		ProtectedID: zoi,
		...extra,
	};
	return { identifier, amount: amountEur, operator, payload };
}

async function insertDocument(
	sql: SQL,
	projectId: string,
	fiscal: ActiveFiscal,
	target: { invoice: string | null; creditNote: string | null },
	issuedAt: number,
	deadline: number,
	prepared: Prepared
) {
	const timestamp = Date.now();
	await sql`
		INSERT INTO fiscal_documents(uuid, project, invoice, credit_note, environment, premise_id, device_id, invoice_number, issued_at, tax_number,
			amount, zoi, status, payload, attempts, subsequent, next_attempt_at, deadline, operator_name, operator_tax_number, created, updated)
		VALUES(${crypto.randomUUID()}, ${projectId}, ${target.invoice}, ${target.creditNote}, ${fiscal.settings.environment}, ${prepared.identifier.premise},
			${prepared.identifier.device}, ${prepared.identifier.number}, ${issuedAt}, ${fiscal.taxNumber}, ${prepared.amount}, ${prepared.payload.ProtectedID},
			'pending', ${JSON.stringify(prepared.payload)}, 0, 0, ${timestamp}, ${deadline}, ${prepared.operator.name}, ${prepared.operator.taxNumber},
			${timestamp}, ${timestamp})
	`;
}

export async function queueInvoiceVerification(sql: SQL, invoiceId: string, paidAt = Date.now()): Promise<boolean> {
	const [invoice] = (await sql`SELECT * FROM invoices WHERE uuid = ${invoiceId}`) as InvoiceRow[];
	if (!invoice || invoice.issued_at === null || invoice.status === "draft") return false;

	const [project] = (await sql`SELECT * FROM projects WHERE uuid = ${invoice.project}`) as ProjectRow[];
	if (!project || !isFiscalCountry(project)) return false;

	const [existing] = (await sql`SELECT uuid FROM fiscal_documents WHERE invoice = ${invoiceId}`) as { uuid: string }[];
	if (existing) return false;

	const payments = (await sql`
		SELECT processor FROM transactions
		WHERE invoice = ${invoiceId} AND type = 'payment' AND status IN ${sql(SETTLED_PAYMENT_STATUSES)}
	`) as { processor: string }[];
	if (!payments.some((payment) => FISCAL_PROCESSORS.has(payment.processor))) return false;

	const fiscal = await activeFiscal(sql, project);
	if (!fiscal) return false;

	const euro = euroConverter(invoice, invoice);
	if (!euro) {
		Logger.warn(`[FURS] ${invoice.reference} on ${project.uuid} has no euro rate, so it cannot be sent to FURS`);
		return false;
	}

	const channel = invoice.source === "pos" ? "pos" : "invoice";
	const identifier = identifierFor(invoice.reference, placeFor(fiscal.settings, channel)!);
	const items = (await sql`SELECT * FROM invoice_items WHERE invoice = ${invoiceId} ORDER BY sort_order ASC`) as InvoiceItemRow[];
	const lines = items.map((item) => ({
		rate: item.tax_rate,
		treatment: item.tax_treatment,
		net: item.total_price - item.discount_amount,
		tax: item.tax_amount,
	}));
	const buyerVat = invoice.buyer_vat_number?.replace(/\s/g, "").slice(0, 20) || null;

	const credentials = openCredentials(fiscal.settings.certificate!);
	const operator = await fiscalOperator(sql, project.uuid, invoice.created_by, fiscal.settings.operator_tax_number);
	const prepared = prepare(
		fiscal,
		credentials,
		identifier,
		invoice.issued_at,
		euro(invoice.total_amount),
		taxesFor(lines, project.vat_status, euro),
		operator,
		{
			...(buyerVat ? { CustomerVATNumber: buyerVat } : {}),
		}
	);
	const immediate = paidAt - invoice.issued_at <= IMMEDIATE_WINDOW_MS;
	await insertDocument(
		sql,
		project.uuid,
		fiscal,
		{ invoice: invoiceId, creditNote: null },
		invoice.issued_at,
		workingDaysAfter(paidAt, immediate ? 2 : 10),
		prepared
	);
	return true;
}

export async function fiscalPlaceForCredit(sql: SQL, invoiceId: string): Promise<{ environment: string; premise: string; device: string } | null> {
	const [document] = (await sql`SELECT environment, premise_id, device_id FROM fiscal_documents WHERE invoice = ${invoiceId}`) as Pick<
		FiscalDocumentRow,
		"environment" | "premise_id" | "device_id"
	>[];
	return document ? { environment: document.environment, premise: document.premise_id, device: document.device_id } : null;
}

export async function queueCreditNoteVerification(sql: SQL, note: CreditNoteRow, invoice: InvoiceRow): Promise<boolean> {
	const [original] = (await sql`SELECT * FROM fiscal_documents WHERE invoice = ${invoice.uuid}`) as FiscalDocumentRow[];
	if (!original || original.status === "rejected") return false;

	const [project] = (await sql`SELECT * FROM projects WHERE uuid = ${note.project}`) as ProjectRow[];
	const fiscal = project ? await activeFiscal(sql, project) : null;
	if (!project || !fiscal) return false;

	const euro = euroConverter(note, invoice);
	if (!euro) return false;

	const identifier = identifierFor(note.reference, { premise: original.premise_id, device: original.device_id });
	const items = (await sql`SELECT * FROM credit_note_items WHERE credit_note = ${note.uuid} ORDER BY sort_order ASC`) as CreditNoteItemRow[];
	const lines = items.map((item) => ({ rate: item.tax_rate, treatment: item.tax_treatment, net: -item.net_amount, tax: -item.tax_amount }));

	const credentials = openCredentials(fiscal.settings.certificate!);
	const operator = await fiscalOperator(sql, project.uuid, note.created_by, fiscal.settings.operator_tax_number);
	const prepared = prepare(fiscal, credentials, identifier, note.issued_at, -euro(note.total_amount), taxesFor(lines, project.vat_status, euro), operator, {
		ReferenceInvoice: [
			{
				ReferenceInvoiceIdentifier: { BusinessPremiseID: original.premise_id, ElectronicDeviceID: original.device_id, InvoiceNumber: original.invoice_number },
				ReferenceInvoiceIssueDateTime: fursTime(original.issued_at).iso,
			},
		],
	});
	await insertDocument(sql, project.uuid, fiscal, { invoice: null, creditNote: note.uuid }, note.issued_at, workingDaysAfter(note.issued_at, 2), prepared);
	return true;
}

async function claim(document: FiscalDocumentRow, now: number): Promise<boolean> {
	const claimed = await Database`
		UPDATE fiscal_documents SET next_attempt_at = ${now + LEASE_MS}, updated = ${now}
		WHERE uuid = ${document.uuid} AND status = 'pending' AND attempts = ${document.attempts}
			AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
	`;
	return claimed.count > 0;
}

export async function submitDocument(document: FiscalDocumentRow, now = Date.now(), timeoutMs?: number): Promise<FiscalDocumentRow> {
	if (document.status !== "pending" || !(await claim(document, now))) return (await findFiscalDocument(document.uuid)) ?? document;

	const attempts = document.attempts + 1;
	try {
		const [settings] = (await Database`SELECT certificate FROM fiscal_settings WHERE project = ${document.project}`) as { certificate: string | null }[];
		if (!settings?.certificate) throw new FursUnavailable("The FURS certificate for this project was removed.");
		const credentials = openCredentials(settings.certificate);
		const payload = JSON.parse(document.payload) as FiscalInvoice;
		if (document.subsequent === 1) payload.SubsequentSubmit = true;

		const receipt = await submitInvoice(fursEndpoint(document.environment), credentials, payload, timeoutMs);
		const timestamp = Date.now();
		await Database`
			UPDATE fiscal_documents SET status = 'verified', eor = ${receipt.eor}, message_id = ${receipt.header.MessageID}, attempts = ${attempts},
				next_attempt_at = NULL, error_code = NULL, last_error = NULL, verified_at = ${timestamp}, updated = ${timestamp}
			WHERE uuid = ${document.uuid}
		`;
		Logger.info(`[FURS] Verified ${document.premise_id}-${document.device_id}-${document.invoice_number} with EOR ${receipt.eor}`);
		await storeVerifiedCopy(document.uuid);
	} catch (err) {
		const timestamp = Date.now();
		if (err instanceof FursRejected) {
			await Database`
				UPDATE fiscal_documents SET status = 'rejected', attempts = ${attempts}, next_attempt_at = NULL, error_code = ${err.code},
					last_error = ${err.message.slice(0, 500)}, updated = ${timestamp}
				WHERE uuid = ${document.uuid}
			`;
			Logger.error(`[FURS] Rejected ${document.premise_id}-${document.device_id}-${document.invoice_number}: ${err.code} ${err.message}`);
		} else {
			const reason = err instanceof Error ? err.message : String(err);
			await Database`
				UPDATE fiscal_documents SET attempts = ${attempts}, subsequent = 1, next_attempt_at = ${timestamp + retryDelay(attempts)},
					last_error = ${reason.slice(0, 500)}, updated = ${timestamp}
				WHERE uuid = ${document.uuid}
			`;
			Logger.warn(`[FURS] ${document.premise_id}-${document.device_id}-${document.invoice_number} waits for FURS: ${reason}`);
		}
	}
	return (await findFiscalDocument(document.uuid))!;
}

async function storeVerifiedCopy(uuid: string) {
	try {
		const { archiveVerifiedCopy } = await import("./archive");
		const verified = await findFiscalDocument(uuid);
		if (verified) await archiveVerifiedCopy(verified);
	} catch (err) {
		Logger.warn(`[DOCUMENTS] The verified copy of ${uuid} will be archived on the next run: ${err}`);
	}
}

export async function findFiscalDocument(uuid: string): Promise<FiscalDocumentRow | null> {
	const [row] = (await Database`SELECT * FROM fiscal_documents WHERE uuid = ${uuid}`) as FiscalDocumentRow[];
	return row ?? null;
}

export async function fiscalDocumentFor(target: { invoice?: string; creditNote?: string }): Promise<FiscalDocumentRow | null> {
	const [row] = (
		target.invoice
			? await Database`SELECT * FROM fiscal_documents WHERE invoice = ${target.invoice}`
			: await Database`SELECT * FROM fiscal_documents WHERE credit_note = ${target.creditNote!}`
	) as FiscalDocumentRow[];
	return row ?? null;
}

export async function submitNow(target: { invoice?: string; creditNote?: string }, timeoutMs = 5000): Promise<FiscalDocumentRow | null> {
	const document = await fiscalDocumentFor(target);
	if (!document || document.status !== "pending") return document;
	return await submitDocument(document, Date.now(), timeoutMs);
}

let submitting: Promise<{ attempted: number; verified: number }> | null = null;

export function submitFiscalSoon() {
	setTimeout(() => {
		void submitPendingDocuments().catch((err) => Logger.error(`[FURS] Sending failed: ${err}`));
	}, 250).unref?.();
}

export async function submitPendingDocuments(now = Date.now()): Promise<{ attempted: number; verified: number }> {
	if (submitting) return await submitting;
	submitting = submitBatch(now);
	try {
		return await submitting;
	} finally {
		submitting = null;
	}
}

async function submitBatch(now: number): Promise<{ attempted: number; verified: number }> {
	const due = (await Database`
		SELECT * FROM fiscal_documents WHERE status = 'pending' AND next_attempt_at <= ${now}
		ORDER BY issued_at ASC LIMIT ${BATCH_SIZE}
	`) as FiscalDocumentRow[];

	let verified = 0;
	for (const document of due) {
		const result = await submitDocument(document, now);
		if (result.status === "verified") verified++;
	}
	return { attempted: due.length, verified };
}

export async function retryDocument(uuid: string): Promise<FiscalDocumentRow | null> {
	const timestamp = Date.now();
	await Database`
		UPDATE fiscal_documents SET status = 'pending', next_attempt_at = ${timestamp}, error_code = NULL, alerted = NULL, updated = ${timestamp}
		WHERE uuid = ${uuid} AND status IN ('pending', 'rejected')
	`;
	const document = await findFiscalDocument(uuid);
	return document ? await submitDocument(document, timestamp) : null;
}

export interface FiscalMarks {
	operator: string | null;
	zoi: string;
	eor: string | null;
	status: FiscalDocumentRow["status"];
	environment: FiscalDocumentRow["environment"];
	issued: string;
	issued_iso: string;
	code: string;
}

export async function fiscalMarks(target: { invoice?: string; creditNote?: string }): Promise<FiscalMarks | null> {
	const document = await fiscalDocumentFor(target);
	if (!document) return null;
	const issued = fursTime(document.issued_at);
	return {
		operator: document.operator_name,
		zoi: document.zoi,
		eor: document.eor,
		status: document.status,
		environment: document.environment,
		issued: issued.printed,
		issued_iso: issued.iso,
		code: verificationCode(document.zoi, document.tax_number, document.issued_at),
	};
}
