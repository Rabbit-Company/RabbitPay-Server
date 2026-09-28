export const COIN_UNITS: Record<string, { ticker: string; decimals: number; baseUnit: string }> = {
	satoshi: { ticker: "BTC", decimals: 8, baseUnit: "satoshis" },
	wei: { ticker: "ETH", decimals: 18, baseUnit: "wei" },
	piconero: { ticker: "XMR", decimals: 12, baseUnit: "piconero" },
};

export function fromBaseUnits(amount: string, decimals: number): string {
	const digits = amount.replace(/[^0-9]/g, "").padStart(decimals + 1, "0");
	const whole = digits.slice(0, digits.length - decimals).replace(/^0+(?=\d)/, "");
	const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");

	return fraction ? `${whole}.${fraction}` : whole;
}

export function coinAmount(amount: string | number | undefined, unit: string | undefined) {
	const raw = String(amount ?? "0");
	const known = COIN_UNITS[unit ?? ""];

	if (!known) return { amount: raw, ticker: unit ?? "units", base: raw, baseUnit: "" };

	return { amount: fromBaseUnits(raw, known.decimals), ticker: known.ticker, base: raw, baseUnit: known.baseUnit };
}
