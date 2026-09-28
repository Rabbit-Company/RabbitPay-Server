import Database from "../database/database";
import { datesBetween, isWeekend, nationalHolidays } from "./holidays";
import type { ProjectRow, WorkforceHolidayRow } from "../database/models";

export interface CalendarDay {
	name: { en: string; sl: string };
	work_free: boolean;
	source: "national" | "project";
}

export type HolidayCalendar = Map<string, CalendarDay>;

export async function holidayCalendar(project: Pick<ProjectRow, "uuid" | "tax_country">, from: string, to: string): Promise<HolidayCalendar> {
	const calendar: HolidayCalendar = new Map();
	const firstYear = Number(from.slice(0, 4));
	const lastYear = Number(to.slice(0, 4));
	for (let year = firstYear; year <= lastYear; year++) {
		for (const holiday of nationalHolidays(project.tax_country, year)) {
			if (holiday.date < from || holiday.date > to) continue;
			const existing = calendar.get(holiday.date);
			if (existing?.work_free) continue;
			calendar.set(holiday.date, { name: holiday.name, work_free: holiday.work_free, source: "national" });
		}
	}

	const custom = (await Database`
		SELECT * FROM workforce_holidays WHERE project = ${project.uuid} AND holiday_date >= ${from} AND holiday_date <= ${to}
	`) as WorkforceHolidayRow[];
	for (const holiday of custom) {
		if (calendar.get(holiday.holiday_date)?.work_free) continue;
		calendar.set(holiday.holiday_date, { name: { en: holiday.name, sl: holiday.name }, work_free: true, source: "project" });
	}
	return calendar;
}

export function isWorkingDay(date: string, calendar: HolidayCalendar): boolean {
	return !isWeekend(date) && !calendar.get(date)?.work_free;
}

export function isPaidHoliday(date: string, calendar: HolidayCalendar): boolean {
	return !isWeekend(date) && Boolean(calendar.get(date)?.work_free);
}

export function workingDaysBetween(from: string, to: string, calendar: HolidayCalendar): string[] {
	return datesBetween(from, to).filter((date) => isWorkingDay(date, calendar));
}

export function monthRange(month: string): { from: string; to: string } {
	const [year, monthNumber] = month.split("-").map(Number);
	const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
	return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export function isMonth(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false;
	const year = Number(value.slice(0, 4));
	return year >= 2000 && year <= 2100;
}

export function isIsoDate(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const [year, month, day] = value.split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	return year >= 2000 && year <= 2100 && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
