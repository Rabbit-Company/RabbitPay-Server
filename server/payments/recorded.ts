import Database from "../database/database";
import { applyBalance, type InvoiceBalance } from "./ledger";
import { enqueueLater } from "../webhooks/events";
import { outstandingOf } from "../invoicing";
import type { InvoiceRow } from "../database/models";

export const PAYABLE_STATUSES = ["open", "overdue", "partially_paid"];

export async function awaitsStorePayment(invoice: Pick<InvoiceRow, "uuid" | "status">): Promise<boolean> {
	if (invoice.status !== "draft") return false;
	const [order] = (await Database`SELECT fulfillment FROM store_orders WHERE invoice = ${invoice.uuid}`) as { fulfillment: string }[];
	return order !== undefined && order.fulfillment !== "canceled";
}

export async function isProformaDraft(invoice: Pick<InvoiceRow, "uuid" | "status">): Promise<boolean> {
	if (invoice.status !== "draft") return false;
	const [row] = (await Database`SELECT 1 AS found FROM proformas WHERE invoice = ${invoice.uuid}`) as unknown[];
	return row !== undefined;
}

export async function awaitsPayment(invoice: InvoiceRow): Promise<boolean> {
	if (invoice.status !== "draft" || outstandingOf(invoice) <= 0) return false;
	return (await awaitsStorePayment(invoice)) || (await isProformaDraft(invoice));
}

export async function acceptsPayment(invoice: InvoiceRow): Promise<boolean> {
	return PAYABLE_STATUSES.includes(invoice.status) || (await awaitsPayment(invoice));
}

export interface RecordedPayment {
	invoice: InvoiceRow;
	processor: string;
	amount: number;
	fee: number;
	processorTxId: string | null;
	paymentMethod: string | null;
	status: "pending" | "confirmed" | "completed";
	notes: string | null;
	recordedBy: string;
	settledAt?: number;
}

export async function recordPayment(payment: RecordedPayment): Promise<{ uuid: string; balance: InvoiceBalance }> {
	const { invoice } = payment;
	const uuid = crypto.randomUUID();
	const timestamp = Date.now();
	const settledAt = payment.settledAt ?? timestamp;
	const settled = payment.status === "confirmed" || payment.status === "completed";
	const details = payment.notes ? { notes: payment.notes, recorded_by: payment.recordedBy } : { recorded_by: payment.recordedBy };

	const balance = await Database.begin(async (tx) => {
		await tx`
			INSERT INTO transactions(uuid, project, invoice, customer, processor, processor_tx_id, status, type, currency, amount,
				fee_amount, net_amount, payment_method, payment_details, confirmed_at, completed_at, created, updated)
			VALUES(${uuid}, ${invoice.project}, ${invoice.uuid}, ${invoice.customer}, ${payment.processor}, ${payment.processorTxId}, ${payment.status},
				'payment', ${invoice.currency}, ${payment.amount}, ${payment.fee}, ${payment.amount - payment.fee}, ${payment.paymentMethod},
				${JSON.stringify(details)}, ${settled ? settledAt : null}, ${payment.status === "completed" ? settledAt : null}, ${timestamp}, ${timestamp})
		`;

		return await applyBalance(tx, invoice.uuid);
	});

	enqueueLater(invoice.project, settled ? "payment.confirmed" : "payment.received", {
		transaction: uuid,
		invoice: invoice.uuid,
		reference: invoice.reference,
		amount: payment.amount,
		currency: invoice.currency,
		processor: payment.processor,
		status: payment.status,
	});

	return { uuid, balance };
}
