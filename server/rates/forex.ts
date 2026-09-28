import Cache from "../cache";
import { Logger } from "../logger";
import { Settings } from "../settings";

export const ASSET_SYMBOLS: Record<string, string> = {
	bitcoin: "BTC",
	ethereum: "ETH",
	monero: "XMR",
};

export interface RateProvider {
	unitsPerAsset(currency: string, symbol: string): Promise<number | null>;
	fiatRates?(base: string): Promise<Record<string, number> | null>;
}

interface RatesResponse {
	base?: string;
	rates?: Record<string, number>;
	timestamps?: Record<string, string | null>;
}

export function isEnabled(): boolean {
	return Settings.rates?.enabled !== false;
}

export function symbolFor(processor: string): string | null {
	return ASSET_SYMBOLS[processor] ?? null;
}

export class RabbitForexProvider implements RateProvider {
	private readonly baseUrl: string;
	private readonly cacheSeconds: number;
	private readonly timeoutMs: number;

	constructor(options: { baseUrl?: string; cacheSeconds?: number; timeoutMs?: number } = {}) {
		this.baseUrl = (options.baseUrl || "https://forex.rabbitmonitor.com").replace(/\/+$/, "");
		this.cacheSeconds = options.cacheSeconds ?? 60;
		this.timeoutMs = options.timeoutMs ?? 10000;
	}

	private async ratesFrom(path: string, key: string, label: string): Promise<Record<string, number> | null> {
		const cached = await Cache.getString(key);
		if (cached !== null) {
			try {
				return JSON.parse(cached) as Record<string, number>;
			} catch {
				void 0;
			}
		}

		let payload: RatesResponse;
		try {
			const response = await fetch(`${this.baseUrl}${path}`, {
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(this.timeoutMs),
			});

			if (!response.ok) throw new Error(`Rates API responded ${response.status}`);

			payload = (await response.json()) as RatesResponse;
		} catch (err) {
			Logger.error(`[RATES] Could not read ${label}: ${err}`);
			return null;
		}

		if (!payload.rates || typeof payload.rates !== "object") return null;

		await Cache.setString(key, JSON.stringify(payload.rates), this.cacheSeconds, this.cacheSeconds);
		return payload.rates;
	}

	private async cryptoRates(currency: string): Promise<Record<string, number> | null> {
		const base = currency.toUpperCase();
		return await this.ratesFrom(`/v1/crypto/rates/${encodeURIComponent(base)}`, `forex_crypto_${base}`, `${base} crypto rates`);
	}

	async fiatRates(base: string): Promise<Record<string, number> | null> {
		const code = base.toUpperCase();
		return await this.ratesFrom(`/v1/rates/${encodeURIComponent(code)}`, `forex_fiat_${code}`, `${code} currency rates`);
	}

	async unitsPerAsset(currency: string, symbol: string): Promise<number | null> {
		const rates = await this.cryptoRates(currency);
		if (!rates) return null;

		const assetPerUnit = rates[symbol.toUpperCase()];
		if (typeof assetPerUnit !== "number" || !Number.isFinite(assetPerUnit) || assetPerUnit <= 0) {
			Logger.warn(`[RATES] No usable ${symbol} rate against ${currency}`);
			return null;
		}

		return 1 / assetPerUnit;
	}
}

let provider: RateProvider | null = null;

export function rateProvider(): RateProvider {
	if (!provider) {
		provider = new RabbitForexProvider({
			baseUrl: Settings.rates?.api_url,
			cacheSeconds: Settings.rates?.cache_seconds,
		});
	}

	return provider;
}

export function setRateProvider(replacement: RateProvider | null) {
	provider = replacement;
}

export const CURRENCY_BASE = "USD";

export interface CurrencyRates {
	base: string;
	currencies: string[];
	rates: Record<string, number>;
	live: boolean;
}

function knownCurrencyCodes(): string[] {
	try {
		return [...Intl.supportedValuesOf("currency")];
	} catch {
		return ["EUR", "USD", "GBP", "CHF"];
	}
}

export async function currencyRates(): Promise<CurrencyRates> {
	const rates = isEnabled() ? ((await rateProvider().fiatRates?.(CURRENCY_BASE)) ?? null) : null;

	if (!rates) return { base: CURRENCY_BASE, currencies: knownCurrencyCodes(), rates: {}, live: false };

	const usable = Object.entries(rates).filter(([, rate]) => typeof rate === "number" && Number.isFinite(rate) && rate > 0);

	return {
		base: CURRENCY_BASE,
		currencies: usable.map(([code]) => code).sort(),
		rates: Object.fromEntries(usable),
		live: true,
	};
}

export function convert(amount: number, from: string, to: string, rates: Record<string, number>): number | null {
	const source = rates[from.toUpperCase()];
	const target = rates[to.toUpperCase()];
	if (!source || !target) return null;

	return (amount / source) * target;
}

export async function rateFor(currency: string, processor: string): Promise<number | null> {
	if (!isEnabled()) return null;

	const symbol = symbolFor(processor);
	if (!symbol) return null;

	return await rateProvider().unitsPerAsset(currency, symbol);
}
