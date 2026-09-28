import { Api } from "../api";
import { combobox, type Combobox } from "../combobox";
import { el, input } from "../dom";
import { t } from "../i18n";
import { icon } from "../storefront/icons";
import { customerOption } from "./invoice-editor";

export interface CustomerFilter {
	combo: Combobox;
	clear: HTMLButtonElement;
	readonly value: string;
	onChange(listener: () => void): void;
}

export async function customerFilter(uuid: string, requested: string | null): Promise<CustomerFilter> {
	const preselected = requested ? await Api.customer(uuid, requested).catch(() => null) : null;
	const combo = combobox({
		class: "combo-customer",
		placeholder: t("invoices.all_customers"),
		emptyText: t("editor.no_customer_match"),
		selected: preselected ? customerOption(preselected) : null,
		search: async (query) => (await Api.customers(uuid, { search: query || undefined, limit: 20 })).customers.map(customerOption),
	});
	const clear = el("button", { class: "icon-button", type: "button", title: t("invoices.show_all_customers") }, icon("close", 16));
	const listeners: (() => void)[] = [];

	const changed = () => {
		clear.hidden = !combo.value;
		for (const listener of listeners) listener();
	};

	combo.onChange(changed);
	clear.addEventListener("click", () => {
		combo.select(null);
		changed();
	});
	clear.hidden = !combo.value;

	return {
		combo,
		clear,
		get value() {
			return combo.value;
		},
		onChange(listener) {
			listeners.push(listener);
		},
	};
}

export function searchFilter(value: string, placeholder: string, onSearch: () => void): HTMLInputElement {
	const field = input("search", { value, maxlength: "64", placeholder });
	let debounce: ReturnType<typeof setTimeout>;
	field.addEventListener("input", () => {
		clearTimeout(debounce);
		debounce = setTimeout(onSearch, 250);
	});
	return field;
}

export function rememberFilters(path: string, values: Record<string, string>) {
	const query = new URLSearchParams(Object.entries(values).filter(([, value]) => value !== ""));
	history.replaceState({}, "", `${path}${query.size > 0 ? `?${query}` : ""}`);
}
