import { Api, type Company, type CreditNoteDocument, type FiscalMarks, type InvoiceDesign, type InvoiceDocument } from "../api";
import { QRCode } from "@rabbit-company/qrcode";
import { FURS_QR_OPTIONS } from "../../../server/furs/qr";
import { formatReference } from "../../../server/payments/reference";
import { el } from "../dom";
import { formatDateIn, formatIban, formatMoneyIn, formatPercentIn, localeFor, type DateFormat } from "../../../server/formats";
import { qrBlock, shortQrCaption } from "../qr";
import { translator } from "../../../server/i18n";
import { isDraftReference } from "../../../server/invoice-numbers";
import { isCountryCode } from "../../../server/countries";
import { partyTaxIds } from "../../../server/tax";
import { referenceDocumentRow } from "../../../server/reference-document";
import { quantityWithUnit } from "../../../server/measure-units";
import { brandLogo, poweredBy } from "../branding";
import { t as ui } from "../i18n";

type Translate = ReturnType<typeof translator>;

function addressLines(party: Partial<Company> & { postal_code?: string | null; city?: string | null }, language: string): string[] {
	const town = [party.postal_code, party.city].filter(Boolean).join(" ");
	const country = party.country && isCountryCode(party.country) ? regionName(party.country, language) : party.country;
	return [party.address_line1, party.address_line2, town, party.state, country].filter((line): line is string => Boolean(line && String(line).trim()));
}

function onlineBody(online: InvoiceDocument["online"]): "qr.online_body" | "qr.online_body_card" | "qr.online_body_crypto" {
	if (online.card && !online.crypto) return "qr.online_body_card";
	if (online.crypto && !online.card) return "qr.online_body_crypto";
	return "qr.online_body";
}

function regionName(code: string, language: string): string {
	try {
		return new Intl.DisplayNames([localeFor(language)], { type: "region" }).of(code) ?? code;
	} catch {
		return code;
	}
}

function partyBlock(title: string, name: string | null, lines: string[], extras: string[]): HTMLElement {
	return el(
		"div",
		{ class: "party" },
		el("h3", { class: "doc-label" }, title),
		name ? el("p", { class: "party-name" }, name) : null,
		...lines.map((line) => el("p", {}, line)),
		...extras.map((extra) => el("p", { class: "doc-muted" }, extra))
	);
}

function parties(
	document_: { seller: InvoiceDocument["seller"]; buyer: InvoiceDocument["buyer"]; language: string },
	t: Translate,
	sellerExtras: string[]
): HTMLElement {
	const { seller, buyer, language } = document_;
	return el(
		"div",
		{ class: "doc-parties" },
		partyBlock(t("invoice.from"), seller.legal_name || seller.name, addressLines(seller, language), sellerExtras),
		buyer
			? partyBlock(
					t("invoice.to"),
					buyer.name || buyer.email,
					addressLines(buyer, language),
					partyTaxIds(buyer, null).map((id) => `${t(id.key)}: ${id.value}`)
				)
			: partyBlock(t("invoice.to"), null, [], [t("invoice.no_customer")])
	);
}

function header(design: InvoiceDesign, title: string, reference: string, logo: HTMLElement | null, dates: [string, string][]): HTMLElement {
	const right = design.logo_position === "right";
	return el(
		"header",
		{ class: "doc-head" },
		el(
			"div",
			{},
			right ? null : logo,
			el("h1", {}, title),
			el("p", { class: "doc-reference" }, reference),
			design.header_text ? el("p", { class: "doc-header-text" }, design.header_text) : null
		),
		el(
			"div",
			{ class: "doc-dates" },
			right ? logo : null,
			...dates.map(([label, value]) => el("p", {}, el("span", { class: "doc-muted" }, label), el("span", {}, value)))
		)
	);
}

function sellerExtrasOf(seller: InvoiceDocument["seller"], vatStatus: string | null, t: Translate, show: InvoiceDesign["show"]): string[] {
	return [
		...partyTaxIds(seller, vatStatus).map((id) => `${t(id.key)}: ${id.value}`),
		seller.registration_number ? `${t("invoice.registration_number")}: ${seller.registration_number}` : null,
		seller.email && show.email ? `${t("invoice.email")}: ${seller.email}` : null,
		seller.phone && show.phone ? `${t("invoice.phone")}: ${seller.phone}` : null,
		seller.website && show.website ? `${t("invoice.website")}: ${seller.website}` : null,
	].filter((entry): entry is string => entry !== null);
}

function closingNote(note: string | null): HTMLElement | null {
	return note ? el("div", { class: "doc-notes" }, el("p", {}, note)) : null;
}

function taxTable(t: Translate, groups: [number, { base: number; tax: number }][], format: (amount: number) => string, language: string): HTMLElement {
	return el(
		"table",
		{ class: "tax-table" },
		el("thead", {}, el("tr", {}, el("th", {}, t("invoice.tax_rate")), el("th", {}, t("invoice.net")), el("th", {}, t("invoice.tax")))),
		el(
			"tbody",
			{},
			...groups.map(([rate, totals]) =>
				el("tr", {}, el("td", {}, formatPercentIn(rate, language)), el("td", {}, format(totals.base)), el("td", {}, format(totals.tax)))
			)
		)
	);
}

function totalsBlock(rows: { label: string; value: string; strong?: boolean }[]): HTMLElement {
	return el(
		"div",
		{ class: "doc-totals" },
		...rows.map((row) => el("div", { class: row.strong ? "doc-total strong" : "doc-total" }, el("span", {}, row.label), el("span", {}, row.value)))
	);
}

function footer(lines: (string | null | undefined)[], powered: HTMLElement | null): HTMLElement {
	return el(
		"footer",
		{ class: "doc-footer" },
		...lines.filter((line): line is string => Boolean(line && line.trim())).map((line) => el("p", {}, line)),
		powered
	);
}

function fiscalBlock(fiscal: FiscalMarks | null, t: Translate, beside: HTMLElement | null = null): HTMLElement | null {
	if (!fiscal) return null;
	const code = el("div", { class: "doc-fiscal-code" });
	code.innerHTML = QRCode.encode(fiscal.code, FURS_QR_OPTIONS).toSVG({ scale: 3, margin: 4 });
	return el(
		"div",
		{ class: "doc-fiscal" },
		fiscal.environment === "test" ? el("p", { class: "doc-fiscal-test" }, t("fiscal.test")) : null,
		el(
			"div",
			{ class: "doc-fiscal-row" },
			el(
				"div",
				{ class: "doc-fiscal-marks" },
				el("p", {}, el("span", { class: "doc-muted" }, `${t("fiscal.issued")}: `), fiscal.issued),
				fiscal.operator ? el("p", {}, el("span", { class: "doc-muted" }, `${t("fiscal.operator")}: `), fiscal.operator) : null,
				el("p", {}, el("span", { class: "doc-muted" }, `${t("fiscal.zoi")}: `), el("span", { class: "doc-fiscal-mark" }, fiscal.zoi)),
				el("p", {}, el("span", { class: "doc-muted" }, `${t("fiscal.eor")}: `), el("span", { class: "doc-fiscal-mark" }, fiscal.eor ?? t("fiscal.pending")))
			),
			code,
			beside
		)
	);
}

function issuerBlock(document_: InvoiceDocument, t: Translate): HTMLElement | null {
	if (!document_.issuer) return null;
	return el(
		"div",
		{ class: "doc-issuer" },
		el("strong", {}, document_.seller.legal_name || document_.seller.name),
		el("p", {}, `${t("invoice.issued_by")} ${document_.issuer.name}`),
		document_.issuer.signature
			? el("div", { class: "doc-signature-box" }, el("img", { class: "doc-signature", src: document_.issuer.signature, alt: "" }))
			: null
	);
}

function page(design: InvoiceDesign, actions: HTMLElement, warning: HTMLElement | null, ...content: (HTMLElement | null)[]): HTMLElement {
	const sheet = el(
		"div",
		{ class: `document doc-layout-${design.layout} doc-font-${design.font} doc-logo-${design.logo_size}${design.accent ? " doc-accented" : ""}` },
		...content
	);
	if (design.accent) sheet.style.setProperty("--doc-accent", design.accent);
	return el("div", { class: "print-page" }, warning, actions, sheet);
}

const PRINT_DELAY_MS = 500;

let printFrame: { frame: HTMLIFrameElement; url: string } | null = null;

function releasePrintFrame() {
	if (!printFrame) return;
	printFrame.frame.remove();
	URL.revokeObjectURL(printFrame.url);
	printFrame = null;
}

function printBlob(blob: Blob) {
	releasePrintFrame();
	const url = URL.createObjectURL(blob);
	const frame = el("iframe", { class: "print-frame", title: ui("invoices.print"), src: url }) as HTMLIFrameElement;
	printFrame = { frame, url };
	frame.addEventListener("load", () => {
		setTimeout(() => {
			try {
				frame.contentWindow!.focus();
				frame.contentWindow!.print();
			} catch {
				window.open(url, "_blank");
			}
		}, PRINT_DELAY_MS);
	});
	document.body.append(frame);
}

export function printButton(load: () => Promise<Blob>, style = "primary"): HTMLElement {
	const button = el(
		"button",
		{
			class: `button ${style}`,
			type: "button",
			onClick: async () => {
				button.disabled = true;
				try {
					printBlob(await load());
				} catch (error) {
					reportError(error);
				} finally {
					button.disabled = false;
				}
			},
		},
		ui("invoices.print")
	) as HTMLButtonElement;
	return button;
}

export async function printView(uuid: string, invoiceId: string, fromTerminal = false): Promise<HTMLElement> {
	const document_ = fromTerminal ? await Api.saleDocument(uuid, invoiceId) : await Api.invoiceDocument(uuid, invoiceId);
	const actions = el(
		"div",
		{ class: "doc-actions no-print" },
		fromTerminal
			? el("a", { class: "button ghost", href: `/projects/${uuid}/pos` }, ui("print.back_to_terminal"))
			: el("a", { class: "button ghost", href: `/projects/${uuid}/invoices/${invoiceId}` }, ui("print.back_to_invoice")),
		printButton(async () => (await (fromTerminal ? Api.salePdf(uuid, invoiceId) : Api.invoicePdf(uuid, invoiceId))).blob)
	);
	return invoiceDocumentView(document_, actions, true);
}

export function invoiceDocumentView(document_: InvoiceDocument, actions: HTMLElement, showWarning = false): HTMLElement {
	const { invoice, seller, bank, language } = document_;
	const t = translator(language);
	const dateOf = (value: number) => formatDateIn(value, document_.formats.date as DateFormat, language, document_.formats.timezone);
	const format = (amount: number) => formatMoneyIn(amount, invoice.currency, language);

	const sellerExtras = sellerExtrasOf(seller, document_.tax.vat_status, t, document_.design.show);

	const dates: [string, string][] = [
		[t("invoice.issued"), dateOf(invoice.issued)],
		...(invoice.supply_date ? [[t("invoice.supplied"), dateOf(invoice.supply_date)] as [string, string]] : []),
		...(invoice.due_date !== null ? [[t("invoice.due"), dateOf(invoice.due_date)] as [string, string]] : []),
		...(invoice.paid_date ? [[t("invoice.paid"), dateOf(invoice.paid_date)] as [string, string]] : []),
	];
	const reference = referenceDocumentRow(invoice.reference_document, t, dateOf);
	if (reference) dates.push(reference);

	const groups = new Map<number, { base: number; tax: number }>();
	for (const item of document_.items) {
		const current = groups.get(item.tax_rate) ?? { base: 0, tax: 0 };
		current.base += item.total_price - item.discount_amount;
		current.tax += item.tax_amount;
		groups.set(item.tax_rate, current);
	}
	const sortedGroups = [...groups.entries()].sort((left, right) => left[0] - right[0]);

	const items = el(
		"table",
		{ class: "doc-items invoice-lines" },
		el(
			"thead",
			{},
			el(
				"tr",
				{},
				el("th", {}, t("invoice.description")),
				el("th", {}, t("invoice.quantity")),
				el("th", {}, t("invoice.unit_price")),
				el("th", {}, t("invoice.tax")),
				el("th", {}, t("invoice.amount"))
			)
		),
		el(
			"tbody",
			{},
			...document_.items.map((item) =>
				el(
					"tr",
					{},
					el("td", {}, item.description),
					el("td", {}, quantityWithUnit(String(item.quantity), item.unit, language)),
					el("td", {}, format(item.unit_price)),
					el("td", {}, formatPercentIn(item.tax_rate, language)),
					el("td", {}, format(item.total_price + item.tax_amount))
				)
			)
		)
	);

	const totals = totalsBlock([
		{ label: t("invoice.subtotal"), value: format(invoice.subtotal) },
		...(invoice.discount_amount > 0 ? [{ label: t("invoice.discount"), value: `-${format(invoice.discount_amount)}` }] : []),
		{ label: t("invoice.tax"), value: format(invoice.tax_amount) },
		{ label: t("invoice.total"), value: format(invoice.total_amount), strong: true },
		...(invoice.paid_amount > 0 ? [{ label: t("invoice.paid"), value: format(invoice.paid_amount) }] : []),
		...(invoice.outstanding !== invoice.total_amount ? [{ label: t("invoice.outstanding"), value: format(invoice.outstanding), strong: true }] : []),
	]);

	document.title = isDraftReference(invoice.reference) ? `Invoice draft ${seller.name}` : `Invoice ${invoice.reference}`;

	const codes = [
		bank?.qr ? qrBlock(bank.qr, shortQrCaption(bank.qr.format, language), 4) : null,
		document_.pay_qr ? qrBlock(document_.pay_qr, bank ? t("qr.online") : undefined, 4) : null,
	].filter((code): code is HTMLElement => code !== null);

	const details: [string, string][] = bank
		? [
				[t("bank.account_holder"), bank.account.holder],
				[t("bank.iban"), formatIban(bank.account.iban)],
				...(bank.account.bic ? [[t("bank.bic"), bank.account.bic] as [string, string]] : []),
				...(bank.account.bank_name ? [[t("bank.bank_name"), bank.account.bank_name] as [string, string]] : []),
				[t("bank.reference"), formatReference(bank.reference)],
				[t("bank.amount"), formatMoneyIn(bank.amount, bank.currency, language)],
			]
		: [];

	const paymentText = bank
		? el(
				"div",
				{ class: "doc-payment-text" },
				el("h3", {}, t("bank.heading")),
				el("dl", { class: "doc-details" }, ...details.flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, value)])),
				bank.qr_unavailable ? el("p", { class: "doc-note" }, t(`qr.unavailable.${bank.qr_unavailable}` as never)) : null
			)
		: el("div", { class: "doc-payment-text" }, el("h3", {}, t("qr.online_heading")), el("p", {}, t(onlineBody(document_.online))));

	const payment =
		bank || codes.length > 0 ? el("div", { class: "doc-payment" }, paymentText, codes.length > 0 ? el("div", { class: "doc-codes" }, ...codes) : null) : null;

	const reporting = document_.tax.reporting
		? t("tax.reporting", {
				currency: document_.tax.reporting.currency,
				amount: formatMoneyIn(document_.tax.reporting.tax_amount, document_.tax.reporting.currency, language),
				from: invoice.currency,
				rate: document_.tax.reporting.rate.toLocaleString(localeFor(language), { maximumFractionDigits: 6 }),
				date: document_.tax.reporting.date === null ? "" : dateOf(document_.tax.reporting.date),
			})
		: null;

	const warning =
		showWarning && (!seller.legal_name || !seller.address_line1) ? el("div", { class: "doc-warning no-print" }, ui("print.incomplete_company")) : null;

	const issuer = issuerBlock(document_, t);

	return page(
		document_.design,
		actions,
		warning,
		header(document_.design, t("invoice.title"), invoice.reference, brandLogo(document_.branding, seller.name, "doc-logo"), dates),
		parties(document_, t, sellerExtras),
		items,
		el("div", { class: "doc-summary" }, sortedGroups.length > 0 ? taxTable(t, sortedGroups, format, language) : el("div", {}), totals),
		invoice.notes ? el("div", { class: "doc-notes" }, el("h3", { class: "doc-label" }, t("invoice.notes")), el("p", {}, invoice.notes)) : null,
		closingNote(document_.closing_note),
		payment,
		footer(
			[document_.tax.exemption_note, ...document_.tax.notes, reporting, seller.footer_note, document_.design.footer_text],
			poweredBy(document_.branding, t("brand.powered_by"))
		),
		document_.fiscal ? fiscalBlock(document_.fiscal, t, issuer) : issuer
	);
}

export async function creditNotePrintView(uuid: string, noteId: string): Promise<HTMLElement> {
	const document_ = await Api.creditNoteDocument(uuid, noteId);
	const actions = el(
		"div",
		{ class: "doc-actions no-print" },
		el("a", { class: "button ghost", href: `/projects/${uuid}/invoices/${document_.corrects.uuid}` }, ui("print.back_to_invoice")),
		printButton(async () => (await Api.creditNotePdf(uuid, noteId)).blob)
	);
	return creditNoteDocumentView(document_, actions);
}

export function creditNoteDocumentView(document_: CreditNoteDocument, actions: HTMLElement): HTMLElement {
	const { credit_note: note, seller, corrects, language } = document_;
	const t = translator(language);
	const dateOf = (value: number) => formatDateIn(value, document_.formats.date as DateFormat, language, document_.formats.timezone);
	const negative = (amount: number) => formatMoneyIn(-amount, note.currency, language);

	const sellerExtras = sellerExtrasOf(seller, document_.tax.vat_status, t, document_.design.show);

	const groups = new Map<number, { base: number; tax: number }>();
	for (const item of document_.items) {
		const current = groups.get(item.tax_rate) ?? { base: 0, tax: 0 };
		current.base += item.net_amount;
		current.tax += item.tax_amount;
		groups.set(item.tax_rate, current);
	}

	document.title = `Credit note ${note.reference}`;

	const reporting = document_.tax.reporting
		? t("tax.reporting", {
				currency: document_.tax.reporting.currency,
				amount: formatMoneyIn(-document_.tax.reporting.tax_amount, document_.tax.reporting.currency, language),
				from: note.currency,
				rate: document_.tax.reporting.rate.toLocaleString(localeFor(language), { maximumFractionDigits: 6 }),
				date: document_.tax.reporting.date === null ? "" : dateOf(document_.tax.reporting.date),
			})
		: null;

	return page(
		document_.design,
		actions,
		null,
		header(document_.design, t("credit.title"), note.reference, brandLogo(document_.branding, seller.name, "doc-logo"), [
			[t("invoice.issued"), dateOf(note.issued)],
		]),
		parties(document_, t, sellerExtras),
		el(
			"div",
			{ class: "doc-notes" },
			el("p", {}, t("credit.corrects", { reference: corrects.reference, date: dateOf(corrects.issued) })),
			note.reason ? el("p", {}, el("span", { class: "doc-muted" }, `${t("credit.reason")}: `), note.reason) : null
		),
		el(
			"table",
			{ class: "doc-items" },
			el(
				"thead",
				{},
				el("tr", {}, el("th", {}, t("invoice.description")), el("th", {}, t("invoice.tax")), el("th", {}, t("invoice.net")), el("th", {}, t("invoice.amount")))
			),
			el(
				"tbody",
				{},
				...document_.items.map((item) =>
					el(
						"tr",
						{},
						el("td", {}, item.description),
						el("td", {}, formatPercentIn(item.tax_rate, language)),
						el("td", {}, negative(item.net_amount)),
						el("td", {}, negative(item.net_amount + item.tax_amount))
					)
				)
			)
		),
		el(
			"div",
			{ class: "doc-summary" },
			taxTable(
				t,
				[...groups.entries()].sort((left, right) => left[0] - right[0]),
				(amount) => negative(amount),
				language
			),
			totalsBlock([
				{ label: t("invoice.subtotal"), value: negative(note.subtotal) },
				{ label: t("invoice.tax"), value: negative(note.tax_amount) },
				{ label: t("credit.total"), value: negative(note.total_amount), strong: true },
			])
		),
		closingNote(document_.closing_note),
		footer(
			[document_.tax.exemption_note, ...document_.tax.notes, reporting, seller.footer_note, document_.design.footer_text],
			poweredBy(document_.branding, t("brand.powered_by"))
		),
		fiscalBlock(document_.fiscal, t)
	);
}
