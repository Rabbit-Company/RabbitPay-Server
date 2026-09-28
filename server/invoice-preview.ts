import Utils from "./utils";
import { url as urlPayload } from "@rabbit-company/qrcode/payload";
import { companyFor, displayNameOf } from "./company";
import { loadLogo, logoPath } from "./branding";
import { defaultExemptionNote, STANDARD_RATES } from "./tax";
import { renderCreditNotePdf, renderInvoicePdf } from "./invoice-pdf";
import type { invoiceDocument } from "./invoice-document";
import type { creditNoteDocument } from "./credit-note-document";
import type { InvoiceDesign } from "./invoice-design";
import type { ProjectRow } from "./database/models";

export type PreviewKind = "invoice" | "receipt" | "credit_note";

type InvoiceDocument = Awaited<ReturnType<typeof invoiceDocument>>;
type CreditNoteDocument = Awaited<ReturnType<typeof creditNoteDocument>>;

const DAY = 24 * 60 * 60 * 1000;

function sampleLines(language: string, rate: number) {
	const sl = language === "sl";
	return [
		{ description: sl ? "Oblikovanje spletne strani" : "Website design", quantity: 1, unit: null, unit_price: 120000 },
		{ description: sl ? "Gostovanje" : "Hosting", quantity: 12, unit: "MON", unit_price: 1500 },
		{ description: sl ? "Podpora" : "Support", quantity: 3, unit: "HUR", unit_price: 4500 },
	].map((line) => {
		const net = line.quantity * line.unit_price;
		return { ...line, tax_rate: rate, total_price: net, tax_amount: Math.round((net * rate) / 100), discount_amount: 0, tax_treatment: null };
	});
}

export type PreviewDocument = { kind: "credit_note"; document: CreditNoteDocument } | { kind: "invoice" | "receipt"; document: InvoiceDocument };

export async function previewDocument(project: ProjectRow, design: InvoiceDesign, kind: PreviewKind): Promise<PreviewDocument> {
	const company = await companyFor(project.uuid);
	const seller = { ...company, name: displayNameOf(project) };
	const language = project.language;
	const sl = language === "sl";
	const rate = project.vat_status === "registered" && project.tax_country ? (STANDARD_RATES[project.tax_country] ?? 0) : 0;
	const lines = sampleLines(language, rate);
	const subtotal = lines.reduce((sum, line) => sum + line.total_price, 0);
	const tax = lines.reduce((sum, line) => sum + line.tax_amount, 0);
	const now = Date.now();
	const branding = { white_label: true, logo: logoPath(project) };
	const buyer = {
		name: sl ? "Primer d.o.o." : "Example Ltd",
		email: "billing@example.com",
		phone: null,
		address_line1: sl ? "Primerna ulica 1" : "1 Example Street",
		address_line2: null,
		postal_code: "1000",
		city: "Ljubljana",
		state: null,
		country: "SI",
		vat_number: null,
		tax_number: null,
		registration_number: null,
		iban: null,
		bic: null,
		customer_type: "business",
	};
	const taxDetails = {
		vat_status: project.vat_status,
		country: project.tax_country,
		exemption_note: project.vat_status === "small_business" ? (project.vat_exemption_note ?? defaultExemptionNote(project.tax_country, language)) : null,
		reporting: null,
		notes: [],
	};
	const formats = { date: project.date_format, time: project.time_format, timezone: project.timezone };
	const reference = kind === "receipt" ? "PR1-B1-42" : "260924000042";

	if (kind === "credit_note") {
		const document: CreditNoteDocument = {
			seller,
			buyer,
			credit_note: {
				uuid: crypto.randomUUID(),
				reference: "D-260924000007",
				reason: sl ? "Vračilo storitve" : "Service refunded",
				currency: project.currency,
				subtotal,
				tax_amount: tax,
				total_amount: subtotal + tax,
				issued: now,
			},
			corrects: { uuid: crypto.randomUUID(), reference, issued: now - 7 * DAY },
			items: lines.map((line) => ({
				description: line.description,
				tax_rate: line.tax_rate,
				tax_treatment: null,
				net_amount: line.total_price,
				tax_amount: line.tax_amount,
			})),
			tax: taxDetails,
			fiscal: null,
			formats,
			language,
			design,
			closing_note: design.notes.credit_note,
			branding,
		};
		return { kind, document };
	}

	const payUrl = `${Utils.publicUrl()}/pay/preview`;
	const document: InvoiceDocument = {
		seller,
		buyer,
		invoice: {
			reference,
			status: kind === "receipt" ? "paid" : "open",
			currency: project.currency,
			subtotal,
			discount_amount: 0,
			tax_amount: tax,
			total_amount: subtotal + tax,
			paid_amount: kind === "receipt" ? subtotal + tax : 0,
			refunded_amount: 0,
			credited_amount: 0,
			outstanding: kind === "receipt" ? 0 : subtotal + tax,
			notes: null,
			issued: now,
			due_date: kind === "receipt" ? null : now + 14 * DAY,
			supply_date: now,
			paid_date: kind === "receipt" ? now : null,
			reference_document: null,
		},
		items: lines,
		tax: taxDetails,
		formats,
		language,
		branding,
		design,
		closing_note: kind === "receipt" ? design.notes.receipt : design.notes.invoice,
		issuer: null,
		bank: null,
		online: { card: true, crypto: false },
		fiscal: null,
		pay_url: payUrl,
		pay_qr: kind === "receipt" ? null : { format: "url", payload: urlPayload(payUrl, { compact: false }), encoding: "utf8" },
	};
	return { kind, document };
}

export async function renderDesignPreview(project: ProjectRow, design: InvoiceDesign, kind: PreviewKind): Promise<Uint8Array> {
	const preview = await previewDocument(project, design, kind);
	const logo = project.logo_updated !== null ? await loadLogo(project.uuid) : null;
	if (preview.kind === "credit_note") return await renderCreditNotePdf(preview.document, logo);
	return await renderInvoicePdf(preview.document, logo, { payLink: preview.kind !== "receipt" });
}
