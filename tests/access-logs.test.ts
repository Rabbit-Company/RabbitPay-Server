import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareTest } from "./environment";
await prepareTest();

const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { updateSettings } = await import("../server/settings");
const { EncryptedDocumentStorage, LocalDocumentStorage } = await import("../server/document-storage");
const { isSealed } = await import("../server/crypto/sealed-file");
const { archiveKey, archivesBetween, maintainAccessLogs, readArchive, retentionCutoff } = await import("../server/access-log-archive");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const root = mkdtempSync(join(tmpdir(), "rabbitpay-access-logs-"));
const raw = new LocalDocumentStorage(root);
const storage = new EncryptedDocumentStorage(raw);
const NOW = Date.UTC(2026, 8, 27, 12, 30);

async function record(created: number, action = "GET /api/v1/projects/p/invoices") {
	await Database`
		INSERT INTO access_logs(uuid, project_id, account_username, action, permission_checked, granted, ip_address, user_agent, created)
		VALUES(${crypto.randomUUID()}, NULL, 'log-user', ${action}, 'invoices.read', 1, '203.0.113.7', 'test-agent', ${created})
	`;
}

async function liveCount(): Promise<number> {
	const [row] = (await Database`SELECT COUNT(*) AS total FROM access_logs`) as { total: number }[];
	return Number(row.total);
}

beforeAll(async () => {
	await initializeDatabase();
	await Database`INSERT INTO accounts(username, email, password, created, updated, accessed, admin) VALUES('log-user', 'log@example.com', 'x', 1, 1, 1, 0)`;
});

beforeEach(async () => {
	await Database`DELETE FROM access_logs`;
	for (const archive of await archivesBetween(0, Number.MAX_SAFE_INTEGER)) await storage.remove(archive.storage_key);
	await Database`DELETE FROM access_log_archives`;
	await updateSettings({ "access_logs.online_days": 90, "access_logs.archive": true, "access_logs.retention_years": 2 });
});

afterAll(async () => {
	await Database.close();
	rmSync(root, { recursive: true, force: true });
});

describe("access log archives", () => {
	test("moves complete hours past the online window into encrypted archives", async () => {
		const cutoff = NOW - 90 * DAY;
		const oldHour = Math.floor((cutoff - 5 * DAY) / HOUR) * HOUR;
		await record(oldHour + 1000, "GET /first");
		await record(oldHour + 2000, "GET /second");
		await record(oldHour + HOUR + 10);
		await record(Math.floor(cutoff / HOUR) * HOUR + 1);
		await record(NOW - DAY);

		const result = await maintainAccessLogs(NOW, storage);
		expect(result).toEqual({ archived: 3, windows: 2, expiredEntries: 0, expiredArchives: 0 });
		expect(await liveCount()).toBe(2);

		const archives = await archivesBetween(0, NOW);
		expect(archives.map((archive) => archive.storage_key)).toEqual([archiveKey(oldHour), archiveKey(oldHour + HOUR)]);
		expect(archives[0].entries).toBe(2);
		expect(isSealed(await raw.get(archives[0].storage_key))).toBe(true);

		const entries = await readArchive(archives[0], storage);
		expect(entries.map((entry) => entry.action)).toEqual(["GET /first", "GET /second"]);
		expect(entries[0]).toMatchObject({ account_username: "log-user", ip_address: "203.0.113.7", granted: 1, created: oldHour + 1000 });
	});

	test("names archives by UTC hour", () => {
		expect(archiveKey(Date.UTC(2026, 5, 14, 8))).toBe("logs/access/2026/06/2026-06-14T08.jsonl.gz");
	});

	test("a second run finds nothing left to archive", async () => {
		await record(NOW - 200 * DAY);
		await maintainAccessLogs(NOW, storage);
		expect(await maintainAccessLogs(NOW, storage)).toEqual({ archived: 0, windows: 0, expiredEntries: 0, expiredArchives: 0 });
	});

	test("deletes entries and archives once the calendar year plus retention has passed", async () => {
		await record(Date.UTC(2026, 1, 3, 10));
		await maintainAccessLogs(NOW, storage);
		const [archive] = await archivesBetween(0, NOW);
		expect(await raw.exists(archive.storage_key)).toBe(true);

		const lastDayKept = Date.UTC(2028, 11, 31, 23);
		expect(retentionCutoff(lastDayKept)).toBe(Date.UTC(2026, 0, 1));
		expect((await maintainAccessLogs(lastDayKept, storage)).expiredArchives).toBe(0);

		const afterRetention = Date.UTC(2029, 0, 1, 1);
		await record(Date.UTC(2026, 11, 31, 23, 30));
		const result = await maintainAccessLogs(afterRetention, storage);
		expect(result.expiredEntries).toBe(1);
		expect(result.expiredArchives).toBe(1);
		expect(await raw.exists(archive.storage_key)).toBe(false);
		expect(await archivesBetween(0, afterRetention)).toEqual([]);
	});

	test("keeps entries in the database until retention ends when archiving is off", async () => {
		await updateSettings({ "access_logs.archive": false });
		await record(NOW - 200 * DAY);
		expect(await maintainAccessLogs(NOW, storage)).toEqual({ archived: 0, windows: 0, expiredEntries: 0, expiredArchives: 0 });
		expect(await liveCount()).toBe(1);
		expect((await maintainAccessLogs(Date.UTC(2029, 0, 1), storage)).expiredEntries).toBe(1);
	});

	test("refuses an archive that was replaced after it was recorded", async () => {
		await record(NOW - 200 * DAY);
		await maintainAccessLogs(NOW, storage);
		const [archive] = await archivesBetween(0, NOW);
		await storage.put(archive.storage_key, new TextEncoder().encode("forged"), "application/gzip");
		await expect(readArchive(archive, storage)).rejects.toThrow("does not match its recorded checksum");
	});
});
