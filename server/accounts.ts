import type { Context } from "@rabbit-company/web";
import type { SQL } from "bun";
import Database from "./database/database";
import Utils from "./utils";
import type { AppState } from "./database/models";

const ACCOUNT_ID_LENGTH = 26;
const ID_LETTERS = "abcdefghijklmnopqrstuvwxyz";
const ID_CHARACTERS = `${ID_LETTERS}0123456789`;
const ACCOUNT_FIELDS = [
	"created_by",
	"updated_by",
	"decided_by",
	"changed_by",
	"verified_by",
	"finalized_by",
	"redeemed_by",
	"sent_by",
	"invited_by",
	"submitted_by",
];

export function normalizeEmail(email: unknown): string {
	return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export function newAccountId(): string {
	const random = crypto.getRandomValues(new Uint8Array(ACCOUNT_ID_LENGTH));
	let id = ID_LETTERS[random[0] % ID_LETTERS.length];
	for (let index = 1; index < ACCOUNT_ID_LENGTH; index++) id += ID_CHARACTERS[random[index] % ID_CHARACTERS.length];
	return id;
}

export async function accountByEmail<Row>(sql: SQL, email: string): Promise<Row | null> {
	const [account] = (await sql`SELECT * FROM accounts WHERE LOWER(email) = ${normalizeEmail(email)}`) as Row[];
	return account ?? null;
}

export async function accountNames(ids: Iterable<string | null | undefined>, projectId: string | null): Promise<Map<string, string>> {
	const wanted = [...new Set([...ids].filter((id): id is string => typeof id === "string" && id !== ""))];
	if (wanted.length === 0) return new Map();
	const rows = (
		projectId === null
			? await Database`SELECT username, email, NULL AS full_name FROM accounts WHERE username IN ${Database(wanted)}`
			: await Database`
				SELECT a.username, a.email, pm.full_name FROM accounts a
				LEFT JOIN project_members pm ON pm.account_username = a.username AND pm.project_id = ${projectId}
				WHERE a.username IN ${Database(wanted)}
			`
	) as { username: string; email: string; full_name: string | null }[];
	return new Map(rows.map((row) => [row.username, row.full_name?.trim() || row.email]));
}

function accountFieldHolders(value: unknown, holders: Record<string, unknown>[]) {
	if (value === null || typeof value !== "object" || ArrayBuffer.isView(value) || value instanceof Date) return;
	if (Array.isArray(value)) {
		for (const item of value) accountFieldHolders(item, holders);
		return;
	}
	const record = value as Record<string, unknown>;
	if (ACCOUNT_FIELDS.some((field) => record[field] !== undefined)) holders.push(record);
	for (const item of Object.values(record)) accountFieldHolders(item, holders);
}

export async function nameAccounts<Data>(data: Data, projectId: string | null): Promise<Data> {
	const holders: Record<string, unknown>[] = [];
	accountFieldHolders(data, holders);
	const names = await accountNames(
		holders.flatMap((holder) => ACCOUNT_FIELDS.map((field) => holder[field] as string | null | undefined)),
		projectId
	);
	for (const holder of holders) {
		for (const field of ACCOUNT_FIELDS) {
			if (holder[field] !== undefined) holder[`${field}_name`] = names.get(holder[field] as string) ?? null;
		}
	}
	return data;
}

export async function okWithNames(ctx: Context<AppState>, data: unknown, statusCode = 200) {
	return Utils.ok(ctx, await nameAccounts(data, ctx.get("project")?.uuid ?? null), statusCode);
}
