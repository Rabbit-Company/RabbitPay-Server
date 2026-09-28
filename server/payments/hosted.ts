import Database from "../database/database";
import { Logger } from "../logger";
import { applyBalance } from "./ledger";
import { enqueueLater } from "../webhooks/events";
import { outstandingOf } from "./bitcoin";
import type { InvoiceRow, ProjectRow, TransactionRow } from "../database/models";
import type { PaymentSessionRow } from "./types";

export interface HostedSession {
	session: PaymentSessionRow;
	checkoutUrl: string;
}

export async function existingSessionFor(invoiceId: string, processor: string): Promise<PaymentSessionRow | undefined> {
	const [row] = (await Database`
		SELECT * FROM payment_sessions WHERE invoice = ${invoiceId} AND processor = ${processor} AND status = 'active' ORDER BY created DESC
	`) as PaymentSessionRow[];
	return row;
}

export async function recordSession(
	project: ProjectRow,
	invoice: InvoiceRow,
	processor: string,
	externalId: string,
	checkoutUrl: string,
	lifetimeMs: number
): Promise<PaymentSessionRow> {
	const uuid = crypto.randomUUID();
	const timestamp = Date.now();

	await Database`
		INSERT INTO payment_sessions(uuid, project, invoice, processor, processor_session_id, amount, currency, status, return_url, created, expires_at)
		VALUES(${uuid}, ${project.uuid}, ${invoice.uuid}, ${processor}, ${externalId}, ${outstandingOf(invoice)}, ${invoice.currency}, 'active',
			${checkoutUrl}, ${timestamp}, ${timestamp + lifetimeMs})
	`;

	Logger.audit(`[${processor.toUpperCase()}] Checkout ${externalId} opened for ${invoice.reference}`);

	const [row] = (await Database`SELECT * FROM payment_sessions WHERE uuid = ${uuid}`) as PaymentSessionRow[];
	return row;
}

export async function sessionByExternalId(processor: string, externalId: string): Promise<PaymentSessionRow | undefined> {
	const [row] = (await Database`
		SELECT * FROM payment_sessions WHERE processor = ${processor} AND processor_session_id = ${externalId}
	`) as PaymentSessionRow[];
	return row;
}

export async function creditHostedPayment(options: {
	processor: string;
	externalId: string;
	paymentId: string;
	amountMinor: number;
	currency: string;
	details: Record<string, unknown>;
}): Promise<boolean> {
	const session = await sessionByExternalId(options.processor, options.externalId);

	if (!session) {
		Logger.warn(`[${options.processor.toUpperCase()}] No open checkout matches ${options.externalId}`);
		return false;
	}

	if (session.invoice === null) return false;

	if (options.currency !== session.currency) {
		Logger.warn(`[${options.processor.toUpperCase()}] Ignoring ${options.currency} payment, the invoice is in ${session.currency}`);
		return false;
	}

	const [existing] = (await Database`
		SELECT uuid FROM transactions WHERE processor = ${options.processor} AND processor_tx_id = ${options.paymentId}
	`) as TransactionRow[];
	if (existing) return false;

	const timestamp = Date.now();
	const [invoice] = (await Database`SELECT customer FROM invoices WHERE uuid = ${session.invoice}`) as { customer: string | null }[];

	await Database`
		INSERT INTO transactions(uuid, project, invoice, customer, processor, processor_tx_id, status, type, currency, amount,
			fee_amount, net_amount, payment_method, payment_details, confirmed_at, completed_at, created, updated)
		VALUES(${crypto.randomUUID()}, ${session.project}, ${session.invoice}, ${invoice?.customer ?? null}, ${options.processor}, ${options.paymentId},
			'completed', 'payment', ${options.currency}, ${options.amountMinor}, 0, ${options.amountMinor}, ${options.processor},
			${JSON.stringify({ ...options.details, checkout: options.externalId })}, ${timestamp}, ${timestamp}, ${timestamp}, ${timestamp})
	`;

	const balance = await applyBalance(Database, session.invoice);

	if (balance.outstanding <= 0) {
		await Database`UPDATE payment_sessions SET status = 'completed', completed_at = ${timestamp} WHERE uuid = ${session.uuid}`;
	}

	Logger.audit(`[${options.processor.toUpperCase()}] Credited ${options.amountMinor} ${options.currency} from ${options.paymentId}`);

	enqueueLater(session.project, "payment.confirmed", {
		invoice: session.invoice,
		processor: options.processor,
		checkout: options.externalId,
		payment: options.paymentId,
		amount: options.amountMinor,
		currency: options.currency,
		status: "completed",
	});

	return true;
}
