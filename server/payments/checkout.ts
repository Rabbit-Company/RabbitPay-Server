import Database from "../database/database";
import { Logger } from "../logger";
import Utils from "../utils";
import { Settings } from "../settings";
import { creditHostedPayment, existingSessionFor, recordSession, sessionByExternalId, type HostedSession } from "./hosted";
import { outstandingOf } from "./bitcoin";
import { toMinorUnits as paypalToMinorUnits, type PaypalClient } from "../processors/paypal";
import type { StripeClient } from "../processors/stripe";
import type { InvoiceRow, ProjectRow } from "../database/models";
import type { PaymentSessionRow } from "./types";

export function stripeEnabled(): boolean {
	return Settings.stripe?.enabled === true;
}

export function paypalEnabled(): boolean {
	return Settings.paypal?.enabled === true;
}

function checkoutLifetimeMs(): number {
	return (Settings.stripe?.checkout_expiry || 86400) * 1000;
}

function returnUrls(invoice: InvoiceRow): { success: string; cancel: string } {
	const base = Utils.publicUrl();
	return { success: `${base}/paid/${invoice.uuid}`, cancel: `${base}/cancelled/${invoice.uuid}` };
}

export async function createStripeCheckout(client: StripeClient, project: ProjectRow, invoice: InvoiceRow): Promise<HostedSession> {
	const existing = await existingSessionFor(invoice.uuid, "stripe");
	if (existing && existing.expires_at > Date.now() && existing.return_url) {
		return { session: existing, checkoutUrl: existing.return_url };
	}

	const urls = returnUrls(invoice);
	const checkout = await client.createCheckout({
		amountMinor: outstandingOf(invoice),
		currency: invoice.currency,
		description: `Invoice ${invoice.reference}`,
		reference: invoice.uuid,
		successUrl: urls.success,
		cancelUrl: urls.cancel,
	});

	const session = await recordSession(project, invoice, "stripe", checkout.id, checkout.url, checkoutLifetimeMs());
	return { session, checkoutUrl: checkout.url };
}

export async function createPaypalOrder(client: PaypalClient, project: ProjectRow, invoice: InvoiceRow): Promise<HostedSession> {
	const existing = await existingSessionFor(invoice.uuid, "paypal");
	if (existing && existing.expires_at > Date.now() && existing.return_url) {
		return { session: existing, checkoutUrl: existing.return_url };
	}

	const urls = returnUrls(invoice);
	const order = await client.createOrder({
		amountMinor: outstandingOf(invoice),
		currency: invoice.currency,
		reference: invoice.uuid,
		returnUrl: urls.success,
		cancelUrl: urls.cancel,
	});

	const session = await recordSession(project, invoice, "paypal", order.id, order.approveUrl, checkoutLifetimeMs());
	return { session, checkoutUrl: order.approveUrl };
}

interface StripeEvent {
	id?: string;
	type?: string;
	data?: { object?: Record<string, any> };
}

export async function handleStripeEvent(event: StripeEvent): Promise<{ processed: boolean; session?: PaymentSessionRow }> {
	if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
		return { processed: false };
	}

	const object = event.data?.object ?? {};
	const checkoutId = typeof object.id === "string" ? object.id : null;
	if (!checkoutId) return { processed: false };

	const session = await sessionByExternalId("stripe", checkoutId);
	if (!session) return { processed: false };

	if (object.payment_status !== "paid") {
		Logger.debug(`[STRIPE] Checkout ${checkoutId} is ${object.payment_status}, not crediting yet`);
		return { processed: false, session };
	}

	const paymentId = typeof object.payment_intent === "string" ? object.payment_intent : checkoutId;
	const amount = typeof object.amount_total === "number" ? object.amount_total : 0;
	const currency = typeof object.currency === "string" ? object.currency.toUpperCase() : session.currency;

	const credited = await creditHostedPayment({
		processor: "stripe",
		externalId: checkoutId,
		paymentId,
		amountMinor: amount,
		currency,
		details: { event: event.id ?? null, customer_email: object.customer_details?.email ?? null },
	});

	return { processed: credited, session };
}

interface PaypalEvent {
	id?: string;
	event_type?: string;
	resource?: Record<string, any>;
}

export async function sessionForEvent(processor: string, event: Record<string, any>): Promise<PaymentSessionRow | undefined> {
	if (processor === "stripe") {
		const id = event.data?.object?.id;
		return typeof id === "string" ? await sessionByExternalId("stripe", id) : undefined;
	}

	return await sessionForPaypalEvent(event.resource ?? {});
}

async function sessionForPaypalEvent(resource: Record<string, any>): Promise<PaymentSessionRow | undefined> {
	const orderId = resource.supplementary_data?.related_ids?.order_id ?? (resource.intent ? resource.id : undefined);
	if (typeof orderId === "string") {
		const session = await sessionByExternalId("paypal", orderId);
		if (session) return session;
	}

	const invoiceId = resource.custom_id ?? resource.purchase_units?.[0]?.custom_id;
	if (typeof invoiceId === "string") {
		const [row] = (await Database`
			SELECT * FROM payment_sessions WHERE processor = 'paypal' AND invoice = ${invoiceId} ORDER BY created DESC
		`) as PaymentSessionRow[];
		return row;
	}

	return undefined;
}

export async function handlePaypalEvent(client: PaypalClient, event: PaypalEvent): Promise<{ processed: boolean; session?: PaymentSessionRow }> {
	const resource = event.resource ?? {};
	const session = await sessionForPaypalEvent(resource);
	if (!session) return { processed: false };

	if (event.event_type === "CHECKOUT.ORDER.APPROVED") {
		const captured = await client.captureOrder(session.processor_session_id);
		if (!captured) return { processed: false, session };

		const credited = await creditHostedPayment({
			processor: "paypal",
			externalId: session.processor_session_id,
			paymentId: captured.captureId,
			amountMinor: captured.amountMinor,
			currency: captured.currency,
			details: { event: event.id ?? null, captured_on_approval: true },
		});

		return { processed: credited, session };
	}

	if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
		const captureId = typeof resource.id === "string" ? resource.id : null;
		if (!captureId) return { processed: false, session };

		const currency = resource.amount?.currency_code ?? session.currency;

		const credited = await creditHostedPayment({
			processor: "paypal",
			externalId: session.processor_session_id,
			paymentId: captureId,
			amountMinor: paypalToMinorUnits(resource.amount?.value ?? "0", currency),
			currency: String(currency).toUpperCase(),
			details: { event: event.id ?? null },
		});

		return { processed: credited, session };
	}

	return { processed: false, session };
}
