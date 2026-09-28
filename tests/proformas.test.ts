import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { prepareTest } from "./environment";

await prepareTest();

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { Settings } = await import("../server/settings");
const { setTransport } = await import("../server/email/mailer");
const { default: Auth } = await import("../server/auth");
const { issuePaidDrafts } = await import("../server/paid-drafts");
const { formatsCanCollide, parseInvoiceFormat } = await import("../server/invoice-format");

interface Result {
	status: number;
	error: number;
	info: string;
	data: any;
}

async function call(method: string, path: string, body?: unknown): Promise<Result> {
	const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const response = await Server.app.handle(
		new Request(`http://127.0.0.1/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
	);
	return { status: response.status, ...((await response.json()) as Omit<Result, "status">) };
}

async function raw(path: string): Promise<Response> {
	return await Server.app.handle(new Request(`http://127.0.0.1/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` } }));
}

let token = "";
let project = "";
let customer = "";
const year = String(new Date().getFullYear());
const base = () => `/projects/${project}`;

const LINES = [
	{ description: "Website", quantity: 1, unit_price: 100000, tax_rate: 22 },
	{ description: "Printed manual", quantity: 2, unit_price: 5000, tax_rate: 9.5 },
];

async function proforma(settlement?: "invoice" | "advance", items = LINES) {
	const draft = await call("POST", `${base()}/invoices`, { customer, due_date: Date.now() + 15 * 86400000, items });
	expect(draft.error).toBe(0);
	const converted = await call("POST", `${base()}/invoices/${draft.data.uuid}/proforma`, settlement ? { settlement } : {});
	expect(converted.status).toBe(201);
	return converted.data;
}

async function pay(invoice: string, amount: number) {
	const paid = await call("POST", `${base()}/transactions`, { invoice, processor: "bank_transfer", amount });
	expect(paid.error).toBe(0);
	await issuePaidDrafts();
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await Server.configure();
	Settings.email.enabled = true;
	setTransport({ sendMail: async () => ({ messageId: "proforma-test" }) } as never);

	const now = Date.now();
	await Database`
		INSERT INTO accounts(username, email, password, created, updated, accessed) VALUES('pf-owner', 'owner@pf.test', 'unused', ${now}, ${now}, ${now})
	`;
	token = (await Auth.createSession("pf-owner", ""))!;
	project = (await call("POST", "/projects", { name: "pf-studio", currency: "EUR" })).data.uuid;
	await call("PATCH", base(), { tax_country: "SI", vat_status: "registered", tax_currency: "EUR" });
	await call("PUT", `${base()}/company`, {
		legal_name: "Studio d.o.o.",
		address_line1: "Dunajska cesta 1",
		postal_code: "1000",
		city: "Ljubljana",
		country: "SI",
		vat_number: "SI12345678",
	});
	customer = (
		await call("POST", `${base()}/customers`, {
			email: "buyer@pf.test",
			name: "Kupec d.o.o.",
			address_line1: "Trg 1",
			postal_code: "2000",
			city: "Maribor",
			country: "SI",
			customer_type: "business",
			vat_number: "SI87654321",
		})
	).data.uuid;
	await call("PUT", `${base()}/processors/bank_transfer`, { enabled: true, config: { iban: "SI56 1910 0000 0123 438", account_holder: "Studio d.o.o." } });
});

afterAll(async () => {
	await Database.close();
});

describe("number series", () => {
	test("formats accept quoted text and refuse formats that could produce the same numbers", async () => {
		const quoted = parseInvoiceFormat('"ORDER"-YYXXXX');
		expect(quoted.ok).toBe(true);
		expect(parseInvoiceFormat('"ORDER-YYXX').ok).toBe(false);
		const parsed = (source: string) => (parseInvoiceFormat(source) as { ok: true; format: any }).format;
		expect(formatsCanCollide(parsed("YYXXXXXX"), parsed("XXXXXXXX"))).toBe(true);
		expect(formatsCanCollide(parsed("PR-XXXXXX"), parsed("XXXXXXXXX"))).toBe(false);
		expect(formatsCanCollide(parsed("1XXXX"), parsed("XXXXX"))).toBe(true);
	});

	test("each series has its own format, next number and bank reference check", async () => {
		const proformas = await call("GET", `${base()}/invoice-numbering?series=proforma`);
		expect(proformas.data).toMatchObject({
			series: "proforma",
			format: "PR-YYYY-XXXXX",
			next_number: 1,
			next_reference: `PR-${year}-00001`,
			bank_reference: true,
		});
		const orders = await call("GET", `${base()}/invoice-numbering?series=order`);
		expect(orders.data.format).toBe('"ORDER"-YYXXXXXX');

		const clash = await call("PUT", `${base()}/invoice-numbering`, { series: "proforma", format: "YYMMDDXXXXXX" });
		expect(clash.error).toBe(1106);
		expect(clash.info).toContain("same numbers as invoices");
		const saved = await call("PUT", `${base()}/invoice-numbering`, { series: "proforma", format: "PR-XXXXXX", next_number: 41 });
		expect(saved.data).toMatchObject({ format: "PR-XXXXXX", next_reference: "PR-000041" });
		const invoices = await call("GET", `${base()}/invoice-numbering`);
		expect(invoices.data.series).toBe("invoice");
		expect((await call("GET", base())).data).toMatchObject({ proforma_format: "PR-XXXXXX", invoice_format: "YYMMDDXXXXXX" });
	});
});

describe("pro forma invoices", () => {
	let first: any;

	test("a draft becomes a numbered pro forma that can be edited, emailed and paid, but not deleted", async () => {
		first = await proforma();
		expect(first).toMatchObject({ reference: "PR-000041", status: "draft", document: "proforma", proforma: { reference: "PR-000041", settlement: "invoice" } });
		expect((await call("POST", `${base()}/invoices/${first.uuid}/proforma`, {})).error).toBe(1044);

		const edited = await call("PATCH", `${base()}/invoices/${first.uuid}`, { notes: "Delivery in two weeks" });
		expect(edited.error).toBe(0);
		expect((await call("DELETE", `${base()}/invoices/${first.uuid}`)).error).toBe(1041);

		const listed = await call("GET", `${base()}/invoices?document=proforma`);
		expect(listed.data.invoices.map((invoice: any) => invoice.reference)).toEqual(["PR-000041"]);
		expect(listed.data.invoices[0].document).toBe("proforma");

		const pdf = await raw(`${base()}/invoices/${first.uuid}/pdf`);
		expect(pdf.headers.get("Content-Disposition")).toContain("Pro forma invoice PR-000041.pdf");
		const printed = await call("GET", `${base()}/invoices/${first.uuid}/document`);
		expect(printed.data).toMatchObject({ kind: "proforma", proforma: { reference: "PR-000041", settlement: "invoice" } });
		expect(printed.data.bank.reference).toMatch(/^RF/);

		const email = await call("POST", `${base()}/invoices/${first.uuid}/email`, {});
		expect(email.error).toBe(0);
		const [queued] = await Database`SELECT kind, subject, attachment_name FROM email_messages WHERE invoice = ${first.uuid}`;
		expect(queued).toMatchObject({ kind: "proforma", attachment_name: "Pro forma invoice PR-000041.pdf" });
		expect(queued.subject).toContain("PR-000041");

		const page = await call("GET", `/public/invoices/${first.uuid}`);
		expect(page.data).toMatchObject({ document: "proforma", payable: true, reference: "PR-000041" });
		const transfer = await call("POST", `/public/invoices/${first.uuid}/pay/bank_transfer`, {});
		expect(transfer.data.reference).toMatch(/^RF/);
	});

	test("paying a pro forma settled with the invoice issues it and keeps the pro forma number", async () => {
		await pay(first.uuid, 132950);
		const issued = await call("GET", `${base()}/invoices/${first.uuid}`);
		expect(issued.data).toMatchObject({ status: "paid", document: "invoice", proforma: { reference: "PR-000041" } });
		expect(issued.data.reference).toMatch(/^[0-9]{12}$/);
		const [email] = await Database`SELECT attachment_name FROM email_messages WHERE invoice = ${first.uuid} AND kind = 'invoice'`;
		expect(email.attachment_name).toContain(issued.data.reference);
	});

	test("a pro forma settled with advance invoices gets one advance invoice per payment, split by VAT rate", async () => {
		const pf = await proforma("advance");
		expect(pf.total_amount).toBe(132950);

		await pay(pf.uuid, 50000);
		let state = (await call("GET", `${base()}/invoices/${pf.uuid}`)).data;
		expect(state).toMatchObject({ status: "draft", paid_amount: 0, advanced_amount: 50000 });
		expect(state.advances).toHaveLength(1);
		const first = (await call("GET", `${base()}/invoices/${state.advances[0].uuid}`)).data;
		expect(first).toMatchObject({ document: "advance", document_type: "advance", status: "paid", total_amount: 50000, paid_amount: 50000 });
		expect(first.source_proforma.reference).toBe(pf.reference);
		expect(first.items.map((item: any) => item.tax_rate)).toEqual([22, 9.5]);
		expect(first.items.reduce((sum: number, item: any) => sum + item.total_price + item.tax_amount, 0)).toBe(50000);
		const moved = await Database`SELECT invoice FROM transactions WHERE invoice = ${first.uuid}`;
		expect(moved).toHaveLength(1);

		const eslog = await (await raw(`${base()}/invoices/${first.uuid}/eslog`)).text();
		expect(eslog).toContain("<D_1001>386</D_1001>");
		const pdf = await raw(`${base()}/invoices/${first.uuid}/pdf`);
		expect(pdf.headers.get("Content-Disposition")).toContain(`Advance invoice ${first.reference}.pdf`);

		const page = await call("GET", `/public/invoices/${pf.uuid}`);
		expect(page.data).toMatchObject({ outstanding: 82950, payable: true });
		await pay(pf.uuid, 82950);
		state = (await call("GET", `${base()}/invoices/${pf.uuid}`)).data;
		expect(state.advances).toHaveLength(2);
		expect(state.advanced_amount).toBe(132950);
		expect((await call("GET", `/public/invoices/${pf.uuid}`)).data.payable).toBe(false);
		expect((await call("POST", `${base()}/invoices/${pf.uuid}/cancel`, {})).error).toBe(1245);
		expect((await call("PATCH", `${base()}/invoices/${pf.uuid}`, { notes: "Changed" })).error).toBe(1041);

		const final = await call("POST", `${base()}/invoices/${pf.uuid}/open`);
		expect(final.error).toBe(0);
		expect(final.data).toMatchObject({ status: "paid", total_amount: 0, advanced_amount: 0, document: "invoice" });
		const deductions = final.data.items.filter((item: any) => item.metadata?.advance_deduction);
		expect(deductions).toHaveLength(4);
		expect(deductions.every((item: any) => item.total_price < 0 && item.tax_amount <= 0)).toBe(true);

		const documents = await Database`
			SELECT subtotal, tax_amount FROM invoices WHERE uuid = ${pf.uuid} OR proforma = ${pf.uuid}
		`;
		const net = documents.reduce((sum: number, row: any) => sum + Number(row.subtotal), 0);
		const tax = documents.reduce((sum: number, row: any) => sum + Number(row.tax_amount), 0);
		expect(net + tax).toBe(132950);
	});

	test("crediting an advance invoice lowers what the pro forma counts as paid", async () => {
		const pf = await proforma("advance");
		await pay(pf.uuid, 40000);
		const state = (await call("GET", `${base()}/invoices/${pf.uuid}`)).data;
		const advance = state.advances[0].uuid;
		const credited = await call("POST", `${base()}/invoices/${advance}/credit-notes`, {});
		expect(credited.error).toBe(0);
		const after = (await call("GET", `${base()}/invoices/${pf.uuid}`)).data;
		expect(after.advanced_amount).toBe(0);
		expect((await call("POST", `${base()}/invoices/${pf.uuid}/cancel`, {})).error).toBe(0);
		expect((await call("GET", `${base()}/invoices/${pf.uuid}`)).data.status).toBe("canceled");
	});

	test("the settlement can change until the first payment, and has a project default", async () => {
		expect((await call("PATCH", base(), { proforma_settlement: "sometimes" })).error).toBe(1244);
		expect((await call("PATCH", base(), { proforma_settlement: "advance" })).data.proforma_settlement).toBe("advance");
		const pf = await proforma();
		expect(pf.proforma.settlement).toBe("advance");
		const changed = await call("PATCH", `${base()}/invoices/${pf.uuid}/proforma`, { settlement: "invoice" });
		expect(changed.data.proforma.settlement).toBe("invoice");
		await call("POST", `${base()}/transactions`, { invoice: pf.uuid, processor: "bank_transfer", amount: 100, status: "pending" });
		await Database`UPDATE invoices SET paid_amount = 100 WHERE uuid = ${pf.uuid}`;
		expect((await call("PATCH", `${base()}/invoices/${pf.uuid}/proforma`, { settlement: "advance" })).error).toBe(1041);
	});
});
