import type { SQL } from "bun";
import Database from "./database/database";
import Validate from "./validate";
import { draftReference, nextInvoiceNumber } from "./invoice-numbers";
import { ErrorCode } from "./errors";
import { calculateTotals, type InvoiceItemInput } from "./invoicing";
import { isTaxTreatment, isZeroRated } from "./tax";
import { isUnitCode } from "./measure-units";
import { reserveKeys, stockShortage } from "./item-keys";
import { MANUAL_RATE_SOURCE, validTaxExchangeRate, type IssueSnapshot } from "./tax-reporting";
import { invoiceRecipient } from "./invoice-recipient";
import { resolveInvoiceIssuer } from "./invoice-issuer";
import { saveIssuePresentation, type PreparedIssuePresentation } from "./invoice-snapshot";
import { prepareInvoiceIssue } from "./invoice-validation";
import { NO_REFERENCE_DOCUMENT, resolveReferenceDocument, type ReferenceDocumentInput } from "./reference-document";
import type { CustomerRow, InvoiceItemRow, InvoiceRow, ProjectRow } from "./database/models";

export interface InvoiceInput extends ReferenceDocumentInput {
	customer?: string | null;
	currency?: string;
	supply_date?: number | null;
	tax_exchange_rate?: number | null;
	late_vat_report?: boolean;
	items?: InvoiceItemInput[];
	discount_amount?: number;
	due_date?: number;
	notes?: string | null;
	metadata?: Record<string, unknown> | null;
	status?: "draft" | "open";
	source?: "invoice" | "pos";
	created_by?: string | null;
	recurring?: string | null;
}

export function validateItems(items: unknown): items is InvoiceItemInput[] {
	if (!Array.isArray(items) || items.length === 0) return false;

	return items.every((item) => {
		if (typeof item !== "object" || item === null) return false;
		if (!Validate.shortText(item.description, 500)) return false;
		if (!Validate.quantity(item.quantity)) return false;
		if (!Validate.minorUnitAmount(item.unit_price)) return false;
		if (item.gross_amount !== undefined) return false;
		if (item.tax_rate !== undefined && !Validate.taxRate(item.tax_rate)) return false;
		if (item.item !== undefined && item.item !== null && !Validate.uuid(item.item)) return false;
		if (item.unit !== undefined && item.unit !== null && !isUnitCode(item.unit)) return false;
		if (item.tax_treatment !== undefined && item.tax_treatment !== null) {
			if (!isTaxTreatment(item.tax_treatment)) return false;
			if (isZeroRated(item.tax_treatment) && (item.tax_rate ?? 0) !== 0) return false;
		}
		return true;
	});
}

export async function validateCatalogLinks(projectId: string, items: InvoiceItemInput[]): Promise<ErrorCode | null> {
	const linked = [...new Set(items.map((item) => item.item).filter((item): item is string => typeof item === "string"))];

	for (const itemId of linked) {
		const [found] = (await Database`SELECT uuid FROM catalog_items WHERE uuid = ${itemId} AND project = ${projectId}`) as { uuid: string }[];
		if (!found) return ErrorCode.ITEM_NOT_FOUND;
	}

	return null;
}

export async function projectCurrency(projectId: string): Promise<string> {
	const [project] = (await Database`SELECT currency FROM projects WHERE uuid = ${projectId}`) as { currency: string }[];
	return project?.currency ?? "EUR";
}

export async function validateInvoiceInput(projectId: string, data: InvoiceInput): Promise<ErrorCode | null> {
	if (data.currency !== undefined && !Validate.currency(data.currency)) return ErrorCode.INVALID_CURRENCY;
	if (!validateItems(data.items)) return ErrorCode.INVALID_INVOICE_ITEMS;
	const unlinked = await validateCatalogLinks(projectId, data.items);
	if (unlinked !== null) return unlinked;
	if (data.discount_amount !== undefined && !Validate.minorUnitAmount(data.discount_amount)) return ErrorCode.INVALID_INVOICE_AMOUNT;
	if (typeof data.due_date !== "number" || !Number.isSafeInteger(data.due_date) || data.due_date <= 0) return ErrorCode.INVALID_DUE_DATE;
	if (data.supply_date !== undefined && data.supply_date !== null) {
		if (typeof data.supply_date !== "number" || !Number.isSafeInteger(data.supply_date) || data.supply_date <= 0) return ErrorCode.INVALID_SUPPLY_DATE;
	}
	if (data.tax_exchange_rate !== undefined && data.tax_exchange_rate !== null && !validTaxExchangeRate(data.tax_exchange_rate)) {
		return ErrorCode.INVALID_TAX_EXCHANGE_RATE;
	}
	if (!Validate.optionalText(data.notes, 5000)) return ErrorCode.REQUIRED_DATA_MISSING;
	if (resolveReferenceDocument(data) === null) return ErrorCode.INVALID_REFERENCE_DOCUMENT;

	if (data.status === "open") {
		const short = await stockShortage(projectId, data.items);
		if (short !== null) return short;
	}

	if (data.customer !== undefined && data.customer !== null) {
		if (!Validate.uuid(data.customer)) return ErrorCode.INVALID_CUSTOMER_ID;

		const [customer] = (await Database`SELECT uuid FROM customers WHERE uuid = ${data.customer} AND project = ${projectId}`) as CustomerRow[];
		if (!customer) return ErrorCode.CUSTOMER_NOT_FOUND;
	}

	return null;
}

export async function replaceItems(sql: SQL, invoiceId: string, items: ReturnType<typeof calculateTotals>["items"]) {
	await sql`DELETE FROM invoice_items WHERE invoice = ${invoiceId}`;

	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		await sql`
			INSERT INTO invoice_items(uuid, invoice, description, quantity, unit_price, tax_rate, tax_amount, total_price, discount_amount, metadata, sort_order, item,
				tax_treatment, unit)
			VALUES(${crypto.randomUUID()}, ${invoiceId}, ${item.description}, ${item.quantity}, ${item.unit_price}, ${item.tax_rate},
				${item.tax_amount}, ${item.total_price}, ${item.discount_amount}, ${item.metadata}, ${index}, ${item.item}, ${item.tax_treatment}, ${item.unit})
		`;
	}
}

export async function stampIssue(
	sql: SQL,
	invoiceId: string,
	snapshot: IssueSnapshot,
	issuedBy: string | null | undefined,
	presentation: PreparedIssuePresentation
) {
	const [invoice] = (await sql`SELECT project, created_by FROM invoices WHERE uuid = ${invoiceId}`) as Pick<InvoiceRow, "project" | "created_by">[];
	const issuer = invoice ? await resolveInvoiceIssuer(sql, invoice.project, issuedBy ?? invoice.created_by) : null;
	const [customer] = (await sql`
		SELECT c.* FROM customers c JOIN invoices i ON i.customer = c.uuid AND i.project = c.project WHERE i.uuid = ${invoiceId}
	`) as CustomerRow[];
	const recipient = invoiceRecipient(customer, snapshot.buyer_vat_number);
	await sql`
		UPDATE invoices SET
			issued_at = ${snapshot.issued_at}, tax_point_date = ${snapshot.tax_point_date}, vat_period_date = ${snapshot.vat_period_date},
			vat_handling = ${snapshot.vat_handling}, vat_correction_period = ${snapshot.vat_correction_period}, tax_currency = ${snapshot.tax_currency}, tax_exchange_rate = ${snapshot.tax_exchange_rate},
			tax_rate_source = ${snapshot.tax_rate_source}, tax_rate_date = ${snapshot.tax_rate_date},
			buyer_country = ${snapshot.buyer_country}, buyer_vat_number = ${snapshot.buyer_vat_number},
			buyer_email = ${recipient?.email?.trim().toLowerCase() || null}, buyer_details = ${recipient ? JSON.stringify(recipient) : null},
			issuer_name = ${issuer?.name ?? null}
		WHERE uuid = ${invoiceId}
	`;
	await sql`DELETE FROM invoice_issuer_signature_versions WHERE invoice = ${invoiceId}`;
	if (issuer?.signatureVersion) {
		await sql`
			INSERT INTO invoice_issuer_signature_versions(invoice, signature_version)
			VALUES(${invoiceId}, ${issuer.signatureVersion})
		`;
	}
	await saveIssuePresentation(sql, invoiceId, presentation, snapshot.issued_at);
}

export interface CreateOptions {
	draftReference?: string;
	holdKeys?: boolean;
	uuid?: string;
}

export async function createInvoice(projectId: string, data: InvoiceInput, options: CreateOptions = {}): Promise<InvoiceRow> {
	const totals = calculateTotals(data.items!, data.discount_amount ?? 0);
	const currency = data.currency ?? (await projectCurrency(projectId));
	const uuid = options.uuid ?? crypto.randomUUID();
	const timestamp = Date.now();
	const status = data.status === "open" ? "open" : "draft";
	const supplyDate = data.supply_date ?? (status === "open" ? timestamp : null);
	const referenceDocument = resolveReferenceDocument(data) ?? NO_REFERENCE_DOCUMENT;
	const manualRate = data.tax_exchange_rate ?? null;
	const [project] = status === "open" ? ((await Database`SELECT * FROM projects WHERE uuid = ${projectId}`) as ProjectRow[]) : [];
	const issue = project
		? await prepareInvoiceIssue(
				project,
				{
					currency,
					customer: data.customer ?? null,
					due_date: data.due_date!,
					supply_date: supplyDate,
					tax_amount: totals.tax_amount,
					tax_exchange_rate: manualRate,
					tax_rate_source: manualRate === null ? null : MANUAL_RATE_SOURCE,
					late_vat_report: data.late_vat_report === true,
				},
				totals.items,
				timestamp
			)
		: null;

	await Database.begin(async (tx) => {
		const reference =
			status === "draft"
				? (options.draftReference ?? draftReference())
				: await nextInvoiceNumber(tx, projectId, timestamp, data.source === "pos" ? "pos" : "invoice");

		await tx`
			INSERT INTO invoices(uuid, project, customer, reference, status, currency, subtotal, discount_amount, tax_amount, total_amount,
				paid_amount, refunded_amount, notes, metadata, due_date, supply_date, source, created_by, recurring,
				reference_document_type, reference_document_number, reference_document_date, created, updated)
			VALUES(${uuid}, ${projectId}, ${data.customer ?? null}, ${reference}, ${status}, ${currency}, ${totals.subtotal},
				${totals.discount_amount}, ${totals.tax_amount}, ${totals.total_amount}, 0, 0, ${data.notes ?? null},
				${data.metadata ? JSON.stringify(data.metadata) : null}, ${data.due_date!}, ${supplyDate}, ${data.source ?? "invoice"},
				${data.created_by ?? null}, ${data.recurring ?? null}, ${referenceDocument.reference_document_type},
				${referenceDocument.reference_document_number}, ${referenceDocument.reference_document_date}, ${timestamp}, ${timestamp})
		`;

		await replaceItems(tx, uuid, totals.items);
		if (manualRate !== null) await tx`UPDATE invoices SET tax_exchange_rate = ${manualRate}, tax_rate_source = ${MANUAL_RATE_SOURCE} WHERE uuid = ${uuid}`;
		if (issue) await stampIssue(tx, uuid, issue.snapshot, data.created_by, issue.presentation);
		if (status === "open" || options.holdKeys) await reserveKeys(tx, uuid);
	});
	if (status === "open") {
		const { archiveIssuedInvoice } = await import("./invoice-archive");
		await archiveIssuedInvoice(projectId, uuid);
	}

	return (await loadInvoice(projectId, uuid))!;
}

export async function loadInvoice(projectId: string, invoiceId: string): Promise<InvoiceRow | undefined> {
	const [invoice] = (await Database`SELECT * FROM invoices WHERE uuid = ${invoiceId} AND project = ${projectId}`) as InvoiceRow[];
	return invoice;
}

export async function loadItems(invoiceId: string): Promise<InvoiceItemRow[]> {
	return (await Database`SELECT * FROM invoice_items WHERE invoice = ${invoiceId} ORDER BY sort_order ASC`) as InvoiceItemRow[];
}

export function present(invoice: InvoiceRow, items: InvoiceItemRow[]) {
	return {
		...invoice,
		metadata: invoice.metadata === null ? null : JSON.parse(invoice.metadata),
		items: items.map((item) => ({ ...item, metadata: item.metadata === null ? null : JSON.parse(item.metadata) })),
	};
}
