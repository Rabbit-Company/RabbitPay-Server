import PDFDocument from "pdfkit";
import regularFontPath from "../assets/fonts/NotoSans-Regular.ttf" with { type: "file" };
import boldFontPath from "../assets/fonts/NotoSans-Bold.ttf" with { type: "file" };
import { localeFor } from "../formats";
import { translator, type TranslationKey } from "../i18n";
import { ABSENCE_KINDS } from "./absence-kinds";
import { legalNameParts } from "../legal-name";
import type { CompanyDetails } from "../company";
import type { MonthReport, PersonMonth } from "./reports";
import type { EmployeeRow, ProjectRow } from "../database/models";

export interface MonthReportInput {
	project: ProjectRow;
	report: MonthReport;
	employees: EmployeeRow[];
	company: { name: string; details: CompanyDetails };
}

type Pdf = InstanceType<typeof PDFDocument>;
type Translate = ReturnType<typeof translator>;

const REGULAR = "regular";
const BOLD = "bold";
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const RIGHT_EDGE = PAGE_WIDTH - MARGIN;
const ROW = 14.5;
const INK = "#111827";
const MUTED = "#6b7280";
const LINE = "#d1d5db";
const SHADE = "#f3f4f6";

const COLUMNS: { key: TranslationKey; width: number; align: "left" | "right" }[] = [
	{ key: "timesheet_pdf.date", width: 66, align: "left" },
	{ key: "timesheet_pdf.shifts", width: 118, align: "left" },
	{ key: "timesheet_pdf.break", width: 42, align: "right" },
	{ key: "timesheet_pdf.worked", width: 58, align: "right" },
	{ key: "timesheet_pdf.overtime", width: 46, align: "right" },
	{ key: "timesheet_pdf.night", width: 42, align: "right" },
	{ key: "timesheet_pdf.notes", width: 143, align: "left" },
];

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

function hours(minutes: number): string {
	if (minutes === 0) return "";
	const sign = minutes < 0 ? "-" : "";
	const absolute = Math.abs(Math.round(minutes));
	return `${sign}${Math.floor(absolute / 60)}:${String(absolute % 60).padStart(2, "0")}`;
}

function monthTitle(month: string, language: string): string {
	const [year, number] = month.split("-").map(Number);
	return new Intl.DateTimeFormat(localeFor(language), { month: "long", year: "numeric", timeZone: "UTC" }).format(Date.UTC(year, number - 1, 1));
}

function dayLabel(date: string, language: string): string {
	const [year, month, day] = date.split("-").map(Number);
	const weekday = new Intl.DateTimeFormat(localeFor(language), { weekday: "short", timeZone: "UTC" }).format(Date.UTC(year, month - 1, day));
	return `${weekday} ${day}. ${month}.`;
}

function text(
	pdf: Pdf,
	value: string,
	x: number,
	y: number,
	options: { width?: number; align?: "left" | "right"; bold?: boolean; size?: number; color?: string } = {}
) {
	pdf
		.font(options.bold ? BOLD : REGULAR)
		.fontSize(options.size ?? 8.5)
		.fillColor(options.color ?? INK)
		.text(value, x, y, { width: options.width, align: options.align ?? "left", lineBreak: false, ellipsis: true });
}

function drawPerson(
	pdf: Pdf,
	t: Translate,
	project: ProjectRow,
	company: { name: string; details: string[] },
	person: PersonMonth,
	employee: EmployeeRow | null,
	month: string,
	generated: string
) {
	const language = project.language;
	let y = MARGIN;
	text(pdf, company.name, MARGIN, y, { bold: true, size: 10 });
	company.details.forEach((line, index) => text(pdf, line, MARGIN, y + 13 + index * 11, { color: MUTED }));
	text(pdf, t("timesheet_pdf.title"), MARGIN, y, { width: RIGHT_EDGE - MARGIN, align: "right", bold: true, size: 13 });
	text(pdf, monthTitle(month, language), MARGIN, y + 18, { width: RIGHT_EDGE - MARGIN, align: "right", size: 10 });
	y += Math.max(40, 13 + company.details.length * 11) + 14;

	const facts: [string, string][] = [
		[t("timesheet_pdf.person"), person.person],
		...(employee?.employee_number ? [[t("timesheet_pdf.employee_number"), employee.employee_number] as [string, string]] : []),
		...(employee?.job_title ? [[t("timesheet_pdf.job_title"), employee.job_title] as [string, string]] : []),
		[t("timesheet_pdf.daily_hours"), hours(person.daily_minutes)],
	];
	facts.forEach(([label, value], index) => {
		text(pdf, label, MARGIN, y + index * 12, { color: MUTED });
		text(pdf, value, MARGIN + 110, y + index * 12, { bold: index === 0 });
	});
	y += facts.length * 12 + 12;

	const header = y;
	pdf.rect(MARGIN, header, RIGHT_EDGE - MARGIN, ROW).fill(SHADE);
	let x = MARGIN;
	for (const column of COLUMNS) {
		text(pdf, t(column.key), x + 3, header + 3.5, { width: column.width - 6, align: column.align, bold: true, size: 7.5 });
		x += column.width;
	}
	y += ROW;

	for (const day of person.days) {
		const notes = [
			day.holiday ? (language === "sl" ? day.holiday.name.sl : day.holiday.name.en) : null,
			...day.absences.map((absence) => {
				const label = t(`timesheet_pdf.absence_${absence.kind}` as TranslationKey);
				return absence.status === "pending" ? `${label} (${t("timesheet_pdf.pending")})` : label;
			}),
			day.employed ? null : t("timesheet_pdf.not_employed"),
		].filter(Boolean);
		if (!day.working_day) pdf.rect(MARGIN, y, RIGHT_EDGE - MARGIN, ROW).fill(SHADE);
		const cells = [
			dayLabel(day.date, language),
			day.shifts.join(", "),
			day.break_minutes ? String(day.break_minutes) : "",
			hours(day.worked_minutes),
			hours(day.overtime_minutes),
			hours(day.night_minutes),
			notes.join(", "),
		];
		x = MARGIN;
		COLUMNS.forEach((column, index) => {
			text(pdf, cells[index], x + 3, y + 3.5, { width: column.width - 6, align: column.align, size: 7.5 });
			x += column.width;
		});
		pdf
			.moveTo(MARGIN, y + ROW)
			.lineTo(RIGHT_EDGE, y + ROW)
			.lineWidth(0.4)
			.strokeColor(LINE)
			.stroke();
		y += ROW;
	}
	y += 12;

	const totals = person.totals;
	const summary: [string, string][] = [
		[t("timesheet_pdf.fund"), hours(totals.fund_minutes) || "0:00"],
		[t("timesheet_pdf.worked_total"), hours(totals.worked_minutes) || "0:00"],
		[t("timesheet_pdf.overtime_total"), hours(totals.overtime_minutes) || "0:00"],
		[t("timesheet_pdf.holidays"), hours(totals.holiday_minutes) || "0:00"],
		...ABSENCE_KINDS.filter((kind) => totals.absence_minutes[kind] > 0).map((kind): [string, string] => [
			t(`timesheet_pdf.absence_${kind}` as TranslationKey),
			hours(totals.absence_minutes[kind]),
		]),
		[t("timesheet_pdf.night_total"), hours(totals.night_minutes) || "0:00"],
		[t("timesheet_pdf.sunday"), hours(totals.sunday_minutes) || "0:00"],
		[t("timesheet_pdf.holiday_work"), hours(totals.holiday_work_minutes) || "0:00"],
		[t("timesheet_pdf.balance"), hours(totals.balance_minutes) || "0:00"],
	];
	const half = Math.ceil(summary.length / 2);
	summary.forEach(([label, value], index) => {
		const column = index < half ? 0 : 1;
		const row = index < half ? index : index - half;
		const left = MARGIN + column * 260;
		text(pdf, label, left, y + row * 12, { color: MUTED });
		text(pdf, value, left + 150, y + row * 12, { width: 60, align: "right", bold: true });
	});
	y += half * 12 + 8;
	text(pdf, t("timesheet_pdf.legend"), MARGIN, y, { color: MUTED, size: 7 });

	const bottom = pdf.page.margins.bottom;
	pdf.page.margins.bottom = 0;
	const signatures = PAGE_HEIGHT - MARGIN - 36;
	for (const [index, key] of (["timesheet_pdf.signature_employee", "timesheet_pdf.signature_employer"] as TranslationKey[]).entries()) {
		const left = MARGIN + index * 280;
		pdf
			.moveTo(left, signatures)
			.lineTo(left + 200, signatures)
			.lineWidth(0.6)
			.strokeColor(INK)
			.stroke();
		text(pdf, t(key), left, signatures + 4, { color: MUTED });
	}
	text(pdf, t("timesheet_pdf.generated", { date: generated }), MARGIN, PAGE_HEIGHT - MARGIN - 8, {
		width: RIGHT_EDGE - MARGIN,
		align: "right",
		color: MUTED,
		size: 7,
	});
	pdf.page.margins.bottom = bottom;
}

export async function buildMonthReportPdf(input: MonthReportInput): Promise<Uint8Array> {
	const { project, report, employees } = input;
	const t = translator(project.language);
	const [regular, bold] = await loadFonts();
	const details = input.company.details;
	const companyName = legalNameParts(input.company.name);
	const company = {
		name: companyName.name,
		details: [
			companyName.activity ?? "",
			[details.address_line1, details.address_line2].filter(Boolean).join(", "),
			[details.postal_code, details.city].filter(Boolean).join(" "),
			details.tax_number ? `${t("timesheet_pdf.tax_number")}: ${details.tax_number}` : "",
		].filter((line) => line.trim() !== ""),
	};
	const generated = new Intl.DateTimeFormat(localeFor(project.language), { dateStyle: "medium", timeStyle: "short", timeZone: project.timezone }).format(
		Date.now()
	);
	const pdf = new PDFDocument({
		size: "A4",
		margin: MARGIN,
		font: null as never,
		lang: localeFor(project.language),
		autoFirstPage: false,
		info: { Title: `${t("timesheet_pdf.title")} ${report.month}`, Author: company.name, Creator: "RabbitPay", Producer: "RabbitPay" },
	});
	pdf.registerFont(REGULAR, regular);
	pdf.registerFont(BOLD, bold);
	pdf.font(REGULAR);
	const output = collect(pdf);

	for (const person of report.people) {
		pdf.addPage({ size: "A4", margin: MARGIN });
		drawPerson(pdf, t, project, company, person, employees.find((employee) => employee.member === person.member) ?? null, report.month, generated);
	}
	if (report.people.length === 0) {
		pdf.addPage({ size: "A4", margin: MARGIN });
		text(pdf, t("timesheet_pdf.title"), MARGIN, MARGIN, { bold: true, size: 13 });
	}
	pdf.end();
	return output;
}
