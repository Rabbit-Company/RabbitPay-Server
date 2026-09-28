import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { prepareTest } from "./environment";

await prepareTest();

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { default: Auth } = await import("../server/auth");
const { numericClient } = await import("../server/database/client");
const { MIGRATIONS, migrate } = await import("../server/database/migrations");
const { Settings } = await import("../server/settings");
const { setTransport } = await import("../server/email/mailer");
const { DEFAULT_INVOICE_DESIGN, readInvoiceDesign, withDesignDefaults } = await import("../server/invoice-design");

interface Result {
	status: number;
	error: number;
	data: any;
}

async function send(method: string, path: string, token: string, body?: unknown): Promise<Response> {
	const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	return await Server.app.handle(
		new Request(`http://127.0.0.1/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
	);
}

async function call(method: string, path: string, token: string, body?: unknown): Promise<Result> {
	const response = await send(method, path, token, body);
	return { status: response.status, ...((await response.json()) as { error: number; data: any }) };
}

const modern = {
	...DEFAULT_INVOICE_DESIGN,
	layout: "modern" as const,
	accent: "#0d9488",
	header_text: "Thank you for your business",
	notes: { invoice: "Payment within 14 days.", credit_note: null, receipt: null },
};

let token = "";
let project = "";
const base = () => `/projects/${project}`;

async function issue(): Promise<string> {
	const created = await call("POST", `${base()}/invoices`, token, {
		currency: "EUR",
		due_date: Date.now() + 86400000,
		status: "open",
		items: [{ description: "Design work", quantity: 1, unit_price: 10000 }],
	});
	expect(created.error).toBe(0);
	return created.data.uuid;
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await Server.configure();
	Settings.email.enabled = true;
	setTransport({ sendMail: async () => ({ messageId: "design-test" }) } as never);
	const now = Date.now();
	await Database`INSERT INTO accounts(username, email, password, created, updated, accessed) VALUES('designer', 'designer@example.com', 'x', ${now}, ${now}, ${now})`;
	token = (await Auth.createSession("designer", ""))!;
	project = (await call("POST", "/projects", token, { name: "design-studio", currency: "EUR" })).data.uuid;
});

afterAll(async () => {
	await Database.close();
});

describe("invoice design settings", () => {
	test("reject unsafe or unknown values", () => {
		expect(readInvoiceDesign(DEFAULT_INVOICE_DESIGN)).toEqual(DEFAULT_INVOICE_DESIGN);
		expect(readInvoiceDesign(modern)).toEqual(modern);
		expect(readInvoiceDesign({ ...modern, accent: "teal" })).toBeNull();
		expect(readInvoiceDesign({ ...modern, layout: "fancy" })).toBeNull();
		expect(readInvoiceDesign({ ...modern, footer_text: "x".repeat(501) })).toBeNull();
		expect(withDesignDefaults(undefined)).toEqual(DEFAULT_INVOICE_DESIGN);
		expect(withDesignDefaults({ layout: "compact" }).layout).toBe("compact");
	});

	test("need an active white label license to save, but can be previewed without one", async () => {
		const state = await call("GET", `${base()}/invoice-design`, token);
		expect(state.data.white_label).toBe(false);
		expect(state.data.design).toEqual(DEFAULT_INVOICE_DESIGN);

		const refused = await call("PUT", `${base()}/invoice-design`, token, modern);
		expect(refused.error).toBe(1097);

		for (const kind of ["invoice", "receipt", "credit_note"]) {
			const preview = await send("POST", `${base()}/invoice-design/preview`, token, { design: modern, kind });
			expect(preview.headers.get("Content-Type")).toBe("application/pdf");
			expect(new TextDecoder().decode((await preview.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
		}
		expect((await call("POST", `${base()}/invoice-design/preview`, token, { design: { ...modern, font: "comic" } })).error).toBe(1170);
	});

	test("are stored on each issued document and changing them later leaves old documents alone", async () => {
		await Database`UPDATE projects SET white_label_until = ${Date.now() + 30 * 86400000} WHERE uuid = ${project}`;
		const saved = await call("PUT", `${base()}/invoice-design`, token, modern);
		expect(saved.error).toBe(0);
		expect(saved.data.applied.layout).toBe("modern");

		const first = await issue();
		const firstDocument = await call("GET", `${base()}/invoices/${first}/document`, token);
		expect(firstDocument.data.design.layout).toBe("modern");
		expect(firstDocument.data.closing_note).toBe("Payment within 14 days.");

		await call("PUT", `${base()}/invoice-design`, token, { ...modern, layout: "compact", notes: { invoice: null, credit_note: null, receipt: null } });
		const second = await issue();
		expect((await call("GET", `${base()}/invoices/${second}/document`, token)).data.design.layout).toBe("compact");
		const again = await call("GET", `${base()}/invoices/${first}/document`, token);
		expect(again.data.design.layout).toBe("modern");
		expect(again.data.closing_note).toBe("Payment within 14 days.");

		const pdf = await send("GET", `${base()}/invoices/${first}/pdf`, token);
		expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
	});

	test("fall back to the default look when white label ends", async () => {
		await Database`UPDATE projects SET white_label_until = ${Date.now() - 1000} WHERE uuid = ${project}`;
		const state = await call("GET", `${base()}/invoice-design`, token);
		expect(state.data.design.layout).toBe("compact");
		expect(state.data.applied).toEqual(DEFAULT_INVOICE_DESIGN);
		const invoice = await issue();
		expect((await call("GET", `${base()}/invoices/${invoice}/document`, token)).data.design).toEqual(DEFAULT_INVOICE_DESIGN);
	});

	test("replace the unused invoice templates table", async () => {
		const sql = numericClient(new SQL("sqlite://:memory:", { safeIntegers: true }));
		await migrate(sql, "sqlite", MIGRATIONS.slice(0, 5));
		await sql.unsafe("CREATE TABLE IF NOT EXISTS invoice_templates(uuid TEXT PRIMARY KEY)");
		await migrate(sql, "sqlite");
		expect(await sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'invoice_templates'`).toHaveLength(0);
		const columns = (await sql.unsafe("PRAGMA table_info(projects)")) as { name: string }[];
		expect(columns.map((column) => column.name)).toContain("invoice_design");
		await sql.close();
	});
});
