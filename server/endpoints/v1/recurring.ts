import type { Context } from "@rabbit-company/web";
import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { Permission } from "../../roles";
import { calculateTotals } from "../../invoicing";
import {
	generateNext,
	limitsOf,
	loadRecurring,
	loadRecurringItems,
	presentRecurring,
	replaceRecurringItems,
	toInvoiceItems,
	validateRecurringInput,
	type RecurringInput,
} from "../../recurring-service";
import { firstRunFrom, nextRunAfter, startOfDay, type Schedule } from "../../recurring-schedule";
import type { AppState, InvoiceRow, RecurringInvoiceItemRow, RecurringInvoiceRow, RecurringStatus } from "../../database/models";

const LISTED_STATUSES = new Set<RecurringStatus>(["active", "paused", "completed", "canceled"]);
const OPEN_STATUSES: RecurringStatus[] = ["active", "paused"];

async function readBody(ctx: Context<AppState>): Promise<RecurringInput | null> {
	try {
		const body = await ctx.body<RecurringInput>();
		return typeof body === "object" && body !== null ? body : null;
	} catch {
		return null;
	}
}

async function findTemplate(ctx: Context<AppState>): Promise<RecurringInvoiceRow | ErrorCode> {
	const recurringId = ctx.params["recurring"];
	if (!Validate.uuid(recurringId)) return ErrorCode.RECURRING_NOT_FOUND;
	const template = await loadRecurring(Permissions.project(ctx).uuid, recurringId);
	return template ?? ErrorCode.RECURRING_NOT_FOUND;
}

async function detail(template: RecurringInvoiceRow, timezone: string) {
	const [fresh] = (await Database`SELECT * FROM recurring_invoices WHERE uuid = ${template.uuid}`) as RecurringInvoiceRow[];
	const [customer] = (await Database`SELECT uuid, name, email FROM customers WHERE uuid = ${fresh.customer}`) as {
		uuid: string;
		name: string | null;
		email: string;
	}[];
	const invoices = (await Database`
		SELECT uuid, reference, status, currency, total_amount, paid_amount, refunded_amount, credited_amount, due_date, issued_at, created
		FROM invoices WHERE recurring = ${fresh.uuid} ORDER BY created DESC LIMIT 100
	`) as Partial<InvoiceRow>[];

	return { ...presentRecurring(fresh, await loadRecurringItems(fresh.uuid), timezone), customer_detail: customer ?? null, invoices };
}

function statusAfterSchedule(occurrences: number, schedule: Schedule, limits: ReturnType<typeof limitsOf>, current: RecurringStatus, timezone: string) {
	const next = nextRunAfter(schedule, limits, occurrences, timezone);
	if (next === null) return { next, status: "completed" as RecurringStatus };
	return { next, status: current === "completed" ? ("active" as RecurringStatus) : current };
}

Server.app.get("/api/v1/projects/:uuid/recurring", Auth.required(), Permissions.require(Permission.SUBSCRIPTION_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();

	const status = query.get("status");
	const customer = query.get("customer");
	const search = query.get("search")?.trim() || null;
	if (status !== null && !LISTED_STATUSES.has(status as RecurringStatus)) return Utils.fail(ctx, ErrorCode.INVALID_RECURRING);
	if (customer !== null && !Validate.uuid(customer)) return Utils.fail(ctx, ErrorCode.INVALID_CUSTOMER_ID);
	if (search !== null && !Validate.shortText(search, 64)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	const pattern = `%${(search ?? "").toLowerCase()}%`;
	const statusFilter = status === null ? Database`` : Database`AND r.status = ${status}`;
	const customerFilter = customer === null ? Database`` : Database`AND r.customer = ${customer}`;
	const searchFilter =
		search === null
			? Database``
			: Database`AND (LOWER(COALESCE(r.title, '')) LIKE ${pattern} OR LOWER(COALESCE(c.name, '')) LIKE ${pattern} OR LOWER(c.email) LIKE ${pattern}
				OR EXISTS (SELECT 1 FROM recurring_invoice_items ri WHERE ri.recurring = r.uuid AND LOWER(ri.description) LIKE ${pattern}))`;

	const rows = (await Database`
		SELECT r.*, c.name AS customer_name, c.email AS customer_email FROM recurring_invoices r
		JOIN customers c ON c.uuid = r.customer
		WHERE r.project = ${project.uuid} ${statusFilter} ${customerFilter} ${searchFilter}
		ORDER BY CASE r.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END, r.next_run_at ASC, r.created DESC, r.uuid ASC
	`) as (RecurringInvoiceRow & { customer_name: string | null; customer_email: string })[];

	const ids = rows.map((row) => row.uuid);
	const items =
		ids.length === 0
			? []
			: ((await Database`
					SELECT * FROM recurring_invoice_items WHERE recurring IN ${Database(ids)} ORDER BY sort_order ASC
				`) as RecurringInvoiceItemRow[]);

	const byTemplate = new Map<string, RecurringInvoiceItemRow[]>();
	for (const item of items) byTemplate.set(item.recurring, [...(byTemplate.get(item.recurring) ?? []), item]);

	return Utils.ok(
		ctx,
		rows.map((row) => {
			const lines = byTemplate.get(row.uuid) ?? [];
			const totals = calculateTotals(toInvoiceItems(lines), row.discount_amount);
			return {
				...row,
				auto_issue: Boolean(row.auto_issue),
				auto_send: Boolean(row.auto_send),
				bill_previous_period: Boolean(row.bill_previous_period),
				first_line: lines[0]?.description ?? null,
				total_amount: totals.total_amount,
			};
		})
	);
});

Server.app.post("/api/v1/projects/:uuid/recurring", Auth.required(), Permissions.require(Permission.SUBSCRIPTION_CREATE), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	const data = await readBody(ctx);
	if (data === null) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	const invalid = await validateRecurringInput(project.uuid, data, true);
	if (invalid !== null) return Utils.fail(ctx, invalid);

	const uuid = crypto.randomUUID();
	const timestamp = Date.now();
	const startDate = startOfDay(data.start_date!, project.timezone);
	const schedule: Schedule = {
		interval_unit: data.interval_unit!,
		interval_count: data.interval_count!,
		anchor_date: startDate,
		anchor_occurrence: 0,
	};
	const limits = { max_occurrences: data.max_occurrences ?? null, end_date: data.end_date ?? null };
	const { next, status } = statusAfterSchedule(0, schedule, limits, "active", project.timezone);
	if (status === "completed") return Utils.fail(ctx, ErrorCode.INVALID_RECURRING);

	await Database.begin(async (tx) => {
		await tx`
			INSERT INTO recurring_invoices(uuid, project, customer, title, currency, discount_amount, notes, interval_unit, interval_count,
				start_date, anchor_date, anchor_occurrence, next_run_at, occurrences, max_occurrences, end_date, days_until_due,
				auto_issue, auto_send, bill_previous_period, status, created_by, created, updated)
			VALUES(${uuid}, ${project.uuid}, ${data.customer!}, ${data.title?.trim() || null}, ${data.currency ?? project.currency},
				${data.discount_amount ?? 0}, ${data.notes?.trim() || null}, ${schedule.interval_unit}, ${schedule.interval_count},
				${startDate}, ${schedule.anchor_date}, 0, ${next}, 0, ${limits.max_occurrences}, ${limits.end_date},
				${data.days_until_due ?? 14}, ${data.auto_issue === false ? 0 : 1}, ${data.auto_send === false ? 0 : 1},
				${data.bill_previous_period === true ? 1 : 0}, ${status}, ${account.username}, ${timestamp}, ${timestamp})
		`;
		await replaceRecurringItems(tx as typeof Database, uuid, data.items!);
	});

	const created = (await loadRecurring(project.uuid, uuid))!;

	await Audit.record(ctx, {
		project: project.uuid,
		action: "recurring.created",
		entityType: "recurring_invoice",
		entityId: uuid,
		newValue: { customer: created.customer, interval: `${created.interval_count} ${created.interval_unit}`, next_run_at: created.next_run_at },
	});
	Logger.audit(`[RECURRING] ${account.username} created ${uuid} on ${project.uuid}`);

	return Utils.ok(ctx, await detail(created, project.timezone), 201);
});

Server.app.get("/api/v1/projects/:uuid/recurring/:recurring", Auth.required(), Permissions.require(Permission.SUBSCRIPTION_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const template = await findTemplate(ctx);
	if (typeof template === "number") return Utils.fail(ctx, template);
	return Utils.ok(ctx, await detail(template, project.timezone));
});

Server.app.get("/api/v1/projects/:uuid/recurring/:recurring/invoices", Auth.required(), Permissions.require(Permission.SUBSCRIPTION_VIEW), async (ctx) => {
	const template = await findTemplate(ctx);
	if (typeof template === "number") return Utils.fail(ctx, template);
	const query = ctx.query();
	const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);
	const invoices = await Database`SELECT uuid, reference, status, currency, total_amount, due_date, issued_at, created
		FROM invoices WHERE recurring = ${template.uuid} AND project = ${template.project}
		ORDER BY created DESC, uuid ASC LIMIT ${limit} OFFSET ${offset}`;
	const [counted] = (await Database`SELECT COUNT(*) AS count FROM invoices WHERE recurring = ${template.uuid} AND project = ${template.project}`) as {
		count: number;
	}[];
	return Utils.ok(ctx, { invoices, total: Number(counted.count), limit, offset });
});

Server.app.patch("/api/v1/projects/:uuid/recurring/:recurring", Auth.required(), Permissions.require(Permission.SUBSCRIPTION_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	const template = await findTemplate(ctx);
	if (typeof template === "number") return Utils.fail(ctx, template);
	if (template.status === "canceled") return Utils.fail(ctx, ErrorCode.RECURRING_CLOSED);

	const data = await readBody(ctx);
	if (data === null) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (data.start_date !== undefined && template.occurrences > 0) return Utils.fail(ctx, ErrorCode.INVALID_RECURRING);

	const invalid = await validateRecurringInput(project.uuid, data, false);
	if (invalid !== null) return Utils.fail(ctx, invalid);

	const scheduleChanged =
		data.interval_unit !== undefined || data.interval_count !== undefined || data.next_date !== undefined || data.start_date !== undefined;

	let schedule: Schedule = template;
	if (scheduleChanged) {
		const requested = data.start_date ?? data.next_date;
		const anchor =
			requested !== undefined
				? startOfDay(requested, project.timezone)
				: (template.next_run_at ?? firstRunFrom(template, template.occurrences, startOfDay(Date.now(), project.timezone), project.timezone));
		schedule = {
			interval_unit: data.interval_unit ?? template.interval_unit,
			interval_count: data.interval_count ?? template.interval_count,
			anchor_date: anchor,
			anchor_occurrence: template.occurrences,
		};
	}

	const limits = {
		max_occurrences: data.max_occurrences === undefined ? template.max_occurrences : data.max_occurrences,
		end_date: data.end_date === undefined ? template.end_date : data.end_date,
	};

	const today = startOfDay(Date.now(), project.timezone);
	const reopening = template.status === "completed" && !scheduleChanged;
	if (reopening) {
		schedule = {
			...schedule,
			anchor_date: firstRunFrom(schedule, template.occurrences, today, project.timezone),
			anchor_occurrence: template.occurrences,
		};
	}
	const { next, status } = statusAfterSchedule(template.occurrences, schedule, limits, template.status, project.timezone);

	await Database.begin(async (tx) => {
		await tx`
			UPDATE recurring_invoices SET
				customer = ${data.customer ?? template.customer},
				title = ${data.title === undefined ? template.title : data.title?.trim() || null},
				currency = ${data.currency ?? template.currency},
				discount_amount = ${data.discount_amount ?? template.discount_amount},
				notes = ${data.notes === undefined ? template.notes : data.notes?.trim() || null},
				interval_unit = ${schedule.interval_unit},
				interval_count = ${schedule.interval_count},
				start_date = ${data.start_date === undefined ? template.start_date : startOfDay(data.start_date, project.timezone)},
				anchor_date = ${schedule.anchor_date},
				anchor_occurrence = ${schedule.anchor_occurrence},
				next_run_at = ${next},
				max_occurrences = ${limits.max_occurrences},
				end_date = ${limits.end_date},
				days_until_due = ${data.days_until_due ?? template.days_until_due},
				auto_issue = ${data.auto_issue === undefined ? template.auto_issue : data.auto_issue ? 1 : 0},
				auto_send = ${data.auto_send === undefined ? template.auto_send : data.auto_send ? 1 : 0},
				bill_previous_period = ${data.bill_previous_period === undefined ? template.bill_previous_period : data.bill_previous_period ? 1 : 0},
				status = ${status},
				updated = ${Date.now()}
			WHERE uuid = ${template.uuid}
		`;
		if (data.items !== undefined) await replaceRecurringItems(tx as typeof Database, template.uuid, data.items);
	});

	const updated = (await loadRecurring(project.uuid, template.uuid))!;

	await Audit.record(ctx, {
		project: project.uuid,
		action: "recurring.updated",
		entityType: "recurring_invoice",
		entityId: template.uuid,
		oldValue: { status: template.status, next_run_at: template.next_run_at, interval: `${template.interval_count} ${template.interval_unit}` },
		newValue: { status: updated.status, next_run_at: updated.next_run_at, interval: `${updated.interval_count} ${updated.interval_unit}` },
	});
	Logger.audit(`[RECURRING] ${account.username} updated ${template.uuid}`);

	return Utils.ok(ctx, await detail(updated, project.timezone));
});

async function changeStatus(ctx: Context<AppState>, action: "pause" | "resume" | "cancel") {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	const template = await findTemplate(ctx);
	if (typeof template === "number") return Utils.fail(ctx, template);

	const timestamp = Date.now();

	if (action === "pause") {
		if (template.status !== "active") return Utils.fail(ctx, ErrorCode.RECURRING_CLOSED);
		await Database`UPDATE recurring_invoices SET status = 'paused', updated = ${timestamp} WHERE uuid = ${template.uuid}`;
	}

	if (action === "resume") {
		if (template.status !== "paused") return Utils.fail(ctx, ErrorCode.RECURRING_CLOSED);
		const today = startOfDay(timestamp, project.timezone);
		const anchor =
			template.next_run_at !== null && template.next_run_at >= today
				? template.next_run_at
				: firstRunFrom(template, template.occurrences, today, project.timezone);
		const schedule: Schedule = { ...template, anchor_date: anchor, anchor_occurrence: template.occurrences };
		const { next, status } = statusAfterSchedule(template.occurrences, schedule, limitsOf(template), "active", project.timezone);
		await Database`
			UPDATE recurring_invoices SET status = ${status}, anchor_date = ${anchor}, anchor_occurrence = ${template.occurrences},
				next_run_at = ${next}, failures = 0, updated = ${timestamp}
			WHERE uuid = ${template.uuid}
		`;
	}

	if (action === "cancel") {
		if (template.status === "canceled") return Utils.fail(ctx, ErrorCode.RECURRING_CLOSED);
		await Database`UPDATE recurring_invoices SET status = 'canceled', next_run_at = NULL, updated = ${timestamp} WHERE uuid = ${template.uuid}`;
	}

	await Audit.record(ctx, {
		project: project.uuid,
		action: `recurring.${action}`,
		entityType: "recurring_invoice",
		entityId: template.uuid,
		oldValue: { status: template.status },
	});
	Logger.audit(`[RECURRING] ${account.username} ran ${action} on ${template.uuid}`);

	return Utils.ok(ctx, await detail(template, project.timezone));
}

Server.app.post("/api/v1/projects/:uuid/recurring/:recurring/pause", Auth.required(), Permissions.require(Permission.SUBSCRIPTION_EDIT), (ctx) =>
	changeStatus(ctx, "pause")
);

Server.app.post("/api/v1/projects/:uuid/recurring/:recurring/resume", Auth.required(), Permissions.require(Permission.SUBSCRIPTION_EDIT), (ctx) =>
	changeStatus(ctx, "resume")
);

Server.app.post("/api/v1/projects/:uuid/recurring/:recurring/cancel", Auth.required(), Permissions.require(Permission.SUBSCRIPTION_CANCEL), (ctx) =>
	changeStatus(ctx, "cancel")
);

Server.app.post("/api/v1/projects/:uuid/recurring/:recurring/run", Auth.required(), Permissions.require(Permission.SUBSCRIPTION_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const member = Permissions.member(ctx);
	const account = Auth.account(ctx);

	if (!Permissions.has(member, Permission.INVOICE_CREATE)) return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);

	const template = await findTemplate(ctx);
	if (typeof template === "number") return Utils.fail(ctx, template);
	if (!OPEN_STATUSES.includes(template.status)) return Utils.fail(ctx, ErrorCode.RECURRING_CLOSED);

	let invoice: InvoiceRow | null;
	try {
		invoice = await generateNext(project, template);
	} catch (err) {
		Logger.warn(`[RECURRING] Manual run of ${template.uuid} failed: ${err}`);
		return Utils.fail(ctx, ErrorCode.RECURRING_RUN_FAILED);
	}
	if (!invoice) return Utils.fail(ctx, ErrorCode.RECURRING_CLOSED);

	await Audit.record(ctx, {
		project: project.uuid,
		action: "recurring.run",
		entityType: "recurring_invoice",
		entityId: template.uuid,
		newValue: { invoice: invoice.reference, occurrence: template.occurrences + 1 },
	});
	Logger.audit(`[RECURRING] ${account.username} created ${invoice.reference} from ${template.uuid}`);

	return Utils.ok(ctx, { ...(await detail(template, project.timezone)), created_invoice: invoice.uuid }, 201);
});

Server.app.delete("/api/v1/projects/:uuid/recurring/:recurring", Auth.required(), Permissions.require(Permission.SUBSCRIPTION_CANCEL), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	const template = await findTemplate(ctx);
	if (typeof template === "number") return Utils.fail(ctx, template);

	const [linked] = (await Database`SELECT COUNT(*) AS count FROM invoices WHERE recurring = ${template.uuid}`) as { count: number }[];
	if (template.occurrences > 0 || Number(linked.count) > 0) return Utils.fail(ctx, ErrorCode.RECURRING_HAS_INVOICES);

	await Database`DELETE FROM recurring_invoices WHERE uuid = ${template.uuid}`;

	await Audit.record(ctx, {
		project: project.uuid,
		action: "recurring.deleted",
		entityType: "recurring_invoice",
		entityId: template.uuid,
		oldValue: { customer: template.customer },
	});
	Logger.audit(`[RECURRING] ${account.username} deleted ${template.uuid}`);

	return Utils.ok(ctx);
});
