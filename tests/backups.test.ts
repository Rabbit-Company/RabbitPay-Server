import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database as SQLite } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const workspace = mkdtempSync(join(tmpdir(), "rabbitpay-backups-"));
const databasePath = join(workspace, "rabbitpay.sqlite");

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${databasePath}`);

const { default: Database, initialize: initializeDatabase, sqliteFile } = await import("../server/database/database");
const { updateSettings } = await import("../server/settings");
const backups = await import("../server/backups");
const { LocalBackupTarget, backupIfDue, backupName, backupNow, backupTime, prune, resetSchedule, runBackup } = backups;
type BackupTarget = import("../server/backups").BackupTarget;

class FailingTarget implements BackupTarget {
	readonly name = "failing";
	async list(): Promise<string[]> {
		return [];
	}
	async upload(): Promise<void> {
		throw new Error("bucket unreachable");
	}
	async remove(): Promise<void> {}
}

beforeAll(async () => {
	await initializeDatabase();
	await Database`INSERT INTO accounts(username, email, password, created, updated, accessed, admin) VALUES('backup-user', 'backup@example.com', 'x', 1, 1, 1, 0)`;
});

afterAll(async () => {
	await Database.close();
	rmSync(workspace, { recursive: true, force: true });
});

describe("backup naming", () => {
	test("names sort by time and parse back to the same second", () => {
		const at = new Date(Date.UTC(2026, 8, 23, 18, 42, 54, 321));
		expect(backupName(at)).toBe("rabbitpay-20260923T184254Z.sqlite.gz");
		expect(backupTime(backupName(at))).toBe(Date.UTC(2026, 8, 23, 18, 42, 54));
		expect(backupTime("rabbitpay.sqlite")).toBeNull();
		expect(backupTime("../rabbitpay-20260923T184254Z.sqlite.gz")).toBeNull();
	});

	test("finds the database file in every SQLite connection form", () => {
		expect(sqliteFile("sqlite://./data/rabbitpay.sqlite")).toBe("./data/rabbitpay.sqlite");
		expect(sqliteFile("sqlite:///var/lib/rabbitpay.sqlite")).toBe("/var/lib/rabbitpay.sqlite");
		expect(sqliteFile("file:///var/lib/rabbitpay.db")).toBe("/var/lib/rabbitpay.db");
		expect(sqliteFile("./rabbitpay.sqlite")).toBe("./rabbitpay.sqlite");
		expect(sqliteFile("sqlite://:memory:")).toBeNull();
		expect(sqliteFile("postgres://localhost/rabbitpay")).toBeNull();
	});
});

describe("SQLite backups", () => {
	test("stores a compressed snapshot that restores with the same data", async () => {
		const directory = join(workspace, "local");
		const result = await runBackup([new LocalBackupTarget(directory)], new Date(Date.UTC(2026, 0, 1)));

		expect(result.stored).toEqual(["directory"]);
		expect(result.failed).toEqual([]);
		expect(readdirSync(directory)).toEqual([result.name]);

		const compressed = await Bun.file(join(directory, result.name)).bytes();
		const restoredPath = join(workspace, "restored.sqlite");
		writeFileSync(restoredPath, gunzipSync(compressed));
		const restored = new SQLite(restoredPath, { readonly: true });
		expect(restored.query("SELECT username FROM accounts").all()).toEqual([{ username: "backup-user" }]);
		expect(restored.query("SELECT version FROM schema_migrations").all().length).toBeGreaterThan(0);
		restored.close();

		expect(readdirSync(workspace).filter((entry) => entry.startsWith(".rabbitpay-backup-"))).toEqual([]);
	});

	test("keeps only the newest backups in each destination", async () => {
		const directory = join(workspace, "retention");
		const target = new LocalBackupTarget(directory);
		for (let day = 1; day <= 4; day++) await runBackup([target], new Date(Date.UTC(2026, 1, day)));
		writeFileSync(join(directory, "notes.txt"), "not a backup");

		const removed = await prune(target, 2);
		expect(removed).toEqual(["rabbitpay-20260202T000000Z.sqlite.gz", "rabbitpay-20260201T000000Z.sqlite.gz"]);
		expect(readdirSync(directory).sort()).toEqual(["notes.txt", "rabbitpay-20260203T000000Z.sqlite.gz", "rabbitpay-20260204T000000Z.sqlite.gz"]);
	});

	test("one failing destination does not stop the others", async () => {
		const directory = join(workspace, "partial");
		const result = await runBackup([new FailingTarget(), new LocalBackupTarget(directory)], new Date(Date.UTC(2026, 2, 1)));
		expect(result.stored).toEqual(["directory"]);
		expect(result.failed).toEqual([{ target: "failing", error: "bucket unreachable" }]);
		expect(readdirSync(directory)).toHaveLength(1);
	});
});

describe("backup schedule", () => {
	test("does nothing while backups are off", async () => {
		await updateSettings({ "backups.enabled": false });
		resetSchedule();
		expect(await backupIfDue()).toBeNull();
	});

	test("backs up when the newest backup is older than the interval", async () => {
		const directory = join(workspace, "scheduled");
		await updateSettings({
			"backups.enabled": true,
			"backups.destination": "local",
			"backups.local_path": directory,
			"backups.interval_hours": 24,
			"backups.keep": 3,
		});
		resetSchedule();

		const start = Date.UTC(2026, 3, 1, 12);
		expect((await backupIfDue(start))?.stored).toEqual(["directory"]);
		expect(await backupIfDue(start + 60 * 60 * 1000)).toBeNull();

		resetSchedule();
		expect(await backupIfDue(start + 23 * 60 * 60 * 1000)).toBeNull();
		expect((await backupIfDue(start + 25 * 60 * 60 * 1000))?.stored).toEqual(["directory"]);
		expect(readdirSync(directory)).toHaveLength(2);
	});

	test("a manual backup cannot overlap a running one", async () => {
		await updateSettings({ "backups.destination": "local", "backups.local_path": join(workspace, "manual") });
		const first = backupNow(Date.UTC(2026, 4, 1));
		await expect(backupNow(Date.UTC(2026, 4, 1, 0, 0, 1))).rejects.toBeInstanceOf(backups.BackupInProgress);
		expect((await first).stored).toEqual(["directory"]);
	});

	test("S3 needs a bucket before it can be used", async () => {
		await updateSettings({ "backups.destination": "s3", "backups.s3_bucket": "" });
		expect(() => backups.configuredTargets()).toThrow();
		await updateSettings({ "backups.enabled": false, "backups.destination": "local" });
	});
});
