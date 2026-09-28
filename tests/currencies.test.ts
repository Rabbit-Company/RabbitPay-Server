import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.currencies.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { convert, setRateProvider } = await import("../server/rates/forex");

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

const USD_RATES = { USD: 1, EUR: 0.86618, GBP: 0.74162, JPY: 155.31, CHF: 0.79 };

function stubRates(rates: Record<string, number> | null) {
	setRateProvider({ unitsPerAsset: async () => null, fiatRates: async () => rates });
}

let ownerToken = "";
let projectUuid = "";

const dueDate = () => Date.now() + 7 * 24 * 60 * 60 * 1000;

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	await call("POST", "/api/v1/auth/register", { body: { username: "cur-owner", email: "cur-owner@example.com", password: password("cur-owner") } });
	const login = await call("POST", "/api/v1/auth/login", { body: { username: "cur-owner", password: password("cur-owner") } });
	ownerToken = login.data.token;

	const project = await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "cur-project" } });
	projectUuid = project.data.uuid;
});

afterAll(async () => {
	setRateProvider(null);
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.currencies.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("a project's primary currency", () => {
	test("starts as euro when none is chosen", async () => {
		const res = await call("GET", `/api/v1/projects/${projectUuid}`, { token: ownerToken });
		expect(res.data.currency).toBe("EUR");
	});

	test("can be set when the project is created", async () => {
		const created = await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "yen-shop", currency: "JPY" } });

		expect(created.data.currency).toBe("JPY");
		expect((await call("GET", `/api/v1/projects/${created.data.uuid}`, { token: ownerToken })).data.currency).toBe("JPY");
	});

	test("can be changed later", async () => {
		const res = await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { currency: "GBP" } });
		expect(res.data.currency).toBe("GBP");

		await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { currency: "EUR" } });
	});

	test("refuses something that is not a currency code", async () => {
		expect((await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { currency: "euro" } })).error).toBe(1037);
		expect((await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "bad-money", currency: "E" } })).error).toBe(1037);
	});

	test("leaves the name alone when only the currency changes", async () => {
		await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { currency: "CHF" } });
		const res = await call("GET", `/api/v1/projects/${projectUuid}`, { token: ownerToken });

		expect(res.data.name).toBe("cur-project");
		expect(res.data.currency).toBe("CHF");

		await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { currency: "EUR" } });
	});
});

describe("new invoices", () => {
	const item = { description: "Work", quantity: 1, unit_price: 10000, tax_rate: 0 };

	test("inherit the project currency when none is given", async () => {
		await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { currency: "SEK" } });

		const res = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { due_date: dueDate(), items: [item] },
		});

		expect(res.error).toBe(0);
		expect(res.data.currency).toBe("SEK");

		await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { currency: "EUR" } });
	});

	test("still take a currency of their own", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { currency: "USD", due_date: dueDate(), items: [item] },
		});

		expect(res.data.currency).toBe("USD");
	});

	test("reject a currency that is not a code", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { currency: "dollars", due_date: dueDate(), items: [item] },
		});

		expect(res.error).toBe(1037);
	});
});

describe("the currency list", () => {
	test("comes back with rates when the feed answers", async () => {
		stubRates(USD_RATES);
		const res = await call("GET", "/api/v1/currencies", { token: ownerToken });

		expect(res.data.live).toBe(true);
		expect(res.data.base).toBe("USD");
		expect(res.data.currencies).toContain("EUR");
		expect(res.data.rates.EUR).toBeCloseTo(0.86618, 5);
	});

	test("is sorted so a picker reads sensibly", async () => {
		stubRates(USD_RATES);
		const res = await call("GET", "/api/v1/currencies", { token: ownerToken });

		expect(res.data.currencies).toEqual([...res.data.currencies].sort());
	});

	test("drops a quote that could not be used", async () => {
		stubRates({ ...USD_RATES, BROKEN: 0, ALSOBAD: -1 });
		const res = await call("GET", "/api/v1/currencies", { token: ownerToken });

		expect(res.data.currencies).not.toContain("BROKEN");
		expect(res.data.currencies).not.toContain("ALSOBAD");
	});

	test("still offers a list when the feed is down, marked as not live", async () => {
		stubRates(null);
		const res = await call("GET", "/api/v1/currencies", { token: ownerToken });

		expect(res.data.live).toBe(false);
		expect(res.data.currencies.length).toBeGreaterThan(10);
		expect(res.data.currencies).toContain("EUR");
		expect(res.data.rates).toEqual({});
	});

	test("is not readable without signing in", async () => {
		expect((await call("GET", "/api/v1/currencies")).error).not.toBe(0);
	});
});

describe("converting between two currencies", () => {
	test("crosses through the base", () => {
		expect(convert(100, "EUR", "USD", USD_RATES)).toBeCloseTo(115.45, 2);
		expect(convert(100, "USD", "EUR", USD_RATES)).toBeCloseTo(86.618, 3);
	});

	test("returns the same amount for the same currency", () => {
		expect(convert(42, "GBP", "GBP", USD_RATES)).toBeCloseTo(42, 10);
	});

	test("round trips back to where it started", () => {
		const there = convert(250, "JPY", "CHF", USD_RATES)!;
		expect(convert(there, "CHF", "JPY", USD_RATES)).toBeCloseTo(250, 8);
	});

	test("reports nothing for a currency it has no quote for", () => {
		expect(convert(10, "EUR", "XYZ", USD_RATES)).toBeNull();
		expect(convert(10, "XYZ", "EUR", USD_RATES)).toBeNull();
	});

	test("answers over the API", async () => {
		stubRates(USD_RATES);
		const res = await call("GET", "/api/v1/currencies/convert?from=EUR&to=USD&amount=100", { token: ownerToken });

		expect(res.error).toBe(0);
		expect(res.data.result).toBeCloseTo(115.45, 2);
		expect(res.data.rate).toBeCloseTo(1.1545, 4);
	});

	test("says so plainly when no rates are available", async () => {
		stubRates(null);
		expect((await call("GET", "/api/v1/currencies/convert?from=EUR&to=USD&amount=1", { token: ownerToken })).error).toBe(1059);
	});

	test("refuses a currency code that makes no sense", async () => {
		stubRates(USD_RATES);
		expect((await call("GET", "/api/v1/currencies/convert?from=nonsense&to=USD&amount=1", { token: ownerToken })).error).toBe(1037);
	});

	test("refuses a currency nobody quotes", async () => {
		stubRates(USD_RATES);
		expect((await call("GET", "/api/v1/currencies/convert?from=EUR&to=ZZZ&amount=1", { token: ownerToken })).error).toBe(1056);
	});
});
