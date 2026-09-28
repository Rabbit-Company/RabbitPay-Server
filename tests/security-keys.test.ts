import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { generateTOTP } from "@rabbit-company/totp";
import { prepareTest } from "./environment";

const databasePath = `${import.meta.dir}/.security-keys.sqlite`;
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

type CborInput = number | string | Uint8Array | Map<CborInput, CborInput>;

function cborHead(major: number, value: number): number[] {
	if (value < 24) return [(major << 5) | value];
	if (value < 0x100) return [(major << 5) | 24, value];
	if (value < 0x10000) return [(major << 5) | 25, value >> 8, value & 0xff];
	return [(major << 5) | 26, (value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function cbor(value: CborInput): Uint8Array {
	if (typeof value === "number") return new Uint8Array(value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value));
	if (typeof value === "string") {
		const text = new TextEncoder().encode(value);
		return new Uint8Array([...cborHead(3, text.length), ...text]);
	}
	if (value instanceof Uint8Array) return new Uint8Array([...cborHead(2, value.length), ...value]);
	const parts = [...value].flatMap(([key, entry]) => [...cbor(key), ...cbor(entry)]);
	return new Uint8Array([...cborHead(5, value.size), ...parts]);
}

const ORIGIN = "http://127.0.0.1:8099";
const base64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");
const sha256 = (value: Uint8Array | string) => new Uint8Array(createHash("sha256").update(value).digest());

class SoftwareAuthenticator {
	readonly credentialId = crypto.getRandomValues(new Uint8Array(32));
	readonly id = base64url(this.credentialId);
	private readonly privateKey: KeyObject;
	private readonly publicKey: KeyObject;
	counter = 0;

	constructor() {
		const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
		this.privateKey = pair.privateKey;
		this.publicKey = pair.publicKey;
	}

	private authenticatorData(flags: number, attested?: Uint8Array): Uint8Array {
		const counter = [(this.counter >>> 24) & 0xff, (this.counter >> 16) & 0xff, (this.counter >> 8) & 0xff, this.counter & 0xff];
		return new Uint8Array([...sha256("127.0.0.1"), flags, ...counter, ...(attested ?? [])]);
	}

	private clientData(type: string, challenge: string, origin: string): Uint8Array {
		return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
	}

	create(options: { challenge: string }, origin = ORIGIN) {
		const jwk = this.publicKey.export({ format: "jwk" });
		const cose = cbor(
			new Map<CborInput, CborInput>([
				[1, 2],
				[3, -7],
				[-1, 1],
				[-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
				[-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
			])
		);
		const attested = new Uint8Array([...new Uint8Array(16), 0, this.credentialId.length, ...this.credentialId, ...cose]);
		const attestationObject = cbor(
			new Map<CborInput, CborInput>([
				["fmt", "none"],
				["attStmt", new Map()],
				["authData", this.authenticatorData(0x41, attested)],
			])
		);
		return {
			id: this.id,
			rawId: this.id,
			type: "public-key",
			response: {
				clientDataJSON: base64url(this.clientData("webauthn.create", options.challenge, origin)),
				attestationObject: base64url(attestationObject),
				transports: ["usb", "bogus"],
			},
		};
	}

	get(options: { challenge: string }, increment = true) {
		if (increment) this.counter++;
		const authData = this.authenticatorData(0x01);
		const clientData = this.clientData("webauthn.get", options.challenge, ORIGIN);
		const signature = sign("sha256", new Uint8Array([...authData, ...sha256(clientData)]), this.privateKey);
		return {
			id: this.id,
			rawId: this.id,
			type: "public-key",
			response: {
				clientDataJSON: base64url(clientData),
				authenticatorData: base64url(authData),
				signature: base64url(signature),
				userHandle: null,
			},
		};
	}
}

const password = (value: string) => new Bun.CryptoHasher("blake2b512").update(value).digest("hex");
const userPassword = password("correct horse");
const adminPassword = password("admin battery");
const authenticator = new SoftwareAuthenticator();
let adminToken = "";
let userToken = "";
let recoveryCodes: string[] = [];
let totpSecret = "";

async function login(username: string, pass: string, extra: Record<string, unknown> = {}) {
	return await call("POST", "/api/v1/auth/login", { body: { username, password: pass, ...extra } });
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();
	await call("POST", "/api/v1/auth/register", { body: { username: "keys-admin", email: "keys-admin@example.com", password: adminPassword } });
	await call("POST", "/api/v1/auth/register", { body: { username: "keys-user", email: "keys-user@example.com", password: userPassword } });
	adminToken = (await login("keys-admin", adminPassword)).data.token;
	userToken = (await login("keys-user", userPassword)).data.token;
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

describe("security key registration", () => {
	test("issues creation options bound to the public URL", async () => {
		const options = await call("POST", "/api/v1/auth/two-factor/security-keys/options", { token: userToken });
		expect(options.error).toBe(0);
		expect(options.data.rp.id).toBe("127.0.0.1");
		expect(options.data.user.name).toBe("keys-user");
		expect(options.data.attestation).toBe("none");
		expect(options.data.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(options.data.pubKeyCredParams.map((param: { alg: number }) => param.alg)).toEqual([-7, -8, -257]);
	});

	test("rejects a wrong password and a credential created for another origin", async () => {
		const first = await call("POST", "/api/v1/auth/two-factor/security-keys/options", { token: userToken });
		const wrongPassword = await call("POST", "/api/v1/auth/two-factor/security-keys", {
			token: userToken,
			body: { password: password("wrong"), name: "YubiKey", credential: authenticator.create(first.data) },
		});
		expect(wrongPassword.error).toBe(1014);

		const second = await call("POST", "/api/v1/auth/two-factor/security-keys/options", { token: userToken });
		const phishing = await call("POST", "/api/v1/auth/two-factor/security-keys", {
			token: userToken,
			body: { password: userPassword, name: "YubiKey", credential: authenticator.create(second.data, "https://evil.example") },
		});
		expect(phishing.error).toBe(1231);
	});

	test("rejects a missing key name", async () => {
		const options = await call("POST", "/api/v1/auth/two-factor/security-keys/options", { token: userToken });
		const result = await call("POST", "/api/v1/auth/two-factor/security-keys", {
			token: userToken,
			body: { password: userPassword, name: " ", credential: authenticator.create(options.data) },
		});
		expect(result.error).toBe(1233);
	});

	test("enables two-factor authentication with the first key and returns recovery codes", async () => {
		const options = await call("POST", "/api/v1/auth/two-factor/security-keys/options", { token: userToken });
		const credential = authenticator.create(options.data);
		const result = await call("POST", "/api/v1/auth/two-factor/security-keys", {
			token: userToken,
			body: { password: userPassword, name: "YubiKey", credential },
		});
		expect(result.status).toBe(201);
		expect(result.data.key.name).toBe("YubiKey");
		expect(result.data.recovery_codes).toHaveLength(10);
		recoveryCodes = result.data.recovery_codes;

		const [stored] = (await Database`SELECT transports FROM account_security_keys WHERE account_username = ${"keys-user"}`) as { transports: string }[];
		expect(stored.transports).toBe("usb");

		const me = await call("GET", "/api/v1/auth/me", { token: userToken });
		expect(me.data.two_factor_enabled).toBe(true);
		expect(me.data.authenticator_enabled).toBe(false);
		expect(me.data.security_keys).toHaveLength(1);

		const excluded = await call("POST", "/api/v1/auth/two-factor/security-keys/options", { token: userToken });
		expect(excluded.data.excludeCredentials[0].id).toBe(authenticator.id);

		const replayed = await call("POST", "/api/v1/auth/two-factor/security-keys", {
			token: userToken,
			body: { password: userPassword, name: "YubiKey", credential },
		});
		expect(replayed.error).toBe(1231);
	});
});

describe("security key login", () => {
	test("offers a WebAuthn challenge after the password is valid", async () => {
		const required = await login("keys-user", userPassword);
		expect(required.error).toBe(1133);
		expect(required.data.authenticator).toBe(false);
		expect(required.data.webauthn.rpId).toBe("127.0.0.1");
		expect(required.data.webauthn.allowCredentials[0].id).toBe(authenticator.id);

		const wrongPassword = await login("keys-user", password("wrong"));
		expect(wrongPassword.error).toBe(1014);
		expect(wrongPassword.data).toBeUndefined();
	});

	test("signs in with a valid assertion and refuses to replay it", async () => {
		const required = await login("keys-user", userPassword);
		const credential = authenticator.get(required.data.webauthn);
		const valid = await login("keys-user", userPassword, { credential });
		expect(valid.error).toBe(0);
		expect(valid.data.token).toHaveLength(128);

		const replayed = await login("keys-user", userPassword, { credential });
		expect(replayed.error).toBe(1231);
	});

	test("rejects a signature counter that did not advance", async () => {
		const required = await login("keys-user", userPassword);
		const cloned = await login("keys-user", userPassword, { credential: authenticator.get(required.data.webauthn, false) });
		expect(cloned.error).toBe(1231);
	});

	test("rejects a tampered signature", async () => {
		const required = await login("keys-user", userPassword);
		const credential = authenticator.get(required.data.webauthn);
		credential.response.signature = base64url(new Uint8Array(70));
		expect((await login("keys-user", userPassword, { credential })).error).toBe(1231);
	});

	test("rejects authenticator codes without an authenticator app and still accepts recovery codes", async () => {
		expect((await login("keys-user", userPassword, { code: "000000" })).error).toBe(1134);
		expect((await login("keys-user", userPassword, { code: recoveryCodes[0] })).error).toBe(0);
	});
});

describe("combining an authenticator app with security keys", () => {
	test("adds an authenticator app without replacing recovery codes", async () => {
		const setup = await call("POST", "/api/v1/auth/two-factor/setup", { token: userToken });
		expect(setup.error).toBe(0);
		totpSecret = setup.data.secret;
		const enabled = await call("POST", "/api/v1/auth/two-factor/enable", {
			token: userToken,
			body: { password: userPassword, code: await generateTOTP(totpSecret) },
		});
		expect(enabled.error).toBe(0);
		expect(enabled.data.recovery_codes).toBeNull();

		const me = await call("GET", "/api/v1/auth/me", { token: userToken });
		expect(me.data.authenticator_enabled).toBe(true);
		expect((await login("keys-user", userPassword, { code: recoveryCodes[1] })).error).toBe(0);

		const required = await login("keys-user", userPassword);
		expect(required.data.authenticator).toBe(true);
		expect(required.data.webauthn).not.toBeNull();
	});

	test("regenerates recovery codes after confirming with a security key", async () => {
		const challenge = await call("POST", "/api/v1/auth/two-factor/security-keys/challenge", { token: userToken });
		const result = await call("POST", "/api/v1/auth/two-factor/recovery-codes", {
			token: userToken,
			body: { credential: authenticator.get(challenge.data) },
		});
		expect(result.error).toBe(0);
		expect(result.data.recovery_codes).toHaveLength(10);

		const me = await call("GET", "/api/v1/auth/me", { token: userToken });
		expect(me.data.authenticator_enabled).toBe(true);
	});

	test("does not accept a login challenge for account changes", async () => {
		const required = await login("keys-user", userPassword);
		const result = await call("POST", "/api/v1/auth/two-factor/recovery-codes", {
			token: userToken,
			body: { credential: authenticator.get(required.data.webauthn) },
		});
		expect(result.error).toBe(1231);
	});

	test("removes a key only with the password and a second factor", async () => {
		const [key] = (await call("GET", "/api/v1/auth/me", { token: userToken })).data.security_keys;
		const withoutFactor = await call("DELETE", `/api/v1/auth/two-factor/security-keys/${key.uuid}`, {
			token: userToken,
			body: { password: userPassword, code: "000000" },
		});
		expect(withoutFactor.error).toBe(1134);

		const removed = await call("DELETE", `/api/v1/auth/two-factor/security-keys/${key.uuid}`, {
			token: userToken,
			body: { password: userPassword, code: await generateTOTP(totpSecret) },
		});
		expect(removed.error).toBe(0);
		expect(removed.data.two_factor_enabled).toBe(true);

		const required = await login("keys-user", userPassword);
		expect(required.data.webauthn).toBeNull();
	});

	test("removing the authenticator app while no keys remain disables two-factor authentication", async () => {
		const options = await call("POST", "/api/v1/auth/two-factor/security-keys/options", { token: userToken });
		await call("POST", "/api/v1/auth/two-factor/security-keys", {
			token: userToken,
			body: { password: userPassword, name: "Backup key", credential: authenticator.create(options.data) },
		});

		const challenge = await call("POST", "/api/v1/auth/two-factor/security-keys/challenge", { token: userToken });
		const removed = await call("DELETE", "/api/v1/auth/two-factor/authenticator", {
			token: userToken,
			body: { password: userPassword, credential: authenticator.get(challenge.data) },
		});
		expect(removed.error).toBe(0);
		expect(removed.data.two_factor_enabled).toBe(true);

		const me = await call("GET", "/api/v1/auth/me", { token: userToken });
		expect(me.data.authenticator_enabled).toBe(false);
		expect(me.data.two_factor_enabled).toBe(true);
	});
});

describe("administrator two-factor reset", () => {
	test("is only available to administrators and not for their own account", async () => {
		expect((await call("DELETE", "/api/v1/admin/accounts/keys-user/two-factor", { token: userToken })).error).toBe(1098);
		expect((await call("DELETE", "/api/v1/admin/accounts/keys-admin/two-factor", { token: adminToken })).error).toBe(1103);
	});

	test("lists which accounts use two-factor authentication", async () => {
		const accounts = await call("GET", "/api/v1/admin/accounts", { token: adminToken });
		const user = accounts.data.accounts.find((account: { username: string }) => account.username === "keys-user");
		expect(user.two_factor_enabled).toBe(true);
	});

	test("removes every second factor so the owner can sign in with the password", async () => {
		const reset = await call("DELETE", "/api/v1/admin/accounts/keys-user/two-factor", { token: adminToken });
		expect(reset.error).toBe(0);
		expect(reset.data.two_factor_enabled).toBe(false);

		const [keys] = (await Database`SELECT COUNT(*) AS count FROM account_security_keys WHERE account_username = ${"keys-user"}`) as { count: number }[];
		expect(Number(keys.count)).toBe(0);
		expect((await login("keys-user", userPassword)).error).toBe(0);

		const [audit] = (await Database`SELECT action FROM audit_log WHERE action = ${"account.two_factor_reset"}`) as { action: string }[];
		expect(audit.action).toBe("account.two_factor_reset");
	});

	test("reports when there is nothing to reset", async () => {
		expect((await call("DELETE", "/api/v1/admin/accounts/keys-user/two-factor", { token: adminToken })).error).toBe(1136);
		expect((await call("DELETE", "/api/v1/admin/accounts/nobody/two-factor", { token: adminToken })).error).toBe(1104);
	});
});
