import { SQL } from "bun";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { databaseDialect } from "./dialect";
import { migrate } from "./migrations";
import { Logger } from "../logger";
import { numericClient } from "./client";

function connectionString(): string {
	return Bun.env.RABBITPAY_DB || "sqlite://./data/rabbitpay.sqlite";
}

export const databaseConnection = connectionString();
export const dialect = databaseDialect(databaseConnection, Bun.env.RABBITPAY_DB_ENGINE);
if (dialect === "sqlite" && databaseConnection.startsWith("sqlite://") && databaseConnection !== "sqlite://:memory:") {
	mkdirSync(dirname(databaseConnection.slice("sqlite://".length)), { recursive: true });
}
const rawDatabase = new SQL(databaseConnection, dialect === "sqlite" ? { safeIntegers: true } : { bigint: true });
const Database = numericClient(rawDatabase);

function serializeTransactions() {
	const original = rawDatabase.begin.bind(rawDatabase) as (...args: unknown[]) => Promise<unknown>;
	let tail: Promise<unknown> = Promise.resolve();

	const queued = (...args: unknown[]) => {
		const run = tail.then(
			() => original(...args),
			() => original(...args)
		);

		tail = run.then(
			() => undefined,
			() => undefined
		);

		return run;
	};

	rawDatabase.begin = queued as typeof rawDatabase.begin;
}

if (dialect === "sqlite") serializeTransactions();

export function sqliteFile(connection = databaseConnection): string | null {
	if (databaseDialect(connection) !== "sqlite") return null;
	const path = connection
		.replace(/^sqlite:(\/\/)?/, "")
		.replace(/^file:\/\//, "")
		.split("?")[0];
	if (path === "" || path === ":memory:" || path.includes("mode=memory")) return null;
	return path;
}

export async function applyPragmas() {
	if (dialect !== "sqlite") return;
	await Database`PRAGMA journal_mode = WAL`;
	await Database`PRAGMA foreign_keys = ON`;
}

export async function initialize() {
	await applyPragmas();
	const ran = await migrate(Database, dialect);
	if (ran.length > 0) Logger.info(`[DB] Applied schema migrations ${ran.join(", ")}`);
}

export default Database;
