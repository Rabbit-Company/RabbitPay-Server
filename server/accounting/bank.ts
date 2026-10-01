import Database from "../database/database";
import { outstandingOf } from "../invoicing";
import { creditorReference } from "../payments/reference";
import { acceptsPayment, recordPayment } from "../payments/recorded";
import { ProcessorType } from "../payments/types";
import type { CamtStatement } from "./camt";
import { bankAccountFor } from "./chart";
import type { BankCandidate, BankMatchInput, BankSuggestion } from "./types";

export type { BankCandidate, BankMatchInput, BankSuggestion };
import type {
	BankMatchType,
	BankTransactionMatchRow,
	BankTransactionRow,
	ExpenseRow,
	InvoiceRow,
	LedgerAccountRow,
	ProjectRow,
	RecordedInvoiceRow,
} from "../database/models";

export interface StatementImport {
	statements: number;
	imported: number;
	skipped: number;
}

export class BankMatchRefused extends Error {}

function compact(value: string | null | undefined): string {
	return (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function mentions(transaction: BankTransactionRow, reference: string | null): boolean {
	const wanted = compact(reference);
	if (wanted.length < 2) return false;
	if (transaction.reference && (compact(transaction.reference) === compact(creditorReference(reference!)) || compact(transaction.reference).endsWith(wanted)))
		return true;
	return compact(transaction.remittance).includes(wanted);
}

function words(value: string | null): Set<string> {
	return new Set(
		(value ?? "")
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((word) => word.length > 2 && !["d.o.o", "doo", "s.p"].includes(word))
	);
}

function similarName(a: string | null, b: string | null): boolean {
	const left = words(a);
	return [...words(b)].some((word) => left.has(word));
}

function buyerName(invoice: InvoiceRow): string | null {
	if (!invoice.buyer_details) return null;
	try {
		return (JSON.parse(invoice.buyer_details) as { name?: string }).name ?? null;
	} catch {
		return null;
	}
}

export async function existingFingerprints(project: string, fingerprints: string[]): Promise<Set<string>> {
	if (fingerprints.length === 0) return new Set();
	const rows = (await Database`
		SELECT fingerprint FROM bank_transactions WHERE project = ${project} AND fingerprint IN ${Database(fingerprints)}
	`) as { fingerprint: string }[];
	return new Set(rows.map((row) => row.fingerprint));
}

export async function importStatements(project: string, statements: CamtStatement[], fileName: string | null, author: string): Promise<StatementImport> {
	const known = await existingFingerprints(
		project,
		statements.flatMap((statement) => statement.transactions.map((transaction) => transaction.fingerprint))
	);
	let imported = 0;
	let skipped = 0;
	await Database.begin(async (tx) => {
		const now = Date.now();
		for (const statement of statements) {
			await bankAccountFor(project, statement.iban, tx);
			const [existing] = (await tx`
				SELECT uuid FROM bank_statements WHERE project = ${project} AND iban = ${statement.iban} AND statement_id = ${statement.statement_id}
			`) as { uuid: string }[];
			const uuid = existing?.uuid ?? crypto.randomUUID();
			if (!existing) {
				await tx`
					INSERT INTO bank_statements(uuid, project, iban, statement_id, currency, period_from, period_to, opening_balance, closing_balance,
						file_name, created_by, created)
					VALUES(${uuid}, ${project}, ${statement.iban}, ${statement.statement_id}, ${statement.currency}, ${statement.period_from},
						${statement.period_to}, ${statement.opening_balance}, ${statement.closing_balance}, ${fileName?.slice(0, 250) ?? null}, ${author}, ${now})
				`;
			}
			for (const line of statement.transactions) {
				if (known.has(line.fingerprint)) {
					skipped++;
					continue;
				}
				known.add(line.fingerprint);
				await tx`
					INSERT INTO bank_transactions(uuid, project, statement, booking_date, value_date, amount, currency, counterparty_name, counterparty_iban,
						reference, remittance, bank_reference, fingerprint, status, created)
					VALUES(${crypto.randomUUID()}, ${project}, ${uuid}, ${line.booking_date}, ${line.value_date}, ${line.amount}, ${line.currency},
						${line.counterparty_name}, ${line.counterparty_iban}, ${line.reference}, ${line.remittance}, ${line.bank_reference},
						${line.fingerprint}, 'open', ${now})
				`;
				imported++;
			}
		}
	});
	return { statements: statements.length, imported, skipped };
}

interface Candidates {
	invoices: InvoiceRow[];
	recorded: RecordedInvoiceRow[];
	expenses: ExpenseRow[];
}

async function candidates(project: string): Promise<Candidates> {
	const invoices = (await Database`
		SELECT * FROM invoices WHERE project = ${project} AND status IN ('open', 'overdue', 'partially_paid') AND issued_at IS NOT NULL
	`) as InvoiceRow[];
	const recorded = (await Database`SELECT * FROM recorded_invoices WHERE project = ${project} AND paid_at IS NULL`) as RecordedInvoiceRow[];
	const expenses = (await Database`SELECT * FROM expenses WHERE project = ${project} AND paid_at IS NULL`) as ExpenseRow[];
	return { invoices, recorded, expenses };
}

function baseCurrency(project: ProjectRow): string {
	return project.tax_currency ?? project.currency;
}

function recordedDirection(record: RecordedInvoiceRow): 1 | -1 {
	return record.document_type === "invoice" ? 1 : -1;
}

function convertible(document: { currency: string; tax_exchange_rate: number | null; tax_currency?: string | null }, base: string): boolean {
	return document.currency !== base && document.tax_exchange_rate !== null && (document.tax_currency === undefined || document.tax_currency === base);
}

function candidateList(pool: Candidates, base: string): (BankCandidate & { convertible: boolean })[] {
	return [
		...pool.invoices.map((invoice) => ({
			type: "invoice" as const,
			id: invoice.uuid,
			reference: invoice.reference,
			name: buyerName(invoice),
			amount: outstandingOf(invoice),
			currency: invoice.currency,
			direction: 1 as const,
			date: invoice.issued_at ?? invoice.created,
			partial: true,
			convertible: false,
		})),
		...pool.recorded.map((record) => ({
			type: "recorded_invoice" as const,
			id: record.uuid,
			reference: record.reference,
			name: record.buyer_name,
			amount: record.total_amount,
			currency: record.currency,
			direction: recordedDirection(record),
			date: record.issued_at,
			partial: false,
			convertible: convertible(record, base),
		})),
		...pool.expenses.map((expense) => ({
			type: "expense" as const,
			id: expense.uuid,
			reference: expense.invoice_number,
			name: expense.supplier ?? expense.description,
			amount: expense.total_amount,
			currency: expense.currency,
			direction: -1 as const,
			date: expense.expense_date,
			partial: false,
			convertible: convertible(expense, base),
		})),
	];
}

function suggestFor(transaction: BankTransactionRow, pool: Candidates, base: string): BankSuggestion[] {
	const direction = transaction.amount > 0 ? 1 : -1;
	const found: (BankSuggestion & { score: number })[] = [];
	for (const { direction: wanted, date: _date, partial: _partial, convertible: foreign, ...candidate } of candidateList(pool, base)) {
		if (wanted !== direction) continue;
		const sameCurrency = candidate.currency === transaction.currency;
		if (!sameCurrency && !(foreign && transaction.currency === base)) continue;
		const referenced = mentions(transaction, candidate.reference);
		const sameAmount = sameCurrency && candidate.amount === Math.abs(transaction.amount);
		if (!referenced && !sameAmount) continue;
		const named = similarName(candidate.name, transaction.counterparty_name);
		found.push({ ...candidate, exact: referenced && sameAmount, score: (referenced ? 4 : 0) + (sameAmount ? 2 : 0) + (named ? 1 : 0) });
	}
	return found
		.sort((a, b) => b.score - a.score)
		.slice(0, 5)
		.map(({ score: _score, ...suggestion }) => suggestion);
}

export async function suggestionsFor(project: ProjectRow, transactions: BankTransactionRow[]): Promise<Map<string, BankSuggestion[]>> {
	const open = transactions.filter((transaction) => transaction.status === "open");
	if (open.length === 0) return new Map();
	const pool = await candidates(project.uuid);
	return new Map(open.map((transaction) => [transaction.uuid, suggestFor(transaction, pool, baseCurrency(project))]));
}

export async function candidatesFor(project: ProjectRow, transaction: BankTransactionRow): Promise<BankCandidate[]> {
	const base = baseCurrency(project);
	return candidateList(await candidates(project.uuid), base)
		.filter((candidate) => candidate.currency === transaction.currency || (candidate.convertible && transaction.currency === base))
		.sort((a, b) => Number(similarName(b.name, transaction.counterparty_name)) - Number(similarName(a.name, transaction.counterparty_name)) || a.date - b.date)
		.slice(0, 300)
		.map(({ convertible: _convertible, ...candidate }) => candidate);
}

interface PlannedMatch {
	type: BankMatchType;
	id: string;
	amount: number;
	invoice: InvoiceRow | null;
}

async function planMatch(
	project: ProjectRow,
	transaction: BankTransactionRow,
	input: BankMatchInput,
	single: boolean
): Promise<PlannedMatch & { signed: number }> {
	const base = baseCurrency(project);
	const whole = Math.abs(transaction.amount);
	const crossCurrency = (document: { currency: string; tax_exchange_rate: number | null; tax_currency?: string | null }) =>
		document.currency !== transaction.currency && single && transaction.currency === base && convertible(document, base);
	if (input.type === "invoice") {
		const [invoice] = (await Database`SELECT * FROM invoices WHERE uuid = ${input.id} AND project = ${project.uuid}`) as InvoiceRow[];
		if (!invoice || invoice.currency !== transaction.currency || !(await acceptsPayment(invoice))) throw new BankMatchRefused();
		const amount = input.amount ?? (single ? whole : outstandingOf(invoice));
		if (!Number.isSafeInteger(amount) || amount <= 0 || amount > outstandingOf(invoice)) throw new BankMatchRefused();
		return { type: "invoice", id: invoice.uuid, amount, invoice, signed: amount };
	}
	if (input.type === "recorded_invoice") {
		const [record] = (await Database`SELECT * FROM recorded_invoices WHERE uuid = ${input.id} AND project = ${project.uuid}`) as RecordedInvoiceRow[];
		if (!record || record.paid_at !== null) throw new BankMatchRefused();
		const direction = recordedDirection(record);
		if (crossCurrency(record)) return { type: "recorded_invoice", id: record.uuid, amount: whole, invoice: null, signed: direction * whole };
		if (record.currency !== transaction.currency || (input.amount !== null && input.amount !== record.total_amount)) throw new BankMatchRefused();
		return { type: "recorded_invoice", id: record.uuid, amount: record.total_amount, invoice: null, signed: direction * record.total_amount };
	}
	const [expense] = (await Database`SELECT * FROM expenses WHERE uuid = ${input.id} AND project = ${project.uuid}`) as ExpenseRow[];
	if (!expense || expense.paid_at !== null) throw new BankMatchRefused();
	if (crossCurrency(expense)) return { type: "expense", id: expense.uuid, amount: whole, invoice: null, signed: -whole };
	if (expense.currency !== transaction.currency || (input.amount !== null && input.amount !== expense.total_amount)) throw new BankMatchRefused();
	return { type: "expense", id: expense.uuid, amount: expense.total_amount, invoice: null, signed: -expense.total_amount };
}

export async function matchTransaction(project: ProjectRow, transaction: BankTransactionRow, inputs: BankMatchInput[], author: string) {
	if (transaction.status !== "open" || inputs.length === 0 || inputs.length > 50) throw new BankMatchRefused();
	if (new Set(inputs.map((input) => `${input.type}:${input.id}`)).size !== inputs.length) throw new BankMatchRefused();
	const single = inputs.length === 1;
	const planned: PlannedMatch[] = [];
	let signed = 0;
	for (const input of inputs) {
		const { signed: part, ...match } = await planMatch(project, transaction, input, single);
		planned.push(match);
		signed += part;
	}
	if (signed !== transaction.amount) throw new BankMatchRefused();

	const types = new Set(planned.map((match) => match.type));
	const now = Date.now();
	const updated = await Database`
		UPDATE bank_transactions SET status = 'matched', match_type = ${types.size === 1 ? planned[0].type : null}, match_id = ${single ? planned[0].id : null},
			ledger_account = NULL, matched_by = ${author}, matched_at = ${now}
		WHERE uuid = ${transaction.uuid} AND status = 'open'
	`;
	if (updated.count === 0) throw new BankMatchRefused();

	for (const match of planned) {
		const uuid = crypto.randomUUID();
		await Database`
			INSERT INTO bank_transaction_matches(uuid, project, bank_transaction, match_type, match_id, amount, payment_transaction, created)
			VALUES(${uuid}, ${project.uuid}, ${transaction.uuid}, ${match.type}, ${match.id}, ${match.amount}, NULL, ${now})
		`;
		if (match.invoice) {
			const payment = await recordPayment({
				invoice: match.invoice,
				processor: ProcessorType.BANK_TRANSFER,
				amount: match.amount,
				fee: 0,
				processorTxId: transaction.bank_reference,
				paymentMethod: "bank_transfer",
				status: "completed",
				notes: "Bank statement",
				recordedBy: author,
				settledAt: transaction.booking_date,
			});
			await Database`UPDATE bank_transaction_matches SET payment_transaction = ${payment.uuid} WHERE uuid = ${uuid}`;
			if (single) await Database`UPDATE bank_transactions SET payment_transaction = ${payment.uuid} WHERE uuid = ${transaction.uuid}`;
		} else if (match.type === "recorded_invoice") {
			await Database`UPDATE recorded_invoices SET paid_at = ${transaction.booking_date}, payment_account = 'bank', updated = ${now} WHERE uuid = ${match.id}`;
		} else {
			await Database`UPDATE expenses SET paid_at = ${transaction.booking_date}, updated = ${now} WHERE uuid = ${match.id}`;
		}
	}
}

export async function matchesOf(transactions: string[]): Promise<Map<string, BankTransactionMatchRow[]>> {
	const result = new Map<string, BankTransactionMatchRow[]>();
	if (transactions.length === 0) return result;
	const rows = (await Database`
		SELECT * FROM bank_transaction_matches WHERE bank_transaction IN ${Database(transactions)} ORDER BY created, uuid
	`) as BankTransactionMatchRow[];
	for (const row of rows) result.set(row.bank_transaction, [...(result.get(row.bank_transaction) ?? []), row]);
	return result;
}

export async function statementAccount(transaction: BankTransactionRow): Promise<LedgerAccountRow> {
	const [statement] = (await Database`SELECT iban FROM bank_statements WHERE uuid = ${transaction.statement}`) as { iban: string }[];
	return await bankAccountFor(transaction.project, statement.iban);
}

export async function bookTransaction(transaction: BankTransactionRow, account: LedgerAccountRow, author: string) {
	if (transaction.status !== "open" || !account.active || account.uuid === (await statementAccount(transaction)).uuid) throw new BankMatchRefused();
	await Database`
		UPDATE bank_transactions SET status = 'booked', ledger_account = ${account.uuid}, matched_by = ${author}, matched_at = ${Date.now()}
		WHERE uuid = ${transaction.uuid} AND status = 'open'
	`;
}

export async function ignoreTransaction(transaction: BankTransactionRow, author: string) {
	if (transaction.status !== "open") throw new BankMatchRefused();
	await Database`
		UPDATE bank_transactions SET status = 'ignored', matched_by = ${author}, matched_at = ${Date.now()} WHERE uuid = ${transaction.uuid} AND status = 'open'
	`;
}

export class PermanentMatch extends Error {}

export async function reopenTransaction(transaction: BankTransactionRow) {
	if (transaction.status === "open") return;
	const matches = (await matchesOf([transaction.uuid])).get(transaction.uuid) ?? [];
	if (transaction.match_type === "invoice" || matches.some((match) => match.match_type === "invoice")) throw new PermanentMatch();
	await Database.begin(async (tx) => {
		const now = Date.now();
		for (const match of matches) {
			if (match.match_type === "expense") await tx`UPDATE expenses SET paid_at = NULL, updated = ${now} WHERE uuid = ${match.match_id}`;
			if (match.match_type === "recorded_invoice") await tx`UPDATE recorded_invoices SET paid_at = NULL, updated = ${now} WHERE uuid = ${match.match_id}`;
		}
		await tx`DELETE FROM bank_transaction_matches WHERE bank_transaction = ${transaction.uuid}`;
		await tx`
			UPDATE bank_transactions SET status = 'open', match_type = NULL, match_id = NULL, ledger_account = NULL, payment_transaction = NULL,
				matched_by = NULL, matched_at = NULL
			WHERE uuid = ${transaction.uuid}
		`;
	});
}
