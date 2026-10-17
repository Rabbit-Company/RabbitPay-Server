export type DunningLevel = 1 | 2 | 3;

export const DUNNING_LEVELS: DunningLevel[] = [1, 2, 3];
export const DEFAULT_DEADLINE_DAYS = 8;
export const MAX_DEADLINE_DAYS = 60;
export const MAX_DUNNING_LINES = 200;
export const RECOVERY_COMPENSATION_EUR = 4000;
export const COMPENSATION_LIMITATION_YEARS = 3;
export const LIMITATION_WARNING_YEARS = 3;

const DAY = 86400000;

export interface StatutoryRate {
	from: string;
	rate: number;
	gazette: string;
}

export const STATUTORY_RATES: StatutoryRate[] = [
	{ from: "2010-01-01", rate: 9, gazette: "1/2010" },
	{ from: "2010-07-01", rate: 9, gazette: "53/2010" },
	{ from: "2011-01-01", rate: 9, gazette: "1/2011" },
	{ from: "2011-07-01", rate: 9.25, gazette: "54/2011" },
	{ from: "2012-01-01", rate: 9, gazette: "1/2012" },
	{ from: "2012-07-01", rate: 9, gazette: "51/2012" },
	{ from: "2013-01-01", rate: 8.75, gazette: "1/2013" },
	{ from: "2013-07-01", rate: 8.5, gazette: "56/2013" },
	{ from: "2014-01-01", rate: 8.25, gazette: "1/2014" },
	{ from: "2014-07-01", rate: 8.15, gazette: "50/2014" },
	{ from: "2015-01-01", rate: 8.05, gazette: "2/2015" },
	{ from: "2015-07-01", rate: 8.05, gazette: "48/2015" },
	{ from: "2016-01-01", rate: 8.05, gazette: "1/2016" },
	{ from: "2016-07-01", rate: 8, gazette: "48/2016" },
	{ from: "2017-01-01", rate: 8, gazette: "1/2017" },
	{ from: "2017-07-01", rate: 8, gazette: "34/2017" },
	{ from: "2018-01-01", rate: 8, gazette: "1/2018" },
	{ from: "2018-07-01", rate: 8, gazette: "46/2018" },
	{ from: "2019-01-01", rate: 8, gazette: "1/2019" },
	{ from: "2019-07-01", rate: 8, gazette: "44/2019" },
	{ from: "2020-01-01", rate: 8, gazette: "2/2020" },
	{ from: "2020-07-01", rate: 8, gazette: "93/2020" },
	{ from: "2021-01-01", rate: 8, gazette: "5/2021" },
	{ from: "2021-07-01", rate: 8, gazette: "106/2021" },
	{ from: "2022-01-01", rate: 8, gazette: "5/2022" },
	{ from: "2022-07-01", rate: 8, gazette: "90/2022" },
	{ from: "2023-01-01", rate: 10.5, gazette: "2/2023" },
	{ from: "2023-07-01", rate: 12, gazette: "74/2023" },
	{ from: "2024-01-01", rate: 12.5, gazette: "1/2024" },
	{ from: "2024-07-01", rate: 12.25, gazette: "55/2024" },
	{ from: "2025-01-01", rate: 11.15, gazette: "2/2025" },
	{ from: "2025-07-01", rate: 10.15, gazette: "50/2025" },
	{ from: "2026-01-01", rate: 10.15, gazette: "2/2026" },
	{ from: "2026-07-01", rate: 10.4, gazette: "1124/2026" },
];

export function lastKnownRateEnd(): string {
	const last = STATUTORY_RATES[STATUTORY_RATES.length - 1]!;
	const [year, month] = last.from.split("-").map(Number) as [number, number];
	return month === 1 ? `${year}-06-30` : `${year}-12-31`;
}

function dayIndex(date: string): number {
	return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY);
}

function dateOfIndex(index: number): string {
	return new Date(index * DAY).toISOString().slice(0, 10);
}

function yearLength(year: number): number {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
}

export function daysBetween(from: string, to: string): number {
	return dayIndex(to) - dayIndex(from);
}

export interface InterestPeriod {
	from: string;
	to: string;
	days: number;
	rate: number;
	interest: number;
}

export interface InterestResult {
	days: number;
	interest: number;
	capped: boolean;
	periods: InterestPeriod[];
}

function rateIndexOn(index: number): number {
	let found = 0;
	for (let position = 0; position < STATUTORY_RATES.length; position++) {
		if (dayIndex(STATUTORY_RATES[position]!.from) <= index) found = position;
	}
	return found;
}

function boundaryAfter(index: number): number {
	const year = Number(dateOfIndex(index).slice(0, 4));
	const nextYear = dayIndex(`${year + 1}-01-01`);
	const next = STATUTORY_RATES.map((entry) => dayIndex(entry.from)).find((start) => start > index);
	return next === undefined ? nextYear : Math.min(next, nextYear);
}

export function statutoryInterest(principal: number, dueDate: string, until: string): InterestResult {
	const first = dayIndex(dueDate) + 1;
	const last = dayIndex(until);
	if (principal <= 0 || last < first) return { days: Math.max(0, last - first + 1), interest: 0, capped: false, periods: [] };

	const periods: InterestPeriod[] = [];
	let exact = 0;
	let cursor = first;
	while (cursor <= last) {
		const end = Math.min(boundaryAfter(cursor) - 1, last);
		const rate = STATUTORY_RATES[rateIndexOn(cursor)]!.rate;
		const days = end - cursor + 1;
		const share = (principal * rate * days) / (100 * yearLength(Number(dateOfIndex(cursor).slice(0, 4))));
		const previous = periods[periods.length - 1];
		if (previous && previous.rate === rate && dayIndex(previous.to) === cursor - 1) {
			previous.to = dateOfIndex(end);
			previous.days += days;
			previous.interest += share;
		} else {
			periods.push({ from: dateOfIndex(cursor), to: dateOfIndex(end), days, rate, interest: share });
		}
		exact += share;
		cursor = end + 1;
	}

	const rounded = Math.round(exact);
	const capped = rounded > principal;
	for (const period of periods) period.interest = Math.round(period.interest);
	return { days: last - first + 1, interest: capped ? principal : rounded, capped, periods };
}

export interface CompensationCheck {
	currency: string;
	business: boolean;
	dueDate: string;
	until: string;
}

export function compensationAllowed(check: CompensationCheck): boolean {
	if (!check.business || check.currency !== "EUR") return false;
	const overdue = daysBetween(check.dueDate, check.until);
	if (overdue <= 0) return false;
	const [year, month, day] = check.dueDate.split("-");
	const expires = `${Number(year) + COMPENSATION_LIMITATION_YEARS}-${month}-${day}`;
	return daysBetween(check.until, expires) >= 0;
}

export function possiblyTimeBarred(dueDate: string, until: string): boolean {
	const [year, month, day] = dueDate.split("-");
	return daysBetween(`${Number(year) + LIMITATION_WARNING_YEARS}-${month}-${day}`, until) > 0;
}

export function isDunningLevel(value: unknown): value is DunningLevel {
	return value === 1 || value === 2 || value === 3;
}

export function nextLevel(previous: DunningLevel | null): DunningLevel {
	if (previous === null) return 1;
	return previous === 3 ? 3 : ((previous + 1) as DunningLevel);
}

export function interestAvailable(taxCountry: string | null | undefined): boolean {
	return taxCountry === "SI";
}

export function compensationAvailable(taxCountry: string | null | undefined): boolean {
	return taxCountry !== null && taxCountry !== undefined && EU_COUNTRIES.has(taxCountry);
}

const EU_COUNTRIES = new Set([
	"AT",
	"BE",
	"BG",
	"CY",
	"CZ",
	"DE",
	"DK",
	"EE",
	"ES",
	"FI",
	"FR",
	"GR",
	"HR",
	"HU",
	"IE",
	"IT",
	"LT",
	"LU",
	"LV",
	"MT",
	"NL",
	"PL",
	"PT",
	"RO",
	"SE",
	"SI",
	"SK",
]);

export interface DunningLineInput {
	open: number;
	due: string;
}

export interface DunningLineFigures {
	days: number;
	interest: number;
	compensation: number;
}

export interface DunningOptions {
	until: string;
	interest: boolean;
	compensation: boolean;
	business: boolean;
	currency: string;
}

export function lineFigures(line: DunningLineInput, options: DunningOptions): DunningLineFigures {
	const days = Math.max(0, daysBetween(line.due, options.until));
	return {
		days,
		interest: options.interest ? statutoryInterest(line.open, line.due, options.until).interest : 0,
		compensation:
			options.compensation && compensationAllowed({ currency: options.currency, business: options.business, dueDate: line.due, until: options.until })
				? RECOVERY_COMPENSATION_EUR
				: 0,
	};
}

export interface DunningTotals {
	principal: number;
	interest: number;
	compensation: number;
	total: number;
}

export function dunningTotals(lines: (DunningLineInput & DunningLineFigures)[]): DunningTotals {
	const principal = lines.reduce((sum, line) => sum + line.open, 0);
	const interest = lines.reduce((sum, line) => sum + line.interest, 0);
	const compensation = lines.reduce((sum, line) => sum + line.compensation, 0);
	return { principal, interest, compensation, total: principal + interest + compensation };
}
