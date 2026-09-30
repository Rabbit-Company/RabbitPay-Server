import type { Context } from "@rabbit-company/web";
import { bodyLimit } from "@rabbit-company/web-middleware/body-limit";
import { createHash } from "node:crypto";
import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { firstRunFrom, nextRunAfter, startOfDay } from "../../recurring-schedule";
import { insertExpense, validExpense, validExpenseSchedule, type ExpenseInput, type ExpenseScheduleInput } from "../../expense-service";
import type { AppState, ExpenseAttachmentRow, ExpenseRow, ExpenseVatLineRow, RecurringExpenseRow } from "../../database/models";
import { documentStorage } from "../../document-storage";
import { hasStorageCapacity } from "../../licensing";
import { accountingPeriodLocked } from "../../accounting-periods";
import { parseExpenseImport } from "../../expense-import";
import Errors from "../../errors";
import {
	EINVOICE_CONTENT_TYPE,
	EinvoiceUnreadable,
	MAX_EINVOICE_BYTES,
	readIncomingInvoice,
	suggestExpense,
	type ImportSuggestion,
} from "../../einvoice-import";

const base = "/api/v1/projects/:uuid";
const attachmentBody = bodyLimit<AppState>({ maxSize: 28 * 1024 * 1024, message: "The file is too large." });
const einvoiceBody = bodyLimit<AppState>({ maxSize: 7 * 1024 * 1024, message: "The file is too large." });

async function body(ctx: Context<AppState>): Promise<Record<string, unknown> | null> {
	try {
		const value = await ctx.body<Record<string, unknown>>();
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

function expenseInput(data: Record<string, unknown>, currency: string, previous?: ExpenseRow, vatLines: ExpenseVatLineRow[] = []): ExpenseInput {
	return {
		supplier: null,
		supplier_tax_number: null,
		supplier_country: null,
		invoice_number: null,
		issue_date: null,
		receipt_date: null,
		supply_date: null,
		vat_treatment: "not_reported",
		asset_type: "expense",
		vat_handling: "1",
		self_assessment_period: null,
		self_assessment_tax: null,
		tax_exchange_rate: null,
		tax_rate_date: null,
		vat_lines: vatLines.map(({ rate, tax_base, tax_amount, deductible_tax_amount }) => ({ rate, tax_base, tax_amount, deductible_tax_amount })),
		notes: null,
		tax_amount: 0,
		deductible_tax_amount: 0,
		paid_at: null,
		currency,
		...previous,
		...data,
	} as ExpenseInput;
}

async function expenseDetails(row: ExpenseRow) {
	const vatLines = (await Database`SELECT * FROM expense_vat_lines WHERE expense = ${row.uuid} ORDER BY sort_order`) as ExpenseVatLineRow[];
	const [attachment] =
		(await Database`SELECT file_name, content_type, byte_size, sha256, created FROM expense_attachments WHERE expense = ${row.uuid}`) as ExpenseAttachmentRow[];
	return { ...row, vat_lines: vatLines, attachment: attachment ?? null };
}

async function audit(ctx: Context<AppState>, action: string, uuid: string, value?: unknown, previous?: unknown) {
	await Audit.record(ctx, {
		project: Permissions.project(ctx).uuid,
		action,
		entityType: action.startsWith("expense_schedule") ? "recurring_expense" : "expense",
		entityId: uuid,
		newValue: value,
		oldValue: previous,
	});
}

Server.app.get(`${base}/expenses`, Auth.required(), Permissions.require(Permission.EXPENSE_VIEW), async (ctx) => {
	const query = ctx.query();
	const limit = Number(query.get("limit") ?? 50);
	const offset = Number(query.get("offset") ?? 0);
	const from = Number(query.get("from") ?? 0);
	const to = Number(query.get("to") ?? Number.MAX_SAFE_INTEGER);
	const status = query.get("status");
	if (
		![limit, offset, from, to].every(Number.isSafeInteger) ||
		limit < 1 ||
		limit > 200 ||
		offset < 0 ||
		from < 0 ||
		to < from ||
		(status !== null && !["paid", "unpaid"].includes(status))
	)
		return Utils.fail(ctx, ErrorCode.INVALID_EXPENSE);
	const project = Permissions.project(ctx).uuid;
	const filter = status === "paid" ? Database`AND paid_at IS NOT NULL` : status === "unpaid" ? Database`AND paid_at IS NULL` : Database``;
	const rows =
		(await Database`SELECT * FROM expenses WHERE project = ${project} AND expense_date >= ${from} AND expense_date <= ${to} ${filter} ORDER BY expense_date DESC, created DESC LIMIT ${limit} OFFSET ${offset}`) as ExpenseRow[];
	const [count] =
		(await Database`SELECT COUNT(*) AS total FROM expenses WHERE project = ${project} AND expense_date >= ${from} AND expense_date <= ${to} ${filter}`) as {
			total: number;
		}[];
	return Utils.ok(ctx, { expenses: await Promise.all(rows.map(expenseDetails)), total: Number(count.total), limit, offset });
});

Server.app.post(`${base}/expenses`, Auth.required(), Permissions.require(Permission.EXPENSE_CREATE), async (ctx) => {
	const raw = await body(ctx);
	if (!raw) return Utils.fail(ctx, ErrorCode.INVALID_EXPENSE);
	const project = Permissions.project(ctx);
	const data = expenseInput(raw, project.currency);
	if (!validExpense(data)) return Utils.fail(ctx, ErrorCode.INVALID_EXPENSE);
	if (await accountingPeriodLocked(project.uuid, data.expense_date)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);
	const uuid = await Database.begin(async (tx) => insertExpense(tx, project.uuid, data, Auth.account(ctx).username));
	const [row] = await Database`SELECT * FROM expenses WHERE uuid = ${uuid}`;
	const detailed = await expenseDetails(row as ExpenseRow);
	await audit(ctx, "expense.created", uuid, detailed);
	return Utils.ok(ctx, detailed, 201);
});

async function uploadedEinvoice(ctx: Context<AppState>): Promise<{ name: string; bytes: Buffer } | null> {
	const raw = await body(ctx);
	const encoded = raw?.data;
	const name = typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 250) : "e-invoice.xml";
	if (typeof encoded !== "string") return null;
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.length === 0 || bytes.length > MAX_EINVOICE_BYTES || bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/\s|=+$/g, "")) return null;
	return { name, bytes };
}

async function importSuggestion(ctx: Context<AppState>, file: { bytes: Buffer }): Promise<ImportSuggestion | Response> {
	try {
		return await suggestExpense(Permissions.project(ctx), readIncomingInvoice(new Uint8Array(file.bytes)));
	} catch (error) {
		if (error instanceof EinvoiceUnreadable) return Utils.failWithReason(ctx, ErrorCode.INVALID_EINVOICE, error.message);
		throw error;
	}
}

Server.app.post(`${base}/expenses/import/preview`, einvoiceBody, Auth.required(), Permissions.require(Permission.EXPENSE_CREATE), async (ctx) => {
	const file = await uploadedEinvoice(ctx);
	if (!file) return Utils.fail(ctx, ErrorCode.INVALID_EINVOICE);
	const suggestion = await importSuggestion(ctx, file);
	if (suggestion instanceof Response) return suggestion;
	return Utils.ok(ctx, suggestion);
});

Server.app.post(`${base}/expenses/import`, einvoiceBody, Auth.required(), Permissions.require(Permission.EXPENSE_CREATE), async (ctx) => {
	const project = Permissions.project(ctx);
	const file = await uploadedEinvoice(ctx);
	if (!file) return Utils.fail(ctx, ErrorCode.INVALID_EINVOICE);
	const suggestion = await importSuggestion(ctx, file);
	if (suggestion instanceof Response) return suggestion;
	if (suggestion.duplicate)
		return Utils.failWithReason(ctx, ErrorCode.EXPENSE_ALREADY_IMPORTED, Errors.get(ErrorCode.EXPENSE_ALREADY_IMPORTED).message, {
			expense: suggestion.duplicate,
		});
	if (!validExpense(suggestion.expense)) {
		return Utils.failWithReason(
			ctx,
			ErrorCode.INVALID_EXPENSE,
			"The e-invoice needs changes before it can be saved. Import it through the preview instead.",
			suggestion
		);
	}
	if (await accountingPeriodLocked(project.uuid, suggestion.expense.expense_date)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);
	if (!(await hasStorageCapacity(project.uuid, file.bytes.length))) return Utils.fail(ctx, ErrorCode.STORAGE_LIMIT_REACHED);

	const key = `expenses/${project.uuid}/imported/${crypto.randomUUID()}`;
	await documentStorage().put(key, file.bytes, EINVOICE_CONTENT_TYPE);
	const sha256 = createHash("sha256").update(file.bytes).digest("hex");
	const uuid = await Database.begin(async (tx) => {
		const created = await insertExpense(tx, project.uuid, suggestion.expense, Auth.account(ctx).username);
		await tx`INSERT INTO expense_attachments(expense, storage_key, file_name, content_type, byte_size, sha256, created)
			VALUES(${created}, ${key}, ${file.name}, ${EINVOICE_CONTENT_TYPE}, ${file.bytes.length}, ${sha256}, ${Date.now()})`;
		return created;
	});
	const [row] = await Database`SELECT * FROM expenses WHERE uuid = ${uuid}`;
	const detailed = await expenseDetails(row as ExpenseRow);
	await audit(ctx, "expense.imported", uuid, { ...detailed, format: suggestion.invoice.format, warnings: suggestion.warnings });
	return Utils.ok(ctx, { expense: detailed, warnings: suggestion.warnings }, 201);
});

Server.app.patch(`${base}/expenses/:expense`, Auth.required(), Permissions.require(Permission.EXPENSE_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const [row] = (await Database`SELECT * FROM expenses WHERE uuid = ${ctx.params.expense} AND project = ${project.uuid}`) as ExpenseRow[];
	if (!row) return Utils.fail(ctx, ErrorCode.EXPENSE_NOT_FOUND);
	const raw = await body(ctx);
	if (!raw) return Utils.fail(ctx, ErrorCode.INVALID_EXPENSE);
	const previousLines = (await Database`SELECT * FROM expense_vat_lines WHERE expense = ${row.uuid} ORDER BY sort_order`) as ExpenseVatLineRow[];
	const data = expenseInput(raw, project.currency, row, previousLines);
	if (!validExpense(data)) return Utils.fail(ctx, ErrorCode.INVALID_EXPENSE);
	if ((await accountingPeriodLocked(project.uuid, row.expense_date)) || (await accountingPeriodLocked(project.uuid, data.expense_date))) {
		return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);
	}
	await Database.begin(async (tx) => {
		await tx`UPDATE expenses SET description = ${data.description.trim()}, supplier = ${data.supplier?.trim() || null},
			supplier_tax_number = ${data.supplier_tax_number?.trim() || null}, supplier_country = ${data.supplier_country}, invoice_number = ${data.invoice_number?.trim() || null},
			category = ${data.category.trim()}, currency = ${data.currency}, total_amount = ${data.total_amount}, tax_amount = ${data.tax_amount},
			deductible_tax_amount = ${data.deductible_tax_amount}, expense_date = ${data.expense_date}, issue_date = ${data.issue_date},
			receipt_date = ${data.receipt_date}, supply_date = ${data.supply_date}, vat_treatment = ${data.vat_treatment}, asset_type = ${data.asset_type},
			vat_handling = ${data.vat_handling}, self_assessment_period = ${data.self_assessment_period}, self_assessment_tax = ${data.self_assessment_tax},
			tax_exchange_rate = ${data.tax_exchange_rate}, tax_rate_date = ${data.tax_rate_date},
			paid_at = ${data.paid_at}, notes = ${data.notes?.trim() || null}, provisional_share = ${data.provisional_share ? 1 : 0}, updated = ${Date.now()}
			WHERE uuid = ${row.uuid}`;
		await tx`DELETE FROM expense_vat_lines WHERE expense = ${row.uuid}`;
		for (const [sort, line] of data.vat_lines.entries()) {
			await tx`INSERT INTO expense_vat_lines(uuid, expense, rate, tax_base, tax_amount, deductible_tax_amount, sort_order)
				VALUES(${crypto.randomUUID()}, ${row.uuid}, ${line.rate}, ${line.tax_base}, ${line.tax_amount}, ${line.deductible_tax_amount}, ${sort})`;
		}
	});
	const [updated] = await Database`SELECT * FROM expenses WHERE uuid = ${row.uuid}`;
	const detailed = await expenseDetails(updated as ExpenseRow);
	await audit(ctx, "expense.updated", row.uuid, detailed, { ...row, vat_lines: previousLines });
	return Utils.ok(ctx, detailed);
});

Server.app.delete(`${base}/expenses/:expense`, Auth.required(), Permissions.require(Permission.EXPENSE_DELETE), async (ctx) => {
	const [row] = (await Database`SELECT * FROM expenses WHERE uuid = ${ctx.params.expense} AND project = ${Permissions.project(ctx).uuid}`) as ExpenseRow[];
	if (!row) return Utils.fail(ctx, ErrorCode.EXPENSE_NOT_FOUND);
	if (await accountingPeriodLocked(row.project, row.expense_date)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);
	const [attachment] = (await Database`SELECT * FROM expense_attachments WHERE expense = ${row.uuid}`) as ExpenseAttachmentRow[];
	await Database`DELETE FROM expenses WHERE uuid = ${row.uuid}`;
	if (attachment) await documentStorage().remove(attachment.storage_key);
	await audit(ctx, "expense.deleted", row.uuid, undefined, row);
	return Utils.ok(ctx);
});

Server.app.put(`${base}/expenses/:expense/attachment`, attachmentBody, Auth.required(), Permissions.require(Permission.EXPENSE_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const [expense] = (await Database`SELECT * FROM expenses WHERE uuid = ${ctx.params.expense} AND project = ${project.uuid}`) as ExpenseRow[];
	if (!expense) return Utils.fail(ctx, ErrorCode.EXPENSE_NOT_FOUND);
	if (await accountingPeriodLocked(project.uuid, expense.expense_date)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);
	const raw = await body(ctx);
	const name = raw?.name;
	const type = raw?.type;
	const encoded = raw?.data;
	const allowed = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/tiff", "application/xml", "text/xml"]);
	if (typeof name !== "string" || !name.trim() || name.length > 250 || typeof type !== "string" || !allowed.has(type) || typeof encoded !== "string")
		return Utils.fail(ctx, ErrorCode.INVALID_EXPENSE_ATTACHMENT);
	let bytes: Buffer;
	try {
		bytes = Buffer.from(encoded, "base64");
	} catch {
		return Utils.fail(ctx, ErrorCode.INVALID_EXPENSE_ATTACHMENT);
	}
	if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024 || bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/\s|=+$/g, ""))
		return Utils.fail(ctx, ErrorCode.INVALID_EXPENSE_ATTACHMENT);
	const [previous] = (await Database`SELECT * FROM expense_attachments WHERE expense = ${expense.uuid}`) as ExpenseAttachmentRow[];
	if (!(await hasStorageCapacity(project.uuid, bytes.length, previous?.byte_size ?? 0))) return Utils.fail(ctx, ErrorCode.STORAGE_LIMIT_REACHED);
	const key = `expenses/${project.uuid}/${expense.uuid}/${crypto.randomUUID()}`;
	await documentStorage().put(key, bytes, type);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const created = Date.now();
	await Database.begin(async (tx) => {
		await tx`DELETE FROM expense_attachments WHERE expense = ${expense.uuid}`;
		await tx`INSERT INTO expense_attachments(expense, storage_key, file_name, content_type, byte_size, sha256, created)
			VALUES(${expense.uuid}, ${key}, ${name.trim()}, ${type}, ${bytes.length}, ${sha256}, ${created})`;
	});
	if (previous) await documentStorage().remove(previous.storage_key);
	const value = { file_name: name.trim(), content_type: type, byte_size: bytes.length, sha256, created };
	await audit(ctx, "expense.attachment_updated", expense.uuid, value, previous);
	return Utils.ok(ctx, value);
});

Server.app.get(`${base}/expenses/:expense/attachment`, Auth.required(), Permissions.require(Permission.EXPENSE_VIEW), async (ctx) => {
	const [attachment] = (await Database`
		SELECT ea.* FROM expense_attachments ea JOIN expenses e ON e.uuid = ea.expense
		WHERE ea.expense = ${ctx.params.expense} AND e.project = ${Permissions.project(ctx).uuid}
	`) as ExpenseAttachmentRow[];
	if (!attachment) return Utils.fail(ctx, ErrorCode.EXPENSE_ATTACHMENT_NOT_FOUND);
	const bytes = await documentStorage().get(attachment.storage_key);
	const fallback = attachment.file_name.replace(/[^A-Za-z0-9._-]/g, "_") || "attachment";
	return new Response(bytes, {
		headers: {
			"Content-Type": attachment.content_type,
			"Content-Length": String(bytes.length),
			"Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(attachment.file_name)}`,
			"X-Content-Type-Options": "nosniff",
		},
	});
});

Server.app.delete(`${base}/expenses/:expense/attachment`, Auth.required(), Permissions.require(Permission.EXPENSE_EDIT), async (ctx) => {
	const [attachment] = (await Database`
		SELECT ea.*, e.project, e.expense_date FROM expense_attachments ea JOIN expenses e ON e.uuid = ea.expense
		WHERE ea.expense = ${ctx.params.expense} AND e.project = ${Permissions.project(ctx).uuid}
	`) as (ExpenseAttachmentRow & { project: string; expense_date: number })[];
	if (!attachment) return Utils.fail(ctx, ErrorCode.EXPENSE_ATTACHMENT_NOT_FOUND);
	if (await accountingPeriodLocked(attachment.project, attachment.expense_date)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);
	await Database`DELETE FROM expense_attachments WHERE expense = ${attachment.expense}`;
	await documentStorage().remove(attachment.storage_key);
	await audit(ctx, "expense.attachment_removed", attachment.expense, undefined, attachment);
	return Utils.ok(ctx);
});

Server.app.get(`${base}/expense-schedules`, Auth.required(), Permissions.require(Permission.EXPENSE_VIEW), async (ctx) => {
	const rows =
		(await Database`SELECT * FROM recurring_expenses WHERE project = ${Permissions.project(ctx).uuid} ORDER BY created DESC, uuid ASC`) as RecurringExpenseRow[];
	return Utils.ok(
		ctx,
		rows.map((row) => ({ ...row, auto_paid: Boolean(row.auto_paid) }))
	);
});

Server.app.post(`${base}/expense-schedules`, Auth.required(), Permissions.require(Permission.EXPENSE_CREATE), async (ctx) => {
	const raw = await body(ctx);
	if (!raw) return Utils.fail(ctx, ErrorCode.INVALID_EXPENSE);
	const project = Permissions.project(ctx);
	const data = {
		supplier: null,
		supplier_tax_number: null,
		supplier_country: null,
		invoice_number: null,
		notes: null,
		tax_amount: 0,
		deductible_tax_amount: 0,
		issue_date: null,
		receipt_date: null,
		supply_date: null,
		vat_treatment: "not_reported",
		asset_type: "expense",
		vat_handling: "1",
		self_assessment_period: null,
		self_assessment_tax: null,
		tax_exchange_rate: null,
		tax_rate_date: null,
		vat_lines: [],
		currency: project.currency,
		interval_count: 1,
		end_date: null,
		max_occurrences: null,
		auto_paid: false,
		...raw,
	} as unknown as ExpenseScheduleInput;
	if (!validExpenseSchedule(data)) return Utils.fail(ctx, ErrorCode.INVALID_EXPENSE);
	const uuid = crypto.randomUUID();
	const now = Date.now();
	const startDate = startOfDay(data.start_date, project.timezone);
	await Database`INSERT INTO recurring_expenses(uuid, project, description, supplier, supplier_tax_number, supplier_country, category, currency, total_amount, tax_amount,
		deductible_tax_amount, vat_treatment, asset_type, notes, interval_unit, interval_count, anchor_date, next_run_at, end_date, max_occurrences, auto_paid, created_by, created, updated)
		VALUES(${uuid}, ${project.uuid}, ${data.description.trim()}, ${data.supplier?.trim() || null}, ${data.supplier_tax_number?.trim() || null},
			${data.supplier_country}, ${data.category.trim()}, ${data.currency}, ${data.total_amount}, ${data.tax_amount}, ${data.deductible_tax_amount},
			${data.vat_treatment}, ${data.asset_type}, ${data.notes?.trim() || null}, ${data.interval_unit},
			${data.interval_count}, ${startDate}, ${startDate}, ${data.end_date}, ${data.max_occurrences}, ${data.auto_paid ? 1 : 0}, ${Auth.account(ctx).username}, ${now}, ${now})`;
	const [row] = await Database`SELECT * FROM recurring_expenses WHERE uuid = ${uuid}`;
	await audit(ctx, "expense_schedule.created", uuid, row);
	return Utils.ok(ctx, { ...row, auto_paid: Boolean(row.auto_paid) }, 201);
});

Server.app.patch(`${base}/expense-schedules/:schedule`, Auth.required(), Permissions.require(Permission.EXPENSE_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const [row] = (await Database`SELECT * FROM recurring_expenses WHERE uuid = ${ctx.params.schedule} AND project = ${project.uuid}`) as RecurringExpenseRow[];
	if (!row) return Utils.fail(ctx, ErrorCode.EXPENSE_SCHEDULE_NOT_FOUND);
	if (row.status === "canceled") return Utils.fail(ctx, ErrorCode.EXPENSE_SCHEDULE_CLOSED);
	const raw = await body(ctx);
	if (!raw) return Utils.fail(ctx, ErrorCode.INVALID_EXPENSE);
	const data = {
		...row,
		invoice_number: null,
		issue_date: null,
		receipt_date: null,
		supply_date: null,
		vat_handling: "1",
		self_assessment_period: null,
		self_assessment_tax: null,
		tax_exchange_rate: null,
		tax_rate_date: null,
		vat_lines: [],
		start_date: row.anchor_date,
		auto_paid: Boolean(row.auto_paid),
		...raw,
	} as ExpenseScheduleInput & {
		status?: RecurringExpenseRow["status"];
	};
	if (!validExpenseSchedule(data) || (raw.status !== undefined && !["active", "paused", "canceled"].includes(raw.status as string)))
		return Utils.fail(ctx, ErrorCode.INVALID_EXPENSE);
	const changed =
		raw.start_date !== undefined ||
		(raw.interval_unit !== undefined && raw.interval_unit !== row.interval_unit) ||
		(raw.interval_count !== undefined && raw.interval_count !== row.interval_count);
	let anchor = changed
		? raw.start_date !== undefined
			? startOfDay(data.start_date, project.timezone)
			: (row.next_run_at ?? firstRunFrom(row, row.occurrences, startOfDay(Date.now(), project.timezone), project.timezone))
		: row.anchor_date;
	let occurrence = changed ? row.occurrences : row.anchor_occurrence;
	let status = data.status ?? row.status;
	if (raw.status === "active" && row.status === "paused" && !changed) {
		anchor = firstRunFrom(row, row.occurrences, startOfDay(Date.now(), project.timezone), project.timezone);
		occurrence = row.occurrences;
	}
	const next =
		status === "canceled"
			? null
			: nextRunAfter(
					{ interval_unit: data.interval_unit, interval_count: data.interval_count, anchor_date: anchor, anchor_occurrence: occurrence },
					data,
					row.occurrences,
					project.timezone
				);
	if (next === null && status !== "canceled") status = "completed";
	else if (next !== null && status === "completed") status = "paused";
	const changedRow = await Database`UPDATE recurring_expenses SET description = ${data.description.trim()}, supplier = ${data.supplier?.trim() || null},
		supplier_tax_number = ${data.supplier_tax_number?.trim() || null}, supplier_country = ${data.supplier_country},
		category = ${data.category.trim()}, currency = ${data.currency}, total_amount = ${data.total_amount}, tax_amount = ${data.tax_amount},
		deductible_tax_amount = ${data.deductible_tax_amount}, vat_treatment = ${data.vat_treatment}, asset_type = ${data.asset_type},
		notes = ${data.notes?.trim() || null}, interval_unit = ${data.interval_unit},
		interval_count = ${data.interval_count}, anchor_date = ${anchor}, anchor_occurrence = ${occurrence}, next_run_at = ${next},
		end_date = ${data.end_date}, max_occurrences = ${data.max_occurrences}, auto_paid = ${data.auto_paid ? 1 : 0}, status = ${status}, updated = ${Math.max(Date.now(), row.updated + 1)} WHERE uuid = ${row.uuid} AND updated = ${row.updated}`;
	if (changedRow.count === 0) return Utils.fail(ctx, ErrorCode.EXPENSE_SCHEDULE_CHANGED);
	const [updated] = await Database`SELECT * FROM recurring_expenses WHERE uuid = ${row.uuid}`;
	await audit(ctx, "expense_schedule.updated", row.uuid, updated, row);
	return Utils.ok(ctx, { ...updated, auto_paid: Boolean(updated.auto_paid) });
});

const csvBody = bodyLimit<AppState>({ maxSize: 5 * 1024 * 1024, message: "The file is too large." });

async function csvContent(ctx: Context<AppState>): Promise<string | null> {
	const raw = await body(ctx);
	return typeof raw?.content === "string" ? raw.content : null;
}

Server.app.post(`${base}/expenses/import-csv/preview`, csvBody, Auth.required(), Permissions.require(Permission.EXPENSE_CREATE), async (ctx) => {
	const content = await csvContent(ctx);
	if (content === null) return Utils.fail(ctx, ErrorCode.INVALID_EXPENSE);
	return Utils.ok(ctx, await parseExpenseImport(content, Permissions.project(ctx)));
});

Server.app.post(`${base}/expenses/import-csv`, csvBody, Auth.required(), Permissions.require(Permission.EXPENSE_CREATE), async (ctx) => {
	const content = await csvContent(ctx);
	if (content === null) return Utils.fail(ctx, ErrorCode.INVALID_EXPENSE);
	const project = Permissions.project(ctx);
	const plan = await parseExpenseImport(content, project);
	if (plan.errors.length > 0 || plan.documents.length === 0)
		return Utils.failWithReason(ctx, ErrorCode.INVALID_EXPENSE, "Fix the rows with errors before importing. Nothing was imported.", plan);
	const author = Auth.account(ctx).username;
	const created = await Database.begin(async (tx) => {
		const ids: string[] = [];
		for (const document of plan.documents) ids.push(await insertExpense(tx, project.uuid, document.input, author));
		return ids;
	});
	await Audit.record(ctx, {
		project: project.uuid,
		action: "expense.csv_imported",
		entityType: "expense",
		entityId: created[0],
		newValue: { count: created.length, invoices: plan.documents.map((document) => document.input.invoice_number) },
	});
	return Utils.ok(ctx, { imported: created.length }, 201);
});
