export interface ContributionRates {
	pension: number;
	health: number;
	unemployment: number;
	parental: number;
	long_term_care: number;
}

export interface EmployerRates extends ContributionRates {
	injury: number;
}

export interface TaxBracket {
	up_to: number | null;
	rate: number;
}

export interface PayrollRates {
	employee: ContributionRates;
	employer: EmployerRates;
	health_flat: number;
	brackets: TaxBracket[];
	general_relief: number;
	additional_relief: { income_limit: number; base: number; factor: number };
	dependent_relief: number[];
	dependent_relief_step: number;
	secondary_employer_rate: number;
	minimum_contribution_base: number | null;
	minimum_wage: number | null;
	average_wage: number | null;
	meal_exempt_daily: number | null;
	commute_exempt_per_km: number | null;
	note: string | null;
}

export interface PayrollPreset {
	period: string;
	label: string;
	rates: PayrollRates;
}

const SLOVENIA_2025_07: PayrollRates = {
	employee: { pension: 15.5, health: 6.36, unemployment: 0.14, parental: 0.1, long_term_care: 1 },
	employer: { pension: 8.85, health: 6.56, injury: 0.53, unemployment: 0.06, parental: 0.1, long_term_care: 1 },
	health_flat: 3717,
	brackets: [
		{ up_to: 921026, rate: 16 },
		{ up_to: 2708900, rate: 26 },
		{ up_to: 5417800, rate: 33 },
		{ up_to: 7801632, rate: 39 },
		{ up_to: null, rate: 50 },
	],
	general_relief: 526000,
	additional_relief: { income_limit: 1683200, base: 1973699, factor: 1.17259 },
	dependent_relief: [299583, 325687, 543202, 760716, 978231],
	dependent_relief_step: 217515,
	secondary_employer_rate: 25,
	minimum_contribution_base: 143695,
	minimum_wage: 127772,
	average_wage: null,
	meal_exempt_daily: 796,
	commute_exempt_per_km: 21,
	note: null,
};

const SLOVENIA_2026_01: PayrollRates = {
	...SLOVENIA_2025_07,
	brackets: [
		{ up_to: 972140, rate: 16 },
		{ up_to: 2859244, rate: 26 },
		{ up_to: 5718488, rate: 33 },
		{ up_to: 8234620, rate: 39 },
		{ up_to: null, rate: 50 },
	],
	general_relief: 555193,
	additional_relief: { income_limit: 1776618, base: 2083239, factor: 1.17259 },
	dependent_relief: [299583, 325677, 543202, 760727, 978251],
	dependent_relief_step: 217525,
	minimum_contribution_base: 143695,
	minimum_wage: 148188,
};

const SLOVENIA_2026_03: PayrollRates = {
	...SLOVENIA_2026_01,
	health_flat: 3936,
	minimum_contribution_base: 152162,
};

export const SLOVENIA_PRESETS: PayrollPreset[] = [
	{ period: "2026-03", label: "Slovenia from March 2026", rates: SLOVENIA_2026_03 },
	{ period: "2026-01", label: "Slovenia January and February 2026", rates: SLOVENIA_2026_01 },
	{ period: "2025-07", label: "Slovenia from July 2025", rates: SLOVENIA_2025_07 },
];

const EMPLOYEE_KEYS: (keyof ContributionRates)[] = ["pension", "health", "unemployment", "parental", "long_term_care"];
const EMPLOYER_KEYS: (keyof EmployerRates)[] = [...EMPLOYEE_KEYS, "injury"];

function percent(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function cents(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000_00;
}

function optionalCents(value: unknown): number | null | undefined {
	if (value === undefined || value === null) return null;
	return cents(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function readPayrollRates(value: unknown): PayrollRates | null {
	const input = record(value);
	const employee = record(input?.employee);
	const employer = record(input?.employer);
	const additional = record(input?.additional_relief);
	if (!input || !employee || !employer || !additional) return null;
	if (!EMPLOYEE_KEYS.every((key) => percent(employee[key])) || !EMPLOYER_KEYS.every((key) => percent(employer[key]))) return null;
	if (!cents(input.health_flat) || !cents(input.general_relief) || !cents(input.dependent_relief_step)) return null;
	if (!cents(additional.income_limit) || !cents(additional.base)) return null;
	if (typeof additional.factor !== "number" || !Number.isFinite(additional.factor) || additional.factor < 0 || additional.factor > 10) return null;
	if (!Array.isArray(input.dependent_relief) || input.dependent_relief.length > 20 || !input.dependent_relief.every(cents)) return null;
	if (input.note !== undefined && input.note !== null && (typeof input.note !== "string" || input.note.length > 2000)) return null;
	const secondary = input.secondary_employer_rate ?? 25;
	if (!percent(secondary)) return null;
	const optional = {
		minimum_contribution_base: optionalCents(input.minimum_contribution_base),
		minimum_wage: optionalCents(input.minimum_wage),
		average_wage: optionalCents(input.average_wage),
		meal_exempt_daily: optionalCents(input.meal_exempt_daily),
		commute_exempt_per_km: optionalCents(input.commute_exempt_per_km),
	};
	if (Object.values(optional).some((entry) => entry === undefined)) return null;

	const brackets = input.brackets;
	if (!Array.isArray(brackets) || brackets.length === 0 || brackets.length > 10) return null;
	let previous = 0;
	for (const [index, bracket] of brackets.entries()) {
		const row = record(bracket);
		if (!row || !percent(row.rate)) return null;
		const last = index === brackets.length - 1;
		if (last ? row.up_to !== null : !cents(row.up_to) || (row.up_to as number) <= previous) return null;
		if (!last) previous = row.up_to as number;
	}

	return {
		employee: Object.fromEntries(EMPLOYEE_KEYS.map((key) => [key, employee[key]])) as unknown as ContributionRates,
		employer: Object.fromEntries(EMPLOYER_KEYS.map((key) => [key, employer[key]])) as unknown as EmployerRates,
		health_flat: input.health_flat,
		brackets: (brackets as TaxBracket[]).map((bracket) => ({ up_to: bracket.up_to, rate: bracket.rate })),
		general_relief: input.general_relief,
		additional_relief: { income_limit: additional.income_limit, base: additional.base, factor: additional.factor },
		dependent_relief: input.dependent_relief as number[],
		dependent_relief_step: input.dependent_relief_step,
		secondary_employer_rate: secondary,
		minimum_contribution_base: optional.minimum_contribution_base as number | null,
		minimum_wage: optional.minimum_wage as number | null,
		average_wage: optional.average_wage as number | null,
		meal_exempt_daily: optional.meal_exempt_daily as number | null,
		commute_exempt_per_km: optional.commute_exempt_per_km as number | null,
		note: typeof input.note === "string" && input.note.trim() ? input.note.trim() : null,
	};
}

export interface NetPayInput {
	gross: number;
	claims_general_relief: boolean;
	dependents: number;
	secondary_employer?: boolean;
	contribution_floor?: number;
}

export type EmployeeContributions = Record<keyof ContributionRates, number>;
export type EmployerContributions = Record<keyof EmployerRates, number>;

export interface NetPay {
	gross: number;
	employee_contributions: EmployeeContributions;
	employee_contributions_total: number;
	general_relief: number;
	additional_relief: number;
	dependent_relief: number;
	tax_base: number;
	income_tax: number;
	secondary_employer: boolean;
	health_flat: number;
	net: number;
	contribution_base: number;
	base_difference: number;
	employee_on_difference: EmployeeContributions;
	employer_contributions: EmployerContributions;
	employer_contributions_total: number;
}

function monthlyDependentRelief(rates: PayrollRates, dependents: number): number {
	let annual = 0;
	for (let index = 0; index < dependents; index++) {
		const listed = rates.dependent_relief[index];
		const last = rates.dependent_relief.at(-1) ?? 0;
		annual += listed ?? last + rates.dependent_relief_step * (index - rates.dependent_relief.length + 1);
	}
	return Math.round(annual / 12);
}

function monthlyGeneralRelief(rates: PayrollRates, gross: number): { total: number; additional: number } {
	const base = rates.general_relief / 12;
	const limit = rates.additional_relief.income_limit / 12;
	const additional = gross <= limit ? Math.max(0, rates.additional_relief.base / 12 - rates.additional_relief.factor * gross) : 0;
	const total = Math.round(base + additional);
	return { total, additional: additional > 0 ? total - Math.round(base) : 0 };
}

export function progressiveTax(base: number, brackets: TaxBracket[]): number {
	let tax = 0;
	let lower = 0;
	for (const bracket of brackets) {
		const upper = bracket.up_to === null ? Infinity : bracket.up_to / 12;
		if (base > lower) tax += (Math.min(base, upper) - lower) * (bracket.rate / 100);
		lower = upper;
		if (base <= upper) break;
	}
	return Math.round(tax);
}

export function employeeContributionsOf(amount: number, rates: Pick<PayrollRates, "employee">): EmployeeContributions {
	return Object.fromEntries(EMPLOYEE_KEYS.map((key) => [key, Math.round((amount * rates.employee[key]) / 100)])) as EmployeeContributions;
}

export function employerContributionsOf(amount: number, rates: Pick<PayrollRates, "employer">): EmployerContributions {
	return Object.fromEntries(EMPLOYER_KEYS.map((key) => [key, Math.round((amount * rates.employer[key]) / 100)])) as EmployerContributions;
}

export function total(values: Record<string, number>): number {
	return Object.values(values).reduce((sum, amount) => sum + amount, 0);
}

export function netPay(input: NetPayInput, rates: PayrollRates): NetPay {
	const gross = Math.max(0, Math.round(input.gross));
	const floor = Math.max(0, Math.round(input.contribution_floor ?? 0));
	const contributionBase = Math.max(gross, floor);
	const difference = contributionBase - gross;
	const employee = employeeContributionsOf(gross, rates);
	const onDifference = employeeContributionsOf(difference, rates);
	const employer = employerContributionsOf(contributionBase, rates);
	const employeeTotal = total(employee);
	const employerTotal = total(employer) + total(onDifference);
	const secondary = Boolean(input.secondary_employer);
	const relief = input.claims_general_relief && !secondary ? monthlyGeneralRelief(rates, gross) : { total: 0, additional: 0 };
	const dependent = secondary ? 0 : monthlyDependentRelief(rates, input.dependents);
	const healthFlat = gross > 0 && !secondary ? rates.health_flat : 0;
	const taxBase = Math.max(0, gross - employeeTotal - healthFlat - relief.total - dependent);
	const tax = secondary ? Math.round(taxBase * (rates.secondary_employer_rate / 100)) : progressiveTax(taxBase, rates.brackets);
	return {
		gross,
		employee_contributions: employee,
		employee_contributions_total: employeeTotal,
		general_relief: relief.total,
		additional_relief: relief.additional,
		dependent_relief: dependent,
		tax_base: taxBase,
		income_tax: tax,
		secondary_employer: secondary,
		health_flat: healthFlat,
		net: gross - employeeTotal - tax - healthFlat,
		contribution_base: contributionBase,
		base_difference: difference,
		employee_on_difference: onDifference,
		employer_contributions: employer,
		employer_contributions_total: employerTotal,
	};
}

export interface SeparatePay {
	amount: number;
	exempt: number;
	taxable: number;
	employee_contributions: EmployeeContributions;
	employer_contributions: EmployerContributions;
	tax_rate: number;
	income_tax: number;
	net: number;
}

export function separatePay(amount: number, exempt: number, averageRate: number, rates: PayrollRates): SeparatePay {
	const free = Math.min(amount, Math.max(0, exempt));
	const taxable = amount - free;
	const employee = employeeContributionsOf(taxable, rates);
	const employer = employerContributionsOf(taxable, rates);
	const tax = Math.round(Math.max(0, taxable - total(employee)) * averageRate);
	return {
		amount,
		exempt: free,
		taxable,
		employee_contributions: employee,
		employer_contributions: employer,
		tax_rate: Math.round(averageRate * 10000) / 100,
		income_tax: tax,
		net: amount - total(employee) - tax,
	};
}
