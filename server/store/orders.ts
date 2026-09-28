import Database from "../database/database";
import { outstandingOf } from "../invoicing";
import { cancelInvoice } from "../invoice-cancel";
import { returnStock } from "./checkout";
import { releaseRedemption } from "./coupons";
import type { InvoiceItemRow, InvoiceRow, ProjectRow, StoreFulfillment, StoreOrderRow } from "../database/models";

export const FULFILLMENTS: StoreFulfillment[] = ["pending", "processing", "shipped", "delivered", "canceled"];

export type OrderRow = StoreOrderRow &
	Pick<InvoiceRow, "reference" | "status" | "issued_at" | "currency" | "total_amount" | "paid_amount" | "refunded_amount" | "credited_amount" | "due_date"> & {
		customer_name: string | null;
		coupon_code?: string | null;
		coupon_discount?: number | null;
	};

function itemGross(item: InvoiceItemRow): number {
	return item.discount_amount > 0 ? Math.round((item.total_price * (100 + item.tax_rate)) / 100) : item.total_price + item.tax_amount;
}

export function paymentStatusOf(status: InvoiceRow["status"]): InvoiceRow["status"] {
	return status === "draft" ? "open" : status;
}

export function isFulfillment(value: unknown): value is StoreFulfillment {
	return typeof value === "string" && FULFILLMENTS.includes(value as StoreFulfillment);
}

export function presentOrder(row: OrderRow, items: InvoiceItemRow[] | null = null) {
	let address: unknown = null;
	try {
		address = row.shipping_address ? JSON.parse(row.shipping_address) : null;
	} catch {
		address = null;
	}
	const gross = items?.map(itemGross) ?? null;
	const discount = gross ? Math.max(0, gross.reduce((sum, value) => sum + value, 0) - row.total_amount) : (row.coupon_discount ?? 0);
	return {
		invoice: row.invoice,
		reference: row.reference,
		number: row.number ?? row.reference,
		invoice_reference: row.status === "draft" || row.issued_at === null ? null : row.reference,
		email: row.email,
		customer_name: row.customer_name,
		fulfillment: row.fulfillment,
		payment_status: paymentStatusOf(row.status),
		currency: row.currency,
		total_amount: row.total_amount,
		outstanding: outstandingOf(row),
		due_date: row.due_date,
		shipping_method: row.shipping_method,
		shipping_address: address,
		note: row.note,
		tracking_url: row.tracking_url,
		coupon: row.coupon_code ? { code: row.coupon_code, discount } : null,
		created: row.created,
		updated: row.updated,
		items:
			items?.map((item, index) => ({
				description: item.description,
				quantity: item.quantity,
				item: item.item,
				total: gross![index],
			})) ?? null,
	};
}

export async function findOrder(projectId: string, invoiceId: string): Promise<OrderRow | null> {
	const [row] = (await Database`
		SELECT o.*, i.reference, i.status, i.issued_at, i.currency, i.total_amount, i.paid_amount, i.refunded_amount, i.credited_amount, i.due_date,
			c.name AS customer_name, sc.code AS coupon_code, r.discount AS coupon_discount
		FROM store_orders o JOIN invoices i ON i.uuid = o.invoice LEFT JOIN customers c ON c.uuid = i.customer
			LEFT JOIN store_coupon_redemptions r ON r.invoice = o.invoice LEFT JOIN store_coupons sc ON sc.uuid = r.coupon
		WHERE o.project = ${projectId} AND o.invoice = ${invoiceId}
	`) as OrderRow[];
	return row ?? null;
}

export async function orderItems(invoiceId: string): Promise<InvoiceItemRow[]> {
	return (await Database`SELECT * FROM invoice_items WHERE invoice = ${invoiceId} ORDER BY sort_order ASC`) as InvoiceItemRow[];
}

export async function restoreOrderStock(order: Pick<StoreOrderRow, "invoice" | "project">) {
	const claimed = await Database`UPDATE store_orders SET stock_returned = 1 WHERE invoice = ${order.invoice} AND stock_returned = 0`;
	if (claimed.count === 0) return;
	const lines = (await Database`
		SELECT item, SUM(quantity) AS quantity FROM invoice_items WHERE invoice = ${order.invoice} AND item IS NOT NULL GROUP BY item
	`) as { item: string; quantity: number }[];
	await returnStock(
		order.project,
		lines.map((line) => ({ product: line.item, quantity: Math.round(Number(line.quantity)) }))
	);
}

export async function cancelOrder(project: ProjectRow, order: OrderRow, reason: string, canceledBy: string) {
	const [invoice] = (await Database`SELECT * FROM invoices WHERE uuid = ${order.invoice}`) as InvoiceRow[];
	if (invoice && invoice.status !== "canceled" && invoice.paid_amount === 0) await cancelInvoice(project, invoice, reason, canceledBy);
	await Database`UPDATE store_orders SET fulfillment = 'canceled', updated = ${Date.now()} WHERE invoice = ${order.invoice}`;
	await restoreOrderStock(order);
	await releaseRedemption(order.invoice);
}
