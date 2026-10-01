import { Api, type CompanyLookup } from "./api";
import { filterOptions, type ComboOption } from "../../server/option-search";
import { t } from "./i18n";

export interface CompanySearch {
	search(query: string): Promise<ComboOption[]>;
	found(option: ComboOption | null): CompanyLookup | null;
}

export function lookupHint(result: CompanyLookup): string {
	const place = [result.postal_code, result.city].filter(Boolean).join(" ");
	return [t(result.source === "furs" ? "lookup.source_furs" : "lookup.source_vies"), result.vat_number ?? result.tax_number, place].filter(Boolean).join(" | ");
}

export function companySearch(local: ComboOption[] = []): CompanySearch {
	const known = new Map<string, CompanyLookup>();
	return {
		async search(query) {
			const own = filterOptions(local, query, query.trim() ? 8 : local.length);
			if (query.trim().length < 2) return own;
			const results = (await Api.registrySearch(query).catch(() => ({ results: [] }))).results;
			const taken = new Set(own.map((option) => option.label.toLowerCase()));
			const extra = results
				.filter((result) => !taken.has(result.name.toLowerCase()))
				.map((result) => {
					const option: ComboOption = { value: `registry:${result.tax_number ?? result.vat_number}`, label: result.name, hint: lookupHint(result) };
					known.set(option.value, result);
					return option;
				});
			return [...own, ...extra];
		},
		found(option) {
			return option ? (known.get(option.value) ?? null) : null;
		},
	};
}

export function watchVatNumber(control: HTMLInputElement, onFound: (result: CompanyLookup) => void, enabled: () => boolean = () => true) {
	let last = "";
	control.addEventListener("change", async () => {
		const typed = control.value.trim();
		if (typed === last || typed.length < 8 || !enabled()) return;
		last = typed;
		const { result } = await Api.registryVat(typed).catch(() => ({ result: null }));
		if (result && control.value.trim() === typed) onFound(result);
	});
}
