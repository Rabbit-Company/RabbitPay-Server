export interface MeasureUnit {
	code: string;
	name: { en: string; sl: string };
	symbol: { en: string; sl: string };
}

export const DEFAULT_UNIT_CODE = "C62";

export const MEASURE_UNITS: readonly MeasureUnit[] = [
	{ code: "C62", name: { en: "Piece", sl: "Kos" }, symbol: { en: "pc", sl: "kos" } },
	{ code: "SET", name: { en: "Set", sl: "Komplet" }, symbol: { en: "set", sl: "kpl" } },
	{ code: "PR", name: { en: "Pair", sl: "Par" }, symbol: { en: "pair", sl: "par" } },
	{ code: "XPK", name: { en: "Package", sl: "Paket" }, symbol: { en: "pkg", sl: "pak" } },
	{ code: "MIN", name: { en: "Minute", sl: "Minuta" }, symbol: { en: "min", sl: "min" } },
	{ code: "HUR", name: { en: "Hour", sl: "Ura" }, symbol: { en: "h", sl: "h" } },
	{ code: "DAY", name: { en: "Day", sl: "Dan" }, symbol: { en: "day", sl: "dan" } },
	{ code: "WEE", name: { en: "Week", sl: "Teden" }, symbol: { en: "wk", sl: "ted" } },
	{ code: "MON", name: { en: "Month", sl: "Mesec" }, symbol: { en: "mo", sl: "mes" } },
	{ code: "ANN", name: { en: "Year", sl: "Leto" }, symbol: { en: "yr", sl: "let" } },
	{ code: "GRM", name: { en: "Gram", sl: "Gram" }, symbol: { en: "g", sl: "g" } },
	{ code: "KGM", name: { en: "Kilogram", sl: "Kilogram" }, symbol: { en: "kg", sl: "kg" } },
	{ code: "TNE", name: { en: "Tonne", sl: "Tona" }, symbol: { en: "t", sl: "t" } },
	{ code: "MTR", name: { en: "Metre", sl: "Meter" }, symbol: { en: "m", sl: "m" } },
	{ code: "KMT", name: { en: "Kilometre", sl: "Kilometer" }, symbol: { en: "km", sl: "km" } },
	{ code: "MTK", name: { en: "Square metre", sl: "Kvadratni meter" }, symbol: { en: "m²", sl: "m²" } },
	{ code: "MTQ", name: { en: "Cubic metre", sl: "Kubični meter" }, symbol: { en: "m³", sl: "m³" } },
	{ code: "LTR", name: { en: "Litre", sl: "Liter" }, symbol: { en: "l", sl: "l" } },
	{ code: "KWH", name: { en: "Kilowatt hour", sl: "Kilovatna ura" }, symbol: { en: "kWh", sl: "kWh" } },
	{ code: "E48", name: { en: "Service unit", sl: "Storitev" }, symbol: { en: "svc", sl: "stor" } },
];

const BY_CODE = new Map(MEASURE_UNITS.map((unit) => [unit.code, unit]));

export function isUnitCode(value: unknown): value is string {
	return typeof value === "string" && BY_CODE.has(value);
}

function localized<T>(value: { en: T; sl: T }, language: string | null | undefined): T {
	return language === "sl" ? value.sl : value.en;
}

export function unitName(code: string, language: string | null | undefined): string {
	const unit = BY_CODE.get(code);
	return unit ? localized(unit.name, language) : code;
}

export function unitSymbol(code: string | null | undefined, language: string | null | undefined): string | null {
	if (!code) return null;
	const unit = BY_CODE.get(code);
	return unit ? localized(unit.symbol, language) : code;
}

export function quantityWithUnit(quantity: string, code: string | null | undefined, language: string | null | undefined): string {
	const symbol = unitSymbol(code, language);
	return symbol ? `${quantity} ${symbol}` : quantity;
}
