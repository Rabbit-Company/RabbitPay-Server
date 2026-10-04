import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { ErrorCode } from "../server/errors";
import type { EslogSource } from "../server/eslog";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.einvoice-import.sqlite`);

const { parseXml, XmlSyntaxError, textOf } = await import("../server/xml-reader");
const { readIncomingInvoice, EinvoiceUnreadable } = await import("../server/einvoice-import");
const { eslogXml } = await import("../server/eslog");
const { credentialsFromPkcs12 } = await import("../server/furs/credentials");
const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");

await Server.configure();

const encoder = new TextEncoder();

function eslogSource(overrides: Partial<EslogSource> = {}): EslogSource {
	return {
		kind: "invoice",
		reference: "2026-0077",
		issued: Date.UTC(2026, 8, 20, 10),
		supply_date: Date.UTC(2026, 8, 19, 10),
		due_date: Date.UTC(2026, 9, 20, 10),
		timezone: "Europe/Ljubljana",
		language: "sl",
		currency: "EUR",
		notes: [],
		seller: {
			name: "Hosting",
			legal_name: "Hosting d.o.o.",
			address_line1: "Tržaška cesta 5",
			address_line2: null,
			postal_code: "1000",
			city: "Ljubljana",
			state: null,
			country: "SI",
			vat_number: "SI55555555",
			tax_number: null,
			registration_number: null,
			email: "billing@hosting.si",
			phone: null,
			website: null,
			footer_note: null,
		},
		buyer: {
			name: "Uvoz d.o.o.",
			email: "ap@uvoz.si",
			phone: null,
			address_line1: "Dunajska cesta 1",
			address_line2: null,
			postal_code: "1000",
			city: "Ljubljana",
			state: null,
			country: "SI",
			vat_number: "SI12345678",
			tax_number: null,
			registration_number: null,
			iban: null,
			bic: null,
			customer_type: "business",
		},
		vat_status: "registered",
		exemption_note: null,
		reporting: null,
		lines: [
			{ description: "Strežnik", quantity: 1, unit: "MON", price: 10000, amount: 10000, allowance: 0, tax_rate: 22, tax_amount: 2200, treatment: "domestic" },
			{ description: "Priročnik", quantity: 2, unit: null, price: 1000, amount: 2000, allowance: 0, tax_rate: 9.5, tax_amount: 190, treatment: "domestic" },
		],
		prepaid: 0,
		bank: {
			account: { iban: "SI56191000000123438", bic: null, holder: "Hosting d.o.o.", bank_name: null },
			reference: "SI00 20260077",
			amount: 14390,
			currency: "EUR",
			qr: null,
			qr_unavailable: null,
		},
		card: false,
		fiscal: null,
		corrects: null,
		reference_document: null,
		...overrides,
	};
}

const ubl = (overrides: { number?: string; category?: string; percent?: string; tax?: string } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
	<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
	<cbc:ID>${overrides.number ?? "AT-2026-19"}</cbc:ID>
	<cbc:IssueDate>2026-09-15</cbc:IssueDate>
	<cbc:DueDate>2026-10-15</cbc:DueDate>
	<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
	<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
	<cac:AccountingSupplierParty>
		<cac:Party>
			<cac:PostalAddress><cbc:CityName>Wien</cbc:CityName><cac:Country><cbc:IdentificationCode>AT</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
			<cac:PartyTaxScheme><cbc:CompanyID>ATU12345678</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
			<cac:PartyLegalEntity><cbc:RegistrationName>Cloud &amp; Co GmbH</cbc:RegistrationName></cac:PartyLegalEntity>
		</cac:Party>
	</cac:AccountingSupplierParty>
	<cac:AccountingCustomerParty>
		<cac:Party>
			<cac:PostalAddress><cac:Country><cbc:IdentificationCode>SI</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
			<cac:PartyTaxScheme><cbc:CompanyID>SI12345678</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
			<cac:PartyLegalEntity><cbc:RegistrationName>Uvoz d.o.o.</cbc:RegistrationName></cac:PartyLegalEntity>
		</cac:Party>
	</cac:AccountingCustomerParty>
	<cac:PaymentMeans>
		<cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>
		<cbc:PaymentID>RF18539007547034</cbc:PaymentID>
		<cac:PayeeFinancialAccount><cbc:ID>AT611904300234573201</cbc:ID></cac:PayeeFinancialAccount>
	</cac:PaymentMeans>
	<cac:TaxTotal>
		<cbc:TaxAmount currencyID="EUR">${overrides.tax ?? "0.00"}</cbc:TaxAmount>
		<cac:TaxSubtotal>
			<cbc:TaxableAmount currencyID="EUR">500.00</cbc:TaxableAmount>
			<cbc:TaxAmount currencyID="EUR">${overrides.tax ?? "0.00"}</cbc:TaxAmount>
			<cac:TaxCategory><cbc:ID>${overrides.category ?? "AE"}</cbc:ID><cbc:Percent>${overrides.percent ?? "0"}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
		</cac:TaxSubtotal>
	</cac:TaxTotal>
	<cac:LegalMonetaryTotal>
		<cbc:LineExtensionAmount currencyID="EUR">500.00</cbc:LineExtensionAmount>
		<cbc:TaxExclusiveAmount currencyID="EUR">500.00</cbc:TaxExclusiveAmount>
		<cbc:TaxInclusiveAmount currencyID="EUR">${(500 + Number(overrides.tax ?? "0")).toFixed(2)}</cbc:TaxInclusiveAmount>
		<cbc:PayableAmount currencyID="EUR">${(500 + Number(overrides.tax ?? "0")).toFixed(2)}</cbc:PayableAmount>
	</cac:LegalMonetaryTotal>
	<cac:InvoiceLine>
		<cbc:ID>1</cbc:ID>
		<cbc:InvoicedQuantity unitCode="HUR">5</cbc:InvoicedQuantity>
		<cbc:LineExtensionAmount currencyID="EUR">500.00</cbc:LineExtensionAmount>
		<cac:Item><cbc:Name>Cloud consulting</cbc:Name></cac:Item>
		<cac:Price><cbc:PriceAmount currencyID="EUR">100.00</cbc:PriceAmount></cac:Price>
	</cac:InvoiceLine>
</Invoice>`;

describe("reading XML safely", () => {
	test("reads elements, attributes, entities and CDATA", () => {
		const root = parseXml(
			`<?xml version="1.0"?><!-- note --><a:Root xmlns:a="x" note='1 > 0'><a:Item>Tom &amp; Jerry &#x10D;</a:Item><Raw><![CDATA[<b>&</b>]]></Raw><Empty/></a:Root>`
		);

		expect(root.name).toBe("Root");
		expect(root.attributes["note"]).toBe("1 > 0");
		expect(textOf(root, "Item")).toBe("Tom & Jerry č");
		expect(textOf(root, "Raw")).toBe("<b>&</b>");
		expect(root.children.map((element) => element.name)).toEqual(["Item", "Raw", "Empty"]);
	});

	test("never reads external entities and stops entity expansion bombs", () => {
		const external = parseXml(`<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>`);
		expect(external.text).toBe("&x;");

		const levels = ["a", "b", "c", "d", "e", "f", "g", "h"];
		const declarations = levels.map((name, index) => `<!ENTITY ${name} "${index === 0 ? "aaaaaaaaaa" : `&${levels[index - 1]};`.repeat(10)}">`).join("");
		expect(() => parseXml(`<!DOCTYPE r [${declarations}]><r>&h;</r>`)).toThrow(XmlSyntaxError);
	});

	test("refuses unknown entities and broken structure", () => {
		const attempts = [`<r>&nbsp;</r>`, `<r><a></r>`, `<r/><r/>`, `<r>`, `text`];
		for (const xml of attempts) expect(() => parseXml(xml)).toThrow(XmlSyntaxError);
	});
});

describe("reading incoming e-invoices", () => {
	test("reads an e-SLOG 2.0 invoice back with its parties, VAT and payment details", () => {
		const invoice = readIncomingInvoice(encoder.encode(eslogXml(eslogSource())));

		expect(invoice.format).toBe("eslog");
		expect(invoice.document_type).toBe("invoice");
		expect(invoice.number).toBe("2026-0077");
		expect([invoice.issue_date, invoice.supply_date, invoice.due_date]).toEqual(["2026-09-20", "2026-09-19", "2026-10-20"]);
		expect(invoice.seller).toEqual({ name: "Hosting d.o.o.", vat_number: "SI55555555", tax_number: "SI55555555", country: "SI" });
		expect(invoice.buyer.vat_number).toBe("SI12345678");
		expect(invoice.vat).toEqual([
			{ category: "S", rate: 22, taxable: 10000, tax: 2200 },
			{ category: "S", rate: 9.5, taxable: 2000, tax: 190 },
		]);
		expect([invoice.net_total, invoice.tax_total, invoice.gross_total, invoice.amount_due]).toEqual([12000, 2390, 14390, 14390]);
		expect(invoice.lines.map((line) => line.description)).toEqual(["Strežnik", "Priročnik"]);
		expect(invoice.iban).toBe("SI56191000000123438");
		expect(invoice.payment_reference).toBe("SI00 20260077");
	});

	test("reads a signed e-SLOG file", async () => {
		const p12 = new Uint8Array(await Bun.file(join(import.meta.dir, "fixtures", "eslog", "signer-ec.p12")).arrayBuffer());
		const signed = eslogXml(eslogSource(), { credentials: credentialsFromPkcs12(p12, "ectest"), signedAt: Date.now() });

		expect(signed).toContain("<ds:Signature");
		expect(readIncomingInvoice(encoder.encode(signed)).gross_total).toBe(14390);
	});

	test("reads an e-SLOG file saved in windows-1250", () => {
		const xml = eslogXml(eslogSource()).replace('encoding="UTF-8"', 'encoding="windows-1250"');
		const windows1250: Record<string, number> = { č: 0xe8, ž: 0x9e, š: 0x9a, Č: 0xc8, Ž: 0x8e, Š: 0x8a };
		const bytes = new Uint8Array([...xml].map((character) => windows1250[character] ?? character.charCodeAt(0)));
		expect([...xml].every((character) => character in windows1250 || character.charCodeAt(0) < 0x80)).toBe(true);

		const invoice = readIncomingInvoice(bytes);
		expect(invoice.lines.map((line) => line.description)).toEqual(["Strežnik", "Priročnik"]);
	});

	test("reads a Peppol UBL 2.1 invoice", () => {
		const invoice = readIncomingInvoice(encoder.encode(ubl()));

		expect(invoice.format).toBe("ubl");
		expect(invoice.number).toBe("AT-2026-19");
		expect(invoice.seller).toEqual({ name: "Cloud & Co GmbH", vat_number: "ATU12345678", tax_number: null, country: "AT" });
		expect(invoice.vat).toEqual([{ category: "AE", rate: 0, taxable: 50000, tax: 0 }]);
		expect(invoice.gross_total).toBe(50000);
		expect(invoice.lines).toEqual([{ description: "Cloud consulting", quantity: 5, amount: 50000 }]);
		expect(invoice.iban).toBe("AT611904300234573201");
		expect(invoice.due_date).toBe("2026-10-15");
	});

	test("rejects files that are not e-invoices", () => {
		for (const content of ["not xml", "<Invoice/>", `<Order xmlns="urn:eslog:2.00"/>`]) {
			expect(() => readIncomingInvoice(encoder.encode(content))).toThrow(EinvoiceUnreadable);
		}
	});
});

interface ApiResponse {
	status: number;
	error: number;
	info: string;
	data?: any;
}

const password = (seed: string) => new Bun.CryptoHasher("blake2b512").update(seed).digest("hex");

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<ApiResponse> {
	const headers: Record<string, string> = {};
	if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
	if (options.body !== undefined) headers["Content-Type"] = "application/json";
	const res = await Server.app.handle(
		new Request(`http://127.0.0.1${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
	);
	return { status: res.status, ...((await res.json()) as { error: number; info: string; data?: unknown }) };
}

let ownerToken = "";
let projectUuid = "";
const base = () => `/api/v1/projects/${projectUuid}`;
const upload = (xml: string, name = "invoice.xml") => ({ data: Buffer.from(xml).toString("base64"), name });

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	await call("POST", "/api/v1/auth/register", { body: { email: "import-owner@example.com", password: password("import-owner") } });
	ownerToken = (await call("POST", "/api/v1/auth/login", { body: { email: "import-owner@example.com", password: password("import-owner") } })).data.token;
	projectUuid = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "import-shop", currency: "EUR" } })).data.uuid;
	await call("PATCH", base(), { token: ownerToken, body: { tax_country: "SI", vat_status: "registered", tax_currency: "EUR", language: "sl" } });
	await call("PUT", `${base()}/company`, {
		token: ownerToken,
		body: { legal_name: "Uvoz d.o.o.", address_line1: "Dunajska cesta 1", postal_code: "1000", city: "Ljubljana", country: "SI", vat_number: "SI12345678" },
	});
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.einvoice-import.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("importing into expenses", () => {
	test("previews a domestic e-SLOG invoice as a ready expense", async () => {
		const res = await call("POST", `${base()}/expenses/import/preview`, { token: ownerToken, body: upload(eslogXml(eslogSource())) });
		const expense = res.data.expense;

		expect(res.error).toBe(0);
		expect(res.data.warnings).toEqual([]);
		expect(res.data.duplicate).toBeNull();
		expect(expense).toMatchObject({
			supplier: "Hosting d.o.o.",
			supplier_tax_number: "SI55555555",
			supplier_country: "SI",
			invoice_number: "2026-0077",
			category: "Other",
			currency: "EUR",
			total_amount: 14390,
			tax_amount: 2390,
			deductible_tax_amount: 2390,
			vat_treatment: "domestic",
			paid_at: null,
			description: "Račun 2026-0077, Hosting d.o.o.",
		});
		expect(expense.vat_lines).toEqual([
			{ rate: 22, tax_base: 10000, tax_amount: 2200, deductible_tax_amount: 2200 },
			{ rate: 9.5, tax_base: 2000, tax_amount: 190, deductible_tax_amount: 190 },
		]);
		expect(expense.notes).toContain("IBAN SI56191000000123438");
		expect(expense.notes).toContain("Sklic SI00 20260077");
		expect((await call("GET", `${base()}/expenses`, { token: ownerToken })).data.total).toBe(0);
	});

	test("imports the invoice with the original XML attached and refuses it a second time", async () => {
		const xml = eslogXml(eslogSource());
		const res = await call("POST", `${base()}/expenses/import`, { token: ownerToken, body: upload(xml, "Racun 2026-0077.xml") });

		expect(res.status).toBe(201);
		expect(res.data.expense.attachment).toMatchObject({ file_name: "Racun 2026-0077.xml", content_type: "application/xml" });
		const attachment = await Server.app.handle(
			new Request(`http://127.0.0.1${base()}/expenses/${res.data.expense.uuid}/attachment`, { headers: { Authorization: `Bearer ${ownerToken}` } })
		);
		expect(await attachment.text()).toBe(xml);

		const again = await call("POST", `${base()}/expenses/import`, { token: ownerToken, body: upload(xml) });
		expect(again.error).toBe(ErrorCode.EXPENSE_ALREADY_IMPORTED);
		expect(again.data.expense).toBe(res.data.expense.uuid);
		const preview = await call("POST", `${base()}/expenses/import/preview`, { token: ownerToken, body: upload(xml) });
		expect(preview.data.duplicate).toBe(res.data.expense.uuid);
	});

	test("records a reverse charge UBL invoice from an EU supplier as EU services", async () => {
		const res = await call("POST", `${base()}/expenses/import/preview`, { token: ownerToken, body: upload(ubl()) });

		expect(res.data.expense).toMatchObject({
			supplier: "Cloud & Co GmbH",
			supplier_country: "AT",
			vat_treatment: "eu_services",
			total_amount: 50000,
			tax_amount: 0,
			description: "Cloud consulting",
		});
		expect(res.data.warnings.map((warning: { code: string }) => warning.code)).toEqual(["reverse_charge"]);
	});

	test("warns when the invoice is addressed to another company", async () => {
		const source = eslogSource({ reference: "2026-0078", buyer: { ...eslogSource().buyer!, vat_number: "SI99999999", name: "Drugo d.o.o." } });
		const res = await call("POST", `${base()}/expenses/import/preview`, { token: ownerToken, body: upload(eslogXml(source)) });

		expect(res.data.warnings.map((warning: { code: string }) => warning.code)).toEqual(["buyer_mismatch"]);
		expect(res.data.warnings[0].message).toContain("Drugo d.o.o.");
	});

	test("refuses credit notes and files that are not e-invoices", async () => {
		const note = eslogXml(eslogSource({ kind: "credit_note", corrects: { reference: "2026-0001", issued: Date.UTC(2026, 8, 1) } }));
		const credit = await call("POST", `${base()}/expenses/import/preview`, { token: ownerToken, body: upload(note) });
		const garbage = await call("POST", `${base()}/expenses/import/preview`, { token: ownerToken, body: upload("<html></html>") });
		const empty = await call("POST", `${base()}/expenses/import/preview`, { token: ownerToken, body: { data: "" } });

		expect(credit.error).toBe(ErrorCode.INVALID_EINVOICE);
		expect(credit.info).toContain("credit notes");
		expect(garbage.error).toBe(ErrorCode.INVALID_EINVOICE);
		expect(empty.error).toBe(ErrorCode.INVALID_EINVOICE);
	});

	test("returns the suggestion instead of saving when it needs an exchange rate", async () => {
		const usd = ubl({ number: "US-7", category: "S", percent: "22", tax: "110.00" })
			.replaceAll('currencyID="EUR"', 'currencyID="USD"')
			.replace("<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>", "<cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode>")
			.replace("<cbc:IdentificationCode>AT</cbc:IdentificationCode>", "<cbc:IdentificationCode>SI</cbc:IdentificationCode>")
			.replace("ATU12345678", "SI44444444");
		const res = await call("POST", `${base()}/expenses/import`, { token: ownerToken, body: upload(usd) });

		expect(res.error).toBe(ErrorCode.INVALID_EXPENSE);
		expect(res.data.expense).toMatchObject({ currency: "USD", vat_treatment: "domestic", total_amount: 61000, tax_exchange_rate: null });
		expect(res.data.warnings.map((warning: { code: string }) => warning.code)).toEqual(["exchange_rate"]);
		const [count] = (await Database`SELECT COUNT(*) AS count FROM expenses WHERE invoice_number = 'US-7'`) as { count: number }[];
		expect(Number(count.count)).toBe(0);
	});

	test("keeps VAT out of the report for a project that is not VAT registered", async () => {
		await call("PATCH", base(), { token: ownerToken, body: { vat_status: "small_business" } });
		const res = await call("POST", `${base()}/expenses/import/preview`, {
			token: ownerToken,
			body: upload(eslogXml(eslogSource({ reference: "2026-0079" }))),
		});
		await call("PATCH", base(), { token: ownerToken, body: { vat_status: "registered" } });

		expect(res.data.expense).toMatchObject({ vat_treatment: "not_reported", tax_amount: 2390, deductible_tax_amount: 0, vat_lines: [] });
		expect(res.data.warnings.map((warning: { code: string }) => warning.code)).toEqual(["not_registered"]);
	});
});
