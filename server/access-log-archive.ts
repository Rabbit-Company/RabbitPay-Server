import { gunzipSync, gzipSync } from "node:zlib";
import Database from "./database/database";
import { integerFields } from "./database/numbers";
import { EncryptedDocumentStorage, documentStorage, type DocumentStorage } from "./document-storage";
import { Settings } from "./settings";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_WINDOWS_PER_RUN = 240;
const ARCHIVE_CONTENT_TYPE = "application/gzip";

export interface AccessLogEntry {
	uuid: string;
	project_id: string | null;
	account_username: string;
	action: string;
	resource_type: string | null;
	resource_id: string | null;
	permission_checked: string | null;
	granted: number | null;
	ip_address: string | null;
	user_agent: string | null;
	metadata: string | null;
	created: number;
}

export interface AccessLogArchiveRow {
	storage_key: string;
	starts_at: number;
	ends_at: number;
	entries: number;
	byte_size: number;
	sha256: string;
	created: number;
}

export interface AccessLogMaintenance {
	archived: number;
	windows: number;
	expiredEntries: number;
	expiredArchives: number;
}

export function archiveStorage(): DocumentStorage {
	const storage = documentStorage();
	return storage instanceof EncryptedDocumentStorage ? storage : new EncryptedDocumentStorage(storage);
}

export function archiveKey(startsAt: number): string {
	const hour = new Date(startsAt).toISOString().slice(0, 13);
	const [day, time] = hour.split("T");
	const [year, month] = day.split("-");
	return `logs/access/${year}/${month}/${day}T${time}.jsonl.gz`;
}

export function onlineCutoff(now: number): number {
	return now - Settings.access_logs.online_days * DAY;
}

export function retentionCutoff(now: number): number {
	return Date.UTC(new Date(now).getUTCFullYear() - Settings.access_logs.retention_years, 0, 1);
}

export function encodeEntries(entries: AccessLogEntry[]): Uint8Array {
	return gzipSync(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { level: 9 });
}

export function decodeEntries(data: Uint8Array): AccessLogEntry[] {
	return gunzipSync(data)
		.toString("utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as AccessLogEntry);
}

async function oldestWindow(before: number): Promise<number | null> {
	const [row] = (await Database`SELECT MIN(created) AS oldest FROM access_logs WHERE created < ${before}`) as { oldest: number | null }[];
	if (row?.oldest === null || row?.oldest === undefined) return null;
	const startsAt = Math.floor(Number(row.oldest) / HOUR) * HOUR;
	return startsAt + HOUR <= before ? startsAt : null;
}

async function archiveWindow(storage: DocumentStorage, startsAt: number, now: number): Promise<number> {
	const endsAt = startsAt + HOUR;
	const entries = integerFields(
		(await Database`
			SELECT uuid, project_id, account_username, action, resource_type, resource_id, permission_checked, granted, ip_address, user_agent, metadata, created
			FROM access_logs WHERE created >= ${startsAt} AND created < ${endsAt} ORDER BY created ASC, uuid ASC
		`) as AccessLogEntry[],
		"created",
		"granted"
	);
	if (entries.length === 0) return 0;

	const key = archiveKey(startsAt);
	const data = encodeEntries(entries);
	const checksum = new Bun.CryptoHasher("sha256").update(data).digest("hex");
	await storage.put(key, data, ARCHIVE_CONTENT_TYPE);

	await Database.begin(async (tx) => {
		await tx`DELETE FROM access_log_archives WHERE storage_key = ${key}`;
		await tx`
			INSERT INTO access_log_archives(storage_key, starts_at, ends_at, entries, byte_size, sha256, created)
			VALUES(${key}, ${startsAt}, ${endsAt}, ${entries.length}, ${data.byteLength}, ${checksum}, ${now})
		`;
		await tx`DELETE FROM access_logs WHERE created >= ${startsAt} AND created < ${endsAt}`;
	});
	return entries.length;
}

async function expireArchives(storage: DocumentStorage, cutoff: number): Promise<number> {
	const expired = (await Database`SELECT storage_key FROM access_log_archives WHERE ends_at <= ${cutoff}`) as Pick<AccessLogArchiveRow, "storage_key">[];
	for (const { storage_key } of expired) {
		await storage.remove(storage_key);
		await Database`DELETE FROM access_log_archives WHERE storage_key = ${storage_key}`;
	}
	return expired.length;
}

export async function maintainAccessLogs(now = Date.now(), storage: DocumentStorage = archiveStorage()): Promise<AccessLogMaintenance> {
	const retention = retentionCutoff(now);
	const expiredEntries = (await Database`DELETE FROM access_logs WHERE created < ${retention}`).count;

	let archived = 0;
	let windows = 0;
	if (Settings.access_logs.archive) {
		const cutoff = onlineCutoff(now);
		while (windows < MAX_WINDOWS_PER_RUN) {
			const startsAt = await oldestWindow(cutoff);
			if (startsAt === null) break;
			archived += await archiveWindow(storage, startsAt, now);
			windows++;
		}
	}

	const expiredArchives = await expireArchives(storage, retention);
	return { archived, windows, expiredEntries, expiredArchives };
}

export async function archivesBetween(from: number, to: number): Promise<AccessLogArchiveRow[]> {
	return integerFields(
		(await Database`SELECT * FROM access_log_archives WHERE ends_at > ${from} AND starts_at < ${to} ORDER BY starts_at ASC`) as AccessLogArchiveRow[],
		"starts_at",
		"ends_at",
		"entries",
		"byte_size",
		"created"
	);
}

export async function readArchive(
	row: Pick<AccessLogArchiveRow, "storage_key" | "sha256">,
	storage: DocumentStorage = archiveStorage()
): Promise<AccessLogEntry[]> {
	const data = await storage.get(row.storage_key);
	const checksum = new Bun.CryptoHasher("sha256").update(data).digest("hex");
	if (checksum !== row.sha256) throw new Error(`Access log archive ${row.storage_key} does not match its recorded checksum`);
	return decodeEntries(data);
}
