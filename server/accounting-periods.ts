import type { SQL } from "bun";
import Database from "./database/database";
import type { AccountingPeriodLockRow, ProjectRow } from "./database/models";
import { zonedParts } from "./timezone";

export async function accountingPeriodLock(project: string, timestamp: number, sql: SQL = Database): Promise<AccountingPeriodLockRow | null> {
	const [row] = (await sql`
		SELECT * FROM accounting_period_locks
		WHERE project = ${project} AND unlocked_at IS NULL AND period_from <= ${timestamp} AND period_to >= ${timestamp}
		ORDER BY locked_at DESC LIMIT 1
	`) as AccountingPeriodLockRow[];
	return row ?? null;
}

export async function closedYear(project: string, timestamp: number, sql: SQL = Database): Promise<boolean> {
	const [row] = (await sql`SELECT timezone FROM projects WHERE uuid = ${project}`) as Pick<ProjectRow, "timezone">[];
	if (!row) return false;
	const year = zonedParts(timestamp, row.timezone).year;
	const [closed] = await sql`SELECT 1 AS closed FROM accounting_years WHERE project = ${project} AND year = ${year} AND reopened_at IS NULL LIMIT 1`;
	return closed !== undefined;
}

export async function accountingPeriodLocked(project: string, timestamp: number, sql: SQL = Database): Promise<boolean> {
	return (await accountingPeriodLock(project, timestamp, sql)) !== null || (await closedYear(project, timestamp, sql));
}

export class AccountingPeriodLocked extends Error {
	constructor() {
		super("This accounting period is locked after a DDV submission or a year end close.");
	}
}

export async function assertAccountingPeriodUnlocked(project: string, timestamp: number, sql: SQL = Database) {
	if (await accountingPeriodLocked(project, timestamp, sql)) throw new AccountingPeriodLocked();
}

export async function createAccountingPeriodLock(
	sql: SQL,
	value: { project: string; from: number; to: number; timezone: string; sourceId: string; account: string | null; timestamp: number }
): Promise<AccountingPeriodLockRow> {
	const [existing] = (await sql`
		SELECT * FROM accounting_period_locks
		WHERE project = ${value.project} AND unlocked_at IS NULL AND period_from = ${value.from} AND period_to = ${value.to}
		ORDER BY locked_at DESC LIMIT 1
	`) as AccountingPeriodLockRow[];
	if (existing) return existing;
	const uuid = crypto.randomUUID();
	await sql`
		INSERT INTO accounting_period_locks(uuid, project, period_from, period_to, timezone, source, source_id, locked_by, locked_at)
		VALUES(${uuid}, ${value.project}, ${value.from}, ${value.to}, ${value.timezone}, 'ddv_export', ${value.sourceId}, ${value.account}, ${value.timestamp})
	`;
	const [created] = (await sql`SELECT * FROM accounting_period_locks WHERE uuid = ${uuid}`) as AccountingPeriodLockRow[];
	return created;
}

export function presentAccountingPeriodLock(row: AccountingPeriodLockRow) {
	return { ...row, active: row.unlocked_at === null };
}
