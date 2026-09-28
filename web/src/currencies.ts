import { Api, type CurrencyRates } from "./api";

const FALLBACK: CurrencyRates = { base: "USD", currencies: ["EUR", "USD", "GBP", "CHF"], rates: {}, live: false };

let cached: CurrencyRates | null = null;
let inflight: Promise<CurrencyRates> | null = null;

export async function currencyRates(): Promise<CurrencyRates> {
	if (cached) return cached;

	if (!inflight) {
		inflight = Api.currencies()
			.catch(() => FALLBACK)
			.then((result) => {
				cached = result.currencies.length > 0 ? result : FALLBACK;
				inflight = null;
				return cached;
			});
	}

	return await inflight;
}

let names: Intl.DisplayNames | null = null;

function displayName(code: string): string | null {
	try {
		if (!names) names = new Intl.DisplayNames(undefined, { type: "currency" });
		const resolved = names.of(code);
		return resolved && resolved !== code ? resolved : null;
	} catch {
		return null;
	}
}

export function currencyLabel(code: string): string {
	const name = displayName(code);
	return name ? `${code} (${name})` : code;
}

export function currencyOptions(codes: string[], preferred: string, withNames = true): { value: string; label: string; hint?: string }[] {
	const listed = codes.includes(preferred) ? codes : [preferred, ...codes];
	const top = listed.filter((code) => code === preferred);
	const rest = listed.filter((code) => code !== preferred);

	return [...top, ...rest].map((code) =>
		withNames ? { value: code, label: currencyLabel(code) } : { value: code, label: code, hint: displayName(code) ?? undefined }
	);
}

export function convertAmount(amount: number, from: string, to: string, rates: Record<string, number>): number | null {
	const source = rates[from.toUpperCase()];
	const target = rates[to.toUpperCase()];
	if (!source || !target) return null;

	return (amount / source) * target;
}
