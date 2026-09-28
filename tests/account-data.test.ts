import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { prepareTest } from "./environment";

const databasePath = `${import.meta.dir}/.account-data.sqlite`;
await prepareTest(`sqlite://${databasePath}`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");

await Server.configure();

interface ApiResponse {
	status: number;
	error: number;
	info: string;
	data?: any;
}

async function raw(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<Response> {
	const headers: Record<string, string> = { "User-Agent": "account-data-test" };
	if (options.token) headers.Authorization = `Bearer ${options.token}`;
	if (options.body !== undefined) headers["Content-Type"] = "application/json";
	return await Server.app.handle(
		new Request(`http://127.0.0.1${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
	);
}

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<ApiResponse> {
	const response = await raw(method, path, options);
	return { status: response.status, ...((await response.json()) as Omit<ApiResponse, "status">) };
}

const password = (value: string) => new Bun.CryptoHasher("blake2b512").update(value).digest("hex");
const tokens: Record<string, string> = {};
const projects: Record<string, string> = {};

async function account(username: string) {
	await call("POST", "/api/v1/auth/register", { body: { username, email: `${username}@example.com`, password: password("data-pass") } });
	tokens[username] = (await call("POST", "/api/v1/auth/login", { body: { username, password: password("data-pass") } })).data.token;
}

async function project(owner: string, name: string) {
	projects[name] = (await call("POST", "/api/v1/projects", { token: tokens[owner], body: { name } })).data.uuid;
}

async function addMember(projectName: string, username: string, role: string) {
	const timestamp = Date.now();
	await Database`
		INSERT INTO project_members(uuid, project_id, account_username, role, status, full_name, created, updated)
		VALUES(${crypto.randomUUID()}, ${projects[projectName]}, ${username}, ${role}, 'active', ${`${username} person`}, ${timestamp}, ${timestamp})
	`;
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();
	for (const username of ["data-admin", "data-owner", "data-colleague", "data-other"]) await account(username);
	await project("data-owner", "solo-shop");
	await project("data-owner", "team-shop");
	await project("data-other", "co-owned");
	await addMember("team-shop", "data-colleague", "accountant");
	await addMember("co-owned", "data-owner", "owner");
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${databasePath}${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("personal data export", () => {
	test("downloads the signed-in account's own data as a JSON file", async () => {
		const response = await raw("GET", "/api/v1/auth/export", { token: tokens["data-owner"] });
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="rabbitpay-data-owner-data.json"');
		expect(response.headers.get("Cache-Control")).toBe("no-store");

		const data = (await response.json()) as any;
		expect(data.account.username).toBe("data-owner");
		expect(data.account.email).toBe("data-owner@example.com");
		expect(data.account.two_factor.enabled).toBe(false);
		expect(JSON.stringify(data)).not.toContain("argon2");
		expect(data.project_memberships.map((row: { project_name: string }) => row.project_name).sort()).toEqual(["co-owned", "solo-shop", "team-shop"]);
		expect(data.changes_made.some((row: { action: string }) => row.action === "project.created")).toBe(true);
	});

	test("lets administrators export an account to answer an access request", async () => {
		const response = await raw("GET", "/api/v1/admin/accounts/data-colleague/export", { token: tokens["data-admin"] });
		expect(response.status).toBe(200);
		expect(((await response.json()) as any).account.username).toBe("data-colleague");
		expect((await call("GET", "/api/v1/admin/accounts/data-colleague/export", { token: tokens["data-other"] })).error).toBe(1098);
	});
});

describe("account deletion", () => {
	test("is blocked while the account is the only owner of a project others use", async () => {
		const plan = await call("GET", "/api/v1/admin/accounts/data-owner/deletion", { token: tokens["data-admin"] });
		expect(plan.data.shared.map((row: { name: string }) => row.name)).toEqual(["team-shop"]);
		expect(plan.data.closing.map((row: { name: string }) => row.name)).toEqual(["solo-shop"]);

		const refused = await call("DELETE", "/api/v1/admin/accounts/data-owner", { token: tokens["data-admin"], body: { confirm: "data-owner" } });
		expect(refused.error).toBe(1239);
		expect(refused.data.shared[0].name).toBe("team-shop");
	});

	test("needs the username typed as confirmation and cannot target yourself", async () => {
		await Database`UPDATE project_members SET role = 'owner' WHERE project_id = ${projects["team-shop"]} AND account_username = ${"data-colleague"}`;
		expect((await call("DELETE", "/api/v1/admin/accounts/data-owner", { token: tokens["data-admin"], body: { confirm: "data-own" } })).error).toBe(1001);
		expect((await call("DELETE", "/api/v1/admin/accounts/data-admin", { token: tokens["data-admin"], body: { confirm: "data-admin" } })).error).toBe(1103);
	});

	test("removes the account, closes its solo projects and keeps shared business records", async () => {
		await Database`UPDATE audit_log SET ip_address = '203.0.113.9' WHERE account = ${"data-owner"}`;
		const deleted = await call("DELETE", "/api/v1/admin/accounts/data-owner", { token: tokens["data-admin"], body: { confirm: "data-owner" } });
		expect(deleted.error).toBe(0);
		expect(deleted.data.closed_projects.map((row: { name: string }) => row.name)).toEqual(["solo-shop"]);

		const [account] = (await Database`SELECT username FROM accounts WHERE username = ${"data-owner"}`) as { username: string }[];
		expect(account).toBeUndefined();

		const statuses = (await Database`SELECT name, status FROM projects ORDER BY name`) as { name: string; status: string }[];
		expect(Object.fromEntries(statuses.map((row) => [row.name, row.status]))).toEqual({ "co-owned": "active", "solo-shop": "deleted", "team-shop": "active" });

		const members = (await Database`
			SELECT account_username, status, full_name FROM project_members WHERE full_name = ${"data-owner person"}
		`) as { account_username: string | null; status: string }[];
		expect(members).toEqual([{ account_username: null, status: "removed", full_name: "data-owner person" }] as never);

		const [traces] = (await Database`SELECT COUNT(*) AS count FROM audit_log WHERE ip_address = '203.0.113.9'`) as { count: number }[];
		expect(Number(traces.count)).toBe(0);

		const [recorded] = (await Database`SELECT action FROM audit_log WHERE action = 'account.deleted' AND entity_id = ${"data-owner"}`) as { action: string }[];
		expect(recorded.action).toBe("account.deleted");
	});

	test("signs the deleted account out and does not hand its session to a new account with the same name", async () => {
		expect((await call("GET", "/api/v1/auth/me", { token: tokens["data-owner"] })).error).toBe(1017);
		await call("POST", "/api/v1/auth/register", { body: { username: "data-owner", email: "someone-else@example.com", password: password("other") } });
		const reused = await call("GET", "/api/v1/auth/me", { token: tokens["data-owner"] });
		expect(reused.error).toBe(1017);
	});
});
