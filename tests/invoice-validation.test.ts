import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { prepareTest } from "./environment";

await prepareTest(`sqlite://${import.meta.dir}/.invoice-validation.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { ErrorCode } = await import("../server/errors");

await Server.configure();

const password = new Bun.CryptoHasher("blake2b512").update("invoice-validation-owner").digest("hex");
let token = "";

interface ApiResponse {
	status: number;
	error: number;
	info: string;
	data?: any;
}

async function call(method: string, path: string, body?: unknown): Promise<ApiResponse> {
	const response = await Server.app.handle(
		new Request(`http://localhost${path}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	);
	return { status: response.status, ...((await response.json()) as Omit<ApiResponse, "status">) };
}

async function project(name: string, vatStatus: "registered" | "small_business" = "registered") {
	const created = await call("POST", "/api/v1/projects", { name, currency: "EUR" });
	const uuid = created.data.uuid as string;
	await call("PATCH", `/api/v1/projects/${uuid}`, { tax_country: "SI", vat_status: vatStatus, tax_currency: "EUR" });
	return uuid;
}

async function company(projectId: string, vatNumber: string | null = "SI12345678") {
	return call("PUT", `/api/v1/projects/${projectId}/company`, {
		legal_name: "Validation d.o.o.",
		address_line1: "Dunajska cesta 1",
		postal_code: "1000",
		city: "Ljubljana",
		country: "SI",
		vat_number: vatNumber,
		tax_number: "12345678",
	});
}

function invoice(overrides: Record<string, unknown> = {}) {
	return {
		due_date: Date.now() + 86400000,
		supply_date: Date.now(),
		items: [{ description: "Accounting", quantity: 1, unit_price: 10000, tax_rate: 22, tax_treatment: "domestic" }],
		...overrides,
	};
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await call("POST", "/api/v1/auth/register", {
		username: "invoice-validation-owner",
		email: "invoice-validation@example.com",
		password,
	});
	token = (await call("POST", "/api/v1/auth/login", { username: "invoice-validation-owner", password })).data.token;
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-wal", "-shm"]) {
		try {
			unlinkSync(`${import.meta.dir}/.invoice-validation.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("mandatory Slovenian invoice data", () => {
	test("allows incomplete drafts but blocks issuance without seller data", async () => {
		const projectId = await project("validation-incomplete");
		const draft = await call("POST", `/api/v1/projects/${projectId}/invoices`, invoice({ supply_date: null }));

		expect(draft.status).toBe(201);
		expect(draft.data.status).toBe("draft");

		const opened = await call("POST", `/api/v1/projects/${projectId}/invoices/${draft.data.uuid}/open`);
		expect(opened.status).toBe(409);
		expect(opened.error).toBe(ErrorCode.INVOICE_DATA_INCOMPLETE);
		const codes = opened.data.issues.map((issue: { code: string }) => issue.code);
		expect(codes).toEqual(expect.arrayContaining(["seller_legal_name", "seller_address", "seller_vat_number"]));
		expect(codes).not.toContain("supply_date");

		const unchanged = await call("GET", `/api/v1/projects/${projectId}/invoices/${draft.data.uuid}`);
		expect(unchanged.data.status).toBe("draft");
		expect(unchanged.data.supply_date).toBeNull();
	});

	test("uses the issue date as the supply date when none was entered", async () => {
		const projectId = await project("validation-supply-default");
		await company(projectId);
		const draft = await call("POST", `/api/v1/projects/${projectId}/invoices`, invoice({ supply_date: null }));

		const opened = await call("POST", `/api/v1/projects/${projectId}/invoices/${draft.data.uuid}/open`);
		expect(opened.status).toBe(200);
		expect(opened.data.supply_date).toBe(opened.data.issued_at);

		const direct = await call("POST", `/api/v1/projects/${projectId}/invoices`, invoice({ supply_date: null, status: "open" }));
		expect(direct.status).toBe(201);
		expect(direct.data.status).toBe("open");
		expect(direct.data.supply_date).toBe(direct.data.issued_at);
	});

	test("blocks incomplete business buyer data and opens after it is completed", async () => {
		const projectId = await project("validation-buyer");
		await company(projectId);
		const customer = await call("POST", `/api/v1/projects/${projectId}/customers`, {
			email: "buyer@example.com",
			customer_type: "business",
		});
		const draft = await call("POST", `/api/v1/projects/${projectId}/invoices`, invoice({ customer: customer.data.uuid }));

		const blocked = await call("POST", `/api/v1/projects/${projectId}/invoices/${draft.data.uuid}/open`);
		expect(blocked.error).toBe(ErrorCode.INVOICE_DATA_INCOMPLETE);
		expect(blocked.data.issues.map((issue: { code: string }) => issue.code)).toEqual(
			expect.arrayContaining(["buyer_name", "buyer_address", "buyer_postal_code", "buyer_city", "buyer_country"])
		);

		await call("PATCH", `/api/v1/projects/${projectId}/customers/${customer.data.uuid}`, {
			name: "Buyer d.o.o.",
			address_line1: "Trg 1",
			postal_code: "2000",
			city: "Maribor",
			country: "SI",
		});
		const opened = await call("POST", `/api/v1/projects/${projectId}/invoices/${draft.data.uuid}/open`);
		expect(opened.status).toBe(200);
		expect(opened.data.status).toBe("open");
	});

	test("requires tax bases for zero VAT and a buyer VAT ID for reverse charge", async () => {
		const projectId = await project("validation-tax");
		await company(projectId);
		const zero = await call(
			"POST",
			`/api/v1/projects/${projectId}/invoices`,
			invoice({ status: "open", items: [{ description: "Export", quantity: 1, unit_price: 10000, tax_rate: 0 }] })
		);
		expect(zero.error).toBe(ErrorCode.INVOICE_DATA_INCOMPLETE);
		expect(zero.data.issues.map((issue: { code: string }) => issue.code)).toContain("zero_vat_basis");

		const customer = await call("POST", `/api/v1/projects/${projectId}/customers`, {
			email: "reverse@example.com",
			name: "Reverse GmbH",
			address_line1: "Hauptstrasse 1",
			postal_code: "10115",
			city: "Berlin",
			country: "DE",
			customer_type: "business",
		});
		const reverse = await call(
			"POST",
			`/api/v1/projects/${projectId}/invoices`,
			invoice({
				status: "open",
				customer: customer.data.uuid,
				items: [{ description: "Consulting", quantity: 1, unit_price: 10000, tax_rate: 0, tax_treatment: "reverse_charge" }],
			})
		);
		expect(reverse.error).toBe(ErrorCode.INVOICE_DATA_INCOMPLETE);
		expect(reverse.data.issues.map((issue: { code: string }) => issue.code)).toContain("buyer_vat_number");
	});

	test("issues a domestic reverse charge invoice only to a Slovenian customer with a VAT ID", async () => {
		const projectId = await project("validation-76a");
		await company(projectId);
		const buyer = (country: string, vatNumber: string | null) =>
			call("POST", `/api/v1/projects/${projectId}/customers`, {
				email: `${country.toLowerCase()}-${vatNumber ?? "none"}@example.com`,
				name: "Gradnje d.o.o.",
				address_line1: "Cesta 1",
				postal_code: "2000",
				city: "Maribor",
				country,
				vat_number: vatNumber,
				customer_type: "business",
			});
		const issue = (customer: string, treatment: string) =>
			call(
				"POST",
				`/api/v1/projects/${projectId}/invoices`,
				invoice({ status: "open", customer, items: [{ description: "Gradbena dela", quantity: 1, unit_price: 10000, tax_rate: 0, tax_treatment: treatment }] })
			);
		const codes = (response: ApiResponse) => response.data.issues.map((entry: { code: string }) => entry.code);
		const slovenian = (await buyer("SI", "SI87654321")).data.uuid;

		const withoutVat = await issue((await buyer("SI", null)).data.uuid, "domestic_reverse_charge");
		expect(withoutVat.error).toBe(ErrorCode.INVOICE_DATA_INCOMPLETE);
		expect(codes(withoutVat)).toContain("domestic_reverse_buyer");

		const foreign = await issue((await buyer("DE", "DE123456789")).data.uuid, "domestic_reverse_charge");
		expect(codes(foreign)).toContain("domestic_reverse_buyer");

		const asEuSale = await issue(slovenian, "reverse_charge");
		expect(codes(asEuSale)).toContain("reverse_charge_domestic_buyer");

		const withVat = await call(
			"POST",
			`/api/v1/projects/${projectId}/invoices`,
			invoice({
				status: "open",
				customer: slovenian,
				items: [{ description: "Gradbena dela", quantity: 1, unit_price: 10000, tax_rate: 22, tax_treatment: "domestic_reverse_charge" }],
			})
		);
		expect(withVat.error).toBe(ErrorCode.INVALID_INVOICE_ITEMS);

		const issued = await issue(slovenian, "domestic_reverse_charge");
		expect(issued.error).toBe(0);
		expect(issued.data).toMatchObject({ status: "open", tax_amount: 0, total_amount: 10000 });

		const document = await call("GET", `/api/v1/projects/${projectId}/invoices/${issued.data.uuid}/document`);
		expect(document.data.tax.notes).toEqual([
			"Reverse charge: VAT is to be accounted for by the recipient under Article 76.a of the Slovenian VAT Act (ZDDV-1).",
		]);

		const report = await call("POST", `/api/v1/projects/${projectId}/reports/vat`);
		expect(report.data.zero_rated).toEqual([{ treatment: "domestic_reverse_charge", net: 10000 }]);
		expect(report.data.domestic_reverse_list).toEqual([{ vat_number: "SI87654321", net: 10000 }]);
		expect(report.data.ec_sales_list).toEqual([]);
	});

	test("refuses a domestic VAT rate that Slovenia does not have and mixing reverse charge lines with taxed ones", async () => {
		const projectId = await project("validation-rates");
		await company(projectId);
		const customer = await call("POST", `/api/v1/projects/${projectId}/customers`, {
			email: "gradnje@example.com",
			name: "Gradnje d.o.o.",
			address_line1: "Cesta 1",
			postal_code: "2000",
			city: "Maribor",
			country: "SI",
			vat_number: "SI87654321",
			customer_type: "business",
		});
		const issue = (items: unknown[], extra: Record<string, unknown> = {}) =>
			call("POST", `/api/v1/projects/${projectId}/invoices`, invoice({ status: "open", items, ...extra }));
		const line = (rate: number, treatment?: string) => ({ description: "Line", quantity: 1, unit_price: 10000, tax_rate: rate, tax_treatment: treatment });

		for (const items of [[line(7, "domestic")], [line(22, "domestic"), line(15)]]) {
			const refused = await issue(items);
			expect(refused.error).toBe(ErrorCode.INVOICE_DATA_INCOMPLETE);
			expect(refused.data.issues.map((entry: { code: string }) => entry.code)).toEqual(["domestic_vat_rate"]);
		}
		expect((await issue([line(22, "domestic"), line(9.5, "domestic"), line(5)])).error).toBe(0);

		const french = await call("POST", `/api/v1/projects/${projectId}/customers`, { email: "fr@example.fr", country: "FR", customer_type: "individual" });
		expect((await issue([line(20, "oss")], { customer: french.data.uuid })).error).toBe(0);

		const mixed = await issue([line(0, "domestic_reverse_charge"), line(22, "domestic")], { customer: customer.data.uuid });
		expect(mixed.error).toBe(ErrorCode.INVOICE_DATA_INCOMPLETE);
		expect(mixed.data.issues.map((entry: { code: string }) => entry.code)).toEqual(["domestic_reverse_mixed"]);
		expect((await issue([line(0, "domestic_reverse_charge"), line(0, "domestic_reverse_charge")], { customer: customer.data.uuid })).error).toBe(0);
	});

	test("refuses the domestic reverse charge from a seller that is not VAT registered", async () => {
		const projectId = await project("validation-76a-small", "small_business");
		await company(projectId, null);
		const customer = await call("POST", `/api/v1/projects/${projectId}/customers`, {
			email: "kupec@example.com",
			name: "Kupec d.o.o.",
			address_line1: "Cesta 1",
			postal_code: "2000",
			city: "Maribor",
			country: "SI",
			vat_number: "SI87654321",
			customer_type: "business",
		});
		const refused = await call(
			"POST",
			`/api/v1/projects/${projectId}/invoices`,
			invoice({
				status: "open",
				customer: customer.data.uuid,
				items: [{ description: "Gradbena dela", quantity: 1, unit_price: 10000, tax_rate: 0, tax_treatment: "domestic_reverse_charge" }],
			})
		);
		expect(refused.data.issues.map((entry: { code: string }) => entry.code)).toContain("domestic_reverse_seller");
	});

	test("prevents a small business from charging VAT", async () => {
		const projectId = await project("validation-small-business", "small_business");
		await company(projectId, null);
		const issued = await call("POST", `/api/v1/projects/${projectId}/invoices`, invoice({ status: "open" }));

		expect(issued.error).toBe(ErrorCode.INVOICE_DATA_INCOMPLETE);
		expect(issued.data.issues.map((issue: { code: string }) => issue.code)).toContain("vat_not_allowed");

		const exempt = await call(
			"POST",
			`/api/v1/projects/${projectId}/invoices`,
			invoice({ status: "open", items: [{ description: "Accounting", quantity: 1, unit_price: 10000, tax_rate: 0 }] })
		);
		expect(exempt.status).toBe(201);
	});

	test("requires a selected customer type before deciding which buyer fields apply", async () => {
		const projectId = await project("validation-buyer-type");
		await company(projectId);
		const customer = await call("POST", `/api/v1/projects/${projectId}/customers`, { email: "unclassified@example.com" });
		const issued = await call("POST", `/api/v1/projects/${projectId}/invoices`, invoice({ status: "open", customer: customer.data.uuid }));

		expect(issued.error).toBe(ErrorCode.INVOICE_DATA_INCOMPLETE);
		expect(issued.data.issues.map((issue: { code: string }) => issue.code)).toContain("buyer_type");
	});

	test("does not require buyer identity for a consumer invoice", async () => {
		const projectId = await project("validation-consumer");
		await company(projectId);
		const issued = await call("POST", `/api/v1/projects/${projectId}/invoices`, invoice({ status: "open", customer: null }));

		expect(issued.status).toBe(201);
		expect(issued.data.status).toBe("open");
	});
});

describe("customers without an email address", () => {
	test("can be saved with only a name, more than once, and still need a name or an email", async () => {
		const projectId = await project("validation-no-email");
		const base = `/api/v1/projects/${projectId}/customers`;

		const first = await call("POST", base, { name: "Kmetija Novak", country: "SI", customer_type: "individual" });
		const second = await call("POST", base, { name: "Kmetija Kranjc", email: "  ", country: "SI" });
		expect(first.error).toBe(0);
		expect(first.data.email).toBeNull();
		expect(second.data.email).toBeNull();

		expect((await call("POST", base, { phone: "041 123 456" })).error).toBe(ErrorCode.CUSTOMER_IDENTITY_MISSING);
		expect((await call("POST", base, { name: "  " })).error).toBe(ErrorCode.CUSTOMER_IDENTITY_MISSING);
		expect((await call("POST", base, { name: "Bad", email: "not an email" })).error).toBe(ErrorCode.INVALID_EMAIL);

		const withEmail = await call("POST", base, { email: "shared@example.com" });
		expect((await call("POST", base, { name: "Same address", email: "shared@example.com" })).error).toBe(ErrorCode.CUSTOMER_ALREADY_EXISTS);
		expect((await call("PATCH", `${base}/${withEmail.data.uuid}`, { email: null })).error).toBe(ErrorCode.CUSTOMER_IDENTITY_MISSING);

		const cleared = await call("PATCH", `${base}/${withEmail.data.uuid}`, { name: "Now named", email: null });
		expect(cleared.data).toMatchObject({ name: "Now named", email: null });
		const added = await call("PATCH", `${base}/${first.data.uuid}`, { email: "novak@example.com" });
		expect(added.data.email).toBe("novak@example.com");

		const found = await call("GET", `${base}?search=Kranjc`);
		expect(found.data.customers.map((customer: { uuid: string }) => customer.uuid)).toEqual([second.data.uuid]);
	});

	test("are reported as possible duplicates when the VAT or tax number matches another customer", async () => {
		const projectId = await project("validation-duplicates");
		const base = `/api/v1/projects/${projectId}`;
		const acme = (await call("POST", `${base}/customers`, { name: "Acme d.o.o.", country: "SI", vat_number: "SI12345678" })).data;
		const farm = (await call("POST", `${base}/customers`, { name: "Kmetija Novak", country: "SI", tax_number: "876 543 21" })).data;
		await call("POST", `${base}/customers`, { name: "Unrelated", country: "SI", tax_number: "11112222" });
		const matches = async (query: string) =>
			(await call("GET", `${base}/customer-duplicates?${query}`)).data.customers.map((customer: { uuid: string }) => customer.uuid);

		expect(await matches("vat_number=SI12345678")).toEqual([acme.uuid]);
		expect(await matches("vat_number=12345678&country=SI")).toEqual([acme.uuid]);
		expect(await matches("tax_number=12345678")).toEqual([acme.uuid]);
		expect(await matches("tax_number=si%2012.345.678")).toEqual([acme.uuid]);
		expect(await matches("tax_number=87654321")).toEqual([farm.uuid]);
		expect(await matches("vat_number=SI87654321")).toEqual([farm.uuid]);
		expect(await matches(`vat_number=SI12345678&exclude=${acme.uuid}`)).toEqual([]);
		expect(await matches("tax_number=345678")).toEqual([]);
		expect(await matches("tax_number=99999999")).toEqual([]);
		expect(await matches("")).toEqual([]);
		expect((await call("GET", `${base}/customer-duplicates?vat_number=SI12345678&exclude=nope`)).error).toBe(ErrorCode.INVALID_CUSTOMER_ID);

		const twin = await call("POST", `${base}/customers`, { name: "Acme, second site", country: "SI", vat_number: "SI12345678" });
		expect(twin.error).toBe(0);
		expect(await matches("tax_number=12345678")).toEqual([acme.uuid, twin.data.uuid]);
	});

	test("can be invoiced, and the invoice is printed instead of emailed", async () => {
		const projectId = await project("validation-no-email-invoice");
		await company(projectId);
		const customer = await call("POST", `/api/v1/projects/${projectId}/customers`, { name: "Janez Novak", country: "SI", customer_type: "individual" });
		const issued = await call("POST", `/api/v1/projects/${projectId}/invoices`, invoice({ status: "open", customer: customer.data.uuid }));
		expect(issued.error).toBe(0);
		expect(issued.data.buyer_email).toBeNull();

		const document = await call("GET", `/api/v1/projects/${projectId}/invoices/${issued.data.uuid}/document`);
		expect(document.data.buyer).toMatchObject({ name: "Janez Novak", email: null });

		const pdf = await Server.app.handle(
			new Request(`http://127.0.0.1/api/v1/projects/${projectId}/invoices/${issued.data.uuid}/pdf`, { headers: { Authorization: `Bearer ${token}` } })
		);
		expect(pdf.headers.get("Content-Type")).toBe("application/pdf");

		const emailed = await call("POST", `/api/v1/projects/${projectId}/invoices/${issued.data.uuid}/email`, {});
		expect([ErrorCode.EMAIL_RECIPIENT_MISSING, ErrorCode.EMAIL_NOT_CONFIGURED]).toContain(emailed.error);
	});
});
