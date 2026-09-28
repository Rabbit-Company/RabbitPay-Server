import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://:memory:`);

const { default: Cache } = await import("../server/cache");
const { RabbitForexProvider, rateFor, setRateProvider, symbolFor } = await import("../server/rates/forex");

const LIVE_API = "https://forex.rabbitmonitor.com";

const liveApiReachable = await fetch(`${LIVE_API}/v1/crypto/rates/EUR`, { signal: AbortSignal.timeout(8000) })
	.then((response) => response.ok)
	.catch(() => false);

function withFetch(handler: (url: string) => Response, run: () => Promise<void>) {
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: any) => handler(String(input))) as unknown as typeof fetch;
	return run().finally(() => {
		globalThis.fetch = original;
	});
}

function ratesResponse(rates: Record<string, number>) {
	return new Response(JSON.stringify({ base: "EUR", rates, timestamps: { crypto: new Date().toISOString() } }));
}

beforeAll(async () => {
	await Cache.initialize();
});

afterAll(() => {
	setRateProvider(null);
});

describe("asset symbols", () => {
	test("maps each supported chain to its ticker", () => {
		expect(symbolFor("bitcoin")).toBe("BTC");
		expect(symbolFor("ethereum")).toBe("ETH");
		expect(symbolFor("monero")).toBe("XMR");
	});

	test("has no symbol for a processor that is not a coin", () => {
		expect(symbolFor("stripe")).toBeNull();
		expect(symbolFor("paypal")).toBeNull();
	});
});

describe("reading a rate", () => {
	test("inverts the quote into units of the currency per coin", async () => {
		await withFetch(
			() => ratesResponse({ BTC: 0.000015245, ETH: 0.00048049 }),
			async () => {
				const provider = new RabbitForexProvider({ cacheSeconds: 0 });
				const rate = await provider.unitsPerAsset("EUR", "BTC");

				expect(rate).toBeCloseTo(65595.28, 1);
			}
		);
	});

	test("asks for the invoice currency as the base", async () => {
		let requested = "";

		await withFetch(
			(url) => {
				requested = url;
				return ratesResponse({ BTC: 0.00002 });
			},
			async () => {
				await new RabbitForexProvider({ cacheSeconds: 0 }).unitsPerAsset("gbp", "BTC");
			}
		);

		expect(requested).toContain("/v1/crypto/rates/GBP");
	});

	test("reports nothing rather than guessing when the symbol is missing", async () => {
		await withFetch(
			() => ratesResponse({ ETH: 0.0004 }),
			async () => {
				expect(await new RabbitForexProvider({ cacheSeconds: 0 }).unitsPerAsset("EUR", "BTC")).toBeNull();
			}
		);
	});

	test("reports nothing when the quote is zero or nonsense", async () => {
		await withFetch(
			() => ratesResponse({ BTC: 0 }),
			async () => {
				expect(await new RabbitForexProvider({ cacheSeconds: 0 }).unitsPerAsset("EUR", "BTC")).toBeNull();
			}
		);
	});

	test("reports nothing when the API is unreachable", async () => {
		await withFetch(
			() => {
				throw new Error("network down");
			},
			async () => {
				expect(await new RabbitForexProvider({ cacheSeconds: 0 }).unitsPerAsset("EUR", "BTC")).toBeNull();
			}
		);
	});

	test("reports nothing on an error response", async () => {
		await withFetch(
			() => new Response("nope", { status: 503 }),
			async () => {
				expect(await new RabbitForexProvider({ cacheSeconds: 0 }).unitsPerAsset("EUR", "BTC")).toBeNull();
			}
		);
	});
});

describe("caching", () => {
	test("asks the API once per currency within the window", async () => {
		let calls = 0;

		await withFetch(
			() => {
				calls++;
				return ratesResponse({ BTC: 0.00002, ETH: 0.0005 });
			},
			async () => {
				const provider = new RabbitForexProvider({ cacheSeconds: 60 });

				await provider.unitsPerAsset("SEK", "BTC");
				await provider.unitsPerAsset("SEK", "ETH");
				await provider.unitsPerAsset("SEK", "BTC");

				expect(calls).toBe(1);
			}
		);
	});

	test("keeps a separate cache per currency", async () => {
		let calls = 0;

		await withFetch(
			() => {
				calls++;
				return ratesResponse({ BTC: 0.00002 });
			},
			async () => {
				const provider = new RabbitForexProvider({ cacheSeconds: 60 });

				await provider.unitsPerAsset("NOK", "BTC");
				await provider.unitsPerAsset("DKK", "BTC");

				expect(calls).toBe(2);
			}
		);
	});
});

describe("the rate used by payments", () => {
	test("comes from whichever provider is installed", async () => {
		setRateProvider({ unitsPerAsset: async () => 42000 });

		expect(await rateFor("EUR", "bitcoin")).toBe(42000);
		expect(await rateFor("EUR", "stripe")).toBeNull();

		setRateProvider(null);
	});
});

describe("against the live RabbitForex API", () => {
	const reachable = liveApiReachable;

	test.skipIf(!reachable)("returns a believable bitcoin price in euro", async () => {
		const provider = new RabbitForexProvider({ baseUrl: LIVE_API, cacheSeconds: 0, timeoutMs: 20000 });
		const rate = await provider.unitsPerAsset("EUR", "BTC");

		expect(rate).not.toBeNull();
		expect(rate!).toBeGreaterThan(1000);
		expect(rate!).toBeLessThan(10_000_000);
	});

	test.skipIf(!reachable)("prices the three coins the server supports", async () => {
		const provider = new RabbitForexProvider({ baseUrl: LIVE_API, cacheSeconds: 0, timeoutMs: 20000 });

		for (const symbol of ["BTC", "ETH", "XMR"]) {
			const rate = await provider.unitsPerAsset("EUR", symbol);
			expect(rate).not.toBeNull();
			expect(rate!).toBeGreaterThan(0);
		}
	});

	test.skipIf(!reachable)("orders the three coins the way the market does", async () => {
		const provider = new RabbitForexProvider({ baseUrl: LIVE_API, cacheSeconds: 0, timeoutMs: 20000 });

		const bitcoin = await provider.unitsPerAsset("EUR", "BTC");
		const ethereum = await provider.unitsPerAsset("EUR", "ETH");
		const monero = await provider.unitsPerAsset("EUR", "XMR");

		expect(bitcoin!).toBeGreaterThan(ethereum!);
		expect(ethereum!).toBeGreaterThan(monero!);
	});
});
