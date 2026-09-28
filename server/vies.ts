import { Settings } from "./settings";
import type { VatNumberParts } from "./tax";

export interface ViesResult {
	valid: boolean;
	name: string | null;
	address: string | null;
	reference: string | null;
	checkedAt: number;
}

export class ViesUnavailable extends Error {
	readonly reason: string;

	constructor(reason: string) {
		super(`VIES could not answer: ${reason}`);
		this.reason = reason;
	}
}

interface CheckResponse {
	valid?: boolean;
	name?: string;
	address?: string;
	requestIdentifier?: string;
	requestDate?: string;
	actionSucceed?: boolean;
	errorWrappers?: { error?: string; message?: string }[];
}

const DEFAULT_URL = "https://ec.europa.eu/taxation_customs/vies/rest-api";

export function isEnabled(): boolean {
	return Settings.vies?.enabled !== false;
}

function meaningful(value: string | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.replace(/\s+/g, " ").trim();
	return trimmed === "" || /^-+$/.test(trimmed) ? null : trimmed;
}

export async function checkVatNumber(vat: VatNumberParts, requester: VatNumberParts | null): Promise<ViesResult> {
	const baseUrl = (Settings.vies?.api_url || DEFAULT_URL).replace(/\/+$/, "");
	const timeoutMs = Math.max(Settings.vies?.timeout ?? 20, 1) * 1000;

	const body: Record<string, string> = { countryCode: vat.prefix, vatNumber: vat.number };
	if (requester) {
		body.requesterMemberStateCode = requester.prefix;
		body.requesterNumber = requester.number;
	}

	let response: Response;
	try {
		response = await fetch(`${baseUrl}/check-vat-number`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		throw new ViesUnavailable(err instanceof Error && err.name === "TimeoutError" ? "TIMEOUT" : "UNREACHABLE");
	}

	let payload: CheckResponse;
	try {
		payload = (await response.json()) as CheckResponse;
	} catch {
		throw new ViesUnavailable(`HTTP_${response.status}`);
	}

	const reason = payload.errorWrappers?.[0]?.error;
	if (payload.actionSucceed === false || reason) {
		if (reason === "INVALID_INPUT") return { valid: false, name: null, address: null, reference: null, checkedAt: Date.now() };
		throw new ViesUnavailable(reason ?? `HTTP_${response.status}`);
	}

	if (!response.ok || typeof payload.valid !== "boolean") throw new ViesUnavailable(`HTTP_${response.status}`);

	const answeredAt = payload.requestDate ? Date.parse(payload.requestDate) : NaN;

	return {
		valid: payload.valid,
		name: payload.valid ? meaningful(payload.name) : null,
		address: payload.valid ? meaningful(payload.address) : null,
		reference: meaningful(payload.requestIdentifier),
		checkedAt: Number.isFinite(answeredAt) ? answeredAt : Date.now(),
	};
}
