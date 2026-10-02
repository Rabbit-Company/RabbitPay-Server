import type { SQL } from "bun";
import Database from "./database/database";
import { Logger } from "./logger";
import { t } from "./i18n";
import { formatDateIn, formatPercentIn, type DateFormat } from "./formats";
import { allocateDiscount, type InvoiceItemInput } from "./invoicing";
import { nextInvoiceNumber, nextSeriesNumber } from "./invoice-numbers";
import { prepareInvoiceIssue } from "./invoice-validation";
import { createInvoice, loadItems, stampIssue } from "./invoice-service";
import { archiveIssuedInvoice } from "./invoice-archive";
import { reserveKeys } from "./item-keys";
import { applyBalance, SETTLED_PAYMENT_STATUSES } from "./payments/ledger";
import { enqueueLater } from "./webhooks/events";
import { MANUAL_RATE_SOURCE } from "./tax-reporting";
import type { InvoiceItemRow, InvoiceRow, ProformaRow, ProformaSettlement, ProjectRow } from "./database/models";

import type { DocumentKind } from "./document-kind";

export type { DocumentKind };

export const PROFORMA_SETTLEMENTS: ProformaSettlement[] = ["invoice", "advance"];

export function isProformaSettlement(value: unknown): value is ProformaSettlement {
	return typeof value === "string" && PROFORMA_SETTLEMENTS.includes(value as ProformaSettlement);
}

export async function proformaFor(invoiceId: string, sql: SQL = Database): Promise<ProformaRow | null> {
	const [row] = (await sql`SELECT * FROM proformas WHERE invoice = ${invoiceId}`) as ProformaRow[];
	return row ?? null;
}

export async function storeOrderNumber(invoiceId: string): Promise<string | null> {
	const [row] = (await Database`SELECT number FROM store_orders WHERE invoice = ${invoiceId}`) as { number: string | null }[];
	return row ? (row.number ?? null) : null;
}

export async function documentKindOf(invoice: Pick<InvoiceRow, "uuid" | "status" | "document_type">): Promise<DocumentKind> {
	if (invoice.status !== "draft") return invoice.document_type === "advance" ? "advance" : "invoice";
	if (await proformaFor(invoice.uuid)) return "proforma";
	const [order] = (await Database`SELECT 1 AS found FROM store_orders WHERE invoice = ${invoice.uuid}`) as unknown[];
	return order ? "order" : "invoice";
}

export async function createProforma(project: ProjectRow, invoice: InvoiceRow, settlement: ProformaSettlement): Promise<ProformaRow> {
	const now = Date.now();
	await Database.begin(async (tx) => {
		const reference = await nextSeriesNumber(tx, project.uuid, "proforma", now);
		await tx`UPDATE invoices SET reference = ${reference}, updated = ${now} WHERE uuid = ${invoice.uuid} AND status = 'draft'`;
		await tx`
			INSERT INTO proformas(invoice, project, reference, settlement, issued_at, created, updated)
			VALUES(${invoice.uuid}, ${project.uuid}, ${reference}, ${settlement}, ${now}, ${now}, ${now})
		`;
	});
	return (await proformaFor(invoice.uuid))!;
}

export async function advancesOf(proformaId: string, sql: SQL = Database): Promise<InvoiceRow[]> {
	return (await sql`
		SELECT * FROM invoices WHERE proforma = ${proformaId} AND document_type = 'advance' AND status <> 'canceled' AND issued_at IS NOT NULL
		ORDER BY issued_at ASC, reference ASC
	`) as InvoiceRow[];
}

export async function refreshAdvancedAmount(sql: SQL, proformaId: string) {
	const [draft] = (await sql`SELECT status FROM invoices WHERE uuid = ${proformaId}`) as Pick<InvoiceRow, "status">[];
	if (!draft || draft.status !== "draft") return;
	const [sum] = (await sql`
		SELECT COALESCE(SUM(total_amount - credited_amount), 0) AS total FROM invoices
		WHERE proforma = ${proformaId} AND document_type = 'advance' AND status <> 'canceled' AND issued_at IS NOT NULL
	`) as { total: number }[];
	await sql`UPDATE invoices SET advanced_amount = ${Math.max(Number(sum.total), 0)} WHERE uuid = ${proformaId}`;
}

interface TaxGroup {
	rate: number;
	treatment: string | null;
	gross: number;
}

function taxGroupsOf(items: InvoiceItemRow[]): TaxGroup[] {
	const groups = new Map<string, TaxGroup>();
	for (const item of items) {
		const key = `${item.tax_rate}|${item.tax_treatment ?? ""}`;
		const group = groups.get(key) ?? { rate: item.tax_rate, treatment: item.tax_treatment, gross: 0 };
		group.gross += item.total_price - item.discount_amount + item.tax_amount;
		groups.set(key, group);
	}
	return [...groups.values()].filter((group) => group.gross > 0);
}

export function advanceLines(project: Pick<ProjectRow, "language">, proforma: ProformaRow, items: InvoiceItemRow[], amount: number): InvoiceItemInput[] {
	const groups = taxGroupsOf(items);
	const shares = allocateDiscount(
		groups.map((group) => group.gross),
		amount
	);
	const several = groups.length > 1;
	return groups
		.map((group, index) => ({ group, share: shares[index] }))
		.filter(({ share }) => share > 0)
		.map(({ group, share }) => ({
			description: `${t(project.language, "advance.line", { reference: proforma.reference })}${
				several ? ` (${t(project.language, "advance.rate", { rate: formatPercentIn(group.rate, project.language) })})` : ""
			}`,
			quantity: 1,
			unit_price: share - Math.round((share * group.rate) / (100 + group.rate)),
			tax_rate: group.rate,
			tax_treatment: group.treatment,
			gross_amount: share,
		}));
}

interface Deduction {
	description: string;
	net: number;
	tax: number;
	rate: number;
	treatment: string | null;
}

async function advanceDeductions(sql: SQL, project: ProjectRow, invoiceId: string): Promise<Deduction[]> {
	const deductions: Deduction[] = [];
	for (const advance of await advancesOf(invoiceId, sql)) {
		const remaining = advance.total_amount - advance.credited_amount;
		if (remaining <= 0 || advance.total_amount <= 0) continue;
		const factor = remaining / advance.total_amount;
		const date = formatDateIn(advance.issued_at!, project.date_format as DateFormat, project.language, project.timezone);
		const lines = (await sql`SELECT * FROM invoice_items WHERE invoice = ${advance.uuid} ORDER BY sort_order ASC`) as InvoiceItemRow[];
		for (const line of lines) {
			deductions.push({
				description: t(project.language, "advance.deduction", { reference: advance.reference, date }),
				net: Math.round((line.total_price - line.discount_amount) * factor),
				tax: Math.round(line.tax_amount * factor),
				rate: line.tax_rate,
				treatment: line.tax_treatment,
			});
		}
	}
	return deductions;
}

export interface IssueOptions {
	issuedBy: string | null;
	issuedAt?: number;
	supplyDate?: number;
	channel?: "invoice" | "pos";
}

export async function issueDraft(project: ProjectRow, invoice: InvoiceRow, options: IssueOptions): Promise<string | null> {
	const issuedAt = options.issuedAt ?? Date.now();
	const supplyDate = options.supplyDate ?? invoice.supply_date ?? issuedAt;
	const items = await loadItems(invoice.uuid);
	const deductions = await advanceDeductions(Database, project, invoice.uuid);
	const deductedTax = deductions.reduce((sum, line) => sum + line.tax, 0);
	const issue = await prepareInvoiceIssue(
		project,
		{ ...invoice, supply_date: supplyDate, tax_amount: invoice.tax_amount - deductedTax },
		[...items, ...deductions.map((line) => ({ description: line.description, quantity: 1, tax_rate: line.rate, tax_treatment: line.treatment }))],
		issuedAt
	);

	const reference = await Database.begin(async (tx) => {
		const claimed = await tx`
			UPDATE invoices SET status = 'open', supply_date = ${supplyDate}, updated = ${issuedAt} WHERE uuid = ${invoice.uuid} AND status = 'draft'
		`;
		if (claimed.count === 0) return null;

		if (deductions.length > 0) {
			let order = items.length;
			for (const line of deductions) {
				await tx`
					INSERT INTO invoice_items(uuid, invoice, description, quantity, unit_price, tax_rate, tax_amount, total_price, discount_amount, metadata,
						sort_order, item, tax_treatment, unit)
					VALUES(${crypto.randomUUID()}, ${invoice.uuid}, ${line.description}, 1, ${-line.net}, ${line.rate}, ${-line.tax}, ${-line.net}, 0,
						${JSON.stringify({ advance_deduction: true })}, ${order++}, NULL, ${line.treatment}, NULL)
				`;
			}
			const net = deductions.reduce((sum, line) => sum + line.net, 0);
			await tx`
				UPDATE invoices SET subtotal = subtotal - ${net}, tax_amount = tax_amount - ${deductedTax}, total_amount = total_amount - ${net + deductedTax},
					advanced_amount = 0
				WHERE uuid = ${invoice.uuid}
			`;
		}

		const number = await nextInvoiceNumber(tx, project.uuid, issuedAt, options.channel ?? (invoice.source === "pos" ? "pos" : "invoice"));
		await tx`UPDATE invoices SET reference = ${number} WHERE uuid = ${invoice.uuid}`;
		await stampIssue(tx, invoice.uuid, issue.snapshot, options.issuedBy, issue.presentation);
		await reserveKeys(tx, invoice.uuid);
		await applyBalance(tx, invoice.uuid);
		return number;
	});
	if (reference === null) return null;

	await archiveIssuedInvoice(project.uuid, invoice.uuid);
	const [issued] = (await Database`SELECT * FROM invoices WHERE uuid = ${invoice.uuid}`) as InvoiceRow[];
	enqueueLater(project.uuid, "invoice.issued", {
		invoice: invoice.uuid,
		reference,
		status: issued.status,
		currency: issued.currency,
		total_amount: issued.total_amount,
		due_date: issued.due_date,
		...(issued.document_type === "advance" ? { advance: true } : {}),
	});
	return reference;
}

export async function issueAdvance(project: ProjectRow, proformaInvoice: InvoiceRow): Promise<string | null> {
	const proforma = await proformaFor(proformaInvoice.uuid);
	if (!proforma || proformaInvoice.status !== "draft") return null;

	const received = proformaInvoice.paid_amount - proformaInvoice.refunded_amount;
	const open = proformaInvoice.total_amount - proformaInvoice.credited_amount - proformaInvoice.advanced_amount;
	const amount = Math.min(received, open);
	if (amount <= 0) return null;

	const items = await loadItems(proformaInvoice.uuid);
	const now = Date.now();
	const advance = await createInvoice(project.uuid, {
		customer: proformaInvoice.customer,
		currency: proformaInvoice.currency,
		items: advanceLines(project, proforma, items, amount),
		discount_amount: 0,
		due_date: now,
		supply_date: now,
		tax_exchange_rate: proformaInvoice.tax_rate_source === MANUAL_RATE_SOURCE ? proformaInvoice.tax_exchange_rate : null,
		notes: null,
		metadata: { proforma: proforma.reference },
		status: "draft",
		source: "invoice",
		created_by: proformaInvoice.created_by,
	});

	const moved = await Database.begin(async (tx) => {
		const result = await tx`
			UPDATE transactions SET invoice = ${advance.uuid}
			WHERE invoice = ${proformaInvoice.uuid} AND type = 'payment' AND status IN ${tx(SETTLED_PAYMENT_STATUSES)}
		`;
		if (result.count === 0) return false;
		await tx`UPDATE invoices SET document_type = 'advance', proforma = ${proformaInvoice.uuid} WHERE uuid = ${advance.uuid}`;
		await applyBalance(tx, proformaInvoice.uuid);
		await applyBalance(tx, advance.uuid);
		return true;
	});
	if (!moved) {
		await Database`DELETE FROM invoices WHERE uuid = ${advance.uuid}`;
		return null;
	}

	const [draft] = (await Database`SELECT * FROM invoices WHERE uuid = ${advance.uuid}`) as InvoiceRow[];
	const reference = await issueDraft(project, draft, { issuedBy: null, issuedAt: now, supplyDate: now });
	await Database.begin((tx) => refreshAdvancedAmount(tx, proformaInvoice.uuid));
	if (reference) Logger.info(`[PROFORMA] Issued advance invoice ${reference} for ${proforma.reference}`);
	return reference;
}

export async function documentDetails(invoice: InvoiceRow) {
	const proforma = await proformaFor(invoice.uuid);
	const advances = proforma ? await advancesOf(invoice.uuid) : [];
	const [source] = invoice.proforma
		? ((await Database`SELECT invoice, reference FROM proformas WHERE invoice = ${invoice.proforma}`) as Pick<ProformaRow, "invoice" | "reference">[])
		: [];
	return {
		document: await documentKindOf(invoice),
		proforma: proforma ? { reference: proforma.reference, settlement: proforma.settlement, issued_at: proforma.issued_at } : null,
		order_number: await storeOrderNumber(invoice.uuid),
		advances: advances.map((advance) => ({
			uuid: advance.uuid,
			reference: advance.reference,
			total_amount: advance.total_amount,
			credited_amount: advance.credited_amount,
			issued_at: advance.issued_at,
		})),
		source_proforma: source ? { uuid: source.invoice, reference: source.reference } : null,
	};
}
