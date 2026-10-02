import { pagination, PAGE_SIZE } from "../pagination";
import { Api, customerLabel, ApiError, type CompanyLookup, type Customer } from "../api";
import { el, emptyState, field, input, select, table } from "../dom";
import { formatDate, formatDateTime } from "../money";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { loadProject, projectLayout } from "./project";
import { combobox, staticCombobox } from "../combobox";
import { companySearch, watchVatNumber } from "../company-lookup";
import { countryName, countryOptions } from "../countries";
import { normalizeVatNumber, splitVatNumber } from "../../../server/tax";
import { customerTypeLabel, customerTypeOptions } from "../options";
import { t } from "../i18n";
import { can, Permission } from "../access";

export function vatPrefixMissing(customer: Customer): boolean {
	const typed = customer.vat_number?.trim() ?? "";
	return typed !== "" && customer.vat_valid !== true && !/^[A-Z]{2}/i.test(typed);
}

export function vatBadge(customer: Customer): HTMLElement | null {
	if (!customer.vat_number) return null;
	if (customer.vat_valid === true) return el("span", { class: "pill pill-paid", title: t("vat.valid_title") }, t("vat.valid"));
	if (customer.vat_valid === false) return el("span", { class: "pill pill-canceled", title: t("vat.invalid_title") }, t("vat.invalid"));
	if (!splitVatNumber(customer.vat_number, customer.country)) return null;
	return el("span", { class: "pill", title: t("vat.unchecked_title") }, t("vat.unchecked"));
}

function vatStatus(customer: Customer): HTMLElement {
	if (customer.vat_valid === null || customer.vat_checked_at === null) {
		return el("p", { class: "muted" }, t("vat.not_checked_yet"));
	}

	const checked = formatDateTime(customer.vat_checked_at);

	if (!customer.vat_valid) {
		return el("p", { class: "warn" }, t("vat.check_failed", { date: checked }));
	}

	return el(
		"div",
		{ class: "vat-result" },
		el("p", {}, el("span", { class: "pill pill-paid" }, t("vat.valid")), ` ${t("vat.checked_on", { date: checked })}`),
		customer.vat_checked_name ? el("p", { class: "muted" }, t("vat.registered_as", { name: customer.vat_checked_name })) : null,
		customer.vat_checked_address ? el("p", { class: "muted" }, customer.vat_checked_address) : null,
		customer.vat_check_reference ? el("p", { class: "muted" }, t("vat.consultation", { reference: customer.vat_check_reference })) : null
	);
}

async function runVatCheck(uuid: string, customer: Customer): Promise<Customer | null> {
	try {
		const checked = await Api.checkCustomerVat(uuid, customer.uuid);
		const label = customerLabel(customer);
		if (checked.vat_valid) toast(t("vat.toast_valid", { customer: label }), "success");
		else toast(t("vat.toast_invalid", { customer: label }), "error");
		return checked;
	} catch (error) {
		if (error instanceof ApiError) toast(error.message, "error");
		else reportError(error);
		return null;
	}
}

export function customerForm(uuid: string, existing: Customer | null, onSaved: (customer: Customer) => void, prefill = "", onClosed?: () => void) {
	const typedEmail = prefill.includes("@") ? prefill : "";
	const typedName = typedEmail ? "" : prefill;
	const lookup = companySearch();
	const name = combobox({
		search: (query) => lookup.search(query),
		selected: existing?.name || typedName ? { value: existing?.name ?? typedName, label: existing?.name ?? typedName } : null,
		freeText: true,
		class: "combo-customer",
		placeholder: t("customers.name_lookup"),
	});
	const email = input("email", { value: existing?.email ?? typedEmail });
	const phone = input("text", { value: existing?.phone ?? "" });
	const line1 = input("text", { value: existing?.address_line1 ?? "" });
	const city = input("text", { value: existing?.city ?? "" });
	const postal = input("text", { value: existing?.postal_code ?? "" });
	const country = staticCombobox(countryOptions(), existing?.country ?? "", {
		placeholder: t("country.search"),
		emptyText: t("country.no_match"),
	});
	const vat = input("text", { value: existing?.vat_number ?? "", placeholder: "SI12345678" });
	const taxNumber = input("text", { value: existing?.tax_number ?? "", placeholder: "12345678" });
	const registrationNumber = input("text", { value: existing?.registration_number ?? "", placeholder: "1234567000", maxlength: "40" });
	const iban = input("text", { value: existing?.iban ?? "", placeholder: "SI56 0110 0637 0171 132", maxlength: "42" });
	const bic = input("text", { value: existing?.bic ?? "", placeholder: "UJPLSI2DICL", maxlength: "11" });
	const eInvoicing = el(
		"details",
		{ class: "form-more" },
		el("summary", {}, t("customers.einvoice_title")),
		el("p", { class: "muted" }, t("customers.einvoice_hint")),
		field(t("customers.registration_number"), registrationNumber),
		el("div", { class: "form-grid" }, field(t("customers.iban"), iban, t("customers.iban_hint")), field(t("customers.bic"), bic))
	) as HTMLDetailsElement;
	eInvoicing.open = Boolean(existing?.registration_number || existing?.iban || existing?.bic);
	const customerType = select([{ value: "", label: t("customers.type_unspecified") }, ...customerTypeOptions()], existing?.customer_type ?? "");
	const taxNumberField = field(t("customers.tax_number"), taxNumber, t("customers.tax_number_hint"));
	const refreshTaxNumber = () => {
		taxNumberField.hidden = customerType.value === "individual" && !taxNumber.value.trim();
	};
	customerType.addEventListener("change", refreshTaxNumber);
	refreshTaxNumber();

	const submit = el("button", { class: "button primary", type: "submit" }, existing ? t("ui.save") : t("customers.create"));
	const checkButton = el("button", { class: "button ghost", type: "button" }, t("customers.save_and_check"));
	const vatBox = el("div", { class: "vat-box" });
	const duplicateBox = el("div", { class: "stack" });
	duplicateBox.hidden = true;
	let acceptedNumbers = "";
	let settled = false;

	const refreshVatBox = () => {
		const typed = vat.value.trim();
		const checkable = splitVatNumber(typed, country.value || null) !== null;
		checkButton.hidden = !checkable;

		if (!typed) {
			vatBox.replaceChildren(el("p", { class: "muted" }, t("vat.hint_eu")));
			return;
		}
		if (!checkable) {
			vatBox.replaceChildren(el("p", { class: "muted" }, t("vat.hint_not_eu")));
			return;
		}
		const unchanged = existing && existing.vat_number === typed && (existing.country ?? "") === (country.value || "");
		const saved = normalizeVatNumber(typed, country.value || null);
		const status = unchanged ? vatStatus(existing) : el("p", { class: "muted" }, t("vat.will_check"));
		if (saved && !/^[A-Z]{2}/i.test(typed)) vatBox.replaceChildren(status, el("p", { class: "warn" }, t("vat.prefix_added", { vat: saved })));
		else vatBox.replaceChildren(status);
	};

	vat.addEventListener("input", refreshVatBox);
	country.onChange(refreshVatBox);
	refreshVatBox();

	const fill = (found: CompanyLookup) => {
		name.select({ value: found.name, label: found.name });
		if (found.address_line1) line1.value = found.address_line1;
		if (found.city) city.value = found.city;
		if (found.postal_code) postal.value = found.postal_code;
		if (found.country) country.select(countryOptions().find((option) => option.value === found.country) ?? null);
		vat.value = found.vat_number ?? "";
		taxNumber.value = found.tax_number ?? taxNumber.value;
		if (found.registration_number) {
			registrationNumber.value = found.registration_number;
			eInvoicing.open = true;
		}
		customerType.value = "business";
		refreshTaxNumber();
		refreshVatBox();
		toast(t("lookup.filled", { source: t(found.source === "furs" ? "lookup.source_furs" : "lookup.source_vies"), name: found.name }));
	};
	name.onChange((option) => {
		const found = lookup.found(option);
		if (found) fill(found);
	});
	watchVatNumber(vat, fill, () => !name.value.trim());

	const save = async (forceCheck: boolean) => {
		if (!form.reportValidity()) return;
		if (!name.value.trim() && !email.value.trim()) {
			toast(t("customers.need_name_or_email"), "error");
			return;
		}
		submit.disabled = true;
		checkButton.disabled = true;

		const payload = {
			name: name.value.trim() || null,
			email: email.value.trim() || null,
			phone: phone.value.trim() || null,
			address_line1: line1.value.trim() || null,
			city: city.value.trim() || null,
			postal_code: postal.value.trim() || null,
			country: country.value || null,
			vat_number: vat.value.trim() || null,
			tax_number: taxNumber.value.trim() || null,
			registration_number: registrationNumber.value.trim() || null,
			iban: iban.value.trim() || null,
			bic: bic.value.trim() || null,
			customer_type: customerType.value || null,
		};

		try {
			const numbers = `${payload.vat_number ?? ""}|${payload.tax_number ?? ""}|${payload.country ?? ""}`;
			const unchanged = existing && existing.vat_number === payload.vat_number && existing.tax_number === payload.tax_number;
			if ((payload.vat_number || payload.tax_number) && !unchanged && numbers !== acceptedNumbers) {
				const { customers: matches } = await Api.customerDuplicates(uuid, {
					vat_number: payload.vat_number,
					tax_number: payload.tax_number,
					country: payload.country,
					exclude: existing?.uuid,
				});
				if (matches.length > 0) {
					acceptedNumbers = numbers;
					duplicateBox.replaceChildren(
						el("p", { class: "warn" }, t("customers.duplicate_found")),
						el(
							"ul",
							{},
							...matches.map((match) =>
								el(
									"li",
									{},
									el("a", { href: `/projects/${uuid}/customers/${match.uuid}`, target: "_blank" }, customerLabel(match)),
									` | ${[match.vat_number, match.tax_number].filter(Boolean).join(" | ")}`
								)
							)
						),
						el("p", { class: "muted" }, t("customers.duplicate_save_again"))
					);
					duplicateBox.hidden = false;
					submit.disabled = false;
					checkButton.disabled = false;
					return;
				}
			}
			duplicateBox.hidden = true;

			const saved = existing ? await Api.updateCustomer(uuid, existing.uuid, payload) : await Api.createCustomer(uuid, payload);

			settled = true;
			dialog.close();
			toast(existing ? t("customers.updated") : t("customers.created"), "success");
			onSaved(saved);

			const checkable = splitVatNumber(saved.vat_number, saved.country) !== null;
			const unchecked = saved.vat_valid === null;
			if (checkable && (forceCheck || unchecked)) {
				const checked = await runVatCheck(uuid, saved);
				if (checked) onSaved(checked);
			}
		} catch (error) {
			reportError(error);
			submit.disabled = false;
			checkButton.disabled = false;
		}
	};

	checkButton.addEventListener("click", () => void save(true));

	const form: HTMLFormElement = el(
		"form",
		{
			onSubmit: (event) => {
				event.preventDefault();
				void save(false);
			},
		},
		el("div", { class: "form-grid" }, field(t("customers.name"), name.element), field(t("customers.email"), email, t("customers.email_hint"))),
		el("div", { class: "form-grid" }, field(t("customers.type"), customerType, t("customers.type_hint")), field(t("customers.phone"), phone)),
		field(t("customers.address"), line1),
		el(
			"div",
			{ class: "form-grid three" },
			field(t("customers.city"), city),
			field(t("customers.postal_code"), postal),
			field(t("customers.country"), country.element, t("customers.country_hint"))
		),
		el("div", { class: "form-grid" }, field(t("customers.vat_number"), vat, t("customers.vat_number_hint")), taxNumberField),
		vatBox,
		eInvoicing,
		duplicateBox,
		el("div", { class: "dialog-actions" }, checkButton, submit)
	);

	const dialog = modal(existing ? t("customers.edit") : t("customers.new"), form, () => {
		if (!settled) onClosed?.();
	});
	(typedEmail ? email : name.input).focus();
}

export async function customersView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const body = el("div", {});
	const search = input("search", { placeholder: t("customers.search_placeholder") });

	let debounce: ReturnType<typeof setTimeout>;

	const controls = pagination(() => load());
	const load = async (): Promise<void> => {
		const round = controls.state.begin();
		try {
			const result = await Api.customers(uuid, { search: search.value.trim() || undefined, limit: PAGE_SIZE, offset: controls.state.offset });

			if (!controls.state.current(round)) return;
			if (controls.update(result.total)) return await load();

			if (result.customers.length === 0) {
				body.replaceChildren(
					emptyState(
						search.value ? t("customers.none_match") : t("customers.empty"),
						search.value || !can(project, Permission.CUSTOMER_CREATE)
							? undefined
							: el("button", { class: "button primary", type: "button", onClick: () => customerForm(uuid, null, () => void load()) }, t("customers.add_first"))
					)
				);
				return;
			}

			const rows = result.customers.map((customer) =>
				el(
					"tr",
					{},
					el(
						"td",
						{},
						el("a", { href: `/projects/${uuid}/customers/${customer.uuid}` }, el("strong", {}, customer.name || t("customers.unnamed"))),
						el("div", { class: "muted" }, [customer.email, customerTypeLabel(customer.customer_type)].filter(Boolean).join(" | "))
					),
					el("td", {}, [customer.city, customer.country ? countryName(customer.country) : null].filter(Boolean).join(", ") || "-"),
					el("td", {}, customer.vat_number ? el("span", { class: "mono" }, customer.vat_number) : "-", customer.vat_number ? " " : null, vatBadge(customer)),
					el("td", {}, formatDate(customer.created)),
					el(
						"td",
						{ class: "actions" },
						el("a", { class: "button ghost small", href: `/projects/${uuid}/customers/${customer.uuid}` }, t("nav.invoices")),
						can(project, Permission.CUSTOMER_EDIT)
							? el("button", { class: "button ghost small", type: "button", onClick: () => customerForm(uuid, customer, () => void load()) }, t("ui.edit"))
							: null,
						can(project, Permission.CUSTOMER_DELETE)
							? el(
									"button",
									{
										class: "button danger small",
										type: "button",
										onClick: async () => {
											const confirmed = await confirmDialog({
												title: t("customers.delete_title"),
												body: t("customers.delete_body", { customer: customerLabel(customer) }),
												confirmLabel: t("ui.delete"),
												destructive: true,
											});
											if (!confirmed) return;

											try {
												await Api.deleteCustomer(uuid, customer.uuid);
												toast(t("customers.deleted"), "success");
												void load();
											} catch (error) {
												reportError(error);
											}
										},
									},
									t("ui.delete")
								)
							: null
					)
				)
			);

			body.replaceChildren(
				table([t("customers.column_customer"), t("customers.column_location"), t("customers.column_vat"), t("customers.column_added"), ""], rows)
			);
		} catch (error) {
			if (controls.state.current(round)) {
				controls.fail();
				reportError(error);
			}
		}
	};

	search.addEventListener("input", () => {
		controls.reset();
		clearTimeout(debounce);
		debounce = setTimeout(() => void load(), 250);
	});

	void load();

	const content = el(
		"div",
		{ class: "stack" },
		el(
			"div",
			{ class: "toolbar" },
			search,
			can(project, Permission.CUSTOMER_CREATE)
				? el(
						"button",
						{
							class: "button primary",
							type: "button",
							dataset: { shortcutAction: "new-customer" },
							onClick: () => customerForm(uuid, null, () => void load()),
						},
						t("customers.new")
					)
				: null
		),
		body,
		controls.element
	);

	return projectLayout(project, content);
}
