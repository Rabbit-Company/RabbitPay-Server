import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.email.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { Settings } = await import("../server/settings");
const { setTransport } = await import("../server/email/mailer");
const { deliverPendingEmails, retryDelay } = await import("../server/email/outbox");
const { sendDueReminders } = await import("../server/email/messages");
const { DAY, reminderDue } = await import("../server/email/reminders");
const { creditNoteEmail, emailDate, escapeHtml, invitationEmail, invoiceEmail, money, receiptEmail } = await import("../server/email/templates");

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
	from: { name: string; address: string };
	to: string;
	replyTo?: string;
	subject: string;
	text: string;
	html: string;
	attachments?: { filename: string; contentType: string; content: Buffer }[];
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
let failWith: string | null = null;

setTransport({
	sendMail: async (message: Captured) => {
		if (failWith) throw new Error(failWith);
		outbox.push(message);
		return { messageId: `<${outbox.length}@test>` };
	},
} as never);

async function flush() {
	await Bun.sleep(5);
	await deliverPendingEmails(Date.now() + 10 * 60 * 60 * 1000);
}

let ownerToken = "";
let viewerToken = "";
let cashierToken = "";
let otherCashierToken = "";
let projectUuid = "";
let customerUuid = "";
let itemUuid = "";
const base = () => `/api/v1/projects/${projectUuid}`;

async function issue(options: { dueDate?: number; customer?: string | null; status?: "open" | "draft" } = {}) {
	const res = await call("POST", `${base()}/invoices`, {
		token: ownerToken,
		body: {
			customer: options.customer === undefined ? customerUuid : options.customer,
			due_date: options.dueDate ?? Date.now() + 14 * DAY,
			status: options.status ?? "open",
			items: [{ description: "Design <work>", quantity: 2, unit_price: 5000, tax_rate: 22 }],
		},
	});
	if (res.error !== 0) throw new Error(res.info);
	return res.data;
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	ownerToken = await account("mail-owner");
	viewerToken = await account("mail-viewer");
	cashierToken = await account("mail-cashier");
	otherCashierToken = await account("mail-cashier-two");

	projectUuid = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "mail-studio", currency: "EUR" } })).data.uuid;
	await call("PATCH", base(), { token: ownerToken, body: { display_name: "Studio <Nord>", language: "en" } });
	await call("PUT", `${base()}/company`, { token: ownerToken, body: { legal_name: "Studio Nord d.o.o.", email: "hello@studio.example", city: "Ljubljana" } });

	for (const [email, role] of [
		["mail-viewer@example.com", "viewer"],
		["mail-cashier@example.com", "cashier"],
		["mail-cashier-two@example.com", "cashier"],
	]) {
		await call("POST", `${base()}/members`, { token: ownerToken, body: { email, role } });
	}

	customerUuid = (await call("POST", `${base()}/customers`, { token: ownerToken, body: { email: "client@example.com", name: "Client" } })).data.uuid;
	itemUuid = (await call("POST", `${base()}/items`, { token: ownerToken, body: { name: "Latte", unit_price: 300, currency: "EUR", tax_rate: 0 } })).data.uuid;
	await flush();
});

beforeEach(async () => {
	failWith = null;
	await flush();
	outbox.length = 0;
});

afterAll(async () => {
	setTransport(null);
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.email.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("templates", () => {
	const brand = {
		merchant: "Shop <b>",
		language: "en",
		accent: null,
		dateFormat: "yyyy-mm-dd" as const,
		replyTo: null,
		address: ["Main 1"],
		whiteLabel: false,
		logoUrl: null,
	};
	const facts = { reference: "R-1", currency: "EUR", total: 12200, tax: 2200, outstanding: 12200, dueDate: Date.UTC(2026, 9, 1, 12), paid: false };

	test("escapes everything that comes from users", () => {
		const content = invoiceEmail(
			brand,
			"invoice",
			facts,
			[{ description: "<img src=x>", quantity: 1, gross: 12200 }],
			"https://pay.example/a?b=1&c=2",
			"Hi <there>"
		);
		expect(content.html).not.toContain("<img src=x>");
		expect(content.html).not.toContain("Shop <b>");
		expect(content.html).toContain("&lt;img src=x&gt;");
		expect(content.html).toContain("https://pay.example/a?b=1&amp;c=2");
		expect(content.text).toContain("<img src=x>");
		expect(escapeHtml(`"'`)).toBe("&quot;&#39;");
	});

	test("an invoice email has the amount, due date and pay link", () => {
		const content = invoiceEmail(brand, "invoice", facts, [], "https://pay.example/x", null);
		expect(content.subject).toBe("Invoice R-1 from Shop <b>");
		expect(content.text).toContain("€122.00");
		expect(content.text).toContain("2026-10-01");
		expect(content.text).toContain("https://pay.example/x");
		expect(content.text).not.toContain("Reply to this email");
	});

	test("reminders talk about what is still unpaid", () => {
		const before = invoiceEmail(brand, "reminder_before", { ...facts, outstanding: 5000 }, [], "u", null);
		const after = invoiceEmail({ ...brand, replyTo: "a@b.c" }, "reminder_after", { ...facts, outstanding: 5000 }, [], "u", null);
		expect(before.subject).toBe("Reminder: invoice R-1 is due 2026-10-01");
		expect(before.text).toContain("€50.00");
		expect(after.subject).toBe("Overdue: invoice R-1 from Shop <b>");
		expect(after.text).toContain("already paid");
		expect(after.text).toContain("Reply to this email");
	});

	test("writes Slovenian for Slovenian projects", () => {
		const content = receiptEmail({ ...brand, language: "sl" }, { reference: "R-2", currency: "EUR", total: 1250, tax: 225, paidAt: facts.dueDate }, [], "u");
		expect(content.subject).toBe("Račun R-2 od Shop <b>");
		expect(content.text).toContain("Vključen DDV");
		expect(money(1250, "EUR", "sl")).toMatch(/^12,50\s€$/);
		expect(invitationEmail({ ...brand, language: "sl" }, { inviter: "ana", role: "cashier", url: "u" }).text).toContain("kot Blagajnik");
	});

	test("an automatic date follows the project language", () => {
		const day = Date.UTC(2026, 9, 1, 12);
		expect(emailDate(day, { dateFormat: "auto", language: "sl" })).toBe("1. oktober 2026");
		expect(emailDate(day, { dateFormat: "auto", language: "en" })).toBe("1 October 2026");
		expect(emailDate(day, { dateFormat: "dd.mm.yyyy", language: "en" })).toBe("01.10.2026");
	});

	test("without a pay link the email carries bank details and mentions the attachment", () => {
		const bank = {
			account: { iban: "SI56191000000123438", bic: "DBSISI2X", holder: "Shop d.o.o.", bank_name: null },
			reference: "SI00 R-1",
			amount: 12200,
			currency: "EUR",
			qr: null,
			qr_unavailable: null,
		};
		const content = invoiceEmail(brand, "invoice", facts, [], null, null, { bank, attached: true });
		expect(content.text).toContain("SI56 1910 0000 0123 438");
		expect(content.text).toContain("SI00 R-1");
		expect(content.text).toContain("attached to this email as a PDF");
		expect(content.text).not.toContain("View and pay");
		expect(content.html).not.toContain("If the button does not work");
	});

	test("labels what the customer owes and how urgent it is", () => {
		const fresh = invoiceEmail(brand, "invoice", facts, [], "u", null);
		const overdue = invoiceEmail(brand, "reminder_after", { ...facts, outstanding: 5000 }, [], "u", null);
		const paid = invoiceEmail(brand, "invoice", { ...facts, paid: true }, [], null, null);

		expect(fresh.text).toContain("Due: €122.00");
		expect(fresh.html).toContain("€122.00 | Due: 2026-10-01");
		expect(overdue.text).toContain("Due: €50.00 (Overdue)");
		expect(overdue.html).toContain("Overdue");
		expect(paid.text).toContain("Total: €122.00 (Paid)");
		expect(paid.text).not.toContain("Due: 2026-10-01");
	});

	test("does not double the full stop after a company name that ends in one", () => {
		const content = receiptEmail(
			{ ...brand, merchant: "Shop d.o.o." },
			{ reference: "R-3", currency: "EUR", total: 100, tax: 0, paidAt: facts.dueDate },
			[],
			"u"
		);
		expect(content.text).toContain("Here is your receipt from Shop d.o.o.\n");
		expect(content.text).not.toContain("d.o.o..");

		const message = invoiceEmail(brand, "invoice", facts, [], "u", "See you soon...");
		expect(message.text).toContain("See you soon...");
	});

	test("formats currencies without cents", () => {
		expect(money(1500, "JPY", "en")).toBe("JP¥1,500");
	});
});

describe("reminder timing", () => {
	const now = 100 * DAY;
	const rules = { daysBefore: 3, daysAfter: 3 };
	const none = { before: 0, after: 0 };

	test("sends one reminder in the days before the due date", () => {
		expect(reminderDue({ dueDate: now + 4 * DAY, issuedAt: 0, outstanding: 1 }, rules, none, now)).toBeNull();
		expect(reminderDue({ dueDate: now + 2 * DAY, issuedAt: 0, outstanding: 1 }, rules, none, now)).toBe("reminder_before");
		expect(reminderDue({ dueDate: now + 2 * DAY, issuedAt: 0, outstanding: 1 }, rules, { before: 1, after: 0 }, now)).toBeNull();
	});

	test("does not remind about an invoice issued in the last day", () => {
		expect(reminderDue({ dueDate: now + DAY, issuedAt: now - DAY / 2, outstanding: 1 }, rules, none, now)).toBeNull();
	});

	test("repeats after the due date up to three times", () => {
		const invoice = { dueDate: now - 3 * DAY, issuedAt: 0, outstanding: 1 };
		expect(reminderDue({ ...invoice, dueDate: now - 2 * DAY }, rules, none, now)).toBeNull();
		expect(reminderDue(invoice, rules, none, now)).toBe("reminder_after");
		expect(reminderDue(invoice, rules, { before: 1, after: 1 }, now)).toBeNull();
		expect(reminderDue({ ...invoice, dueDate: now - 6 * DAY }, rules, { before: 1, after: 1 }, now)).toBe("reminder_after");
		expect(reminderDue({ ...invoice, dueDate: now - 90 * DAY }, rules, { before: 1, after: 3 }, now)).toBeNull();
	});

	test("zero days turns a reminder off and paid invoices are skipped", () => {
		expect(reminderDue({ dueDate: now + DAY, issuedAt: 0, outstanding: 1 }, { daysBefore: 0, daysAfter: 3 }, none, now)).toBeNull();
		expect(reminderDue({ dueDate: now - 9 * DAY, issuedAt: 0, outstanding: 1 }, { daysBefore: 3, daysAfter: 0 }, none, now)).toBeNull();
		expect(reminderDue({ dueDate: now - 9 * DAY, issuedAt: 0, outstanding: 0 }, rules, none, now)).toBeNull();
	});

	test("backs off between retries", () => {
		expect(retryDelay(1)).toBe(30000);
		expect(retryDelay(2)).toBe(60000);
		expect(retryDelay(20)).toBe(3600000);
	});
});

describe("emailing an invoice", () => {
	test("goes to the customer with the pay link and reply address", async () => {
		const invoice = await issue();
		const res = await call("POST", `${base()}/invoices/${invoice.uuid}/email`, { token: ownerToken, body: { message: "Thanks for the project" } });
		expect(res.status).toBe(201);
		expect(res.data).toMatchObject({ kind: "invoice", recipient: "client@example.com", sent_by: "mail-owner" });
		expect(["pending", "sent"]).toContain(res.data.status);

		await flush();
		expect(outbox).toHaveLength(1);
		const [sent] = outbox;
		expect(sent.to).toBe("client@example.com");
		expect(sent.from).toEqual({ name: "Studio <Nord>", address: "billing@rabbitpay.test" });
		expect(sent.replyTo).toBe("hello@studio.example");
		expect(sent.subject).toBe(`Invoice ${invoice.reference} from Studio <Nord>`);
		expect(sent.text).toContain(`http://127.0.0.1:8099/pay/${invoice.uuid}`);
		expect(sent.text).toContain("http://127.0.0.1:8099/customer");
		expect(sent.text).toContain("Open customer portal");
		expect(sent.text).toContain("Thanks for the project");
		expect(sent.text).toContain("2 x Design <work>");
		expect(sent.text).toContain("Studio Nord d.o.o.");
		expect(sent.html).toContain("Design &lt;work&gt;");

		const history = await call("GET", `${base()}/invoices/${invoice.uuid}/emails`, { token: ownerToken });
		expect(history.data).toHaveLength(1);
		expect(history.data[0].status).toBe("sent");
		expect(history.data[0].sent_at).not.toBeNull();
		expect(history.data[0].body_html).toBeUndefined();
	});

	test("can go to another address and be sent as a reminder", async () => {
		const invoice = await issue({ dueDate: Date.now() - DAY });
		const res = await call("POST", `${base()}/invoices/${invoice.uuid}/email`, { token: ownerToken, body: { to: "boss@example.com", reminder: true } });
		expect(res.data.kind).toBe("reminder_after");
		await flush();
		expect(outbox[0].to).toBe("boss@example.com");
		expect(outbox[0].subject).toStartWith("Overdue");
	});

	test("refuses drafts, canceled invoices and missing or bad addresses", async () => {
		const draft = await issue({ status: "draft" });
		expect((await call("POST", `${base()}/invoices/${draft.uuid}/email`, { token: ownerToken, body: {} })).error).toBe(1044);

		const canceled = await issue();
		await call("POST", `${base()}/invoices/${canceled.uuid}/cancel`, { token: ownerToken });
		expect((await call("POST", `${base()}/invoices/${canceled.uuid}/email`, { token: ownerToken, body: {} })).error).toBe(1042);

		const anonymous = await issue({ customer: null });
		expect((await call("POST", `${base()}/invoices/${anonymous.uuid}/email`, { token: ownerToken, body: {} })).error).toBe(1084);
		expect((await call("POST", `${base()}/invoices/${anonymous.uuid}/email`, { token: ownerToken, body: { to: "nope" } })).error).toBe(1009);
	});

	test("a reminder needs something left to pay", async () => {
		const invoice = await issue();
		await call("POST", `${base()}/transactions`, { token: ownerToken, body: { invoice: invoice.uuid, processor: "cash", amount: invoice.total_amount } });
		expect((await call("POST", `${base()}/invoices/${invoice.uuid}/email`, { token: ownerToken, body: { reminder: true } })).error).toBe(1050);
		expect((await call("POST", `${base()}/invoices/${invoice.uuid}/email`, { token: ownerToken, body: {} })).error).toBe(0);
		await flush();
		expect(outbox[0].text).toContain("already paid");
	});

	test("a viewer can read the history but not send", async () => {
		const invoice = await issue();
		expect((await call("POST", `${base()}/invoices/${invoice.uuid}/email`, { token: viewerToken, body: {} })).error).toBe(9999);
		expect((await call("GET", `${base()}/invoices/${invoice.uuid}/emails`, { token: viewerToken })).error).toBe(0);
	});

	test("stops after twenty emails for one invoice", async () => {
		const invoice = await issue();
		for (let index = 0; index < 20; index++) {
			expect((await call("POST", `${base()}/invoices/${invoice.uuid}/email`, { token: ownerToken, body: {} })).error).toBe(0);
		}
		expect((await call("POST", `${base()}/invoices/${invoice.uuid}/email`, { token: ownerToken, body: {} })).error).toBe(1085);
	});
});

describe("invoice email options", () => {
	test("settings default to a link without an attachment and are validated", async () => {
		const current = await call("GET", base(), { token: ownerToken });
		expect(current.data).toMatchObject({ email_attach_invoice: false, email_pay_link: true, email_portal_link: true });
		expect((await call("PATCH", base(), { token: ownerToken, body: { email_attach_invoice: "yes" } })).error).toBe(1001);
		expect((await call("PATCH", base(), { token: ownerToken, body: { email_pay_link: 0 } })).error).toBe(1001);
		expect((await call("PATCH", base(), { token: ownerToken, body: { email_portal_link: "yes" } })).error).toBe(1001);
		expect((await call("PATCH", base(), { token: viewerToken, body: { email_pay_link: false } })).error).toBe(9999);
	});

	test("attaches the invoice as a PDF and drops the stored copy once sent", async () => {
		const invoice = await issue();
		const res = await call("POST", `${base()}/invoices/${invoice.uuid}/email`, { token: ownerToken, body: { attach_invoice: true } });
		expect(res.status).toBe(201);
		expect(res.data.attachment).toBe(`Invoice ${invoice.reference}.pdf`);
		const [queued] = (await Database`SELECT attachment_data, attachment_storage_key FROM email_messages WHERE uuid = ${res.data.uuid}`) as {
			attachment_data: string | null;
			attachment_storage_key: string | null;
		}[];
		expect(queued.attachment_data).toBeNull();
		expect(queued.attachment_storage_key).not.toBeNull();

		await flush();
		const [sent] = outbox;
		expect(sent.attachments).toHaveLength(1);
		expect(sent.attachments![0].filename).toBe(`Invoice ${invoice.reference}.pdf`);
		expect(sent.attachments![0].contentType).toBe("application/pdf");
		expect(sent.attachments![0].content.subarray(0, 5).toString()).toBe("%PDF-");
		expect(sent.text).toContain("attached to this email as a PDF");
		expect(sent.text).toContain(`/pay/${invoice.uuid}`);

		const [stored] = (await Database`SELECT attachment_name, attachment_data FROM email_messages WHERE uuid = ${res.data.uuid}`) as {
			attachment_name: string;
			attachment_data: string | null;
		}[];
		expect(stored.attachment_name).toBe(`Invoice ${invoice.reference}.pdf`);
		expect(stored.attachment_data).toBeNull();
	});

	test("leaves out the pay link and shows bank details instead", async () => {
		const bank = await call("PUT", `${base()}/processors/bank_transfer`, {
			token: ownerToken,
			body: { enabled: true, config: { iban: "SI56 1910 0000 0123 438", account_holder: "Studio Nord d.o.o." } },
		});
		expect(bank.error).toBe(0);
		try {
			const invoice = await issue();
			const res = await call("POST", `${base()}/invoices/${invoice.uuid}/email`, { token: ownerToken, body: { pay_link: false, attach_invoice: false } });
			expect(res.status).toBe(201);
			expect(res.data.attachment).toBeNull();

			await flush();
			const [sent] = outbox;
			expect(sent.attachments).toBeUndefined();
			expect(sent.text).not.toContain("/pay/");
			expect(sent.text).toContain("Pay by bank transfer");
			expect(sent.text).toContain("SI56 1910 0000 0123 438");
			expect(sent.text).toContain(invoice.reference);
		} finally {
			await call("PUT", `${base()}/processors/bank_transfer`, { token: ownerToken, body: { enabled: false } });
		}
	});

	test("project settings decide for emails sent without a choice", async () => {
		const saved = await call("PATCH", base(), {
			token: ownerToken,
			body: { email_attach_invoice: true, email_pay_link: false, email_portal_link: false },
		});
		expect(saved.data).toMatchObject({ email_attach_invoice: true, email_pay_link: false, email_portal_link: false });
		try {
			const invoice = await issue();
			await call("POST", `${base()}/invoices/${invoice.uuid}/email`, { token: ownerToken, body: {} });
			await flush();
			const [sent] = outbox;
			expect(sent.attachments?.[0].filename).toBe(`Invoice ${invoice.reference}.pdf`);
			expect(sent.text).not.toContain("/pay/");
			expect(sent.text).not.toContain("/customer");
		} finally {
			await call("PATCH", base(), { token: ownerToken, body: { email_attach_invoice: false, email_pay_link: true, email_portal_link: true } });
		}
	});
});

describe("invoice PDF downloads", () => {
	async function fetchPdf(path: string, token?: string): Promise<Response> {
		return await Server.app.handle(new Request(`http://127.0.0.1${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }));
	}

	test("staff with view access download the invoice as a named PDF", async () => {
		const invoice = await issue();
		for (const token of [ownerToken, viewerToken]) {
			const res = await fetchPdf(`${base()}/invoices/${invoice.uuid}/pdf`, token);
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toBe("application/pdf");
			expect(res.headers.get("Cache-Control")).toBe("no-store");
			expect(res.headers.get("Content-Disposition")).toBe(
				`attachment; filename="Invoice ${invoice.reference}.pdf"; filename*=UTF-8''${encodeURIComponent(`Invoice ${invoice.reference}.pdf`)}`
			);
			expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
		}

		const anonymous = await fetchPdf(`${base()}/invoices/${invoice.uuid}/pdf`);
		expect(((await anonymous.json()) as { error: number }).error).toBe(1000);
	});

	test("customers download it from the public link, but never a draft", async () => {
		const invoice = await issue();
		const res = await fetchPdf(`/api/v1/public/invoices/${invoice.uuid}/pdf`);
		expect(res.status).toBe(200);
		expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 5))).toBe("%PDF-");

		const draft = await issue({ status: "draft" });
		const hidden = await fetchPdf(`/api/v1/public/invoices/${draft.uuid}/pdf`);
		expect(hidden.headers.get("Content-Type")).not.toBe("application/pdf");
		expect(((await fetchPdf("/api/v1/public/invoices/not-a-uuid/pdf").then((r) => r.json())) as { error: number }).error).not.toBe(0);
	});
});

describe("credit notes and receipts", () => {
	test("a credit note email shows negative amounts without quantities", () => {
		const brand = {
			merchant: "Shop",
			language: "en",
			accent: null,
			dateFormat: "yyyy-mm-dd" as const,
			replyTo: null,
			address: [],
			whiteLabel: false,
			logoUrl: null,
		};
		const content = creditNoteEmail(
			brand,
			{ reference: "CN-1", invoiceReference: "R-1", currency: "EUR", total: 12200, tax: 2200, issuedAt: Date.UTC(2026, 9, 1) },
			[{ description: "Design", quantity: null, gross: 12200 }],
			null,
			{ attached: true }
		);
		expect(content.subject).toBe("Credit note CN-1 from Shop");
		expect(content.text).toContain("correcting invoice R-1");
		expect(content.text).toContain("Design  -€122.00");
		expect(content.text).not.toContain(" x Design");
		expect(content.text).toContain("credit note is attached");
	});

	test("a credit note is emailed with its PDF and shows in the invoice history", async () => {
		const invoice = await issue();
		const note = (await call("POST", `${base()}/invoices/${invoice.uuid}/credit-notes`, { token: ownerToken, body: {} })).data;
		expect(note.reference).toBeTruthy();

		expect((await call("POST", `${base()}/credit-notes/${note.uuid}/email`, { token: viewerToken, body: {} })).error).toBe(9999);

		const res = await call("POST", `${base()}/credit-notes/${note.uuid}/email`, { token: ownerToken, body: { attach_invoice: true, message: "Sorry" } });
		expect(res.status).toBe(201);
		expect(res.data).toMatchObject({ kind: "credit_note", recipient: "client@example.com", attachment: `Credit note ${note.reference}.pdf` });

		await flush();
		const [sent] = outbox;
		expect(sent.subject).toBe(`Credit note ${note.reference} from Studio <Nord>`);
		expect(sent.text).toContain(`correcting invoice ${invoice.reference}`);
		expect(sent.text).toContain("Sorry");
		expect(sent.text).toContain("/customer");
		expect(sent.attachments?.[0].filename).toBe(`Credit note ${note.reference}.pdf`);
		expect(sent.attachments?.[0].content.subarray(0, 5).toString()).toBe("%PDF-");

		const history = await call("GET", `${base()}/invoices/${invoice.uuid}/emails`, { token: ownerToken });
		expect(history.data.map((email: { kind: string }) => email.kind)).toContain("credit_note");
	});

	test("a credit note PDF downloads for anyone who can view invoices", async () => {
		const invoice = await issue();
		const note = (await call("POST", `${base()}/invoices/${invoice.uuid}/credit-notes`, { token: ownerToken, body: {} })).data;
		const res = await Server.app.handle(
			new Request(`http://127.0.0.1${base()}/credit-notes/${note.uuid}/pdf`, { headers: { Authorization: `Bearer ${viewerToken}` } })
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/pdf");
		expect(res.headers.get("Content-Disposition")).toContain(`filename="Credit note ${note.reference}.pdf"`);
	});

	test("a terminal receipt carries the PDF when asked or when the project attaches by default", async () => {
		const sale = (await call("POST", `${base()}/pos/sales`, { token: cashierToken, body: { lines: [{ item: itemUuid }] } })).data;
		await call("POST", `${base()}/pos/sales/${sale.uuid}/cash`, { token: cashierToken, body: {} });

		await call("POST", `${base()}/pos/sales/${sale.uuid}/email`, { token: cashierToken, body: { to: "shopper@example.com", attach_invoice: true } });
		await flush();
		expect(outbox[0].attachments?.[0].filename).toBe(`Invoice ${sale.reference}.pdf`);
		expect(outbox[0].text).toContain("receipt is attached");

		outbox.length = 0;
		await call("POST", `${base()}/pos/sales/${sale.uuid}/email`, { token: cashierToken, body: { to: "shopper@example.com" } });
		await flush();
		expect(outbox[0].attachments).toBeUndefined();

		await call("PATCH", base(), { token: ownerToken, body: { email_attach_invoice: true } });
		try {
			outbox.length = 0;
			await call("POST", `${base()}/pos/sales/${sale.uuid}/email`, { token: cashierToken, body: { to: "shopper@example.com" } });
			await flush();
			expect(outbox[0].attachments?.[0].filename).toBe(`Invoice ${sale.reference}.pdf`);
		} finally {
			await call("PATCH", base(), { token: ownerToken, body: { email_attach_invoice: false } });
		}
	});
});

describe("delivery", () => {
	test("retries a failed email later and gives up after the last attempt", async () => {
		const invoice = await issue();
		failWith = "Connection refused";
		const queued = (await call("POST", `${base()}/invoices/${invoice.uuid}/email`, { token: ownerToken, body: {} })).data;
		await Bun.sleep(5);
		await deliverPendingEmails();

		let [row] = (await Database`SELECT * FROM email_messages WHERE uuid = ${queued.uuid}`) as any[];
		expect(row.status).toBe("pending");
		expect(row.attempts).toBe(1);
		expect(row.last_error).toBe("Connection refused");
		expect(row.next_attempt_at).toBeGreaterThan(Date.now() + 20000);

		await deliverPendingEmails(Date.now());
		[row] = (await Database`SELECT * FROM email_messages WHERE uuid = ${queued.uuid}`) as any[];
		expect(row.attempts).toBe(1);

		await flush();
		await flush();
		[row] = (await Database`SELECT * FROM email_messages WHERE uuid = ${queued.uuid}`) as any[];
		expect(row.status).toBe("failed");
		expect(row.attempts).toBe(3);
		expect(row.next_attempt_at).toBeNull();

		failWith = null;
		await flush();
		expect(outbox).toHaveLength(0);
	});

	test("a later success clears the error", async () => {
		const invoice = await issue();
		failWith = "Temporary failure";
		const queued = (await call("POST", `${base()}/invoices/${invoice.uuid}/email`, { token: ownerToken, body: {} })).data;
		await flush();
		failWith = null;
		await flush();

		const [row] = (await Database`SELECT * FROM email_messages WHERE uuid = ${queued.uuid}`) as any[];
		expect(row.status).toBe("sent");
		expect(row.attempts).toBe(3);
		expect(row.last_error).toBeNull();
	});
});

describe("invitation emails", () => {
	test("inviting someone without an account emails them the link", async () => {
		const res = await call("POST", `${base()}/members`, { token: ownerToken, body: { email: "new-hire@example.com", role: "cashier" } });
		expect(res.data.email_queued).toBe(true);

		await flush();
		expect(outbox).toHaveLength(1);
		expect(outbox[0].to).toBe("new-hire@example.com");
		expect(outbox[0].subject).toBe("mail-owner invited you to Studio <Nord>");
		expect(outbox[0].text).toContain(`http://127.0.0.1:8099/invite/${res.data.invitation_token}`);
		expect(outbox[0].text).toContain("as Cashier");
	});

	test("adding an existing account sends nothing", async () => {
		await account("mail-existing");
		const res = await call("POST", `${base()}/members`, { token: ownerToken, body: { email: "mail-existing@example.com", role: "viewer" } });
		expect(res.data.email_queued).toBe(false);
		await flush();
		expect(outbox).toHaveLength(0);
	});

	test("the link can be emailed again a few times", async () => {
		const invited = (await call("POST", `${base()}/members`, { token: ownerToken, body: { email: "again@example.com", role: "viewer" } })).data;
		for (let index = 0; index < 4; index++) {
			expect((await call("POST", `${base()}/members/${invited.uuid}/invitation-email`, { token: ownerToken })).error).toBe(0);
		}
		expect((await call("POST", `${base()}/members/${invited.uuid}/invitation-email`, { token: ownerToken })).error).toBe(1085);
		expect((await call("POST", `${base()}/members/${invited.uuid}/invitation-email`, { token: viewerToken })).error).toBe(9999);
	});

	test("an accepted invitation cannot be emailed again", async () => {
		const invited = (await call("POST", `${base()}/members`, { token: ownerToken, body: { email: "joined@example.com", role: "viewer" } })).data;
		const joiner = await account("mail-joined");
		await call("POST", `/api/v1/invitations/${invited.invitation_token}/accept`, { token: joiner });
		expect((await call("POST", `${base()}/members/${invited.uuid}/invitation-email`, { token: ownerToken })).error).toBe(1082);
	});
});

describe("terminal receipts", () => {
	test("a cashier emails the receipt of their own sale", async () => {
		const sale = (await call("POST", `${base()}/pos/sales`, { token: cashierToken, body: { lines: [{ item: itemUuid, quantity: 2 }] } })).data;
		await call("POST", `${base()}/pos/sales/${sale.uuid}/cash`, { token: cashierToken, body: {} });

		const res = await call("POST", `${base()}/pos/sales/${sale.uuid}/email`, { token: cashierToken, body: { to: "shopper@example.com" } });
		expect(res.data).toMatchObject({ kind: "receipt", recipient: "shopper@example.com", sent_by: "mail-cashier" });

		await flush();
		expect(outbox[0].subject).toBe(`Receipt ${sale.reference} from Studio <Nord>`);
		expect(outbox[0].text).toContain("2 x Latte");
		expect(outbox[0].text).toContain("Paid €6.00");

		expect((await call("POST", `${base()}/pos/sales/${sale.uuid}/email`, { token: otherCashierToken, body: { to: "x@example.com" } })).error).toBe(1080);
	});

	test("needs a valid address and stops after five", async () => {
		const sale = (await call("POST", `${base()}/pos/sales`, { token: cashierToken, body: { lines: [{ item: itemUuid }] } })).data;
		expect((await call("POST", `${base()}/pos/sales/${sale.uuid}/email`, { token: cashierToken, body: {} })).error).toBe(1084);
		expect((await call("POST", `${base()}/pos/sales/${sale.uuid}/email`, { token: cashierToken, body: { to: "bad" } })).error).toBe(1009);
		for (let index = 0; index < 5; index++) {
			expect((await call("POST", `${base()}/pos/sales/${sale.uuid}/email`, { token: cashierToken, body: { to: "a@example.com" } })).error).toBe(0);
		}
		expect((await call("POST", `${base()}/pos/sales/${sale.uuid}/email`, { token: cashierToken, body: { to: "a@example.com" } })).error).toBe(1085);
	});
});

describe("automatic reminders", () => {
	test("settings are validated and only owners and admins change them", async () => {
		expect((await call("PATCH", base(), { token: ownerToken, body: { reminder_days_before: 31 } })).error).toBe(1001);
		expect((await call("PATCH", base(), { token: ownerToken, body: { reminder_days_after: -1 } })).error).toBe(1001);
		expect((await call("PATCH", base(), { token: ownerToken, body: { email_reminders: "yes" } })).error).toBe(1001);
		expect((await call("PATCH", base(), { token: viewerToken, body: { email_reminders: true } })).error).toBe(9999);

		const res = await call("PATCH", base(), { token: ownerToken, body: { email_reminders: false, reminder_days_before: 2, reminder_days_after: 5 } });
		expect(res.data).toMatchObject({ email_enabled: true, email_reminders: false, reminder_days_before: 2, reminder_days_after: 5 });
	});

	test("nothing is sent while reminders are off", async () => {
		const invoice = await issue({ dueDate: Date.now() + DAY });
		await Database`UPDATE invoices SET issued_at = ${Date.now() - 5 * DAY} WHERE uuid = ${invoice.uuid}`;
		await sendDueReminders();
		await flush();
		expect(outbox.filter((mail) => mail.subject.includes(invoice.reference))).toHaveLength(0);
	});

	test("sends one reminder before and repeated reminders after the due date", async () => {
		await Database`UPDATE invoices SET status = 'paid' WHERE project = ${projectUuid} AND status IN ('open', 'overdue', 'partially_paid')`;
		await call("PATCH", base(), { token: ownerToken, body: { email_reminders: true, reminder_days_before: 3, reminder_days_after: 3 } });

		const soon = await issue({ dueDate: Date.now() + DAY });
		const late = await issue({ dueDate: Date.now() - 4 * DAY });
		const fresh = await issue({ dueDate: Date.now() + DAY });
		const anonymous = await issue({ customer: null, dueDate: Date.now() - 10 * DAY });
		await Database`UPDATE invoices SET issued_at = ${Date.now() - 10 * DAY} WHERE uuid IN ${Database([soon.uuid, late.uuid, anonymous.uuid])}`;

		expect(await sendDueReminders()).toBe(2);
		await flush();
		expect(outbox.map((mail) => mail.subject).sort()).toEqual(
			[`Overdue: invoice ${late.reference} from Studio <Nord>`, expect.stringContaining(`Reminder: invoice ${soon.reference}`)].sort()
		);
		expect(outbox.some((mail) => mail.subject.includes(fresh.reference))).toBe(false);

		expect(await sendDueReminders()).toBe(0);
		expect(await sendDueReminders(Date.now() + 2 * DAY)).toBe(1);
		expect(await sendDueReminders(Date.now() + 2 * DAY)).toBe(0);
		expect(await sendDueReminders(Date.now() + 5 * DAY)).toBeGreaterThanOrEqual(1);
	});

	test("paid and terminal invoices are never reminded", async () => {
		await Database`UPDATE invoices SET status = 'paid' WHERE project = ${projectUuid} AND source = 'invoice'`;
		const sale = (await call("POST", `${base()}/pos/sales`, { token: cashierToken, body: { lines: [{ item: itemUuid }] } })).data;
		await Database`UPDATE invoices SET due_date = ${Date.now() - 30 * DAY}, customer = ${customerUuid} WHERE uuid = ${sale.uuid}`;
		expect(await sendDueReminders()).toBe(0);
	});
});

describe("without email", () => {
	test("sending is refused and nothing is delivered", async () => {
		const invoice = await issue();
		Settings.email.enabled = false;
		try {
			expect((await call("POST", `${base()}/invoices/${invoice.uuid}/email`, { token: ownerToken, body: {} })).error).toBe(1083);
			expect((await call("GET", base(), { token: ownerToken })).data.email_enabled).toBe(false);

			const invited = await call("POST", `${base()}/members`, { token: ownerToken, body: { email: "offline@example.com", role: "viewer" } });
			expect(invited.data.email_queued).toBe(false);
			expect(await deliverPendingEmails()).toEqual({ attempted: 0, sent: 0 });
		} finally {
			Settings.email.enabled = true;
		}
	});
});

describe("e-invoice attachments", () => {
	let einvoiceProject = "";
	let businessCustomer = "";
	let consumer = "";
	const einvoiceBase = () => `/api/v1/projects/${einvoiceProject}`;
	const issueFor = async (customer: string) => {
		const res = await call("POST", `${einvoiceBase()}/invoices`, {
			token: ownerToken,
			body: {
				customer,
				status: "open",
				due_date: Date.now() + 14 * DAY,
				supply_date: Date.now(),
				items: [{ description: "Svetovanje", quantity: 2, unit: "HUR", unit_price: 5000, tax_rate: 22 }],
			},
		});
		if (res.error !== 0) throw new Error(res.info);
		return res.data;
	};
	const xmlOf = (message: Captured) => message.attachments?.find((attachment) => attachment.contentType === "application/xml");

	beforeAll(async () => {
		einvoiceProject = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "mail-einvoice", currency: "EUR" } })).data.uuid;
		await call("PATCH", einvoiceBase(), { token: ownerToken, body: { language: "en", tax_country: "SI", vat_status: "registered", tax_currency: "EUR" } });
		await call("PUT", `${einvoiceBase()}/company`, {
			token: ownerToken,
			body: {
				legal_name: "e-Racuni d.o.o.",
				address_line1: "Dunajska cesta 1",
				postal_code: "1000",
				city: "Ljubljana",
				country: "SI",
				vat_number: "SI12345678",
				email: "racuni@example.com",
			},
		});
		businessCustomer = (
			await call("POST", `${einvoiceBase()}/customers`, {
				token: ownerToken,
				body: {
					email: "ap@kupec.example",
					name: "Kupec d.o.o.",
					address_line1: "Trg 1",
					postal_code: "4000",
					city: "Kranj",
					country: "SI",
					vat_number: "SI87654321",
					customer_type: "business",
				},
			})
		).data.uuid;
		consumer = (
			await call("POST", `${einvoiceBase()}/customers`, {
				token: ownerToken,
				body: {
					email: "person@example.com",
					name: "Ana",
					address_line1: "Ulica 2",
					postal_code: "1000",
					city: "Ljubljana",
					country: "SI",
					customer_type: "individual",
				},
			})
		).data.uuid;
		await flush();
		outbox.length = 0;
	});

	test("attaches the stored e-SLOG file next to the PDF when asked", async () => {
		const invoice = await issueFor(businessCustomer);
		const res = await call("POST", `${einvoiceBase()}/invoices/${invoice.uuid}/email`, {
			token: ownerToken,
			body: { attach_invoice: true, attach_eslog: true },
		});
		expect(res.status).toBe(201);
		expect(res.data.eslog_document).not.toBeNull();

		await flush();
		const [sent] = outbox;
		expect(sent.attachments?.map((attachment) => attachment.contentType)).toEqual(["application/pdf", "application/xml"]);
		expect(xmlOf(sent)!.filename).toBe(`Invoice ${invoice.reference}.xml`);
		expect(sent.text).toContain("e-SLOG 2.0 format is attached");

		const stored = await (
			await Server.app.handle(
				new Request(`http://127.0.0.1${einvoiceBase()}/invoices/${invoice.uuid}/eslog`, { headers: { Authorization: `Bearer ${ownerToken}` } })
			)
		).text();
		expect(xmlOf(sent)!.content.toString()).toBe(stored);
		expect(stored).toContain("<D_6411>HUR</D_6411>");
	});

	test("refuses an explicit request when the invoice cannot become an e-invoice", async () => {
		const invoice = await issueFor(consumer);
		const res = await call("POST", `${einvoiceBase()}/invoices/${invoice.uuid}/email`, { token: ownerToken, body: { attach_eslog: true } });

		expect(res.error).toBe(1172);
		const [count] = (await Database`SELECT COUNT(*) AS count FROM email_messages WHERE invoice = ${invoice.uuid}`) as { count: number }[];
		expect(Number(count.count)).toBe(0);
	});

	test("uses the project default for invoices and skips it where it cannot apply", async () => {
		expect((await call("PATCH", einvoiceBase(), { token: ownerToken, body: { email_attach_eslog: "yes" } })).error).toBe(1001);
		const updated = await call("PATCH", einvoiceBase(), { token: ownerToken, body: { email_attach_eslog: true } });
		expect(updated.data.email_attach_eslog).toBe(true);

		const business = await issueFor(businessCustomer);
		const person = await issueFor(consumer);
		await call("POST", `${einvoiceBase()}/invoices/${business.uuid}/email`, { token: ownerToken, body: {} });
		await call("POST", `${einvoiceBase()}/invoices/${person.uuid}/email`, { token: ownerToken, body: {} });
		await call("POST", `${einvoiceBase()}/invoices/${business.uuid}/email`, { token: ownerToken, body: { reminder: true } });
		await flush();

		const [toBusiness, toPerson, reminder] = outbox;
		expect(toBusiness.to).toBe("ap@kupec.example");
		expect(xmlOf(toBusiness)).toBeDefined();
		expect(toPerson.to).toBe("person@example.com");
		expect(xmlOf(toPerson)).toBeUndefined();
		expect(toPerson.text).not.toContain("e-SLOG");
		expect(xmlOf(reminder)).toBeUndefined();

		await call("PATCH", einvoiceBase(), { token: ownerToken, body: { email_attach_eslog: false } });
	});

	test("attaches the e-SLOG file to credit note emails", async () => {
		const invoice = await issueFor(businessCustomer);
		const note = await call("POST", `${einvoiceBase()}/invoices/${invoice.uuid}/credit-notes`, { token: ownerToken, body: { reason: "Popust" } });
		const res = await call("POST", `${einvoiceBase()}/credit-notes/${note.data.uuid}/email`, {
			token: ownerToken,
			body: { attach_invoice: false, attach_eslog: true },
		});
		expect(res.status).toBe(201);

		await flush();
		const [sent] = outbox;
		expect(sent.attachments).toHaveLength(1);
		expect(xmlOf(sent)!.filename).toBe(`Credit note ${note.data.reference}.xml`);
		expect(xmlOf(sent)!.content.toString()).toContain("<D_1001>381</D_1001>");
	});
});
