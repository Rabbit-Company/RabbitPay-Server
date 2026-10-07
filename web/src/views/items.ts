import { pagination, PAGE_SIZE } from "../pagination";
import { Api, ApiError, isAdmin, type CatalogItem, type ItemKey, type Project } from "../api";
import { el, emptyState, field, input, select, table } from "../dom";
import { formatMoney, minorUnitDigits, toMajorUnits, toMinorUnits } from "../money";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { loadProject, projectLayout } from "./project";
import { currencyOptions, currencyRates } from "../currencies";
import { staticCombobox } from "../combobox";
import { supplyTypeHint, supplyTypeLabel, supplyTypeOptions, taxCategoryOptions, unitOptions } from "../options";
import { t, tn } from "../i18n";
import { can, Permission } from "../access";
import { ErrorCode } from "../../../server/errors";
import { DEFAULT_REDUCED_RATES, STANDARD_RATES } from "../../../server/tax";
import { readLicenseProduct, usesAmount, usesDays, type BelowMinimum, type LicenseProduct } from "../../../server/license-pricing";
import type { UiKey } from "../i18n";

const LICENSE_TYPES: { value: LicenseProduct["type"]; label: UiKey; rate: UiKey; amount: UiKey | null }[] = [
	{ value: "transactions", label: "items.license_transactions", rate: "items.license_rate_payments", amount: "items.license_amount_payments" },
	{ value: "emails", label: "items.license_emails", rate: "items.license_rate_emails", amount: "items.license_amount_emails" },
	{ value: "storage", label: "items.license_storage", rate: "items.license_rate_storage", amount: "items.license_amount_storage" },
	{ value: "files", label: "items.license_files", rate: "items.license_rate_storage", amount: "items.license_amount_storage" },
	{ value: "white_label", label: "items.license_white_label", rate: "items.license_rate_days", amount: null },
	{ value: "store", label: "items.license_store", rate: "items.license_rate_days", amount: null },
	{ value: "workforce", label: "items.license_workforce", rate: "items.license_rate_days", amount: null },
	{ value: "accounting", label: "items.license_accounting", rate: "items.license_rate_days", amount: null },
	{ value: "employees", label: "items.license_employees", rate: "items.license_rate_employees", amount: "items.license_amount_employees" },
];

function licenseSection(existing: LicenseProduct | null, currency: () => string) {
	const type = select(
		[{ value: "", label: t("items.license_none") }, ...LICENSE_TYPES.map((entry) => ({ value: entry.value, label: t(entry.label) }))],
		existing?.type ?? ""
	);
	const money = (minor: number | null | undefined) =>
		input("number", {
			min: "0",
			step: "0.01",
			value: minor === null || minor === undefined ? "" : toMajorUnits(minor, currency()).toFixed(minorUnitDigits(currency())),
		});
	const whole = (value: number | null | undefined) =>
		input("number", { min: "1", step: "1", value: value === null || value === undefined ? "" : String(value) });
	const rate = money(existing?.rate);
	const minimum = money(existing?.minimum ?? 0);
	const belowMinimum = select(
		[
			{ value: "charge", label: t("items.license_below_charge") },
			{ value: "refuse", label: t("items.license_below_refuse") },
		],
		existing?.below_minimum ?? "charge"
	);
	const minAmount = whole(existing?.min_amount);
	const maxAmount = whole(existing?.max_amount);
	const minDays = whole(existing?.min_days ?? 30);
	const maxDays = whole(existing?.max_days ?? 3650);

	const rateField = field("", rate);
	const amountRow = el("div", { class: "form-grid" }, field("", minAmount), field(t("items.license_amount_max"), maxAmount));
	const daysRow = el("div", { class: "form-grid" }, field(t("items.license_days_min"), minDays), field(t("items.license_days_max"), maxDays));
	const details = el(
		"div",
		{ class: "stack" },
		el("div", { class: "form-grid" }, rateField, field(t("items.license_minimum"), minimum)),
		field(t("items.license_below"), belowMinimum, t("items.license_below_hint")),
		amountRow,
		daysRow,
		el("p", { class: "muted" }, t("items.license_hint"))
	);

	const listeners: (() => void)[] = [];
	const sync = () => {
		const entry = LICENSE_TYPES.find((option) => option.value === type.value);
		details.hidden = !entry;
		if (entry) {
			rateField.querySelector(".field-label")!.textContent = t(entry.rate);
			amountRow.hidden = !usesAmount(entry.value);
			daysRow.hidden = !usesDays(entry.value);
			if (entry.amount) amountRow.querySelector(".field-label")!.textContent = t(entry.amount);
		}
		for (const listener of listeners) listener();
	};
	type.addEventListener("change", sync);

	const element = el("div", { class: "stack" }, field(t("items.license"), type, t("items.license_type_hint")), details);
	return {
		element,
		active: () => type.value !== "",
		onChange: (listener: () => void) => {
			listeners.push(listener);
			sync();
		},
		read(): LicenseProduct | null | undefined {
			if (type.value === "") return null;
			const kind = type.value as LicenseProduct["type"];
			const toMinor = (field: HTMLInputElement) => toMinorUnits(Number(field.value) || 0, currency());
			const wholeValue = (field: HTMLInputElement) => (field.value === "" ? null : Number(field.value));
			return (
				readLicenseProduct({
					type: kind,
					rate: toMinor(rate),
					minimum: toMinor(minimum),
					below_minimum: belowMinimum.value as BelowMinimum,
					min_amount: usesAmount(kind) ? wholeValue(minAmount) : null,
					max_amount: usesAmount(kind) ? wholeValue(maxAmount) : null,
					min_days: usesDays(kind) ? wholeValue(minDays) : null,
					max_days: usesDays(kind) ? wholeValue(maxDays) : null,
				}) ?? undefined
			);
		},
	};
}

function stockCell(item: CatalogItem): HTMLElement {
	if (item.license) return el("span", { class: "muted" }, t("items.license_created_on_payment"));
	if (!item.delivers_keys || !item.keys) return el("span", { class: "muted" }, "-");

	const { available, delivered } = item.keys;

	return el(
		"div",
		{},
		available === 0
			? el("span", { class: "pill pill-overdue" }, t("items.out_of_stock"))
			: el("span", { class: "mono" }, t("items.keys_left", { keys: tn("count.keys", available) })),
		delivered > 0 ? el("div", { class: "muted" }, t("items.keys_sent", { count: delivered })) : null
	);
}

function keyStatusPill(key: ItemKey): HTMLElement {
	const pills: Record<ItemKey["status"], string> = { available: "open", reserved: "partially_paid", delivered: "paid" };
	const labels: Record<ItemKey["status"], string> = { available: t("items.key_in_stock"), reserved: t("items.key_held"), delivered: t("items.key_sent") };

	return el("span", { class: `pill pill-${pills[key.status]}` }, labels[key.status]);
}

function keysDialog(uuid: string, item: CatalogItem, onChanged: () => void) {
	const body = el("div", {});
	const summary = el("p", { class: "muted" });
	const paste = el("textarea", { rows: "6", placeholder: "ABCD-1234-EFGH\nIJKL-5678-MNOP" });
	const submit = el("button", { class: "button primary", type: "submit" }, t("items.add_keys"));
	let changed = false;

	const remove = async (key: ItemKey) => {
		try {
			await Api.deleteItemKey(uuid, item.uuid, key.uuid);
			changed = true;
			toast(t("items.key_removed"), "success");
			void load();
		} catch (error) {
			reportError(error);
		}
	};

	const controls = pagination(() => load());
	const load = async (): Promise<void> => {
		const round = controls.state.begin();
		try {
			const result = await Api.itemKeys(uuid, item.uuid, { limit: PAGE_SIZE, offset: controls.state.offset });
			if (!controls.state.current(round)) return;
			if (controls.update(result.total)) return await load();
			const { stock } = result;

			summary.textContent = t("items.stock_summary", { available: stock.available, reserved: stock.reserved, delivered: stock.delivered });

			if (result.keys.length === 0) {
				body.replaceChildren(emptyState(t("items.keys_empty")));
				return;
			}

			const rows = result.keys.map((key) =>
				el(
					"tr",
					{},
					el("td", { class: "mono" }, key.secret ?? "-"),
					el("td", {}, keyStatusPill(key)),
					el(
						"td",
						{},
						key.invoice_reference ? el("span", { class: "mono" }, key.invoice_reference) : el("span", { class: "muted" }, "-"),
						key.recipient ? el("div", { class: "muted" }, key.recipient) : null
					),
					el(
						"td",
						{ class: "actions" },
						key.status === "available"
							? el("button", { class: "button danger small", type: "button", onClick: () => void remove(key) }, t("members.remove"))
							: el("span", { class: "muted" }, "-")
					)
				)
			);

			body.replaceChildren(table([t("items.column_key"), t("payments.status"), t("payments.invoice"), ""], rows));
		} catch (error) {
			if (controls.state.current(round)) {
				controls.fail();
				reportError(error);
			}
		}
	};

	const form = el(
		"form",
		{
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;

				try {
					const added = await Api.addItemKeys(uuid, item.uuid, paste.value);
					paste.value = "";
					changed = true;
					toast(
						added.duplicates > 0
							? t("items.keys_added_with_duplicates", { added: added.added, duplicates: added.duplicates })
							: t("items.keys_added", { added: added.added }),
						"success"
					);
					void load();
				} catch (error) {
					reportError(error);
				} finally {
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted intro" }, t("items.keys_intro")),
		field(t("items.paste_keys"), paste),
		el("div", { class: "dialog-actions" }, submit),
		summary,
		body,
		controls.element
	);

	modal(t("items.keys_title", { item: item.name }), form, () => {
		if (changed) onChanged();
	});
	void load();
	paste.focus();
}

function describeTax(item: CatalogItem): string {
	const supply = supplyTypeLabel(item.supply_type);
	if (item.tax_category === "exempt") return `${supply}, ${t("items.tax_exempt")}`;
	if (item.tax_category === "domestic_reverse") return `${supply}, ${item.tax_rate}% ${t("items.tax_domestic_reverse")}`;
	return `${supply}, ${item.tax_rate}%${item.tax_category === "reduced" ? ` ${t("items.tax_reduced")}` : ""}`;
}

async function itemForm(uuid: string, project: Project, existing: CatalogItem | null, onSaved: () => void) {
	const known = await currencyRates();
	const startCurrency = existing?.currency ?? project.currency;
	const standardRate = project.tax_country ? STANDARD_RATES[project.tax_country] : undefined;
	const reducedRate = project.tax_country ? DEFAULT_REDUCED_RATES[project.tax_country] : undefined;

	const name = input("text", { value: existing?.name ?? "", required: true, maxlength: "200", placeholder: t("items.name_placeholder") });
	const sku = input("text", { value: existing?.sku ?? "", maxlength: "64", placeholder: "HOST-M" });
	const price = input("number", {
		value: existing ? toMajorUnits(existing.unit_price, existing.currency).toFixed(minorUnitDigits(existing.currency)) : "",
		min: "0",
		step: "0.01",
		required: true,
		placeholder: "0.00",
	});
	const unit = select(unitOptions(), existing?.unit ?? "");
	const taxRate = input("number", { value: String(existing?.tax_rate ?? standardRate ?? 0), min: "0", max: "100", step: "0.01" });
	const supplyType = select(supplyTypeOptions(), existing?.supply_type ?? "services");
	const supplyHint = el("span", { class: "field-hint" });
	const syncSupply = () => {
		supplyHint.textContent = `${supplyTypeHint(supplyType.value)}. ${t("items.supply_hint")}`;
	};
	supplyType.addEventListener("change", syncSupply);
	syncSupply();
	const category = select(taxCategoryOptions(), existing?.tax_category ?? "standard");
	const rateHint = el("span", { class: "field-hint" });

	const syncRate = (fromUser: boolean) => {
		taxRate.disabled = category.value === "exempt";
		if (category.value === "exempt") {
			taxRate.value = "0";
			rateHint.textContent = t("items.rate_hint_exempt");
			return;
		}
		if (category.value === "standard") {
			if (fromUser && standardRate !== undefined) taxRate.value = String(standardRate);
			rateHint.textContent =
				standardRate !== undefined
					? t("items.rate_hint_standard", { country: project.tax_country ?? "", rate: standardRate })
					: t("items.rate_hint_no_country");
			return;
		}
		if (category.value === "domestic_reverse") {
			if (fromUser && standardRate !== undefined) taxRate.value = String(standardRate);
			rateHint.textContent = t("items.rate_hint_domestic_reverse");
			return;
		}
		if (fromUser && reducedRate !== undefined) taxRate.value = String(reducedRate);
		rateHint.textContent =
			reducedRate !== undefined
				? t("items.rate_hint_reduced_default", { country: project.tax_country ?? "", rate: reducedRate })
				: t("items.rate_hint_reduced");
	};

	category.addEventListener("change", () => syncRate(true));
	syncRate(false);
	const description = el("textarea", { rows: "3", maxlength: "1000", placeholder: t("items.notes_placeholder") });
	description.value = existing?.description ?? "";

	const deliversKeys = input("checkbox");
	deliversKeys.checked = existing?.delivers_keys ?? false;
	const keysField = el(
		"div",
		{ class: "field" },
		el("label", { class: "switch" }, deliversKeys, el("span", {}, t("items.sells_keys"))),
		el("span", { class: "field-hint" }, existing?.delivers_keys ? t("items.sells_keys_hint_existing") : t("items.sells_keys_hint_new"))
	);

	const currency = staticCombobox(currencyOptions(known.currencies, startCurrency), startCurrency, {
		required: true,
		placeholder: t("currency.search"),
		emptyText: t("currency.no_match"),
	});

	const license = isAdmin() ? licenseSection(existing?.license ?? null, () => currency.value || startCurrency) : null;
	const priceField = field(t("items.unit_price"), price);
	license?.onChange(() => {
		const active = license.active();
		priceField.hidden = active;
		price.required = !active;
		keysField.hidden = active;
	});

	const submit = el("button", { class: "button primary", type: "submit" }, existing ? t("ui.save") : t("items.add"));

	const form = el(
		"form",
		{
			onSubmit: async (event) => {
				event.preventDefault();

				const code = currency.value || startCurrency;
				const licensed = license?.read();
				if (licensed === undefined && license) {
					toast(t("items.license_invalid"), "error");
					return;
				}
				const payload = {
					name: name.value.trim(),
					sku: sku.value.trim() || null,
					description: description.value.trim() || null,
					unit_price: toMinorUnits(Number(price.value) || 0, code),
					currency: code,
					tax_rate: category.value === "exempt" ? 0 : Number(taxRate.value) || 0,
					supply_type: supplyType.value,
					tax_category: category.value,
					delivers_keys: deliversKeys.checked || Boolean(licensed),
					unit: unit.value || null,
					...(license && (licensed || existing?.license) ? { license: licensed } : {}),
				};

				submit.disabled = true;

				try {
					if (existing) await Api.updateItem(uuid, existing.uuid, payload);
					else await Api.createItem(uuid, payload);

					dialog.close();
					toast(existing ? t("items.updated") : t("items.added"), "success");
					onSaved();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("div", { class: "form-grid" }, field(t("customers.name"), name, t("items.name_hint")), field(t("items.sku"), sku, t("items.sku_hint"))),
		el("div", { class: "form-grid three" }, priceField, field(t("editor.unit"), unit, t("items.unit_hint")), field(t("items.currency"), currency.element)),
		el(
			"div",
			{ class: "form-grid three" },
			el("label", { class: "field" }, el("span", { class: "field-label" }, t("items.what_it_is")), supplyType, supplyHint),
			field(t("items.vat_category"), category),
			el("label", { class: "field" }, el("span", { class: "field-label" }, t("items.tax_percent")), taxRate, rateHint)
		),
		field(t("payments.notes"), description),
		keysField,
		license?.element ?? null,
		el("div", { class: "dialog-actions" }, submit)
	);

	const dialog = modal(existing ? t("items.edit") : t("items.new"), form);
	name.focus();
}

export async function itemsView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const body = el("div", {});
	const search = input("search", { placeholder: t("items.search_placeholder") });
	let showArchived = false;
	let debounce: ReturnType<typeof setTimeout>;

	const archiveToggle = el("button", { class: "button ghost", type: "button" }, t("items.show_archived"));
	const editable = can(project, Permission.ITEM_EDIT);

	const setArchived = async (item: CatalogItem, archived: boolean) => {
		try {
			await Api.updateItem(uuid, item.uuid, { archived });
			toast(archived ? t("items.archived_toast", { item: item.name }) : t("items.restored_toast", { item: item.name }), "success");
			void load();
		} catch (error) {
			reportError(error);
		}
	};

	const remove = async (item: CatalogItem) => {
		const unsold = item.keys?.available ?? 0;
		const confirmed = await confirmDialog({
			title: t("items.delete_title"),
			body: unsold > 0 ? t("items.delete_body_keys", { item: item.name, keys: tn("count.keys", unsold) }) : t("items.delete_body", { item: item.name }),
			confirmLabel: t("ui.delete"),
			destructive: true,
		});
		if (!confirmed) return;

		try {
			await Api.deleteItem(uuid, item.uuid);
			toast(t("items.deleted"), "success");
			void load();
		} catch (error) {
			if (error instanceof ApiError && error.code === ErrorCode.ITEM_IN_USE) {
				const archive = await confirmDialog({
					title: t("items.in_use_title"),
					body: t("items.in_use_body", { item: item.name }),
					confirmLabel: t("items.archive"),
				});
				if (archive) await setArchived(item, true);
				return;
			}
			reportError(error);
		}
	};

	const controls = pagination(() => load());
	const load = async (): Promise<void> => {
		const round = controls.state.begin();
		try {
			const result = await Api.items(uuid, {
				search: search.value.trim() || undefined,
				archived: showArchived,
				limit: PAGE_SIZE,
				offset: controls.state.offset,
			});

			if (!controls.state.current(round)) return;
			if (controls.update(result.total)) return await load();

			if (result.items.length === 0) {
				const message = search.value ? t("items.none_match") : showArchived ? t("items.none_archived") : t("items.empty");
				body.replaceChildren(
					emptyState(
						message,
						search.value || showArchived || !can(project, Permission.ITEM_CREATE)
							? undefined
							: el(
									"button",
									{ class: "button primary", type: "button", onClick: () => void itemForm(uuid, project, null, () => void load()) },
									t("items.add_first")
								)
					)
				);
				return;
			}

			const rows = result.items.map((item) =>
				el(
					"tr",
					{},
					el("td", {}, el("strong", {}, item.name), item.description ? el("div", { class: "muted" }, item.description) : null),
					el("td", { class: "mono" }, item.sku ?? "-"),
					el("td", { class: "mono" }, formatMoney(item.unit_price, item.currency)),
					el("td", {}, describeTax(item)),
					el("td", {}, stockCell(item)),
					el(
						"td",
						{ class: "actions" },
						...(editable
							? [
									item.license
										? null
										: el("button", { class: "button ghost small", type: "button", onClick: () => keysDialog(uuid, item, () => void load()) }, t("items.keys")),
									el(
										"button",
										{ class: "button ghost small", type: "button", onClick: () => void itemForm(uuid, project, item, () => void load()) },
										t("ui.edit")
									),
									el(
										"button",
										{ class: "button ghost small", type: "button", onClick: () => void setArchived(item, !item.archived) },
										item.archived ? t("items.restore") : t("items.archive")
									),
								]
							: []),
						can(project, Permission.ITEM_DELETE)
							? el("button", { class: "button danger small", type: "button", onClick: () => void remove(item) }, t("ui.delete"))
							: null
					)
				)
			);

			body.replaceChildren(table([t("items.column_item"), t("items.sku"), t("items.column_price"), t("customers.column_vat"), t("items.keys"), ""], rows));
		} catch (error) {
			if (controls.state.current(round)) {
				controls.fail();
				reportError(error);
			}
		}
	};

	archiveToggle.addEventListener("click", () => {
		controls.reset();
		showArchived = !showArchived;
		archiveToggle.textContent = showArchived ? t("items.show_active") : t("items.show_archived");
		void load();
	});

	search.addEventListener("input", () => {
		controls.reset();
		clearTimeout(debounce);
		debounce = setTimeout(() => void load(), 250);
	});

	void load();

	const content = el(
		"div",
		{ class: "stack" },
		el("p", { class: "muted intro" }, t("items.intro")),
		el(
			"div",
			{ class: "toolbar" },
			search,
			archiveToggle,
			can(project, Permission.ITEM_CREATE)
				? el(
						"button",
						{
							class: "button primary",
							type: "button",
							dataset: { shortcutAction: "new-item" },
							onClick: () => void itemForm(uuid, project, null, () => void load()),
						},
						t("items.new")
					)
				: null
		),
		body,
		controls.element
	);

	return projectLayout(project, content);
}
