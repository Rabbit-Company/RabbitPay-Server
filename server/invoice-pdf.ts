import { invoiceDocument } from "./invoice-document";
import { creditNoteDocument } from "./credit-note-document";
import { loadLogo } from "./branding";
import { translator } from "./i18n";
import { DOCUMENT_TITLES, type DocumentKind } from "./document-kind";
import RenderPool from "./render-pool";
import type { CreditNoteDocument, InvoiceDocument, LogoSource } from "./invoice-render";
import type { CreditNoteRow, InvoiceRow, ProjectRow } from "./database/models";

const UNSAFE_FILENAME = /[\\/:*?"<>|\p{Cc}]+/gu;

function documentFilename(title: string, reference: string, extension: string): string {
	return `${`${title} ${reference}`.replace(UNSAFE_FILENAME, "-").trim()}.${extension}`;
}

export function invoiceFilename(reference: string, language: string, extension = "pdf", kind: DocumentKind = "invoice"): string {
	return documentFilename(translator(language)(DOCUMENT_TITLES[kind]), reference, extension);
}

export function creditNoteFilename(reference: string, language: string, extension = "pdf"): string {
	return documentFilename(translator(language)("credit.title"), reference, extension);
}

export async function renderInvoicePdf(document: InvoiceDocument, logo: LogoSource | null, options: { payLink: boolean }): Promise<Uint8Array> {
	return await RenderPool.render({ kind: "invoice", document, logo, payLink: options.payLink });
}

export async function renderCreditNotePdf(document: CreditNoteDocument, logo: LogoSource | null): Promise<Uint8Array> {
	return await RenderPool.render({ kind: "credit_note", document, logo });
}

export async function renderFiscalInvoicePdf(project: ProjectRow, invoice: InvoiceRow): Promise<{ name: string; data: Uint8Array }> {
	const { issueSnapshotFor, snapshotLogo } = await import("./invoice-snapshot");
	const snapshot = await issueSnapshotFor(invoice.uuid);
	const document = await invoiceDocument(project, invoice);
	const data = await renderInvoicePdf(document, await snapshotLogo(invoice.uuid), { payLink: snapshot?.settings.pdf_pay_link ?? false });
	return { name: invoiceFilename(invoice.reference, document.language, "pdf", document.kind), data };
}

export async function renderFiscalCreditNotePdf(project: ProjectRow, note: CreditNoteRow): Promise<{ name: string; data: Uint8Array }> {
	const { creditNoteSnapshotLogo } = await import("./credit-note-snapshot");
	const document = await creditNoteDocument(project, note);
	const data = await renderCreditNotePdf(document, await creditNoteSnapshotLogo(note.uuid));
	return { name: creditNoteFilename(note.reference, document.language), data };
}

export async function deliveredInvoicePdf(project: ProjectRow, invoice: InvoiceRow): Promise<{ name: string; data: Uint8Array }> {
	const { fiscalDocumentFor } = await import("./fiscal/documents");
	const fiscal = await fiscalDocumentFor({ invoice: invoice.uuid });
	if (fiscal) {
		const { verifiedCopy } = await import("./fiscal/archive");
		const stored = await verifiedCopy(fiscal);
		if (stored) {
			const { issueSnapshotFor } = await import("./invoice-snapshot");
			const language = (await issueSnapshotFor(invoice.uuid))?.settings.language ?? project.language;
			return { name: invoiceFilename(invoice.reference, language, "pdf", invoice.document_type), data: stored };
		}
		return await renderFiscalInvoicePdf(project, invoice);
	}
	const { archivedInvoicePdf } = await import("./invoice-archive");
	return await archivedInvoicePdf(project, invoice);
}

export async function deliveredCreditNotePdf(project: ProjectRow, note: CreditNoteRow): Promise<{ name: string; data: Uint8Array }> {
	const { fiscalDocumentFor } = await import("./fiscal/documents");
	const fiscal = await fiscalDocumentFor({ creditNote: note.uuid });
	if (fiscal) {
		const { verifiedCopy } = await import("./fiscal/archive");
		const stored = await verifiedCopy(fiscal);
		if (stored) {
			const { creditNoteSnapshotFor } = await import("./credit-note-snapshot");
			const language = (await creditNoteSnapshotFor(note.uuid))?.settings.language ?? project.language;
			return { name: creditNoteFilename(note.reference, language), data: stored };
		}
		return await renderFiscalCreditNotePdf(project, note);
	}
	const { archivedCreditNotePdf } = await import("./credit-note-archive");
	return await archivedCreditNotePdf(project, note);
}

export async function invoicePdf(project: ProjectRow, invoice: InvoiceRow, options: { payLink: boolean }): Promise<{ name: string; data: Uint8Array }> {
	if (invoice.status !== "draft") return await deliveredInvoicePdf(project, invoice);
	const document = await invoiceDocument(project, invoice);
	const logo = document.branding.logo ? await loadLogo(project.uuid) : null;
	const data = await renderInvoicePdf(document, logo, options);
	return { name: invoiceFilename(invoice.reference, document.language, "pdf", document.kind), data };
}

export async function creditNotePdf(project: ProjectRow, note: CreditNoteRow): Promise<{ name: string; data: Uint8Array }> {
	return await deliveredCreditNotePdf(project, note);
}

export function pdfResponse(file: { name: string; data: Uint8Array }): Response {
	return downloadResponse(file, "application/pdf");
}

export function downloadResponse(file: { name: string; data: Uint8Array }, contentType: string): Response {
	const fallback =
		file.name
			.normalize("NFKD")
			.replace(/[^\x20-\x7e]/g, "")
			.replace(/["\\]/g, "") || "invoice.pdf";
	return new Response(file.data, {
		headers: {
			"Content-Type": contentType,
			"Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
