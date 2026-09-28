import Database from "./database/database";
import { Logger } from "./logger";
import { canEmail } from "./email/mailer";
import { queueInvoiceEmail } from "./email/messages";
import { cancelOrder, findOrder } from "./store/orders";
import { issueAdvance, issueDraft, proformaFor } from "./proformas";
import type { CustomerRow, InvoiceRow, ProjectRow } from "./database/models";

export const UNPAID_ORDER_GRACE_DAYS = 7;

const DAY = 24 * 60 * 60 * 1000;
const BATCH = 100;
const SETTLE_DELAY_MS = 300;

async function recipientOf(invoice: InvoiceRow): Promise<string | null> {
	const [order] = (await Database`SELECT email FROM store_orders WHERE invoice = ${invoice.uuid}`) as { email: string }[];
	if (order) return order.email;
	if (invoice.customer === null) return null;
	const [customer] = (await Database`SELECT email FROM customers WHERE uuid = ${invoice.customer}`) as Pick<CustomerRow, "email">[];
	return customer?.email ?? null;
}

async function sendIssued(project: ProjectRow, invoiceId: string, to: string | null) {
	if (!to || !canEmail(project)) return;
	const [issued] = (await Database`SELECT * FROM invoices WHERE uuid = ${invoiceId}`) as InvoiceRow[];
	try {
		await queueInvoiceEmail(project, issued, { to, kind: "invoice", message: null, sentBy: null, attachInvoice: true, payLink: true });
	} catch (err) {
		Logger.error(`[INVOICES] Could not queue the invoice email for ${issued.reference}: ${err}`);
	}
}

export async function issuePaidDraft(invoiceId: string): Promise<string | null> {
	const [invoice] = (await Database`SELECT * FROM invoices WHERE uuid = ${invoiceId}`) as InvoiceRow[];
	if (!invoice || invoice.status !== "draft" || invoice.paid_amount <= 0) return null;
	const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${invoice.project}`) as ProjectRow[];
	const to = await recipientOf(invoice);

	if (invoice.document_type === "advance") {
		const reference = await issueDraft(project, invoice, { issuedBy: null });
		if (reference) await sendIssued(project, invoice.uuid, to);
		return reference;
	}

	const proforma = await proformaFor(invoice.uuid);
	if (proforma) {
		if (proforma.settlement === "advance") {
			const reference = await issueAdvance(project, invoice);
			if (reference) {
				const [advance] = (await Database`SELECT uuid FROM invoices WHERE reference = ${reference} AND project = ${project.uuid}`) as { uuid: string }[];
				if (advance) await sendIssued(project, advance.uuid, to);
			}
			return reference;
		}
		const reference = await issueDraft(project, invoice, { issuedBy: null });
		if (reference) {
			Logger.info(`[PROFORMA] ${proforma.reference} was paid and issued as invoice ${reference}`);
			await sendIssued(project, invoice.uuid, to);
		}
		return reference;
	}

	const [order] = (await Database`SELECT fulfillment FROM store_orders WHERE invoice = ${invoiceId}`) as { fulfillment: string }[];
	if (!order || order.fulfillment === "canceled") return null;
	const now = Date.now();
	const reference = await issueDraft(project, invoice, { issuedBy: null, issuedAt: now, supplyDate: now });
	if (reference) {
		Logger.info(`[STORE] Order ${invoice.reference} was paid and issued as invoice ${reference}`);
		await sendIssued(project, invoice.uuid, to);
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
		SELECT i.uuid AS invoice FROM invoices i
		WHERE i.status = 'draft' AND i.paid_amount > i.refunded_amount AND (
			i.document_type = 'advance'
			OR EXISTS (SELECT 1 FROM proformas p WHERE p.invoice = i.uuid)
			OR EXISTS (SELECT 1 FROM store_orders o WHERE o.invoice = i.uuid AND o.fulfillment != 'canceled')
		)
		ORDER BY i.updated ASC LIMIT ${BATCH}
	`) as { invoice: string }[];

	let issued = 0;
	for (const row of paid) {
		try {
			if (await issuePaidDraft(row.invoice)) issued++;
		} catch (err) {
			Logger.error(`[INVOICES] Could not issue the invoice for paid draft ${row.invoice}: ${err instanceof Error ? err.message : err}`);
		}
	}
	return issued;
}

export async function issuePaidDrafts(): Promise<number> {
	if (issuing) return await issuing;
	issuing = issueBatch();
	try {
		return await issuing;
	} finally {
		issuing = null;
	}
}

export function issueDraftsSoon() {
	setTimeout(() => {
		void issuePaidDrafts().catch((err) => Logger.error(`[INVOICES] Issuing paid drafts failed: ${err}`));
	}, SETTLE_DELAY_MS).unref?.();
}
