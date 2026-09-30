import type { SQL } from "bun";
import Database from "./database/database";
import Validate from "./validate";
import { Logger } from "./logger";
import { isIntervalCount, isIntervalUnit, MAX_CATCH_UP, MAX_OCCURRENCES, nextRunAfter } from "./recurring-schedule";
import type { ProjectRow, RecurringExpenseRow } from "./database/models";
import { assertAccountingPeriodUnlocked } from "./accounting-periods";

import { EXPENSE_ASSET_TYPES, EXPENSE_VAT_TREATMENTS, type ExpenseInput, type ExpenseScheduleInput } from "./expense-types";
export type { ExpenseInput, ExpenseScheduleInput } from "./expense-types";

export function validExpenseDate(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
}

export function validExpense(data: ExpenseInput): boolean {
	const lines = Array.isArray(data.vat_lines) ? data.vat_lines : [];
	const validLines =
		lines.length <= 20 &&
		lines.every(
			(line) =>
				typeof line === "object" &&
				Number.isFinite(line.rate) &&
				line.rate >= 0 &&
				line.rate <= 100 &&
				Validate.minorUnitAmount(line.tax_base) &&
				Validate.minorUnitAmount(line.tax_amount) &&
				Validate.minorUnitAmount(line.deductible_tax_amount) &&
				line.deductible_tax_amount <= line.tax_amount
		);
	const lineTax = lines.reduce((sum, line) => sum + line.tax_amount, 0);
	const lineDeductible = lines.reduce((sum, line) => sum + line.deductible_tax_amount, 0);
	const reportable = data.vat_treatment !== "not_reported";
	return (
		typeof data.description === "string" &&
		data.description.trim().length > 0 &&
		data.description.length <= 240 &&
		typeof data.category === "string" &&
		data.category.trim().length > 0 &&
		data.category.length <= 80 &&
		Validate.optionalText(data.supplier, 240) &&
		Validate.optionalText(data.supplier_tax_number, 80) &&
		(data.supplier_country === null || Validate.country(data.supplier_country)) &&
		Validate.optionalText(data.invoice_number, 250) &&
		Validate.optionalText(data.notes, 5000) &&
		Validate.currency(data.currency) &&
		Validate.minorUnitAmount(data.total_amount) &&
		data.total_amount > 0 &&
		Validate.minorUnitAmount(data.tax_amount) &&
		data.tax_amount <= data.total_amount &&
		Validate.minorUnitAmount(data.deductible_tax_amount) &&
		data.deductible_tax_amount <= data.tax_amount &&
		validExpenseDate(data.expense_date) &&
		(data.issue_date === null || validExpenseDate(data.issue_date)) &&
		(data.receipt_date === null || validExpenseDate(data.receipt_date)) &&
		(data.supply_date === null || validExpenseDate(data.supply_date)) &&
		EXPENSE_VAT_TREATMENTS.includes(data.vat_treatment as (typeof EXPENSE_VAT_TREATMENTS)[number]) &&
		EXPENSE_ASSET_TYPES.includes(data.asset_type as (typeof EXPENSE_ASSET_TYPES)[number]) &&
		["1", "2", "3"].includes(data.vat_handling) &&
		(data.self_assessment_period === null || /^\d{8}$/.test(data.self_assessment_period)) &&
		(data.self_assessment_tax === null || Validate.minorUnitAmount(data.self_assessment_tax)) &&
		(data.tax_exchange_rate === null ||
			(typeof data.tax_exchange_rate === "number" && Number.isFinite(data.tax_exchange_rate) && data.tax_exchange_rate > 0)) &&
		(data.tax_rate_date === null || validExpenseDate(data.tax_rate_date)) &&
		(!reportable || data.currency === "EUR" || (data.tax_exchange_rate !== null && data.tax_rate_date !== null)) &&
		validLines &&
		(!reportable || (Boolean(data.supplier?.trim()) && Boolean(data.invoice_number?.trim()) && data.issue_date !== null && data.receipt_date !== null)) &&
		(!reportable || Boolean(data.supplier_tax_number?.trim() || data.supplier_country)) &&
		(!reportable || (lines.length > 0 && lineTax === data.tax_amount && lineDeductible === data.deductible_tax_amount)) &&
		(data.vat_handling === "1" || (data.self_assessment_period !== null && data.self_assessment_tax !== null && data.self_assessment_tax > 0)) &&
		(data.paid_at === null || validExpenseDate(data.paid_at)) &&
		(data.provisional_share === undefined || typeof data.provisional_share === "boolean" || data.provisional_share === 0 || data.provisional_share === 1)
	);
}

export function validExpenseSchedule(data: ExpenseScheduleInput): boolean {
	return (
		validExpense({ ...data, expense_date: data.start_date, paid_at: null }) &&
		data.vat_treatment === "not_reported" &&
		data.vat_lines.length === 0 &&
		isIntervalUnit(data.interval_unit) &&
		isIntervalCount(data.interval_count) &&
		(data.end_date === null || (validExpenseDate(data.end_date) && data.end_date >= data.start_date)) &&
		(data.max_occurrences === null || (Number.isSafeInteger(data.max_occurrences) && data.max_occurrences >= 1 && data.max_occurrences <= MAX_OCCURRENCES)) &&
		typeof data.auto_paid === "boolean"
	);
}

export async function insertExpense(
	sql: SQL,
	project: string,
	data: ExpenseInput,
	author: string | null,
	recurring: string | null = null,
	occurrence: number | null = null
) {
	await assertAccountingPeriodUnlocked(project, data.expense_date, sql);
	const uuid = crypto.randomUUID();
	const now = Date.now();
	await sql`
			INSERT INTO expenses(uuid, project, description, supplier, supplier_tax_number, supplier_country, invoice_number, category, currency,
				total_amount, tax_amount, deductible_tax_amount, expense_date, issue_date, receipt_date, supply_date, vat_treatment, asset_type,
				vat_handling, self_assessment_period, self_assessment_tax, tax_exchange_rate, tax_rate_date, paid_at, notes, recurring, occurrence, created_by, created, updated,
				provisional_share)
			VALUES(${uuid}, ${project}, ${data.description.trim()}, ${data.supplier?.trim() || null}, ${data.supplier_tax_number?.trim() || null},
				${data.supplier_country}, ${data.invoice_number?.trim() || null}, ${data.category.trim()}, ${data.currency}, ${data.total_amount},
				${data.tax_amount}, ${data.deductible_tax_amount}, ${data.expense_date}, ${data.issue_date}, ${data.receipt_date}, ${data.supply_date},
				${data.vat_treatment}, ${data.asset_type}, ${data.vat_handling}, ${data.self_assessment_period}, ${data.self_assessment_tax}, ${data.tax_exchange_rate}, ${data.tax_rate_date}, ${data.paid_at},
				${data.notes?.trim() || null}, ${recurring}, ${occurrence}, ${author}, ${now}, ${now}, ${data.provisional_share ? 1 : 0})
	`;
	for (const [sort, line] of data.vat_lines.entries()) {
		await sql`INSERT INTO expense_vat_lines(uuid, expense, rate, tax_base, tax_amount, deductible_tax_amount, sort_order)
				VALUES(${crypto.randomUUID()}, ${uuid}, ${line.rate}, ${line.tax_base}, ${line.tax_amount}, ${line.deductible_tax_amount}, ${sort})`;
	}
	return uuid;
}

export async function generateExpense(template: RecurringExpenseRow, now = Date.now()): Promise<string | null> {
	if (template.status !== "active" || template.next_run_at === null || template.next_run_at > now) return null;
	return Database.begin(async (tx) => {
		const [project] = (await tx`SELECT timezone FROM projects WHERE uuid = ${template.project}`) as Pick<ProjectRow, "timezone">[];
		const next = nextRunAfter(template, template, template.occurrences + 1, project.timezone);
		const updated = Math.max(now, template.updated + 1);
		const claim = await tx`
			UPDATE recurring_expenses SET occurrences = ${template.occurrences + 1}, next_run_at = ${next},
				status = ${next === null ? "completed" : "active"}, updated = ${updated}
			WHERE uuid = ${template.uuid} AND status = 'active' AND occurrences = ${template.occurrences}
				AND next_run_at = ${template.next_run_at} AND updated = ${template.updated}
		`;
		if (claim.count === 0) return null;
		return insertExpense(
			tx as SQL,
			template.project,
			{
				...template,
				invoice_number: null,
				expense_date: template.next_run_at!,
				issue_date: null,
				receipt_date: null,
				supply_date: null,
				vat_handling: "1",
				self_assessment_period: null,
				self_assessment_tax: null,
				tax_exchange_rate: null,
				tax_rate_date: null,
				vat_lines: [],
				paid_at: template.auto_paid ? template.next_run_at : null,
			},
			template.created_by,
			template.uuid,
			template.occurrences
		);
	});
}

export async function runDueExpenses(now = Date.now()): Promise<number> {
	const due = (await Database`
		SELECT r.uuid FROM recurring_expenses r JOIN projects p ON p.uuid = r.project
		WHERE r.status = 'active' AND r.next_run_at <= ${now} AND p.status <> 'deleted'
		ORDER BY r.next_run_at LIMIT 200
	`) as { uuid: string }[];
	let count = 0;
	for (const row of due) {
		for (let attempt = 0; attempt < MAX_CATCH_UP; attempt++) {
			const [template] = (await Database`SELECT * FROM recurring_expenses WHERE uuid = ${row.uuid}`) as RecurringExpenseRow[];
			if (!template) break;
			try {
				if (!(await generateExpense(template, now))) break;
				count++;
			} catch (error) {
				Logger.error(`[EXPENSES] Could not generate ${row.uuid}: ${error}`);
				break;
			}
		}
	}
	return count;
}
