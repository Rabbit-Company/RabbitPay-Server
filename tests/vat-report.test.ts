import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import { vatPeriod, vatReportCsv } from "../server/vat-report";
import { convertMinor } from "../server/invoicing";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.vat-report.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { ErrorCode } = await import("../server/errors");
const { setRateProvider } = await import("../server/rates/forex");
const { storeEcbRates } = await import("../server/rates/ecb");
const { DEFAULT_TIMEZONE, localDate, startOfLocalDate } = await import("../server/timezone");
const { createInvoice } = await import("../server/invoice-service");

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

const RATES: Record<string, Record<string, number>> = { USD: { EUR: 0.9, USD: 1 } };

let ownerToken = "";
let viewerToken = "";
let projectUuid = "";
const base = () => `/api/v1/projects/${projectUuid}`;
const customers: Record<string, string> = {};
const ids: Record<string, string> = {};

async function issue(items: unknown[], options: { customer?: string; currency?: string; discount?: number; rate?: number } = {}) {
	const created = await call("POST", `${base()}/invoices`, {
		token: ownerToken,
		body: {
			customer: options.customer ?? null,
			currency: options.currency ?? "EUR",
			discount_amount: options.discount ?? 0,
			due_date: Date.now() + 86400000,
			supply_date: Date.now(),
			tax_exchange_rate: options.rate ?? null,
			items,
		},
	});
	if (created.error !== 0) throw new Error(created.info);
	const opened = await call("POST", `${base()}/invoices/${created.data.uuid}/open`, { token: ownerToken });
	return opened.data;
}

async function report(query = "") {
	return (await call("POST", `${base()}/reports/vat${query}`, { token: ownerToken })).data;
}

beforeAll(async () => {
	setRateProvider({
		unitsPerAsset: async () => null,
		fiatRates: async (from: string) => RATES[from] ?? null,
	});

	await Cache.initialize();
	const { updateSettings } = await import("../server/settings");
	await updateSettings({ "reports.cooldown_minutes": 0 });
	await initializeDatabase();
	await storeEcbRates([{ day: localDate(Date.now(), DEFAULT_TIMEZONE), currency: "USD", rate: 1 / 0.9 }]);

	await call("POST", "/api/v1/auth/register", { body: { email: "vat-owner@example.com", password: password("vat-owner") } });
	ownerToken = (await call("POST", "/api/v1/auth/login", { body: { email: "vat-owner@example.com", password: password("vat-owner") } })).data.token;
	await call("POST", "/api/v1/auth/register", { body: { email: "vat-viewer@example.com", password: password("vat-viewer") } });
	viewerToken = (await call("POST", "/api/v1/auth/login", { body: { email: "vat-viewer@example.com", password: password("vat-viewer") } })).data.token;

	projectUuid = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "vat-shop", currency: "EUR" } })).data.uuid;
	await call("PATCH", base(), { token: ownerToken, body: { tax_country: "SI", vat_status: "registered", oss_registered: true, tax_currency: "EUR" } });
	await call("PUT", `${base()}/company`, {
		token: ownerToken,
		body: {
			legal_name: "VAT Shop d.o.o.",
			address_line1: "Dunajska cesta 1",
			postal_code: "1000",
			city: "Ljubljana",
			country: "SI",
			vat_number: "SI12345678",
		},
	});
	await call("POST", `${base()}/members`, { token: ownerToken, body: { email: "vat-viewer@example.com", role: "viewer" } });

	for (const [key, body] of Object.entries({
		de: { email: "de@example.de", country: "DE", vat_number: "DE123456789", customer_type: "business" },
		at: { email: "at@example.at", country: "AT", vat_number: "ATU12345678", customer_type: "business" },
		fr: { email: "fr@example.fr", country: "FR", customer_type: "individual" },
		us: { email: "us@example.com", country: "US", customer_type: "individual" },
		it: { email: "it@example.it", country: "IT", vat_number: "IT12345678901", customer_type: "business" },
	})) {
		customers[key] = (
			await call("POST", `${base()}/customers`, {
				token: ownerToken,
				body:
					body.customer_type === "business"
						? { ...body, name: `${key.toUpperCase()} Customer`, address_line1: "Main Street 1", postal_code: "1000", city: "City" }
						: body,
			})
		).data.uuid;
	}

	ids.domestic = (
		await issue(
			[
				{ description: "Service", quantity: 1, unit_price: 10000, tax_rate: 22, tax_treatment: "domestic" },
				{ description: "Book", quantity: 2, unit_price: 5000, tax_rate: 9.5, tax_treatment: "domestic" },
			],
			{ discount: 2000 }
		)
	).uuid;
	ids.legacy = (await issue([{ description: "Old style", quantity: 1, unit_price: 1000, tax_rate: 22 }])).uuid;
	ids.reverse = (
		await issue([{ description: "Consulting", quantity: 1, unit_price: 50000, tax_rate: 0, tax_treatment: "reverse_charge" }], { customer: customers.de })
	).uuid;
	ids.goods = (
		await issue(
			[
				{ description: "Router", quantity: 1, unit_price: 20000, tax_rate: 0, tax_treatment: "intra_eu_goods" },
				{ description: "Setup", quantity: 1, unit_price: 3000, tax_rate: 0, tax_treatment: "reverse_charge" },
			],
			{ customer: customers.de }
		)
	).uuid;
	ids.oss = (await issue([{ description: "App", quantity: 1, unit_price: 1000, tax_rate: 20, tax_treatment: "oss" }], { customer: customers.fr })).uuid;
	ids.export = (await issue([{ description: "Parcel", quantity: 1, unit_price: 7000, tax_rate: 0, tax_treatment: "export" }], { customer: customers.us })).uuid;
	ids.usd = (await issue([{ description: "Hour", quantity: 1, unit_price: 10000, tax_rate: 22, tax_treatment: "domestic" }], { currency: "USD" })).uuid;
	ids.gbp = (
		await issue([{ description: "Hour", quantity: 1, unit_price: 10000, tax_rate: 22, tax_treatment: "domestic" }], { currency: "GBP", rate: 1.2 })
	).uuid;
	await Database`UPDATE invoices SET tax_exchange_rate = NULL, tax_rate_source = NULL, tax_rate_date = NULL WHERE uuid = ${ids.gbp}`;
	ids.noVat = (
		await issue([{ description: "Unchecked", quantity: 1, unit_price: 100, tax_rate: 0, tax_treatment: "reverse_charge" }], { customer: customers.it })
	).uuid;
	await Database`UPDATE invoices SET buyer_vat_number = NULL WHERE uuid = ${ids.noVat}`;

	const canceled = await issue([{ description: "Withdrawn", quantity: 1, unit_price: 99999, tax_rate: 22, tax_treatment: "domestic" }]);
	await call("POST", `${base()}/invoices/${canceled.uuid}/cancel`, { token: ownerToken });

	await call("POST", `${base()}/invoices`, {
		token: ownerToken,
		body: { due_date: Date.now() + 86400000, items: [{ description: "Draft", quantity: 1, unit_price: 88888, tax_rate: 22 }] },
	});
});

afterAll(async () => {
	setRateProvider(null);
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.vat-report.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("issuing an invoice", () => {
	test("records when it was issued and who it was for at that moment", async () => {
		const invoice = (await call("GET", `${base()}/invoices/${ids.reverse}`, { token: ownerToken })).data;

		expect(invoice.issued_at).toBeGreaterThan(0);
		expect(invoice.buyer_country).toBe("DE");
		expect(invoice.buyer_vat_number).toBe("DE123456789");
		expect(invoice.tax_currency).toBe("EUR");
		expect(invoice.tax_exchange_rate).toBe(1);
		expect(invoice.tax_rate_source).toBe("same");
	});

	test("records the ECB reference rate of the supply date for an invoice in another currency", async () => {
		const invoice = (await call("GET", `${base()}/invoices/${ids.usd}`, { token: ownerToken })).data;

		expect(invoice.tax_exchange_rate).toBeCloseTo(0.9, 12);
		expect(invoice.tax_rate_source).toBe("ECB");
		expect(invoice.tax_rate_date).toBe(startOfLocalDate(localDate(invoice.supply_date, DEFAULT_TIMEZONE), DEFAULT_TIMEZONE));
	});

	test("keeps an invoice issued before a rate was required without one", async () => {
		const invoice = (await call("GET", `${base()}/invoices/${ids.gbp}`, { token: ownerToken })).data;

		expect(invoice.tax_currency).toBe("EUR");
		expect(invoice.tax_exchange_rate).toBeNull();
		expect(invoice.tax_rate_source).toBeNull();
	});

	test("leaves a draft without an issue date", async () => {
		const draft = await call("POST", `${base()}/invoices`, {
			token: ownerToken,
			body: { due_date: Date.now() + 86400000, items: [{ description: "Draft", quantity: 1, unit_price: 1 }] },
		});

		expect(draft.data.issued_at).toBeNull();
		expect(draft.data.tax_exchange_rate).toBeNull();
	});

	test("is recorded the same way for an invoice created already open", async () => {
		const invoice = await createInvoice(projectUuid, {
			customer: customers.de,
			currency: "USD",
			due_date: Date.now() + 86400000,
			supply_date: Date.now(),
			status: "open",
			items: [{ description: "API sale", quantity: 1, unit_price: 100, tax_rate: 0, tax_treatment: "reverse_charge" }],
		});

		expect(invoice.issued_at).toBe(invoice.created);
		expect(invoice.tax_exchange_rate).toBeCloseTo(0.9, 12);
		expect(invoice.buyer_vat_number).toBe("DE123456789");

		await call("POST", `${base()}/invoices/${invoice.uuid}/cancel`, { token: ownerToken });
	});

	test("prints VAT in the reporting currency when the invoice is in another one", async () => {
		const usd = await call("GET", `${base()}/invoices/${ids.usd}/document`, { token: ownerToken });
		expect(usd.data.tax.reporting).toMatchObject({ currency: "EUR", tax_amount: 1980 });
		expect(usd.data.tax.reporting.rate).toBeCloseTo(0.9, 12);

		const eur = await call("GET", `${base()}/invoices/${ids.domestic}/document`, { token: ownerToken });
		expect(eur.data.tax.reporting).toBeNull();
		expect(eur.data.invoice.issued).toBe((await call("GET", `${base()}/invoices/${ids.domestic}`, { token: ownerToken })).data.issued_at);
	});

	test("stores the discount share of each line and taxes what is left", async () => {
		const invoice = (await call("GET", `${base()}/invoices/${ids.domestic}`, { token: ownerToken })).data;

		expect(invoice.items.map((item: any) => item.discount_amount)).toEqual([1000, 1000]);
		expect(invoice.items.map((item: any) => item.tax_amount)).toEqual([1980, 855]);
		expect(invoice.total_amount).toBe(20000 - 2000 + 1980 + 855);

		const document = await call("GET", `${base()}/invoices/${ids.domestic}/document`, { token: ownerToken });
		expect(document.data.items.map((item: any) => item.discount_amount)).toEqual([1000, 1000]);
	});
});

describe("the VAT report", () => {
	test("sorts domestic sales by rate, after discounts, and counts lines without a treatment as domestic", async () => {
		const data = await report();

		expect(data.currency).toBe("EUR");
		expect(data.domestic).toEqual([
			{ rate: 22, net: 9000 + 1000 + 9000, vat: 1980 + 220 + 1980 },
			{ rate: 9.5, net: 9000, vat: 855 },
		]);
		expect(data.totals.domestic_vat).toBe(1980 + 220 + 1980 + 855);
	});

	test("groups One-Stop Shop sales by customer country", async () => {
		const data = await report();

		expect(data.oss).toEqual([{ country: "FR", rate: 20, net: 1000, vat: 200 }]);
		expect(data.totals.oss_vat).toBe(200);
	});

	test("lists sales without VAT by treatment", async () => {
		const data = await report();

		expect(data.zero_rated).toEqual([
			{ treatment: "export", net: 7000 },
			{ treatment: "intra_eu_goods", net: 20000 },
			{ treatment: "reverse_charge", net: 50000 + 3000 + 100 },
		]);
	});

	test("builds the EU sales listing from the VAT number at the time of issue", async () => {
		await call("PATCH", `${base()}/customers/${customers.de}`, { token: ownerToken, body: { vat_number: "DE999999999" } });
		const data = await report();

		expect(data.ec_sales_list).toEqual([{ vat_number: "DE123456789", country: "DE", goods: 20000, services: 53000 }]);
		expect(data.missing_details).toEqual([{ invoice: ids.noVat, reference: expect.any(String), reason: "EU sale without an EU VAT number for the customer" }]);
	});

	test("offsets cancelled invoices with their credit notes, leaves out drafts and invoices without a rate, and lists the last", async () => {
		const data = await report();

		expect(data.invoices).toBe(10);
		expect(data.credit_notes).toBe(2);
		expect(data.missing_rates).toEqual([{ invoice: ids.gbp, reference: expect.any(String), currency: "GBP", issued_at: expect.any(Number) }]);
		expect(data.totals.net).toBe(9000 + 1000 + 9000 + 9000 + 1000 + 7000 + 20000 + 53100);
	});

	test("takes an invoice in once a rate is set by hand", async () => {
		const set = await call("PUT", `${base()}/invoices/${ids.gbp}/tax-rate`, { token: ownerToken, body: { rate: 1.2 } });
		expect(set.error).toBe(0);
		expect(set.data.tax_rate_source).toBe("manual");
		expect(set.data.tax_rate_date).toBe(set.data.supply_date);

		const data = await report();
		expect(data.missing_rates).toEqual([]);
		expect(data.domestic[0]).toEqual({ rate: 22, net: 9000 + 1000 + 9000 + 12000, vat: 1980 + 220 + 1980 + 2640 });
	});

	test("only counts invoices issued in the period", async () => {
		const future = Date.now() + 60_000;
		const later = await report(`?from=${future}`);
		expect(later.invoices).toBe(0);
		expect(later.domestic).toEqual([]);

		const all = await report(`?from=0&to=${future}`);
		expect(all.invoices).toBe(11);
	});

	test("refuses a period that makes no sense", async () => {
		expect((await call("POST", `${base()}/reports/vat?from=5&to=1`, { token: ownerToken })).error).toBe(1073);
		expect((await call("POST", `${base()}/reports/vat?to=soon`, { token: ownerToken })).error).toBe(1073);
	});

	test("is open to anyone who can see reports", async () => {
		expect((await call("POST", `${base()}/reports/vat`, { token: viewerToken })).error).toBe(0);
	});
});

describe("setting an exchange rate by hand", () => {
	test("is refused for a draft, an invoice in the reporting currency, or a bad rate", async () => {
		const draft = await call("POST", `${base()}/invoices`, {
			token: ownerToken,
			body: { currency: "USD", due_date: Date.now() + 86400000, items: [{ description: "Draft", quantity: 1, unit_price: 1 }] },
		});

		expect((await call("PUT", `${base()}/invoices/${draft.data.uuid}/tax-rate`, { token: ownerToken, body: { rate: 1 } })).error).toBe(1044);
		expect((await call("PUT", `${base()}/invoices/${ids.domestic}/tax-rate`, { token: ownerToken, body: { rate: 1 } })).error).toBe(1072);

		for (const body of [{ rate: 0 }, { rate: -1 }, { rate: "1.2" }, {}, { rate: 1.1, date: "today" }]) {
			expect((await call("PUT", `${base()}/invoices/${ids.usd}/tax-rate`, { token: ownerToken, body })).error).toBe(1072);
		}
	});

	test("needs permission to edit invoices", async () => {
		expect((await call("PUT", `${base()}/invoices/${ids.usd}/tax-rate`, { token: viewerToken, body: { rate: 1 } })).error).toBe(9999);
	});

	test("keeps the date given and can be corrected while the invoice carries no VAT", async () => {
		const unrated = await call("POST", `${base()}/invoices`, {
			token: ownerToken,
			body: {
				customer: customers.us,
				currency: "GBP",
				status: "open",
				due_date: Date.now() + 86400000,
				supply_date: Date.now(),
				items: [{ description: "Parcel", quantity: 1, unit_price: 7000, tax_rate: 0, tax_treatment: "export" }],
			},
		});
		const res = await call("PUT", `${base()}/invoices/${unrated.data.uuid}/tax-rate`, { token: ownerToken, body: { rate: 0.91, date: 1767225600000 } });
		expect(res.data.tax_exchange_rate).toBe(0.91);
		expect(res.data.tax_rate_date).toBe(1767225600000);

		const corrected = await call("PUT", `${base()}/invoices/${unrated.data.uuid}/tax-rate`, { token: ownerToken, body: { rate: 0.92 } });
		expect(corrected.data.tax_exchange_rate).toBe(0.92);
		await call("POST", `${base()}/invoices/${unrated.data.uuid}/cancel`, { token: ownerToken });
	});

	test("is refused once the rate is printed next to the VAT on the issued invoice", async () => {
		const before = (await call("GET", `${base()}/invoices/${ids.usd}`, { token: ownerToken })).data;
		const refused = await call("PUT", `${base()}/invoices/${ids.usd}/tax-rate`, { token: ownerToken, body: { rate: 0.91 } });
		expect(refused.error).toBe(ErrorCode.TAX_EXCHANGE_RATE_LOCKED);
		expect((await call("PUT", `${base()}/invoices/${ids.gbp}/tax-rate`, { token: ownerToken, body: { rate: 1.3 } })).error).toBe(
			ErrorCode.TAX_EXCHANGE_RATE_LOCKED
		);

		const after = (await call("GET", `${base()}/invoices/${ids.usd}`, { token: ownerToken })).data;
		expect(after.tax_exchange_rate).toBe(before.tax_exchange_rate);
		expect(after.tax_rate_source).toBe("ECB");
	});
});

describe("the rate an invoice is issued with", () => {
	test("refuses to issue an invoice with VAT in a currency that has no rate", async () => {
		const body = {
			currency: "GBP",
			due_date: Date.now() + 86400000,
			supply_date: Date.now(),
			items: [{ description: "Hour", quantity: 1, unit_price: 10000, tax_rate: 22, tax_treatment: "domestic" }],
		};
		const atOnce = await call("POST", `${base()}/invoices`, { token: ownerToken, body: { ...body, status: "open" } });
		expect(atOnce.error).toBe(ErrorCode.INVOICE_DATA_INCOMPLETE);
		expect(atOnce.data.issues.map((issue: any) => issue.code)).toEqual(["tax_exchange_rate"]);

		const draft = await call("POST", `${base()}/invoices`, { token: ownerToken, body });
		const opened = await call("POST", `${base()}/invoices/${draft.data.uuid}/open`, { token: ownerToken });
		expect(opened.error).toBe(ErrorCode.INVOICE_DATA_INCOMPLETE);
		expect((await call("GET", `${base()}/invoices/${draft.data.uuid}`, { token: ownerToken })).data.status).toBe("draft");

		const rated = await call("PATCH", `${base()}/invoices/${draft.data.uuid}`, { token: ownerToken, body: { tax_exchange_rate: 1.15 } });
		expect(rated.data.tax_exchange_rate).toBe(1.15);
		const issued = await call("POST", `${base()}/invoices/${draft.data.uuid}/open`, { token: ownerToken });
		expect(issued.error).toBe(0);
		expect(issued.data).toMatchObject({ tax_exchange_rate: 1.15, tax_rate_source: "manual", tax_rate_date: issued.data.supply_date });
		await call("POST", `${base()}/invoices/${draft.data.uuid}/cancel`, { token: ownerToken });
	});

	test("prefers a rate entered by hand over the ECB rate and drops it when the currency changes", async () => {
		const draft = await call("POST", `${base()}/invoices`, {
			token: ownerToken,
			body: {
				currency: "USD",
				tax_exchange_rate: 0.85,
				due_date: Date.now() + 86400000,
				supply_date: Date.now(),
				items: [{ description: "Hour", quantity: 1, unit_price: 10000, tax_rate: 22, tax_treatment: "domestic" }],
			},
		});
		expect(draft.data).toMatchObject({ tax_exchange_rate: 0.85, tax_rate_source: "manual", issued_at: null });

		const changed = await call("PATCH", `${base()}/invoices/${draft.data.uuid}`, { token: ownerToken, body: { currency: "GBP" } });
		expect(changed.data).toMatchObject({ tax_exchange_rate: null, tax_rate_source: null });

		await call("PATCH", `${base()}/invoices/${draft.data.uuid}`, { token: ownerToken, body: { currency: "USD", tax_exchange_rate: 0.85 } });
		const issued = await call("POST", `${base()}/invoices/${draft.data.uuid}/open`, { token: ownerToken });
		expect(issued.data).toMatchObject({ tax_exchange_rate: 0.85, tax_rate_source: "manual" });
		await call("POST", `${base()}/invoices/${draft.data.uuid}/cancel`, { token: ownerToken });

		for (const rate of [0, -1, "0.9"]) {
			const refused = await call("POST", `${base()}/invoices`, {
				token: ownerToken,
				body: { currency: "USD", tax_exchange_rate: rate, due_date: Date.now() + 86400000, items: [{ description: "Hour", quantity: 1, unit_price: 1 }] },
			});
			expect(refused.error).toBe(ErrorCode.INVALID_TAX_EXCHANGE_RATE);
		}
	});

	test("issues an invoice without VAT even when no rate is available", async () => {
		const invoice = await call("POST", `${base()}/invoices`, {
			token: ownerToken,
			body: {
				customer: customers.us,
				currency: "GBP",
				status: "open",
				due_date: Date.now() + 86400000,
				supply_date: Date.now(),
				items: [{ description: "Parcel", quantity: 1, unit_price: 7000, tax_rate: 0, tax_treatment: "export" }],
			},
		});
		expect(invoice.error).toBe(0);
		expect(invoice.data).toMatchObject({ status: "open", tax_currency: "EUR", tax_exchange_rate: null, tax_rate_source: null });
		await call("POST", `${base()}/invoices/${invoice.data.uuid}/cancel`, { token: ownerToken });
	});
});

describe("VAT report helpers", () => {
	test("convert between currencies with different minor units", () => {
		expect(convertMinor(10000, "USD", 0.9, "EUR")).toBe(9000);
		expect(convertMinor(1000, "EUR", 160.5, "JPY")).toBe(1605);
		expect(convertMinor(1605, "JPY", 0.00623, "EUR")).toBe(1000);
	});

	test("turn a period choice into calendar boundaries", () => {
		const now = new Date(2026, 4, 17, 12, 0, 0);

		expect(vatPeriod("this-month", now)).toEqual({ from: new Date(2026, 4, 1).getTime(), to: new Date(2026, 5, 1).getTime() - 1 });
		expect(vatPeriod("last-month", new Date(2026, 0, 10))).toEqual({ from: new Date(2025, 11, 1).getTime(), to: new Date(2026, 0, 1).getTime() - 1 });
		expect(vatPeriod("this-quarter", now)).toEqual({ from: new Date(2026, 3, 1).getTime(), to: new Date(2026, 6, 1).getTime() - 1 });
		expect(vatPeriod("last-quarter", new Date(2026, 1, 3))).toEqual({ from: new Date(2025, 9, 1).getTime(), to: new Date(2026, 0, 1).getTime() - 1 });
		expect(vatPeriod("last-year", now)).toEqual({ from: new Date(2025, 0, 1).getTime(), to: new Date(2026, 0, 1).getTime() - 1 });
		expect(vatPeriod("all", now)).toEqual({});
	});

	test("export the report as CSV in major units", () => {
		const csv = vatReportCsv({
			currency: "EUR",
			domestic: [{ rate: 22, net: 123456, vat: 27160 }],
			oss: [{ country: "FR", rate: 20, net: 1000, vat: 200 }],
			zero_rated: [{ treatment: "reverse_charge", net: 5000 }],
			ec_sales_list: [{ vat_number: "DE123456789", country: "DE", goods: 0, services: 5000 }],
		});

		expect(csv.split("\n")).toEqual([
			"section,key,rate,net,vat",
			"domestic,,22,1234.56,271.60",
			"oss,FR,20,10.00,2.00",
			"zero_rated,reverse_charge,0,50.00,0.00",
			"ec_sales_list_services,DE123456789,0,50.00,0.00",
			"",
		]);
	});
});
