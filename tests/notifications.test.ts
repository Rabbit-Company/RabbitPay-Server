import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { prepareTest } from "./environment";

await prepareTest();

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { default: Auth } = await import("../server/auth");
const { Realtime } = await import("../server/realtime");
const { Settings } = await import("../server/settings");
const { setTransport } = await import("../server/email/mailer");
const { announce } = await import("../server/notifications/announce");
const { flushOverdueNotices, queueOverdueNotice } = await import("../server/notifications/sales");
const { NOTIFICATION_KIND_NAMES } = await import("../server/notifications/kinds");
const { countsTowardAllowance } = await import("../server/email/kinds");

interface Result {
	status: number;
	error: number;
	info: string;
	data: any;
}

async function call(method: string, path: string, token?: string, body?: unknown): Promise<Result> {
	const headers: Record<string, string> = {};
	if (token) headers.Authorization = `Bearer ${token}`;
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const response = await Server.app.handle(
		new Request(`http://127.0.0.1/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
	);
	return { status: response.status, ...((await response.json()) as Omit<Result, "status">) };
}

const tokens = { owner: "", anna: "", cashier: "" };
let project = "";
const path = "/auth/notifications";

async function account(username: string): Promise<string> {
	const now = Date.now();
	await Database`INSERT INTO accounts(username, email, password, created, updated, accessed) VALUES(${username}, ${`${username}@team.test`}, 'unused', ${now}, ${now}, ${now})`;
	return (await Auth.createSession(username, ""))!;
}

async function member(username: string, role: string, fullName: string) {
	const now = Date.now();
	await Database`
		INSERT INTO project_members(uuid, project_id, account_username, role, status, full_name, created, updated)
		VALUES(${crypto.randomUUID()}, ${project}, ${username}, ${role}, 'active', ${fullName}, ${now}, ${now})
	`;
}

function listen(username: string) {
	const events: any[] = [];
	const socket = { send: (data: string) => events.push(JSON.parse(data)), close() {} };
	Realtime.attach(socket, username, "");
	return { notices: () => events.filter((event) => event.type === "notification"), events, stop: () => Realtime.detach(socket) };
}

async function preference(token: string, kind: string) {
	return (await call("GET", path, token)).data.preferences.find((entry: any) => entry.kind === kind);
}

async function emailed(kind: string): Promise<string[]> {
	const rows = (await Database`SELECT recipient FROM email_messages WHERE project = ${project} AND kind = ${kind} ORDER BY recipient ASC`) as {
		recipient: string;
	}[];
	return rows.map((row) => row.recipient);
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await Server.configure();
	Settings.email.enabled = true;
	setTransport({ sendMail: async () => ({ messageId: "notifications-test" }) } as never);

	tokens.owner = await account("note-owner");
	tokens.anna = await account("note-anna");
	tokens.cashier = await account("note-cashier");
	project = (await call("POST", "/projects", tokens.owner, { name: "notify-co", currency: "EUR" })).data.uuid;
	await Database`UPDATE projects SET workforce_until = ${Date.now() + 86400000} WHERE uuid = ${project}`;
	await member("note-anna", "employee", "Anna Employee");
	await member("note-cashier", "cashier", "Cene Cashier");
});

afterAll(async () => {
	setTransport(null);
	Settings.email.enabled = false;
	await Database.close();
});

describe("notification preferences", () => {
	test("start from the defaults", async () => {
		const res = await call("GET", path, tokens.owner);
		expect(res.status).toBe(200);
		expect(res.data.preferences.map((entry: any) => entry.kind)).toEqual(NOTIFICATION_KIND_NAMES);
		expect(res.data.email_ready).toBe(true);
		Settings.email.enabled = false;
		expect((await call("GET", path, tokens.owner)).data.email_ready).toBe(false);
		Settings.email.enabled = true;
		expect(await preference(tokens.owner, "meeting_reminder")).toMatchObject({
			group: "calendar",
			browser: { enabled: true, default: true, locked: false },
			email: { enabled: false, default: false, locked: false },
		});
		expect((await preference(tokens.owner, "chat_message")).email).toBeNull();
		expect((await preference(tokens.owner, "fiscal_alert")).email).toEqual({ enabled: true, default: true, locked: true });
	});

	test("show only what a person can receive as relevant", async () => {
		expect((await preference(tokens.owner, "fiscal_alert")).relevant).toBe(true);
		expect((await preference(tokens.anna, "fiscal_alert")).relevant).toBe(false);
		expect((await preference(tokens.anna, "absence_decided")).relevant).toBe(true);
		expect((await preference(tokens.anna, "absence_requested")).relevant).toBe(false);
		expect((await preference(tokens.cashier, "invoice_paid")).relevant).toBe(false);
	});

	test("are saved per account and tell the other tabs", async () => {
		const tab = listen("note-anna");
		const res = await call("PATCH", path, tokens.anna, { changes: [{ kind: "meeting_reminder", channel: "email", enabled: true }] });
		expect(res.status).toBe(200);
		expect(res.data.preferences.find((entry: any) => entry.kind === "meeting_reminder").email.enabled).toBe(true);
		expect(tab.events).toContainEqual({ type: "notifications.changed" });
		expect((await preference(tokens.owner, "meeting_reminder")).email.enabled).toBe(false);
		tab.stop();
	});

	test("refuse locked, missing and unknown channels", async () => {
		const refused = [
			{ kind: "fiscal_alert", channel: "email", enabled: false },
			{ kind: "chat_message", channel: "email", enabled: true },
			{ kind: "payslip_ready", channel: "browser", enabled: false },
			{ kind: "meeting_reminder", channel: "sms", enabled: true },
			{ kind: "meeting_reminder", channel: "browser", enabled: "no" },
		];
		for (const change of refused) expect((await call("PATCH", path, tokens.anna, { changes: [change] })).error).toBe(1337);
		expect((await call("PATCH", path, tokens.anna, { changes: [] })).error).toBe(1337);
		expect((await call("GET", path)).status).toBe(401);
	});

	test("go back to the defaults", async () => {
		expect((await call("DELETE", path, tokens.anna)).data.preferences.find((entry: any) => entry.kind === "meeting_reminder").email.enabled).toBe(false);
		const [stored] = await Database`SELECT COUNT(*) AS count FROM notification_preferences WHERE account = 'note-anna'`;
		expect(Number(stored.count)).toBe(0);
	});
});

describe("email allowance", () => {
	test("counts the sales notifications and leaves the other team emails free", () => {
		for (const kind of ["store_order", "invoice_paid", "invoice_overdue", "invoice", "ticket_reply"] as const) expect(countsTowardAllowance(kind)).toBe(true);
		for (const kind of ["meeting_reminder", "ticket_comment", "timesheet_decided", "absence_decided", "fiscal_alert", "invitation"] as const) {
			expect(countsTowardAllowance(kind)).toBe(false);
		}
	});
});

describe("delivery", () => {
	const ticketComment = (accounts: string[]) =>
		announce({
			kind: "ticket_comment",
			project,
			accounts,
			params: { number: 7, title: "Printer", author: "Cene Cashier" },
			path: `/projects/${project}/tickets/t-1`,
			email: ({ url }) => ({ subject: "Comment", heading: "Comment", paragraphs: ["Body"], button: { label: "Open", url } }),
		});

	test("follows each person's choice for both channels", async () => {
		await call("PATCH", path, tokens.anna, {
			changes: [
				{ kind: "ticket_comment", channel: "browser", enabled: false },
				{ kind: "ticket_comment", channel: "email", enabled: true },
			],
		});
		const owner = listen("note-owner");
		const anna = listen("note-anna");
		await ticketComment(["note-owner", "note-anna"]);
		expect(owner.notices()).toMatchObject([
			{ kind: "ticket_comment", project, project_name: "notify-co", params: { number: 7 }, path: `/projects/${project}/tickets/t-1` },
		]);
		expect(anna.notices()).toEqual([]);
		expect(await emailed("ticket_comment")).toEqual(["note-anna@team.test"]);
		owner.stop();
		anna.stop();
	});

	test("keeps workforce emails behind the project switch", async () => {
		await Database`DELETE FROM email_messages WHERE project = ${project}`;
		const settings = await call("GET", `/projects/${project}/workforce`, tokens.owner);
		const saved = await call("PUT", `/projects/${project}/workforce/settings`, tokens.owner, { ...settings.data.config, email_notifications: false });
		expect(saved.status).toBe(200);
		await ticketComment(["note-anna"]);
		expect(await emailed("ticket_comment")).toEqual([]);
	});

	const invoice = (number: number) => ({ uuid: `inv-${number}`, project, reference: `2026-000${number}`, currency: "EUR" });

	test("tells the people who see invoices about an overdue invoice", async () => {
		const owner = listen("note-owner");
		const cashier = listen("note-cashier");
		await call("PATCH", path, tokens.owner, { changes: [{ kind: "invoice_overdue", channel: "email", enabled: true }] });
		queueOverdueNotice(invoice(7), 12500);
		queueOverdueNotice(invoice(7), 12500);
		expect(owner.notices()).toEqual([]);
		await flushOverdueNotices();
		expect(owner.notices()).toMatchObject([
			{
				kind: "invoice_overdue",
				variant: null,
				params: { reference: "2026-0007", amount: 12500, currency: "EUR" },
				path: `/projects/${project}/invoices/inv-7`,
			},
		]);
		expect(cashier.notices()).toEqual([]);
		expect(await emailed("invoice_overdue")).toEqual(["note-owner@team.test"]);
		owner.stop();
		cashier.stop();
	});

	test("sends one summary when several invoices go overdue together", async () => {
		await Database`DELETE FROM email_messages WHERE project = ${project}`;
		const owner = listen("note-owner");
		for (const number of [1, 2, 3, 4, 5]) queueOverdueNotice(invoice(number), number * 1000);
		await flushOverdueNotices();
		expect(owner.notices()).toMatchObject([
			{
				kind: "invoice_overdue",
				variant: "many",
				params: { count: 5, references: "2026-0001, 2026-0002, 2026-0003, ..." },
				path: `/projects/${project}/invoices?status=overdue`,
			},
		]);
		const mails = (await Database`SELECT subject, body_text FROM email_messages WHERE project = ${project} AND kind = 'invoice_overdue'`) as {
			subject: string;
			body_text: string;
		}[];
		expect(mails.length).toBe(1);
		expect(mails[0].subject).toBe("5 invoices are overdue");
		expect(mails[0].body_text).toContain("2026-0005");
		await flushOverdueNotices();
		expect(owner.notices().length).toBe(1);
		owner.stop();
	});
});
