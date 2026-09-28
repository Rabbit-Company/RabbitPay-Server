import { createHmac, timingSafeEqual } from "node:crypto";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import Database from "../database/database";
import { Logger } from "../logger";
import { Settings } from "../settings";
import { pinnedLookup, resolveTarget, type ResolvedTarget } from "./target";
import type { WebhookDeliveryRow } from "./events";
import type { ProjectRow } from "../database/models";

const BACKOFF_SECONDS = [30, 120, 600, 3600, 21600];

export function maxAttempts(): number {
	const configured = Settings.webhooks?.max_attempts;
	return typeof configured === "number" && configured > 0 ? configured : BACKOFF_SECONDS.length;
}

function backoffFor(attempt: number): number {
	return BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)] * 1000;
}

export function sign(secret: string, timestamp: number, body: string): string {
	return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verify(secret: string, timestamp: number, body: string, signature: string): boolean {
	const expected = Buffer.from(sign(secret, timestamp, body), "utf8");
	const received = Buffer.from(signature, "utf8");
	if (expected.length !== received.length) return false;
	return timingSafeEqual(expected, received);
}

async function markFailed(delivery: WebhookDeliveryRow, error: string, responseStatus: number | null) {
	const attempts = delivery.attempts + 1;
	const exhausted = attempts >= maxAttempts();
	const timestamp = Date.now();

	await Database`
		UPDATE webhook_deliveries SET
			status = ${exhausted ? "failed" : "pending"},
			attempts = ${attempts},
			response_status = ${responseStatus},
			last_error = ${error.slice(0, 500)},
			next_attempt_at = ${exhausted ? null : timestamp + backoffFor(delivery.attempts)},
			updated = ${timestamp}
		WHERE uuid = ${delivery.uuid}
	`;

	if (exhausted) Logger.warn(`[WEBHOOK] Giving up on ${delivery.event_type} for ${delivery.project} after ${attempts} attempts: ${error}`);
}

export function sendPinnedWebhook(target: ResolvedTarget, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<number> {
	if (!target.allowed || !target.url || !target.address || !target.family) return Promise.reject(new Error("Webhook target was not resolved"));
	const url = target.url;
	const request = url.protocol === "https:" ? requestHttps : requestHttp;

	return new Promise((resolve, reject) => {
		const outgoing = request(
			url,
			{
				method: "POST",
				headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
				lookup: pinnedLookup(target),
				family: target.family,
				agent: false,
				signal,
			},
			(response) => {
				response.resume();
				resolve(response.statusCode ?? 0);
			}
		);
		outgoing.once("error", reject);
		outgoing.end(body);
	});
}

export async function deliver(delivery: WebhookDeliveryRow): Promise<boolean> {
	const safety = await resolveTarget(delivery.target_url);
	if (!safety.allowed) {
		await markFailed(delivery, safety.reason ?? "Target is not allowed", null);
		return false;
	}

	const [project] = (await Database`SELECT webhook_secret FROM projects WHERE uuid = ${delivery.project}`) as Pick<ProjectRow, "webhook_secret">[];
	const timestamp = Date.now();
	const signature = project?.webhook_secret ? sign(project.webhook_secret, timestamp, delivery.payload) : "";

	let responseStatus: number;
	try {
		responseStatus = await sendPinnedWebhook(
			safety,
			{
				"Content-Type": "application/json",
				"User-Agent": "RabbitPay-Webhook/1",
				"X-RabbitPay-Event": delivery.event_type,
				"X-RabbitPay-Delivery": delivery.uuid,
				"X-RabbitPay-Timestamp": String(timestamp),
				"X-RabbitPay-Signature": `sha256=${signature}`,
			},
			delivery.payload,
			AbortSignal.timeout((Settings.webhooks?.timeout || 10) * 1000)
		);
	} catch (err) {
		await markFailed(delivery, String(err), null);
		return false;
	}

	if (responseStatus < 200 || responseStatus >= 300) {
		await markFailed(delivery, `Target responded ${responseStatus}`, responseStatus);
		return false;
	}

	const now = Date.now();
	await Database`
		UPDATE webhook_deliveries SET status = 'delivered', attempts = ${delivery.attempts + 1}, response_status = ${responseStatus},
			last_error = NULL, next_attempt_at = NULL, delivered_at = ${now}, updated = ${now}
		WHERE uuid = ${delivery.uuid}
	`;

	return true;
}

export async function deliverPending(limit = 20): Promise<{ attempted: number; delivered: number }> {
	const pending = (await Database`
		SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ${Date.now()}
		ORDER BY next_attempt_at ASC LIMIT ${limit}
	`) as WebhookDeliveryRow[];

	let delivered = 0;
	for (const delivery of pending) {
		if (await deliver(delivery)) delivered++;
	}

	return { attempted: pending.length, delivered };
}
