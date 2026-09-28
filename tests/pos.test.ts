import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.pos.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { createSchema } = await import("../server/database/schema");
const { default: Cache } = await import("../server/cache");
const { priceSale, summarizeSales, cashNote, isSaleLines } = await import("../server/pos-sale");
const { ErrorCode } = await import("../server/errors");
const { setFursEndpoint } = await import("../server/furs/client");
const { enableFiscalVerification, startFursMock } = await import("./furs-mock");

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

async function account(name: string): Promise<string> {
	await call("POST", "/api/v1/auth/register", { body: { username: name, email: `${name}@example.com`, password: password(name) } });
	return (await call("POST", "/api/v1/auth/login", { body: { username: name, password: password(name) } })).data.token;
}

let ownerToken = "";
let cashierToken = "";
let otherCashierToken = "";
let managerToken = "";
let projectUuid = "";
let coffeeUuid = "";
let croissantUuid = "";
let dollarItemUuid = "";
let furs: Awaited<ReturnType<typeof startFursMock>>;

const base = () => `/api/v1/projects/${projectUuid}`;
const sell = (token: string, body: unknown) => call("POST", `${base()}/pos/sales`, { token, body });

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();
	furs = await startFursMock();
	setFursEndpoint("test", furs.endpoint);

	ownerToken = await account("pos-owner");
	cashierToken = await account("pos-cashier");
	otherCashierToken = await account("pos-cashier-two");
	managerToken = await account("pos-manager");

	projectUuid = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "pos-cafe", currency: "EUR" } })).data.uuid;
	await call("PATCH", base(), { token: ownerToken, body: { tax_country: "SI", vat_status: "registered" } });
	await call("PUT", `${base()}/company`, {
		token: ownerToken,
		body: {
			legal_name: "POS Cafe d.o.o.",
			address_line1: "Dunajska cesta 1",
			postal_code: "1000",
			city: "Ljubljana",
			country: "SI",
			vat_number: "SI12345678",
		},
	});

	await enableFiscalVerification(call, ownerToken, base());

	for (const [email, role] of [
		["pos-cashier@example.com", "cashier"],
		["pos-cashier-two@example.com", "cashier"],
		["pos-manager@example.com", "manager"],
	]) {
		const invited = await call("POST", `${base()}/members`, { token: ownerToken, body: { email, role } });
		if (invited.error !== 0) throw new Error(invited.info);
	}

	const item = async (body: Record<string, unknown>) => (await call("POST", `${base()}/items`, { token: ownerToken, body })).data.uuid as string;
	coffeeUuid = await item({ name: "Coffee", unit_price: 250, currency: "EUR", tax_rate: 22, supply_type: "services", tax_category: "standard" });
	croissantUuid = await item({ name: "Croissant", unit_price: 280, currency: "EUR", tax_rate: 9.5, supply_type: "goods", tax_category: "reduced" });
	dollarItemUuid = await item({ name: "Import", unit_price: 1000, currency: "USD", tax_rate: 22, supply_type: "goods", tax_category: "standard" });
});

afterAll(async () => {
	setFursEndpoint("test", null);
	furs.stop();
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.pos.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("cashier role", () => {
	test("sees the project with terminal permissions only", async () => {
		const res = await call("GET", base(), { token: cashierToken });
		expect(res.data.role).toBe("cashier");
		expect(res.data.permissions.sort()).toEqual(["item.view", "pos.sell", "project.view"]);
		expect(res.data.stats).toBeUndefined();
		expect(res.data.pos_custom_amounts).toBe(true);
	});

	test("cannot reach invoices, customers or payments", async () => {
		expect((await call("GET", `${base()}/invoices`, { token: cashierToken })).error).toBe(9999);
		expect((await call("GET", `${base()}/customers`, { token: cashierToken })).error).toBe(9999);
		expect((await call("GET", `${base()}/transactions`, { token: cashierToken })).error).toBe(9999);
		expect((await call("POST", `${base()}/invoices`, { token: cashierToken, body: {} })).error).toBe(9999);
	});

	test("can list saved items", async () => {
		const res = await call("GET", `${base()}/items`, { token: cashierToken });
		expect(res.data.items.length).toBe(3);
	});

	test("a viewer cannot sell", async () => {
		const viewer = await account("pos-viewer");
		await call("POST", `${base()}/members`, { token: ownerToken, body: { email: "pos-viewer@example.com", role: "viewer" } });
		expect((await sell(viewer, { lines: [{ item: coffeeUuid }] })).error).toBe(9999);
	});
});

describe("selling", () => {
	test("prices saved items on the server and applies their VAT", async () => {
		const res = await sell(cashierToken, {
			lines: [
				{ item: coffeeUuid, quantity: 2, unit_price: 1 },
				{ item: croissantUuid, quantity: 1 },
			],
		});
		expect(res.status).toBe(201);
		expect(res.data.source).toBe("pos");
		expect(res.data.created_by).toBe("pos-cashier");
		expect(res.data.status).toBe("open");
		expect(res.data.issued_at).not.toBeNull();
		expect(res.data.items.map((item: any) => [item.unit_price, item.tax_rate, item.tax_treatment])).toEqual([
			[250, 22, "domestic"],
			[280, 9.5, "domestic"],
		]);
		expect(res.data.total_amount).toBe(610 + 307);
	});

	test("carries the catalog item's unit of measure onto the sale line", async () => {
		const coffeeBeans = (
			await call("POST", `${base()}/items`, {
				token: ownerToken,
				body: { name: "Coffee beans", unit_price: 1800, currency: "EUR", tax_rate: 9.5, supply_type: "goods", tax_category: "reduced", unit: "KGM" },
			})
		).data.uuid as string;
		const res = await sell(cashierToken, {
			lines: [
				{ item: coffeeBeans, quantity: 2 },
				{ item: croissantUuid, quantity: 1 },
			],
		});

		expect(res.status).toBe(201);
		expect(res.data.items.map((line: any) => line.unit)).toEqual(["KGM", null]);
	});

	test("treats a custom amount as the price including VAT", async () => {
		const res = await sell(cashierToken, { lines: [{ amount: 450, description: "Flowers" }] });
		expect(res.data.total_amount).toBe(450);
		expect(res.data.items[0].description).toBe("Flowers");
		expect(res.data.items[0].tax_rate).toBe(22);
	});

	test("converts an item priced in another currency or refuses without a rate", async () => {
		const res = await sell(cashierToken, { lines: [{ item: dollarItemUuid }] });
		expect(res.error).toBe(ErrorCode.RATE_UNAVAILABLE);
	});

	test("rejects malformed sales", async () => {
		expect((await sell(cashierToken, { lines: [] })).error).toBe(1078);
		expect((await sell(cashierToken, { lines: [{ item: coffeeUuid, amount: 100 }] })).error).toBe(1078);
		expect((await sell(cashierToken, { lines: [{ item: coffeeUuid, quantity: 1.5 }] })).error).toBe(1078);
		expect((await sell(cashierToken, { lines: [{ amount: 0 }] })).error).toBe(1078);
		expect((await sell(cashierToken, { lines: [{ item: crypto.randomUUID() }] })).error).toBe(ErrorCode.ITEM_NOT_FOUND);
		expect((await sell(cashierToken, { currency: "euro", lines: [{ item: coffeeUuid }] })).error).toBe(ErrorCode.INVALID_CURRENCY);
	});

	test("refuses an item from another project", async () => {
		const other = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "pos-other" } })).data.uuid;
		const foreign = (
			await call("POST", `/api/v1/projects/${other}/items`, {
				token: ownerToken,
				body: { name: "Foreign", unit_price: 100, currency: "EUR", tax_rate: 0 },
			})
		).data.uuid;
		expect((await sell(cashierToken, { lines: [{ item: foreign }] })).error).toBe(ErrorCode.ITEM_NOT_FOUND);
	});
});

describe("custom amount setting", () => {
	test("only owners and admins can change it", async () => {
		expect((await call("PATCH", base(), { token: managerToken, body: { pos_custom_amounts: false } })).error).toBe(9999);
		expect((await call("PATCH", base(), { token: ownerToken, body: { pos_custom_amounts: "no" } })).error).toBe(1001);

		const res = await call("PATCH", base(), { token: ownerToken, body: { pos_custom_amounts: false } });
		expect(res.data.pos_custom_amounts).toBe(false);
	});

	test("blocks custom amounts for cashiers once turned off", async () => {
		expect((await sell(cashierToken, { lines: [{ amount: 500 }] })).error).toBe(1079);
		expect((await sell(cashierToken, { lines: [{ item: coffeeUuid }] })).error).toBe(0);
	});

	test("still lets managers and owners type an amount", async () => {
		expect((await sell(managerToken, { lines: [{ amount: 500 }] })).error).toBe(0);
		expect((await sell(ownerToken, { lines: [{ amount: 500 }] })).error).toBe(0);
	});

	test("can be turned back on", async () => {
		await call("PATCH", base(), { token: ownerToken, body: { pos_custom_amounts: true } });
		expect((await sell(cashierToken, { lines: [{ amount: 500 }] })).error).toBe(0);
	});
});

describe("own sales only", () => {
	let saleUuid = "";

	beforeAll(async () => {
		saleUuid = (await sell(cashierToken, { lines: [{ item: coffeeUuid }] })).data.uuid;
	});

	test("the seller can open the sale and its receipt", async () => {
		expect((await call("GET", `${base()}/pos/sales/${saleUuid}`, { token: cashierToken })).data.uuid).toBe(saleUuid);
		const receipt = await call("GET", `${base()}/pos/sales/${saleUuid}/document`, { token: cashierToken });
		expect(receipt.data.invoice.total_amount).toBe(305);
		expect(receipt.data.invoice.due_date).toBeNull();
	});

	test("the seller can fetch the receipt as the PDF that gets printed", async () => {
		const pdf = await Server.app.handle(
			new Request(`http://127.0.0.1${base()}/pos/sales/${saleUuid}/pdf`, { headers: { Authorization: `Bearer ${cashierToken}` } })
		);
		expect(pdf.status).toBe(200);
		expect(pdf.headers.get("Content-Type")).toContain("application/pdf");
		expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
	});

	test("another cashier cannot see, pay or cancel it", async () => {
		expect((await call("GET", `${base()}/pos/sales/${saleUuid}`, { token: otherCashierToken })).error).toBe(1080);
		expect((await call("GET", `${base()}/pos/sales/${saleUuid}/document`, { token: otherCashierToken })).error).toBe(1080);
		expect((await call("GET", `${base()}/pos/sales/${saleUuid}/pdf`, { token: otherCashierToken })).error).toBe(1080);
		expect((await call("POST", `${base()}/pos/sales/${saleUuid}/cash`, { token: otherCashierToken, body: {} })).error).toBe(1080);
		expect((await call("POST", `${base()}/pos/sales/${saleUuid}/cancel`, { token: otherCashierToken, body: {} })).error).toBe(1080);
	});

	test("a normal invoice is not reachable through the terminal", async () => {
		const invoice = await call("POST", `${base()}/invoices`, {
			token: ownerToken,
			body: {
				due_date: Date.now() + 86400000,
				supply_date: Date.now(),
				status: "open",
				items: [{ description: "Consulting", quantity: 1, unit_price: 10000, tax_rate: 22 }],
			},
		});
		expect(invoice.data.source).toBe("invoice");
		expect(invoice.data.created_by).toBe("pos-owner");
		expect((await call("GET", `${base()}/pos/sales/${invoice.data.uuid}`, { token: ownerToken })).error).toBe(1080);
		expect((await call("POST", `${base()}/pos/sales/${invoice.data.uuid}/cash`, { token: cashierToken, body: {} })).error).toBe(1080);
	});

	test("a manager can see every sale", async () => {
		expect((await call("GET", `${base()}/pos/sales/${saleUuid}`, { token: managerToken })).data.uuid).toBe(saleUuid);
	});
});

describe("cash and cancel", () => {
	test("records cash with the change in the note", async () => {
		const sale = (await sell(cashierToken, { lines: [{ item: coffeeUuid }] })).data;
		const res = await call("POST", `${base()}/pos/sales/${sale.uuid}/cash`, { token: cashierToken, body: { tendered: 1000 } });
		expect(res.data.status).toBe("paid");

		const [payment] = (await Database`SELECT * FROM transactions WHERE invoice = ${sale.uuid}`) as any[];
		expect(payment.processor).toBe("cash");
		expect(payment.amount).toBe(305);
		expect(JSON.parse(payment.payment_details)).toEqual({ notes: "Cash received 10.00 EUR, change given 6.95 EUR", recorded_by: "pos-cashier" });
	});

	test("takes a part payment in cash", async () => {
		const sale = (await sell(cashierToken, { lines: [{ item: coffeeUuid, quantity: 2 }] })).data;
		const res = await call("POST", `${base()}/pos/sales/${sale.uuid}/cash`, { token: cashierToken, body: { amount: 200 } });
		expect(res.data.status).toBe("partially_paid");
		expect(res.data.paid_amount).toBe(200);
	});

	test("refuses more cash than is owed or less tendered than taken", async () => {
		const sale = (await sell(cashierToken, { lines: [{ item: coffeeUuid }] })).data;
		expect((await call("POST", `${base()}/pos/sales/${sale.uuid}/cash`, { token: cashierToken, body: { amount: 306 } })).error).toBe(1047);
		expect((await call("POST", `${base()}/pos/sales/${sale.uuid}/cash`, { token: cashierToken, body: { amount: 305, tendered: 300 } })).error).toBe(1047);
	});

	test("refuses cash on a paid sale", async () => {
		const sale = (await sell(cashierToken, { lines: [{ item: coffeeUuid }] })).data;
		await call("POST", `${base()}/pos/sales/${sale.uuid}/cash`, { token: cashierToken, body: {} });
		expect((await call("POST", `${base()}/pos/sales/${sale.uuid}/cash`, { token: cashierToken, body: {} })).error).toBe(1050);
	});

	test("a cashier cancels their own unpaid sale with a credit note", async () => {
		const sale = (await sell(cashierToken, { lines: [{ item: coffeeUuid }] })).data;
		const res = await call("POST", `${base()}/pos/sales/${sale.uuid}/cancel`, { token: cashierToken });
		expect(res.data.status).toBe("canceled");
		expect(res.data.credited_amount).toBe(305);
	});

	test("a cashier cannot cancel once money was taken", async () => {
		const sale = (await sell(cashierToken, { lines: [{ item: coffeeUuid, quantity: 2 }] })).data;
		await call("POST", `${base()}/pos/sales/${sale.uuid}/cash`, { token: cashierToken, body: { amount: 100 } });
		expect((await call("POST", `${base()}/pos/sales/${sale.uuid}/cancel`, { token: cashierToken, body: {} })).error).toBe(1081);

		const res = await call("POST", `${base()}/pos/sales/${sale.uuid}/cancel`, { token: managerToken, body: { reason: "Customer changed their mind" } });
		expect(res.data.status).toBe("canceled");
	});

	test("a cashier cannot cancel a sale from an earlier day", async () => {
		const sale = (await sell(cashierToken, { lines: [{ item: coffeeUuid }] })).data;
		await Database`UPDATE invoices SET created = ${Date.now() - 2 * 86400000} WHERE uuid = ${sale.uuid}`;
		expect((await call("POST", `${base()}/pos/sales/${sale.uuid}/cancel`, { token: cashierToken, body: {} })).error).toBe(1081);
	});

	test("a manager can take cash on a cashier's sale", async () => {
		const sale = (await sell(cashierToken, { lines: [{ item: coffeeUuid }] })).data;
		expect((await call("POST", `${base()}/pos/sales/${sale.uuid}/cash`, { token: managerToken, body: {} })).data.status).toBe("paid");
	});
});

describe("sales today", () => {
	test("a cashier only sees their own sales", async () => {
		await sell(otherCashierToken, { lines: [{ item: coffeeUuid }] });

		const mine = await call("GET", `${base()}/pos/sales?scope=all`, { token: cashierToken });
		expect(mine.data.scope).toBe("mine");
		expect(mine.data.sales.every((sale: any) => sale.created_by === "pos-cashier")).toBe(true);

		const theirs = await call("GET", `${base()}/pos/sales`, { token: otherCashierToken });
		expect(theirs.data.sales).toHaveLength(1);
		expect(theirs.data.summary).toEqual([{ currency: "EUR", sales: 1, canceled: 0, total: 305, received: 0, cash: 0, other: 0, outstanding: 305 }]);
	});

	test("a manager can see everyone", async () => {
		const all = await call("GET", `${base()}/pos/sales?scope=all`, { token: managerToken });
		expect(all.data.scope).toBe("all");
		const sellers = new Set(all.data.sales.map((sale: any) => sale.created_by));
		expect(sellers.has("pos-cashier")).toBe(true);
		expect(sellers.has("pos-cashier-two")).toBe(true);
	});

	test("adds up cash for the day", async () => {
		const mine = await call("GET", `${base()}/pos/sales`, { token: cashierToken });
		const [eur] = mine.data.summary;
		expect(eur.cash).toBeGreaterThan(0);
		expect(eur.cash).toBe(eur.received);
		expect(eur.canceled).toBeGreaterThan(0);
	});

	test("rejects a bad period", async () => {
		expect((await call("GET", `${base()}/pos/sales?from=10&to=5`, { token: cashierToken })).error).toBe(1073);
	});
});

describe("sale pricing", () => {
	const project = { tax_country: "SI", vat_status: "registered", oss_registered: 0 };
	const pricing = { currency: "EUR", catalog: new Map(), rates: null, allowCustomAmounts: true };

	test("small businesses charge no VAT on custom amounts", () => {
		const lines = priceSale({ ...project, vat_status: "small_business" }, [{ amount: 1000 }], pricing);
		expect(lines).toEqual([
			{ description: "Custom amount", quantity: 1, unit_price: 1000, tax_rate: 0, item: null, tax_treatment: "small_business", gross_amount: 1000 },
		]);
	});

	test("a typed round amount stays exact", async () => {
		const res = await sell(cashierToken, { lines: [{ amount: 1250, quantity: 2 }] });
		expect(res.data.total_amount).toBe(2500);
		expect(res.data.tax_amount).toBe(451);
		expect(res.data.items[0].total_price + res.data.items[0].tax_amount).toBe(2500);
	});

	test("the invoice API refuses VAT inclusive lines", async () => {
		const res = await call("POST", `${base()}/invoices`, {
			token: ownerToken,
			body: { due_date: Date.now() + 86400000, items: [{ description: "X", quantity: 1, unit_price: 100, gross_amount: 5 }] },
		});
		expect(res.error).toBe(1038);
	});

	test("validates line shapes", () => {
		expect(isSaleLines([{ amount: 100, description: "x".repeat(201) }])).toBe(false);
		expect(isSaleLines([{ amount: 100, quantity: 10000 }])).toBe(false);
		expect(isSaleLines(new Array(201).fill({ amount: 1 }))).toBe(false);
		expect(isSaleLines([{ amount: 100, quantity: 3 }])).toBe(true);
	});

	test("writes a cash note only when change was given", () => {
		expect(cashNote(305, null, "EUR")).toBeNull();
		expect(cashNote(305, 305, "EUR")).toBeNull();
		expect(cashNote(1500, 2000, "JPY")).toBe("Cash received 2000 JPY, change given 500 JPY");
	});

	test("summarizes refunds out of the cash total", () => {
		const summary = summarizeSales(
			[{ status: "refunded", currency: "EUR", total_amount: 500, credited_amount: 0, paid_amount: 500, refunded_amount: 500 }],
			[
				{ currency: "EUR", type: "payment", amount: 500 },
				{ currency: "EUR", type: "refund", amount: 500 },
			]
		);
		expect(summary).toEqual([{ currency: "EUR", sales: 1, canceled: 0, total: 500, received: 0, cash: 0, other: 0, outstanding: 0 }]);
	});
});

async function fails(query: PromiseLike<unknown>): Promise<boolean> {
	try {
		await query;
		return false;
	} catch {
		return true;
	}
}

describe("the initial schema", () => {
	test("accepts the cashier role and nothing unknown", async () => {
		const sql = new SQL("sqlite://:memory:");
		await createSchema(sql as never, "sqlite");

		await sql`INSERT INTO accounts(username, email, password, created, updated, accessed) VALUES('old-owner', 'old@example.com', 'x', 1, 1, 1)`;
		await sql`INSERT INTO projects(uuid, name, apikey, apikey2, created, updated, created_by) VALUES('p1', 'old', 'k1', 'k2', 1, 1, 'old-owner')`;
		await sql`INSERT INTO project_members(uuid, project_id, role, created, updated) VALUES('m1', 'p1', 'cashier', 1, 1)`;
		expect(await fails(sql`INSERT INTO project_members(uuid, project_id, role, created, updated) VALUES('m2', 'p1', 'boss', 1, 1)`)).toBe(true);

		const [project] = (await sql`SELECT pos_custom_amounts FROM projects WHERE uuid = 'p1'`) as { pos_custom_amounts: number }[];
		expect(project.pos_custom_amounts).toBe(1);

		await sql.close();
	});
});
