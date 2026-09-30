import type { SQL } from "bun";
import { createHash } from "node:crypto";
import Database from "../database/database";
import { safeInteger } from "../database/numbers";
import { zonedParts } from "../timezone";
import { ensureChart } from "./chart";
import { LedgerPlanner, type PlannedEntry } from "./sources";
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

async function nextNumber(sql: SQL, project: string, year: number): Promise<number> {
	const [row] = (await sql`SELECT MAX(number) AS last FROM journal_entries WHERE project = ${project} AND year = ${year}`) as { last: number | null }[];
	return safeInteger(row?.last ?? 0) + 1;
}

export async function postEntry(
	sql: SQL,
	project: Pick<ProjectRow, "uuid" | "timezone">,
	posting: Posting,
	author: string | null,
	reverses: string | null = null
): Promise<JournalEntryRow> {
	if (!balanced(posting.lines)) throw new UnbalancedEntry();
	const uuid = crypto.randomUUID();
	const year = zonedParts(posting.date, project.timezone).year;
	const number = await nextNumber(sql, project.uuid, year);
	await sql`
		INSERT INTO journal_entries(uuid, project, year, number, entry_date, description, source_type, source_id, reverses, fingerprint, posted_by, created)
		VALUES(${uuid}, ${project.uuid}, ${year}, ${number}, ${posting.date}, ${posting.description}, ${posting.source_type}, ${posting.source_id},
			${reverses}, ${fingerprint(posting)}, ${author}, ${Date.now()})
	`;
	for (const [index, line] of posting.lines.entries()) {
		await sql`
			INSERT INTO journal_lines(uuid, entry, project, ledger_account, debit, credit, partner, sort_order)
			VALUES(${crypto.randomUUID()}, ${uuid}, ${project.uuid}, ${line.ledger_account}, ${line.debit}, ${line.credit}, ${line.partner}, ${index})
		`;
	}
	const [row] = (await sql`SELECT * FROM journal_entries WHERE uuid = ${uuid}`) as JournalEntryRow[];
	return row;
}

export async function reverseEntry(sql: SQL, project: Pick<ProjectRow, "uuid" | "timezone">, entry: JournalEntryRow, author: string | null) {
	const lines = (await sql`SELECT * FROM journal_lines WHERE entry = ${entry.uuid} ORDER BY sort_order`) as JournalLineRow[];
	return await postEntry(
		sql,
		project,
		{
			source_type: entry.source_type,
			source_id: entry.source_id,
			date: entry.entry_date,
			description: `Storno ${entry.year}/${entry.number}: ${entry.description}`.slice(0, 500),
			lines: lines.map((line) => ({ ledger_account: line.ledger_account, debit: line.credit, credit: line.debit, partner: line.partner })),
		},
		author,
		entry.uuid
	);
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

const lastIssues = new Map<string, LedgerIssue[]>();

export function knownIssues(project: string): LedgerIssue[] | null {
	return lastIssues.get(project) ?? null;
}

export function syncLedger(project: ProjectRow): Promise<SyncResult> {
	return withLedger(project.uuid, async () => {
		const result = await synchronize(project);
		lastIssues.set(project.uuid, result.issues);
		return result;
	});
}

async function synchronize(project: ProjectRow): Promise<SyncResult> {
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

	const reversals: JournalEntryRow[] = [];
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
		if (current) reversals.push(current);
		postings.push(posting);
	}
	for (const [key, entry] of active) {
		if (skipped.has(key) || entry.source_type.startsWith("year_")) continue;
		if (inClosedYear(entry.entry_date)) blocked(entry.source_type, entry.source_id);
		else reversals.push(entry);
	}

	if (reversals.length > 0 || postings.length > 0) {
		await Database.begin(async (tx) => {
			for (const entry of reversals) await reverseEntry(tx, project, entry, null);
			for (const posting of postings) await postEntry(tx, project, posting, null);
		});
	}
	return { posted: postings.length, reversed: reversals.length, issues };
}
