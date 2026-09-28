import { describe, expect, test } from "bun:test";
import { customerStats, daysLate, type CustomerInvoiceFacts } from "../server/customer-stats";

const DAY = 24 * 60 * 60 * 1000;
const now = 100 * DAY;

function invoice(overrides: Partial<CustomerInvoiceFacts>): CustomerInvoiceFacts {
	return {
		status: "open",
		currency: "EUR",
		total_amount: 10000,
		paid_amount: 0,
		refunded_amount: 0,
		credited_amount: 0,
		due_date: now + 10 * DAY,
		paid_date: null,
		issued_at: now - 20 * DAY,
		...overrides,
	};
}

describe("customer stats", () => {
	test("returns empty stats for a customer without invoices", () => {
		const stats = customerStats([], now);
		expect(stats.invoices).toBe(0);
		expect(stats.currencies).toEqual([]);
		expect(stats.average_days_to_pay).toBeNull();
		expect(stats.last_payment).toBeNull();
	});

	test("counts drafts apart from issued invoices", () => {
		const stats = customerStats([invoice({ status: "draft", issued_at: null }), invoice({})], now);
		expect(stats.invoices).toBe(2);
		expect(stats.drafts).toBe(1);
		expect(stats.issued).toBe(1);
		expect(stats.currencies[0].billed).toBe(10000);
	});

	test("splits outstanding and past due amounts", () => {
		const stats = customerStats(
			[
				invoice({ due_date: now - 5 * DAY }),
				invoice({ status: "partially_paid", paid_amount: 4000 }),
				invoice({ status: "overdue", total_amount: 3000, credited_amount: 3000, due_date: now - DAY }),
			],
			now
		);
		expect(stats.unpaid).toBe(2);
		expect(stats.overdue).toBe(1);
		expect(stats.currencies[0]).toEqual({ currency: "EUR", invoices: 3, billed: 20000, paid: 4000, outstanding: 16000, overdue: 10000 });
	});

	test("tracks punctuality of paid invoices", () => {
		const stats = customerStats(
			[
				invoice({ status: "paid", paid_amount: 10000, issued_at: 0, due_date: 10 * DAY, paid_date: 4 * DAY }),
				invoice({ status: "paid", paid_amount: 10000, issued_at: 0, due_date: 10 * DAY, paid_date: 16 * DAY }),
				invoice({ status: "refunded", paid_amount: 10000, refunded_amount: 10000, issued_at: 0, due_date: 10 * DAY, paid_date: 10 * DAY }),
			],
			now
		);
		expect(stats.settled).toBe(3);
		expect(stats.paid_on_time).toBe(2);
		expect(stats.paid_late).toBe(1);
		expect(stats.average_days_late).toBe(6);
		expect(stats.average_days_to_pay).toBe(10);
		expect(stats.last_payment).toBe(16 * DAY);
		expect(stats.currencies[0].paid).toBe(20000);
	});

	test("keeps currencies apart and sorted", () => {
		const stats = customerStats([invoice({ currency: "USD" }), invoice({ currency: "EUR", total_amount: 500 })], now);
		expect(stats.currencies.map((sum) => [sum.currency, sum.billed])).toEqual([
			["EUR", 500],
			["USD", 10000],
		]);
	});

	test("canceled invoices are billed only for what was not credited", () => {
		const stats = customerStats([invoice({ status: "canceled", credited_amount: 10000 })], now);
		expect(stats.canceled).toBe(1);
		expect(stats.unpaid).toBe(0);
		expect(stats.currencies[0].billed).toBe(0);
	});

	test("a payment on the due date is on time", () => {
		expect(daysLate(10 * DAY, 10 * DAY + 3600000)).toBe(0);
		expect(daysLate(10 * DAY, 11 * DAY)).toBe(1);
		expect(daysLate(10 * DAY, 2 * DAY)).toBe(0);
	});
});
