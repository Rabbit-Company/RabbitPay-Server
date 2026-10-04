import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import { createHmac } from "node:crypto";
import type { PaypalClient, PaypalOrder, PaypalSignatureInput } from "../server/processors/paypal";
import type { StripeCheckout, StripeClient } from "../server/processors/stripe";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.cards.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { parseSignatureHeader, verifySignature } = await import("../server/processors/stripe");
const { toDecimalString, toMinorUnits } = await import("../server/processors/paypal");
const { createPaypalOrder, createStripeCheckout, handlePaypalEvent, handleStripeEvent } = await import("../server/payments/checkout");
const { setProcessor } = await import("../server/payments/methods");

await Server.configure();

const SECRET = "whsec_test";
const password = (seed: string) => new Bun.CryptoHasher("blake2b512").update(seed).digest("hex");

interface ApiResponse {
	status: number;
	error: number;
	info: string;
	data?: any;
}

async function call(method: string, path: string, options: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
	const headers: Record<string, string> = { ...options.headers };
	if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
	if (options.body !== undefined || options.raw !== undefined) headers["Content-Type"] = "application/json";

	const res = await Server.app.handle(
		new Request(`http://127.0.0.1${path}`, {
			method,
			headers,
			body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
		})
	);

	const json = (await res.json()) as { error: number; info: string; data?: unknown };
	return { status: res.status, ...json } as ApiResponse;
}

class FakeStripe implements StripeClient {
	nextId = 1;
	lastOptions: any = null;
	fail = false;

	async createCheckout(options: any): Promise<StripeCheckout> {
		if (this.fail) throw new Error("stripe is down");
		this.lastOptions = options;
		const id = `cs_test_${this.nextId++}`;
		return { id, url: `https://checkout.stripe.test/${id}` };
	}
}

class FakePaypal implements PaypalClient {
	nextId = 1;
	lastOptions: any = null;
	verifyResult = true;
	captureResult: { captureId: string; amountMinor: number; currency: string } | null = null;

	async createOrder(options: any): Promise<PaypalOrder> {
		this.lastOptions = options;
		const id = `ORDER-${this.nextId++}`;
		return { id, approveUrl: `https://paypal.test/approve/${id}` };
	}

	async captureOrder(): Promise<{ captureId: string; amountMinor: number; currency: string } | null> {
		return this.captureResult;
	}

	async verifyWebhook(_input: PaypalSignatureInput): Promise<boolean> {
		return this.verifyResult;
	}
}

function stripeSignature(body: string, secret = SECRET, at = Math.floor(Date.now() / 1000)) {
	return `t=${at},v1=${createHmac("sha256", secret).update(`${at}.${body}`).digest("hex")}`;
}

let stripe: FakeStripe;
let paypal: FakePaypal;
let sessionToken = "";
let apiKey = "";
let projectUuid = "";

const dueDate = () => Date.now() + 7 * 24 * 60 * 60 * 1000;

async function issueInvoice(unitPrice: number) {
	const created = await call("POST", "/api/v1/pay/invoices", {
		token: apiKey,
		body: { currency: "EUR", due_date: dueDate(), items: [{ description: "Work", quantity: 1, unit_price: unitPrice }] },
	});
	return created.data.uuid as string;
}

async function projectRow() {
	const [row] = (await Database`SELECT * FROM projects WHERE uuid = ${projectUuid}`) as any[];
	return row;
}

async function invoiceRow(uuid: string) {
	const [row] = (await Database`SELECT * FROM invoices WHERE uuid = ${uuid}`) as any[];
	return row;
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();
	stripe = new FakeStripe();
	paypal = new FakePaypal();

	await call("POST", "/api/v1/auth/register", { body: { email: "card-owner@example.com", password: password("owner") } });
	sessionToken = (await call("POST", "/api/v1/auth/login", { body: { email: "card-owner@example.com", password: password("owner") } })).data.token;

	const project = await call("POST", "/api/v1/projects", { token: sessionToken, body: { name: "card-shop" } });
	projectUuid = project.data.uuid;
	apiKey = project.data.apikey;
	await setProcessor(projectUuid, "stripe", true, { secret_key: "sk_test_shop", webhook_secret: SECRET });
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.cards.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("stripe signature verification", () => {
	const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });

	test("accepts a signature it can reproduce", () => {
		expect(verifySignature(SECRET, stripeSignature(body), body).valid).toBe(true);
	});

	test("rejects a tampered body", () => {
		const header = stripeSignature(body);
		expect(verifySignature(SECRET, header, JSON.stringify({ id: "evt_1", type: "evil" })).valid).toBe(false);
	});

	test("rejects the wrong secret", () => {
		expect(verifySignature("whsec_other", stripeSignature(body), body).valid).toBe(false);
	});

	test("rejects an old timestamp so a capture cannot be replayed", () => {
		const old = Math.floor(Date.now() / 1000) - 3600;
		const check = verifySignature(SECRET, stripeSignature(body, SECRET, old), body);

		expect(check.valid).toBe(false);
		expect(check.reason).toContain("tolerance");
	});

	test("rejects a missing or malformed header", () => {
		expect(verifySignature(SECRET, "", body).valid).toBe(false);
		expect(verifySignature(SECRET, "nonsense", body).valid).toBe(false);
		expect(verifySignature(SECRET, "t=123", body).valid).toBe(false);
	});

	test("rejects everything when no secret is configured", () => {
		expect(verifySignature("", stripeSignature(body), body).valid).toBe(false);
	});

	test("accepts a header carrying several signatures during a secret rotation", () => {
		const at = Math.floor(Date.now() / 1000);
		const good = createHmac("sha256", SECRET).update(`${at}.${body}`).digest("hex");
		const header = `t=${at},v1=00000000,v1=${good}`;

		expect(verifySignature(SECRET, header, body).valid).toBe(true);
	});

	test("parses the header into its parts", () => {
		const parsed = parseSignatureHeader("t=1700000000,v1=abc,v0=ignored");
		expect(parsed.timestamp).toBe(1700000000);
		expect(parsed.signatures).toEqual(["abc"]);
	});
});

describe("paypal amounts", () => {
	test("formats minor units as a decimal string", () => {
		expect(toDecimalString(25000, "EUR")).toBe("250.00");
		expect(toDecimalString(1, "EUR")).toBe("0.01");
		expect(toDecimalString(1500, "JPY")).toBe("1500");
	});

	test("parses a decimal string back to minor units", () => {
		expect(toMinorUnits("250.00", "EUR")).toBe(25000);
		expect(toMinorUnits("19.99", "EUR")).toBe(1999);
		expect(toMinorUnits("1500", "JPY")).toBe(1500);
	});

	test("a round trip keeps the amount", () => {
		for (const minor of [1, 999, 25000, 1234567]) {
			expect(toMinorUnits(toDecimalString(minor, "EUR"), "EUR")).toBe(minor);
		}
	});
});

describe("opening a checkout", () => {
	test("stripe checkout asks for the outstanding amount", async () => {
		const invoiceId = await issueInvoice(25000);
		const hosted = await createStripeCheckout(stripe, await projectRow(), await invoiceRow(invoiceId));

		expect(stripe.lastOptions.amountMinor).toBe(25000);
		expect(stripe.lastOptions.currency).toBe("EUR");
		expect(hosted.checkoutUrl).toContain("checkout.stripe.test");
		expect(hosted.session.processor).toBe("stripe");
	});

	test("reuses a live checkout rather than opening another", async () => {
		const invoiceId = await issueInvoice(25000);
		const invoice = await invoiceRow(invoiceId);

		const first = await createStripeCheckout(stripe, await projectRow(), invoice);
		const second = await createStripeCheckout(stripe, await projectRow(), invoice);

		expect(second.session.processor_session_id).toBe(first.session.processor_session_id);
	});

	test("paypal order carries the invoice as its custom id", async () => {
		const invoiceId = await issueInvoice(25000);
		const hosted = await createPaypalOrder(paypal, await projectRow(), await invoiceRow(invoiceId));

		expect(paypal.lastOptions.reference).toBe(invoiceId);
		expect(hosted.checkoutUrl).toContain("paypal.test/approve");
	});
});

describe("stripe events", () => {
	test("credits an invoice when a checkout completes", async () => {
		const invoiceId = await issueInvoice(25000);
		const hosted = await createStripeCheckout(stripe, await projectRow(), await invoiceRow(invoiceId));

		const result = await handleStripeEvent({
			id: "evt_paid",
			type: "checkout.session.completed",
			data: { object: { id: hosted.session.processor_session_id, payment_status: "paid", payment_intent: "pi_1", amount_total: 25000, currency: "eur" } },
		});

		expect(result.processed).toBe(true);

		const after = await invoiceRow(invoiceId);
		expect(after.status).toBe("paid");
		expect(after.paid_amount).toBe(25000);
	});

	test("does not credit a checkout that is not paid", async () => {
		const invoiceId = await issueInvoice(25000);
		const hosted = await createStripeCheckout(stripe, await projectRow(), await invoiceRow(invoiceId));

		const result = await handleStripeEvent({
			id: "evt_unpaid",
			type: "checkout.session.completed",
			data: { object: { id: hosted.session.processor_session_id, payment_status: "unpaid", amount_total: 25000, currency: "eur" } },
		});

		expect(result.processed).toBe(false);
		expect((await invoiceRow(invoiceId)).paid_amount).toBe(0);
	});

	test("ignores an event for an unknown checkout", async () => {
		const result = await handleStripeEvent({
			id: "evt_unknown",
			type: "checkout.session.completed",
			data: { object: { id: "cs_test_nope", payment_status: "paid", amount_total: 100, currency: "eur" } },
		});

		expect(result.processed).toBe(false);
	});

	test("does not credit the same payment twice", async () => {
		const invoiceId = await issueInvoice(25000);
		const hosted = await createStripeCheckout(stripe, await projectRow(), await invoiceRow(invoiceId));

		const event = {
			id: "evt_repeat",
			type: "checkout.session.completed",
			data: { object: { id: hosted.session.processor_session_id, payment_status: "paid", payment_intent: "pi_repeat", amount_total: 25000, currency: "eur" } },
		};

		await handleStripeEvent(event);
		await handleStripeEvent(event);

		const [row] = (await Database`SELECT COUNT(*) AS count FROM transactions WHERE invoice = ${invoiceId}`) as { count: number }[];
		expect(row.count).toBe(1);
	});

	test("refuses a payment in the wrong currency", async () => {
		const invoiceId = await issueInvoice(25000);
		const hosted = await createStripeCheckout(stripe, await projectRow(), await invoiceRow(invoiceId));

		await handleStripeEvent({
			id: "evt_currency",
			type: "checkout.session.completed",
			data: { object: { id: hosted.session.processor_session_id, payment_status: "paid", payment_intent: "pi_usd", amount_total: 25000, currency: "usd" } },
		});

		expect((await invoiceRow(invoiceId)).paid_amount).toBe(0);
	});

	test("closes the checkout once the invoice is settled", async () => {
		const [session] = (await Database`
			SELECT * FROM payment_sessions WHERE processor = 'stripe' AND status = 'completed' ORDER BY created DESC
		`) as any[];
		expect(session).toBeDefined();
		expect(session.completed_at).toBeGreaterThan(0);
	});
});

describe("paypal events", () => {
	test("captures on approval and credits the invoice", async () => {
		const invoiceId = await issueInvoice(25000);
		const hosted = await createPaypalOrder(paypal, await projectRow(), await invoiceRow(invoiceId));

		paypal.captureResult = { captureId: "CAPTURE-1", amountMinor: 25000, currency: "EUR" };

		const result = await handlePaypalEvent(paypal, {
			id: "WH-1",
			event_type: "CHECKOUT.ORDER.APPROVED",
			resource: { id: hosted.session.processor_session_id, intent: "CAPTURE", custom_id: invoiceId },
		});

		expect(result.processed).toBe(true);
		expect((await invoiceRow(invoiceId)).status).toBe("paid");
	});

	test("credits a capture event matched by order id", async () => {
		const invoiceId = await issueInvoice(25000);
		const hosted = await createPaypalOrder(paypal, await projectRow(), await invoiceRow(invoiceId));

		const result = await handlePaypalEvent(paypal, {
			id: "WH-2",
			event_type: "PAYMENT.CAPTURE.COMPLETED",
			resource: {
				id: "CAPTURE-2",
				amount: { currency_code: "EUR", value: "250.00" },
				supplementary_data: { related_ids: { order_id: hosted.session.processor_session_id } },
			},
		});

		expect(result.processed).toBe(true);
		expect((await invoiceRow(invoiceId)).paid_amount).toBe(25000);
	});

	test("falls back to the custom id when the order id is absent", async () => {
		const invoiceId = await issueInvoice(25000);
		await createPaypalOrder(paypal, await projectRow(), await invoiceRow(invoiceId));

		const result = await handlePaypalEvent(paypal, {
			id: "WH-3",
			event_type: "PAYMENT.CAPTURE.COMPLETED",
			resource: { id: "CAPTURE-3", amount: { currency_code: "EUR", value: "250.00" }, custom_id: invoiceId },
		});

		expect(result.processed).toBe(true);
	});

	test("ignores an event type it does not handle", async () => {
		const invoiceId = await issueInvoice(25000);
		const hosted = await createPaypalOrder(paypal, await projectRow(), await invoiceRow(invoiceId));

		const result = await handlePaypalEvent(paypal, {
			id: "WH-4",
			event_type: "PAYMENT.CAPTURE.PENDING",
			resource: { supplementary_data: { related_ids: { order_id: hosted.session.processor_session_id } } },
		});

		expect(result.processed).toBe(false);
	});

	test("does not credit when the capture call fails", async () => {
		const invoiceId = await issueInvoice(25000);
		const hosted = await createPaypalOrder(paypal, await projectRow(), await invoiceRow(invoiceId));

		paypal.captureResult = null;

		const result = await handlePaypalEvent(paypal, {
			id: "WH-5",
			event_type: "CHECKOUT.ORDER.APPROVED",
			resource: { id: hosted.session.processor_session_id, intent: "CAPTURE" },
		});

		expect(result.processed).toBe(false);
		expect((await invoiceRow(invoiceId)).paid_amount).toBe(0);
	});
});

describe("inbound webhook endpoints", () => {
	async function sessionEvent(id: string) {
		const invoiceId = await issueInvoice(1000);
		const hosted = await createStripeCheckout(stripe, await projectRow(), await invoiceRow(invoiceId));
		return JSON.stringify({ id, type: "checkout.session.completed", data: { object: { id: hosted.session.processor_session_id, payment_status: "unpaid" } } });
	}

	test("stripe rejects an unsigned request for a known checkout", async () => {
		const res = await call("POST", "/api/v1/hooks/stripe", { raw: await sessionEvent("evt_unsigned") });
		expect(res.error).toBe(1057);
	});

	test("stripe rejects a request signed with another secret", async () => {
		const body = await sessionEvent("evt_wrong");
		const res = await call("POST", "/api/v1/hooks/stripe", {
			raw: body,
			headers: { "stripe-signature": stripeSignature(body, "whsec_wrong") },
		});
		expect(res.error).toBe(1057);
	});

	test("stripe accepts a request signed with the project's secret", async () => {
		const body = await sessionEvent("evt_ok");
		const res = await call("POST", "/api/v1/hooks/stripe", { raw: body, headers: { "stripe-signature": stripeSignature(body) } });

		expect(res.error).toBe(0);
		expect(res.data.received).toBe(true);
	});

	test("another project's secret does not verify this project's checkout", async () => {
		const other = await call("POST", "/api/v1/projects", { token: sessionToken, body: { name: "card-other-shop" } });
		await setProcessor(other.data.uuid, "stripe", true, { secret_key: "sk_test_other", webhook_secret: "whsec_other" });
		const body = await sessionEvent("evt_crossed");
		const res = await call("POST", "/api/v1/hooks/stripe", { raw: body, headers: { "stripe-signature": stripeSignature(body, "whsec_other") } });
		expect(res.error).toBe(1057);
	});

	test("events for no known checkout are acknowledged and ignored", async () => {
		const body = JSON.stringify({ id: "evt_other", type: "customer.created", data: { object: {} } });
		const res = await call("POST", "/api/v1/hooks/stripe", { raw: body });
		expect(res.error).toBe(0);
		expect(res.data.processed).toBe(false);

		const paypal = await call("POST", "/api/v1/hooks/paypal", { raw: JSON.stringify({ id: "WH-1", event_type: "CUSTOMER.CREATED", resource: {} }) });
		expect(paypal.error).toBe(0);
		expect(paypal.data.processed).toBe(false);
	});

	test("a signed stripe webhook credits the invoice end to end", async () => {
		const invoiceId = await issueInvoice(25000);
		const hosted = await createStripeCheckout(stripe, await projectRow(), await invoiceRow(invoiceId));

		const body = JSON.stringify({
			id: "evt_endtoend",
			type: "checkout.session.completed",
			data: { object: { id: hosted.session.processor_session_id, payment_status: "paid", payment_intent: "pi_e2e", amount_total: 25000, currency: "eur" } },
		});

		const res = await call("POST", "/api/v1/hooks/stripe", { raw: body, headers: { "stripe-signature": stripeSignature(body) } });

		expect(res.data.processed).toBe(true);
		expect((await invoiceRow(invoiceId)).status).toBe("paid");
	});

	test("records the inbound event for audit", async () => {
		const [row] = (await Database`
			SELECT * FROM webhook_events WHERE processor = 'stripe' AND event_id = 'evt_endtoend'
		`) as any[];

		expect(row).toBeDefined();
		expect(row.verified).toBe(1);
		expect(row.processed).toBe(1);
		expect(row.project).toBe(projectUuid);
	});

	test("the webhook endpoints need no api key or session", async () => {
		const body = await sessionEvent("evt_anon");
		const res = await call("POST", "/api/v1/hooks/stripe", { raw: body, headers: { "stripe-signature": stripeSignature(body) } });

		expect(res.error).toBe(0);
	});
});
