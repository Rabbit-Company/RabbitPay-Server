import { customText, type EmailTexts } from "../email-design";
import { formatDateIn, formatMoneyIn, type DateFormat } from "../formats";
import { translator, type TranslationKey } from "../i18n";
import { BRAND_BLUE, accentTextFor, isAccentColor } from "../colors";
import { formatIban } from "../formats";
import type { BankInstruction } from "../payments/bank";
import { translate, type UiLanguage } from "../../web/src/i18n/dictionary";
import { formatReference } from "../payments/reference";
import { quantityWithUnit } from "../measure-units";

export interface EmailBrand {
	merchant: string;
	language: string;
	accent: string | null;
	dateFormat: DateFormat;
	timezone?: string;
	replyTo: string | null;
	address: string[];
	whiteLabel: boolean;
	logoUrl: string | null;
	signature?: string | null;
	footerText?: string | null;
}

export interface EmailLine {
	description: string;
	quantity: number | null;
	unit?: string | null;
	gross: number;
}

export interface EmailContent {
	subject: string;
	text: string;
	html: string;
}

export interface InvoiceFacts {
	reference: string;
	currency: string;
	total: number;
	tax: number;
	outstanding: number;
	dueDate: number;
	paid: boolean;
}

export interface ReceiptFacts {
	reference: string;
	currency: string;
	total: number;
	tax: number;
	paidAt: number;
}

export type InvoiceEmailKind = "invoice" | "reminder_before" | "reminder_after" | "order_placed" | "proforma";

export interface KeyGroup {
	name: string;
	codes: string[];
}

type Tone = "success" | "warning" | "danger";

interface Summary {
	label: string;
	amount: string;
	status?: { label: string; tone: Tone } | null;
	facts: { label: string; value: string }[];
}

interface Section {
	heading: string;
	preheader?: string;
	paragraphs: string[];
	summary?: Summary | null;
	note?: { title: string; body: string } | null;
	keys?: KeyGroup[] | null;
	lines?: { rows: EmailLine[]; currency: string; tax: number; total: number } | null;
	details?: { title: string; rows: { label: string; value: string; mono?: boolean }[] } | null;
	button?: { label: string; url: string } | null;
	secondaryLink?: { intro: string; label: string; url: string } | null;
	closing: string[];
}

export function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export const money = formatMoneyIn;

export function emailDate(timestamp: number, brand: Pick<EmailBrand, "dateFormat" | "language" | "timezone">): string {
	return formatDateIn(timestamp, brand.dateFormat, brand.language, brand.timezone);
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
const PAGE = "#f3f4f6";
const CARD = "#ffffff";
const PANEL = "#f9fafb";
const LINE = "#e5e7eb";
const INK = "#111827";
const BODY = "#374151";
const MUTED = "#6b7280";
const FAINT = "#9ca3af";

const TONES: Record<Tone, { background: string; color: string }> = {
	success: { background: "#dcfce7", color: "#166534" },
	warning: { background: "#fef3c7", color: "#92400e" },
	danger: { background: "#fee2e2", color: "#991b1b" },
};

function paragraphHtml(text: string, style = `margin:0 0 16px;color:${BODY};`): string {
	return `<p style="${style}">${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
}

function pillHtml(label: string, tone: Tone): string {
	const colors = TONES[tone];
	return `<span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${colors.background};color:${colors.color};font-size:12px;font-weight:600;line-height:1.2;white-space:nowrap;">${escapeHtml(label)}</span>`;
}

function buttonHtml(label: string, url: string, accent: string, accentText: string): string {
	const href = escapeHtml(url);
	return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
<tr><td align="center" bgcolor="${accent}" style="border-radius:10px;background:${accent};">
<a href="${href}" target="_blank" style="display:inline-block;padding:14px 32px;font-family:${FONT};font-size:16px;font-weight:600;line-height:1.2;color:${accentText};text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>
</td></tr>
</table>`;
}

function tidy(text: string): string {
	return text.replace(/(?<!\.)\.\.(?=\s|$)/g, ".");
}

function tidySection(section: Section): Section {
	return {
		...section,
		heading: tidy(section.heading),
		preheader: section.preheader === undefined ? undefined : tidy(section.preheader),
		paragraphs: section.paragraphs.map(tidy),
		closing: section.closing.map(tidy),
	};
}

function render(brand: EmailBrand, subject: string, original: Section): EmailContent {
	const section = tidySection(original);
	const t = translator(brand.language);
	const accent = isAccentColor(brand.accent) ? brand.accent : BRAND_BLUE;
	const accentText = accentTextFor(accent);
	const footer = [t(brand.whiteLabel ? "email.footer_plain" : "email.footer", { merchant: brand.merchant }), ...brand.address, brand.footerText].filter(
		(line): line is string => Boolean(line)
	);
	const closing = [...section.closing, ...(brand.signature ? [brand.signature] : []), ...(brand.replyTo ? [t("email.reply")] : [])];

	const textParts: string[] = [section.heading, "", ...section.paragraphs];
	if (section.summary) {
		const { label, amount, status, facts } = section.summary;
		textParts.push("", `${label}: ${amount}${status ? ` (${status.label})` : ""}`, ...facts.map((fact) => `${fact.label}: ${fact.value}`));
	}
	if (section.note) textParts.push("", `${section.note.title}:`, section.note.body);
	if (section.keys) {
		for (const group of section.keys) textParts.push("", `${group.name}:`, ...group.codes);
	}
	if (section.lines) {
		const { rows, currency, tax, total } = section.lines;
		textParts.push("");
		for (const row of rows)
			textParts.push(
				`${row.quantity === null ? "" : `${quantityWithUnit(String(row.quantity), row.unit, brand.language)} x `}${row.description}  ${money(row.gross, currency, brand.language)}`
			);
		if (tax > 0) textParts.push(`${t("email.includes_tax")}: ${money(tax, currency, brand.language)}`);
		textParts.push(`${t("invoice.total")}: ${money(total, currency, brand.language)}`);
	}
	if (section.details) {
		textParts.push("", `${section.details.title}:`, ...section.details.rows.map((row) => `${row.label}: ${row.value}`));
	}
	if (section.button) textParts.push("", `${section.button.label}: ${section.button.url}`);
	if (section.secondaryLink) textParts.push("", section.secondaryLink.intro, `${section.secondaryLink.label}: ${section.secondaryLink.url}`);
	if (closing.length > 0) textParts.push("", ...closing);
	textParts.push("", "--", ...footer);

	const summaryHtml = section.summary
		? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 28px;background:${PANEL};border:1px solid ${LINE};border-radius:14px;border-collapse:separate;">
<tr><td style="padding:22px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr>
<td style="font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${MUTED};">${escapeHtml(section.summary.label)}</td>
<td align="right">${section.summary.status ? pillHtml(section.summary.status.label, section.summary.status.tone) : ""}</td>
</tr>
</table>
<p class="amount" style="margin:6px 0 ${section.summary.facts.length > 0 ? "16px" : "0"};font-size:34px;font-weight:700;letter-spacing:-0.02em;line-height:1.15;color:${INK};">${escapeHtml(section.summary.amount)}</p>
${
	section.summary.facts.length > 0
		? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${LINE};font-size:14px;">
${section.summary.facts
	.map(
		(fact) =>
			`<tr><td style="padding:10px 0 0;color:${MUTED};">${escapeHtml(fact.label)}</td><td align="right" style="padding:10px 0 0;color:${INK};font-weight:600;">${escapeHtml(fact.value)}</td></tr>`
	)
	.join("\n")}
</table>`
		: ""
}
</td></tr>
</table>`
		: "";

	const actionHtml = section.button
		? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:${section.summary ? "0" : "12px"} 0 28px;">
<tr><td align="center">${buttonHtml(section.button.label, section.button.url, accent, accentText)}</td></tr>
</table>`
		: "";

	const noteHtml = section.note
		? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
<tr><td style="padding:16px 20px;background:${PANEL};border-left:3px solid ${accent};border-radius:0 10px 10px 0;">
<p style="margin:0 0 6px;font-size:13px;font-weight:600;color:${INK};">${escapeHtml(section.note.title)}</p>
${paragraphHtml(section.note.body, `margin:0;color:${BODY};font-style:italic;`)}
</td></tr>
</table>`
		: "";

	const linesHtml = section.lines
		? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;font-size:14px;border-collapse:collapse;">
<tr>
<td style="padding:0 0 10px;border-bottom:1px solid ${LINE};font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${MUTED};">${escapeHtml(t("invoice.description"))}</td>
<td align="right" style="padding:0 0 10px;border-bottom:1px solid ${LINE};font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${MUTED};">${escapeHtml(t("invoice.amount"))}</td>
</tr>
${section.lines.rows
	.map(
		(row) =>
			`<tr><td style="padding:14px 16px 14px 0;border-bottom:1px solid ${LINE};color:${INK};vertical-align:top;">${escapeHtml(row.description)}${
				row.quantity === null || (row.quantity === 1 && !row.unit)
					? ""
					: `<br><span style="font-size:13px;color:${MUTED};">${escapeHtml(t("invoice.quantity"))} ${escapeHtml(quantityWithUnit(String(row.quantity), row.unit, brand.language))}</span>`
			}</td><td align="right" style="padding:14px 0;border-bottom:1px solid ${LINE};color:${INK};white-space:nowrap;vertical-align:top;">${escapeHtml(money(row.gross, section.lines!.currency, brand.language))}</td></tr>`
	)
	.join("\n")}
${
	section.lines.tax !== 0
		? `<tr><td style="padding:14px 0 0;color:${MUTED};">${escapeHtml(t("email.includes_tax"))}</td><td align="right" style="padding:14px 0 0;color:${MUTED};white-space:nowrap;">${escapeHtml(money(section.lines.tax, section.lines.currency, brand.language))}</td></tr>`
		: ""
}
<tr><td style="padding:8px 0 0;font-size:16px;font-weight:700;color:${INK};">${escapeHtml(t("invoice.total"))}</td><td align="right" style="padding:8px 0 0;font-size:16px;font-weight:700;color:${INK};white-space:nowrap;">${escapeHtml(money(section.lines.total, section.lines.currency, brand.language))}</td></tr>
</table>`
		: "";

	const detailsHtml = section.details
		? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;background:${PANEL};border:1px solid ${LINE};border-radius:14px;border-collapse:separate;">
<tr><td style="padding:20px 24px;">
<p style="margin:0 0 12px;font-size:15px;font-weight:700;color:${INK};">${escapeHtml(section.details.title)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
${section.details.rows
	.map(
		(row) =>
			`<tr><td style="padding:6px 16px 6px 0;color:${MUTED};white-space:nowrap;vertical-align:top;">${escapeHtml(row.label)}</td><td align="right" style="padding:6px 0;color:${INK};${row.mono ? `font-family:${MONO};` : ""}font-size:14px;word-break:break-all;">${escapeHtml(row.value)}</td></tr>`
	)
	.join("\n")}
</table>
</td></tr>
</table>`
		: "";

	const keysHtml = section.keys
		? section.keys
				.map(
					(group) =>
						`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
<tr><td style="padding:0 0 8px;font-size:14px;font-weight:700;color:${INK};">${escapeHtml(group.name)}</td></tr>
${group.codes
	.map(
		(code) =>
			`<tr><td style="padding:0 0 8px;"><div style="padding:14px 16px;background:${PANEL};border:1px dashed ${FAINT};border-radius:10px;font-family:${MONO};font-size:16px;letter-spacing:0.04em;color:${INK};text-align:center;word-break:break-all;">${escapeHtml(code)}</div></td></tr>`
	)
	.join("\n")}
</table>`
				)
				.join("\n")
		: "";

	const secondaryLinkHtml = section.secondaryLink
		? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-top:1px solid ${LINE};">
<tr><td style="padding:20px 0 0;">
${paragraphHtml(section.secondaryLink.intro, `margin:0 0 6px;color:${MUTED};font-size:14px;`)}
<a href="${escapeHtml(section.secondaryLink.url)}" target="_blank" style="color:${accent};font-size:14px;font-weight:600;text-decoration:none;">${escapeHtml(section.secondaryLink.label)}</a>
</td></tr>
</table>`
		: "";

	const linkHint = section.button
		? paragraphHtml(t("email.link_hint", { url: section.button.url }), `margin:0 0 8px;font-size:12px;color:${FAINT};word-break:break-all;`)
		: "";
	const closingHtml = closing.map((text) => paragraphHtml(text, `margin:0 0 8px;color:${MUTED};font-size:14px;`)).join("\n");
	const preheader = section.preheader ?? section.paragraphs[0] ?? section.heading;
	const brandHtml = brand.logoUrl
		? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.merchant)}" height="44" style="display:block;height:44px;max-width:200px;border:0;outline:none;text-decoration:none;">`
		: `<span style="font-size:18px;font-weight:700;letter-spacing:-0.01em;color:${INK};">${escapeHtml(brand.merchant)}</span>`;

	const html = `<!doctype html>
<html lang="${escapeHtml(brand.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(subject)}</title>
<style>
@media (max-width: 620px) {
.card { padding: 28px 22px !important; }
.amount { font-size: 28px !important; }
.shell { padding: 20px 10px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:${PAGE};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(preheader)}${"&#8199;&#65279;&#847; ".repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${PAGE}" style="background:${PAGE};">
<tr><td align="center" class="shell" style="padding:36px 16px;font-family:${FONT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
<tr><td align="center" style="padding:0 0 22px;">${brandHtml}</td></tr>
<tr><td style="background:${CARD};border:1px solid ${LINE};border-radius:18px;overflow:hidden;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td height="5" style="height:5px;line-height:5px;font-size:0;background:${accent};border-radius:18px 18px 0 0;">&nbsp;</td></tr>
<tr><td class="card" style="padding:40px 44px 36px;font-family:${FONT};font-size:15px;line-height:1.6;color:${BODY};">
${brand.logoUrl ? `<p style="margin:0 0 6px;font-size:13px;font-weight:600;color:${MUTED};">${escapeHtml(brand.merchant)}</p>` : ""}
<h1 style="margin:0 0 16px;font-size:26px;font-weight:700;letter-spacing:-0.02em;line-height:1.25;color:${INK};">${escapeHtml(section.heading)}</h1>
${section.paragraphs.map((text) => paragraphHtml(text)).join("\n")}
${summaryHtml}
${keysHtml}
${actionHtml}
${noteHtml}
${linesHtml}
${detailsHtml}
${secondaryLinkHtml}
${closingHtml}
${linkHint}
</td></tr>
</table>
</td></tr>
<tr><td align="center" style="padding:24px 24px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${FAINT};">
${footer.map((line) => escapeHtml(line)).join("<br>")}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

	return { subject, text: textParts.join("\n"), html };
}

export function customerLoginEmail(language: UiLanguage, url: string, store: { name: string; accent: string } | null = null): EmailContent {
	const brand: EmailBrand = {
		merchant: store?.name ?? "RabbitPay",
		language,
		accent: store?.accent ?? null,
		dateFormat: "auto",
		replyTo: null,
		address: [],
		whiteLabel: true,
		logoUrl: null,
	};
	if (store) {
		return render(brand, translate(language, "shop.email_subject", { merchant: store.name }), {
			heading: store.name,
			paragraphs: [translate(language, "shop.email_body", { merchant: store.name })],
			button: { label: translate(language, "shop.email_button"), url },
			closing: [translate(language, "portal.email_expiry")],
		});
	}
	return render(brand, translate(language, "portal.email_subject"), {
		heading: translate(language, "portal.title"),
		paragraphs: [translate(language, "portal.email_body")],
		button: { label: translate(language, "portal.continue"), url },
		closing: [translate(language, "portal.email_expiry")],
	});
}

export function invoiceEmail(
	brand: EmailBrand,
	kind: InvoiceEmailKind,
	invoice: InvoiceFacts,
	lines: EmailLine[],
	payUrl: string | null,
	message: string | null,
	extras: { bank?: BankInstruction | null; attached?: boolean; eslogAttached?: boolean; portalUrl?: string | null; custom?: EmailTexts } = {}
): EmailContent {
	const t = translator(brand.language);
	const custom = extras.custom;
	const due = emailDate(invoice.dueDate, brand);
	const params = {
		merchant: brand.merchant,
		reference: invoice.reference,
		date: due,
		amount: money(kind === "invoice" || kind === "order_placed" ? invoice.total : invoice.outstanding, invoice.currency, brand.language),
	};
	const order = kind === "order_placed";
	const proforma = kind === "proforma";

	const subjectKey: Record<InvoiceEmailKind, TranslationKey> = {
		invoice: "email.invoice.subject",
		reminder_before: "email.reminder_before.subject",
		reminder_after: "email.reminder_after.subject",
		order_placed: "email.order_placed.subject",
		proforma: "email.proforma.subject",
	};

	const paragraphs =
		kind === "invoice"
			? [customText(custom, "intro", t("email.invoice.intro", params), params), ...(invoice.paid ? [t("email.invoice.paid")] : [])]
			: order || proforma
				? [customText(custom, "intro", t(order ? "email.order_placed.intro" : "email.proforma.intro", params), params)]
				: [customText(custom, "intro", t(kind === "reminder_before" ? "email.reminder_before.intro" : "email.reminder_after.intro", params), params)];
	if (extras.attached) paragraphs.push(t(order ? "email.order_placed.attached" : proforma ? "email.proforma.attached" : "email.invoice.attached"));
	if (extras.eslogAttached) paragraphs.push(t("email.eslog_attached"));

	const bank = payUrl === null && !invoice.paid ? (extras.bank ?? null) : null;
	const amount = money(invoice.paid ? invoice.total : invoice.outstanding, invoice.currency, brand.language);
	const status: Summary["status"] = invoice.paid
		? { label: t("invoice.paid"), tone: "success" }
		: kind === "reminder_after"
			? { label: t("email.status.overdue"), tone: "danger" }
			: kind === "reminder_before"
				? { label: t("email.status.due_soon"), tone: "warning" }
				: null;

	return render(brand, customText(custom, "subject", t(subjectKey[kind], params), params), {
		heading: customText(
			custom,
			"heading",
			t(order ? "email.order_placed.heading" : proforma ? "email.proforma.heading" : "email.invoice.heading", params),
			params
		),
		preheader: invoice.paid ? undefined : `${amount} | ${t("invoice.due")}: ${due}`,
		paragraphs,
		summary: {
			label: t(invoice.paid ? "invoice.total" : "invoice.outstanding"),
			amount,
			status,
			facts: [
				{ label: t(order ? "email.order_placed.number" : proforma ? "invoice.title_proforma" : "invoice.title"), value: invoice.reference },
				...(invoice.paid ? [] : [{ label: t(order ? "email.order_placed.pay_by" : proforma ? "invoice.valid_until" : "invoice.due"), value: due }]),
			],
		},
		note: message ? { title: t("email.message_from", params), body: message } : null,
		lines: { rows: lines, currency: invoice.currency, tax: invoice.tax, total: invoice.total },
		details: bank
			? {
					title: t("bank.heading"),
					rows: [
						{ label: t("bank.account_holder"), value: bank.account.holder },
						{ label: t("bank.iban"), value: formatIban(bank.account.iban), mono: true },
						...(bank.account.bic ? [{ label: t("bank.bic"), value: bank.account.bic, mono: true }] : []),
						...(bank.account.bank_name ? [{ label: t("bank.bank_name"), value: bank.account.bank_name }] : []),
						{ label: t("bank.reference"), value: formatReference(bank.reference), mono: true },
						{ label: t("bank.amount"), value: money(bank.amount, bank.currency, brand.language) },
					],
				}
			: null,
		button: payUrl ? { label: customText(custom, "button", t("email.invoice.button"), params), url: payUrl } : null,
		secondaryLink: extras.portalUrl ? { intro: t("email.portal.intro"), label: t("email.portal.button"), url: extras.portalUrl } : null,
		closing: custom?.closing
			? [customText(custom, "closing", "", params)]
			: order || proforma
				? [t(order ? "email.order_placed.closing" : "email.proforma.closing")]
				: kind === "invoice"
					? []
					: [t("email.reminder.ignore")],
	});
}

export function receiptEmail(
	brand: EmailBrand,
	receipt: ReceiptFacts,
	lines: EmailLine[],
	receiptUrl: string,
	keys: KeyGroup[] = [],
	extras: { attached?: boolean; custom?: EmailTexts } = {}
): EmailContent {
	const custom = extras.custom;
	const t = translator(brand.language);
	const params = {
		merchant: brand.merchant,
		reference: receipt.reference,
		amount: money(receipt.total, receipt.currency, brand.language),
		date: emailDate(receipt.paidAt, brand),
	};

	return render(brand, customText(custom, "subject", t("email.receipt.subject", params), params), {
		heading: customText(custom, "heading", t("email.receipt.heading"), params),
		preheader: t("email.receipt.paid", params),
		paragraphs: [
			customText(custom, "intro", t("email.receipt.intro", params), params),
			t("email.receipt.paid", params),
			...(extras.attached ? [t("email.receipt.attached")] : []),
		],
		summary: {
			label: t("invoice.total"),
			amount: params.amount,
			status: { label: t("invoice.paid"), tone: "success" },
			facts: [
				{ label: t("invoice.title"), value: receipt.reference },
				{ label: t("invoice.paid"), value: params.date },
			],
		},
		keys: keys.length > 0 ? keys : null,
		lines: { rows: lines, currency: receipt.currency, tax: receipt.tax, total: receipt.total },
		button: { label: customText(custom, "button", t("email.receipt.button"), params), url: receiptUrl },
		closing: [...(keys.length > 0 ? [t("email.keys.keep")] : []), ...(custom?.closing ? [customText(custom, "closing", "", params)] : [])],
	});
}

export interface CreditNoteFacts {
	reference: string;
	invoiceReference: string;
	currency: string;
	total: number;
	tax: number;
	issuedAt: number;
}

export function creditNoteEmail(
	brand: EmailBrand,
	note: CreditNoteFacts,
	lines: EmailLine[],
	message: string | null,
	extras: { attached?: boolean; eslogAttached?: boolean; portalUrl?: string | null; custom?: EmailTexts } = {}
): EmailContent {
	const custom = extras.custom;
	const t = translator(brand.language);
	const params = {
		merchant: brand.merchant,
		reference: note.reference,
		invoice: note.invoiceReference,
		amount: money(note.total, note.currency, brand.language),
		date: emailDate(note.issuedAt, brand),
	};

	return render(brand, customText(custom, "subject", t("email.credit_note.subject", params), params), {
		heading: customText(custom, "heading", t("email.credit_note.heading", params), params),
		paragraphs: [
			customText(custom, "intro", t("email.credit_note.intro", params), params),
			...(extras.attached ? [t("email.credit_note.attached")] : []),
			...(extras.eslogAttached ? [t("email.eslog_attached")] : []),
		],
		summary: {
			label: t("credit.total"),
			amount: params.amount,
			facts: [
				{ label: t("credit.title"), value: note.reference },
				{ label: t("invoice.title"), value: note.invoiceReference },
				{ label: t("invoice.issued"), value: params.date },
			],
		},
		note: message ? { title: t("email.message_from", params), body: message } : null,
		lines: { rows: lines.map((line) => ({ ...line, gross: -line.gross })), currency: note.currency, tax: -note.tax, total: -note.total },
		secondaryLink: extras.portalUrl ? { intro: t("email.portal.intro"), label: t("email.portal.button"), url: extras.portalUrl } : null,
		closing: custom?.closing ? [customText(custom, "closing", "", params)] : [],
	});
}

export function keysEmail(brand: EmailBrand, order: { reference: string }, groups: KeyGroup[], orderUrl: string, custom?: EmailTexts): EmailContent {
	const t = translator(brand.language);
	const params = { merchant: brand.merchant, reference: order.reference };

	return render(brand, customText(custom, "subject", t("email.keys.subject", params), params), {
		heading: customText(custom, "heading", t("email.keys.heading"), params),
		paragraphs: [customText(custom, "intro", t("email.keys.intro", params), params)],
		keys: groups,
		button: { label: customText(custom, "button", t("email.keys.button"), params), url: orderUrl },
		closing: [customText(custom, "closing", t("email.keys.keep"), params)],
	});
}

export function orderUpdateEmail(
	brand: EmailBrand,
	order: { reference: string; fulfillment: "processing" | "shipped" | "delivered" },
	urls: { tracking: string | null; order: string },
	custom?: EmailTexts
): EmailContent {
	const t = translator(brand.language);
	const params = { merchant: brand.merchant, reference: order.reference };
	const tracking = order.fulfillment === "shipped" && urls.tracking;

	return render(brand, customText(custom, "subject", t(`email.order.subject_${order.fulfillment}`, params), params), {
		heading: customText(custom, "heading", t(`email.order.heading_${order.fulfillment}`), params),
		paragraphs: [customText(custom, "intro", t(`email.order.intro_${order.fulfillment}`, params), params)],
		button: tracking
			? { label: customText(custom, "button", t("email.order.track"), params), url: urls.tracking! }
			: { label: customText(custom, "button", t("email.order.view"), params), url: urls.order },
		closing: custom?.closing ? [customText(custom, "closing", "", params)] : [],
	});
}

export function invitationEmail(brand: EmailBrand, invitation: { inviter: string; role: string; url: string }): EmailContent {
	const t = translator(brand.language);
	const roleKey = `role.${invitation.role}` as TranslationKey;
	const params = { merchant: brand.merchant, inviter: invitation.inviter, role: t(roleKey) };

	return render(brand, t("email.invitation.subject", params), {
		heading: t("email.invitation.heading", params),
		paragraphs: [t(brand.whiteLabel ? "email.invitation.intro_plain" : "email.invitation.intro", params)],
		button: { label: t("email.invitation.button"), url: invitation.url },
		closing: [t("email.invitation.ignore")],
	});
}

export interface FiscalAlertLine {
	reference: string;
	problem: "rejected" | "due" | "late";
	code: string | null;
	message: string | null;
	deadline: number;
}

export function fiscalAlertEmail(brand: EmailBrand, lines: FiscalAlertLine[], url: string): EmailContent {
	const t = translator(brand.language);
	const params = { merchant: brand.merchant };
	const describe = (line: FiscalAlertLine): string => {
		const deadline = emailDate(line.deadline, brand);
		if (line.problem === "rejected") return t("email.fiscal_alert.rejected", { code: line.code ?? "", message: line.message ?? "" });
		return t(line.problem === "late" ? "email.fiscal_alert.late" : "email.fiscal_alert.due", { deadline });
	};

	return render(brand, t("email.fiscal_alert.subject", params), {
		heading: t("email.fiscal_alert.heading"),
		paragraphs: [t("email.fiscal_alert.intro", params)],
		details: { title: t("email.fiscal_alert.details"), rows: lines.map((line) => ({ label: line.reference, value: describe(line) })) },
		button: { label: t("email.fiscal_alert.button"), url },
		closing: [t("email.fiscal_alert.closing", params)],
	});
}

export interface NoticeContent {
	subject: string;
	heading: string;
	paragraphs: string[];
	note?: { title: string; body: string } | null;
	button: { label: string; url: string };
	closing?: string[];
}

export function noticeEmail(brand: EmailBrand, notice: NoticeContent): EmailContent {
	return render(brand, notice.subject, {
		heading: notice.heading,
		paragraphs: notice.paragraphs,
		note: notice.note ?? null,
		button: notice.button,
		closing: notice.closing ?? [],
	});
}
