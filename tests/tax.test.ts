import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import {
	DEFAULT_REDUCED_RATES,
	EU_COUNTRIES,
	STANDARD_RATES,
	defaultExemptionNote,
	defaultTaxCurrency,
	isEuCountry,
	partyTaxIds,
	splitVatNumber,
	suggestTax,
	viesPrefixFor,
} from "../server/tax";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.tax.sqlite`);

const { Server } = await import("../server/server");
const { Settings } = await import("../server/settings");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");

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

interface ViesCall {
	countryCode: string;
	vatNumber: string;
	requesterMemberStateCode?: string;
	requesterNumber?: string;
}

const viesCalls: ViesCall[] = [];
let viesReply: (request: ViesCall) => { status: number; body: unknown } = () => ({ status: 500, body: {} });

const fakeVies = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request) {
		if (new URL(request.url).pathname !== "/rest-api/check-vat-number") return new Response("not found", { status: 404 });
		const body = (await request.json()) as ViesCall;
		viesCalls.push(body);
		const reply = viesReply(body);
		return Response.json(reply.body, { status: reply.status });
	},
});

const validReply = (request: ViesCall) => ({
	status: 200,
	body: {
		countryCode: request.countryCode,
		vatNumber: request.vatNumber,
		requestDate: "2026-09-16T10:00:00.000Z",
		valid: true,
		requestIdentifier: request.requesterNumber ? "WAPIAAAAZ1234567" : "",
		name: "ACME   GMBH",
		address: "Hauptstrasse 1\n10115 Berlin",
	},
});

let ownerToken = "";
let viewerToken = "";
let projectUuid = "";
const base = () => `/api/v1/projects/${projectUuid}`;

beforeAll(async () => {
	Settings.vies = { enabled: true, api_url: `http://127.0.0.1:${fakeVies.port}/rest-api/`, timeout: 2 };

	await Cache.initialize();
	await initializeDatabase();

	await call("POST", "/api/v1/auth/register", { body: { email: "tax-owner@example.com", password: password("tax-owner") } });
	ownerToken = (await call("POST", "/api/v1/auth/login", { body: { email: "tax-owner@example.com", password: password("tax-owner") } })).data.token;

	await call("POST", "/api/v1/auth/register", { body: { email: "tax-viewer@example.com", password: password("tax-viewer") } });
	viewerToken = (await call("POST", "/api/v1/auth/login", { body: { email: "tax-viewer@example.com", password: password("tax-viewer") } })).data.token;

	projectUuid = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "tax-shop", currency: "EUR" } })).data.uuid;
	await call("POST", `${base()}/members`, { token: ownerToken, body: { email: "tax-viewer@example.com", role: "viewer" } });
});

afterAll(async () => {
	fakeVies.stop(true);
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.tax.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("reading a VAT number", () => {
	test("takes the country from the prefix and ignores spacing", () => {
		expect(splitVatNumber("de 123.456-789", null)).toEqual({ prefix: "DE", country: "DE", number: "123456789" });
		expect(splitVatNumber("SI12345678", "AT")).toEqual({ prefix: "SI", country: "SI", number: "12345678" });
	});

	test("uses Greece's EL prefix and Northern Ireland's XI prefix", () => {
		expect(splitVatNumber("EL123456789", null)).toEqual({ prefix: "EL", country: "GR", number: "123456789" });
		expect(splitVatNumber("123456789", "GR")).toEqual({ prefix: "EL", country: "GR", number: "123456789" });
		expect(splitVatNumber("XI123456789", null)).toEqual({ prefix: "XI", country: "GB", number: "123456789" });
		expect(viesPrefixFor("GR")).toBe("EL");
	});

	test("falls back to the customer's EU country when there is no prefix", () => {
		expect(splitVatNumber("12345678", "SI")).toEqual({ prefix: "SI", country: "SI", number: "12345678" });
	});

	test("refuses numbers VIES cannot check", () => {
		expect(splitVatNumber("GB123456789", null)).toBeNull();
		expect(splitVatNumber("GR123456789", null)).toBeNull();
		expect(splitVatNumber("CHE-123.456.789", null)).toBeNull();
		expect(splitVatNumber("12345678", "US")).toBeNull();
		expect(splitVatNumber("12345678", null)).toBeNull();
		expect(splitVatNumber("", "SI")).toBeNull();
		expect(splitVatNumber(null, "SI")).toBeNull();
	});
});

describe("tax defaults", () => {
	test("know which countries are in the EU", () => {
		expect(isEuCountry("SI")).toBe(true);
		expect(isEuCountry("BG")).toBe(true);
		expect(isEuCountry("GB")).toBe(false);
		expect(isEuCountry("CH")).toBe(false);
		expect(isEuCountry(null)).toBe(false);
	});

	test("suggest the currency VAT is reported in", () => {
		expect(defaultTaxCurrency("SI")).toBe("EUR");
		expect(defaultTaxCurrency("HR")).toBe("EUR");
		expect(defaultTaxCurrency("PL")).toBe("PLN");
		expect(defaultTaxCurrency("SE")).toBe("SEK");
		expect(defaultTaxCurrency("US")).toBeNull();
	});

	test("word the Slovenian exemption as the law requires", () => {
		expect(defaultExemptionNote("SI", "sl")).toBe("DDV ni obračunan na podlagi 1. odstavka 94. člena ZDDV-1.");
		expect(defaultExemptionNote("SI", "en")).toContain("Article 94(1)");
		expect(defaultExemptionNote("AT", "en")).toContain("small business exemption");
	});
});

describe("the domestic reverse charge", () => {
	const seller = { country: "SI", vatStatus: "registered", ossRegistered: false };
	const line = { supplyType: "services" as const, category: "domestic_reverse" as const, rate: 22 };
	const buyer = { country: "SI", type: "business", vatNumber: "SI87654321", vatValid: true as boolean | null };

	test("is suggested for a business in the seller's country whose VAT number is confirmed", () => {
		expect(suggestTax(seller, buyer, line)).toEqual({ treatment: "domestic_reverse_charge", rate: 0, warnings: [] });
	});

	test("charges VAT and says why when the VAT number is missing, unchecked or invalid", () => {
		for (const other of [null, { ...buyer, vatNumber: null }, { ...buyer, type: "individual" }, { ...buyer, country: null, type: null, vatNumber: null }]) {
			expect(suggestTax(seller, other, line)).toEqual({ treatment: "domestic", rate: 22, warnings: ["domestic_reverse_buyer"] });
		}
		expect(suggestTax(seller, { ...buyer, vatValid: null }, line)).toEqual({ treatment: "domestic", rate: 22, warnings: ["vies_check"] });
		expect(suggestTax(seller, { ...buyer, vatValid: false }, line)).toEqual({ treatment: "domestic", rate: 22, warnings: ["vies_invalid"] });
	});

	test("does not change how ordinary lines or foreign customers are taxed", () => {
		expect(suggestTax(seller, buyer, { ...line, category: "standard" })).toEqual({ treatment: "domestic", rate: 22, warnings: [] });
		expect(suggestTax(seller, { country: "DE", type: "business", vatNumber: "DE123456789", vatValid: true }, line).treatment).toBe("reverse_charge");
		expect(suggestTax({ ...seller, vatStatus: "small_business" }, buyer, line).treatment).toBe("small_business");
	});
});

describe("a project's tax profile", () => {
	test("starts empty", async () => {
		const res = await call("GET", base(), { token: ownerToken });

		expect(res.data.tax_country).toBeNull();
		expect(res.data.vat_status).toBeNull();
		expect(res.data.oss_registered).toBe(false);
		expect(res.data.tax_currency).toBeNull();
	});

	test("is saved and read back", async () => {
		const res = await call("PATCH", base(), {
			token: ownerToken,
			body: { tax_country: "SI", vat_status: "registered", oss_registered: true, tax_currency: "EUR" },
		});

		expect(res.error).toBe(0);
		expect(res.data.tax_country).toBe("SI");
		expect(res.data.vat_status).toBe("registered");
		expect(res.data.oss_registered).toBe(true);
		expect(res.data.tax_currency).toBe("EUR");
		expect(res.data.currency).toBe("EUR");
	});

	test("is refused when a value is not one we know", async () => {
		for (const body of [
			{ tax_country: "XX" },
			{ tax_country: "si" },
			{ vat_status: "exempt" },
			{ oss_registered: "yes" },
			{ tax_currency: "euro" },
			{ vat_exemption_note: "x".repeat(501) },
		]) {
			expect((await call("PATCH", base(), { token: ownerToken, body })).error).toBe(1068);
		}
	});

	test("cannot be changed by a viewer", async () => {
		expect((await call("PATCH", base(), { token: viewerToken, body: { vat_status: "not_registered" } })).error).toBe(9999);
	});

	test("always reports in euros for a Slovenian seller", async () => {
		const created = await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "usd-in-slovenia", currency: "USD" } });
		const path = `/api/v1/projects/${created.data.uuid}`;

		const refused = await call("PATCH", path, { token: ownerToken, body: { tax_country: "SI", tax_currency: "USD" } });
		expect(refused.error).toBe(1068);

		const slovenian = await call("PATCH", path, { token: ownerToken, body: { tax_country: "SI" } });
		expect(slovenian.data).toMatchObject({ currency: "USD", tax_country: "SI", tax_currency: "EUR" });
		expect((await call("PATCH", path, { token: ownerToken, body: { tax_currency: "USD" } })).error).toBe(1068);
		expect((await call("PATCH", path, { token: ownerToken, body: { tax_currency: null } })).data.tax_currency).toBe("EUR");

		const moved = await call("PATCH", path, { token: ownerToken, body: { tax_country: "US", tax_currency: "USD" } });
		expect(moved.data).toMatchObject({ tax_country: "US", tax_currency: "USD" });
	});
});

describe("the exemption note on an invoice", () => {
	async function documentNote() {
		const created = await call("POST", `${base()}/invoices`, {
			token: ownerToken,
			body: { due_date: Date.now() + 86400000, items: [{ description: "Work", quantity: 1, unit_price: 1000 }] },
		});
		const document = await call("GET", `${base()}/invoices/${created.data.uuid}/document`, { token: ownerToken });
		return document.data.tax;
	}

	test("is left out for a VAT registered seller", async () => {
		const tax = await documentNote();
		expect(tax.vat_status).toBe("registered");
		expect(tax.exemption_note).toBeNull();
	});

	test("uses the legal wording in the invoice language for a small business", async () => {
		await call("PATCH", base(), { token: ownerToken, body: { vat_status: "small_business", language: "sl" } });
		expect((await documentNote()).exemption_note).toBe("DDV ni obračunan na podlagi 1. odstavka 94. člena ZDDV-1.");
	});

	test("uses the seller's own wording when given", async () => {
		await call("PATCH", base(), { token: ownerToken, body: { vat_exemption_note: "  Oproščeno po 94. členu.  " } });
		expect((await documentNote()).exemption_note).toBe("Oproščeno po 94. členu.");

		await call("PATCH", base(), { token: ownerToken, body: { vat_exemption_note: "", vat_status: "registered", language: "en" } });
	});
});

describe("a customer's type", () => {
	test("is saved and can be cleared", async () => {
		const created = await call("POST", `${base()}/customers`, { token: ownerToken, body: { email: "type@example.com", customer_type: "individual" } });
		expect(created.data.customer_type).toBe("individual");

		const cleared = await call("PATCH", `${base()}/customers/${created.data.uuid}`, { token: ownerToken, body: { customer_type: null } });
		expect(cleared.data.customer_type).toBeNull();
	});

	test("is refused when unknown", async () => {
		expect((await call("POST", `${base()}/customers`, { token: ownerToken, body: { email: "bad-type@example.com", customer_type: "company" } })).error).toBe(
			1069
		);
	});
});

describe("checking a VAT number in VIES", () => {
	let customer = "";
	const check = (id = customer, token = ownerToken) => call("POST", `${base()}/customers/${id}/vat-check`, { token });

	beforeAll(async () => {
		customer = (
			await call("POST", `${base()}/customers`, {
				token: ownerToken,
				body: { email: "acme@example.de", name: "Acme", vat_number: "DE 123 456 789", country: "DE" },
			})
		).data.uuid;
	});

	test("starts unchecked", async () => {
		const res = await call("GET", `${base()}/customers/${customer}`, { token: ownerToken });
		expect(res.data.vat_valid).toBeNull();
		expect(res.data.vat_checked_at).toBeNull();
	});

	test("stores a valid answer, with the consultation number when we are VAT registered", async () => {
		await call("PUT", `${base()}/company`, { token: ownerToken, body: { vat_number: "SI 12345678" } });
		viesReply = validReply;
		viesCalls.length = 0;

		const res = await check();

		expect(res.error).toBe(0);
		expect(viesCalls).toEqual([{ countryCode: "DE", vatNumber: "123456789", requesterMemberStateCode: "SI", requesterNumber: "12345678" }]);
		expect(res.data.vat_valid).toBe(true);
		expect(res.data.vat_checked_at).toBe(Date.parse("2026-09-16T10:00:00.000Z"));
		expect(res.data.vat_checked_name).toBe("ACME GMBH");
		expect(res.data.vat_checked_address).toBe("Hauptstrasse 1 10115 Berlin");
		expect(res.data.vat_check_reference).toBe("WAPIAAAAZ1234567");
		expect(res.data.customer_type).toBe("business");
	});

	test("leaves the requester out when we are not VAT registered", async () => {
		await call("PATCH", base(), { token: ownerToken, body: { vat_status: "small_business" } });
		viesCalls.length = 0;

		const res = await check();

		expect(viesCalls[0]).toEqual({ countryCode: "DE", vatNumber: "123456789" });
		expect(res.data.vat_check_reference).toBeNull();

		await call("PATCH", base(), { token: ownerToken, body: { vat_status: "registered" } });
	});

	test("keeps the result when other details change and clears it when the number changes", async () => {
		const renamed = await call("PATCH", `${base()}/customers/${customer}`, { token: ownerToken, body: { name: "Acme GmbH", vat_number: "de123456789" } });
		expect(renamed.data.vat_valid).toBe(true);

		const changed = await call("PATCH", `${base()}/customers/${customer}`, { token: ownerToken, body: { vat_number: "DE999999999" } });
		expect(changed.data.vat_valid).toBeNull();
		expect(changed.data.vat_checked_at).toBeNull();
		expect(changed.data.vat_checked_name).toBeNull();
		expect(changed.data.vat_check_reference).toBeNull();
		expect(changed.data.customer_type).toBe("business");
	});

	test("stores an invalid answer without a name or address", async () => {
		viesReply = (request) => ({
			status: 200,
			body: { countryCode: request.countryCode, vatNumber: request.vatNumber, requestDate: "2026-09-16T11:00:00Z", valid: false, name: "---", address: "---" },
		});

		const res = await check();

		expect(res.data.vat_valid).toBe(false);
		expect(res.data.vat_checked_name).toBeNull();
		expect(res.data.vat_checked_address).toBeNull();
	});

	test("treats a number VIES calls malformed as invalid", async () => {
		viesReply = () => ({ status: 400, body: { actionSucceed: false, errorWrappers: [{ error: "INVALID_INPUT" }] } });

		const res = await check();

		expect(res.error).toBe(0);
		expect(res.data.vat_valid).toBe(false);
	});

	test("keeps the previous result when VIES is down", async () => {
		viesReply = validReply;
		await check();

		for (const reply of [
			{ status: 500, body: { actionSucceed: false, errorWrappers: [{ error: "MS_UNAVAILABLE" }] } },
			{ status: 200, body: { actionSucceed: false, errorWrappers: [{ error: "MS_MAX_CONCURRENT_REQ" }] } },
			{ status: 502, body: "<html>bad gateway</html>" },
		]) {
			viesReply = () => reply;
			const res = await check();
			expect(res.error).toBe(1071);
			expect(res.status).toBe(503);
		}

		const res = await call("GET", `${base()}/customers/${customer}`, { token: ownerToken });
		expect(res.data.vat_valid).toBe(true);
	});

	test("reports VIES as unavailable when it cannot be reached or is switched off", async () => {
		const original = Settings.vies;

		Settings.vies = { ...original, api_url: "http://127.0.0.1:1" };
		expect((await check()).error).toBe(1071);

		Settings.vies = { ...original, enabled: false };
		expect((await check()).error).toBe(1071);

		Settings.vies = original;
	});

	test("fills in a missing country from a valid number", async () => {
		viesReply = validReply;
		const greek = await call("POST", `${base()}/customers`, { token: ownerToken, body: { email: "gr@example.gr", vat_number: "EL123456789" } });
		const res = await check(greek.data.uuid);

		expect(viesCalls.at(-1)?.countryCode).toBe("EL");
		expect(res.data.country).toBe("GR");
		expect(res.data.vat_valid).toBe(true);
	});

	test("is refused for a number VIES cannot check", async () => {
		const swiss = await call("POST", `${base()}/customers`, {
			token: ownerToken,
			body: { email: "ch@example.ch", vat_number: "CHE-123.456.789", country: "CH" },
		});
		const bare = await call("POST", `${base()}/customers`, { token: ownerToken, body: { email: "bare@example.com" } });

		expect((await check(swiss.data.uuid)).error).toBe(1070);
		expect((await check(bare.data.uuid)).error).toBe(1070);
	});

	test("needs permission to edit customers", async () => {
		expect((await check(customer, viewerToken)).error).toBe(9999);
	});

	test("is recorded in the audit log", async () => {
		const [row] = (await Database`
			SELECT COUNT(*) AS count FROM audit_log WHERE action = 'customer.vat_checked' AND entity_id = ${customer}
		`) as { count: number }[];
		expect(Number(row.count)).toBeGreaterThan(0);
	});
});

describe("suggesting VAT for a line", () => {
	const registered = { country: "SI", vatStatus: "registered", ossRegistered: false };
	const withOss = { ...registered, ossRegistered: true };
	const service = { supplyType: "services" as const, category: "standard" as const, rate: 22 };
	const digital = { supplyType: "digital" as const, category: "standard" as const, rate: 22 };
	const goods = { supplyType: "goods" as const, category: "standard" as const, rate: 22 };
	const person = (country: string | null) => ({ country, type: "individual", vatNumber: null, vatValid: null });
	const company = (country: string | null, vatValid: boolean | null = true) => ({ country, type: "business", vatNumber: "X123", vatValid });

	test("charges your own rate at home and without a customer", () => {
		expect(suggestTax(registered, null, service)).toEqual({ treatment: "domestic", rate: 22, warnings: [] });
		expect(suggestTax(registered, company("SI"), goods)).toMatchObject({ treatment: "domestic", rate: 22 });
		expect(suggestTax(registered, person("SI"), digital)).toMatchObject({ treatment: "domestic", rate: 22 });
	});

	test("uses reverse charge for a verified EU business and the goods exemption for goods", () => {
		expect(suggestTax(registered, company("DE"), service)).toEqual({ treatment: "reverse_charge", rate: 0, warnings: [] });
		expect(suggestTax(registered, company("DE"), digital)).toMatchObject({ treatment: "reverse_charge", rate: 0 });
		expect(suggestTax(registered, company("DE"), goods)).toMatchObject({ treatment: "intra_eu_goods", rate: 0 });
	});

	test("treats an EU business without a valid number as a consumer and says why", () => {
		const unchecked = suggestTax(registered, company("DE", null), service);
		expect(unchecked).toMatchObject({ treatment: "domestic", rate: 22 });
		expect(unchecked.warnings).toEqual(["vies_check"]);

		const invalid = suggestTax(withOss, company("DE", false), digital);
		expect(invalid).toMatchObject({ treatment: "oss", rate: 19 });
		expect(invalid.warnings).toEqual(["vies_invalid"]);
	});

	test("counts a customer with a VAT number and no type as a business", () => {
		expect(suggestTax(registered, { country: "AT", type: null, vatNumber: "ATU1", vatValid: true }, service)).toMatchObject({ treatment: "reverse_charge" });
	});

	test("charges the customer's country rate to EU consumers only with OSS", () => {
		expect(suggestTax(withOss, person("DE"), digital)).toEqual({ treatment: "oss", rate: 19, warnings: [] });
		expect(suggestTax(withOss, person("FI"), goods)).toMatchObject({ treatment: "oss", rate: 25.5 });
		expect(suggestTax(withOss, person("DE"), service)).toMatchObject({ treatment: "domestic", rate: 22 });

		const withoutOss = suggestTax(registered, person("DE"), digital);
		expect(withoutOss).toMatchObject({ treatment: "domestic", rate: 22 });
		expect(withoutOss.warnings).toEqual(["oss_threshold"]);
	});

	test("flags a reduced item sold under OSS", () => {
		const reduced = suggestTax(withOss, person("DE"), { supplyType: "goods", category: "reduced", rate: 9.5 });
		expect(reduced).toMatchObject({ treatment: "oss", rate: 19 });
		expect(reduced.warnings).toEqual(["reduced_rate"]);
	});

	test("zero rates exports and business services outside the EU", () => {
		expect(suggestTax(registered, person("US"), goods)).toMatchObject({ treatment: "export", rate: 0 });
		expect(suggestTax(registered, company("US"), service)).toEqual({ treatment: "outside_scope", rate: 0, warnings: [] });
		expect(suggestTax(registered, { country: "CH", type: "business", vatNumber: null, vatValid: null }, service).warnings).toEqual(["business_proof"]);
		expect(suggestTax(registered, person("GB"), digital)).toMatchObject({ treatment: "outside_scope", rate: 0 });
	});

	test("keeps your rate for services to consumers outside the EU", () => {
		expect(suggestTax(registered, person("US"), service)).toMatchObject({ treatment: "domestic", rate: 22 });
	});

	test("zero rates exempt items everywhere", () => {
		const exempt = suggestTax(registered, person("SI"), { supplyType: "services", category: "exempt", rate: 0 });
		expect(exempt).toMatchObject({ treatment: "exempt", rate: 0 });
		expect(exempt.warnings).toEqual(["exempt_basis"]);
	});

	test("never charges VAT for a small business", () => {
		expect(suggestTax({ ...registered, vatStatus: "small_business" }, company("DE"), goods)).toEqual({ treatment: "small_business", rate: 0, warnings: [] });
	});

	test("makes no suggestion without a usable tax profile", () => {
		expect(suggestTax({ country: null, vatStatus: null, ossRegistered: false }, company("DE"), service)).toMatchObject({ treatment: null, rate: 22 });
		expect(suggestTax({ country: "US", vatStatus: "registered", ossRegistered: false }, company("DE"), service)).toEqual({
			treatment: null,
			rate: 22,
			warnings: [],
		});
		expect(suggestTax({ country: "SI", vatStatus: "not_registered", ossRegistered: false }, company("DE"), service)).toEqual({
			treatment: null,
			rate: 22,
			warnings: [],
		});
	});

	test("asks for the country of a business customer", () => {
		expect(suggestTax(registered, company(null), service).warnings).toEqual(["customer_country"]);
	});

	test("has a standard rate for every EU country", () => {
		for (const country of EU_COUNTRIES) expect(STANDARD_RATES[country]).toBeGreaterThan(0);
		expect(Object.keys(STANDARD_RATES).sort()).toEqual([...EU_COUNTRIES].sort());
	});

	test("has a default reduced rate for every country with a standard rate", () => {
		expect(Object.keys(DEFAULT_REDUCED_RATES).sort()).toEqual(Object.keys(STANDARD_RATES).sort());
		for (const [country, rate] of Object.entries(DEFAULT_REDUCED_RATES)) {
			expect(rate, country).toBeGreaterThanOrEqual(0);
			expect(rate, country).toBeLessThan(STANDARD_RATES[country]);
		}
		expect(DEFAULT_REDUCED_RATES.SI).toBe(9.5);
		expect(DEFAULT_REDUCED_RATES.DK).toBe(0);
	});
});

describe("VAT on items and invoice lines", () => {
	test("an item keeps its supply type and category", async () => {
		const res = await call("POST", `${base()}/items`, {
			token: ownerToken,
			body: { name: "E-book", unit_price: 1000, tax_rate: 5, supply_type: "digital", tax_category: "reduced" },
		});

		expect(res.data.supply_type).toBe("digital");
		expect(res.data.tax_category).toBe("reduced");
		expect(res.data.tax_rate).toBe(5);

		const defaults = await call("POST", `${base()}/items`, { token: ownerToken, body: { name: "Hour", unit_price: 5000, tax_rate: 22 } });
		expect(defaults.data.supply_type).toBe("services");
		expect(defaults.data.tax_category).toBe("standard");
	});

	test("an exempt item has no rate", async () => {
		const created = await call("POST", `${base()}/items`, { token: ownerToken, body: { name: "Course", unit_price: 1000, tax_category: "exempt" } });
		expect(created.data.tax_rate).toBe(0);

		const standard = await call("POST", `${base()}/items`, { token: ownerToken, body: { name: "Kit", unit_price: 1000, tax_rate: 22 } });
		const made = await call("PATCH", `${base()}/items/${standard.data.uuid}`, { token: ownerToken, body: { tax_category: "exempt" } });
		expect(made.data.tax_rate).toBe(0);

		expect(
			(await call("POST", `${base()}/items`, { token: ownerToken, body: { name: "Bad", unit_price: 1, tax_category: "exempt", tax_rate: 5 } })).error
		).toBe(1066);
	});

	test("an item refuses unknown tax types", async () => {
		for (const body of [
			{ name: "Bad", unit_price: 1, supply_type: "physical" },
			{ name: "Bad", unit_price: 1, tax_category: "zero" },
		]) {
			expect((await call("POST", `${base()}/items`, { token: ownerToken, body })).error).toBe(1066);
		}
	});

	test("a line keeps its treatment and the invoice prints the matching notes", async () => {
		const created = await call("POST", `${base()}/invoices`, {
			token: ownerToken,
			body: {
				due_date: Date.now() + 86400000,
				items: [
					{ description: "Consulting", quantity: 1, unit_price: 10000, tax_rate: 0, tax_treatment: "reverse_charge" },
					{ description: "Parts", quantity: 1, unit_price: 5000, tax_rate: 0, tax_treatment: "intra_eu_goods" },
					{ description: "Fee", quantity: 1, unit_price: 100, tax_rate: 22, tax_treatment: "domestic" },
					{ description: "Extra", quantity: 1, unit_price: 100, tax_rate: 0, tax_treatment: "reverse_charge" },
				],
			},
		});

		expect(created.error).toBe(0);
		expect(created.data.items.map((item: any) => item.tax_treatment)).toEqual(["reverse_charge", "intra_eu_goods", "domestic", "reverse_charge"]);

		const document = await call("GET", `${base()}/invoices/${created.data.uuid}/document`, { token: ownerToken });
		expect(document.data.items[0].tax_treatment).toBe("reverse_charge");
		expect(document.data.tax.notes).toEqual([
			"Reverse charge: VAT is to be accounted for by the recipient under Article 196 of Directive 2006/112/EC.",
			"VAT exempt intra-Community supply of goods under Article 138 of Directive 2006/112/EC.",
		]);

		const updated = await call("PATCH", `${base()}/invoices/${created.data.uuid}`, { token: ownerToken, body: { notes: "Thanks" } });
		expect(updated.data.items[0].tax_treatment).toBe("reverse_charge");
	});

	test("the notes follow the invoice language", async () => {
		await call("PATCH", base(), { token: ownerToken, body: { language: "sl" } });
		const created = await call("POST", `${base()}/invoices`, {
			token: ownerToken,
			body: { due_date: Date.now() + 86400000, items: [{ description: "Izvoz", quantity: 1, unit_price: 100, tax_rate: 0, tax_treatment: "export" }] },
		});
		const document = await call("GET", `${base()}/invoices/${created.data.uuid}/document`, { token: ownerToken });

		expect(document.data.tax.notes).toEqual(["Oproščen izvoz blaga v skladu s 146. členom Direktive 2006/112/ES."]);
		await call("PATCH", base(), { token: ownerToken, body: { language: "en" } });
	});

	test("a zero rated treatment cannot carry VAT and an unknown one is refused", async () => {
		for (const item of [
			{ description: "Wrong", quantity: 1, unit_price: 100, tax_rate: 22, tax_treatment: "reverse_charge" },
			{ description: "Wrong", quantity: 1, unit_price: 100, tax_rate: 22, tax_treatment: "small_business" },
			{ description: "Wrong", quantity: 1, unit_price: 100, tax_rate: 0, tax_treatment: "zero" },
		]) {
			const res = await call("POST", `${base()}/invoices`, { token: ownerToken, body: { due_date: Date.now() + 86400000, items: [item] } });
			expect(res.error).toBe(1038);
		}
	});

	test("a line without a treatment still works", async () => {
		const res = await call("POST", `${base()}/invoices`, {
			token: ownerToken,
			body: { due_date: Date.now() + 86400000, items: [{ description: "Plain", quantity: 1, unit_price: 100, tax_rate: 9.5 }] },
		});
		expect(res.data.items[0].tax_treatment).toBeNull();

		const document = await call("GET", `${base()}/invoices/${res.data.uuid}/document`, { token: ownerToken });
		expect(document.data.tax.notes).toEqual([]);
	});
});

describe("a customer's tax numbers", () => {
	test("store the VAT ID with its country prefix next to a separate tax number", async () => {
		const res = await call("POST", `${base()}/customers`, {
			token: ownerToken,
			body: { email: "rangor@example.si", name: "RANGOR d.o.o.", country: "SI", vat_number: "91534534", tax_number: " 12345678 " },
		});

		expect(res.data.vat_number).toBe("SI91534534");
		expect(res.data.tax_number).toBe("12345678");
	});

	test("keep a number VIES cannot read exactly as typed", async () => {
		const res = await call("POST", `${base()}/customers`, {
			token: ownerToken,
			body: { email: "swiss-tax@example.ch", country: "CH", vat_number: "CHE-123.456.789" },
		});

		expect(res.data.vat_number).toBe("CHE-123.456.789");
	});

	test("add the prefix to an older number without losing its VIES result", async () => {
		const created = await call("POST", `${base()}/customers`, { token: ownerToken, body: { email: "older@example.si", country: "SI" } });
		const id = created.data.uuid;
		await Database`UPDATE customers SET vat_number = ${"91534534"}, vat_valid = ${1}, vat_checked_at = ${1} WHERE uuid = ${id}`;

		const renamed = await call("PATCH", `${base()}/customers/${id}`, { token: ownerToken, body: { name: "Older d.o.o." } });
		expect(renamed.data.vat_number).toBe("91534534");
		expect(renamed.data.vat_valid).toBe(true);

		const saved = await call("PATCH", `${base()}/customers/${id}`, { token: ownerToken, body: { vat_number: "91534534" } });
		expect(saved.data.vat_number).toBe("SI91534534");
		expect(saved.data.vat_valid).toBe(true);
	});

	test("can be searched by tax number", async () => {
		const res = await call("GET", `${base()}/customers?search=12345678`, { token: ownerToken });
		expect(res.data.customers.map((customer: { email: string }) => customer.email)).toContain("rangor@example.si");
	});
});

describe("the tax numbers printed for the seller", () => {
	const simonca = { vat_number: "85465313", tax_number: "85465313", country: "SI" };

	test("show only the tax number for a seller outside the VAT system", () => {
		expect(partyTaxIds(simonca, "not_registered")).toEqual([{ key: "invoice.tax_number", value: "85465313" }]);
		expect(partyTaxIds(simonca, "small_business")).toEqual([{ key: "invoice.tax_number", value: "85465313" }]);
	});

	test("fall back to the number typed as a VAT ID when an unregistered seller has no tax number", () => {
		expect(partyTaxIds({ vat_number: "SI85465313", tax_number: null, country: "SI" }, "not_registered")).toEqual([
			{ key: "invoice.tax_number", value: "85465313" },
		]);
	});

	test("show only the VAT ID for a registered seller whose tax number is the same digits", () => {
		expect(partyTaxIds({ ...simonca, vat_number: "SI 85465313" }, "registered")).toEqual([{ key: "invoice.vat_number", value: "SI85465313" }]);
		expect(partyTaxIds(simonca, "registered")).toEqual([{ key: "invoice.vat_number", value: "SI85465313" }]);
	});

	test("keep a tax number that differs from the VAT ID", () => {
		expect(partyTaxIds({ vat_number: "DE123456789", tax_number: "12/345/67890", country: "DE" }, "registered")).toEqual([
			{ key: "invoice.vat_number", value: "DE123456789" },
			{ key: "invoice.tax_number", value: "12/345/67890" },
		]);
	});

	test("still avoid the duplicate when the VAT status was never chosen", () => {
		expect(partyTaxIds(simonca, null)).toEqual([{ key: "invoice.vat_number", value: "SI85465313" }]);
		expect(partyTaxIds({ vat_number: null, tax_number: "85465313", country: "SI" }, null)).toEqual([{ key: "invoice.tax_number", value: "85465313" }]);
		expect(partyTaxIds({ vat_number: null, tax_number: null, country: "SI" }, "registered")).toEqual([]);
	});
});

describe("the tax numbers printed for the buyer", () => {
	test("show a registered buyer's VAT ID with its prefix", () => {
		expect(partyTaxIds({ vat_number: "91534534", tax_number: null, country: "SI" }, null)).toEqual([{ key: "invoice.vat_number", value: "SI91534534" }]);
	});

	test("show the tax number of a business outside the VAT system", () => {
		expect(partyTaxIds({ vat_number: null, tax_number: "12345678", country: "SI" }, null)).toEqual([{ key: "invoice.tax_number", value: "12345678" }]);
	});

	test("show nothing for a buyer without either number", () => {
		expect(partyTaxIds({ vat_number: null, country: "SI" }, null)).toEqual([]);
	});
});
