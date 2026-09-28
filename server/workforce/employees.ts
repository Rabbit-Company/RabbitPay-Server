import Vault from "../crypto/vault";
import { isIsoDate } from "./calendar";
import { parseWorkforceOverrides, readWorkforceOverrides, type WorkforceOverrides } from "./config";
import type { EmployeeRow, EmploymentType, PayType } from "../database/models";

export interface EmployeePrivate {
	salary: number | null;
	commute_per_day: number | null;
	personal_id: string | null;
	tax_number: string | null;
	birth_date: string | null;
	address: string | null;
	iban: string | null;
	phone: string | null;
	private_email: string | null;
	emergency_contact: string | null;
	notes: string | null;
	dependents: number;
	claims_general_relief: boolean;
	commute_km: number | null;
	secondary_employer: boolean;
}

export interface EmployeeInput {
	employee_number: string | null;
	job_title: string | null;
	employment_type: EmploymentType;
	started_on: string | null;
	ended_on: string | null;
	prior_service_months: number;
	weekly_minutes: number;
	vacation_days: number;
	pay_type: PayType;
	private: EmployeePrivate;
	workforce_settings: WorkforceOverrides;
}

export const EMPLOYMENT_TYPES: EmploymentType[] = ["full_time", "part_time", "student", "contractor"];
export const PAY_TYPES: PayType[] = ["monthly", "hourly"];

export const EMPTY_PRIVATE: EmployeePrivate = {
	salary: null,
	commute_per_day: null,
	personal_id: null,
	tax_number: null,
	birth_date: null,
	address: null,
	iban: null,
	phone: null,
	private_email: null,
	emergency_contact: null,
	notes: null,
	dependents: 0,
	claims_general_relief: true,
	commute_km: null,
	secondary_employer: false,
};

const TEXT_LIMITS: Record<
	Exclude<keyof EmployeePrivate, "salary" | "commute_per_day" | "birth_date" | "dependents" | "claims_general_relief" | "commute_km" | "secondary_employer">,
	number
> = {
	personal_id: 20,
	tax_number: 20,
	address: 500,
	iban: 34,
	phone: 40,
	private_email: 254,
	emergency_contact: 300,
	notes: 5000,
};

export class PrivateDataUnavailable extends Error {
	constructor() {
		super("Employee details need RABBITPAY_MASTER_KEY to be stored encrypted.");
	}
}

export function openPrivate(row: Pick<EmployeeRow, "private_data"> | null): EmployeePrivate {
	if (!row?.private_data || !Vault.isConfigured()) return { ...EMPTY_PRIVATE };
	try {
		return { ...EMPTY_PRIVATE, ...(JSON.parse(Vault.decrypt(row.private_data)) as Partial<EmployeePrivate>) };
	} catch {
		return { ...EMPTY_PRIVATE };
	}
}

export function sealPrivate(data: EmployeePrivate): string | null {
	const filled = Object.entries(data).some(([key, value]) => value !== EMPTY_PRIVATE[key as keyof EmployeePrivate]);
	if (!filled) return null;
	if (!Vault.isConfigured()) throw new PrivateDataUnavailable();
	return Vault.encrypt(JSON.stringify(data));
}

function optionalText(value: unknown, limit: number): string | null | undefined {
	if (value === null) return null;
	if (typeof value !== "string" || value.length > limit) return undefined;
	return value.trim() || null;
}

function optionalAmount(value: unknown): number | null | undefined {
	if (value === null) return null;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000 ? value : undefined;
}

function readPrivate(value: unknown, previous: EmployeePrivate): EmployeePrivate | null {
	if (value === undefined) return previous;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	const result: EmployeePrivate = { ...previous };

	for (const key of ["salary", "commute_per_day"] as const) {
		if (input[key] === undefined) continue;
		const amount = optionalAmount(input[key]);
		if (amount === undefined) return null;
		result[key] = amount;
	}
	if (input.dependents !== undefined) {
		if (typeof input.dependents !== "number" || !Number.isSafeInteger(input.dependents) || input.dependents < 0 || input.dependents > 20) return null;
		result.dependents = input.dependents;
	}
	if (input.commute_km !== undefined) {
		if (
			input.commute_km !== null &&
			(typeof input.commute_km !== "number" || !Number.isSafeInteger(input.commute_km) || input.commute_km < 0 || input.commute_km > 1000)
		)
			return null;
		result.commute_km = input.commute_km as number | null;
	}
	if (input.secondary_employer !== undefined) {
		if (typeof input.secondary_employer !== "boolean") return null;
		result.secondary_employer = input.secondary_employer;
	}
	if (input.claims_general_relief !== undefined) {
		if (typeof input.claims_general_relief !== "boolean") return null;
		result.claims_general_relief = input.claims_general_relief;
	}
	if (input.birth_date !== undefined) {
		if (input.birth_date !== null && !isIsoDate(input.birth_date)) return null;
		result.birth_date = input.birth_date as string | null;
	}
	for (const [key, limit] of Object.entries(TEXT_LIMITS) as [keyof typeof TEXT_LIMITS, number][]) {
		if (input[key] === undefined) continue;
		const text = optionalText(input[key], limit);
		if (text === undefined) return null;
		result[key] = text;
	}
	if (result.personal_id !== null && !/^\d{13}$/.test(result.personal_id)) return null;
	if (result.iban !== null && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(result.iban.replace(/\s/g, "").toUpperCase())) return null;
	if (result.iban !== null) result.iban = result.iban.replace(/\s/g, "").toUpperCase();
	return result;
}

export function readEmployee(data: Record<string, unknown>, previous: EmployeeRow | null): EmployeeInput | null {
	const current = openPrivate(previous);
	const employeeNumber = data.employee_number === undefined ? (previous?.employee_number ?? null) : optionalText(data.employee_number, 64);
	const jobTitle = data.job_title === undefined ? (previous?.job_title ?? null) : optionalText(data.job_title, 150);
	const employmentType = data.employment_type ?? previous?.employment_type ?? "full_time";
	const startedOn = data.started_on === undefined ? (previous?.started_on ?? null) : data.started_on;
	const endedOn = data.ended_on === undefined ? (previous?.ended_on ?? null) : data.ended_on;
	const priorService = data.prior_service_months ?? previous?.prior_service_months ?? 0;
	const weeklyMinutes = data.weekly_minutes ?? previous?.weekly_minutes ?? 2400;
	const vacationDays = data.vacation_days ?? previous?.vacation_days ?? 20;
	const payType = data.pay_type ?? previous?.pay_type ?? "monthly";
	const privateData = readPrivate(data.private, current);
	const settings =
		data.workforce_settings === undefined ? parseWorkforceOverrides(previous?.workforce_settings) : readWorkforceOverrides(data.workforce_settings);

	if (employeeNumber === undefined || jobTitle === undefined || privateData === null || settings === null) return null;
	if (!EMPLOYMENT_TYPES.includes(employmentType as EmploymentType) || !PAY_TYPES.includes(payType as PayType)) return null;
	if (startedOn !== null && !isIsoDate(startedOn)) return null;
	if (endedOn !== null && (!isIsoDate(endedOn) || (startedOn !== null && endedOn < startedOn))) return null;
	if (typeof priorService !== "number" || !Number.isSafeInteger(priorService) || priorService < 0 || priorService > 720) return null;
	if (typeof weeklyMinutes !== "number" || !Number.isSafeInteger(weeklyMinutes) || weeklyMinutes < 1 || weeklyMinutes > 4800) return null;
	if (typeof vacationDays !== "number" || !Number.isFinite(vacationDays) || vacationDays < 0 || vacationDays > 366 || (vacationDays * 2) % 1 !== 0) return null;

	return {
		employee_number: employeeNumber,
		job_title: jobTitle,
		employment_type: employmentType as EmploymentType,
		started_on: startedOn as string | null,
		ended_on: endedOn as string | null,
		prior_service_months: priorService,
		weekly_minutes: weeklyMinutes,
		vacation_days: vacationDays,
		pay_type: payType as PayType,
		private: privateData,
		workforce_settings: settings,
	};
}

export function presentEmployee(row: EmployeeRow) {
	return {
		member: row.member,
		employee_number: row.employee_number,
		job_title: row.job_title,
		employment_type: row.employment_type,
		started_on: row.started_on,
		ended_on: row.ended_on,
		prior_service_months: row.prior_service_months,
		weekly_minutes: row.weekly_minutes,
		vacation_days: row.vacation_days,
		pay_type: row.pay_type,
		workforce_settings: parseWorkforceOverrides(row.workforce_settings),
		private: openPrivate(row),
		created: row.created,
		updated: row.updated,
	};
}
