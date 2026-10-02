import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://:memory:`);

const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { ECB_TIMEZONE, ecbRatesAge, ecbReferenceRate, forgetEcbAttempts, parseEcbRates, refreshEcbRates, storeEcbRates, storedEcbRate } =
	await import("../server/rates/ecb");
const { taxPointDate, taxRateFor } = await import("../server/tax-reporting");
const { localDate, shiftLocalDate, startOfLocalDate } = await import("../server/timezone");

const TODAY = localDate(Date.now(), ECB_TIMEZONE);

function ecbFile(days: Record<string, Record<string, number>>): string {
	const cubes = Object.entries(days)
		.map(
			([day, rates]) =>
				`<Cube time="${day}">${Object.entries(rates)
					.map(([currency, rate]) => `<Cube currency="${currency}" rate="${rate}"/>`)
					.join("")}</Cube>`
		)
		.join("");
	return `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
	<gesmes:subject>Reference rates</gesmes:subject>
	<gesmes:Sender><gesmes:name>European Central Bank</gesmes:name></gesmes:Sender>
	<Cube>${cubes}</Cube>
</gesmes:Envelope>`;
}

async function withFetch(handler: (url: string) => Response, run: () => Promise<void>) {
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: any) => handler(String(input))) as unknown as typeof fetch;
	try {
		await run();
	} finally {
		globalThis.fetch = original;
	}
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();
});

beforeEach(async () => {
	await Database`DELETE FROM ecb_rates`;
	forgetEcbAttempts();
});

afterAll(async () => {
	await Database.close();
});

describe("reading the ECB file", () => {
	test("returns every dated quote and skips what it cannot read", () => {
		const rates = parseEcbRates(
			ecbFile({
				"2026-09-30": { USD: 1.0876, JPY: 161.43 },
				"2026-09-29": { USD: 1.0851, GBP: 0 },
				"not a date": { USD: 1.1 },
			})
		);

		expect(rates).toEqual([
			{ day: "2026-09-30", currency: "USD", rate: 1.0876 },
			{ day: "2026-09-30", currency: "JPY", rate: 161.43 },
			{ day: "2026-09-29", currency: "USD", rate: 1.0851 },
		]);
	});

	test("stores a day once and never rewrites a published rate", async () => {
		expect(await storeEcbRates([{ day: "2026-09-30", currency: "USD", rate: 1.0876 }])).toBe(1);
		expect(await storeEcbRates([{ day: "2026-09-30", currency: "USD", rate: 9.9 }])).toBe(0);
		expect((await storedEcbRate("USD", "2026-09-30"))?.rate).toBe(1.0876);
		expect(await ecbRatesAge()).toBeLessThan(5000);
	});
});

describe("looking up the rate for a day", () => {
	test("uses the latest rate published on or before the day, within a week", async () => {
		await storeEcbRates([
			{ day: "2026-09-24", currency: "USD", rate: 1.07 },
			{ day: "2026-09-25", currency: "USD", rate: 1.08 },
		]);

		expect(await storedEcbRate("USD", "2026-09-25")).toEqual({ day: "2026-09-25", currency: "USD", rate: 1.08 });
		expect(await storedEcbRate("USD", "2026-09-27")).toEqual({ day: "2026-09-25", currency: "USD", rate: 1.08 });
		expect(await storedEcbRate("USD", "2026-09-24")).toEqual({ day: "2026-09-24", currency: "USD", rate: 1.07 });
		expect(await storedEcbRate("USD", "2026-10-02")).toBeNull();
		expect(await storedEcbRate("USD", "2026-09-23")).toBeNull();
		expect(await storedEcbRate("RSD", "2026-09-25")).toBeNull();
	});

	test("downloads the recent file when the day is newer than what is stored", async () => {
		const yesterday = shiftLocalDate(TODAY, -1);
		await storeEcbRates([{ day: shiftLocalDate(TODAY, -2), currency: "USD", rate: 1.05 }]);
		const requested: string[] = [];

		await withFetch(
			(url) => {
				requested.push(url);
				return new Response(ecbFile({ [yesterday]: { USD: 1.09 } }));
			},
			async () => {
				expect(await ecbReferenceRate("usd", yesterday)).toEqual({ day: yesterday, currency: "USD", rate: 1.09 });
				expect(await ecbReferenceRate("USD", yesterday)).toEqual({ day: yesterday, currency: "USD", rate: 1.09 });
			}
		);

		expect(requested).toHaveLength(1);
		expect(requested[0]).toEndWith("/eurofxref-hist-90d.xml");
	});

	test("falls back to the stored rate and does not ask again straight away when the ECB is unreachable", async () => {
		const yesterday = shiftLocalDate(TODAY, -1);
		await storeEcbRates([{ day: yesterday, currency: "USD", rate: 1.05 }]);
		let requests = 0;

		await withFetch(
			() => {
				requests++;
				return new Response("unavailable", { status: 503 });
			},
			async () => {
				expect(await ecbReferenceRate("USD", TODAY)).toEqual({ day: yesterday, currency: "USD", rate: 1.05 });
				expect(await ecbReferenceRate("USD", TODAY)).toEqual({ day: yesterday, currency: "USD", rate: 1.05 });
			}
		);

		expect(requests).toBe(1);
	});

	test("downloads the full history for an old day and keeps only the days around it", async () => {
		const requested: string[] = [];

		await withFetch(
			(url) => {
				requested.push(url);
				return new Response(ecbFile({ "2024-03-15": { USD: 1.0892 }, "2024-03-14": { USD: 1.0925 }, "2023-01-02": { USD: 1.0683 } }));
			},
			async () => {
				expect(await ecbReferenceRate("USD", "2024-03-16")).toEqual({ day: "2024-03-15", currency: "USD", rate: 1.0892 });
				expect(await ecbReferenceRate("USD", "2024-03-17")).toEqual({ day: "2024-03-15", currency: "USD", rate: 1.0892 });
			}
		);

		expect(requested).toHaveLength(1);
		expect(requested[0]).toEndWith("/eurofxref-hist.xml");
		const [stored] = (await Database`SELECT COUNT(*) AS count FROM ecb_rates`) as { count: number }[];
		expect(Number(stored.count)).toBe(2);
	});

	test("refreshes from the recent file on request", async () => {
		await withFetch(
			() => new Response(ecbFile({ "2026-09-30": { USD: 1.0876, CHF: 0.94 } })),
			async () => {
				expect(await refreshEcbRates()).toBe(2);
				expect(await refreshEcbRates()).toBe(0);
			}
		);
		await withFetch(
			() => new Response("<Envelope/>"),
			async () => {
				expect(refreshEcbRates()).rejects.toThrow("holds no reference rates");
			}
		);
	});
});

describe("the rate an invoice is taxed at", () => {
	const project = { currency: "EUR", tax_currency: "EUR", timezone: "Europe/Ljubljana" };
	const supplied = startOfLocalDate("2026-09-27", "Europe/Ljubljana");
	const issued = startOfLocalDate("2026-10-02", "Europe/Ljubljana");

	test("is the ECB rate of the supply date, not of the issue date", async () => {
		await storeEcbRates([
			{ day: "2026-09-25", currency: "USD", rate: 1.25 },
			{ day: "2026-10-02", currency: "USD", rate: 2 },
		]);

		expect(await taxRateFor(project, { currency: "USD", supply_date: supplied }, issued)).toEqual({
			rate: 0.8,
			source: "ECB",
			date: startOfLocalDate("2026-09-25", "Europe/Ljubljana"),
		});
		expect(await taxRateFor(project, { currency: "USD", supply_date: null }, issued)).toMatchObject({ rate: 0.5, source: "ECB" });
	});

	test("is one for an invoice in the reporting currency and the entered rate when there is one", async () => {
		await storeEcbRates([{ day: "2026-09-25", currency: "USD", rate: 1.25 }]);

		expect(await taxRateFor(project, { currency: "EUR", supply_date: supplied }, issued)).toEqual({ rate: 1, source: "same", date: issued });
		expect(await taxRateFor(project, { currency: "USD", supply_date: supplied, tax_exchange_rate: 0.77, tax_rate_source: "manual" }, issued)).toEqual({
			rate: 0.77,
			source: "manual",
			date: supplied,
		});
	});

	test("is missing for a currency the ECB does not quote", async () => {
		await storeEcbRates([{ day: "2026-09-25", currency: "USD", rate: 1.25 }]);

		expect(await taxRateFor(project, { currency: "RSD", supply_date: supplied }, issued)).toBeNull();
	});
});

describe("the day VAT becomes due on an invoice", () => {
	const zone = "Europe/Ljubljana";
	const day = (value: string) => startOfLocalDate(value, zone);
	const taxed = [{ tax_rate: 22, tax_treatment: "domestic" }];
	const goods = [{ tax_rate: 0, tax_treatment: "intra_eu_goods" }];

	test("is the supply date, or the issue date when no supply date was entered", () => {
		expect(taxPointDate(zone, day("2026-09-28"), day("2026-10-05"), taxed)).toBe(day("2026-09-28"));
		expect(taxPointDate(zone, day("2026-10-20"), day("2026-10-05"), taxed)).toBe(day("2026-10-20"));
		expect(taxPointDate(zone, null, day("2026-10-05"), taxed)).toBe(day("2026-10-05"));
		expect(taxPointDate(zone, day("2026-09-28"), day("2026-10-05"), [{ tax_rate: 0, tax_treatment: "reverse_charge" }])).toBe(day("2026-09-28"));
	});

	test("is the issue date for goods supplied to another EU country, at the latest the 15th of the following month", () => {
		expect(taxPointDate(zone, day("2026-09-28"), day("2026-10-05"), goods)).toBe(day("2026-10-05"));
		expect(taxPointDate(zone, day("2026-09-28"), day("2026-09-20"), goods)).toBe(day("2026-09-20"));
		expect(localDate(taxPointDate(zone, day("2026-09-28"), day("2026-11-03"), goods), zone)).toBe("2026-10-15");
		expect(localDate(taxPointDate(zone, day("2026-12-10"), day("2027-02-01"), goods), zone)).toBe("2027-01-15");
		expect(taxPointDate(zone, day("2026-09-28"), day("2026-10-05"), [...goods, ...taxed])).toBe(day("2026-09-28"));
	});
});
