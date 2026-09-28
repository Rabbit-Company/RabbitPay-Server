import type { SQL } from "bun";
import Database from "./database/database";
import { ErrorCode } from "./errors";
import type { ItemKeyRow, ItemKeyStatus } from "./database/models";

export const MAX_KEY_LENGTH = 500;
export const MAX_KEYS_AT_ONCE = 5000;

export interface KeyStock {
	available: number;
	reserved: number;
	delivered: number;
	total: number;
}

export interface KeyLine {
	item?: string | null;
	quantity: number;
}

export class OutOfStock extends Error {
	constructor() {
		super("There are not enough keys left in stock for one of the items on this invoice.");
	}
}

export function emptyStock(): KeyStock {
	return { available: 0, reserved: 0, delivered: 0, total: 0 };
}

export function parseKeys(value: unknown): string[] | null {
	const lines = typeof value === "string" ? value.split(/\r?\n/) : Array.isArray(value) ? value : null;
	if (lines === null || lines.length > MAX_KEYS_AT_ONCE) return null;

	const seen = new Set<string>();
	const keys: string[] = [];

	for (const line of lines) {
		if (typeof line !== "string") return null;

		const key = line.trim();
		if (key === "") continue;
		if (key.length > MAX_KEY_LENGTH) return null;
		if (seen.has(key)) continue;

		seen.add(key);
		keys.push(key);
	}

	return keys;
}

export function presentKey(key: ItemKeyRow, withSecret = true) {
	return {
		uuid: key.uuid,
		item: key.item,
		secret: withSecret ? key.secret : null,
		status: key.status,
		invoice: key.invoice,
		recipient: key.recipient,
		reserved_at: key.reserved_at,
		delivered_at: key.delivered_at,
		created: key.created,
	};
}

export async function stockFor(projectId: string, itemIds: string[]): Promise<Map<string, KeyStock>> {
	const stock = new Map<string, KeyStock>();
	if (itemIds.length === 0) return stock;

	const rows = (await Database`
		SELECT item, status, COUNT(*) AS count FROM item_keys
		WHERE project = ${projectId} AND item IN ${Database(itemIds)}
		GROUP BY item, status
	`) as { item: string; status: ItemKeyStatus; count: number }[];

	for (const row of rows) {
		const entry = stock.get(row.item) ?? emptyStock();
		const count = Number(row.count);
		entry[row.status] += count;
		entry.total += count;
		stock.set(row.item, entry);
	}

	return stock;
}

export async function availableFor(projectId: string, itemIds: string[]): Promise<Map<string, number>> {
	const available = new Map<string, number>();
	if (itemIds.length === 0) return available;

	const rows = (await Database`
		SELECT item, COUNT(*) AS count FROM item_keys
		WHERE project = ${projectId} AND status = 'available' AND item IN ${Database(itemIds)}
		GROUP BY item
	`) as { item: string; count: number }[];

	for (const row of rows) available.set(row.item, Number(row.count));
	return available;
}

async function keyItemsAmong(projectId: string, itemIds: string[]): Promise<Set<string>> {
	if (itemIds.length === 0) return new Set();

	const rows = (await Database`
		SELECT uuid FROM catalog_items WHERE project = ${projectId} AND delivers_keys = 1 AND uuid IN ${Database(itemIds)}
	`) as { uuid: string }[];

	return new Set(rows.map((row) => row.uuid));
}

export function demandOf(lines: KeyLine[], keyItems: Set<string>): Map<string, number> {
	const demand = new Map<string, number>();

	for (const line of lines) {
		if (typeof line.item !== "string" || !keyItems.has(line.item)) continue;
		demand.set(line.item, (demand.get(line.item) ?? 0) + Math.ceil(line.quantity));
	}

	return demand;
}

export async function stockShortage(projectId: string, lines: KeyLine[]): Promise<ErrorCode | null> {
	const itemIds = [...new Set(lines.map((line) => line.item).filter((item): item is string => typeof item === "string"))];
	const keyItems = await keyItemsAmong(projectId, itemIds);
	const demand = demandOf(lines, keyItems);
	if (demand.size === 0) return null;

	const available = await availableFor(projectId, [...demand.keys()]);
	for (const [item, wanted] of demand) {
		if ((available.get(item) ?? 0) < wanted) return ErrorCode.OUT_OF_STOCK;
	}

	return null;
}

export async function reserveKeys(sql: SQL, invoiceId: string): Promise<number> {
	const lines = (await sql`
		SELECT ii.uuid AS line, ii.item AS item, ii.quantity AS quantity
		FROM invoice_items ii JOIN catalog_items c ON c.uuid = ii.item
		WHERE ii.invoice = ${invoiceId} AND c.delivers_keys = 1
		ORDER BY ii.sort_order ASC
	`) as { line: string; item: string; quantity: number }[];

	if (lines.length === 0) return 0;

	const timestamp = Date.now();
	let reserved = 0;

	for (const line of lines) {
		const wanted = Math.ceil(line.quantity);
		const free = (await sql`
			SELECT uuid FROM item_keys WHERE item = ${line.item} AND status = 'available' ORDER BY sequence ASC LIMIT ${wanted}
		`) as { uuid: string }[];

		if (free.length < wanted) throw new OutOfStock();

		for (const key of free) {
			const claimed = await sql`
				UPDATE item_keys SET status = 'reserved', invoice = ${invoiceId}, invoice_item = ${line.line}, reserved_at = ${timestamp}
				WHERE uuid = ${key.uuid} AND status = 'available'
			`;
			if (claimed.count === 0) throw new OutOfStock();
			reserved++;
		}
	}

	return reserved;
}

export async function releaseKeys(sql: SQL, invoiceId: string): Promise<number> {
	const released = await sql`
		UPDATE item_keys SET status = 'available', invoice = NULL, invoice_item = NULL, reserved_at = NULL
		WHERE invoice = ${invoiceId} AND status = 'reserved'
	`;

	return released.count ?? 0;
}
