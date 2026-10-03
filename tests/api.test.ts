import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.test.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { default: Vault } = await import("../server/crypto/vault");
const { allocateDiscount, calculateTotals, statusForPayment } = await import("../server/invoicing");

await Server.configure();

const BASE = "http://127.0.0.1";

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
		new Request(`${BASE}${path}`, {
			method,
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		})
	);

	const json = (await res.json()) as { error: number; info: string; data?: unknown };
	return { status: res.status, ...json };
}

let ownerToken = "";
let viewerToken = "";
let outsiderToken = "";
let projectUuid = "";
let customerUuid = "";
let invoiceUuid = "";
let signedInvoiceUuid = "";
const PNG_SIGNATURE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_SIGNATURE_2 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.test.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("database schema", () => {
	test("baseline tables exist", async () => {
		const tables = (await Database`SELECT name FROM sqlite_master WHERE type='table'`) as { name: string }[];
		const names = tables.map((table) => table.name);
		expect(names).toContain("accounts");
		expect(names).toContain("projects");
		expect(names).toContain("customers");
		expect(names).toContain("invoices");
		expect(names).toContain("invoice_items");
		expect(names).toContain("invoice_issue_snapshots");
		expect(names).toContain("invoice_documents");
		expect(names).toContain("credit_note_issue_snapshots");
		expect(names).toContain("credit_note_documents");
		expect(names).toContain("signature_assets");
		expect(names).toContain("project_member_signature_versions");
		expect(names).toContain("invoice_issuer_signature_versions");
		expect(names).not.toContain("project_member_signatures");
		expect(names).not.toContain("invoice_issuer_signatures");
	});

	test("the unused subscription tables are gone", async () => {
		const tables = (await Database`SELECT name FROM sqlite_master WHERE type='table'`) as { name: string }[];
		const names = tables.map((table) => table.name);
		expect(names).not.toContain("subscription_plans");
		expect(names).not.toContain("subscriptions");
		expect(names).not.toContain("subscription_invoices");
		expect(names).toContain("recurring_invoices");
	});

	test("initialization is idempotent", async () => {
		await initializeDatabase();
		const [accounts] = (await Database`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'accounts'`) as { count: number }[];
		expect(accounts.count).toBe(1);
	});
});

describe("invoice totals", () => {
	test("sums line totals and tax", () => {
		const totals = calculateTotals(
			[
				{ description: "Widget", quantity: 2, unit_price: 1000, tax_rate: 20 },
				{ description: "Gadget", quantity: 1, unit_price: 500, tax_rate: 20 },
			],
			0
		);

		expect(totals.subtotal).toBe(2500);
		expect(totals.tax_amount).toBe(500);
		expect(totals.total_amount).toBe(3000);
	});

	test("subtracts the discount before adding tax", () => {
		const totals = calculateTotals([{ description: "Widget", quantity: 1, unit_price: 1000, tax_rate: 10 }], 200);
		expect(totals.discount_amount).toBe(200);
		expect(totals.tax_amount).toBe(80);
		expect(totals.total_amount).toBe(880);
	});

	test("spreads the discount over lines by their value so each rate is taxed on what is charged", () => {
		const totals = calculateTotals(
			[
				{ description: "Book", quantity: 1, unit_price: 3000, tax_rate: 5 },
				{ description: "Service", quantity: 1, unit_price: 7000, tax_rate: 22 },
			],
			1000
		);

		expect(totals.items.map((item) => item.discount_amount)).toEqual([300, 700]);
		expect(totals.items.map((item) => item.tax_amount)).toEqual([135, 1386]);
		expect(totals.total_amount).toBe(9000 + 135 + 1386);
	});

	test("hands out every cent of an uneven discount", () => {
		const shares = allocateDiscount([100, 100, 100], 100);
		expect(shares.reduce((sum, share) => sum + share, 0)).toBe(100);
		expect(shares).toEqual([34, 33, 33]);
		expect(allocateDiscount([0, 0], 50)).toEqual([0, 0]);
		expect(allocateDiscount([500, 0, 1500], 2000)).toEqual([500, 0, 1500]);
	});

	test("never discounts below zero", () => {
		const totals = calculateTotals([{ description: "Widget", quantity: 1, unit_price: 1000 }], 5000);
		expect(totals.discount_amount).toBe(1000);
		expect(totals.total_amount).toBe(0);
	});

	test("rounds fractional quantities to whole minor units", () => {
		const totals = calculateTotals([{ description: "Hours", quantity: 1.5, unit_price: 3333 }], 0);
		expect(totals.subtotal).toBe(5000);
		expect(Number.isInteger(totals.subtotal)).toBe(true);
	});

	test("treats a missing tax rate as zero", () => {
		const totals = calculateTotals([{ description: "Widget", quantity: 1, unit_price: 1000 }], 0);
		expect(totals.tax_amount).toBe(0);
		expect(totals.total_amount).toBe(1000);
	});

	test("derives status from the paid amount", () => {
		const future = Date.now() + 100000;
		const past = Date.now() - 100000;
		expect(statusForPayment(1000, 1000, future, Date.now())).toBe("paid");
		expect(statusForPayment(1000, 400, future, Date.now())).toBe("partially_paid");
		expect(statusForPayment(1000, 0, past, Date.now())).toBe("overdue");
		expect(statusForPayment(1000, 0, future, Date.now())).toBe("open");
	});
});

describe("vault", () => {
	test("round trips a secret", () => {
		const secret = "abandon abandon abandon about";
		expect(Vault.decrypt(Vault.encrypt(secret))).toBe(secret);
	});

	test("rejects a tampered ciphertext", () => {
		const parts = Vault.encrypt("sensitive").split(".");
		parts[3] = parts[3].slice(0, -1) + (parts[3].endsWith("A") ? "B" : "A");
		expect(() => Vault.decrypt(parts.join("."))).toThrow();
	});

	test("produces a different ciphertext each time", () => {
		expect(Vault.encrypt("same")).not.toBe(Vault.encrypt("same"));
	});
});

describe("registration", () => {
	test("creates an account", async () => {
		const res = await call("POST", "/api/v1/auth/register", {
			body: { username: "owner-user", email: "owner@example.com", password: password("owner") },
		});
		expect(res.status).toBe(201);
		expect(res.data.username).toBe("owner-user");
	});

	test("rejects a duplicate username", async () => {
		const res = await call("POST", "/api/v1/auth/register", {
			body: { username: "owner-user", email: "other@example.com", password: password("owner") },
		});
		expect(res.error).toBe(1007);
	});

	test("rejects an invalid username", async () => {
		const res = await call("POST", "/api/v1/auth/register", { body: { username: "X", email: "x@example.com", password: password("x") } });
		expect(res.error).toBe(1003);
	});

	test("rejects an unhashed password", async () => {
		const res = await call("POST", "/api/v1/auth/register", {
			body: { username: "plain-user", email: "plain@example.com", password: "hunter2" },
		});
		expect(res.error).toBe(1004);
	});

	test("never stores the password as supplied", async () => {
		const [row] = (await Database`SELECT password FROM accounts WHERE username = ${"owner-user"}`) as { password: string }[];
		expect(row.password).not.toBe(password("owner"));
		expect(row.password.startsWith("$argon2")).toBe(true);
	});
});

describe("login", () => {
	test("issues a session token", async () => {
		const res = await call("POST", "/api/v1/auth/login", { body: { username: "owner-user", password: password("owner") } });
		expect(res.data.token).toHaveLength(128);
		ownerToken = res.data.token;
	});

	test("rejects a wrong password", async () => {
		const res = await call("POST", "/api/v1/auth/login", { body: { username: "owner-user", password: password("wrong") } });
		expect(res.error).toBe(1014);
	});

	test("reports the same error for an unknown account", async () => {
		const res = await call("POST", "/api/v1/auth/login", { body: { username: "ghost-user", password: password("whatever") } });
		expect(res.error).toBe(1014);
	});

	test("returns the authenticated account", async () => {
		const res = await call("GET", "/api/v1/auth/me", { token: ownerToken });
		expect(res.data.username).toBe("owner-user");
		expect(res.data.projects).toBe(0);
	});

	test("rejects a missing token", async () => {
		expect((await call("GET", "/api/v1/auth/me")).error).toBe(1000);
	});

	test("rejects a malformed token", async () => {
		expect((await call("GET", "/api/v1/auth/me", { token: "short" })).error).toBe(1016);
	});

	test("rejects a well formed but unknown token", async () => {
		expect((await call("GET", "/api/v1/auth/me", { token: "a".repeat(128) })).error).toBe(1017);
	});
});

describe("projects", () => {
	test("creates a project and returns its API keys once", async () => {
		const res = await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "test-shop" } });
		expect(res.status).toBe(201);
		expect(res.data.role).toBe("owner");
		expect(res.data.apikey).toHaveLength(128);
		projectUuid = res.data.uuid;
	});

	test("creates the owner membership alongside the project", async () => {
		const [member] = (await Database`SELECT * FROM project_members WHERE project_id = ${projectUuid}`) as any[];
		expect(member.role).toBe("owner");
		expect(member.account_username).toBe("owner-user");
	});

	test("rejects a duplicate project name for the same owner", async () => {
		const res = await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "test-shop" } });
		expect(res.error).toBe(1005);
	});

	test("lists the caller's projects", async () => {
		const res = await call("GET", "/api/v1/projects", { token: ownerToken });
		expect(res.data).toHaveLength(1);
		expect(res.data[0].role).toBe("owner");
	});

	test("never exposes the seed through the API", async () => {
		const list = await call("GET", "/api/v1/projects", { token: ownerToken });
		const single = await call("GET", `/api/v1/projects/${projectUuid}`, { token: ownerToken });
		expect(JSON.stringify(list.data)).not.toContain("seed");
		expect(JSON.stringify(single.data)).not.toContain("seed");
	});

	test("updates the webhook URL", async () => {
		const res = await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { webhook_url: "https://example.com/hook" } });
		expect(res.data.webhook_url).toBe("https://example.com/hook");
	});

	test("rejects a non http webhook URL", async () => {
		const res = await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { webhook_url: "javascript:alert(1)" } });
		expect(res.error).toBe(1029);
	});

	test("returns 404 for an unknown project", async () => {
		expect((await call("GET", `/api/v1/projects/${crypto.randomUUID()}`, { token: ownerToken })).error).toBe(1019);
	});
});

describe("api keys", () => {
	test("returns masked keys", async () => {
		const res = await call("GET", `/api/v1/projects/${projectUuid}/keys`, { token: ownerToken });
		expect(res.data.primary).toContain("*");
		expect(res.data.primary).not.toHaveLength(128);
	});

	test("rotates only the requested slot", async () => {
		const [before] = (await Database`SELECT apikey, apikey2 FROM projects WHERE uuid = ${projectUuid}`) as any[];

		const res = await call("POST", `/api/v1/projects/${projectUuid}/keys/rotate`, { token: ownerToken, body: { slot: "primary" } });
		expect(res.data.key).toHaveLength(128);

		const [after] = (await Database`SELECT apikey, apikey2 FROM projects WHERE uuid = ${projectUuid}`) as any[];
		expect(after.apikey).toBe(res.data.key);
		expect(after.apikey).not.toBe(before.apikey);
		expect(after.apikey2).toBe(before.apikey2);
	});

	test("keeps rotated keys out of the audit log", async () => {
		const entries = (await Database`SELECT new_value FROM audit_log WHERE action = 'project.apikey.rotated'`) as { new_value: string }[];
		const [project] = (await Database`SELECT apikey FROM projects WHERE uuid = ${projectUuid}`) as { apikey: string }[];
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) expect(entry.new_value).not.toContain(project.apikey);
	});
});

describe("customers", () => {
	test("creates a customer", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/customers`, {
			token: ownerToken,
			body: { name: "Acme Ltd", email: "billing@acme.example", country: "SI", vat_number: "SI12345678" },
		});
		expect(res.status).toBe(201);
		expect(res.data.email).toBe("billing@acme.example");
		expect(res.data.country).toBe("SI");
		customerUuid = res.data.uuid;
	});

	test("rejects a duplicate email in the same project", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/customers`, { token: ownerToken, body: { email: "billing@acme.example" } });
		expect(res.error).toBe(1032);
	});

	test("rejects an invalid country code", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/customers`, {
			token: ownerToken,
			body: { email: "x@acme.example", country: "Slovenia" },
		});
		expect(res.error).toBe(1034);
	});

	test("rejects a two letter code that is not a country", async () => {
		for (const country of ["XX", "si", "EU", "UK"]) {
			const res = await call("POST", `/api/v1/projects/${projectUuid}/customers`, { token: ownerToken, body: { email: "x@acme.example", country } });
			expect(res.error).toBe(1034);
		}
	});

	test("lets a country be cleared", async () => {
		const created = await call("POST", `/api/v1/projects/${projectUuid}/customers`, {
			token: ownerToken,
			body: { email: "nowhere@acme.example", country: "DE" },
		});
		const cleared = await call("PATCH", `/api/v1/projects/${projectUuid}/customers/${created.data.uuid}`, { token: ownerToken, body: { country: null } });

		expect(cleared.data.country).toBeNull();
		await call("DELETE", `/api/v1/projects/${projectUuid}/customers/${created.data.uuid}`, { token: ownerToken });
	});

	test("rejects an invalid email", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/customers`, { token: ownerToken, body: { email: "not-an-email" } });
		expect(res.error).toBe(1009);
	});

	test("stores metadata as JSON and returns it parsed", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/customers`, {
			token: ownerToken,
			body: { email: "meta@acme.example", metadata: { tier: "gold", seats: 4 } },
		});
		expect(res.data.metadata).toEqual({ tier: "gold", seats: 4 });

		await call("DELETE", `/api/v1/projects/${projectUuid}/customers/${res.data.uuid}`, { token: ownerToken });
	});

	test("lists customers with a total", async () => {
		const res = await call("GET", `/api/v1/projects/${projectUuid}/customers`, { token: ownerToken });
		expect(res.data.total).toBe(1);
		expect(res.data.customers).toHaveLength(1);
	});

	test("searches by email and VAT number", async () => {
		const found = await call("GET", `/api/v1/projects/${projectUuid}/customers?search=acme`, { token: ownerToken });
		expect(found.data.customers).toHaveLength(1);
		const foundByVat = await call("GET", `/api/v1/projects/${projectUuid}/customers?search=12345678`, { token: ownerToken });
		expect(foundByVat.data.customers.map((customer: { uuid: string }) => customer.uuid)).toEqual([customerUuid]);

		const missing = await call("GET", `/api/v1/projects/${projectUuid}/customers?search=nothing`, { token: ownerToken });
		expect(missing.data.customers).toHaveLength(0);
	});

	test("updates only the supplied fields", async () => {
		const res = await call("PATCH", `/api/v1/projects/${projectUuid}/customers/${customerUuid}`, {
			token: ownerToken,
			body: { city: "Ljubljana" },
		});
		expect(res.data.city).toBe("Ljubljana");
		expect(res.data.name).toBe("Acme Ltd");
		expect(res.data.email).toBe("billing@acme.example");
	});

	test("returns 404 for an unknown customer", async () => {
		const res = await call("GET", `/api/v1/projects/${projectUuid}/customers/${crypto.randomUUID()}`, { token: ownerToken });
		expect(res.error).toBe(1031);
	});

	test("rejects a malformed customer id", async () => {
		const res = await call("GET", `/api/v1/projects/${projectUuid}/customers/not-a-uuid`, { token: ownerToken });
		expect(res.error).toBe(1033);
	});

	test("does not leak customers across projects", async () => {
		const other = await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "other-shop" } });

		expect((await call("GET", `/api/v1/projects/${other.data.uuid}/customers/${customerUuid}`, { token: ownerToken })).error).toBe(1031);

		const list = await call("GET", `/api/v1/projects/${other.data.uuid}/customers`, { token: ownerToken });
		expect(list.data.total).toBe(0);
	});
});

describe("invoices", () => {
	test("creates a draft invoice with calculated totals", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: {
				customer: customerUuid,
				currency: "EUR",
				due_date: Date.now() + 7 * 24 * 60 * 60 * 1000,
				items: [
					{ description: "Consulting", quantity: 3, unit_price: 10000, tax_rate: 22 },
					{ description: "Hosting", quantity: 1, unit_price: 2500, tax_rate: 22 },
				],
			},
		});

		expect(res.status).toBe(201);
		expect(res.data.status).toBe("draft");
		expect(res.data.subtotal).toBe(32500);
		expect(res.data.tax_amount).toBe(7150);
		expect(res.data.total_amount).toBe(39650);
		expect(res.data.items).toHaveLength(2);
		expect(res.data.reference.startsWith("DRAFT-")).toBe(true);
		invoiceUuid = res.data.uuid;
	});

	test("filters the list, count and totals by customer", async () => {
		await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { currency: "EUR", due_date: Date.now() + 1000, items: [{ description: "Walk in", quantity: 1, unit_price: 500 }] },
		});

		const filtered = await call("GET", `/api/v1/projects/${projectUuid}/invoices?customer=${customerUuid}`, { token: ownerToken });
		expect(filtered.data.invoices).toHaveLength(1);
		expect(filtered.data.total).toBe(1);
		expect(filtered.data.totals).toEqual([{ currency: "EUR", count: 1, total_amount: 39650, paid_amount: 0, outstanding_amount: 0 }]);
		expect(filtered.data.invoices[0].customer_name).toBe("Acme Ltd");

		const all = await call("GET", `/api/v1/projects/${projectUuid}/invoices`, { token: ownerToken });
		expect(all.data.total).toBe(2);
	});

	test("searches invoice references and applies the search to totals", async () => {
		await Database`UPDATE invoices SET reference = 'BANK-001/26' WHERE uuid = ${invoiceUuid}`;
		const found = await call("GET", `/api/v1/projects/${projectUuid}/invoices?reference=${encodeURIComponent("001/26")}`, { token: ownerToken });
		expect(found.data.invoices.map((invoice: any) => invoice.uuid)).toEqual([invoiceUuid]);
		expect(found.data.total).toBe(1);
		expect(found.data.totals).toEqual([{ currency: "EUR", count: 1, total_amount: 39650, paid_amount: 0, outstanding_amount: 0 }]);

		const combined = await call("GET", `/api/v1/projects/${projectUuid}/invoices?reference=001%2F26&status=open`, { token: ownerToken });
		expect(combined.data.invoices).toHaveLength(0);
		expect(combined.data.total).toBe(0);
		expect(combined.data.totals).toEqual([]);
	});

	test("reports customer stats", async () => {
		const res = await call("GET", `/api/v1/projects/${projectUuid}/customers/${customerUuid}`, { token: ownerToken });
		expect(res.data.stats.invoices).toBe(1);
		expect(res.data.stats.drafts).toBe(1);
		expect(res.data.stats.issued).toBe(0);
		expect(res.data.stats.currencies).toEqual([]);
	});

	test("persists line items in order", async () => {
		const items = (await Database`
			SELECT description, sort_order FROM invoice_items WHERE invoice = ${invoiceUuid} ORDER BY sort_order
		`) as any[];
		expect(items.map((item) => item.description)).toEqual(["Consulting", "Hosting"]);
		expect(items.map((item) => item.sort_order)).toEqual([0, 1]);
	});

	test("rejects an invoice with no items", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { currency: "EUR", due_date: Date.now() + 1000, items: [] },
		});
		expect(res.error).toBe(1038);
	});

	test("rejects a fractional unit price", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { currency: "EUR", due_date: Date.now() + 1000, items: [{ description: "X", quantity: 1, unit_price: 10.5 }] },
		});
		expect(res.error).toBe(1038);
	});

	test("rejects a negative unit price", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { currency: "EUR", due_date: Date.now() + 1000, items: [{ description: "X", quantity: 1, unit_price: -100 }] },
		});
		expect(res.error).toBe(1038);
	});

	test("rejects an invalid currency", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { currency: "euro", due_date: Date.now() + 1000, items: [{ description: "X", quantity: 1, unit_price: 100 }] },
		});
		expect(res.error).toBe(1037);
	});

	test("rejects a missing due date", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { currency: "EUR", items: [{ description: "X", quantity: 1, unit_price: 100 }] },
		});
		expect(res.error).toBe(1040);
	});

	test("rejects a customer from another project", async () => {
		const other = await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "third-shop" } });
		const res = await call("POST", `/api/v1/projects/${other.data.uuid}/invoices`, {
			token: ownerToken,
			body: { customer: customerUuid, currency: "EUR", due_date: Date.now() + 1000, items: [{ description: "X", quantity: 1, unit_price: 100 }] },
		});
		expect(res.error).toBe(1031);
	});

	test("recalculates totals when items are edited", async () => {
		const res = await call("PATCH", `/api/v1/projects/${projectUuid}/invoices/${invoiceUuid}`, {
			token: ownerToken,
			body: { items: [{ description: "Consulting", quantity: 1, unit_price: 10000, tax_rate: 22 }] },
		});
		expect(res.data.subtotal).toBe(10000);
		expect(res.data.tax_amount).toBe(2200);
		expect(res.data.total_amount).toBe(12200);
		expect(res.data.items).toHaveLength(1);
	});

	test("replaces rather than appends line items", async () => {
		const [items] = (await Database`SELECT COUNT(*) AS count FROM invoice_items WHERE invoice = ${invoiceUuid}`) as { count: number }[];
		expect(items.count).toBe(1);
	});

	test("keeps unspecified fields on edit", async () => {
		const res = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoiceUuid}`, { token: ownerToken });
		expect(res.data.currency).toBe("EUR");
		expect(res.data.customer).toBe(customerUuid);
	});

	test("opens a draft invoice", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/invoices/${invoiceUuid}/open`, { token: ownerToken });

		expect(res.data.status).toBe("open");
		expect(res.data.reference).toMatch(/^[0-9]{12}$/);
	});

	test("refuses to edit an invoice once open", async () => {
		const res = await call("PATCH", `/api/v1/projects/${projectUuid}/invoices/${invoiceUuid}`, { token: ownerToken, body: { notes: "too late" } });
		expect(res.error).toBe(1041);
	});

	test("refuses to delete an invoice once open", async () => {
		const res = await call("DELETE", `/api/v1/projects/${projectUuid}/invoices/${invoiceUuid}`, { token: ownerToken });
		expect(res.error).toBe(1041);
	});

	test("refuses to open the same invoice twice", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/invoices/${invoiceUuid}/open`, { token: ownerToken });
		expect(res.error).toBe(1044);
	});

	test("opens an overdue invoice as overdue", async () => {
		const created = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { currency: "EUR", due_date: Date.now() - 1000, items: [{ description: "Late", quantity: 1, unit_price: 100 }] },
		});
		const opened = await call("POST", `/api/v1/projects/${projectUuid}/invoices/${created.data.uuid}/open`, { token: ownerToken });
		expect(opened.data.status).toBe("overdue");
	});

	test("cancels an open invoice", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/invoices/${invoiceUuid}/cancel`, { token: ownerToken });
		expect(res.data.status).toBe("canceled");
		expect(res.data.canceled_date).toBeGreaterThan(0);
	});

	test("refuses to cancel twice", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/invoices/${invoiceUuid}/cancel`, { token: ownerToken });
		expect(res.error).toBe(1042);
	});

	test("deletes a draft invoice and its items", async () => {
		const created = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { currency: "EUR", due_date: Date.now() + 1000, items: [{ description: "Scratch", quantity: 1, unit_price: 100 }] },
		});

		expect((await call("DELETE", `/api/v1/projects/${projectUuid}/invoices/${created.data.uuid}`, { token: ownerToken })).error).toBe(0);

		const [items] = (await Database`SELECT COUNT(*) AS count FROM invoice_items WHERE invoice = ${created.data.uuid}`) as { count: number }[];
		expect(items.count).toBe(0);
	});

	test("filters by status", async () => {
		const canceled = await call("GET", `/api/v1/projects/${projectUuid}/invoices?status=canceled`, { token: ownerToken });
		expect(canceled.data.invoices.length).toBeGreaterThan(0);
		expect(canceled.data.invoices.every((invoice: any) => invoice.status === "canceled")).toBe(true);
	});

	test("filters by customer", async () => {
		const res = await call("GET", `/api/v1/projects/${projectUuid}/invoices?customer=${customerUuid}`, { token: ownerToken });
		expect(res.data.invoices.every((invoice: any) => invoice.customer === customerUuid)).toBe(true);
	});

	test("refuses to delete a customer that has invoices", async () => {
		const res = await call("DELETE", `/api/v1/projects/${projectUuid}/customers/${customerUuid}`, { token: ownerToken });
		expect(res.error).toBe(1045);
	});

	test("previews an unsaved invoice as a PDF without saving it", async () => {
		const preview = async (body: unknown) => {
			const res = await Server.app.handle(
				new Request(`http://127.0.0.1/api/v1/projects/${projectUuid}/invoices/preview`, {
					method: "POST",
					headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
					body: JSON.stringify(body),
				})
			);
			return { type: res.headers.get("Content-Type"), start: new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()).slice(0, 5)) };
		};
		const body = {
			customer: customerUuid,
			currency: "EUR",
			due_date: Date.now() + 7 * 24 * 60 * 60 * 1000,
			items: [{ description: "Consulting", quantity: 3, unit_price: 10000, tax_rate: 22 }],
		};
		const [before] = (await Database`SELECT COUNT(*) AS count FROM invoices`) as { count: number }[];

		expect(await preview(body)).toEqual({ type: "application/pdf", start: "%PDF-" });

		const draft = (await call("POST", `/api/v1/projects/${projectUuid}/invoices`, { token: ownerToken, body })).data;
		expect(await preview({ ...body, invoice: draft.uuid, notes: "Changed in the form" })).toEqual({ type: "application/pdf", start: "%PDF-" });
		const unchanged = (await call("GET", `/api/v1/projects/${projectUuid}/invoices/${draft.uuid}`, { token: ownerToken })).data;
		expect(unchanged.notes).toBeNull();

		const [after] = (await Database`SELECT COUNT(*) AS count FROM invoices`) as { count: number }[];
		expect(Number(after.count)).toBe(Number(before.count) + 1);

		const noItems = await call("POST", `/api/v1/projects/${projectUuid}/invoices/preview`, { token: ownerToken, body: { ...body, items: [] } });
		expect(noItems.error).not.toBe(0);
		const unknown = await call("POST", `/api/v1/projects/${projectUuid}/invoices/preview`, {
			token: ownerToken,
			body: { ...body, invoice: crypto.randomUUID() },
		});
		expect(unknown.error).toBe(1035);
	});

	test("an unsaved invoice document carries the form values and totals", async () => {
		const { unsavedInvoiceDocument } = await import("../server/unsaved-invoice");
		const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${projectUuid}`) as any[];
		const issued = Date.now();
		const document = await unsavedInvoiceDocument(project, {
			customer: customerUuid,
			currency: "EUR",
			items: [{ description: "Consulting", quantity: 3, unit_price: 10000, tax_rate: 22 }],
			discount_amount: 0,
			notes: "Thank you",
			issued,
			due_date: issued + 86400000,
			supply_date: issued,
			created_by: null,
		});

		expect(document.invoice.status).toBe("draft");
		expect(document.invoice.reference.startsWith("DRAFT-")).toBe(true);
		expect(document.invoice.total_amount).toBe(36600);
		expect(document.invoice.notes).toBe("Thank you");
		expect(document.invoice.issued).toBe(issued);
		expect(document.buyer?.name).toBe("Acme Ltd");
		expect(document.items).toHaveLength(1);
	});
});

describe("members and permissions", () => {
	beforeAll(async () => {
		await call("POST", "/api/v1/auth/register", {
			body: { username: "viewer-user", email: "viewer@example.com", password: password("viewer") },
		});
		viewerToken = (await call("POST", "/api/v1/auth/login", { body: { username: "viewer-user", password: password("viewer") } })).data.token;

		await call("POST", "/api/v1/auth/register", {
			body: { username: "outsider-user", email: "outsider@example.com", password: password("outsider") },
		});
		outsiderToken = (await call("POST", "/api/v1/auth/login", { body: { username: "outsider-user", password: password("outsider") } })).data.token;

		await call("POST", `/api/v1/projects/${projectUuid}/members`, { token: ownerToken, body: { email: "viewer@example.com", role: "viewer" } });
	});

	test("a non member cannot see the project", async () => {
		expect((await call("GET", `/api/v1/projects/${projectUuid}`, { token: outsiderToken })).error).toBe(1020);
	});

	test("a non member cannot list customers", async () => {
		expect((await call("GET", `/api/v1/projects/${projectUuid}/customers`, { token: outsiderToken })).error).toBe(1020);
	});

	test("a non member cannot list invoices", async () => {
		expect((await call("GET", `/api/v1/projects/${projectUuid}/invoices`, { token: outsiderToken })).error).toBe(1020);
	});

	test("invites an unregistered address as pending", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/members`, {
			token: ownerToken,
			body: { email: "future@example.com", role: "developer" },
		});
		expect(res.data.status).toBe("pending");
		expect(res.data.invitation_token).toHaveLength(64);
	});

	test("rejects a duplicate invitation", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/members`, {
			token: ownerToken,
			body: { email: "viewer@example.com", role: "viewer" },
		});
		expect(res.error).toBe(1022);
	});

	test("rejects an unknown role", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/members`, {
			token: ownerToken,
			body: { email: "someone@example.com", role: "superuser" },
		});
		expect(res.error).toBe(1023);
	});

	test("a viewer can read the project, its customers and its invoices", async () => {
		expect((await call("GET", `/api/v1/projects/${projectUuid}`, { token: viewerToken })).error).toBe(0);
		expect((await call("GET", `/api/v1/projects/${projectUuid}/customers`, { token: viewerToken })).error).toBe(0);
		expect((await call("GET", `/api/v1/projects/${projectUuid}/invoices`, { token: viewerToken })).error).toBe(0);
	});

	test("a viewer cannot create a customer", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/customers`, { token: viewerToken, body: { email: "nope@example.com" } });
		expect(res.error).toBe(9999);
	});

	test("a viewer cannot create an invoice", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: viewerToken,
			body: { currency: "EUR", due_date: Date.now() + 1000, items: [{ description: "X", quantity: 1, unit_price: 100 }] },
		});
		expect(res.error).toBe(9999);
	});

	test("a viewer cannot read API keys", async () => {
		expect((await call("GET", `/api/v1/projects/${projectUuid}/keys`, { token: viewerToken })).error).toBe(9999);
	});

	test("an accountant can view invoices but not create them", async () => {
		const members = await call("GET", `/api/v1/projects/${projectUuid}/members`, { token: ownerToken });
		const viewer = members.data.find((member: any) => member.account_username === "viewer-user");

		await call("PATCH", `/api/v1/projects/${projectUuid}/members/${viewer.uuid}`, { token: ownerToken, body: { role: "accountant" } });

		expect((await call("GET", `/api/v1/projects/${projectUuid}/invoices`, { token: viewerToken })).error).toBe(0);

		const create = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: viewerToken,
			body: { currency: "EUR", due_date: Date.now() + 1000, items: [{ description: "X", quantity: 1, unit_price: 100 }] },
		});
		expect(create.error).toBe(9999);
	});

	test("a manager can create invoices", async () => {
		const members = await call("GET", `/api/v1/projects/${projectUuid}/members`, { token: ownerToken });
		const viewer = members.data.find((member: any) => member.account_username === "viewer-user");

		await call("PATCH", `/api/v1/projects/${projectUuid}/members/${viewer.uuid}`, { token: ownerToken, body: { role: "manager" } });

		const create = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: viewerToken,
			body: { currency: "EUR", due_date: Date.now() + 1000, items: [{ description: "Managed", quantity: 1, unit_price: 100 }] },
		});
		expect(create.error).toBe(0);
	});

	test("an owner cannot remove their own membership", async () => {
		const members = await call("GET", `/api/v1/projects/${projectUuid}/members`, { token: ownerToken });
		const own = members.data.find((member: any) => member.account_username === "owner-user");

		expect((await call("DELETE", `/api/v1/projects/${projectUuid}/members/${own.uuid}`, { token: ownerToken })).error).toBe(1025);
	});

	test("members save their own full name and drawn signature", async () => {
		const saved = await call("PUT", `/api/v1/projects/${projectUuid}/member-profile`, {
			token: ownerToken,
			body: { full_name: "Owner Person", signature: PNG_SIGNATURE },
		});
		expect(saved.error).toBe(0);
		expect(saved.data.full_name).toBe("Owner Person");

		const profile = await call("GET", `/api/v1/projects/${projectUuid}/member-profile`, { token: ownerToken });
		expect(profile.data).toEqual({ full_name: "Owner Person", signature: PNG_SIGNATURE });

		const members = await call("GET", `/api/v1/projects/${projectUuid}/members`, { token: ownerToken });
		const owner = members.data.find((member: any) => member.account_username === "owner-user");
		expect(owner.full_name).toBe("Owner Person");
		expect(owner.has_signature).toBe(true);
		expect(JSON.stringify(owner)).not.toContain(PNG_SIGNATURE);
	});

	test("an issued invoice keeps the issuer name and signature snapshot", async () => {
		const created = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { due_date: Date.now() + 86_400_000, items: [{ description: "Signed work", quantity: 1, unit_price: 1000, tax_rate: 22 }] },
		});
		signedInvoiceUuid = created.data.uuid;
		const draftDocument = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${created.data.uuid}/document`, { token: ownerToken });
		expect(draftDocument.data.issuer).toEqual({ name: "Owner Person", signature: `data:image/png;base64,${PNG_SIGNATURE}` });

		expect((await call("POST", `/api/v1/projects/${projectUuid}/invoices/${created.data.uuid}/open`, { token: ownerToken })).error).toBe(0);
		await call("PUT", `/api/v1/projects/${projectUuid}/member-profile`, { token: ownerToken, body: { full_name: "Changed Later", signature: null } });

		const issuedDocument = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${created.data.uuid}/document`, { token: ownerToken });
		expect(issuedDocument.data.issuer).toEqual({ name: "Owner Person", signature: `data:image/png;base64,${PNG_SIGNATURE}` });

		const hidden = await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { invoice_issuer_details: false } });
		expect(hidden.data.invoice_issuer_details).toBe(false);
		expect((await call("GET", `/api/v1/projects/${projectUuid}/invoices/${created.data.uuid}/document`, { token: ownerToken })).data.issuer).toEqual({
			name: "Owner Person",
			signature: `data:image/png;base64,${PNG_SIGNATURE}`,
		});
		expect(
			(await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { invoice_issuer_details: true } })).data.invoice_issuer_details
		).toBe(true);

		const pdf = await Server.app.handle(
			new Request(`${BASE}/api/v1/projects/${projectUuid}/invoices/${created.data.uuid}/pdf`, { headers: { Authorization: `Bearer ${ownerToken}` } })
		);
		expect(pdf.status).toBe(200);
		expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
		expect((await pdf.arrayBuffer()).byteLength).toBeGreaterThan(1000);
	});

	test("signature images are deduplicated while invoices retain exact versions", async () => {
		const [before] = (await Database`SELECT COUNT(*) AS count FROM signature_assets`) as { count: number }[];
		expect(before.count).toBe(1);

		expect(
			(
				await call("PUT", `/api/v1/projects/${projectUuid}/member-profile`, {
					token: ownerToken,
					body: { full_name: "Changed Later", signature: PNG_SIGNATURE },
				})
			).error
		).toBe(0);
		const [owner] = (await Database`
			SELECT uuid FROM project_members WHERE project_id = ${projectUuid} AND account_username = 'owner-user'
		`) as { uuid: string }[];
		const [restored] = (await Database`
			SELECT
				(SELECT COUNT(*) FROM signature_assets) AS assets,
				(SELECT COUNT(*) FROM project_member_signature_versions WHERE member = ${owner.uuid}) AS versions,
				(SELECT COUNT(*) FROM project_member_signature_versions WHERE member = ${owner.uuid} AND valid_until IS NULL) AS active
		`) as { assets: number; versions: number; active: number }[];
		expect(restored).toEqual({ assets: 1, versions: 2, active: 1 });

		await call("PUT", `/api/v1/projects/${projectUuid}/member-profile`, {
			token: ownerToken,
			body: { full_name: "Changed Later", signature: PNG_SIGNATURE },
		});
		const [unchanged] = (await Database`
			SELECT COUNT(*) AS count FROM project_member_signature_versions WHERE member = ${owner.uuid}
		`) as { count: number }[];
		expect(unchanged.count).toBe(2);

		const created = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { due_date: Date.now() + 86_400_000, items: [{ description: "Later signed work", quantity: 1, unit_price: 1000, tax_rate: 22 }] },
		});
		expect((await call("POST", `/api/v1/projects/${projectUuid}/invoices/${created.data.uuid}/open`, { token: ownerToken })).error).toBe(0);

		const refs = (await Database`
			SELECT invoice_signature.invoice, invoice_signature.signature_version, version.signature_hash
			FROM invoice_issuer_signature_versions invoice_signature
			JOIN project_member_signature_versions version ON version.uuid = invoice_signature.signature_version
			WHERE invoice_signature.invoice IN (${signedInvoiceUuid}, ${created.data.uuid})
			ORDER BY invoice_signature.invoice
		`) as { invoice: string; signature_version: string; signature_hash: string }[];
		expect(refs).toHaveLength(2);
		expect(refs[0].signature_version).not.toBe(refs[1].signature_version);
		expect(refs[0].signature_hash).toBe(refs[1].signature_hash);

		expect(
			(
				await call("PUT", `/api/v1/projects/${projectUuid}/member-profile`, {
					token: ownerToken,
					body: { full_name: "Changed Later", signature: PNG_SIGNATURE_2 },
				})
			).error
		).toBe(0);
		const [changed] = (await Database`
			SELECT
				(SELECT COUNT(*) FROM signature_assets) AS assets,
				(SELECT COUNT(*) FROM project_member_signature_versions WHERE member = ${owner.uuid}) AS versions
		`) as { assets: number; versions: number }[];
		expect(changed).toEqual({ assets: 2, versions: 3 });
		const historical = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${signedInvoiceUuid}/document`, { token: ownerToken });
		expect(historical.data.issuer.signature).toBe(`data:image/png;base64,${PNG_SIGNATURE}`);
	});

	test("rejects malformed signature data", async () => {
		const res = await call("PUT", `/api/v1/projects/${projectUuid}/member-profile`, {
			token: ownerToken,
			body: { full_name: "Owner Person", signature: Buffer.from("not an image").toString("base64") },
		});
		expect(res.error).toBe(1120);
	});

	test("an expired membership loses access", async () => {
		const members = await call("GET", `/api/v1/projects/${projectUuid}/members`, { token: ownerToken });
		const viewer = members.data.find((member: any) => member.account_username === "viewer-user");

		await Database`UPDATE project_members SET expires_at = ${Date.now() - 1000} WHERE uuid = ${viewer.uuid}`;
		expect((await call("GET", `/api/v1/projects/${projectUuid}`, { token: viewerToken })).error).toBe(1020);

		await Database`UPDATE project_members SET expires_at = NULL WHERE uuid = ${viewer.uuid}`;
	});
});

describe("audit trail", () => {
	test("records project creation", async () => {
		const [entry] = (await Database`SELECT * FROM audit_log WHERE action = 'project.created' AND entity_id = ${projectUuid}`) as any[];
		expect(entry.account).toBe("owner-user");
	});

	test("records invoice creation", async () => {
		const [entry] = (await Database`SELECT COUNT(*) AS count FROM audit_log WHERE action = 'invoice.created'`) as { count: number }[];
		expect(entry.count).toBeGreaterThan(0);
	});

	test("records customer creation", async () => {
		const [entry] = (await Database`SELECT COUNT(*) AS count FROM audit_log WHERE action = 'customer.created'`) as { count: number }[];
		expect(entry.count).toBeGreaterThan(0);
	});

	test("records denied and granted authorization attempts", async () => {
		const [denied] = (await Database`SELECT COUNT(*) AS count FROM access_logs WHERE granted = 0`) as { count: number }[];
		const [granted] = (await Database`SELECT COUNT(*) AS count FROM access_logs WHERE granted = 1`) as { count: number }[];
		expect(denied.count).toBeGreaterThan(0);
		expect(granted.count).toBeGreaterThan(0);
	});
});

describe("session lifecycle", () => {
	test("logout invalidates the token", async () => {
		const login = await call("POST", "/api/v1/auth/login", { body: { username: "outsider-user", password: password("outsider") } });
		const token = login.data.token;

		expect((await call("GET", "/api/v1/auth/me", { token })).error).toBe(0);
		expect((await call("POST", "/api/v1/auth/logout", { token })).error).toBe(0);
		expect((await call("GET", "/api/v1/auth/me", { token })).error).toBe(1017);
	});

	test("logging in twice yields two independent sessions", async () => {
		const first = (await call("POST", "/api/v1/auth/login", { body: { username: "outsider-user", password: password("outsider") } })).data.token;
		const second = (await call("POST", "/api/v1/auth/login", { body: { username: "outsider-user", password: password("outsider") } })).data.token;

		expect(first).not.toBe(second);

		await call("POST", "/api/v1/auth/logout", { token: first });
		expect((await call("GET", "/api/v1/auth/me", { token: second })).error).toBe(0);
	});

	test("session tokens are not stored in the clear", async () => {
		const token = (await call("POST", "/api/v1/auth/login", { body: { username: "outsider-user", password: password("outsider") } })).data.token;
		expect(await Cache.getString(`session_${token}`)).toBeNull();
	});
});

describe("unknown routes", () => {
	test("returns the standard JSON envelope", async () => {
		const res = await call("GET", "/api/v1/nope");
		expect(res.error).toBe(404);
		expect(res.status).toBe(404);
	});
});

describe("rate limiting", () => {
	test("throttles repeated attempts on a credential endpoint", async () => {
		const statuses: number[] = [];

		for (let i = 0; i < 60; i++) {
			const res = await call("POST", "/api/v1/auth/register", { body: { username: "X", email: "x@example.com", password: password("x") } });
			statuses.push(res.status);
		}

		expect(statuses).toContain(429);
		expect(statuses[0]).toBe(400);
		expect(statuses[statuses.length - 1]).toBe(429);
	});

	test("leaves other endpoints unaffected", async () => {
		const res = await call("POST", "/api/v1/auth/login", { body: { username: "owner-user", password: password("owner") } });
		expect(res.error).toBe(0);
	});
});
