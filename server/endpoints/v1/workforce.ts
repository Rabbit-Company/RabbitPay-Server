import type { Context } from "@rabbit-company/web";
import { Server } from "../../server";
import Database, { dialect } from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { licensingEnforced, workforceActive } from "../../licensing";
import {
	configFor,
	memberConfig,
	memberConfigs,
	readWorkforceConfig,
	saveWorkforceConfig,
	workforceConfig,
	type WorkforceConfig,
} from "../../workforce/config";
import { holidayCalendar, isIsoDate, isMonth, isWorkingDay } from "../../workforce/calendar";
import { addDays, datesBetween, nationalHolidays } from "../../workforce/holidays";
import { dailyMinutesOf, employeeOf, listPeople, personName, type Person } from "../../workforce/people";
import { accessOf, requireWorkforce, subjectOf, todayIn } from "../../workforce/access";
import {
	anyOverlap,
	overlapsExisting,
	parseClock,
	paidBreaks,
	presentEntries,
	presentEntry,
	presentRevision,
	readEntry,
	recordRevision,
	withinEditWindow,
	workdayEntries,
	type EntryInput,
} from "../../workforce/timesheets";
import { overlapsAbsence, presentAbsence, readAbsence } from "../../workforce/absences";
import { monthReport, monthReportCsv, vacationBalance } from "../../workforce/reports";
import { notifyAbsenceDecided, notifyAbsenceRequested } from "../../workforce/notifications";
import { monthReportPdf } from "../../workforce/report-pdf";
import { pdfResponse } from "../../invoice-pdf";
import type {
	AbsenceRow,
	AppState,
	EmployeeRow,
	LeaveBalanceRow,
	ProjectMemberRow,
	TicketRow,
	TimeEntryRow,
	WorkforceHolidayRow,
	WorkforceRevisionRow,
} from "../../database/models";

const base = "/api/v1/projects/:uuid";
const MAX_RANGE_DAYS = 366;
const MAX_DAY_ENTRIES = 48;
const MAX_FILL_DAYS = 62;

async function body(ctx: Context<AppState>): Promise<Record<string, unknown> | null> {
	try {
		const value = await ctx.body<Record<string, unknown>>();
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

function readReason(value: unknown): string | null | undefined {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || value.length > 500) return undefined;
	return value.trim() || null;
}

function readRange(ctx: Context<AppState>): { from: string; to: string } | null {
	const query = ctx.query();
	const from = query.get("from");
	const to = query.get("to");
	if (!isIsoDate(from) || !isIsoDate(to) || to < from || datesBetween(from, to).length > MAX_RANGE_DAYS) return null;
	return { from, to };
}

async function audit(ctx: Context<AppState>, action: string, entityType: string, entityId: string, value?: unknown, previous?: unknown) {
	await Audit.record(ctx, { project: Permissions.project(ctx).uuid, action, entityType, entityId, newValue: value, oldValue: previous });
}

async function validTicket(projectId: string, ticket: string | null): Promise<boolean> {
	if (ticket === null) return true;
	const [row] = await Database`SELECT uuid FROM tickets WHERE uuid = ${ticket} AND project = ${projectId}`;
	return Boolean(row);
}

Server.app.get(`${base}/workforce`, Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const access = accessOf(ctx);
	const config = await workforceConfig(project.uuid);
	const employee = await employeeOf(access.self.uuid);
	const rules = configFor(config, employee);
	return Utils.ok(ctx, {
		license: { enforced: licensingEnforced(), active: workforceActive(project), until: project.workforce_until },
		config,
		today: todayIn(project),
		me: {
			member: access.self.uuid,
			name: personName(access.self),
			daily_minutes: dailyMinutesOf(employee, config),
			edit_days: rules.edit_days,
			paid_break_minutes: rules.paid_break_minutes,
			own: access.own,
			view: access.view,
			edit: access.edit,
		},
		people: access.view ? await listPeople(project.uuid, config) : [],
	});
});

Server.app.put(`${base}/workforce/settings`, Auth.required(), Permissions.require(Permission.TIMESHEET_EDIT), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const config = readWorkforceConfig(await body(ctx));
	if (!config) return Utils.fail(ctx, ErrorCode.INVALID_WORKFORCE_SETTINGS);
	const previous = await workforceConfig(project.uuid);
	await saveWorkforceConfig(project.uuid, config);
	await audit(ctx, "workforce.settings_updated", "project", project.uuid, config, previous);
	return Utils.ok(ctx, config);
});

Server.app.get(`${base}/workforce/holidays`, Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const year = Number(ctx.query().get("year") ?? todayIn(project).slice(0, 4));
	if (!Number.isSafeInteger(year) || year < 2000 || year > 2100) return Utils.fail(ctx, ErrorCode.INVALID_HOLIDAY);
	const custom = (await Database`
		SELECT * FROM workforce_holidays WHERE project = ${project.uuid} AND holiday_date >= ${`${year}-01-01`} AND holiday_date <= ${`${year}-12-31`}
	`) as WorkforceHolidayRow[];
	const holidays = [
		...nationalHolidays(project.tax_country, year).map((holiday) => ({ ...holiday, uuid: null, source: "national" as const })),
		...custom.map((holiday) => ({
			date: holiday.holiday_date,
			name: { en: holiday.name, sl: holiday.name },
			work_free: true,
			uuid: holiday.uuid,
			source: "project" as const,
		})),
	].sort((first, second) => first.date.localeCompare(second.date));
	return Utils.ok(ctx, { year, country: project.tax_country, holidays });
});

Server.app.post(`${base}/workforce/holidays`, Auth.required(), Permissions.require(Permission.TIMESHEET_EDIT), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const data = await body(ctx);
	const date = data?.date;
	const name = data?.name;
	if (!isIsoDate(date) || typeof name !== "string" || !name.trim() || name.length > 200) return Utils.fail(ctx, ErrorCode.INVALID_HOLIDAY);
	const [existing] = await Database`SELECT uuid FROM workforce_holidays WHERE project = ${project.uuid} AND holiday_date = ${date}`;
	if (existing) return Utils.fail(ctx, ErrorCode.HOLIDAY_EXISTS);
	const uuid = crypto.randomUUID();
	await Database`INSERT INTO workforce_holidays(uuid, project, holiday_date, name, created) VALUES(${uuid}, ${project.uuid}, ${date}, ${name.trim()}, ${Date.now()})`;
	await audit(ctx, "workforce.holiday_added", "workforce_holiday", uuid, { date, name: name.trim() });
	return Utils.ok(ctx, { uuid, date, name: name.trim() }, 201);
});

Server.app.delete(`${base}/workforce/holidays/:holiday`, Auth.required(), Permissions.require(Permission.TIMESHEET_EDIT), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const [holiday] = (await Database`
		SELECT * FROM workforce_holidays WHERE uuid = ${ctx.params.holiday} AND project = ${project.uuid}
	`) as WorkforceHolidayRow[];
	if (!holiday) return Utils.fail(ctx, ErrorCode.HOLIDAY_NOT_FOUND);
	await Database`DELETE FROM workforce_holidays WHERE uuid = ${holiday.uuid}`;
	await audit(ctx, "workforce.holiday_removed", "workforce_holiday", holiday.uuid, undefined, holiday);
	return Utils.ok(ctx);
});

Server.app.get(`${base}/workforce/people`, Auth.required(), Permissions.require(Permission.TIMESHEET_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	return Utils.ok(ctx, await listPeople(project.uuid, await workforceConfig(project.uuid)));
});

Server.app.get(`${base}/timesheets`, Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const range = readRange(ctx);
	if (!range) return Utils.fail(ctx, ErrorCode.INVALID_TIME_ENTRY);
	const requested = ctx.query().get("member");
	const access = accessOf(ctx);
	const everyone = requested === "all";
	if (everyone && !access.view) return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);
	const subject = everyone ? null : await subjectOf(ctx, requested, "view");
	if (typeof subject === "number") return Utils.fail(ctx, subject);

	const filter = subject ? Database`AND member = ${subject.uuid}` : Database``;
	const rows = (await Database`
		SELECT * FROM time_entries WHERE project = ${project.uuid} AND work_date >= ${range.from} AND work_date <= ${range.to} ${filter}
		ORDER BY work_date ASC, start_minute ASC
	`) as TimeEntryRow[];
	const ticketIds = [...new Set(rows.map((row) => row.ticket).filter((ticket): ticket is string => ticket !== null))];
	const tickets = ticketIds.length
		? ((await Database`SELECT uuid, number, title, status FROM tickets WHERE uuid IN ${Database(ticketIds)}`) as Pick<
				TicketRow,
				"uuid" | "number" | "title" | "status"
			>[])
		: [];
	const configOf = await memberConfigs(project.uuid, [subject?.uuid ?? null, ...rows.map((row) => row.member)]);
	return Utils.ok(ctx, {
		...range,
		member: subject?.uuid ?? null,
		today: todayIn(project),
		edit_days: configOf(subject?.uuid ?? null).edit_days,
		entries: presentEntries(rows, configOf),
		tickets,
	});
});

async function presentInDay(row: TimeEntryRow, config: WorkforceConfig) {
	const day = (await Database`SELECT * FROM time_entries WHERE member = ${row.member} AND work_date = ${row.work_date}`) as TimeEntryRow[];
	return presentEntry(
		row,
		config,
		paidBreaks(day.length ? day : [row], () => config)
	);
}

async function checkEntry(ctx: Context<AppState>, subject: ProjectMemberRow, input: EntryInput, previous: TimeEntryRow | null): Promise<ErrorCode | null> {
	const project = Permissions.project(ctx);
	const access = accessOf(ctx);
	if (!access.edit) {
		const config = await memberConfig(project.uuid, subject.uuid);
		const today = todayIn(project);
		if (!withinEditWindow(input.work_date, today, config.edit_days)) return ErrorCode.TIMESHEET_LOCKED;
		if (previous && !withinEditWindow(previous.work_date, today, config.edit_days)) return ErrorCode.TIMESHEET_LOCKED;
	}
	if (!(await validTicket(project.uuid, input.ticket))) return ErrorCode.TICKET_NOT_FOUND;
	if (await overlapsExisting(subject.uuid, input, previous?.uuid ?? null)) return ErrorCode.TIME_ENTRY_OVERLAPS;
	return null;
}

Server.app.post(`${base}/timesheets`, Auth.required(), Permissions.require(Permission.PROJECT_VIEW), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	const data = await body(ctx);
	if (!data) return Utils.fail(ctx, ErrorCode.INVALID_TIME_ENTRY);
	const subject = await subjectOf(ctx, data.member, "edit");
	if (typeof subject === "number") return Utils.fail(ctx, subject);
	const input = readEntry(data);
	if (!input) return Utils.fail(ctx, ErrorCode.INVALID_TIME_ENTRY);
	const problem = await checkEntry(ctx, subject, input, null);
	if (problem !== null) return Utils.fail(ctx, problem);
	const reason = readReason(data.reason);
	if (reason === undefined) return Utils.fail(ctx, ErrorCode.INVALID_TIME_ENTRY);

	const uuid = crypto.randomUUID();
	const now = Date.now();
	await Database.begin(async (tx) => {
		await tx`
			INSERT INTO time_entries(uuid, project, member, person, work_date, start_minute, end_minute, break_minutes, kind, remote, ticket, note,
				created_by, updated_by, created, updated)
			VALUES(${uuid}, ${project.uuid}, ${subject.uuid}, ${personName(subject)}, ${input.work_date}, ${input.start_minute}, ${input.end_minute},
				${input.break_minutes}, ${input.kind}, ${input.remote ? 1 : 0}, ${input.ticket}, ${input.note}, ${account.username}, ${account.username}, ${now}, ${now})
		`;
		await recordRevision(tx, {
			project: project.uuid,
			member: subject.uuid,
			recordType: "time_entry",
			record: uuid,
			operation: "created",
			newValue: input,
			changedBy: account.username,
			reason,
		});
	});
	const [row] = (await Database`SELECT * FROM time_entries WHERE uuid = ${uuid}`) as TimeEntryRow[];
	const presented = await presentInDay(row, await memberConfig(project.uuid, subject.uuid));
	await audit(ctx, "time_entry.created", "time_entry", uuid, presented);
	return Utils.ok(ctx, presented, 201);
});

async function editableEntry(ctx: Context<AppState>): Promise<TimeEntryRow | ErrorCode> {
	const project = Permissions.project(ctx);
	const access = accessOf(ctx);
	const [row] = (await Database`SELECT * FROM time_entries WHERE uuid = ${ctx.params.entry} AND project = ${project.uuid}`) as TimeEntryRow[];
	if (!row) return ErrorCode.TIME_ENTRY_NOT_FOUND;
	if (row.member === access.self.uuid ? !access.own && !access.edit : !access.edit) {
		return access.view || row.member === access.self.uuid ? ErrorCode.INSUFFICIENT_PERMISSIONS : ErrorCode.TIME_ENTRY_NOT_FOUND;
	}
	if (row.invoice !== null) return ErrorCode.TIME_ENTRY_INVOICED;
	return row;
}

Server.app.patch(`${base}/timesheets/:entry`, Auth.required(), Permissions.require(Permission.PROJECT_VIEW), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	const row = await editableEntry(ctx);
	if (typeof row === "number") return Utils.fail(ctx, row);
	const data = await body(ctx);
	if (!data) return Utils.fail(ctx, ErrorCode.INVALID_TIME_ENTRY);
	const input = readEntry(data, row);
	const reason = readReason(data.reason);
	if (!input || reason === undefined) return Utils.fail(ctx, ErrorCode.INVALID_TIME_ENTRY);
	const [subject] = row.member ? ((await Database`SELECT * FROM project_members WHERE uuid = ${row.member}`) as ProjectMemberRow[]) : [];
	if (subject) {
		const problem = await checkEntry(ctx, subject, input, row);
		if (problem !== null) return Utils.fail(ctx, problem);
	} else if (!(await validTicket(project.uuid, input.ticket))) return Utils.fail(ctx, ErrorCode.TICKET_NOT_FOUND);

	const config = await memberConfig(project.uuid, row.member);
	const before = presentEntry(row, config);
	await Database.begin(async (tx) => {
		await tx`
			UPDATE time_entries SET work_date = ${input.work_date}, start_minute = ${input.start_minute}, end_minute = ${input.end_minute},
				break_minutes = ${input.break_minutes}, kind = ${input.kind}, remote = ${input.remote ? 1 : 0}, ticket = ${input.ticket}, note = ${input.note},
				updated_by = ${account.username}, updated = ${Date.now()}
			WHERE uuid = ${row.uuid}
		`;
		await recordRevision(tx, {
			project: project.uuid,
			member: row.member,
			recordType: "time_entry",
			record: row.uuid,
			operation: "updated",
			oldValue: before,
			newValue: input,
			changedBy: account.username,
			reason,
		});
	});
	const [updated] = (await Database`SELECT * FROM time_entries WHERE uuid = ${row.uuid}`) as TimeEntryRow[];
	const presented = await presentInDay(updated, config);
	await audit(ctx, "time_entry.updated", "time_entry", row.uuid, presented, before);
	return Utils.ok(ctx, presented);
});

Server.app.delete(`${base}/timesheets/:entry`, Auth.required(), Permissions.require(Permission.PROJECT_VIEW), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	const row = await editableEntry(ctx);
	if (typeof row === "number") return Utils.fail(ctx, row);
	const access = accessOf(ctx);
	const config = await memberConfig(project.uuid, row.member);
	if (!access.edit && !withinEditWindow(row.work_date, todayIn(project), config.edit_days)) return Utils.fail(ctx, ErrorCode.TIMESHEET_LOCKED);
	const reason = readReason(ctx.query().get("reason") ?? undefined);
	if (reason === undefined) return Utils.fail(ctx, ErrorCode.INVALID_TIME_ENTRY);

	const before = presentEntry(row, config);
	await Database.begin(async (tx) => {
		await tx`DELETE FROM time_entries WHERE uuid = ${row.uuid}`;
		await recordRevision(tx, {
			project: project.uuid,
			member: row.member,
			recordType: "time_entry",
			record: row.uuid,
			operation: "deleted",
			oldValue: before,
			changedBy: account.username,
			reason,
		});
	});
	await audit(ctx, "time_entry.deleted", "time_entry", row.uuid, undefined, before);
	return Utils.ok(ctx);
});

function sameEntry(row: TimeEntryRow, input: EntryInput): boolean {
	return (
		row.start_minute === input.start_minute &&
		row.end_minute === input.end_minute &&
		row.break_minutes === input.break_minutes &&
		row.kind === input.kind &&
		Boolean(row.remote) === input.remote &&
		row.ticket === input.ticket &&
		row.note === input.note
	);
}

interface PlannedEntry {
	row: TimeEntryRow | null;
	input: EntryInput;
}

Server.app.put(`${base}/timesheets/day`, Auth.required(), Permissions.require(Permission.PROJECT_VIEW), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	const access = accessOf(ctx);
	const data = await body(ctx);
	const date = data?.work_date;
	if (!data || !isIsoDate(date) || !Array.isArray(data.entries) || data.entries.length > MAX_DAY_ENTRIES) {
		return Utils.fail(ctx, ErrorCode.INVALID_TIME_ENTRY);
	}
	const subject = await subjectOf(ctx, data.member, "edit");
	if (typeof subject === "number") return Utils.fail(ctx, subject);
	const config = await memberConfig(project.uuid, subject.uuid);
	if (!access.edit && !withinEditWindow(date, todayIn(project), config.edit_days)) return Utils.fail(ctx, ErrorCode.TIMESHEET_LOCKED);
	const reason = readReason(data.reason);
	if (reason === undefined) return Utils.fail(ctx, ErrorCode.INVALID_TIME_ENTRY);

	const nearby = (await Database`
		SELECT * FROM time_entries WHERE member = ${subject.uuid} AND work_date >= ${addDays(date, -1)} AND work_date <= ${addDays(date, 1)}
	`) as TimeEntryRow[];
	const existing = new Map(nearby.filter((row) => row.work_date === date).map((row) => [row.uuid, row]));
	const planned: PlannedEntry[] = [];
	const kept = new Set<string>();
	for (const item of data.entries) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return Utils.fail(ctx, ErrorCode.INVALID_TIME_ENTRY);
		const fields = item as Record<string, unknown>;
		let row: TimeEntryRow | null = null;
		if (fields.uuid !== undefined && fields.uuid !== null) {
			if (typeof fields.uuid !== "string" || kept.has(fields.uuid)) return Utils.fail(ctx, ErrorCode.INVALID_TIME_ENTRY);
			row = existing.get(fields.uuid) ?? null;
			if (!row) return Utils.fail(ctx, ErrorCode.TIME_ENTRY_NOT_FOUND);
			if (row.invoice !== null) return Utils.fail(ctx, ErrorCode.TIME_ENTRY_INVOICED);
			kept.add(row.uuid);
		}
		const input = readEntry({ ...fields, work_date: date }, row ?? undefined);
		if (!input) return Utils.fail(ctx, ErrorCode.INVALID_TIME_ENTRY);
		if (!(await validTicket(project.uuid, input.ticket))) return Utils.fail(ctx, ErrorCode.TICKET_NOT_FOUND);
		planned.push({ row, input });
	}
	const removed = [...existing.values()].filter((row) => row.invoice === null && !kept.has(row.uuid));
	const untouched = nearby.filter((row) => row.work_date !== date || row.invoice !== null);
	if (anyOverlap([...untouched, ...planned.map((entry) => entry.input)])) return Utils.fail(ctx, ErrorCode.TIME_ENTRY_OVERLAPS);

	const created: string[] = [];
	const updated: TimeEntryRow[] = [];
	const now = Date.now();
	await Database.begin(async (tx) => {
		for (const row of removed) {
			await tx`DELETE FROM time_entries WHERE uuid = ${row.uuid}`;
			await recordRevision(tx, {
				project: project.uuid,
				member: subject.uuid,
				recordType: "time_entry",
				record: row.uuid,
				operation: "deleted",
				oldValue: presentEntry(row, config),
				changedBy: account.username,
				reason,
			});
		}
		for (const { row, input } of planned) {
			if (row && sameEntry(row, input)) continue;
			if (row) {
				await tx`
					UPDATE time_entries SET start_minute = ${input.start_minute}, end_minute = ${input.end_minute}, break_minutes = ${input.break_minutes},
						kind = ${input.kind}, remote = ${input.remote ? 1 : 0}, ticket = ${input.ticket}, note = ${input.note}, updated_by = ${account.username},
						updated = ${now}
					WHERE uuid = ${row.uuid}
				`;
				updated.push(row);
			} else {
				const uuid = crypto.randomUUID();
				await tx`
					INSERT INTO time_entries(uuid, project, member, person, work_date, start_minute, end_minute, break_minutes, kind, remote, ticket, note,
						created_by, updated_by, created, updated)
					VALUES(${uuid}, ${project.uuid}, ${subject.uuid}, ${personName(subject)}, ${date}, ${input.start_minute}, ${input.end_minute},
						${input.break_minutes}, ${input.kind}, ${input.remote ? 1 : 0}, ${input.ticket}, ${input.note}, ${account.username}, ${account.username}, ${now}, ${now})
				`;
				created.push(uuid);
			}
			await recordRevision(tx, {
				project: project.uuid,
				member: subject.uuid,
				recordType: "time_entry",
				record: row?.uuid ?? created[created.length - 1],
				operation: row ? "updated" : "created",
				oldValue: row ? presentEntry(row, config) : undefined,
				newValue: input,
				changedBy: account.username,
				reason,
			});
		}
	});

	const rows = (await Database`
		SELECT * FROM time_entries WHERE member = ${subject.uuid} AND work_date = ${date} ORDER BY start_minute ASC
	`) as TimeEntryRow[];
	const entries = presentEntries(rows, () => config);
	const presented = new Map(entries.map((entry) => [entry.uuid, entry]));
	for (const row of removed) await audit(ctx, "time_entry.deleted", "time_entry", row.uuid, undefined, presentEntry(row, config));
	for (const row of updated) await audit(ctx, "time_entry.updated", "time_entry", row.uuid, presented.get(row.uuid), presentEntry(row, config));
	for (const uuid of created) await audit(ctx, "time_entry.created", "time_entry", uuid, presented.get(uuid));
	return Utils.ok(ctx, { work_date: date, member: subject.uuid, entries });
});

Server.app.post(`${base}/timesheets/fill`, Auth.required(), Permissions.require(Permission.TIMESHEET_EDIT), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	const data = await body(ctx);
	const from = data?.from;
	const to = data?.to;
	const start = parseClock(data?.start);
	const withBreak = data?.break_start !== undefined && data?.break_start !== null && data?.break_start !== "";
	const breakStart = withBreak ? parseClock(data?.break_start) : null;
	if (!data || !isIsoDate(from) || !isIsoDate(to) || to < from || datesBetween(from, to).length > MAX_FILL_DAYS || start === null) {
		return Utils.fail(ctx, ErrorCode.INVALID_TIME_ENTRY);
	}
	if (withBreak && breakStart === null) return Utils.fail(ctx, ErrorCode.INVALID_TIME_ENTRY);
	const reason = readReason(data.reason);
	if (reason === undefined) return Utils.fail(ctx, ErrorCode.INVALID_TIME_ENTRY);
	const subject = await subjectOf(ctx, data.member, "edit");
	if (typeof subject === "number") return Utils.fail(ctx, subject);

	const employee = await employeeOf(subject.uuid);
	const config = configFor(await workforceConfig(project.uuid), employee);
	const daily = dailyMinutesOf(employee, config);
	if (!workdayEntries(from, start, breakStart, daily, config.paid_break_minutes)) return Utils.fail(ctx, ErrorCode.INVALID_TIME_ENTRY);

	const calendar = await holidayCalendar(project, from, to);
	const absences = (await Database`
		SELECT starts_on, ends_on FROM absences
		WHERE member = ${subject.uuid} AND status IN ('approved', 'pending') AND starts_on <= ${to} AND ends_on >= ${from}
	`) as Pick<AbsenceRow, "starts_on" | "ends_on">[];
	const nearby = (await Database`
		SELECT * FROM time_entries WHERE member = ${subject.uuid} AND work_date >= ${addDays(from, -1)} AND work_date <= ${addDays(to, 1)}
	`) as TimeEntryRow[];
	const logged = new Set(nearby.map((row) => row.work_date));
	const skipped = { absent: 0, logged: 0, not_employed: 0 };
	const planned: EntryInput[][] = [];
	for (const date of datesBetween(from, to)) {
		if (!isWorkingDay(date, calendar)) continue;
		if ((employee?.started_on && date < employee.started_on) || (employee?.ended_on && date > employee.ended_on)) {
			skipped.not_employed += 1;
			continue;
		}
		if (absences.some((absence) => absence.starts_on <= date && absence.ends_on >= date)) {
			skipped.absent += 1;
			continue;
		}
		const entries = workdayEntries(date, start, breakStart, daily, config.paid_break_minutes)!;
		const neighbours = nearby.filter((row) => row.work_date === addDays(date, -1) || row.work_date === addDays(date, 1));
		if (logged.has(date) || anyOverlap([...neighbours, ...entries])) {
			skipped.logged += 1;
			continue;
		}
		planned.push(entries);
	}

	const now = Date.now();
	await Database.begin(async (tx) => {
		for (const entry of planned.flat()) {
			const uuid = crypto.randomUUID();
			await tx`
				INSERT INTO time_entries(uuid, project, member, person, work_date, start_minute, end_minute, break_minutes, kind, remote, ticket, note,
					created_by, updated_by, created, updated)
				VALUES(${uuid}, ${project.uuid}, ${subject.uuid}, ${personName(subject)}, ${entry.work_date}, ${entry.start_minute}, ${entry.end_minute}, 0,
					${entry.kind}, 0, NULL, NULL, ${account.username}, ${account.username}, ${now}, ${now})
			`;
			await recordRevision(tx, {
				project: project.uuid,
				member: subject.uuid,
				recordType: "time_entry",
				record: uuid,
				operation: "created",
				newValue: entry,
				changedBy: account.username,
				reason,
			});
		}
	});
	const days = planned.map((entries) => entries[0].work_date);
	await audit(ctx, "time_entry.filled", "project_member", subject.uuid, { from, to, days, reason });
	return Utils.ok(ctx, { filled: days.length, days, skipped });
});

Server.app.get(`${base}/workforce/revisions`, Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();
	const limit = Number(query.get("limit") ?? 50);
	const offset = Number(query.get("offset") ?? 0);
	const record = query.get("record");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0)
		return Utils.fail(ctx, ErrorCode.INVALID_TIME_ENTRY);
	const subject = await subjectOf(ctx, query.get("member"), "view");
	if (typeof subject === "number") return Utils.fail(ctx, subject);

	const recordFilter = record ? Database`AND record = ${record}` : Database``;
	const rows = (await Database`
		SELECT * FROM workforce_revisions WHERE project = ${project.uuid} AND member = ${subject.uuid} ${recordFilter}
		ORDER BY created DESC, uuid ASC LIMIT ${limit} OFFSET ${offset}
	`) as WorkforceRevisionRow[];
	const [total] = (await Database`
		SELECT COUNT(*) AS count FROM workforce_revisions WHERE project = ${project.uuid} AND member = ${subject.uuid} ${recordFilter}
	`) as { count: number }[];
	return Utils.ok(ctx, { revisions: rows.map(presentRevision), total: Number(total.count), limit, offset });
});

async function absenceContext(projectId: string, row: AbsenceRow) {
	const config = await workforceConfig(projectId);
	const [project] = (await Database`SELECT uuid, tax_country FROM projects WHERE uuid = ${projectId}`) as { uuid: string; tax_country: string | null }[];
	const calendar = await holidayCalendar(project, row.starts_on, row.ends_on);
	const employee = row.member ? await employeeOf(row.member) : null;
	return presentAbsence(row, calendar, dailyMinutesOf(employee, config));
}

Server.app.get(`${base}/absences`, Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const range = readRange(ctx);
	if (!range) return Utils.fail(ctx, ErrorCode.INVALID_ABSENCE);
	const query = ctx.query();
	const status = query.get("status");
	if (status !== null && !["pending", "approved", "rejected", "canceled"].includes(status)) return Utils.fail(ctx, ErrorCode.INVALID_ABSENCE);
	const access = accessOf(ctx);
	const requested = query.get("member");
	const everyone = requested === "all";
	if (everyone && !access.view) return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);
	const subject = everyone ? null : await subjectOf(ctx, requested, "view");
	if (typeof subject === "number") return Utils.fail(ctx, subject);

	const memberFilter = subject ? Database`AND member = ${subject.uuid}` : Database``;
	const statusFilter = status ? Database`AND status = ${status}` : Database``;
	const rows = (await Database`
		SELECT * FROM absences WHERE project = ${project.uuid} AND starts_on <= ${range.to} AND ends_on >= ${range.from} ${memberFilter} ${statusFilter}
		ORDER BY starts_on ASC, created ASC
	`) as AbsenceRow[];
	const config = await workforceConfig(project.uuid);
	const earliest = rows.reduce((first, row) => (row.starts_on < first ? row.starts_on : first), range.from);
	const latest = rows.reduce((last, row) => (row.ends_on > last ? row.ends_on : last), range.to);
	const calendar = await holidayCalendar(project, earliest, latest);
	const employees = new Map<string, number>();
	for (const row of rows) {
		if (row.member && !employees.has(row.member)) employees.set(row.member, dailyMinutesOf(await employeeOf(row.member), config));
	}
	return Utils.ok(
		ctx,
		rows.map((row) => presentAbsence(row, calendar, row.member ? (employees.get(row.member) ?? config.daily_minutes) : config.daily_minutes))
	);
});

Server.app.post(`${base}/absences`, Auth.required(), Permissions.require(Permission.PROJECT_VIEW), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	const data = await body(ctx);
	if (!data) return Utils.fail(ctx, ErrorCode.INVALID_ABSENCE);
	const subject = await subjectOf(ctx, data.member, "edit");
	if (typeof subject === "number") return Utils.fail(ctx, subject);
	const input = readAbsence(data);
	if (!input) return Utils.fail(ctx, ErrorCode.INVALID_ABSENCE);
	if (await overlapsAbsence(subject.uuid, input, null)) return Utils.fail(ctx, ErrorCode.ABSENCE_OVERLAPS);

	const approved = accessOf(ctx).edit;
	const uuid = crypto.randomUUID();
	const now = Date.now();
	await Database.begin(async (tx) => {
		await tx`
			INSERT INTO absences(uuid, project, member, person, kind, starts_on, ends_on, minutes_per_day, status, note, decided_by, decided_at,
				created_by, created, updated)
			VALUES(${uuid}, ${project.uuid}, ${subject.uuid}, ${personName(subject)}, ${input.kind}, ${input.starts_on}, ${input.ends_on},
				${input.minutes_per_day}, ${approved ? "approved" : "pending"}, ${input.note}, ${approved ? account.username : null},
				${approved ? now : null}, ${account.username}, ${now}, ${now})
		`;
		await recordRevision(tx, {
			project: project.uuid,
			member: subject.uuid,
			recordType: "absence",
			record: uuid,
			operation: approved ? "approved" : "created",
			newValue: input,
			changedBy: account.username,
		});
	});
	const [row] = (await Database`SELECT * FROM absences WHERE uuid = ${uuid}`) as AbsenceRow[];
	const presented = await absenceContext(project.uuid, row);
	await audit(ctx, "absence.created", "absence", uuid, presented);
	if (approved) await notifyAbsenceDecided(row, accessOf(ctx).self);
	else await notifyAbsenceRequested(row, presented.working_days);
	return Utils.ok(ctx, presented, 201);
});

async function findAbsence(ctx: Context<AppState>): Promise<AbsenceRow | ErrorCode> {
	const access = accessOf(ctx);
	const [row] = (await Database`SELECT * FROM absences WHERE uuid = ${ctx.params.absence} AND project = ${Permissions.project(ctx).uuid}`) as AbsenceRow[];
	if (!row) return ErrorCode.ABSENCE_NOT_FOUND;
	if (row.member !== access.self.uuid && !access.view && !access.edit) return ErrorCode.ABSENCE_NOT_FOUND;
	return row;
}

Server.app.patch(`${base}/absences/:absence`, Auth.required(), Permissions.require(Permission.PROJECT_VIEW), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	const access = accessOf(ctx);
	const row = await findAbsence(ctx);
	if (typeof row === "number") return Utils.fail(ctx, row);
	if (!access.edit && (row.member !== access.self.uuid || !access.own)) return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);
	if (row.status === "rejected" || row.status === "canceled" || (!access.edit && row.status !== "pending")) {
		return Utils.fail(ctx, ErrorCode.ABSENCE_ALREADY_DECIDED);
	}
	const data = await body(ctx);
	const input = data ? readAbsence(data, row) : null;
	if (!input) return Utils.fail(ctx, ErrorCode.INVALID_ABSENCE);
	if (row.member && (await overlapsAbsence(row.member, input, row.uuid))) return Utils.fail(ctx, ErrorCode.ABSENCE_OVERLAPS);

	await Database.begin(async (tx) => {
		await tx`
			UPDATE absences SET kind = ${input.kind}, starts_on = ${input.starts_on}, ends_on = ${input.ends_on}, minutes_per_day = ${input.minutes_per_day},
				note = ${input.note}, updated = ${Date.now()}
			WHERE uuid = ${row.uuid}
		`;
		await recordRevision(tx, {
			project: project.uuid,
			member: row.member,
			recordType: "absence",
			record: row.uuid,
			operation: "updated",
			oldValue: row,
			newValue: input,
			changedBy: account.username,
		});
	});
	const [updated] = (await Database`SELECT * FROM absences WHERE uuid = ${row.uuid}`) as AbsenceRow[];
	const presented = await absenceContext(project.uuid, updated);
	await audit(ctx, "absence.updated", "absence", row.uuid, presented, row);
	return Utils.ok(ctx, presented);
});

Server.app.post(`${base}/absences/:absence/decision`, Auth.required(), Permissions.require(Permission.TIMESHEET_EDIT), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	const row = await findAbsence(ctx);
	if (typeof row === "number") return Utils.fail(ctx, row);
	const data = await body(ctx);
	const status = data?.status;
	const note = readReason(data?.note);
	if ((status !== "approved" && status !== "rejected") || note === undefined) return Utils.fail(ctx, ErrorCode.INVALID_ABSENCE);
	const now = Date.now();
	const decided = await Database.begin(async (tx) => {
		const changed = await tx`
			UPDATE absences SET status = ${status}, decided_by = ${account.username}, decided_at = ${now}, decision_note = ${note}, updated = ${now}
			WHERE uuid = ${row.uuid} AND status = 'pending'
		`;
		if (changed.count === 0) return false;
		await recordRevision(tx, {
			project: project.uuid,
			member: row.member,
			recordType: "absence",
			record: row.uuid,
			operation: status,
			oldValue: { status: row.status },
			newValue: { status },
			changedBy: account.username,
			reason: note,
		});
		return true;
	});
	if (!decided) return Utils.fail(ctx, ErrorCode.ABSENCE_ALREADY_DECIDED);
	const [updated] = (await Database`SELECT * FROM absences WHERE uuid = ${row.uuid}`) as AbsenceRow[];
	const presented = await absenceContext(project.uuid, updated);
	await audit(ctx, `absence.${status}`, "absence", row.uuid, presented, row);
	await notifyAbsenceDecided(updated, accessOf(ctx).self);
	return Utils.ok(ctx, presented);
});

Server.app.post(`${base}/absences/:absence/cancel`, Auth.required(), Permissions.require(Permission.PROJECT_VIEW), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	const access = accessOf(ctx);
	const row = await findAbsence(ctx);
	if (typeof row === "number") return Utils.fail(ctx, row);
	const own = row.member === access.self.uuid && access.own;
	if (!access.edit && !(own && row.status === "pending")) {
		return Utils.fail(ctx, own ? ErrorCode.ABSENCE_ALREADY_DECIDED : ErrorCode.INSUFFICIENT_PERMISSIONS);
	}
	if (row.status !== "pending" && row.status !== "approved") return Utils.fail(ctx, ErrorCode.ABSENCE_ALREADY_DECIDED);
	const now = Date.now();
	await Database.begin(async (tx) => {
		await tx`UPDATE absences SET status = 'canceled', updated = ${now} WHERE uuid = ${row.uuid}`;
		await recordRevision(tx, {
			project: project.uuid,
			member: row.member,
			recordType: "absence",
			record: row.uuid,
			operation: "canceled",
			oldValue: { status: row.status },
			newValue: { status: "canceled" },
			changedBy: account.username,
		});
	});
	await audit(ctx, "absence.canceled", "absence", row.uuid, { status: "canceled" }, row);
	return Utils.ok(ctx);
});

Server.app.get(`${base}/workforce/balance`, Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();
	const today = todayIn(project);
	const year = Number(query.get("year") ?? today.slice(0, 4));
	if (!Number.isSafeInteger(year) || year < 2000 || year > 2100) return Utils.fail(ctx, ErrorCode.INVALID_LEAVE_BALANCE);
	const subject = await subjectOf(ctx, query.get("member"), "view");
	if (typeof subject === "number") return Utils.fail(ctx, subject);
	const config = await workforceConfig(project.uuid);
	const daily = dailyMinutesOf(await employeeOf(subject.uuid), config);
	return Utils.ok(ctx, { member: subject.uuid, ...(await vacationBalance(project, subject.uuid, year, daily, today)) });
});

function halfDays(value: unknown, allowNull: boolean): value is number | null {
	if (value === null) return allowNull;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 366 && (value * 2) % 1 === 0;
}

Server.app.put(`${base}/workforce/balance`, Auth.required(), Permissions.require(Permission.TIMESHEET_EDIT), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const data = await body(ctx);
	const year = data?.year;
	if (!data || typeof year !== "number" || !Number.isSafeInteger(year) || year < 2000 || year > 2100) return Utils.fail(ctx, ErrorCode.INVALID_LEAVE_BALANCE);
	if (!halfDays(data.entitled_days ?? null, true) || !halfDays(data.carried_days ?? 0, false)) return Utils.fail(ctx, ErrorCode.INVALID_LEAVE_BALANCE);
	const subject = await subjectOf(ctx, data.member, "edit");
	if (typeof subject === "number") return Utils.fail(ctx, subject);
	const entitled = (data.entitled_days ?? null) as number | null;
	const carried = (data.carried_days ?? 0) as number;
	const now = Date.now();
	const [previous] = (await Database`SELECT * FROM leave_balances WHERE member = ${subject.uuid} AND year = ${year}`) as LeaveBalanceRow[];
	if (dialect === "mysql") {
		await Database`INSERT INTO leave_balances(member, year, entitled_days, carried_days, updated) VALUES(${subject.uuid}, ${year}, ${entitled}, ${carried}, ${now})
			ON DUPLICATE KEY UPDATE entitled_days = ${entitled}, carried_days = ${carried}, updated = ${now}`;
	} else {
		await Database`INSERT INTO leave_balances(member, year, entitled_days, carried_days, updated) VALUES(${subject.uuid}, ${year}, ${entitled}, ${carried}, ${now})
			ON CONFLICT(member, year) DO UPDATE SET entitled_days = ${entitled}, carried_days = ${carried}, updated = ${now}`;
	}
	await audit(ctx, "leave_balance.updated", "project_member", subject.uuid, { year, entitled_days: entitled, carried_days: carried }, previous);
	const config = await workforceConfig(project.uuid);
	const daily = dailyMinutesOf(await employeeOf(subject.uuid), config);
	return Utils.ok(ctx, { member: subject.uuid, ...(await vacationBalance(project, subject.uuid, year, daily, todayIn(project))) });
});

async function reportPeople(ctx: Context<AppState>, requested: string | null): Promise<Person[] | ErrorCode> {
	const project = Permissions.project(ctx);
	const access = accessOf(ctx);
	const config = await workforceConfig(project.uuid);
	const people = await listPeople(project.uuid, config);
	if (requested === "all") return access.view ? people : ErrorCode.INSUFFICIENT_PERMISSIONS;
	const subject = await subjectOf(ctx, requested, "view");
	if (typeof subject === "number") return subject;
	const listed = people.find((person) => person.member === subject.uuid);
	if (listed) return [listed];
	const employee = await employeeOf(subject.uuid);
	const rules = configFor(config, employee);
	return [
		{
			member: subject.uuid,
			name: personName(subject),
			username: subject.account_username,
			role: subject.role,
			status: subject.status,
			daily_minutes: dailyMinutesOf(employee, config),
			edit_days: rules.edit_days,
			paid_break_minutes: rules.paid_break_minutes,
			employee: null,
		},
	];
}

Server.app.get(`${base}/timesheets/report`, Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();
	const month = query.get("month");
	if (!isMonth(month)) return Utils.fail(ctx, ErrorCode.INVALID_TIME_ENTRY);
	const people = await reportPeople(ctx, query.get("member"));
	if (typeof people === "number") return Utils.fail(ctx, people);
	const report = await monthReport(project, await workforceConfig(project.uuid), month, people);

	if (query.get("format") === "pdf") {
		const members = report.people.map((person) => person.member);
		const employees = members.length ? ((await Database`SELECT * FROM employees WHERE member IN ${Database(members)}`) as EmployeeRow[]) : [];
		return pdfResponse({ name: `timesheet-${month}.pdf`, data: await monthReportPdf(project, report, employees) });
	}
	if (query.get("format") === "csv") {
		return new Response(monthReportCsv(report), {
			headers: {
				"Content-Type": "text/csv; charset=utf-8",
				"Content-Disposition": `attachment; filename="timesheet-${month}.csv"`,
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	}
	return Utils.ok(ctx, report);
});
