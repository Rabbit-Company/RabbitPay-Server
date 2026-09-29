import PDFDocument from "pdfkit";
import { QRCode } from "@rabbit-company/qrcode";
import { latin2 } from "@rabbit-company/qrcode/payload";
import regularFontPath from "./assets/fonts/NotoSans-Regular.ttf" with { type: "file" };
import boldFontPath from "./assets/fonts/NotoSans-Bold.ttf" with { type: "file" };
import serifRegularFontPath from "./assets/fonts/NotoSerif-Regular.ttf" with { type: "file" };
import serifBoldFontPath from "./assets/fonts/NotoSerif-Bold.ttf" with { type: "file" };
import { LOGO_BOXES, type InvoiceDesign } from "./invoice-design";
import { isCountryCode } from "./countries";
import { partyTaxIds } from "./tax";
import { formatDateIn, formatIban, formatMoneyIn, formatPercentIn, localeFor, type DateFormat } from "./formats";
import { translator, type TranslationKey } from "./i18n";
import { UPN_QR_OPTIONS } from "./upn-qr";
import { formatReference } from "./payments/reference";
import { FURS_QR_OPTIONS } from "./furs/qr";
import { referenceDocumentRow } from "./reference-document";
import { quantityWithUnit } from "./measure-units";
import { DOCUMENT_TITLES, documentDateRows, documentNote } from "./document-kind";
import type { invoiceDocument } from "./invoice-document";
import type { creditNoteDocument } from "./credit-note-document";

export type InvoiceDocument = Awaited<ReturnType<typeof invoiceDocument>>;
export type CreditNoteDocument = Awaited<ReturnType<typeof creditNoteDocument>>;
export type LogoSource = { type: string; bytes: Uint8Array };
type Translate = ReturnType<typeof translator>;
type Pdf = InstanceType<typeof PDFDocument>;

interface QrSource {
	format: string;
	payload: string;
	encoding: string;
}

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const RIGHT_EDGE = PAGE_WIDTH - MARGIN;
const LINE_FACTOR = 1.4;
const QR_SIZE = 112;
const QR_GAP = 12;
const ISSUER_WIDTH = 260;
const ISSUER_BESIDE_FISCAL_WIDTH = 180;

const TEXT = "#1a1d21";
const MUTED = "#59616e";
const BORDER = "#b8bec7";

const REGULAR = "regular";
const BOLD = "bold";

const MODERN_FALLBACK_ACCENT = "#334155";
const FONT_FILES: Record<InvoiceDesign["font"], [string, string]> = {
	sans: [regularFontPath, boldFontPath],
	serif: [serifRegularFontPath, serifBoldFontPath],
};
const fontBytes = new Map<InvoiceDesign["font"], Promise<[Buffer, Buffer]>>();

function loadFonts(font: InvoiceDesign["font"]): Promise<[Buffer, Buffer]> {
	let loaded = fontBytes.get(font);
	if (!loaded) {
		const [regular, bold] = FONT_FILES[font];
		loaded = Promise.all([Bun.file(regular).arrayBuffer(), Bun.file(bold).arrayBuffer()]).then(
			([regularBytes, boldBytes]) => [Buffer.from(regularBytes), Buffer.from(boldBytes)] as [Buffer, Buffer]
		);
		fontBytes.set(font, loaded);
	}
	return loaded;
}

interface Theme {
	design: InvoiceDesign;
	accent: string | null;
	tint: string | null;
	scale: number;
	spacing: number;
}

export function tintOf(hex: string, amount: number): string {
	const channel = (offset: number) => {
		const value = parseInt(hex.slice(offset, offset + 2), 16);
		return Math.round(value + (255 - value) * (1 - amount))
			.toString(16)
			.padStart(2, "0");
	};
	return `#${channel(1)}${channel(3)}${channel(5)}`;
}

function themeOf(design: InvoiceDesign): Theme {
	const accent = design.layout === "modern" ? (design.accent ?? MODERN_FALLBACK_ACCENT) : design.accent;
	return {
		design,
		accent,
		tint: design.layout === "modern" && accent ? tintOf(accent, 0.1) : null,
		scale: design.layout === "compact" ? 0.88 : 1,
		spacing: design.layout === "compact" ? 0.6 : 1,
	};
}

interface TextStyle {
	bold?: boolean;
	size?: number;
	color?: string;
	align?: "left" | "right";
}

class Layout {
	cursor = MARGIN;

	constructor(
		readonly pdf: Pdf,
		readonly theme: Theme
	) {}

	gap(value: number): number {
		return value * this.theme.spacing;
	}

	ensure(height: number) {
		if (this.cursor + height <= PAGE_HEIGHT - MARGIN) return;
		this.pdf.addPage();
		this.cursor = MARGIN;
	}

	lineHeight(size: number): number {
		return size * this.theme.scale * LINE_FACTOR;
	}

	width(value: string, style: TextStyle = {}): number {
		return this.pdf
			.font(style.bold ? BOLD : REGULAR)
			.fontSize((style.size ?? 10) * this.theme.scale)
			.widthOfString(value);
	}

	wrap(value: string, width: number, style: TextStyle = {}): string[] {
		const lines: string[] = [];
		for (const paragraph of value.split(/\r?\n/)) {
			let line = "";
			for (const word of paragraph.split(/\s+/).filter(Boolean)) {
				const candidate = line ? `${line} ${word}` : word;
				if (this.width(candidate, style) <= width) {
					line = candidate;
					continue;
				}
				if (line) lines.push(line);
				let rest = word;
				while (this.width(rest, style) > width && rest.length > 1) {
					let cut = rest.length - 1;
					while (cut > 1 && this.width(rest.slice(0, cut), style) > width) cut--;
					lines.push(rest.slice(0, cut));
					rest = rest.slice(cut);
				}
				line = rest;
			}
			lines.push(line);
		}
		return lines;
	}

	text(value: string, x: number, top: number, style: TextStyle = {}) {
		const width = this.width(value, style);
		const left = style.align === "right" ? x - width : x;
		this.pdf.fillColor(style.color ?? TEXT).text(value, left, top, { lineBreak: false });
	}

	rule(top: number, from = MARGIN, to = RIGHT_EDGE) {
		this.pdf.moveTo(from, top).lineTo(to, top).lineWidth(1).strokeColor(BORDER).stroke();
	}

	paragraph(value: string, width: number, style: TextStyle = {}) {
		const size = style.size ?? 10;
		for (const line of this.wrap(value, width, style)) {
			this.ensure(this.lineHeight(size));
			this.text(line, MARGIN, this.cursor, style);
			this.cursor += this.lineHeight(size);
		}
	}
}

function regionName(code: string, language: string): string {
	try {
		return new Intl.DisplayNames([localeFor(language)], { type: "region" }).of(code) ?? code;
	} catch {
		return code;
	}
}

function addressLines(
	party: {
		address_line1?: string | null;
		address_line2?: string | null;
		postal_code?: string | null;
		city?: string | null;
		state?: string | null;
		country?: string | null;
	},
	language: string
): string[] {
	const town = [party.postal_code, party.city].filter(Boolean).join(" ");
	const country = party.country && isCountryCode(party.country) ? regionName(party.country, language) : party.country;
	return [party.address_line1, party.address_line2, town, party.state, country].filter((line): line is string => Boolean(line && String(line).trim()));
}

function qrMatrix(source: QrSource): boolean[][] | null {
	try {
		if (source.format === "upn") return QRCode.encodeBinary(latin2(source.payload), UPN_QR_OPTIONS).toArray();
		if (source.encoding === "latin2") return QRCode.encodeBinary(latin2(source.payload)).toArray();
		return QRCode.encode(source.payload).toArray();
	} catch {
		return null;
	}
}

function drawQr(pdf: Pdf, matrix: boolean[][], x: number, top: number, size: number, quiet = 2) {
	const cell = size / (matrix.length + quiet * 2);
	pdf.rect(x, top, size, size).fill("#ffffff");

	matrix.forEach((row, rowIndex) => {
		let start = -1;
		for (let column = 0; column <= row.length; column++) {
			const dark = column < row.length && row[column];
			if (dark && start < 0) start = column;
			if (!dark && start >= 0) {
				pdf.rect(x + (start + quiet) * cell, top + (rowIndex + quiet) * cell, (column - start) * cell, cell);
				start = -1;
			}
		}
	});
	pdf.fill("#000000");
}

type TaxGroups = [number, { base: number; tax: number }][];

function taxGroups(lines: { tax_rate: number; base: number; tax: number }[]): TaxGroups {
	const groups = new Map<number, { base: number; tax: number }>();
	for (const line of lines) {
		const current = groups.get(line.tax_rate) ?? { base: 0, tax: 0 };
		current.base += line.base;
		current.tax += line.tax;
		groups.set(line.tax_rate, current);
	}
	return [...groups.entries()].sort((left, right) => left[0] - right[0]);
}

function onlineBody(online: InvoiceDocument["online"]): TranslationKey {
	if (online.card && !online.crypto) return "qr.online_body_card";
	if (online.crypto && !online.card) return "qr.online_body_crypto";
	return "qr.online_body";
}

export interface Logo {
	bytes: Buffer;
	width: number;
	height: number;
}

function drawHeader(layout: Layout, title: string, reference: string, logo: Logo | null, dates: [string, string][]) {
	const { pdf, theme } = layout;
	const { design } = theme;
	let left = layout.cursor;
	let right = layout.cursor;

	if (logo) {
		const box = LOGO_BOXES[design.logo_size];
		const scale = Math.min(box.width / logo.width, box.height / logo.height, 1);
		const width = logo.width * scale;
		const height = logo.height * scale;
		if (design.logo_position === "right") {
			pdf.image(logo.bytes, RIGHT_EDGE - width, right, { width, height });
			right += height + layout.gap(12);
		} else {
			pdf.image(logo.bytes, MARGIN, left, { width, height });
			left += height + layout.gap(12);
		}
	}

	const titleSize = design.layout === "modern" ? 26 : 22;
	layout.text(title, MARGIN, left, { bold: true, size: titleSize, color: theme.accent ?? TEXT });
	left += layout.lineHeight(titleSize);
	layout.text(reference, MARGIN, left, { size: 11, color: MUTED });
	left += layout.lineHeight(11);
	if (design.header_text) {
		for (const line of layout.wrap(design.header_text, CONTENT_WIDTH / 2, { size: 9 })) {
			layout.text(line, MARGIN, left, { size: 9, color: MUTED });
			left += layout.lineHeight(9);
		}
	}

	for (const [label, value] of dates) {
		layout.text(value, RIGHT_EDGE, right, { align: "right" });
		layout.text(label, RIGHT_EDGE - layout.width(value) - 6, right, { align: "right", color: MUTED });
		right += layout.lineHeight(10);
	}

	layout.cursor = Math.max(left, right) + layout.gap(20);
}

function drawParty(layout: Layout, x: number, width: number, title: string, name: string, lines: string[], extras: string[]): number {
	let cursor = layout.cursor;
	const labelColor = layout.theme.design.layout === "modern" && layout.theme.accent ? layout.theme.accent : MUTED;
	layout.text(title.toUpperCase(), x, cursor, { bold: true, size: 8, color: labelColor });
	cursor += layout.lineHeight(8) + 2;

	for (const line of name ? layout.wrap(name, width, { bold: true, size: 11 }) : []) {
		layout.text(line, x, cursor, { bold: true, size: 11 });
		cursor += layout.lineHeight(11);
	}
	const rows = [...lines.map((line) => ({ line, color: TEXT })), ...extras.map((line) => ({ line, color: MUTED }))];
	for (const row of rows) {
		for (const line of layout.wrap(row.line, width)) {
			layout.text(line, x, cursor, { color: row.color });
			cursor += layout.lineHeight(10);
		}
	}
	return cursor;
}

function drawParties(
	layout: Layout,
	parties: { seller: InvoiceDocument["seller"]; buyer: InvoiceDocument["buyer"]; language: string },
	t: Translate,
	sellerExtras: string[]
) {
	const { seller, buyer, language } = parties;
	const column = (CONTENT_WIDTH - 24) / 2;
	const buyerX = MARGIN + column + 24;

	const sellerBottom = drawParty(layout, MARGIN, column, t("invoice.from"), seller.legal_name || seller.name, addressLines(seller, language), sellerExtras);
	const buyerBottom = buyer
		? drawParty(
				layout,
				buyerX,
				column,
				t("invoice.to"),
				buyer.name || buyer.email,
				addressLines(buyer, language),
				partyTaxIds(buyer, null).map((id) => `${t(id.key)}: ${id.value}`)
			)
		: drawParty(layout, buyerX, column, t("invoice.to"), "", [], [t("invoice.no_customer")]);

	layout.cursor = Math.max(sellerBottom, buyerBottom) + layout.gap(20);
}

interface LineColumn {
	heading: string;
	offset: number;
}

function drawLines(layout: Layout, description: string, columns: LineColumn[], rows: { description: string; cells: string[] }[]) {
	const descriptionWidth = RIGHT_EDGE - Math.max(...columns.map((column) => column.offset)) - 50 - MARGIN;
	const headingStyle = { bold: true, size: 9, color: MUTED };

	const heading = () => {
		layout.ensure(layout.lineHeight(9) + 40);
		if (layout.theme.tint) layout.pdf.rect(MARGIN, layout.cursor - 4, CONTENT_WIDTH, layout.lineHeight(9) + 6).fill(layout.theme.tint);
		layout.text(description, MARGIN, layout.cursor, headingStyle);
		for (const column of columns) layout.text(column.heading, RIGHT_EDGE - column.offset, layout.cursor, { ...headingStyle, align: "right" });
		layout.cursor += layout.lineHeight(9) + 2;
		layout.rule(layout.cursor);
		layout.cursor += 6;
	};

	heading();
	for (const row of rows) {
		const lines = layout.wrap(row.description, descriptionWidth);
		const height = lines.length * layout.lineHeight(10) + 12;
		if (layout.cursor + height > PAGE_HEIGHT - MARGIN) {
			layout.ensure(PAGE_HEIGHT);
			heading();
		}
		const top = layout.cursor;
		lines.forEach((line, index) => layout.text(line, MARGIN, top + index * layout.lineHeight(10)));
		columns.forEach((column, index) => layout.text(row.cells[index] ?? "", RIGHT_EDGE - column.offset, top, { align: "right" }));
		layout.cursor += lines.length * layout.lineHeight(10) + layout.gap(6);
		layout.rule(layout.cursor);
		layout.cursor += layout.gap(6);
	}
	layout.cursor += layout.gap(10);
}

interface TotalRow {
	label: string;
	value: string;
	strong?: boolean;
}

function drawSummary(layout: Layout, t: Translate, groups: TaxGroups, totals: TotalRow[], format: (amount: number) => string, language: string) {
	const totalsLeft = RIGHT_EDGE - 220;
	const rowHeight = layout.lineHeight(10) + 4;

	layout.ensure(Math.max(totals.length + 1, groups.length + 1) * rowHeight + 10);
	const top = layout.cursor;

	if (groups.length > 0) {
		const columns = { rate: MARGIN, net: MARGIN + 150, tax: MARGIN + 230 };
		const style = { bold: true, size: 9, color: MUTED };
		layout.text(t("invoice.tax_rate"), columns.rate, top, style);
		layout.text(t("invoice.net"), columns.net, top, { ...style, align: "right" });
		layout.text(t("invoice.tax"), columns.tax, top, { ...style, align: "right" });
		groups.forEach(([rate, sums], index) => {
			const row = top + (index + 1) * rowHeight;
			layout.text(formatPercentIn(rate, language), columns.rate, row);
			layout.text(format(sums.base), columns.net, row, { align: "right" });
			layout.text(format(sums.tax), columns.tax, row, { align: "right" });
		});
	}

	let cursor = top;
	for (const row of totals) {
		if (row.strong) {
			layout.rule(cursor - 2, totalsLeft, RIGHT_EDGE);
			cursor += 4;
		}
		const style = row.strong ? { bold: true, size: 11, color: layout.theme.accent ?? TEXT } : {};
		if (row.strong && layout.theme.tint)
			layout.pdf.rect(totalsLeft - 8, cursor - 4, RIGHT_EDGE - totalsLeft + 8, layout.lineHeight(11) + 6).fill(layout.theme.tint);
		layout.text(row.label, totalsLeft, cursor, style);
		layout.text(row.value, RIGHT_EDGE, cursor, { ...style, align: "right" });
		cursor += row.strong ? layout.lineHeight(11) + 4 : rowHeight;
	}

	layout.cursor = Math.max(cursor, top + (groups.length + 1) * rowHeight) + layout.gap(16);
}

function drawSection(layout: Layout, heading: string | null, body: string) {
	layout.ensure(layout.lineHeight(8) + layout.lineHeight(10) * 2);
	if (heading) {
		layout.text(heading.toUpperCase(), MARGIN, layout.cursor, { bold: true, size: 8, color: MUTED });
		layout.cursor += layout.lineHeight(8) + 2;
	}
	layout.paragraph(body, CONTENT_WIDTH);
	layout.cursor += layout.gap(12);
}

function drawPayment(layout: Layout, document: InvoiceDocument, t: Translate, format: (amount: number) => string, payLink: boolean) {
	const { pdf } = layout;
	const { bank } = document;
	const codes: { matrix: boolean[][]; caption: string | null }[] = [];

	if (bank?.qr) {
		const matrix = qrMatrix(bank.qr);
		if (matrix) codes.push({ matrix, caption: t(bank.qr.format === "upn" ? "qr.upn" : "qr.epc") });
	}
	if (payLink && document.pay_qr) {
		const matrix = qrMatrix(document.pay_qr);
		if (matrix) codes.push({ matrix, caption: bank ? t("qr.online") : null });
	}

	if (!bank && codes.length === 0) return;

	const details: { label: string; value: string }[] = bank
		? [
				{ label: t("bank.account_holder"), value: bank.account.holder },
				{ label: t("bank.iban"), value: formatIban(bank.account.iban) },
				...(bank.account.bic ? [{ label: t("bank.bic"), value: bank.account.bic }] : []),
				...(bank.account.bank_name ? [{ label: t("bank.bank_name"), value: bank.account.bank_name }] : []),
				{ label: t("bank.reference"), value: formatReference(bank.reference) },
				{ label: t("bank.amount"), value: format(bank.amount) },
			]
		: [];

	const padding = 14;
	const codesWidth = codes.length * QR_SIZE + Math.max(codes.length - 1, 0) * QR_GAP;
	const textWidth = CONTENT_WIDTH - padding * 2 - (codesWidth > 0 ? codesWidth + 16 : 0);
	const noteStyle = bank ? { size: 9, color: MUTED } : {};
	const note = bank
		? bank.qr_unavailable
			? layout.wrap(t(`qr.unavailable.${bank.qr_unavailable}` as TranslationKey), textWidth, noteStyle)
			: []
		: layout.wrap(t(onlineBody(document.online)), textWidth);

	const textHeight = layout.lineHeight(12) + 4 + (details.length + note.length) * layout.lineHeight(10);
	const codesHeight = codes.length > 0 ? QR_SIZE + layout.lineHeight(8) + 4 : 0;
	const height = Math.max(textHeight, codesHeight) + padding * 2;

	layout.ensure(height + 10);
	const top = layout.cursor;
	pdf.rect(MARGIN, top, CONTENT_WIDTH, height).lineWidth(1).strokeColor(BORDER).stroke();

	let cursor = top + padding;
	layout.text(bank ? t("bank.heading") : t("qr.online_heading"), MARGIN + padding, cursor, { bold: true, size: 12 });
	cursor += layout.lineHeight(12) + 4;

	const labelWidth = Math.max(0, ...details.map((entry) => layout.width(entry.label))) + 10;
	for (const entry of details) {
		layout.text(entry.label, MARGIN + padding, cursor, { color: MUTED });
		layout.text(entry.value, MARGIN + padding + labelWidth, cursor);
		cursor += layout.lineHeight(10);
	}
	for (const line of note) {
		layout.text(line, MARGIN + padding, cursor, noteStyle);
		cursor += layout.lineHeight(10);
	}

	let x = RIGHT_EDGE - padding - codesWidth;
	for (const code of codes) {
		drawQr(pdf, code.matrix, x, top + padding, QR_SIZE);
		if (code.caption) {
			const style = { size: 8, color: MUTED };
			layout.text(code.caption, x + (QR_SIZE - layout.width(code.caption, style)) / 2, top + padding + QR_SIZE + 4, style);
		}
		x += QR_SIZE + QR_GAP;
	}

	layout.cursor = top + height + layout.gap(18);
}

interface FooterSource {
	tax: InvoiceDocument["tax"];
	seller: InvoiceDocument["seller"];
	branding: InvoiceDocument["branding"];
	design: InvoiceDesign;
	language: string;
}

function drawFooter(layout: Layout, source: FooterSource, t: Translate, currency: string, dateOf: (value: number) => string, sign = 1) {
	const { tax, seller, language } = source;
	const lines = [
		tax.exemption_note,
		...tax.notes,
		tax.reporting
			? t("tax.reporting", {
					currency: tax.reporting.currency,
					amount: formatMoneyIn(sign * tax.reporting.tax_amount, tax.reporting.currency, language),
					from: currency,
					rate: tax.reporting.rate.toLocaleString(localeFor(language), { maximumFractionDigits: 6 }),
					date: tax.reporting.date === null ? "" : dateOf(tax.reporting.date),
				})
			: null,
		seller.footer_note,
		source.design.footer_text,
	].filter((line): line is string => Boolean(line && line.trim()));

	if (lines.length === 0) return;

	layout.ensure(layout.lineHeight(9) * 2 + 10);
	layout.rule(layout.cursor);
	layout.cursor += 10;
	for (const line of lines) layout.paragraph(line, CONTENT_WIDTH, { size: 9, color: MUTED });
}

interface IssuerBlock {
	height: number;
	draw(top: number): void;
}

async function prepareIssuer(layout: Layout, document: InvoiceDocument, t: Translate, width: number): Promise<IssuerBlock | null> {
	if (!document.issuer) return null;
	let signature: { bytes: Buffer; width: number; height: number } | null = null;
	if (document.issuer.signature) {
		try {
			const data = document.issuer.signature.replace(/^data:image\/png;base64,/, "");
			const bytes = Buffer.from(data, "base64");
			const metadata = await new Bun.Image(bytes).metadata();
			if (metadata.width && metadata.height) {
				const scale = Math.min(160 / metadata.width, 50 / metadata.height, 1);
				signature = { bytes, width: metadata.width * scale, height: metadata.height * scale };
			}
		} catch {
			void 0;
		}
	}
	const legalName = layout.wrap(document.seller.legal_name || document.seller.name, width, { bold: true });
	const issuedBy = layout.wrap(`${t("invoice.issued_by")} ${document.issuer.name}`, width);
	const line = layout.lineHeight(10);
	const signatureHeight = signature ? 55 : 0;

	return {
		height: signatureHeight + line * (legalName.length + issuedBy.length),
		draw(top: number) {
			let cursor = top;
			for (const entry of legalName) {
				layout.text(entry, RIGHT_EDGE, cursor, { bold: true, align: "right" });
				cursor += line;
			}
			for (const entry of issuedBy) {
				layout.text(entry, RIGHT_EDGE, cursor, { align: "right" });
				cursor += line;
			}
			if (signature) layout.pdf.image(signature.bytes, RIGHT_EDGE - 80 - signature.width / 2, cursor + 5, { width: signature.width, height: signature.height });
		},
	};
}

function drawClosing(layout: Layout, fiscal: InvoiceDocument["fiscal"], issuer: IssuerBlock | null, t: Translate) {
	if (!fiscal && !issuer) return;
	const size = 64;
	const gap = 16;
	const style = { size: 9 };
	const line = layout.lineHeight(9);
	const available = CONTENT_WIDTH - size - gap - (issuer ? ISSUER_BESIDE_FISCAL_WIDTH + gap : 0);
	const lines = fiscal
		? [
				`${t("fiscal.issued")}: ${fiscal.issued}`,
				fiscal.operator ? `${t("fiscal.operator")}: ${fiscal.operator}` : null,
				`${t("fiscal.zoi")}: ${fiscal.zoi}`,
				`${t("fiscal.eor")}: ${fiscal.eor ?? t("fiscal.pending")}`,
			]
				.filter((entry): entry is string => entry !== null)
				.flatMap((entry) => layout.wrap(entry, available, style))
		: [];
	const banner = fiscal?.environment === "test" ? line : 0;
	const band = Math.max(fiscal ? Math.max(lines.length * line, size) : 0, issuer?.height ?? 0);
	const height = banner + band;

	layout.ensure(height + 12);
	layout.cursor = Math.max(layout.cursor + 12, PAGE_HEIGHT - MARGIN - height);
	if (banner > 0) layout.paragraph(t("fiscal.test"), CONTENT_WIDTH, { size: 9, bold: true, color: "#b42318" });

	const top = layout.cursor;
	if (fiscal) {
		const textWidth = Math.max(...lines.map((entry) => layout.width(entry, style)));
		const textTop = top + Math.max((size - lines.length * line) / 2, 0);
		lines.forEach((entry, index) => layout.text(entry, MARGIN, textTop + index * line, style));
		drawQr(layout.pdf, QRCode.encode(fiscal.code, FURS_QR_OPTIONS).toArray(), MARGIN + textWidth + gap, top, size, 4);
	}
	issuer?.draw(top);
	layout.cursor = top + band;
}

export async function printableLogo(logo: LogoSource | null): Promise<Logo | null> {
	if (!logo) return null;
	try {
		const source = Buffer.from(logo.bytes.buffer, logo.bytes.byteOffset, logo.bytes.byteLength);
		const bytes = logo.type === "image/png" || logo.type === "image/jpeg" ? source : await new Bun.Image(source).png().buffer();
		const { width, height } = await new Bun.Image(bytes).metadata();
		if (!width || !height) return null;
		return { bytes, width, height };
	} catch {
		return null;
	}
}

function collect(pdf: Pdf): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
		pdf.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
		pdf.on("error", reject);
	});
}

interface PdfSource {
	language: string;
	seller: InvoiceDocument["seller"];
	branding: InvoiceDocument["branding"];
	design: InvoiceDesign;
}

function drawPageFooters(layout: Layout, source: PdfSource, t: Translate, reference: string) {
	const { pdf } = layout;
	const top = PAGE_HEIGHT - MARGIN + 18;
	const style = { size: 8, color: MUTED };
	const { start, count } = pdf.bufferedPageRange();

	for (let index = start; index < start + count; index++) {
		pdf.switchToPage(index);
		const bottom = pdf.page.margins.bottom;
		pdf.page.margins.bottom = 0;
		if (layout.theme.design.layout === "modern" && layout.theme.accent) pdf.rect(0, 0, PAGE_WIDTH, 6).fill(layout.theme.accent);
		if (!source.branding.white_label) layout.text(t("brand.powered_by"), MARGIN, top, style);
		if (count > 1) {
			const page = t("document.page", { page: index - start + 1, pages: count });
			layout.text(`${reference} | ${page}`, RIGHT_EDGE, top, { ...style, align: "right" });
		}
		pdf.page.margins.bottom = bottom;
	}
}

async function startPdf(source: PdfSource, title: string): Promise<{ pdf: Pdf; layout: Layout; output: Promise<Uint8Array> }> {
	const [regular, bold] = await loadFonts(source.design.font);
	const brand = source.branding.white_label ? source.seller.name : "RabbitPay";

	const pdf = new PDFDocument({
		size: "A4",
		margin: MARGIN,
		font: null as never,
		lang: localeFor(source.language),
		displayTitle: true,
		bufferPages: true,
		info: {
			Title: title,
			Author: source.seller.legal_name || source.seller.name,
			Creator: brand,
			Producer: brand,
		},
	});
	pdf.registerFont(REGULAR, regular);
	pdf.registerFont(BOLD, bold);
	pdf.font(REGULAR);
	return { pdf, layout: new Layout(pdf, themeOf(source.design)), output: collect(pdf) };
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

export async function buildInvoicePdf(document: InvoiceDocument, logo: LogoSource | null, options: { payLink: boolean }): Promise<Uint8Array> {
	const { invoice } = document;
	const t = translator(document.language);
	const dateOf = (value: number) => formatDateIn(value, document.formats.date as DateFormat, document.language, document.formats.timezone);
	const format = (amount: number) => formatMoneyIn(amount, invoice.currency, document.language);
	const title = t(DOCUMENT_TITLES[document.kind]);
	const { pdf, layout, output } = await startPdf(document, `${title} ${invoice.reference}`);

	const dates: [string, string][] = documentDateRows(document).map(([key, value]) => [t(key), dateOf(value)]);
	const reference = referenceDocumentRow(invoice.reference_document, t, dateOf);

	drawHeader(layout, title, invoice.reference, await printableLogo(logo), reference ? [...dates, reference] : dates);
	drawParties(layout, document, t, sellerExtrasOf(document.seller, document.tax.vat_status, t, document.design.show));
	drawLines(
		layout,
		t("invoice.description"),
		[
			{ heading: t("invoice.quantity"), offset: 230 },
			{ heading: t("invoice.unit_price"), offset: 140 },
			{ heading: t("invoice.tax"), offset: 90 },
			{ heading: t("invoice.amount"), offset: 0 },
		],
		document.items.map((item) => ({
			description: item.description,
			cells: [
				quantityWithUnit(String(item.quantity), item.unit, document.language),
				format(item.unit_price),
				formatPercentIn(item.tax_rate, document.language),
				format(item.total_price + item.tax_amount),
			],
		}))
	);
	drawSummary(
		layout,
		t,
		taxGroups(document.items.map((item) => ({ tax_rate: item.tax_rate, base: item.total_price - item.discount_amount, tax: item.tax_amount }))),
		[
			{ label: t("invoice.subtotal"), value: format(invoice.subtotal) },
			...(invoice.discount_amount > 0 ? [{ label: t("invoice.discount"), value: `-${format(invoice.discount_amount)}` }] : []),
			{ label: t("invoice.tax"), value: format(invoice.tax_amount) },
			{ label: t("invoice.total"), value: format(invoice.total_amount), strong: true },
			...(invoice.advanced_amount > 0 ? [{ label: t("invoice.advanced"), value: format(invoice.advanced_amount) }] : []),
			...(invoice.paid_amount > 0 ? [{ label: t("invoice.paid"), value: format(invoice.paid_amount) }] : []),
			...(invoice.outstanding !== invoice.total_amount ? [{ label: t("invoice.outstanding"), value: format(invoice.outstanding), strong: true }] : []),
		],
		format,
		document.language
	);
	const note = documentNote(document, t);
	if (note) drawSection(layout, null, note);
	if (invoice.notes) drawSection(layout, t("invoice.notes"), invoice.notes);
	if (document.closing_note) drawSection(layout, null, document.closing_note);
	const issuer = await prepareIssuer(layout, document, t, document.fiscal ? ISSUER_BESIDE_FISCAL_WIDTH : ISSUER_WIDTH);
	drawPayment(layout, document, t, format, options.payLink);
	drawFooter(layout, document, t, invoice.currency, dateOf);
	drawClosing(layout, document.fiscal, issuer, t);
	drawPageFooters(layout, document, t, invoice.reference);

	pdf.end();
	return await output;
}

export async function buildCreditNotePdf(document: CreditNoteDocument, logo: LogoSource | null): Promise<Uint8Array> {
	const { credit_note: note, corrects } = document;
	const t = translator(document.language);
	const dateOf = (value: number) => formatDateIn(value, document.formats.date as DateFormat, document.language, document.formats.timezone);
	const negative = (amount: number) => formatMoneyIn(-amount, note.currency, document.language);
	const { pdf, layout, output } = await startPdf(document, `${t("credit.title")} ${note.reference}`);

	drawHeader(layout, t("credit.title"), note.reference, await printableLogo(logo), [[t("invoice.issued"), dateOf(note.issued)]]);
	drawParties(layout, document, t, sellerExtrasOf(document.seller, document.tax.vat_status, t, document.design.show));

	layout.paragraph(t("credit.corrects", { reference: corrects.reference, date: dateOf(corrects.issued) }), CONTENT_WIDTH);
	if (note.reason) layout.paragraph(`${t("credit.reason")}: ${note.reason}`, CONTENT_WIDTH);
	layout.cursor += 12;

	drawLines(
		layout,
		t("invoice.description"),
		[
			{ heading: t("invoice.tax"), offset: 190 },
			{ heading: t("invoice.net"), offset: 100 },
			{ heading: t("invoice.amount"), offset: 0 },
		],
		document.items.map((item) => ({
			description: item.description,
			cells: [formatPercentIn(item.tax_rate, document.language), negative(item.net_amount), negative(item.net_amount + item.tax_amount)],
		}))
	);
	drawSummary(
		layout,
		t,
		taxGroups(document.items.map((item) => ({ tax_rate: item.tax_rate, base: item.net_amount, tax: item.tax_amount }))),
		[
			{ label: t("invoice.subtotal"), value: negative(note.subtotal) },
			{ label: t("invoice.tax"), value: negative(note.tax_amount) },
			{ label: t("credit.total"), value: negative(note.total_amount), strong: true },
		],
		negative,
		document.language
	);
	if (document.closing_note) drawSection(layout, null, document.closing_note);
	drawFooter(layout, document, t, note.currency, dateOf, -1);
	drawClosing(layout, document.fiscal, null, t);
	drawPageFooters(layout, document, t, note.reference);

	pdf.end();
	return await output;
}
