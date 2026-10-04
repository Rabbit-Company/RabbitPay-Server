import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";

import { accountId, prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.invitations.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { markOverdueInvoices } = await import("../server/overdue");

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

async function account(name: string): Promise<string> {
	await call("POST", "/api/v1/auth/register", { body: { email: `${name}@example.com`, password: password(name) } });
	return (await call("POST", "/api/v1/auth/login", { body: { email: `${name}@example.com`, password: password(name) } })).data.token;
}

async function invite(email: string, role = "cashier"): Promise<string> {
	const res = await call("POST", `${base()}/members`, { token: ownerToken, body: { email, role } });
	if (res.error !== 0) throw new Error(res.info);
	return res.data.invitation_token;
}

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const found = await read();
		if (found !== undefined) return found;
		await Bun.sleep(20);
	}
	return undefined;
}

let ownerToken = "";
let projectUuid = "";
const base = () => `/api/v1/projects/${projectUuid}`;

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	ownerToken = await account("invite-owner");
	projectUuid = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "invite-shop" } })).data.uuid;
	await call("PATCH", base(), { token: ownerToken, body: { display_name: "Invite Shop" } });
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.invitations.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("invitation links", () => {
	test("anyone with the link can see what it is for", async () => {
		const token = await invite("new-cashier@example.com");
		const res = await call("GET", `/api/v1/invitations/${token}`);
		expect(res.data).toMatchObject({
			project: projectUuid,
			project_name: "Invite Shop",
			role: "cashier",
			role_name: "Cashier",
			invitation_email: "new-cashier@example.com",
			invited_by: "invite-owner@example.com",
			expired: false,
		});
	});

	test("several people can be invited before anyone accepts", async () => {
		const first = await invite("first-pending@example.com");
		const second = await invite("second-pending@example.com");
		expect(first).not.toBe(second);
	});

	test("the same address in another case is a duplicate", async () => {
		await invite("Case@Example.com");
		const res = await call("POST", `${base()}/members`, { token: ownerToken, body: { email: "case@example.com", role: "viewer" } });
		expect(res.error).toBe(1022);
	});

	test("rejects unknown and malformed tokens", async () => {
		expect((await call("GET", `/api/v1/invitations/${"a".repeat(64)}`)).error).toBe(1082);
		expect((await call("GET", "/api/v1/invitations/short")).error).toBe(1082);
		expect((await call("GET", `/api/v1/invitations/${"a".repeat(63)}!`)).error).toBe(1082);
	});

	test("accepting needs a signed in account", async () => {
		const token = await invite("anonymous@example.com");
		expect((await call("POST", `/api/v1/invitations/${token}/accept`)).error).toBe(1000);
	});

	test("a new account joins the project with the invited role", async () => {
		const token = await invite("joiner@example.com");
		const joiner = await account("invite-joiner");

		expect((await call("GET", base(), { token: joiner })).error).toBe(1020);

		const accepted = await call("POST", `/api/v1/invitations/${token}/accept`, { token: joiner });
		expect(accepted.data.account_username).toBe(await accountId("invite-joiner"));

		const project = await call("GET", base(), { token: joiner });
		expect(project.data.role).toBe("cashier");

		const members = (await call("GET", `${base()}/members`, { token: ownerToken })).data;
		const rowId = await accountId("invite-joiner");
		const row = members.find((member: any) => member.account_username === rowId);
		expect(row.status).toBe("active");
		expect(row.invitation_token).toBeNull();
		expect(row.accepted_at).not.toBeNull();
	});

	test("a link works only once", async () => {
		const token = await invite("once@example.com");
		const first = await account("invite-first");
		const second = await account("invite-second");

		expect((await call("POST", `/api/v1/invitations/${token}/accept`, { token: first })).error).toBe(0);
		expect((await call("POST", `/api/v1/invitations/${token}/accept`, { token: second })).error).toBe(1082);
		expect((await call("GET", `/api/v1/invitations/${token}`)).error).toBe(1082);
	});

	test("an existing member cannot take a second seat", async () => {
		const token = await invite("second-seat@example.com");
		expect((await call("POST", `/api/v1/invitations/${token}/accept`, { token: ownerToken })).error).toBe(1022);
		expect((await call("GET", `/api/v1/invitations/${token}`)).error).toBe(0);
	});

	test("a removed member can come back through a new link", async () => {
		const returning = await account("invite-returning");
		const first = await invite("returning@example.com");
		await call("POST", `/api/v1/invitations/${first}/accept`, { token: returning });

		const members = (await call("GET", `${base()}/members`, { token: ownerToken })).data;
		const seatId = await accountId("invite-returning");
		const seat = members.find((member: any) => member.account_username === seatId);
		await call("DELETE", `${base()}/members/${seat.uuid}`, { token: ownerToken });
		expect((await call("GET", base(), { token: returning })).error).toBe(1020);

		const second = await invite("returning-again@example.com", "viewer");
		expect((await call("POST", `/api/v1/invitations/${second}/accept`, { token: returning })).error).toBe(0);
		expect((await call("GET", base(), { token: returning })).data.role).toBe("viewer");
	});

	test("declining withdraws the link", async () => {
		const token = await invite("decliner@example.com");
		const decliner = await account("invite-decliner");

		expect((await call("POST", `/api/v1/invitations/${token}/decline`, { token: decliner })).error).toBe(0);
		expect((await call("POST", `/api/v1/invitations/${token}/accept`, { token: decliner })).error).toBe(1082);

		const members = (await call("GET", `${base()}/members`, { token: ownerToken })).data;
		expect(members.some((member: any) => member.invitation_email === "decliner@example.com")).toBe(false);
	});

	test("an expired invitation cannot be accepted", async () => {
		const token = await invite("late@example.com");
		await Database`UPDATE project_members SET expires_at = ${Date.now() - 1000} WHERE invitation_token = ${token}`;
		const late = await account("invite-late");

		expect((await call("GET", `/api/v1/invitations/${token}`)).data.expired).toBe(true);
		expect((await call("POST", `/api/v1/invitations/${token}/accept`, { token: late })).error).toBe(1082);
	});

	test("only members who manage the team see pending links", async () => {
		const pending = await invite("pending@example.com");
		const viewer = await account("invite-viewer");
		const viewerLink = await invite("viewer-seat@example.com", "viewer");
		await call("POST", `/api/v1/invitations/${viewerLink}/accept`, { token: viewer });

		const asOwner = (await call("GET", `${base()}/members`, { token: ownerToken })).data;
		expect(asOwner.find((member: any) => member.invitation_email === "pending@example.com").invitation_token).toBe(pending);

		const asViewer = (await call("GET", `${base()}/members`, { token: viewer })).data;
		expect(asViewer.every((member: any) => member.invitation_token === null)).toBe(true);
	});

	test("a link to a deleted project stops working", async () => {
		const other = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "invite-gone" } })).data.uuid;
		const token = (await call("POST", `/api/v1/projects/${other}/members`, { token: ownerToken, body: { email: "gone@example.com", role: "viewer" } })).data
			.invitation_token;
		await call("DELETE", `/api/v1/projects/${other}`, { token: ownerToken });
		expect((await call("GET", `/api/v1/invitations/${token}`)).error).toBe(1082);
	});
});

describe("overdue invoices", () => {
	const issue = async (dueDate: number, status: "open" | "draft" = "open") =>
		(
			await call("POST", `${base()}/invoices`, {
				token: ownerToken,
				body: { due_date: dueDate, status, items: [{ description: "Work", quantity: 1, unit_price: 10000 }] },
			})
		).data;

	const statusOf = async (uuid: string) => (await call("GET", `${base()}/invoices/${uuid}`, { token: ownerToken })).data.status;

	beforeAll(async () => {
		await Database`UPDATE projects SET webhook_url = 'http://127.0.0.1:9/hook' WHERE uuid = ${projectUuid}`;
	});

	test("marks open invoices past their due date and sends the webhook", async () => {
		const invoice = await issue(Date.now() + 86400000);
		expect(invoice.status).toBe("open");
		await Database`UPDATE invoices SET due_date = ${Date.now() - 1000} WHERE uuid = ${invoice.uuid}`;

		expect(await markOverdueInvoices()).toBeGreaterThanOrEqual(1);
		expect(await statusOf(invoice.uuid)).toBe("overdue");

		const delivery = await waitFor(async () => {
			const [row] = (await Database`
				SELECT payload FROM webhook_deliveries WHERE event_type = 'invoice.overdue' AND payload LIKE ${`%${invoice.uuid}%`}
			`) as { payload: string }[];
			return row;
		});
		expect(JSON.parse(delivery!.payload).data).toMatchObject({ invoice: invoice.uuid, status: "overdue", previous_status: "open" });
	});

	test("leaves invoices that are not yet due alone", async () => {
		const invoice = await issue(Date.now() + 86400000);
		await markOverdueInvoices();
		expect(await statusOf(invoice.uuid)).toBe("open");
	});

	test("leaves drafts, part paid and paid invoices alone", async () => {
		const draft = await issue(Date.now() + 86400000, "draft");
		const partial = await issue(Date.now() + 86400000);
		const paid = await issue(Date.now() + 86400000);

		await call("POST", `${base()}/transactions`, { token: ownerToken, body: { invoice: partial.uuid, processor: "cash", amount: 4000 } });
		await call("POST", `${base()}/transactions`, { token: ownerToken, body: { invoice: paid.uuid, processor: "cash", amount: 10000 } });
		await Database`UPDATE invoices SET due_date = ${Date.now() - 1000} WHERE uuid IN ${Database([draft.uuid, partial.uuid, paid.uuid])}`;

		await markOverdueInvoices();
		expect(await statusOf(draft.uuid)).toBe("draft");
		expect(await statusOf(partial.uuid)).toBe("partially_paid");
		expect(await statusOf(paid.uuid)).toBe("paid");
	});

	test("does nothing the second time", async () => {
		await markOverdueInvoices();
		expect(await markOverdueInvoices()).toBe(0);
	});

	test("an overdue invoice is found by the overdue filter", async () => {
		const res = await call("GET", `${base()}/invoices?status=overdue`, { token: ownerToken });
		expect(res.data.invoices.length).toBeGreaterThan(0);
		expect(res.data.invoices.every((invoice: any) => invoice.status === "overdue")).toBe(true);
	});
});
