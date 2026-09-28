import { outstandingOf } from "./invoicing";

const DAY = 24 * 60 * 60 * 1000;
const UNPAID_STATUSES = new Set(["open", "overdue", "partially_paid"]);
const SETTLED_STATUSES = new Set(["paid", "refunded"]);

export interface CustomerInvoiceFacts {
	status: string;
	currency: string;
	total_amount: number;
	paid_amount: number;
	refunded_amount: number;
	credited_amount: number;
	due_date: number;
	paid_date: number | null;
	issued_at: number | null;
}

export interface CustomerCurrencyStats {
	currency: string;
	invoices: number;
	billed: number;
	paid: number;
	outstanding: number;
	overdue: number;
}

export interface CustomerStats {
	invoices: number;
	paid_total: number;
	issued: number;
	drafts: number;
	settled: number;
	unpaid: number;
	overdue: number;
	canceled: number;
	paid_on_time: number;
	paid_late: number;
	average_days_to_pay: number | null;
	average_days_late: number | null;
	first_invoice: number | null;
	last_invoice: number | null;
	last_payment: number | null;
	currencies: CustomerCurrencyStats[];
}

function average(values: number[]): number | null {
	if (values.length === 0) return null;
	return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

export function daysLate(dueDate: number, paidDate: number): number {
	return Math.max(Math.floor((paidDate - dueDate) / DAY), 0);
}

export function customerStats(invoices: CustomerInvoiceFacts[], now: number): CustomerStats {
	const byCurrency = new Map<string, CustomerCurrencyStats>();
	const daysToPay: number[] = [];
	const lateness: number[] = [];

	const stats: CustomerStats = {
		invoices: invoices.length,
		paid_total: 0,
		issued: 0,
		drafts: 0,
		settled: 0,
		unpaid: 0,
		overdue: 0,
		canceled: 0,
		paid_on_time: 0,
		paid_late: 0,
		average_days_to_pay: null,
		average_days_late: null,
		first_invoice: null,
		last_invoice: null,
		last_payment: null,
		currencies: [],
	};

	for (const invoice of invoices) {
		stats.paid_total += invoice.paid_amount;

		if (invoice.issued_at === null) {
			stats.drafts++;
			continue;
		}

		stats.issued++;
		stats.first_invoice = Math.min(stats.first_invoice ?? invoice.issued_at, invoice.issued_at);
		stats.last_invoice = Math.max(stats.last_invoice ?? invoice.issued_at, invoice.issued_at);

		let totals = byCurrency.get(invoice.currency);
		if (!totals) {
			totals = { currency: invoice.currency, invoices: 0, billed: 0, paid: 0, outstanding: 0, overdue: 0 };
			byCurrency.set(invoice.currency, totals);
		}

		totals.invoices++;
		totals.billed += invoice.total_amount - invoice.credited_amount;
		totals.paid += invoice.paid_amount - invoice.refunded_amount;

		if (invoice.status === "canceled") stats.canceled++;

		if (UNPAID_STATUSES.has(invoice.status)) {
			const outstanding = outstandingOf(invoice);
			totals.outstanding += outstanding;
			if (outstanding > 0) {
				stats.unpaid++;
				if (invoice.due_date < now) {
					stats.overdue++;
					totals.overdue += outstanding;
				}
			}
		}

		if (invoice.paid_date !== null) {
			stats.last_payment = Math.max(stats.last_payment ?? invoice.paid_date, invoice.paid_date);
		}

		if (SETTLED_STATUSES.has(invoice.status) && invoice.paid_date !== null) {
			stats.settled++;
			daysToPay.push(Math.max((invoice.paid_date - invoice.issued_at) / DAY, 0));

			const late = daysLate(invoice.due_date, invoice.paid_date);
			if (late === 0) {
				stats.paid_on_time++;
			} else {
				stats.paid_late++;
				lateness.push(late);
			}
		}
	}

	stats.average_days_to_pay = average(daysToPay);
	stats.average_days_late = average(lateness);
	stats.currencies = [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));

	return stats;
}
