export const KEYPAD_MAX_DIGITS = 9;

export type KeypadKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "00" | "back" | "clear";

export interface CartLine {
	key: string;
	item: string | null;
	description: string;
	unitPrice: number;
	quantity: number;
	taxRate: number;
	treatment: string | null;
	gross: number | null;
}

export function isKeypadKey(value: string): value is KeypadKey {
	return /^(\d|00|back|clear)$/.test(value);
}

export function pressKey(entry: string, key: KeypadKey, maxDigits = KEYPAD_MAX_DIGITS): string {
	if (key === "clear") return "";
	if (key === "back") return entry.slice(0, -1);

	const next = `${entry}${key}`.replace(/^0+/, "");
	return next.length > maxDigits ? entry : next;
}

export function keypadAmount(entry: string): number {
	return entry === "" ? 0 : Number(entry);
}

function sameProduct(line: CartLine, added: Omit<CartLine, "key" | "quantity">): boolean {
	return (
		line.item !== null &&
		line.item === added.item &&
		line.unitPrice === added.unitPrice &&
		line.taxRate === added.taxRate &&
		line.description === added.description &&
		line.gross === added.gross
	);
}

export function addLine(lines: CartLine[], added: Omit<CartLine, "key" | "quantity">, key: string, quantity = 1): CartLine[] {
	const existing = lines.find((line) => sameProduct(line, added));
	if (existing) return lines.map((line) => (line === existing ? { ...line, quantity: line.quantity + quantity } : line));
	return [...lines, { ...added, key, quantity }];
}

export function changeQuantity(lines: CartLine[], key: string, delta: number): CartLine[] {
	return lines.flatMap((line) => {
		if (line.key !== key) return [line];
		const quantity = line.quantity + delta;
		return quantity > 0 ? [{ ...line, quantity }] : [];
	});
}

export function itemQuantity(lines: CartLine[], item: string): number {
	return lines.filter((line) => line.item === item).reduce((sum, line) => sum + line.quantity, 0);
}

export function lineCount(lines: CartLine[]): number {
	return lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function toSaleLines(lines: CartLine[]) {
	return lines.map((line) =>
		line.item === null ? { amount: unitGross(line), description: line.description, quantity: line.quantity } : { item: line.item, quantity: line.quantity }
	);
}

export function isCartLine(value: unknown): value is CartLine {
	if (typeof value !== "object" || value === null) return false;
	const line = value as Record<string, unknown>;
	return (
		typeof line.key === "string" &&
		(line.item === null || typeof line.item === "string") &&
		typeof line.description === "string" &&
		Number.isSafeInteger(line.unitPrice) &&
		Number.isSafeInteger(line.quantity) &&
		(line.quantity as number) > 0 &&
		typeof line.taxRate === "number" &&
		(line.treatment === null || typeof line.treatment === "string") &&
		(line.gross === null || (Number.isSafeInteger(line.gross) && (line.gross as number) > 0))
	);
}

export function grossOf(net: number, taxRate: number): number {
	return net + Math.round((net * taxRate) / 100);
}

export function unitGross(line: CartLine): number {
	return line.gross ?? grossOf(line.unitPrice, line.taxRate);
}

export function toTotalsInput(lines: CartLine[]) {
	return lines.map((line) => ({
		description: line.description,
		quantity: line.quantity,
		unit_price: line.unitPrice,
		tax_rate: line.taxRate,
		gross_amount: line.gross === null ? null : line.gross * line.quantity,
	}));
}

export function changeFor(tendered: number, due: number): number {
	return Math.max(tendered - due, 0);
}

export function quickCashAmounts(due: number, minorPerMajor: number): number[] {
	const steps = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].map((major) => major * minorPerMajor);
	const rounded = steps.map((step) => Math.ceil(due / step) * step).filter((amount) => amount > due);
	return [due, ...new Set(rounded)].slice(0, 4);
}
