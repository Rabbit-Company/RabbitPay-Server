import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";

import { accountId, prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.payments.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");

await Server.configure();

const password = (seed: string) => new Bun.CryptoHasher("blake2b512").update(seed).digest("hex");

interface ApiResponse {
	status: number;
	error: number;
	info: string;
	data?: any;
}

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<ApiResponse> {
	const headers: Record<string, string> = {};
	if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
	if (options.body !== undefined) headers["Content-Type"] = "application/json";

	const res = await Server.app.handle(
		new Request(`http://127.0.0.1${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
	);

	const json = (await res.json()) as { error: number; info: string; data?: unknown };
	return { status: res.status, ...json };
}

let ownerToken = "";
let accountantToken = "";
let projectUuid = "";
let customerUuid = "";

async function createInvoice(total: number, options: { open?: boolean; currency?: string; dueDate?: number } = {}) {
	const created = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
		token: ownerToken,
		body: {
			customer: customerUuid,
			currency: options.currency ?? "EUR",
			due_date: options.dueDate ?? Date.now() + 7 * 24 * 60 * 60 * 1000,
			items: [{ description: "Work", quantity: 1, unit_price: total, tax_rate: 0 }],
		},
	});

	if (options.open !== false) await call("POST", `/api/v1/projects/${projectUuid}/invoices/${created.data.uuid}/open`, { token: ownerToken });

	return created.data.uuid as string;
}

function pay(invoice: string, amount: number, extra: Record<string, unknown> = {}) {
	return call("POST", `/api/v1/projects/${projectUuid}/transactions`, {
		token: ownerToken,
		body: { invoice, processor: "bank_transfer", amount, ...extra },
	});
}

function invoiceOf(uuid: string) {
	return call("GET", `/api/v1/projects/${projectUuid}/invoices/${uuid}`, { token: ownerToken });
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	await call("POST", "/api/v1/auth/register", { body: { email: "pay-owner@example.com", password: password("owner") } });
	ownerToken = (await call("POST", "/api/v1/auth/login", { body: { email: "pay-owner@example.com", password: password("owner") } })).data.token;

	await call("POST", "/api/v1/auth/register", { body: { email: "pay-books@example.com", password: password("books") } });
	accountantToken = (await call("POST", "/api/v1/auth/login", { body: { email: "pay-books@example.com", password: password("books") } })).data.token;

	projectUuid = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "pay-shop" } })).data.uuid;

	await call("POST", `/api/v1/projects/${projectUuid}/members`, {
		token: ownerToken,
		body: { email: "pay-books@example.com", role: "accountant" },
	});

	customerUuid = (await call("POST", `/api/v1/projects/${projectUuid}/customers`, { token: ownerToken, body: { email: "payer@example.com", name: "Payer" } }))
		.data.uuid;
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.payments.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("recording payments", () => {
	test("a full payment marks the invoice paid", async () => {
		const invoice = await createInvoice(10000);
		const res = await pay(invoice, 10000);

		expect(res.status).toBe(201);
		expect(res.data.invoice_balance.status).toBe("paid");

		const after = await invoiceOf(invoice);
		expect(after.data.status).toBe("paid");
		expect(after.data.paid_amount).toBe(10000);
		expect(after.data.paid_date).toBeGreaterThan(0);
	});

	test("a part payment marks the invoice partially paid", async () => {
		const invoice = await createInvoice(10000);
		await pay(invoice, 4000);

		const after = await invoiceOf(invoice);
		expect(after.data.status).toBe("partially_paid");
		expect(after.data.paid_amount).toBe(4000);
	});

	test("several part payments add up to paid", async () => {
		const invoice = await createInvoice(10000);
		await pay(invoice, 3000);
		await pay(invoice, 3000);
		await pay(invoice, 4000);

		const after = await invoiceOf(invoice);
		expect(after.data.paid_amount).toBe(10000);
		expect(after.data.status).toBe("paid");
	});

	test("a pending payment does not count towards the balance", async () => {
		const invoice = await createInvoice(10000);
		await pay(invoice, 10000, { status: "pending" });

		const after = await invoiceOf(invoice);
		expect(after.data.paid_amount).toBe(0);
		expect(after.data.status).toBe("open");
	});

	test("a confirmed payment counts towards the balance", async () => {
		const invoice = await createInvoice(10000);
		await pay(invoice, 10000, { status: "confirmed" });

		const after = await invoiceOf(invoice);
		expect(after.data.paid_amount).toBe(10000);
		expect(after.data.status).toBe("paid");
	});

	test("overpayment is recorded faithfully and still reads as paid", async () => {
		const invoice = await createInvoice(10000);
		await pay(invoice, 12500);

		const after = await invoiceOf(invoice);
		expect(after.data.paid_amount).toBe(12500);
		expect(after.data.status).toBe("paid");
	});

	test("records the fee and the net amount", async () => {
		const invoice = await createInvoice(10000);
		const res = await pay(invoice, 10000, { fee_amount: 290 });

		expect(res.data.fee_amount).toBe(290);
		expect(res.data.net_amount).toBe(9710);
	});

	test("takes the currency from the invoice", async () => {
		const invoice = await createInvoice(10000);
		const res = await pay(invoice, 10000);
		expect(res.data.currency).toBe("EUR");
	});

	test("rejects a currency that disagrees with the invoice", async () => {
		const invoice = await createInvoice(10000);
		const res = await pay(invoice, 10000, { currency: "USD" });
		expect(res.error).toBe(1049);
	});

	test("rejects an unknown processor", async () => {
		const invoice = await createInvoice(10000);
		const res = await call("POST", `/api/v1/projects/${projectUuid}/transactions`, {
			token: ownerToken,
			body: { invoice, processor: "carrier_pigeon", amount: 100 },
		});
		expect(res.error).toBe(1048);
	});

	test("rejects a zero or negative amount", async () => {
		const invoice = await createInvoice(10000);
		expect((await pay(invoice, 0)).error).toBe(1047);
		expect((await pay(invoice, -500)).error).toBe(1047);
	});

	test("rejects a fractional amount", async () => {
		const invoice = await createInvoice(10000);
		expect((await pay(invoice, 10.5)).error).toBe(1047);
	});

	test("refuses payment against a draft invoice", async () => {
		const invoice = await createInvoice(10000, { open: false });
		expect((await pay(invoice, 10000)).error).toBe(1050);
	});

	test("refuses payment against a canceled invoice", async () => {
		const invoice = await createInvoice(10000);
		await call("POST", `/api/v1/projects/${projectUuid}/invoices/${invoice}/cancel`, { token: ownerToken });
		expect((await pay(invoice, 10000)).error).toBe(1050);
	});

	test("refuses payment against an invoice from another project", async () => {
		const other = await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "other-pay-shop" } });
		const invoice = await createInvoice(10000);

		const res = await call("POST", `/api/v1/projects/${other.data.uuid}/transactions`, {
			token: ownerToken,
			body: { invoice, processor: "bank_transfer", amount: 10000 },
		});
		expect(res.error).toBe(1035);
	});

	test("records a cash payment from the terminal", async () => {
		const invoice = await createInvoice(1180);
		const res = await pay(invoice, 1180, { processor: "cash" });
		expect(res.error).toBe(0);
		expect(res.data.processor).toBe("cash");
		expect((await invoiceOf(invoice)).data.status).toBe("paid");
	});

	test("an overdue invoice becomes paid once settled", async () => {
		const invoice = await createInvoice(10000, { dueDate: Date.now() - 1000 });
		expect((await invoiceOf(invoice)).data.status).toBe("overdue");

		await pay(invoice, 10000);
		expect((await invoiceOf(invoice)).data.status).toBe("paid");
	});
});

describe("refunds", () => {
	test("a full refund returns the invoice to refunded", async () => {
		const invoice = await createInvoice(10000);
		const payment = await pay(invoice, 10000);

		const res = await call("POST", `/api/v1/projects/${projectUuid}/transactions/${payment.data.uuid}/refund`, {
			token: ownerToken,
			body: { reason: "Customer cancelled" },
		});

		expect(res.status).toBe(201);
		expect(res.data.type).toBe("refund");
		expect(res.data.amount).toBe(10000);

		const after = await invoiceOf(invoice);
		expect(after.data.status).toBe("refunded");
		expect(after.data.refunded_amount).toBe(10000);
		expect(after.data.paid_amount).toBe(10000);
	});

	test("a partial refund leaves the invoice partially paid", async () => {
		const invoice = await createInvoice(10000);
		const payment = await pay(invoice, 10000);

		await call("POST", `/api/v1/projects/${projectUuid}/transactions/${payment.data.uuid}/refund`, { token: ownerToken, body: { amount: 2500 } });

		const after = await invoiceOf(invoice);
		expect(after.data.refunded_amount).toBe(2500);
		expect(after.data.status).toBe("partially_paid");
	});

	test("refunding without an amount refunds everything still available", async () => {
		const invoice = await createInvoice(10000);
		const payment = await pay(invoice, 10000);

		await call("POST", `/api/v1/projects/${projectUuid}/transactions/${payment.data.uuid}/refund`, { token: ownerToken, body: { amount: 3000 } });
		const res = await call("POST", `/api/v1/projects/${projectUuid}/transactions/${payment.data.uuid}/refund`, { token: ownerToken, body: {} });

		expect(res.data.amount).toBe(7000);
		expect((await invoiceOf(invoice)).data.refunded_amount).toBe(10000);
	});

	test("refuses to refund more than was paid", async () => {
		const invoice = await createInvoice(10000);
		const payment = await pay(invoice, 10000);

		const res = await call("POST", `/api/v1/projects/${projectUuid}/transactions/${payment.data.uuid}/refund`, {
			token: ownerToken,
			body: { amount: 10001 },
		});
		expect(res.error).toBe(1051);
	});

	test("refuses to refund more than remains after a partial refund", async () => {
		const invoice = await createInvoice(10000);
		const payment = await pay(invoice, 10000);

		await call("POST", `/api/v1/projects/${projectUuid}/transactions/${payment.data.uuid}/refund`, { token: ownerToken, body: { amount: 6000 } });
		const res = await call("POST", `/api/v1/projects/${projectUuid}/transactions/${payment.data.uuid}/refund`, {
			token: ownerToken,
			body: { amount: 5000 },
		});

		expect(res.error).toBe(1051);
	});

	test("marks the payment refunded or partially refunded", async () => {
		const invoice = await createInvoice(10000);
		const payment = await pay(invoice, 10000);

		await call("POST", `/api/v1/projects/${projectUuid}/transactions/${payment.data.uuid}/refund`, { token: ownerToken, body: { amount: 4000 } });
		let detail = await call("GET", `/api/v1/projects/${projectUuid}/transactions/${payment.data.uuid}`, { token: ownerToken });
		expect(detail.data.status).toBe("partially_refunded");
		expect(detail.data.refundable).toBe(6000);

		await call("POST", `/api/v1/projects/${projectUuid}/transactions/${payment.data.uuid}/refund`, { token: ownerToken, body: { amount: 6000 } });
		detail = await call("GET", `/api/v1/projects/${projectUuid}/transactions/${payment.data.uuid}`, { token: ownerToken });
		expect(detail.data.status).toBe("refunded");
		expect(detail.data.refundable).toBe(0);
	});

	test("refuses to refund a pending payment", async () => {
		const invoice = await createInvoice(10000);
		const payment = await pay(invoice, 10000, { status: "pending" });

		const res = await call("POST", `/api/v1/projects/${projectUuid}/transactions/${payment.data.uuid}/refund`, { token: ownerToken, body: {} });
		expect(res.error).toBe(1052);
	});

	test("refuses to refund a refund", async () => {
		const invoice = await createInvoice(10000);
		const payment = await pay(invoice, 10000);
		const refund = await call("POST", `/api/v1/projects/${projectUuid}/transactions/${payment.data.uuid}/refund`, { token: ownerToken, body: {} });

		const res = await call("POST", `/api/v1/projects/${projectUuid}/transactions/${refund.data.uuid}/refund`, { token: ownerToken, body: {} });
		expect(res.error).toBe(1052);
	});

	test("writes a refunds row with who and why", async () => {
		const invoice = await createInvoice(10000);
		const payment = await pay(invoice, 10000);
		await call("POST", `/api/v1/projects/${projectUuid}/transactions/${payment.data.uuid}/refund`, {
			token: ownerToken,
			body: { amount: 1000, reason: "Goodwill" },
		});

		const [row] = (await Database`SELECT * FROM refunds WHERE transaction_id = ${payment.data.uuid}`) as any[];
		expect(row.reason).toBe("Goodwill");
		expect(row.initiated_by).toBe(await accountId("pay-owner"));
		expect(row.amount).toBe(1000);
	});
});

describe("ledger integrity", () => {
	test("invoice amounts are derived, so a stale value is corrected", async () => {
		const invoice = await createInvoice(10000);
		await pay(invoice, 6000);

		await Database`UPDATE invoices SET paid_amount = 999999 WHERE uuid = ${invoice}`;
		await pay(invoice, 1000);

		const after = await invoiceOf(invoice);
		expect(after.data.paid_amount).toBe(7000);
	});

	test("a failed refund leaves nothing behind", async () => {
		const invoice = await createInvoice(10000);
		const payment = await pay(invoice, 10000);

		await call("POST", `/api/v1/projects/${projectUuid}/transactions/${payment.data.uuid}/refund`, { token: ownerToken, body: { amount: 99999 } });

		const [count] = (await Database`
			SELECT COUNT(*) AS count FROM transactions WHERE parent_transaction = ${payment.data.uuid}
		`) as { count: number }[];
		expect(count.count).toBe(0);

		const [refunds] = (await Database`SELECT COUNT(*) AS count FROM refunds WHERE transaction_id = ${payment.data.uuid}`) as { count: number }[];
		expect(refunds.count).toBe(0);
	});

	test("a refunded payment still counts as received", async () => {
		const isolated = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "totals-shop" } })).data.uuid;
		const customer = (await call("POST", `/api/v1/projects/${isolated}/customers`, { token: ownerToken, body: { email: "t@example.com" } })).data.uuid;

		const invoice = (
			await call("POST", `/api/v1/projects/${isolated}/invoices`, {
				token: ownerToken,
				body: { customer, currency: "EUR", due_date: Date.now() + 100000, items: [{ description: "Work", quantity: 1, unit_price: 10000 }] },
			})
		).data.uuid;
		await call("POST", `/api/v1/projects/${isolated}/invoices/${invoice}/open`, { token: ownerToken });

		const payment = await call("POST", `/api/v1/projects/${isolated}/transactions`, {
			token: ownerToken,
			body: { invoice, processor: "bank_transfer", amount: 10000 },
		});

		await call("POST", `/api/v1/projects/${isolated}/transactions/${payment.data.uuid}/refund`, { token: ownerToken, body: { amount: 2500 } });

		const res = await call("GET", `/api/v1/projects/${isolated}/transactions`, { token: ownerToken });
		const eur = res.data.totals.find((total: any) => total.currency === "EUR");

		expect(eur.received).toBe(10000);
		expect(eur.refunded).toBe(2500);
	});

	test("transaction totals are grouped by currency", async () => {
		const res = await call("GET", `/api/v1/projects/${projectUuid}/transactions`, { token: ownerToken });
		expect(res.data.totals.length).toBeGreaterThan(0);
		for (const total of res.data.totals) {
			expect(total.currency).toBe("EUR");
			expect(total.received).toBeGreaterThan(0);
		}
	});

	test("filters transactions by invoice", async () => {
		const invoice = await createInvoice(10000);
		await pay(invoice, 5000);

		const res = await call("GET", `/api/v1/projects/${projectUuid}/transactions?invoice=${invoice}`, { token: ownerToken });
		expect(res.data.transactions).toHaveLength(1);
		expect(res.data.transactions[0].invoice).toBe(invoice);
	});
});

describe("payment list filters", () => {
	const list = async (query: string) => (await call("GET", `/api/v1/projects/${projectUuid}/transactions?${query}`, { token: ownerToken })).data;
	let filterCustomer = "";
	let invoiceReference = "";

	beforeAll(async () => {
		filterCustomer = (
			await call("POST", `/api/v1/projects/${projectUuid}/customers`, { token: ownerToken, body: { email: "filtered@example.com", name: "Filtered Buyer" } })
		).data.uuid;
		const created = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: {
				customer: filterCustomer,
				currency: "EUR",
				due_date: Date.now() + 86400000,
				items: [{ description: "Work", quantity: 1, unit_price: 9000, tax_rate: 0 }],
			},
		});
		await call("POST", `/api/v1/projects/${projectUuid}/invoices/${created.data.uuid}/open`, { token: ownerToken });
		invoiceReference = (await invoiceOf(created.data.uuid)).data.reference;
		const payment = await pay(created.data.uuid, 9000, { processor: "cash", processor_tx_id: "TILL-4471" });
		await call("POST", `/api/v1/projects/${projectUuid}/transactions/${payment.data.uuid}/refund`, { token: ownerToken, body: { amount: 1500 } });
	});

	test("returns the invoice reference and customer with each transaction", async () => {
		const result = await list(`customer=${filterCustomer}&type=payment`);
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0]).toMatchObject({
			invoice_reference: invoiceReference,
			customer_name: "Filtered Buyer",
			customer_email: "filtered@example.com",
		});
	});

	test("filters by customer, type and processor together with the totals", async () => {
		const both = await list(`customer=${filterCustomer}`);
		expect(both.total).toBe(2);
		expect(both.totals).toEqual([{ currency: "EUR", received: 9000, refunded: 1500, fees: 0 }]);

		const refunds = await list(`customer=${filterCustomer}&type=refund`);
		expect(refunds.total).toBe(1);
		expect(refunds.transactions[0].type).toBe("partial_refund");
		expect(refunds.totals).toEqual([{ currency: "EUR", received: 0, refunded: 1500, fees: 0 }]);

		expect((await list(`customer=${filterCustomer}&processor=cash`)).total).toBe(2);
		expect((await list(`customer=${filterCustomer}&processor=stripe`)).total).toBe(0);
	});

	test("searches the invoice reference and the processor transaction id", async () => {
		expect((await list("search=till-44")).transactions.map((row: any) => row.processor_tx_id)).toEqual(["TILL-4471"]);
		const byReference = await list(`search=${encodeURIComponent(invoiceReference)}`);
		expect(byReference.transactions.every((row: any) => row.invoice_reference === invoiceReference)).toBe(true);
		expect(byReference.total).toBe(2);
	});

	test("rejects unknown type filters and bad customer ids", async () => {
		expect((await call("GET", `/api/v1/projects/${projectUuid}/transactions?type=gift`, { token: ownerToken })).error).toBe(1001);
		expect((await call("GET", `/api/v1/projects/${projectUuid}/transactions?customer=nope`, { token: ownerToken })).error).toBe(1033);
	});
});

describe("payment permissions", () => {
	test("an accountant can view transactions", async () => {
		expect((await call("GET", `/api/v1/projects/${projectUuid}/transactions`, { token: accountantToken })).error).toBe(0);
	});

	test("an accountant cannot record a payment", async () => {
		const invoice = await createInvoice(10000);
		const res = await call("POST", `/api/v1/projects/${projectUuid}/transactions`, {
			token: accountantToken,
			body: { invoice, processor: "bank_transfer", amount: 100 },
		});
		expect(res.error).toBe(9999);
	});

	test("an accountant cannot refund", async () => {
		const invoice = await createInvoice(10000);
		const payment = await pay(invoice, 10000);

		const res = await call("POST", `/api/v1/projects/${projectUuid}/transactions/${payment.data.uuid}/refund`, {
			token: accountantToken,
			body: {},
		});
		expect(res.error).toBe(9999);
	});

	test("records payments in the audit trail", async () => {
		const [entry] = (await Database`SELECT COUNT(*) AS count FROM audit_log WHERE action = 'payment.recorded'`) as { count: number }[];
		expect(entry.count).toBeGreaterThan(0);

		const [refunded] = (await Database`SELECT COUNT(*) AS count FROM audit_log WHERE action = 'payment.refunded'`) as { count: number }[];
		expect(refunded.count).toBeGreaterThan(0);
	});
});
