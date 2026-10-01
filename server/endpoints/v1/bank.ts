import type { Context } from "@rabbit-company/web";
import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { accountingActive } from "../../licensing";
import { decodeXmlBytes, XmlSyntaxError } from "../../xml-reader";
import { CamtUnreadable, parseCamt053, type CamtStatement } from "../../accounting/camt";
import { ensureChart } from "../../accounting/chart";
import { syncLedger } from "../../accounting/journal";
import {
	BankMatchRefused,
	bookTransaction,
	candidatesFor,
	matchesOf,
	existingFingerprints,
	ignoreTransaction,
	importStatements,
	matchTransaction,
	PermanentMatch,
	reopenTransaction,
	suggestionsFor,
} from "../../accounting/bank";
import { importBody } from "./recorded-invoices";
import { closedYear } from "../../accounting-periods";
import type { BankMatchInput } from "../../accounting/types";
import type { AppState, BankMatchType, BankStatementRow, BankTransactionRow, ProjectRow } from "../../database/models";

const base = "/api/v1/projects/:uuid/accounting";
const MAX_STATEMENT_BYTES = 3 * 1024 * 1024;
const MATCH_TYPES: BankMatchType[] = ["invoice", "recorded_invoice", "expense"];

async function body(ctx: Context<AppState>): Promise<Record<string, unknown> | null> {
	try {
		const value = await ctx.body<Record<string, unknown>>();
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

async function uploadedStatements(ctx: Context<AppState>, project: ProjectRow): Promise<{ name: string | null; statements: CamtStatement[] } | null> {
	const data = await body(ctx);
	if (typeof data?.data !== "string") return null;
	const bytes = Buffer.from(data.data, "base64");
	if (bytes.length === 0 || bytes.length > MAX_STATEMENT_BYTES) return null;
	try {
		const statements = parseCamt053(decodeXmlBytes(bytes), project.timezone);
		if (statements.every((statement) => statement.transactions.length === 0)) return null;
		return { name: typeof data.name === "string" ? data.name : null, statements };
	} catch (error) {
		if (error instanceof CamtUnreadable || error instanceof XmlSyntaxError) return null;
		throw error;
	}
}

async function findTransaction(project: string, uuid: string): Promise<BankTransactionRow | null> {
	const [row] = (await Database`SELECT * FROM bank_transactions WHERE project = ${project} AND uuid = ${uuid}`) as BankTransactionRow[];
	return row ?? null;
}

async function audit(ctx: Context<AppState>, action: string, uuid: string, value?: unknown) {
	await Audit.record(ctx, { project: Permissions.project(ctx).uuid, action, entityType: "bank_transaction", entityId: uuid, newValue: value });
}

function editable(ctx: Context<AppState>): Response | null {
	return accountingActive(Permissions.project(ctx)) ? null : Utils.fail(ctx, ErrorCode.ACCOUNTING_LICENSE_REQUIRED);
}

Server.app.post(`${base}/bank-statements/preview`, importBody, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	const refused = editable(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const upload = await uploadedStatements(ctx, project);
	if (!upload) return Utils.fail(ctx, ErrorCode.INVALID_BANK_STATEMENT);
	const lines = upload.statements.flatMap((statement) => statement.transactions);
	const known = await existingFingerprints(
		project.uuid,
		lines.map((line) => line.fingerprint)
	);
	return Utils.ok(ctx, {
		statements: upload.statements.map(({ transactions, ...statement }) => ({ ...statement, transactions: transactions.length })),
		new_lines: lines.filter((line) => !known.has(line.fingerprint)).length,
		known_lines: lines.filter((line) => known.has(line.fingerprint)).length,
	});
});

Server.app.post(`${base}/bank-statements`, importBody, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	const refused = editable(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const upload = await uploadedStatements(ctx, project);
	if (!upload) return Utils.fail(ctx, ErrorCode.INVALID_BANK_STATEMENT);
	const result = await importStatements(project.uuid, upload.statements, upload.name, Auth.account(ctx).username);
	await Audit.record(ctx, {
		project: project.uuid,
		action: "bank_statement.imported",
		entityType: "bank_statement",
		newValue: { name: upload.name, ...result },
	});
	return Utils.ok(ctx, result, 201);
});

Server.app.get(`${base}/bank-statements`, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const rows = (await Database`SELECT * FROM bank_statements WHERE project = ${project.uuid} ORDER BY period_to DESC, created DESC`) as BankStatementRow[];
	const counts = (await Database`
		SELECT statement, status, COUNT(*) AS total FROM bank_transactions WHERE project = ${project.uuid} GROUP BY statement, status
	`) as { statement: string; status: string; total: number }[];
	const chart = await ensureChart(project.uuid);
	await syncLedger(project);
	const ledgerBalance = async (iban: string, until: number | null) => {
		const bank = chart.byIban(iban);
		if (until === null || !bank) return null;
		const [row] = (await Database`
			SELECT COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0) AS balance FROM journal_lines jl
			JOIN journal_entries je ON je.uuid = jl.entry
			WHERE jl.project = ${project.uuid} AND jl.ledger_account = ${bank.uuid} AND je.entry_date < ${until + 86400000}
		`) as { balance: number }[];
		return Number(row.balance);
	};
	return Utils.ok(ctx, {
		statements: await Promise.all(
			rows.map(async (row) => ({
				...row,
				ledger_balance: await ledgerBalance(row.iban, row.period_to),
				lines: Object.fromEntries(counts.filter((count) => count.statement === row.uuid).map((count) => [count.status, Number(count.total)])),
			}))
		),
	});
});

Server.app.get(`${base}/bank-transactions`, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();
	const status = query.get("status") ?? "open";
	const limit = Number(query.get("limit") ?? 50);
	const offset = Number(query.get("offset") ?? 0);
	if (
		!["open", "matched", "booked", "ignored", "all"].includes(status) ||
		!Number.isSafeInteger(limit) ||
		!Number.isSafeInteger(offset) ||
		limit < 1 ||
		limit > 200 ||
		offset < 0
	)
		return Utils.fail(ctx, ErrorCode.INVALID_LEDGER_PERIOD);
	const filter = status === "all" ? Database`` : Database`AND status = ${status}`;
	const rows = (await Database`
		SELECT * FROM bank_transactions WHERE project = ${project.uuid} ${filter} ORDER BY booking_date DESC, created DESC LIMIT ${limit} OFFSET ${offset}
	`) as BankTransactionRow[];
	const [count] = (await Database`SELECT COUNT(*) AS total FROM bank_transactions WHERE project = ${project.uuid} ${filter}`) as { total: number }[];
	const suggestions = await suggestionsFor(project, rows);
	const matches = await matchesOf(rows.map((row) => row.uuid));
	return Utils.ok(ctx, {
		transactions: rows.map((row) => ({ ...row, suggestions: suggestions.get(row.uuid) ?? [], matches: matches.get(row.uuid) ?? [] })),
		total: Number(count.total),
		limit,
		offset,
	});
});

Server.app.post(`${base}/bank-transactions/match-exact`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	const refused = editable(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const open =
		(await Database`SELECT * FROM bank_transactions WHERE project = ${project.uuid} AND status = 'open' ORDER BY booking_date`) as BankTransactionRow[];
	const author = Auth.account(ctx).username;
	const used = new Set<string>();
	let matched = 0;
	for (const transaction of open) {
		const exact = ((await suggestionsFor(project, [transaction])).get(transaction.uuid) ?? []).filter((suggestion) => suggestion.exact);
		if (exact.length !== 1 || used.has(exact[0].id) || (await closedYear(project.uuid, transaction.booking_date))) continue;
		try {
			await matchTransaction(project, transaction, [{ type: exact[0].type, id: exact[0].id, amount: null }], author);
			used.add(exact[0].id);
			matched++;
		} catch (error) {
			if (!(error instanceof BankMatchRefused)) throw error;
		}
	}
	if (matched > 0) {
		await Audit.record(ctx, { project: project.uuid, action: "bank_transactions.matched", entityType: "bank_transaction", newValue: { matched } });
		await syncLedger(project);
	}
	return Utils.ok(ctx, { matched });
});

function matchInputs(data: Record<string, unknown> | null): BankMatchInput[] | null {
	const raw = Array.isArray(data?.matches) ? (data.matches as unknown[]) : data ? [data] : [];
	const inputs: BankMatchInput[] = [];
	for (const item of raw) {
		const entry = item as Record<string, unknown> | null;
		if (!entry || !MATCH_TYPES.includes(entry.type as BankMatchType) || typeof entry.id !== "string") return null;
		const amount = entry.amount === undefined || entry.amount === null ? null : entry.amount;
		if (amount !== null && (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0)) return null;
		inputs.push({ type: entry.type as BankMatchType, id: entry.id, amount });
	}
	return inputs.length > 0 && inputs.length <= 50 ? inputs : null;
}

Server.app.get(`${base}/bank-transactions/:line/candidates`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const transaction = await findTransaction(project.uuid, ctx.params.line);
	if (!transaction) return Utils.fail(ctx, ErrorCode.BANK_TRANSACTION_NOT_FOUND);
	return Utils.ok(ctx, { candidates: await candidatesFor(project, transaction) });
});

Server.app.post(`${base}/bank-transactions/:line/match`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	const refused = editable(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const transaction = await findTransaction(project.uuid, ctx.params.line);
	if (!transaction) return Utils.fail(ctx, ErrorCode.BANK_TRANSACTION_NOT_FOUND);
	if (await closedYear(project.uuid, transaction.booking_date)) return Utils.fail(ctx, ErrorCode.YEAR_CLOSED);
	const inputs = matchInputs(await body(ctx));
	if (!inputs) return Utils.fail(ctx, ErrorCode.INVALID_BANK_MATCH);
	try {
		await matchTransaction(project, transaction, inputs, Auth.account(ctx).username);
	} catch (error) {
		if (error instanceof BankMatchRefused) return Utils.fail(ctx, ErrorCode.INVALID_BANK_MATCH);
		throw error;
	}
	await audit(ctx, "bank_transaction.matched", transaction.uuid, { matches: inputs });
	await syncLedger(project);
	return Utils.ok(ctx, await findTransaction(project.uuid, transaction.uuid));
});

Server.app.post(`${base}/bank-transactions/:line/book`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	const refused = editable(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const transaction = await findTransaction(project.uuid, ctx.params.line);
	if (!transaction) return Utils.fail(ctx, ErrorCode.BANK_TRANSACTION_NOT_FOUND);
	if (await closedYear(project.uuid, transaction.booking_date)) return Utils.fail(ctx, ErrorCode.YEAR_CLOSED);
	const data = await body(ctx);
	const account = typeof data?.account === "string" ? (await ensureChart(project.uuid)).byUuid(data.account) : undefined;
	if (!account) return Utils.fail(ctx, ErrorCode.LEDGER_ACCOUNT_NOT_FOUND);
	try {
		await bookTransaction(transaction, account, Auth.account(ctx).username);
	} catch (error) {
		if (error instanceof BankMatchRefused) return Utils.fail(ctx, ErrorCode.INVALID_BANK_MATCH);
		throw error;
	}
	await audit(ctx, "bank_transaction.booked", transaction.uuid, { account: account.code });
	await syncLedger(project);
	return Utils.ok(ctx, await findTransaction(project.uuid, transaction.uuid));
});

Server.app.post(`${base}/bank-transactions/:line/ignore`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	const refused = editable(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const transaction = await findTransaction(project.uuid, ctx.params.line);
	if (!transaction) return Utils.fail(ctx, ErrorCode.BANK_TRANSACTION_NOT_FOUND);
	try {
		await ignoreTransaction(transaction, Auth.account(ctx).username);
	} catch (error) {
		if (error instanceof BankMatchRefused) return Utils.fail(ctx, ErrorCode.INVALID_BANK_MATCH);
		throw error;
	}
	await audit(ctx, "bank_transaction.ignored", transaction.uuid);
	return Utils.ok(ctx, await findTransaction(project.uuid, transaction.uuid));
});

Server.app.post(`${base}/bank-transactions/:line/reopen`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	const refused = editable(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const transaction = await findTransaction(project.uuid, ctx.params.line);
	if (!transaction) return Utils.fail(ctx, ErrorCode.BANK_TRANSACTION_NOT_FOUND);
	if (await closedYear(project.uuid, transaction.booking_date)) return Utils.fail(ctx, ErrorCode.YEAR_CLOSED);
	try {
		await reopenTransaction(transaction);
	} catch (error) {
		if (error instanceof PermanentMatch) return Utils.fail(ctx, ErrorCode.BANK_MATCH_PERMANENT);
		throw error;
	}
	await audit(ctx, "bank_transaction.reopened", transaction.uuid, { previous: transaction.status, match_type: transaction.match_type });
	await syncLedger(project);
	return Utils.ok(ctx, await findTransaction(project.uuid, transaction.uuid));
});
