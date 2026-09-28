import Database from "../database/database";
import { addDays, datesBetween, weekdayOf } from "./holidays";
import { holidayCalendar, isPaidHoliday, isWorkingDay, monthRange, workingDaysBetween, type HolidayCalendar } from "./calendar";
import { absenceDayFraction, absenceWorkingDays, ABSENCE_KINDS } from "./absences";
import { formatClock, nightMinutesOf, paidBreaks, segmentsOf, workedMinutes } from "./timesheets";
import { configFor, type WorkforceConfig } from "./config";
import type { Person } from "./people";
import type { AbsenceKind, AbsenceRow, EmployeeRow, LeaveBalanceRow, ProjectRow, TimeEntryRow } from "../database/models";

export interface DayAbsence {
	uuid: string;
	kind: AbsenceKind;
	status: AbsenceRow["status"];
	minutes: number;
	case_day: number;
}

export interface DayReport {
	date: string;
	weekday: number;
	holiday: { name: { en: string; sl: string }; work_free: boolean } | null;
	working_day: boolean;
	employed: boolean;
	worked_minutes: number;
	overtime_minutes: number;
	night_minutes: number;
	break_minutes: number;
	entries: number;
	shifts: string[];
	absences: DayAbsence[];
}

export interface MonthTotals {
	fund_minutes: number;
	worked_minutes: number;
	overtime_minutes: number;
	night_minutes: number;
	sunday_minutes: number;
	holiday_work_minutes: number;
	holiday_minutes: number;
	absence_minutes: Record<AbsenceKind, number>;
	days_worked: number;
	meal_days: number;
	balance_minutes: number;
}

export interface PersonMonth {
	member: string;
	person: string;
	daily_minutes: number;
	days: DayReport[];
	totals: MonthTotals;
}

export interface MonthReport {
	month: string;
	from: string;
	to: string;
	people: PersonMonth[];
}

function emptyAbsenceMinutes(): Record<AbsenceKind, number> {
	return Object.fromEntries(ABSENCE_KINDS.map((kind) => [kind, 0])) as Record<AbsenceKind, number>;
}

function employedOn(date: string, employee: Pick<EmployeeRow, "started_on" | "ended_on"> | null): boolean {
	if (!employee) return true;
	if (employee.started_on && date < employee.started_on) return false;
	if (employee.ended_on && date > employee.ended_on) return false;
	return true;
}

function caseDay(absence: AbsenceRow, date: string, calendar: HolidayCalendar): number {
	return workingDaysBetween(absence.starts_on, date, calendar).length;
}

export function personMonth(
	person: Pick<Person, "member" | "name" | "daily_minutes">,
	employee: Pick<EmployeeRow, "started_on" | "ended_on"> | null,
	range: { from: string; to: string },
	entries: TimeEntryRow[],
	absences: AbsenceRow[],
	calendar: HolidayCalendar,
	config: WorkforceConfig
): PersonMonth {
	const days = new Map<string, DayReport>(
		datesBetween(range.from, range.to).map((date) => {
			const holiday = calendar.get(date);
			return [
				date,
				{
					date,
					weekday: weekdayOf(date),
					holiday: holiday ? { name: holiday.name, work_free: holiday.work_free } : null,
					working_day: isWorkingDay(date, calendar),
					employed: employedOn(date, employee),
					worked_minutes: 0,
					overtime_minutes: 0,
					night_minutes: 0,
					break_minutes: 0,
					entries: 0,
					shifts: [],
					absences: [],
				},
			];
		})
	);
	const totals: MonthTotals = {
		fund_minutes: 0,
		worked_minutes: 0,
		overtime_minutes: 0,
		night_minutes: 0,
		sunday_minutes: 0,
		holiday_work_minutes: 0,
		holiday_minutes: 0,
		absence_minutes: emptyAbsenceMinutes(),
		days_worked: 0,
		meal_days: 0,
		balance_minutes: 0,
	};

	const paid = paidBreaks(entries, () => config);
	for (const entry of entries) {
		const pause = entry.kind === "break";
		const worked = pause ? (paid.get(entry.uuid) ?? 0) : workedMinutes(entry, config);
		const duration = entry.end_minute - entry.start_minute;
		const share = worked / duration;
		const first = days.get(entry.work_date);
		if (first && pause) first.break_minutes += duration;
		if (first && !pause) {
			first.entries += 1;
			first.break_minutes += entry.break_minutes;
			first.shifts.push(`${formatClock(entry.start_minute)}-${formatClock(entry.end_minute)}${entry.kind === "overtime" ? "*" : ""}`);
		}
		for (const segment of segmentsOf(entry)) {
			const day = days.get(segment.date);
			if (!day) continue;
			const minutes = Math.round(segment.minutes * share);
			const night = Math.round(nightMinutesOf(segment, config) * share);
			if (entry.kind === "overtime") day.overtime_minutes += minutes;
			else day.worked_minutes += minutes;
			day.night_minutes += night;
			totals.night_minutes += night;
			if (day.weekday === 0) totals.sunday_minutes += minutes;
			if (day.holiday?.work_free) totals.holiday_work_minutes += minutes;
		}
	}

	for (const absence of absences) {
		if (absence.status !== "approved" && absence.status !== "pending") continue;
		const fraction = absenceDayFraction(absence, person.daily_minutes);
		for (const date of absenceWorkingDays(absence, calendar, range.from, range.to)) {
			const day = days.get(date);
			if (!day) continue;
			day.absences.push({
				uuid: absence.uuid,
				kind: absence.kind,
				status: absence.status,
				minutes: Math.round(person.daily_minutes * fraction),
				case_day: caseDay(absence, date, calendar),
			});
		}
	}

	for (const day of days.values()) {
		totals.worked_minutes += day.worked_minutes;
		totals.overtime_minutes += day.overtime_minutes;
		const present = day.worked_minutes + day.overtime_minutes;
		if (present > 0) totals.days_worked += 1;
		if (present > 0 && present >= config.meal_min_minutes) totals.meal_days += 1;
		if (!day.employed || day.weekday === 0 || day.weekday === 6) continue;
		totals.fund_minutes += person.daily_minutes;
		if (isPaidHoliday(day.date, calendar)) totals.holiday_minutes += person.daily_minutes;
		for (const absence of day.absences) {
			if (absence.status === "approved") totals.absence_minutes[absence.kind] += absence.minutes;
		}
	}

	const absent = Object.values(totals.absence_minutes).reduce((sum, minutes) => sum + minutes, 0);
	totals.balance_minutes = totals.worked_minutes + totals.overtime_minutes + totals.holiday_minutes + absent - totals.fund_minutes;

	return { member: person.member, person: person.name, daily_minutes: person.daily_minutes, days: [...days.values()], totals };
}

export async function monthReport(
	project: Pick<ProjectRow, "uuid" | "tax_country">,
	config: WorkforceConfig,
	month: string,
	people: Person[]
): Promise<MonthReport> {
	const range = monthRange(month);
	const members = people.map((person) => person.member);
	if (members.length === 0) return { month, ...range, people: [] };

	const entries = (await Database`
		SELECT * FROM time_entries
		WHERE project = ${project.uuid} AND member IN ${Database(members)} AND work_date >= ${addDays(range.from, -1)} AND work_date <= ${range.to}
		ORDER BY work_date ASC, start_minute ASC
	`) as TimeEntryRow[];
	const absences = (await Database`
		SELECT * FROM absences
		WHERE project = ${project.uuid} AND member IN ${Database(members)} AND status IN ('approved', 'pending')
			AND starts_on <= ${range.to} AND ends_on >= ${range.from}
		ORDER BY starts_on ASC
	`) as AbsenceRow[];
	const employees = (await Database`SELECT * FROM employees WHERE member IN ${Database(members)}`) as EmployeeRow[];
	const earliest = absences.reduce((first, absence) => (absence.starts_on < first ? absence.starts_on : first), range.from);
	const calendar = await holidayCalendar(project, earliest, range.to);

	return {
		month,
		...range,
		people: people.map((person) => {
			const employee = employees.find((row) => row.member === person.member) ?? null;
			return personMonth(
				person,
				employee,
				range,
				entries.filter((entry) => entry.member === person.member),
				absences.filter((absence) => absence.member === person.member),
				calendar,
				configFor(config, employee)
			);
		}),
	};
}

export interface VacationBalance {
	year: number;
	entitled_days: number;
	carried_days: number;
	approved_days: number;
	taken_days: number;
	pending_days: number;
	remaining_days: number;
}

function roundDays(days: number): number {
	return Math.round(days * 100) / 100;
}

export async function vacationBalance(
	project: Pick<ProjectRow, "uuid" | "tax_country">,
	member: string,
	year: number,
	dailyMinutes: number,
	today: string
): Promise<VacationBalance> {
	const from = `${year}-01-01`;
	const to = `${year}-12-31`;
	const [employee] = (await Database`SELECT vacation_days FROM employees WHERE member = ${member}`) as Pick<EmployeeRow, "vacation_days">[];
	const [balance] = (await Database`SELECT * FROM leave_balances WHERE member = ${member} AND year = ${year}`) as LeaveBalanceRow[];
	const absences = (await Database`
		SELECT * FROM absences
		WHERE member = ${member} AND kind = 'vacation' AND status IN ('approved', 'pending') AND starts_on <= ${to} AND ends_on >= ${from}
	`) as AbsenceRow[];
	const calendar = await holidayCalendar(project, from, to);

	let approved = 0;
	let taken = 0;
	let pending = 0;
	for (const absence of absences) {
		const fraction = absenceDayFraction(absence, dailyMinutes);
		const dates = absenceWorkingDays(absence, calendar, from, to);
		if (absence.status === "pending") {
			pending += dates.length * fraction;
			continue;
		}
		approved += dates.length * fraction;
		taken += dates.filter((date) => date <= today).length * fraction;
	}

	const entitled = balance?.entitled_days ?? employee?.vacation_days ?? 20;
	const carried = balance?.carried_days ?? 0;
	return {
		year,
		entitled_days: entitled,
		carried_days: carried,
		approved_days: roundDays(approved),
		taken_days: roundDays(taken),
		pending_days: roundDays(pending),
		remaining_days: roundDays(entitled + carried - approved),
	};
}

function csvCell(value: string | number): string {
	const text = String(value);
	return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function hours(minutes: number): string {
	return (minutes / 60).toFixed(2);
}

export function monthReportCsv(report: MonthReport): string {
	const rows: (string | number)[][] = [
		["person", "date", "holiday", "worked_hours", "overtime_hours", "night_hours", "break_minutes", "absence", "absence_hours", "absence_status"],
	];
	for (const person of report.people) {
		for (const day of person.days) {
			const absence = day.absences[0];
			rows.push([
				person.person,
				day.date,
				day.holiday?.name.sl ?? "",
				hours(day.worked_minutes),
				hours(day.overtime_minutes),
				hours(day.night_minutes),
				day.break_minutes,
				absence?.kind ?? "",
				absence ? hours(absence.minutes) : "",
				absence?.status ?? "",
			]);
		}
		const totals = person.totals;
		rows.push([
			person.person,
			"total",
			`fund ${hours(totals.fund_minutes)}; holidays ${hours(totals.holiday_minutes)}; balance ${hours(totals.balance_minutes)}`,
			hours(totals.worked_minutes),
			hours(totals.overtime_minutes),
			hours(totals.night_minutes),
			"",
			ABSENCE_KINDS.filter((kind) => totals.absence_minutes[kind] > 0)
				.map((kind) => `${kind} ${hours(totals.absence_minutes[kind])}`)
				.join("; "),
			"",
			"",
		]);
	}
	return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
