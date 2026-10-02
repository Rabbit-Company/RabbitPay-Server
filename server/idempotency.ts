import type { Context } from "@rabbit-company/web";
import Database from "./database/database";
import { ErrorCode } from "./errors";
import Utils from "./utils";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_REPLAYED_HEADER = "Idempotency-Replayed";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface IdempotencyRow {
	request_hash: string;
	resource: string;
}

export class IdempotencyKeyInvalid extends Error {}

export class IdempotencyKeyReused extends Error {}

export function idempotencyKeyOf(ctx: Context<any, any>): string | null {
	const key = ctx.req.headers.get(IDEMPOTENCY_HEADER);
	if (key === null) return null;
	if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) throw new IdempotencyKeyInvalid();
	return key;
}

function requestHash(body: unknown): string {
	return new Bun.CryptoHasher("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

async function claimed(projectId: string, key: string): Promise<IdempotencyRow | undefined> {
	const [row] = (await Database`
		SELECT request_hash, resource FROM idempotency_keys WHERE project = ${projectId} AND request_key = ${key}
	`) as IdempotencyRow[];
	return row;
}

export async function claimIdempotencyKey(projectId: string, key: string, body: unknown): Promise<string> {
	const hash = requestHash(body);
	const now = Date.now();
	await Database`DELETE FROM idempotency_keys WHERE created < ${now - RETENTION_MS}`;

	let row = await claimed(projectId, key);
	if (!row) {
		try {
			await Database`
				INSERT INTO idempotency_keys(project, request_key, request_hash, resource, created)
				VALUES(${projectId}, ${key}, ${hash}, ${crypto.randomUUID()}, ${now})
			`;
		} catch (err) {
			row = await claimed(projectId, key);
			if (!row) throw err;
		}
		row ??= await claimed(projectId, key);
	}

	if (!row || row.request_hash !== hash) throw new IdempotencyKeyReused();
	return row.resource;
}

export async function releaseIdempotencyKey(projectId: string, key: string): Promise<void> {
	await Database`
		DELETE FROM idempotency_keys WHERE project = ${projectId} AND request_key = ${key}
			AND NOT EXISTS (SELECT 1 FROM invoices WHERE invoices.uuid = idempotency_keys.resource)
	`;
}

export interface IdempotentRequest {
	resource: string | undefined;
	release(): Promise<void>;
	replayed(): void;
}

export async function idempotentRequest(ctx: Context<any, any>, projectId: string, body: unknown): Promise<IdempotentRequest | Response> {
	let key: string | null;
	try {
		key = idempotencyKeyOf(ctx);
	} catch {
		return Utils.fail(ctx, ErrorCode.INVALID_IDEMPOTENCY_KEY);
	}
	if (key === null) return { resource: undefined, release: async () => undefined, replayed: () => undefined };

	try {
		const requestKey = key;
		const resource = await claimIdempotencyKey(projectId, requestKey, body);
		return {
			resource,
			release: () => releaseIdempotencyKey(projectId, requestKey),
			replayed: () => ctx.header(IDEMPOTENCY_REPLAYED_HEADER, "true"),
		};
	} catch (err) {
		if (err instanceof IdempotencyKeyReused) return Utils.fail(ctx, ErrorCode.IDEMPOTENCY_KEY_REUSED);
		throw err;
	}
}
