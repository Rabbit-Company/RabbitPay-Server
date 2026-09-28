import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { prepareTest } from "./environment";

await prepareTest();

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { default: Auth } = await import("../server/auth");
const { Settings } = await import("../server/settings");
const { setTransport } = await import("../server/email/mailer");
const { numericClient } = await import("../server/database/client");
const { MIGRATIONS, migrate } = await import("../server/database/migrations");
const { CUSTOMER_EMAIL_KINDS, DEFAULT_EMAIL_DESIGN, readEmailDesign } = await import("../server/email-design");

interface Result {
	status: number;
	error: number;
	data: any;
}

async function call(method: string, path: string, token: string, body?: unknown): Promise<Result> {
	const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const response = await Server.app.handle(
		new Request(`http://127.0.0.1/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
	);
	return { status: response.status, ...((await response.json()) as { error: number; data: any }) };
}

const custom = {
	...DEFAULT_EMAIL_DESIGN,
	accent: "#db2777",
	show_logo: false,
	show_address: false,
	signature: "Kind regards,\nThe Studio team",
	footer_text: "You ordered from Studio Nord.",
	templates: {
		...DEFAULT_EMAIL_DESIGN.templates,
		invoice: {
			subject: "Invoice {reference} is ready",
			heading: "Hello there",
			intro: "{merchant} prepared {reference} for {amount}, due {date}.",
			button: "Pay now",
			closing: "Questions? Just reply.",
		},
		credit_note: { subject: "Credit {reference} for {invoice}", heading: null, intro: null, button: null, closing: null },
		order_shipped: { subject: "{reference} is shipped", heading: null, intro: "Your parcel left {merchant}.", button: "Where is it?", closing: null },
	},
};

let token = "";
let project = "";
const base = () => `/projects/${project}`;

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await Server.configure();
	Settings.email.enabled = true;
	setTransport({ sendMail: async () => ({ messageId: "email-design-test" }) } as never);
	const now = Date.now();
	await Database`INSERT INTO accounts(username, email, password, created, updated, accessed) VALUES('mailer', 'mailer@example.com', 'x', ${now}, ${now}, ${now})`;
	token = (await Auth.createSession("mailer", ""))!;
	project = (await call("POST", "/projects", token, { name: "studio-nord", currency: "EUR" })).data.uuid;
	await call("PUT", `${base()}/company`, token, {
		legal_name: "Studio Nord d.o.o.",
		address_line1: "Trubarjeva 5",
		postal_code: "1000",
		city: "Ljubljana",
		country: "SI",
	});
});

afterAll(async () => {
	await Database.close();
});

describe("email design", () => {
	test("rejects unknown placeholders, extra fields and multi-line subjects", () => {
		expect(readEmailDesign(DEFAULT_EMAIL_DESIGN)).toEqual(DEFAULT_EMAIL_DESIGN);
		expect(readEmailDesign(custom)).toEqual(custom);
		const withTemplate = (kind: string, texts: object) => ({
			...custom,
			templates: { ...custom.templates, [kind]: { ...DEFAULT_EMAIL_DESIGN.templates.invoice, ...texts } },
		});
		expect(readEmailDesign(withTemplate("keys", { intro: "Total {amount}" }))).toBeNull();
		expect(readEmailDesign(withTemplate("credit_note", { button: "Open" }))).toBeNull();
		expect(readEmailDesign(withTemplate("invoice", { subject: "Two\nlines" }))).toBeNull();
		expect(readEmailDesign(withTemplate("newsletter", {}))).toBeNull();
		expect(readEmailDesign({ ...custom, accent: "pink" })).toBeNull();
	});

	test("offers the default wording and previews every customer email without a license", async () => {
		const state = await call("GET", `${base()}/email-design`, token);
		expect(state.data.white_label).toBe(false);
		expect(state.data.defaults.invoice.subject).toBe("Invoice {reference} from {merchant}");
		expect(state.data.defaults.credit_note.button).toBeNull();

		for (const kind of CUSTOMER_EMAIL_KINDS) {
			const preview = await call("POST", `${base()}/email-design/preview`, token, { design: custom, kind });
			expect(preview.error).toBe(0);
			expect(preview.data.html).toContain("Kind regards,");
			expect(preview.data.html).toContain("#db2777");
		}
		const invoice = await call("POST", `${base()}/email-design/preview`, token, { design: custom, kind: "invoice" });
		expect(invoice.data.subject).toBe("Invoice 260924000042 is ready");
		expect(invoice.data.html).toContain("Hello there");
		expect(invoice.data.html).toContain("Pay now");
		expect(invoice.data.html).toContain("You ordered from Studio Nord.");
		expect(invoice.data.html).not.toContain("Trubarjeva 5");
		const shipped = await call("POST", `${base()}/email-design/preview`, token, { design: custom, kind: "order_shipped" });
		expect(shipped.data.html).toContain("Where is it?");

		expect((await call("PUT", `${base()}/email-design`, token, custom)).error).toBe(1097);
	});

	test("changes real invoice emails once white label is active, and leaves team emails alone", async () => {
		await Database`UPDATE projects SET white_label_until = ${Date.now() + 30 * 86400000} WHERE uuid = ${project}`;
		expect((await call("PUT", `${base()}/email-design`, token, custom)).error).toBe(0);

		const created = await call("POST", `${base()}/invoices`, token, {
			currency: "EUR",
			due_date: Date.now() + 86400000,
			status: "open",
			items: [{ description: "Branding", quantity: 1, unit_price: 50000 }],
		});
		const invoice = created.data.uuid;
		expect((await call("POST", `${base()}/invoices/${invoice}/email`, token, { to: "client@example.com" })).error).toBe(0);
		const [email] = await Database`SELECT subject, body_text, body_html FROM email_messages WHERE invoice = ${invoice}`;
		expect(email.subject).toBe(`Invoice ${created.data.reference} is ready`);
		expect(email.body_text).toContain(`studio-nord prepared ${created.data.reference} for`);
		expect(email.body_text).toContain("Questions? Just reply.");
		expect(email.body_text).toContain("The Studio team");
		expect(email.body_html).toContain("#db2777");

		await call("POST", `${base()}/members`, token, { email: "new@example.com", role: "viewer" });
		const [invitation] = await Database`SELECT body_text FROM email_messages WHERE kind = 'invitation' AND project = ${project}`;
		expect(invitation.body_text).not.toContain("The Studio team");
		expect(invitation.body_text).toContain("Trubarjeva 5");
	});

	test("moves the invoice email texts out of the invoice design", async () => {
		const sql = numericClient(new SQL("sqlite://:memory:", { safeIntegers: true }));
		await migrate(sql, "sqlite", MIGRATIONS.slice(0, 6));
		const now = Date.now();
		const legacy = JSON.stringify({ layout: "modern", email: { invoice_subject: "Hi {reference}", invoice_intro: "Thanks {merchant}" } });
		await sql`INSERT INTO projects(uuid, name, apikey, apikey2, created, updated, created_by, invoice_design) VALUES('p', 'p', 'a', 'b', ${now}, ${now}, 'o', ${legacy})`;
		await migrate(sql, "sqlite");
		const [row] = (await sql`SELECT email_design FROM projects WHERE uuid = 'p'`) as { email_design: string }[];
		const design = readEmailDesign(JSON.parse(row.email_design))!;
		expect(design.templates.invoice.subject).toBe("Hi {reference}");
		expect(design.templates.invoice.intro).toBe("Thanks {merchant}");
		expect(design.templates.receipt.subject).toBeNull();
		await sql.close();
	});
});
