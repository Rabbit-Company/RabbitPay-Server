import Database, { dialect } from "./database/database";
import { identifier } from "./database/dialect";
import { schemaTypes } from "./database/schema-types";
import Vault from "./crypto/vault";
import { Logger } from "./logger";
import {
	DEFAULT_SETTINGS,
	SETTING_FIELDS,
	coerceSetting,
	readPath,
	settingField,
	settingValues,
	writePath,
	type ServerSettings,
	type SettingValue,
} from "./settings-schema";

export type { ServerSettings };

export const Settings: ServerSettings = structuredClone(DEFAULT_SETTINGS);

interface SettingRow {
	key: string;
	value: string;
}

interface SealedValue {
	sealed: string;
}

function isSealed(value: unknown): value is SealedValue {
	return value !== null && typeof value === "object" && typeof (value as SealedValue).sealed === "string";
}

function encode(key: string, value: SettingValue): string {
	const secret = settingField(key)?.kind === "secret";
	if (secret && typeof value === "string" && value !== "" && Vault.isConfigured()) {
		return JSON.stringify({ sealed: Vault.encrypt(value) } satisfies SealedValue);
	}
	return JSON.stringify(value);
}

function decode(row: SettingRow): unknown {
	const parsed = JSON.parse(row.value) as unknown;
	return isSealed(parsed) ? Vault.decrypt(parsed.sealed) : parsed;
}

async function ensureTable() {
	const types = schemaTypes(dialect);
	await Database.unsafe(`
		CREATE TABLE IF NOT EXISTS settings(
			${identifier("key", dialect)} ${types.text("key")} PRIMARY KEY,
			value ${types.text("settings_value")} NOT NULL,
			updated ${types.int64} NOT NULL
		)
	`);
}

async function store(values: Record<string, SettingValue>) {
	const timestamp = Date.now();
	await Database.begin(async (tx) => {
		for (const [key, value] of Object.entries(values)) {
			if (value === readPath(DEFAULT_SETTINGS, key)) {
				if (dialect === "mysql") await tx`DELETE FROM settings WHERE \`key\` = ${key}`;
				else await tx`DELETE FROM settings WHERE key = ${key}`;
				continue;
			}
			const encoded = encode(key, value);
			if (dialect === "mysql")
				await tx`
				INSERT INTO settings(\`key\`, value, updated) VALUES(${key}, ${encoded}, ${timestamp})
				ON DUPLICATE KEY UPDATE value = ${encoded}, updated = ${timestamp}
			`;
			else
				await tx`
				INSERT INTO settings(key, value, updated) VALUES(${key}, ${encoded}, ${timestamp})
				ON CONFLICT(key) DO UPDATE SET value = ${encoded}, updated = ${timestamp}
			`;
		}
	});
}

function apply(values: Record<string, unknown>): boolean {
	const next = structuredClone(DEFAULT_SETTINGS);
	for (const [key, raw] of Object.entries(values)) {
		const field = settingField(key);
		if (!field) continue;
		const value = coerceSetting(field, raw);
		if (value === undefined) {
			Logger.warn(`[SETTINGS] Ignoring invalid stored value for ${key}`);
			continue;
		}
		writePath(next, key, value);
	}

	const changed = JSON.stringify(next) !== JSON.stringify(Settings);
	for (const section of Object.keys(next) as (keyof ServerSettings)[]) {
		(Settings as unknown as Record<string, unknown>)[section] = next[section];
	}
	Logger.setLevel(Settings.logging.level);
	return changed;
}

export async function reloadSettings(): Promise<boolean> {
	const rows = (dialect === "mysql" ? await Database`SELECT \`key\`, value FROM settings` : await Database`SELECT key, value FROM settings`) as SettingRow[];
	const values: Record<string, unknown> = {};
	for (const row of rows) {
		try {
			values[row.key] = decode(row);
		} catch (err) {
			Logger.error(`[SETTINGS] Could not read ${row.key}: ${err}`);
		}
	}
	return apply(values);
}

export type SettingsProblem = { key: string; reason: "unknown" | "invalid" | "master_key" };

function acceptChanges(changes: Record<string, unknown>, stored: boolean): { accepted: Record<string, SettingValue>; problem: SettingsProblem | null } {
	const accepted: Record<string, SettingValue> = {};
	for (const [key, raw] of Object.entries(changes)) {
		const field = settingField(key);
		if (!field) return { accepted, problem: { key, reason: "unknown" } };

		const clearing = field.kind === "secret" && raw === null;
		if (field.kind === "secret" && (raw === undefined || raw === "")) continue;

		const value = clearing ? "" : coerceSetting(field, raw);
		if (value === undefined) return { accepted, problem: { key, reason: "invalid" } };
		if (stored && field.kind === "secret" && value !== "" && !Vault.isConfigured()) return { accepted, problem: { key, reason: "master_key" } };

		accepted[key] = value;
	}
	return { accepted, problem: null };
}

export async function updateSettings(changes: Record<string, unknown>): Promise<SettingsProblem | null> {
	const { accepted, problem } = acceptChanges(changes, true);
	if (problem) return problem;

	await store(accepted);
	await reloadSettings();
	return null;
}

export function settingsWith(changes: Record<string, unknown>): { settings: ServerSettings; problem: SettingsProblem | null } {
	const settings = structuredClone(Settings);
	const { accepted, problem } = acceptChanges(changes, false);
	for (const [key, value] of Object.entries(accepted)) writePath(settings, key, value);
	return { settings, problem };
}

export function presentSettings() {
	const values = settingValues(Settings);
	const secrets: Record<string, boolean> = {};
	for (const field of SETTING_FIELDS) {
		if (field.kind !== "secret") continue;
		secrets[field.key] = values[field.key] !== "" && values[field.key] !== undefined;
		values[field.key] = "";
	}
	return { values, secrets, defaults: settingValues(DEFAULT_SETTINGS) };
}

await ensureTable();
await reloadSettings();
