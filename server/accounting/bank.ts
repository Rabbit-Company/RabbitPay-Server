import Database from "../database/database";
import { outstandingOf } from "../invoicing";
import { creditorReference } from "../payments/reference";
import { acceptsPayment, recordPayment } from "../payments/recorded";
import { ProcessorType } from "../payments/types";
import type { CamtStatement } from "./camt";
import { bankAccountFor } from "./chart";
import type { BankSuggestion } from "./types";

export type { BankSuggestion };
import type { BankMatchType, BankTransactionRow, ExpenseRow, InvoiceRow, LedgerAccountRow, ProjectRow, RecordedInvoiceRow } from "../database/models";

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

function suggestFor(transaction: BankTransactionRow, pool: Candidates): BankSuggestion[] {
	const found: (BankSuggestion & { score: number })[] = [];
	const add = (suggestion: Omit<BankSuggestion, "exact">, referenced: boolean, named: boolean) => {
		const sameAmount = suggestion.amount === Math.abs(transaction.amount) && suggestion.currency === transaction.currency;
		if (!referenced && !sameAmount) return;
		found.push({ ...suggestion, exact: referenced && sameAmount, score: (referenced ? 4 : 0) + (sameAmount ? 2 : 0) + (named ? 1 : 0) });
	};
	if (transaction.amount > 0) {
		for (const invoice of pool.invoices) {
			if (invoice.currency !== transaction.currency) continue;
			const buyer = buyerName(invoice);
			add(
				{ type: "invoice", id: invoice.uuid, reference: invoice.reference, name: buyer, amount: outstandingOf(invoice), currency: invoice.currency },
				mentions(transaction, invoice.reference),
				similarName(buyer, transaction.counterparty_name)
			);
		}
	}
	for (const record of pool.recorded) {
		const incoming = record.document_type === "invoice";
		if (incoming !== transaction.amount > 0 || record.currency !== transaction.currency) continue;
		add(
			{
				type: "recorded_invoice",
				id: record.uuid,
				reference: record.reference,
				name: record.buyer_name,
				amount: record.total_amount,
				currency: record.currency,
			},
			mentions(transaction, record.reference),
			similarName(record.buyer_name, transaction.counterparty_name)
		);
	}
	if (transaction.amount < 0) {
		for (const expense of pool.expenses) {
			if (expense.currency !== transaction.currency) continue;
			add(
				{
					type: "expense",
					id: expense.uuid,
					reference: expense.invoice_number,
					name: expense.supplier ?? expense.description,
					amount: expense.total_amount,
					currency: expense.currency,
				},
				mentions(transaction, expense.invoice_number),
				similarName(expense.supplier, transaction.counterparty_name)
			);
		}
	}
	return found
		.sort((a, b) => b.score - a.score)
		.slice(0, 5)
		.map(({ score: _score, ...suggestion }) => suggestion);
}

export async function suggestionsFor(project: string, transactions: BankTransactionRow[]): Promise<Map<string, BankSuggestion[]>> {
	const open = transactions.filter((transaction) => transaction.status === "open");
	if (open.length === 0) return new Map();
	const pool = await candidates(project);
	return new Map(open.map((transaction) => [transaction.uuid, suggestFor(transaction, pool)]));
}

async function settle(transaction: BankTransactionRow, type: BankMatchType, id: string, author: string) {
	const updated = await Database`
		UPDATE bank_transactions SET status = 'matched', match_type = ${type}, match_id = ${id}, ledger_account = NULL, matched_by = ${author}, matched_at = ${Date.now()}
		WHERE uuid = ${transaction.uuid} AND status = 'open'
	`;
	if (updated.count === 0) throw new BankMatchRefused();
}

export async function matchTransaction(project: ProjectRow, transaction: BankTransactionRow, type: BankMatchType, id: string, author: string) {
	if (transaction.status !== "open") throw new BankMatchRefused();
	const amount = Math.abs(transaction.amount);
	if (type === "invoice") {
		const [invoice] = (await Database`SELECT * FROM invoices WHERE uuid = ${id} AND project = ${project.uuid}`) as InvoiceRow[];
		if (!invoice || transaction.amount <= 0 || invoice.currency !== transaction.currency || !(await acceptsPayment(invoice)) || amount > outstandingOf(invoice))
			throw new BankMatchRefused();
		await settle(transaction, type, id, author);
		const payment = await recordPayment({
			invoice,
			processor: ProcessorType.BANK_TRANSFER,
			amount,
			fee: 0,
			processorTxId: transaction.bank_reference,
			paymentMethod: "bank_transfer",
			status: "completed",
			notes: "Bank statement",
			recordedBy: author,
			settledAt: transaction.booking_date,
		});
		await Database`UPDATE bank_transactions SET payment_transaction = ${payment.uuid} WHERE uuid = ${transaction.uuid}`;
		return;
	}
	if (type === "recorded_invoice") {
		const [record] = (await Database`SELECT * FROM recorded_invoices WHERE uuid = ${id} AND project = ${project.uuid}`) as RecordedInvoiceRow[];
		if (
			!record ||
			record.paid_at !== null ||
			record.currency !== transaction.currency ||
			record.total_amount !== amount ||
			(record.document_type === "invoice") !== transaction.amount > 0
		)
			throw new BankMatchRefused();
		await settle(transaction, type, id, author);
		await Database`UPDATE recorded_invoices SET paid_at = ${transaction.booking_date}, payment_account = 'bank', updated = ${Date.now()} WHERE uuid = ${id}`;
		return;
	}
	const [expense] = (await Database`SELECT * FROM expenses WHERE uuid = ${id} AND project = ${project.uuid}`) as ExpenseRow[];
	if (!expense || expense.paid_at !== null || transaction.amount >= 0 || expense.currency !== transaction.currency || expense.total_amount !== amount)
		throw new BankMatchRefused();
	await settle(transaction, "expense", id, author);
	await Database`UPDATE expenses SET paid_at = ${transaction.booking_date}, updated = ${Date.now()} WHERE uuid = ${id}`;
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
	if (transaction.match_type === "invoice") throw new PermanentMatch();
	await Database.begin(async (tx) => {
		const now = Date.now();
		if (transaction.match_type === "expense") await tx`UPDATE expenses SET paid_at = NULL, updated = ${now} WHERE uuid = ${transaction.match_id}`;
		if (transaction.match_type === "recorded_invoice")
			await tx`UPDATE recorded_invoices SET paid_at = NULL, updated = ${now} WHERE uuid = ${transaction.match_id}`;
		await tx`
			UPDATE bank_transactions SET status = 'open', match_type = NULL, match_id = NULL, ledger_account = NULL, matched_by = NULL, matched_at = NULL
			WHERE uuid = ${transaction.uuid}
		`;
	});
}
