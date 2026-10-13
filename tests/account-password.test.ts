import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { prepareTest } from "./environment";

await prepareTest();

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { Settings } = await import("../server/settings");
const { setTransport } = await import("../server/email/mailer");

await Server.configure();

interface Result {
	status: number;
	error: number;
	info: string;
	data: any;
}

const messages: { to: string; subject: string; text: string }[] = [];
const password = (value: string) => new Bun.CryptoHasher("blake2b512").update(value).digest("hex");

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<Result> {
	const headers: Record<string, string> = {};
	if (options.token) headers.Authorization = `Bearer ${options.token}`;
	if (options.body !== undefined) headers["Content-Type"] = "application/json";
	const response = await Server.app.handle(
		new Request(`http://127.0.0.1/api/v1${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
	);
	return { status: response.status, ...((await response.json()) as Omit<Result, "status">) };
}

async function signIn(name: string, secret = name): Promise<Result> {
	return await call("POST", "/auth/login", { body: { email: `${name}@example.com`, password: password(secret) } });
}

async function account(name: string): Promise<string> {
	await call("POST", "/auth/register", { body: { email: `${name}@example.com`, password: password(name) } });
	return (await signIn(name)).data.token;
}

function linkToken(message: { text: string }): string {
	return message.text.match(/\/account\/password#token=([A-Za-z0-9]{128})/)![1];
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	Settings.security.credential_rate_limit = 1000;
	setTransport({
		sendMail: async (message: (typeof messages)[number]) => {
			messages.push(message);
			return { messageId: "account-password-test" };
		},
	} as never);
});

afterAll(async () => {
	setTransport(null);
	Settings.email.enabled = false;
	await Database.close();
});

describe("changing the password while signed in", () => {
	test("needs the current password and a different new one", async () => {
		const token = await account("key-keeper");
		const wrong = await call("POST", "/auth/password", { token, body: { password: password("guess"), new_password: password("fresh") } });
		expect(wrong.error).toBe(1014);
		const same = await call("POST", "/auth/password", { token, body: { password: password("key-keeper"), new_password: password("key-keeper") } });
		expect(same.error).toBe(1361);
		const plain = await call("POST", "/auth/password", { token, body: { password: password("key-keeper"), new_password: "not hashed" } });
		expect(plain.error).toBe(1004);
		expect((await call("POST", "/auth/password", { body: { password: password("key-keeper"), new_password: password("fresh") } })).status).toBe(401);
		expect((await signIn("key-keeper")).error).toBe(0);
	});

	test("replaces the password, keeps this device and signs out the others", async () => {
		const here = await account("key-changer");
		const elsewhere = (await signIn("key-changer")).data.token;

		const changed = await call("POST", "/auth/password", { token: here, body: { password: password("key-changer"), new_password: password("brand-new") } });
		expect(changed.error).toBe(0);

		expect((await call("GET", "/auth/me", { token: here })).error).toBe(0);
		expect((await call("GET", "/auth/me", { token: elsewhere })).status).toBe(401);
		expect((await signIn("key-changer")).error).toBe(1014);
		const again = await signIn("key-changer", "brand-new");
		expect(again.error).toBe(0);
		expect((await call("GET", "/auth/me", { token: again.data.token })).error).toBe(0);

		const [audit] = (await Database`SELECT action FROM audit_log WHERE action = 'account.password_changed'`) as { action: string }[];
		expect(audit.action).toBe("account.password_changed");
	});

	test("tells the owner by email when the server can send it", async () => {
		const token = await account("key-notified");
		Settings.email.enabled = true;
		messages.length = 0;
		await call("POST", "/auth/password", { token, body: { password: password("key-notified"), new_password: password("other"), language: "sl" } });
		Settings.email.enabled = false;
		expect(messages.length).toBe(1);
		expect(messages[0].to).toBe("key-notified@example.com");
		expect(messages[0].subject).toBe("Vaše geslo za RabbitPay je bilo spremenjeno");
	});
});

describe("resetting a forgotten password", () => {
	test("is refused when the server cannot send email", async () => {
		await account("key-stranded");
		const refused = await call("POST", "/auth/password/reset", { body: { email: "key-stranded@example.com" } });
		expect(refused.error).toBe(1363);
	});

	test("answers the same for an unknown address and sends nothing", async () => {
		Settings.email.enabled = true;
		messages.length = 0;
		const unknown = await call("POST", "/auth/password/reset", { body: { email: "nobody-here@example.com" } });
		expect(unknown.error).toBe(0);
		expect(unknown.data).toBeUndefined();
		expect(messages.length).toBe(0);
		expect((await call("POST", "/auth/password/reset", { body: { email: "not an address" } })).error).not.toBe(0);
	});

	test("sends a link that sets a new password once and signs every device out", async () => {
		const token = await account("key-forgetful");
		Settings.email.enabled = true;
		messages.length = 0;

		const asked = await call("POST", "/auth/password/reset", { body: { email: "Key-Forgetful@example.com", language: "en" } });
		expect(asked.error).toBe(0);
		expect(asked.data).toBeUndefined();
		expect(messages.length).toBe(1);
		expect(messages[0].to).toBe("key-forgetful@example.com");
		expect(messages[0].subject).toBe("Choose a new RabbitPay password");
		const link = linkToken(messages[0]);

		expect((await call("POST", "/auth/password/reset/confirm", { body: { token: link, password: "not hashed" } })).error).toBe(1004);
		const reset = await call("POST", "/auth/password/reset/confirm", { body: { token: link, password: password("remembered") } });
		expect(reset.error).toBe(0);
		expect(reset.data.email).toBe("key-forgetful@example.com");

		expect((await call("GET", "/auth/me", { token })).status).toBe(401);
		expect((await signIn("key-forgetful")).error).toBe(1014);
		expect((await signIn("key-forgetful", "remembered")).error).toBe(0);
		expect((await call("POST", "/auth/password/reset/confirm", { body: { token: link, password: password("again") } })).error).toBe(1362);
		expect(messages.at(-1)!.subject).toBe("Your RabbitPay password was changed");
	});

	test("refuses a made up link and one that is older than a password change", async () => {
		const token = await account("key-careful");
		Settings.email.enabled = true;
		messages.length = 0;
		expect((await call("POST", "/auth/password/reset/confirm", { body: { token: "a".repeat(128), password: password("x") } })).error).toBe(1362);

		await call("POST", "/auth/password/reset", { body: { email: "key-careful@example.com" } });
		const link = linkToken(messages[0]);
		await call("POST", "/auth/password", { token, body: { password: password("key-careful"), new_password: password("changed-first") } });
		expect((await call("POST", "/auth/password/reset/confirm", { body: { token: link, password: password("late") } })).error).toBe(1362);
		expect((await signIn("key-careful", "changed-first")).error).toBe(0);
	});
});
