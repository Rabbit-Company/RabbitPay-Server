import { COUNTRY_CODES } from "../../server/countries";
import type { ComboOption } from "./combobox";
import { language } from "./i18n";

const cached = new Map<string, ComboOption[]>();
const names = new Map<string, Intl.DisplayNames | null>();

function regionNames(): Intl.DisplayNames | null {
	const locale = language();
	if (!names.has(locale)) {
		try {
			names.set(locale, new Intl.DisplayNames(locale, { type: "region" }));
		} catch {
			names.set(locale, null);
		}
	}
	return names.get(locale) ?? null;
}

export function countryName(code: string): string {
	const name = regionNames()?.of(code);
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
	const locale = language();
	let options = cached.get(locale);
	if (!options) {
		options = COUNTRY_CODES.map((code) => ({ value: code, label: countryName(code), hint: code })).sort((a, b) => a.label.localeCompare(b.label, locale));
		cached.set(locale, options);
	}
	return options;
}
