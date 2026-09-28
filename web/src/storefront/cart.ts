export interface CartEntry {
	product: string;
	slug: string;
	name: string;
	image: string | null;
	price: number;
	currency: string;
	quantity: number;
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
		(entry.quantity as number) > 0
	);
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
	const existing = entries.find((line) => line.product === entry.product);
	if (existing) {
		Object.assign(existing, entry, { quantity: Math.min(existing.quantity + quantity, MAX_QUANTITY) });
	} else {
		entries.push({ ...entry, quantity: Math.min(quantity, MAX_QUANTITY) });
	}
	save(store, entries);
}

export function setQuantity(store: string, product: string, quantity: number) {
	const entries = cartOf(store)
		.map((line) => (line.product === product ? { ...line, quantity: Math.min(Math.max(quantity, 0), MAX_QUANTITY) } : line))
		.filter((line) => line.quantity > 0);
	save(store, entries);
}

export function removeFromCart(store: string, product: string) {
	save(
		store,
		cartOf(store).filter((line) => line.product !== product)
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

export function cartLines(store: string) {
	return cartOf(store).map((line) => ({ product: line.product, quantity: line.quantity }));
}
