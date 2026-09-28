import { formatMoneyIn } from "../../../server/formats";
import { language } from "../i18n";
import type { StoreDayHours } from "../../../server/store/config";

const DAY = 24 * 60 * 60 * 1000;

export function money(amount: number, currency: string): string {
	return formatMoneyIn(amount, currency, language());
}

function locale(): string {
	return language() === "sl" ? "sl-SI" : "en-GB";
}

export function shortDate(timestamp: number): string {
	return new Intl.DateTimeFormat(locale(), { weekday: "short", day: "numeric", month: "short" }).format(new Date(timestamp));
}

export function longDate(timestamp: number): string {
	return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long", year: "numeric" }).format(new Date(timestamp));
}

function isWeekend(date: Date): boolean {
	return date.getDay() === 0 || date.getDay() === 6;
}

function addDays(start: Date, days: number, businessDays: boolean): Date {
	const date = new Date(start);
	let left = days;
	while (businessDays && isWeekend(date)) date.setDate(date.getDate() + 1);
	while (left > 0) {
		date.setDate(date.getDate() + 1);
		if (!businessDays || !isWeekend(date)) left--;
	}
	return date;
}

export interface DeliveryWindow {
	from: number;
	to: number;
	shipsFrom: number | null;
}

export function deliveryWindow(
	days: { min_days: number; max_days: number },
	rules: { business_days: boolean; cutoff_hour: number },
	restockAt: number | null = null,
	now = Date.now()
): DeliveryWindow {
	const start = new Date(Math.max(now, restockAt ?? 0));
	if (restockAt === null && start.getHours() >= rules.cutoff_hour) start.setDate(start.getDate() + 1);
	start.setHours(12, 0, 0, 0);
	return {
		from: addDays(start, days.min_days, rules.business_days).getTime(),
		to: addDays(start, days.max_days, rules.business_days).getTime(),
		shipsFrom: restockAt !== null && restockAt > now ? restockAt : null,
	};
}

export function describeWindow(window: DeliveryWindow): string {
	const from = shortDate(window.from);
	const to = shortDate(window.to);
	return from === to ? from : `${from} - ${to}`;
}

export function cutoffLeft(cutoffHour: number, now = new Date()): number | null {
	if (cutoffHour >= 24 || isWeekend(now)) return null;
	const cutoff = new Date(now);
	cutoff.setHours(cutoffHour, 0, 0, 0);
	const left = cutoff.getTime() - now.getTime();
	return left > 0 && left < DAY ? left : null;
}

export function duration(milliseconds: number): string {
	const minutes = Math.max(1, Math.round(milliseconds / 60000));
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (hours === 0) return `${rest} min`;
	return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function partsIn(timezone: string, now: Date): { weekday: number; minutes: number } {
	try {
		const parts = new Intl.DateTimeFormat("en-GB", {
			timeZone: timezone,
			weekday: "short",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).formatToParts(now);
		const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
		const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(value("weekday"));
		return { weekday: Math.max(0, weekday), minutes: Number(value("hour")) * 60 + Number(value("minute")) };
	} catch {
		return { weekday: (now.getDay() + 6) % 7, minutes: now.getHours() * 60 + now.getMinutes() };
	}
}

function minutesOf(time: string): number {
	const [hours, minutes] = time.split(":").map(Number);
	return hours * 60 + minutes;
}

export interface OpenState {
	open: boolean;
	today: number;
	closesAt: string | null;
	opensAt: { day: number; time: string } | null;
}

export function openState(hours: StoreDayHours[], timezone: string, now = new Date()): OpenState {
	const { weekday, minutes } = partsIn(timezone, now);
	const today = hours[weekday];
	if (today && !today.closed && minutes >= minutesOf(today.open) && minutes < minutesOf(today.close)) {
		return { open: true, today: weekday, closesAt: today.close, opensAt: null };
	}
	for (let offset = 0; offset < 8; offset++) {
		const day = (weekday + offset) % 7;
		const entry = hours[day];
		if (!entry || entry.closed) continue;
		if (offset === 0 && minutes >= minutesOf(entry.open)) continue;
		return { open: false, today: weekday, closesAt: null, opensAt: { day, time: entry.open } };
	}
	return { open: false, today: weekday, closesAt: null, opensAt: null };
}

export function weekdayName(day: number, style: "long" | "short" = "long"): string {
	const monday = new Date(Date.UTC(2024, 0, 1 + day));
	return new Intl.DateTimeFormat(locale(), { weekday: style, timeZone: "UTC" }).format(monday);
}

export function percentOff(price: number, compare: number | null): number | null {
	if (compare === null || compare <= price || compare === 0) return null;
	return Math.round(((compare - price) / compare) * 100);
}
