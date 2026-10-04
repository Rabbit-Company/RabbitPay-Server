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

async function account(name: string): Promise<string> {
	await call("POST", "/auth/register", { body: { email: `${name}@example.com`, password: password(name) } });
	return (await call("POST", "/auth/login", { body: { email: `${name}@example.com`, password: password(name) } })).data.token;
}

function linkToken(message: { text: string }): string {
	return message.text.match(/\/account\/email#token=([A-Za-z0-9]{128})/)![1];
}

let moverToken = "";
let moverId = "";
let project = "";

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	setTransport({
		sendMail: async (message: (typeof messages)[number]) => {
			messages.push(message);
			return { messageId: "account-email-test" };
		},
	} as never);
	moverToken = await account("mail-mover");
	await account("mail-settled");
	project = (await call("POST", "/projects", { token: moverToken, body: { name: "mail-project" } })).data.uuid;
});

afterAll(async () => {
	setTransport(null);
	Settings.email.enabled = false;
	await Database.close();
});

describe("account identifiers", () => {
	test("are random, say nothing about the email and stay valid as identifiers", async () => {
		const first = await call("POST", "/auth/register", { body: { email: "twin@example.com", password: password("twin") } });
		const second = await call("POST", "/auth/register", { body: { email: "twin@example.org", password: password("twin") } });
		for (const id of [first.data.username, second.data.username]) expect(id).toMatch(/^[a-z][a-z0-9]{25}$/);
		expect(first.data.username).not.toBe(second.data.username);
		expect(first.data.username).not.toContain("twin");
		moverId = (await call("GET", "/auth/me", { token: moverToken })).data.username;
	});
});

describe("changing the email without a mail server", () => {
	test("needs the current password", async () => {
		const res = await call("POST", "/auth/email", { token: moverToken, body: { email: "mover-new@example.com", password: password("wrong") } });
		expect(res.error).toBe(1014);
	});

	test("refuses the current address and an address that already has an account", async () => {
		const same = await call("POST", "/auth/email", { token: moverToken, body: { email: "Mail-Mover@example.com", password: password("mail-mover") } });
		expect(same.error).toBe(1300);
		const taken = await call("POST", "/auth/email", { token: moverToken, body: { email: "Mail-Settled@example.com", password: password("mail-mover") } });
		expect(taken.error).toBe(1007);
	});

	test("changes right away and keeps the account, its projects and its session", async () => {
		const res = await call("POST", "/auth/email", { token: moverToken, body: { email: "Mover-New@example.com", password: password("mail-mover") } });
		expect(res.error).toBe(0);
		expect(res.data).toEqual({ email: "mover-new@example.com", pending: false });

		const me = await call("GET", "/auth/me", { token: moverToken });
		expect(me.data.username).toBe(moverId);
		expect(me.data.email).toBe("mover-new@example.com");
		expect(me.data.projects).toBe(1);

		const members = await call("GET", `/projects/${project}/members`, { token: moverToken });
		expect(members.data[0].account_email).toBe("mover-new@example.com");

		expect((await call("POST", "/auth/login", { body: { email: "mail-mover@example.com", password: password("mail-mover") } })).error).toBe(1014);
		expect((await call("POST", "/auth/login", { body: { email: "mover-new@example.com", password: password("mail-mover") } })).error).toBe(0);
	});

	test("records the change in the audit log", async () => {
		const [entry] = (await Database`SELECT account, old_value, new_value FROM audit_log WHERE action = 'account.email_changed'`) as {
			account: string;
			old_value: string;
			new_value: string;
		}[];
		expect(entry.account).toBe(moverId);
		expect(JSON.parse(entry.old_value)).toEqual({ email: "mail-mover@example.com" });
		expect(JSON.parse(entry.new_value)).toEqual({ email: "mover-new@example.com" });
	});
});

describe("changing the email with a mail server", () => {
	beforeAll(() => {
		Settings.email.enabled = true;
	});

	test("waits for the link sent to the new address", async () => {
		const res = await call("POST", "/auth/email", {
			token: moverToken,
			body: { email: "mover-final@example.com", password: password("mail-mover"), language: "sl" },
		});
		expect(res.data).toEqual({ email: "mover-final@example.com", pending: true });
		expect(messages).toHaveLength(1);
		expect(messages[0].to).toBe("mover-final@example.com");
		expect(messages[0].subject).toBe("Potrdite nov e-poštni naslov za RabbitPay");
		expect((await call("GET", "/auth/me", { token: moverToken })).data.email).toBe("mover-new@example.com");
	});

	test("rejects a link that was never issued without ending the session", async () => {
		const res = await call("POST", "/auth/email/confirm", { body: { token: "a".repeat(128) } });
		expect(res.error).toBe(1301);
		expect(res.status).toBe(400);
	});

	test("changes the email once the link is opened and tells the old address", async () => {
		const token = linkToken(messages[0]);
		const res = await call("POST", "/auth/email/confirm", { body: { token } });
		expect(res.error).toBe(0);
		expect(res.data.email).toBe("mover-final@example.com");
		expect((await call("GET", "/auth/me", { token: moverToken })).data.email).toBe("mover-final@example.com");

		expect(messages).toHaveLength(2);
		expect(messages[1].to).toBe("mover-new@example.com");
		expect(messages[1].text).toContain("mover-final@example.com");

		expect((await call("POST", "/auth/email/confirm", { body: { token } })).error).toBe(1301);
	});

	test("does not take an address that was registered while the link was waiting", async () => {
		await call("POST", "/auth/email", { token: moverToken, body: { email: "mail-late@example.com", password: password("mail-mover") } });
		await account("mail-late");
		const res = await call("POST", "/auth/email/confirm", { body: { token: linkToken(messages[2]) } });
		expect(res.error).toBe(1007);
		expect((await call("GET", "/auth/me", { token: moverToken })).data.email).toBe("mover-final@example.com");
	});
});
