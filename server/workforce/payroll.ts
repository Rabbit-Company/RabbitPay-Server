import { addDays, datesBetween, isWeekend } from "./holidays";
import type { WorkforceConfig } from "./config";
import type { EmployeePrivate } from "./employees";
import type { PersonMonth } from "./reports";
import type { EmployeeRow } from "../database/models";

export interface PayrollMinutes {
	worked: number;
	waiting_home: number;
	overtime: number;
	holiday: number;
	vacation: number;
	paid_leave: number;
	sick_employer: number;
	sick_insurance: number;
	unpaid: number;
	night: number;
	sunday: number;
	holiday_work: number;
}

export interface PayrollAmounts {
	regular: number;
	waiting_home: number;
	overtime: number;
	holidays: number;
	leave: number;
	sick: number;
	overtime_supplement: number;
	night_supplement: number;
	sunday_supplement: number;
	holiday_supplement: number;
	seniority?: number;
	gross: number;
	meal: number;
	commute: number;
	reimbursements: number;
}

export interface PayrollLine {
	member: string;
	days: { worked: number; meal: number; commute: number };
	fund_minutes: number;
	person: string;
	employment_type: EmployeeRow["employment_type"];
	pay_type: EmployeeRow["pay_type"];
	salary: number | null;
	hourly_rate: number | null;
	service_months?: number | null;
	service_days?: number;
	seniority_percent?: number;
	minutes: PayrollMinutes;
	amounts: PayrollAmounts;
}

function weekdaysIn(from: string, to: string): number {
	return datesBetween(from, to).filter((date) => !isWeekend(date)).length;
}

export function serviceSpan(startedOn: string | null | undefined, priorMonths: number, until: string): { months: number; days: number } {
	if (!startedOn || startedOn > until) return { months: priorMonths, days: 0 };
	const [startYear, startMonth, startDay] = startedOn.split("-").map(Number);
	const [untilYear, untilMonth, untilDay] = until.split("-").map(Number);
	let months = (untilYear - startYear) * 12 + (untilMonth - startMonth);
	let days = untilDay - startDay;
	if (days < 0) {
		months -= 1;
		days += new Date(Date.UTC(untilYear, untilMonth - 1, 0)).getUTCDate();
	}
	return { months: priorMonths + Math.max(0, months), days: Math.max(0, days) };
}

export function payrollLine(
	month: PersonMonth,
	range: { from: string; to: string },
	employee: Pick<EmployeeRow, "employment_type" | "pay_type"> & Partial<Pick<EmployeeRow, "started_on" | "prior_service_months">>,
	details: Pick<EmployeePrivate, "salary" | "commute_per_day">,
	config: WorkforceConfig
): PayrollLine {
	const salary = details.salary;
	const fullFund = weekdaysIn(range.from, range.to) * month.daily_minutes;
	const perMinute = salary === null ? 0 : employee.pay_type === "hourly" ? salary / 60 : fullFund > 0 ? salary / fullFund : 0;
	const employed = employee.employment_type === "full_time" || employee.employment_type === "part_time";
	const totals = month.totals;

	let sickEmployerMinutes = 0;
	let sickEmployerPay = 0;
	let sickInsurance = 0;
	for (const day of month.days) {
		for (const absence of day.absences) {
			if (absence.status !== "approved" || (absence.kind !== "sick" && absence.kind !== "injury")) continue;
			if (!employed || absence.case_day > config.sick_employer_days) {
				sickInsurance += absence.minutes;
				continue;
			}
			sickEmployerMinutes += absence.minutes;
			sickEmployerPay += absence.minutes * perMinute * ((absence.kind === "injury" ? config.rates.injury : config.rates.sick) / 100);
		}
	}

	const minutes: PayrollMinutes = {
		worked: Math.max(0, totals.worked_minutes - totals.activity_minutes.waiting_home),
		waiting_home: totals.activity_minutes.waiting_home,
		overtime: totals.overtime_minutes,
		holiday: employed ? totals.holiday_minutes : 0,
		vacation: employed ? totals.absence_minutes.vacation : 0,
		paid_leave: employed ? totals.absence_minutes.paid_leave : 0,
		sick_employer: sickEmployerMinutes,
		sick_insurance: sickInsurance,
		unpaid: totals.absence_minutes.unpaid + totals.absence_minutes.parental + totals.absence_minutes.other,
		night: totals.night_minutes,
		sunday: totals.sunday_minutes,
		holiday_work: totals.holiday_work_minutes,
	};

	const pay = (count: number, percent = 100) => Math.round(count * perMinute * (percent / 100));
	const regular = pay(minutes.worked);
	const waitingHome = pay(minutes.waiting_home, config.rates.waiting_home);
	const overtime = pay(minutes.overtime);
	const holidays = pay(minutes.holiday);
	const leave = pay(minutes.vacation + minutes.paid_leave);
	const sick = Math.round(sickEmployerPay);
	const overtimeSupplement = pay(minutes.overtime, config.rates.overtime);
	const nightSupplement = pay(minutes.night, config.rates.night);
	const sundaySupplement = pay(minutes.sunday, config.rates.sunday);
	const holidaySupplement = pay(minutes.holiday_work, config.rates.holiday);
	const service = employed ? serviceSpan(employee.started_on, employee.prior_service_months ?? 0, addDays(range.from, -1)) : null;
	const seniorityPercent = service === null ? 0 : Math.round(Math.floor(service.months / 12) * config.seniority_rate * 100) / 100;
	const seniority = Math.round(((regular + waitingHome + holidays + leave) * seniorityPercent) / 100);
	const reimbursed = employee.employment_type !== "contractor";
	const meal = reimbursed ? totals.meal_days * config.meal_allowance : 0;
	const commute = reimbursed ? totals.commute_days * (details.commute_per_day ?? 0) : 0;

	return {
		member: month.member,
		days: { worked: totals.days_worked, meal: totals.meal_days, commute: totals.commute_days },
		fund_minutes: fullFund,
		person: month.person,
		employment_type: employee.employment_type,
		pay_type: employee.pay_type,
		salary,
		hourly_rate: salary === null ? null : Math.round(perMinute * 60),
		service_months: service?.months ?? null,
		service_days: service?.days ?? 0,
		seniority_percent: seniorityPercent,
		minutes,
		amounts: {
			regular,
			waiting_home: waitingHome,
			overtime,
			holidays,
			leave,
			sick,
			overtime_supplement: overtimeSupplement,
			night_supplement: nightSupplement,
			sunday_supplement: sundaySupplement,
			holiday_supplement: holidaySupplement,
			seniority,
			gross:
				regular + waitingHome + overtime + holidays + leave + sick + overtimeSupplement + nightSupplement + sundaySupplement + holidaySupplement + seniority,
			meal,
			commute,
			reimbursements: meal + commute,
		},
	};
}
