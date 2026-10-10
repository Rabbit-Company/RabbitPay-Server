import type { CalendarEntry, CalendarFeed, CalendarPerson, CalendarRepeat, Project } from "../api";
import { el } from "../dom";
import { formatTime } from "../money";
import { language, t, tn, type UiKey } from "../i18n";
import { absenceLabel, formatDay, holidayName, shiftDate } from "./workforce-shared";
import type { TimeFormat } from "../../../server/formats";

export const MINUTE_MS = 60 * 1000;
export const DAY_MINUTES = 24 * 60;

const PERSON_COLORS = ["#0891b2", "#d97706", "#db2777", "#059669", "#7c3aed", "#dc2626", "#0d9488", "#ca8a04", "#2563eb", "#c026d3"];
const WORK_WEEK = [1, 2, 3, 4, 5];

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

export function dateKey(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayKey(): string {
	return dateKey(new Date());
}

export function dayStart(key: string): number {
	const [year, month, day] = key.split("-").map(Number);
	return new Date(year, month - 1, day).getTime();
}

export function clockValue(timestamp: number): string {
	const date = new Date(timestamp);
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function clockOfMinutes(minutes: number): string {
	return `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
}

export function minutesOfClock(clock: string): number {
	const [hours, minutes] = clock.split(":").map(Number);
	return hours * 60 + minutes;
}

export function isoWeekday(key: string): number {
	const [year, month, day] = key.split("-").map(Number);
	return ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
}

function locale(): string {
	return language() === "sl" ? "sl-SI" : "en-GB";
}

function utcOf(key: string): number {
	const [year, month, day] = key.split("-").map(Number);
	return Date.UTC(year, month - 1, day);
}

export function weekdayLabel(key: string, width: "short" | "long" = "short"): string {
	return new Intl.DateTimeFormat(locale(), { weekday: width, timeZone: "UTC" }).format(utcOf(key));
}

export function monthLabel(key: string): string {
	return new Intl.DateTimeFormat(locale(), { month: "long", year: "numeric", timeZone: "UTC" }).format(utcOf(key));
}

export function longDayLabel(key: string): string {
	return new Intl.DateTimeFormat(locale(), { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(utcOf(key));
}

export function shortDayLabel(key: string): string {
	return new Intl.DateTimeFormat(locale(), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(utcOf(key));
}

export function weekdayOfIso(weekday: number, width: "short" | "long" = "short"): string {
	return weekdayLabel(shiftDate("2024-01-01", weekday - 1), width);
}

export function clock(project: Pick<Project, "time_format">, timestamp: number): string {
	return formatTime(timestamp, project.time_format as TimeFormat);
}

export function initials(name: string): string {
	const words = name.split(/[\s@._-]+/).filter(Boolean);
	return ((words[0]?.[0] ?? "") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase() || "?";
}

export function personColor(feed: CalendarFeed, account: string): string {
	if (account === feed.me) return "var(--accent)";
	const others = feed.people.filter((person) => person.account !== feed.me);
	const index = others.findIndex((person) => person.account === account);
	return PERSON_COLORS[Math.max(index, 0) % PERSON_COLORS.length];
}

export function paint(node: HTMLElement, color: string) {
	node.style.setProperty("--person", color);
	node.style.setProperty("--person-text", color === "var(--accent)" ? "var(--accent-text)" : "#ffffff");
}

export function avatar(feed: CalendarFeed, person: CalendarPerson, size = ""): HTMLElement {
	const node = el("span", { class: `calendar-avatar ${size}` }, initials(person.name));
	paint(node, personColor(feed, person.account));
	node.setAttribute("aria-hidden", "true");
	return node;
}

export function presenceDot(person: CalendarPerson): HTMLElement {
	const label = t(`chat.presence_${person.presence}` as UiKey);
	const dot = el("span", { class: `presence presence-${person.presence}`, title: label });
	dot.setAttribute("role", "img");
	dot.setAttribute("aria-label", label);
	return dot;
}

export function entryTitle(entry: CalendarEntry): string {
	if (entry.kind === "holiday") return holidayName(entry.holiday_name!);
	if (entry.kind === "absence") return entry.absence_kind ? absenceLabel(entry.absence_kind) : t("calendar.absent");
	if (entry.title !== null) return entry.title;
	return entry.kind === "meeting" ? t("calendar.in_meeting") : t("calendar.busy");
}

export function coversDate(entry: CalendarEntry, key: string): boolean {
	if (entry.all_day) return entry.starts_on! <= key && entry.ends_on! >= key;
	const start = dayStart(key);
	return entry.starts_at! < dayStart(shiftDate(key, 1)) && entry.ends_at! > start;
}

export function involves(entry: CalendarEntry, accounts: Iterable<string>): boolean {
	if (entry.kind === "holiday") return true;
	for (const account of accounts) if (entry.accounts.includes(account)) return true;
	return false;
}

export function entryWhen(project: Project, entry: CalendarEntry): string {
	if (entry.all_day) {
		const first = formatDay(entry.starts_on!, project);
		return entry.ends_on === entry.starts_on ? first : `${first} - ${formatDay(entry.ends_on!, project)}`;
	}
	const day = shortDayLabel(dateKey(new Date(entry.starts_at!)));
	return `${day} | ${clock(project, entry.starts_at!)} - ${clock(project, entry.ends_at!)}`;
}

export function describeRepeat(project: Project, repeat: CalendarRepeat, startsOn: string): string {
	const count = repeat.interval;
	const weekdays = repeat.weekdays ?? [isoWeekday(startsOn)];
	const days = weekdays.map((weekday) => weekdayOfIso(weekday)).join(", ");
	const everyWorkday = repeat.unit === "week" && count === 1 && weekdays.join() === WORK_WEEK.join();
	const rule = everyWorkday
		? t("calendar.repeat_weekdays")
		: repeat.unit === "day"
			? tn("calendar.every_days", count)
			: repeat.unit === "week"
				? `${tn("calendar.every_weeks", count)} | ${days}`
				: repeat.unit === "month"
					? `${tn("calendar.every_months", count)} | ${t("calendar.on_day", { day: Number(startsOn.slice(8)) })}`
					: tn("calendar.every_years", count);
	return repeat.until ? `${rule} | ${t("calendar.until", { date: formatDay(repeat.until, project) })}` : rule;
}

export function seriesStartsOn(entry: CalendarEntry): string {
	if (entry.series_starts_on) return entry.series_starts_on;
	if (entry.series_starts_at) return dateKey(new Date(entry.series_starts_at));
	return entry.occurrence;
}

export function formatLength(minutes: number): string {
	const hours = Math.floor(minutes / 60);
	const rest = Math.round(minutes % 60);
	if (hours === 0) return t("calendar.length_minutes", { minutes: rest });
	return rest === 0 ? t("calendar.length_hours", { hours }) : t("calendar.length_hours_minutes", { hours, minutes: rest });
}

export function bookedMinutes(entries: CalendarEntry[], account: string, from: number, to: number): number {
	const spans = entries
		.filter((entry) => !entry.all_day && (entry.kind === "meeting" || entry.kind === "event") && entry.accounts.includes(account))
		.map((entry) => [Math.max(entry.starts_at!, from), Math.min(entry.ends_at!, to)] as [number, number])
		.filter(([start, end]) => end > start)
		.sort((first, second) => first[0] - second[0]);
	let total = 0;
	let covered = -Infinity;
	for (const [start, end] of spans) {
		if (end <= covered) continue;
		total += end - Math.max(start, covered);
		covered = end;
	}
	return Math.round(total / MINUTE_MS);
}

export function statusOf(
	project: Project,
	person: CalendarPerson,
	today: CalendarEntry[],
	now: number
): { text: string; tone: "busy" | "away" | "free" | "off" } {
	if (person.call) return { text: person.call.title ? `${t("chat.presence_busy")} | ${person.call.title}` : t("chat.presence_busy"), tone: "busy" };
	const own = today.filter((entry) => entry.accounts.includes(person.account));
	const current = own.find((entry) => !entry.all_day && entry.starts_at! <= now && entry.ends_at! > now);
	if (current) return { text: t("calendar.status_until", { what: entryTitle(current), time: clock(project, current.ends_at!) }), tone: "busy" };
	const key = todayKey();
	const absence = own.find((entry) => entry.kind === "absence" && !entry.pending && coversDate(entry, key));
	if (absence) return { text: entryTitle(absence), tone: "off" };
	if (person.presence === "offline") return { text: t("chat.presence_offline"), tone: "off" };
	if (person.presence === "away" || person.presence === "dnd") return { text: t(`chat.presence_${person.presence}` as UiKey), tone: "away" };
	const next = own
		.filter((entry) => !entry.all_day && entry.starts_at! > now && entry.starts_at! < dayStart(shiftDate(key, 1)))
		.sort((first, second) => first.starts_at! - second.starts_at!)[0];
	return { text: next ? t("calendar.free_until", { time: clock(project, next.starts_at!) }) : t("calendar.free"), tone: "free" };
}
