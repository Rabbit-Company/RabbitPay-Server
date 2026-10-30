import PDFDocument from "pdfkit";
import regularFontPath from "./assets/fonts/NotoSans-Regular.ttf" with { type: "file" };
import boldFontPath from "./assets/fonts/NotoSans-Bold.ttf" with { type: "file" };
import { formatDate, localeFor, type DateFormat } from "./formats";
import { translator, type TranslationKey } from "./i18n";
import { minorUnitDigits } from "./invoicing";
import { legalNameParts } from "./legal-name";
import type { AccountantPackage, PackageCheck, ReceivedGroup } from "./accountant-package-types";

type Pdf = InstanceType<typeof PDFDocument>;
type Translate = ReturnType<typeof translator>;
type Align = "left" | "right";

const REGULAR = "regular";
const BOLD = "bold";
const PAGE_WIDTH = 841.89;
const PAGE_HEIGHT = 595.28;
const MARGIN = 40;
const RIGHT_EDGE = PAGE_WIDTH - MARGIN;
const CONTENT_WIDTH = RIGHT_EDGE - MARGIN;
const BODY_TOP = MARGIN + 46;
const BODY_BOTTOM = PAGE_HEIGHT - MARGIN - 18;
const ROW = 15;
const INK = "#111827";
const MUTED = "#6b7280";
const LINE = "#d1d5db";
const SHADE = "#f3f4f6";
const ACCENT = "#1d4ed8";
const WARN = "#b45309";

interface Column {
	key: TranslationKey;
	width: number;
	align: Align;
}

interface Cell {
	text: string;
	bold?: boolean;
	muted?: boolean;
	warn?: boolean;
}

let fonts: Promise<[Buffer, Buffer]> | null = null;

function loadFonts(): Promise<[Buffer, Buffer]> {
	fonts ??= Promise.all([Bun.file(regularFontPath).arrayBuffer(), Bun.file(boldFontPath).arrayBuffer()]).then(
		([regular, bold]) => [Buffer.from(regular), Buffer.from(bold)] as [Buffer, Buffer]
	);
	return fonts;
}

function collect(pdf: Pdf): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
		pdf.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
		pdf.on("error", reject);
	});
}

function fitted(pdf: Pdf, value: string, width: number | undefined): string {
	if (width === undefined || pdf.widthOfString(value) <= width) return value;
	let length = value.length;
	while (length > 0 && pdf.widthOfString(`${value.slice(0, length).trimEnd()}...`) > width) length--;
	return `${value.slice(0, length).trimEnd()}...`;
}

function text(pdf: Pdf, value: string, x: number, y: number, options: { width?: number; align?: Align; bold?: boolean; size?: number; color?: string } = {}) {
	pdf
		.font(options.bold ? BOLD : REGULAR)
		.fontSize(options.size ?? 8)
		.fillColor(options.color ?? INK);
	pdf.text(fitted(pdf, value, options.width), x, y, { width: options.width, align: options.align ?? "left", lineBreak: false });
}

function rule(pdf: Pdf, y: number, color = LINE, width = 0.4) {
	pdf.moveTo(MARGIN, y).lineTo(RIGHT_EDGE, y).lineWidth(width).strokeColor(color).stroke();
}

class Writer {
	readonly pdf: Pdf;
	readonly t: Translate;
	y = BODY_TOP;
	private readonly number: Intl.NumberFormat;
	private readonly dateFormat: DateFormat;

	constructor(
		pdf: Pdf,
		readonly data: AccountantPackage
	) {
		this.pdf = pdf;
		this.t = translator(data.language);
		this.number = new Intl.NumberFormat(localeFor(data.language), { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: "always" });
		const format = data.date_format as DateFormat;
		this.dateFormat = format !== "auto" ? format : data.language === "sl" ? "dd.mm.yyyy" : "dd/mm/yyyy";
	}

	amount(value: number | null): string {
		return value === null ? "-" : this.number.format(value / 100).replace("\u2212", "-");
	}

	date(value: number | null): string {
		return value === null ? "" : formatDate(value, this.dateFormat, this.data.timezone);
	}

	localDate(value: string): string {
		const [year, month, day] = value.split("-").map(Number);
		return formatDate(Date.UTC(year, month - 1, day), this.dateFormat, "UTC");
	}

	period(): string {
		return `${this.localDate(this.data.period.from)} - ${this.localDate(this.data.period.to)}`;
	}

	page() {
		this.pdf.addPage({ size: "A4", layout: "landscape", margin: MARGIN });
		this.y = BODY_TOP;
	}

	room(height: number): boolean {
		return this.y + height <= BODY_BOTTOM;
	}

	ensure(height: number) {
		if (!this.room(height)) this.page();
	}

	heading(title: string, subtitle?: string) {
		this.ensure(40);
		text(this.pdf, title, MARGIN, this.y, { bold: true, size: 13 });
		if (subtitle) text(this.pdf, subtitle, MARGIN, this.y + 18, { color: MUTED, size: 8.5, width: CONTENT_WIDTH });
		this.y += subtitle ? 34 : 22;
	}

	tableHeader(columns: Column[]) {
		this.pdf.rect(MARGIN, this.y, CONTENT_WIDTH, ROW + 1).fill(SHADE);
		let x = MARGIN;
		for (const column of columns) {
			text(this.pdf, this.t(column.key), x + 3, this.y + 4, { width: column.width - 6, align: column.align, bold: true, size: 7 });
			x += column.width;
		}
		this.y += ROW + 1;
	}

	table(columns: Column[], rows: Cell[][], totals: Cell[] | null) {
		const scale = CONTENT_WIDTH / columns.reduce((sum, column) => sum + column.width, 0);
		const scaled = columns.map((column) => ({ ...column, width: column.width * scale }));
		this.ensure(ROW * 3);
		this.tableHeader(scaled);
		for (const row of rows) {
			if (!this.room(ROW)) {
				this.page();
				this.tableHeader(scaled);
			}
			this.row(scaled, row);
		}
		if (totals) {
			if (!this.room(ROW + 2)) {
				this.page();
				this.tableHeader(scaled);
			}
			rule(this.pdf, this.y, INK, 0.8);
			this.y += 1;
			this.row(scaled, totals, false);
		}
		this.y += 10;
	}

	private row(columns: Column[], cells: Cell[], line = true) {
		let x = MARGIN;
		columns.forEach((column, index) => {
			const cell = cells[index] ?? { text: "" };
			text(this.pdf, cell.text, x + 3, this.y + 4, {
				width: column.width - 6,
				align: column.align,
				bold: cell.bold,
				size: 7.5,
				color: cell.warn ? WARN : cell.muted ? MUTED : INK,
			});
			x += column.width;
		});
		this.y += ROW;
		if (line) rule(this.pdf, this.y);
	}
}

function drawFrame(writer: Writer, pageNumber: number, pages: number) {
	const { pdf, t, data } = writer;
	const bottom = pdf.page.margins.bottom;
	pdf.page.margins.bottom = 0;
	const company = legalNameParts(data.company.name).name;
	text(pdf, company, MARGIN, MARGIN, { bold: true, size: 10, width: CONTENT_WIDTH / 2 });
	text(pdf, data.changes ? `${t("package.title")} | ${t("package.changes_label")}` : t("package.title"), MARGIN, MARGIN, {
		bold: true,
		size: 10,
		width: CONTENT_WIDTH,
		align: "right",
		color: ACCENT,
	});
	text(pdf, writer.period(), MARGIN, MARGIN + 14, { width: CONTENT_WIDTH, align: "right", color: MUTED });
	const details = data.company.details;
	const taxId = details.vat_number
		? `${t("package.vat_number")}: ${details.vat_number}`
		: details.tax_number
			? `${t("package.tax_number")}: ${details.tax_number}`
			: "";
	if (taxId) text(pdf, taxId, MARGIN, MARGIN + 14, { color: MUTED, width: CONTENT_WIDTH / 2 });
	rule(pdf, MARGIN + 30, LINE, 0.6);
	const generated = new Intl.DateTimeFormat(localeFor(data.language), { dateStyle: "medium", timeStyle: "short", timeZone: data.timezone }).format(
		data.generated_at
	);
	text(pdf, t("package.generated", { date: generated }), MARGIN, PAGE_HEIGHT - MARGIN - 6, { color: MUTED, size: 7, width: CONTENT_WIDTH / 2 });
	text(pdf, t("package.page", { page: pageNumber, pages }), MARGIN, PAGE_HEIGHT - MARGIN - 6, {
		color: MUTED,
		size: 7,
		width: CONTENT_WIDTH,
		align: "right",
	});
	pdf.page.margins.bottom = bottom;
}

function sum<T>(rows: T[], value: (row: T) => number | null): number {
	return rows.reduce((total, row) => total + (value(row) ?? 0), 0);
}

function originalNote(writer: Writer, currency: string, amount: number): string {
	if (currency === writer.data.currency) return "";
	const digits = minorUnitDigits(currency);
	const formatted = new Intl.NumberFormat(localeFor(writer.data.language), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(
		amount / Math.pow(10, digits)
	);
	return ` | ${currency} ${formatted.replace("\u2212", "-")}`;
}

const GROUP_TITLES: Record<ReceivedGroup, TranslationKey> = {
	domestic: "package.received_domestic",
	foreign: "package.received_foreign",
	paid_on_spot: "package.received_on_spot",
};

const RETURN_LINES: { code: string; key: TranslationKey; always?: boolean }[] = [
	{ code: "11", key: "package.ddvo_11", always: true },
	{ code: "11a", key: "package.ddvo_11a" },
	{ code: "12", key: "package.ddvo_12" },
	{ code: "13", key: "package.ddvo_13" },
	{ code: "14", key: "package.ddvo_14" },
	{ code: "15", key: "package.ddvo_15" },
	{ code: "21", key: "package.ddvo_21", always: true },
	{ code: "22", key: "package.ddvo_22" },
	{ code: "22a", key: "package.ddvo_22a" },
	{ code: "23", key: "package.ddvo_23" },
	{ code: "23a", key: "package.ddvo_23a" },
	{ code: "24", key: "package.ddvo_24" },
	{ code: "24a", key: "package.ddvo_24a" },
	{ code: "24b", key: "package.ddvo_24b" },
	{ code: "24c", key: "package.ddvo_24c" },
	{ code: "25", key: "package.ddvo_25" },
	{ code: "25a", key: "package.ddvo_25a" },
	{ code: "25b", key: "package.ddvo_25b" },
	{ code: "26", key: "package.ddvo_26" },
	{ code: "31", key: "package.ddvo_31", always: true },
	{ code: "31a", key: "package.ddvo_31a" },
	{ code: "32", key: "package.ddvo_32" },
	{ code: "32a", key: "package.ddvo_32a" },
	{ code: "33", key: "package.ddvo_33" },
	{ code: "34", key: "package.ddvo_34" },
	{ code: "35", key: "package.ddvo_35" },
	{ code: "41", key: "package.ddvo_41", always: true },
	{ code: "42", key: "package.ddvo_42" },
	{ code: "42a", key: "package.ddvo_42a" },
	{ code: "43", key: "package.ddvo_43" },
];

function checkLine(t: Translate, check: PackageCheck): string {
	const known: Record<string, TranslationKey> = {
		missing_original: "package.check_missing_original",
		missing_rate: "package.check_missing_rate",
		unpaid_received: "package.check_unpaid_received",
		document_unavailable: "package.check_document_unavailable",
		bank_unmatched: "package.check_bank_unmatched",
		bank_missing: "package.check_bank_missing",
	};
	const key = known[check.code];
	if (key) return t(key, { reference: check.reference ?? "", detail: check.detail ?? "" });
	return [check.reference, check.detail].filter(Boolean).join(" | ");
}

function drawSummary(writer: Writer) {
	const { pdf, t, data } = writer;
	const details = data.company.details;
	const name = legalNameParts(data.company.name);
	text(pdf, t("package.title"), MARGIN, writer.y, { bold: true, size: 16 });
	text(pdf, writer.period(), MARGIN, writer.y + 22, { size: 10, color: MUTED });
	writer.y += 44;

	const facts: [string, string][] = [
		[t("package.company"), [name.name, name.activity].filter(Boolean).join(", ")],
		[
			t("package.address"),
			[details.address_line1, details.address_line2, [details.postal_code, details.city].filter(Boolean).join(" ")].filter(Boolean).join(", "),
		],
		...(details.tax_number ? [[t("package.tax_number"), details.tax_number] as [string, string]] : []),
		...(details.vat_number ? [[t("package.vat_number"), details.vat_number] as [string, string]] : []),
		...(details.registration_number ? [[t("package.registration_number"), details.registration_number] as [string, string]] : []),
		[t("package.currency"), data.currency],
	];
	for (const [label, value] of facts) {
		text(pdf, label, MARGIN, writer.y, { color: MUTED, size: 8.5 });
		text(pdf, value, MARGIN + 120, writer.y, { size: 8.5, width: 360 });
		writer.y += 13;
	}
	writer.y += 12;

	const counted = data.issued.filter((row) => row.counted);
	const group = (name: ReceivedGroup) => data.received.filter((row) => row.group === name);
	const sections: [TranslationKey, { net: number | null; vat: number | null; total: number | null }[]][] = [
		["package.issued", counted],
		["package.credit_notes", data.credit_notes],
		["package.received_domestic", group("domestic")],
		["package.received_foreign", group("foreign")],
		["package.received_on_spot", group("paid_on_spot")],
	];
	text(pdf, t("package.summary"), MARGIN, writer.y, { bold: true, size: 11 });
	writer.y += 18;
	writer.table(
		[
			{ key: "package.col_section", width: 300, align: "left" },
			{ key: "package.col_documents", width: 90, align: "right" },
			{ key: "package.col_net", width: 120, align: "right" },
			{ key: "package.col_vat", width: 120, align: "right" },
			{ key: "package.col_total", width: 130, align: "right" },
		],
		sections.map(([key, rows]) => [
			{ text: t(key) },
			{ text: String(rows.length) },
			{ text: writer.amount(sum(rows, (row) => row.net)) },
			{ text: writer.amount(sum(rows, (row) => row.vat)) },
			{ text: writer.amount(sum(rows, (row) => row.total)), bold: true },
		]),
		null
	);

	if (data.changes) drawChanges(writer);

	const receivable = data.open_items.filter((item) => item.kind === "receivable");
	const payable = data.open_items.filter((item) => item.kind === "payable");
	const bankLines = data.bank.reduce((total, account) => total + account.lines.length, 0);
	const unmatched = data.bank.reduce((total, account) => total + account.lines.filter((line) => line.status === "open").length, 0);
	const position: [string, string][] = [
		[t("package.open_receivable"), `${writer.amount(sum(receivable, (item) => item.open))} | ${t("package.total_count", { count: receivable.length })}`],
		[t("package.open_payable"), `${writer.amount(sum(payable, (item) => item.open))} | ${t("package.total_count", { count: payable.length })}`],
		[
			t("package.bank"),
			data.bank.length > 0
				? t("package.bank_summary", { lines: bankLines, unmatched })
				: t(data.bank_used ? "package.bank_none_period" : "package.bank_not_used"),
		],
	];
	writer.ensure(position.length * 13 + 30);
	text(pdf, t("package.position", { date: writer.localDate(data.period.to) }), MARGIN, writer.y, { bold: true, size: 11 });
	writer.y += 18;
	for (const [label, value] of position) {
		text(pdf, label, MARGIN, writer.y, { color: MUTED, size: 8.5 });
		text(pdf, value, MARGIN + 200, writer.y, { size: 8.5, width: CONTENT_WIDTH - 200 });
		writer.y += 13;
	}
	writer.y += 14;

	if (data.vat_return) drawVatReturn(writer);
	else if (data.vat_registered && !data.monthly_vat_period) {
		writer.ensure(20);
		text(pdf, t("package.ddvo_needs_period"), MARGIN, writer.y, { color: MUTED, size: 8.5, width: CONTENT_WIDTH });
		writer.y += 20;
	}

	writer.ensure(40);
	text(pdf, t("package.checks"), MARGIN, writer.y, { bold: true, size: 11 });
	writer.y += 18;
	if (data.checks.length === 0) {
		text(pdf, t("package.checks_none"), MARGIN, writer.y, { size: 8.5, color: MUTED });
		writer.y += 16;
	}
	for (const check of data.checks.slice(0, 200)) {
		writer.ensure(13);
		text(pdf, `- ${checkLine(t, check)}`, MARGIN, writer.y, { size: 8.5, color: WARN, width: CONTENT_WIDTH });
		writer.y += 13;
	}
	if (data.checks.length > 200) {
		text(pdf, t("package.checks_more", { count: data.checks.length - 200 }), MARGIN, writer.y, { size: 8.5, color: MUTED });
		writer.y += 13;
	}
}

function drawChanges(writer: Writer) {
	const { pdf, t, data } = writer;
	const changes = data.changes!;
	const since = new Intl.DateTimeFormat(localeFor(data.language), { dateStyle: "medium", timeStyle: "short", timeZone: data.timezone }).format(changes.since);
	writer.ensure(60);
	pdf.rect(MARGIN, writer.y - 4, CONTENT_WIDTH, 4).fill(ACCENT);
	writer.y += 8;
	text(pdf, t("package.changes_title", { date: since }), MARGIN, writer.y, { bold: true, size: 11, color: ACCENT });
	writer.y += 16;
	text(pdf, t("package.changes_hint"), MARGIN, writer.y, { size: 8, color: MUTED, width: CONTENT_WIDTH });
	writer.y += 16;
	const groups: [TranslationKey, string[]][] = [
		["package.changes_added", changes.added],
		["package.changes_changed", changes.changed],
		["package.changes_removed", changes.removed],
	];
	for (const [key, labels] of groups) {
		if (labels.length === 0) continue;
		writer.ensure(26);
		text(pdf, `${t(key)} (${labels.length})`, MARGIN, writer.y, { bold: true, size: 8.5 });
		writer.y += 13;
		for (const label of labels.slice(0, 60)) {
			writer.ensure(12);
			text(pdf, `- ${label}`, MARGIN + 10, writer.y, { size: 8.5, width: CONTENT_WIDTH - 10 });
			writer.y += 12;
		}
		if (labels.length > 60) {
			text(pdf, t("package.checks_more", { count: labels.length - 60 }), MARGIN + 10, writer.y, { size: 8.5, color: MUTED });
			writer.y += 12;
		}
		writer.y += 4;
	}
	writer.y += 10;
}

function drawVatReturn(writer: Writer) {
	const { pdf, t, data } = writer;
	const summary = data.vat_return!;
	const lines = RETURN_LINES.filter((line) => line.always || summary.fields[line.code] !== 0);
	const half = Math.ceil(lines.length / 2);
	const height = 18 + 16 + half * 14 + 50;
	writer.ensure(height);
	text(pdf, t("package.ddvo"), MARGIN, writer.y, { bold: true, size: 11 });
	writer.y += 16;
	text(pdf, t("package.ddvo_hint"), MARGIN, writer.y, { size: 7.5, color: MUTED, width: CONTENT_WIDTH });
	writer.y += 16;
	const columnWidth = (CONTENT_WIDTH - 30) / 2;
	lines.forEach((line, index) => {
		const column = index < half ? 0 : 1;
		const row = index < half ? index : index - half;
		const left = MARGIN + column * (columnWidth + 30);
		const y = writer.y + row * 14;
		text(pdf, line.code, left, y, { bold: true, size: 8, width: 28 });
		text(pdf, t(line.key), left + 30, y, { size: 8, width: columnWidth - 130 });
		text(pdf, writer.amount(summary.fields[line.code]), left + columnWidth - 100, y, { size: 8, width: 100, align: "right" });
	});
	writer.y += half * 14 + 6;
	rule(pdf, writer.y, INK, 0.8);
	writer.y += 6;
	const liability = summary.fields["51"] > 0 || summary.fields["52"] === 0;
	text(pdf, liability ? "51" : "52", MARGIN, writer.y, { bold: true, size: 10, width: 28 });
	text(pdf, t(liability ? "package.ddvo_51" : "package.ddvo_52"), MARGIN + 30, writer.y, { bold: true, size: 10, width: 400 });
	text(pdf, writer.amount(summary.fields[liability ? "51" : "52"]), MARGIN, writer.y, { bold: true, size: 10, width: CONTENT_WIDTH, align: "right" });
	writer.y += 16;
	if (summary.corrections > 0) {
		text(pdf, t("package.ddvo_corrections", { count: summary.corrections }), MARGIN, writer.y, { size: 7.5, color: MUTED, width: CONTENT_WIDTH });
		writer.y += 12;
	}
	writer.y += 12;
}

function drawIssued(writer: Writer) {
	const { t, data } = writer;
	if (data.issued.length === 0) return;
	writer.page();
	writer.heading(t("package.issued"), t("package.issued_hint"));
	const status = (row: (typeof data.issued)[number]) =>
		row.status === "canceled"
			? t(row.counted ? "package.status_credited" : "package.status_canceled")
			: row.status === "paid"
				? row.paid_at
					? t("package.status_paid_on", { date: writer.date(row.paid_at) })
					: t("package.status_paid")
				: t("package.status_open");
	const counted = data.issued.filter((row) => row.counted);
	writer.table(
		[
			{ key: "package.col_number", width: 80, align: "left" },
			{ key: "package.col_customer", width: 190, align: "left" },
			{ key: "package.col_tax_number", width: 85, align: "left" },
			{ key: "package.col_issued", width: 62, align: "left" },
			{ key: "package.col_due", width: 62, align: "left" },
			{ key: "package.col_status", width: 120, align: "left" },
			{ key: "package.col_net", width: 75, align: "right" },
			{ key: "package.col_vat", width: 70, align: "right" },
			{ key: "package.col_total", width: 80, align: "right" },
		],
		data.issued.map((row) => {
			const muted = !row.counted;
			const source = row.source === "recorded" ? ` | ${t("package.issued_elsewhere")}` : "";
			return [
				{ text: row.reference, muted },
				{ text: `${row.customer}${source}${originalNote(writer, row.currency, row.total_original)}`, muted },
				{ text: row.tax_number ?? "", muted },
				{ text: writer.date(row.issued_at), muted },
				{ text: writer.date(row.due_date), muted },
				{ text: status(row), muted },
				{ text: writer.amount(row.net), muted },
				{ text: writer.amount(row.vat), muted },
				{ text: writer.amount(row.total), muted, bold: !muted },
			];
		}),
		[
			{ text: t("package.total"), bold: true },
			{ text: t("package.total_count", { count: counted.length }), muted: true },
			{ text: "" },
			{ text: "" },
			{ text: "" },
			{ text: "" },
			{ text: writer.amount(sum(counted, (row) => row.net)), bold: true },
			{ text: writer.amount(sum(counted, (row) => row.vat)), bold: true },
			{ text: writer.amount(sum(counted, (row) => row.total)), bold: true },
		]
	);
}

function drawCreditNotes(writer: Writer) {
	const { t, data } = writer;
	if (data.credit_notes.length === 0) return;
	writer.page();
	writer.heading(t("package.credit_notes"), t("package.credit_notes_hint"));
	writer.table(
		[
			{ key: "package.col_number", width: 85, align: "left" },
			{ key: "package.col_invoice", width: 85, align: "left" },
			{ key: "package.col_customer", width: 250, align: "left" },
			{ key: "package.col_tax_number", width: 90, align: "left" },
			{ key: "package.col_issued", width: 65, align: "left" },
			{ key: "package.col_net", width: 80, align: "right" },
			{ key: "package.col_vat", width: 75, align: "right" },
			{ key: "package.col_total", width: 85, align: "right" },
		],
		data.credit_notes.map((row) => [
			{ text: row.reference },
			{ text: row.invoice_reference ?? "" },
			{ text: `${row.customer}${row.reason ? ` | ${row.reason}` : ""}${originalNote(writer, row.currency, row.total_original)}` },
			{ text: row.tax_number ?? "" },
			{ text: writer.date(row.issued_at) },
			{ text: writer.amount(row.net) },
			{ text: writer.amount(row.vat) },
			{ text: writer.amount(row.total), bold: true },
		]),
		[
			{ text: t("package.total"), bold: true },
			{ text: "" },
			{ text: t("package.total_count", { count: data.credit_notes.length }), muted: true },
			{ text: "" },
			{ text: "" },
			{ text: writer.amount(sum(data.credit_notes, (row) => row.net)), bold: true },
			{ text: writer.amount(sum(data.credit_notes, (row) => row.vat)), bold: true },
			{ text: writer.amount(sum(data.credit_notes, (row) => row.total)), bold: true },
		]
	);
}

function drawReceived(writer: Writer, group: ReceivedGroup) {
	const { t, data } = writer;
	const rows = data.received.filter((row) => row.group === group);
	if (rows.length === 0) return;
	writer.page();
	writer.heading(t(GROUP_TITLES[group]), t(`${GROUP_TITLES[group]}_hint` as TranslationKey));
	const onSpot = group === "paid_on_spot";
	const party = (row: (typeof rows)[number]) =>
		group === "foreign" && row.country && !(row.tax_number ?? "").toUpperCase().startsWith(row.country)
			? `${row.country} ${row.tax_number ?? ""}`.trim()
			: (row.tax_number ?? "");
	writer.table(
		[
			{ key: "package.col_supplier", width: 165, align: "left" },
			{ key: "package.col_tax_number", width: 75, align: "left" },
			{ key: "package.col_invoice_number", width: 100, align: "left" },
			{ key: "package.col_issued", width: 56, align: "left" },
			{ key: "package.col_booked", width: 56, align: "left" },
			{ key: onSpot ? "package.col_paid_with" : "package.col_due", width: 56, align: "left" },
			{ key: "package.col_paid", width: 56, align: "left" },
			{ key: "package.col_net", width: 64, align: "right" },
			{ key: "package.col_vat", width: 58, align: "right" },
			{ key: "package.col_deductible", width: 58, align: "right" },
			{ key: "package.col_total", width: 68, align: "right" },
		],
		rows.map((row) => [
			{ text: `${row.supplier}${row.attached ? "" : " | " + t("package.no_original")}${originalNote(writer, row.currency, row.total_original)}` },
			{ text: party(row) },
			{ text: row.invoice_number ?? row.description },
			{ text: writer.date(row.issue_date) },
			{ text: writer.date(row.booked_at) },
			{ text: onSpot ? t(`package.method_${row.payment_method}` as TranslationKey) : writer.date(row.due_date) },
			{ text: row.paid_at === null ? t("package.unpaid") : writer.date(row.paid_at), muted: row.paid_at === null },
			{ text: writer.amount(row.net) },
			{ text: writer.amount(row.vat) },
			{ text: writer.amount(row.deductible) },
			{ text: writer.amount(row.total), bold: true },
		]),
		[
			{ text: t("package.total"), bold: true },
			{ text: t("package.total_count", { count: rows.length }), muted: true },
			{ text: "" },
			{ text: "" },
			{ text: "" },
			{ text: "" },
			{ text: "" },
			{ text: writer.amount(sum(rows, (row) => row.net)), bold: true },
			{ text: writer.amount(sum(rows, (row) => row.vat)), bold: true },
			{ text: writer.amount(sum(rows, (row) => row.deductible)), bold: true },
			{ text: writer.amount(sum(rows, (row) => row.total)), bold: true },
		]
	);
}

const BANK_STATUS: Record<string, TranslationKey> = {
	open: "package.bank_open",
	matched: "package.bank_matched",
	booked: "package.bank_booked",
	ignored: "package.bank_ignored",
};

function money(writer: Writer, amount: number, currency: string): string {
	const digits = minorUnitDigits(currency);
	const formatted = new Intl.NumberFormat(localeFor(writer.data.language), {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
		useGrouping: "always",
	}).format(amount / Math.pow(10, digits));
	return formatted.replace("\u2212", "-");
}

function drawBank(writer: Writer) {
	const { pdf, t, data } = writer;
	if (data.bank.length === 0) return;
	writer.page();
	writer.heading(t("package.bank"), t("package.bank_hint"));
	for (const account of data.bank) {
		writer.ensure(ROW * 5);
		const iban = account.iban.replace(/(.{4})/g, "$1 ").trim();
		text(pdf, `${iban} | ${account.currency}`, MARGIN, writer.y, { bold: true, size: 10 });
		const balances = [
			account.opening_balance === null ? null : `${t("package.bank_opening")}: ${money(writer, account.opening_balance, account.currency)}`,
			account.closing_balance === null ? null : `${t("package.bank_closing")}: ${money(writer, account.closing_balance, account.currency)}`,
		]
			.filter(Boolean)
			.join(" | ");
		text(pdf, balances, MARGIN, writer.y + 1, { width: CONTENT_WIDTH, align: "right", size: 8.5, color: MUTED });
		writer.y += 18;
		const incoming = account.lines.filter((line) => line.amount > 0);
		const outgoing = account.lines.filter((line) => line.amount < 0);
		writer.table(
			[
				{ key: "package.col_date", width: 62, align: "left" },
				{ key: "package.col_partner", width: 190, align: "left" },
				{ key: "package.col_description", width: 220, align: "left" },
				{ key: "package.col_status", width: 70, align: "left" },
				{ key: "package.col_settles", width: 140, align: "left" },
				{ key: "package.col_amount", width: 80, align: "right" },
			],
			account.lines.map((line) => [
				{ text: writer.date(line.booking_date) },
				{ text: line.counterparty },
				{ text: line.description, muted: true },
				{ text: t(BANK_STATUS[line.status]), muted: line.status !== "open", warn: line.status === "open", bold: line.status === "open" },
				{ text: line.settles },
				{ text: money(writer, line.amount, account.currency), bold: true },
			]),
			[
				{ text: t("package.total"), bold: true },
				{
					text: t("package.bank_in_out", {
						in: money(
							writer,
							sum(incoming, (line) => line.amount),
							account.currency
						),
						out: money(
							writer,
							sum(outgoing, (line) => line.amount),
							account.currency
						),
					}),
					muted: true,
				},
				{ text: "" },
				{ text: "" },
				{ text: "" },
				{
					text: money(
						writer,
						sum(account.lines, (line) => line.amount),
						account.currency
					),
					bold: true,
				},
			]
		);
	}
}

function drawOpenItems(writer: Writer) {
	const { t, data } = writer;
	for (const kind of ["receivable", "payable"] as const) {
		const rows = data.open_items.filter((item) => item.kind === kind);
		if (rows.length === 0) continue;
		writer.page();
		writer.heading(
			t(kind === "receivable" ? "package.open_receivable" : "package.open_payable"),
			t("package.open_hint", { date: writer.localDate(data.period.to) })
		);
		writer.table(
			[
				{ key: kind === "receivable" ? "package.col_customer" : "package.col_supplier", width: 230, align: "left" },
				{ key: "package.col_tax_number", width: 85, align: "left" },
				{ key: "package.col_document", width: 110, align: "left" },
				{ key: "package.col_issued", width: 62, align: "left" },
				{ key: "package.col_due", width: 62, align: "left" },
				{ key: "package.col_overdue", width: 62, align: "right" },
				{ key: "package.col_amount", width: 80, align: "right" },
				{ key: "package.col_open", width: 80, align: "right" },
			],
			rows.map((row) => [
				{ text: `${row.partner}${row.currency && row.currency !== data.currency ? originalNote(writer, row.currency, row.open_foreign) : ""}` },
				{ text: row.tax_number ?? "" },
				{ text: row.reference },
				{ text: writer.date(row.date) },
				{ text: writer.date(row.due_date) },
				{ text: row.days_overdue > 0 ? String(row.days_overdue) : "", bold: row.days_overdue > 60 },
				{ text: writer.amount(row.amount), muted: true },
				{ text: writer.amount(row.open), bold: true },
			]),
			[
				{ text: t("package.total"), bold: true },
				{ text: t("package.total_count", { count: rows.length }), muted: true },
				{ text: "" },
				{ text: "" },
				{ text: "" },
				{ text: "" },
				{ text: "" },
				{ text: writer.amount(sum(rows, (row) => row.open)), bold: true },
			]
		);
	}
}

export async function buildAccountantPackagePdf(data: AccountantPackage): Promise<Uint8Array> {
	const t = translator(data.language);
	const [regular, bold] = await loadFonts();
	const pdf = new PDFDocument({
		size: "A4",
		layout: "landscape",
		margin: MARGIN,
		font: null as never,
		lang: localeFor(data.language),
		autoFirstPage: false,
		bufferPages: true,
		info: {
			Title: `${t("package.title")} ${data.period.from} - ${data.period.to}`,
			Author: legalNameParts(data.company.name).name,
			Creator: "RabbitPay",
			Producer: "RabbitPay",
		},
	});
	pdf.registerFont(REGULAR, regular);
	pdf.registerFont(BOLD, bold);
	pdf.font(REGULAR);
	const output = collect(pdf);
	const writer = new Writer(pdf, data);

	writer.page();
	drawSummary(writer);
	drawIssued(writer);
	drawCreditNotes(writer);
	drawReceived(writer, "domestic");
	drawReceived(writer, "foreign");
	drawReceived(writer, "paid_on_spot");
	drawBank(writer);
	drawOpenItems(writer);

	const range = pdf.bufferedPageRange();
	for (let index = range.start; index < range.start + range.count; index++) {
		pdf.switchToPage(index);
		drawFrame(writer, index - range.start + 1, range.count);
	}
	pdf.end();
	return output;
}
