import type { SQL } from "bun";
import Database from "../database/database";
import { safeInteger } from "../database/numbers";
import { Logger } from "../logger";
import { inventoryConfig, methodAt, type InventoryConfig } from "./config";
import { toThousandths } from "./quantity";
import { emptyState, onHand, replay, type AppliedThrough, type CostBasis, type StockState, type ValuationMovement, type ValuedSource } from "./valuation";
import type { ProjectRow, StockLevelRow, StockMovementKind, StockMovementRow, WarehouseRow } from "../database/models";

type ProjectClock = Pick<ProjectRow, "uuid" | "timezone">;

const queues = new Map<string, Promise<unknown>>();

export function withInventory<T>(project: string, task: () => Promise<T>): Promise<T> {
	const previous = queues.get(project) ?? Promise.resolve();
	const next = previous.catch(() => null).then(task);
	queues.set(project, next);
	void next
		.catch(() => null)
		.finally(() => {
			if (queues.get(project) === next) queues.delete(project);
		});
	return next;
}

const BASIS: Record<StockMovementKind, CostBasis> = {
	receipt: "entered",
	opening: "entered",
	customer_return: "source",
	sale: "entered",
	sale_return: "source",
	issue: "entered",
	transfer_out: "entered",
	transfer_in: "source",
	surplus: "current",
	shortage: "entered",
};

export function movementRow(row: StockMovementRow): StockMovementRow {
	return {
		...row,
		movement_date: safeInteger(row.movement_date),
		sequence: safeInteger(row.sequence),
		quantity: safeInteger(row.quantity),
		entered_value: row.entered_value === null ? null : safeInteger(row.entered_value),
		value: safeInteger(row.value),
		correction: safeInteger(row.correction),
		created: safeInteger(row.created),
	};
}

function valuationMovement(row: StockMovementRow): ValuationMovement & { movement_date: number } {
	return {
		uuid: row.uuid,
		warehouse: row.warehouse,
		quantity: row.quantity,
		basis: BASIS[row.movement_kind],
		entered_value: row.entered_value,
		cost_source: row.cost_source,
		movement_date: row.movement_date,
	};
}

export interface NewMovement {
	uuid?: string;
	item: string;
	warehouse: string;
	movement_date: number;
	movement_kind: StockMovementKind;
	quantity: number;
	entered_value?: number | null;
	cost_source?: string | null;
	document?: string | null;
	document_line?: string | null;
	invoice?: string | null;
	invoice_item?: string | null;
}

export async function insertMovements(sql: SQL, project: string, movements: NewMovement[]): Promise<string[]> {
	if (movements.length === 0) return [];
	const [last] = (await sql`SELECT MAX(sequence) AS last FROM stock_movements WHERE project = ${project}`) as { last: number | null }[];
	let sequence = safeInteger(last?.last ?? 0);
	const created = Date.now();
	const ids: string[] = [];
	for (const movement of movements) {
		sequence++;
		const uuid = movement.uuid ?? crypto.randomUUID();
		ids.push(uuid);
		await sql`
			INSERT INTO stock_movements(uuid, project, item, warehouse, movement_date, sequence, movement_kind, quantity, entered_value, cost_source, value, correction,
				document, document_line, invoice, invoice_item, created)
			VALUES(${uuid}, ${project}, ${movement.item}, ${movement.warehouse}, ${movement.movement_date}, ${sequence}, ${movement.movement_kind},
				${movement.quantity}, ${movement.entered_value ?? null}, ${movement.cost_source ?? null}, 0, 0, ${movement.document ?? null},
				${movement.document_line ?? null}, ${movement.invoice ?? null}, ${movement.invoice_item ?? null}, ${created})
		`;
	}
	return ids;
}

export async function itemMovements(sql: SQL, item: string, through: number | null = null): Promise<StockMovementRow[]> {
	const rows = (
		through === null
			? await sql`SELECT * FROM stock_movements WHERE item = ${item} ORDER BY movement_date ASC, sequence ASC`
			: await sql`SELECT * FROM stock_movements WHERE item = ${item} AND movement_date <= ${through} ORDER BY movement_date ASC, sequence ASC`
	) as StockMovementRow[];
	return rows.map(movementRow);
}

export function replayItem(rows: StockMovementRow[], config: InventoryConfig, timezone: string) {
	return replay(rows.map(valuationMovement), (movement) => methodAt(config, movement.movement_date, timezone));
}

interface Continuation {
	states: Map<string, StockState>;
	applied: AppliedThrough;
	rows: StockMovementRow[];
	sources: Map<string, ValuedSource>;
}

async function continuation(sql: SQL, item: string): Promise<Continuation | null> {
	const levels = ((await sql`SELECT * FROM stock_levels WHERE item = ${item}`) as StockLevelRow[]).map(levelRow);
	const applied = levels[0]?.layers.applied;
	if (!applied || levels.some((level) => level.layers.applied?.sequence !== applied.sequence)) return null;
	const [before] = (await sql`
		SELECT COUNT(*) AS count FROM stock_movements
		WHERE item = ${item} AND (movement_date < ${applied.date} OR (movement_date = ${applied.date} AND sequence <= ${applied.sequence}))
	`) as { count: number }[];
	if (Number(before.count) !== applied.count) return null;
	const rows = (
		(await sql`
			SELECT * FROM stock_movements
			WHERE item = ${item} AND (movement_date > ${applied.date} OR (movement_date = ${applied.date} AND sequence > ${applied.sequence}))
			ORDER BY movement_date ASC, sequence ASC
		`) as StockMovementRow[]
	).map(movementRow);
	const referenced = [...new Set(rows.map((row) => row.cost_source).filter((source): source is string => source !== null))];
	const sources = new Map<string, ValuedSource>();
	if (referenced.length > 0) {
		const found = (await sql`SELECT uuid, quantity, value FROM stock_movements WHERE uuid IN ${sql(referenced)}`) as Pick<
			StockMovementRow,
			"uuid" | "quantity" | "value"
		>[];
		for (const row of found) sources.set(row.uuid, { quantity: safeInteger(row.quantity), value: safeInteger(row.value) });
	}
	return { states: new Map(levels.map((level) => [level.warehouse, level.layers])), applied, rows, sources };
}

export async function revalue(
	sql: SQL,
	project: ProjectClock,
	items: Iterable<string>,
	config: InventoryConfig | null = null,
	options: { full?: boolean } = {}
) {
	const settings = config ?? (await inventoryConfig(project.uuid, sql));
	const now = Date.now();
	for (const item of new Set(items)) {
		const known = options.full ? null : await continuation(sql, item);
		if (known && known.rows.length === 0) continue;
		const rows = known ? known.rows : await itemMovements(sql, item);
		const result = replay(
			rows.map(valuationMovement),
			(movement) => methodAt(settings, movement.movement_date, project.timezone),
			known ? { states: known.states, sources: known.sources } : null
		);
		for (const row of rows) {
			const valued = result.values.get(row.uuid)!;
			if (valued.value === row.value && valued.correction === row.correction) continue;
			await sql`UPDATE stock_movements SET value = ${valued.value}, correction = ${valued.correction} WHERE uuid = ${row.uuid}`;
		}
		const last = rows.at(-1);
		const applied: AppliedThrough | undefined = last
			? { date: last.movement_date, sequence: last.sequence, count: (known?.applied.count ?? 0) + rows.length }
			: undefined;
		await sql`DELETE FROM stock_levels WHERE item = ${item}`;
		for (const [warehouse, state] of result.states) {
			const level = onHand(state);
			await sql`
				INSERT INTO stock_levels(item, warehouse, project, quantity, value, state, updated)
				VALUES(${item}, ${warehouse}, ${project.uuid}, ${level.quantity}, ${level.value}, ${JSON.stringify({ ...state, applied })}, ${now})
			`;
		}
	}
}

export async function revalueProject(sql: SQL, project: ProjectClock, config: InventoryConfig | null = null) {
	const items = (await sql`SELECT DISTINCT item FROM stock_movements WHERE project = ${project.uuid}`) as { item: string }[];
	await revalue(
		sql,
		project,
		items.map((row) => row.item),
		config,
		{ full: true }
	);
}

export function levelRow(row: StockLevelRow): StockLevelRow & { layers: StockState } {
	let layers = emptyState();
	try {
		layers = JSON.parse(row.state) as StockState;
	} catch {
		layers = emptyState();
	}
	return { ...row, quantity: safeInteger(row.quantity), value: safeInteger(row.value), updated: safeInteger(row.updated), layers };
}

export async function quantitiesOnHand(sql: SQL, warehouse: string, items: string[]): Promise<Map<string, number>> {
	if (items.length === 0) return new Map();
	const rows = (await sql`SELECT item, quantity FROM stock_levels WHERE warehouse = ${warehouse} AND item IN ${sql(items)}`) as Pick<
		StockLevelRow,
		"item" | "quantity"
	>[];
	return new Map(rows.map((row) => [row.item, safeInteger(row.quantity)]));
}

export async function stateThrough(
	sql: SQL,
	project: ProjectClock,
	item: string,
	through: number,
	config: InventoryConfig | null = null
): Promise<Map<string, StockState>> {
	const settings = config ?? (await inventoryConfig(project.uuid, sql));
	return replayItem(await itemMovements(sql, item, through), settings, project.timezone).states;
}

export async function warehouses(project: string, sql: SQL = Database): Promise<WarehouseRow[]> {
	return (await sql`SELECT * FROM warehouses WHERE project = ${project} ORDER BY is_default DESC, archived ASC, code ASC`) as WarehouseRow[];
}

export async function defaultWarehouse(project: Pick<ProjectRow, "uuid" | "language">, sql: SQL = Database): Promise<WarehouseRow> {
	const existing = await warehouses(project.uuid, sql);
	const chosen = existing.find((row) => Boolean(row.is_default)) ?? existing.find((row) => !row.archived);
	if (chosen) return chosen;
	const now = Date.now();
	const uuid = crypto.randomUUID();
	const name = project.language === "sl" ? "Glavno skladišče" : "Main warehouse";
	await sql`
		INSERT INTO warehouses(uuid, project, name, code, address, is_default, archived, created, updated)
		VALUES(${uuid}, ${project.uuid}, ${name}, '01', NULL, 1, 0, ${now}, ${now})
	`;
	const [created] = (await sql`SELECT * FROM warehouses WHERE uuid = ${uuid}`) as WarehouseRow[];
	return created;
}

export function sellableUnits(sql: SQL) {
	return sql`((SELECT COALESCE(SUM(sl.quantity), 0) FROM stock_levels sl JOIN warehouses sw ON sw.uuid = sl.warehouse
			WHERE sl.item = c.uuid AND sw.is_default = 1) / 1000.0
		- (SELECT COALESCE(SUM(ri.quantity), 0) FROM store_orders ro JOIN invoices rv ON rv.uuid = ro.invoice JOIN invoice_items ri ON ri.invoice = rv.uuid
			WHERE ri.item = c.uuid AND rv.status = 'draft' AND ro.fulfillment <> 'canceled'))`;
}

export async function terminalWarehouse(project: string, config: InventoryConfig | null = null): Promise<string | null> {
	const chosen = (config ?? (await inventoryConfig(project))).pos_warehouse;
	if (chosen === null) return null;
	const [warehouse] = await Database`SELECT uuid FROM warehouses WHERE uuid = ${chosen} AND project = ${project} AND archived = 0 AND is_default = 0`;
	return warehouse ? chosen : null;
}

export async function sellableQuantities(project: string, items: string[], warehouse: string | null = null): Promise<Map<string, number>> {
	if (items.length === 0) return new Map();
	if (warehouse !== null) {
		const held = (await Database`
			SELECT c.uuid AS item, COALESCE((SELECT SUM(sl.quantity) FROM stock_levels sl WHERE sl.item = c.uuid AND sl.warehouse = ${warehouse}), 0) AS quantity
			FROM catalog_items c WHERE c.project = ${project} AND c.stock_kind IS NOT NULL AND c.uuid IN ${Database(items)}
		`) as { item: string; quantity: number }[];
		return new Map(held.map((row) => [row.item, safeInteger(row.quantity) / 1000]));
	}
	const rows = (await Database`
		SELECT c.uuid AS item, ${sellableUnits(Database)} AS units FROM catalog_items c
		WHERE c.project = ${project} AND c.stock_kind IS NOT NULL AND c.uuid IN ${Database(items)}
	`) as { item: string; units: number }[];
	return new Map(rows.map((row) => [row.item, Number(row.units)]));
}

export type SalesChannel = "invoice" | "pos";

export async function inventoryShortage(
	project: string,
	lines: { item?: string | null; quantity: number }[],
	channel: SalesChannel = "invoice"
): Promise<boolean> {
	const wanted = new Map<string, number>();
	for (const line of lines) {
		if (typeof line.item === "string" && line.quantity > 0) wanted.set(line.item, (wanted.get(line.item) ?? 0) + line.quantity);
	}
	if (wanted.size === 0) return false;
	const config = await inventoryConfig(project);
	if (config.negative_stock) return false;
	const sellable = await sellableQuantities(project, [...wanted.keys()], channel === "pos" ? await terminalWarehouse(project, config) : null);
	for (const [item, units] of sellable) if (units < (wanted.get(item) ?? 0)) return true;
	return false;
}

interface UnrecordedSale {
	line: string;
	item: string;
	quantity: number;
	invoice: string;
	issued_at: number;
	source: string;
}

interface UnreturnedSale {
	uuid: string;
	item: string;
	warehouse: string;
	quantity: number;
	invoice: string;
	invoice_item: string | null;
	canceled_date: number | null;
}

async function tracksStock(project: string): Promise<boolean> {
	const [tracked] = await Database`SELECT 1 AS tracked FROM catalog_items WHERE project = ${project} AND stock_kind IS NOT NULL LIMIT 1`;
	return tracked !== undefined;
}

const FULL_SALES_SCAN_EVERY = 6 * 60 * 60 * 1000;
const RECENT_SALES_WINDOW = 48 * 60 * 60 * 1000;
const fullSalesScans = new Map<string, number>();

function salesScanFrom(project: string, now: number): number {
	const last = fullSalesScans.get(project);
	if (last !== undefined && now - last < FULL_SALES_SCAN_EVERY) return now - RECENT_SALES_WINDOW;
	fullSalesScans.set(project, now);
	return 0;
}

export function forgetSalesScans() {
	fullSalesScans.clear();
}

async function recordSales(project: Pick<ProjectRow, "uuid" | "timezone" | "language">): Promise<number> {
	const scanFrom = salesScanFrom(project.uuid, Date.now());
	const sold = (await Database`
		SELECT ii.uuid AS line, ii.item AS item, ii.quantity AS quantity, i.uuid AS invoice, i.issued_at AS issued_at, i.source AS source
		FROM invoice_items ii JOIN invoices i ON i.uuid = ii.invoice JOIN catalog_items c ON c.uuid = ii.item
		WHERE i.project = ${project.uuid} AND i.issued_at IS NOT NULL AND i.status <> 'draft' AND i.document_type = 'invoice'
			AND i.issued_at >= ${scanFrom}
			AND c.stock_kind IS NOT NULL AND c.stock_since IS NOT NULL AND i.issued_at >= c.stock_since AND ii.quantity <> 0
			AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.invoice_item = ii.uuid AND m.movement_kind IN ('sale', 'customer_return'))
		ORDER BY i.issued_at ASC, ii.sort_order ASC
	`) as UnrecordedSale[];
	const returned = (await Database`
		SELECT m.uuid AS uuid, m.item AS item, m.warehouse AS warehouse, m.quantity AS quantity, m.invoice AS invoice, m.invoice_item AS invoice_item,
			i.canceled_date AS canceled_date
		FROM stock_movements m JOIN invoices i ON i.uuid = m.invoice
		WHERE m.project = ${project.uuid} AND m.movement_kind = 'sale' AND i.status = 'canceled' AND COALESCE(i.canceled_date, i.updated) >= ${scanFrom}
			AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.cost_source = m.uuid AND r.movement_kind = 'sale_return')
	`) as UnreturnedSale[];
	if (sold.length === 0 && returned.length === 0) return 0;

	const warehouse = await defaultWarehouse(project);
	const terminal = (await terminalWarehouse(project.uuid)) ?? warehouse.uuid;
	const now = Date.now();
	await Database.begin(async (tx) => {
		const sales = sold.map((sale) => {
			const quantity = toThousandths(Number(sale.quantity));
			return {
				item: sale.item,
				warehouse: sale.source === "pos" ? terminal : warehouse.uuid,
				movement_date: safeInteger(sale.issued_at),
				movement_kind: (quantity < 0 ? "customer_return" : "sale") as StockMovementKind,
				quantity: -quantity,
				invoice: sale.invoice,
				invoice_item: sale.line,
			};
		});
		const returns = returned.map((sale) => ({
			item: sale.item,
			warehouse: sale.warehouse,
			movement_date: Math.max(safeInteger(sale.canceled_date ?? now), 0),
			movement_kind: "sale_return" as StockMovementKind,
			quantity: -safeInteger(sale.quantity),
			cost_source: sale.uuid,
			invoice: sale.invoice,
			invoice_item: sale.invoice_item,
		}));
		const movements = [...sales, ...returns].filter((movement) => movement.quantity !== 0);
		await insertMovements(tx, project.uuid, movements);
		await revalue(
			tx,
			project,
			movements.map((movement) => movement.item)
		);
	});
	return sold.length + returned.length;
}

export async function syncSales(project: Pick<ProjectRow, "uuid" | "timezone" | "language">): Promise<number> {
	if (!(await tracksStock(project.uuid))) return 0;
	return withInventory(project.uuid, () => recordSales(project));
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
const SALES_SYNC_DELAY = 300;

export function syncSalesSoon(projectId: string) {
	if (pending.has(projectId)) return;
	pending.set(
		projectId,
		setTimeout(async () => {
			pending.delete(projectId);
			try {
				const [project] = (await Database`SELECT uuid, timezone, language FROM projects WHERE uuid = ${projectId}`) as Pick<
					ProjectRow,
					"uuid" | "timezone" | "language"
				>[];
				if (project) await syncSales(project);
			} catch (error) {
				Logger.error(`[INVENTORY] Could not record the stock of sold items for project ${projectId}: ${error}`);
			}
		}, SALES_SYNC_DELAY)
	);
}
