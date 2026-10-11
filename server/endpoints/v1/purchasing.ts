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
import { localDate } from "../../timezone";
import {
	cancelOrder,
	closeOrder,
	confirmOrder,
	findOrder,
	findSupplier,
	lastSuppliers,
	onOrderQuantities,
	presentOrder,
	presentSupplier,
	readOrderInput,
	readSupplierInput,
	saveOrder,
	saveSupplier,
} from "../../inventory/purchasing";
import { stockList } from "../../inventory/reports";
import type { AppState, PurchaseOrderRow, PurchaseOrderStatus, SupplierRow } from "../../database/models";

const base = "/api/v1/projects/:uuid/inventory";
const view = [Auth.required(), Permissions.require(Permission.STOCK_VIEW)] as const;
const edit = [Auth.required(), Permissions.require(Permission.STOCK_EDIT)] as const;
const ORDER_STATUSES: PurchaseOrderStatus[] = ["draft", "ordered", "received", "canceled"];

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

Server.app.get(`${base}/suppliers`, ...view, async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();
	const pattern = `%${query.get("search")?.trim() ?? ""}%`;
	const archived = query.get("archived") === "1" ? 1 : 0;
	const rows = (await Database`
		SELECT * FROM suppliers WHERE project = ${project.uuid} AND archived = ${archived}
			AND (name LIKE ${pattern} OR COALESCE(tax_number, '') LIKE ${pattern})
		ORDER BY name ASC LIMIT 500
	`) as SupplierRow[];
	return Utils.ok(ctx, { suppliers: rows.map(presentSupplier) });
});

Server.app.post(`${base}/suppliers`, ...edit, async (ctx) => {
	const refused = licensed(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const data = await body(ctx);
	const input = data ? readSupplierInput(data) : null;
	if (!input) return Utils.fail(ctx, ErrorCode.INVALID_SUPPLIER);
	const created = await saveSupplier(project.uuid, input, null);
	await audit(ctx, "supplier.created", "supplier", created.uuid, { name: created.name });
	return Utils.ok(ctx, presentSupplier(created), 201);
});

Server.app.put(`${base}/suppliers/:supplier`, ...edit, async (ctx) => {
	const refused = licensed(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const supplier = Validate.uuid(ctx.params["supplier"]) ? await findSupplier(project.uuid, ctx.params["supplier"]) : null;
	if (!supplier) return Utils.fail(ctx, ErrorCode.SUPPLIER_NOT_FOUND);
	const data = await body(ctx);
	const input = data ? readSupplierInput(data) : null;
	if (!input || (data!.archived !== undefined && typeof data!.archived !== "boolean")) return Utils.fail(ctx, ErrorCode.INVALID_SUPPLIER);
	const saved = await saveSupplier(project.uuid, input, supplier);
	if (typeof data!.archived === "boolean") {
		await Database`UPDATE suppliers SET archived = ${data!.archived ? 1 : 0}, updated = ${Date.now()} WHERE uuid = ${supplier.uuid}`;
	}
	await audit(ctx, "supplier.updated", "supplier", supplier.uuid, { name: saved.name }, { name: supplier.name });
	return Utils.ok(ctx, presentSupplier((await findSupplier(project.uuid, supplier.uuid))!));
});

Server.app.delete(`${base}/suppliers/:supplier`, ...edit, async (ctx) => {
	const refused = licensed(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const supplier = Validate.uuid(ctx.params["supplier"]) ? await findSupplier(project.uuid, ctx.params["supplier"]) : null;
	if (!supplier) return Utils.fail(ctx, ErrorCode.SUPPLIER_NOT_FOUND);
	const [used] = await Database`SELECT 1 AS used FROM purchase_orders WHERE supplier = ${supplier.uuid} LIMIT 1`;
	if (used) return Utils.fail(ctx, ErrorCode.SUPPLIER_IN_USE);
	await Database`DELETE FROM suppliers WHERE uuid = ${supplier.uuid}`;
	await audit(ctx, "supplier.deleted", "supplier", supplier.uuid, undefined, { name: supplier.name });
	return Utils.ok(ctx);
});

Server.app.get(`${base}/orders`, ...view, async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();
	const status = ORDER_STATUSES.includes(query.get("status") as PurchaseOrderStatus) ? query.get("status") : null;
	const pattern = `%${query.get("search")?.trim() ?? ""}%`;
	const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 500);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);
	const inStatus = status ? Database`AND po.status = ${status}` : Database``;
	const where = Database`po.project = ${project.uuid} ${inStatus} AND (COALESCE(po.number, '') LIKE ${pattern} OR s.name LIKE ${pattern})`;
	const rows = (await Database`
		SELECT po.*, s.name AS supplier_name,
			(SELECT COALESCE(SUM(pl.value), 0) FROM purchase_order_lines pl WHERE pl.purchase_order = po.uuid) AS ordered_value,
			(SELECT COALESCE(SUM(pl.quantity), 0) FROM purchase_order_lines pl WHERE pl.purchase_order = po.uuid) AS ordered_quantity,
			(SELECT COALESCE(SUM(l.quantity), 0) FROM stock_document_lines l JOIN stock_documents d ON d.uuid = l.document
				WHERE d.purchase_order = po.uuid AND d.status = 'posted' AND l.order_line IS NOT NULL) AS received_quantity
		FROM purchase_orders po JOIN suppliers s ON s.uuid = po.supplier
		WHERE ${where} ORDER BY po.order_date DESC, po.created DESC LIMIT ${limit} OFFSET ${offset}
	`) as (PurchaseOrderRow & { supplier_name: string; ordered_value: number; ordered_quantity: number; received_quantity: number })[];
	const [counted] = (await Database`SELECT COUNT(*) AS count FROM purchase_orders po JOIN suppliers s ON s.uuid = po.supplier WHERE ${where}`) as {
		count: number;
	}[];
	return Utils.ok(ctx, {
		currency: project.tax_currency ?? project.currency,
		orders: rows.map((row) => ({
			uuid: row.uuid,
			number: row.number,
			status: row.status,
			supplier: row.supplier,
			supplier_name: row.supplier_name,
			date: localDate(safeInteger(row.order_date), project.timezone),
			expected_date: row.expected_date === null ? null : localDate(safeInteger(row.expected_date), project.timezone),
			value: safeInteger(row.ordered_value),
			ordered_quantity: safeInteger(row.ordered_quantity),
			received_quantity: safeInteger(row.received_quantity),
		})),
		total: Number(counted.count),
		limit,
		offset,
	});
});

async function loadOrder(ctx: Context<AppState>): Promise<PurchaseOrderRow | null> {
	const uuid = ctx.params["order"];
	return Validate.uuid(uuid) ? findOrder(Permissions.project(ctx).uuid, uuid) : null;
}

Server.app.post(`${base}/orders`, ...edit, async (ctx) => {
	const refused = licensed(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const data = await body(ctx);
	const input = data ? readOrderInput(project, data) : null;
	if (!input) return Utils.fail(ctx, ErrorCode.INVALID_PURCHASE_ORDER);
	const saved = await saveOrder(project, input, null, Auth.account(ctx).username);
	if (typeof saved === "number") return Utils.fail(ctx, saved);
	await audit(ctx, "purchase_order.created", "purchase_order", saved.uuid, { supplier: saved.supplier, lines: input.lines.length });
	return Utils.ok(ctx, await presentOrder(project, saved), 201);
});

Server.app.get(`${base}/orders/:order`, ...view, async (ctx) => {
	const order = await loadOrder(ctx);
	if (!order) return Utils.fail(ctx, ErrorCode.PURCHASE_ORDER_NOT_FOUND);
	return Utils.ok(ctx, await presentOrder(Permissions.project(ctx), order));
});

Server.app.put(`${base}/orders/:order`, ...edit, async (ctx) => {
	const refused = licensed(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const order = await loadOrder(ctx);
	if (!order) return Utils.fail(ctx, ErrorCode.PURCHASE_ORDER_NOT_FOUND);
	const data = await body(ctx);
	const input = data ? readOrderInput(project, data) : null;
	if (!input) return Utils.fail(ctx, ErrorCode.INVALID_PURCHASE_ORDER);
	const saved = await saveOrder(project, input, order, Auth.account(ctx).username);
	if (typeof saved === "number") return Utils.fail(ctx, saved);
	return Utils.ok(ctx, await presentOrder(project, saved));
});

for (const action of ["confirm", "close", "cancel"] as const) {
	Server.app.post(`${base}/orders/:order/${action}`, ...edit, async (ctx) => {
		const refused = licensed(ctx);
		if (refused) return refused;
		const project = Permissions.project(ctx);
		const order = await loadOrder(ctx);
		if (!order) return Utils.fail(ctx, ErrorCode.PURCHASE_ORDER_NOT_FOUND);
		if (action === "confirm") {
			const confirmed = await confirmOrder(project, order, Auth.account(ctx).username);
			if (typeof confirmed === "number") return Utils.fail(ctx, confirmed);
			await audit(ctx, "purchase_order.confirmed", "purchase_order", order.uuid, { number: confirmed.number });
			return Utils.ok(ctx, await presentOrder(project, confirmed));
		}
		const failed = action === "close" ? await closeOrder(order) : await cancelOrder(order);
		if (failed !== null) return Utils.fail(ctx, failed);
		await audit(ctx, `purchase_order.${action === "close" ? "closed" : "canceled"}`, "purchase_order", order.uuid, { number: order.number });
		const current = await findOrder(project.uuid, order.uuid);
		return Utils.ok(ctx, current ? await presentOrder(project, current) : null);
	});
}

Server.app.get(`${base}/reorder`, ...view, async (ctx) => {
	const project = Permissions.project(ctx);
	const rows = await stockList(project.uuid, { warehouse: null, search: null, filter: "all" });
	const ordered = await onOrderQuantities(project.uuid);
	const suppliers = await lastSuppliers(project.uuid);
	const known = new Map(
		((await Database`SELECT uuid, name FROM suppliers WHERE project = ${project.uuid} AND archived = 0`) as Pick<SupplierRow, "uuid" | "name">[]).map((row) => [
			row.uuid,
			row.name,
		])
	);
	const items = rows
		.filter((row) => !row.archived && row.minimum !== null && row.quantity + (ordered.get(row.item) ?? 0) < row.minimum)
		.map((row) => {
			const last = suppliers.get(row.item);
			const onOrder = ordered.get(row.item) ?? 0;
			const supplier = last && known.has(last.supplier) ? last.supplier : null;
			return {
				item: row.item,
				name: row.name,
				sku: row.sku,
				unit: row.unit,
				quantity: row.quantity,
				minimum: row.minimum!,
				on_order: onOrder,
				suggested: row.minimum! - row.quantity - onOrder,
				supplier,
				supplier_name: supplier ? known.get(supplier)! : null,
				last_quantity: last?.quantity ?? null,
				last_value: last?.unit_value ?? null,
			};
		});
	return Utils.ok(ctx, { currency: project.tax_currency ?? project.currency, items });
});
