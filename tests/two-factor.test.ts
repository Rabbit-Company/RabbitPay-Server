import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { generateTOTP } from "@rabbit-company/totp";
import { prepareTest } from "./environment";

const databasePath = `${import.meta.dir}/.two-factor.sqlite`;
await prepareTest(`sqlite://${databasePath}`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { default: Vault } = await import("../server/crypto/vault");

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
		new Request(`http://127.0.0.1${path}`, {
			method,
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		})
	);
	return { status: response.status, ...((await response.json()) as Omit<ApiResponse, "status">) };
}

const password = (value: string) => new Bun.CryptoHasher("blake2b512").update(value).digest("hex");
let firstToken = "";
let secondToken = "";
let secret = "";
let recoveryCodes: string[] = [];

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();
	await call("POST", "/api/v1/auth/register", {
		body: { email: "two-factor-user@example.com", password: password("correct horse") },
	});
	firstToken = (
		await call("POST", "/api/v1/auth/login", {
			body: { email: "two-factor-user@example.com", password: password("correct horse") },
		})
	).data.token;
	secondToken = (
		await call("POST", "/api/v1/auth/login", {
			body: { email: "two-factor-user@example.com", password: password("correct horse") },
		})
	).data.token;
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

describe("two-factor enrollment", () => {
	test("creates a session-bound provisioning QR without enabling the account", async () => {
		const setup = await call("POST", "/api/v1/auth/two-factor/setup", { token: firstToken });
		expect(setup.error).toBe(0);
		expect(setup.data.secret).toMatch(/^[A-Z2-7]{32}$/);
		expect(setup.data.uri).toStartWith("otpauth://totp/RabbitPay:");
		expect(setup.data.uri).toContain("issuer=RabbitPay");
		expect(setup.data.qr_svg).toStartWith("<svg");
		expect(setup.data.expires_in).toBe(600);
		secret = setup.data.secret;

		const [account] = (await Database`SELECT two_factor_secret FROM accounts WHERE email = ${"two-factor-user@example.com"}`) as {
			two_factor_secret: string | null;
		}[];
		expect(account.two_factor_secret).toBeNull();
	});

	test("does not let another session confirm the pending secret", async () => {
		const result = await call("POST", "/api/v1/auth/two-factor/enable", {
			token: secondToken,
			body: { password: password("correct horse"), code: await generateTOTP(secret) },
		});
		expect(result.error).toBe(1137);
	});

	test("rejects an invalid confirmation code", async () => {
		const wrongPassword = await call("POST", "/api/v1/auth/two-factor/enable", {
			token: firstToken,
			body: { password: password("wrong"), code: await generateTOTP(secret) },
		});
		expect(wrongPassword.error).toBe(1014);

		const result = await call("POST", "/api/v1/auth/two-factor/enable", {
			token: firstToken,
			body: { password: password("correct horse"), code: "000000" },
		});
		expect(result.error).toBe(1134);
	});

	test("enables two-factor authentication and returns recovery codes once", async () => {
		const result = await call("POST", "/api/v1/auth/two-factor/enable", {
			token: firstToken,
			body: { password: password("correct horse"), code: await generateTOTP(secret) },
		});
		expect(result.error).toBe(0);
		expect(result.data.recovery_codes).toHaveLength(10);
		expect(result.data.recovery_codes[0]).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
		recoveryCodes = result.data.recovery_codes;

		const [account] = (await Database`SELECT two_factor_secret FROM accounts WHERE email = ${"two-factor-user@example.com"}`) as {
			two_factor_secret: string;
		}[];
		expect(account.two_factor_secret).not.toContain(secret);
		expect(account.two_factor_secret).not.toContain(recoveryCodes[0]);
		const stored = JSON.parse(Vault.decrypt(account.two_factor_secret));
		expect(stored.secret).toBe(secret);
		expect(stored.recovery_hashes).toHaveLength(10);

		const me = await call("GET", "/api/v1/auth/me", { token: firstToken });
		expect(me.data.two_factor_enabled).toBe(true);
	});

	test("does not start a second enrollment while enabled", async () => {
		expect((await call("POST", "/api/v1/auth/two-factor/setup", { token: firstToken })).error).toBe(1135);
	});
});

describe("two-factor login and recovery", () => {
	test("requires a second factor only after the password is valid", async () => {
		const missing = await call("POST", "/api/v1/auth/login", {
			body: { email: "two-factor-user@example.com", password: password("correct horse") },
		});
		expect(missing.error).toBe(1133);

		const wrongPassword = await call("POST", "/api/v1/auth/login", {
			body: { email: "two-factor-user@example.com", password: password("wrong") },
		});
		expect(wrongPassword.error).toBe(1014);
	});

	test("rejects a wrong code and accepts a current TOTP", async () => {
		const wrong = await call("POST", "/api/v1/auth/login", {
			body: { email: "two-factor-user@example.com", password: password("correct horse"), code: "000000" },
		});
		expect(wrong.error).toBe(1134);

		const valid = await call("POST", "/api/v1/auth/login", {
			body: { email: "two-factor-user@example.com", password: password("correct horse"), code: await generateTOTP(secret) },
		});
		expect(valid.error).toBe(0);
		expect(valid.data.token).toHaveLength(128);
	});

	test("asks for a second factor before changing the email", async () => {
		const token = (
			await call("POST", "/api/v1/auth/login", {
				body: { email: "two-factor-user@example.com", password: password("correct horse"), code: await generateTOTP(secret) },
			})
		).data.token;
		const body = { email: "two-factor-moved@example.com", password: password("correct horse") };
		expect((await call("POST", "/api/v1/auth/email", { token, body })).error).toBe(1134);
		expect((await call("POST", "/api/v1/auth/email", { token, body: { ...body, code: "000000" } })).error).toBe(1134);
		expect((await call("GET", "/api/v1/auth/me", { token })).data.email).toBe("two-factor-user@example.com");
	});

	test("consumes each recovery code exactly once", async () => {
		const body = { email: "two-factor-user@example.com", password: password("correct horse"), code: recoveryCodes[0] };
		const first = await call("POST", "/api/v1/auth/login", { body });
		expect(first.error).toBe(0);
		const reused = await call("POST", "/api/v1/auth/login", { body });
		expect(reused.error).toBe(1134);
	});

	test("regenerates recovery codes after a valid authenticator code", async () => {
		const result = await call("POST", "/api/v1/auth/two-factor/recovery-codes", {
			token: firstToken,
			body: { code: await generateTOTP(secret) },
		});
		expect(result.error).toBe(0);
		expect(result.data.recovery_codes).toHaveLength(10);
		expect(result.data.recovery_codes).not.toContain(recoveryCodes[1]);

		const oldCode = await call("POST", "/api/v1/auth/login", {
			body: { email: "two-factor-user@example.com", password: password("correct horse"), code: recoveryCodes[1] },
		});
		expect(oldCode.error).toBe(1134);
	});
});

describe("disabling two-factor authentication", () => {
	test("requires both the password and a valid second factor", async () => {
		const wrongPassword = await call("DELETE", "/api/v1/auth/two-factor", {
			token: firstToken,
			body: { password: password("wrong"), code: await generateTOTP(secret) },
		});
		expect(wrongPassword.error).toBe(1014);

		const wrongCode = await call("DELETE", "/api/v1/auth/two-factor", {
			token: firstToken,
			body: { password: password("correct horse"), code: "000000" },
		});
		expect(wrongCode.error).toBe(1134);
	});

	test("disables two-factor authentication and restores password-only login", async () => {
		const result = await call("DELETE", "/api/v1/auth/two-factor", {
			token: firstToken,
			body: { password: password("correct horse"), code: await generateTOTP(secret) },
		});
		expect(result.error).toBe(0);

		const me = await call("GET", "/api/v1/auth/me", { token: firstToken });
		expect(me.data.two_factor_enabled).toBe(false);
		const login = await call("POST", "/api/v1/auth/login", {
			body: { email: "two-factor-user@example.com", password: password("correct horse") },
		});
		expect(login.error).toBe(0);
	});
});
