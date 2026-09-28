import { reportRoutes } from "../../report-routes";
import { Server } from "../../server";
import Database from "../../database/database";
import { safeInteger, addIntegers } from "../../database/numbers";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { isSupplyType, isTaxCategory } from "../../tax";
import { isUnitCode } from "../../measure-units";
import { emptyStock, stockFor, type KeyStock } from "../../item-keys";
import { removeStoreImages } from "../../store/images";
import type { CatalogItemRow } from "../../database/models";

interface ItemBody {
	name?: string;
	description?: string | null;
	sku?: string | null;
	unit_price?: number;
	currency?: string;
	tax_rate?: number;
	supply_type?: string;
	tax_category?: string;
	delivers_keys?: boolean;
	unit?: string | null;
	archived?: boolean;
}

function present(item: CatalogItemRow, stock: KeyStock | undefined = undefined) {
	return {
		...item,
		archived: Boolean(item.archived),
		delivers_keys: Boolean(item.delivers_keys),
		keys: item.delivers_keys ? (stock ?? emptyStock()) : null,
	};
}

async function presentOne(projectId: string, item: CatalogItemRow) {
	return present(item, item.delivers_keys ? (await stockFor(projectId, [item.uuid])).get(item.uuid) : undefined);
}

function cleanText(value: string | null | undefined): string | null {
	if (value === undefined || value === null) return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function validateBody(data: ItemBody, creating: boolean): ErrorCode | null {
	if (creating || data.name !== undefined) {
		if (!Validate.shortText(data.name, 200)) return ErrorCode.INVALID_ITEM;
	}
	if (creating || data.unit_price !== undefined) {
		if (!Validate.minorUnitAmount(data.unit_price)) return ErrorCode.INVALID_ITEM;
	}
	if (data.tax_rate !== undefined && !Validate.taxRate(data.tax_rate)) return ErrorCode.INVALID_ITEM;
	if (data.supply_type !== undefined && !isSupplyType(data.supply_type)) return ErrorCode.INVALID_ITEM;
	if (data.tax_category !== undefined && !isTaxCategory(data.tax_category)) return ErrorCode.INVALID_ITEM;
	if (data.tax_category === "exempt" && data.tax_rate !== undefined && data.tax_rate !== 0) return ErrorCode.INVALID_ITEM;
	if (!Validate.optionalText(data.description, 1000)) return ErrorCode.INVALID_ITEM;
	if (!Validate.optionalText(data.sku, 64)) return ErrorCode.INVALID_ITEM;
	if (data.archived !== undefined && typeof data.archived !== "boolean") return ErrorCode.INVALID_ITEM;
	if (data.delivers_keys !== undefined && typeof data.delivers_keys !== "boolean") return ErrorCode.INVALID_ITEM;
	if (data.unit !== undefined && data.unit !== null && !isUnitCode(data.unit)) return ErrorCode.INVALID_ITEM;
	if (data.currency !== undefined && !Validate.currency(data.currency)) return ErrorCode.INVALID_CURRENCY;
	return null;
}

async function findItem(projectId: string, itemId: string): Promise<CatalogItemRow | undefined> {
	const [item] = (await Database`SELECT * FROM catalog_items WHERE uuid = ${itemId} AND project = ${projectId}`) as CatalogItemRow[];
	return item;
}

function periodBound(value: string | null, fallback: number): number | null {
	if (value === null || value === "") return fallback;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

Server.app.get("/api/v1/projects/:uuid/items", Auth.required(), Permissions.require(Permission.ITEM_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();

	const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 500);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);
	const search = query.get("search")?.trim() || null;
	const archived = query.get("archived") === "1" ? 1 : 0;
	const pattern = `%${search ?? ""}%`;

	const items = (await Database`
		SELECT * FROM catalog_items
		WHERE project = ${project.uuid} AND archived = ${archived}
			AND (name LIKE ${pattern} OR sku LIKE ${pattern} OR description LIKE ${pattern})
		ORDER BY name ASC, uuid ASC LIMIT ${limit} OFFSET ${offset}
	`) as CatalogItemRow[];

	const [counted] = (await Database`
		SELECT COUNT(*) AS count FROM catalog_items WHERE project = ${project.uuid} AND archived = ${archived}
			AND (name LIKE ${pattern} OR sku LIKE ${pattern} OR description LIKE ${pattern})
	`) as { count: number }[];

	const stock = await stockFor(
		project.uuid,
		items.filter((item) => item.delivers_keys).map((item) => item.uuid)
	);

	return Utils.ok(ctx, { items: items.map((item) => present(item, stock.get(item.uuid))), total: Number(counted.count), limit, offset });
});

Server.app.post("/api/v1/projects/:uuid/items", Auth.required(), Permissions.require(Permission.ITEM_CREATE), async (ctx) => {
	const project = Permissions.project(ctx);

	let data: ItemBody;
	try {
		data = await ctx.body<ItemBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const invalid = validateBody(data, true);
	if (invalid !== null) return Utils.fail(ctx, invalid);

	const uuid = crypto.randomUUID();
	const timestamp = Date.now();

	await Database`
		INSERT INTO catalog_items(uuid, project, name, description, sku, unit_price, currency, tax_rate, supply_type, tax_category, delivers_keys,
			unit, archived, created, updated)
		VALUES(
			${uuid}, ${project.uuid}, ${data.name!.trim()}, ${cleanText(data.description)}, ${cleanText(data.sku)}, ${data.unit_price!},
			${data.currency ?? project.currency}, ${data.tax_category === "exempt" ? 0 : (data.tax_rate ?? 0)}, ${data.supply_type ?? "services"},
			${data.tax_category ?? "standard"}, ${data.delivers_keys ? 1 : 0}, ${data.unit ?? null}, ${data.archived ? 1 : 0}, ${timestamp}, ${timestamp}
		)
	`;

	await Audit.record(ctx, {
		project: project.uuid,
		action: "item.created",
		entityType: "item",
		entityId: uuid,
		newValue: { name: data.name!.trim(), unit_price: data.unit_price, currency: data.currency ?? project.currency, delivers_keys: Boolean(data.delivers_keys) },
	});

	return Utils.ok(ctx, await presentOne(project.uuid, (await findItem(project.uuid, uuid))!), 201);
});

reportRoutes("/api/v1/projects/:uuid/items/stats", "items", (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();

	const from = periodBound(query.get("from"), 0);
	const to = periodBound(query.get("to"), Number.MAX_SAFE_INTEGER);
	if (from === null || to === null || from > to) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	return async () => {
		const rows = (await Database`
			SELECT
				ii.item AS item,
				c.name AS name,
				c.sku AS sku,
				c.archived AS archived,
				i.currency AS currency,
				SUM(CASE WHEN i.status = 'paid' THEN ii.quantity ELSE 0 END) AS sold_quantity,
				SUM(CASE WHEN i.status = 'paid' THEN ii.total_price ELSE 0 END) AS sold_amount,
				COUNT(DISTINCT CASE WHEN i.status = 'paid' THEN i.uuid END) AS sold_invoices,
				SUM(CASE WHEN i.status IN ('open', 'overdue', 'partially_paid') THEN ii.quantity ELSE 0 END) AS pending_quantity,
				SUM(CASE WHEN i.status IN ('open', 'overdue', 'partially_paid') THEN ii.total_price ELSE 0 END) AS pending_amount
			FROM invoice_items ii
			JOIN invoices i ON i.uuid = ii.invoice
			JOIN catalog_items c ON c.uuid = ii.item
			WHERE i.project = ${project.uuid} AND i.created >= ${from} AND i.created <= ${to}
			GROUP BY ii.item, c.name, c.sku, c.archived, i.currency
			ORDER BY sold_amount DESC, pending_amount DESC, c.name ASC
		`) as {
			item: string;
			name: string;
			sku: string | null;
			archived: number;
			currency: string;
			sold_quantity: number;
			sold_amount: number;
			sold_invoices: number;
			pending_quantity: number;
			pending_amount: number;
		}[];

		const items = rows
			.map((row) => ({
				item: row.item,
				name: row.name,
				sku: row.sku,
				archived: Boolean(row.archived),
				currency: row.currency,
				sold_quantity: Number(row.sold_quantity),
				sold_amount: safeInteger(row.sold_amount),
				sold_invoices: safeInteger(row.sold_invoices),
				pending_quantity: Number(row.pending_quantity),
				pending_amount: safeInteger(row.pending_amount),
			}))
			.filter((row) => row.sold_quantity > 0 || row.pending_quantity > 0);

		const totals = new Map<string, { currency: string; sold_amount: number; pending_amount: number }>();
		for (const row of items) {
			const entry = totals.get(row.currency) ?? { currency: row.currency, sold_amount: 0, pending_amount: 0 };
			entry.sold_amount = addIntegers(entry.sold_amount, row.sold_amount);
			entry.pending_amount = addIntegers(entry.pending_amount, row.pending_amount);
			totals.set(row.currency, entry);
		}

		return { from, to, items, totals: [...totals.values()].sort((a, b) => b.sold_amount - a.sold_amount) };
	};
});

Server.app.get("/api/v1/projects/:uuid/items/:item", Auth.required(), Permissions.require(Permission.ITEM_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);

	const itemId = ctx.params["item"];
	if (!Validate.uuid(itemId)) return Utils.fail(ctx, ErrorCode.INVALID_ITEM_ID);

	const item = await findItem(project.uuid, itemId);
	if (!item) return Utils.fail(ctx, ErrorCode.ITEM_NOT_FOUND);

	return Utils.ok(ctx, await presentOne(project.uuid, item));
});

Server.app.patch("/api/v1/projects/:uuid/items/:item", Auth.required(), Permissions.require(Permission.ITEM_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);

	const itemId = ctx.params["item"];
	if (!Validate.uuid(itemId)) return Utils.fail(ctx, ErrorCode.INVALID_ITEM_ID);

	const item = await findItem(project.uuid, itemId);
	if (!item) return Utils.fail(ctx, ErrorCode.ITEM_NOT_FOUND);

	let data: ItemBody;
	try {
		data = await ctx.body<ItemBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const invalid = validateBody(data, false);
	if (invalid !== null) return Utils.fail(ctx, invalid);

	const merged = {
		name: data.name === undefined ? item.name : data.name.trim(),
		description: data.description === undefined ? item.description : cleanText(data.description),
		sku: data.sku === undefined ? item.sku : cleanText(data.sku),
		unit_price: data.unit_price ?? item.unit_price,
		currency: data.currency ?? item.currency,
		tax_category: data.tax_category ?? item.tax_category,
		tax_rate: (data.tax_category ?? item.tax_category) === "exempt" ? 0 : (data.tax_rate ?? item.tax_rate),
		supply_type: data.supply_type ?? item.supply_type,
		delivers_keys: data.delivers_keys === undefined ? item.delivers_keys : data.delivers_keys ? 1 : 0,
		unit: data.unit === undefined ? item.unit : data.unit,
		archived: data.archived === undefined ? item.archived : data.archived ? 1 : 0,
	};

	await Database`
		UPDATE catalog_items SET
			name = ${merged.name}, description = ${merged.description}, sku = ${merged.sku}, unit_price = ${merged.unit_price},
			currency = ${merged.currency}, tax_rate = ${merged.tax_rate}, supply_type = ${merged.supply_type},
			tax_category = ${merged.tax_category}, delivers_keys = ${merged.delivers_keys}, unit = ${merged.unit}, archived = ${merged.archived},
			updated = ${Date.now()}
		WHERE uuid = ${itemId}
	`;

	await Audit.record(ctx, {
		project: project.uuid,
		action: "item.updated",
		entityType: "item",
		entityId: itemId,
		oldValue: { name: item.name, unit_price: item.unit_price, currency: item.currency, archived: Boolean(item.archived) },
		newValue: { name: merged.name, unit_price: merged.unit_price, currency: merged.currency, archived: Boolean(merged.archived) },
	});

	return Utils.ok(ctx, await presentOne(project.uuid, (await findItem(project.uuid, itemId))!));
});

Server.app.delete("/api/v1/projects/:uuid/items/:item", Auth.required(), Permissions.require(Permission.ITEM_DELETE), async (ctx) => {
	const project = Permissions.project(ctx);

	const itemId = ctx.params["item"];
	if (!Validate.uuid(itemId)) return Utils.fail(ctx, ErrorCode.INVALID_ITEM_ID);

	const item = await findItem(project.uuid, itemId);
	if (!item) return Utils.fail(ctx, ErrorCode.ITEM_NOT_FOUND);

	const [used] = (await Database`SELECT COUNT(*) AS count FROM invoice_items WHERE item = ${itemId}`) as { count: number }[];
	if (Number(used.count) > 0) return Utils.fail(ctx, ErrorCode.ITEM_IN_USE);

	const images = (await Database`SELECT uuid, storage_key FROM store_images WHERE item = ${itemId}`) as { uuid: string; storage_key: string }[];
	await Database`DELETE FROM catalog_items WHERE uuid = ${itemId}`;
	await removeStoreImages(images);

	await Audit.record(ctx, {
		project: project.uuid,
		action: "item.deleted",
		entityType: "item",
		entityId: itemId,
		oldValue: { name: item.name, unit_price: item.unit_price, currency: item.currency },
	});

	return Utils.ok(ctx);
});
