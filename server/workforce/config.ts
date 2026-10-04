import Database, { dialect } from "../database/database";
import type { EmployeeRow, WorkforceSettingsRow } from "../database/models";

export interface WorkforceRates {
	overtime: number;
	night: number;
	sunday: number;
	holiday: number;
	waiting_home: number;
	sick: number;
	injury: number;
}

export interface WorkforceConfig {
	edit_days: number;
	paid_break_minutes: number;
	daily_minutes: number;
	night_from: number;
	night_to: number;
	rates: WorkforceRates;
	sick_employer_days: number;
	seniority_rate: number;
	meal_allowance: number;
	meal_min_minutes: number;
	ticket_hourly_rate: number | null;
	ticket_tax_rate: number;
	email_notifications: boolean;
}

export const DEFAULT_WORKFORCE_CONFIG: WorkforceConfig = {
	edit_days: 1,
	paid_break_minutes: 30,
	daily_minutes: 480,
	night_from: 22 * 60,
	night_to: 6 * 60,
	rates: { overtime: 30, night: 50, sunday: 50, holiday: 100, waiting_home: 80, sick: 80, injury: 100 },
	sick_employer_days: 20,
	seniority_rate: 0.5,
	meal_allowance: 0,
	meal_min_minutes: 240,
	ticket_hourly_rate: null,
	ticket_tax_rate: 22,
	email_notifications: true,
};

function wholeNumber(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function percent(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 500 && Math.round(value * 100) === value * 100;
}

export function readWorkforceConfig(value: unknown): WorkforceConfig | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	const rates = input.rates;
	if (typeof rates !== "object" || rates === null || Array.isArray(rates)) return null;
	const rateInput = rates as Record<string, unknown>;
	const rateKeys = Object.keys(DEFAULT_WORKFORCE_CONFIG.rates) as (keyof WorkforceRates)[];
	if (!rateKeys.every((key) => percent(rateInput[key]))) return null;

	if (!wholeNumber(input.edit_days, 0, 60)) return null;
	if (!wholeNumber(input.paid_break_minutes, 0, 120)) return null;
	if (!wholeNumber(input.daily_minutes, 60, 720)) return null;
	if (!wholeNumber(input.night_from, 0, 1439) || !wholeNumber(input.night_to, 0, 1439) || input.night_from === input.night_to) return null;
	if (!wholeNumber(input.sick_employer_days, 0, 366)) return null;
	if (!percent(input.seniority_rate) || input.seniority_rate > 5) return null;
	if (!wholeNumber(input.meal_allowance, 0, 100_000)) return null;
	if (!wholeNumber(input.meal_min_minutes, 0, 1440)) return null;
	if (input.ticket_hourly_rate !== null && !wholeNumber(input.ticket_hourly_rate, 0, 100_000_000)) return null;
	if (!percent(input.ticket_tax_rate) || input.ticket_tax_rate > 100) return null;
	if (typeof input.email_notifications !== "boolean") return null;

	return {
		edit_days: input.edit_days,
		paid_break_minutes: input.paid_break_minutes,
		daily_minutes: input.daily_minutes,
		night_from: input.night_from,
		night_to: input.night_to,
		rates: Object.fromEntries(rateKeys.map((key) => [key, rateInput[key] as number])) as unknown as WorkforceRates,
		sick_employer_days: input.sick_employer_days,
		seniority_rate: input.seniority_rate,
		meal_allowance: input.meal_allowance,
		meal_min_minutes: input.meal_min_minutes,
		ticket_hourly_rate: input.ticket_hourly_rate as number | null,
		ticket_tax_rate: input.ticket_tax_rate,
		email_notifications: input.email_notifications,
	};
}

export function parseWorkforceConfig(stored: string | null | undefined): WorkforceConfig {
	if (!stored) return DEFAULT_WORKFORCE_CONFIG;
	try {
		const parsed = JSON.parse(stored);
		return (
			readWorkforceConfig({ ...DEFAULT_WORKFORCE_CONFIG, ...parsed, rates: { ...DEFAULT_WORKFORCE_CONFIG.rates, ...parsed?.rates } }) ??
			DEFAULT_WORKFORCE_CONFIG
		);
	} catch {
		return DEFAULT_WORKFORCE_CONFIG;
	}
}

export const OVERRIDE_KEYS = [
	"edit_days",
	"paid_break_minutes",
	"night_from",
	"night_to",
	"sick_employer_days",
	"seniority_rate",
	"meal_allowance",
	"meal_min_minutes",
	"ticket_hourly_rate",
	"ticket_tax_rate",
] as const;

export type WorkforceOverrideKey = (typeof OVERRIDE_KEYS)[number];

export type WorkforceOverrides = { [Key in WorkforceOverrideKey]?: number } & { rates?: Partial<WorkforceRates> };

export type ConfigOf = (member: string | null) => WorkforceConfig;

export function readWorkforceOverrides(value: unknown): WorkforceOverrides | null {
	if (value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	const allowed = new Set<string>([...OVERRIDE_KEYS, "rates"]);
	if (Object.keys(input).some((key) => !allowed.has(key))) return null;

	const result: WorkforceOverrides = {};
	for (const key of OVERRIDE_KEYS) {
		if (input[key] === undefined || input[key] === null) continue;
		if (typeof input[key] !== "number") return null;
		result[key] = input[key];
	}
	if ((result.night_from === undefined) !== (result.night_to === undefined)) return null;

	if (input.rates !== undefined && input.rates !== null) {
		if (typeof input.rates !== "object" || Array.isArray(input.rates)) return null;
		const rateInput = input.rates as Record<string, unknown>;
		const rateKeys = Object.keys(DEFAULT_WORKFORCE_CONFIG.rates) as (keyof WorkforceRates)[];
		if (Object.keys(rateInput).some((key) => !rateKeys.includes(key as keyof WorkforceRates))) return null;
		const rates: Partial<WorkforceRates> = {};
		for (const key of rateKeys) {
			if (rateInput[key] === undefined || rateInput[key] === null) continue;
			if (typeof rateInput[key] !== "number") return null;
			rates[key] = rateInput[key];
		}
		if (Object.keys(rates).length > 0) result.rates = rates;
	}

	const merged = { ...DEFAULT_WORKFORCE_CONFIG, ...result, rates: { ...DEFAULT_WORKFORCE_CONFIG.rates, ...result.rates } };
	return readWorkforceConfig(merged) ? result : null;
}

export function parseWorkforceOverrides(stored: string | null | undefined): WorkforceOverrides {
	if (!stored) return {};
	try {
		return readWorkforceOverrides(JSON.parse(stored)) ?? {};
	} catch {
		return {};
	}
}

export function storedOverrides(overrides: WorkforceOverrides): string | null {
	return Object.keys(overrides).length > 0 ? JSON.stringify(overrides) : null;
}

export function applyOverrides(config: WorkforceConfig, overrides: WorkforceOverrides): WorkforceConfig {
	return readWorkforceConfig({ ...config, ...overrides, rates: { ...config.rates, ...overrides.rates } }) ?? config;
}

export function configFor(config: WorkforceConfig, employee: Pick<EmployeeRow, "workforce_settings"> | null | undefined): WorkforceConfig {
	return employee?.workforce_settings ? applyOverrides(config, parseWorkforceOverrides(employee.workforce_settings)) : config;
}

export async function workforceConfig(projectId: string): Promise<WorkforceConfig> {
	const [row] = (await Database`SELECT config FROM workforce_settings WHERE project = ${projectId}`) as Pick<WorkforceSettingsRow, "config">[];
	return parseWorkforceConfig(row?.config);
}

export async function memberConfigs(projectId: string, members: (string | null)[]): Promise<ConfigOf> {
	const config = await workforceConfig(projectId);
	const ids = [...new Set(members.filter((member): member is string => member !== null))];
	const rows = ids.length
		? ((await Database`SELECT member, workforce_settings FROM employees WHERE member IN ${Database(ids)}`) as Pick<
				EmployeeRow,
				"member" | "workforce_settings"
			>[])
		: [];
	const byMember = new Map(rows.map((row) => [row.member, configFor(config, row)]));
	return (member) => (member === null ? config : (byMember.get(member) ?? config));
}

export async function memberConfig(projectId: string, member: string | null): Promise<WorkforceConfig> {
	return (await memberConfigs(projectId, [member]))(member);
}

export async function saveWorkforceConfig(projectId: string, config: WorkforceConfig) {
	const stored = JSON.stringify(config);
	const now = Date.now();
	if (dialect === "mysql") {
		await Database`INSERT INTO workforce_settings(project, config, updated) VALUES(${projectId}, ${stored}, ${now})
			ON DUPLICATE KEY UPDATE config = ${stored}, updated = ${now}`;
	} else {
		await Database`INSERT INTO workforce_settings(project, config, updated) VALUES(${projectId}, ${stored}, ${now})
			ON CONFLICT(project) DO UPDATE SET config = ${stored}, updated = ${now}`;
	}
}
