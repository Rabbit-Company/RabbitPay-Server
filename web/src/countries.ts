import { COUNTRY_CODES } from "../../server/countries";
import type { ComboOption } from "./combobox";

let cached: ComboOption[] | null = null;
let names: Intl.DisplayNames | null | undefined;

export function countryName(code: string): string {
	if (names === undefined) {
		try {
			names = new Intl.DisplayNames(undefined, { type: "region" });
		} catch {
			names = null;
		}
	}

	const name = names?.of(code);
	return name && name !== code ? name : code;
}

export function countryCodeFor(value: string | null | undefined): string {
	const text = value?.trim() ?? "";
	if (!text) return "";
	if (COUNTRY_CODES.includes(text.toUpperCase())) return text.toUpperCase();

	const wanted = text.toLocaleLowerCase();
	for (const locale of [undefined, "en", "sl"]) {
		let regions: Intl.DisplayNames;
		try {
			regions = new Intl.DisplayNames(locale, { type: "region" });
		} catch {
			continue;
		}
		const match = COUNTRY_CODES.find((code) => regions.of(code)?.toLocaleLowerCase() === wanted);
		if (match) return match;
	}
	return "";
}

export function countryOptions(): ComboOption[] {
	if (!cached) {
		cached = COUNTRY_CODES.map((code) => ({ value: code, label: countryName(code), hint: code })).sort((a, b) => a.label.localeCompare(b.label));
	}
	return cached;
}
