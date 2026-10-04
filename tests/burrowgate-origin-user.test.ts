import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createHmac } from "node:crypto";
import { unlinkSync } from "node:fs";

import { accountId, prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.burrowgate-origin-user.sqlite`);

const secret = "origin-signing-secret-for-origin-user-tests";
const { updateSettings } = await import("../server/settings");
await updateSettings({ "server.proxy": "burrowgate", "server.burrowgate_secret": secret });

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");

await Server.configure();

const password = (seed: string) => new Bun.CryptoHasher("blake2b512").update(seed).digest("hex");
const hmac = (value: string) => createHmac("sha256", secret).update(value).digest("hex");

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<{ response: Response; signature: string }> {
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = hmac([method, path, "allowlisted", "203.0.113.30", "SI", timestamp].join("\n"));
	const headers: Record<string, string> = {
		"x-burrowgate-session-id": "allowlisted",
		"x-burrowgate-client-ip": "203.0.113.30",
		"x-burrowgate-country": "SI",
		"x-burrowgate-timestamp": timestamp,
		"x-burrowgate-signature": signature,
	};
	if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
	if (options.body !== undefined) headers["Content-Type"] = "application/json";
	const response = await Server.app.handle(
		new Request(`http://127.0.0.1${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
	);
	return { response, signature };
}

function expectReported(response: Response, username: string, request: string) {
	expect(response.headers.get("x-burrowgate-origin-user")).toBe(username);
	expect(response.headers.get("x-burrowgate-origin-user-signature")).toBe(hmac(`${request}\n${username}`));
}

let token = "";

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();
	const { response: registered } = await call("POST", "/api/v1/auth/register", {
		body: { email: "bg-user@example.com", password: password("bg-user") },
	});
	expect(registered.status).toBe(201);
});

afterAll(async () => {
	await updateSettings({ "server.proxy": "direct", "server.burrowgate_secret": null });
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.burrowgate-origin-user.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("reporting the signed-in user to BurrowGate", () => {
	test("the login response names the user", async () => {
		const { response, signature } = await call("POST", "/api/v1/auth/login", { body: { email: "bg-user@example.com", password: password("bg-user") } });
		expect(response.status).toBe(200);
		token = ((await response.json()) as { data: { token: string } }).data.token;
		expectReported(response, await accountId("bg-user"), signature);
	});

	test("authenticated responses name the user and are bound to their request", async () => {
		const { response, signature } = await call("GET", "/api/v1/auth/me", { token });
		expect(response.status).toBe(200);
		expectReported(response, await accountId("bg-user"), signature);
	});

	test("anonymous and rejected requests name nobody", async () => {
		const { response: anonymous } = await call("GET", "/api/v1/auth/registration");
		expect(anonymous.status).toBe(200);
		expect(anonymous.headers.has("x-burrowgate-origin-user")).toBe(false);

		const { response: rejected } = await call("GET", "/api/v1/auth/me", { token: "not-a-real-token" });
		expect(rejected.headers.has("x-burrowgate-origin-user")).toBe(false);

		const { response: failedLogin } = await call("POST", "/api/v1/auth/login", { body: { email: "bg-user@example.com", password: password("wrong") } });
		expect(failedLogin.headers.has("x-burrowgate-origin-user")).toBe(false);
	});
});
