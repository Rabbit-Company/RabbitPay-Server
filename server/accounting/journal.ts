import type { SQL } from "bun";
import { createHash } from "node:crypto";
import Database from "../database/database";
import { safeInteger } from "../database/numbers";
import { localDate, zonedParts } from "../timezone";
import { ensureChart } from "./chart";
import { LedgerPlanner, type OpenItemMovement, type PlannedEntry } from "./sources";
import type { LedgerIssue } from "./types";
import type { JournalEntryRow, JournalLineRow, JournalSourceType, ProjectRow } from "../database/models";

export interface PostingLine {
	ledger_account: string;
	debit: number;
	credit: number;
	partner: string | null;
}

export interface Posting {
	source_type: JournalSourceType;
	source_id: string;
	date: number;
	description: string;
	lines: PostingLine[];
}

export class UnbalancedEntry extends Error {
	constructor() {
		super("A journal entry must have equal debits and credits.");
	}
}

export function balanced(lines: PostingLine[]): boolean {
	if (lines.length < 2) return false;
	let debit = 0;
	let credit = 0;
	for (const line of lines) {
		if (!Number.isSafeInteger(line.debit) || !Number.isSafeInteger(line.credit) || line.debit < 0 || line.credit < 0) return false;
		if ((line.debit === 0) === (line.credit === 0)) return false;
		debit += line.debit;
		credit += line.credit;
	}
	return debit === credit && Number.isSafeInteger(debit);
}

export function fingerprint(posting: Pick<Posting, "date" | "description" | "lines">): string {
	const lines = posting.lines
		.map((line) => [line.ledger_account, line.debit, line.credit, line.partner ?? ""].join("|"))
		.sort()
		.join("\n");
	return createHash("sha256").update(`${posting.date}\n${posting.description}\n${lines}`).digest("hex");
}

const BATCH = 500;

interface PendingEntry {
	posting: Posting;
	reverses: string | null;
}

const ENTRY_COLUMNS = [
	"uuid",
	"project",
	"year",
	"number",
	"entry_date",
	"description",
	"source_type",
	"source_id",
	"reverses",
	"fingerprint",
	"posted_by",
	"created",
] as const satisfies (keyof JournalEntryRow)[];
const LINE_COLUMNS = ["uuid", "entry", "project", "ledger_account", "debit", "credit", "partner", "sort_order"] as const satisfies (keyof JournalLineRow)[];

async function postEntries(
	sql: SQL,
	project: Pick<ProjectRow, "uuid" | "timezone">,
	pending: PendingEntry[],
	author: string | null
): Promise<JournalEntryRow[]> {
	if (pending.length === 0) return [];
	for (const { posting } of pending) if (!balanced(posting.lines)) throw new UnbalancedEntry();
	const years = [...new Set(pending.map(({ posting }) => zonedParts(posting.date, project.timezone).year))];
	const last = (await sql`
		SELECT year, MAX(number) AS last FROM journal_entries WHERE project = ${project.uuid} AND year IN ${sql(years)} GROUP BY year
	`) as { year: number; last: number | null }[];
	const next = new Map(years.map((year) => [year, safeInteger(last.find((row) => Number(row.year) === year)?.last ?? 0) + 1]));
	const created = Date.now();
	const entries: JournalEntryRow[] = [];
	const lines: JournalLineRow[] = [];
	for (const { posting, reverses } of pending) {
		const year = zonedParts(posting.date, project.timezone).year;
		const number = next.get(year)!;
		next.set(year, number + 1);
		const entry: JournalEntryRow = {
			uuid: crypto.randomUUID(),
			project: project.uuid,
			year,
			number,
			entry_date: posting.date,
			description: posting.description,
			source_type: posting.source_type,
			source_id: posting.source_id,
			reverses,
			fingerprint: fingerprint(posting),
			posted_by: author,
			created,
		};
		entries.push(entry);
		for (const [index, line] of posting.lines.entries()) {
			lines.push({
				uuid: crypto.randomUUID(),
				entry: entry.uuid,
				project: project.uuid,
				ledger_account: line.ledger_account,
				debit: line.debit,
				credit: line.credit,
				partner: line.partner,
				sort_order: index,
			});
		}
	}
	for (let start = 0; start < entries.length; start += BATCH) {
		await sql`INSERT INTO journal_entries ${sql(
			entries.slice(start, start + BATCH).map((row) => ({ ...row })),
			...ENTRY_COLUMNS
		)}`;
	}
	for (let start = 0; start < lines.length; start += BATCH) {
		await sql`INSERT INTO journal_lines ${sql(
			lines.slice(start, start + BATCH).map((row) => ({ ...row })),
			...LINE_COLUMNS
		)}`;
	}
	return entries;
}

export async function postEntry(
	sql: SQL,
	project: Pick<ProjectRow, "uuid" | "timezone">,
	posting: Posting,
	author: string | null,
	reverses: string | null = null
): Promise<JournalEntryRow> {
	const [entry] = await postEntries(sql, project, [{ posting, reverses }], author);
	return entry;
}

async function reversals(sql: SQL, entries: JournalEntryRow[]): Promise<PendingEntry[]> {
	const lines = new Map<string, JournalLineRow[]>();
	for (let start = 0; start < entries.length; start += BATCH) {
		const ids = entries.slice(start, start + BATCH).map((entry) => entry.uuid);
		const rows = (await sql`SELECT * FROM journal_lines WHERE entry IN ${sql(ids)} ORDER BY entry, sort_order`) as JournalLineRow[];
		for (const row of rows) lines.set(row.entry, [...(lines.get(row.entry) ?? []), row]);
	}
	return entries.map((entry) => ({
		reverses: entry.uuid,
		posting: {
			source_type: entry.source_type,
			source_id: entry.source_id,
			date: entry.entry_date,
			description: `Storno ${entry.year}/${entry.number}: ${entry.description}`.slice(0, 500),
			lines: (lines.get(entry.uuid) ?? []).map((line) => ({
				ledger_account: line.ledger_account,
				debit: safeInteger(line.credit),
				credit: safeInteger(line.debit),
				partner: line.partner,
			})),
		},
	}));
}

export async function reverseEntry(sql: SQL, project: Pick<ProjectRow, "uuid" | "timezone">, entry: JournalEntryRow, author: string | null) {
	const [storno] = await postEntries(sql, project, await reversals(sql, [entry]), author);
	return storno;
}

export async function activeEntries(project: string, sql: SQL = Database): Promise<JournalEntryRow[]> {
	return (await sql`
		SELECT * FROM journal_entries e WHERE e.project = ${project} AND e.reverses IS NULL
			AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses = e.uuid)
	`) as JournalEntryRow[];
}

function toPosting(entry: PlannedEntry): Posting {
	return {
		source_type: entry.source_type,
		source_id: entry.source_id,
		date: entry.date,
		description: entry.description.slice(0, 500),
		lines: entry.lines.map((line) => ({ ledger_account: line.account.uuid, debit: line.debit, credit: line.credit, partner: line.partner })),
	};
}

export interface SyncResult {
	posted: number;
	reversed: number;
	issues: LedgerIssue[];
}

const queues = new Map<string, Promise<unknown>>();

export function withLedger<T>(project: string, task: () => Promise<T>): Promise<T> {
	const previous = queues.get(project) ?? Promise.resolve();
	const next = previous.catch(() => null).then(task);
	queues.set(project, next);
	void next
		.catch(() => null)
		.finally(() => {
			if (queues.get(project) === next) queues.delete(project);
		});
	return next;
}

const synced = new Map<string, { stamp: string; issues: LedgerIssue[]; movements: OpenItemMovement[] }>();

export function knownIssues(project: string): LedgerIssue[] | null {
	return synced.get(project)?.issues ?? null;
}

async function changeStamp(project: ProjectRow): Promise<string> {
	const uuid = project.uuid;
	const [sources] = await Database`
		SELECT
			(SELECT COUNT(*) FROM invoices WHERE project = ${uuid}) AS invoices,
			(SELECT COUNT(issued_at) FROM invoices WHERE project = ${uuid}) AS invoices_issued,
			(SELECT MAX(updated) FROM invoices WHERE project = ${uuid}) AS invoices_updated,
			(SELECT COUNT(*) FROM credit_notes WHERE project = ${uuid}) AS credit_notes,
			(SELECT COUNT(*) FROM transactions WHERE project = ${uuid}) AS transactions,
			(SELECT COUNT(base_amount) FROM transactions WHERE project = ${uuid}) AS transactions_valued,
			(SELECT MAX(updated) FROM transactions WHERE project = ${uuid}) AS transactions_updated,
			(SELECT COUNT(*) FROM expenses WHERE project = ${uuid}) AS expenses,
			(SELECT MAX(updated) FROM expenses WHERE project = ${uuid}) AS expenses_updated,
			(SELECT COUNT(*) FROM recorded_invoices WHERE project = ${uuid}) AS recorded,
			(SELECT MAX(updated) FROM recorded_invoices WHERE project = ${uuid}) AS recorded_updated,
			(SELECT COUNT(*) FROM bank_transactions WHERE project = ${uuid}) AS bank_lines,
			(SELECT SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) FROM bank_transactions WHERE project = ${uuid}) AS bank_open,
			(SELECT MAX(matched_at) FROM bank_transactions WHERE project = ${uuid}) AS bank_matched,
			(SELECT COUNT(*) FROM bank_transaction_matches WHERE project = ${uuid}) AS bank_matches,
			(SELECT COUNT(*) FROM fixed_assets WHERE project = ${uuid}) AS assets,
			(SELECT MAX(updated) FROM fixed_assets WHERE project = ${uuid}) AS assets_updated,
			(SELECT COUNT(*) FROM payroll_runs WHERE project = ${uuid}) AS payroll,
			(SELECT MAX(updated) FROM payroll_runs WHERE project = ${uuid}) AS payroll_updated,
			(SELECT COUNT(*) FROM deductible_shares WHERE project = ${uuid}) AS shares,
			(SELECT MAX(updated) FROM deductible_shares WHERE project = ${uuid}) AS shares_updated,
			(SELECT COUNT(*) FROM ledger_accounts WHERE project = ${uuid}) AS accounts,
			(SELECT MAX(updated) FROM ledger_accounts WHERE project = ${uuid}) AS accounts_updated,
			(SELECT COUNT(*) FROM ledger_category_accounts WHERE project = ${uuid}) AS categories,
			(SELECT MAX(updated) FROM ledger_category_accounts WHERE project = ${uuid}) AS categories_updated,
			(SELECT COUNT(*) FROM accounting_years WHERE project = ${uuid}) AS years,
			(SELECT MAX(closed_at) FROM accounting_years WHERE project = ${uuid}) AS years_closed,
			(SELECT MAX(reopened_at) FROM accounting_years WHERE project = ${uuid}) AS years_reopened
	`;
	const settings = [project.currency, project.tax_currency, project.tax_country, project.timezone, project.bookkeeping];
	return JSON.stringify([sources, settings, localDate(Date.now(), project.timezone)]);
}

export function syncLedger(project: ProjectRow, options: { force?: boolean } = {}): Promise<SyncResult> {
	return withLedger(project.uuid, async () => {
		const previous = synced.get(project.uuid);
		if (!previous) await ensureChart(project.uuid);
		const stamp = await changeStamp(project);
		if (!options.force && previous?.stamp === stamp) return { posted: 0, reversed: 0, issues: previous.issues };
		const { result, movements } = await synchronize(project);
		synced.set(project.uuid, { stamp, issues: result.issues, movements });
		return result;
	});
}

export async function ledgerMovements(project: ProjectRow): Promise<OpenItemMovement[]> {
	await syncLedger(project);
	return synced.get(project.uuid)?.movements ?? [];
}

async function synchronize(project: ProjectRow): Promise<{ result: SyncResult; movements: OpenItemMovement[] }> {
	const chart = await ensureChart(project.uuid);
	const planner = new LedgerPlanner(project, chart);
	await planner.plan();
	const planned = planner.entries
		.filter((entry) => entry.lines.length > 0)
		.map(toPosting)
		.sort((a, b) => a.date - b.date || a.source_type.localeCompare(b.source_type) || a.source_id.localeCompare(b.source_id));
	const skipped = new Set(planner.issues.filter((issue) => issue.code === "missing_exchange_rate").map((issue) => `${issue.source_type}:${issue.source_id}`));
	const active = new Map(
		(await activeEntries(project.uuid))
			.filter((entry) => entry.source_type !== "manual" && !entry.source_type.startsWith("year_"))
			.map((entry) => [`${entry.source_type}:${entry.source_id}`, entry])
	);

	const closed = new Set(
		((await Database`SELECT year FROM accounting_years WHERE project = ${project.uuid} AND reopened_at IS NULL`) as { year: number }[]).map((row) =>
			Number(row.year)
		)
	);
	const inClosedYear = (date: number) => closed.has(zonedParts(date, project.timezone).year);
	const issues = [...planner.issues];
	const blocked = (source_type: Posting["source_type"], source_id: string) => {
		if (!issues.some((issue) => issue.source_type === source_type && issue.source_id === source_id && issue.code === "closed_year"))
			issues.push({ source_type, source_id, reference: null, code: "closed_year" });
	};

	const reversed: JournalEntryRow[] = [];
	const postings: Posting[] = [];
	for (const posting of planned) {
		const key = `${posting.source_type}:${posting.source_id}`;
		const current = active.get(key);
		active.delete(key);
		if (current?.fingerprint === fingerprint(posting)) continue;
		if ((current && inClosedYear(current.entry_date)) || inClosedYear(posting.date)) {
			blocked(posting.source_type, posting.source_id);
			continue;
		}
		if (current) reversed.push(current);
		postings.push(posting);
	}
	for (const [key, entry] of active) {
		if (skipped.has(key) || entry.source_type.startsWith("year_")) continue;
		if (inClosedYear(entry.entry_date)) blocked(entry.source_type, entry.source_id);
		else reversed.push(entry);
	}

	if (reversed.length > 0 || postings.length > 0) {
		await Database.begin(async (tx) => {
			const pending = [...(await reversals(tx, reversed)), ...postings.map((posting) => ({ posting, reverses: null }))];
			await postEntries(tx, project, pending, null);
		});
	}
	return { result: { posted: postings.length, reversed: reversed.length, issues }, movements: planner.movements };
}
