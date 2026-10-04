import type { SQL } from "bun";
import Database from "../database/database";
import { addDays } from "./holidays";
import { isIsoDate } from "./calendar";
import type { ConfigOf, WorkforceConfig } from "./config";
import type { TimeEntryActivity, TimeEntryKind, TimeEntryRow, WorkforceRevisionRow } from "../database/models";

export interface EntryInput {
	work_date: string;
	start_minute: number;
	end_minute: number;
	break_minutes: number;
	kind: TimeEntryKind;
	activity: TimeEntryActivity | null;
	remote: boolean;
	ticket: string | null;
	note: string | null;
}

export interface DaySegment {
	date: string;
	minutes: number;
	start: number;
	end: number;
}

const KINDS: TimeEntryKind[] = ["regular", "overtime", "break"];
export const TIME_ENTRY_ACTIVITIES: TimeEntryActivity[] = ["ticket", "internal", "administration", "training", "available", "waiting_home"];
export const MAX_NOTE_LENGTH = 2000;

export function parseClock(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
	if (!match) return null;
	return Number(match[1]) * 60 + Number(match[2]);
}

export function formatClock(minutes: number): string {
	const within = ((minutes % 1440) + 1440) % 1440;
	return `${String(Math.floor(within / 60)).padStart(2, "0")}:${String(within % 60).padStart(2, "0")}`;
}

function currentClock(entry: Pick<TimeEntryRow, "start_minute" | "end_minute">) {
	return { start: formatClock(entry.start_minute), end: formatClock(entry.end_minute) };
}

export function readEntry(data: Record<string, unknown>, previous?: TimeEntryRow): EntryInput | null {
	const clock = previous ? currentClock(previous) : { start: undefined, end: undefined };
	const workDate = data.work_date ?? previous?.work_date;
	const start = parseClock(data.start ?? clock.start);
	const endClock = parseClock(data.end ?? clock.end);
	const kind = data.kind ?? previous?.kind ?? "regular";
	const remote = data.remote ?? (previous ? Boolean(previous.remote) : false);
	const ticket = data.ticket === undefined ? (previous?.ticket ?? null) : data.ticket;
	const requestedActivity = data.activity === undefined ? previous?.activity : data.activity;
	const note = data.note === undefined ? (previous?.note ?? null) : data.note;

	if (!isIsoDate(workDate) || start === null || endClock === null) return null;
	const end = endClock <= start ? endClock + 1440 : endClock;
	const pause = kind === "break";
	const breakMinutes = pause ? 0 : (data.break_minutes ?? previous?.break_minutes ?? 0);
	if (typeof breakMinutes !== "number" || !Number.isSafeInteger(breakMinutes) || breakMinutes < 0 || breakMinutes >= end - start) return null;
	if (!KINDS.includes(kind as TimeEntryKind) || typeof remote !== "boolean") return null;
	if (ticket !== null && typeof ticket !== "string") return null;
	const activity = pause ? null : (requestedActivity ?? (ticket ? "ticket" : "internal"));
	if (activity !== null && !TIME_ENTRY_ACTIVITIES.includes(activity as TimeEntryActivity)) return null;
	if (!pause && (activity === "ticket") !== (ticket !== null)) return null;
	if (activity === "waiting_home" && (kind !== "regular" || !remote)) return null;
	if (note !== null && (typeof note !== "string" || note.length > MAX_NOTE_LENGTH)) return null;

	return {
		work_date: workDate,
		start_minute: start,
		end_minute: end,
		break_minutes: breakMinutes,
		kind: kind as TimeEntryKind,
		activity: activity as TimeEntryActivity | null,
		remote: pause ? false : remote,
		ticket: pause ? null : ticket,
		note: typeof note === "string" && note.trim() ? note.trim() : null,
	};
}

export function workedMinutes(
	entry: Pick<TimeEntryRow, "start_minute" | "end_minute" | "break_minutes">,
	config: Pick<WorkforceConfig, "paid_break_minutes">
): number {
	return entry.end_minute - entry.start_minute - Math.max(0, entry.break_minutes - config.paid_break_minutes);
}

export function paidBreaks(
	rows: Pick<TimeEntryRow, "uuid" | "member" | "work_date" | "start_minute" | "end_minute" | "kind">[],
	configOf: ConfigOf
): Map<string, number> {
	const left = new Map<string, number>();
	const paid = new Map<string, number>();
	for (const row of [...rows].sort((first, second) => first.start_minute - second.start_minute)) {
		if (row.kind !== "break") continue;
		const day = `${row.member}:${row.work_date}`;
		const available = left.get(day) ?? configOf(row.member).paid_break_minutes;
		const minutes = Math.min(available, row.end_minute - row.start_minute);
		paid.set(row.uuid, minutes);
		left.set(day, available - minutes);
	}
	return paid;
}

export function segmentsOf(entry: Pick<TimeEntryRow, "work_date" | "start_minute" | "end_minute">): DaySegment[] {
	const segments: DaySegment[] = [];
	const firstEnd = Math.min(entry.end_minute, 1440);
	segments.push({ date: entry.work_date, start: entry.start_minute, end: firstEnd, minutes: firstEnd - entry.start_minute });
	if (entry.end_minute > 1440) {
		segments.push({ date: addDays(entry.work_date, 1), start: 0, end: entry.end_minute - 1440, minutes: entry.end_minute - 1440 });
	}
	return segments;
}

function overlap(start: number, end: number, windowStart: number, windowEnd: number): number {
	return Math.max(0, Math.min(end, windowEnd) - Math.max(start, windowStart));
}

export function nightMinutesOf(segment: Pick<DaySegment, "start" | "end">, config: Pick<WorkforceConfig, "night_from" | "night_to">): number {
	if (config.night_from < config.night_to) return overlap(segment.start, segment.end, config.night_from, config.night_to);
	return overlap(segment.start, segment.end, 0, config.night_to) + overlap(segment.start, segment.end, config.night_from, 1440);
}

export function entryInterval(entry: Pick<TimeEntryRow, "work_date" | "start_minute" | "end_minute">, origin: string): [number, number] {
	const days = Math.round((Date.parse(`${entry.work_date}T00:00:00Z`) - Date.parse(`${origin}T00:00:00Z`)) / 86_400_000);
	return [days * 1440 + entry.start_minute, days * 1440 + entry.end_minute];
}

export async function overlapsExisting(memberId: string, entry: EntryInput, excluding: string | null): Promise<boolean> {
	const rows = (await Database`
		SELECT uuid, work_date, start_minute, end_minute FROM time_entries
		WHERE member = ${memberId} AND work_date >= ${addDays(entry.work_date, -1)} AND work_date <= ${addDays(entry.work_date, 1)}
	`) as Pick<TimeEntryRow, "uuid" | "work_date" | "start_minute" | "end_minute">[];
	const [start, end] = entryInterval(entry, entry.work_date);
	return rows.some((row) => {
		if (row.uuid === excluding) return false;
		const [otherStart, otherEnd] = entryInterval(row, entry.work_date);
		return start < otherEnd && otherStart < end;
	});
}

export function workdayEntries(date: string, start: number, breakStart: number | null, dailyMinutes: number, breakMinutes: number): EntryInput[] | null {
	const end = start + dailyMinutes;
	if (dailyMinutes <= 0 || dailyMinutes > 1440) return null;
	const shared = { work_date: date, break_minutes: 0, remote: false, ticket: null, note: null };
	if (breakStart === null || breakMinutes === 0) return [{ ...shared, activity: "internal", start_minute: start, end_minute: end, kind: "regular" }];
	const resume = breakStart + breakMinutes;
	if (breakStart <= start || resume >= end) return null;
	return [
		{ ...shared, activity: "internal", start_minute: start, end_minute: breakStart, kind: "regular" },
		{ ...shared, activity: null, start_minute: breakStart, end_minute: resume, kind: "break" },
		{ ...shared, activity: "internal", start_minute: resume, end_minute: end, kind: "regular" },
	];
}

export function anyOverlap(entries: Pick<TimeEntryRow, "work_date" | "start_minute" | "end_minute">[]): boolean {
	if (entries.length < 2) return false;
	const origin = entries[0].work_date;
	const intervals = entries.map((entry) => entryInterval(entry, origin)).sort((first, second) => first[0] - second[0]);
	return intervals.some(([start], index) => index > 0 && start < intervals[index - 1][1]);
}

export function withinEditWindow(date: string, today: string, editDays: number): boolean {
	return date <= today && date >= addDays(today, -editDays);
}

export function presentEntry(row: TimeEntryRow, config: WorkforceConfig, paid = paidBreaks([row], () => config)) {
	return {
		uuid: row.uuid,
		member: row.member,
		person: row.person,
		work_date: row.work_date,
		start: formatClock(row.start_minute),
		end: formatClock(row.end_minute),
		overnight: row.end_minute > 1440,
		break_minutes: row.break_minutes,
		worked_minutes: row.kind === "break" ? (paid.get(row.uuid) ?? 0) : workedMinutes(row, config),
		kind: row.kind,
		activity: row.activity,
		remote: Boolean(row.remote),
		ticket: row.ticket,
		note: row.note,
		invoice: row.invoice,
		created_by: row.created_by,
		updated_by: row.updated_by,
		created: row.created,
		updated: row.updated,
	};
}

export function presentEntries(rows: TimeEntryRow[], configOf: ConfigOf) {
	const paid = paidBreaks(rows, configOf);
	return rows.map((row) => presentEntry(row, configOf(row.member), paid));
}

export interface RevisionInput {
	project: string;
	member: string | null;
	recordType: WorkforceRevisionRow["record_type"];
	record: string;
	operation: WorkforceRevisionRow["operation"];
	oldValue?: unknown;
	newValue?: unknown;
	changedBy: string;
	reason?: string | null;
}

export async function recordRevision(sql: SQL, revision: RevisionInput) {
	await sql`
		INSERT INTO workforce_revisions(uuid, project, member, record_type, record, operation, old_value, new_value, changed_by, reason, created)
		VALUES(${crypto.randomUUID()}, ${revision.project}, ${revision.member}, ${revision.recordType}, ${revision.record}, ${revision.operation},
			${revision.oldValue === undefined ? null : JSON.stringify(revision.oldValue)},
			${revision.newValue === undefined ? null : JSON.stringify(revision.newValue)},
			${revision.changedBy}, ${revision.reason ?? null}, ${Date.now()})
	`;
}

export function presentRevision(row: WorkforceRevisionRow) {
	const parse = (value: string | null) => {
		if (value === null) return null;
		try {
			return JSON.parse(value);
		} catch {
			return null;
		}
	};
	return {
		uuid: row.uuid,
		member: row.member,
		record_type: row.record_type,
		record: row.record,
		operation: row.operation,
		old_value: parse(row.old_value),
		new_value: parse(row.new_value),
		changed_by: row.changed_by,
		reason: row.reason,
		created: row.created,
	};
}
