import type { SQL } from "bun";
import Database from "../database/database";
import { isLocalDate, localDate } from "../timezone";
import { isValuationMethod, type ValuationMethod } from "./valuation";
import type { InventorySettingsRow } from "../database/models";

export interface MethodPeriod {
	from: string;
	method: ValuationMethod;
}

export interface InventoryConfig {
	methods: MethodPeriod[];
	negative_stock: boolean;
	pos_warehouse: string | null;
}

export const FIRST_DAY = "1970-01-01";

export const DEFAULT_INVENTORY_CONFIG: InventoryConfig = {
	methods: [{ from: FIRST_DAY, method: "average" }],
	negative_stock: true,
	pos_warehouse: null,
};

function readMethods(value: unknown): MethodPeriod[] {
	if (!Array.isArray(value)) return DEFAULT_INVENTORY_CONFIG.methods;
	const periods = value
		.filter((entry): entry is MethodPeriod => typeof entry === "object" && entry !== null && isLocalDate(entry.from) && isValuationMethod(entry.method))
		.map((entry) => ({ from: entry.from, method: entry.method }))
		.sort((a, b) => a.from.localeCompare(b.from));
	if (periods.length === 0) return DEFAULT_INVENTORY_CONFIG.methods;
	periods[0].from = FIRST_DAY;
	return periods.filter((entry, index) => index === 0 || entry.method !== periods[index - 1].method);
}

export function parseInventoryConfig(text: string | null | undefined): InventoryConfig {
	let stored: Partial<InventoryConfig> = {};
	try {
		stored = text ? (JSON.parse(text) as Partial<InventoryConfig>) : {};
	} catch {
		stored = {};
	}
	return {
		methods: readMethods(stored.methods),
		negative_stock: typeof stored.negative_stock === "boolean" ? stored.negative_stock : DEFAULT_INVENTORY_CONFIG.negative_stock,
		pos_warehouse: typeof stored.pos_warehouse === "string" ? stored.pos_warehouse : null,
	};
}

export async function inventoryConfig(project: string, sql: SQL = Database): Promise<InventoryConfig> {
	const [row] = (await sql`SELECT config FROM inventory_settings WHERE project = ${project}`) as Pick<InventorySettingsRow, "config">[];
	return parseInventoryConfig(row?.config);
}

export async function saveInventoryConfig(project: string, config: InventoryConfig, sql: SQL = Database) {
	const now = Date.now();
	const text = JSON.stringify(config);
	const updated = await sql`UPDATE inventory_settings SET config = ${text}, updated = ${now} WHERE project = ${project}`;
	if (updated.count === 0) await sql`INSERT INTO inventory_settings(project, config, updated) VALUES(${project}, ${text}, ${now})`;
}

export function methodOn(config: InventoryConfig, date: string): ValuationMethod {
	let method = config.methods[0].method;
	for (const period of config.methods) if (period.from <= date) method = period.method;
	return method;
}

export function methodAt(config: InventoryConfig, timestamp: number, timezone: string): ValuationMethod {
	return methodOn(config, localDate(timestamp, timezone));
}

export function currentMethod(config: InventoryConfig, timezone: string, now = Date.now()): ValuationMethod {
	return methodAt(config, now, timezone);
}

export function withMethodFrom(config: InventoryConfig, from: string, method: ValuationMethod): InventoryConfig {
	const kept = config.methods.filter((period) => period.from < from);
	const methods = readMethods([...kept, { from: kept.length === 0 ? FIRST_DAY : from, method }]);
	return { ...config, methods };
}
