import { minorUnitDigits } from "../invoicing";

export interface PaypalOrder {
	id: string;
	approveUrl: string;
}

export interface PaypalSignatureInput {
	transmissionId: string;
	transmissionTime: string;
	transmissionSig: string;
	certUrl: string;
	authAlgo: string;
	rawBody: string;
}

export interface PaypalClient {
	createOrder(options: { amountMinor: number; currency: string; reference: string; returnUrl: string; cancelUrl: string }): Promise<PaypalOrder>;
	captureOrder(orderId: string): Promise<{ captureId: string; amountMinor: number; currency: string } | null>;
	verifyWebhook(input: PaypalSignatureInput): Promise<boolean>;
}

export function toDecimalString(amountMinor: number, currency: string): string {
	const digits = minorUnitDigits(currency);
	return (amountMinor / Math.pow(10, digits)).toFixed(digits);
}

export function toMinorUnits(value: string | number, currency: string): number {
	const amount = typeof value === "string" ? Number(value) : value;
	if (!Number.isFinite(amount)) return 0;

	const scale = Math.pow(10, minorUnitDigits(currency));
	return Math.round(Math.round(amount * scale * 1e6) / 1e6);
}

export class PaypalApiClient implements PaypalClient {
	private readonly baseUrl: string;
	private readonly clientId: string;
	private readonly clientSecret: string;
	private readonly webhookId: string;
	private readonly timeoutMs: number;
	private token: { value: string; expiresAt: number } | null = null;

	constructor(options: { baseUrl?: string; clientId: string; clientSecret: string; webhookId: string; timeoutMs?: number }) {
		this.baseUrl = (options.baseUrl || "https://api-m.paypal.com").replace(/\/+$/, "");
		this.clientId = options.clientId;
		this.clientSecret = options.clientSecret;
		this.webhookId = options.webhookId;
		this.timeoutMs = options.timeoutMs ?? 15000;
	}

	private async accessToken(): Promise<string> {
		if (this.token && this.token.expiresAt > Date.now()) return this.token.value;

		const response = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
			method: "POST",
			headers: {
				Authorization: `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: "grant_type=client_credentials",
			signal: AbortSignal.timeout(this.timeoutMs),
		});

		const payload = (await response.json()) as { access_token?: string; expires_in?: number; error_description?: string };

		if (!response.ok || !payload.access_token) throw new Error(payload.error_description ?? `PayPal responded ${response.status}`);

		this.token = { value: payload.access_token, expiresAt: Date.now() + Math.max((payload.expires_in ?? 600) - 60, 60) * 1000 };
		return this.token.value;
	}

	private async authorized<T>(path: string, body: unknown): Promise<{ ok: boolean; status: number; payload: T }> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${await this.accessToken()}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(this.timeoutMs),
		});

		return { ok: response.ok, status: response.status, payload: (await response.json()) as T };
	}

	async createOrder(options: { amountMinor: number; currency: string; reference: string; returnUrl: string; cancelUrl: string }): Promise<PaypalOrder> {
		const { ok, status, payload } = await this.authorized<{
			id?: string;
			links?: { rel?: string; href?: string }[];
			message?: string;
		}>("/v2/checkout/orders", {
			intent: "CAPTURE",
			purchase_units: [
				{
					custom_id: options.reference,
					invoice_id: options.reference,
					amount: { currency_code: options.currency.toUpperCase(), value: toDecimalString(options.amountMinor, options.currency) },
				},
			],
			application_context: { return_url: options.returnUrl, cancel_url: options.cancelUrl, user_action: "PAY_NOW" },
		});

		const approve = payload.links?.find((link) => link.rel === "approve")?.href;

		if (!ok || !payload.id || !approve) throw new Error(payload.message ?? `PayPal responded ${status}`);

		return { id: payload.id, approveUrl: approve };
	}

	async captureOrder(orderId: string): Promise<{ captureId: string; amountMinor: number; currency: string } | null> {
		const { ok, payload } = await this.authorized<{
			purchase_units?: { payments?: { captures?: { id?: string; amount?: { currency_code?: string; value?: string } }[] } }[];
		}>(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {});

		if (!ok) return null;

		const capture = payload.purchase_units?.[0]?.payments?.captures?.[0];
		if (!capture?.id || !capture.amount?.value || !capture.amount.currency_code) return null;

		return {
			captureId: capture.id,
			amountMinor: toMinorUnits(capture.amount.value, capture.amount.currency_code),
			currency: capture.amount.currency_code.toUpperCase(),
		};
	}

	async verifyWebhook(input: PaypalSignatureInput): Promise<boolean> {
		if (!this.webhookId) return false;

		let event: unknown;
		try {
			event = JSON.parse(input.rawBody);
		} catch {
			return false;
		}

		const { ok, payload } = await this.authorized<{ verification_status?: string }>("/v1/notifications/verify-webhook-signature", {
			transmission_id: input.transmissionId,
			transmission_time: input.transmissionTime,
			cert_url: input.certUrl,
			auth_algo: input.authAlgo,
			transmission_sig: input.transmissionSig,
			webhook_id: this.webhookId,
			webhook_event: event,
		});

		return ok && payload.verification_status === "SUCCESS";
	}
}
