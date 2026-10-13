import Database from "../database/database";
import { safeInteger } from "../database/numbers";
import { endOfLocalDate } from "../timezone";
import { inventoryConfig, type InventoryConfig } from "./config";
import { movementRow, replayItem } from "./stock";
import { onOrderQuantities } from "./purchasing";
import { emptyState, onHand, type StockLayer } from "./valuation";
import type { CatalogItemRow, ProjectRow, StockDocumentRow, StockKind, StockLevelRow, StockMovementRow } from "../database/models";
import { textSearch } from "../text-search";

export type StockFilter = "all" | "in_stock" | "low" | "negative" | "empty";

export const STOCK_FILTERS: StockFilter[] = ["all", "in_stock", "low", "negative", "empty"];

export interface StockListRow {
	item: string;
	name: string;
	sku: string | null;
	unit: string | null;
	stock_kind: StockKind;
	archived: boolean;
	quantity: number;
	value: number;
	reserved: number;
	on_order: number;
	minimum: number | null;
	low: boolean;
}

type TrackedItem = Pick<CatalogItemRow, "uuid" | "name" | "sku" | "unit" | "stock_kind" | "stock_minimum" | "archived">;

async function trackedItems(project: string, search: string | null): Promise<TrackedItem[]> {
	return (await Database`
		SELECT uuid, name, sku, unit, stock_kind, stock_minimum, archived FROM catalog_items
		WHERE project = ${project} AND stock_kind IS NOT NULL AND ${textSearch(Database, search ?? "", [Database`name`, Database`sku`])}
		ORDER BY name ASC, uuid ASC
	`) as TrackedItem[];
}

export async function reservedQuantities(project: string): Promise<Map<string, number>> {
	const rows = (await Database`
		SELECT ii.item AS item, SUM(ii.quantity) AS quantity
		FROM store_orders o JOIN invoices i ON i.uuid = o.invoice JOIN invoice_items ii ON ii.invoice = i.uuid JOIN catalog_items c ON c.uuid = ii.item
		WHERE o.project = ${project} AND i.status = 'draft' AND o.fulfillment <> 'canceled' AND c.stock_kind IS NOT NULL
		GROUP BY ii.item
	`) as { item: string; quantity: number }[];
	return new Map(rows.map((row) => [row.item, Math.round(Number(row.quantity) * 1000)]));
}

export async function stockList(project: string, options: { warehouse: string | null; search: string | null; filter: StockFilter }): Promise<StockListRow[]> {
	const items = await trackedItems(project, options.search);
	const levels = (
		options.warehouse
			? await Database`SELECT item, quantity, value FROM stock_levels WHERE project = ${project} AND warehouse = ${options.warehouse}`
			: await Database`SELECT item, quantity, value FROM stock_levels WHERE project = ${project}`
	) as Pick<StockLevelRow, "item" | "quantity" | "value">[];
	const totals = new Map<string, StockLayer>();
	for (const level of levels) {
		const total = totals.get(level.item) ?? { quantity: 0, value: 0 };
		totals.set(level.item, { quantity: total.quantity + safeInteger(level.quantity), value: total.value + safeInteger(level.value) });
	}
	const reserved = await reservedQuantities(project);
	const ordered = await onOrderQuantities(project);
	const rows = items.map((item) => {
		const total = totals.get(item.uuid) ?? { quantity: 0, value: 0 };
		const minimum = item.stock_minimum === null ? null : safeInteger(item.stock_minimum);
		return {
			item: item.uuid,
			name: item.name,
			sku: item.sku,
			unit: item.unit,
			stock_kind: item.stock_kind!,
			archived: Boolean(item.archived),
			quantity: total.quantity,
			value: total.value,
			reserved: reserved.get(item.uuid) ?? 0,
			on_order: ordered.get(item.uuid) ?? 0,
			minimum,
			low: minimum !== null && total.quantity < minimum,
		};
	});
	if (options.filter === "in_stock") return rows.filter((row) => row.quantity > 0);
	if (options.filter === "low") return rows.filter((row) => row.low);
	if (options.filter === "negative") return rows.filter((row) => row.quantity < 0);
	if (options.filter === "empty") return rows.filter((row) => row.quantity === 0);
	return rows.filter((row) => !row.archived || row.quantity !== 0);
}

export interface ItemCardRow {
	uuid: string;
	date: number;
	kind: StockMovementRow["movement_kind"];
	warehouse: string;
	quantity: number;
	value: number;
	correction: number;
	balance_quantity: number;
	balance_value: number;
	document: string | null;
	document_number: string | null;
	document_type: StockDocumentRow["document_type"] | null;
	reason: string | null;
	partner: string | null;
	invoice: string | null;
	invoice_reference: string | null;
}

export async function itemCard(
	project: string,
	item: string,
	warehouse: string | null,
	limit: number,
	offset: number
): Promise<{ movements: ItemCardRow[]; total: number }> {
	const place = warehouse === null ? Database`` : Database`AND m.warehouse = ${warehouse}`;
	const [all] = (await Database`
		SELECT COUNT(*) AS total, COALESCE(SUM(m.quantity), 0) AS quantity, COALESCE(SUM(m.value - m.correction), 0) AS value
		FROM stock_movements m WHERE m.project = ${project} AND m.item = ${item} ${place}
	`) as { total: number; quantity: number; value: number }[];
	const [newer] =
		offset === 0
			? [{ quantity: 0, value: 0 }]
			: ((await Database`
					SELECT COALESCE(SUM(n.quantity), 0) AS quantity, COALESCE(SUM(n.value - n.correction), 0) AS value FROM (
						SELECT m.quantity AS quantity, m.value AS value, m.correction AS correction FROM stock_movements m
						WHERE m.project = ${project} AND m.item = ${item} ${place}
						ORDER BY m.movement_date DESC, m.sequence DESC LIMIT ${offset}
					) n
				`) as { quantity: number; value: number }[]);
	const rows = (await Database`
		SELECT m.*, d.number AS document_number, d.document_type AS document_type, d.reason AS reason, d.partner AS partner, i.reference AS invoice_reference
		FROM stock_movements m LEFT JOIN stock_documents d ON d.uuid = m.document LEFT JOIN invoices i ON i.uuid = m.invoice
		WHERE m.project = ${project} AND m.item = ${item} ${place}
		ORDER BY m.movement_date DESC, m.sequence DESC LIMIT ${limit} OFFSET ${offset}
	`) as (StockMovementRow & Pick<ItemCardRow, "document_number" | "document_type" | "reason" | "partner" | "invoice_reference">)[];
	let quantity = safeInteger(all.quantity) - safeInteger(newer.quantity);
	let value = safeInteger(all.value) - safeInteger(newer.value);
	const movements = rows.map((raw) => {
		const row = movementRow(raw);
		const entry: ItemCardRow = {
			uuid: row.uuid,
			date: row.movement_date,
			kind: row.movement_kind,
			warehouse: row.warehouse,
			quantity: row.quantity,
			value: row.value,
			correction: row.correction,
			balance_quantity: quantity,
			balance_value: value,
			document: row.document,
			document_number: raw.document_number,
			document_type: raw.document_type,
			reason: raw.reason,
			partner: raw.partner,
			invoice: row.invoice,
			invoice_reference: raw.invoice_reference,
		};
		quantity -= row.quantity;
		value -= row.value - row.correction;
		return entry;
	});
	return { movements, total: Number(all.total) };
}

export interface ValuationRow {
	item: string;
	name: string;
	sku: string | null;
	unit: string | null;
	stock_kind: StockKind;
	quantity: number;
	value: number;
}

export async function valuationOn(
	project: Pick<ProjectRow, "uuid" | "timezone">,
	date: string,
	warehouse: string | null,
	config: InventoryConfig | null = null
): Promise<ValuationRow[]> {
	const settings = config ?? (await inventoryConfig(project.uuid));
	const through = endOfLocalDate(date, project.timezone);
	const movements = (
		(await Database`
			SELECT * FROM stock_movements WHERE project = ${project.uuid} AND movement_date <= ${through} ORDER BY item ASC, movement_date ASC, sequence ASC
		`) as StockMovementRow[]
	).map(movementRow);
	const byItem = new Map<string, StockMovementRow[]>();
	for (const movement of movements) byItem.set(movement.item, [...(byItem.get(movement.item) ?? []), movement]);
	const items = new Map((await trackedItemsWithHistory(project.uuid)).map((item) => [item.uuid, item]));
	const rows: ValuationRow[] = [];
	for (const [item, history] of byItem) {
		const details = items.get(item);
		if (!details) continue;
		const states = replayItem(history, settings, project.timezone).states;
		let quantity = 0;
		let value = 0;
		for (const [place, state] of states) {
			if (warehouse !== null && place !== warehouse) continue;
			const level = onHand(state ?? emptyState());
			quantity += level.quantity;
			value += level.value;
		}
		if (quantity === 0 && value === 0) continue;
		rows.push({ item, name: details.name, sku: details.sku, unit: details.unit, stock_kind: details.stock_kind ?? "goods", quantity, value });
	}
	return rows.sort((a, b) => a.name.localeCompare(b.name, "sl") || a.item.localeCompare(b.item));
}

async function trackedItemsWithHistory(project: string): Promise<TrackedItem[]> {
	return (await Database`
		SELECT uuid, name, sku, unit, stock_kind, stock_minimum, archived FROM catalog_items c
		WHERE project = ${project} AND (stock_kind IS NOT NULL OR EXISTS (SELECT 1 FROM stock_movements m WHERE m.item = c.uuid))
	`) as TrackedItem[];
}

export interface StockTotals {
	goods: number;
	material: number;
	items: number;
	low: number;
	negative: number;
	drafts: number;
}

export async function stockTotals(project: string): Promise<StockTotals> {
	const rows = await stockList(project, { warehouse: null, search: null, filter: "all" });
	const [drafts] = (await Database`SELECT COUNT(*) AS count FROM stock_documents WHERE project = ${project} AND status = 'draft'`) as { count: number }[];
	return {
		goods: rows.filter((row) => row.stock_kind === "goods").reduce((sum, row) => sum + row.value, 0),
		material: rows.filter((row) => row.stock_kind === "material").reduce((sum, row) => sum + row.value, 0),
		items: rows.length,
		low: rows.filter((row) => row.low).length,
		negative: rows.filter((row) => row.quantity < 0).length,
		drafts: Number(drafts.count),
	};
}

export interface LedgerComparison {
	kind: StockKind;
	code: string;
	name: string;
	ledger: number;
	stock: number;
	difference: number;
}

export async function ledgerComparison(project: string, totals: StockTotals): Promise<LedgerComparison[]> {
	const accounts = (await Database`
		SELECT la.system_key AS system_key, la.code AS code, la.name AS name,
			(SELECT COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0) FROM journal_lines jl WHERE jl.ledger_account = la.uuid) AS balance
		FROM ledger_accounts la WHERE la.project = ${project} AND la.system_key IN ('goods_stock', 'material_stock')
	`) as { system_key: string; code: string; name: string; balance: number }[];
	return accounts.map((account) => {
		const kind: StockKind = account.system_key === "goods_stock" ? "goods" : "material";
		const stock = kind === "goods" ? totals.goods : totals.material;
		const ledger = safeInteger(account.balance);
		return { kind, code: account.code, name: account.name, ledger, stock, difference: ledger - stock };
	});
}
