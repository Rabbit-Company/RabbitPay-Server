import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.items.sqlite`);

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
let viewerToken = "";
let projectUuid = "";
let otherProjectUuid = "";
let widget = "";

const base = () => `/api/v1/projects/${projectUuid}`;

async function invoiceWith(items: unknown[], currency = "EUR") {
	const created = await call("POST", `${base()}/invoices`, {
		token: ownerToken,
		body: { currency, due_date: Date.now() + 86400000, items },
	});
	return created;
}

beforeAll(async () => {
	await Cache.initialize();
	const { updateSettings } = await import("../server/settings");
	await updateSettings({ "reports.cooldown_minutes": 0 });
	await initializeDatabase();

	await call("POST", "/api/v1/auth/register", { body: { email: "item-owner@example.com", password: password("item-owner") } });
	ownerToken = (await call("POST", "/api/v1/auth/login", { body: { email: "item-owner@example.com", password: password("item-owner") } })).data.token;

	await call("POST", "/api/v1/auth/register", { body: { email: "item-viewer@example.com", password: password("item-viewer") } });
	viewerToken = (await call("POST", "/api/v1/auth/login", { body: { email: "item-viewer@example.com", password: password("item-viewer") } })).data.token;

	projectUuid = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "item-shop", currency: "EUR" } })).data.uuid;
	otherProjectUuid = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "item-other", currency: "EUR" } })).data.uuid;

	await call("POST", `${base()}/members`, { token: ownerToken, body: { email: "item-viewer@example.com", role: "viewer" } });
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.items.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("the item catalog", () => {
	test("creates an item in the project currency by default", async () => {
		const res = await call("POST", `${base()}/items`, {
			token: ownerToken,
			body: { name: "  Widget  ", sku: "WID-1", unit_price: 1250, tax_rate: 22, description: "A small widget" },
		});

		expect(res.status).toBe(201);
		expect(res.data.name).toBe("Widget");
		expect(res.data.currency).toBe("EUR");
		expect(res.data.tax_rate).toBe(22);
		expect(res.data.archived).toBe(false);
		widget = res.data.uuid;
	});

	test("creates an item priced in another currency", async () => {
		const res = await call("POST", `${base()}/items`, { token: ownerToken, body: { name: "Consulting hour", unit_price: 9000, currency: "USD" } });

		expect(res.data.currency).toBe("USD");
		expect(res.data.sku).toBeNull();
	});

	test("refuses an item without a name or a valid price", async () => {
		expect((await call("POST", `${base()}/items`, { token: ownerToken, body: { unit_price: 100 } })).error).toBe(1066);
		expect((await call("POST", `${base()}/items`, { token: ownerToken, body: { name: "Bad", unit_price: 1.5 } })).error).toBe(1066);
		expect((await call("POST", `${base()}/items`, { token: ownerToken, body: { name: "Bad", unit_price: -1 } })).error).toBe(1066);
		expect((await call("POST", `${base()}/items`, { token: ownerToken, body: { name: "Bad", unit_price: 1, tax_rate: 101 } })).error).toBe(1066);
		expect((await call("POST", `${base()}/items`, { token: ownerToken, body: { name: "Bad", unit_price: 1, currency: "euro" } })).error).toBe(1037);
	});

	test("lists items by name and finds them by name or SKU", async () => {
		const all = await call("GET", `${base()}/items`, { token: ownerToken });
		expect(all.data.items.map((item: any) => item.name)).toEqual(["Consulting hour", "Widget"]);
		expect(all.data.total).toBe(2);

		const bySku = await call("GET", `${base()}/items?search=wid-1`, { token: ownerToken });
		expect(bySku.data.items.map((item: any) => item.uuid)).toEqual([widget]);
	});

	test("updates only the fields given", async () => {
		const res = await call("PATCH", `${base()}/items/${widget}`, { token: ownerToken, body: { unit_price: 1500, sku: "" } });

		expect(res.data.unit_price).toBe(1500);
		expect(res.data.sku).toBeNull();
		expect(res.data.name).toBe("Widget");
		expect(res.data.tax_rate).toBe(22);
	});

	test("is readable but not writable by a viewer", async () => {
		expect((await call("GET", `${base()}/items`, { token: viewerToken })).error).toBe(0);
		expect((await call("POST", `${base()}/items`, { token: viewerToken, body: { name: "Nope", unit_price: 1 } })).error).toBe(9999);
		expect((await call("DELETE", `${base()}/items/${widget}`, { token: viewerToken })).error).toBe(9999);
	});

	test("does not leak into another project", async () => {
		expect((await call("GET", `/api/v1/projects/${otherProjectUuid}/items/${widget}`, { token: ownerToken })).error).toBe(1065);
	});
});

describe("an invoice line from the catalog", () => {
	test("keeps its link to the item", async () => {
		const created = await invoiceWith([
			{ description: "Widget", quantity: 2, unit_price: 1500, tax_rate: 22, item: widget },
			{ description: "Delivery", quantity: 1, unit_price: 500 },
		]);

		expect(created.error).toBe(0);
		expect(created.data.items[0].item).toBe(widget);
		expect(created.data.items[1].item).toBeNull();
	});

	test("is refused when the item belongs to another project", async () => {
		const foreign = await call("POST", `/api/v1/projects/${otherProjectUuid}/items`, { token: ownerToken, body: { name: "Foreign", unit_price: 1 } });
		const res = await invoiceWith([{ description: "Foreign", quantity: 1, unit_price: 1, item: foreign.data.uuid }]);

		expect(res.error).toBe(1065);
	});

	test("is refused when the link is not an id", async () => {
		expect((await invoiceWith([{ description: "Widget", quantity: 1, unit_price: 1, item: "widget" }])).error).toBe(1038);
	});

	test("survives editing a draft without new items", async () => {
		const created = await invoiceWith([{ description: "Widget", quantity: 1, unit_price: 1500, item: widget }]);
		const updated = await call("PATCH", `${base()}/invoices/${created.data.uuid}`, { token: ownerToken, body: { notes: "Thanks" } });

		expect(updated.data.items[0].item).toBe(widget);
	});

	test("stops the item from being deleted, but it can still be archived", async () => {
		expect((await call("DELETE", `${base()}/items/${widget}`, { token: ownerToken })).error).toBe(1067);

		const archived = await call("PATCH", `${base()}/items/${widget}`, { token: ownerToken, body: { archived: true } });
		expect(archived.data.archived).toBe(true);

		const active = await call("GET", `${base()}/items`, { token: ownerToken });
		expect(active.data.items.map((item: any) => item.uuid)).not.toContain(widget);

		const shelved = await call("GET", `${base()}/items?archived=1`, { token: ownerToken });
		expect(shelved.data.items.map((item: any) => item.uuid)).toEqual([widget]);

		await call("PATCH", `${base()}/items/${widget}`, { token: ownerToken, body: { archived: false } });
	});

	test("an unused item can be deleted", async () => {
		const spare = await call("POST", `${base()}/items`, { token: ownerToken, body: { name: "Spare", unit_price: 1 } });

		expect((await call("DELETE", `${base()}/items/${spare.data.uuid}`, { token: ownerToken })).error).toBe(0);
		expect((await call("GET", `${base()}/items/${spare.data.uuid}`, { token: ownerToken })).error).toBe(1065);
	});
});

describe("item sales statistics", () => {
	let statsProject = "";
	let lamp = "";
	let cable = "";
	const statsBase = () => `/api/v1/projects/${statsProject}`;

	beforeAll(async () => {
		statsProject = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "item-stats", currency: "EUR" } })).data.uuid;
		lamp = (await call("POST", `${statsBase()}/items`, { token: ownerToken, body: { name: "Lamp", unit_price: 4000 } })).data.uuid;
		cable = (await call("POST", `${statsBase()}/items`, { token: ownerToken, body: { name: "Cable", unit_price: 500 } })).data.uuid;
		await call("POST", `${statsBase()}/items`, { token: ownerToken, body: { name: "Never sold", unit_price: 1 } });

		const create = async (items: unknown[], currency = "EUR") =>
			(await call("POST", `${statsBase()}/invoices`, { token: ownerToken, body: { currency, due_date: Date.now() + 86400000, items } })).data.uuid as string;

		const pay = async (invoiceId: string) => {
			await call("POST", `${statsBase()}/invoices/${invoiceId}/open`, { token: ownerToken });
			const invoice = await call("GET", `${statsBase()}/invoices/${invoiceId}`, { token: ownerToken });
			await call("POST", `${statsBase()}/transactions`, {
				token: ownerToken,
				body: { invoice: invoiceId, processor: "bank_transfer", amount: invoice.data.total_amount },
			});
		};

		await pay(
			await create([
				{ description: "Lamp", quantity: 2, unit_price: 4000, tax_rate: 22, item: lamp },
				{ description: "Cable", quantity: 3, unit_price: 500, item: cable },
			])
		);
		await pay(await create([{ description: "Lamp", quantity: 1, unit_price: 3500, item: lamp }]));
		await pay(await create([{ description: "Lamp", quantity: 1, unit_price: 45, item: lamp }], "USD"));

		const pending = await create([{ description: "Cable", quantity: 4, unit_price: 500, item: cable }]);
		await call("POST", `${statsBase()}/invoices/${pending}/open`, { token: ownerToken });

		await create([{ description: "Lamp", quantity: 10, unit_price: 4000, item: lamp }]);
	});

	test("counts paid quantities and revenue per item and currency", async () => {
		const res = await call("POST", `${statsBase()}/items/stats`, { token: ownerToken });
		const rows = res.data.items;

		const lampEur = rows.find((row: any) => row.item === lamp && row.currency === "EUR");
		expect(lampEur.sold_quantity).toBe(3);
		expect(lampEur.sold_amount).toBe(11500);
		expect(lampEur.sold_invoices).toBe(2);
		expect(lampEur.pending_quantity).toBe(0);

		const lampUsd = rows.find((row: any) => row.item === lamp && row.currency === "USD");
		expect(lampUsd.sold_quantity).toBe(1);
		expect(lampUsd.sold_amount).toBe(45);
	});

	test("keeps issued but unpaid lines apart and ignores drafts", async () => {
		const res = await call("POST", `${statsBase()}/items/stats`, { token: ownerToken });
		const cableRow = res.data.items.find((row: any) => row.item === cable);

		expect(cableRow.sold_quantity).toBe(3);
		expect(cableRow.sold_amount).toBe(1500);
		expect(cableRow.pending_quantity).toBe(4);
		expect(cableRow.pending_amount).toBe(2000);
		expect(res.data.items.some((row: any) => row.name === "Never sold")).toBe(false);
	});

	test("totals revenue per currency, best seller first", async () => {
		const res = await call("POST", `${statsBase()}/items/stats`, { token: ownerToken });

		expect(res.data.items[0].item).toBe(lamp);
		expect(res.data.totals).toEqual([
			{ currency: "EUR", sold_amount: 13000, pending_amount: 2000 },
			{ currency: "USD", sold_amount: 45, pending_amount: 0 },
		]);
	});

	test("only counts invoices raised in the chosen period", async () => {
		const future = Date.now() + 60 * 60 * 1000;
		const res = await call("POST", `${statsBase()}/items/stats?from=${future}`, { token: ownerToken });

		expect(res.data.items).toEqual([]);
		expect(res.data.totals).toEqual([]);
	});

	test("refuses a period that does not make sense", async () => {
		expect((await call("POST", `${statsBase()}/items/stats?from=10&to=5`, { token: ownerToken })).error).toBe(1001);
		expect((await call("POST", `${statsBase()}/items/stats?from=soon`, { token: ownerToken })).error).toBe(1001);
	});

	test("is open to a viewer, who can see reports", async () => {
		await call("POST", `${statsBase()}/members`, { token: ownerToken, body: { email: "item-viewer@example.com", role: "viewer" } });
		expect((await call("POST", `${statsBase()}/items/stats`, { token: viewerToken })).error).toBe(0);
	});
});
