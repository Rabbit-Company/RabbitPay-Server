import Database from "../database/database";
import { addIntegers, safeInteger } from "../database/numbers";
import { endOfLocalDate, startOfLocalDate, zonedParts } from "../timezone";
import { ensureChart } from "./chart";
import { postEntry, reverseEntry, syncLedger, withLedger, type PostingLine } from "./journal";
import type { AccountingYearRow, JournalEntryRow, LedgerAccountRow, ProjectRow } from "../database/models";
import type { AccountingYear, LedgerIssue, YearCloseRefusal } from "./types";

export type { AccountingYear, YearCloseRefusal };

export class YearCloseRefused extends Error {
	constructor(
		readonly reason: YearCloseRefusal,
		readonly issues: LedgerIssue[] = []
	) {
		super(reason);
	}
}

const YEAR_SOURCES = ["year_result", "year_closing", "year_opening"] as const;

function yearBounds(project: ProjectRow, year: number) {
	return {
		from: startOfLocalDate(`${year}-01-01`, project.timezone),
		last: startOfLocalDate(`${year}-12-31`, project.timezone),
		to: endOfLocalDate(`${year}-12-31`, project.timezone),
		next: startOfLocalDate(`${year + 1}-01-01`, project.timezone),
	};
}

async function activeClose(project: string, year: number): Promise<AccountingYearRow | null> {
	const [row] = (await Database`
		SELECT * FROM accounting_years WHERE project = ${project} AND year = ${year} AND reopened_at IS NULL ORDER BY closed_at DESC LIMIT 1
	`) as AccountingYearRow[];
	return row ?? null;
}

async function balancesUntil(project: string, until: number): Promise<Map<string, number>> {
	const rows = (await Database`
		SELECT jl.ledger_account, COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0) AS balance
		FROM journal_lines jl JOIN journal_entries je ON je.uuid = jl.entry
		WHERE jl.project = ${project} AND je.entry_date <= ${until}
		GROUP BY jl.ledger_account
	`) as { ledger_account: string; balance: number }[];
	return new Map(rows.map((row) => [row.ledger_account, safeInteger(row.balance)]).filter(([, balance]) => balance !== 0) as [string, number][]);
}

function zeroing(balances: Map<string, number>, accounts: LedgerAccountRow[], kinds: LedgerAccountRow["account_kind"][]): PostingLine[] {
	const lines: PostingLine[] = [];
	for (const account of accounts) {
		const balance = balances.get(account.uuid) ?? 0;
		if (balance === 0 || !kinds.includes(account.account_kind)) continue;
		lines.push({ ledger_account: account.uuid, debit: balance < 0 ? -balance : 0, credit: balance > 0 ? balance : 0, partner: null });
	}
	return lines;
}

export async function accountingYears(project: ProjectRow): Promise<AccountingYear[]> {
	const counts = (await Database`
		SELECT year, COUNT(*) AS total FROM journal_entries WHERE project = ${project.uuid} GROUP BY year ORDER BY year
	`) as { year: number; total: number }[];
	const closes = (await Database`SELECT * FROM accounting_years WHERE project = ${project.uuid} AND reopened_at IS NULL`) as AccountingYearRow[];
	const results = (await Database`
		SELECT je.year, SUM(jl.credit) - SUM(jl.debit) AS result FROM journal_lines jl
		JOIN journal_entries je ON je.uuid = jl.entry JOIN ledger_accounts la ON la.uuid = jl.ledger_account
		WHERE jl.project = ${project.uuid} AND la.account_kind IN ('revenue', 'expense') AND je.source_type <> 'year_result'
		GROUP BY je.year
	`) as { year: number; result: number }[];
	const shares = (await Database`SELECT year, final_share FROM deductible_shares WHERE project = ${project.uuid}`) as { year: number; final_share: number }[];
	const provisional = (await Database`SELECT expense_date FROM expenses WHERE project = ${project.uuid} AND provisional_share = 1`) as {
		expense_date: number;
	}[];
	const adjustments = (await Database`
		SELECT je.source_id, SUM(jl.debit) - SUM(jl.credit) AS amount FROM journal_lines jl
		JOIN journal_entries je ON je.uuid = jl.entry JOIN ledger_accounts la ON la.uuid = jl.ledger_account
		WHERE jl.project = ${project.uuid} AND je.source_type = 'deductible_share' AND la.system_key = 'input_vat'
		GROUP BY je.source_id
	`) as { source_id: string; amount: number }[];
	const current = zonedParts(Date.now(), project.timezone).year;
	const years = new Set([
		...counts.map((row) => Number(row.year)),
		...closes.map((row) => Number(row.year)),
		...provisional.map((row) => zonedParts(Number(row.expense_date), project.timezone).year),
		current,
	]);
	return [...years]
		.sort((a, b) => b - a)
		.map((year) => {
			const close = closes.find((row) => Number(row.year) === year) ?? null;
			return {
				year,
				entries: Number(counts.find((row) => Number(row.year) === year)?.total ?? 0),
				closed: close !== null,
				closed_at: close?.closed_at ?? null,
				closed_by: close?.closed_by ?? null,
				result: results.find((row) => Number(row.year) === year) ? safeInteger(results.find((row) => Number(row.year) === year)!.result) : null,
				final_share: shares.find((row) => Number(row.year) === year)?.final_share ?? null,
				provisional_expenses: provisional.filter((row) => zonedParts(Number(row.expense_date), project.timezone).year === year).length,
				share_adjustment: (() => {
					const found = adjustments.find((row) => row.source_id === String(year));
					return found ? safeInteger(found.amount) : null;
				})(),
			};
		});
}

export async function closeYear(project: ProjectRow, year: number, author: string): Promise<AccountingYear> {
	const bounds = yearBounds(project, year);
	if (Date.now() <= bounds.to) throw new YearCloseRefused("year_not_over");
	if (await activeClose(project.uuid, year)) throw new YearCloseRefused("already_closed");
	const sync = await syncLedger(project, { force: true });
	const blocking = sync.issues.filter((issue) => issue.code === "missing_exchange_rate");
	if (blocking.length > 0) throw new YearCloseRefused("ledger_issues", blocking);

	return await withLedger(project.uuid, async () => {
		const [earlier] = (await Database`
			SELECT je.year FROM journal_entries je WHERE je.project = ${project.uuid} AND je.year < ${year}
				AND NOT EXISTS (SELECT 1 FROM accounting_years ay WHERE ay.project = je.project AND ay.year = je.year AND ay.reopened_at IS NULL)
			LIMIT 1
		`) as { year: number }[];
		if (earlier) throw new YearCloseRefused("earlier_year_open");
		const [entries] = (await Database`
			SELECT COUNT(*) AS total FROM journal_entries WHERE project = ${project.uuid} AND entry_date BETWEEN ${bounds.from} AND ${bounds.to}
		`) as { total: number }[];
		if (Number(entries.total) === 0) throw new YearCloseRefused("nothing_to_close");

		const chart = await ensureChart(project.uuid);
		await Database.begin(async (tx) => {
			const before = await balancesUntil(project.uuid, bounds.to);
			const result = zeroing(before, chart.accounts, ["revenue", "expense"]);
			const net = result.reduce((sum, line) => addIntegers(sum, line.debit, -line.credit), 0);
			const sole = project.bookkeeping !== "company";
			if (result.length > 0 && net !== 0) {
				const target = chart.system(sole ? (net > 0 ? "sole_income" : "sole_loss") : net > 0 ? "current_result" : "current_loss");
				result.push({ ledger_account: target.uuid, debit: net < 0 ? -net : 0, credit: net > 0 ? net : 0, partner: null });
			}
			if (result.length >= 2) {
				await postEntry(
					tx,
					project,
					{ source_type: "year_result", source_id: String(year), date: bounds.last, description: `Ugotovitev poslovnega izida ${year}`, lines: result },
					author
				);
			}

			const after = await balancesUntil(project.uuid, bounds.to);
			const closing = zeroing(after, chart.accounts, ["asset", "liability", "equity"]);
			if (closing.length >= 2) {
				await postEntry(
					tx,
					project,
					{ source_type: "year_closing", source_id: String(year), date: bounds.last, description: `Zaključni list ${year}`, lines: closing },
					author
				);
				const carried = new Map([
					[chart.system("current_result").uuid, chart.system("retained_earnings").uuid],
					[chart.system("current_loss").uuid, chart.system("carried_loss").uuid],
					...(sole
						? (["sole_income", "sole_loss", "household_flows", "sole_transfers"] as const).map(
								(key) => [chart.system(key).uuid, chart.system("sole_capital").uuid] as [string, string]
							)
						: []),
				]);
				const opening = closing.map((line) => ({
					ledger_account: carried.get(line.ledger_account) ?? line.ledger_account,
					debit: line.credit,
					credit: line.debit,
					partner: null,
				}));
				await postEntry(
					tx,
					project,
					{ source_type: "year_opening", source_id: String(year + 1), date: bounds.next, description: `Otvoritveni list ${year + 1}`, lines: opening },
					author
				);
			}
			await tx`
				INSERT INTO accounting_years(uuid, project, year, closed_by, closed_at) VALUES(${crypto.randomUUID()}, ${project.uuid}, ${year}, ${author}, ${Date.now()})
			`;
		});
		return (await accountingYears(project)).find((row) => row.year === year)!;
	});
}

export async function reopenYear(project: ProjectRow, year: number, author: string, reason: string): Promise<AccountingYear> {
	const close = await activeClose(project.uuid, year);
	if (!close) throw new YearCloseRefused("nothing_to_close");
	if (await activeClose(project.uuid, year + 1)) throw new YearCloseRefused("later_year_closed");
	return await withLedger(project.uuid, async () => {
		await Database.begin(async (tx) => {
			const entries = (await tx`
				SELECT * FROM journal_entries e WHERE e.project = ${project.uuid} AND e.reverses IS NULL
					AND ((e.source_type IN ${tx(YEAR_SOURCES.slice(0, 2))} AND e.source_id = ${String(year)})
						OR (e.source_type = 'year_opening' AND e.source_id = ${String(year + 1)}))
					AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses = e.uuid)
				ORDER BY e.number DESC
			`) as JournalEntryRow[];
			for (const entry of entries) await reverseEntry(tx, project, entry, author);
			await tx`
				UPDATE accounting_years SET reopened_at = ${Date.now()}, reopened_by = ${author}, reopen_reason = ${reason} WHERE uuid = ${close.uuid}
			`;
		});
		return (await accountingYears(project)).find((row) => row.year === year)!;
	});
}
