import { formatMoneyIn, localeFor } from "../formats";

export type NoticeParams = Record<string, string | number>;

function monthName(period: string, locale: string): string {
	const [year, month] = period.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
}

function dayName(date: string, locale: string): string {
	const [year, month, day] = date.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function startTime(timestamp: number, locale: string, now: number): string {
	const start = new Date(timestamp);
	const time = start.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
	if (start.toDateString() === new Date(now).toDateString()) return time;
	return `${start.toLocaleDateString(locale, { day: "numeric", month: "short" })} ${time}`;
}

export function readableParams(params: Record<string, unknown>, language: string, now = Date.now()): NoticeParams {
	const locale = localeFor(language);
	const shown: NoticeParams = {};
	for (const [name, value] of Object.entries(params)) {
		if (typeof value === "string" || typeof value === "number") shown[name] = value;
	}
	if (typeof params.starts_at === "number") shown.time = startTime(params.starts_at, locale, now);
	if (typeof params.starts_on === "string") shown.from = dayName(params.starts_on, locale);
	if (typeof params.ends_on === "string") shown.to = dayName(params.ends_on, locale);
	if (typeof params.period === "string") shown.period = monthName(params.period, locale);
	if (typeof params.amount === "number" && typeof params.currency === "string") shown.amount = formatMoneyIn(params.amount, params.currency, language);
	return shown;
}

export function fillNotice(template: string, params: NoticeParams): string {
	return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

export function noticeKey(kind: string, variant: unknown): string {
	return `notify.${kind}${typeof variant === "string" && variant !== "" ? `_${variant}` : ""}`;
}

export function isAppPath(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\");
}
