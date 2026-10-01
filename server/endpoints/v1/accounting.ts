import type { Context } from "@rabbit-company/web";
import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { Permission, type ProjectRole } from "../../roles";
import { accountingActive, redeemLicense } from "../../licensing";
import { Logger } from "../../logger";
import { zonedParts } from "../../timezone";
import { ACCOUNT_CODE, CATEGORY_ACCOUNTS, ensureChart, kindForCode } from "../../accounting/chart";
import { balanced, knownIssues, postEntry, reverseEntry, syncLedger, withLedger, type PostingLine } from "../../accounting/journal";
import { accountLedger, journal, journalEntry, trialBalance } from "../../accounting/reports";
import { accountingYears, closeYear, reopenYear, YearCloseRefused } from "../../accounting/year-end";
import { financialStatements } from "../../accounting/statements";
import { kpoBook } from "../../accounting/kpo";
import { ajpesReport, ajpesXml } from "../../accounting/ajpes";
import { postRevaluation, revaluationPreview, revaluationSource, RevaluationRefused } from "../../accounting/revaluation";
import type { ProjectCompanyRow } from "../../database/models";
import { accountingPeriodLock, closedYear } from "../../accounting-periods";
import { endOfLocalDate, localDate, startOfLocalDate } from "../../timezone";
import type { AppState, JournalEntryRow, LedgerAccountRow, ProjectMemberRow, ProjectRow } from "../../database/models";

const base = "/api/v1/projects/:uuid/accounting";
const MAX_PERIOD = 100 * 366 * 86400000;
const MAX_LINES = 200;

async function body(ctx: Context<AppState>): Promise<Record<string, unknown> | null> {
	try {
		const value = await ctx.body<Record<string, unknown>>();
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

function period(ctx: Context<AppState>): { from: number; to: number } | null {
	const query = ctx.query();
	const timezone = Permissions.project(ctx).timezone;
	const year = zonedParts(Date.now(), timezone).year;
	const from = Number(query.get("from") ?? startOfLocalDate(`${year}-01-01`, timezone));
	const to = Number(query.get("to") ?? endOfLocalDate(`${year}-12-31`, timezone));
	if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to - from > MAX_PERIOD) return null;
	return { from, to };
}

function businessYear(ctx: Context<AppState>, range: { from: number; to: number }): number | null {
	const timezone = Permissions.project(ctx).timezone;
	const year = zonedParts(range.from, timezone).year;
	if (zonedParts(range.to, timezone).year !== year) return null;
	return startOfLocalDate(`${year}-01-01`, timezone);
}

function licensed(ctx: Context<AppState>): boolean {
	return accountingActive(Permissions.project(ctx));
}

async function audit(ctx: Context<AppState>, action: string, entityType: string, entityId: string, value?: unknown, previous?: unknown) {
	await Audit.record(ctx, { project: Permissions.project(ctx).uuid, action, entityType, entityId, newValue: value, oldValue: previous });
}

function presentAccount(row: LedgerAccountRow) {
	return { ...row, active: Boolean(row.active) };
}

async function findAccount(project: string, uuid: string): Promise<LedgerAccountRow | null> {
	const [row] = (await Database`SELECT * FROM ledger_accounts WHERE project = ${project} AND uuid = ${uuid}`) as LedgerAccountRow[];
	return row ?? null;
}

const VAT_ACCOUNTS = new Set(["input_vat", "advance_vat", "output_vat", "self_assessed_vat", "oss_vat"]);

async function vatPeriodLocked(project: string, date: number, accounts: (LedgerAccountRow | undefined)[]): Promise<boolean> {
	if (!accounts.some((account) => account?.system_key && VAT_ACCOUNTS.has(account.system_key))) return false;
	return (await accountingPeriodLock(project, date)) !== null;
}

function validName(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}

Server.app.post(`${base}/sync`, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	return Utils.ok(ctx, await syncLedger(Permissions.project(ctx)));
});

Server.app.get(`${base}/accounts`, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const chart = await ensureChart(Permissions.project(ctx).uuid);
	return Utils.ok(ctx, { accounts: chart.accounts.map(presentAccount), licensed: licensed(ctx) });
});

Server.app.post(`${base}/accounts`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	if (!licensed(ctx)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_LICENSE_REQUIRED);
	const data = await body(ctx);
	const code = typeof data?.code === "string" ? data.code.trim() : "";
	const kind = ACCOUNT_CODE.test(code) ? kindForCode(code) : null;
	if (!data || kind === null || !validName(data.name)) return Utils.fail(ctx, ErrorCode.INVALID_LEDGER_ACCOUNT);
	const project = Permissions.project(ctx).uuid;
	await ensureChart(project);
	const [existing] = await Database`SELECT uuid FROM ledger_accounts WHERE project = ${project} AND code = ${code}`;
	if (existing) return Utils.fail(ctx, ErrorCode.LEDGER_ACCOUNT_EXISTS);
	const uuid = crypto.randomUUID();
	const now = Date.now();
	await Database`
		INSERT INTO ledger_accounts(uuid, project, code, name, account_kind, system_key, active, created, updated)
		VALUES(${uuid}, ${project}, ${code}, ${data.name.trim()}, ${kind}, NULL, 1, ${now}, ${now})
	`;
	const created = (await findAccount(project, uuid))!;
	await audit(ctx, "ledger_account.created", "ledger_account", uuid, created);
	return Utils.ok(ctx, presentAccount(created));
});

Server.app.patch(`${base}/accounts/:account`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	if (!licensed(ctx)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_LICENSE_REQUIRED);
	const project = Permissions.project(ctx).uuid;
	const account = await findAccount(project, ctx.params.account);
	if (!account) return Utils.fail(ctx, ErrorCode.LEDGER_ACCOUNT_NOT_FOUND);
	const data = await body(ctx);
	if (
		!data ||
		(data.name !== undefined && !validName(data.name)) ||
		(data.active !== undefined && typeof data.active !== "boolean") ||
		(data.active === false && account.system_key !== null)
	)
		return Utils.fail(ctx, ErrorCode.INVALID_LEDGER_ACCOUNT);
	const name = typeof data.name === "string" ? data.name.trim() : account.name;
	const active = typeof data.active === "boolean" ? Number(data.active) : account.active;
	await Database`UPDATE ledger_accounts SET name = ${name}, active = ${active}, updated = ${Date.now()} WHERE uuid = ${account.uuid}`;
	const updated = (await findAccount(project, account.uuid))!;
	await audit(ctx, "ledger_account.updated", "ledger_account", account.uuid, updated, account);
	return Utils.ok(ctx, presentAccount(updated));
});

Server.app.get(`${base}/category-accounts`, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx).uuid;
	const chart = await ensureChart(project);
	const used = (await Database`SELECT DISTINCT category FROM expenses WHERE project = ${project}`) as { category: string }[];
	const categories = [...new Set([...Object.keys(CATEGORY_ACCOUNTS), ...used.map((row) => row.category)])].sort((a, b) => a.localeCompare(b));
	return Utils.ok(ctx, { categories: categories.map((category) => ({ category, account: chart.forCategory(category).uuid })) });
});

Server.app.put(`${base}/category-accounts`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	if (!licensed(ctx)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_LICENSE_REQUIRED);
	const project = Permissions.project(ctx).uuid;
	const data = await body(ctx);
	const category = typeof data?.category === "string" ? data.category.trim() : "";
	if (!category || category.length > 80 || typeof data?.account !== "string") return Utils.fail(ctx, ErrorCode.INVALID_LEDGER_ACCOUNT);
	const account = await findAccount(project, data.account);
	if (!account || !account.active) return Utils.fail(ctx, ErrorCode.LEDGER_ACCOUNT_NOT_FOUND);
	const now = Date.now();
	await Database.begin(async (tx) => {
		await tx`DELETE FROM ledger_category_accounts WHERE project = ${project} AND expense_category = ${category}`;
		await tx`INSERT INTO ledger_category_accounts(project, expense_category, ledger_account, updated) VALUES(${project}, ${category}, ${account.uuid}, ${now})`;
	});
	await audit(ctx, "ledger_category.mapped", "ledger_account", account.uuid, { category, account: account.code });
	return Utils.ok(ctx, { category, account: account.uuid, sync: await syncLedger(Permissions.project(ctx)) });
});

Server.app.get(`${base}/journal`, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const range = period(ctx);
	const query = ctx.query();
	const limit = Number(query.get("limit") ?? 50);
	const offset = Number(query.get("offset") ?? 0);
	if (!range || !Number.isSafeInteger(limit) || !Number.isSafeInteger(offset) || limit < 1 || limit > 200 || offset < 0)
		return Utils.fail(ctx, ErrorCode.INVALID_LEDGER_PERIOD);
	const project = Permissions.project(ctx);
	const sync = await syncLedger(project);
	return Utils.ok(ctx, { ...(await journal(project.uuid, range.from, range.to, limit, offset)), issues: sync.issues });
});

Server.app.get(`${base}/journal/:entry`, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const entry = await journalEntry(Permissions.project(ctx).uuid, ctx.params.entry);
	if (!entry) return Utils.fail(ctx, ErrorCode.JOURNAL_ENTRY_NOT_FOUND);
	return Utils.ok(ctx, entry);
});

Server.app.post(`${base}/journal`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	if (!licensed(ctx)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_LICENSE_REQUIRED);
	const project = Permissions.project(ctx);
	const data = await body(ctx);
	const date = Number(data?.date);
	const description = typeof data?.description === "string" ? data.description.trim() : "";
	const rawLines = Array.isArray(data?.lines) ? (data.lines as Record<string, unknown>[]) : [];
	if (!Number.isSafeInteger(date) || date <= 0 || !description || description.length > 500 || rawLines.length > MAX_LINES)
		return Utils.fail(ctx, ErrorCode.INVALID_JOURNAL_ENTRY);
	const chart = await ensureChart(project.uuid);
	const lines: PostingLine[] = [];
	for (const line of rawLines) {
		const account = typeof line?.account === "string" ? chart.byUuid(line.account) : undefined;
		const partner = line?.partner === undefined || line.partner === null ? null : line.partner;
		if (!account || !account.active || (partner !== null && (typeof partner !== "string" || partner.length > 200)))
			return Utils.fail(ctx, ErrorCode.INVALID_JOURNAL_ENTRY);
		lines.push({ ledger_account: account.uuid, debit: Number(line.debit ?? 0), credit: Number(line.credit ?? 0), partner: partner?.trim() || null });
	}
	if (!balanced(lines)) return Utils.fail(ctx, ErrorCode.INVALID_JOURNAL_ENTRY);
	if (await closedYear(project.uuid, date)) return Utils.fail(ctx, ErrorCode.YEAR_CLOSED);
	if (
		await vatPeriodLocked(
			project.uuid,
			date,
			lines.map((line) => chart.byUuid(line.ledger_account))
		)
	)
		return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);
	const author = Auth.account(ctx).username;
	const uuid = crypto.randomUUID();
	const entry = await withLedger(project.uuid, () =>
		Database.begin(async (tx) => postEntry(tx, project, { source_type: "manual", source_id: uuid, date, description, lines }, author))
	);
	await audit(ctx, "journal_entry.posted", "journal_entry", entry.uuid, { description, lines });
	return Utils.ok(ctx, await journalEntry(project.uuid, entry.uuid));
});

async function revaluationPair(project: string, entry: JournalEntryRow): Promise<JournalEntryRow[]> {
	const match = /^fx_revaluation:(\d{4})(:reversal)?$/.exec(entry.source_id);
	if (entry.source_type !== "manual" || !match) return [];
	const other = match[2] ? revaluationSource(Number(match[1])) : `${revaluationSource(Number(match[1]))}:reversal`;
	return (await Database`
		SELECT * FROM journal_entries e WHERE e.project = ${project} AND e.source_type = 'manual' AND e.source_id = ${other} AND e.reverses IS NULL
			AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses = e.uuid)
	`) as JournalEntryRow[];
}

Server.app.post(`${base}/journal/:entry/reverse`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	if (!licensed(ctx)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_LICENSE_REQUIRED);
	const project = Permissions.project(ctx);
	const [entry] = (await Database`SELECT * FROM journal_entries WHERE project = ${project.uuid} AND uuid = ${ctx.params.entry}`) as JournalEntryRow[];
	if (!entry) return Utils.fail(ctx, ErrorCode.JOURNAL_ENTRY_NOT_FOUND);
	const [reversal] = await Database`SELECT uuid FROM journal_entries WHERE reverses = ${entry.uuid}`;
	if (entry.source_type !== "manual" || entry.reverses !== null || reversal) return Utils.fail(ctx, ErrorCode.JOURNAL_ENTRY_NOT_REVERSIBLE);
	if (await closedYear(project.uuid, entry.entry_date)) return Utils.fail(ctx, ErrorCode.YEAR_CLOSED);
	const chart = await ensureChart(project.uuid);
	const touched = (await Database`SELECT ledger_account FROM journal_lines WHERE entry = ${entry.uuid}`) as { ledger_account: string }[];
	if (
		await vatPeriodLocked(
			project.uuid,
			entry.entry_date,
			touched.map((line) => chart.byUuid(line.ledger_account))
		)
	)
		return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);
	const paired = await revaluationPair(project.uuid, entry);
	for (const other of paired) if (await closedYear(project.uuid, other.entry_date)) return Utils.fail(ctx, ErrorCode.YEAR_CLOSED);
	const author = Auth.account(ctx).username;
	const storno = await withLedger(project.uuid, () =>
		Database.begin(async (tx) => {
			for (const other of paired) await reverseEntry(tx, project, other, author);
			return await reverseEntry(tx, project, entry, author);
		})
	);
	await audit(ctx, "journal_entry.reversed", "journal_entry", entry.uuid, { storno: storno.uuid, paired: paired.map((other) => other.uuid) });
	return Utils.ok(ctx, await journalEntry(project.uuid, storno.uuid));
});

Server.app.get(`${base}/trial-balance`, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const range = period(ctx);
	if (!range) return Utils.fail(ctx, ErrorCode.INVALID_LEDGER_PERIOD);
	const yearStart = businessYear(ctx, range);
	if (yearStart === null) return Utils.fail(ctx, ErrorCode.LEDGER_PERIOD_SPANS_YEARS);
	const project = Permissions.project(ctx);
	const sync = await syncLedger(project);
	return Utils.ok(ctx, { ...range, accounts: await trialBalance(project.uuid, range.from, range.to, yearStart), issues: sync.issues });
});

Server.app.get(`${base}/ledger/:account`, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const range = period(ctx);
	if (!range) return Utils.fail(ctx, ErrorCode.INVALID_LEDGER_PERIOD);
	const yearStart = businessYear(ctx, range);
	if (yearStart === null) return Utils.fail(ctx, ErrorCode.LEDGER_PERIOD_SPANS_YEARS);
	const project = Permissions.project(ctx);
	const account = await findAccount(project.uuid, ctx.params.account);
	if (!account) return Utils.fail(ctx, ErrorCode.LEDGER_ACCOUNT_NOT_FOUND);
	await syncLedger(project);
	const ledger = await accountLedger(project.uuid, account, range.from, range.to, yearStart);
	return Utils.ok(ctx, { ...range, ...ledger, account: presentAccount(ledger.account) });
});

Server.app.post(`${base}/license/redeem`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	const data = await body(ctx);
	const code = typeof data?.code === "string" ? data.code.trim() : "";
	if (!code || code.length > 2000) return Utils.fail(ctx, ErrorCode.LICENSE_NOT_FOUND);
	const result = await redeemLicense(project.uuid, code, account.username, ["accounting"]);
	if (typeof result === "number") return Utils.fail(ctx, result);
	await audit(ctx, "license.redeemed", "license_key", result.uuid, { type: result.type, duration_days: result.duration_days });
	Logger.audit(`[LICENSE] ${account.username} redeemed an accounting license on ${project.uuid}`);
	const [updated] = (await Database`SELECT * FROM projects WHERE uuid = ${project.uuid}`) as ProjectRow[];
	return Utils.ok(ctx, { accounting: accountingActive(updated), accounting_until: updated.accounting_until });
});

Server.app.get("/api/v1/accounting/clients", Auth.required(), async (ctx) => {
	const account = Auth.account(ctx);
	const now = Date.now();
	const rows = (await Database`
		SELECT p.*, pm.role AS member_role, pm.additional_permissions AS member_additional, pm.restricted_permissions AS member_restricted
		FROM projects p JOIN project_members pm ON pm.project_id = p.uuid
		WHERE pm.account_username = ${account.username} AND pm.status = 'active' AND (pm.expires_at IS NULL OR pm.expires_at > ${now})
			AND p.status != 'deleted'
		ORDER BY p.name
	`) as (ProjectRow & { member_role: ProjectRole; member_additional: string | null; member_restricted: string | null })[];
	const clients = rows.filter((row) =>
		Permissions.resolve({
			role: row.member_role,
			additional_permissions: row.member_additional,
			restricted_permissions: row.member_restricted,
		} as ProjectMemberRow).has(Permission.LEDGER_EDIT)
	);
	if (clients.length === 0) return Utils.ok(ctx, { clients: [] });

	const ids = clients.map((row) => row.uuid);
	const entries = (await Database`
		SELECT project, year, COUNT(*) AS total, MAX(created) AS last_posted FROM journal_entries WHERE project IN ${Database(ids)} GROUP BY project, year
	`) as { project: string; year: number; total: number; last_posted: number }[];
	const expenses = (await Database`
		SELECT e.project,
			SUM(CASE WHEN e.paid_at IS NULL THEN 1 ELSE 0 END) AS unpaid,
			SUM(CASE WHEN e.vat_treatment <> 'not_reported' AND NOT EXISTS (SELECT 1 FROM expense_attachments ea WHERE ea.expense = e.uuid) THEN 1 ELSE 0 END) AS unattached
		FROM expenses e WHERE e.project IN ${Database(ids)} GROUP BY e.project
	`) as { project: string; unpaid: number; unattached: number }[];

	return Utils.ok(ctx, {
		clients: clients.map((row) => {
			const year = zonedParts(now, row.timezone).year;
			const own = entries.filter((entry) => entry.project === row.uuid);
			const current = own.find((entry) => Number(entry.year) === year);
			const costs = expenses.find((entry) => entry.project === row.uuid);
			const issues = knownIssues(row.uuid);
			return {
				uuid: row.uuid,
				name: row.name,
				display_name: row.display_name,
				role: row.member_role,
				accounting: accountingActive(row),
				accounting_until: row.accounting_until,
				entries_this_year: Number(current?.total ?? 0),
				last_posted: own.length ? Math.max(...own.map((entry) => Number(entry.last_posted))) : null,
				unpaid_expenses: Number(costs?.unpaid ?? 0),
				unattached_expenses: Number(costs?.unattached ?? 0),
				issues: issues === null ? null : issues.length,
			};
		}),
	});
});

Server.app.get(`${base}/years`, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	await syncLedger(project);
	return Utils.ok(ctx, { years: await accountingYears(project) });
});

function yearParam(ctx: Context<AppState>): number | null {
	const year = Number(ctx.params.year);
	return Number.isSafeInteger(year) && year >= 1990 && year <= 9998 ? year : null;
}

Server.app.post(`${base}/years/:year/close`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	if (!licensed(ctx)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_LICENSE_REQUIRED);
	const year = yearParam(ctx);
	if (year === null) return Utils.fail(ctx, ErrorCode.INVALID_LEDGER_PERIOD);
	try {
		const closed = await closeYear(Permissions.project(ctx), year, Auth.account(ctx).username);
		await audit(ctx, "accounting_year.closed", "accounting_year", String(year), closed);
		return Utils.ok(ctx, closed);
	} catch (error) {
		if (!(error instanceof YearCloseRefused)) throw error;
		return Utils.failWithReason(ctx, ErrorCode.YEAR_CLOSE_REFUSED, error.reason, { reason: error.reason, issues: error.issues });
	}
});

Server.app.post(`${base}/years/:year/reopen`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	if (!licensed(ctx)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_LICENSE_REQUIRED);
	const year = yearParam(ctx);
	const data = await body(ctx);
	const reason = typeof data?.reason === "string" ? data.reason.trim() : "";
	if (year === null || reason.length < 3 || reason.length > 500) return Utils.fail(ctx, ErrorCode.YEAR_CLOSE_REFUSED);
	try {
		const reopened = await reopenYear(Permissions.project(ctx), year, Auth.account(ctx).username, reason);
		await audit(ctx, "accounting_year.reopened", "accounting_year", String(year), { reason });
		return Utils.ok(ctx, reopened);
	} catch (error) {
		if (!(error instanceof YearCloseRefused)) throw error;
		return Utils.failWithReason(ctx, ErrorCode.YEAR_CLOSE_REFUSED, error.reason, { reason: error.reason, issues: [] });
	}
});

Server.app.get(`${base}/statements`, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const year = Number(ctx.query().get("year"));
	if (!Number.isSafeInteger(year) || year < 1990 || year > 9998) return Utils.fail(ctx, ErrorCode.INVALID_LEDGER_PERIOD);
	const project = Permissions.project(ctx);
	const sync = await syncLedger(project);
	return Utils.ok(ctx, { ...(await financialStatements(project, year)), issues: sync.issues });
});

Server.app.get(`${base}/kpo`, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const year = Number(ctx.query().get("year"));
	if (!Number.isSafeInteger(year) || year < 1990 || year > 9998) return Utils.fail(ctx, ErrorCode.INVALID_LEDGER_PERIOD);
	const project = Permissions.project(ctx);
	const sync = await syncLedger(project);
	return Utils.ok(ctx, { ...(await kpoBook(project, year)), issues: sync.issues });
});

const BOOKKEEPING = ["company", "sole_double", "sole_simplified", "sole_flat_rate"];

Server.app.put(`${base}/settings`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	if (!licensed(ctx)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_LICENSE_REQUIRED);
	const project = Permissions.project(ctx);
	const data = await body(ctx);
	if (typeof data?.bookkeeping !== "string" || !BOOKKEEPING.includes(data.bookkeeping)) return Utils.fail(ctx, ErrorCode.INVALID_LEDGER_ACCOUNT);
	await Database`UPDATE projects SET bookkeeping = ${data.bookkeeping}, updated = ${Date.now()} WHERE uuid = ${project.uuid}`;
	await audit(ctx, "accounting.settings_updated", "project", project.uuid, { bookkeeping: data.bookkeeping }, { bookkeeping: project.bookkeeping });
	return Utils.ok(ctx, { bookkeeping: data.bookkeeping });
});

function csvCell(value: string | number | null): string {
	const text = value === null ? "" : String(value);
	return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function major(value: number): string {
	return (value / 100).toFixed(2);
}

function csvResponse(rows: (string | number | null)[][], name: string): Response {
	return new Response("\uFEFF" + rows.map((row) => row.map(csvCell).join(";")).join("\n") + "\n", {
		headers: { "Content-Type": "text/csv;charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` },
	});
}

Server.app.get(`${base}/journal/export`, Auth.required(), Permissions.require(Permission.REPORT_EXPORT), async (ctx) => {
	const range = period(ctx);
	if (!range) return Utils.fail(ctx, ErrorCode.INVALID_LEDGER_PERIOD);
	const project = Permissions.project(ctx);
	await syncLedger(project);
	const rows = (await Database`
		SELECT je.year, je.number, je.entry_date, je.description, je.source_type, la.code, la.name, jl.debit, jl.credit, jl.partner
		FROM journal_lines jl JOIN journal_entries je ON je.uuid = jl.entry JOIN ledger_accounts la ON la.uuid = jl.ledger_account
		WHERE jl.project = ${project.uuid} AND je.entry_date BETWEEN ${range.from} AND ${range.to}
		ORDER BY je.year, je.number, jl.sort_order
	`) as {
		year: number;
		number: number;
		entry_date: number;
		description: string;
		source_type: string;
		code: string;
		name: string;
		debit: number;
		credit: number;
		partner: string | null;
	}[];
	return csvResponse(
		[
			["temeljnica", "datum", "opis", "vir", "konto", "naziv_konta", "breme", "dobro", "partner"],
			...rows.map((row) => [
				`${row.year}/${row.number}`,
				localDate(Number(row.entry_date), project.timezone),
				row.description,
				row.source_type,
				row.code,
				row.name,
				major(Number(row.debit)),
				major(Number(row.credit)),
				row.partner,
			]),
		],
		"dnevnik.csv"
	);
});

Server.app.get(`${base}/trial-balance/export`, Auth.required(), Permissions.require(Permission.REPORT_EXPORT), async (ctx) => {
	const range = period(ctx);
	if (!range) return Utils.fail(ctx, ErrorCode.INVALID_LEDGER_PERIOD);
	const yearStart = businessYear(ctx, range);
	if (yearStart === null) return Utils.fail(ctx, ErrorCode.LEDGER_PERIOD_SPANS_YEARS);
	const project = Permissions.project(ctx);
	await syncLedger(project);
	const accounts = await trialBalance(project.uuid, range.from, range.to, yearStart);
	return csvResponse(
		[
			["konto", "naziv_konta", "zacetno_stanje", "breme", "dobro", "koncno_stanje"],
			...accounts.map((row) => [row.code, row.name, major(row.opening), major(row.debit), major(row.credit), major(row.closing)]),
		],
		"bruto-bilanca.csv"
	);
});

Server.app.put(`${base}/years/:year/deductible-share`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	if (!licensed(ctx)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_LICENSE_REQUIRED);
	const year = yearParam(ctx);
	const data = await body(ctx);
	const share = data?.final_share;
	if (year === null || (share !== null && (typeof share !== "number" || !Number.isFinite(share) || share < 0 || share > 100)))
		return Utils.fail(ctx, ErrorCode.INVALID_LEDGER_PERIOD);
	const project = Permissions.project(ctx);
	const [row] =
		(await Database`SELECT 1 AS closed FROM accounting_years WHERE project = ${project.uuid} AND year = ${year} AND reopened_at IS NULL`) as unknown[];
	if (row) return Utils.fail(ctx, ErrorCode.YEAR_CLOSED);
	await Database`DELETE FROM deductible_shares WHERE project = ${project.uuid} AND year = ${year}`;
	if (share !== null) {
		await Database`
			INSERT INTO deductible_shares(project, year, final_share, updated_by, updated) VALUES(${project.uuid}, ${year}, ${share}, ${Auth.account(ctx).username}, ${Date.now()})
		`;
	}
	await audit(ctx, "accounting_year.deductible_share", "accounting_year", String(year), { final_share: share });
	await syncLedger(project);
	return Utils.ok(
		ctx,
		(await accountingYears(project)).find((item) => item.year === year)
	);
});

Server.app.get(`${base}/ajpes`, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const year = Number(ctx.query().get("year"));
	if (!Number.isSafeInteger(year) || year < 1990 || year > 9998) return Utils.fail(ctx, ErrorCode.INVALID_LEDGER_PERIOD);
	const project = Permissions.project(ctx);
	const sync = await syncLedger(project);
	return Utils.ok(ctx, { ...(await ajpesReport(project, year)), issues: sync.issues });
});

Server.app.get(`${base}/ajpes/export`, Auth.required(), Permissions.require(Permission.REPORT_EXPORT), async (ctx) => {
	const year = Number(ctx.query().get("year"));
	if (!Number.isSafeInteger(year) || year < 1990 || year > 9998) return Utils.fail(ctx, ErrorCode.INVALID_LEDGER_PERIOD);
	const project = Permissions.project(ctx);
	const [company] = (await Database`SELECT * FROM project_company WHERE project = ${project.uuid}`) as ProjectCompanyRow[];
	const registration = company?.registration_number?.replace(/\s+/g, "") ?? "";
	if (!/^[0-9]{7,10}$/.test(registration)) return Utils.fail(ctx, ErrorCode.AJPES_REGISTRATION_NUMBER_REQUIRED);
	await syncLedger(project);
	const taxNumber = (company.tax_number ?? company.vat_number ?? "").replace(/^SI/i, "").replace(/\D/g, "");
	const xml = ajpesXml(
		await ajpesReport(project, year),
		{
			registration_number: registration,
			tax_number: /^[0-9]{8}$/.test(taxNumber) ? taxNumber : null,
			name: company.legal_name,
		},
		project.bookkeeping
	);
	return new Response(xml, {
		headers: { "Content-Type": "application/xml;charset=utf-8", "Content-Disposition": `attachment; filename="ajpes-${year}.xml"` },
	});
});

function exchangeRates(value: unknown): Record<string, number> | null {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) return null;
	const rates: Record<string, number> = {};
	for (const [currency, rate] of Object.entries(value as Record<string, unknown>)) {
		if (!/^[A-Z]{3}$/.test(currency) || typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
		rates[currency] = rate;
	}
	return rates;
}

Server.app.get(`${base}/years/:year/revaluation`, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const year = yearParam(ctx);
	if (year === null) return Utils.fail(ctx, ErrorCode.INVALID_LEDGER_PERIOD);
	const project = Permissions.project(ctx);
	await syncLedger(project);
	return Utils.ok(ctx, await revaluationPreview(project, year, {}));
});

Server.app.post(`${base}/years/:year/revaluation`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	if (!licensed(ctx)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_LICENSE_REQUIRED);
	const year = yearParam(ctx);
	const data = await body(ctx);
	const rates = exchangeRates(data?.rates);
	if (year === null || rates === null) return Utils.fail(ctx, ErrorCode.INVALID_REVALUATION);
	const project = Permissions.project(ctx);
	if (data?.preview === true) return Utils.ok(ctx, await revaluationPreview(project, year, rates));
	await syncLedger(project);
	try {
		const posted = await postRevaluation(project, year, rates, Auth.account(ctx).username);
		await audit(ctx, "accounting_year.revalued", "accounting_year", String(year), { rates, ...posted });
		return Utils.ok(ctx, await revaluationPreview(project, year, rates));
	} catch (error) {
		if (!(error instanceof RevaluationRefused)) throw error;
		if (error.reason === "year_closed") return Utils.fail(ctx, ErrorCode.YEAR_CLOSED);
		if (error.reason === "already_revalued") return Utils.fail(ctx, ErrorCode.REVALUATION_EXISTS);
		if (error.reason === "year_not_over") return Utils.failWithReason(ctx, ErrorCode.YEAR_CLOSE_REFUSED, error.reason, { reason: error.reason, issues: [] });
		return Utils.fail(ctx, ErrorCode.INVALID_REVALUATION);
	}
});
