import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { prepareTest } from "./environment";

await prepareTest();

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { Settings } = await import("../server/settings");
const { setTransport } = await import("../server/email/mailer");
const { default: Auth } = await import("../server/auth");
const { default: Utils } = await import("../server/utils");
const { createInvoice } = await import("../server/invoice-service");

interface Result {
	error: number;
	info: string;
	data: any;
}

async function fetchRoute(method: string, path: string, token?: string, body?: unknown): Promise<Response> {
	const headers: Record<string, string> = {};
	if (token) headers.Authorization = `Bearer ${token}`;
	if (body !== undefined) headers["Content-Type"] = "application/json";
	return await Server.app.handle(
		new Request(`http://127.0.0.1/api/v1${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	);
}

async function call(method: string, path: string, token?: string, body?: unknown): Promise<Result> {
	return (await (await fetchRoute(method, path, token, body)).json()) as Result;
}

const messages: { to: string; text: string; html: string; subject: string }[] = [];
let mailFails = false;
let ownerToken = "";
let firstProject = "";
let secondProject = "";
let customer = "";
let firstInvoice = "";
let secondInvoice = "";
let otherInvoice = "";
let draftInvoice = "";
let customerSession = "";

async function loginLink(email: string, language = "en"): Promise<string> {
	const result = await call("POST", "/customer/auth/request", undefined, { email, language });
	expect(result.error).toBe(0);
	return messages.at(-1)!.text.match(/#token=([A-Za-z0-9]{128})/)![1];
}

async function login(email: string): Promise<string> {
	const result = await call("POST", "/customer/auth/verify", undefined, { token: await loginLink(email) });
	expect(result.error).toBe(0);
	return result.data.token;
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await Server.configure();
	Settings.email.enabled = true;
	setTransport({
		sendMail: async (message: (typeof messages)[number]) => {
			if (mailFails) throw new Error("Unavailable");
			messages.push(message);
			return { messageId: "portal-test" };
		},
	} as never);
	const now = Date.now();
	await Database`INSERT INTO accounts(username, email, password, created, updated, accessed)
		VALUES('portal-owner', 'client@example.com', 'unused', ${now}, ${now}, ${now})`;
	ownerToken = (await Auth.createSession("portal-owner", ""))!;
	firstProject = (await call("POST", "/projects", ownerToken, { name: "portal-first" })).data.uuid;
	secondProject = (await call("POST", "/projects", ownerToken, { name: "portal-second" })).data.uuid;
	await call("PATCH", `/projects/${firstProject}`, ownerToken, { display_name: "First Business" });
	customer = (
		await call("POST", `/projects/${firstProject}/customers`, ownerToken, {
			email: "Client@Example.com",
			name: "Original Client",
			address_line1: "Original address",
		})
	).data.uuid;
	const secondCustomer = (await call("POST", `/projects/${secondProject}/customers`, ownerToken, { email: "client@example.com" })).data.uuid;
	const otherCustomer = (await call("POST", `/projects/${firstProject}/customers`, ownerToken, { email: "other@example.com" })).data.uuid;
	const issue = async (project: string, buyer: string, status: "open" | "draft" = "open", due = now + 86400000) =>
		await createInvoice(project, { customer: buyer, status, due_date: due, items: [{ description: "Service", quantity: 1, unit_price: 10000 }] });
	firstInvoice = (await issue(firstProject, customer, "open", now - 86400000)).uuid;
	secondInvoice = (await issue(secondProject, secondCustomer)).uuid;
	otherInvoice = (await issue(firstProject, otherCustomer)).uuid;
	draftInvoice = (await issue(firstProject, customer, "draft")).uuid;
	customerSession = await login("CLIENT@example.com");
});

afterAll(async () => {
	setTransport(null);
	await Database.close();
});

describe("customer login", () => {
	test("verifies email independently of the business account with the same email", async () => {
		expect((await call("GET", "/customer/auth/me", customerSession)).data).toEqual({ email: "client@example.com", tickets: false });
		expect((await call("GET", "/auth/me", ownerToken)).data.username).toBe("portal-owner");
		expect(await Database`SELECT email FROM customer_accounts WHERE email = 'client@example.com'`).toHaveLength(1);
	});

	test("customer and business tokens cannot access each other's routes", async () => {
		expect((await call("GET", "/auth/me", customerSession)).error).toBe(1017);
		expect((await call("GET", "/projects", customerSession)).error).toBe(1017);
		expect((await call("GET", `/projects/${firstProject}/invoices`, customerSession)).error).toBe(1017);
		expect((await call("GET", "/customer/invoices", ownerToken)).error).toBe(1017);
		expect((await call("GET", "/customer/invoices")).error).toBe(1000);
	});

	test("stores only a hash of each login token and consumes it once", async () => {
		const token = await loginLink("once@example.com");
		const [stored] = await Database`SELECT * FROM customer_login_links WHERE email = 'once@example.com'`;
		expect(stored.token_hash).toBe(await Utils.generateHash(token, "sha256"));
		expect(JSON.stringify(stored)).not.toContain(token);
		expect((await call("POST", "/customer/auth/verify", undefined, { token })).error).toBe(0);
		expect((await call("POST", "/customer/auth/verify", undefined, { token })).error).toBe(1017);
	});

	test("concurrent verification creates only one session", async () => {
		const token = await loginLink("concurrent@example.com");
		const results = await Promise.all([
			call("POST", "/customer/auth/verify", undefined, { token }),
			call("POST", "/customer/auth/verify", undefined, { token }),
		]);
		expect(results.map((result) => result.error).sort()).toEqual([0, 1017]);
	});

	test("rejects expired and malformed links", async () => {
		const token = await loginLink("expired@example.com");
		await Database`UPDATE customer_login_links SET expires_at = ${Date.now() - 1} WHERE email = 'expired@example.com'`;
		expect((await call("POST", "/customer/auth/verify", undefined, { token })).error).toBe(1017);
		expect((await call("POST", "/customer/auth/verify", undefined, { token: "invalid" })).error).toBe(1016);
		expect((await call("POST", "/customer/auth/verify", undefined, null)).error).toBe(1016);
	});

	test("allows a verified customer with no invoices to sign in", async () => {
		const token = await login("new@example.com");
		expect((await call("GET", "/customer/invoices", token)).data).toMatchObject({ invoices: [], total: 0 });
	});

	test("sends Slovenian login emails and keeps tokens in the URL fragment", async () => {
		await loginLink("slovenian@example.com", "sl");
		const message = messages.at(-1)!;
		expect(message.subject).toContain("prijavo");
		expect(message.text).toContain("15 minut");
		expect(message.html).toContain("<!doctype html>");
		expect(message.html).toContain('<html lang="sl">');
		expect(message.html).toContain("background:#4f46e5");
		expect(message.html).toContain("/customer/login#token=");
		expect(message.html).not.toContain("?token=");
	});

	test("limits repeated login emails without revealing invoice ownership", async () => {
		for (let index = 0; index < 3; index++) await loginLink("limited@example.com");
		expect((await call("POST", "/customer/auth/request", undefined, { email: "limited@example.com" })).error).toBe(1030);
		expect((await call("POST", "/customer/auth/request", undefined, { email: "invalid" })).error).toBe(1009);
		expect((await call("POST", "/customer/auth/request", undefined, null)).error).toBe(1009);
	});

	test("requires the server email service and removes links when delivery fails", async () => {
		Settings.email.enabled = false;
		try {
			expect((await call("POST", "/customer/auth/request", undefined, { email: "disabled@example.com" })).error).toBe(1083);
		} finally {
			Settings.email.enabled = true;
		}
		mailFails = true;
		try {
			expect((await call("POST", "/customer/auth/request", undefined, { email: "failed@example.com" })).error).toBe(1105);
			expect(await Database`SELECT * FROM customer_login_links WHERE email = 'failed@example.com'`).toHaveLength(0);
		} finally {
			mailFails = false;
		}
	});

	test("logout revokes only the customer session", async () => {
		const token = await login("logout@example.com");
		expect((await call("POST", "/customer/auth/logout", token, {})).error).toBe(0);
		expect((await call("GET", "/customer/auth/me", token)).error).toBe(1017);
		expect((await call("GET", "/auth/me", ownerToken)).error).toBe(0);
	});
});

describe("customer invoices", () => {
	test("lists invoices across projects with public business names and safe fields", async () => {
		const response = await fetchRoute("GET", "/customer/invoices", customerSession);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		const result = (await response.json()) as Result;
		expect(result.data.total).toBe(2);
		expect(result.data.invoices.map((invoice: any) => invoice.uuid).sort()).toEqual([firstInvoice, secondInvoice].sort());
		const invoice = result.data.invoices.find((invoice: any) => invoice.uuid === firstInvoice);
		expect(invoice.merchant).toBe("First Business");
		expect(invoice).not.toHaveProperty("metadata");
		expect(invoice).not.toHaveProperty("created_by");
		expect(invoice).not.toHaveProperty("buyer_details");
	});

	test("filters unpaid, overdue and paid invoices and supports pagination", async () => {
		expect((await call("GET", "/customer/invoices?status=unpaid", customerSession)).data.total).toBe(2);
		expect((await call("GET", "/customer/invoices?status=overdue", customerSession)).data.invoices.map((invoice: any) => invoice.uuid)).toEqual([firstInvoice]);
		await Database`UPDATE invoices SET status = 'paid', paid_amount = total_amount WHERE uuid = ${secondInvoice}`;
		try {
			expect((await call("GET", "/customer/invoices?status=paid", customerSession)).data.invoices.map((invoice: any) => invoice.uuid)).toEqual([secondInvoice]);
			expect((await call("GET", "/customer/invoices?status=unpaid", customerSession)).data.total).toBe(1);
		} finally {
			await Database`UPDATE invoices SET status = 'open', paid_amount = 0 WHERE uuid = ${secondInvoice}`;
		}
		const first = (await call("GET", "/customer/invoices?limit=1", customerSession)).data;
		const second = (await call("GET", "/customer/invoices?limit=1&offset=1", customerSession)).data;
		expect(first.total).toBe(2);
		expect(first.invoices).toHaveLength(1);
		expect(second.invoices).toHaveLength(1);
		expect(first.invoices[0].uuid).not.toBe(second.invoices[0].uuid);
		expect((await call("GET", "/customer/invoices?status=draft", customerSession)).error).toBe(1044);
	});

	test("restricts invoice details and PDF downloads to the verified recipient", async () => {
		const details = (await call("GET", `/customer/invoices/${firstInvoice}`, customerSession)).data;
		expect(details.document.buyer.email).toBe("Client@Example.com");
		const pdf = await fetchRoute("GET", `/customer/invoices/${firstInvoice}/pdf`, customerSession);
		expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
		expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
		for (const uuid of [otherInvoice, draftInvoice, crypto.randomUUID()]) {
			for (const suffix of ["", "/pdf"]) {
				expect((await call("GET", `/customer/invoices/${uuid}${suffix}`, customerSession)).error).toBe(1035);
			}
		}
	});

	test("customer edits cannot transfer old invoices or expose replacement buyer details", async () => {
		expect(
			(
				await call("PATCH", `/projects/${firstProject}/customers/${customer}`, ownerToken, {
					email: "replacement@example.com",
					name: "Replacement Client",
					address_line1: "Replacement address",
				})
			).error
		).toBe(0);
		const replacement = await login("replacement@example.com");
		expect((await call("GET", `/customer/invoices/${firstInvoice}`, replacement)).error).toBe(1035);
		const details = (await call("GET", `/customer/invoices/${firstInvoice}`, customerSession)).data.document;
		expect(details.buyer.name).toBe("Original Client");
		expect(details.buyer.address_line1).toBe("Original address");
		expect(details.buyer.email).toBe("Client@Example.com");
		expect((await call("POST", `/projects/${firstProject}/invoices/${draftInvoice}/open`, ownerToken, {})).error).toBe(0);
		expect((await call("GET", `/customer/invoices/${draftInvoice}`, replacement)).error).toBe(0);
		expect((await call("GET", `/customer/invoices/${draftInvoice}`, customerSession)).error).toBe(1035);
	});

	test("shows related credit notes and protects their details and PDFs", async () => {
		const issued = await call("POST", `/projects/${firstProject}/invoices/${firstInvoice}/credit-notes`, ownerToken, { amount: 1000, reason: "Adjustment" });
		expect(issued.error).toBe(0);
		const uuid = issued.data.uuid;
		const details = (await call("GET", `/customer/invoices/${firstInvoice}`, customerSession)).data;
		expect(details.credit_notes.map((note: any) => note.uuid)).toContain(uuid);
		expect((await call("GET", `/customer/credit-notes/${uuid}`, customerSession)).data.credit_note.reason).toBe("Adjustment");
		const pdf = await fetchRoute("GET", `/customer/credit-notes/${uuid}/pdf`, customerSession);
		expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
		const other = await login("other@example.com");
		for (const suffix of ["", "/pdf"]) expect((await call("GET", `/customer/credit-notes/${uuid}${suffix}`, other)).error).toBe(1076);
	});

	test("deleted projects disappear and their documents cannot be downloaded", async () => {
		await Database`UPDATE projects SET status = 'deleted' WHERE uuid = ${secondProject}`;
		expect((await call("GET", "/customer/invoices", customerSession)).data.total).toBe(1);
		expect((await call("GET", `/customer/invoices/${secondInvoice}`, customerSession)).error).toBe(1035);
		expect((await call("GET", `/customer/invoices/${secondInvoice}/pdf`, customerSession)).error).toBe(1035);
	});
});

describe("e-invoice downloads", () => {
	test("lets a business buyer download the stored e-SLOG and hides the details of why it is missing", async () => {
		const project = (await call("POST", "/projects", ownerToken, { name: "portal-einvoice" })).data.uuid;
		await call("PATCH", `/projects/${project}`, ownerToken, { tax_country: "SI", vat_status: "registered", tax_currency: "EUR" });
		await call("PUT", `/projects/${project}/company`, ownerToken, {
			legal_name: "e-Racuni d.o.o.",
			address_line1: "Dunajska cesta 1",
			postal_code: "1000",
			city: "Ljubljana",
			country: "SI",
			vat_number: "SI12345678",
		});
		const buyer = (
			await call("POST", `/projects/${project}/customers`, ownerToken, {
				email: "einvoice-buyer@example.com",
				name: "Kupec d.o.o.",
				address_line1: "Trg 1",
				postal_code: "4000",
				city: "Kranj",
				country: "SI",
				vat_number: "SI87654321",
				customer_type: "business",
			})
		).data.uuid;
		const invoice = await createInvoice(project, {
			customer: buyer,
			status: "open",
			due_date: Date.now() + 86400000,
			supply_date: Date.now(),
			items: [{ description: "Service", quantity: 1, unit_price: 10000, tax_rate: 22 }],
		});
		const session = await login("einvoice-buyer@example.com");

		const download = await fetchRoute("GET", `/customer/invoices/${invoice.uuid}/eslog`, session);
		const xml = await download.text();
		expect(download.headers.get("Content-Type")).toBe("application/xml");
		expect(xml).toContain('<Invoice xmlns="urn:eslog:2.00"');
		const admin = await (await fetchRoute("GET", `/projects/${project}/invoices/${invoice.uuid}/eslog`, ownerToken)).text();
		expect(admin).toBe(xml);

		const note = await call("POST", `/projects/${project}/invoices/${invoice.uuid}/credit-notes`, ownerToken, { amount: 1000, reason: "Popust" });
		const noteXml = await (await fetchRoute("GET", `/customer/credit-notes/${note.data.uuid}/eslog`, session)).text();
		expect(noteXml).toContain("<D_1001>381</D_1001>");

		const unavailable = await call("GET", `/customer/invoices/${firstInvoice}/eslog`, customerSession);
		expect(unavailable.error).toBe(1179);
		expect(unavailable.info).not.toContain("VAT");
		expect((await call("GET", `/customer/invoices/${invoice.uuid}/eslog`, customerSession)).error).toBe(1035);
	});
});
