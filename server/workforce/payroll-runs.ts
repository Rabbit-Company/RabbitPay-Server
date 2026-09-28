import Database from "../database/database";
import { configFor, workforceConfig } from "./config";
import { monthRange } from "./calendar";
import { listPeople } from "./people";
import { monthReport, vacationBalance } from "./reports";
import { payrollLine, type PayrollLine } from "./payroll";
import { openPrivate } from "./employees";
import { netPay, readPayrollRates, separatePay, total, type NetPay, type PayrollRates, type SeparatePay } from "./net-pay";
import { datesBetween, isWeekend } from "./holidays";
import type { EmployeeRow, PayrollLineRow, PayrollRatesRow, PayrollRunRow, ProjectRow } from "../database/models";

export type PayrollItemType = "gross" | "benefit" | "regres" | "winter_regres" | "business_performance" | "reimbursement" | "deduction";

export interface PayrollItem {
	type: PayrollItemType;
	description: string;
	amount: number;
}

export interface PerformancePay extends SeparatePay {
	winter: { amount: number; exempt: number };
	business: { amount: number; exempt: number };
}

export interface YearToDate {
	regres_exempt: number;
	winter_exempt: number;
	performance_exempt: number;
	gross: number;
	contributions: number;
	income_tax: number;
	payout: number;
}

export interface PayslipLeave {
	year: number;
	entitled_days: number;
	carried_days: number;
	taken_days: number;
	remaining_days: number;
}

export interface PayrollCalculation {
	period: string;
	person: string;
	employee: {
		employee_number: string | null;
		job_title: string | null;
		employment_type: EmployeeRow["employment_type"];
		pay_type: EmployeeRow["pay_type"];
		tax_number: string | null;
		iban: string | null;
		address: string | null;
		dependents: number;
		claims_general_relief: boolean;
		secondary_employer: boolean;
		weekly_minutes: number;
		started_on?: string | null;
	};
	leave?: PayslipLeave | null;
	year_to_date?: Pick<YearToDate, "gross" | "contributions" | "income_tax" | "payout">;
	rates_period: string | null;
	rates_verified: boolean;
	rates: PayrollRates | null;
	hours: PayrollLine;
	items: PayrollItem[];
	salary_gross: number;
	benefits: number;
	taxable_reimbursements: { meal: number; commute: number };
	exempt_reimbursements: { meal: number; commute: number };
	other_reimbursements: number;
	contribution_floor: number;
	gross: number;
	net: NetPay | null;
	regres: SeparatePay | null;
	performance: PerformancePay | null;
	reimbursements: number;
	deductions: number;
	payout: number | null;
	employer_cost: number;
	warnings: string[];
}

export interface RatesChoice {
	period: string;
	rates: PayrollRates;
	verified: boolean;
}

const ITEM_TYPES: PayrollItemType[] = ["gross", "benefit", "regres", "winter_regres", "business_performance", "reimbursement", "deduction"];
export const EMPTY_YEAR: YearToDate = { regres_exempt: 0, winter_exempt: 0, performance_exempt: 0, gross: 0, contributions: 0, income_tax: 0, payout: 0 };

export function readPayrollItems(value: unknown): PayrollItem[] | null {
	if (!Array.isArray(value) || value.length > 30) return null;
	const items: PayrollItem[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) return null;
		const item = entry as Record<string, unknown>;
		if (!ITEM_TYPES.includes(item.type as PayrollItemType)) return null;
		if (typeof item.description !== "string" || !item.description.trim() || item.description.length > 200) return null;
		if (typeof item.amount !== "number" || !Number.isSafeInteger(item.amount) || item.amount <= 0 || item.amount > 100_000_000) return null;
		items.push({ type: item.type as PayrollItemType, description: item.description.trim(), amount: item.amount });
	}
	return items;
}

export async function ratesFor(projectId: string, period: string): Promise<RatesChoice | null> {
	const [row] = (await Database`
		SELECT * FROM payroll_rates WHERE project = ${projectId} AND period <= ${period} ORDER BY period DESC LIMIT 1
	`) as PayrollRatesRow[];
	if (!row) return null;
	try {
		const rates = readPayrollRates(JSON.parse(row.config));
		return rates ? { period: row.period, rates, verified: row.verified_at !== null } : null;
	} catch {
		return null;
	}
}

function weekdaysIn(period: string): number {
	const range = monthRange(period);
	return datesBetween(range.from, range.to).filter((date) => !isWeekend(date)).length;
}

export function averageTaxRate(net: NetPay, rates: PayrollRates): number {
	if (net.secondary_employer) return rates.secondary_employer_rate / 100;
	if (net.tax_base > 0) return net.income_tax / net.tax_base;
	return (rates.brackets[0]?.rate ?? 0) / 100;
}

export function calculateLine(
	hours: PayrollLine,
	employee: EmployeeRow,
	period: string,
	items: PayrollItem[],
	choice: RatesChoice | null,
	year: YearToDate = EMPTY_YEAR,
	leave: PayslipLeave | null = null
): PayrollCalculation {
	const details = openPrivate(employee);
	const rates = choice?.rates ?? null;
	const warnings: string[] = [];
	const sum = (type: PayrollItemType) => items.filter((item) => item.type === type).reduce((amount, item) => amount + item.amount, 0);
	const employed = employee.employment_type === "full_time" || employee.employment_type === "part_time";

	const salaryGross = hours.amounts.gross + sum("gross");
	const benefits = sum("benefit");
	const mealPaid = hours.amounts.meal;
	const commutePaid = hours.amounts.commute;
	const mealLimit = rates?.meal_exempt_daily == null ? mealPaid : hours.days.meal * rates.meal_exempt_daily;
	const commuteLimit =
		rates?.commute_exempt_per_km == null
			? commutePaid
			: details.commute_km == null
				? commutePaid
				: hours.days.worked * details.commute_km * rates.commute_exempt_per_km;
	if (commutePaid > 0 && rates?.commute_exempt_per_km != null && details.commute_km == null) warnings.push("commute_distance_missing");
	const exempt = { meal: Math.min(mealPaid, mealLimit), commute: Math.min(commutePaid, commuteLimit) };
	const taxableReimbursements = { meal: mealPaid - exempt.meal, commute: commutePaid - exempt.commute };
	const taxableExtra = benefits + taxableReimbursements.meal + taxableReimbursements.commute;
	const otherReimbursements = sum("reimbursement");
	const gross = salaryGross + taxableExtra;

	const regularMinutes = hours.minutes.worked + hours.minutes.holiday + hours.minutes.vacation + hours.minutes.paid_leave + hours.minutes.sick_employer;
	const fullTimeFund = weekdaysIn(period) * 480;
	const floor =
		employed && rates?.minimum_contribution_base != null && fullTimeFund > 0
			? Math.round(rates.minimum_contribution_base * Math.min(1, regularMinutes / fullTimeFund))
			: 0;
	if (employed && rates && rates.minimum_contribution_base == null) warnings.push("minimum_base_missing");
	if (employed && hours.salary !== null && regularMinutes === 0) warnings.push("no_hours");

	const net =
		employed && rates
			? netPay(
					{
						gross,
						claims_general_relief: details.claims_general_relief,
						dependents: details.dependents,
						secondary_employer: details.secondary_employer,
						contribution_floor: floor > salaryGross ? floor + taxableExtra : 0,
					},
					rates
				)
			: null;

	let regres: SeparatePay | null = null;
	let performance: PerformancePay | null = null;
	if (net && rates) {
		const rate = averageTaxRate(net, rates);
		const regresAmount = sum("regres");
		if (regresAmount > 0) {
			if (rates.average_wage == null) warnings.push("average_wage_missing");
			const available = Math.max(0, (rates.average_wage ?? 0) - year.regres_exempt);
			regres = separatePay(regresAmount, available, rate, rates);
		}
		const winterAmount = sum("winter_regres");
		const businessAmount = sum("business_performance");
		if (winterAmount + businessAmount > 0) {
			if (rates.average_wage == null || rates.minimum_wage == null) warnings.push("average_wage_missing");
			const share = Math.min(1, employee.weekly_minutes / 2400);
			const winterLimit = Math.round(((rates.minimum_wage ?? 0) / 2) * share);
			const winterExempt = Math.min(winterAmount, Math.max(0, winterLimit - year.winter_exempt));
			const businessExempt = Math.min(businessAmount, Math.max(0, (rates.average_wage ?? 0) - year.performance_exempt - winterExempt));
			performance = {
				...separatePay(winterAmount + businessAmount, winterExempt + businessExempt, rate, rates),
				winter: { amount: winterAmount, exempt: winterExempt },
				business: { amount: businessAmount, exempt: businessExempt },
			};
		}
	}

	const reimbursements = mealPaid + commutePaid + otherReimbursements;
	const deductions = sum("deduction");
	const extrasNet = (regres?.net ?? 0) + (performance?.net ?? 0);
	const payout = net ? net.net - taxableExtra + reimbursements + extrasNet - deductions : null;
	const extrasEmployer = (regres ? total(regres.employer_contributions) : 0) + (performance ? total(performance.employer_contributions) : 0);
	const extrasCost = (regres?.amount ?? 0) + (performance?.amount ?? 0) + extrasEmployer;
	const employerCost = net
		? gross -
			benefits +
			net.employer_contributions_total +
			mealPaid -
			taxableReimbursements.meal +
			commutePaid -
			taxableReimbursements.commute +
			otherReimbursements +
			extrasCost
		: salaryGross + reimbursements;

	const line: PayrollCalculation = {
		period,
		person: hours.person,
		employee: {
			employee_number: employee.employee_number,
			job_title: employee.job_title,
			employment_type: employee.employment_type,
			pay_type: employee.pay_type,
			tax_number: details.tax_number,
			iban: details.iban,
			address: details.address,
			dependents: details.dependents,
			claims_general_relief: details.claims_general_relief,
			secondary_employer: details.secondary_employer,
			weekly_minutes: employee.weekly_minutes,
			started_on: employee.started_on,
		},
		leave,
		rates_period: choice?.period ?? null,
		rates_verified: choice?.verified ?? false,
		rates,
		hours,
		items,
		salary_gross: salaryGross,
		benefits,
		taxable_reimbursements: taxableReimbursements,
		exempt_reimbursements: exempt,
		other_reimbursements: otherReimbursements,
		contribution_floor: floor,
		gross,
		net,
		regres,
		performance,
		reimbursements,
		deductions,
		payout,
		employer_cost: employerCost,
		warnings,
	};
	const month = monthTotals(line);
	line.year_to_date = {
		gross: year.gross + month.gross,
		contributions: year.contributions + month.contributions,
		income_tax: year.income_tax + month.income_tax,
		payout: year.payout + month.payout,
	};
	return line;
}

function monthTotals(line: Partial<PayrollCalculation>) {
	const extras = [line.regres, line.performance].filter((entry): entry is SeparatePay => Boolean(entry));
	return {
		gross: (line.gross ?? 0) + extras.reduce((sum, entry) => sum + entry.amount, 0),
		contributions:
			(line.net?.employee_contributions_total ?? 0) +
			(line.net?.health_flat ?? 0) +
			extras.reduce((sum, entry) => sum + total(entry.employee_contributions), 0),
		income_tax: (line.net?.income_tax ?? 0) + extras.reduce((sum, entry) => sum + entry.income_tax, 0),
		payout: line.payout ?? 0,
	};
}

async function yearToDate(project: ProjectRow, run: PayrollRunRow): Promise<Map<string, YearToDate>> {
	const year = run.period.slice(0, 4);
	const rows = (await Database`
		SELECT l.member, l.calculation FROM payroll_lines l JOIN payroll_runs r ON r.uuid = l.run
		WHERE r.project = ${project.uuid} AND r.status = 'final' AND r.uuid != ${run.uuid} AND r.period >= ${`${year}-01`} AND r.period < ${run.period}
	`) as { member: string | null; calculation: string }[];
	const totals = new Map<string, YearToDate>();
	for (const row of rows) {
		if (!row.member) continue;
		const calculation = JSON.parse(row.calculation) as Partial<PayrollCalculation>;
		const current = totals.get(row.member) ?? { ...EMPTY_YEAR };
		current.regres_exempt += calculation.regres?.exempt ?? 0;
		current.winter_exempt += calculation.performance?.winter.exempt ?? 0;
		current.performance_exempt += calculation.performance?.exempt ?? 0;
		const month = monthTotals(calculation);
		current.gross += month.gross;
		current.contributions += month.contributions;
		current.income_tax += month.income_tax;
		current.payout += month.payout;
		totals.set(row.member, current);
	}
	return totals;
}

export async function calculateRun(project: ProjectRow, run: PayrollRunRow, keepItems: Map<string, PayrollItem[]>) {
	const config = await workforceConfig(project.uuid);
	const employees = (await Database`SELECT * FROM employees WHERE project = ${project.uuid}`) as EmployeeRow[];
	const people = (await listPeople(project.uuid, config)).filter((person) => employees.some((employee) => employee.member === person.member));
	const report = await monthReport(project, config, run.period, people);
	const range = monthRange(run.period);
	const rates = await ratesFor(project.uuid, run.period);
	const years = await yearToDate(project, run);

	const year = Number(run.period.slice(0, 4));
	const lines = [];
	for (const person of report.people) {
		const employee = employees.find((row) => row.member === person.member)!;
		const hours = payrollLine(person, range, employee, openPrivate(employee), configFor(config, employee));
		const balance = await vacationBalance(project, person.member, year, person.daily_minutes, range.to);
		const leave: PayslipLeave = {
			year,
			entitled_days: balance.entitled_days,
			carried_days: balance.carried_days,
			taken_days: balance.taken_days,
			remaining_days: balance.remaining_days,
		};
		lines.push({
			member: person.member,
			calculation: calculateLine(hours, employee, run.period, keepItems.get(person.member) ?? [], rates, years.get(person.member) ?? EMPTY_YEAR, leave),
		});
	}
	return { rates, lines };
}

export async function yearToDateFor(project: ProjectRow, run: PayrollRunRow, member: string): Promise<YearToDate> {
	return (await yearToDate(project, run)).get(member) ?? EMPTY_YEAR;
}

export async function storeRunCalculation(project: ProjectRow, run: PayrollRunRow) {
	const existing = (await Database`SELECT * FROM payroll_lines WHERE run = ${run.uuid}`) as PayrollLineRow[];
	const items = new Map(existing.filter((line) => line.member !== null).map((line) => [line.member!, JSON.parse(line.items) as PayrollItem[]]));
	const { rates, lines } = await calculateRun(project, run, items);
	const now = Date.now();
	const byMember = new Map(existing.filter((line) => line.member !== null).map((line) => [line.member!, line]));
	const kept = new Set(lines.map((line) => line.member));
	await Database.begin(async (tx) => {
		for (const line of existing) {
			if (line.member === null || !kept.has(line.member)) await tx`DELETE FROM payroll_lines WHERE uuid = ${line.uuid}`;
		}
		for (const line of lines) {
			const current = byMember.get(line.member);
			const items = JSON.stringify(line.calculation.items);
			const calculation = JSON.stringify(line.calculation);
			if (current) {
				await tx`
					UPDATE payroll_lines SET person = ${line.calculation.person}, items = ${items}, calculation = ${calculation}, updated = ${now}
					WHERE uuid = ${current.uuid}
				`;
			} else {
				await tx`
					INSERT INTO payroll_lines(uuid, run, member, person, items, calculation, created, updated)
					VALUES(${crypto.randomUUID()}, ${run.uuid}, ${line.member}, ${line.calculation.person}, ${items}, ${calculation}, ${now}, ${now})
				`;
			}
		}
		await tx`UPDATE payroll_runs SET rates_period = ${rates?.period ?? null}, updated = ${now} WHERE uuid = ${run.uuid}`;
	});
}

export function presentLine(row: PayrollLineRow) {
	return { uuid: row.uuid, member: row.member, person: row.person, calculation: JSON.parse(row.calculation) as PayrollCalculation, updated: row.updated };
}

function extrasOf(line: PayrollCalculation) {
	const extras = [line.regres, line.performance].filter((entry): entry is SeparatePay => Boolean(entry));
	return {
		amount: extras.reduce((sum, entry) => sum + entry.amount, 0),
		employee: extras.reduce((sum, entry) => sum + total(entry.employee_contributions), 0),
		employer: extras.reduce((sum, entry) => sum + total(entry.employer_contributions), 0),
		tax: extras.reduce((sum, entry) => sum + entry.income_tax, 0),
		net: extras.reduce((sum, entry) => sum + entry.net, 0),
	};
}

export function runTotals(lines: PayrollCalculation[]) {
	return lines.reduce(
		(totals, line) => {
			const extras = extrasOf(line);
			return {
				gross: totals.gross + line.gross,
				extra_pay: totals.extra_pay + extras.amount,
				employee_contributions: totals.employee_contributions + (line.net?.employee_contributions_total ?? 0) + extras.employee,
				income_tax: totals.income_tax + (line.net?.income_tax ?? 0) + extras.tax,
				health_flat: totals.health_flat + (line.net?.health_flat ?? 0),
				net: totals.net + (line.net?.net ?? 0) + extras.net,
				reimbursements: totals.reimbursements + line.reimbursements,
				deductions: totals.deductions + line.deductions,
				payout: totals.payout + (line.payout ?? 0),
				employer_contributions: totals.employer_contributions + (line.net?.employer_contributions_total ?? 0) + extras.employer,
				employer_cost: totals.employer_cost + line.employer_cost,
			};
		},
		{
			gross: 0,
			extra_pay: 0,
			employee_contributions: 0,
			income_tax: 0,
			health_flat: 0,
			net: 0,
			reimbursements: 0,
			deductions: 0,
			payout: 0,
			employer_contributions: 0,
			employer_cost: 0,
		}
	);
}

function csvCell(value: string | number | null): string {
	const text = value === null ? "" : String(value);
	return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function major(amount: number | null | undefined): string {
	return amount === null || amount === undefined ? "" : (amount / 100).toFixed(2);
}

export function payrollCsv(run: PayrollRunRow, lines: PayrollCalculation[]): string {
	const header = [
		"period",
		"person",
		"employee_number",
		"tax_number",
		"iban",
		"employment_type",
		"hours_worked",
		"hours_overtime",
		"hours_holiday",
		"hours_leave",
		"hours_sick_employer",
		"hours_sick_insurance",
		"regular",
		"overtime",
		"holidays",
		"leave",
		"sick",
		"supplements",
		"seniority",
		"extra_gross",
		"benefits",
		"taxable_meal",
		"taxable_commute",
		"gross",
		"contribution_base",
		"minimum_base_difference",
		"pension_employee",
		"health_employee",
		"unemployment_employee",
		"parental_employee",
		"long_term_care_employee",
		"general_relief",
		"dependent_relief",
		"tax_base",
		"income_tax",
		"health_flat",
		"net",
		"reimbursements",
		"deductions",
		"payout",
		"employer_contributions",
		"regres",
		"regres_taxable",
		"regres_tax",
		"winter_regres",
		"business_performance",
		"performance_taxable",
		"performance_tax",
		"employer_cost",
		"pay_date",
	];
	const hours = (minutes: number) => (minutes / 60).toFixed(2);
	const rows = lines.map((line) => {
		const amounts = line.hours.amounts;
		const minutes = line.hours.minutes;
		const net = line.net;
		const supplements = amounts.overtime_supplement + amounts.night_supplement + amounts.sunday_supplement + amounts.holiday_supplement;
		return [
			run.period,
			line.person,
			line.employee.employee_number,
			line.employee.tax_number,
			line.employee.iban,
			line.employee.employment_type,
			hours(minutes.worked),
			hours(minutes.overtime),
			hours(minutes.holiday),
			hours(minutes.vacation + minutes.paid_leave),
			hours(minutes.sick_employer),
			hours(minutes.sick_insurance),
			major(amounts.regular),
			major(amounts.overtime),
			major(amounts.holidays),
			major(amounts.leave),
			major(amounts.sick),
			major(supplements),
			major(amounts.seniority ?? 0),
			major(line.salary_gross - amounts.gross),
			major(line.benefits),
			major(line.taxable_reimbursements.meal),
			major(line.taxable_reimbursements.commute),
			major(line.gross),
			major(net?.contribution_base),
			major(net?.base_difference),
			major(net?.employee_contributions.pension),
			major(net?.employee_contributions.health),
			major(net?.employee_contributions.unemployment),
			major(net?.employee_contributions.parental),
			major(net?.employee_contributions.long_term_care),
			major(net?.general_relief),
			major(net?.dependent_relief),
			major(net?.tax_base),
			major(net?.income_tax),
			major(net?.health_flat),
			major(net?.net),
			major(line.reimbursements),
			major(line.deductions),
			major(line.payout),
			major(net?.employer_contributions_total),
			major(line.regres?.amount),
			major(line.regres?.taxable),
			major(line.regres?.income_tax),
			major(line.performance?.winter.amount),
			major(line.performance?.business.amount),
			major(line.performance?.taxable),
			major(line.performance?.income_tax),
			major(line.employer_cost),
			run.pay_date,
		];
	});
	return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
