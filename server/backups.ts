import { Database as SQLite } from "bun:sqlite";
import { S3Client } from "bun";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { BACKUP_CONTEXT, sealFile } from "./crypto/sealed-file";
import { dialect, sqliteFile } from "./database/database";
import { Settings } from "./settings";
import { Logger } from "./logger";

const BACKUP_NAME = /^rabbitpay-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.sqlite\.gz(?:\.enc)?$/;
const STAGING_PREFIX = ".rabbitpay-backup-";
const RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000;

export interface BackupTarget {
	readonly name: string;
	list(): Promise<string[]>;
	upload(name: string, source: string): Promise<void>;
	remove(name: string): Promise<void>;
}

export interface BackupResult {
	name: string;
	size: number;
	stored: string[];
	failed: { target: string; error: string }[];
}

export function backupName(at: Date): string {
	return `rabbitpay-${at
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "")}.sqlite.gz`;
}

export function backupTime(name: string): number | null {
	const match = name.match(BACKUP_NAME);
	if (!match) return null;
	const [, year, month, day, hour, minute, second] = match.map(Number);
	return Date.UTC(year, month - 1, day, hour, minute, second);
}

function newestFirst(names: string[]): string[] {
	return names.filter((name) => backupTime(name) !== null).sort((left, right) => backupTime(right)! - backupTime(left)!);
}

export class LocalBackupTarget implements BackupTarget {
	readonly name = "directory";
	readonly root: string;

	constructor(path: string) {
		this.root = resolve(path);
	}

	async list(): Promise<string[]> {
		try {
			return newestFirst(await readdir(this.root));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	async upload(name: string, source: string): Promise<void> {
		await mkdir(this.root, { recursive: true });
		const target = join(this.root, name);
		const temporary = join(this.root, `${STAGING_PREFIX}${crypto.randomUUID()}.tmp`);
		try {
			await Bun.write(temporary, Bun.file(source));
			await rename(temporary, target);
		} catch (error) {
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
	}

	async remove(name: string): Promise<void> {
		if (backupTime(name) === null) throw new Error("Refusing to delete a file that is not a backup");
		await unlink(join(this.root, name));
	}
}

export class S3BackupTarget implements BackupTarget {
	readonly name = "s3";
	private readonly client: S3Client;
	private readonly prefix: string;

	constructor(options: { bucket: string; region?: string; endpoint?: string; accessKeyId?: string; secretAccessKey?: string; prefix?: string }) {
		if (!options.bucket) throw new Error("An S3 bucket is required for S3 backups");
		this.client = new S3Client({
			bucket: options.bucket,
			region: options.region || undefined,
			endpoint: options.endpoint || undefined,
			accessKeyId: options.accessKeyId || undefined,
			secretAccessKey: options.secretAccessKey || undefined,
		});
		this.prefix = options.prefix ?? "";
	}

	async list(): Promise<string[]> {
		const names: string[] = [];
		let continuationToken: string | undefined;
		do {
			const page = await this.client.list({ prefix: this.prefix, continuationToken });
			for (const entry of page.contents ?? []) names.push(entry.key.slice(this.prefix.length));
			continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
		} while (continuationToken);
		return newestFirst(names);
	}

	async upload(name: string, source: string): Promise<void> {
		const sealed = join(dirname(source), `${STAGING_PREFIX}${crypto.randomUUID()}.enc`);
		try {
			await sealFile(source, sealed, BACKUP_CONTEXT);
			await this.client.write(`${this.prefix}${name}.enc`, Bun.file(sealed), { type: "application/octet-stream" });
		} finally {
			await removeQuietly(sealed);
		}
	}

	async remove(name: string): Promise<void> {
		if (backupTime(name) === null) throw new Error("Refusing to delete an object that is not a backup");
		await this.client.delete(`${this.prefix}${name}`);
	}
}

export function configuredTargets(): BackupTarget[] {
	const backups = Settings.backups;
	const targets: BackupTarget[] = [];
	if (backups.destination === "local" || backups.destination === "both") targets.push(new LocalBackupTarget(backups.local_path || "./data/backups"));
	if (backups.destination === "s3" || backups.destination === "both") {
		targets.push(
			new S3BackupTarget({
				bucket: backups.s3_bucket,
				region: backups.s3_region,
				endpoint: backups.s3_endpoint,
				accessKeyId: backups.s3_access_key_id,
				secretAccessKey: backups.s3_secret_access_key,
				prefix: backups.s3_prefix,
			})
		);
	}
	return targets;
}

export function backupsSupported(): boolean {
	return dialect === "sqlite" && sqliteFile() !== null;
}

async function removeQuietly(path: string) {
	await unlink(path).catch(() => undefined);
}

export async function clearStaging(directory: string) {
	const entries = await readdir(directory).catch(() => [] as string[]);
	for (const entry of entries) {
		if (entry.startsWith(STAGING_PREFIX)) await removeQuietly(join(directory, entry));
	}
}

export async function snapshot(database: string, directory: string): Promise<string> {
	await mkdir(directory, { recursive: true });
	const id = crypto.randomUUID();
	const raw = join(directory, `${STAGING_PREFIX}${id}.sqlite`);
	const compressed = join(directory, `${STAGING_PREFIX}${id}.sqlite.gz`);

	try {
		const source = new SQLite(database, { readonly: true });
		try {
			source.run(`VACUUM INTO '${raw.replaceAll("'", "''")}'`);
		} finally {
			source.close();
		}

		const copy = new SQLite(raw, { readonly: true });
		try {
			const [check] = copy.query("PRAGMA quick_check").values() as [string][];
			if (check?.[0] !== "ok") throw new Error(`The snapshot failed its integrity check: ${check?.[0] ?? "no result"}`);
		} finally {
			copy.close();
		}

		await pipeline(createReadStream(raw), createGzip({ level: 6 }), createWriteStream(compressed));
		return compressed;
	} catch (error) {
		await removeQuietly(compressed);
		throw error;
	} finally {
		await removeQuietly(raw);
	}
}

export async function prune(target: BackupTarget, keep: number): Promise<string[]> {
	const expired = (await target.list()).slice(Math.max(keep, 1));
	for (const name of expired) await target.remove(name);
	return expired;
}

export async function runBackup(targets: BackupTarget[] = configuredTargets(), now = new Date()): Promise<BackupResult> {
	const database = sqliteFile();
	if (dialect !== "sqlite" || database === null) throw new Error("Automatic backups only cover a SQLite database file");
	if (targets.length === 0) throw new Error("No backup destination is configured");

	const name = backupName(now);
	const staging = dirname(resolve(database));
	const archive = await snapshot(database, staging);

	try {
		const size = (await stat(archive)).size;
		const stored: string[] = [];
		const failed: { target: string; error: string }[] = [];

		for (const target of targets) {
			try {
				await target.upload(name, archive);
				stored.push(target.name);
			} catch (error) {
				failed.push({ target: target.name, error: error instanceof Error ? error.message : String(error) });
				continue;
			}
			try {
				const removed = await prune(target, Settings.backups.keep);
				if (removed.length > 0) Logger.info(`[BACKUP] Deleted ${removed.length} old backups from ${target.name}`);
			} catch (error) {
				Logger.warn(`[BACKUP] Could not delete old backups from ${target.name}: ${error}`);
			}
		}

		return { name, size, stored, failed };
	} finally {
		await removeQuietly(archive);
	}
}

export async function latestBackups(targets: BackupTarget[] = configuredTargets()) {
	return await Promise.all(
		targets.map(async (target) => {
			try {
				const names = await target.list();
				return { target: target.name, backups: names.map((name) => ({ name, created: backupTime(name)! })) };
			} catch (error) {
				return { target: target.name, backups: [], error: error instanceof Error ? error.message : String(error) };
			}
		})
	);
}

let newestKnown: number | null = null;
let retryAt = 0;
let unsupportedLogged = false;
let active: Promise<BackupResult> | null = null;

export class BackupInProgress extends Error {
	constructor() {
		super("A backup is already running");
	}
}

export function backupRunning(): boolean {
	return active !== null;
}

function logResult(result: BackupResult) {
	for (const failure of result.failed) Logger.error(`[BACKUP] Could not store ${result.name} in ${failure.target}: ${failure.error}`);
	if (result.stored.length > 0) Logger.info(`[BACKUP] Stored ${result.name} (${result.size} bytes) in ${result.stored.join(" and ")}`);
}

async function exclusive(targets: BackupTarget[], at: number): Promise<BackupResult> {
	if (active) throw new BackupInProgress();
	active = runBackup(targets, new Date(at));
	try {
		const result = await active;
		logResult(result);
		if (result.failed.length === 0) {
			newestKnown = at;
			retryAt = 0;
		} else {
			retryAt = at + RETRY_AFTER_FAILURE_MS;
		}
		return result;
	} finally {
		active = null;
	}
}

export async function backupNow(now = Date.now()): Promise<BackupResult> {
	return await exclusive(configuredTargets(), now);
}

export function resetSchedule() {
	newestKnown = null;
	retryAt = 0;
}

async function oldestNewestBackup(targets: BackupTarget[]): Promise<number> {
	let oldest = Infinity;
	for (const target of targets) {
		const [newest] = await target.list();
		oldest = Math.min(oldest, newest ? backupTime(newest)! : 0);
	}
	return oldest === Infinity ? 0 : oldest;
}

export async function backupIfDue(now = Date.now()): Promise<BackupResult | null> {
	if (!Settings.backups.enabled) return null;
	if (!backupsSupported()) {
		if (!unsupportedLogged) Logger.warn(`[BACKUP] Automatic backups are on but only cover SQLite, use the ${dialect} backup tooling instead`);
		unsupportedLogged = true;
		return null;
	}
	if (now < retryAt || active) return null;

	const targets = configuredTargets();
	const database = sqliteFile()!;
	if (newestKnown === null) {
		await clearStaging(dirname(resolve(database)));
		for (const target of targets) if (target instanceof LocalBackupTarget) await clearStaging(target.root);
		newestKnown = await oldestNewestBackup(targets);
	}
	if (now - newestKnown < Settings.backups.interval_hours * 60 * 60 * 1000) return null;

	return await exclusive(targets, now);
}

export function recordFailure(now = Date.now()) {
	retryAt = now + RETRY_AFTER_FAILURE_MS;
}
