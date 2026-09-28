import Database from "../database/database";
import { Logger } from "../logger";
import { canEmail } from "../email/mailer";
import { queueInvoiceEmail } from "../email/messages";
import { applyBalance } from "../payments/ledger";
import { nextInvoiceNumber } from "../invoice-numbers";
import { prepareInvoiceIssue } from "../invoice-validation";
import { loadItems, stampIssue } from "../invoice-service";
import { archiveIssuedInvoice } from "../invoice-archive";
import { enqueueLater } from "../webhooks/events";
import { cancelOrder, findOrder } from "./orders";
import type { InvoiceRow, ProjectRow } from "../database/models";

export const UNPAID_ORDER_GRACE_DAYS = 7;

const DAY = 24 * 60 * 60 * 1000;
const BATCH = 100;
const SETTLE_DELAY_MS = 300;

export async function issuePaidOrder(invoiceId: string): Promise<string | null> {
	const [invoice] = (await Database`SELECT * FROM invoices WHERE uuid = ${invoiceId}`) as InvoiceRow[];
	if (!invoice || invoice.status !== "draft" || invoice.paid_amount <= 0) return null;
	const [order] = (await Database`SELECT email, fulfillment FROM store_orders WHERE invoice = ${invoiceId}`) as { email: string; fulfillment: string }[];
	if (!order || order.fulfillment === "canceled") return null;
	const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${invoice.project}`) as ProjectRow[];

	const issuedAt = Date.now();
	const items = await loadItems(invoiceId);
	const issue = await prepareInvoiceIssue(project, { ...invoice, supply_date: issuedAt }, items, issuedAt);

	const reference = await Database.begin(async (tx) => {
		const claimed = await tx`
			UPDATE invoices SET status = 'open', supply_date = ${issuedAt}, updated = ${issuedAt} WHERE uuid = ${invoiceId} AND status = 'draft'
		`;
		if (claimed.count === 0) return null;
		const number = await nextInvoiceNumber(tx, project.uuid, issuedAt, "invoice");
		await tx`UPDATE invoices SET reference = ${number} WHERE uuid = ${invoiceId}`;
		await stampIssue(tx, invoiceId, issue.snapshot, null, issue.presentation);
		await applyBalance(tx, invoiceId);
		return number;
	});
	if (reference === null) return null;

	await archiveIssuedInvoice(project.uuid, invoiceId);
	enqueueLater(project.uuid, "invoice.issued", {
		invoice: invoiceId,
		reference,
		status: "open",
		currency: invoice.currency,
		total_amount: invoice.total_amount,
		due_date: invoice.due_date,
		store_order: true,
	});
	Logger.info(`[STORE] Order ${invoice.reference} was paid and issued as invoice ${reference}`);

	if (canEmail(project)) {
		const [issued] = (await Database`SELECT * FROM invoices WHERE uuid = ${invoiceId}`) as InvoiceRow[];
		try {
			await queueInvoiceEmail(project, issued, { to: order.email, kind: "invoice", message: null, sentBy: null, attachInvoice: true, payLink: true });
		} catch (err) {
			Logger.error(`[STORE] Could not queue the invoice email for ${reference}: ${err}`);
		}
	}
	return reference;
}

export async function expireUnpaidOrders(now = Date.now()): Promise<number> {
	const expired = (await Database`
		SELECT o.invoice AS invoice, o.project AS project FROM store_orders o JOIN invoices i ON i.uuid = o.invoice
		WHERE i.status = 'draft' AND i.paid_amount = 0 AND o.fulfillment != 'canceled' AND i.due_date < ${now - UNPAID_ORDER_GRACE_DAYS * DAY}
		LIMIT ${BATCH}
	`) as { invoice: string; project: string }[];

	let canceled = 0;
	for (const row of expired) {
		const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${row.project}`) as ProjectRow[];
		const order = await findOrder(row.project, row.invoice);
		if (!project || !order) continue;
		await cancelOrder(project, order, "Not paid in time", "system");
		canceled++;
	}
	if (canceled > 0) Logger.info(`[STORE] Canceled ${canceled} orders that were not paid in time`);
	return canceled;
}

let issuing: Promise<number> | null = null;

async function issueBatch(): Promise<number> {
	const paid = (await Database`
		SELECT i.uuid AS invoice FROM invoices i JOIN store_orders o ON o.invoice = i.uuid
		WHERE i.status = 'draft' AND i.paid_amount > 0 AND o.fulfillment != 'canceled'
		ORDER BY i.updated ASC LIMIT ${BATCH}
	`) as { invoice: string }[];

	let issued = 0;
	for (const row of paid) {
		try {
			if (await issuePaidOrder(row.invoice)) issued++;
		} catch (err) {
			Logger.error(`[STORE] Could not issue the invoice for paid order ${row.invoice}: ${err instanceof Error ? err.message : err}`);
		}
	}
	return issued;
}

export async function issuePaidOrders(): Promise<number> {
	if (issuing) return await issuing;
	issuing = issueBatch();
	try {
		return await issuing;
	} finally {
		issuing = null;
	}
}

export function issueOrdersSoon() {
	setTimeout(() => {
		void issuePaidOrders().catch((err) => Logger.error(`[STORE] Issuing paid orders failed: ${err}`));
	}, SETTLE_DELAY_MS).unref?.();
}
