import { isLocalDate, localDate, zonedParts } from "../timezone";

export const REPEAT_UNITS = ["day", "week", "month", "year"] as const;
export const MAX_REPEAT_INTERVAL = 99;
export const MAX_REPEAT_SKIPS = 366;
export const MAX_OCCURRENCES = 400;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const MAX_SCANNED_DAYS = 3700;

export type RepeatUnit = (typeof REPEAT_UNITS)[number];

export interface Repeat {
	unit: RepeatUnit;
	interval: number;
	weekdays: number[] | null;
	until: string | null;
}

export interface RepeatColumns {
	repeat_unit: string | null;
	repeat_interval: number;
	repeat_weekdays: string | null;
	repeat_until: string | null;
	repeat_skips: string | null;
}

export interface TimedOccurrence {
	date: string;
	starts_at: number;
	ends_at: number;
}

function dayNumber(date: string): number {
	const [year, month, day] = date.split("-").map(Number);
	return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

function dateOf(number: number): string {
	return new Date(number * DAY_MS).toISOString().slice(0, 10);
}

function weekdayOfNumber(number: number): number {
	return ((((number + 3) % 7) + 7) % 7) + 1;
}

export function isoWeekday(date: string): number {
	return weekdayOfNumber(dayNumber(date));
}

export function shiftDate(date: string, days: number): string {
	return dateOf(dayNumber(date) + days);
}

export function daysApart(from: string, to: string): number {
	return dayNumber(to) - dayNumber(from);
}

function isRepeatUnit(value: unknown): value is RepeatUnit {
	return typeof value === "string" && (REPEAT_UNITS as readonly string[]).includes(value);
}

function readWeekdays(value: unknown, startsOn: string): number[] | null | undefined {
	if (value === undefined || value === null) return null;
	if (!Array.isArray(value) || value.length === 0 || value.length > 7) return undefined;
	if (value.some((day) => typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 7)) return undefined;
	const days = [...new Set([...(value as number[]), isoWeekday(startsOn)])].sort((first, second) => first - second);
	return days.length === 1 ? null : days;
}

export function readRepeat(value: unknown, startsOn: string): Repeat | null | undefined {
	if (value === undefined || value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) return undefined;
	const data = value as Record<string, unknown>;
	const interval = data.interval ?? 1;
	const until = data.until ?? null;
	if (!isRepeatUnit(data.unit)) return undefined;
	if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 1 || interval > MAX_REPEAT_INTERVAL) return undefined;
	if (until !== null && (!isLocalDate(until) || until < startsOn)) return undefined;
	const weekdays = data.unit === "week" ? readWeekdays(data.weekdays, startsOn) : null;
	if (weekdays === undefined) return undefined;
	return { unit: data.unit, interval, weekdays, until };
}

export function repeatOf(row: RepeatColumns): Repeat | null {
	if (!isRepeatUnit(row.repeat_unit)) return null;
	const weekdays = row.repeat_weekdays ? row.repeat_weekdays.split(",").map(Number) : null;
	return { unit: row.repeat_unit, interval: Number(row.repeat_interval), weekdays, until: row.repeat_until };
}

export function repeatColumns(repeat: Repeat | null): Omit<RepeatColumns, "repeat_skips"> {
	return {
		repeat_unit: repeat?.unit ?? null,
		repeat_interval: repeat?.interval ?? 1,
		repeat_weekdays: repeat?.weekdays ? repeat.weekdays.join(",") : null,
		repeat_until: repeat?.until ?? null,
	};
}

export function sameRepeat(first: Repeat | null, second: Repeat | null): boolean {
	return JSON.stringify(first) === JSON.stringify(second);
}

export function skipsOf(row: Pick<RepeatColumns, "repeat_skips">): Set<string> {
	return new Set(row.repeat_skips ? row.repeat_skips.split(",") : []);
}

export function withSkip(row: Pick<RepeatColumns, "repeat_skips">, date: string): string | null {
	const skips = [...skipsOf(row).add(date)].sort();
	return skips.length > MAX_REPEAT_SKIPS ? null : skips.join(",");
}

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthlyDates(startsOn: string, months: number, first: string, last: string): string[] {
	const [year, month, day] = startsOn.split("-").map(Number);
	const [firstYear, firstMonth] = first.split("-").map(Number);
	const apart = (firstYear - year) * 12 + (firstMonth - month);
	const dates: string[] = [];
	for (let step = Math.max(0, Math.floor(apart / months)); dates.length < MAX_OCCURRENCES; step++) {
		const total = month - 1 + step * months;
		const occurrenceYear = year + Math.floor(total / 12);
		const occurrenceMonth = (total % 12) + 1;
		const occurrenceDay = Math.min(day, daysInMonth(occurrenceYear, occurrenceMonth));
		const date = `${occurrenceYear}-${String(occurrenceMonth).padStart(2, "0")}-${String(occurrenceDay).padStart(2, "0")}`;
		if (date > last) break;
		if (date >= first) dates.push(date);
	}
	return dates;
}

function dailyDates(startsOn: string, interval: number, first: string, last: string): string[] {
	const start = dayNumber(startsOn);
	const end = dayNumber(last);
	const dates: string[] = [];
	const skipped = Math.max(0, Math.ceil((dayNumber(first) - start) / interval));
	for (let number = start + skipped * interval; number <= end && dates.length < MAX_OCCURRENCES; number += interval) dates.push(dateOf(number));
	return dates;
}

function weeklyDates(startsOn: string, repeat: Repeat, first: string, last: string): string[] {
	const weekdays = repeat.weekdays ?? [isoWeekday(startsOn)];
	const firstWeek = dayNumber(startsOn) - (isoWeekday(startsOn) - 1);
	const end = Math.min(dayNumber(last), dayNumber(first) + MAX_SCANNED_DAYS);
	const dates: string[] = [];
	for (let number = dayNumber(first); number <= end && dates.length < MAX_OCCURRENCES; number++) {
		if (Math.floor((number - firstWeek) / 7) % repeat.interval !== 0) continue;
		if (weekdays.includes(weekdayOfNumber(number))) dates.push(dateOf(number));
	}
	return dates;
}

export function occurrenceDates(startsOn: string, repeat: Repeat | null, from: string, to: string, skips: Set<string> = new Set()): string[] {
	if (to < from) return [];
	if (!repeat) return startsOn >= from && startsOn <= to ? [startsOn] : [];
	const first = from > startsOn ? from : startsOn;
	const last = repeat.until !== null && repeat.until < to ? repeat.until : to;
	if (last < first) return [];

	const dates =
		repeat.unit === "day"
			? dailyDates(startsOn, repeat.interval, first, last)
			: repeat.unit === "week"
				? weeklyDates(startsOn, repeat, first, last)
				: monthlyDates(startsOn, repeat.interval * (repeat.unit === "year" ? 12 : 1), first, last);
	return dates.filter((date) => !skips.has(date));
}

export function timestampOfLocalTime(date: string, minuteOfDay: number, timezone: string): number {
	const [year, month, day] = date.split("-").map(Number);
	const target = Date.UTC(year, month - 1, day, 0, minuteOfDay);
	let result = target;
	for (let attempt = 0; attempt < 4; attempt++) {
		const actual = zonedParts(result, timezone);
		const difference = target - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
		if (difference === 0) break;
		result += difference;
	}
	return result;
}

export function timedOccurrences(
	startsAt: number,
	durationMinutes: number,
	repeat: Repeat | null,
	skips: Set<string>,
	from: number,
	to: number,
	timezone: string
): TimedOccurrence[] {
	const length = durationMinutes * MINUTE_MS;
	const startsOn = localDate(startsAt, timezone);
	const overlaps = (occurrence: TimedOccurrence) => occurrence.starts_at <= to && occurrence.ends_at > from;
	if (!repeat) return [{ date: startsOn, starts_at: startsAt, ends_at: startsAt + length }].filter(overlaps);

	const parts = zonedParts(startsAt, timezone);
	const minuteOfDay = parts.hour * 60 + parts.minute;
	const withinMinute = startsAt % MINUTE_MS;
	return occurrenceDates(startsOn, repeat, localDate(from - length, timezone), localDate(to, timezone), skips)
		.map((date) => {
			const occurrenceStart = timestampOfLocalTime(date, minuteOfDay, timezone) + withinMinute;
			return { date, starts_at: occurrenceStart, ends_at: occurrenceStart + length };
		})
		.filter(overlaps);
}

export function endedBefore(repeat: Repeat, occurrence: string): Repeat {
	return { ...repeat, until: shiftDate(occurrence, -1) };
}
