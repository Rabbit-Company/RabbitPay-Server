import type { SQL } from "bun";
import { safeInteger } from "./database/numbers";
import Database from "./database/database";
import { ErrorCode } from "./errors";
import { allocateDiscount } from "./invoicing";
import { nextCreditNoteNumber } from "./invoice-numbers";
import { applyBalance } from "./payments/ledger";
import { enqueueLater } from "./webhooks/events";
import { saveCreditNotePresentation } from "./credit-note-snapshot";
import { activeFiscalFor } from "./fiscal/config";
import { fiscalPlaceForCredit, queueCreditNoteVerification, submitFiscalSoon } from "./fiscal/documents";
import type { PreparedIssuePresentation } from "./invoice-snapshot";
import type { CreditNoteItemRow, CreditNoteRow, InvoiceItemRow, InvoiceRow } from "./database/models";

export interface CreditRequest {
	reason?: string | null;
	amount?: number;
	lines?: { line?: string; amount?: number }[];
}

export interface CreditableLine {
	line: InvoiceItemRow;
	net: number;
	tax: number;
}

export interface PlannedLine {
	line: InvoiceItemRow;
	net: number;
	tax: number;
}

interface CreditNoteOptions {
	reason?: string | null;
	transactionId?: string | null;
	createdBy?: string | null;
	issuedAt?: number;
	amount?: number;
	presentation: PreparedIssuePresentation;
}

export async function creditableLines(sql: SQL, invoiceId: string): Promise<CreditableLine[]> {
	const lines = (await sql`SELECT * FROM invoice_items WHERE invoice = ${invoiceId} ORDER BY sort_order ASC`) as InvoiceItemRow[];

	const credited = (await sql`
		SELECT cni.invoice_item AS line, COALESCE(SUM(cni.net_amount), 0) AS net, COALESCE(SUM(cni.tax_amount), 0) AS tax
		FROM credit_note_items cni JOIN credit_notes cn ON cn.uuid = cni.credit_note
		WHERE cn.invoice = ${invoiceId} AND cni.invoice_item IS NOT NULL
		GROUP BY cni.invoice_item
	`) as { line: string; net: number; tax: number }[];

	const used = new Map(credited.map((row) => [row.line, row]));

	return lines.map((line) => ({
		line,
		net: line.total_price - line.discount_amount - safeInteger(used.get(line.uuid)?.net ?? 0),
		tax: line.tax_amount - safeInteger(used.get(line.uuid)?.tax ?? 0),
	}));
}

function remainingGross(lines: CreditableLine[]): number {
	return lines.reduce((sum, entry) => sum + Math.max(entry.net, 0) + Math.max(entry.tax, 0), 0);
}

export function planCredit(available: CreditableLine[], request: CreditRequest): PlannedLine[] | ErrorCode {
	const open = available.map((entry) => ({ ...entry, net: Math.max(entry.net, 0), tax: Math.max(entry.tax, 0) }));
	const gross = remainingGross(open);
	if (gross <= 0) return ErrorCode.NOTHING_TO_CREDIT;

	if (request.lines !== undefined) {
		if (!Array.isArray(request.lines) || request.lines.length === 0 || request.amount !== undefined) return ErrorCode.INVALID_CREDIT_NOTE;

		const planned: PlannedLine[] = [];
		const seen = new Set<string>();

		for (const wanted of request.lines) {
			const entry = open.find((candidate) => candidate.line.uuid === wanted?.line);
			const amount = wanted?.amount;
			if (!entry || seen.has(entry.line.uuid)) return ErrorCode.INVALID_CREDIT_NOTE;
			if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0 || amount > entry.net) return ErrorCode.INVALID_CREDIT_NOTE;

			seen.add(entry.line.uuid);
			const tax = amount === entry.net ? entry.tax : Math.min(Math.round((amount * entry.line.tax_rate) / 100), entry.tax);
			planned.push({ line: entry.line, net: amount, tax });
		}

		return planned;
	}

	if (request.amount !== undefined) {
		const amount = request.amount;
		if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0 || amount > gross) return ErrorCode.INVALID_CREDIT_NOTE;

		const shares = allocateDiscount(
			open.map((entry) => entry.net + entry.tax),
			amount
		);

		return open
			.map((entry, index) => {
				const share = shares[index];
				if (share <= 0) return null;
				if (share === entry.net + entry.tax) return { line: entry.line, net: entry.net, tax: entry.tax };

				let net = Math.min(Math.round(share / (1 + entry.line.tax_rate / 100)), entry.net);
				let tax = share - net;
				if (tax > entry.tax) {
					tax = entry.tax;
					net = share - tax;
				}
				return { line: entry.line, net, tax };
			})
			.filter((entry): entry is PlannedLine => entry !== null);
	}

	return open.filter((entry) => entry.net > 0 || entry.tax > 0).map((entry) => ({ line: entry.line, net: entry.net, tax: entry.tax }));
}

export async function issueCreditNote(sql: SQL, invoice: InvoiceRow, planned: PlannedLine[], options: CreditNoteOptions): Promise<CreditNoteRow> {
	const issuedAt = options.issuedAt ?? Date.now();
	const uuid = crypto.randomUUID();
	const fiscalPlace = await fiscalPlaceForCredit(sql, invoice.uuid);
	const fiscal = fiscalPlace ? await activeFiscalFor(sql, invoice.project) : null;
	const reference = await nextCreditNoteNumber(sql, invoice.project, issuedAt, fiscal?.settings.environment === fiscalPlace?.environment ? fiscalPlace : null);

	const subtotal = planned.reduce((sum, entry) => sum + entry.net, 0);
	const tax = planned.reduce((sum, entry) => sum + entry.tax, 0);
	const total = subtotal + tax;

	await sql`
		INSERT INTO credit_notes(uuid, project, invoice, reference, reason, currency, subtotal, tax_amount, total_amount, transaction_id, issued_at, created_by, created)
		VALUES(${uuid}, ${invoice.project}, ${invoice.uuid}, ${reference}, ${options.reason ?? null}, ${invoice.currency}, ${subtotal}, ${tax}, ${total},
			${options.transactionId ?? null}, ${issuedAt}, ${options.createdBy ?? null}, ${issuedAt})
	`;

	for (let index = 0; index < planned.length; index++) {
		const entry = planned[index];
		await sql`
			INSERT INTO credit_note_items(uuid, credit_note, invoice_item, description, tax_rate, tax_treatment, net_amount, tax_amount, sort_order)
			VALUES(${crypto.randomUUID()}, ${uuid}, ${entry.line.uuid}, ${entry.line.description}, ${entry.line.tax_rate}, ${entry.line.tax_treatment},
				${entry.net}, ${entry.tax}, ${index})
		`;
	}

	await sql`UPDATE invoices SET credited_amount = credited_amount + ${total}, updated = ${issuedAt} WHERE uuid = ${invoice.uuid}`;
	await applyBalance(sql, invoice.uuid);

	const [created] = (await sql`SELECT * FROM credit_notes WHERE uuid = ${uuid}`) as CreditNoteRow[];
	await saveCreditNotePresentation(
		sql,
		created,
		invoice,
		planned.map((entry) => entry.line.tax_treatment),
		options.presentation
	);
	if (await queueCreditNoteVerification(sql, created, invoice)) submitFiscalSoon();

	enqueueLater(invoice.project, "invoice.credited", {
		invoice: invoice.uuid,
		reference: invoice.reference,
		credit_note: uuid,
		credit_note_reference: reference,
		currency: invoice.currency,
		credited_amount: total,
		tax_amount: tax,
		reason: options.reason ?? null,
	});

	return created;
}

export async function creditRemaining(sql: SQL, invoice: InvoiceRow, options: CreditNoteOptions): Promise<CreditNoteRow | null> {
	const available = await creditableLines(sql, invoice.uuid);
	const left = remainingGross(available);
	if (left <= 0) return null;

	const amount = options.amount === undefined ? undefined : Math.min(options.amount, left);
	if (amount !== undefined && amount <= 0) return null;

	const planned = planCredit(available, amount === undefined || amount === left ? {} : { amount });
	if (!Array.isArray(planned) || planned.length === 0) return null;

	return await issueCreditNote(sql, invoice, planned, options);
}

export async function creditNotesFor(invoiceId: string): Promise<CreditNoteRow[]> {
	return (await Database`SELECT * FROM credit_notes WHERE invoice = ${invoiceId} ORDER BY issued_at ASC, reference ASC`) as CreditNoteRow[];
}

export async function creditNoteItems(creditNoteId: string): Promise<CreditNoteItemRow[]> {
	return (await Database`SELECT * FROM credit_note_items WHERE credit_note = ${creditNoteId} ORDER BY sort_order ASC`) as CreditNoteItemRow[];
}
