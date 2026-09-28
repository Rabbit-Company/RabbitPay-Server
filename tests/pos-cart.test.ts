import { calculateTotals, taxIncluded } from "../server/invoicing";
import { describe, expect, test } from "bun:test";
import {
	addLine,
	changeFor,
	changeQuantity,
	grossOf,
	isCartLine,
	itemQuantity,
	keypadAmount,
	lineCount,
	pressKey,
	quickCashAmounts,
	toSaleLines,
	toTotalsInput,
	unitGross,
	type CartLine,
} from "../server/pos-cart";

const coffee = { item: "coffee", description: "Coffee", unitPrice: 250, taxRate: 22, treatment: "domestic", gross: null };
const custom = { item: null, description: "Custom amount", unitPrice: 328, taxRate: 22, treatment: "domestic", gross: 400 };

describe("keypad", () => {
	test("fills from the right in minor units", () => {
		let entry = "";
		for (const key of ["1", "2", "5", "0"] as const) entry = pressKey(entry, key);
		expect(entry).toBe("1250");
		expect(keypadAmount(entry)).toBe(1250);
	});

	test("ignores leading zeros", () => {
		expect(pressKey("", "0")).toBe("");
		expect(pressKey("", "00")).toBe("");
		expect(pressKey("5", "00")).toBe("500");
	});

	test("deletes and clears", () => {
		expect(pressKey("1250", "back")).toBe("125");
		expect(pressKey("", "back")).toBe("");
		expect(pressKey("1250", "clear")).toBe("");
		expect(keypadAmount("")).toBe(0);
	});

	test("stops at the digit limit", () => {
		expect(pressKey("123", "4", 3)).toBe("123");
		expect(pressKey("12", "00", 3)).toBe("12");
	});
});

describe("cart", () => {
	test("merges repeated catalog items", () => {
		let lines: CartLine[] = [];
		lines = addLine(lines, coffee, "a");
		lines = addLine(lines, coffee, "b");
		expect(lines).toHaveLength(1);
		expect(lines[0].quantity).toBe(2);
		expect(itemQuantity(lines, "coffee")).toBe(2);
	});

	test("keeps custom amounts as separate lines", () => {
		let lines: CartLine[] = [];
		lines = addLine(lines, custom, "a");
		lines = addLine(lines, custom, "b");
		expect(lines).toHaveLength(2);
		expect(lineCount(lines)).toBe(2);
	});

	test("does not merge the same item at another price", () => {
		const lines = addLine(addLine([], coffee, "a"), { ...coffee, unitPrice: 300 }, "b");
		expect(lines).toHaveLength(2);
	});

	test("changes quantity and drops a line at zero", () => {
		let lines = addLine([], coffee, "a");
		lines = changeQuantity(lines, "a", 2);
		expect(lines[0].quantity).toBe(3);
		lines = changeQuantity(lines, "a", -3);
		expect(lines).toEqual([]);
	});

	test("sends saved items by id and custom lines as the amount paid", () => {
		const lines = addLine(addLine([], coffee, "a"), custom, "b");
		expect(toSaleLines(lines)).toEqual([
			{ item: "coffee", quantity: 1 },
			{ amount: 400, description: "Custom amount", quantity: 1 },
		]);
	});

	test("rejects malformed saved lines", () => {
		expect(isCartLine({ ...coffee, key: "a", quantity: 1 })).toBe(true);
		expect(isCartLine({ ...coffee, key: "a", quantity: 0 })).toBe(false);
		expect(isCartLine({ ...coffee, key: "a", quantity: 1, unitPrice: 2.5 })).toBe(false);
		expect(isCartLine({ ...custom, key: "a", quantity: 1, gross: 0 })).toBe(false);
		expect(isCartLine(null)).toBe(false);
		expect(isCartLine("line")).toBe(false);
	});
});

describe("prices including VAT", () => {
	test("adds VAT the way invoices round it", () => {
		expect(grossOf(250, 22)).toBe(305);
		expect(grossOf(280, 9.5)).toBe(307);
		expect(grossOf(500, 0)).toBe(500);
	});

	test("shows the gross unit price of each line", () => {
		expect(unitGross({ ...coffee, key: "a", quantity: 1 })).toBe(305);
		expect(unitGross({ ...custom, key: "b", quantity: 1 })).toBe(400);
	});

	test("charges exactly the typed amount including VAT", () => {
		for (const rate of [0, 5, 9.5, 20, 22, 25, 27]) {
			for (let gross = 1; gross <= 3000; gross++) {
				for (const quantity of [1, 3]) {
					const line = { ...custom, key: "a", quantity, taxRate: rate, gross, unitPrice: gross - taxIncluded(gross, rate) };
					const totals = calculateTotals(toTotalsInput([line]), 0);
					expect(totals.total_amount).toBe(gross * quantity);
				}
			}
		}
	});

	test("works out the VAT inside a gross amount", () => {
		expect(taxIncluded(1250, 22)).toBe(225);
		expect(taxIncluded(1000, 9.5)).toBe(87);
		expect(taxIncluded(500, 0)).toBe(0);
	});
});

describe("cash", () => {
	test("works out the change", () => {
		expect(changeFor(2000, 1180)).toBe(820);
		expect(changeFor(1000, 1180)).toBe(0);
	});

	test("suggests exact and rounded notes", () => {
		expect(quickCashAmounts(1180, 100)).toEqual([1180, 1500, 2000, 5000]);
		expect(quickCashAmounts(2000, 100)).toEqual([2000, 5000, 10000, 20000]);
		expect(quickCashAmounts(1180, 1)).toEqual([1180, 1200, 1500, 2000]);
	});
});
