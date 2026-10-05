import type { SQL } from "bun";
import { safeInteger, addIntegers } from "../database/numbers";
import { statusForPayment } from "../invoicing";
import { deliverKeysSoon } from "../key-delivery";
import { issueDraftsSoon } from "../paid-drafts";
import { queueInvoiceVerification, submitFiscalSoon } from "../fiscal/documents";
import { enqueueLater, type WebhookEvent } from "../webhooks/events";
import type { InvoiceRow, InvoiceStatus } from "../database/models";

export const SETTLED_PAYMENT_STATUSES = ["confirmed", "completed", "refunded", "partially_refunded"];
export const SETTLED_REFUND_STATUSES = ["completed"];
export const REFUND_TYPES = ["refund", "partial_refund"];

export interface InvoiceBalance {
	paid_amount: number;
	refunded_amount: number;
	net_paid: number;
	outstanding: number;
	status: InvoiceStatus;
}

export async function balanceFor(sql: SQL, invoice: InvoiceRow): Promise<InvoiceBalance> {
	const [payments] = (await sql`
		SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
		WHERE invoice = ${invoice.uuid} AND type = 'payment' AND status IN ${sql(SETTLED_PAYMENT_STATUSES)}
	`) as { total: number }[];

	const [refunds] = (await sql`
		SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
		WHERE invoice = ${invoice.uuid} AND type IN ${sql(REFUND_TYPES)} AND status IN ${sql(SETTLED_REFUND_STATUSES)}
	`) as { total: number }[];

	const paid = safeInteger(payments.total);
	const refunded = safeInteger(refunds.total);
	const net = addIntegers(paid, -refunded);

	return {
		paid_amount: paid,
		refunded_amount: refunded,
		net_paid: net,
		outstanding: Math.max(invoice.total_amount - invoice.credited_amount - net, 0),
		status: resolveStatus(invoice, paid, refunded, net),
	};
}

function resolveStatus(invoice: InvoiceRow, paid: number, refunded: number, net: number): InvoiceStatus {
	if (invoice.status === "draft" || invoice.status === "canceled") return invoice.status;
	if (paid > 0 && refunded > 0 && net <= 0) return "refunded";

	const due = invoice.total_amount - invoice.credited_amount;
	if (due <= 0) return net > 0 || invoice.credited_amount === 0 ? "paid" : "canceled";

	return statusForPayment(due, net, invoice.due_date, Date.now());
}

const STATUS_EVENTS: Partial<Record<InvoiceStatus, WebhookEvent>> = {
	paid: "invoice.paid",
	partially_paid: "invoice.partially_paid",
	refunded: "invoice.refunded",
	overdue: "invoice.overdue",
};

export async function applyBalance(sql: SQL, invoiceId: string, paidAt = Date.now()): Promise<InvoiceBalance> {
	const [invoice] = (await sql`SELECT * FROM invoices WHERE uuid = ${invoiceId}`) as InvoiceRow[];
	const balance = await balanceFor(sql, invoice);

	const paidDate = balance.status === "paid" ? (invoice.paid_date ?? paidAt) : null;

	await sql`
		UPDATE invoices SET
			paid_amount = ${balance.paid_amount},
			refunded_amount = ${balance.refunded_amount},
			status = ${balance.status},
			paid_date = ${paidDate},
			updated = ${Date.now()}
		WHERE uuid = ${invoiceId}
	`;

	if (await queueInvoiceVerification(sql, invoiceId)) submitFiscalSoon();
	if (invoice.status === "draft" && balance.paid_amount > 0) issueDraftsSoon();

	if (balance.status !== invoice.status) {
		if (balance.status === "paid") deliverKeysSoon();

		const event = STATUS_EVENTS[balance.status];
		if (event) {
			enqueueLater(invoice.project, event, {
				invoice: invoice.uuid,
				reference: invoice.reference,
				status: balance.status,
				previous_status: invoice.status,
				currency: invoice.currency,
				total_amount: invoice.total_amount,
				paid_amount: balance.paid_amount,
				refunded_amount: balance.refunded_amount,
				outstanding: balance.outstanding,
			});
		}
	}

	return balance;
}

export async function refundableAmount(sql: SQL, transactionId: string): Promise<number> {
	const [payment] = (await sql`SELECT amount FROM transactions WHERE uuid = ${transactionId}`) as { amount: number }[];
	if (!payment) return 0;

	const [refunded] = (await sql`
		SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
		WHERE parent_transaction = ${transactionId} AND type IN ${sql(REFUND_TYPES)} AND status IN ${sql(SETTLED_REFUND_STATUSES)}
	`) as { total: number }[];

	return addIntegers(payment.amount, -safeInteger(refunded.total));
}
