export const DEFAULT_TIMEZONE = "Europe/Ljubljana";

export interface ZonedParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
	const existing = formatters.get(timezone);
	if (existing) return existing;
	const created = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	});
	formatters.set(timezone, created);
	return created;
}

export function isTimezone(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 1 || value.length > 100) return false;
	try {
		formatter(value).format(0);
		return true;
	} catch {
		return false;
	}
}

export function zonedParts(timestamp: number, timezone: string): ZonedParts {
	const values = new Map(
		formatter(timezone)
			.formatToParts(timestamp)
			.map((part) => [part.type, part.value])
	);
	return {
		year: Number(values.get("year")),
		month: Number(values.get("month")),
		day: Number(values.get("day")),
		hour: Number(values.get("hour")),
		minute: Number(values.get("minute")),
		second: Number(values.get("second")),
	};
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

export function localDate(timestamp: number, timezone: string): string {
	const value = zonedParts(timestamp, timezone);
	return `${value.year}-${pad(value.month)}-${pad(value.day)}`;
}

export function isLocalDate(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const [year, month, day] = value.split("-").map(Number);
	const checked = new Date(Date.UTC(year, month - 1, day));
	return checked.getUTCFullYear() === year && checked.getUTCMonth() === month - 1 && checked.getUTCDate() === day;
}

export function shiftLocalDate(value: string, days: number): string {
	if (!isLocalDate(value) || !Number.isInteger(days)) throw new Error("Invalid local date");
	const [year, month, day] = value.split("-").map(Number);
	const shifted = new Date(Date.UTC(year, month - 1, day + days));
	return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export function startOfLocalDate(value: string, timezone: string): number {
	if (!isLocalDate(value) || !isTimezone(timezone)) throw new Error("Invalid local date or timezone");
	const [year, month, day] = value.split("-").map(Number);
	const target = Date.UTC(year, month - 1, day);
	let result = target;
	for (let attempt = 0; attempt < 4; attempt++) {
		const actual = zonedParts(result, timezone);
		const difference = target - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
		if (difference === 0) break;
		result += difference;
	}
	if (localDate(result, timezone) !== value) throw new Error("Local date does not exist in this timezone");
	return result;
}

export function endOfLocalDate(value: string, timezone: string): number {
	return startOfLocalDate(shiftLocalDate(value, 1), timezone) - 1;
}

export function previousLocalMonth(now: number, timezone: string): { from: number; to: number } {
	const current = zonedParts(now, timezone);
	const first = new Date(Date.UTC(current.year, current.month - 2, 1));
	const fromDate = `${first.getUTCFullYear()}-${pad(first.getUTCMonth() + 1)}-01`;
	const nextDate = `${current.year}-${pad(current.month)}-01`;
	return { from: startOfLocalDate(fromDate, timezone), to: startOfLocalDate(nextDate, timezone) - 1 };
}

export function isCompleteLocalVatPeriod(from: number, to: number, timezone: string): boolean {
	if (![from, to].every(Number.isSafeInteger) || from <= 0 || to < from || !isTimezone(timezone)) return false;
	const fromDate = localDate(from, timezone);
	const toDate = localDate(to, timezone);
	if (from !== startOfLocalDate(fromDate, timezone) || to !== endOfLocalDate(toDate, timezone)) return false;
	const [startYear, startMonth, startDay] = fromDate.split("-").map(Number);
	const [endYear, endMonth, endDay] = toDate.split("-").map(Number);
	if (startDay !== 1 || startYear !== endYear) return false;
	const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
	if (endDay !== lastDay) return false;
	const months = endMonth - startMonth + 1;
	return months === 1 || (months === 3 && (startMonth - 1) % 3 === 0);
}
