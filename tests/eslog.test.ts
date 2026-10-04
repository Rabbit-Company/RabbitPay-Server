import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCode } from "../server/errors";
import type { EslogSource } from "../server/eslog";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.eslog.sqlite`);

const { EslogDataIncomplete, eslogXml, vatCategory } = await import("../server/eslog");
const { credentialsFromPkcs12 } = await import("../server/furs/credentials");
const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { documentStorage } = await import("../server/document-storage");
const { storageFor } = await import("../server/licensing");

await Server.configure();

const SCHEMA = join(import.meta.dir, "fixtures", "eslog", "eSLOG20_INVOIC_v200.xsd");
const FURS_FIXTURES = join(import.meta.dir, "fixtures", "furs");
const EC_SIGNER = join(import.meta.dir, "fixtures", "eslog", "signer-ec.p12");
const EC_SIGNER_CERTIFICATE = join(import.meta.dir, "fixtures", "eslog", "signer-ec.pem");
const RSA_SIGNER = join(FURS_FIXTURES, "taxpayer.p12");
const xmllint = Bun.which("xmllint");
const xmlsec = Bun.which("xmlsec1");
const scratch = mkdtempSync(join(tmpdir(), "rabbitpay-eslog-"));

function scratchFile(xml: string): string {
	const file = join(scratch, `${crypto.randomUUID()}.xml`);
	writeFileSync(file, xml);
	return file;
}

function schemaErrors(xml: string): string {
	const result = Bun.spawnSync([xmllint!, "--nonet", "--noout", "--schema", SCHEMA, scratchFile(xml)]);
	return result.exitCode === 0 ? "" : result.stderr.toString();
}

function verifiesWith(trusted: string, xml: string): boolean {
	const result = Bun.spawnSync([
		xmlsec!,
		"--verify",
		"--id-attr:Id",
		"urn:eslog:2.00:M_INVOIC",
		"--id-attr:Id",
		"http://uri.etsi.org/01903/v1.3.2#:SignedProperties",
		"--trusted-pem",
		trusted,
		scratchFile(xml),
	]);
	return result.exitCode === 0;
}

async function signer(file: string, password: string) {
	return { credentials: credentialsFromPkcs12(new Uint8Array(await Bun.file(file).arrayBuffer()), password), signedAt: Date.UTC(2026, 8, 24, 12) };
}

function values(xml: string, element: string): string[] {
	return [...xml.matchAll(new RegExp(`<${element}>([^<]*)</${element}>`, "g"))].map((match) => match[1]);
}

function segment(xml: string, element: string, containing: string): string {
	const blocks = xml
		.split(`<${element}>`)
		.slice(1)
		.map((block) => block.split(`</${element}>`)[0]);
	return blocks.find((block) => block.includes(containing)) ?? "";
}

const seller = {
	name: "Studio",
	legal_name: "Studio d.o.o.",
	address_line1: "Dunajska cesta 1",
	address_line2: null,
	postal_code: "1000",
	city: "Ljubljana",
	state: null,
	country: "SI",
	vat_number: "SI12345678",
	tax_number: null,
	registration_number: "1234567000",
	email: "billing@studio.si",
	phone: null,
	website: null,
	footer_note: null,
};

const buyer = {
	name: "Kupec d.o.o.",
	email: "ap@kupec.si",
	phone: null,
	address_line1: "Stara cesta 1",
	address_line2: null,
	postal_code: "4000",
	city: "Kranj",
	state: null,
	country: "SI",
	vat_number: "SI87654321",
	tax_number: null,
	registration_number: null as string | null,
	iban: null as string | null,
	bic: null as string | null,
	customer_type: "business",
};

function source(overrides: Partial<EslogSource> = {}): EslogSource {
	return {
		kind: "invoice",
		reference: "2026-0001",
		issued: Date.UTC(2026, 8, 20, 10),
		supply_date: Date.UTC(2026, 8, 19, 10),
		due_date: Date.UTC(2026, 9, 20, 10),
		timezone: "Europe/Ljubljana",
		language: "sl",
		currency: "EUR",
		notes: [],
		seller,
		buyer,
		vat_status: "registered",
		exemption_note: null,
		reporting: null,
		lines: [
			{ description: "Svetovanje", quantity: 2, unit: null, price: 5000, amount: 10000, allowance: 0, tax_rate: 22, tax_amount: 2200, treatment: "domestic" },
			{ description: "Knjiga", quantity: 1, unit: null, price: 2000, amount: 2000, allowance: 0, tax_rate: 9.5, tax_amount: 190, treatment: "domestic" },
		],
		prepaid: 0,
		bank: null,
		card: false,
		fiscal: null,
		corrects: null,
		reference_document: null,
		...overrides,
	};
}

describe("VAT categories", () => {
	test("maps every tax treatment to its e-SLOG code", () => {
		expect(vatCategory("domestic", 22, "registered")).toBe("S");
		expect(vatCategory("oss", 19, "registered")).toBe("S");
		expect(vatCategory("reverse_charge", 0, "registered")).toBe("AE");
		expect(vatCategory("domestic_reverse_charge", 0, "registered")).toBe("AE");
		expect(vatCategory("intra_eu_goods", 0, "registered")).toBe("K");
		expect(vatCategory("export", 0, "registered")).toBe("G");
		expect(vatCategory("exempt", 0, "registered")).toBe("E");
		expect(vatCategory("outside_scope", 0, "registered")).toBe("O");
		expect(vatCategory("small_business", 0, "small_business")).toBe("O");
		expect(vatCategory(null, 0, "not_registered")).toBe("O");
		expect(vatCategory(null, 0, "registered")).toBe("Z");
	});
});

describe("building the XML", () => {
	test("writes a standard invoice with two VAT rates", () => {
		const xml = eslogXml(source());

		expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<Invoice xmlns="urn:eslog:2.00"')).toBe(true);
		expect(xml).toContain('<M_INVOIC Id="data">');
		expect(values(xml, "D_1001")).toEqual(["380"]);
		expect(values(xml, "D_1004")).toEqual(["2026-0001"]);
		expect(segment(xml, "S_DTM", "<D_2005>137</D_2005>")).toContain("<D_2380>2026-09-20</D_2380>");
		expect(segment(xml, "S_DTM", "<D_2005>35</D_2005>")).toContain("<D_2380>2026-09-19</D_2380>");
		expect(segment(xml, "G_SG8", "S_PAT")).toContain("<D_2380>2026-10-20</D_2380>");
		expect(segment(xml, "S_FTX", "<D_4451>DOC</D_4451>")).toContain("urn:cen.eu:en16931:2017");
		expect(segment(xml, "S_FTX", "<D_4451>PMD</D_4451>")).toContain("Račun 2026-0001");
		expect(xml).not.toContain("<D_4451>AGM</D_4451>");

		expect(values(segment(xml, "G_SG2", "<D_3035>SE</D_3035>"), "D_1153")).toEqual(["0199", "VA", "AHP"]);
		expect(values(segment(xml, "G_SG2", "<D_3035>SE</D_3035>"), "D_1154")).toEqual(["1234567000", "SI12345678", "SI12345678"]);
		expect(segment(xml, "G_SG2", "<D_3035>SE</D_3035>")).toContain("<D_3036>Studio d.o.o.</D_3036>");
		expect(segment(xml, "G_SG2", "<D_3035>SE</D_3035>")).toContain("<D_3036_2>Studio</D_3036_2>");
		expect(values(segment(xml, "G_SG2", "<D_3035>BY</D_3035>"), "D_1154")).toEqual(["SI87654321", "SI87654321"]);

		const totals = Object.fromEntries(
			xml
				.split("<G_SG50>")
				.slice(1)
				.map((block) => [values(block, "D_5025")[0], values(block, "D_5004")[0]])
		);
		expect(totals).toEqual({ "79": "120.00", "389": "120.00", "176": "23.90", "388": "143.90", "9": "143.90" });

		const breakdowns = xml
			.split("<G_SG52>")
			.slice(1)
			.map((block) => [values(block, "D_5305")[0], values(block, "D_5278")[0], ...values(block, "D_5004")]);
		expect(breakdowns).toEqual([
			["S", "22", "100.00", "22.00"],
			["S", "9.5", "20.00", "1.90"],
		]);
	});

	test("records an allocated invoice discount as a line allowance", () => {
		const xml = eslogXml(
			source({
				lines: [
					{
						description: "Svetovanje",
						quantity: 3,
						unit: null,
						price: 3333,
						amount: 10000,
						allowance: 1000,
						tax_rate: 22,
						tax_amount: 1980,
						treatment: "domestic",
					},
				],
			})
		);
		const line = segment(xml, "G_SG26", "Svetovanje");

		expect(segment(line, "G_SG27", "<D_5025>203</D_5025>")).toContain("<D_5004>90.00</D_5004>");
		expect(segment(line, "G_SG27", "<D_5025>38</D_5025>")).toContain("<D_5004>109.80</D_5004>");
		expect(segment(line, "G_SG29", "AAA")).toContain("<D_5118>33.3300</D_5118>");
		expect(segment(line, "G_SG39", "S_ALC")).toContain("<D_5189>95</D_5189>");
		expect(segment(line, "G_SG42", "<D_5025>204</D_5025>")).toContain("<D_5004>10.00</D_5004>");
		expect(segment(line, "G_SG42", "<D_5025>25</D_5025>")).toContain("<D_5004>100.00</D_5004>");
	});

	test("uses code O for a small business and keeps VAT IDs out", () => {
		const xml = eslogXml(
			source({
				vat_status: "small_business",
				seller: { ...seller, vat_number: null, tax_number: "12345678" },
				exemption_note: "DDV ni obračunan na podlagi 1. odstavka 94. člena ZDDV-1.",
				lines: [
					{
						description: "Storitev",
						quantity: 1,
						unit: null,
						price: 5000,
						amount: 5000,
						allowance: 0,
						tax_rate: 0,
						tax_amount: 0,
						treatment: "small_business",
					},
				],
			})
		);

		expect(values(segment(xml, "G_SG2", "<D_3035>SE</D_3035>"), "D_1153")).toEqual(["0199", "AHP"]);
		expect(values(segment(xml, "G_SG2", "<D_3035>SE</D_3035>"), "D_1154")).toEqual(["1234567000", "12345678"]);
		expect(values(segment(xml, "G_SG2", "<D_3035>BY</D_3035>"), "D_1153")).toEqual(["AHP"]);
		expect(segment(xml, "G_SG52", "S_TAX")).not.toContain("D_5278");
		expect(values(segment(xml, "G_SG52", "S_TAX"), "D_5305")).toEqual(["O"]);
		const agm = segment(xml, "S_FTX", "<D_4451>AGM</D_4451>");
		expect(agm).toContain("<D_4441>VATEX-EU-O</D_4441>");
		expect(agm).toContain("94. člena ZDDV-1");
	});

	test("states the reverse charge clause and code", () => {
		const xml = eslogXml(
			source({
				language: "en",
				buyer: { ...buyer, name: "Kunde GmbH", country: "DE", vat_number: "DE123456789" },
				lines: [
					{
						description: "Consulting",
						quantity: 1,
						unit: null,
						price: 10000,
						amount: 10000,
						allowance: 0,
						tax_rate: 0,
						tax_amount: 0,
						treatment: "reverse_charge",
					},
				],
			})
		);
		const agm = segment(xml, "S_FTX", "<D_4451>AGM</D_4451>");

		expect(agm).toContain("<D_4441>VATEX-EU-AE</D_4441>");
		expect(agm).toContain("Article 196 of Directive 2006/112/EC");
		expect(values(segment(xml, "G_SG52", "S_TAX"), "D_5305")).toEqual(["AE"]);
		expect(values(segment(xml, "G_SG2", "<D_3035>BY</D_3035>"), "D_1154")).toEqual(["DE123456789", "DE123456789"]);
	});

	test("marks a paid invoice as paid with nothing due", () => {
		const xml = eslogXml(source({ prepaid: 14390 }));

		expect(segment(xml, "S_FTX", "<D_4451>PAI</D_4451>")).toContain("<D_4440>2</D_4440>");
		expect(segment(xml, "G_SG50", "<D_5025>113</D_5025>")).toContain("<D_5004>143.90</D_5004>");
		expect(segment(xml, "G_SG50", "<D_5025>9</D_5025>")).toContain("<D_5004>0.00</D_5004>");
		expect(xml).not.toContain("<G_SG8>");
	});

	test("adds the bank account, payment reference and credit transfer means", () => {
		const xml = eslogXml(
			source({
				bank: {
					account: { iban: "SI56191000000123438", bic: "DBSISI2X", holder: "Studio d.o.o.", bank_name: null },
					reference: "SI00 2026-0001",
					amount: 14390,
					currency: "EUR",
					qr: null,
					qr_unavailable: null,
				},
			})
		);

		expect(segment(xml, "S_FII", "<D_3035>RB</D_3035>")).toContain("<D_3194>SI56191000000123438</D_3194>");
		expect(segment(xml, "S_FII", "<D_3035>RB</D_3035>")).toContain("<D_3433>DBSISI2X</D_3433>");
		expect(segment(xml, "G_SG1", "<D_1153>PQ</D_1153>")).toContain("<D_1154>SI00 2026-0001</D_1154>");
		expect(segment(xml, "S_PAI", "C_C534")).toContain("<D_4461>30</D_4461>");
	});

	test("carries the fiscal verification marks", () => {
		const xml = eslogXml(
			source({
				fiscal: {
					operator: "Ana Novak",
					zoi: "8402f0a963e37b2258e034fc8ae7ffc1",
					eor: "56dcaf93-933a-497d-b864-0ba1e8f4fa23",
					status: "verified",
					environment: "production",
					issued: "20.09.2026 12:00:00",
					issued_iso: "2026-09-20T12:00:00",
					code: "279042272585972554922067893753871413584876543211601021503002",
				},
			})
		);
		const txd = segment(xml, "S_FTX", "<D_4451>TXD</D_4451>");

		expect(values(txd, "D_4440")).toEqual(["2026-09-20T12:00:00"]);
		expect(values(txd, "D_4440_2")).toEqual(["Ana Novak"]);
		expect(values(txd, "D_4440_3")).toEqual(["56dcaf93-933a-497d-b864-0ba1e8f4fa23"]);
		expect(values(txd, "D_4440_4")).toEqual(["8402f0a963e37b2258e034fc8ae7ffc1"]);
		expect(values(txd, "D_4440_5")).toEqual(["279042272585972554922067893753871413584876543211601021503002"]);
	});

	test("writes a credit note with a reference to the corrected invoice", () => {
		const xml = eslogXml(
			source({
				kind: "credit_note",
				reference: "CN-2026-0001",
				supply_date: null,
				due_date: null,
				notes: ["Vračilo"],
				corrects: { reference: "2026-0001", issued: Date.UTC(2026, 8, 20, 10) },
				lines: [
					{
						description: "Svetovanje",
						quantity: 1,
						unit: null,
						price: 5000,
						amount: 5000,
						allowance: 0,
						tax_rate: 22,
						tax_amount: 1100,
						treatment: "domestic",
					},
				],
			})
		);

		expect(values(xml, "D_1001")).toEqual(["381"]);
		const corrected = segment(xml, "G_SG1", "<D_1153>OI</D_1153>");
		expect(corrected).toContain("<D_1154>2026-0001</D_1154>");
		expect(corrected).toContain("<D_2005>384</D_2005>");
		expect(segment(xml, "S_FTX", "<D_4451>GEN</D_4451>")).toContain("Vračilo");
		expect(xml).not.toContain("<D_4451>PAI</D_4451>");
		expect(segment(xml, "G_SG50", "<D_5025>9</D_5025>")).toContain("<D_5004>61.00</D_5004>");
	});

	test("escapes markup and fits long addresses into the 35 character lines", () => {
		const xml = eslogXml(
			source({
				buyer: { ...buyer, name: "Kupec & <Partner>", address_line1: "Zelo dolga ulica s posebej dolgim imenom 123", address_line2: "Poslovna stavba B" },
			})
		);
		const party = segment(xml, "G_SG2", "<D_3035>BY</D_3035>");

		expect(party).toContain("<D_3036>Kupec &amp; &lt;Partner&gt;</D_3036>");
		expect(values(party, "D_3042")).toEqual(["Zelo dolga ulica s posebej dolgim"]);
		expect(values(party, "D_3042_2")).toEqual(["imenom 123"]);
		expect(values(party, "D_3042_3")).toEqual(["Poslovna stavba B"]);
	});

	test("lists what is missing instead of writing an invalid document", () => {
		let error: unknown = null;
		try {
			eslogXml(source({ seller: { ...seller, vat_number: null, country: null }, buyer: { ...buyer, vat_number: null, country: null } }));
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(EslogDataIncomplete);
		expect((error as InstanceType<typeof EslogDataIncomplete>).issues.map((issue) => issue.code)).toEqual([
			"seller_country",
			"seller_tax_number",
			"buyer_country",
			"buyer_tax_number",
		]);
		expect(() => eslogXml(source({ buyer: null }))).toThrow(EslogDataIncomplete);
	});

	test("adds the reference document and buyer routing details that UJP requires", () => {
		const xml = eslogXml(
			source({
				buyer: { ...buyer, registration_number: "1234567000", iban: "SI56011006370171132", bic: "UJPLSI2DICL" },
				reference_document: { type: "order", number: "N-2026-10", date: Date.UTC(2026, 8, 1, 10) },
			})
		);
		const party = segment(xml, "G_SG2", "<D_3035>BY</D_3035>");
		const order = segment(xml, "G_SG1", "<D_1153>ON</D_1153>");

		expect(order).toContain("<D_1154>N-2026-10</D_1154>");
		expect(order).toContain("<D_2005>171</D_2005>");
		expect(order).toContain("<D_2380>2026-09-01</D_2380>");
		expect(values(party, "D_1153")).toEqual(["0199", "VA", "AHP"]);
		expect(values(party, "D_1154")[0]).toBe("1234567000");
		const account = segment(party, "S_FII", "<D_3035>BB</D_3035>");
		expect(account).toContain("<D_3194>SI56011006370171132</D_3194>");
		expect(account).toContain("<D_3192>Kupec d.o.o.</D_3192>");
		expect(account).toContain("<D_3433>UJPLSI2DICL</D_3433>");
	});

	test("writes a contract reference without a date", () => {
		const xml = eslogXml(source({ reference_document: { type: "contract", number: "POG-7/2026", date: null } }));
		const contract = segment(xml, "G_SG1", "<D_1153>CT</D_1153>");

		expect(contract).toContain("<D_1154>POG-7/2026</D_1154>");
		expect(contract).not.toContain("S_DTM");
	});

	test.skipIf(!xmllint)("passes the official e-SLOG 2.0 schema in every variant", () => {
		const variants = [
			source(),
			source({ prepaid: 14390, notes: ["Hvala za zaupanje.\nDruga vrstica."] }),
			source({
				vat_status: "small_business",
				seller: { ...seller, vat_number: null, tax_number: "12345678" },
				exemption_note: "DDV ni obračunan na podlagi 1. odstavka 94. člena ZDDV-1.",
				lines: [
					{
						description: "Storitev",
						quantity: 1.5,
						unit: null,
						price: 3333.3333,
						amount: 5000,
						allowance: 500,
						tax_rate: 0,
						tax_amount: 0,
						treatment: "small_business",
					},
				],
			}),
			source({
				reporting: { currency: "EUR", tax_amount: 2390 },
				currency: "USD",
				fiscal: {
					operator: null,
					zoi: "8402f0a963e37b2258e034fc8ae7ffc1",
					eor: null,
					status: "pending",
					environment: "test",
					issued: "20.09.2026 12:00:00",
					issued_iso: "2026-09-20T12:00:00",
					code: "279042272585972554922067893753871413584876543211601021503002",
				},
			}),
			source({ kind: "credit_note", due_date: null, supply_date: null, corrects: { reference: "2026-0001", issued: Date.UTC(2026, 8, 20) } }),
			source({
				vat_status: "small_business",
				seller: { ...seller, vat_number: null, tax_number: "85465313" },
				exemption_note: "DDV ni obračunan na podlagi 1. odstavka 94. člena ZDDV-1.",
				buyer: { ...buyer, registration_number: "1234567000", iban: "SI56011006370171132", bic: "UJPLSI2DICL" },
				reference_document: { type: "order", number: "N-2026-10", date: Date.UTC(2026, 8, 1) },
				lines: [
					{
						description: "Letno poročilo",
						quantity: 1,
						unit: null,
						price: 10000,
						amount: 10000,
						allowance: 0,
						tax_rate: 0,
						tax_amount: 0,
						treatment: "small_business",
					},
				],
			}),
		];

		for (const variant of variants) expect(schemaErrors(eslogXml(variant))).toBe("");
	});
});

describe("XAdES signature", () => {
	const tricky = () =>
		source({
			notes: ['Vrstica 1\r\nVrstica 2 & "več" > manj'],
			buyer: { ...buyer, name: "Kupec & <Partner>", registration_number: "1234567000", iban: "SI56011006370171132", bic: "UJPLSI2DICL" },
			reference_document: { type: "order", number: "N-2026-10", date: Date.UTC(2026, 8, 1) },
		});

	test("places an enveloped XAdES signature next to the message", async () => {
		const xml = eslogXml(source(), await signer(RSA_SIGNER, "futest"));

		expect(xml).toContain('<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="Signature-');
		expect(xml).toContain('<ds:Reference URI="#data">');
		expect(xml).toContain('Type="http://uri.etsi.org/01903#SignedProperties"');
		expect(xml).toContain("<xds:SigningTime>2026-09-24T12:00:00Z</xds:SigningTime>");
		expect(xml).toContain("<ds:X509IssuerName>CN=Tax CA Test,O=state-institutions,C=SI</ds:X509IssuerName>");
		expect(xml.indexOf("</M_INVOIC>")).toBeLessThan(xml.indexOf("<ds:Signature"));
		expect(eslogXml(source())).not.toContain("ds:Signature");
	});

	test.skipIf(!xmlsec)("verifies with xmlsec for an RSA certificate", async () => {
		expect(verifiesWith(join(FURS_FIXTURES, "ca.pem"), eslogXml(tricky(), await signer(RSA_SIGNER, "futest")))).toBe(true);
	});

	test.skipIf(!xmlsec)("verifies with xmlsec for an EC certificate", async () => {
		expect(verifiesWith(EC_SIGNER_CERTIFICATE, eslogXml(tricky(), await signer(EC_SIGNER, "ectest")))).toBe(true);
	});

	test.skipIf(!xmlsec)("fails verification once the signed invoice is changed", async () => {
		const xml = eslogXml(tricky(), await signer(RSA_SIGNER, "futest"));
		expect(verifiesWith(join(FURS_FIXTURES, "ca.pem"), xml.replace("<D_1154>N-2026-10</D_1154>", "<D_1154>N-2026-11</D_1154>"))).toBe(false);
	});

	test.skipIf(!xmllint)("still passes the official e-SLOG 2.0 schema when signed", async () => {
		expect(schemaErrors(eslogXml(tricky(), await signer(RSA_SIGNER, "futest")))).toBe("");
		expect(schemaErrors(eslogXml(tricky(), await signer(EC_SIGNER, "ectest")))).toBe("");
	});
});

interface ApiResponse {
	status: number;
	error: number;
	info: string;
	data?: any;
}

const password = (seed: string) => new Bun.CryptoHasher("blake2b512").update(seed).digest("hex");

async function raw(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<Response> {
	const headers: Record<string, string> = {};
	if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
	if (options.body !== undefined) headers["Content-Type"] = "application/json";
	return await Server.app.handle(
		new Request(`http://127.0.0.1${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
	);
}

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<ApiResponse> {
	const res = await raw(method, path, options);
	return { status: res.status, ...((await res.json()) as { error: number; info: string; data?: unknown }) };
}

let ownerToken = "";
let projectUuid = "";
let customerUuid = "";
const base = () => `/api/v1/projects/${projectUuid}`;

async function issued(items: unknown[], extra: Record<string, unknown> = {}) {
	const created = await call("POST", `${base()}/invoices`, {
		token: ownerToken,
		body: { due_date: Date.now() + 86400000, supply_date: Date.now(), items, ...extra },
	});
	if (created.error !== 0) throw new Error(created.info);
	const opened = await call("POST", `${base()}/invoices/${created.data.uuid}/open`, { token: ownerToken });
	if (opened.error !== 0) throw new Error(opened.info);
	return opened.data;
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	await call("POST", "/api/v1/auth/register", { body: { email: "eslog-owner@example.com", password: password("eslog-owner") } });
	ownerToken = (await call("POST", "/api/v1/auth/login", { body: { email: "eslog-owner@example.com", password: password("eslog-owner") } })).data.token;

	projectUuid = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "eslog-shop", currency: "EUR" } })).data.uuid;
	await call("PATCH", base(), { token: ownerToken, body: { tax_country: "SI", vat_status: "registered", tax_currency: "EUR", language: "sl" } });
	await call("PUT", `${base()}/company`, {
		token: ownerToken,
		body: {
			legal_name: "e-SLOG d.o.o.",
			address_line1: "Dunajska cesta 1",
			postal_code: "1000",
			city: "Ljubljana",
			country: "SI",
			vat_number: "SI12345678",
			registration_number: "1234567000",
			email: "racuni@eslog.si",
		},
	});
	await call("PUT", `${base()}/processors/bank_transfer`, {
		token: ownerToken,
		body: { enabled: true, config: { iban: "SI56 1910 0000 0123 438", account_holder: "e-SLOG d.o.o." } },
	});
	customerUuid = (
		await call("POST", `${base()}/customers`, {
			token: ownerToken,
			body: {
				email: "ap@obcina.si",
				name: "Občina Primer",
				address_line1: "Trg 1",
				postal_code: "4000",
				city: "Kranj",
				country: "SI",
				vat_number: "SI87654321",
				customer_type: "business",
			},
		})
	).data.uuid;
});

afterAll(async () => {
	await Database.close();
	rmSync(scratch, { recursive: true, force: true });
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.eslog.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("e-SLOG downloads", () => {
	test("downloads an issued invoice as e-SLOG XML", async () => {
		const invoice = await issued(
			[
				{ description: "Svetovanje", quantity: 2, unit_price: 5000, tax_rate: 22 },
				{ description: "Knjiga", quantity: 1, unit_price: 2000, tax_rate: 9.5 },
			],
			{ customer: customerUuid, discount_amount: 1200 }
		);
		const res = await raw("GET", `${base()}/invoices/${invoice.uuid}/eslog`, { token: ownerToken });
		const xml = await res.text();

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/xml");
		expect(res.headers.get("Content-Disposition")).toContain(".xml");
		expect(values(xml, "D_1004")).toEqual([invoice.reference]);
		expect(segment(xml, "G_SG2", "<D_3035>BY</D_3035>")).toContain("<D_3036>Občina Primer</D_3036>");
		expect(segment(xml, "S_FII", "<D_3035>RB</D_3035>")).toContain("<D_3194>SI56191000000123438</D_3194>");
		expect(segment(xml, "G_SG50", "<D_5025>388</D_5025>")).toContain(`<D_5004>${(invoice.total_amount / 100).toFixed(2)}</D_5004>`);
		expect(segment(xml, "G_SG50", "<D_5025>79</D_5025>")).toContain("<D_5004>108.00</D_5004>");
		if (xmllint) expect(schemaErrors(xml)).toBe("");
	});

	test("downloads a credit note as e-SLOG XML", async () => {
		const invoice = await issued([{ description: "Svetovanje", quantity: 1, unit_price: 10000, tax_rate: 22 }], { customer: customerUuid });
		const note = await call("POST", `${base()}/invoices/${invoice.uuid}/credit-notes`, { token: ownerToken, body: { reason: "Popust" } });
		const res = await raw("GET", `${base()}/credit-notes/${note.data.uuid}/eslog`, { token: ownerToken });
		const xml = await res.text();

		expect(res.status).toBe(200);
		expect(values(xml, "D_1001")).toEqual(["381"]);
		expect(segment(xml, "G_SG1", "<D_1153>OI</D_1153>")).toContain(`<D_1154>${invoice.reference}</D_1154>`);
		if (xmllint) expect(schemaErrors(xml)).toBe("");
	});

	test("explains what is missing when the invoice has no customer", async () => {
		const invoice = await issued([{ description: "Prodaja", quantity: 1, unit_price: 1000, tax_rate: 22 }]);
		const res = await call("GET", `${base()}/invoices/${invoice.uuid}/eslog`, { token: ownerToken });

		expect(res.status).toBe(409);
		expect(res.error).toBe(ErrorCode.ESLOG_DATA_INCOMPLETE);
		expect(res.data.issues.map((issue: { code: string }) => issue.code)).toEqual(["buyer"]);
	});

	test("refuses drafts because they have no final number", async () => {
		const created = await call("POST", `${base()}/invoices`, {
			token: ownerToken,
			body: {
				due_date: Date.now() + 86400000,
				supply_date: Date.now(),
				customer: customerUuid,
				items: [{ description: "Osnutek", quantity: 1, unit_price: 1000, tax_rate: 22 }],
			},
		});
		const res = await call("GET", `${base()}/invoices/${created.data.uuid}/eslog`, { token: ownerToken });

		expect(res.error).toBe(ErrorCode.INVALID_INVOICE_STATUS);
	});

	test("requires a signed in member", async () => {
		const res = await call("GET", `${base()}/invoices/${crypto.randomUUID()}/eslog`);
		expect(res.status).toBe(401);
	});
});

describe("public sector routing", () => {
	let publicBuyer = "";

	beforeAll(async () => {
		const created = await call("POST", `${base()}/customers`, {
			token: ownerToken,
			body: {
				email: "racuni@ministrstvo.si",
				name: "Ministrstvo za primere",
				address_line1: "Gregorčičeva 20",
				postal_code: "1000",
				city: "Ljubljana",
				country: "SI",
				vat_number: "SI47429518",
				customer_type: "business",
				registration_number: " 1234567000 ",
				iban: "si56 0110 0637 0171 132",
				bic: "ujplsi2dicl",
			},
		});
		publicBuyer = created.data.uuid;
	});

	test("stores the customer's registration number and normalized bank account", async () => {
		const customer = (await call("GET", `${base()}/customers/${publicBuyer}`, { token: ownerToken })).data;

		expect(customer.registration_number).toBe("1234567000");
		expect(customer.iban).toBe("SI56011006370171132");
		expect(customer.bic).toBe("UJPLSI2DICL");
	});

	test("rejects an IBAN that fails the checksum and a malformed BIC", async () => {
		const badIban = await call("PATCH", `${base()}/customers/${publicBuyer}`, { token: ownerToken, body: { iban: "SI56011006370171133" } });
		const badBic = await call("PATCH", `${base()}/customers/${publicBuyer}`, { token: ownerToken, body: { bic: "UJP" } });

		expect(badIban.error).toBe(ErrorCode.INVALID_CUSTOMER_BANK_ACCOUNT);
		expect(badBic.error).toBe(ErrorCode.INVALID_CUSTOMER_BANK_ACCOUNT);
	});

	test("carries the reference document from the new invoice into e-SLOG", async () => {
		const invoice = await issued([{ description: "Letno poročilo", quantity: 1, unit_price: 10000, tax_rate: 22 }], {
			customer: publicBuyer,
			reference_document_type: "order",
			reference_document_number: "N-2026-10",
			reference_document_date: Date.UTC(2026, 8, 1, 10),
		});
		const xml = await (await raw("GET", `${base()}/invoices/${invoice.uuid}/eslog`, { token: ownerToken })).text();

		expect(invoice.reference_document_number).toBe("N-2026-10");
		expect(segment(xml, "G_SG1", "<D_1153>ON</D_1153>")).toContain("<D_1154>N-2026-10</D_1154>");
		expect(segment(xml, "G_SG2", "<D_3035>BY</D_3035>")).toContain("<D_1154>1234567000</D_1154>");
		expect(segment(xml, "S_FII", "<D_3035>BB</D_3035>")).toContain("<D_3194>SI56011006370171132</D_3194>");
		if (xmllint) expect(schemaErrors(xml)).toBe("");
	});

	test("rejects a reference document without a known type", async () => {
		const res = await call("POST", `${base()}/invoices`, {
			token: ownerToken,
			body: {
				due_date: Date.now() + 86400000,
				items: [{ description: "Storitev", quantity: 1, unit_price: 1000, tax_rate: 22 }],
				reference_document_number: "N-1",
				reference_document_type: "receipt",
			},
		});

		expect(res.error).toBe(ErrorCode.INVALID_REFERENCE_DOCUMENT);
	});

	test("sets, corrects and clears the reference document on an issued invoice", async () => {
		const invoice = await issued([{ description: "Storitev", quantity: 1, unit_price: 5000, tax_rate: 22 }], { customer: publicBuyer });
		const path = `${base()}/invoices/${invoice.uuid}/reference-document`;

		const set = await call("PUT", path, { token: ownerToken, body: { reference_document_type: "contract", reference_document_number: "POG-7/2026" } });
		expect(set.data.reference_document_type).toBe("contract");
		expect(set.data.reference_document_number).toBe("POG-7/2026");
		expect(set.data.total_amount).toBe(invoice.total_amount);
		const xml = await (await raw("GET", `${base()}/invoices/${invoice.uuid}/eslog`, { token: ownerToken })).text();
		expect(segment(xml, "G_SG1", "<D_1153>CT</D_1153>")).toContain("<D_1154>POG-7/2026</D_1154>");

		const invalid = await call("PUT", path, { token: ownerToken, body: { reference_document_number: "POG-8" } });
		expect(invalid.error).toBe(ErrorCode.INVALID_REFERENCE_DOCUMENT);

		const cleared = await call("PUT", path, { token: ownerToken, body: { reference_document_number: null } });
		expect(cleared.data.reference_document_type).toBeNull();
		expect(cleared.data.reference_document_number).toBeNull();
	});

	test("uses the customer's current routing details for invoices issued before they were recorded", async () => {
		const invoice = await issued([{ description: "Storitev", quantity: 1, unit_price: 5000, tax_rate: 22 }], { customer: publicBuyer });
		const [row] = (await Database`SELECT buyer_details FROM invoices WHERE uuid = ${invoice.uuid}`) as { buyer_details: string }[];
		const { registration_number, iban, bic, ...older } = JSON.parse(row.buyer_details);
		expect([registration_number, iban, bic]).toEqual(["1234567000", "SI56011006370171132", "UJPLSI2DICL"]);
		await Database`UPDATE invoices SET buyer_details = ${JSON.stringify(older)} WHERE uuid = ${invoice.uuid}`;

		const xml = await (await raw("GET", `${base()}/invoices/${invoice.uuid}/eslog`, { token: ownerToken })).text();
		expect(segment(xml, "G_SG2", "<D_3035>BY</D_3035>")).toContain("<D_1154>1234567000</D_1154>");
		expect(segment(xml, "S_FII", "<D_3035>BB</D_3035>")).toContain("<D_3433>UJPLSI2DICL</D_3433>");
	});
});

describe("signing certificate", () => {
	const path = () => `${base()}/einvoice/signing-certificate`;
	const upload = async (file: string, password: string) =>
		call("PUT", path(), { token: ownerToken, body: { file: Buffer.from(await Bun.file(file).arrayBuffer()).toString("base64"), password } });

	test("refuses a wrong password", async () => {
		const res = await upload(EC_SIGNER, "wrong");
		expect(res.error).toBe(ErrorCode.SIGNING_CERTIFICATE_INVALID);
		expect((await call("GET", path(), { token: ownerToken })).data.certificate).toBeNull();
	});

	test("signs every e-SLOG download once a certificate is uploaded, and stops after it is removed", async () => {
		const uploaded = await upload(EC_SIGNER, "ectest");
		expect(uploaded.error).toBe(0);
		expect(uploaded.data.certificate.holder).toBe("Test Signer EC");
		expect((await call("GET", path(), { token: ownerToken })).data.certificate.holder).toBe("Test Signer EC");

		const invoice = await issued([{ description: "Storitev", quantity: 1, unit_price: 5000, tax_rate: 22 }], { customer: customerUuid });
		const note = await call("POST", `${base()}/invoices/${invoice.uuid}/credit-notes`, { token: ownerToken, body: {} });
		const signedInvoice = await (await raw("GET", `${base()}/invoices/${invoice.uuid}/eslog`, { token: ownerToken })).text();
		const signedNote = await (await raw("GET", `${base()}/credit-notes/${note.data.uuid}/eslog`, { token: ownerToken })).text();

		expect(signedInvoice).toContain("<ds:Signature");
		expect(signedNote).toContain("<ds:Signature");
		if (xmlsec) {
			expect(verifiesWith(EC_SIGNER_CERTIFICATE, signedInvoice)).toBe(true);
			expect(verifiesWith(EC_SIGNER_CERTIFICATE, signedNote)).toBe(true);
		}
		if (xmllint) expect(schemaErrors(signedInvoice)).toBe("");

		await call("DELETE", path(), { token: ownerToken });
		const archived = await (await raw("GET", `${base()}/invoices/${invoice.uuid}/eslog`, { token: ownerToken })).text();
		expect(archived).toBe(signedInvoice);

		const fresh = await issued([{ description: "Storitev", quantity: 1, unit_price: 5000, tax_rate: 22 }], { customer: customerUuid });
		const unsigned = await (await raw("GET", `${base()}/invoices/${fresh.uuid}/eslog`, { token: ownerToken })).text();
		expect(unsigned).not.toContain("ds:Signature");
	});

	test("explains an expired certificate instead of signing with it", async () => {
		await upload(EC_SIGNER, "ectest");
		await Database`UPDATE einvoice_signing SET certificate_valid_to = ${Date.now() - 1000} WHERE project = ${projectUuid}`;
		const invoice = await issued([{ description: "Storitev", quantity: 1, unit_price: 5000, tax_rate: 22 }], { customer: customerUuid });

		const res = await call("GET", `${base()}/invoices/${invoice.uuid}/eslog`, { token: ownerToken });
		expect(res.error).toBe(ErrorCode.SIGNING_CERTIFICATE_REJECTED);
		expect(res.info).toContain("expired");
		await call("DELETE", path(), { token: ownerToken });
	});
});

describe("archived e-invoices", () => {
	const signingPath = () => `${base()}/einvoice/signing-certificate`;
	const uploadSigner = async () =>
		call("PUT", signingPath(), {
			token: ownerToken,
			body: { file: Buffer.from(await Bun.file(EC_SIGNER).arrayBuffer()).toString("base64"), password: "ectest" },
		});
	const download = async (path: string) => {
		const res = await raw("GET", path, { token: ownerToken });
		return { status: res.status, version: res.headers.get("X-Document-Version"), xml: await res.text() };
	};
	const fresh = () => issued([{ description: "Storitev", quantity: 1, unit_price: 5000, tax_rate: 22 }], { customer: customerUuid });

	test("returns the same stored file on every download", async () => {
		await uploadSigner();
		const invoice = await fresh();
		const path = `${base()}/invoices/${invoice.uuid}/eslog`;

		const first = await download(path);
		await Bun.sleep(1100);
		const second = await download(path);

		expect(first.version).toBe("1");
		expect(second.version).toBe("1");
		expect(second.xml).toBe(first.xml);
		expect(first.xml).toContain("<ds:Signature");
		await call("DELETE", signingPath(), { token: ownerToken });
	});

	test("keeps the original and stores a new version when the reference document changes", async () => {
		const invoice = await fresh();
		const path = `${base()}/invoices/${invoice.uuid}/eslog`;
		const original = await download(path);

		await call("PUT", `${base()}/invoices/${invoice.uuid}/reference-document`, {
			token: ownerToken,
			body: { reference_document_type: "order", reference_document_number: "N-2026-44" },
		});
		const changed = await download(path);
		const again = await download(path);
		const first = await download(`${path}?version=1`);
		const versions = (await call("GET", `${path}/versions`, { token: ownerToken })).data.versions;

		expect(changed.version).toBe("2");
		expect(changed.xml).toContain("<D_1154>N-2026-44</D_1154>");
		expect(again.xml).toBe(changed.xml);
		expect(first.xml).toBe(original.xml);
		expect(first.xml).not.toContain("N-2026-44");
		expect(versions.map((entry: { version: number }) => entry.version)).toEqual([1, 2]);
		expect(versions[1].reference_document_number).toBe("N-2026-44");
		expect(versions[0].sha256).toBe(new Bun.CryptoHasher("sha256").update(original.xml).digest("hex"));
	});

	test("signs a new version once a certificate is added to an unsigned original", async () => {
		const invoice = await fresh();
		const path = `${base()}/invoices/${invoice.uuid}/eslog`;
		const unsigned = await download(path);

		await uploadSigner();
		const signed = await download(path);
		await call("DELETE", signingPath(), { token: ownerToken });
		const afterRemoval = await download(path);

		expect(unsigned.xml).not.toContain("ds:Signature");
		expect(signed.version).toBe("2");
		expect(signed.xml).toContain("<ds:Signature");
		expect(afterRemoval.xml).toBe(signed.xml);
	});

	test("keeps credit notes as issued too", async () => {
		const invoice = await fresh();
		const note = await call("POST", `${base()}/invoices/${invoice.uuid}/credit-notes`, { token: ownerToken, body: { reason: "Popust" } });
		const path = `${base()}/credit-notes/${note.data.uuid}/eslog`;

		const first = await download(path);
		const second = await download(path);
		const versions = (await call("GET", `${path}/versions`, { token: ownerToken })).data.versions;

		expect(second.xml).toBe(first.xml);
		expect(versions).toHaveLength(1);
	});

	test("refuses to serve a stored file that no longer matches its checksum", async () => {
		const invoice = await fresh();
		const path = `${base()}/invoices/${invoice.uuid}/eslog`;
		await download(path);
		const [row] = (await Database`SELECT storage_key FROM eslog_documents WHERE invoice = ${invoice.uuid}`) as { storage_key: string }[];
		await documentStorage().put(row.storage_key, new TextEncoder().encode("<Invoice/>"), "application/xml");

		const res = await call("GET", path, { token: ownerToken });
		expect(res.error).toBe(ErrorCode.ESLOG_ARCHIVE_DAMAGED);
		const [count] = (await Database`SELECT COUNT(*) AS count FROM eslog_documents WHERE invoice = ${invoice.uuid}`) as { count: number }[];
		expect(Number(count.count)).toBe(1);
	});

	test("rejects unknown versions and counts stored files toward document storage", async () => {
		const invoice = await fresh();
		const path = `${base()}/invoices/${invoice.uuid}/eslog`;
		const before = (await storageFor(projectUuid)).storage_used;
		const stored = await download(path);

		expect((await storageFor(projectUuid)).storage_used - before).toBe(new TextEncoder().encode(stored.xml).byteLength);
		expect((await call("GET", `${path}?version=9`, { token: ownerToken })).error).toBe(ErrorCode.ESLOG_VERSION_NOT_FOUND);
		expect((await call("GET", `${path}?version=abc`, { token: ownerToken })).error).toBe(ErrorCode.ESLOG_VERSION_NOT_FOUND);
	});
});

describe("units of measure", () => {
	test("knows the UN/ECE codes and prints short symbols in both languages", async () => {
		const { isUnitCode, quantityWithUnit, unitName } = await import("../server/measure-units");

		expect(isUnitCode("HUR")).toBe(true);
		expect(isUnitCode("hour")).toBe(false);
		expect(quantityWithUnit("3", "HUR", "sl")).toBe("3 h");
		expect(quantityWithUnit("12", "MON", "sl")).toBe("12 mes");
		expect(quantityWithUnit("12", "MON", "en")).toBe("12 mo");
		expect(quantityWithUnit("2", null, "sl")).toBe("2");
		expect(unitName("KGM", "sl")).toBe("Kilogram");
	});

	test("writes each line's unit into e-SLOG and falls back to a piece", () => {
		const xml = eslogXml(
			source({
				lines: [
					{
						description: "Svetovanje",
						quantity: 3,
						unit: "HUR",
						price: 5000,
						amount: 15000,
						allowance: 0,
						tax_rate: 22,
						tax_amount: 3300,
						treatment: "domestic",
					},
					{ description: "Knjiga", quantity: 1, unit: null, price: 2000, amount: 2000, allowance: 0, tax_rate: 9.5, tax_amount: 190, treatment: "domestic" },
				],
			})
		);

		expect(segment(xml, "G_SG26", "Svetovanje")).toContain("<D_6411>HUR</D_6411>");
		expect(segment(xml, "G_SG26", "Knjiga")).toContain("<D_6411>C62</D_6411>");
		if (xmllint) expect(schemaErrors(xml)).toBe("");
	});

	test("stores units on catalog items and invoice lines and sends them in e-SLOG", async () => {
		const created = await call("POST", `${base()}/items`, { token: ownerToken, body: { name: "Svetovanje", unit_price: 6000, tax_rate: 22, unit: "HUR" } });
		expect(created.data.unit).toBe("HUR");
		expect((await call("POST", `${base()}/items`, { token: ownerToken, body: { name: "Napaka", unit_price: 100, unit: "hours" } })).error).toBe(
			ErrorCode.INVALID_ITEM
		);
		const cleared = await call("PATCH", `${base()}/items/${created.data.uuid}`, { token: ownerToken, body: { unit: null } });
		expect(cleared.data.unit).toBeNull();

		const invoice = await issued(
			[
				{ description: "Svetovanje", quantity: 3, unit: "HUR", unit_price: 6000, tax_rate: 22 },
				{ description: "Gostovanje", quantity: 12, unit: "MON", unit_price: 1500, tax_rate: 22 },
				{ description: "Knjiga", quantity: 1, unit_price: 2000, tax_rate: 9.5 },
			],
			{ customer: customerUuid }
		);
		expect(invoice.items.map((line: { unit: string | null }) => line.unit)).toEqual(["HUR", "MON", null]);

		const document = (await call("GET", `${base()}/invoices/${invoice.uuid}/document`, { token: ownerToken })).data;
		expect(document.items.map((line: { unit: string | null }) => line.unit)).toEqual(["HUR", "MON", null]);

		const xml = await (await raw("GET", `${base()}/invoices/${invoice.uuid}/eslog`, { token: ownerToken })).text();
		expect(values(xml, "D_6411")).toEqual(["HUR", "MON", "C62"]);
	});

	test("keeps units on recurring invoice templates", async () => {
		const template = await call("POST", `${base()}/recurring`, {
			token: ownerToken,
			body: {
				customer: customerUuid,
				interval_unit: "month",
				interval_count: 1,
				start_date: Date.now() + 7 * 86400000,
				days_until_due: 10,
				items: [{ description: "Vzdrževanje", quantity: 1, unit: "MON", unit_price: 5000, tax_rate: 22 }],
			},
		});
		expect(template.error).toBe(0);
		const detail = (await call("GET", `${base()}/recurring/${template.data.uuid}`, { token: ownerToken })).data;
		expect(detail.items[0].unit).toBe("MON");
	});

	test("rejects an unknown unit on an invoice line", async () => {
		const res = await call("POST", `${base()}/invoices`, {
			token: ownerToken,
			body: { due_date: Date.now() + 86400000, items: [{ description: "Storitev", quantity: 1, unit: "HOURS", unit_price: 1000, tax_rate: 22 }] },
		});
		expect(res.error).toBe(ErrorCode.INVALID_INVOICE_ITEMS);
	});

	test("keeps the unit when a draft is edited without replacing its lines", async () => {
		const draft = await call("POST", `${base()}/invoices`, {
			token: ownerToken,
			body: {
				due_date: Date.now() + 86400000,
				customer: customerUuid,
				items: [{ description: "Svetovanje", quantity: 2, unit: "HUR", unit_price: 5000, tax_rate: 22 }],
			},
		});
		const edited = await call("PATCH", `${base()}/invoices/${draft.data.uuid}`, { token: ownerToken, body: { notes: "Hvala" } });
		expect(edited.data.items[0].unit).toBe("HUR");
	});
});
