import Utils from "../utils";
import { t as translate, type TranslationKey } from "../i18n";
import { STANDARD_RATES } from "../tax";
import { CUSTOMER_EMAIL_KINDS, type CustomerEmailKind, type EmailDesign, type EmailTexts } from "../email-design";
import { brandFor } from "./messages";
import { creditNoteEmail, invoiceEmail, keysEmail, orderUpdateEmail, receiptEmail, type EmailContent, type EmailLine } from "./templates";
import type { ProjectRow } from "../database/models";

const DAY = 24 * 60 * 60 * 1000;

const DEFAULT_KEYS: Record<CustomerEmailKind, Partial<Record<keyof EmailTexts, TranslationKey>>> = {
	invoice: { subject: "email.invoice.subject", heading: "email.invoice.heading", intro: "email.invoice.intro", button: "email.invoice.button" },
	proforma: {
		subject: "email.proforma.subject",
		heading: "email.proforma.heading",
		intro: "email.proforma.intro",
		button: "email.invoice.button",
		closing: "email.proforma.closing",
	},
	reminder_before: {
		subject: "email.reminder_before.subject",
		heading: "email.invoice.heading",
		intro: "email.reminder_before.intro",
		button: "email.invoice.button",
		closing: "email.reminder.ignore",
	},
	reminder_after: {
		subject: "email.reminder_after.subject",
		heading: "email.invoice.heading",
		intro: "email.reminder_after.intro",
		button: "email.invoice.button",
		closing: "email.reminder.ignore",
	},
	receipt: { subject: "email.receipt.subject", heading: "email.receipt.heading", intro: "email.receipt.intro", button: "email.receipt.button" },
	credit_note: { subject: "email.credit_note.subject", heading: "email.credit_note.heading", intro: "email.credit_note.intro" },
	keys: { subject: "email.keys.subject", heading: "email.keys.heading", intro: "email.keys.intro", button: "email.keys.button", closing: "email.keys.keep" },
	order_placed: {
		subject: "email.order_placed.subject",
		heading: "email.order_placed.heading",
		intro: "email.order_placed.intro",
		button: "email.invoice.button",
		closing: "email.order_placed.closing",
	},
	order_processing: {
		subject: "email.order.subject_processing",
		heading: "email.order.heading_processing",
		intro: "email.order.intro_processing",
		button: "email.order.view",
	},
	order_shipped: {
		subject: "email.order.subject_shipped",
		heading: "email.order.heading_shipped",
		intro: "email.order.intro_shipped",
		button: "email.order.track",
	},
	order_delivered: {
		subject: "email.order.subject_delivered",
		heading: "email.order.heading_delivered",
		intro: "email.order.intro_delivered",
		button: "email.order.view",
	},
};

export function defaultEmailTexts(language: string): Record<CustomerEmailKind, EmailTexts> {
	return Object.fromEntries(
		CUSTOMER_EMAIL_KINDS.map((kind) => {
			const keys = DEFAULT_KEYS[kind];
			const value = (field: keyof EmailTexts) => (keys[field] ? translate(language, keys[field]!) : null);
			return [kind, { subject: value("subject"), heading: value("heading"), intro: value("intro"), button: value("button"), closing: value("closing") }];
		})
	) as Record<CustomerEmailKind, EmailTexts>;
}

function sampleLines(language: string, rate: number): { lines: EmailLine[]; total: number; tax: number } {
	const sl = language === "sl";
	const nets = [
		{ description: sl ? "Oblikovanje spletne strani" : "Website design", quantity: 1, net: 120000 },
		{ description: sl ? "Gostovanje, 12 mesecev" : "Hosting, 12 months", quantity: 12, net: 18000 },
	];
	const lines = nets.map((line) => ({ description: line.description, quantity: line.quantity, gross: line.net + Math.round((line.net * rate) / 100) }));
	const total = lines.reduce((sum, line) => sum + line.gross, 0);
	return { lines, total, tax: total - nets.reduce((sum, line) => sum + line.net, 0) };
}

export async function previewEmail(project: ProjectRow, design: EmailDesign, kind: CustomerEmailKind): Promise<EmailContent> {
	const brand = await brandFor(project, "customer", design);
	const custom = design.templates[kind];
	const rate = project.vat_status === "registered" && project.tax_country ? (STANDARD_RATES[project.tax_country] ?? 0) : 0;
	const { lines, total, tax } = sampleLines(project.language, rate);
	const now = Date.now();
	const url = `${Utils.publicUrl()}/pay/preview`;
	const reference = "260924000042";

	if (kind === "order_placed" || kind === "proforma") {
		return invoiceEmail(
			brand,
			kind,
			{
				reference: kind === "proforma" ? "PR-2026-00042" : "ORDER-26000042",
				currency: project.currency,
				total,
				tax,
				outstanding: total,
				dueDate: now + 3 * DAY,
				paid: false,
			},
			lines,
			url,
			null,
			{ custom }
		);
	}
	if (kind === "invoice" || kind === "reminder_before" || kind === "reminder_after") {
		const due = kind === "reminder_after" ? now - 3 * DAY : kind === "reminder_before" ? now + 3 * DAY : now + 14 * DAY;
		return invoiceEmail(brand, kind, { reference, currency: project.currency, total, tax, outstanding: total, dueDate: due, paid: false }, lines, url, null, {
			custom,
		});
	}
	if (kind === "receipt") {
		return receiptEmail(brand, { reference, currency: project.currency, total, tax, paidAt: now }, lines, url, [], { custom });
	}
	if (kind === "credit_note") {
		return creditNoteEmail(
			brand,
			{ reference: "D-260924000007", invoiceReference: reference, currency: project.currency, total, tax, issuedAt: now },
			lines,
			null,
			{ custom }
		);
	}
	if (kind === "keys") {
		return keysEmail(brand, { reference }, [{ name: project.language === "sl" ? "Igra, ključ" : "Game key", codes: ["ABCD-1234-EFGH-5678"] }], url, custom);
	}
	const fulfillment = kind === "order_processing" ? "processing" : kind === "order_shipped" ? "shipped" : "delivered";
	return orderUpdateEmail(brand, { reference, fulfillment }, { tracking: "https://tracking.example.com/RR123456789SI", order: url }, custom);
}
