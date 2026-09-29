import Database from "../database/database";
import { datesBetween } from "./holidays";
import { isIsoDate, workingDaysBetween, type HolidayCalendar } from "./calendar";
import { ABSENCE_KINDS } from "./absence-kinds";
import type { AbsenceKind, AbsenceRow } from "../database/models";

export interface AbsenceInput {
	kind: AbsenceKind;
	starts_on: string;
	ends_on: string;
	minutes_per_day: number | null;
	note: string | null;
}

export const PAID_ABSENCE_KINDS: AbsenceKind[] = ["vacation", "paid_leave", "sick", "injury"];
const MAX_ABSENCE_DAYS = 366;

export function readAbsence(data: Record<string, unknown>, previous?: AbsenceRow): AbsenceInput | null {
	const kind = data.kind ?? previous?.kind;
	const startsOn = data.starts_on ?? previous?.starts_on;
	const endsOn = data.ends_on ?? data.starts_on ?? previous?.ends_on;
	const minutes = data.minutes_per_day === undefined ? (previous?.minutes_per_day ?? null) : data.minutes_per_day;
	const note = data.note === undefined ? (previous?.note ?? null) : data.note;

	if (!ABSENCE_KINDS.includes(kind as AbsenceKind)) return null;
	if (!isIsoDate(startsOn) || !isIsoDate(endsOn) || endsOn < startsOn) return null;
	if (datesBetween(startsOn, endsOn).length > MAX_ABSENCE_DAYS) return null;
	if (minutes !== null && (typeof minutes !== "number" || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440)) return null;
	if (note !== null && (typeof note !== "string" || note.length > 2000)) return null;

	return {
		kind: kind as AbsenceKind,
		starts_on: startsOn,
		ends_on: endsOn,
		minutes_per_day: minutes,
		note: typeof note === "string" && note.trim() ? note.trim() : null,
	};
}

export async function overlapsAbsence(memberId: string, input: Pick<AbsenceInput, "starts_on" | "ends_on">, excluding: string | null): Promise<boolean> {
	const rows = (await Database`
		SELECT uuid FROM absences
		WHERE member = ${memberId} AND status IN ('pending', 'approved') AND starts_on <= ${input.ends_on} AND ends_on >= ${input.starts_on}
	`) as Pick<AbsenceRow, "uuid">[];
	return rows.some((row) => row.uuid !== excluding);
}

export function absenceWorkingDays(absence: Pick<AbsenceRow, "starts_on" | "ends_on">, calendar: HolidayCalendar, from?: string, to?: string): string[] {
	const start = from && from > absence.starts_on ? from : absence.starts_on;
	const end = to && to < absence.ends_on ? to : absence.ends_on;
	if (end < start) return [];
	return workingDaysBetween(start, end, calendar);
}

export function absenceDayFraction(absence: Pick<AbsenceRow, "minutes_per_day">, dailyMinutes: number): number {
	if (absence.minutes_per_day === null) return 1;
	return Math.min(1, absence.minutes_per_day / dailyMinutes);
}

export function presentAbsence(row: AbsenceRow, calendar: HolidayCalendar | null, dailyMinutes: number | null) {
	const days = calendar ? absenceWorkingDays(row, calendar) : null;
	return {
		uuid: row.uuid,
		member: row.member,
		person: row.person,
		kind: row.kind,
		starts_on: row.starts_on,
		ends_on: row.ends_on,
		minutes_per_day: row.minutes_per_day,
		working_days: days && dailyMinutes ? Math.round(days.length * absenceDayFraction(row, dailyMinutes) * 100) / 100 : null,
		status: row.status,
		note: row.note,
		decided_by: row.decided_by,
		decided_at: row.decided_at,
		decision_note: row.decision_note,
		created_by: row.created_by,
		created: row.created,
		updated: row.updated,
	};
}
