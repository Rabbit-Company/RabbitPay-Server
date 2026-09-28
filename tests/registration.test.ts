import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.registration.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { generateInviteCode, normalizeInviteCode } = await import("../server/registration");

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

function register(name: string, extra: Record<string, unknown> = {}, email = `${name}@example.com`) {
	return call("POST", "/api/v1/auth/register", { body: { username: name, email, password: password(name), ...extra } });
}

async function login(name: string): Promise<string> {
	return (await call("POST", "/api/v1/auth/login", { body: { username: name, password: password(name) } })).data.token;
}

let adminToken = "";

async function configure(values: Record<string, unknown>) {
	const res = await call("PATCH", "/api/v1/admin/settings", { token: adminToken, body: { values } });
	if (res.error !== 0) throw new Error(res.info);
}

async function createInvite(body: Record<string, unknown> = {}) {
	const res = await call("POST", "/api/v1/admin/invites", { token: adminToken, body });
	if (res.error !== 0) throw new Error(res.info);
	return res.data as { uuid: string; code: string; state: string; uses: number };
}

async function mode(): Promise<string> {
	return (await call("GET", "/api/v1/auth/registration")).data.mode;
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();
	await Database`INSERT INTO settings(key, value, updated) VALUES('registrations.mode', '"closed"', ${Date.now()})`;
	const { reloadSettings } = await import("../server/settings");
	await reloadSettings();
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.registration.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("invite codes", () => {
	test("are read back regardless of case, spacing and look-alike letters", () => {
		const code = generateInviteCode();
		expect(code).toMatch(/^JOIN-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
		expect(normalizeInviteCode(code.toLowerCase().replace(/-/g, " "))).toBe(code);
		expect(normalizeInviteCode("JOIN-OOOOO-IIIII-LLLLL")).toBe("JOIN-00000-11111-11111");
		expect(normalizeInviteCode("RPAY-00000-00000-00000")).toBeNull();
		expect(normalizeInviteCode(42)).toBeNull();
	});
});

describe("registration", () => {
	test("the first account can always register and becomes the administrator", async () => {
		expect(await mode()).toBe("open");
		const res = await register("reg-admin");
		expect(res.error).toBe(0);
		adminToken = await login("reg-admin");
		const me = await call("GET", "/api/v1/admin/overview", { token: adminToken });
		expect(me.error).toBe(0);
	});

	test("closed registration refuses everyone else", async () => {
		expect(await mode()).toBe("closed");
		const res = await register("reg-closed");
		expect(res.error).toBe(1182);
		expect(res.status).toBe(403);
	});

	test("open registration accepts anyone", async () => {
		await configure({ "registrations.mode": "open" });
		expect(await mode()).toBe("open");
		expect((await register("reg-open")).error).toBe(0);
	});

	test("invite mode needs a valid code", async () => {
		await configure({ "registrations.mode": "invite" });
		expect(await mode()).toBe("invite");
		expect((await register("reg-nocode")).error).toBe(1183);
		expect((await register("reg-badcode", { invite: "JOIN-00000-00000-00000" })).error).toBe(1184);
		expect((await register("reg-garbage", { invite: "hello" })).error).toBe(1184);
	});

	test("a single use code works once", async () => {
		const invite = await createInvite({ max_uses: 1, note: "for a friend" });
		expect(invite.state).toBe("active");

		expect((await register("reg-invited", { invite: invite.code.toLowerCase() })).error).toBe(0);
		expect((await register("reg-second", { invite: invite.code })).error).toBe(1184);

		const listed = await call("GET", "/api/v1/admin/invites", { token: adminToken });
		const row = listed.data.invites.find((entry: { uuid: string }) => entry.uuid === invite.uuid);
		expect(row.uses).toBe(1);
		expect(row.state).toBe("used_up");
	});

	test("a refused registration does not use up the code", async () => {
		const invite = await createInvite({ max_uses: 1 });
		expect((await register("reg-invited", { invite: invite.code })).error).toBe(1007);
		const listed = await call("GET", "/api/v1/admin/invites", { token: adminToken });
		expect(listed.data.invites.find((entry: { uuid: string }) => entry.uuid === invite.uuid).uses).toBe(0);
	});

	test("revoked and expired codes are refused", async () => {
		const revoked = await createInvite();
		expect((await call("POST", `/api/v1/admin/invites/${revoked.uuid}/revoke`, { token: adminToken })).data.state).toBe("revoked");
		expect((await call("POST", `/api/v1/admin/invites/${revoked.uuid}/revoke`, { token: adminToken })).error).toBe(1188);
		expect((await register("reg-revoked", { invite: revoked.code })).error).toBe(1184);

		const expired = await createInvite({ expires_at: Date.now() + 60_000 });
		await Database`UPDATE registration_invites SET expires_at = ${Date.now() - 1} WHERE uuid = ${expired.uuid}`;
		expect((await register("reg-expired", { invite: expired.code })).error).toBe(1184);
	});

	test("invalid invite details are refused", async () => {
		for (const body of [{ max_uses: 0 }, { max_uses: 1.5 }, { expires_at: Date.now() - 1000 }, { note: "x".repeat(501) }]) {
			expect((await call("POST", "/api/v1/admin/invites", { token: adminToken, body })).error).toBe(1187);
		}
	});

	test("people invited to a project register with their invitation instead of a code", async () => {
		const ownerToken = await login("reg-open");
		const project = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "reg-shop", currency: "EUR" } })).data.uuid;
		const member = await call("POST", `/api/v1/projects/${project}/members`, {
			token: ownerToken,
			body: { email: "teammate@example.com", role: "viewer" },
		});
		const token = member.data.invitation_token as string;

		expect((await register("reg-stranger", { invitation: token }, "stranger@example.com")).error).toBe(1183);
		expect((await register("reg-teammate", { invitation: "x".repeat(64) }, "teammate@example.com")).error).toBe(1183);
		expect((await register("reg-teammate", { invitation: token }, "Teammate@example.com")).error).toBe(0);
	});

	test("admin endpoints need an administrator", async () => {
		const ownerToken = await login("reg-open");
		expect((await call("GET", "/api/v1/admin/invites", { token: ownerToken })).error).toBe(1098);
		expect((await call("POST", "/api/v1/admin/invites", { token: ownerToken, body: {} })).error).toBe(1098);
	});

	test("the account limit closes registration", async () => {
		await configure({ "registrations.mode": "open" });
		const [count] = (await Database`SELECT COUNT(*) AS count FROM accounts`) as { count: number }[];
		await configure({ "registrations.max_accounts": Number(count.count) + 1 });

		expect((await register("reg-last")).error).toBe(0);
		expect(await mode()).toBe("closed");
		expect((await register("reg-over")).error).toBe(1185);

		await configure({ "registrations.max_accounts": 0 });
		expect(await mode()).toBe("open");
	});
});
