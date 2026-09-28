import type { CartLine, LicenseChoice } from "./api";

export interface CartEntry {
	product: string;
	slug: string;
	name: string;
	image: string | null;
	price: number;
	currency: string;
	quantity: number;
	license?: LicenseChoice | null;
}

const MAX_QUANTITY = 999;
const listeners = new Set<() => void>();

function key(store: string): string {
	return `rabbitpay.cart.${store}`;
}

function isEntry(value: unknown): value is CartEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.product === "string" &&
		typeof entry.slug === "string" &&
		typeof entry.name === "string" &&
		(entry.image === null || typeof entry.image === "string") &&
		Number.isSafeInteger(entry.price) &&
		typeof entry.currency === "string" &&
		Number.isSafeInteger(entry.quantity) &&
		(entry.quantity as number) > 0 &&
		(entry.license === undefined || entry.license === null || isChoice(entry.license))
	);
}

function isChoice(value: unknown): value is LicenseChoice {
	if (typeof value !== "object" || value === null) return false;
	const choice = value as Record<string, unknown>;
	return (
		(choice.amount === null || Number.isSafeInteger(choice.amount)) &&
		(choice.days === null || Number.isSafeInteger(choice.days)) &&
		(choice.server_id === null || typeof choice.server_id === "string")
	);
}

export function lineKey(line: Pick<CartLine, "product"> & { license?: LicenseChoice | null }): string {
	const license = line.license ?? null;
	return JSON.stringify([line.product, license?.amount ?? null, license?.days ?? null, license?.server_id ?? null]);
}

export function cartOf(store: string): CartEntry[] {
	try {
		const parsed = JSON.parse(localStorage.getItem(key(store)) ?? "[]");
		return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
	} catch {
		return [];
	}
}

function save(store: string, entries: CartEntry[]) {
	try {
		if (entries.length === 0) localStorage.removeItem(key(store));
		else localStorage.setItem(key(store), JSON.stringify(entries));
	} catch {
		void 0;
	}
	for (const listener of listeners) listener();
}

export function onCartChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function addToCart(store: string, entry: Omit<CartEntry, "quantity">, quantity: number) {
	const entries = cartOf(store);
	const existing = entries.find((line) => lineKey(line) === lineKey(entry));
	if (existing) {
		Object.assign(existing, entry, { quantity: Math.min(existing.quantity + quantity, MAX_QUANTITY) });
	} else {
		entries.push({ ...entry, quantity: Math.min(quantity, MAX_QUANTITY) });
	}
	save(store, entries);
}

export function setQuantity(store: string, key: string, quantity: number) {
	const entries = cartOf(store)
		.map((line) => (lineKey(line) === key ? { ...line, quantity: Math.min(Math.max(quantity, 0), MAX_QUANTITY) } : line))
		.filter((line) => line.quantity > 0);
	save(store, entries);
}

export function removeFromCart(store: string, key: string) {
	save(
		store,
		cartOf(store).filter((line) => lineKey(line) !== key)
	);
}

export function forgetProducts(store: string, products: string[]) {
	if (products.length === 0) return;
	save(
		store,
		cartOf(store).filter((line) => !products.includes(line.product))
	);
}

export function clearCart(store: string) {
	save(store, []);
}

export function cartCount(store: string): number {
	return cartOf(store).reduce((sum, line) => sum + line.quantity, 0);
}

export function cartLines(store: string): CartLine[] {
	return cartOf(store).map((line) => ({ product: line.product, quantity: line.quantity, license: line.license ?? null }));
}
