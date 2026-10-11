import type { SQL } from "bun";
import Database from "../database/database";
import { safeInteger } from "../database/numbers";
import { accountingPeriodLocked, closedYear } from "../accounting-periods";
import { ErrorCode } from "../errors";
import { allocateDiscount } from "../invoicing";
import { endOfLocalDate, isLocalDate, localDate, startOfLocalDate, zonedParts } from "../timezone";
import { inventoryConfig } from "./config";
import { isStockQuantity, isStockValue } from "./quantity";
import { insertMovements, quantitiesOnHand, revalue, stateThrough, withInventory, type NewMovement } from "./stock";
import { onHand } from "./valuation";
import { refreshOrderStatus } from "./purchasing";
import type {
	CatalogItemRow,
	OpeningOffset,
	ProjectRow,
	StockDocumentLineRow,
	StockDocumentRow,
	StockDocumentType,
	StockIssueReason,
	StockMovementRow,
	StockReceiptReason,
	WarehouseRow,
} from "../database/models";

export const STOCK_DOCUMENT_TYPES: StockDocumentType[] = ["receipt", "issue", "transfer", "stocktake", "opening"];
export const ISSUE_REASONS: StockIssueReason[] = [
	"consumption",
	"own_use",
	"gift",
	"damage",
	"expiry",
	"shortage",
	"natural_loss",
	"theft",
	"force_majeure",
	"supplier_return",
];
export const RECEIPT_REASONS: StockReceiptReason[] = ["purchase", "customer_return", "other"];
export const TAXABLE_ISSUE_REASONS: StockIssueReason[] = ["own_use", "gift", "shortage"];
export const MAX_DOCUMENT_LINES = 2000;

const NUMBER_PREFIX: Record<StockDocumentType, string> = { receipt: "PR", issue: "IZ", transfer: "MP", stocktake: "IN", opening: "OT" };

export interface StockLineInput {
	item: string;
	quantity: number;
	value: number | null;
	tax_rate: number | null;
	note: string | null;
	order_line: string | null;
}

export interface StockDocumentInput {
	document_type: StockDocumentType;
	warehouse: string;
	target_warehouse: string | null;
	document_date: number;
	reason: string | null;
	partner: string | null;
	partner_tax_number: string | null;
	external_reference: string | null;
	expense: string | null;
	invoice: string | null;
	extra_costs: number;
	charge_vat: boolean;
	opening_offset: OpeningOffset | null;
	ledger_account: string | null;
	purchase_order: string | null;
	notes: string | null;
	lines: StockLineInput[];
}

function text(value: unknown, limit: number): string | null | undefined {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || value.trim().length > limit) return undefined;
	return value.trim() || null;
}

function uuidOrNull(value: unknown): string | null | undefined {
	if (value === undefined || value === null || value === "") return null;
	return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined;
}

function readLines(type: StockDocumentType, value: unknown): StockLineInput[] | null {
	if (!Array.isArray(value) || value.length > MAX_DOCUMENT_LINES) return null;
	const valued = type === "receipt" || type === "opening";
	const lines: StockLineInput[] = [];
	for (const entry of value as Record<string, unknown>[]) {
		if (typeof entry !== "object" || entry === null) return null;
		const item = uuidOrNull(entry.item);
		const note = text(entry.note, 500);
		if (!item || note === undefined || !isStockQuantity(entry.quantity)) return null;
		if (type !== "stocktake" && entry.quantity === 0) return null;
		const lineValue = entry.value === undefined || entry.value === null ? null : entry.value;
		if (lineValue !== null && !isStockValue(lineValue)) return null;
		const rate = entry.tax_rate === undefined || entry.tax_rate === null ? null : entry.tax_rate;
		if (rate !== null && (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 100)) return null;
		const orderLine = uuidOrNull(entry.order_line);
		if (orderLine === undefined) return null;
		lines.push({
			item,
			quantity: entry.quantity,
			value: valued ? (lineValue as number | null) : null,
			tax_rate: type === "issue" ? rate : null,
			note,
			order_line: type === "receipt" ? orderLine : null,
		});
	}
	if (type === "stocktake" && new Set(lines.map((line) => line.item)).size !== lines.length) return null;
	return lines;
}

export function readDocumentInput(project: Pick<ProjectRow, "timezone">, data: Record<string, unknown>): StockDocumentInput | null {
	const type = data.document_type;
	if (typeof type !== "string" || !STOCK_DOCUMENT_TYPES.includes(type as StockDocumentType)) return null;
	const documentType = type as StockDocumentType;
	const warehouse = uuidOrNull(data.warehouse);
	const target = uuidOrNull(data.target_warehouse);
	const expense = uuidOrNull(data.expense);
	const invoice = uuidOrNull(data.invoice);
	const account = uuidOrNull(data.ledger_account);
	const order = uuidOrNull(data.purchase_order);
	const partner = text(data.partner, 240);
	const partnerTax = text(data.partner_tax_number, 80);
	const reference = text(data.external_reference, 120);
	const notes = text(data.notes, 2000);
	const lines = readLines(documentType, data.lines);
	if (!warehouse || target === undefined || expense === undefined || invoice === undefined || account === undefined || order === undefined) return null;
	if (partner === undefined || partnerTax === undefined || reference === undefined || notes === undefined || lines === null) return null;
	if (!isLocalDate(data.date)) return null;
	if (documentType === "transfer" ? !target || target === warehouse : target !== null) return null;

	let reason: string | null = null;
	if (documentType === "issue") {
		if (typeof data.reason !== "string" || !ISSUE_REASONS.includes(data.reason as StockIssueReason)) return null;
		reason = data.reason;
	}
	if (documentType === "receipt") {
		const chosen = data.reason ?? "purchase";
		if (typeof chosen !== "string" || !RECEIPT_REASONS.includes(chosen as StockReceiptReason)) return null;
		reason = chosen;
	}
	const purchase = documentType === "receipt" && reason === "purchase";
	const extraCosts = data.extra_costs === undefined || data.extra_costs === null ? 0 : data.extra_costs;
	if (!isStockValue(extraCosts) || (extraCosts > 0 && !purchase)) return null;
	if (data.charge_vat !== undefined && typeof data.charge_vat !== "boolean") return null;
	const offset = data.opening_offset ?? "none";
	if (offset !== "none" && offset !== "expense") return null;
	const chargesVat = documentType === "issue" || documentType === "stocktake";

	return {
		document_type: documentType,
		warehouse,
		target_warehouse: target,
		document_date: startOfLocalDate(data.date, project.timezone),
		reason,
		partner: documentType === "receipt" ? partner : null,
		partner_tax_number: documentType === "receipt" ? partnerTax : null,
		external_reference: reference,
		expense: purchase ? expense : null,
		invoice: documentType === "receipt" && reason === "customer_return" ? invoice : null,
		extra_costs: extraCosts,
		charge_vat: chargesVat && data.charge_vat === true,
		opening_offset: documentType === "opening" ? offset : null,
		ledger_account: documentType === "issue" ? account : null,
		purchase_order: purchase ? order : null,
		notes,
		lines,
	};
}

async function activeWarehouse(sql: SQL, project: string, uuid: string): Promise<WarehouseRow | null> {
	const [row] = (await sql`SELECT * FROM warehouses WHERE uuid = ${uuid} AND project = ${project} AND archived = 0`) as WarehouseRow[];
	return row ?? null;
}

async function checkReferences(sql: SQL, project: string, input: StockDocumentInput): Promise<ErrorCode | null> {
	if (!(await activeWarehouse(sql, project, input.warehouse))) return ErrorCode.WAREHOUSE_NOT_FOUND;
	if (input.target_warehouse && !(await activeWarehouse(sql, project, input.target_warehouse))) return ErrorCode.WAREHOUSE_NOT_FOUND;
	if (input.expense) {
		const [expense] = await sql`SELECT uuid FROM expenses WHERE uuid = ${input.expense} AND project = ${project}`;
		if (!expense) return ErrorCode.INVALID_STOCK_DOCUMENT;
	}
	if (input.invoice) {
		const [invoice] = await sql`SELECT uuid FROM invoices WHERE uuid = ${input.invoice} AND project = ${project} AND issued_at IS NOT NULL`;
		if (!invoice) return ErrorCode.INVALID_STOCK_DOCUMENT;
	}
	if (input.ledger_account) {
		const [account] = await sql`SELECT uuid FROM ledger_accounts WHERE uuid = ${input.ledger_account} AND project = ${project} AND active = 1`;
		if (!account) return ErrorCode.INVALID_STOCK_DOCUMENT;
	}
	const orderLineIds = input.lines.map((line) => line.order_line).filter((line): line is string => line !== null);
	if (input.purchase_order) {
		const [order] =
			await sql`SELECT uuid FROM purchase_orders WHERE uuid = ${input.purchase_order} AND project = ${project} AND status IN ('ordered', 'received')`;
		if (!order) return ErrorCode.PURCHASE_ORDER_NOT_FOUND;
		const known = orderLineIds.length
			? ((await sql`SELECT uuid, item FROM purchase_order_lines WHERE purchase_order = ${input.purchase_order} AND uuid IN ${sql(orderLineIds)}`) as {
					uuid: string;
					item: string;
				}[])
			: [];
		const itemOf = new Map(known.map((line) => [line.uuid, line.item]));
		if (input.lines.some((line) => line.order_line !== null && itemOf.get(line.order_line) !== line.item)) return ErrorCode.INVALID_STOCK_DOCUMENT;
	} else if (orderLineIds.length > 0) return ErrorCode.INVALID_STOCK_DOCUMENT;
	const items = [...new Set(input.lines.map((line) => line.item))];
	if (items.length === 0) return null;
	const found = (await sql`SELECT uuid, stock_kind FROM catalog_items WHERE project = ${project} AND uuid IN ${sql(items)}`) as Pick<
		CatalogItemRow,
		"uuid" | "stock_kind"
	>[];
	if (found.length !== items.length) return ErrorCode.INVALID_STOCK_DOCUMENT;
	if (found.some((item) => item.stock_kind === null)) return ErrorCode.STOCK_ITEM_NOT_TRACKED;
	return null;
}

async function writeLines(sql: SQL, project: string, document: string, input: StockDocumentInput) {
	await sql`DELETE FROM stock_document_lines WHERE document = ${document}`;
	const items = [...new Set(input.lines.map((line) => line.item))];
	const rates =
		input.document_type === "issue" && items.length > 0
			? new Map(
					((await sql`SELECT uuid, tax_rate FROM catalog_items WHERE uuid IN ${sql(items)}`) as Pick<CatalogItemRow, "uuid" | "tax_rate">[]).map((item) => [
						item.uuid,
						Number(item.tax_rate),
					])
				)
			: new Map<string, number>();
	for (const [index, line] of input.lines.entries()) {
		await sql`
			INSERT INTO stock_document_lines(uuid, document, project, item, quantity, value, expected_quantity, tax_rate, note, sort_order, order_line)
			VALUES(${crypto.randomUUID()}, ${document}, ${project}, ${line.item}, ${line.quantity}, ${line.value}, NULL,
				${input.document_type === "issue" ? (line.tax_rate ?? rates.get(line.item) ?? 0) : null}, ${line.note}, ${index}, ${line.order_line})
		`;
	}
}

export async function findDocument(project: string, uuid: string, sql: SQL = Database): Promise<StockDocumentRow | null> {
	const [row] = (await sql`SELECT * FROM stock_documents WHERE uuid = ${uuid} AND project = ${project}`) as StockDocumentRow[];
	return row ?? null;
}

export async function documentLines(document: string, sql: SQL = Database): Promise<StockDocumentLineRow[]> {
	const rows = (await sql`SELECT * FROM stock_document_lines WHERE document = ${document} ORDER BY sort_order ASC`) as StockDocumentLineRow[];
	return rows.map((row) => ({
		...row,
		quantity: safeInteger(row.quantity),
		value: row.value === null ? null : safeInteger(row.value),
		expected_quantity: row.expected_quantity === null ? null : safeInteger(row.expected_quantity),
		tax_rate: row.tax_rate === null ? null : Number(row.tax_rate),
	}));
}

export async function createDraft(project: ProjectRow, input: StockDocumentInput, author: string): Promise<StockDocumentRow | ErrorCode> {
	const refused = await checkReferences(Database, project.uuid, input);
	if (refused !== null) return refused;
	const uuid = crypto.randomUUID();
	const now = Date.now();
	await Database.begin(async (tx) => {
		await tx`
			INSERT INTO stock_documents(uuid, project, document_type, status, warehouse, target_warehouse, document_date, reason, partner, partner_tax_number,
				external_reference, expense, invoice, extra_costs, charge_vat, opening_offset, ledger_account, purchase_order, notes, created_by, created, updated)
			VALUES(${uuid}, ${project.uuid}, ${input.document_type}, 'draft', ${input.warehouse}, ${input.target_warehouse}, ${input.document_date}, ${input.reason},
				${input.partner}, ${input.partner_tax_number}, ${input.external_reference}, ${input.expense}, ${input.invoice}, ${input.extra_costs},
				${input.charge_vat ? 1 : 0}, ${input.opening_offset}, ${input.ledger_account}, ${input.purchase_order}, ${input.notes}, ${author}, ${now}, ${now})
		`;
		await writeLines(tx, project.uuid, uuid, input);
	});
	return (await findDocument(project.uuid, uuid))!;
}

export async function updateDraft(project: ProjectRow, document: StockDocumentRow, input: StockDocumentInput): Promise<StockDocumentRow | ErrorCode> {
	if (document.status !== "draft") return ErrorCode.STOCK_DOCUMENT_NOT_DRAFT;
	if (input.document_type !== document.document_type) return ErrorCode.INVALID_STOCK_DOCUMENT;
	const refused = await checkReferences(Database, project.uuid, input);
	if (refused !== null) return refused;
	await Database.begin(async (tx) => {
		await tx`
			UPDATE stock_documents SET warehouse = ${input.warehouse}, target_warehouse = ${input.target_warehouse}, document_date = ${input.document_date},
				reason = ${input.reason}, partner = ${input.partner}, partner_tax_number = ${input.partner_tax_number},
				external_reference = ${input.external_reference}, expense = ${input.expense}, invoice = ${input.invoice}, extra_costs = ${input.extra_costs},
				charge_vat = ${input.charge_vat ? 1 : 0}, opening_offset = ${input.opening_offset}, ledger_account = ${input.ledger_account}, purchase_order = ${input.purchase_order}, notes = ${input.notes},
				updated = ${Date.now()}
			WHERE uuid = ${document.uuid} AND status = 'draft'
		`;
		await writeLines(tx, project.uuid, document.uuid, input);
	});
	return (await findDocument(project.uuid, document.uuid))!;
}

export async function deleteDraft(document: StockDocumentRow): Promise<ErrorCode | null> {
	if (document.status !== "draft") return ErrorCode.STOCK_DOCUMENT_NOT_DRAFT;
	await Database`DELETE FROM stock_documents WHERE uuid = ${document.uuid} AND status = 'draft'`;
	return null;
}

export function documentMoment(document: Pick<StockDocumentRow, "document_type" | "document_date">, timezone: string, now: number): number {
	const day = localDate(safeInteger(document.document_date), timezone);
	if (day === localDate(now, timezone)) return now;
	return document.document_type === "stocktake" ? endOfLocalDate(day, timezone) : startOfLocalDate(day, timezone);
}

function stocktakeMoment(document: Pick<StockDocumentRow, "document_date" | "posted_at">, timezone: string): number {
	const dayEnd = endOfLocalDate(localDate(safeInteger(document.document_date), timezone), timezone);
	return document.posted_at === null ? dayEnd : Math.min(dayEnd, safeInteger(document.posted_at));
}

async function countedLater(sql: SQL, project: ProjectRow, document: StockDocumentRow, lines: StockDocumentLineRow[], moment: number): Promise<boolean> {
	const items = [...new Set(lines.map((line) => line.item))];
	const places = [document.warehouse, document.target_warehouse].filter((value): value is string => value !== null);
	if (items.length === 0) return false;
	const stocktakes = (await sql`
		SELECT DISTINCT d.uuid, d.document_date, d.posted_at FROM stock_documents d JOIN stock_document_lines l ON l.document = d.uuid
		WHERE d.project = ${project.uuid} AND d.document_type = 'stocktake' AND d.status = 'posted' AND d.uuid <> ${document.uuid}
			AND d.warehouse IN ${sql(places)} AND l.item IN ${sql(items)}
	`) as Pick<StockDocumentRow, "uuid" | "document_date" | "posted_at">[];
	return stocktakes.some((stocktake) => stocktakeMoment(stocktake, project.timezone) >= moment);
}

async function nextNumber(sql: SQL, project: string, type: StockDocumentType, year: number): Promise<{ sequence: number; number: string }> {
	const [last] = (await sql`
		SELECT MAX(sequence_number) AS last FROM stock_documents WHERE project = ${project} AND document_type = ${type} AND year = ${year}
	`) as { last: number | null }[];
	const sequence = safeInteger(last?.last ?? 0) + 1;
	return { sequence, number: `${NUMBER_PREFIX[type]}-${year}-${String(sequence).padStart(4, "0")}` };
}

async function returnSources(sql: SQL, invoice: string, lines: StockDocumentLineRow[]): Promise<Map<string, string> | ErrorCode> {
	const sales = (await sql`
		SELECT uuid, item, quantity FROM stock_movements WHERE invoice = ${invoice} AND movement_kind = 'sale' ORDER BY sequence ASC
	`) as Pick<StockMovementRow, "uuid" | "item" | "quantity">[];
	const returned = (await sql`
		SELECT item, SUM(quantity) AS quantity FROM stock_movements
		WHERE invoice = ${invoice} AND movement_kind IN ('customer_return', 'sale_return') GROUP BY item
	`) as { item: string; quantity: number }[];
	const sources = new Map<string, string>();
	for (const item of new Set(lines.map((line) => line.item))) {
		const sold = sales.filter((sale) => sale.item === item);
		const soldQuantity = sold.reduce((sum, sale) => sum - safeInteger(sale.quantity), 0);
		const alreadyBack = safeInteger(returned.find((row) => row.item === item)?.quantity ?? 0);
		const wanted = lines.filter((line) => line.item === item).reduce((sum, line) => sum + line.quantity, 0);
		if (sold.length === 0 || wanted + alreadyBack > soldQuantity) return ErrorCode.STOCK_RETURN_EXCEEDS_SALE;
		sources.set(item, sold[0].uuid);
	}
	return sources;
}

function landedValues(document: StockDocumentRow, lines: StockDocumentLineRow[]): number[] {
	const values = lines.map((line) => line.value ?? 0);
	const extra = safeInteger(document.extra_costs);
	if (extra === 0) return values;
	const basis = values.some((value) => value > 0) ? values : lines.map((line) => line.quantity);
	const shares = allocateDiscount(basis, extra);
	return values.map((value, index) => value + shares[index]);
}

export async function postDocument(project: ProjectRow, uuid: string, author: string): Promise<StockDocumentRow | ErrorCode> {
	return withInventory(project.uuid, async () => {
		const document = await findDocument(project.uuid, uuid);
		if (!document) return ErrorCode.STOCK_DOCUMENT_NOT_FOUND;
		if (document.status !== "draft") return ErrorCode.STOCK_DOCUMENT_NOT_DRAFT;
		const lines = await documentLines(uuid);
		if (lines.length === 0) return ErrorCode.INVALID_STOCK_DOCUMENT;
		const now = Date.now();
		const timezone = project.timezone;
		const day = localDate(safeInteger(document.document_date), timezone);
		if (day > localDate(now, timezone)) return ErrorCode.STOCK_DATE_IN_FUTURE;
		const moment = documentMoment(document, timezone, now);
		if (await closedYear(project.uuid, moment)) return ErrorCode.YEAR_CLOSED;
		if (document.charge_vat && (await accountingPeriodLocked(project.uuid, moment))) return ErrorCode.ACCOUNTING_PERIOD_LOCKED;
		if (await countedLater(Database, project, document, lines, moment)) return ErrorCode.STOCK_COUNTED_LATER;
		const tracked = (await Database`
			SELECT uuid FROM catalog_items WHERE project = ${project.uuid} AND stock_kind IS NOT NULL AND uuid IN ${Database(lines.map((line) => line.item))}
		`) as { uuid: string }[];
		if (tracked.length !== new Set(lines.map((line) => line.item)).size) return ErrorCode.STOCK_ITEM_NOT_TRACKED;
		for (const place of [document.warehouse, document.target_warehouse]) {
			if (place && !(await activeWarehouse(Database, project.uuid, place))) return ErrorCode.WAREHOUSE_NOT_FOUND;
		}

		const config = await inventoryConfig(project.uuid);
		const outgoing = document.document_type === "issue" || document.document_type === "transfer";
		if (outgoing && !config.negative_stock) {
			const available = await quantitiesOnHand(
				Database,
				document.warehouse,
				lines.map((line) => line.item)
			);
			const wanted = new Map<string, number>();
			for (const line of lines) wanted.set(line.item, (wanted.get(line.item) ?? 0) + line.quantity);
			for (const [item, quantity] of wanted) if ((available.get(item) ?? 0) < quantity) return ErrorCode.INSUFFICIENT_STOCK;
		}

		let sources = new Map<string, string>();
		if (document.document_type === "receipt" && document.reason === "customer_return" && document.invoice) {
			const found = await returnSources(Database, document.invoice, lines);
			if (!(found instanceof Map)) return found;
			sources = found;
		}

		const movements: NewMovement[] = [];
		const expected = new Map<string, number>();
		const landed = landedValues(document, lines);
		const origin = { movement_date: moment, document: document.uuid };
		for (const [index, line] of lines.entries()) {
			const common = { ...origin, item: line.item, document_line: line.uuid };
			if (document.document_type === "opening") {
				movements.push({ ...common, warehouse: document.warehouse, movement_kind: "opening", quantity: line.quantity, entered_value: line.value ?? 0 });
			} else if (document.document_type === "receipt" && document.reason === "customer_return") {
				movements.push({
					...common,
					warehouse: document.warehouse,
					movement_kind: "customer_return",
					quantity: line.quantity,
					cost_source: sources.get(line.item) ?? null,
					invoice: document.invoice,
				});
			} else if (document.document_type === "receipt") {
				movements.push({ ...common, warehouse: document.warehouse, movement_kind: "receipt", quantity: line.quantity, entered_value: landed[index] });
			} else if (document.document_type === "issue") {
				movements.push({ ...common, warehouse: document.warehouse, movement_kind: "issue", quantity: -line.quantity });
			} else if (document.document_type === "transfer") {
				const out = crypto.randomUUID();
				movements.push({ ...common, uuid: out, warehouse: document.warehouse, movement_kind: "transfer_out", quantity: -line.quantity });
				movements.push({ ...common, warehouse: document.target_warehouse!, movement_kind: "transfer_in", quantity: line.quantity, cost_source: out });
			} else {
				const states = await stateThrough(Database, project, line.item, moment, config);
				const state = states.get(document.warehouse);
				const booked = state ? onHand(state).quantity : 0;
				expected.set(line.uuid, booked);
				const difference = line.quantity - booked;
				if (difference !== 0) {
					movements.push({ ...common, warehouse: document.warehouse, movement_kind: difference > 0 ? "surplus" : "shortage", quantity: difference });
				}
			}
		}

		await Database.begin(async (tx) => {
			const year = zonedParts(moment, timezone).year;
			const numbered = await nextNumber(tx, project.uuid, document.document_type, year);
			await tx`
				UPDATE stock_documents SET status = 'posted', year = ${year}, sequence_number = ${numbered.sequence}, number = ${numbered.number},
					posted_by = ${author}, posted_at = ${now}, updated = ${now}
				WHERE uuid = ${uuid} AND status = 'draft'
			`;
			for (const [line, quantity] of expected) await tx`UPDATE stock_document_lines SET expected_quantity = ${quantity} WHERE uuid = ${line}`;
			await insertMovements(tx, project.uuid, movements);
			await revalue(
				tx,
				project,
				movements.map((movement) => movement.item),
				config
			);
			if (document.purchase_order) await refreshOrderStatus(tx, document.purchase_order);
		});
		return (await findDocument(project.uuid, uuid))!;
	});
}

export async function cancelDocument(project: ProjectRow, uuid: string, author: string, reason: string | null): Promise<StockDocumentRow | ErrorCode> {
	return withInventory(project.uuid, async () => {
		const document = await findDocument(project.uuid, uuid);
		if (!document) return ErrorCode.STOCK_DOCUMENT_NOT_FOUND;
		if (document.status !== "posted") return ErrorCode.STOCK_DOCUMENT_NOT_POSTED;
		const lines = await documentLines(uuid);
		const movements = (await Database`SELECT uuid, item, movement_date FROM stock_movements WHERE document = ${uuid}`) as Pick<
			StockMovementRow,
			"uuid" | "item" | "movement_date"
		>[];
		const moment = movements.length
			? Math.min(...movements.map((movement) => safeInteger(movement.movement_date)))
			: documentMoment(document, project.timezone, safeInteger(document.posted_at ?? Date.now()));
		if (await closedYear(project.uuid, moment)) return ErrorCode.YEAR_CLOSED;
		if (document.charge_vat && (await accountingPeriodLocked(project.uuid, moment))) return ErrorCode.ACCOUNTING_PERIOD_LOCKED;
		if (await countedLater(Database, project, document, lines, moment)) return ErrorCode.STOCK_COUNTED_LATER;
		const now = Date.now();
		await Database.begin(async (tx) => {
			if (movements.length > 0) {
				const ids = movements.map((movement) => movement.uuid);
				await tx`UPDATE stock_movements SET cost_source = NULL WHERE cost_source IN ${tx(ids)} AND (document IS NULL OR document <> ${uuid})`;
				await tx`DELETE FROM stock_movements WHERE document = ${uuid}`;
			}
			await tx`
				UPDATE stock_documents SET status = 'canceled', canceled_by = ${author}, canceled_at = ${now}, cancel_reason = ${reason}, updated = ${now}
				WHERE uuid = ${uuid} AND status = 'posted'
			`;
			await revalue(tx, project, [...movements.map((movement) => movement.item), ...lines.map((line) => line.item)]);
			if (document.purchase_order) await refreshOrderStatus(tx, document.purchase_order);
		});
		return (await findDocument(project.uuid, uuid))!;
	});
}
