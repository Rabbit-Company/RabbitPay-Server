import { Api, type CatalogItem, type Customer, type ItemInput, type Project } from "../api";
import { el, field, input, select } from "../dom";
import { formatMoney, minorUnitDigits, toMajorUnits } from "../money";
import { toast } from "../ui";
import { calculateTotals } from "../../../server/invoicing";
import { convertAmount, currencyOptions, currencyRates } from "../currencies";
import { combobox, staticCombobox, type Combobox, type ComboOption } from "../combobox";
import { customerForm } from "./customers";
import { taxTreatmentName, taxWarning, unitOptions } from "../options";
import { t } from "../i18n";
import {
	STANDARD_RATES,
	suggestTax,
	type BuyerTax,
	type LineTax,
	type SellerTax,
	type SupplyType,
	type TaxCategory,
	type TaxTreatment,
} from "../../../server/tax";
import { icon } from "../storefront/icons";

interface ItemRow {
	description: Combobox;
	quantity: HTMLInputElement;
	unit: HTMLSelectElement;
	unitPrice: HTMLInputElement;
	taxRate: HTMLInputElement;
	item: string | null;
	treatment: TaxTreatment | null;
	ownRate: number;
	manualTax: boolean;
	taxNote: HTMLElement;
	node: HTMLElement;
}

export interface EditorInitial {
	customer: Customer | null;
	currency: string;
	discount: number;
	notes: string | null;
	items: ItemInput[];
}

export interface EditorOptions {
	initial?: EditorInitial;
	customerRequired?: boolean;
	customerPlaceholder?: string;
	notesPlaceholder?: string;
	descriptionPlaceholder?: string;
	extraItemsHint?: HTMLElement | null;
}

export interface EditorValues {
	customer: string | null;
	currency: string;
	discount_amount: number;
	notes: string | null;
	items: ItemInput[];
}

export interface InvoiceEditor {
	customerField: HTMLElement;
	currencyField: HTMLElement;
	discountField: HTMLElement;
	notesField: HTMLElement;
	itemsCard: HTMLElement;
	values(): EditorValues | null;
}

export function customerOption(customer: Customer): ComboOption {
	const details = [customer.name ? customer.email : null, customer.vat_number].filter(Boolean).join("\n");
	return {
		value: customer.uuid,
		label: customer.name || customer.email,
		hint: details || undefined,
		keywords: customer.vat_number ?? undefined,
	};
}

function catalogOption(item: CatalogItem): ComboOption {
	return {
		value: item.uuid,
		label: item.name,
		hint: [item.sku, formatMoney(item.unit_price, item.currency)].filter(Boolean).join(" | "),
		keywords: [item.sku, item.description].filter(Boolean).join(" "),
	};
}

export async function invoiceEditor(uuid: string, project: Project, options: EditorOptions = {}): Promise<InvoiceEditor> {
	const initial = options.initial;
	const [known, catalog] = await Promise.all([currencyRates(), Api.items(uuid, { limit: 500 }).catch(() => ({ items: [] as CatalogItem[], total: 0 }))]);
	const catalogById = new Map(catalog.items.map((item) => [item.uuid, item]));
	const catalogOptions = catalog.items.map(catalogOption);
	const startCurrency = initial?.currency ?? project.currency;

	const currency = staticCombobox(currencyOptions(known.currencies, startCurrency), startCurrency, {
		required: true,
		placeholder: t("currency.search"),
		emptyText: t("currency.no_match"),
	});
	const discount = input("number", {
		value: initial ? toMajorUnits(initial.discount, startCurrency).toFixed(minorUnitDigits(startCurrency)) : "0",
		min: "0",
		step: "0.01",
	});
	const notes = el("textarea", { rows: "3", placeholder: options.notesPlaceholder ?? t("editor.notes_placeholder") });
	notes.value = initial?.notes ?? "";

	const customersById = new Map<string, Customer>(initial?.customer ? [[initial.customer.uuid, initial.customer]] : []);
	let buyer: Customer | null = initial?.customer ?? null;

	const customerPicker = combobox({
		selected: initial?.customer ? customerOption(initial.customer) : null,
		class: "combo-customer",
		required: options.customerRequired,
		placeholder: options.customerPlaceholder ?? t("editor.customer_placeholder"),
		emptyText: t("editor.no_customer_match"),
		search: async (query) => {
			const found = (await Api.customers(uuid, { search: query || undefined, limit: 20 })).customers;
			for (const customer of found) customersById.set(customer.uuid, customer);
			return found.map(customerOption);
		},
		action: {
			label: (query) => (query ? t("editor.add_named_customer", { query }) : t("editor.add_customer")),
			run: (query) =>
				new Promise((resolve) =>
					customerForm(
						uuid,
						null,
						(customer) => {
							customersById.set(customer.uuid, customer);
							resolve(customerOption(customer));
							if (buyer?.uuid === customer.uuid) {
								buyer = customer;
								applyTax();
							}
						},
						query,
						() => resolve(null)
					)
				),
		},
	});

	const rows: ItemRow[] = [];
	const itemsBody = el("div", { class: "items" });
	const totalsBox = el("div", { class: "totals" });
	const taxAdvice = el("div", { class: "tax-advice" });

	const seller: SellerTax = { country: project.tax_country, vatStatus: project.vat_status, ossRegistered: project.oss_registered };
	const sellerStandardRate = seller.vatStatus === "registered" && project.tax_country ? (STANDARD_RATES[project.tax_country] ?? 0) : 0;

	const buyerTax = (): BuyerTax | null =>
		buyer ? { country: buyer.country, type: buyer.customer_type, vatNumber: buyer.vat_number, vatValid: buyer.vat_valid } : null;

	const lineTax = (row: ItemRow): LineTax => {
		const item = row.item ? catalogById.get(row.item) : undefined;
		if (item) return { supplyType: item.supply_type as SupplyType, category: item.tax_category as TaxCategory, rate: item.tax_rate };
		return { supplyType: "services", category: "standard", rate: row.ownRate };
	};

	const code = () => currency.value || project.currency;
	const toMinor = (value: string) => Math.round((Number(value) || 0) * Math.pow(10, minorUnitDigits(code())));

	const refreshTotals = () => {
		const parsed = rows.map((row) => ({
			description: row.description.value,
			quantity: Number(row.quantity.value) || 0,
			unit_price: toMinor(row.unitPrice.value),
			tax_rate: Number(row.taxRate.value) || 0,
		}));

		const totals = calculateTotals(parsed, toMinor(discount.value));
		const shown = code();

		totalsBox.replaceChildren(
			el("div", { class: "totals-row" }, el("span", {}, t("editor.subtotal")), el("span", { class: "mono" }, formatMoney(totals.subtotal, shown))),
			el("div", { class: "totals-row" }, el("span", {}, t("editor.discount")), el("span", { class: "mono" }, `-${formatMoney(totals.discount_amount, shown)}`)),
			el("div", { class: "totals-row" }, el("span", {}, t("editor.tax")), el("span", { class: "mono" }, formatMoney(totals.tax_amount, shown))),
			el("div", { class: "totals-row grand" }, el("span", {}, t("editor.total")), el("span", { class: "mono" }, formatMoney(totals.total_amount, shown)))
		);
	};

	const applyTax = () => {
		const warnings = new Set<string>();

		for (const row of rows) {
			const suggestion = suggestTax(seller, buyerTax(), lineTax(row));
			for (const warning of suggestion.warnings) warnings.add(warning);

			if (!row.manualTax) {
				row.taxRate.value = String(suggestion.rate);
				row.treatment = suggestion.treatment;
			} else {
				row.treatment = Number(row.taxRate.value) === suggestion.rate ? suggestion.treatment : null;
			}

			const parts: (string | HTMLElement)[] = [];
			if (suggestion.treatment && suggestion.treatment !== "domestic") {
				parts.push(`${taxTreatmentName(suggestion.treatment)}, ${suggestion.rate}%`);
				if (!row.item) parts.push(` ${t("editor.treated_as_service")}`);
			}
			if (row.manualTax && Number(row.taxRate.value) !== suggestion.rate) {
				parts.push(`${parts.length > 0 ? ". " : ""}${t("editor.changed_by_hand", { rate: suggestion.rate })} `);
				parts.push(
					el(
						"button",
						{
							class: "link-button",
							type: "button",
							onClick: () => {
								row.manualTax = false;
								applyTax();
							},
						},
						t("editor.use_suggestion")
					)
				);
			}
			row.taxNote.replaceChildren(...parts);
			row.taxNote.hidden = parts.length === 0;
		}

		taxAdvice.replaceChildren(...[...warnings].map((warning) => el("p", { class: "warn" }, taxWarning(warning, buyer?.country ?? null))));
		refreshTotals();
	};

	const priceFor = (item: CatalogItem, target: string): { price: number; converted: boolean } | null => {
		if (item.currency === target) return { price: toMajorUnits(item.unit_price, target), converted: false };
		if (!known.live) return null;

		const converted = convertAmount(toMajorUnits(item.unit_price, item.currency), item.currency, target, known.rates);
		return converted === null ? null : { price: converted, converted: true };
	};

	const applyCatalogItem = (row: ItemRow, item: CatalogItem) => {
		const target = code();
		const priced = priceFor(item, target);

		row.item = item.uuid;
		row.manualTax = false;
		row.unit.value = item.unit ?? "";
		if (!(Number(row.quantity.value) > 0)) row.quantity.value = "1";

		if (priced === null) {
			row.unitPrice.value = toMajorUnits(item.unit_price, item.currency).toFixed(minorUnitDigits(item.currency));
			toast(t("editor.no_rate", { item: item.name, from: item.currency, to: target }), "error");
		} else {
			row.unitPrice.value = priced.price.toFixed(minorUnitDigits(target));
			if (priced.converted) toast(t("editor.converted", { item: item.name, amount: formatMoney(item.unit_price, item.currency) }), "info");
		}

		applyTax();
		row.quantity.focus();
		row.quantity.select();
	};

	const addRow = (preset?: ItemInput) => {
		const description = combobox({
			options: catalogOptions,
			freeText: true,
			required: true,
			class: "combo-free",
			placeholder: catalogOptions.length > 0 ? t("editor.line_search") : (options.descriptionPlaceholder ?? t("editor.line_placeholder")),
		});
		const quantity = input("number", { value: preset ? String(preset.quantity) : "1", min: "0", step: "any", required: true });
		const unit = select(unitOptions(), preset?.unit ?? "");
		unit.title = t("editor.unit");
		const unitPrice = input("number", {
			value: preset ? toMajorUnits(preset.unit_price, startCurrency).toFixed(minorUnitDigits(startCurrency)) : "0",
			min: "0",
			step: "0.01",
			required: true,
		});
		const taxRate = input("number", { value: String(preset?.tax_rate ?? sellerStandardRate), min: "0", step: "0.01" });
		const taxNote = el("p", { class: "line-tax muted" });

		const remove = el(
			"button",
			{
				class: "icon-button",
				type: "button",
				title: t("editor.remove_line"),
				onClick: () => {
					const index = rows.indexOf(row);
					if (index >= 0) rows.splice(index, 1);
					node.remove();
					refreshTotals();
				},
			},
			icon("close", 16)
		);

		const node = el("div", { class: "item-line" }, el("div", { class: "item-row" }, description.element, quantity, unit, unitPrice, taxRate, remove), taxNote);
		const row: ItemRow = {
			description,
			quantity,
			unit,
			unitPrice,
			taxRate,
			item: preset?.item ?? null,
			treatment: null,
			ownRate: preset && !preset.item ? preset.tax_rate : sellerStandardRate,
			manualTax: false,
			taxNote,
			node,
		};

		if (preset) {
			description.input.value = preset.description;
			const suggestion = suggestTax(seller, buyerTax(), lineTax(row));
			row.manualTax = suggestion.rate !== preset.tax_rate;
		}

		description.onChange((option) => {
			const item = option ? catalogById.get(option.value) : undefined;
			if (item) {
				applyCatalogItem(row, item);
				return;
			}
			if (row.item) {
				row.item = null;
				applyTax();
			}
		});

		for (const control of [quantity, unitPrice]) control.addEventListener("input", refreshTotals);
		taxRate.addEventListener("input", () => {
			row.manualTax = true;
			if (row.treatment === null || row.treatment === "domestic") row.ownRate = Number(taxRate.value) || 0;
			applyTax();
		});

		rows.push(row);
		itemsBody.appendChild(node);
		applyTax();
		return row;
	};

	if (initial && initial.items.length > 0) {
		for (const item of initial.items) addRow(item);
	} else {
		addRow();
	}

	customerPicker.onChange((option) => {
		buyer = option ? (customersById.get(option.value) ?? null) : null;
		applyTax();
	});
	currency.onChange(refreshTotals);
	discount.addEventListener("input", refreshTotals);

	const itemsCard = el(
		"div",
		{ class: "card" },
		el("h2", {}, t("editor.line_items")),
		options.extraItemsHint ?? null,
		el(
			"div",
			{ class: "item-row item-head" },
			el("span", {}, t("editor.description")),
			el("span", {}, t("editor.quantity")),
			el("span", {}, t("editor.unit")),
			el("span", {}, t("items.unit_price")),
			el("span", {}, t("items.tax_percent")),
			el("span", {})
		),
		taxAdvice,
		itemsBody,
		el(
			"div",
			{ class: "line-actions" },
			el("button", { class: "button ghost", type: "button", onClick: () => addRow().description.input.focus() }, t("editor.add_line")),
			catalogOptions.length === 0
				? el(
						"span",
						{ class: "muted" },
						`${t("editor.save_items_before")} `,
						el("a", { href: `/projects/${uuid}/items` }, t("nav.items")),
						t("editor.save_items_after")
					)
				: null
		),
		totalsBox
	);

	const values = (): EditorValues | null => {
		const items: ItemInput[] = rows
			.filter((row) => row.description.value.trim().length > 0)
			.map((row) => ({
				description: row.description.value.trim(),
				quantity: Number(row.quantity.value) || 0,
				unit_price: toMinor(row.unitPrice.value),
				tax_rate: Number(row.taxRate.value) || 0,
				item: row.item,
				tax_treatment: row.treatment,
				unit: row.unit.value || null,
			}));

		if (items.length === 0) {
			toast(t("editor.need_line"), "error");
			return null;
		}
		if (options.customerRequired && !customerPicker.value) {
			toast(t("editor.need_customer"), "error");
			return null;
		}

		return {
			customer: customerPicker.value || null,
			currency: code(),
			discount_amount: toMinor(discount.value),
			notes: notes.value.trim() || null,
			items,
		};
	};

	return {
		customerField: field(t("customers.column_customer"), customerPicker.element),
		currencyField: field(t("items.currency"), currency.element, t("editor.currency_hint", { currency: project.currency })),
		discountField: field(t("editor.discount"), discount, t("editor.discount_hint")),
		notesField: field(t("payments.notes"), notes),
		itemsCard,
		values,
	};
}
