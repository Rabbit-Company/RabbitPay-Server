import { el, field, input } from "./dom";
import { countryOptions } from "./countries";
import { t } from "./i18n";
import type { StoreAddress } from "./api";

export interface AddressValue {
	name: string;
	phone: string | null;
	address_line1: string;
	address_line2: string | null;
	postal_code: string;
	city: string;
	state: string | null;
	country: string;
}

export interface CustomerValue extends AddressValue {
	customer_type: "individual" | "business";
	company: string | null;
	vat_number: string | null;
	tax_number: string | null;
}

export interface AddressForm {
	element: HTMLElement;
	country: HTMLSelectElement;
	read(): AddressValue;
	fill(value: Partial<StoreAddress>): void;
	setRequired(required: boolean): void;
}

function text(value: string): string | null {
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

export function countrySelect(selected: string | null): HTMLSelectElement {
	const node = el("select", { autocomplete: "country" }, el("option", { value: "" }, t("forms.choose_country")));
	for (const option of countryOptions()) {
		const entry = el("option", { value: option.value }, option.label);
		entry.selected = option.value === selected;
		node.append(entry);
	}
	return node;
}

export function addressForm(
	initial: Partial<StoreAddress> | null,
	options: { prefix?: string; nameLabel?: string; phoneRequired?: boolean } = {}
): AddressForm {
	const prefix = options.prefix ?? "";
	const auto = (token: string) => (prefix ? `${prefix} ${token}` : token);
	const name = input("text", { autocomplete: auto("name"), maxlength: "150", required: true });
	const phone = input("tel", { autocomplete: auto("tel"), maxlength: "40", required: options.phoneRequired });
	const line1 = input("text", { autocomplete: auto("address-line1"), maxlength: "200", required: true });
	const line2 = input("text", { autocomplete: auto("address-line2"), maxlength: "200" });
	const postal = input("text", { autocomplete: auto("postal-code"), maxlength: "20", required: true });
	const city = input("text", { autocomplete: auto("address-level2"), maxlength: "100", required: true });
	const state = input("text", { autocomplete: auto("address-level1"), maxlength: "100" });
	const country = countrySelect(initial?.country ?? null);
	country.required = true;
	country.autocomplete = auto("country") as AutoFill;
	const requiredInputs = [name, line1, postal, city, country];

	const fill = (value: Partial<StoreAddress>) => {
		name.value = value.name ?? "";
		phone.value = value.phone ?? "";
		line1.value = value.address_line1 ?? "";
		line2.value = value.address_line2 ?? "";
		postal.value = value.postal_code ?? "";
		city.value = value.city ?? "";
		state.value = value.state ?? "";
		if (value.country) country.value = value.country;
	};
	if (initial) fill(initial);

	return {
		element: el(
			"div",
			{ class: "form-stack" },
			el(
				"div",
				{ class: "form-grid" },
				field(options.nameLabel ?? t("forms.full_name"), name),
				field(t("forms.phone"), phone, options.phoneRequired ? undefined : t("forms.optional"))
			),
			field(t("forms.street"), line1),
			field(t("forms.street_more"), line2, t("forms.optional")),
			el(
				"div",
				{ class: "form-grid three" },
				field(t("forms.postal_code"), postal),
				field(t("forms.city"), city),
				field(t("forms.state"), state, t("forms.optional"))
			),
			field(t("forms.country"), country)
		),
		country,
		read: () => ({
			name: name.value.trim(),
			phone: text(phone.value),
			address_line1: line1.value.trim(),
			address_line2: text(line2.value),
			postal_code: postal.value.trim(),
			city: city.value.trim(),
			state: text(state.value),
			country: country.value,
		}),
		fill,
		setRequired(required: boolean) {
			for (const entry of requiredInputs) entry.required = required;
		},
	};
}

export interface CustomerForm {
	element: HTMLElement;
	address: AddressForm;
	type(): "individual" | "business";
	vat(): string | null;
	read(): CustomerValue;
	onChange(listener: () => void): void;
}

export function customerForm(
	initial: (Partial<StoreAddress> & { customer_type?: string; company?: string | null; vat_number?: string | null; tax_number?: string | null }) | null,
	allowBusiness: boolean
): CustomerForm {
	const address = addressForm(initial);
	const listeners: (() => void)[] = [];
	const notify = () => listeners.forEach((listener) => listener());
	const company = input("text", { autocomplete: "organization", maxlength: "200", value: initial?.company ?? "" });
	const vat = input("text", { maxlength: "40", value: initial?.vat_number ?? "", placeholder: "SI12345678" });
	const tax = input("text", { maxlength: "40", value: initial?.tax_number ?? "" });
	let type: "individual" | "business" = allowBusiness && initial?.customer_type === "business" ? "business" : "individual";

	const businessFields = el(
		"div",
		{ class: "form-grid three" },
		field(t("forms.company"), company),
		field(t("forms.vat_number"), vat, t("forms.vat_hint")),
		field(t("forms.tax_number"), tax, t("forms.optional"))
	);

	const toggle = el("div", { class: "segmented" });
	toggle.setAttribute("role", "radiogroup");
	const choices = (["individual", "business"] as const).map((value) => {
		const button = el("button", { type: "button", class: "segment" }, t(value === "individual" ? "forms.individual" : "forms.business"));
		button.setAttribute("role", "radio");
		button.addEventListener("click", () => {
			type = value;
			sync();
			notify();
		});
		toggle.append(button);
		return { value, button };
	});

	const sync = () => {
		businessFields.hidden = type !== "business";
		company.required = type === "business";
		for (const choice of choices) {
			choice.button.classList.toggle("active", choice.value === type);
			choice.button.setAttribute("aria-checked", String(choice.value === type));
		}
	};
	sync();

	address.country.addEventListener("change", notify);
	vat.addEventListener("change", notify);

	return {
		element: el("div", { class: "form-stack" }, allowBusiness ? toggle : null, allowBusiness ? businessFields : null, address.element),
		address,
		type: () => type,
		vat: () => (type === "business" ? text(vat.value) : null),
		read: () => ({
			...address.read(),
			customer_type: type,
			company: type === "business" ? text(company.value) : null,
			vat_number: type === "business" ? text(vat.value) : null,
			tax_number: type === "business" ? text(tax.value) : null,
		}),
		onChange(listener) {
			listeners.push(listener);
		},
	};
}
