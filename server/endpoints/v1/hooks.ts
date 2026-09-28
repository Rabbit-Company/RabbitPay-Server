import { Server } from "../../server";
import Database from "../../database/database";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { verifySignature } from "../../processors/stripe";
import { handlePaypalEvent, handleStripeEvent, paypalEnabled, sessionForEvent, stripeEnabled } from "../../payments/checkout";
import { configFor } from "../../payments/methods";
import { paypalClient } from "../../crypto/chains";
import type { PaymentSessionRow } from "../../payments/types";

async function recordInbound(options: {
	session: PaymentSessionRow | undefined;
	processor: string;
	eventType: string;
	eventId: string | null;
	rawBody: string;
	signature: string | null;
	verified: boolean;
	processed: boolean;
	error?: string;
}) {
	if (!options.session) return;

	try {
		const timestamp = Date.now();
		await Database`
			INSERT INTO webhook_events(uuid, project, processor, event_type, event_id, payload, signature, verified, processed, attempts,
				error_message, received_at, processed_at)
			VALUES(${crypto.randomUUID()}, ${options.session.project}, ${options.processor}, ${options.eventType}, ${options.eventId},
				${options.rawBody.slice(0, 20000)}, ${options.signature}, ${options.verified ? 1 : 0}, ${options.processed ? 1 : 0}, 1,
				${options.error ?? null}, ${timestamp}, ${options.processed ? timestamp : null})
		`;
	} catch (err) {
		Logger.error(`[HOOKS] Could not record the ${options.processor} event: ${err}`);
	}
}

function parseEvent(rawBody: string): Record<string, any> | null {
	try {
		const parsed = JSON.parse(rawBody);
		return typeof parsed === "object" && parsed !== null ? parsed : null;
	} catch {
		return null;
	}
}

Server.app.post("/api/v1/hooks/stripe", async (ctx) => {
	if (!stripeEnabled()) return Utils.fail(ctx, ErrorCode.PROCESSOR_DISABLED);

	const rawBody = await ctx.req.text();
	const header = ctx.req.headers.get("stripe-signature") ?? "";

	const untrusted = parseEvent(rawBody);
	if (!untrusted) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	const session = await sessionForEvent("stripe", untrusted);
	if (!session) return Utils.ok(ctx, { received: true, processed: false });

	const secret = (await configFor(session.project, "stripe")).webhook_secret;
	const check = verifySignature(secret || "", header, rawBody);
	if (!check.valid) {
		Logger.audit(`[STRIPE] Rejected a webhook from ${Utils.clientIp(ctx)}: ${check.reason}`);
		return Utils.fail(ctx, ErrorCode.INVALID_WEBHOOK_SIGNATURE);
	}

	let result;
	try {
		result = await handleStripeEvent(untrusted);
	} catch (err) {
		Logger.error(`[STRIPE] Could not handle ${untrusted.type}: ${err}`);
		return Utils.fail(ctx, ErrorCode.UNKNOWN_ERROR);
	}

	await recordInbound({
		session: result.session,
		processor: "stripe",
		eventType: untrusted.type ?? "unknown",
		eventId: untrusted.id ?? null,
		rawBody,
		signature: header,
		verified: true,
		processed: result.processed,
	});

	return Utils.ok(ctx, { received: true, processed: result.processed });
});

Server.app.post("/api/v1/hooks/paypal", async (ctx) => {
	if (!paypalEnabled()) return Utils.fail(ctx, ErrorCode.PROCESSOR_DISABLED);

	const rawBody = await ctx.req.text();
	const headers = ctx.req.headers;

	const untrusted = parseEvent(rawBody);
	if (!untrusted) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	const session = await sessionForEvent("paypal", untrusted);
	if (!session) return Utils.ok(ctx, { received: true, processed: false });

	const client = paypalClient(await configFor(session.project, "paypal"));

	const signature = {
		transmissionId: headers.get("paypal-transmission-id") ?? "",
		transmissionTime: headers.get("paypal-transmission-time") ?? "",
		transmissionSig: headers.get("paypal-transmission-sig") ?? "",
		certUrl: headers.get("paypal-cert-url") ?? "",
		authAlgo: headers.get("paypal-auth-algo") ?? "",
		rawBody,
	};

	let verified = false;
	try {
		verified = await client.verifyWebhook(signature);
	} catch (err) {
		Logger.error(`[PAYPAL] Could not verify a webhook: ${err}`);
	}

	if (!verified) {
		Logger.audit(`[PAYPAL] Rejected an unverified webhook from ${Utils.clientIp(ctx)}`);
		return Utils.fail(ctx, ErrorCode.INVALID_WEBHOOK_SIGNATURE);
	}

	let result;
	try {
		result = await handlePaypalEvent(client, untrusted);
	} catch (err) {
		Logger.error(`[PAYPAL] Could not handle ${untrusted.event_type}: ${err}`);
		return Utils.fail(ctx, ErrorCode.UNKNOWN_ERROR);
	}

	await recordInbound({
		session: result.session,
		processor: "paypal",
		eventType: untrusted.event_type ?? "unknown",
		eventId: untrusted.id ?? null,
		rawBody,
		signature: signature.transmissionSig,
		verified: true,
		processed: result.processed,
	});

	return Utils.ok(ctx, { received: true, processed: result.processed });
});
