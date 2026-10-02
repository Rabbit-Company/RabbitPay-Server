import Database from "../database/database";
import { Logger } from "../logger";
import { Settings } from "../settings";
import { isLocalDate, localDate, shiftLocalDate } from "../timezone";
import { children, parseXml } from "../xml-reader";

export const ECB_SOURCE = "ECB";
export const ECB_TIMEZONE = "Europe/Berlin";
export const ECB_LOOKBACK_DAYS = 6;

const RECENT_FILE = "eurofxref-hist-90d.xml";
const HISTORY_FILE = "eurofxref-hist.xml";
const RECENT_DAYS = 80;
const ON_DEMAND_INTERVAL_MS = 15 * 60 * 1000;
const ON_DEMAND_TIMEOUT_MS = 8000;
const DOWNLOAD_TIMEOUT_MS = 30000;
const BATCH = 500;

export interface EcbRate {
	day: string;
	currency: string;
	rate: number;
}

export class EcbFileUnreadable extends Error {}

const lastAttempt: Record<string, number> = {};

export function isEnabled(): boolean {
	return Settings.rates?.enabled !== false;
}

export function parseEcbRates(source: string): EcbRate[] {
	const rates: EcbRate[] = [];
	for (const group of children(parseXml(source), "Cube")) {
		for (const dated of children(group, "Cube")) {
			const day = dated.attributes["time"];
			if (!isLocalDate(day)) continue;
			for (const quote of children(dated, "Cube")) {
				const currency = quote.attributes["currency"];
				const rate = Number(quote.attributes["rate"]);
				if (!/^[A-Z]{3}$/.test(currency ?? "") || !Number.isFinite(rate) || rate <= 0) continue;
				rates.push({ day, currency, rate });
			}
		}
	}
	return rates;
}

export async function storeEcbRates(rates: EcbRate[], fetched = Date.now()): Promise<number> {
	if (rates.length === 0) return 0;
	const days = [...new Set(rates.map((rate) => rate.day))];
	return await Database.begin(async (tx) => {
		const known = new Set<string>();
		for (let start = 0; start < days.length; start += BATCH) {
			const stored = (await tx`SELECT DISTINCT day FROM ecb_rates WHERE day IN ${tx(days.slice(start, start + BATCH))}`) as { day: string }[];
			for (const row of stored) known.add(row.day);
		}
		const fresh = rates.filter((rate) => !known.has(rate.day)).map((rate) => ({ ...rate, fetched }));
		for (let start = 0; start < fresh.length; start += BATCH) {
			await tx`INSERT INTO ecb_rates ${tx(fresh.slice(start, start + BATCH), "day", "currency", "rate", "fetched")}`;
		}
		return fresh.length;
	});
}

async function download(file: string, timeoutMs = DOWNLOAD_TIMEOUT_MS): Promise<EcbRate[]> {
	lastAttempt[file] = Date.now();
	const base = (Settings.rates?.ecb_url || "https://www.ecb.europa.eu/stats/eurofxref").replace(/\/+$/, "");
	const response = await fetch(`${base}/${file}`, { headers: { Accept: "application/xml" }, signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw new EcbFileUnreadable(`${file} answered ${response.status}`);
	const rates = parseEcbRates(await response.text());
	if (rates.length === 0) throw new EcbFileUnreadable(`${file} holds no reference rates`);
	return rates;
}

export async function refreshEcbRates(): Promise<number> {
	return await storeEcbRates(await download(RECENT_FILE));
}

export async function ecbRatesAge(): Promise<number | null> {
	const [row] = (await Database`SELECT MAX(fetched) AS fetched FROM ecb_rates`) as { fetched: number | null }[];
	return row?.fetched === null || row?.fetched === undefined ? null : Date.now() - Number(row.fetched);
}

export async function storedEcbRate(currency: string, day: string): Promise<EcbRate | null> {
	const [row] = (await Database`
		SELECT day, currency, rate FROM ecb_rates
		WHERE currency = ${currency} AND day <= ${day} AND day >= ${shiftLocalDate(day, -ECB_LOOKBACK_DAYS)}
		ORDER BY day DESC LIMIT 1
	`) as EcbRate[];
	return row ? { day: row.day, currency: row.currency, rate: Number(row.rate) } : null;
}

async function missingFile(day: string): Promise<string | null> {
	const [published] = (await Database`SELECT 1 AS found FROM ecb_rates WHERE day = ${day} LIMIT 1`) as { found: number }[];
	if (published) return null;

	if (day >= shiftLocalDate(localDate(Date.now(), ECB_TIMEZONE), -RECENT_DAYS)) {
		const [newest] = (await Database`SELECT MAX(day) AS day FROM ecb_rates`) as { day: string | null }[];
		return newest?.day && newest.day >= day ? null : RECENT_FILE;
	}

	const [nearby] = (await Database`
		SELECT 1 AS found FROM ecb_rates WHERE day <= ${day} AND day >= ${shiftLocalDate(day, -ECB_LOOKBACK_DAYS)} LIMIT 1
	`) as { found: number }[];
	return nearby ? null : HISTORY_FILE;
}

async function fetchMissing(day: string): Promise<boolean> {
	if (!isEnabled()) return false;
	const file = await missingFile(day);
	if (file === null) return false;

	if (Date.now() - (lastAttempt[file] ?? 0) < ON_DEMAND_INTERVAL_MS) return false;

	try {
		const rates = await download(file, ON_DEMAND_TIMEOUT_MS);
		const from = shiftLocalDate(day, -ECB_LOOKBACK_DAYS);
		await storeEcbRates(file === HISTORY_FILE ? rates.filter((rate) => rate.day >= from && rate.day <= day) : rates);
		return true;
	} catch (err) {
		Logger.error(`[RATES] Could not read the ECB reference rates: ${err}`);
		return false;
	}
}

export function forgetEcbAttempts() {
	for (const file of Object.keys(lastAttempt)) delete lastAttempt[file];
}

export async function ecbReferenceRate(currency: string, day: string): Promise<EcbRate | null> {
	const code = currency.toUpperCase();
	if (!isLocalDate(day)) return null;

	const stored = await storedEcbRate(code, day);
	if (stored?.day === day) return stored;
	return (await fetchMissing(day)) ? await storedEcbRate(code, day) : stored;
}
