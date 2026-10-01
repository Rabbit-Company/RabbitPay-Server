import Database from "../database/database";
import { addIntegers, safeInteger } from "../database/numbers";
import type { JournalEntryRow, JournalLineRow, LedgerAccountRow } from "../database/models";
import type { AccountLedgerRow, JournalEntryView, JournalFilters, JournalLineView, TrialBalanceRow } from "./types";

async function linesOf(entries: string[]): Promise<Map<string, JournalLineView[]>> {
	const result = new Map<string, JournalLineView[]>();
	if (entries.length === 0) return result;
	const rows = (await Database`
		SELECT jl.entry, jl.ledger_account, jl.debit, jl.credit, jl.partner, la.code, la.name FROM journal_lines jl
		JOIN ledger_accounts la ON la.uuid = jl.ledger_account
		WHERE jl.entry IN ${Database(entries)} ORDER BY jl.entry, jl.sort_order
	`) as (Pick<JournalLineRow, "entry" | "ledger_account" | "debit" | "credit" | "partner"> & { code: string; name: string })[];
	for (const row of rows) {
		const lines = result.get(row.entry) ?? [];
		lines.push({
			account: row.ledger_account,
			code: row.code,
			name: row.name,
			debit: safeInteger(row.debit),
			credit: safeInteger(row.credit),
			partner: row.partner,
		});
		result.set(row.entry, lines);
	}
	return result;
}

export function journalFilter(filters: JournalFilters) {
	const parts = [
		filters.account ? Database`AND EXISTS (SELECT 1 FROM journal_lines fl WHERE fl.entry = e.uuid AND fl.ledger_account = ${filters.account})` : Database``,
		filters.source ? Database`AND e.source_type = ${filters.source}` : Database``,
		filters.text
			? Database`AND (LOWER(e.description) LIKE ${`%${filters.text.toLowerCase()}%`}
				OR EXISTS (SELECT 1 FROM journal_lines fl WHERE fl.entry = e.uuid AND LOWER(fl.partner) LIKE ${`%${filters.text.toLowerCase()}%`}))`
			: Database``,
		filters.amount !== null
			? Database`AND EXISTS (SELECT 1 FROM journal_lines fl WHERE fl.entry = e.uuid AND (fl.debit = ${filters.amount} OR fl.credit = ${filters.amount}))`
			: Database``,
	];
	return Database`${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]}`;
}

async function invoicesOf(entries: JournalEntryRow[]): Promise<Map<string, string>> {
	const notes = entries.filter((entry) => entry.source_type === "credit_note").map((entry) => entry.source_id);
	const payments = entries.filter((entry) => entry.source_type === "payment" || entry.source_type === "refund").map((entry) => entry.source_id);
	const rows = [
		...(notes.length ? ((await Database`SELECT uuid, invoice FROM credit_notes WHERE uuid IN ${Database(notes)}`) as { uuid: string; invoice: string }[]) : []),
		...(payments.length
			? ((await Database`SELECT uuid, invoice FROM transactions WHERE uuid IN ${Database(payments)}`) as { uuid: string; invoice: string }[])
			: []),
	];
	return new Map(rows.map((row) => [row.uuid, row.invoice]));
}

export async function journal(project: string, from: number, to: number, limit: number, offset: number, filters: JournalFilters) {
	const entries = (await Database`
		SELECT e.*, r.uuid AS reversed_by FROM journal_entries e
		LEFT JOIN journal_entries r ON r.reverses = e.uuid
		WHERE e.project = ${project} AND e.entry_date BETWEEN ${from} AND ${to} ${journalFilter(filters)}
		ORDER BY e.year, e.number LIMIT ${limit} OFFSET ${offset}
	`) as (JournalEntryRow & { reversed_by: string | null })[];
	const [count] = (await Database`
		SELECT COUNT(*) AS total FROM journal_entries e WHERE e.project = ${project} AND e.entry_date BETWEEN ${from} AND ${to} ${journalFilter(filters)}
	`) as { total: number }[];
	const lines = await linesOf(entries.map((entry) => entry.uuid));
	const invoices = await invoicesOf(entries);
	return {
		entries: entries.map(
			(entry): JournalEntryView => ({
				...entry,
				lines: lines.get(entry.uuid) ?? [],
				invoice: entry.source_type === "invoice" ? entry.source_id : (invoices.get(entry.source_id) ?? null),
			})
		),
		total: Number(count.total),
		limit,
		offset,
	};
}

export async function journalEntry(project: string, uuid: string): Promise<JournalEntryView | null> {
	const [entry] = (await Database`
		SELECT e.*, r.uuid AS reversed_by FROM journal_entries e
		LEFT JOIN journal_entries r ON r.reverses = e.uuid
		WHERE e.project = ${project} AND e.uuid = ${uuid}
	`) as (JournalEntryRow & { reversed_by: string | null })[];
	if (!entry) return null;
	const invoice = entry.source_type === "invoice" ? entry.source_id : ((await invoicesOf([entry])).get(entry.source_id) ?? null);
	return { ...entry, lines: (await linesOf([entry.uuid])).get(entry.uuid) ?? [], invoice };
}

export function signedBalance(kind: LedgerAccountRow["account_kind"], debit: number, credit: number): number {
	return kind === "asset" || kind === "expense" ? addIntegers(debit, -credit) : addIntegers(credit, -debit);
}

export async function trialBalance(project: string, from: number, to: number, yearStart: number): Promise<TrialBalanceRow[]> {
	const accounts = (await Database`SELECT * FROM ledger_accounts WHERE project = ${project} ORDER BY code`) as LedgerAccountRow[];
	const totals = (await Database`
		SELECT jl.ledger_account,
			COALESCE(SUM(CASE WHEN je.entry_date < ${from} OR je.source_type = 'year_opening' THEN jl.debit ELSE 0 END), 0) AS opening_debit,
			COALESCE(SUM(CASE WHEN je.entry_date < ${from} OR je.source_type = 'year_opening' THEN jl.credit ELSE 0 END), 0) AS opening_credit,
			COALESCE(SUM(CASE WHEN je.entry_date >= ${from} AND je.source_type <> 'year_opening' THEN jl.debit ELSE 0 END), 0) AS debit,
			COALESCE(SUM(CASE WHEN je.entry_date >= ${from} AND je.source_type <> 'year_opening' THEN jl.credit ELSE 0 END), 0) AS credit
		FROM journal_lines jl JOIN journal_entries je ON je.uuid = jl.entry JOIN ledger_accounts la ON la.uuid = jl.ledger_account
		WHERE jl.project = ${project} AND je.entry_date <= ${to}
			AND (la.account_kind NOT IN ('revenue', 'expense') OR je.entry_date >= ${yearStart})
			AND NOT (je.source_type IN ('year_closing', 'year_result') AND je.entry_date >= ${from})
			AND NOT (je.reverses IS NOT NULL AND je.entry_date >= ${from} AND EXISTS (
				SELECT 1 FROM journal_entries o WHERE o.uuid = je.reverses AND o.source_type IN ('year_closing', 'year_result')))
		GROUP BY jl.ledger_account
	`) as { ledger_account: string; opening_debit: number; opening_credit: number; debit: number; credit: number }[];
	const byAccount = new Map(totals.map((row) => [row.ledger_account, row]));
	return accounts
		.filter((account) => byAccount.has(account.uuid))
		.map((account) => {
			const row = byAccount.get(account.uuid)!;
			const opening = signedBalance(account.account_kind, safeInteger(row.opening_debit), safeInteger(row.opening_credit));
			const debit = safeInteger(row.debit);
			const credit = safeInteger(row.credit);
			const closing = addIntegers(opening, signedBalance(account.account_kind, debit, credit));
			const debitSide = account.account_kind === "asset" || account.account_kind === "expense" ? 1 : -1;
			return {
				account: account.uuid,
				code: account.code,
				name: account.name,
				kind: account.account_kind,
				opening,
				debit,
				credit,
				closing,
				opening_debit: Math.max(debitSide * opening, 0),
				opening_credit: Math.max(-debitSide * opening, 0),
				closing_debit: Math.max(debitSide * closing, 0),
				closing_credit: Math.max(-debitSide * closing, 0),
			};
		})
		.filter((row) => row.opening !== 0 || row.debit !== 0 || row.credit !== 0);
}

export async function accountLedger(project: string, account: LedgerAccountRow, from: number, to: number, yearStart: number, partner: string | null = null) {
	const since = account.account_kind === "revenue" || account.account_kind === "expense" ? yearStart : 0;
	const byPartner = partner ? Database`AND LOWER(jl.partner) LIKE ${`%${partner.toLowerCase()}%`}` : Database``;
	const [opening] = (await Database`
		SELECT COALESCE(SUM(jl.debit), 0) AS debit, COALESCE(SUM(jl.credit), 0) AS credit
		FROM journal_lines jl JOIN journal_entries je ON je.uuid = jl.entry
		WHERE jl.project = ${project} AND jl.ledger_account = ${account.uuid} AND je.entry_date >= ${since} AND je.entry_date < ${from} ${byPartner}
	`) as { debit: number; credit: number }[];
	const rows = (await Database`
		SELECT je.uuid AS entry, je.year, je.number, je.entry_date, je.description, jl.debit, jl.credit, jl.partner
		FROM journal_lines jl JOIN journal_entries je ON je.uuid = jl.entry
		WHERE jl.project = ${project} AND jl.ledger_account = ${account.uuid} AND je.entry_date BETWEEN ${from} AND ${to} ${byPartner}
			AND je.source_type <> 'year_closing'
			AND NOT (je.reverses IS NOT NULL AND EXISTS (SELECT 1 FROM journal_entries o WHERE o.uuid = je.reverses AND o.source_type = 'year_closing'))
		ORDER BY je.entry_date, je.year, je.number, jl.sort_order
	`) as Omit<AccountLedgerRow, "balance">[];
	let balance = signedBalance(account.account_kind, safeInteger(opening.debit), safeInteger(opening.credit));
	const openingBalance = balance;
	const lines: AccountLedgerRow[] = rows.map((row) => {
		const debit = safeInteger(row.debit);
		const credit = safeInteger(row.credit);
		balance = addIntegers(balance, signedBalance(account.account_kind, debit, credit));
		return { ...row, debit, credit, balance };
	});
	return { account, opening: openingBalance, closing: balance, lines };
}
