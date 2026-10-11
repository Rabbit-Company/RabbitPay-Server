import { describe, expect, test } from "bun:test";
import { emptyState, onHand, proportion, replay, type CostBasis, type ValuationMethod, type ValuationMovement } from "../server/inventory/valuation";

let counter = 0;

function movement(quantity: number, value: number | null = null, extra: Partial<ValuationMovement> = {}): ValuationMovement {
	counter++;
	const basis: CostBasis = quantity > 0 && value === null ? "current" : "entered";
	return { uuid: `m${counter}`, warehouse: "main", quantity, basis, entered_value: value, cost_source: null, ...extra };
}

function run(method: ValuationMethod, movements: ValuationMovement[]) {
	const result = replay(movements, () => method);
	return {
		values: movements.map((entry) => result.values.get(entry.uuid)!.value),
		corrections: movements.map((entry) => result.values.get(entry.uuid)!.correction),
		stock: (warehouse = "main") => onHand(result.states.get(warehouse) ?? emptyState()),
	};
}

describe("proportion", () => {
	test("rounds half away from zero and keeps whole parts exact", () => {
		expect(proportion(1000, 1, 3)).toBe(333);
		expect(proportion(1000, 2, 3)).toBe(667);
		expect(proportion(5, 1, 2)).toBe(3);
		expect(proportion(-5, 1, 2)).toBe(-3);
		expect(proportion(999, 7, 7)).toBe(999);
		expect(proportion(0, 5, 9)).toBe(0);
	});

	test("survives products beyond the safe integer range", () => {
		expect(proportion(90_000_000_000, 999_999_999, 1_000_000_000)).toBe(89_999_999_910);
	});
});

describe("FIFO", () => {
	test("issues the oldest purchase prices first", () => {
		const result = run("fifo", [movement(10_000, 10_000), movement(10_000, 12_000), movement(-15_000)]);
		expect(result.values).toEqual([10_000, 12_000, -16_000]);
		expect(result.stock()).toEqual({ quantity: 5_000, value: 6_000 });
	});

	test("the last unit of a layer takes the rounding remainder", () => {
		const result = run("fifo", [movement(3_000, 1_000), movement(-1_000), movement(-1_000), movement(-1_000)]);
		expect(result.values).toEqual([1_000, -333, -334, -333]);
		expect(result.stock()).toEqual({ quantity: 0, value: 0 });
	});
});

describe("moving weighted average", () => {
	test("recalculates the average on every receipt", () => {
		const result = run("average", [movement(10_000, 10_000), movement(10_000, 12_000), movement(-15_000), movement(5_000, 7_000), movement(-10_000)]);
		expect(result.values).toEqual([10_000, 12_000, -16_500, 7_000, -12_500]);
		expect(result.stock()).toEqual({ quantity: 0, value: 0 });
	});

	test("an empty warehouse leaves no value behind", () => {
		const result = run("average", [movement(3_000, 1_000), movement(-1_000), movement(-2_000)]);
		expect(result.values).toEqual([1_000, -333, -667]);
		expect(result.stock().value).toBe(0);
	});
});

describe("selling before the receipt is booked", () => {
	for (const method of ["fifo", "average"] as ValuationMethod[]) {
		test(`${method}: the shortfall uses the last known cost and the next receipt corrects it`, () => {
			const result = run(method, [movement(2_000, 2_000), movement(-5_000), movement(10_000, 12_000)]);
			expect(result.values).toEqual([2_000, -5_000, 12_000]);
			expect(result.corrections).toEqual([0, 0, 600]);
			expect(result.stock()).toEqual({ quantity: 7_000, value: 8_400 });
		});
	}

	test("without any known cost the shortfall is valued at zero until goods arrive", () => {
		const result = run("fifo", [movement(-2_000), movement(4_000, 4_000)]);
		expect(result.values).toEqual([0, 4_000]);
		expect(result.corrections).toEqual([0, 2_000]);
		expect(result.stock()).toEqual({ quantity: 2_000, value: 2_000 });
	});

	test("a receipt smaller than the shortfall covers only its own share", () => {
		const result = run("fifo", [movement(1_000, 1_000), movement(-5_000), movement(2_000, 3_000)]);
		expect(result.corrections).toEqual([0, 0, 1_000]);
		expect(result.stock()).toEqual({ quantity: -2_000, value: -2_000 });
	});
});

describe("receipts without an entered value", () => {
	test("a stocktake surplus comes in at the current cost", () => {
		const result = run("average", [movement(4_000, 6_000), movement(2_000)]);
		expect(result.values).toEqual([6_000, 3_000]);
		expect(result.stock()).toEqual({ quantity: 6_000, value: 9_000 });
	});

	test("a customer return comes back at the cost of the original sale", () => {
		const sale = movement(-4_000);
		const back = movement(1_000, null, { basis: "source", cost_source: sale.uuid });
		const result = run("fifo", [movement(2_000, 2_000), movement(2_000, 4_000), sale, back]);
		expect(result.values).toEqual([2_000, 4_000, -6_000, 1_500]);
	});

	test("a transfer carries its cost to the other warehouse", () => {
		const out = movement(-3_000);
		const into = movement(3_000, null, { basis: "source", cost_source: out.uuid, warehouse: "shop" });
		const result = run("fifo", [movement(2_000, 2_000), movement(2_000, 4_000), out, into]);
		expect(result.stock("main")).toEqual({ quantity: 1_000, value: 2_000 });
		expect(result.stock("shop")).toEqual({ quantity: 3_000, value: 4_000 });
	});
});

describe("changing the method", () => {
	test("FIFO layers merge into one average when the method changes", () => {
		const movements = [movement(1_000, 1_000), movement(1_000, 3_000), movement(-1_000)];
		const result = replay(movements, (entry) => (entry === movements[2] ? "average" : "fifo"));
		expect(result.values.get(movements[2].uuid)!.value).toBe(-2_000);
	});
});
