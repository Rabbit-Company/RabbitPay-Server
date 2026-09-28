import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.item-keys.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { Settings } = await import("../server/settings");
const { setTransport } = await import("../server/email/mailer");
const { deliverPendingEmails } = await import("../server/email/outbox");
const { deliverPendingKeys } = await import("../server/key-delivery");
const { MAX_KEY_LENGTH, parseKeys } = await import("../server/item-keys");

await Server.configure();
Settings.email.enabled = true;

const password = (seed: string) => new Bun.CryptoHasher("blake2b512").update(seed).digest("hex");

interface ApiResponse {
	status: number;
	error: number;
	info: string;
	data?: any;
}

interface Captured {
	to: string;
	subject: string;
	text: string;
	html: string;
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
	await call("POST", "/api/v1/auth/register", { body: { username: name, email: `${name}@example.com`, password: password(name) } });
	return (await call("POST", "/api/v1/auth/login", { body: { username: name, password: password(name) } })).data.token;
}

const outbox: Captured[] = [];

setTransport({
	sendMail: async (message: Captured) => {
		outbox.push(message);
		return { messageId: `<${outbox.length}@test>` };
	},
} as never);

async function settle() {
	await deliverPendingKeys();
	await deliverPendingEmails(Date.now() + 60 * 60 * 1000);
}

let ownerToken = "";
let managerToken = "";
let apiKey = "";
let projectUuid = "";
let otherProjectUuid = "";
let customerUuid = "";
let secondCustomer = "";
let license = "";
const base = () => `/api/v1/projects/${projectUuid}`;

async function addKeys(item: string, keys: string | string[]) {
	return await call("POST", `${base()}/items/${item}/keys`, { token: ownerToken, body: { keys } });
}

async function stockOf(item: string) {
	return (await call("GET", `${base()}/items/${item}`, { token: ownerToken })).data.keys;
}

async function newItem(name: string, options: { delivers_keys?: boolean } = {}) {
	const res = await call("POST", `${base()}/items`, { token: ownerToken, body: { name, unit_price: 2500, currency: "EUR", tax_rate: 0, ...options } });
	return res.data.uuid as string;
}

async function invoiceFor(item: string, quantity: number, options: { customer?: string | null; status?: "draft" | "open" } = {}) {
	return await call("POST", `${base()}/invoices`, {
		token: ownerToken,
		body: {
			customer: options.customer === undefined ? customerUuid : options.customer,
			due_date: Date.now() + 86400000,
			status: options.status ?? "open",
			items: [{ description: "License", quantity, unit_price: 2500, item }],
		},
	});
}

async function payInFull(invoice: string) {
	const current = await call("GET", `${base()}/invoices/${invoice}`, { token: ownerToken });
	const paid = await call("POST", `${base()}/transactions`, {
		token: ownerToken,
		body: { invoice, processor: "bank_transfer", amount: current.data.total_amount },
	});
	if (paid.error !== 0) throw new Error(paid.info);
	await settle();
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	ownerToken = await account("keys-owner");
	managerToken = await account("keys-manager");

	const project = await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "keys-shop", currency: "EUR" } });
	projectUuid = project.data.uuid;
	apiKey = project.data.apikey;
	otherProjectUuid = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "keys-other", currency: "EUR" } })).data.uuid;

	await call("POST", `${base()}/members`, { token: ownerToken, body: { email: "keys-manager@example.com", role: "manager" } });

	customerUuid = (await call("POST", `${base()}/customers`, { token: ownerToken, body: { email: "buyer@example.com", name: "Buyer" } })).data.uuid;
	secondCustomer = (await call("POST", `${base()}/customers`, { token: ownerToken, body: { email: "second@example.com", name: "Second" } })).data.uuid;

	license = await newItem("Pro license");
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.item-keys.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("pasting a list of keys", () => {
	test("reads one key per line, trimming blanks and repeats", () => {
		expect(parseKeys("  AAA-1  \n\nBBB-2\r\nAAA-1\n")).toEqual(["AAA-1", "BBB-2"]);
		expect(parseKeys(["CCC-3", " ", "CCC-3"])).toEqual(["CCC-3"]);
		expect(parseKeys("")).toEqual([]);
		expect(parseKeys(7)).toBeNull();
		expect(parseKeys(["x", 7])).toBeNull();
		expect(parseKeys("x".repeat(MAX_KEY_LENGTH + 1))).toBeNull();
	});

	test("fills the stock and turns the item into a keys product", async () => {
		const before = await call("GET", `${base()}/items/${license}`, { token: ownerToken });
		expect(before.data.delivers_keys).toBe(false);
		expect(before.data.keys).toBeNull();

		const added = await addKeys(license, "  KEY-A  \n\nKEY-B\nKEY-C\nKEY-B\n");

		expect(added.status).toBe(201);
		expect(added.data.added).toBe(3);
		expect(added.data.duplicates).toBe(0);
		expect(added.data.stock).toEqual({ available: 3, reserved: 0, delivered: 0, total: 3 });

		const item = await call("GET", `${base()}/items/${license}`, { token: ownerToken });
		expect(item.data.delivers_keys).toBe(true);
		expect(item.data.keys.available).toBe(3);
	});

	test("counts a key it already holds as a duplicate rather than adding it twice", async () => {
		const again = await addKeys(license, "KEY-C\nKEY-D");

		expect(again.data.added).toBe(1);
		expect(again.data.duplicates).toBe(1);
		expect(again.data.stock.available).toBe(4);
	});

	test("refuses a paste that is not text, is empty or carries an oversized key", async () => {
		expect((await addKeys(license, "   \n  ")).error).toBe(1109);
		expect((await addKeys(license, ["x".repeat(MAX_KEY_LENGTH + 1)])).error).toBe(1109);
		expect((await call("POST", `${base()}/items/${license}/keys`, { token: ownerToken, body: { keys: 5 } })).error).toBe(1109);
	});

	test("lists the keys with their status, and hides the list from a project that does not own the item", async () => {
		const listed = await call("GET", `${base()}/items/${license}/keys`, { token: ownerToken });

		expect(listed.data.keys.map((key: any) => key.secret)).toEqual(["KEY-A", "KEY-B", "KEY-C", "KEY-D"]);
		expect(listed.data.keys.every((key: any) => key.status === "available")).toBe(true);
		expect(listed.data.stock.total).toBe(4);

		expect((await call("GET", `/api/v1/projects/${otherProjectUuid}/items/${license}/keys`, { token: ownerToken })).error).toBe(1065);
	});
});

describe("issuing an invoice for a keys product", () => {
	test("holds one key per unit sold", async () => {
		const invoice = await invoiceFor(license, 2);
		expect(invoice.error).toBe(0);

		const stock = await stockOf(license);
		expect(stock).toEqual({ available: 2, reserved: 2, delivered: 0, total: 4 });

		const held = await call("GET", `${base()}/invoices/${invoice.data.uuid}/keys`, { token: ownerToken });
		expect(held.data.reserved.map((key: any) => key.secret)).toEqual(["KEY-A", "KEY-B"]);
		expect(held.data.delivered).toEqual([]);

		await call("POST", `${base()}/invoices/${invoice.data.uuid}/cancel`, { token: ownerToken });
	});

	test("gives the keys back when the invoice is cancelled", async () => {
		expect(await stockOf(license)).toEqual({ available: 4, reserved: 0, delivered: 0, total: 4 });
	});

	test("holds nothing while the invoice is only a draft, then holds when it is issued", async () => {
		const draft = await invoiceFor(license, 1, { status: "draft" });
		expect((await stockOf(license)).reserved).toBe(0);

		await call("POST", `${base()}/invoices/${draft.data.uuid}/open`, { token: ownerToken });
		expect((await stockOf(license)).reserved).toBe(1);

		await call("POST", `${base()}/invoices/${draft.data.uuid}/cancel`, { token: ownerToken });
	});

	test("is refused once the keys run out", async () => {
		const short = await invoiceFor(license, 5);
		expect(short.error).toBe(1108);
		expect(short.status).toBe(409);

		const draft = await invoiceFor(license, 5, { status: "draft" });
		expect(draft.error).toBe(0);
		expect((await call("POST", `${base()}/invoices/${draft.data.uuid}/open`, { token: ownerToken })).error).toBe(1108);
		expect((await stockOf(license)).reserved).toBe(0);
	});

	test("is refused for a terminal sale and through an API key as well", async () => {
		const sale = await call("POST", `${base()}/pos/sales`, { token: ownerToken, body: { lines: [{ item: license, quantity: 9 }] } });
		expect(sale.error).toBe(1108);

		const raised = await call("POST", "/api/v1/pay/invoices", {
			token: apiKey,
			body: { due_date: Date.now() + 86400000, items: [{ description: "License", quantity: 9, unit_price: 2500, item: license }] },
		});
		expect(raised.error).toBe(1108);
	});

	test("leaves an item without keys alone", async () => {
		const service = await newItem("Consulting");
		const invoice = await invoiceFor(service, 50);

		expect(invoice.error).toBe(0);
	});
});

describe("paying for keys", () => {
	let invoiceUuid = "";

	test("hands them over and emails them to the customer", async () => {
		outbox.length = 0;

		const invoice = await invoiceFor(license, 2);
		invoiceUuid = invoice.data.uuid;
		await payInFull(invoiceUuid);

		const stock = await stockOf(license);
		expect(stock).toEqual({ available: 2, reserved: 0, delivered: 2, total: 4 });

		const sent = outbox.filter((message) => message.to === "buyer@example.com" && message.text.includes("KEY-A"));
		expect(sent).toHaveLength(1);
		expect(sent[0].subject).toContain("keys");
		expect(sent[0].text).toContain("KEY-B");
		expect(sent[0].html).toContain("KEY-B");
		expect(sent[0].text).toContain("Pro license");
	});

	test("records the delivery against the invoice and the customer", async () => {
		const held = await call("GET", `${base()}/invoices/${invoiceUuid}/keys`, { token: ownerToken });

		expect(held.data.reserved).toEqual([]);
		expect(held.data.delivered.map((key: any) => key.secret)).toEqual(["KEY-A", "KEY-B"]);
		expect(held.data.delivered.every((key: any) => key.recipient === "buyer@example.com")).toBe(true);
		expect(held.data.delivered.every((key: any) => key.delivered_at > 0)).toBe(true);
	});

	test("does not send the same keys twice when delivery runs again", async () => {
		outbox.length = 0;
		await settle();

		expect(outbox).toHaveLength(0);
	});

	test("never gives a key that is already sold to the next customer", async () => {
		outbox.length = 0;

		const second = await invoiceFor(license, 2, { customer: secondCustomer });
		await payInFull(second.data.uuid);

		const sent = outbox.filter((message) => message.to === "second@example.com");
		expect(sent).toHaveLength(1);
		expect(sent[0].text).toContain("KEY-C");
		expect(sent[0].text).toContain("KEY-D");
		expect(sent[0].text).not.toContain("KEY-A");

		expect(await stockOf(license)).toEqual({ available: 0, reserved: 0, delivered: 4, total: 4 });
		expect((await invoiceFor(license, 1)).error).toBe(1108);
	});

	test("shows the keys on the payment page once the invoice is paid", async () => {
		const page = await call("GET", `/api/v1/public/invoices/${invoiceUuid}`);

		expect(page.data.keys).toEqual([{ name: "Pro license", codes: ["KEY-A", "KEY-B"] }]);
		expect(page.data.keys_pending).toBe(false);
	});

	test("keeps the keys off the payment page while the invoice is unpaid", async () => {
		await addKeys(license, "KEY-E");
		const unpaid = await invoiceFor(license, 1);
		const page = await call("GET", `/api/v1/public/invoices/${unpaid.data.uuid}`);

		expect(page.data.keys).toEqual([]);
		expect(page.data.keys_pending).toBe(false);

		await call("POST", `${base()}/invoices/${unpaid.data.uuid}/cancel`, { token: ownerToken });
	});

	test("emails them again on request, to another address if needed", async () => {
		outbox.length = 0;

		const resent = await call("POST", `${base()}/invoices/${invoiceUuid}/keys/email`, { token: ownerToken, body: { to: "backup@example.com" } });
		expect(resent.status).toBe(201);
		expect(resent.data.kind).toBe("keys");

		await deliverPendingEmails(Date.now() + 60 * 60 * 1000);
		expect(outbox.some((message) => message.to === "backup@example.com" && message.text.includes("KEY-A"))).toBe(true);
	});

	test("has nothing to email when no key was handed over", async () => {
		const plain = await invoiceFor(await newItem("Workshop"), 1);

		expect((await call("POST", `${base()}/invoices/${plain.data.uuid}/keys/email`, { token: ownerToken })).error).toBe(1110);
	});

	test("hands the keys over even when there is nobody to email, as at the terminal", async () => {
		const walkIn = await newItem("Gift card");
		await addKeys(walkIn, "GIFT-1\nGIFT-2");

		const sale = await call("POST", `${base()}/pos/sales`, { token: ownerToken, body: { lines: [{ item: walkIn, quantity: 1 }] } });
		expect(sale.error).toBe(0);

		await call("POST", `${base()}/pos/sales/${sale.data.uuid}/cash`, { token: ownerToken });
		await settle();

		const held = await call("GET", `${base()}/invoices/${sale.data.uuid}/keys`, { token: ownerToken });
		expect(held.data.delivered).toHaveLength(1);
		expect(held.data.delivered[0].recipient).toBeNull();
		expect((await stockOf(walkIn)).available).toBe(1);

		outbox.length = 0;
		await call("POST", `${base()}/pos/sales/${sale.data.uuid}/email`, { token: ownerToken, body: { to: "walkin@example.com" } });
		await deliverPendingEmails(Date.now() + 60 * 60 * 1000);

		const receipt = outbox.find((message) => message.to === "walkin@example.com");
		expect(receipt?.text).toContain("GIFT-1");

		const after = await call("GET", `${base()}/invoices/${sale.data.uuid}/keys`, { token: ownerToken });
		expect(after.data.delivered[0].recipient).toBe("walkin@example.com");
	});
});

describe("removing keys", () => {
	test("takes an unsold key out of stock", async () => {
		const spare = await newItem("Spare license");
		await addKeys(spare, "SPARE-1\nSPARE-2");

		const listed = await call("GET", `${base()}/items/${spare}/keys`, { token: ownerToken });
		const removed = await call("DELETE", `${base()}/items/${spare}/keys/${listed.data.keys[0].uuid}`, { token: ownerToken });

		expect(removed.error).toBe(0);
		expect(removed.data.stock.available).toBe(1);
	});

	test("refuses to remove one that is held or already sent", async () => {
		const held = await newItem("Held license");
		await addKeys(held, "HELD-1");
		await invoiceFor(held, 1);

		const listed = await call("GET", `${base()}/items/${held}/keys`, { token: ownerToken });
		expect(listed.data.keys[0].status).toBe("reserved");

		const refused = await call("DELETE", `${base()}/items/${held}/keys/${listed.data.keys[0].uuid}`, { token: ownerToken });
		expect(refused.error).toBe(1111);
		expect(refused.status).toBe(409);

		expect((await call("DELETE", `${base()}/items/${held}/keys/${crypto.randomUUID()}`, { token: ownerToken })).error).toBe(1110);
	});
});

describe("who may see and change keys", () => {
	test("needs permission to edit items", async () => {
		const guarded = await newItem("Guarded license");
		await addKeys(guarded, "GUARD-1");

		expect((await call("GET", `${base()}/items/${guarded}/keys`, { token: managerToken })).error).toBe(0);
		expect((await addKeys(guarded, "GUARD-2")).error).toBe(0);

		const viewer = await account("keys-viewer");
		await call("POST", `${base()}/members`, { token: ownerToken, body: { email: "keys-viewer@example.com", role: "viewer" } });

		expect((await call("GET", `${base()}/items/${guarded}/keys`, { token: viewer })).error).toBe(9999);
		expect((await call("POST", `${base()}/items/${guarded}/keys`, { token: viewer, body: { keys: "NOPE" } })).error).toBe(9999);
		expect((await call("GET", `${base()}/items/${guarded}`, { token: viewer })).data.keys.available).toBe(2);
	});
});
