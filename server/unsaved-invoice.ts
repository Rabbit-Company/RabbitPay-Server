import { calculateTotals, type InvoiceItemInput } from "./invoicing";
import { invoiceDocument } from "./invoice-document";
import { invoiceFilename, renderInvoicePdf } from "./invoice-pdf";
import { draftReference } from "./invoice-numbers";
import { loadLogo } from "./branding";
import { NO_REFERENCE_DOCUMENT, type ReferenceDocumentColumns } from "./reference-document";
import type { InvoiceItemRow, InvoiceRow, ProjectRow } from "./database/models";

export interface UnsavedInvoice {
	draft?: InvoiceRow;
	customer: string | null;
	currency: string;
	items: InvoiceItemInput[];
	discount_amount: number;
	notes: string | null;
	issued: number;
	due_date: number;
	supply_date: number | null;
	created_by: string | null;
	reference_document?: ReferenceDocumentColumns;
}

export async function unsavedInvoiceDocument(project: ProjectRow, input: UnsavedInvoice) {
	const totals = calculateTotals(input.items, input.discount_amount);
	const uuid = input.draft?.uuid ?? crypto.randomUUID();
	const items: InvoiceItemRow[] = totals.items.map((item, index) => ({ ...item, uuid: crypto.randomUUID(), invoice: uuid, sort_order: index }));

	const blank: InvoiceRow = {
		uuid,
		project: project.uuid,
		customer: null,
		reference: draftReference(),
		status: "draft",
		document_type: "invoice",
		proforma: null,
		advanced_amount: 0,
		currency: input.currency,
		subtotal: 0,
		discount_amount: 0,
		tax_amount: 0,
		total_amount: 0,
		paid_amount: 0,
		refunded_amount: 0,
		credited_amount: 0,
		notes: null,
		metadata: null,
		due_date: input.due_date,
		supply_date: null,
		tax_point_date: null,
		vat_period_date: null,
		vat_handling: "1",
		vat_correction_period: null,
		issued_at: null,
		tax_currency: null,
		tax_exchange_rate: null,
		tax_rate_source: null,
		tax_rate_date: null,
		buyer_country: null,
		buyer_vat_number: null,
		buyer_email: null,
		buyer_details: null,
		paid_date: null,
		canceled_date: null,
		source: "invoice",
		created_by: null,
		issuer_name: null,
		recurring: null,
		...NO_REFERENCE_DOCUMENT,
		created: input.issued,
		updated: input.issued,
	};

	const invoice: InvoiceRow = {
		...(input.draft ?? blank),
		customer: input.customer,
		currency: input.currency,
		subtotal: totals.subtotal,
		discount_amount: totals.discount_amount,
		tax_amount: totals.tax_amount,
		total_amount: totals.total_amount,
		notes: input.notes,
		due_date: input.due_date,
		supply_date: input.supply_date,
		created_by: input.draft?.created_by ?? input.created_by,
		...(input.reference_document ?? NO_REFERENCE_DOCUMENT),
		created: input.issued,
	};

	return await invoiceDocument(project, invoice, { items });
}

export async function unsavedInvoicePdf(project: ProjectRow, input: UnsavedInvoice): Promise<{ name: string; data: Uint8Array }> {
	const document = await unsavedInvoiceDocument(project, input);
	const logo = document.branding.logo ? await loadLogo(project.uuid) : null;
	const data = await renderInvoicePdf(document, logo, { payLink: false });
	return { name: invoiceFilename(document.invoice.reference, document.language, "pdf", document.kind), data };
}
