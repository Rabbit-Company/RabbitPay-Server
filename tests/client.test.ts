import { describe, expect, test } from "bun:test";
import Blake2b from "@rabbit-company/blake2b";
import { calculateTotals, type InvoiceItemInput } from "../server/invoicing";
import { coinAmount } from "../server/units";
import { filterOptions } from "../server/option-search";
import { includedTaxAtRate } from "../server/expense-types";
import { COUNTRY_CODES, isCountryCode } from "../server/countries";
import { toUtcDateInput } from "../server/formats";
import { canSubmitSlovenianDdvEvidence } from "../server/tax";

describe("UTC accounting dates", () => {
	test("keeps a period end on its UTC calendar day", () => {
		expect(toUtcDateInput(Date.UTC(2026, 8, 30, 23, 59, 59, 999))).toBe("2026-09-30");
	});
});

describe("official DDV evidence availability", () => {
	test("is offered only to Slovenian VAT registered businesses", () => {
		expect(canSubmitSlovenianDdvEvidence("SI", "registered")).toBe(true);
		expect(canSubmitSlovenianDdvEvidence("SI", "small_business")).toBe(false);
		expect(canSubmitSlovenianDdvEvidence("SI", "not_registered")).toBe(false);
		expect(canSubmitSlovenianDdvEvidence("AT", "registered")).toBe(false);
	});
});

describe("browser password hashing", () => {
	test("matches what the server expects", () => {
		for (const password of ["hunter2", "correct-horse-battery-staple", "", "unicode ✓ password", "a".repeat(500)]) {
			const server = new Bun.CryptoHasher("blake2b512").update(password).digest("hex");
			expect(Blake2b.hash(password)).toBe(server);
		}
	});

	test("produces the 128 character digest the API validates", () => {
		const digest = Blake2b.hash("hunter2");
		expect(digest).toHaveLength(128);
		expect(/^[a-z0-9]{128}$/.test(digest)).toBe(true);
	});
});

describe("invoice totals used by both sides", () => {
	const cases: { items: InvoiceItemInput[]; discount: number }[] = [
		{ items: [{ description: "a", quantity: 1, unit_price: 1000, tax_rate: 20 }], discount: 0 },
		{ items: [{ description: "a", quantity: 3, unit_price: 10000, tax_rate: 22 }], discount: 500 },
		{ items: [{ description: "a", quantity: 1.5, unit_price: 3333, tax_rate: 0 }], discount: 0 },
		{ items: [{ description: "a", quantity: 0.333, unit_price: 999, tax_rate: 7.5 }], discount: 1 },
		{
			items: [
				{ description: "a", quantity: 2, unit_price: 1999, tax_rate: 21 },
				{ description: "b", quantity: 7, unit_price: 250, tax_rate: 9.5 },
				{ description: "c", quantity: 1, unit_price: 0, tax_rate: 20 },
			],
			discount: 1234,
		},
		{ items: [{ description: "a", quantity: 1, unit_price: 100, tax_rate: 0 }], discount: 99999 },
	];

	test("always produces whole minor units", () => {
		for (const { items, discount } of cases) {
			const totals = calculateTotals(items, discount);
			expect(Number.isSafeInteger(totals.subtotal)).toBe(true);
			expect(Number.isSafeInteger(totals.tax_amount)).toBe(true);
			expect(Number.isSafeInteger(totals.total_amount)).toBe(true);
		}
	});

	test("never produces a negative total", () => {
		for (let run = 0; run < 250; run++) {
			const items: InvoiceItemInput[] = Array.from({ length: 1 + Math.floor(Math.random() * 4) }, () => ({
				description: "item",
				quantity: Math.round(Math.random() * 1000) / 100,
				unit_price: Math.floor(Math.random() * 500000),
				tax_rate: Math.round(Math.random() * 2500) / 100,
			}));

			const totals = calculateTotals(items, Math.floor(Math.random() * 100000));
			expect(totals.total_amount).toBeGreaterThanOrEqual(0);
			expect(totals.discount_amount).toBeLessThanOrEqual(totals.subtotal);
			expect(totals.items.reduce((sum, item) => sum + item.discount_amount, 0)).toBe(totals.discount_amount);
			for (const item of totals.items) expect(item.discount_amount).toBeLessThanOrEqual(item.total_price);
		}
	});

	test("the interface imports this same module", async () => {
		const source = await Bun.file(`${import.meta.dir}/../web/src/views/invoices.ts`).text();
		expect(source).toContain('from "../../../server/invoicing"');
		expect(source).not.toContain("previewTotals");
	});
});

describe("expense VAT estimates", () => {
	test("extracts VAT from a tax-inclusive total", () => {
		expect(includedTaxAtRate(12200, 22)).toBe(2200);
		expect(includedTaxAtRate(11900, 19)).toBe(1900);
	});

	test("rounds to minor units and stays empty without a usable rate", () => {
		expect(includedTaxAtRate(13170, 22)).toBe(2375);
		expect(includedTaxAtRate(1000, 0)).toBe(0);
		expect(includedTaxAtRate(0, 22)).toBe(0);
	});
});

describe("coin amounts shown to a customer", () => {
	test("turns base units into the figure a wallet asks for", () => {
		expect(coinAmount(74716, "satoshi").amount).toBe("0.00074716");
		expect(coinAmount("10000000000000000", "wei").amount).toBe("0.01");
		expect(coinAmount("150000000000", "piconero").amount).toBe("0.15");
	});

	test("names the coin rather than its smallest unit", () => {
		expect(coinAmount(1, "satoshi").ticker).toBe("BTC");
		expect(coinAmount(1, "wei").ticker).toBe("ETH");
		expect(coinAmount(1, "piconero").ticker).toBe("XMR");
	});

	test("keeps every digit of a wei amount that a float would lose", () => {
		const wei = "1234567890123456789";
		expect(coinAmount(wei, "wei").amount).toBe("1.234567890123456789");
		expect(String(Number(wei) / 1e18)).not.toBe(coinAmount(wei, "wei").amount);
	});

	test("handles a whole coin and nothing owed", () => {
		expect(coinAmount("100000000", "satoshi").amount).toBe("1");
		expect(coinAmount(0, "satoshi").amount).toBe("0");
		expect(coinAmount("1000000000000000000", "wei").amount).toBe("1");
	});

	test("leaves an unknown unit alone rather than inventing a conversion", () => {
		const unknown = coinAmount(500, "gwei");
		expect(unknown.amount).toBe("500");
		expect(unknown.ticker).toBe("gwei");
	});
});

describe("searchable dropdown matching", () => {
	const options = [
		{ value: "EUR", label: "EUR (Euro)" },
		{ value: "USD", label: "USD (US Dollar)" },
		{ value: "c1", label: "Žiga Novak", hint: "ziga@example.com" },
		{ value: "i1", label: "Website hosting", hint: "HOST-M | €9.00", keywords: "HOST-M monthly plan" },
		{ value: "i2", label: "Premium support", keywords: "hosting add-on" },
	];

	test("keeps the original order when nothing is typed", () => {
		expect(filterOptions(options, "").map((option) => option.value)).toEqual(["EUR", "USD", "c1", "i1", "i2"]);
	});

	test("ignores case and accents", () => {
		expect(filterOptions(options, "ZIGA").map((option) => option.value)).toEqual(["c1"]);
		expect(filterOptions(options, "novák").map((option) => option.value)).toEqual(["c1"]);
	});

	test("matches the hint, keywords and value too", () => {
		expect(filterOptions(options, "example.com").map((option) => option.value)).toEqual(["c1"]);
		expect(filterOptions(options, "host-m").map((option) => option.value)).toEqual(["i1"]);
		expect(filterOptions(options, "usd").map((option) => option.value)).toEqual(["USD"]);
	});

	test("needs every typed word to match", () => {
		expect(filterOptions(options, "us dollar").map((option) => option.value)).toEqual(["USD"]);
		expect(filterOptions(options, "euro dollar")).toEqual([]);
	});

	test("puts labels that start with the query first", () => {
		expect(filterOptions(options, "hosting").map((option) => option.value)).toEqual(["i1", "i2"]);
		expect(filterOptions(options, "support hosting").map((option) => option.value)).toEqual(["i2"]);
		expect(filterOptions(options, "euro").map((option) => option.value)).toEqual(["EUR"]);
	});

	test("stops at the limit", () => {
		const many = Array.from({ length: 120 }, (_, index) => ({ value: String(index), label: `Item ${index}` }));
		expect(filterOptions(many, "item")).toHaveLength(50);
		expect(filterOptions(many, "item", 10)).toHaveLength(10);
	});
});

describe("the country list", () => {
	test("holds every ISO 3166-1 alpha-2 code once, in order", () => {
		expect(COUNTRY_CODES).toHaveLength(249);
		expect(new Set(COUNTRY_CODES).size).toBe(249);
		expect([...COUNTRY_CODES].sort()).toEqual([...COUNTRY_CODES]);
		expect(COUNTRY_CODES.every((code) => /^[A-Z]{2}$/.test(code))).toBe(true);
	});

	test("has a readable name for every code", () => {
		const names = new Intl.DisplayNames("en", { type: "region" });
		for (const code of COUNTRY_CODES) expect(names.of(code)).not.toBe(code);
	});

	test("accepts real countries only", () => {
		expect(isCountryCode("SI")).toBe(true);
		expect(isCountryCode("GB")).toBe(true);
		expect(isCountryCode("XK")).toBe(false);
		expect(isCountryCode("si")).toBe(false);
		expect(isCountryCode(null)).toBe(false);
	});
});

describe("UPN QR symbol", () => {
	test("uses version 15 at error correction level M as the ZBS standard requires", async () => {
		const { QRCode, ErrorCorrectionLevel } = await import("@rabbit-company/qrcode");
		const { latin2, upn } = await import("@rabbit-company/qrcode/payload");
		const { UPN_QR_OPTIONS } = await import("../server/upn-qr");

		const payload = upn({ recipientIban: "SI56 1910 0000 0123 438", recipientName: "Trgovina", amount: "10.00", purpose: "Račun 052/26" });
		const symbol = QRCode.encodeBinary(latin2(payload), UPN_QR_OPTIONS);

		expect(symbol.version).toBe(15);
		expect(symbol.size).toBe(77);
		expect(symbol.errorCorrectionLevel).toBe(ErrorCorrectionLevel.MEDIUM);
	});

	test("declares ISO-8859-2 with ECI 000004 so readers show č and not è", async () => {
		const { ECI } = await import("@rabbit-company/qrcode");
		const { UPN_QR_OPTIONS } = await import("../server/upn-qr");

		expect(UPN_QR_OPTIONS.eci).toBe(ECI.ISO_8859_2);
		expect(ECI.ISO_8859_2).toBe(4);
	});
});
