import type { SQL } from "bun";
import Database from "../database/database";
import { safeInteger } from "../database/numbers";
import { ErrorCode } from "../errors";
import { isPlausibleIban, normalizeIban } from "../payments/bank";
import { isLocalDate, localDate, startOfLocalDate, zonedParts } from "../timezone";
import Validate from "../validate";
import { isStockQuantity, isStockValue } from "./quantity";
import type { CatalogItemRow, ProjectRow, PurchaseOrderLineRow, PurchaseOrderRow, StockDocumentRow, SupplierRow } from "../database/models";

export const MAX_ORDER_LINES = 500;

export interface SupplierInput {
	name: string;
	tax_number: string | null;
	country: string | null;
	address_line1: string | null;
	postal_code: string | null;
	city: string | null;
	email: string | null;
	phone: string | null;
	iban: string | null;
	bic: string | null;
	payment_days: number | null;
	notes: string | null;
}

function text(value: unknown, limit: number): string | null | undefined {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || value.trim().length > limit) return undefined;
	return value.trim() || null;
}

export function readSupplierInput(data: Record<string, unknown>): SupplierInput | null {
	const name = text(data.name, 240);
	const taxNumber = text(data.tax_number, 80);
	const address = text(data.address_line1, 255);
	const postalCode = text(data.postal_code, 32);
	const city = text(data.city, 120);
	const email = text(data.email, 254);
	const phone = text(data.phone, 64);
	const bic = text(data.bic, 11);
	const notes = text(data.notes, 2000);
	const rawIban = text(data.iban, 42);
	const country = data.country === undefined || data.country === null || data.country === "" ? null : data.country;
	const days = data.payment_days === undefined || data.payment_days === null ? null : data.payment_days;
	if (!name || [taxNumber, address, postalCode, city, email, phone, bic, notes, rawIban].includes(undefined)) return null;
	if (country !== null && (typeof country !== "string" || !Validate.country(country))) return null;
	if (email && !Validate.email(email)) return null;
	if (rawIban && !isPlausibleIban(rawIban)) return null;
	if (bic && !/^[A-Za-z0-9]{8}([A-Za-z0-9]{3})?$/.test(bic)) return null;
	if (days !== null && (typeof days !== "number" || !Number.isSafeInteger(days) || days < 0 || days > 365)) return null;
	return {
		name,
		tax_number: taxNumber ?? null,
		country: country as string | null,
		address_line1: address ?? null,
		postal_code: postalCode ?? null,
		city: city ?? null,
		email: email ?? null,
		phone: phone ?? null,
		iban: rawIban ? normalizeIban(rawIban) : null,
		bic: bic ? bic.toUpperCase() : null,
		payment_days: days as number | null,
		notes: notes ?? null,
	};
}

export function presentSupplier(row: SupplierRow) {
	return { ...row, archived: Boolean(row.archived), payment_days: row.payment_days === null ? null : Number(row.payment_days) };
}

export async function findSupplier(project: string, uuid: string, sql: SQL = Database): Promise<SupplierRow | null> {
	const [row] = (await sql`SELECT * FROM suppliers WHERE uuid = ${uuid} AND project = ${project}`) as SupplierRow[];
	return row ?? null;
}

export async function saveSupplier(project: string, input: SupplierInput, existing: SupplierRow | null): Promise<SupplierRow> {
	const now = Date.now();
	const uuid = existing?.uuid ?? crypto.randomUUID();
	if (existing) {
		await Database`
			UPDATE suppliers SET name = ${input.name}, tax_number = ${input.tax_number}, country = ${input.country}, address_line1 = ${input.address_line1},
				postal_code = ${input.postal_code}, city = ${input.city}, email = ${input.email}, phone = ${input.phone}, iban = ${input.iban}, bic = ${input.bic},
				payment_days = ${input.payment_days}, notes = ${input.notes}, updated = ${now}
			WHERE uuid = ${uuid}
		`;
	} else {
		await Database`
			INSERT INTO suppliers(uuid, project, name, tax_number, country, address_line1, postal_code, city, email, phone, iban, bic, payment_days, notes, archived,
				created, updated)
			VALUES(${uuid}, ${project}, ${input.name}, ${input.tax_number}, ${input.country}, ${input.address_line1}, ${input.postal_code}, ${input.city},
				${input.email}, ${input.phone}, ${input.iban}, ${input.bic}, ${input.payment_days}, ${input.notes}, 0, ${now}, ${now})
		`;
	}
	return (await findSupplier(project, uuid))!;
}

export interface OrderLineInput {
	item: string;
	quantity: number;
	value: number;
	note: string | null;
}

export interface OrderInput {
	supplier: string;
	warehouse: string;
	order_date: number;
	expected_date: number | null;
	supplier_reference: string | null;
	notes: string | null;
	lines: OrderLineInput[];
}

export function readOrderInput(project: Pick<ProjectRow, "timezone">, data: Record<string, unknown>): OrderInput | null {
	const reference = text(data.supplier_reference, 120);
	const notes = text(data.notes, 2000);
	if (!Validate.uuid(data.supplier as string) || !Validate.uuid(data.warehouse as string) || !isLocalDate(data.date)) return null;
	if (reference === undefined || notes === undefined) return null;
	const expected = data.expected_date === undefined || data.expected_date === null || data.expected_date === "" ? null : data.expected_date;
	if (expected !== null && (!isLocalDate(expected) || expected < data.date)) return null;
	if (!Array.isArray(data.lines) || data.lines.length > MAX_ORDER_LINES) return null;
	const lines: OrderLineInput[] = [];
	for (const entry of data.lines as Record<string, unknown>[]) {
		if (typeof entry !== "object" || entry === null) return null;
		const note = text(entry.note, 500);
		const value = entry.value === undefined || entry.value === null ? 0 : entry.value;
		if (!Validate.uuid(entry.item as string) || note === undefined || !isStockQuantity(entry.quantity) || entry.quantity === 0 || !isStockValue(value))
			return null;
		lines.push({ item: entry.item as string, quantity: entry.quantity, value, note });
	}
	return {
		supplier: data.supplier as string,
		warehouse: data.warehouse as string,
		order_date: startOfLocalDate(data.date, project.timezone),
		expected_date: expected === null ? null : startOfLocalDate(expected as string, project.timezone),
		supplier_reference: reference,
		notes,
		lines,
	};
}

async function checkOrder(project: string, input: OrderInput): Promise<ErrorCode | null> {
	const supplier = await findSupplier(project, input.supplier);
	if (!supplier || supplier.archived) return ErrorCode.SUPPLIER_NOT_FOUND;
	const [warehouse] = await Database`SELECT uuid FROM warehouses WHERE uuid = ${input.warehouse} AND project = ${project} AND archived = 0`;
	if (!warehouse) return ErrorCode.WAREHOUSE_NOT_FOUND;
	const items = [...new Set(input.lines.map((line) => line.item))];
	if (items.length === 0) return null;
	const found = (await Database`SELECT uuid, stock_kind FROM catalog_items WHERE project = ${project} AND uuid IN ${Database(items)}`) as Pick<
		CatalogItemRow,
		"uuid" | "stock_kind"
	>[];
	if (found.length !== items.length) return ErrorCode.INVALID_PURCHASE_ORDER;
	return found.some((item) => item.stock_kind === null) ? ErrorCode.STOCK_ITEM_NOT_TRACKED : null;
}

async function writeOrderLines(sql: SQL, project: string, order: string, lines: OrderLineInput[]) {
	await sql`DELETE FROM purchase_order_lines WHERE purchase_order = ${order}`;
	for (const [index, line] of lines.entries()) {
		await sql`
			INSERT INTO purchase_order_lines(uuid, purchase_order, project, item, quantity, value, note, sort_order)
			VALUES(${crypto.randomUUID()}, ${order}, ${project}, ${line.item}, ${line.quantity}, ${line.value}, ${line.note}, ${index})
		`;
	}
}

export async function findOrder(project: string, uuid: string, sql: SQL = Database): Promise<PurchaseOrderRow | null> {
	const [row] = (await sql`SELECT * FROM purchase_orders WHERE uuid = ${uuid} AND project = ${project}`) as PurchaseOrderRow[];
	return row ?? null;
}

export async function orderLines(order: string, sql: SQL = Database): Promise<PurchaseOrderLineRow[]> {
	const rows = (await sql`SELECT * FROM purchase_order_lines WHERE purchase_order = ${order} ORDER BY sort_order ASC`) as PurchaseOrderLineRow[];
	return rows.map((row) => ({ ...row, quantity: safeInteger(row.quantity), value: safeInteger(row.value) }));
}

export async function saveOrder(
	project: ProjectRow,
	input: OrderInput,
	existing: PurchaseOrderRow | null,
	author: string
): Promise<PurchaseOrderRow | ErrorCode> {
	if (existing && existing.status !== "draft") return ErrorCode.PURCHASE_ORDER_STATE;
	const refused = await checkOrder(project.uuid, input);
	if (refused !== null) return refused;
	const uuid = existing?.uuid ?? crypto.randomUUID();
	const now = Date.now();
	await Database.begin(async (tx) => {
		if (existing) {
			await tx`
				UPDATE purchase_orders SET supplier = ${input.supplier}, warehouse = ${input.warehouse}, order_date = ${input.order_date},
					expected_date = ${input.expected_date}, supplier_reference = ${input.supplier_reference}, notes = ${input.notes}, updated = ${now}
				WHERE uuid = ${uuid} AND status = 'draft'
			`;
		} else {
			await tx`
				INSERT INTO purchase_orders(uuid, project, supplier, status, warehouse, order_date, expected_date, supplier_reference, notes, created_by, created, updated)
				VALUES(${uuid}, ${project.uuid}, ${input.supplier}, 'draft', ${input.warehouse}, ${input.order_date}, ${input.expected_date},
					${input.supplier_reference}, ${input.notes}, ${author}, ${now}, ${now})
			`;
		}
		await writeOrderLines(tx, project.uuid, uuid, input.lines);
	});
	return (await findOrder(project.uuid, uuid))!;
}

export async function confirmOrder(project: ProjectRow, order: PurchaseOrderRow, author: string): Promise<PurchaseOrderRow | ErrorCode> {
	if (order.status !== "draft") return ErrorCode.PURCHASE_ORDER_STATE;
	if ((await orderLines(order.uuid)).length === 0) return ErrorCode.INVALID_PURCHASE_ORDER;
	const now = Date.now();
	const year = zonedParts(safeInteger(order.order_date), project.timezone).year;
	await Database.begin(async (tx) => {
		const [last] = (await tx`SELECT MAX(sequence_number) AS last FROM purchase_orders WHERE project = ${project.uuid} AND year = ${year}`) as {
			last: number | null;
		}[];
		const sequence = safeInteger(last?.last ?? 0) + 1;
		await tx`
			UPDATE purchase_orders SET status = 'ordered', year = ${year}, sequence_number = ${sequence},
				number = ${`NA-${year}-${String(sequence).padStart(4, "0")}`}, ordered_by = ${author}, ordered_at = ${now}, updated = ${now}
			WHERE uuid = ${order.uuid} AND status = 'draft'
		`;
	});
	return (await findOrder(project.uuid, order.uuid))!;
}

export async function receivedQuantities(order: string, sql: SQL = Database): Promise<Map<string, number>> {
	const rows = (await sql`
		SELECT l.order_line AS line, SUM(l.quantity) AS quantity
		FROM stock_document_lines l JOIN stock_documents d ON d.uuid = l.document
		WHERE d.purchase_order = ${order} AND d.status = 'posted' AND l.order_line IS NOT NULL GROUP BY l.order_line
	`) as { line: string; quantity: number }[];
	return new Map(rows.map((row) => [row.line, safeInteger(row.quantity)]));
}

export async function refreshOrderStatus(sql: SQL, orderId: string) {
	const [order] = (await sql`SELECT * FROM purchase_orders WHERE uuid = ${orderId}`) as PurchaseOrderRow[];
	if (!order || (order.status !== "ordered" && order.status !== "received")) return;
	const lines = await orderLines(orderId, sql);
	const received = await receivedQuantities(orderId, sql);
	const complete = lines.length > 0 && lines.every((line) => (received.get(line.uuid) ?? 0) >= line.quantity);
	const now = Date.now();
	if (complete && order.status === "ordered") {
		await sql`UPDATE purchase_orders SET status = 'received', closed_at = ${now}, updated = ${now} WHERE uuid = ${orderId}`;
	} else if (!complete && order.status === "received") {
		await sql`UPDATE purchase_orders SET status = 'ordered', closed_at = NULL, updated = ${now} WHERE uuid = ${orderId}`;
	}
}

export async function closeOrder(order: PurchaseOrderRow): Promise<ErrorCode | null> {
	if (order.status !== "ordered") return ErrorCode.PURCHASE_ORDER_STATE;
	const now = Date.now();
	await Database`UPDATE purchase_orders SET status = 'received', closed_at = ${now}, updated = ${now} WHERE uuid = ${order.uuid}`;
	return null;
}

export async function cancelOrder(order: PurchaseOrderRow): Promise<ErrorCode | null> {
	if (order.status === "draft") {
		await Database`DELETE FROM purchase_orders WHERE uuid = ${order.uuid} AND status = 'draft'`;
		return null;
	}
	if (order.status !== "ordered") return ErrorCode.PURCHASE_ORDER_STATE;
	const [received] = await Database`SELECT 1 AS used FROM stock_documents WHERE purchase_order = ${order.uuid} AND status <> 'canceled' LIMIT 1`;
	if (received) return ErrorCode.PURCHASE_ORDER_STATE;
	await Database`UPDATE purchase_orders SET status = 'canceled', updated = ${Date.now()} WHERE uuid = ${order.uuid}`;
	return null;
}

export async function onOrderQuantities(project: string): Promise<Map<string, number>> {
	const rows = (await Database`
		SELECT pl.item AS item, pl.quantity AS quantity,
			COALESCE((SELECT SUM(l.quantity) FROM stock_document_lines l JOIN stock_documents d ON d.uuid = l.document
				WHERE l.order_line = pl.uuid AND d.status = 'posted'), 0) AS received
		FROM purchase_order_lines pl JOIN purchase_orders po ON po.uuid = pl.purchase_order
		WHERE po.project = ${project} AND po.status = 'ordered'
	`) as { item: string; quantity: number; received: number }[];
	const open = new Map<string, number>();
	for (const row of rows) {
		const remaining = safeInteger(row.quantity) - safeInteger(row.received);
		if (remaining > 0) open.set(row.item, (open.get(row.item) ?? 0) + remaining);
	}
	return open;
}

export async function lastSuppliers(project: string): Promise<Map<string, { supplier: string; unit_value: number; quantity: number }>> {
	const rows = (await Database`
		SELECT l.item AS item, po.supplier AS supplier, l.quantity AS quantity, l.value AS value
		FROM stock_document_lines l JOIN stock_documents d ON d.uuid = l.document JOIN purchase_orders po ON po.uuid = d.purchase_order
		WHERE d.project = ${project} AND d.status = 'posted' AND d.document_type = 'receipt'
		ORDER BY d.posted_at ASC
	`) as { item: string; supplier: string; quantity: number; value: number | null }[];
	return new Map(rows.map((row) => [row.item, { supplier: row.supplier, unit_value: safeInteger(row.value ?? 0), quantity: safeInteger(row.quantity) }]));
}

export async function presentOrder(project: ProjectRow, order: PurchaseOrderRow) {
	const lines = await orderLines(order.uuid);
	const received = await receivedQuantities(order.uuid);
	const items = lines.length
		? ((await Database`SELECT uuid, name, sku, unit FROM catalog_items WHERE uuid IN ${Database(lines.map((line) => line.item))}`) as Pick<
				CatalogItemRow,
				"uuid" | "name" | "sku" | "unit"
			>[])
		: [];
	const names = new Map(items.map((item) => [item.uuid, item]));
	const supplier = await findSupplier(project.uuid, order.supplier);
	const receipts = (await Database`
		SELECT d.uuid, d.number, d.status, d.document_date, d.expense,
			(SELECT COALESCE(SUM(m.value), 0) FROM stock_movements m WHERE m.document = d.uuid) AS value
		FROM stock_documents d WHERE d.purchase_order = ${order.uuid} ORDER BY d.created ASC
	`) as (Pick<StockDocumentRow, "uuid" | "number" | "status" | "document_date" | "expense"> & { value: number })[];
	const expenseIds = [...new Set(receipts.filter((receipt) => receipt.status === "posted" && receipt.expense).map((receipt) => receipt.expense!))];
	const invoices = expenseIds.length
		? ((await Database`
				SELECT uuid, invoice_number, expense_date, currency, total_amount, tax_amount, paid_at FROM expenses WHERE uuid IN ${Database(expenseIds)}
			`) as {
				uuid: string;
				invoice_number: string | null;
				expense_date: number;
				currency: string;
				total_amount: number;
				tax_amount: number;
				paid_at: number | null;
			}[])
		: [];
	const date = (value: number | null) => (value === null ? null : localDate(safeInteger(value), project.timezone));
	return {
		...order,
		date: date(order.order_date),
		expected_date: date(order.expected_date),
		currency: project.tax_currency ?? project.currency,
		supplier: supplier ? presentSupplier(supplier) : null,
		ordered_value: lines.reduce((sum, line) => sum + line.value, 0),
		received_value: receipts.filter((receipt) => receipt.status === "posted").reduce((sum, receipt) => sum + safeInteger(receipt.value), 0),
		invoiced_value: invoices.reduce((sum, invoice) => sum + safeInteger(invoice.total_amount) - safeInteger(invoice.tax_amount), 0),
		lines: lines.map((line) => {
			const item = names.get(line.item);
			const got = received.get(line.uuid) ?? 0;
			return { ...line, name: item?.name ?? "", sku: item?.sku ?? null, unit: item?.unit ?? null, received: got, remaining: Math.max(line.quantity - got, 0) };
		}),
		receipts: receipts.map((receipt) => ({
			uuid: receipt.uuid,
			number: receipt.number,
			status: receipt.status,
			date: date(receipt.document_date),
			value: safeInteger(receipt.value),
		})),
		invoices: invoices.map((invoice) => ({
			uuid: invoice.uuid,
			invoice_number: invoice.invoice_number,
			date: date(invoice.expense_date),
			currency: invoice.currency,
			net_amount: safeInteger(invoice.total_amount) - safeInteger(invoice.tax_amount),
			paid: invoice.paid_at !== null,
		})),
	};
}
