import { formatDateIn, localeFor, type DateFormat } from "./formats";
import { t } from "./i18n";
import { endOfLocalDate, localDate, shiftLocalDate, startOfLocalDate, zonedParts } from "./timezone";

export const DAY = 24 * 60 * 60 * 1000;
export const INTERVAL_UNITS = ["week", "month", "year"] as const;
export const MAX_INTERVAL_COUNT = 60;
export const MAX_OCCURRENCES = 1000;
export const MAX_DAYS_UNTIL_DUE = 365;
export const MAX_CATCH_UP = 12;

export type IntervalUnit = (typeof INTERVAL_UNITS)[number];

export interface Schedule {
	interval_unit: string;
	interval_count: number;
	anchor_date: number;
	anchor_occurrence: number;
}

export interface Limits {
	max_occurrences: number | null;
	end_date: number | null;
}

export function isIntervalUnit(value: unknown): value is IntervalUnit {
	return typeof value === "string" && (INTERVAL_UNITS as readonly string[]).includes(value);
}

export function isIntervalCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_INTERVAL_COUNT;
}

export function startOfDay(timestamp: number, timezone?: string): number {
	if (timezone) return startOfLocalDate(localDate(timestamp, timezone), timezone);
	const date = new Date(timestamp);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

export function addInterval(anchor: number, unit: string, count: number, times: number, timezone?: string): number {
	if (timezone) {
		const parts = zonedParts(anchor, timezone);
		const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
		if (unit === "week") {
			date.setUTCDate(date.getUTCDate() + 7 * count * times);
		} else {
			const months = (unit === "year" ? 12 : 1) * count * times;
			const day = date.getUTCDate();
			date.setUTCDate(1);
			date.setUTCMonth(date.getUTCMonth() + months);
			const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
			date.setUTCDate(Math.min(day, lastDay));
		}
		return startOfLocalDate(date.toISOString().slice(0, 10), timezone);
	}
	const date = new Date(anchor);

	if (unit === "week") {
		date.setDate(date.getDate() + 7 * count * times);
		return date.getTime();
	}

	const months = (unit === "year" ? 12 : 1) * count * times;
	const day = date.getDate();
	date.setDate(1);
	date.setMonth(date.getMonth() + months);
	const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
	date.setDate(Math.min(day, lastDay));
	return date.getTime();
}

export function occurrenceDate(schedule: Schedule, occurrence: number, timezone?: string): number {
	return addInterval(schedule.anchor_date, schedule.interval_unit, schedule.interval_count, occurrence - schedule.anchor_occurrence, timezone);
}

export function withinLimits(occurrence: number, date: number, limits: Limits): boolean {
	if (limits.max_occurrences !== null && occurrence >= limits.max_occurrences) return false;
	if (limits.end_date !== null && date > limits.end_date) return false;
	return true;
}

export function nextRunAfter(schedule: Schedule, limits: Limits, occurrence: number, timezone?: string): number | null {
	const date = occurrenceDate(schedule, occurrence, timezone);
	return withinLimits(occurrence, date, limits) ? date : null;
}

export function upcomingRuns(schedule: Schedule, limits: Limits, fromOccurrence: number, count: number, timezone?: string): number[] {
	const dates: number[] = [];
	for (let occurrence = fromOccurrence; dates.length < count; occurrence++) {
		const date = nextRunAfter(schedule, limits, occurrence, timezone);
		if (date === null) break;
		dates.push(date);
	}
	return dates;
}

export function firstRunFrom(schedule: Schedule, occurrence: number, from: number, timezone?: string): number {
	let date = occurrenceDate(schedule, occurrence, timezone);
	for (let step = 1; date < from && step < 10000; step++) {
		date = addInterval(schedule.anchor_date, schedule.interval_unit, schedule.interval_count, occurrence - schedule.anchor_occurrence + step, timezone);
	}
	return date;
}

export interface Period {
	start: number;
	end: number;
}

export function periodOf(schedule: Schedule, occurrence: number, timezone?: string): Period {
	const start = occurrenceDate(schedule, occurrence, timezone);
	if (timezone) {
		const next = occurrenceDate(schedule, occurrence + 1, timezone);
		return { start, end: endOfLocalDate(shiftLocalDate(localDate(next, timezone), -1), timezone) };
	}
	const end = new Date(occurrenceDate(schedule, occurrence + 1));
	end.setDate(end.getDate() - 1);
	end.setHours(0, 0, 0, 0);
	return { start, end: end.getTime() };
}

function monthName(timestamp: number, language: string, timezone?: string): string {
	try {
		return new Date(timestamp).toLocaleDateString(localeFor(language), { month: "long", timeZone: timezone });
	} catch {
		return String(new Date(timestamp).getMonth() + 1);
	}
}

export function fillPlaceholders(text: string, period: Period, language: string, dateFormat: DateFormat, timezone?: string): string {
	const values: Record<string, string> = {
		month: monthName(period.start, language, timezone),
		year: String(timezone ? zonedParts(period.start, timezone).year : new Date(period.start).getFullYear()),
		period: t(language, "recurring.period", {
			start: formatDateIn(period.start, dateFormat, language, timezone),
			end: formatDateIn(period.end, dateFormat, language, timezone),
		}),
	};
	return text.replace(/\{(month|year|period)\}/g, (_, name: string) => values[name]);
}
