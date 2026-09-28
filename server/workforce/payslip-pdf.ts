import PDFDocument from "pdfkit";
import regularFontPath from "../assets/fonts/NotoSans-Regular.ttf" with { type: "file" };
import boldFontPath from "../assets/fonts/NotoSans-Bold.ttf" with { type: "file" };
import { companyFor, displayNameOf } from "../company";
import { loadLogo } from "../branding";
import { accentTextFor, isAccentColor } from "../colors";
import { formatIban, formatMoneyIn, localeFor } from "../formats";
import { translator, type TranslationKey } from "../i18n";
import { printableLogo, tintOf, type Logo } from "../invoice-pdf";
import type { PayrollCalculation } from "./payroll-runs";
import type { NetPay, SeparatePay } from "./net-pay";
import type { PayrollRunRow, ProjectRow } from "../database/models";

type Pdf = InstanceType<typeof PDFDocument>;
type Translate = ReturnType<typeof translator>;
type Align = "left" | "right";

const REGULAR = "regular";
const BOLD = "bold";
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const RIGHT_EDGE = PAGE_WIDTH - MARGIN;
const WIDTH = RIGHT_EDGE - MARGIN;
const CONTENT_BOTTOM = PAGE_HEIGHT - MARGIN - 22;
const GAP = 12;
const ROW = 13;
const FACT = 12.5;
const INK = "#111827";
const MUTED = "#6b7280";
const LINE = "#b6bcc6";
const SOFT = "#eceff3";
const PAPER = "#ffffff";
const DEFAULT_ACCENT = "#334155";
const EMPLOYEE_KEYS = ["pension", "health", "unemployment", "parental", "long_term_care"] as const;
const CONTRIBUTION_KEYS = ["pension", "health", "unemployment", "parental", "injury", "long_term_care"] as const;

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

interface TextOptions {
	width?: number;
	align?: Align;
	bold?: boolean;
	size?: number;
	color?: string;
	spacing?: number;
}

function text(pdf: Pdf, value: string, x: number, y: number, options: TextOptions = {}) {
	pdf
		.font(options.bold ? BOLD : REGULAR)
		.fontSize(options.size ?? 8.5)
		.fillColor(options.color ?? INK)
		.text(value, x, y, {
			width: options.width,
			align: options.align ?? "left",
			lineBreak: false,
			ellipsis: true,
			characterSpacing: options.spacing ?? 0,
		});
}

function paragraph(pdf: Pdf, value: string, x: number, y: number, width: number, size = 7.5): number {
	pdf.font(REGULAR).fontSize(size).fillColor(MUTED);
	const height = pdf.heightOfString(value, { width, lineGap: 1.5 });
	pdf.text(value, x, y, { width, lineGap: 1.5 });
	return height;
}

interface Column {
	label: string;
	width: number;
	align?: Align;
}

interface Cell {
	value: string;
	bold?: boolean;
	color?: string;
}

type TableRow = (string | Cell)[];

interface Formats {
	money: (amount: number) => string;
	signed: (amount: number, sign: "+" | "-") => string;
	percent: (rate: number) => string;
	hours: (minutes: number) => string;
	date: (iso: string) => string;
}

function formatsFor(project: ProjectRow): Formats {
	const locale = localeFor(project.language);
	const money = (amount: number) => formatMoneyIn(amount, project.currency, project.language);
	const decimals = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: "always" });
	const percent = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 3 });
	return {
		money,
		signed: (amount, sign) => `${sign} ${money(amount)}`,
		percent: (rate) => `${percent.format(rate)} %`,
		hours: (minutes) => decimals.format(minutes / 60),
		date: (iso) => {
			const [year, month, day] = iso.split("-").map(Number);
			return new Intl.DateTimeFormat(locale, { day: "numeric", month: "numeric", year: "numeric", timeZone: "UTC" }).format(Date.UTC(year, month - 1, day));
		},
	};
}

interface Layout {
	tiles: boolean;
	yearToDate: boolean;
}

const LAYOUTS: Layout[] = [
	{ tiles: true, yearToDate: true },
	{ tiles: false, yearToDate: true },
	{ tiles: false, yearToDate: false },
];

class Payslip {
	y = MARGIN;
	pages = 1;
	readonly tint: string;
	readonly onAccent: string;

	constructor(
		private pdf: Pdf,
		readonly accent: string,
		private continued: string
	) {
		this.tint = tintOf(accent, 0.08);
		this.onAccent = accentTextFor(accent);
	}

	ensure(height: number) {
		if (this.y + height <= CONTENT_BOTTOM) return;
		this.pdf.addPage({ size: "A4", margin: MARGIN });
		this.pages += 1;
		text(this.pdf, this.continued, MARGIN, MARGIN, { width: WIDTH, color: MUTED, size: 8 });
		this.y = MARGIN + 22;
	}

	heading(label: string, x: number, y: number, width: number) {
		text(this.pdf, label.toUpperCase(), x, y, { width, bold: true, size: 7.5, color: this.accent, spacing: 0.6 });
		this.pdf
			.moveTo(x, y + 13)
			.lineTo(x + width, y + 13)
			.lineWidth(0.75)
			.strokeColor(this.accent)
			.stroke();
	}

	tableHeight(rows: number, footer: boolean, header = true): number {
		return 20 + (header ? 14 : 2) + rows * ROW + (footer ? 19 : 0) + 4;
	}

	table(options: { title: string; columns: Column[]; rows: TableRow[]; footer?: TableRow; x?: number; width?: number; y?: number; header?: boolean }): number {
		const pdf = this.pdf;
		const x = options.x ?? MARGIN;
		const width = options.width ?? WIDTH;
		let y = options.y ?? this.y;
		const fixed = options.columns.reduce((sum, column) => sum + (column.width > 0 ? column.width : 0), 0);
		const widths = options.columns.map((column) => (column.width > 0 ? column.width : width - fixed));
		const lefts = widths.map((_, index) => x + widths.slice(0, index).reduce((sum, value) => sum + value, 0));
		const cell = (row: TableRow, top: number, base: TextOptions) =>
			row.forEach((entry, index) => {
				const value = typeof entry === "string" ? { value: entry } : entry;
				const column = options.columns[index];
				const inset = index === 0 ? 0 : 6;
				text(pdf, value.value, lefts[index] + inset, top, {
					...base,
					width: widths[index] - inset,
					align: column.align ?? "left",
					bold: base.bold || value.bold,
					color: value.color ?? base.color,
				});
			});

		this.heading(options.title, x, y, width);
		y += 20;
		if (options.header === false) y += 2;
		else {
			cell(
				options.columns.map((column) => column.label),
				y,
				{ size: 7, color: MUTED }
			);
			y += 14;
		}
		options.rows.forEach((row, index) => {
			if (index % 2 === 1) pdf.rect(x, y - 0.5, width, ROW).fill(SOFT);
			cell(row, y, {});
			y += ROW;
		});
		if (options.footer) {
			pdf
				.moveTo(x, y + 1)
				.lineTo(x + width, y + 1)
				.lineWidth(0.75)
				.strokeColor(LINE)
				.stroke();
			y += 5;
			cell(options.footer, y, { bold: true });
			y += 14;
		}
		return y + 4;
	}

	card(x: number, y: number, width: number, height: number) {
		this.pdf.roundedRect(x, y, width, height, 6).lineWidth(0.75).fillAndStroke(PAPER, LINE);
	}

	facts(title: string, rows: [string, string][], x: number, y: number, width: number, label = 100, lead?: string) {
		this.heading(title, x + 12, y + 10, width - 24);
		let top = y + 30;
		if (lead) {
			text(this.pdf, lead, x + 12, top, { width: width - 24, bold: true, size: 10 });
			top += 16;
		}
		for (const [name, value] of rows) {
			text(this.pdf, name, x + 12, top, { width: label - 4, color: MUTED, size: 8 });
			text(this.pdf, value, x + 12 + label, top, { width: width - 24 - label, size: 8.5 });
			top += FACT;
		}
	}
}

function taxSteps(net: NetPay, line: PayrollCalculation, formats: Formats, t: Translate): string | null {
	const rates = line.rates;
	if (!rates || net.income_tax === 0) return null;
	if (net.secondary_employer) return t("payslip.tax_steps_flat", { rate: String(rates.secondary_employer_rate), base: formats.money(net.tax_base) });
	const steps: string[] = [];
	let lower = 0;
	for (const bracket of rates.brackets) {
		const upper = bracket.up_to === null ? Infinity : bracket.up_to / 12;
		if (net.tax_base <= lower) break;
		const part = Math.min(net.tax_base, upper) - lower;
		steps.push(
			t("payslip.tax_step", {
				rate: formats.percent(bracket.rate),
				base: formats.money(Math.round(part)),
				tax: formats.money(Math.round(part * (bracket.rate / 100))),
			})
		);
		lower = upper;
	}
	return steps.join("\n");
}

function drawPayslip(
	pdf: Pdf,
	t: Translate,
	project: ProjectRow,
	company: { name: string; details: string[]; logo: Logo | null },
	run: PayrollRunRow,
	line: PayrollCalculation,
	layout: Layout
): number {
	const formats = formatsFor(project);
	const { money, signed, percent, hours } = formats;
	const accent = isAccentColor(project.accent_color) ? project.accent_color : DEFAULT_ACCENT;
	const [year, month] = run.period.split("-").map(Number);
	const periodLabel = new Intl.DateTimeFormat(localeFor(project.language), { month: "long", year: "numeric", timeZone: "UTC" }).format(
		Date.UTC(year, month - 1, 1)
	);
	const sheet = new Payslip(pdf, accent, `${t("payslip.title")} | ${line.person} | ${periodLabel}`);
	const net = line.net;
	const employee = line.employee;
	const minutes = line.hours.minutes;
	const amounts = line.hours.amounts;

	let left = MARGIN;
	if (company.logo) {
		const scale = Math.min(150 / company.logo.width, 44 / company.logo.height, 1);
		pdf.image(company.logo.bytes, MARGIN, MARGIN, { width: company.logo.width * scale, height: company.logo.height * scale });
		left += company.logo.height * scale + 6;
		text(pdf, company.name, MARGIN, left, { bold: true, size: 9.5, width: 280 });
		left += 13;
	} else {
		text(pdf, company.name, MARGIN, MARGIN, { bold: true, size: 13, width: 280 });
		left += 19;
	}
	company.details.forEach((detail, index) => text(pdf, detail, MARGIN, left + index * 11, { color: MUTED, size: 8, width: 280 }));
	left += company.details.length * 11;

	text(pdf, t("payslip.title").toUpperCase(), MARGIN, MARGIN, { width: WIDTH, align: "right", bold: true, size: 8, color: accent, spacing: 1 });
	text(pdf, periodLabel, MARGIN, MARGIN + 13, { width: WIDTH, align: "right", bold: true, size: 20 });
	if (run.pay_date)
		text(pdf, t("payslip.pay_date", { date: formats.date(run.pay_date) }), MARGIN, MARGIN + 42, { width: WIDTH, align: "right", color: MUTED, size: 8.5 });

	sheet.y = Math.max(left, MARGIN + 56) + 10;
	pdf.rect(MARGIN, sheet.y, WIDTH, 2).fill(accent);
	sheet.y += 14;

	const half = (WIDTH - GAP) / 2;
	const address = (employee.address ?? "")
		.split(/\n|,\s*/)
		.map((part) => part.trim())
		.filter(Boolean)
		.join(", ");
	const personal: [string, string][] = [
		...(address ? [[t("payslip.address"), address] as [string, string]] : []),
		...(employee.tax_number ? [[t("payslip.tax_number"), employee.tax_number] as [string, string]] : []),
		...(employee.employee_number ? [[t("payslip.employee_number"), employee.employee_number] as [string, string]] : []),
		...(employee.job_title ? [[t("payslip.job_title"), employee.job_title] as [string, string]] : []),
	];
	const salary = line.hours.salary;
	const days = (value: number) => new Intl.NumberFormat(localeFor(project.language), { maximumFractionDigits: 2 }).format(value);
	const work: [string, string][] = [
		...(salary !== null ? [[employee.pay_type === "hourly" ? t("payslip.hourly_rate") : t("payslip.base_salary"), money(salary)] as [string, string]] : []),
		...(employee.started_on ? [[t("payslip.started_on"), formats.date(employee.started_on)] as [string, string]] : []),
		...(line.hours.service_months != null
			? [
					[
						t("payslip.service"),
						t("payslip.service_value", {
							years: String(Math.floor(line.hours.service_months / 12)),
							months: String(line.hours.service_months % 12),
							days: String(line.hours.service_days ?? 0),
						}),
					] as [string, string],
				]
			: []),
		[t("payslip.hours_fund"), hours(line.hours.fund_minutes)],
		...(line.leave
			? [
					[
						t("payslip.leave_year", { year: String(line.leave.year) }),
						t("payslip.leave_summary", {
							remaining: days(line.leave.remaining_days),
							total: days(line.leave.entitled_days + line.leave.carried_days),
						}),
					] as [string, string],
				]
			: []),
	];
	const cardHeight = 30 + Math.max(16 + personal.length * FACT, work.length * FACT) + 6;
	sheet.card(MARGIN, sheet.y, half, cardHeight);
	sheet.card(MARGIN + half + GAP, sheet.y, half, cardHeight);
	sheet.facts(t("payslip.employee_title"), personal, MARGIN, sheet.y, half, 92, line.person);
	sheet.facts(t("payslip.work_title"), work, MARGIN + half + GAP, sheet.y, half, 110);
	sheet.y += cardHeight + 10;

	const withheld = net ? net.gross - net.net : 0;
	if (layout.tiles) {
		const tiles: [string, string][] = [
			[t("payslip.gross"), money(line.gross)],
			[t("payslip.withheld"), net ? money(withheld) : "-"],
			[t("payslip.net"), net ? money(net.net) : "-"],
			[t("payslip.payout"), line.payout === null ? "-" : money(line.payout)],
		];
		const tileWidth = (WIDTH - GAP * 3) / 4;
		tiles.forEach(([label, value], index) => {
			const x = MARGIN + index * (tileWidth + GAP);
			const last = index === tiles.length - 1;
			if (last) pdf.roundedRect(x, sheet.y, tileWidth, 40, 6).fill(accent);
			else sheet.card(x, sheet.y, tileWidth, 40);
			text(pdf, label, x + 10, sheet.y + 7, { width: tileWidth - 20, size: 7.5, color: last ? sheet.onAccent : MUTED });
			text(pdf, value, x + 10, sheet.y + 19, { width: tileWidth - 20, size: 13, bold: true, color: last ? sheet.onAccent : INK });
		});
		sheet.y += 40 + 12;
	}

	const rate = line.hours.hourly_rate;
	const hourly = (value: number | null) => (value === null ? "" : money(Math.round(value)));
	const earnings: TableRow[] = [
		[t("payslip.regular"), hours(minutes.worked), hourly(rate), money(amounts.regular)],
		[t("payslip.overtime"), hours(minutes.overtime), hourly(rate), money(amounts.overtime)],
		[t("payslip.holidays"), hours(minutes.holiday), hourly(rate), money(amounts.holidays)],
		[t("payslip.leave"), hours(minutes.vacation + minutes.paid_leave), hourly(rate), money(amounts.leave)],
		[t("payslip.sick"), hours(minutes.sick_employer), "", money(amounts.sick)],
		[t("payslip.seniority"), "", percent(line.hours.seniority_percent ?? 0), money(amounts.seniority ?? 0)],
		[t("payslip.overtime_supplement"), "", "", money(amounts.overtime_supplement)],
		[t("payslip.night_supplement"), hours(minutes.night), "", money(amounts.night_supplement)],
		[t("payslip.sunday_supplement"), hours(minutes.sunday), "", money(amounts.sunday_supplement)],
		[t("payslip.holiday_supplement"), hours(minutes.holiday_work), "", money(amounts.holiday_supplement)],
		...line.items.filter((item) => item.type === "gross").map((item) => [item.description, "", "", money(item.amount)]),
		...line.items.filter((item) => item.type === "benefit").map((item) => [t("payslip.benefit", { name: item.description }), "", "", money(item.amount)]),
		[t("payslip.taxable_meal"), "", "", money(line.taxable_reimbursements?.meal ?? 0)],
		[t("payslip.taxable_commute"), "", "", money(line.taxable_reimbursements?.commute ?? 0)],
	].filter((row) => row[3] !== money(0));
	sheet.ensure(sheet.tableHeight(earnings.length, true));
	sheet.y = sheet.table({
		title: t("payslip.earnings"),
		columns: [
			{ label: t("payslip.column_item"), width: 0 },
			{ label: t("payslip.column_hours"), width: 70, align: "right" },
			{ label: t("payslip.column_rate"), width: 90, align: "right" },
			{ label: t("payslip.column_amount"), width: 100, align: "right" },
		],
		rows: earnings,
		footer: [
			t("payslip.gross"),
			hours(minutes.worked + minutes.overtime + minutes.holiday + minutes.vacation + minutes.paid_leave + minutes.sick_employer),
			"",
			money(line.gross),
		],
	});
	sheet.y += 6;

	if (net && line.rates) {
		const rates = line.rates;
		const base = money(net.contribution_base);
		const contributions: TableRow[] = CONTRIBUTION_KEYS.filter(
			(key) => (key !== "injury" && net.employee_contributions[key] > 0) || net.employer_contributions[key] > 0
		).map((key) => {
			const own = key === "injury" ? 0 : net.employee_contributions[key];
			return [
				t(`payslip.contribution_${key}` as TranslationKey),
				base,
				key === "injury" ? "" : percent(rates.employee[key]),
				own ? money(own) : "",
				percent(rates.employer[key]),
				money(net.employer_contributions[key]),
			];
		});
		if (net.health_flat) contributions.push([t("payslip.health_flat"), "", "", money(net.health_flat), "", ""]);
		const difference = net.employee_on_difference ? Object.values(net.employee_on_difference).reduce((sum, value) => sum + value, 0) : 0;
		if (difference) contributions.push([t("payslip.minimum_base_difference", { amount: money(net.base_difference) }), "", "", "", "", money(difference)]);
		const employeeTotal = net.employee_contributions_total + net.health_flat;
		const employeeRate = EMPLOYEE_KEYS.reduce((sum, key) => sum + rates.employee[key], 0);
		const employerRate = CONTRIBUTION_KEYS.reduce((sum, key) => sum + rates.employer[key], 0);
		sheet.ensure(sheet.tableHeight(contributions.length, true) + 12);
		sheet.y = sheet.table({
			title: t("payslip.contributions_title"),
			columns: [
				{ label: t("payslip.column_contribution"), width: 0 },
				{ label: t("payslip.column_base"), width: 80, align: "right" },
				{ label: t("payslip.column_employee_rate"), width: 60, align: "right" },
				{ label: t("payslip.column_employee"), width: 76, align: "right" },
				{ label: t("payslip.column_employer_rate"), width: 64, align: "right" },
				{ label: t("payslip.column_employer"), width: 76, align: "right" },
			],
			rows: contributions,
			footer: [
				t("payslip.contributions_total"),
				"",
				percent(employeeRate),
				money(employeeTotal),
				percent(employerRate),
				money(net.employer_contributions_total),
			],
		});
		text(pdf, `${t("payslip.employer_cost")}: ${money(line.employer_cost)}`, MARGIN, sheet.y, { width: WIDTH, align: "right", color: MUTED, size: 8 });
		sheet.y += 16;

		const available = Math.max(0, net.gross - employeeTotal);
		const generalUsed = Math.min(net.general_relief, available);
		const dependentUsed = Math.min(net.dependent_relief, available - generalUsed);
		const taxRows: TableRow[] = [
			[t("payslip.gross"), money(net.gross)],
			[t("payslip.tax_contributions"), signed(employeeTotal, "-")],
			...(generalUsed ? [[t("payslip.general_relief"), signed(generalUsed, "-")]] : []),
			...(dependentUsed ? [[t("payslip.dependent_relief"), signed(dependentUsed, "-")]] : []),
			[
				{ value: t("payslip.tax_base"), bold: true },
				{ value: money(net.tax_base), bold: true },
			],
		];
		const payoutRows: TableRow[] = [
			[t("payslip.gross"), money(net.gross)],
			[t("payslip.employee_contributions"), signed(employeeTotal, "-")],
			[net.secondary_employer ? t("payslip.income_tax_secondary") : t("payslip.income_tax"), signed(net.income_tax, "-")],
			[
				{ value: t("payslip.net"), bold: true },
				{ value: money(net.net), bold: true },
			],
		];
		const taxableExtra = line.benefits + (line.taxable_reimbursements?.meal ?? 0) + (line.taxable_reimbursements?.commute ?? 0);
		if (taxableExtra) payoutRows.push([t("payslip.benefits_not_paid"), signed(taxableExtra, "-")]);
		if (amounts.meal) payoutRows.push([t("payslip.meal"), signed(amounts.meal, "+")]);
		if (amounts.commute) payoutRows.push([t("payslip.commute"), signed(amounts.commute, "+")]);
		for (const item of line.items.filter((entry) => entry.type === "reimbursement")) payoutRows.push([item.description, signed(item.amount, "+")]);
		if (line.regres) payoutRows.push([t("payslip.regres_net"), signed(line.regres.net, "+")]);
		if (line.performance) payoutRows.push([t("payslip.performance_net"), signed(line.performance.net, "+")]);
		for (const item of line.items.filter((entry) => entry.type === "deduction")) payoutRows.push([item.description, signed(item.amount, "-")]);

		const steps = taxSteps(net, line, formats, t);
		pdf.font(REGULAR).fontSize(7.5);
		const stepsHeight = steps ? pdf.heightOfString(steps, { width: half, lineGap: 1.5 }) + 6 : 0;
		const taxHeight = sheet.tableHeight(taxRows.length, true, false) + stepsHeight;
		const payoutHeight = sheet.tableHeight(payoutRows.length, false, false) + 24 + (employee.iban ? 15 : 0);
		sheet.ensure(Math.max(taxHeight, payoutHeight));
		const top = sheet.y;
		const halfColumns = (label: string): Column[] => [
			{ label, width: 0 },
			{ label: t("payslip.column_amount"), width: 100, align: "right" },
		];
		let taxBottom = sheet.table({
			title: t("payslip.tax_title"),
			columns: halfColumns(t("payslip.column_item")),
			rows: taxRows,
			footer: [net.secondary_employer ? t("payslip.income_tax_secondary") : t("payslip.income_tax"), money(net.income_tax)],
			width: half,
			y: top,
			header: false,
		});
		if (steps) taxBottom += paragraph(pdf, steps, MARGIN, taxBottom, half) + 6;
		const payoutX = MARGIN + half + GAP;
		const payoutBottom = sheet.table({
			title: t("payslip.payout_title"),
			columns: halfColumns(t("payslip.column_item")),
			rows: payoutRows,
			x: payoutX,
			width: half,
			y: top,
			header: false,
		});
		pdf.roundedRect(payoutX, payoutBottom, half, 24, 5).fill(sheet.tint);
		text(pdf, t("payslip.payout"), payoutX + 8, payoutBottom + 7, { bold: true, size: 9.5, color: accent, width: half / 2 });
		text(pdf, line.payout === null ? "-" : money(line.payout), payoutX, payoutBottom + 7, {
			bold: true,
			size: 9.5,
			color: accent,
			width: half - 8,
			align: "right",
		});
		const payoutEnd = payoutBottom + 24 + (employee.iban ? 4 + 11 : 0);
		if (employee.iban)
			text(pdf, t("payslip.paid_to", { iban: formatIban(employee.iban) }), payoutX, payoutBottom + 29, {
				width: half,
				align: "right",
				color: MUTED,
				size: 7.5,
			});
		sheet.y = Math.max(taxBottom, payoutEnd) + 8;
	} else {
		sheet.ensure(30);
		sheet.y += paragraph(pdf, t("payslip.no_net"), MARGIN, sheet.y, WIDTH, 8.5) + 12;
	}

	const separate = (title: string, pay: SeparatePay | null | undefined) => {
		if (!pay) return;
		const rows: TableRow[] = [
			[t("payslip.separate_amount"), money(pay.amount)],
			[t("payslip.separate_exempt"), money(pay.exempt)],
			...EMPLOYEE_KEYS.filter((key) => pay.employee_contributions[key] > 0).map((key) => [
				t(`payslip.contribution_${key}` as TranslationKey),
				signed(pay.employee_contributions[key], "-"),
			]),
			...(pay.income_tax ? [[t("payslip.separate_tax", { rate: String(pay.tax_rate) }), signed(pay.income_tax, "-")]] : []),
		];
		sheet.ensure(sheet.tableHeight(rows.length, true));
		sheet.y =
			sheet.table({
				title,
				columns: [
					{ label: t("payslip.column_item"), width: 0 },
					{ label: t("payslip.column_amount"), width: 100, align: "right" },
				],
				rows,
				footer: [t("payslip.separate_net"), money(pay.net)],
			}) + 8;
	};
	separate(t("payslip.regres_title"), line.regres);
	separate(t("payslip.performance_title"), line.performance);

	if (layout.yearToDate && line.year_to_date) {
		const totals: [string, string][] = [
			[t("payslip.gross"), money(line.year_to_date.gross)],
			[t("payslip.employee_contributions"), money(line.year_to_date.contributions)],
			[t("payslip.income_tax"), money(line.year_to_date.income_tax)],
			[t("payslip.payout"), money(line.year_to_date.payout)],
		];
		sheet.ensure(50);
		sheet.card(MARGIN, sheet.y, WIDTH, 50);
		sheet.heading(t("payslip.year_title", { year: String(year) }), MARGIN + 12, sheet.y + 8, WIDTH - 24);
		const column = (WIDTH - 24) / totals.length;
		totals.forEach(([label, value], index) => {
			const x = MARGIN + 12 + index * column;
			text(pdf, label, x, sheet.y + 26, { width: column - 8, color: MUTED, size: 7.5 });
			text(pdf, value, x, sheet.y + 35, { width: column - 8, bold: true, size: 9.5 });
		});
		sheet.y += 50;
	}
	return sheet.pages;
}

function footers(pdf: Pdf, t: Translate, pages: { first: number; count: number }[], note: string) {
	for (const range of pages) {
		for (let index = 0; index < range.count; index++) {
			pdf.switchToPage(range.first + index);
			const bottom = pdf.page.margins.bottom;
			pdf.page.margins.bottom = 0;
			const y = PAGE_HEIGHT - MARGIN - 10;
			pdf
				.moveTo(MARGIN, y - 8)
				.lineTo(RIGHT_EDGE, y - 8)
				.lineWidth(0.75)
				.strokeColor(LINE)
				.stroke();
			text(pdf, note, MARGIN, y, { width: WIDTH - 90, color: MUTED, size: 7 });
			text(pdf, t("payslip.page", { page: String(index + 1), pages: String(range.count) }), MARGIN, y, { width: WIDTH, align: "right", color: MUTED, size: 7 });
			pdf.page.margins.bottom = bottom;
		}
	}
}

export async function payslipsPdf(project: ProjectRow, run: PayrollRunRow, lines: PayrollCalculation[]): Promise<Uint8Array> {
	const t = translator(project.language);
	const [regular, bold] = await loadFonts();
	const details = await companyFor(project.uuid);
	const company = {
		name: details.legal_name || displayNameOf(project),
		details: [
			[details.address_line1, details.address_line2].filter(Boolean).join(", "),
			[details.postal_code, details.city].filter(Boolean).join(" "),
			details.tax_number ? `${t("payslip.company_tax_number")}: ${details.tax_number}` : "",
			details.registration_number ? `${t("payslip.registration_number")}: ${details.registration_number}` : "",
		].filter((line) => line.trim() !== ""),
		logo: await printableLogo(await loadLogo(project.uuid)),
	};
	const generated = new Intl.DateTimeFormat(localeFor(project.language), { dateStyle: "medium", timeStyle: "short", timeZone: project.timezone }).format(
		Date.now()
	);
	const pdf = new PDFDocument({
		size: "A4",
		margin: MARGIN,
		font: regular as never,
		lang: localeFor(project.language),
		autoFirstPage: false,
		bufferPages: true,
		info: { Title: `${t("payslip.title")} ${run.period}`, Author: company.name, Creator: "RabbitPay", Producer: "RabbitPay" },
	});
	pdf.registerFont(REGULAR, regular);
	pdf.registerFont(BOLD, bold);
	const output = collect(pdf);
	const pages: { first: number; count: number }[] = [];
	const pagesWith = (line: PayrollCalculation, layout: Layout) => {
		const scratch = new PDFDocument({ size: "A4", margin: MARGIN, font: regular as never, autoFirstPage: false });
		scratch.registerFont(REGULAR, regular);
		scratch.registerFont(BOLD, bold);
		scratch.addPage({ size: "A4", margin: MARGIN });
		const count = drawPayslip(scratch, t, project, company, run, line, layout);
		scratch.end();
		return count;
	};
	for (const line of lines) {
		const layout = LAYOUTS.find((candidate) => pagesWith(line, candidate) === 1) ?? LAYOUTS[LAYOUTS.length - 1];
		const first = pdf.bufferedPageRange().count;
		pdf.addPage({ size: "A4", margin: MARGIN });
		drawPayslip(pdf, t, project, company, run, line, layout);
		pages.push({ first, count: pdf.bufferedPageRange().count - first });
	}
	if (lines.length === 0) {
		pdf.addPage({ size: "A4", margin: MARGIN });
		text(pdf, t("payslip.title"), MARGIN, MARGIN, { bold: true, size: 14 });
		pages.push({ first: 0, count: 1 });
	}
	const rates = lines.find((line) => line.rates_period)?.rates_period ?? "-";
	footers(pdf, t, pages, t("payslip.footer", { rates, date: generated }));
	pdf.flushPages();
	pdf.end();
	return output;
}
