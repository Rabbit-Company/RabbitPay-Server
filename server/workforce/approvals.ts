import Database from "../database/database";
import type { TimesheetPeriodRow, TimesheetPeriodStatus } from "../database/models";

export interface TimesheetPeriod {
	member: string;
	period: string;
	status: TimesheetPeriodStatus;
	note: string | null;
	submitted_by: string | null;
	submitted_at: number | null;
	decided_by: string | null;
	decided_at: number | null;
	updated: number | null;
}

export function presentTimesheetPeriod(member: string, period: string, row?: TimesheetPeriodRow): TimesheetPeriod {
	return {
		member,
		period,
		status: row?.status ?? "draft",
		note: row?.note ?? null,
		submitted_by: row?.submitted_by ?? null,
		submitted_at: row?.submitted_at ?? null,
		decided_by: row?.decided_by ?? null,
		decided_at: row?.decided_at ?? null,
		updated: row?.updated ?? null,
	};
}

export async function timesheetPeriods(project: string, members: string[], periods: string[]): Promise<Map<string, TimesheetPeriod>> {
	const result = new Map<string, TimesheetPeriod>();
	if (members.length === 0 || periods.length === 0) return result;
	const rows = (await Database`
		SELECT * FROM timesheet_periods WHERE project = ${project} AND member IN ${Database(members)} AND period IN ${Database(periods)}
	`) as TimesheetPeriodRow[];
	const stored = new Map(rows.map((row) => [`${row.member}:${row.period}`, row]));
	for (const member of members) {
		for (const period of periods) result.set(`${member}:${period}`, presentTimesheetPeriod(member, period, stored.get(`${member}:${period}`)));
	}
	return result;
}

export async function timesheetPeriod(project: string, member: string, period: string): Promise<TimesheetPeriod> {
	return (await timesheetPeriods(project, [member], [period])).get(`${member}:${period}`)!;
}

export function locksTimesheet(status: TimesheetPeriodStatus): boolean {
	return status === "submitted" || status === "approved";
}

export async function timesheetPeriodLocked(project: string, member: string | null, date: string): Promise<boolean> {
	if (member === null) return false;
	const [row] = (await Database`
		SELECT status FROM timesheet_periods WHERE project = ${project} AND member = ${member} AND period = ${date.slice(0, 7)}
	`) as Pick<TimesheetPeriodRow, "status">[];
	return row ? locksTimesheet(row.status) : false;
}
