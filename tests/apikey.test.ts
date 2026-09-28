import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.apikey.sqlite`);

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

let sessionToken = "";
let projectUuid = "";
let primaryKey = "";
let secondaryKey = "";
let otherKey = "";

const dueDate = () => Date.now() + 7 * 24 * 60 * 60 * 1000;
const items = [{ description: "Licence", quantity: 2, unit_price: 5000, tax_rate: 20 }];

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	await call("POST", "/api/v1/auth/register", { body: { username: "key-owner", email: "keyowner@example.com", password: password("owner") } });
	sessionToken = (await call("POST", "/api/v1/auth/login", { body: { username: "key-owner", password: password("owner") } })).data.token;

	const project = await call("POST", "/api/v1/projects", { token: sessionToken, body: { name: "key-shop" } });
	projectUuid = project.data.uuid;
	primaryKey = project.data.apikey;
	secondaryKey = project.data.apikey2;

	const other = await call("POST", "/api/v1/projects", { token: sessionToken, body: { name: "key-other-shop" } });
	otherKey = other.data.apikey;
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.apikey.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("api key authentication", () => {
	test("accepts the primary key", async () => {
		const res = await call("GET", "/api/v1/pay/me", { token: primaryKey });
		expect(res.error).toBe(0);
		expect(res.data.project).toBe(projectUuid);
		expect(res.data.key_slot).toBe("primary");
	});

	test("accepts the secondary key", async () => {
		const res = await call("GET", "/api/v1/pay/me", { token: secondaryKey });
		expect(res.data.key_slot).toBe("secondary");
		expect(res.data.project).toBe(projectUuid);
	});

	test("rejects a missing key", async () => {
		expect((await call("GET", "/api/v1/pay/me")).error).toBe(1000);
	});

	test("rejects a malformed key", async () => {
		expect((await call("GET", "/api/v1/pay/me", { token: "too-short" })).error).toBe(1008);
	});

	test("rejects an unknown key of the right shape", async () => {
		expect((await call("GET", "/api/v1/pay/me", { token: "a".repeat(128) })).error).toBe(1008);
	});

	test("rejects a session token", async () => {
		expect((await call("GET", "/api/v1/pay/me", { token: sessionToken })).error).toBe(1008);
	});

	test("rejects an api key on a session route", async () => {
		expect((await call("GET", "/api/v1/auth/me", { token: primaryKey })).error).toBe(1017);
	});

	test("a rotated key stops working and the new one starts", async () => {
		const rotated = await call("POST", `/api/v1/projects/${projectUuid}/keys/rotate`, { token: sessionToken, body: { slot: "secondary" } });

		expect((await call("GET", "/api/v1/pay/me", { token: secondaryKey })).error).toBe(1008);
		expect((await call("GET", "/api/v1/pay/me", { token: rotated.data.key })).error).toBe(0);

		secondaryKey = rotated.data.key;
	});

	test("a key from a deleted project stops working", async () => {
		const throwaway = await call("POST", "/api/v1/projects", { token: sessionToken, body: { name: "key-doomed-shop" } });
		expect((await call("GET", "/api/v1/pay/me", { token: throwaway.data.apikey })).error).toBe(0);

		await call("DELETE", `/api/v1/projects/${throwaway.data.uuid}`, { token: sessionToken });
		expect((await call("GET", "/api/v1/pay/me", { token: throwaway.data.apikey })).error).toBe(1008);
	});
});

describe("api key scope", () => {
	test("cannot reach project management", async () => {
		expect((await call("GET", "/api/v1/projects", { token: primaryKey })).error).toBe(1017);
		expect((await call("GET", `/api/v1/projects/${projectUuid}`, { token: primaryKey })).error).toBe(1017);
	});

	test("cannot read or rotate keys", async () => {
		expect((await call("GET", `/api/v1/projects/${projectUuid}/keys`, { token: primaryKey })).error).toBe(1017);
		expect((await call("POST", `/api/v1/projects/${projectUuid}/keys/rotate`, { token: primaryKey, body: {} })).error).toBe(1017);
	});

	test("cannot reach members or refunds", async () => {
		expect((await call("GET", `/api/v1/projects/${projectUuid}/members`, { token: primaryKey })).error).toBe(1017);
		expect((await call("GET", `/api/v1/projects/${projectUuid}/transactions`, { token: primaryKey })).error).toBe(1017);
	});
});

describe("machine invoices", () => {
	test("creates an issued invoice by default", async () => {
		const res = await call("POST", "/api/v1/pay/invoices", { token: primaryKey, body: { currency: "EUR", due_date: dueDate(), items } });

		expect(res.status).toBe(201);
		expect(res.data.status).toBe("open");
		expect(res.data.subtotal).toBe(10000);
		expect(res.data.tax_amount).toBe(2000);
		expect(res.data.total_amount).toBe(12000);
	});

	test("can still create a draft when asked", async () => {
		const res = await call("POST", "/api/v1/pay/invoices", {
			token: primaryKey,
			body: { currency: "EUR", due_date: dueDate(), items, status: "draft" },
		});
		expect(res.data.status).toBe("draft");
	});

	test("applies the same validation as the dashboard", async () => {
		expect((await call("POST", "/api/v1/pay/invoices", { token: primaryKey, body: { currency: "eur", due_date: dueDate(), items } })).error).toBe(1037);
		expect((await call("POST", "/api/v1/pay/invoices", { token: primaryKey, body: { currency: "EUR", due_date: dueDate(), items: [] } })).error).toBe(1038);
		expect((await call("POST", "/api/v1/pay/invoices", { token: primaryKey, body: { currency: "EUR", items } })).error).toBe(1040);
		expect(
			(
				await call("POST", "/api/v1/pay/invoices", {
					token: primaryKey,
					body: { currency: "EUR", due_date: dueDate(), items: [{ description: "X", quantity: 1, unit_price: 1.5 }] },
				})
			).error
		).toBe(1038);
	});

	test("produces the same totals as the dashboard route", async () => {
		const viaKey = await call("POST", "/api/v1/pay/invoices", { token: primaryKey, body: { currency: "EUR", due_date: dueDate(), items } });
		const viaSession = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: sessionToken,
			body: { currency: "EUR", due_date: dueDate(), items },
		});

		expect(viaKey.data.subtotal).toBe(viaSession.data.subtotal);
		expect(viaKey.data.tax_amount).toBe(viaSession.data.tax_amount);
		expect(viaKey.data.total_amount).toBe(viaSession.data.total_amount);
	});

	test("reports the outstanding amount for polling", async () => {
		const created = await call("POST", "/api/v1/pay/invoices", { token: primaryKey, body: { currency: "EUR", due_date: dueDate(), items } });

		let res = await call("GET", `/api/v1/pay/invoices/${created.data.uuid}`, { token: primaryKey });
		expect(res.data.outstanding).toBe(12000);
		expect(res.data.status).toBe("open");

		await call("POST", `/api/v1/projects/${projectUuid}/transactions`, {
			token: sessionToken,
			body: { invoice: created.data.uuid, processor: "bank_transfer", amount: 5000 },
		});

		res = await call("GET", `/api/v1/pay/invoices/${created.data.uuid}`, { token: primaryKey });
		expect(res.data.outstanding).toBe(7000);
		expect(res.data.status).toBe("partially_paid");
	});

	test("cannot see another project's invoice", async () => {
		const mine = await call("POST", "/api/v1/pay/invoices", { token: primaryKey, body: { currency: "EUR", due_date: dueDate(), items } });

		const res = await call("GET", `/api/v1/pay/invoices/${mine.data.uuid}`, { token: otherKey });
		expect(res.error).toBe(1035);
	});

	test("lists only its own project's invoices", async () => {
		const mine = await call("GET", "/api/v1/pay/invoices", { token: primaryKey });
		const theirs = await call("GET", "/api/v1/pay/invoices", { token: otherKey });

		expect(mine.data.invoices.length).toBeGreaterThan(0);
		expect(theirs.data.invoices).toHaveLength(0);
		for (const invoice of mine.data.invoices) expect(invoice.project).toBe(projectUuid);
	});
});

describe("machine customers", () => {
	test("creates a customer", async () => {
		const res = await call("POST", "/api/v1/pay/customers", {
			token: primaryKey,
			body: {
				email: "buyer@example.com",
				name: "Buyer d.o.o.",
				address_line1: "Trg 1",
				postal_code: "1000",
				city: "Ljubljana",
				country: "SI",
				vat_number: "SI12345678",
				customer_type: "business",
			},
		});

		expect(res.status).toBe(201);
		expect(res.data.email).toBe("buyer@example.com");
		expect(res.data.address_line1).toBe("Trg 1");
		expect(res.data.customer_type).toBe("business");
	});

	test("returns the existing customer instead of failing on a repeat", async () => {
		const first = await call("POST", "/api/v1/pay/customers", { token: primaryKey, body: { email: "repeat@example.com" } });
		const second = await call("POST", "/api/v1/pay/customers", { token: primaryKey, body: { email: "repeat@example.com" } });

		expect(first.status).toBe(201);
		expect(second.status).toBe(200);
		expect(second.data.uuid).toBe(first.data.uuid);
	});

	test("rejects an invalid email", async () => {
		expect((await call("POST", "/api/v1/pay/customers", { token: primaryKey, body: { email: "nope" } })).error).toBe(1009);
	});

	test("an invoice can be attached to a customer created through the key", async () => {
		const customer = await call("POST", "/api/v1/pay/customers", { token: primaryKey, body: { email: "attached@example.com" } });
		const invoice = await call("POST", "/api/v1/pay/invoices", {
			token: primaryKey,
			body: { customer: customer.data.uuid, currency: "EUR", due_date: dueDate(), items },
		});

		expect(invoice.data.customer).toBe(customer.data.uuid);
	});

	test("cannot attach a customer from another project", async () => {
		const customer = await call("POST", "/api/v1/pay/customers", { token: otherKey, body: { email: "outsider@example.com" } });
		const invoice = await call("POST", "/api/v1/pay/invoices", {
			token: primaryKey,
			body: { customer: customer.data.uuid, currency: "EUR", due_date: dueDate(), items },
		});

		expect(invoice.error).toBe(1031);
	});
});

describe("api key audit trail", () => {
	test("records machine created invoices without an account", async () => {
		const [entry] = (await Database`
			SELECT * FROM audit_log WHERE action = 'invoice.created' AND new_value LIKE '%api_key%' ORDER BY created DESC
		`) as any[];

		expect(entry).toBeDefined();
		expect(entry.account).toBeNull();
		expect(entry.project).toBe(projectUuid);
	});
});
