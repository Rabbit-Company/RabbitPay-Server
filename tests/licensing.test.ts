import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.licensing.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { Settings, reloadSettings } = await import("../server/settings");
const { setTransport } = await import("../server/email/mailer");
const { deliverPendingEmails } = await import("../server/email/outbox");
const { generateLicenseCode, normalizeLicenseCode, extendWhiteLabel, periodOf, storageFor, activateScheduledLicenses, DAY } =
	await import("../server/licensing");
const { readLogo } = await import("../server/branding");

await Server.configure();

const password = (seed: string) => new Bun.CryptoHasher("blake2b512").update(seed).digest("hex");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]).toString("base64");

interface ApiResponse {
	status: number;
	error: number;
	info: string;
	data?: any;
}

interface Captured {
	from: { name: string; address: string };
	to: string;
	subject: string;
	html: string;
	text: string;
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

const outbox: Captured[] = [];
setTransport({
	sendMail: async (message: Captured) => {
		outbox.push(message);
		return { messageId: `<${outbox.length}@test>` };
	},
} as never);

let adminToken = "";
let ownerToken = "";
let projectUuid = "";
let customerUuid = "";
const base = () => `/api/v1/projects/${projectUuid}`;

async function createLicense(body: Record<string, unknown>) {
	const res = await call("POST", "/api/v1/admin/licenses", { token: adminToken, body });
	if (res.error !== 0) throw new Error(res.info);
	return res.data[0] as { uuid: string; code: string };
}

async function issue(status: "open" | "draft" = "open") {
	return await call("POST", `${base()}/invoices`, {
		token: ownerToken,
		body: {
			customer: customerUuid,
			due_date: Date.now() + 14 * DAY,
			status,
			items: [{ description: "Work", quantity: 1, unit_price: 1000, tax_rate: 0 }],
		},
	});
}

async function pay(status: "confirmed" | "completed" = "completed") {
	const invoice = await issue();
	if (invoice.error !== 0) throw new Error(invoice.info);
	const res = await call("POST", `${base()}/transactions`, {
		token: ownerToken,
		body: { invoice: invoice.data.uuid, processor: "bank_transfer", amount: 1000, status },
	});
	if (res.error !== 0) throw new Error(res.info);
}

async function license() {
	return (await call("GET", `${base()}/license`, { token: ownerToken })).data;
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	adminToken = await account("lic-admin");
	ownerToken = await account("lic-owner");

	projectUuid = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "lic-shop", currency: "EUR" } })).data.uuid;
	customerUuid = (await call("POST", `${base()}/customers`, { token: ownerToken, body: { email: "buyer@example.com", name: "Buyer" } })).data.uuid;
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.licensing.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("license codes", () => {
	test("are grouped and read back regardless of case, spacing and look-alike letters", () => {
		const code = generateLicenseCode();
		expect(code).toMatch(/^RPAY(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
		expect(normalizeLicenseCode(code.toLowerCase().replace(/-/g, " "))).toBe(code);
		expect(normalizeLicenseCode("rpay-oooo0-iiiii-lllll-00000")).toBe("RPAY-00000-11111-11111-00000");
		expect(normalizeLicenseCode("RPAY-UUUUU-00000-00000-00000")).toBeNull();
		expect(normalizeLicenseCode("KEY-00000-00000-00000-00000")).toBeNull();
		expect(normalizeLicenseCode(42)).toBeNull();
	});

	test("white label time stacks onto what is left", () => {
		const now = 1_000_000;
		expect(extendWhiteLabel(null, 5, now)).toBe(now + 5 * DAY);
		expect(extendWhiteLabel(now + DAY, 5, now)).toBe(now + 6 * DAY);
		expect(extendWhiteLabel(now - DAY, 5, now)).toBe(now + 5 * DAY);
	});

	test("periods are calendar months in UTC", () => {
		expect(periodOf(Date.UTC(2026, 0, 31, 23, 59))).toBe("2026-01");
		expect(periodOf(Date.UTC(2026, 11, 1))).toBe("2026-12");
	});

	test("logos are recognised by their bytes, not their claimed type", () => {
		expect(readLogo(PNG)?.type).toBe("image/png");
		expect(readLogo(Buffer.from("<svg onload=alert(1)></svg>").toString("base64"))).toBeNull();
		expect(readLogo(Buffer.alloc(151 * 1024, 0x89).toString("base64"))).toBeNull();
		expect(readLogo("not base64!")).toBeNull();
	});
});

describe("administrators", () => {
	test("the first account is an administrator, later ones are not", async () => {
		expect((await call("GET", "/api/v1/auth/me", { token: adminToken })).data.admin).toBe(true);
		expect((await call("GET", "/api/v1/auth/me", { token: ownerToken })).data.admin).toBe(false);
	});

	test("admin routes refuse everyone else", async () => {
		for (const path of ["/api/v1/admin/overview", "/api/v1/admin/settings", "/api/v1/admin/licenses", "/api/v1/admin/projects", "/api/v1/admin/accounts"]) {
			expect((await call("GET", path, { token: ownerToken })).error).toBe(1098);
			expect((await call("GET", path)).error).toBe(1000);
		}
	});

	test("can promote another account but not change their own", async () => {
		const other = await account("lic-helper");
		expect((await call("PATCH", "/api/v1/admin/accounts/lic-admin", { token: adminToken, body: { admin: false } })).error).toBe(1103);

		const promoted = await call("PATCH", "/api/v1/admin/accounts/lic-helper", { token: adminToken, body: { admin: true } });
		expect(promoted.data.admin).toBe(true);
		expect((await call("GET", "/api/v1/admin/overview", { token: other })).error).toBe(0);

		await call("PATCH", "/api/v1/admin/accounts/lic-helper", { token: adminToken, body: { admin: false, status: "suspended" } });
		expect((await call("GET", "/api/v1/admin/overview", { token: other })).error).toBe(1026);
		expect((await call("PATCH", "/api/v1/admin/accounts/nobody-here", { token: adminToken, body: { admin: true } })).error).toBe(1104);
	});

	test("list accounts with their project counts", async () => {
		const res = await call("GET", "/api/v1/admin/accounts?search=lic-owner", { token: adminToken });
		expect(res.data.total).toBe(1);
		expect(res.data.accounts[0].projects).toBe(1);
		expect(res.data.accounts[0].password).toBeUndefined();
	});
});

describe("server settings", () => {
	test("are loaded from the database on start", () => {
		expect(Settings.server.port).toBe(8099);
		expect(Settings.webhooks.allow_private_targets).toBe(true);
	});

	test("hide secrets but say whether they are set", async () => {
		const res = await call("GET", "/api/v1/admin/settings", { token: adminToken });
		expect(res.data.values["email.host"]).toBe("127.0.0.1");
		expect(res.data.values["metrics.token"]).toBe("");
		expect(res.data.secrets["metrics.token"]).toBe(true);
		expect(res.data.secrets["email.password"]).toBe(false);
		expect(res.data.defaults["licensing.free_transactions"]).toBe(50);
		expect(res.data.defaults["licensing.free_storage_gb"]).toBe(1);
		expect(res.data.master_key_configured).toBe(true);
	});

	test("are saved, applied and reported when they need a restart", async () => {
		const res = await call("PATCH", "/api/v1/admin/settings", {
			token: adminToken,
			body: { values: { "vies.timeout": 7, "server.port": 9100, "email.password": "hunter2", "logging.level": "1" } },
		});
		expect(res.error).toBe(0);
		expect(res.data.restart_required).toEqual(["server.port"]);
		expect(res.data.secrets["email.password"]).toBe(true);
		expect(Settings.vies.timeout).toBe(7);
		expect(Settings.logging.level).toBe(1);
		expect(Settings.email.password).toBe("hunter2");

		const [stored] = (await Database`SELECT value FROM settings WHERE key = 'email.password'`) as { value: string }[];
		expect(stored.value).not.toContain("hunter2");
		expect(JSON.parse(stored.value).sealed).toBeString();

		Settings.vies.timeout = 1;
		await reloadSettings();
		expect(Settings.vies.timeout).toBe(7);
	});

	test("store only values that differ from the default, so new defaults still apply", async () => {
		await call("PATCH", "/api/v1/admin/settings", { token: adminToken, body: { values: { "rates.cache_seconds": 90 } } });
		expect(((await Database`SELECT key FROM settings WHERE key = 'rates.cache_seconds'`) as unknown[]).length).toBe(1);

		await call("PATCH", "/api/v1/admin/settings", { token: adminToken, body: { values: { "rates.cache_seconds": 60 } } });
		expect(((await Database`SELECT key FROM settings WHERE key = 'rates.cache_seconds'`) as unknown[]).length).toBe(0);
		expect(Settings.rates.cache_seconds).toBe(60);
	});

	test("keep a secret when it is left blank and clear it with null", async () => {
		await call("PATCH", "/api/v1/admin/settings", { token: adminToken, body: { values: { "email.password": "" } } });
		expect(Settings.email.password).toBe("hunter2");
		await call("PATCH", "/api/v1/admin/settings", { token: adminToken, body: { values: { "email.password": null } } });
		expect(Settings.email.password).toBe("");
	});

	test("refuse unknown keys and invalid values without saving anything", async () => {
		const unknown = await call("PATCH", "/api/v1/admin/settings", { token: adminToken, body: { values: { "security.master_key": "x" } } });
		expect(unknown.error).toBe(1099);

		const invalid = await call("PATCH", "/api/v1/admin/settings", {
			token: adminToken,
			body: { values: { "vies.timeout": 3, "server.port": 70000 } },
		});
		expect(invalid.error).toBe(1099);
		expect(invalid.info).toContain("Port");
		expect(Settings.vies.timeout).toBe(7);

		expect((await call("PATCH", "/api/v1/admin/settings", { token: adminToken, body: { values: { "btc.backend": "electrum" } } })).error).toBe(1099);
		expect((await call("PATCH", "/api/v1/admin/settings", { token: adminToken, body: { values: { "email.enabled": "yes" } } })).error).toBe(1099);
	});
});

describe("license keys", () => {
	test("are validated when created", async () => {
		const bad = [
			{ type: "support" },
			{ type: "transactions" },
			{ type: "transactions", transactions: 0 },
			{ type: "transactions", transactions: 1.5 },
			{ type: "white_label", duration_days: 0 },
			{ type: "storage" },
			{ type: "storage", storage_gb: 10 },
			{ type: "storage", storage_gb: 0, duration_days: 30 },
			{ type: "storage", storage_gb: 1.5, duration_days: 30 },
			{ type: "storage", storage_gb: 10, duration_days: 0 },
			{ type: "white_label", duration_days: 5, quantity: 101 },
			{ type: "white_label", duration_days: 5, price: 1000 },
			{ type: "white_label", duration_days: 5, price: 1000, currency: "EURO" },
			{ type: "white_label", duration_days: 5, buyer_email: "nope" },
		];
		for (const body of bad) {
			expect((await call("POST", "/api/v1/admin/licenses", { token: adminToken, body })).error).toBe(1095);
		}
	});

	test("are created in batches with purchase details", async () => {
		const res = await call("POST", "/api/v1/admin/licenses", {
			token: adminToken,
			body: { type: "transactions", transactions: 500, quantity: 3, price: 4900, currency: "eur", buyer_name: "Acme", buyer_email: "billing@acme.test" },
		});
		expect(res.status).toBe(201);
		expect(res.data.length).toBe(3);
		expect(new Set(res.data.map((row: { code: string }) => row.code)).size).toBe(3);
		expect(res.data[0]).toMatchObject({ type: "transactions", transactions: 500, duration_days: null, status: "available", currency: "EUR" });

		const listed = await call("GET", "/api/v1/admin/licenses?search=acme", { token: adminToken });
		expect(listed.data.total).toBe(3);

		const overview = await call("GET", "/api/v1/admin/overview", { token: adminToken });
		expect(overview.data.licenses_available).toBe(3);
		expect(overview.data.revenue).toEqual([{ currency: "EUR", amount: 14700, count: 3 }]);
	});

	test("purchase details can be corrected later", async () => {
		const created = await createLicense({ type: "white_label", duration_days: 30 });
		const res = await call("PATCH", `/api/v1/admin/licenses/${created.uuid}`, {
			token: adminToken,
			body: { price: 2500, currency: "USD", note: "Paid by transfer" },
		});
		expect(res.data).toMatchObject({ price: 2500, currency: "USD", note: "Paid by transfer", duration_days: 30 });

		const cleared = await call("PATCH", `/api/v1/admin/licenses/${created.uuid}`, { token: adminToken, body: { note: null } });
		expect(cleared.data.note).toBeNull();
		expect(cleared.data.price).toBe(2500);
	});

	test("only unused keys can be revoked, and a revoked key cannot be redeemed", async () => {
		const created = await createLicense({ type: "transactions", transactions: 10 });
		const revoked = await call("POST", `/api/v1/admin/licenses/${created.uuid}/revoke`, { token: adminToken });
		expect(revoked.data.status).toBe("revoked");
		expect((await call("POST", `/api/v1/admin/licenses/${created.uuid}/revoke`, { token: adminToken })).error).toBe(1101);
		expect((await call("POST", `${base()}/license/redeem`, { token: ownerToken, body: { code: created.code } })).error).toBe(1094);
	});

	test("unknown or malformed codes are refused", async () => {
		expect((await call("POST", `${base()}/license/redeem`, { token: ownerToken, body: { code: "hello" } })).error).toBe(1093);
		expect((await call("POST", `${base()}/license/redeem`, { token: ownerToken, body: { code: generateLicenseCode() } })).error).toBe(1093);
	});
});

describe("transaction limits", () => {
	test("start with the server default of free payments", async () => {
		const state = await license();
		expect(state).toMatchObject({ enforced: true, free_allowance: 50, free_used: 0, paid_balance: 0, remaining: 50, white_label: false });
		expect(state.period).toBe(periodOf(Date.now()));
	});

	test("an administrator can override the free allowance per project", async () => {
		const res = await call("PATCH", `/api/v1/admin/projects/${projectUuid}`, { token: adminToken, body: { free_transactions: 2 } });
		expect(res.data).toMatchObject({ free_transactions: 2, free_allowance: 2, remaining: 2 });
		expect((await call("PATCH", `/api/v1/admin/projects/${projectUuid}`, { token: adminToken, body: { free_transactions: -1 } })).error).toBe(1099);
	});

	test("completed and confirmed payments use the free allowance first, pending ones are not counted", async () => {
		const unpaid = (await issue()).data.uuid;
		await pay();
		await pay("confirmed");
		const pending = await call("POST", `${base()}/transactions`, {
			token: ownerToken,
			body: { invoice: unpaid, processor: "bank_transfer", amount: 500, status: "pending" },
		});
		expect(pending.error).toBe(0);
		expect(await license()).toMatchObject({ free_used: 2, paid_used: 0, remaining: 0 });
	});

	test("an exhausted project cannot issue new invoices or sales, but can still keep drafts", async () => {
		expect((await issue()).error).toBe(1096);
		expect((await issue()).status).toBe(402);

		const draft = await issue("draft");
		expect(draft.error).toBe(0);
		expect((await call("POST", `${base()}/invoices/${draft.data.uuid}/open`, { token: ownerToken })).error).toBe(1096);

		const sale = await call("POST", `${base()}/pos/sales`, { token: ownerToken, body: { lines: [{ amount: 500, quantity: 1, tax_rate: 0 }] } });
		expect(sale.error).toBe(1096);
	});

	test("a transaction license adds paid payments that are used after the free ones", async () => {
		const created = await createLicense({ type: "transactions", transactions: 3 });
		const redeemed = await call("POST", `${base()}/license/redeem`, { token: ownerToken, body: { code: created.code.toLowerCase() } });
		expect(redeemed.data).toMatchObject({ paid_balance: 3, remaining: 3 });
		expect(redeemed.data.licenses[0].code).toStartWith("RPAY-*****");
		expect((await call("POST", `${base()}/license/redeem`, { token: ownerToken, body: { code: created.code } })).error).toBe(1094);

		await pay();
		expect(await license()).toMatchObject({ free_used: 2, paid_used: 1, paid_balance: 2, remaining: 2 });

		const listed = await call("GET", `/api/v1/admin/licenses?status=redeemed`, { token: adminToken });
		expect(listed.data.licenses[0]).toMatchObject({ redeemed_project: projectUuid, project_name: "lic-shop", redeemed_by: "lic-owner" });
	});

	test("payments that arrive past the limit are still recorded and taken from the next license", async () => {
		const open = [(await issue()).data.uuid, (await issue()).data.uuid, (await issue()).data.uuid];
		for (const uuid of open) {
			const paid = await call("POST", `${base()}/transactions`, { token: ownerToken, body: { invoice: uuid, processor: "bank_transfer", amount: 1000 } });
			expect(paid.error).toBe(0);
		}
		expect(await license()).toMatchObject({ paid_balance: -1, remaining: -1 });

		const created = await createLicense({ type: "transactions", transactions: 1 });
		const applied = await call("POST", `/api/v1/admin/projects/${projectUuid}/licenses`, { token: adminToken, body: { code: created.code } });
		expect(applied.data).toMatchObject({ paid_balance: 0, remaining: 0 });
		expect((await issue()).error).toBe(1096);
	});

	test("turning licensing off lifts every limit", async () => {
		await call("PATCH", "/api/v1/admin/settings", { token: adminToken, body: { values: { "licensing.enabled": false } } });
		expect((await issue()).error).toBe(0);
		expect((await license()).remaining).toBeNull();
		expect((await call("GET", base(), { token: ownerToken })).data.white_label).toBe(true);
		await call("PATCH", "/api/v1/admin/settings", { token: adminToken, body: { values: { "licensing.enabled": true } } });
	});

	test("the admin project list shows usage for this month", async () => {
		const res = await call("GET", "/api/v1/admin/projects?search=lic-shop", { token: adminToken });
		expect(res.data.total).toBe(1);
		expect(res.data.projects[0]).toMatchObject({ uuid: projectUuid, free_used: 2, free_allowance: 2, paid_balance: 0, white_label: false });

		const state = await license();
		const listed = res.data.projects[0];
		expect(Number.isSafeInteger(listed.storage_used)).toBe(true);
		expect(listed).toMatchObject({
			storage_included: state.storage_included,
			storage_licensed: state.storage_licensed,
			storage_used: state.storage_used,
			storage_limit: state.storage_limit,
			storage_remaining: state.storage_remaining,
		});
	});
});

describe("storage limits", () => {
	test("includes five GB and counts archived documents", async () => {
		const state = await license();
		expect(state.storage_included).toBe(1_000_000_000);
		expect(state.storage_licensed).toBe(0);
		expect(state.storage_limit).toBe(1_000_000_000);
		expect(state.storage_used).toBeGreaterThan(0);
		expect(state.storage_remaining).toBe(1_000_000_000 - state.storage_used);
	});

	test("a storage license adds capacity for a number of days", async () => {
		const created = await createLicense({ type: "storage", storage_gb: 10, duration_days: 30 });
		const redeemed = await call("POST", `${base()}/license/redeem`, { token: ownerToken, body: { code: created.code } });
		expect(redeemed.data).toMatchObject({ storage_included: 1_000_000_000, storage_licensed: 10_000_000_000, storage_limit: 11_000_000_000 });
		expect(redeemed.data.licenses[0]).toMatchObject({ type: "storage", storage_gb: 10, transactions: null, duration_days: 30 });
		expect(redeemed.data.storage_grants).toHaveLength(1);
		expect(redeemed.data.storage_grants[0].storage_gb).toBe(10);
		expect(redeemed.data.storage_grants[0].until).toBeGreaterThan(Date.now() + 29 * DAY);
	});

	test("storage keys run on their own and stop counting when they end", async () => {
		const created = await createLicense({ type: "storage", storage_gb: 5, duration_days: 60 });
		const redeemed = await call("POST", `${base()}/license/redeem`, { token: ownerToken, body: { code: created.code } });
		expect(redeemed.data).toMatchObject({ storage_licensed: 15_000_000_000, storage_limit: 16_000_000_000 });

		expect(await storageFor(projectUuid, Date.now() + 31 * DAY)).toMatchObject({ storage_licensed: 5_000_000_000, storage_limit: 6_000_000_000 });
		const ended = await storageFor(projectUuid, Date.now() + 61 * DAY);
		expect(ended).toMatchObject({ storage_licensed: 0, storage_limit: 1_000_000_000, storage_grants: [] });
		expect(ended.storage_used).toBeGreaterThan(0);
	});

	test("blocks issued documents at the limit until a storage key is redeemed", async () => {
		await call("PATCH", "/api/v1/admin/settings", { token: adminToken, body: { values: { "licensing.free_storage_gb": 0 } } });
		const limited = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "storage-limited", currency: "EUR" } })).data.uuid;
		const limitedBase = `/api/v1/projects/${limited}`;
		const invoiceBody = {
			due_date: Date.now() + 14 * DAY,
			items: [{ description: "Storage", quantity: 1, unit_price: 1000, tax_rate: 0 }],
		};
		const blocked = await call("POST", `${limitedBase}/invoices`, { token: ownerToken, body: { ...invoiceBody, status: "open" } });
		expect(blocked.error).toBe(1126);
		const draft = await call("POST", `${limitedBase}/invoices`, { token: ownerToken, body: { ...invoiceBody, status: "draft" } });
		expect(draft.error).toBe(0);
		expect((await call("POST", `${limitedBase}/invoices/${draft.data.uuid}/open`, { token: ownerToken })).error).toBe(1126);

		const created = await createLicense({ type: "storage", storage_gb: 1, duration_days: 30 });
		const redeemed = await call("POST", `${limitedBase}/license/redeem`, { token: ownerToken, body: { code: created.code } });
		expect(redeemed.data.storage_licensed).toBe(1_000_000_000);
		expect((await call("POST", `${limitedBase}/invoices/${draft.data.uuid}/open`, { token: ownerToken })).error).toBe(0);
		await call("PATCH", "/api/v1/admin/settings", { token: adminToken, body: { values: { "licensing.free_storage_gb": 5 } } });
	});
});

describe("start dates", () => {
	let planned = "";
	const plannedBase = () => `/api/v1/projects/${planned}`;
	const state = async () => (await call("GET", `${plannedBase()}/license`, { token: ownerToken })).data;
	const redeem = async (code: string, startsAt?: unknown) =>
		await call("POST", `${plannedBase()}/license/redeem`, { token: ownerToken, body: { code, starts_at: startsAt } });

	test("checking a key shows what it adds without redeeming it", async () => {
		planned = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "planned", currency: "EUR" } })).data.uuid;
		const created = await createLicense({ type: "storage", storage_gb: 10, duration_days: 30 });
		const preview = await call("POST", `${plannedBase()}/license/preview`, { token: ownerToken, body: { code: created.code } });
		expect(preview.data).toMatchObject({ type: "storage", storage_gb: 10, duration_days: 30, timed: true, adds_up: true, running_until: null });
		expect((await call("POST", `${plannedBase()}/license/preview`, { token: ownerToken, body: { code: "RPAY-00000-00000-00000-00000" } })).error).toBe(1093);

		const redeemed = await redeem(created.code);
		expect(redeemed.data.storage_licensed).toBe(10_000_000_000);
		expect(redeemed.data.licenses[0].starts_at).toBeNull();
		expect((await call("POST", `${plannedBase()}/license/preview`, { token: ownerToken, body: { code: created.code } })).error).toBe(1094);
	});

	test("a storage key can start when the running one ends", async () => {
		const created = await createLicense({ type: "storage", storage_gb: 5, duration_days: 30 });
		const preview = await call("POST", `${plannedBase()}/license/preview`, { token: ownerToken, body: { code: created.code } });
		const runningUntil = preview.data.running_until as number;
		expect(runningUntil).toBeGreaterThan(Date.now() + 29 * DAY);

		const redeemed = await redeem(created.code, runningUntil);
		expect(redeemed.data.storage_licensed).toBe(10_000_000_000);
		expect(redeemed.data.storage_grants).toHaveLength(2);
		expect(redeemed.data.storage_grants[1]).toMatchObject({ storage_gb: 5, from: runningUntil, until: runningUntil + 30 * DAY });
		expect(redeemed.data.licenses[0]).toMatchObject({ starts_at: runningUntil, ends_at: runningUntil + 30 * DAY });

		expect((await storageFor(planned, runningUntil + DAY)).storage_licensed).toBe(5_000_000_000);
		expect((await storageFor(planned, runningUntil + 31 * DAY)).storage_licensed).toBe(0);
	});

	test("a start less than a day after the last key joins it without a gap", async () => {
		const last = (await state()).storage_grants[1].until as number;
		const created = await createLicense({ type: "storage", storage_gb: 1, duration_days: 30 });
		const redeemed = await redeem(created.code, last + DAY / 2);
		expect(redeemed.data.storage_grants[2]).toMatchObject({ storage_gb: 1, from: last });
	});

	test("an add-on key with a later start waits and then runs its full days", async () => {
		const created = await createLicense({ type: "workforce", duration_days: 30 });
		const start = Date.now() + 10 * DAY;
		const redeemed = await redeem(created.code, start);
		expect(redeemed.data).toMatchObject({ workforce: false, workforce_until: null });
		expect(redeemed.data.scheduled).toEqual([{ type: "workforce", from: start, until: start + 30 * DAY }]);
		expect(redeemed.data.licenses[0]).toMatchObject({ type: "workforce", starts_at: start });

		expect(await activateScheduledLicenses(planned, start - 1)).toBe(0);
		expect(await activateScheduledLicenses(planned, start + 5 * 60 * 1000)).toBe(1);
		expect(await activateScheduledLicenses(planned, start + 5 * 60 * 1000)).toBe(0);
		const after = await state();
		expect(after.workforce_until).toBe(start + 30 * DAY);
		expect(after.scheduled).toEqual([]);
	});

	test("an add-on key that starts before the running one ends is added to its end", async () => {
		const until = (await state()).workforce_until as number;
		const created = await createLicense({ type: "workforce", duration_days: 30 });
		const preview = await call("POST", `${plannedBase()}/license/preview`, { token: ownerToken, body: { code: created.code } });
		expect(preview.data).toMatchObject({ type: "workforce", timed: true, adds_up: false, running_until: until });

		const redeemed = await redeem(created.code, Date.now() + 20 * DAY);
		expect(redeemed.data.workforce_until).toBe(until + 30 * DAY);
		expect(redeemed.data.scheduled).toEqual([]);
		expect(redeemed.data.licenses[0].starts_at).toBeNull();
	});

	test("an administrator can check a key and apply it with a later start", async () => {
		const created = await createLicense({ type: "white_label", duration_days: 30 });
		const path = `/api/v1/admin/projects/${planned}/licenses`;
		expect((await call("POST", `${path}/preview`, { token: ownerToken, body: { code: created.code } })).error).toBe(1098);
		const preview = await call("POST", `${path}/preview`, { token: adminToken, body: { code: created.code } });
		expect(preview.data).toMatchObject({ type: "white_label", duration_days: 30, timed: true, adds_up: false, running_until: null });
		expect((await call("POST", path, { token: adminToken, body: { code: created.code, starts_at: "later" } })).error).toBe(1095);

		const start = Date.now() + 15 * DAY;
		const applied = await call("POST", path, { token: adminToken, body: { code: created.code, starts_at: start } });
		expect(applied.data).toMatchObject({ white_label: false, white_label_until: null });
		expect((await state()).scheduled).toEqual([{ type: "white_label", from: start, until: start + 30 * DAY }]);
	});

	test("payments keys start right away and bad start dates are refused", async () => {
		const payments = await createLicense({ type: "transactions", transactions: 10 });
		for (const startsAt of ["tomorrow", -5, 1.5, Date.now() + 4000 * DAY]) expect((await redeem(payments.code, startsAt)).error).toBe(1095);

		const redeemed = await redeem(payments.code, Date.now() + 10 * DAY);
		expect(redeemed.data.paid_balance).toBe(10);
		expect(redeemed.data.licenses[0].starts_at).toBeNull();
	});
});

describe("accounting", () => {
	test("an accounting license is redeemed for a number of days and stacks onto what is left", async () => {
		expect((await license()).accounting).toBe(false);
		const first = await createLicense({ type: "accounting", duration_days: 30 });
		const redeemed = await call("POST", `${base()}/license/redeem`, { token: ownerToken, body: { code: first.code } });
		expect(redeemed.data.accounting).toBe(true);
		expect(redeemed.data.accounting_until).toBeGreaterThan(Date.now() + 29 * DAY);

		const second = await createLicense({ type: "accounting", duration_days: 10 });
		const extended = await call("POST", `${base()}/license/redeem`, { token: ownerToken, body: { code: second.code } });
		expect(extended.data.accounting_until - redeemed.data.accounting_until).toBe(10 * DAY);
		expect((await call("GET", `${base()}`, { token: ownerToken })).data.accounting).toBe(true);
	});

	test("accounting keys need a number of days", async () => {
		expect((await call("POST", "/api/v1/admin/licenses", { token: adminToken, body: { type: "accounting" } })).error).toBe(1095);
	});
});

describe("white label", () => {
	test("branding and email servers need an active license", async () => {
		expect((await call("PUT", `${base()}/branding/logo`, { token: ownerToken, body: { data: PNG } })).error).toBe(1097);
		expect(
			(
				await call("PUT", `${base()}/email-server`, {
					token: ownerToken,
					body: { host: "smtp.shop.test", port: 587, secure: false, username: "u", password: "p", from_address: "billing@shop.test" },
				})
			).error
		).toBe(1097);

		const invoice = (await call("GET", `${base()}/invoices?limit=1`, { token: ownerToken })).data.invoices[0];
		const pub = await call("GET", `/api/v1/public/invoices/${invoice.uuid}`);
		expect(pub.data.branding).toEqual({ white_label: false, logo: null });
	});

	test("a white label license unlocks a logo that customers see", async () => {
		const created = await createLicense({ type: "white_label", duration_days: 5 });
		const redeemed = await call("POST", `${base()}/license/redeem`, { token: ownerToken, body: { code: created.code } });
		expect(redeemed.data.white_label).toBe(true);
		expect(redeemed.data.white_label_until).toBeGreaterThan(Date.now() + 4 * DAY);

		expect((await call("PUT", `${base()}/branding/logo`, { token: ownerToken, body: { data: "PHN2Zz4=" } })).error).toBe(1100);
		const uploaded = await call("PUT", `${base()}/branding/logo`, { token: ownerToken, body: { data: PNG } });
		expect(uploaded.data.logo).toStartWith(`/api/v1/public/projects/${projectUuid}/logo?v=`);

		const image = await Server.app.handle(new Request(`http://127.0.0.1${uploaded.data.logo}`));
		expect(image.status).toBe(200);
		expect(image.headers.get("content-type")).toBe("image/png");
		expect(image.headers.get("x-content-type-options")).toBe("nosniff");
		expect(Buffer.from(await image.arrayBuffer()).toString("base64")).toBe(PNG);

		const invoice = (await call("GET", `${base()}/invoices?limit=1`, { token: ownerToken })).data.invoices[0];
		expect((await call("GET", `/api/v1/public/invoices/${invoice.uuid}`)).data.branding).toEqual({ white_label: true, logo: uploaded.data.logo });
		expect((await call("GET", `${base()}/invoices/${invoice.uuid}/document`, { token: ownerToken })).data.branding.white_label).toBe(true);
	});

	test("a second license extends the time left", async () => {
		const before = (await license()).white_label_until;
		const created = await createLicense({ type: "white_label", duration_days: 10 });
		const after = (await call("POST", `${base()}/license/redeem`, { token: ownerToken, body: { code: created.code } })).data.white_label_until;
		expect(after - before).toBe(10 * DAY);
	});

	test("the project's own email server is stored encrypted and used for its emails", async () => {
		const saved = await call("PUT", `${base()}/email-server`, {
			token: ownerToken,
			body: { host: "smtp.shop.test", port: 587, secure: false, username: "mailer", password: "s3cret", from_address: "billing@shop.test" },
		});
		expect(saved.data).toEqual({ host: "smtp.shop.test", port: 587, secure: false, username: "mailer", from_address: "billing@shop.test", password_set: true });

		const [row] = (await Database`SELECT email_server FROM projects WHERE uuid = ${projectUuid}`) as { email_server: string }[];
		expect(row.email_server).not.toContain("s3cret");

		const kept = await call("PUT", `${base()}/email-server`, {
			token: ownerToken,
			body: { host: "smtp2.shop.test", port: 465, secure: true, username: "mailer", from_address: "billing@shop.test" },
		});
		expect(kept.data.password_set).toBe(true);
		expect((await call("PUT", `${base()}/email-server`, { token: ownerToken, body: { host: "", port: 0, secure: false } })).error).toBe(1102);

		expect((await call("GET", base(), { token: ownerToken })).data).toMatchObject({ email_enabled: true, custom_email_server: true, has_logo: true });

		const invoice = (await call("GET", `${base()}/invoices?limit=1`, { token: ownerToken })).data.invoices[0];
		const sent = await call("POST", `${base()}/invoices/${invoice.uuid}/email`, { token: ownerToken, body: {} });
		expect(sent.error).toBe(0);
		await Bun.sleep(5);
		await deliverPendingEmails(Date.now() + 60 * 60 * 1000);

		const message = outbox.find((entry) => entry.subject.includes(invoice.reference))!;
		expect(message.from.address).toBe("billing@shop.test");
		expect(message.text).not.toContain("RabbitPay");
		expect(message.html).toContain(`/api/v1/public/projects/${projectUuid}/logo?v=`);

		const tested = await call("POST", `${base()}/email-server/test`, { token: ownerToken, body: { to: "owner@shop.test" } });
		expect(tested.data.to).toBe("owner@shop.test");
		expect(outbox.at(-1)!.from.address).toBe("billing@shop.test");
	});

	test("when it runs out, RabbitPay branding returns and the project server is no longer used", async () => {
		await Database`UPDATE projects SET white_label_until = ${Date.now() - 1000} WHERE uuid = ${projectUuid}`;

		const state = await license();
		expect(state.white_label).toBe(false);
		expect(state.logo).toBeNull();

		const project = (await call("GET", base(), { token: ownerToken })).data;
		expect(project).toMatchObject({ white_label: false, has_logo: true, custom_email_server: true, email_enabled: false });

		const image = await Server.app.handle(new Request(`http://127.0.0.1/api/v1/public/projects/${projectUuid}/logo`));
		expect(image.status).toBe(404);

		const invoice = (await call("GET", `${base()}/invoices?limit=1`, { token: ownerToken })).data.invoices[0];
		expect((await call("POST", `${base()}/invoices/${invoice.uuid}/email`, { token: ownerToken, body: {} })).error).toBe(1083);

		Settings.email.enabled = true;
		const count = outbox.length;
		const sent = await call("POST", `${base()}/invoices/${invoice.uuid}/email`, { token: ownerToken, body: {} });
		expect(sent.error).toBe(0);
		await Bun.sleep(5);
		await deliverPendingEmails(Date.now() + 60 * 60 * 1000);
		const message = outbox.slice(count).find((entry) => entry.subject.includes(invoice.reference))!;
		expect(message.from.address).toBe(Settings.email.from_address);
		expect(message.text).toContain("with RabbitPay");
		expect(message.html).not.toContain("/logo?v=");
		Settings.email.enabled = false;
	});

	test("removing the logo and email server clears them", async () => {
		expect((await call("DELETE", `${base()}/branding/logo`, { token: ownerToken })).error).toBe(0);
		expect((await call("DELETE", `${base()}/email-server`, { token: ownerToken })).error).toBe(0);
		expect((await call("GET", `${base()}/email-server`, { token: ownerToken })).data).toBeNull();
		expect((await call("GET", base(), { token: ownerToken })).data).toMatchObject({ has_logo: false, custom_email_server: false });
	});
});
