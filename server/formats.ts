import { minorUnitDigits } from "./invoicing";
import { zonedParts } from "./timezone";

export type DateFormat = "auto" | "d. m. yyyy" | "dd.mm.yyyy" | "dd/mm/yyyy" | "mm/dd/yyyy" | "yyyy-mm-dd";
export type TimeFormat = "auto" | "24" | "12";

export const DATE_FORMATS: { value: DateFormat; label: string; example: string }[] = [
	{ value: "d. m. yyyy", label: "16. 9. 2026", example: "Slovenia" },
	{ value: "dd.mm.yyyy", label: "16.09.2026", example: "Central Europe" },
	{ value: "dd/mm/yyyy", label: "16/09/2026", example: "United Kingdom and much of Europe" },
	{ value: "mm/dd/yyyy", label: "09/16/2026", example: "United States" },
	{ value: "yyyy-mm-dd", label: "2026-09-16", example: "ISO 8601" },
	{ value: "auto", label: "Match the reader's device", example: "Varies by who opens it" },
];

export const TIME_FORMATS: { value: TimeFormat; label: string }[] = [
	{ value: "24", label: "14:05" },
	{ value: "12", label: "2:05 PM" },
	{ value: "auto", label: "Match the reader's device" },
];

export const DEFAULT_DATE_FORMAT: DateFormat = "auto";
export const DEFAULT_TIME_FORMAT: TimeFormat = "24";

export function isDateFormat(value: unknown): value is DateFormat {
	return typeof value === "string" && DATE_FORMATS.some((entry) => entry.value === value);
}

export function isTimeFormat(value: unknown): value is TimeFormat {
	return typeof value === "string" && TIME_FORMATS.some((entry) => entry.value === value);
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

export function formatDate(timestamp: number | null | undefined, format: DateFormat = DEFAULT_DATE_FORMAT, timezone?: string): string {
	if (!timestamp) return "-";

	const date = new Date(timestamp);
	const local = timezone ? zonedParts(timestamp, timezone) : null;
	const day = local?.day ?? date.getDate();
	const month = local?.month ?? date.getMonth() + 1;
	const year = local?.year ?? date.getFullYear();

	switch (format) {
		case "d. m. yyyy":
			return `${day}. ${month}. ${year}`;
		case "dd.mm.yyyy":
			return `${pad(day)}.${pad(month)}.${year}`;
		case "dd/mm/yyyy":
			return `${pad(day)}/${pad(month)}/${year}`;
		case "mm/dd/yyyy":
			return `${pad(month)}/${pad(day)}/${year}`;
		case "yyyy-mm-dd":
			return `${year}-${pad(month)}-${pad(day)}`;
		default:
			return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: timezone });
	}
}

export function toUtcDateInput(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

const LANGUAGE_LOCALES: Record<string, string> = { en: "en-GB", sl: "sl-SI" };

export function localeFor(language: string): string {
	return LANGUAGE_LOCALES[language] ?? language;
}

export function formatPercentIn(rate: number, language: string): string {
	return new Intl.NumberFormat(localeFor(language), { style: "percent", maximumFractionDigits: 4 }).format(rate / 100);
}

export function formatMoneyIn(amount: number, currency: string, language: string): string {
	const digits = minorUnitDigits(currency);
	const major = amount / Math.pow(10, digits);
	try {
		return new Intl.NumberFormat(localeFor(language), { style: "currency", currency, useGrouping: "always" }).format(major);
	} catch {
		return `${major.toFixed(digits)} ${currency}`;
	}
}

export function formatDateIn(timestamp: number, format: DateFormat, language: string, timezone?: string): string {
	if (format !== "auto") return formatDate(timestamp, format, timezone);
	try {
		return new Date(timestamp).toLocaleDateString(localeFor(language), { year: "numeric", month: "long", day: "numeric", timeZone: timezone });
	} catch {
		return formatDate(timestamp, format, timezone);
	}
}

export function formatTime(timestamp: number | null | undefined, format: TimeFormat = DEFAULT_TIME_FORMAT, timezone?: string): string {
	if (!timestamp) return "-";

	const date = new Date(timestamp);
	const local = timezone ? zonedParts(timestamp, timezone) : null;
	const hours = local?.hour ?? date.getHours();
	const minutes = local?.minute ?? date.getMinutes();

	if (format === "24") return `${pad(hours)}:${pad(minutes)}`;

	if (format === "12") {
		const hour = hours % 12 === 0 ? 12 : hours % 12;
		return `${hour}:${pad(minutes)} ${hours < 12 ? "AM" : "PM"}`;
	}

	return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZone: timezone });
}

export function formatDateTime(
	timestamp: number | null | undefined,
	dateFormat: DateFormat = DEFAULT_DATE_FORMAT,
	timeFormat: TimeFormat = DEFAULT_TIME_FORMAT,
	timezone?: string
): string {
	if (!timestamp) return "-";

	if (dateFormat === "auto" && timeFormat === "auto") {
		return new Date(timestamp).toLocaleString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			timeZone: timezone,
		});
	}

	return `${formatDate(timestamp, dateFormat, timezone)} ${formatTime(timestamp, timeFormat, timezone)}`;
}

export function formatIban(iban: string): string {
	return iban
		.replace(/\s+/g, "")
		.toUpperCase()
		.replace(/(.{4})(?=.)/g, "$1 ");
}
