import type { Context } from "@rabbit-company/web";
import { Server } from "../../server";
import Database from "../../database/database";
import { safeInteger } from "../../database/numbers";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { inventoryActive } from "../../licensing";
import { closedYear } from "../../accounting-periods";
import { expenseCost } from "../../accounting/sources";
import { syncLedger } from "../../accounting/journal";
import { endOfLocalDate, isLocalDate, localDate, startOfLocalDate } from "../../timezone";
import { currentMethod, inventoryConfig, saveInventoryConfig, withMethodFrom } from "../../inventory/config";
import {
	cancelDocument,
	createDraft,
	deleteDraft,
	documentLines,
	findDocument,
	ISSUE_REASONS,
	postDocument,
	readDocumentInput,
	RECEIPT_REASONS,
	STOCK_DOCUMENT_TYPES,
	TAXABLE_ISSUE_REASONS,
	updateDraft,
} from "../../inventory/documents";
import { isStockQuantity, isStockValue } from "../../inventory/quantity";
import { itemCard, ledgerComparison, STOCK_FILTERS, stockList, stockTotals, valuationOn, type StockFilter } from "../../inventory/reports";
import { terminalWarehouse, defaultWarehouse, levelRow, revalueProject, stateThrough, syncSales, warehouses, withInventory } from "../../inventory/stock";
import { isValuationMethod, onHand } from "../../inventory/valuation";
import { documentStorage } from "../../document-storage";
import { readIncomingInvoice } from "../../einvoice-import";
import { convertMinor } from "../../invoicing";
import { toThousandths } from "../../inventory/quantity";
import type {
	AppState,
	CatalogItemRow,
	ExpenseRow,
	ProjectRow,
	StockDocumentRow,
	StockDocumentType,
	StockLevelRow,
	StockMovementRow,
	WarehouseRow,
} from "../../database/models";
import { textSearch } from "../../text-search";

const base = "/api/v1/projects/:uuid/inventory";
const view = [Auth.required(), Permissions.require(Permission.STOCK_VIEW)] as const;
const edit = [Auth.required(), Permissions.require(Permission.STOCK_EDIT)] as const;

async function body(ctx: Context<AppState>): Promise<Record<string, unknown> | null> {
	try {
		const value = await ctx.body<Record<string, unknown>>();
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

function licensed(ctx: Context<AppState>): Response | null {
	return inventoryActive(Permissions.project(ctx)) ? null : Utils.fail(ctx, ErrorCode.INVENTORY_LICENSE_REQUIRED);
}

async function audit(ctx: Context<AppState>, action: string, entityType: string, uuid: string, value?: unknown, previous?: unknown) {
	await Audit.record(ctx, { project: Permissions.project(ctx).uuid, action, entityType, entityId: uuid, newValue: value, oldValue: previous });
}

function baseCurrency(project: ProjectRow): string {
	return project.tax_currency ?? project.currency;
}

function presentWarehouse(row: WarehouseRow) {
	return { ...row, is_default: Boolean(row.is_default), archived: Boolean(row.archived) };
}

async function presentSettings(project: ProjectRow) {
	const config = await inventoryConfig(project.uuid);
	const [moved] = await Database`SELECT 1 AS moved FROM stock_movements WHERE project = ${project.uuid} LIMIT 1`;
	return {
		method: currentMethod(config, project.timezone),
		methods: config.methods,
		negative_stock: config.negative_stock,
		pos_warehouse: await terminalWarehouse(project.uuid, config),
		has_movements: moved !== undefined,
	};
}

async function presentDocument(project: ProjectRow, document: StockDocumentRow) {
	const lines = await documentLines(document.uuid);
	const items = lines.length
		? ((await Database`SELECT uuid, name, sku, unit, tax_rate, stock_kind FROM catalog_items WHERE uuid IN ${Database(lines.map((line) => line.item))}`) as Pick<
				CatalogItemRow,
				"uuid" | "name" | "sku" | "unit" | "tax_rate" | "stock_kind"
			>[])
		: [];
	const movements = (await Database`
		SELECT document_line, value FROM stock_movements WHERE document = ${document.uuid} AND movement_kind <> 'transfer_in'
	`) as Pick<StockMovementRow, "document_line" | "value">[];
	const names = new Map(items.map((item) => [item.uuid, item]));
	const booked = new Map<string, number>();
	for (const movement of movements) {
		if (movement.document_line === null) continue;
		booked.set(movement.document_line, (booked.get(movement.document_line) ?? 0) + safeInteger(movement.value));
	}
	return {
		...document,
		date: localDate(safeInteger(document.document_date), project.timezone),
		charge_vat: Boolean(document.charge_vat),
		extra_costs: safeInteger(document.extra_costs),
		currency: baseCurrency(project),
		lines: lines.map((line) => {
			const item = names.get(line.item);
			return {
				...line,
				name: item?.name ?? "",
				sku: item?.sku ?? null,
				unit: item?.unit ?? null,
				stock_kind: item?.stock_kind ?? null,
				item_tax_rate: Number(item?.tax_rate ?? 0),
				booked_value: document.status === "posted" ? (booked.get(line.uuid) ?? 0) : null,
			};
		}),
	};
}

Server.app.get(`${base}/overview`, ...view, async (ctx) => {
	const project = Permissions.project(ctx);
	await syncSales(project);
	const totals = await stockTotals(project.uuid);
	const [ledger] = await Database`SELECT 1 AS used FROM ledger_accounts WHERE project = ${project.uuid} LIMIT 1`;
	if (ledger) await syncLedger(project);
	return Utils.ok(ctx, {
		licensed: inventoryActive(project),
		inventory_until: project.inventory_until,
		currency: baseCurrency(project),
		settings: await presentSettings(project),
		warehouses: (await warehouses(project.uuid)).map(presentWarehouse),
		totals,
		ledger: ledger ? await ledgerComparison(project.uuid, totals) : [],
		document_types: STOCK_DOCUMENT_TYPES,
		issue_reasons: ISSUE_REASONS,
		receipt_reasons: RECEIPT_REASONS,
		taxable_issue_reasons: TAXABLE_ISSUE_REASONS,
	});
});

Server.app.put(`${base}/settings`, Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const refused = licensed(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const data = await body(ctx);
	if (!data) return Utils.fail(ctx, ErrorCode.INVALID_INVENTORY_SETTINGS);
	const previous = await inventoryConfig(project.uuid);
	let next = { ...previous };
	if (data.negative_stock !== undefined) {
		if (typeof data.negative_stock !== "boolean") return Utils.fail(ctx, ErrorCode.INVALID_INVENTORY_SETTINGS);
		next.negative_stock = data.negative_stock;
	}
	if (data.pos_warehouse !== undefined) {
		if (data.pos_warehouse !== null) {
			const [chosen] = await Database`SELECT uuid FROM warehouses WHERE uuid = ${String(data.pos_warehouse)} AND project = ${project.uuid} AND archived = 0`;
			if (!chosen) return Utils.fail(ctx, ErrorCode.WAREHOUSE_NOT_FOUND);
		}
		next.pos_warehouse = data.pos_warehouse === null ? null : String(data.pos_warehouse);
	}
	let revalues = false;
	if (data.method !== undefined) {
		if (!isValuationMethod(data.method)) return Utils.fail(ctx, ErrorCode.INVALID_INVENTORY_SETTINGS);
		const [moved] = await Database`SELECT 1 AS moved FROM stock_movements WHERE project = ${project.uuid} LIMIT 1`;
		if (!moved) next = { ...next, methods: [{ from: "1970-01-01", method: data.method }] };
		else {
			const from = data.from;
			if (!isLocalDate(from) || !from.endsWith("-01-01")) return Utils.fail(ctx, ErrorCode.INVALID_INVENTORY_SETTINGS);
			const start = startOfLocalDate(from, project.timezone);
			const [closedLater] = await Database`
				SELECT 1 AS closed FROM accounting_years WHERE project = ${project.uuid} AND reopened_at IS NULL AND year >= ${Number(from.slice(0, 4))} LIMIT 1
			`;
			if (closedLater || (await closedYear(project.uuid, start))) return Utils.fail(ctx, ErrorCode.YEAR_CLOSED);
			next = withMethodFrom(next, from, data.method);
			revalues = true;
		}
	}
	await withInventory(project.uuid, () =>
		Database.begin(async (tx) => {
			await saveInventoryConfig(project.uuid, next, tx);
			if (revalues) await revalueProject(tx, project, next);
		})
	);
	await audit(ctx, "inventory.settings_updated", "inventory_settings", project.uuid, next, previous);
	if (revalues) await syncLedger(project, { force: true });
	return Utils.ok(ctx, await presentSettings(project));
});

function readWarehouse(data: Record<string, unknown>): { name: string; code: string; address: string | null } | null {
	const name = typeof data.name === "string" ? data.name.trim() : "";
	const code = typeof data.code === "string" ? data.code.trim().toUpperCase() : "";
	const address = data.address === undefined || data.address === null ? null : data.address;
	if (!name || name.length > 200 || !/^[A-Z0-9-]{1,16}$/.test(code)) return null;
	if (address !== null && (typeof address !== "string" || address.length > 255)) return null;
	return { name, code, address: address === null ? null : address.trim() || null };
}

Server.app.post(`${base}/warehouses`, Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const refused = licensed(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const data = await body(ctx);
	const input = data ? readWarehouse(data) : null;
	if (!input) return Utils.fail(ctx, ErrorCode.INVALID_WAREHOUSE);
	const existing = await warehouses(project.uuid);
	if (existing.some((row) => row.code === input.code)) return Utils.fail(ctx, ErrorCode.INVALID_WAREHOUSE);
	const uuid = crypto.randomUUID();
	const now = Date.now();
	await Database`
		INSERT INTO warehouses(uuid, project, name, code, address, is_default, archived, created, updated)
		VALUES(${uuid}, ${project.uuid}, ${input.name}, ${input.code}, ${input.address}, ${existing.some((row) => row.is_default) ? 0 : 1}, 0, ${now}, ${now})
	`;
	const [created] = (await Database`SELECT * FROM warehouses WHERE uuid = ${uuid}`) as WarehouseRow[];
	await audit(ctx, "warehouse.created", "warehouse", uuid, created);
	return Utils.ok(ctx, presentWarehouse(created), 201);
});

Server.app.patch(`${base}/warehouses/:warehouse`, Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const refused = licensed(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const data = await body(ctx);
	const [warehouse] = (await Database`SELECT * FROM warehouses WHERE uuid = ${ctx.params["warehouse"]} AND project = ${project.uuid}`) as WarehouseRow[];
	if (!warehouse) return Utils.fail(ctx, ErrorCode.WAREHOUSE_NOT_FOUND);
	if (!data) return Utils.fail(ctx, ErrorCode.INVALID_WAREHOUSE);
	const input = readWarehouse({ name: data.name ?? warehouse.name, code: data.code ?? warehouse.code, address: data.address ?? warehouse.address });
	if (!input) return Utils.fail(ctx, ErrorCode.INVALID_WAREHOUSE);
	if (data.archived !== undefined && typeof data.archived !== "boolean") return Utils.fail(ctx, ErrorCode.INVALID_WAREHOUSE);
	if (data.is_default !== undefined && data.is_default !== true) return Utils.fail(ctx, ErrorCode.INVALID_WAREHOUSE);
	const others = (await warehouses(project.uuid)).filter((row) => row.uuid !== warehouse.uuid);
	if (others.some((row) => row.code === input.code)) return Utils.fail(ctx, ErrorCode.INVALID_WAREHOUSE);
	const archived = data.archived === undefined ? Boolean(warehouse.archived) : data.archived;
	const makeDefault = data.is_default === true;
	if (archived && (makeDefault || (warehouse.is_default && !makeDefault))) return Utils.fail(ctx, ErrorCode.WAREHOUSE_IN_USE);
	if (archived && !warehouse.archived) {
		const [stocked] = await Database`SELECT 1 AS stocked FROM stock_levels WHERE warehouse = ${warehouse.uuid} AND quantity <> 0 LIMIT 1`;
		const [drafted] = await Database`
			SELECT 1 AS drafted FROM stock_documents WHERE status = 'draft' AND (warehouse = ${warehouse.uuid} OR target_warehouse = ${warehouse.uuid}) LIMIT 1
		`;
		if (stocked || drafted) return Utils.fail(ctx, ErrorCode.WAREHOUSE_IN_USE);
	}
	const now = Date.now();
	await Database.begin(async (tx) => {
		if (makeDefault) await tx`UPDATE warehouses SET is_default = 0, updated = ${now} WHERE project = ${project.uuid} AND is_default = 1`;
		await tx`
			UPDATE warehouses SET name = ${input.name}, code = ${input.code}, address = ${input.address}, archived = ${archived ? 1 : 0},
				is_default = ${makeDefault ? 1 : warehouse.is_default}, updated = ${now}
			WHERE uuid = ${warehouse.uuid}
		`;
	});
	const [updated] = (await Database`SELECT * FROM warehouses WHERE uuid = ${warehouse.uuid}`) as WarehouseRow[];
	await audit(ctx, "warehouse.updated", "warehouse", warehouse.uuid, updated, warehouse);
	return Utils.ok(ctx, presentWarehouse(updated));
});

function stockFilter(value: string | null): StockFilter {
	return STOCK_FILTERS.includes(value as StockFilter) ? (value as StockFilter) : "all";
}

function page(ctx: Context<AppState>): { limit: number; offset: number } {
	const query = ctx.query();
	return { limit: Math.min(Math.max(Number(query.get("limit")) || 50, 1), 500), offset: Math.max(Number(query.get("offset")) || 0, 0) };
}

function warehouseFilter(ctx: Context<AppState>): string | null {
	const value = ctx.query().get("warehouse");
	return value && Validate.uuid(value) ? value : null;
}

Server.app.get(`${base}/stock`, ...view, async (ctx) => {
	const project = Permissions.project(ctx);
	await syncSales(project);
	const query = ctx.query();
	const rows = await stockList(project.uuid, {
		warehouse: warehouseFilter(ctx),
		search: query.get("search")?.trim() || null,
		filter: stockFilter(query.get("filter")),
	});
	const { limit, offset } = page(ctx);
	return Utils.ok(ctx, {
		currency: baseCurrency(project),
		items: rows.slice(offset, offset + limit),
		total: rows.length,
		value: rows.reduce((sum, row) => sum + row.value, 0),
		limit,
		offset,
	});
});

Server.app.get(`${base}/items/:item`, ...view, async (ctx) => {
	const project = Permissions.project(ctx);
	await syncSales(project);
	const [item] = (await Database`SELECT * FROM catalog_items WHERE uuid = ${ctx.params["item"]} AND project = ${project.uuid}`) as CatalogItemRow[];
	if (!item) return Utils.fail(ctx, ErrorCode.ITEM_NOT_FOUND);
	const { limit, offset } = page(ctx);
	const card = await itemCard(project.uuid, item.uuid, warehouseFilter(ctx), limit, offset);
	const levels = ((await Database`SELECT * FROM stock_levels WHERE item = ${item.uuid}`) as StockLevelRow[]).map(levelRow);
	return Utils.ok(ctx, {
		currency: baseCurrency(project),
		item: {
			uuid: item.uuid,
			name: item.name,
			sku: item.sku,
			unit: item.unit,
			supply_type: item.supply_type,
			tax_rate: Number(item.tax_rate),
			stock_kind: item.stock_kind,
			stock_since: item.stock_since,
			stock_minimum: item.stock_minimum === null ? null : safeInteger(item.stock_minimum),
			archived: Boolean(item.archived),
		},
		levels: levels.map((level) => ({
			warehouse: level.warehouse,
			quantity: level.quantity,
			value: level.value,
			layers: level.layers.layers,
			deficit: level.layers.deficit,
		})),
		movements: card.movements,
		total: card.total,
		limit,
		offset,
	});
});

function readOpening(value: unknown): { quantity: number; value: number; offset: "none" | "expense" } | null | undefined {
	if (value === undefined || value === null) return null;
	if (typeof value !== "object") return undefined;
	const opening = value as Record<string, unknown>;
	const offset = opening.offset ?? "none";
	if (!isStockQuantity(opening.quantity) || opening.quantity === 0 || !isStockValue(opening.value)) return undefined;
	if (offset !== "none" && offset !== "expense") return undefined;
	return { quantity: opening.quantity, value: opening.value, offset };
}

Server.app.put(`${base}/items/:item`, ...edit, async (ctx) => {
	const refused = licensed(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const data = await body(ctx);
	const [item] = (await Database`SELECT * FROM catalog_items WHERE uuid = ${ctx.params["item"]} AND project = ${project.uuid}`) as CatalogItemRow[];
	if (!item) return Utils.fail(ctx, ErrorCode.ITEM_NOT_FOUND);
	if (!data) return Utils.fail(ctx, ErrorCode.INVALID_ITEM);
	const kind = data.stock_kind === undefined ? item.stock_kind : data.stock_kind;
	if (kind !== null && kind !== "goods" && kind !== "material") return Utils.fail(ctx, ErrorCode.INVALID_ITEM);
	const minimum = data.stock_minimum === undefined ? item.stock_minimum : data.stock_minimum;
	if (minimum !== null && !isStockQuantity(minimum)) return Utils.fail(ctx, ErrorCode.INVALID_ITEM);
	if (kind !== null && (item.delivers_keys || item.license !== null || item.supply_type !== "goods")) return Utils.fail(ctx, ErrorCode.STOCK_ITEM_NOT_TRACKED);
	if (kind !== item.stock_kind && item.stock_kind !== null) {
		const [moved] = await Database`SELECT 1 AS moved FROM stock_movements WHERE item = ${item.uuid} LIMIT 1`;
		const [held] = await Database`SELECT 1 AS held FROM stock_levels WHERE item = ${item.uuid} AND (quantity <> 0 OR value <> 0) LIMIT 1`;
		const [drafted] = await Database`
			SELECT 1 AS drafted FROM stock_document_lines l JOIN stock_documents d ON d.uuid = l.document WHERE l.item = ${item.uuid} AND d.status = 'draft' LIMIT 1
		`;
		if ((kind !== null && moved) || (kind === null && (held || drafted))) return Utils.fail(ctx, ErrorCode.STOCK_KIND_LOCKED);
	}
	const opening = item.stock_kind === null && kind !== null ? readOpening(data.opening) : null;
	if (opening === undefined) return Utils.fail(ctx, ErrorCode.INVALID_STOCK_DOCUMENT);
	const now = Date.now();
	const since = kind === null ? null : item.stock_kind === null ? now : item.stock_since;
	await Database`
		UPDATE catalog_items SET stock_kind = ${kind}, stock_since = ${since}, stock_minimum = ${kind === null ? null : minimum}, updated = ${now}
		WHERE uuid = ${item.uuid}
	`;
	const warehouse = kind !== null ? await defaultWarehouse(project) : null;
	if (opening && warehouse) {
		const draft = await createDraft(
			project,
			{
				document_type: "opening",
				warehouse: warehouse.uuid,
				target_warehouse: null,
				document_date: startOfLocalDate(localDate(now, project.timezone), project.timezone),
				reason: null,
				partner: null,
				partner_tax_number: null,
				external_reference: null,
				expense: null,
				invoice: null,
				extra_costs: 0,
				charge_vat: false,
				opening_offset: opening.offset,
				ledger_account: null,
				purchase_order: null,
				notes: null,
				lines: [{ item: item.uuid, quantity: opening.quantity, value: opening.value, tax_rate: null, note: null, order_line: null }],
			},
			Auth.account(ctx).username
		);
		if (typeof draft === "number") return Utils.fail(ctx, draft);
		const posted = await postDocument(project, draft.uuid, Auth.account(ctx).username);
		if (typeof posted === "number") return Utils.fail(ctx, posted);
		await syncLedger(project);
	}
	await audit(
		ctx,
		"item.stock_updated",
		"item",
		item.uuid,
		{ stock_kind: kind, stock_minimum: minimum },
		{ stock_kind: item.stock_kind, stock_minimum: item.stock_minimum }
	);
	return Utils.ok(ctx, { uuid: item.uuid, stock_kind: kind, stock_since: since, stock_minimum: kind === null ? null : minimum });
});

Server.app.get(`${base}/candidates`, ...view, async (ctx) => {
	const project = Permissions.project(ctx);
	const search = ctx.query().get("search")?.trim() ?? "";
	const wanted = ctx.query().get("item");
	const only = wanted && Validate.uuid(wanted) ? Database`AND c.uuid = ${wanted}` : Database``;
	const items = (await Database`
		SELECT c.uuid, c.name, c.sku, c.unit, (SELECT sp.stock FROM store_products sp WHERE sp.item = c.uuid) AS store_stock
		FROM catalog_items c
		WHERE c.project = ${project.uuid} AND c.archived = 0 AND c.stock_kind IS NULL AND c.supply_type = 'goods' AND c.delivers_keys = 0
			AND c.license IS NULL AND ${textSearch(Database, search, [Database`c.name`, Database`c.sku`])} ${only}
		ORDER BY c.name ASC LIMIT 200
	`) as (Pick<CatalogItemRow, "uuid" | "name" | "sku" | "unit"> & { store_stock: number | null })[];
	return Utils.ok(ctx, { items: items.map((item) => ({ ...item, store_stock: item.store_stock === null ? null : safeInteger(item.store_stock) })) });
});

function documentType(value: string | null): StockDocumentType | null {
	return STOCK_DOCUMENT_TYPES.includes(value as StockDocumentType) ? (value as StockDocumentType) : null;
}

Server.app.get(`${base}/documents`, ...view, async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();
	const type = documentType(query.get("type"));
	const status = ["draft", "posted", "canceled"].includes(query.get("status") ?? "") ? query.get("status") : null;
	const search = query.get("search")?.trim() ?? "";
	const { limit, offset } = page(ctx);
	const ofType = type ? Database`AND d.document_type = ${type}` : Database``;
	const inStatus = status ? Database`AND d.status = ${status}` : Database``;
	const where = Database`
		d.project = ${project.uuid} ${ofType} ${inStatus}
		AND ${textSearch(Database, search, [Database`d.number`, Database`d.partner`, Database`d.external_reference`])}
	`;
	const rows = (await Database`
		SELECT d.*, w.name AS warehouse_name, t.name AS target_name,
			(SELECT COUNT(*) FROM stock_document_lines l WHERE l.document = d.uuid) AS line_count,
			(SELECT COALESCE(SUM(l.value), 0) FROM stock_document_lines l WHERE l.document = d.uuid) AS entered_value,
			(SELECT COALESCE(SUM(m.value), 0) FROM stock_movements m WHERE m.document = d.uuid AND m.movement_kind <> 'transfer_in') AS booked_value
		FROM stock_documents d JOIN warehouses w ON w.uuid = d.warehouse LEFT JOIN warehouses t ON t.uuid = d.target_warehouse
		WHERE ${where}
		ORDER BY d.document_date DESC, d.created DESC LIMIT ${limit} OFFSET ${offset}
	`) as (StockDocumentRow & { warehouse_name: string; target_name: string | null; line_count: number; entered_value: number; booked_value: number })[];
	const [counted] = (await Database`SELECT COUNT(*) AS count FROM stock_documents d WHERE ${where}`) as { count: number }[];
	return Utils.ok(ctx, {
		currency: baseCurrency(project),
		documents: rows.map((row) => ({
			uuid: row.uuid,
			document_type: row.document_type,
			status: row.status,
			number: row.number,
			date: localDate(safeInteger(row.document_date), project.timezone),
			reason: row.reason,
			partner: row.partner,
			external_reference: row.external_reference,
			warehouse: row.warehouse,
			warehouse_name: row.warehouse_name,
			target_name: row.target_name,
			lines: Number(row.line_count),
			value: row.status === "posted" ? safeInteger(row.booked_value) : safeInteger(row.entered_value) + safeInteger(row.extra_costs),
		})),
		total: Number(counted.count),
		limit,
		offset,
	});
});

async function loadDocument(ctx: Context<AppState>): Promise<StockDocumentRow | null> {
	const uuid = ctx.params["document"];
	return Validate.uuid(uuid) ? findDocument(Permissions.project(ctx).uuid, uuid) : null;
}

Server.app.post(`${base}/documents`, ...edit, async (ctx) => {
	const refused = licensed(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const data = await body(ctx);
	const input = data ? readDocumentInput(project, data) : null;
	if (!input) return Utils.fail(ctx, ErrorCode.INVALID_STOCK_DOCUMENT);
	const created = await createDraft(project, input, Auth.account(ctx).username);
	if (typeof created === "number") return Utils.fail(ctx, created);
	await audit(ctx, "stock_document.created", "stock_document", created.uuid, { document_type: created.document_type, lines: input.lines.length });
	return Utils.ok(ctx, await presentDocument(project, created), 201);
});

Server.app.get(`${base}/documents/:document`, ...view, async (ctx) => {
	const document = await loadDocument(ctx);
	if (!document) return Utils.fail(ctx, ErrorCode.STOCK_DOCUMENT_NOT_FOUND);
	return Utils.ok(ctx, await presentDocument(Permissions.project(ctx), document));
});

Server.app.put(`${base}/documents/:document`, ...edit, async (ctx) => {
	const refused = licensed(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const document = await loadDocument(ctx);
	if (!document) return Utils.fail(ctx, ErrorCode.STOCK_DOCUMENT_NOT_FOUND);
	const data = await body(ctx);
	const input = data ? readDocumentInput(project, { ...data, document_type: document.document_type }) : null;
	if (!input) return Utils.fail(ctx, ErrorCode.INVALID_STOCK_DOCUMENT);
	const updated = await updateDraft(project, document, input);
	if (typeof updated === "number") return Utils.fail(ctx, updated);
	return Utils.ok(ctx, await presentDocument(project, updated));
});

Server.app.delete(`${base}/documents/:document`, ...edit, async (ctx) => {
	const refused = licensed(ctx);
	if (refused) return refused;
	const document = await loadDocument(ctx);
	if (!document) return Utils.fail(ctx, ErrorCode.STOCK_DOCUMENT_NOT_FOUND);
	const failed = await deleteDraft(document);
	if (failed !== null) return Utils.fail(ctx, failed);
	await audit(ctx, "stock_document.deleted", "stock_document", document.uuid, undefined, { document_type: document.document_type });
	return Utils.ok(ctx);
});

Server.app.post(`${base}/documents/:document/post`, ...edit, async (ctx) => {
	const refused = licensed(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const uuid = ctx.params["document"];
	if (!Validate.uuid(uuid)) return Utils.fail(ctx, ErrorCode.STOCK_DOCUMENT_NOT_FOUND);
	await syncSales(project);
	const posted = await postDocument(project, uuid, Auth.account(ctx).username);
	if (typeof posted === "number") return Utils.fail(ctx, posted);
	await audit(ctx, "stock_document.posted", "stock_document", posted.uuid, { number: posted.number, document_type: posted.document_type });
	await syncLedger(project);
	return Utils.ok(ctx, await presentDocument(project, posted));
});

Server.app.post(`${base}/documents/:document/cancel`, ...edit, async (ctx) => {
	const refused = licensed(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const uuid = ctx.params["document"];
	if (!Validate.uuid(uuid)) return Utils.fail(ctx, ErrorCode.STOCK_DOCUMENT_NOT_FOUND);
	const data = await body(ctx);
	const reason = typeof data?.reason === "string" ? data.reason.trim().slice(0, 500) || null : null;
	const canceled = await cancelDocument(project, uuid, Auth.account(ctx).username, reason);
	if (typeof canceled === "number") return Utils.fail(ctx, canceled);
	await audit(ctx, "stock_document.canceled", "stock_document", canceled.uuid, { number: canceled.number, reason });
	await syncLedger(project);
	return Utils.ok(ctx, await presentDocument(project, canceled));
});

Server.app.get(`${base}/count-sheet`, ...view, async (ctx) => {
	const project = Permissions.project(ctx);
	await syncSales(project);
	const query = ctx.query();
	const warehouse = warehouseFilter(ctx);
	const date = query.get("date");
	if (!warehouse || !isLocalDate(date)) return Utils.fail(ctx, ErrorCode.INVALID_STOCK_DOCUMENT);
	const today = localDate(Date.now(), project.timezone);
	if (date > today) return Utils.fail(ctx, ErrorCode.STOCK_DATE_IN_FUTURE);
	const rows =
		date === today
			? (await stockList(project.uuid, { warehouse, search: null, filter: "all" })).map((row) => ({ ...row, booked: row.quantity }))
			: await (async () => {
					const valued = new Map((await valuationOn(project, date, warehouse)).map((row) => [row.item, row.quantity]));
					return (await stockList(project.uuid, { warehouse, search: null, filter: "all" })).map((row) => ({ ...row, booked: valued.get(row.item) ?? 0 }));
				})();
	return Utils.ok(ctx, {
		date,
		items: rows.map((row) => ({ item: row.item, name: row.name, sku: row.sku, unit: row.unit, stock_kind: row.stock_kind, booked: row.booked })),
	});
});

Server.app.get(`${base}/booked`, ...view, async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();
	const warehouse = warehouseFilter(ctx);
	const item = query.get("item");
	const date = query.get("date");
	if (!warehouse || !Validate.uuid(item) || !isLocalDate(date)) return Utils.fail(ctx, ErrorCode.INVALID_STOCK_DOCUMENT);
	const through = date >= localDate(Date.now(), project.timezone) ? Date.now() : endOfLocalDate(date, project.timezone);
	const state = (await stateThrough(Database, project, item!, through)).get(warehouse);
	const level = state ? onHand(state) : { quantity: 0, value: 0 };
	return Utils.ok(ctx, { item, warehouse, date, quantity: level.quantity, value: level.value });
});

function major(value: number): string {
	return (value / 100).toFixed(2).replace(".", ",");
}

function quantityText(value: number): string {
	return (value / 1000).toFixed(3).replace(".", ",");
}

function csvCell(value: string | number | null): string {
	const text = value === null ? "" : String(value);
	return /[";\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

Server.app.get(`${base}/valuation`, ...view, async (ctx) => {
	const project = Permissions.project(ctx);
	await syncSales(project);
	const query = ctx.query();
	const date = query.get("date") ?? localDate(Date.now(), project.timezone);
	if (!isLocalDate(date)) return Utils.fail(ctx, ErrorCode.INVALID_STOCK_DOCUMENT);
	const config = await inventoryConfig(project.uuid);
	const rows = await valuationOn(project, date, warehouseFilter(ctx), config);
	const method = currentMethod(config, project.timezone, startOfLocalDate(date, project.timezone));
	if (query.get("format") === "csv") {
		const table: (string | number | null)[][] = [
			["sifra", "naziv", "vrsta", "enota", "kolicina", "cena", "vrednost"],
			...rows.map((row) => [
				row.sku,
				row.name,
				row.stock_kind === "goods" ? "blago" : "material",
				row.unit,
				quantityText(row.quantity),
				row.quantity === 0 ? "" : major(Math.round((row.value * 1000) / row.quantity)),
				major(row.value),
			]),
		];
		return new Response("﻿" + table.map((row) => row.map(csvCell).join(";")).join("\n") + "\n", {
			headers: { "Content-Type": "text/csv;charset=utf-8", "Content-Disposition": `attachment; filename="zaloga-${date}.csv"` },
		});
	}
	return Utils.ok(ctx, {
		date,
		method,
		currency: baseCurrency(project),
		items: rows,
		goods: rows.filter((row) => row.stock_kind === "goods").reduce((sum, row) => sum + row.value, 0),
		material: rows.filter((row) => row.stock_kind === "material").reduce((sum, row) => sum + row.value, 0),
	});
});

Server.app.get(`${base}/purchases`, ...view, async (ctx) => {
	const project = Permissions.project(ctx);
	const currency = baseCurrency(project);
	const expenses = (await Database`
		SELECT e.* FROM expenses e
		WHERE e.project = ${project.uuid} AND e.stock_purchase IN ('goods', 'material')
			AND NOT EXISTS (SELECT 1 FROM stock_documents d WHERE d.expense = e.uuid AND d.status <> 'canceled')
		ORDER BY e.expense_date DESC LIMIT 200
	`) as ExpenseRow[];
	return Utils.ok(ctx, {
		currency,
		expenses: expenses.map((expense) => ({
			uuid: expense.uuid,
			description: expense.description,
			supplier: expense.supplier,
			supplier_tax_number: expense.supplier_tax_number,
			invoice_number: expense.invoice_number,
			date: localDate(safeInteger(expense.expense_date), project.timezone),
			stock_purchase: expense.stock_purchase,
			value: expenseCost(expense, currency),
		})),
	});
});

function matchable(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

Server.app.get(`${base}/purchases/:expense/lines`, ...view, async (ctx) => {
	const project = Permissions.project(ctx);
	const currency = baseCurrency(project);
	const [expense] = (await Database`SELECT * FROM expenses WHERE uuid = ${ctx.params["expense"]} AND project = ${project.uuid}`) as ExpenseRow[];
	if (!expense) return Utils.fail(ctx, ErrorCode.EXPENSE_NOT_FOUND);
	const [attachment] = (await Database`SELECT storage_key, content_type FROM expense_attachments WHERE expense = ${expense.uuid}`) as {
		storage_key: string;
		content_type: string;
	}[];
	if (!attachment || !attachment.content_type.includes("xml")) return Utils.ok(ctx, { currency, lines: [] });
	let invoice: ReturnType<typeof readIncomingInvoice>;
	try {
		invoice = readIncomingInvoice(await documentStorage().get(attachment.storage_key));
	} catch {
		return Utils.ok(ctx, { currency, lines: [] });
	}
	const items = (await Database`
		SELECT uuid, name, sku, unit FROM catalog_items WHERE project = ${project.uuid} AND stock_kind IS NOT NULL AND archived = 0
	`) as Pick<CatalogItemRow, "uuid" | "name" | "sku" | "unit">[];
	const remembered = (await Database`
		SELECT l.note AS note, l.item AS item FROM stock_document_lines l JOIN stock_documents d ON d.uuid = l.document
		WHERE l.project = ${project.uuid} AND l.note IS NOT NULL AND d.document_type = 'receipt' AND d.status = 'posted'
		ORDER BY d.posted_at ASC
	`) as { note: string; item: string }[];
	const known = new Map(remembered.map((row) => [matchable(row.note), row.item]));
	const byId = new Map(items.map((item) => [item.uuid, item]));
	const suggest = (description: string) => {
		const text = matchable(description);
		const earlier = byId.get(known.get(text) ?? "");
		if (earlier) return earlier;
		const words = new Set(text.split(" "));
		return (
			items.find((item) => matchable(item.name) === text) ??
			items.find(
				(item) =>
					item.sku !== null &&
					matchable(item.sku).length > 2 &&
					matchable(item.sku)
						.split(" ")
						.every((word) => words.has(word))
			) ??
			null
		);
	};
	const inBase = (amount: number) =>
		invoice.currency === currency
			? amount
			: expense.tax_exchange_rate === null
				? null
				: convertMinor(amount, invoice.currency, expense.tax_exchange_rate, currency);
	return Utils.ok(ctx, {
		currency,
		lines: invoice.lines
			.filter((line) => line.quantity !== null && line.quantity > 0 && line.amount >= 0)
			.map((line) => {
				const item = suggest(line.description);
				return {
					description: line.description.slice(0, 500),
					quantity: toThousandths(line.quantity!),
					value: inBase(line.amount),
					item: item ? { uuid: item.uuid, name: item.name, sku: item.sku, unit: item.unit } : null,
				};
			}),
	});
});
