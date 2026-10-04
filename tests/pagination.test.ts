import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { PageState } from "../server/page-state";
import { prepareTest } from "./environment";
await prepareTest();
const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
await Server.configure();
let token = "";
let project = "";
let other = "";
let customer = "";
let keyedItem = "";
let recurring = "";
const base = () => `/api/v1/projects/${project}`;

async function call(method: string, path: string, body?: unknown) {
	const response = await Server.app.handle(
		new Request(`http://localhost${path}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	);
	return { status: response.status, ...((await response.json()) as { error: number; data: any }) };
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	const password = new Bun.CryptoHasher("blake2b512").update("pagination-owner").digest("hex");
	await call("POST", "/api/v1/auth/register", { email: "pagination-owner@example.com", password });
	token = (await call("POST", "/api/v1/auth/login", { email: "pagination-owner@example.com", password })).data.token;
	project = (await call("POST", "/api/v1/projects", { name: "pagination-project" })).data.uuid;
	other = (await call("POST", "/api/v1/projects", { name: "pagination-other" })).data.uuid;
	for (let index = 0; index < 55; index++) {
		const result = await call("POST", `${base()}/customers`, {
			email: `customer${index}@example.com`,
			name: index < 3 ? "Matched customer" : "Another customer",
		});
		expect(result.error).toBe(0);
		customer = result.data.uuid;
	}
	for (let index = 0; index < 55; index++) {
		const result = await call("POST", `${base()}/items`, {
			name: index < 3 ? "Matched item" : "Another item",
			sku: `SKU-${index}`,
			unit_price: 1000,
			delivers_keys: index === 0,
		});
		expect(result.error).toBe(0);
		if (index === 0) keyedItem = result.data.uuid;
	}
	await call("POST", `${base()}/items/${keyedItem}/keys`, { keys: Array.from({ length: 55 }, (_, index) => `KEY-${index}`).join("\n") });
	const template = await call("POST", `${base()}/recurring`, {
		title: "Recurring",
		customer,
		interval_unit: "month",
		interval_count: 1,
		start_date: Date.now(),
		items: [{ description: "Service", quantity: 1, unit_price: 1000 }],
		auto_issue: false,
		auto_send: false,
	});
	expect(template.error).toBe(0);
	recurring = template.data.uuid;
	for (let index = 0; index < 55; index++) {
		const invoice = await call("POST", `${base()}/invoices`, {
			customer,
			items: [{ description: "Service", quantity: 1, unit_price: 1000 }],
			due_date: Date.now() + 86400000,
		});
		expect(invoice.error).toBe(0);
		await Database`UPDATE invoices SET recurring = ${recurring}, created = 1000, source = 'pos' WHERE uuid = ${invoice.data.uuid}`;
		await Database`INSERT INTO transactions(uuid, project, invoice, processor, status, type, currency, amount, fee_amount, created, updated)
			VALUES(${crypto.randomUUID()}, ${project}, ${invoice.data.uuid}, 'bank_transfer', ${index < 3 ? "pending" : "completed"}, 'payment', 'EUR', 1000, 0, 1000, 1000)`;
		await Database`INSERT INTO webhook_deliveries(uuid, project, event_type, target_url, payload, status, attempts, created, updated)
			VALUES(${crypto.randomUUID()}, ${project}, 'invoice.issued', 'https://example.com/hook', '{}', 'pending', 0, 1000, 1000)`;
	}
});
afterAll(async () => {
	await Database.close();
});

async function pages(path: string, key: string) {
	const first = (await call("GET", `${path}?limit=50&offset=0`)).data;
	const second = (await call("GET", `${path}?limit=50&offset=50`)).data;
	expect(first.total).toBe(55);
	expect(second.total).toBe(55);
	expect(first[key]).toHaveLength(50);
	expect(second[key]).toHaveLength(5);
	expect(new Set([...first[key], ...second[key]].map((row) => row.uuid)).size).toBe(55);
	const repeat = (await call("GET", `${path}?limit=50&offset=0`)).data;
	expect(repeat[key].map((row: any) => row.uuid)).toEqual(first[key].map((row: any) => row.uuid));
}

describe("paginated records", () => {
	test("makes every customer reachable with stable page ordering", async () => {
		await pages(`${base()}/customers`, "customers");
	});
	test("counts only customers matching the search", async () => {
		const first = (await call("GET", `${base()}/customers?search=Matched&limit=2`)).data;
		const next = (await call("GET", `${base()}/customers?search=Matched&limit=2&offset=2`)).data;
		expect(first.total).toBe(3);
		expect(next.customers).toHaveLength(1);
	});
	test("makes every item reachable and counts matching items", async () => {
		await pages(`${base()}/items`, "items");
		const result = (await call("GET", `${base()}/items?search=Matched&limit=2`)).data;
		expect(result.total).toBe(3);
		expect(result.items).toHaveLength(2);
	});
	test("pages key stock without changing stock totals", async () => {
		await pages(`${base()}/items/${keyedItem}/keys`, "keys");
		const result = (await call("GET", `${base()}/items/${keyedItem}/keys?offset=50&limit=50&status=available`)).data;
		expect(result.stock.available).toBe(55);
		expect(result.total).toBe(55);
	});
	test("pages transactions and applies status and invoice filters to the count", async () => {
		await pages(`${base()}/transactions`, "transactions");
		const pending = (await call("GET", `${base()}/transactions?status=pending&limit=2`)).data;
		expect(pending.total).toBe(3);
		const invoice = pending.transactions[0].invoice;
		const detail = (await call("GET", `${base()}/transactions?invoice=${invoice}&status=pending`)).data;
		expect(detail.total).toBe(1);
	});
	test("pages webhook history while retaining full delivery counts", async () => {
		await pages(`${base()}/webhooks`, "deliveries");
		const result = (await call("GET", `${base()}/webhooks?limit=50&offset=50`)).data;
		expect(result.counts.pending).toBe(55);
	});
	test("pages recurring invoice history and keeps it scoped to the project", async () => {
		await pages(`${base()}/recurring/${recurring}/invoices`, "invoices");
		expect((await call("GET", `/api/v1/projects/${other}/recurring/${recurring}/invoices`)).status).toBe(404);
	});
	test("pages terminal sales while keeping the summary for the full period", async () => {
		const query = `${base()}/pos/sales?scope=all&from=0&to=2000&limit=50`;
		const first = (await call("GET", query)).data;
		const second = (await call("GET", `${query}&offset=50`)).data;
		expect(first.sales).toHaveLength(50);
		expect(second.sales).toHaveLength(5);
		expect(second.total).toBe(55);
		expect(second.summary).toEqual(first.summary);
		expect(first.summary[0].sales).toBe(55);
	});
	test("returns the remaining page after deleting records", async () => {
		const last = (await call("GET", `${base()}/customers?limit=50&offset=50`)).data.customers;
		for (const row of last.filter((row: any) => row.uuid !== customer).slice(0, 4)) {
			expect((await call("DELETE", `${base()}/customers/${row.uuid}`)).error).toBe(0);
		}
		const result = (await call("GET", `${base()}/customers?limit=50&offset=50`)).data;
		expect(result.total).toBe(51);
		expect(result.customers).toHaveLength(1);
	});
});

describe("page state during list changes", () => {
	test("moves back when the last record on a later page is deleted", () => {
		const page = new PageState();
		page.update(101);
		page.offset = 100;
		expect(page.update(100)).toBe(true);
		expect(page.offset).toBe(50);
		expect(page.next).toBe(false);
		expect(page.previous).toBe(true);
		page.update(0);
		expect(page.offset).toBe(0);
		expect(page.previous).toBe(false);
	});
	test("ignores requests from a previous filter and older requests for the current filter", () => {
		const page = new PageState();
		page.update(100);
		page.offset = 50;
		const oldFilter = page.begin();
		page.reset();
		expect(page.offset).toBe(0);
		expect(page.current(oldFilter)).toBe(false);
		const first = page.begin();
		const latest = page.begin();
		expect(page.current(first)).toBe(false);
		expect(page.current(latest)).toBe(true);
	});
});
