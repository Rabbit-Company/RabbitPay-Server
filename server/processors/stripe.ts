import { createHmac, timingSafeEqual } from "node:crypto";

export interface StripeCheckout {
	id: string;
	url: string;
}

export interface StripeClient {
	createCheckout(options: {
		amountMinor: number;
		currency: string;
		description: string;
		reference: string;
		successUrl: string;
		cancelUrl: string;
	}): Promise<StripeCheckout>;
}

export interface SignatureCheck {
	valid: boolean;
	reason?: string;
}

export function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } {
	let timestamp = 0;
	const signatures: string[] = [];

	for (const part of header.split(",")) {
		const [key, value] = part.trim().split("=", 2);
		if (key === "t") timestamp = Number(value);
		if (key === "v1" && value) signatures.push(value);
	}

	return { timestamp, signatures };
}

export function verifySignature(secret: string, header: string, rawBody: string, toleranceSeconds = 300, now = Date.now()): SignatureCheck {
	if (!secret) return { valid: false, reason: "No signing secret is configured" };
	if (!header) return { valid: false, reason: "Signature header is missing" };

	const { timestamp, signatures } = parseSignatureHeader(header);

	if (!Number.isFinite(timestamp) || timestamp <= 0) return { valid: false, reason: "Signature header has no timestamp" };
	if (signatures.length === 0) return { valid: false, reason: "Signature header has no v1 signature" };

	const age = Math.abs(now / 1000 - timestamp);
	if (age > toleranceSeconds) return { valid: false, reason: "Signature timestamp is outside the tolerance window" };

	const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
	const expectedBuffer = Buffer.from(expected, "utf8");

	for (const candidate of signatures) {
		const candidateBuffer = Buffer.from(candidate, "utf8");
		if (candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer)) return { valid: true };
	}

	return { valid: false, reason: "Signature does not match" };
}

export class StripeApiClient implements StripeClient {
	private readonly baseUrl: string;
	private readonly secretKey: string;
	private readonly timeoutMs: number;

	constructor(options: { baseUrl?: string; secretKey: string; timeoutMs?: number }) {
		this.baseUrl = (options.baseUrl || "https://api.stripe.com").replace(/\/+$/, "");
		this.secretKey = options.secretKey;
		this.timeoutMs = options.timeoutMs ?? 15000;
	}

	async createCheckout(options: {
		amountMinor: number;
		currency: string;
		description: string;
		reference: string;
		successUrl: string;
		cancelUrl: string;
	}): Promise<StripeCheckout> {
		const form = new URLSearchParams({
			mode: "payment",
			success_url: options.successUrl,
			cancel_url: options.cancelUrl,
			client_reference_id: options.reference,
			"line_items[0][quantity]": "1",
			"line_items[0][price_data][currency]": options.currency.toLowerCase(),
			"line_items[0][price_data][unit_amount]": String(options.amountMinor),
			"line_items[0][price_data][product_data][name]": options.description,
			"metadata[reference]": options.reference,
		});

		const response = await fetch(`${this.baseUrl}/v1/checkout/sessions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.secretKey}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: form,
			signal: AbortSignal.timeout(this.timeoutMs),
		});

		const payload = (await response.json()) as { id?: string; url?: string; error?: { message?: string } };

		if (!response.ok || !payload.id || !payload.url) {
			throw new Error(payload.error?.message ?? `Stripe responded ${response.status}`);
		}

		return { id: payload.id, url: payload.url };
	}
}
