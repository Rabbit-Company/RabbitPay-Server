import Database from "./database/database";
import { addIntegers } from "./database/numbers";
import { REFUND_TYPES, SETTLED_PAYMENT_STATUSES, SETTLED_REFUND_STATUSES } from "./payments/ledger";

import type { FinancialValues, FinancialPeriod, FinancialReport } from "./expense-types";
export type { FinancialValues, FinancialPeriod, FinancialReport } from "./expense-types";

const empty = (): FinancialValues => ({ revenue: 0, expenses: 0, fees: 0, profit: 0, received: 0, refunds: 0, paid_expenses: 0, cash_flow: 0 });

export async function financialReport(project: string, from: number, to: number, group: "month" | "year"): Promise<FinancialReport> {
	const events = (await Database`
		SELECT currency, issued_at AS date, 'revenue' AS kind, total_amount - tax_amount AS amount, NULL AS category FROM invoices
		WHERE project = ${project} AND issued_at BETWEEN ${from} AND ${to} AND status <> 'draft'
			AND (status <> 'canceled' OR EXISTS (SELECT 1 FROM credit_notes cn WHERE cn.invoice = invoices.uuid))
		UNION ALL
		SELECT currency, issued_at, 'revenue', -(total_amount - tax_amount), NULL FROM credit_notes
		WHERE project = ${project} AND issued_at BETWEEN ${from} AND ${to}
		UNION ALL
		SELECT currency, issued_at, 'revenue', CASE WHEN document_type = 'credit_note' THEN -subtotal ELSE subtotal END, NULL FROM recorded_invoices
		WHERE project = ${project} AND issued_at BETWEEN ${from} AND ${to}
		UNION ALL
		SELECT currency, paid_at, 'received', total_amount, NULL FROM recorded_invoices
		WHERE project = ${project} AND document_type = 'invoice' AND paid_at BETWEEN ${from} AND ${to}
		UNION ALL
		SELECT currency, paid_at, 'refunds', total_amount, NULL FROM recorded_invoices
		WHERE project = ${project} AND document_type = 'credit_note' AND paid_at BETWEEN ${from} AND ${to}
		UNION ALL
		SELECT currency, expense_date, 'expenses', total_amount - CASE
			WHEN vat_treatment IN ('domestic_reverse_charge', 'eu_goods', 'eu_services') THEN 0
			ELSE deductible_tax_amount
		END, category FROM expenses
		WHERE project = ${project} AND expense_date BETWEEN ${from} AND ${to}
		UNION ALL
		SELECT currency, paid_at, 'paid_expenses', total_amount, NULL FROM expenses
		WHERE project = ${project} AND paid_at BETWEEN ${from} AND ${to}
		UNION ALL
		SELECT currency, COALESCE(completed_at, confirmed_at, created), 'received', amount, NULL FROM transactions
		WHERE project = ${project} AND type = 'payment' AND status IN ${Database(SETTLED_PAYMENT_STATUSES)}
			AND COALESCE(completed_at, confirmed_at, created) BETWEEN ${from} AND ${to}
		UNION ALL
		SELECT currency, COALESCE(completed_at, confirmed_at, created), 'refunds', amount, NULL FROM transactions
		WHERE project = ${project} AND type IN ${Database(REFUND_TYPES)} AND status IN ${Database(SETTLED_REFUND_STATUSES)}
			AND COALESCE(completed_at, confirmed_at, created) BETWEEN ${from} AND ${to}
		UNION ALL
		SELECT currency, COALESCE(completed_at, confirmed_at, created), 'fees', fee_amount, NULL FROM transactions
		WHERE project = ${project} AND ((type = 'payment' AND status IN ${Database(SETTLED_PAYMENT_STATUSES)})
			OR (type IN ${Database(REFUND_TYPES)} AND status IN ${Database(SETTLED_REFUND_STATUSES)}))
			AND COALESCE(completed_at, confirmed_at, created) BETWEEN ${from} AND ${to}
	`) as {
		currency: string;
		date: number;
		kind: "revenue" | "expenses" | "paid_expenses" | "received" | "refunds" | "fees";
		amount: number;
		category: string | null;
	}[];
	const totals = new Map<string, FinancialValues & { currency: string }>();
	const periods = new Map<string, FinancialPeriod>();
	const categories = new Map<string, { currency: string; category: string; amount: number }>();
	const periodOf = (date: number) => new Date(date).toISOString().slice(0, group === "year" ? 4 : 7);
	for (const event of events) {
		if (!totals.has(event.currency)) totals.set(event.currency, { currency: event.currency, ...empty() });
		const period = periodOf(event.date);
		const key = `${event.currency}:${period}`;
		if (!periods.has(key)) periods.set(key, { currency: event.currency, period, ...empty() });
		const total = totals.get(event.currency)!;
		const bucket = periods.get(key)!;
		total[event.kind] = addIntegers(total[event.kind], event.amount);
		bucket[event.kind] = addIntegers(bucket[event.kind], event.amount);
		if (event.category !== null) {
			const categoryKey = `${event.currency}:${event.category}`;
			if (!categories.has(categoryKey)) categories.set(categoryKey, { currency: event.currency, category: event.category, amount: 0 });
			const category = categories.get(categoryKey)!;
			category.amount = addIntegers(category.amount, event.amount);
		}
	}
	const date = new Date(from);
	date.setUTCDate(1);
	date.setUTCHours(0, 0, 0, 0);
	if (group === "year") date.setUTCMonth(0);
	while (date.getTime() <= to) {
		for (const currency of totals.keys()) {
			const period = periodOf(date.getTime());
			const key = `${currency}:${period}`;
			if (!periods.has(key)) periods.set(key, { currency, period, ...empty() });
		}
		date.setUTCMonth(date.getUTCMonth() + (group === "year" ? 12 : 1));
	}
	for (const row of [...totals.values(), ...periods.values()]) {
		row.profit = addIntegers(row.revenue, -row.expenses, -row.fees);
		row.cash_flow = addIntegers(row.received, -row.refunds, -row.paid_expenses, -row.fees);
	}
	return {
		from,
		to,
		group,
		totals: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
		periods: [...periods.values()].sort((a, b) => a.period.localeCompare(b.period) || a.currency.localeCompare(b.currency)),
		categories: [...categories.values()].sort((a, b) => a.currency.localeCompare(b.currency) || b.amount - a.amount),
	};
}

export { financialReportCsv } from "./financial-report-csv";
