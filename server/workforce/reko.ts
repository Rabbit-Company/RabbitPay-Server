import { monthRange } from "./calendar";
import { total, type SeparatePay } from "./net-pay";
import type { CompanyDetails } from "../company";
import type { PayrollCalculation } from "./payroll-runs";
import type { PayrollRunRow } from "../database/models";

const REK_NAMESPACE = "http://edavki.durs.si/Documents/Schemas/REK_O_1.xsd";
const EDP_NAMESPACE = "http://edavki.durs.si/Documents/Schemas/EDP-Common-1.xsd";
const ANALYTICAL_NAMESPACE = "http://edavki.durs.si/Documents/Schemas/REK_O_Analytical_1.xsd";

export type RekKind = "salary" | "regres" | "performance";

export const REK_KINDS: RekKind[] = ["salary", "regres", "performance"];

const INCOME_TYPES: Record<RekKind, string> = { salary: "1001", regres: "1090", performance: "1151" };

export interface RekOptions {
	kind: RekKind;
	responsible_person: string;
	contact: string;
	taxpayer_type: "PO" | "SP";
	collective_agreement: string;
}

export interface RekProblem {
	field: "company_tax_number" | "company_address" | "company_registration_number" | "pay_date" | "employee_tax_number" | "no_employees";
	person?: string;
}

interface Figures {
	employee: { pension: number; health: number; health_flat: number; long_term_care: number; parental: number; unemployment: number };
	employer: { pension: number; health: number; long_term_care: number; parental: number; unemployment: number; injury: number };
	tax: number;
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function amount(cents: number): string {
	const sign = cents < 0 ? "-" : "";
	const absolute = Math.abs(Math.round(cents));
	return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function element(name: string, value: string | number | boolean | null | undefined): string {
	if (value === null || value === undefined || value === "") return "";
	return `<${name}>${escapeXml(String(value))}</${name}>`;
}

function hours(minutes: number): number {
	return Math.round(minutes / 60);
}

function splitName(person: string): { first: string; last: string } {
	const parts = person.trim().split(/\s+/);
	if (parts.length === 1) return { first: parts[0], last: "" };
	return { first: parts.slice(0, -1).join(" "), last: parts.at(-1)! };
}

function taxNumber(value: string | null | undefined): string | null {
	const digits = (value ?? "").replace(/^SI/i, "").replace(/\s/g, "");
	return /^\d{8}$/.test(digits) ? digits : null;
}

export function registrationNumber(value: string | null | undefined): string | null {
	const compact = (value ?? "").replace(/\s/g, "").toUpperCase();
	if (/^\d{7}$/.test(compact)) return `${compact}000`;
	return /^[0-9A-Z]{10}$/.test(compact) ? compact : null;
}

export function isCollectiveAgreementCode(value: unknown): value is string {
	return typeof value === "string" && /^\d{3}$/.test(value);
}

export function isRekKind(value: unknown): value is RekKind {
	return REK_KINDS.includes(value as RekKind);
}

function includedIn(kind: RekKind, line: PayrollCalculation): boolean {
	if (line.net === null) return false;
	if (kind === "regres") return (line.regres?.amount ?? 0) > 0;
	if (kind === "performance") return (line.performance?.amount ?? 0) > 0;
	return true;
}

export function rekProblems(company: CompanyDetails, run: PayrollRunRow, lines: PayrollCalculation[], kind: RekKind = "salary"): RekProblem[] {
	const problems: RekProblem[] = [];
	if (!taxNumber(company.tax_number)) problems.push({ field: "company_tax_number" });
	if (!registrationNumber(company.registration_number)) problems.push({ field: "company_registration_number" });
	if (!company.address_line1 || !company.city || !company.postal_code) problems.push({ field: "company_address" });
	if (!run.pay_date) problems.push({ field: "pay_date" });
	const reported = lines.filter((line) => includedIn(kind, line));
	if (reported.length === 0) problems.push({ field: "no_employees" });
	for (const line of reported) {
		if (!taxNumber(line.employee.tax_number)) problems.push({ field: "employee_tax_number", person: line.person });
	}
	return problems;
}

function salaryFigures(line: PayrollCalculation): Figures {
	const net = line.net!;
	const difference = net.employee_on_difference;
	return {
		employee: {
			pension: net.employee_contributions.pension,
			health: net.employee_contributions.health,
			health_flat: net.health_flat,
			long_term_care: net.employee_contributions.long_term_care,
			parental: net.employee_contributions.parental,
			unemployment: net.employee_contributions.unemployment,
		},
		employer: {
			pension: net.employer_contributions.pension + difference.pension,
			health: net.employer_contributions.health + difference.health,
			long_term_care: net.employer_contributions.long_term_care + difference.long_term_care,
			parental: net.employer_contributions.parental + difference.parental,
			unemployment: net.employer_contributions.unemployment + difference.unemployment,
			injury: net.employer_contributions.injury,
		},
		tax: net.income_tax,
	};
}

function separateFigures(pay: SeparatePay): Figures {
	return {
		employee: {
			pension: pay.employee_contributions.pension,
			health: pay.employee_contributions.health,
			health_flat: 0,
			long_term_care: pay.employee_contributions.long_term_care,
			parental: pay.employee_contributions.parental,
			unemployment: pay.employee_contributions.unemployment,
		},
		employer: {
			pension: pay.employer_contributions.pension,
			health: pay.employer_contributions.health,
			long_term_care: pay.employer_contributions.long_term_care,
			parental: pay.employer_contributions.parental,
			unemployment: pay.employer_contributions.unemployment,
			injury: pay.employer_contributions.injury,
		},
		tax: pay.income_tax,
	};
}

function figuresOf(kind: RekKind, line: PayrollCalculation): Figures {
	if (kind === "regres") return separateFigures(line.regres!);
	if (kind === "performance") return separateFigures(line.performance!);
	return salaryFigures(line);
}

const tag = (name: string, value: string | number | boolean | null | undefined) => element(`podo:${name}`, value);
const paired = (code: string, value: number) => `${tag(`${code}O`, amount(value))}${tag(`${code}P`, amount(value))}`;

function contributionFields(figures: Figures, withFlat: boolean): string {
	const employeeTotal = total(figures.employee);
	const employerTotal = total(figures.employer);
	return [
		paired("A071", figures.employee.pension),
		paired("A072", figures.employee.health),
		withFlat ? paired("A072a", figures.employee.health_flat) : "",
		paired("A072b", figures.employee.long_term_care),
		paired("A073", figures.employee.parental),
		paired("A074", figures.employee.unemployment),
		paired("A075", employeeTotal),
		paired("A081", figures.employer.pension),
		paired("A082", figures.employer.health),
		paired("A082a", figures.employer.long_term_care),
		paired("A083", figures.employer.parental),
		paired("A084", figures.employer.unemployment),
		paired("A085", figures.employer.injury),
		paired("A086", employerTotal),
	].join("");
}

function person(line: PayrollCalculation): string {
	const name = splitName(line.person);
	return `${tag("A001", taxNumber(line.employee.tax_number))}${tag("A003", name.first)}${tag("A003a", name.last)}${tag("A004", "R")}`;
}

function taxFields(line: PayrollCalculation, figures: Figures): string {
	return `${line.employee.secondary_employer ? tag("A090", true) : ""}${tag("A091", amount(figures.tax))}${tag("A093", amount(figures.tax))}`;
}

function period(prefix: string, range: { from: string; to: string }): string {
	return `${tag(`${prefix}OD`, range.from)}${tag(`${prefix}DO`, range.to)}`;
}

function salaryItem(line: PayrollCalculation, range: { from: string; to: string }, collectiveAgreement: string, registration: string): string {
	const net = line.net!;
	const figures = salaryFigures(line);
	const minutes = line.hours.minutes;
	const pay = line.hours.amounts;
	const grossItems = line.items.filter((item) => item.type === "gross").reduce((sum, item) => sum + item.amount, 0);
	const overtime = pay.overtime + pay.overtime_supplement;
	const supplements = overtime + pay.night_supplement + pay.sunday_supplement + pay.holiday_supplement;
	const leaveMinutes = minutes.holiday + minutes.vacation + minutes.paid_leave;
	const regularMinutes = minutes.worked + minutes.waiting_home + leaveMinutes;
	const paidMinutes = regularMinutes + minutes.overtime + minutes.sick_employer;
	const taxableReimbursements = line.taxable_reimbursements.meal + line.taxable_reimbursements.commute;
	const otherBase = line.benefits + taxableReimbursements;
	const share = line.gross > 0 ? line.salary_gross / line.gross : 1;
	const salaryNet = Math.round(line.salary_gross - (total(net.employee_contributions) + net.income_tax) * share);
	const month = range.from.slice(5, 7);
	const baseYear = Number(range.from.slice(0, 4)) - 1;

	return [
		"<podo:AnalyticalDataItem>",
		person(line),
		tag("A028", true),
		tag(`A028_${month}`, true),
		`<podo:IncomeTax>${tag("A051", "1101")}${tag("A052", amount(line.salary_gross))}</podo:IncomeTax>`,
		line.benefits ? `<podo:IncomeTax>${tag("A051", "1102")}${tag("A052", amount(line.benefits))}</podo:IncomeTax>` : "",
		taxableReimbursements ? `<podo:IncomeTax>${tag("A051", "1104")}${tag("A052", amount(taxableReimbursements))}</podo:IncomeTax>` : "",
		line.taxable_reimbursements.meal ? `<podo:A054>${tag("A054a", "B04")}${tag("A054z", amount(line.taxable_reimbursements.meal))}</podo:A054>` : "",
		line.taxable_reimbursements.commute ? `<podo:A054>${tag("A054a", "B05")}${tag("A054z", amount(line.taxable_reimbursements.commute))}</podo:A054>` : "",
		`<podo:Contribution>${tag("A061", "P01a")}${tag("A062", amount(line.salary_gross))}${tag("A062a", hours(paidMinutes))}</podo:Contribution>`,
		net.base_difference ? `<podo:Contribution>${tag("A061", "P02")}${tag("A062", amount(net.base_difference))}</podo:Contribution>` : "",
		otherBase ? `<podo:Contribution>${tag("A061", "P04")}${tag("A062", amount(otherBase))}</podo:Contribution>` : "",
		contributionFields(figures, true),
		taxFields(line, figures),
		line.exempt_reimbursements.meal ? tag("B04", amount(line.exempt_reimbursements.meal)) : "",
		line.exempt_reimbursements.commute ? tag("B05", amount(line.exempt_reimbursements.commute)) : "",
		line.benefits ? tag("B017", amount(line.benefits)) : "",
		`<podo:M01>${tag("M01U", hours(regularMinutes))}${tag("M01Z", amount(line.salary_gross - overtime - pay.sick))}${period("M01", range)}</podo:M01>`,
		pay.sick
			? `<podo:M02>${tag("M02U", hours(minutes.sick_employer))}${tag("M02Z", amount(pay.sick))}${tag("M02L", baseYear)}${period("M02", range)}</podo:M02>`
			: "",
		overtime ? `<podo:M03>${tag("M03U", hours(minutes.overtime))}${tag("M03Z", amount(overtime))}${period("M03", range)}</podo:M03>` : "",
		otherBase ? `<podo:M05>${tag("M05Z", amount(otherBase))}${period("M05", range)}</podo:M05>` : "",
		net.base_difference ? `<podo:M08>${tag("M08Z", amount(net.base_difference))}${period("M08", range)}</podo:M08>` : "",
		tag("S01", registration),
		tag("S02", collectiveAgreement),
		tag("S03", amount(pay.regular)),
		tag("S04", amount(grossItems)),
		tag("S05", amount(supplements)),
		tag("S06", amount(0)),
		tag("S07", amount(pay.holidays + pay.leave + pay.sick)),
		tag("S08", amount(salaryNet)),
		tag("S09", hours(paidMinutes)),
		"</podo:AnalyticalDataItem>",
	]
		.filter(Boolean)
		.join("");
}

function separateItem(kind: "regres" | "performance", line: PayrollCalculation, range: { from: string; to: string }): string {
	const pay = kind === "regres" ? line.regres! : line.performance!;
	const figures = separateFigures(pay);
	const income =
		kind === "regres"
			? `<podo:IncomeTax>${tag("A051", "1103")}${tag("A052", amount(pay.amount))}${pay.taxable ? tag("A052a", amount(pay.taxable)) : ""}</podo:IncomeTax>`
			: [
					line.performance!.business.amount
						? `<podo:IncomeTax>${tag("A051", "1111")}${tag("A052", amount(line.performance!.business.amount))}${
								line.performance!.business.amount > line.performance!.business.exempt
									? tag("A052a", amount(line.performance!.business.amount - line.performance!.business.exempt))
									: ""
							}</podo:IncomeTax>`
						: "",
					line.performance!.winter.amount
						? `<podo:IncomeTax>${tag("A051", "1112")}${tag("A052", amount(line.performance!.winter.amount))}${
								line.performance!.winter.amount > line.performance!.winter.exempt
									? tag("A052a", amount(line.performance!.winter.amount - line.performance!.winter.exempt))
									: ""
							}</podo:IncomeTax>`
						: "",
				].join("");
	return [
		"<podo:AnalyticalDataItem>",
		person(line),
		income,
		pay.taxable ? `<podo:Contribution>${tag("A061", "P04")}${tag("A062", amount(pay.taxable))}</podo:Contribution>` : "",
		pay.taxable ? contributionFields(figures, false) : "",
		taxFields(line, figures),
		pay.taxable ? `<podo:M05>${tag("M05Z", amount(pay.taxable))}${period("M05", range)}</podo:M05>` : "",
		"</podo:AnalyticalDataItem>",
	]
		.filter(Boolean)
		.join("");
}

export function rekOXml(company: CompanyDetails, companyName: string, run: PayrollRunRow, lines: PayrollCalculation[], options: RekOptions): string {
	const kind = options.kind;
	const reported = lines.filter((line) => includedIn(kind, line));
	const range = monthRange(run.period);
	const [year, month] = run.period.split("-");
	const figures = reported.map((line) => figuresOf(kind, line));
	const sum = (pick: (figure: Figures) => number) => figures.reduce((amountSum, figure) => amountSum + pick(figure), 0);
	const registration = registrationNumber(company.registration_number)!;
	const pair = (code: string, value: number) => `${element(`${code}O`, amount(value))}${element(`${code}P`, amount(value))}`;
	const edp = (name: string, value: string | number | null | undefined) => element(`edp:${name}`, value);

	const summary = [
		"<REK_O>",
		element("DocumentType", "O"),
		element("DocumentTypeName", "Original"),
		element("F004", false),
		element("F008", options.responsible_person),
		element("F009", options.contact),
		element("F010", INCOME_TYPES[kind]),
		element("F010a", false),
		element("F011Start", `${month}.${year}`),
		element("F012", run.pay_date),
		element("F101P", amount(sum((figure) => figure.tax))),
		pair(
			"F201",
			sum((figure) => figure.employee.pension)
		),
		pair(
			"F202",
			sum((figure) => figure.employee.health)
		),
		kind === "salary"
			? pair(
					"F202a",
					sum((figure) => figure.employee.health_flat)
				)
			: "",
		pair(
			"F202b",
			sum((figure) => figure.employee.long_term_care)
		),
		pair(
			"F203",
			sum((figure) => figure.employee.parental)
		),
		pair(
			"F204",
			sum((figure) => figure.employee.unemployment)
		),
		pair(
			"F301",
			sum((figure) => figure.employer.pension)
		),
		pair(
			"F302",
			sum((figure) => figure.employer.health)
		),
		pair(
			"F302a",
			sum((figure) => figure.employer.long_term_care)
		),
		pair(
			"F303",
			sum((figure) => figure.employer.parental)
		),
		pair(
			"F304",
			sum((figure) => figure.employer.unemployment)
		),
		pair(
			"F305",
			sum((figure) => figure.employer.injury)
		),
		"</REK_O>",
	].join("");

	const items = reported.map((line) =>
		kind === "salary" ? salaryItem(line, range, options.collective_agreement, registration) : separateItem(kind, line, range)
	);
	const analytical = `<podo:AnalyticalData>${items.join("")}</podo:AnalyticalData>`;
	const header = [
		"<edp:Header><edp:taxpayer>",
		edp("taxNumber", taxNumber(company.tax_number)),
		edp("taxpayerType", options.taxpayer_type),
		edp("name", company.legal_name || companyName),
		edp("address1", company.address_line1),
		edp("address2", company.address_line2),
		edp("city", company.city),
		edp("postNumber", company.postal_code),
		edp("postName", company.city),
		"</edp:taxpayer></edp:Header>",
	].join("");

	return (
		`<?xml version="1.0" encoding="UTF-8"?>\n` +
		`<Envelope xmlns="${REK_NAMESPACE}" xmlns:edp="${EDP_NAMESPACE}" xmlns:podo="${ANALYTICAL_NAMESPACE}">` +
		`${header}<edp:Signatures></edp:Signatures><body><edp:bodyContent></edp:bodyContent><REK>${summary}${analytical}</REK></body></Envelope>\n`
	);
}
