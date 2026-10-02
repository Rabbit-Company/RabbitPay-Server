import type { SQL } from "bun";
import Database from "./database/database";
import Validate from "./validate";
import { ErrorCode } from "./errors";
import { Logger } from "./logger";
import { calculateTotals, type InvoiceItemInput } from "./invoicing";
import { createInvoice, validateCatalogLinks, validateItems } from "./invoice-service";
import { enqueueLater } from "./webhooks/events";
import { canEmail } from "./email/mailer";
import { queueInvoiceEmail } from "./email/messages";
import { assertCapacity, assertStorageCapacity } from "./licensing";
import { assertAccountingPeriodUnlocked } from "./accounting-periods";
import { projectOwnerIssuer } from "./invoice-issuer";
import {
	MAX_CATCH_UP,
	MAX_DAYS_UNTIL_DUE,
	MAX_OCCURRENCES,
	fillPlaceholders,
	isIntervalCount,
	isIntervalUnit,
	nextRunAfter,
	periodOf,
	startOfDay,
	upcomingRuns,
} from "./recurring-schedule";
import type { DateFormat } from "./formats";
import type { CustomerRow, InvoiceRow, ProjectRow, RecurringInvoiceItemRow, RecurringInvoiceRow } from "./database/models";
import { endOfLocalDate, localDate, shiftLocalDate } from "./timezone";

export const MAX_FAILURES = 5;

export interface RecurringInput {
	title?: string | null;
	customer?: string;
	currency?: string;
	items?: InvoiceItemInput[];
	discount_amount?: number;
	notes?: string | null;
	interval_unit?: string;
	interval_count?: number;
	start_date?: number;
	next_date?: number;
	days_until_due?: number;
	max_occurrences?: number | null;
	end_date?: number | null;
	auto_issue?: boolean;
	auto_send?: boolean;
}

function isTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export async function validateRecurringInput(projectId: string, data: RecurringInput, creating: boolean): Promise<ErrorCode | null> {
	const now = Date.now();
	const [project] = (await Database`SELECT timezone FROM projects WHERE uuid = ${projectId}`) as Pick<ProjectRow, "timezone">[];
	const timezone = project?.timezone;

	if (creating || data.customer !== undefined) {
		if (!Validate.uuid(data.customer)) return ErrorCode.INVALID_RECURRING;
		const [customer] = (await Database`SELECT uuid FROM customers WHERE uuid = ${data.customer!} AND project = ${projectId}`) as CustomerRow[];
		if (!customer) return ErrorCode.CUSTOMER_NOT_FOUND;
	}

	if (creating || data.items !== undefined) {
		if (!validateItems(data.items)) return ErrorCode.INVALID_INVOICE_ITEMS;
		const unlinked = await validateCatalogLinks(projectId, data.items);
		if (unlinked !== null) return unlinked;
	}

	if (creating || data.interval_unit !== undefined) {
		if (!isIntervalUnit(data.interval_unit)) return ErrorCode.INVALID_RECURRING;
	}
	if (creating || data.interval_count !== undefined) {
		if (!isIntervalCount(data.interval_count)) return ErrorCode.INVALID_RECURRING;
	}
	if (creating || data.start_date !== undefined) {
		if (!isTimestamp(data.start_date) || data.start_date < startOfDay(now, timezone)) return ErrorCode.INVALID_RECURRING;
	}
	if (data.next_date !== undefined && (!isTimestamp(data.next_date) || data.next_date < startOfDay(now, timezone))) return ErrorCode.INVALID_RECURRING;

	if (data.currency !== undefined && !Validate.currency(data.currency)) return ErrorCode.INVALID_CURRENCY;
	if (data.discount_amount !== undefined && !Validate.minorUnitAmount(data.discount_amount)) return ErrorCode.INVALID_INVOICE_AMOUNT;
	if (!Validate.optionalText(data.title, 120)) return ErrorCode.INVALID_RECURRING;
	if (!Validate.optionalText(data.notes, 5000)) return ErrorCode.REQUIRED_DATA_MISSING;

	if (data.days_until_due !== undefined) {
		const days = data.days_until_due;
		if (!Number.isSafeInteger(days) || days < 0 || days > MAX_DAYS_UNTIL_DUE) return ErrorCode.INVALID_RECURRING;
	}
	if (data.max_occurrences !== undefined && data.max_occurrences !== null) {
		const count = data.max_occurrences;
		if (!Number.isSafeInteger(count) || count < 1 || count > MAX_OCCURRENCES) return ErrorCode.INVALID_RECURRING;
	}
	if (data.end_date !== undefined && data.end_date !== null && !isTimestamp(data.end_date)) return ErrorCode.INVALID_RECURRING;
	if (data.auto_issue !== undefined && typeof data.auto_issue !== "boolean") return ErrorCode.INVALID_RECURRING;
	if (data.auto_send !== undefined && typeof data.auto_send !== "boolean") return ErrorCode.INVALID_RECURRING;

	return null;
}

export async function loadRecurring(projectId: string, recurringId: string): Promise<RecurringInvoiceRow | undefined> {
	const [row] = (await Database`SELECT * FROM recurring_invoices WHERE uuid = ${recurringId} AND project = ${projectId}`) as RecurringInvoiceRow[];
	return row;
}

export async function loadRecurringItems(recurringId: string): Promise<RecurringInvoiceItemRow[]> {
	return (await Database`
		SELECT * FROM recurring_invoice_items WHERE recurring = ${recurringId} ORDER BY sort_order ASC
	`) as RecurringInvoiceItemRow[];
}

export async function replaceRecurringItems(sql: SQL, recurringId: string, items: InvoiceItemInput[]) {
	await sql`DELETE FROM recurring_invoice_items WHERE recurring = ${recurringId}`;
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		await sql`
			INSERT INTO recurring_invoice_items(uuid, recurring, description, quantity, unit_price, tax_rate, item, tax_treatment, unit, sort_order)
			VALUES(${crypto.randomUUID()}, ${recurringId}, ${item.description}, ${item.quantity}, ${item.unit_price}, ${item.tax_rate ?? 0},
				${item.item ?? null}, ${item.tax_treatment ?? null}, ${item.unit ?? null}, ${index})
		`;
	}
}

export function toInvoiceItems(items: RecurringInvoiceItemRow[]): InvoiceItemInput[] {
	return items.map((item) => ({
		description: item.description,
		quantity: item.quantity,
		unit_price: item.unit_price,
		tax_rate: item.tax_rate,
		item: item.item,
		tax_treatment: item.tax_treatment,
		unit: item.unit,
	}));
}

export function limitsOf(row: Pick<RecurringInvoiceRow, "max_occurrences" | "end_date">) {
	return { max_occurrences: row.max_occurrences, end_date: row.end_date };
}

export function presentRecurring(row: RecurringInvoiceRow, items: RecurringInvoiceItemRow[], timezone?: string) {
	const totals = calculateTotals(toInvoiceItems(items), row.discount_amount);
	const upcoming = row.status === "active" || row.status === "paused" ? upcomingRuns(row, limitsOf(row), row.occurrences, 5, timezone) : [];

	return {
		...row,
		auto_issue: Boolean(row.auto_issue),
		auto_send: Boolean(row.auto_send),
		items: items.map((item) => ({ ...item })),
		subtotal: totals.subtotal,
		tax_amount: totals.tax_amount,
		total_amount: totals.total_amount,
		upcoming,
	};
}

export async function generateNext(project: ProjectRow, template: RecurringInvoiceRow, now = Date.now()): Promise<InvoiceRow | null> {
	const occurrence = template.occurrences;
	const nextRun = nextRunAfter(template, limitsOf(template), occurrence + 1, project.timezone);
	const nextStatus = nextRun === null ? "completed" : template.status;

	const claim = await Database`
		UPDATE recurring_invoices SET occurrences = ${occurrence + 1}, next_run_at = ${nextRun}, status = ${nextStatus},
			last_run_at = ${now}, updated = ${now}
		WHERE uuid = ${template.uuid} AND occurrences = ${occurrence} AND status = ${template.status}
	`;
	if (claim.count === 0) return null;

	try {
		const [customer] = (await Database`SELECT * FROM customers WHERE uuid = ${template.customer}`) as CustomerRow[];
		if (!customer) throw new Error("The customer no longer exists");

		const period = periodOf(template, occurrence, project.timezone);
		const fill = (text: string) => fillPlaceholders(text, period, project.language, project.date_format as DateFormat, project.timezone);
		const items = toInvoiceItems(await loadRecurringItems(template.uuid)).map((item) => ({ ...item, description: fill(item.description) }));
		if (items.length === 0) throw new Error("The recurring invoice has no lines");

		const issue = Boolean(template.auto_issue);
		if (issue) await assertCapacity(project.uuid);
		if (issue) await assertStorageCapacity(project.uuid);
		if (issue) await assertAccountingPeriodUnlocked(project.uuid, now);
		const owner = await projectOwnerIssuer(Database, project.uuid);
		const invoice = await createInvoice(project.uuid, {
			customer: customer.uuid,
			currency: template.currency,
			items,
			discount_amount: template.discount_amount,
			due_date: endOfLocalDate(shiftLocalDate(localDate(now, project.timezone), template.days_until_due), project.timezone),
			supply_date: now,
			notes: template.notes ? fill(template.notes) : null,
			status: issue ? "open" : "draft",
			source: "invoice",
			created_by: owner?.username ?? template.created_by,
			recurring: template.uuid,
		});

		await Database`
			UPDATE recurring_invoices SET last_invoice = ${invoice.uuid}, last_error = NULL, failures = 0 WHERE uuid = ${template.uuid}
		`;

		if (issue) {
			enqueueLater(project.uuid, "invoice.issued", {
				invoice: invoice.uuid,
				reference: invoice.reference,
				status: invoice.status,
				currency: invoice.currency,
				total_amount: invoice.total_amount,
				due_date: invoice.due_date,
				recurring: template.uuid,
			});

			if (template.auto_send && canEmail(project) && customer.email) {
				await queueInvoiceEmail(project, invoice, { to: customer.email, kind: "invoice", message: null, sentBy: null }).catch((err) =>
					Logger.error(`[RECURRING] Could not email ${invoice.reference}: ${err}`)
				);
			}
		}

		return invoice;
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		const failures = template.failures + 1;
		const status = failures >= MAX_FAILURES ? "paused" : template.status;

		await Database`
			UPDATE recurring_invoices SET occurrences = ${occurrence}, next_run_at = ${template.next_run_at}, status = ${status},
				last_error = ${reason.slice(0, 500)}, failures = ${failures}, updated = ${Date.now()}
			WHERE uuid = ${template.uuid} AND occurrences = ${occurrence + 1}
		`;
		throw err;
	}
}

export async function runDueRecurring(now = Date.now()): Promise<number> {
	const due = (await Database`
		SELECT r.uuid, r.project FROM recurring_invoices r
		JOIN projects p ON p.uuid = r.project
		WHERE r.status = 'active' AND r.next_run_at IS NOT NULL AND r.next_run_at <= ${now} AND p.status != 'deleted'
		ORDER BY r.next_run_at ASC LIMIT 200
	`) as { uuid: string; project: string }[];

	let created = 0;
	for (const { uuid, project: projectId } of due) {
		const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${projectId}`) as ProjectRow[];

		for (let round = 0; round < MAX_CATCH_UP; round++) {
			const template = await loadRecurring(projectId, uuid);
			if (!template || template.status !== "active" || template.next_run_at === null || template.next_run_at > now) break;

			try {
				const invoice = await generateNext(project, template, now);
				if (!invoice) break;
				created++;
			} catch (err) {
				Logger.error(`[RECURRING] Could not create the invoice for ${uuid}: ${err}`);
				break;
			}
		}
	}

	return created;
}
