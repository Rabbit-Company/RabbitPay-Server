export const QUANTITY_SCALE = 1000;
export const MAX_STOCK_QUANTITY = 1_000_000_000_000;
export const MAX_STOCK_VALUE = 100_000_000_000_000;

export function toThousandths(quantity: number): number {
	return Math.round(quantity * QUANTITY_SCALE);
}

export function fromThousandths(quantity: number): number {
	return quantity / QUANTITY_SCALE;
}

export function isStockQuantity(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_STOCK_QUANTITY;
}

export function isStockValue(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_STOCK_VALUE;
}
