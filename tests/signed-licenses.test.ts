import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { prepareTest } from "./environment";

const databasePath = `${import.meta.dir}/.signed-licenses.sqlite`;
await prepareTest(`sqlite://${databasePath}`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { Settings } = await import("../server/settings");
const { generateIssuerKeys } = await import("../server/license-signing");

await Server.configure();

interface ApiResponse {
	status: number;
	error: number;
	info: string;
	data?: any;
}

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<ApiResponse> {
	const headers: Record<string, string> = {};
	if (options.token) headers.Authorization = `Bearer ${options.token}`;
	if (options.body !== undefined) headers["Content-Type"] = "application/json";
	const response = await Server.app.handle(
		new Request(`http://127.0.0.1${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
	);
	return { status: response.status, ...((await response.json()) as Omit<ApiResponse, "status">) };
}

const password = new Bun.CryptoHasher("blake2b512").update("signed-pass").digest("hex");
const issuerKey = process.env.RABBITPAY_LICENSE_SIGNING_KEY!;
let token = "";
let project = "";
let serverId = "";
let localCode = "";
let ownKey = "";
let foreignKey = "";
let seatKey = "";

function licensedMode() {
	delete process.env.RABBITPAY_LICENSE_SIGNING_KEY;
}

async function redeem(code: string) {
	return await call("POST", `/api/v1/projects/${project}/license/redeem`, { token, body: { code } });
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();
	await call("POST", "/api/v1/auth/register", { body: { username: "signed-admin", email: "signed@example.com", password } });
	token = (await call("POST", "/api/v1/auth/login", { body: { username: "signed-admin", password } })).data.token;
	project = (await call("POST", "/api/v1/projects", { token, body: { name: "signed-shop" } })).data.uuid;
});

afterAll(async () => {
	process.env.RABBITPAY_LICENSE_SIGNING_KEY = issuerKey;
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${databasePath}${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("license issuer", () => {
	test("shows a stable Server ID and knows it is the issuer", async () => {
		const settings = await call("GET", "/api/v1/admin/settings", { token });
		expect(settings.data.license_issuer).toBe(true);
		expect(settings.data.server_id).toMatch(/^RPS(-[0-9A-Z]{5}){4}$/);
		serverId = settings.data.server_id;
		expect((await call("GET", "/api/v1/admin/overview", { token })).data.server_id).toBe(serverId);
	});

	test("signs keys for a Server ID and still creates local keys", async () => {
		const signed = await call("POST", "/api/v1/admin/licenses", {
			token,
			body: { type: "transactions", transactions: 500, server_id: serverId.toLowerCase(), buyer_name: "Self Host d.o.o." },
		});
		expect(signed.status).toBe(201);
		expect(signed.data[0].server_id).toBe(serverId);
		expect(signed.data[0].signed_key).toStartWith("RPAY2.");
		ownKey = signed.data[0].signed_key;

		const other = await call("POST", "/api/v1/admin/licenses", {
			token,
			body: { type: "white_label", duration_days: 30, server_id: "RPS-AAAAA-BBBBB-CCCCC-DDDDD" },
		});
		foreignKey = other.data[0].signed_key;

		const seats = await call("POST", "/api/v1/admin/licenses", { token, body: { type: "employees", employees: 20, duration_days: 365, server_id: serverId } });
		expect(seats.data[0]).toMatchObject({ type: "employees", employees: 20, duration_days: 365 });
		seatKey = seats.data[0].signed_key;

		const local = await call("POST", "/api/v1/admin/licenses", { token, body: { type: "transactions", transactions: 10 } });
		expect(local.data[0].signed_key).toBeNull();
		localCode = local.data[0].code;

		expect((await call("POST", "/api/v1/admin/licenses", { token, body: { type: "storage", storage_gb: 1, server_id: "not-a-server" } })).error).toBe(1095);
	});
});

describe("licensed server", () => {
	test("cannot create keys or change license limits", async () => {
		licensedMode();
		const settings = await call("GET", "/api/v1/admin/settings", { token });
		expect(settings.data.license_issuer).toBe(false);
		expect(settings.data.server_id).toBe(serverId);

		expect((await call("POST", "/api/v1/admin/licenses", { token, body: { type: "transactions", transactions: 10 } })).error).toBe(1240);
		expect((await call("PATCH", "/api/v1/admin/settings", { token, body: { values: { "licensing.enabled": false } } })).error).toBe(1240);
		expect((await call("PATCH", "/api/v1/admin/settings", { token, body: { values: { "licensing.free_transactions": 1000000 } } })).error).toBe(1240);
		expect((await call("PATCH", "/api/v1/admin/settings", { token, body: { values: { "reports.cooldown_minutes": 5 } } })).error).toBe(0);
		expect((await call("PATCH", `/api/v1/admin/projects/${project}`, { token, body: { free_transactions: 1000000 } })).error).toBe(1240);
	});

	test("ignores license settings stored before it stopped being the issuer", async () => {
		Settings.licensing.enabled = false;
		Settings.licensing.free_transactions = 1_000_000;
		Settings.licensing.free_storage_gb = 1_000;
		Settings.licensing.free_employees = 1_000;
		await Database`UPDATE projects SET free_transactions = 1000000 WHERE uuid = ${project}`;
		try {
			const license = await call("GET", `/api/v1/projects/${project}/license`, { token });
			expect(license.data.enforced).toBe(true);
			expect(license.data.free_allowance).toBe(50);
			expect(license.data.storage_included).toBe(1_000_000_000);
			expect(license.data.employees_included).toBe(5);
			expect(license.data.license_issuer).toBe(false);
			expect(license.data.server_id).toBe(serverId);
		} finally {
			Settings.licensing.enabled = true;
			Settings.licensing.free_transactions = 50;
			Settings.licensing.free_storage_gb = 1;
			Settings.licensing.free_employees = 5;
		}
	});

	test("refuses unsigned, foreign, tampered and forged keys", async () => {
		expect((await redeem(localCode)).error).toBe(1242);
		expect((await redeem(foreignKey)).error).toBe(1241);

		const [prefix, body, signature] = ownKey.split(".");
		const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
		const inflated = Buffer.from(JSON.stringify({ ...payload, transactions: 99999999 })).toString("base64url");
		expect((await redeem(`${prefix}.${inflated}.${signature}`)).error).toBe(1093);

		const attacker = generateIssuerKeys();
		process.env.RABBITPAY_LICENSE_SIGNING_KEY = attacker.privateKey;
		try {
			expect((await call("GET", "/api/v1/admin/settings", { token })).data.license_issuer).toBe(false);
			expect((await call("POST", "/api/v1/admin/licenses", { token, body: { type: "transactions", transactions: 10 } })).error).toBe(1240);
		} finally {
			licensedMode();
		}
	});

	test("redeems a key signed for this server exactly once", async () => {
		const redeemed = await redeem(`  ${ownKey}  `);
		expect(redeemed.error).toBe(0);
		expect(redeemed.data.paid_balance).toBe(500);
		expect(redeemed.data.licenses[0].server_id).toBe(serverId);

		expect((await redeem(ownKey)).error).toBe(1094);
	});

	test("redeems signed employee seats for their own number of days", async () => {
		const redeemed = await redeem(seatKey);
		expect(redeemed.error).toBe(0);
		expect(redeemed.data).toMatchObject({ employees_included: 5, employees_licensed: 20, employees_limit: 25 });
		expect(redeemed.data.employee_seats[0].employees).toBe(20);
		expect(redeemed.data.employee_seats[0].until).toBeGreaterThan(Date.now() + 364 * 86400000);
		expect(redeemed.data.licenses[0]).toMatchObject({ type: "employees", employees: 20, duration_days: 365 });
	});
});
