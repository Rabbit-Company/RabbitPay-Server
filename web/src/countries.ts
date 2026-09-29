import { COUNTRY_CODES } from "../../server/countries";
import type { ComboOption } from "./combobox";
import { locale } from "./i18n";

const cached = new Map<string, ComboOption[]>();
const names = new Map<string, Intl.DisplayNames | null>();

function regionNames(): Intl.DisplayNames | null {
	const code = locale();
	if (!names.has(code)) {
		try {
			names.set(code, new Intl.DisplayNames(code, { type: "region" }));
		} catch {
			names.set(code, null);
		}
	}
	return names.get(code) ?? null;
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
	const code = locale();
	let options = cached.get(code);
	if (!options) {
		options = COUNTRY_CODES.map((entry) => ({ value: entry, label: countryName(entry), hint: entry })).sort((a, b) => a.label.localeCompare(b.label, code));
		cached.set(code, options);
	}
	return options;
}
