import {
	InventoryApi,
	PurchasingApi,
	type CompanyLookup,
	type InventoryOverview,
	type Project,
	type PurchaseOrder,
	type PurchaseOrderInput,
	type PurchaseOrderStatus,
	type ReorderSuggestion,
	type Supplier,
	type SupplierInput,
} from "../api";
import { el, emptyState, field, input, replaceContent, select, table } from "../dom";
import { formatMoney, toDateInput, toMajorUnits, toMinorUnits } from "../money";
import { t, type UiKey } from "../i18n";
import { combobox, staticCombobox, type Combobox, type ComboOption } from "../combobox";
import { countryOptions } from "../countries";
import { companySearch, watchVatNumber } from "../company-lookup";
import { remoteTable } from "../pagination";
import { navigate } from "../router";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { icon } from "../storefront/icons";
import { loadProject } from "./project";
import { searchFilter } from "./list-filters";
import {
	formatQuantity,
	formatUnitCost,
	inventoryPage,
	inventoryPath,
	licenseNotice,
	moneyCell,
	numeric,
	quantityFromInput,
	quantityToInput,
	shortDate,
	stockEditable,
	warehouseSelect,
} from "./inventory";

const STATUSES: PurchaseOrderStatus[] = ["draft", "ordered", "received", "canceled"];

function statusPill(status: PurchaseOrderStatus, partly = false): HTMLElement {
	const tone = status === "received" ? "pill-paid" : status === "canceled" ? "pill-canceled" : status === "ordered" ? "pill-open" : "pill-pending";
	return el("span", { class: `pill ${tone}` }, t(partly && status === "ordered" ? "purchase.status_partly" : (`purchase.status_${status}` as UiKey)));
}

function supplierDialog(project: Project, supplier: Supplier | null, onSaved: (saved: Supplier) => void) {
	const lookup = companySearch();
	const name = combobox({
		search: (query) => lookup.search(query),
		selected: supplier ? { value: supplier.name, label: supplier.name } : null,
		freeText: true,
		required: true,
		class: "combo-customer",
		placeholder: t("purchase.suppliers_search"),
	});
	name.input.maxLength = 240;
	const taxNumber = input("text", { maxlength: "80", value: supplier?.tax_number ?? "", placeholder: "SI12345678" });
	const country = select([{ value: "", label: t("ui.none") }, ...countryOptions()], supplier?.country ?? "SI");
	const address = input("text", { maxlength: "255", value: supplier?.address_line1 ?? "" });
	const postalCode = input("text", { maxlength: "32", value: supplier?.postal_code ?? "" });
	const city = input("text", { maxlength: "120", value: supplier?.city ?? "" });
	const email = input("email", { maxlength: "254", value: supplier?.email ?? "" });
	const phone = input("text", { maxlength: "64", value: supplier?.phone ?? "" });
	const iban = input("text", { maxlength: "42", value: supplier?.iban ?? "" });
	const bic = input("text", { maxlength: "11", value: supplier?.bic ?? "" });
	const days = input("number", { min: "0", max: "365", step: "1", value: supplier?.payment_days === null || !supplier ? "" : String(supplier.payment_days) });
	const notes = el("textarea", { rows: "2", maxlength: "2000" });
	notes.value = supplier?.notes ?? "";
	const fill = (found: CompanyLookup) => {
		name.select({ value: found.name, label: found.name });
		if (found.address_line1) address.value = found.address_line1;
		if (found.postal_code) postalCode.value = found.postal_code;
		if (found.city) city.value = found.city;
		if (found.country) country.value = found.country;
		taxNumber.value = found.vat_number ?? found.tax_number ?? taxNumber.value;
		toast(t("lookup.filled", { source: t(found.source === "furs" ? "lookup.source_furs" : "lookup.source_vies"), name: found.name }));
	};
	name.onChange((option) => {
		const found = lookup.found(option);
		if (found) fill(found);
	});
	watchVatNumber(taxNumber, fill, () => !name.value.trim());
	const submit = el("button", { class: "button primary", type: "submit" }, t("ui.save"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				if (!name.value.trim()) {
					name.input.focus();
					return;
				}
				submit.disabled = true;
				const data: SupplierInput = {
					name: name.value.trim(),
					tax_number: taxNumber.value.trim() || null,
					country: country.value || null,
					address_line1: address.value.trim() || null,
					postal_code: postalCode.value.trim() || null,
					city: city.value.trim() || null,
					email: email.value.trim() || null,
					phone: phone.value.trim() || null,
					iban: iban.value.trim() || null,
					bic: bic.value.trim() || null,
					payment_days: days.value === "" ? null : Number(days.value),
					notes: notes.value.trim() || null,
				};
				try {
					const saved = supplier
						? await PurchasingApi.updateSupplier(project.uuid, supplier.uuid, data)
						: await PurchasingApi.createSupplier(project.uuid, data);
					dialog.close();
					onSaved(saved);
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el(
			"div",
			{ class: "grid" },
			field(t("purchase.supplier_name"), name.element, t("purchase.supplier_name_hint")),
			field(t("stock.supplier_tax_number"), taxNumber)
		),
		field(t("stock.warehouse_address"), address),
		el("div", { class: "grid" }, field(t("purchase.postal_code"), postalCode), field(t("purchase.city"), city)),
		el("div", { class: "grid" }, field(t("purchase.country"), country), field(t("purchase.email"), email)),
		el("div", { class: "grid" }, field(t("purchase.phone"), phone), field(t("purchase.payment_days"), days, t("purchase.payment_days_hint"))),
		el("div", { class: "grid" }, field(t("purchase.iban"), iban, t("purchase.iban_hint")), field(t("purchase.bic"), bic)),
		field(t("stock.notes"), notes),
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(supplier ? t("purchase.supplier_edit") : t("purchase.supplier_new"), form);
	name.input.focus();
}

export async function inventorySuppliersView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const canEdit = stockEditable(project);
	const archived = input("checkbox");
	const list = el("div", {});
	const render = async () => {
		try {
			const { suppliers } = await PurchasingApi.suppliers(uuid, { search: search.value.trim() || undefined, archived: archived.checked });
			const rows = suppliers.map((supplier) =>
				el(
					"tr",
					{ class: supplier.archived ? "muted" : "" },
					el("td", {}, supplier.name, supplier.tax_number ? el("div", { class: "muted" }, supplier.tax_number) : null),
					el("td", {}, [supplier.postal_code, supplier.city].filter(Boolean).join(" "), supplier.email ? el("div", { class: "muted" }, supplier.email) : null),
					el("td", { class: "mono" }, supplier.iban ?? ""),
					el("td", { class: "num" }, supplier.payment_days === null ? "" : String(supplier.payment_days)),
					el(
						"td",
						{ class: "actions" },
						canEdit
							? el(
									"button",
									{ class: "button ghost small", type: "button", onClick: () => supplierDialog(project, supplier, () => void render()) },
									t("ui.edit")
								)
							: null,
						canEdit
							? el(
									"button",
									{
										class: "button ghost small",
										type: "button",
										onClick: async () => {
											try {
												await PurchasingApi.updateSupplier(uuid, supplier.uuid, { ...supplier, archived: !supplier.archived });
												await render();
											} catch (error) {
												reportError(error);
											}
										},
									},
									supplier.archived ? t("stock.warehouse_restore") : t("stock.warehouse_archive")
								)
							: null
					)
				)
			);
			replaceContent(
				list,
				rows.length
					? table([t("stock.supplier"), t("purchase.city"), t("purchase.iban"), numeric(t("purchase.payment_days")), ""], rows)
					: emptyState(t("purchase.suppliers_empty"))
			);
		} catch (error) {
			reportError(error);
		}
	};
	const search = searchFilter("", t("purchase.suppliers_search"), () => void render());
	archived.addEventListener("change", () => void render());
	await render();
	return inventoryPage(
		project,
		"suppliers",
		{
			title: t("purchase.suppliers_title"),
			intro: t("purchase.suppliers_intro"),
			actions: [
				canEdit
					? el(
							"button",
							{ class: "button primary", type: "button", onClick: () => supplierDialog(project, null, () => void render()) },
							t("purchase.supplier_new")
						)
					: null,
			],
		},
		licenseNotice(project),
		el(
			"div",
			{ class: "ledger-controls" },
			field(t("ui.search"), search),
			el("label", { class: "switch" }, archived, el("span", {}, t("purchase.show_archived")))
		),
		list
	);
}

function reorderSection(project: Project, suggestions: ReorderSuggestion[]): HTMLElement | null {
	if (suggestions.length === 0) return null;
	return el(
		"section",
		{ class: "ledger-section" },
		el(
			"div",
			{ class: "ledger-section-head" },
			el("h3", {}, t("purchase.reorder_title")),
			stockEditable(project)
				? el("a", { class: "button primary small", href: inventoryPath(project.uuid, "/orders/new?reorder=1") }, t("purchase.reorder_create"))
				: null
		),
		el("p", { class: "muted" }, t("purchase.reorder_hint")),
		table(
			[
				t("stock.item"),
				numeric(t("stock.quantity")),
				numeric(t("stock.minimum")),
				numeric(t("purchase.on_order")),
				numeric(t("purchase.suggested")),
				t("purchase.last_supplier"),
			],
			suggestions.map((row) =>
				el(
					"tr",
					{},
					el("td", {}, el("a", { href: inventoryPath(project.uuid, `/items/${row.item}`) }, row.name), row.sku ? el("div", { class: "muted" }, row.sku) : null),
					el("td", { class: `num${row.quantity < 0 ? " warn" : ""}` }, formatQuantity(row.quantity, row.unit)),
					el("td", { class: "num" }, formatQuantity(row.minimum, row.unit)),
					el("td", { class: "num" }, row.on_order ? formatQuantity(row.on_order, row.unit) : ""),
					el("td", { class: "num" }, el("strong", {}, formatQuantity(row.suggested, row.unit))),
					el("td", {}, row.supplier_name ?? "")
				)
			)
		)
	);
}

export async function inventoryOrdersView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const params = new URLSearchParams(location.search);
	const status = select(
		[{ value: "", label: t("stock.all_statuses") }, ...STATUSES.map((value) => ({ value, label: t(`purchase.status_${value}` as UiKey) }))],
		params.get("status") ?? ""
	);
	const list = el("div", {});
	const render = () => {
		replaceContent(
			list,
			remoteTable(
				[t("stock.number"), t("stock.date"), t("stock.supplier"), t("purchase.expected"), numeric(t("stock.value")), ""],
				async (offset, limit) => {
					const page = await PurchasingApi.orders(uuid, {
						status: (status.value || undefined) as PurchaseOrderStatus | undefined,
						search: search.value.trim() || undefined,
						limit,
						offset,
					});
					return {
						rows: page.orders.map((order) =>
							el(
								"tr",
								{ class: order.status === "canceled" ? "muted" : "" },
								el("td", {}, el("a", { href: inventoryPath(uuid, `/orders/${order.uuid}`) }, order.number ?? t("stock.draft_number"))),
								el("td", { class: "date" }, shortDate(order.date, project)),
								el("td", {}, order.supplier_name),
								el("td", { class: "date" }, order.expected_date ? shortDate(order.expected_date, project) : ""),
								moneyCell(order.value, page.currency),
								el("td", { class: "actions" }, statusPill(order.status, order.received_quantity > 0))
							)
						),
						total: page.total,
					};
				},
				t("purchase.orders_empty")
			)
		);
	};
	const search = searchFilter("", t("purchase.orders_search"), render);
	status.addEventListener("change", render);
	render();
	const suggestions = await PurchasingApi.reorder(uuid).catch(() => ({ items: [] as ReorderSuggestion[] }));
	return inventoryPage(
		project,
		"orders",
		{
			title: t("purchase.orders_title"),
			intro: t("purchase.orders_intro"),
			actions: [stockEditable(project) ? el("a", { class: "button primary", href: inventoryPath(uuid, "/orders/new") }, t("purchase.order_new")) : null],
		},
		licenseNotice(project),
		reorderSection(project, suggestions.items),
		el("section", { class: "ledger-section" }, el("div", { class: "ledger-controls" }, field(t("ui.search"), search), field(t("stock.status"), status)), list)
	);
}

interface OrderLine {
	row: HTMLElement;
	item: Combobox;
	quantity: HTMLInputElement;
	price: HTMLInputElement;
	value: HTMLInputElement;
}

function orderEditor(
	project: Project,
	overview: InventoryOverview,
	suppliers: Supplier[],
	existing: PurchaseOrder | null,
	suggested: ReorderSuggestion[]
): HTMLElement {
	const uuid = project.uuid;
	const currency = overview.currency;
	const today = toDateInput(Date.now(), project.timezone);
	let known = suppliers;
	const supplierOptions = () => known.map((entry) => ({ value: entry.uuid, label: entry.name, hint: entry.tax_number ?? undefined }));
	const preferred = existing?.supplier?.uuid ?? suggested.find((row) => row.supplier)?.supplier ?? "";
	const supplier = staticCombobox(supplierOptions(), preferred, { placeholder: t("purchase.supplier_search"), required: true });
	const addSupplier = el(
		"button",
		{
			class: "button ghost small",
			type: "button",
			onClick: () =>
				supplierDialog(project, null, (saved) => {
					known = [...known, saved];
					supplier.setOptions(supplierOptions());
					supplier.select({ value: saved.uuid, label: saved.name });
				}),
		},
		t("purchase.supplier_new")
	);
	const warehouse = warehouseSelect(
		overview.warehouses,
		existing?.warehouse ?? overview.warehouses.find((entry) => entry.is_default && !entry.archived)?.uuid ?? "",
		false
	);
	const date = input("date", { value: existing?.date ?? today, required: true });
	const expected = input("date", { value: existing?.expected_date ?? "" });
	const reference = input("text", { maxlength: "120", value: existing?.supplier_reference ?? "" });
	const notes = el("textarea", { rows: "2", maxlength: "2000" });
	notes.value = existing?.notes ?? "";
	const rows = el("div", { class: "stock-lines" });
	const totals = el("p", { class: "stock-total" });
	const lines: OrderLine[] = [];

	const itemOptions = async (query: string): Promise<ComboOption[]> =>
		(await InventoryApi.stock(uuid, { search: query || undefined, limit: 30 })).items
			.filter((row) => !row.archived)
			.map((row) => ({ value: row.item, label: row.name, hint: formatQuantity(row.quantity, row.unit), keywords: row.sku ?? undefined }));
	const lineValue = (line: OrderLine) => (line.value.value ? toMinorUnits(Number(line.value.value), currency) : 0);
	const refresh = () => {
		totals.textContent = t("purchase.order_total", {
			value: formatMoney(
				lines.reduce((sum, line) => sum + lineValue(line), 0),
				currency
			),
		});
	};

	function addLine(initial?: { item: ComboOption; quantity: number; value: number }): OrderLine {
		const item = combobox({ search: itemOptions, selected: initial?.item ?? null, placeholder: t("stock.item_search"), emptyText: t("stock.item_none") });
		const quantity = input("number", { min: "0.001", step: "0.001", value: initial ? quantityToInput(initial.quantity) : "" });
		const price = input("number", { min: "0", step: "0.0001" });
		const value = input("number", { min: "0", step: "0.01", value: initial?.value ? String(toMajorUnits(initial.value, currency)) : "" });
		if (initial?.value && initial.quantity) price.value = String(Number(((initial.value / 100) * 1000) / initial.quantity).toFixed(4)).replace(/\.?0+$/, "");
		const remove = el("button", { class: "icon-button", type: "button", title: t("stock.remove_line") }, icon("trash"));
		remove.setAttribute("aria-label", t("stock.remove_line"));
		const cell = (label: string, control: HTMLElement, extra = "") =>
			el("label", { class: `stock-cell${extra}` }, el("span", { class: "stock-cell-label" }, label), control);
		const row = el(
			"div",
			{ class: "stock-line valued" },
			el("div", { class: "stock-line-item" }, cell(t("stock.item"), item.element)),
			cell(t("stock.quantity"), quantity, " stock-cell-quantity"),
			cell(t("stock.unit_price"), price, " stock-cell-price"),
			cell(t("stock.line_value"), value, " stock-cell-value"),
			el("div", { class: "stock-cell stock-cell-remove" }, el("span", { class: "stock-cell-label" }, t("stock.item")), remove)
		);
		const line: OrderLine = { row, item, quantity, price, value };
		const fromPrice = () => {
			if (price.value && quantity.value) value.value = (Number(price.value) * Number(quantity.value)).toFixed(2);
			refresh();
		};
		quantity.addEventListener("input", fromPrice);
		price.addEventListener("input", fromPrice);
		value.addEventListener("input", () => {
			if (value.value && Number(quantity.value) > 0) price.value = String(Number((Number(value.value) / Number(quantity.value)).toFixed(4)));
			refresh();
		});
		remove.addEventListener("click", () => {
			lines.splice(lines.indexOf(line), 1);
			row.remove();
			if (lines.length === 0) addLine();
			refresh();
		});
		lines.push(line);
		rows.appendChild(row);
		return line;
	}

	for (const line of existing?.lines ?? [])
		addLine({ item: { value: line.item, label: line.name, hint: line.sku ?? undefined }, quantity: line.quantity, value: line.value });
	if (!existing) {
		for (const row of suggested) {
			const value = row.last_value && row.last_quantity ? Math.round((row.last_value * row.suggested) / row.last_quantity) : 0;
			addLine({ item: { value: row.item, label: row.name, hint: row.sku ?? undefined }, quantity: row.suggested, value });
		}
	}
	if (lines.length === 0) addLine();
	refresh();

	const collect = (): PurchaseOrderInput | null => {
		const filled = lines.filter((line) => line.item.value);
		if (!supplier.value || filled.length === 0 || filled.some((line) => !line.quantity.value)) {
			toast(t("purchase.order_incomplete"), "error");
			return null;
		}
		return {
			supplier: supplier.value,
			warehouse: warehouse.value,
			date: date.value,
			expected_date: expected.value || null,
			supplier_reference: reference.value.trim() || null,
			notes: notes.value.trim() || null,
			lines: filled.map((line) => ({ item: line.item.value, quantity: quantityFromInput(line.quantity.value), value: lineValue(line) })),
		};
	};
	const store = async (): Promise<PurchaseOrder | null> => {
		const data = collect();
		if (!data) return null;
		return existing ? await PurchasingApi.updateOrder(uuid, existing.uuid, data) : await PurchasingApi.createOrder(uuid, data);
	};

	const save = el("button", { class: "button ghost", type: "submit" }, t("stock.save_draft"));
	const confirm = el("button", { class: "button primary", type: "button" }, t("purchase.order_confirm"));
	const busy = (state: boolean) => (save.disabled = confirm.disabled = state);
	confirm.addEventListener("click", async () => {
		if (!form.reportValidity()) return;
		if (!(await confirmDialog({ title: t("purchase.confirm_title"), body: t("purchase.confirm_body"), confirmLabel: t("purchase.order_confirm") }))) return;
		busy(true);
		try {
			const saved = await store();
			if (!saved) return busy(false);
			await PurchasingApi.orderAction(uuid, saved.uuid, "confirm");
			navigate(inventoryPath(uuid, `/orders/${saved.uuid}`), true);
		} catch (error) {
			reportError(error);
			busy(false);
		}
	});
	const remove = existing
		? el(
				"button",
				{
					class: "button ghost danger",
					type: "button",
					onClick: async () => {
						if (!(await confirmDialog({ title: t("stock.delete_title"), body: t("purchase.delete_body"), confirmLabel: t("ui.delete"), destructive: true })))
							return;
						try {
							await PurchasingApi.orderAction(uuid, existing.uuid, "cancel");
							navigate(inventoryPath(uuid, "/orders"));
						} catch (error) {
							reportError(error);
						}
					},
				},
				t("ui.delete")
			)
		: null;
	const form: HTMLFormElement = el(
		"form",
		{
			class: "stack stock-form",
			onSubmit: async (event) => {
				event.preventDefault();
				busy(true);
				try {
					const saved = await store();
					if (!saved) return busy(false);
					toast(t("stock.draft_saved"), "success");
					navigate(inventoryPath(uuid, `/orders/${saved.uuid}`), true);
				} catch (error) {
					reportError(error);
					busy(false);
				}
			},
		},
		el("div", { class: "purchase-supplier" }, field(t("stock.supplier"), supplier.element), addSupplier),
		el(
			"div",
			{ class: "grid" },
			field(t("purchase.order_date"), date),
			field(t("purchase.expected"), expected, t("purchase.expected_hint")),
			field(t("purchase.deliver_to"), warehouse)
		),
		field(t("purchase.supplier_reference"), reference),
		el(
			"section",
			{ class: "ledger-section" },
			el("h3", {}, t("stock.lines")),
			el("p", { class: "muted" }, t("purchase.lines_hint")),
			rows,
			el(
				"div",
				{ class: "stock-lines-foot" },
				el("button", { class: "button ghost small", type: "button", onClick: () => addLine().item.input.focus() }, t("stock.add_line")),
				totals
			)
		),
		field(t("purchase.order_notes"), notes),
		el("div", { class: "form-actions" }, remove, save, confirm)
	);
	return form;
}

function detail(label: string, value: string | HTMLElement | null): HTMLElement | null {
	if (value === null || value === "") return null;
	return el("div", { class: "stock-detail" }, el("span", { class: "muted" }, label), el("span", {}, value));
}

function statCard(label: string, value: string): HTMLElement {
	return el("div", { class: "card stat" }, el("span", { class: "stat-value" }, value), el("span", { class: "stat-label" }, label));
}

function orderDetails(project: Project, overview: InventoryOverview, order: PurchaseOrder): HTMLElement {
	const currency = order.currency;
	const warehouses = new Map(overview.warehouses.map((warehouse) => [warehouse.uuid, `${warehouse.code} ${warehouse.name}`]));
	const supplier = order.supplier;
	return el(
		"div",
		{ class: "stack" },
		el(
			"div",
			{ class: "grid stats" },
			statCard(t("purchase.ordered_value"), formatMoney(order.ordered_value, currency)),
			statCard(t("purchase.received_value"), formatMoney(order.received_value, currency)),
			statCard(t("purchase.invoiced_value"), formatMoney(order.invoiced_value, currency))
		),
		el(
			"div",
			{ class: "stock-details" },
			detail(t("stock.supplier"), supplier ? [supplier.name, supplier.tax_number].filter(Boolean).join(" | ") : null),
			detail(t("purchase.order_date"), shortDate(order.date, project)),
			detail(t("purchase.expected"), order.expected_date ? shortDate(order.expected_date, project) : null),
			detail(t("purchase.deliver_to"), warehouses.get(order.warehouse) ?? null),
			detail(t("purchase.supplier_reference"), order.supplier_reference),
			detail(t("purchase.order_notes"), order.notes)
		),
		el(
			"section",
			{ class: "ledger-section" },
			el("h3", {}, t("stock.lines")),
			table(
				[
					t("stock.item"),
					numeric(t("purchase.ordered")),
					numeric(t("purchase.received")),
					numeric(t("purchase.remaining")),
					numeric(t("stock.unit_price")),
					numeric(t("stock.value")),
				],
				order.lines.map((line) =>
					el(
						"tr",
						{},
						el(
							"td",
							{},
							el("a", { href: inventoryPath(project.uuid, `/items/${line.item}`) }, line.name),
							line.sku ? el("div", { class: "muted" }, line.sku) : null
						),
						el("td", { class: "num" }, formatQuantity(line.quantity, line.unit)),
						el("td", { class: "num" }, line.received ? formatQuantity(line.received, line.unit) : ""),
						el(
							"td",
							{ class: `num${line.remaining > 0 && order.status === "ordered" ? " warn" : ""}` },
							line.remaining ? formatQuantity(line.remaining, line.unit) : ""
						),
						el("td", { class: "num" }, formatUnitCost(line.value, line.quantity, currency)),
						moneyCell(line.value, currency)
					)
				)
			)
		),
		order.receipts.length > 0
			? el(
					"section",
					{ class: "ledger-section" },
					el("h3", {}, t("purchase.receipts")),
					table(
						[t("stock.number"), t("stock.date"), numeric(t("stock.value")), ""],
						order.receipts.map((receipt) =>
							el(
								"tr",
								{ class: receipt.status === "canceled" ? "muted" : "" },
								el("td", {}, el("a", { href: inventoryPath(project.uuid, `/documents/${receipt.uuid}`) }, receipt.number ?? t("stock.draft_number"))),
								el("td", { class: "date" }, receipt.date ? shortDate(receipt.date, project) : ""),
								moneyCell(receipt.status === "posted" ? receipt.value : null, currency),
								el("td", { class: "actions" }, el("span", { class: "pill" }, t(`stock.status_${receipt.status}` as UiKey)))
							)
						)
					)
				)
			: null,
		order.invoices.length > 0
			? el(
					"section",
					{ class: "ledger-section" },
					el("h3", {}, t("purchase.invoices")),
					table(
						[t("purchase.invoice_number"), t("stock.date"), numeric(t("purchase.net_amount")), ""],
						order.invoices.map((invoice) =>
							el(
								"tr",
								{},
								el("td", {}, el("a", { href: `/projects/${project.uuid}/expenses?open=${invoice.uuid}` }, invoice.invoice_number ?? t("stock.open_expense"))),
								el("td", { class: "date" }, invoice.date ? shortDate(invoice.date, project) : ""),
								moneyCell(invoice.net_amount, invoice.currency),
								el(
									"td",
									{ class: "actions" },
									el("span", { class: `pill ${invoice.paid ? "pill-paid" : "pill-open"}` }, t(invoice.paid ? "purchase.paid" : "purchase.unpaid"))
								)
							)
						)
					),
					order.status !== "ordered" && order.received_value !== order.invoiced_value
						? el(
								"p",
								{ class: "warn" },
								t("purchase.invoice_differs", { received: formatMoney(order.received_value, currency), invoiced: formatMoney(order.invoiced_value, currency) })
							)
						: null
				)
			: null
	);
}

export async function inventoryOrderView(uuid: string, orderId: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const overview = await InventoryApi.overview(uuid);
	const back = el("a", { class: "back-link", href: inventoryPath(uuid, "/orders") }, t("purchase.back_to_orders"));
	const canEdit = stockEditable(project);
	if (orderId === "new") {
		const params = new URLSearchParams(location.search);
		const [suppliers, reorder] = await Promise.all([
			PurchasingApi.suppliers(uuid),
			params.get("reorder") === "1" ? PurchasingApi.reorder(uuid) : Promise.resolve({ items: [] as ReorderSuggestion[] }),
		]);
		return inventoryPage(
			project,
			"orders",
			{ back, title: t("purchase.order_new"), intro: t("purchase.order_intro") },
			licenseNotice(project),
			overview.warehouses.some((warehouse) => !warehouse.archived)
				? orderEditor(project, overview, suppliers.suppliers, null, reorder.items)
				: emptyState(t("stock.no_tracked_items"), el("a", { class: "button primary", href: inventoryPath(uuid) }, t("stock.back_to_stock")))
		);
	}
	const order = await PurchasingApi.order(uuid, orderId);
	const title = `${t("purchase.order")} ${order.number ?? t("stock.draft_number")}`;
	if (order.status === "draft" && canEdit) {
		const suppliers = await PurchasingApi.suppliers(uuid);
		return inventoryPage(project, "orders", { back, title, intro: t("purchase.order_intro") }, orderEditor(project, overview, suppliers.suppliers, order, []));
	}
	const act = (action: "close" | "cancel", titleKey: UiKey, bodyKey: UiKey) => async () => {
		if (!(await confirmDialog({ title: t(titleKey), body: t(bodyKey), confirmLabel: t(titleKey), destructive: action === "cancel" }))) return;
		try {
			await PurchasingApi.orderAction(uuid, order.uuid, action);
			navigate(inventoryPath(uuid, `/orders/${order.uuid}`), true);
		} catch (error) {
			reportError(error);
		}
	};
	const open = order.status === "ordered" && canEdit;
	const untouched = order.receipts.every((receipt) => receipt.status === "canceled");
	return inventoryPage(
		project,
		"orders",
		{
			back,
			title: el(
				"h2",
				{},
				title,
				" ",
				statusPill(
					order.status,
					order.lines.some((line) => line.received > 0)
				)
			),
			actions: [
				open ? el("a", { class: "button primary", href: inventoryPath(uuid, `/documents/new?type=receipt&order=${order.uuid}`) }, t("purchase.receive")) : null,
				el("a", { class: "button ghost", href: inventoryPath(uuid, `/orders/${order.uuid}/print`) }, t("stock.print")),
				open && !untouched
					? el("button", { class: "button ghost", type: "button", onClick: act("close", "purchase.close", "purchase.close_body") }, t("purchase.close"))
					: null,
				open && untouched
					? el(
							"button",
							{ class: "button ghost danger", type: "button", onClick: act("cancel", "purchase.cancel", "purchase.cancel_body") },
							t("purchase.cancel")
						)
					: null,
			],
		},
		licenseNotice(project),
		orderDetails(project, overview, order)
	);
}
