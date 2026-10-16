import {
	Api,
	InventoryApi,
	type InventoryOverview,
	type LedgerAccount,
	type Project,
	type StockDocument,
	type StockDocumentInput,
	type StockPurchaseLine,
	type PurchaseOrder,
	PurchasingApi,
	type StockDocumentStatus,
	type StockDocumentType,
} from "../api";
import { el, emptyState, field, input, replaceContent, select, table, type TableHeader } from "../dom";
import { formatDateTime, formatMoney, toDateInput, toMajorUnits, toMinorUnits } from "../money";
import { t, type UiKey } from "../i18n";
import { can, Permission } from "../access";
import { combobox, staticCombobox, type Combobox, type ComboOption } from "../combobox";
import { remoteTable } from "../pagination";
import { navigate } from "../router";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { icon } from "../storefront/icons";
import { loadProject } from "./project";
import { searchFilter } from "./list-filters";
import {
	DOCUMENT_TYPES,
	documentTypeLabel,
	formatQuantity,
	formatUnitCost,
	inventoryPage,
	inventoryPath,
	licenseNotice,
	moneyCell,
	numeric,
	quantityFromInput,
	quantityToInput,
	reasonLabel,
	shortDate,
	stockEditable,
	warehouseSelect,
} from "./inventory";
import type { DateFormat, TimeFormat } from "../../../server/formats";

const STATUSES: StockDocumentStatus[] = ["draft", "posted", "canceled"];

function statusPill(status: StockDocumentStatus): HTMLElement {
	const tone = status === "posted" ? "pill-paid" : status === "canceled" ? "pill-canceled" : "pill-pending";
	return el("span", { class: `pill ${tone}` }, t(`stock.status_${status}` as UiKey));
}

function isType(value: string | null): value is StockDocumentType {
	return DOCUMENT_TYPES.includes(value as StockDocumentType);
}

export async function inventoryDocumentsView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const params = new URLSearchParams(location.search);
	const type = select(
		[{ value: "", label: t("stock.all_types") }, ...DOCUMENT_TYPES.map((value) => ({ value, label: documentTypeLabel(value) }))],
		params.get("type") ?? ""
	);
	const status = select(
		[{ value: "", label: t("stock.all_statuses") }, ...STATUSES.map((value) => ({ value, label: t(`stock.status_${value}` as UiKey) }))],
		params.get("status") ?? ""
	);
	const list = el("div", {});
	const render = () => {
		replaceContent(
			list,
			remoteTable(
				[t("stock.number"), t("stock.date"), t("stock.document_type"), t("stock.partner_or_reason"), t("stock.warehouse"), numeric(t("stock.value")), ""],
				async (offset, limit) => {
					const page = await InventoryApi.documents(uuid, {
						type: isType(type.value) ? type.value : undefined,
						status: (status.value || undefined) as StockDocumentStatus | undefined,
						search: search.value.trim() || undefined,
						limit,
						offset,
					});
					return {
						rows: page.documents.map((document) =>
							el(
								"tr",
								{ class: document.status === "canceled" ? "muted" : "" },
								el(
									"td",
									{},
									el("a", { href: inventoryPath(uuid, `/documents/${document.uuid}`) }, document.number ?? t("stock.draft_number")),
									document.external_reference ? el("div", { class: "muted" }, document.external_reference) : null
								),
								el("td", { class: "date" }, shortDate(document.date, project)),
								el("td", {}, documentTypeLabel(document.document_type)),
								el("td", {}, document.partner ?? reasonLabel(document.document_type === "issue" ? document.reason : null)),
								el("td", {}, document.target_name ? `${document.warehouse_name} → ${document.target_name}` : document.warehouse_name),
								moneyCell(document.document_type === "transfer" ? null : Math.abs(document.value), page.currency),
								el("td", { class: "actions" }, statusPill(document.status))
							)
						),
						total: page.total,
					};
				},
				t("stock.documents_empty")
			)
		);
	};
	const search = searchFilter("", t("stock.documents_search"), render);
	type.addEventListener("change", render);
	status.addEventListener("change", render);
	render();

	const newLinks = stockEditable(project)
		? DOCUMENT_TYPES.map((value, index) =>
				el(
					"a",
					{ class: `button ${index === 0 ? "primary" : "ghost"} small`, href: inventoryPath(uuid, `/documents/new?type=${value}`) },
					t(`stock.new_${value}` as UiKey)
				)
			)
		: [];

	return inventoryPage(
		project,
		"documents",
		{ title: t("stock.documents_title"), intro: t("stock.documents_intro"), actions: newLinks },
		licenseNotice(project),
		el("div", { class: "ledger-controls" }, field(t("ui.search"), search), field(t("stock.document_type"), type), field(t("stock.status"), status)),
		list
	);
}

interface LineControls {
	row: HTMLElement;
	item: Combobox;
	quantity: HTMLInputElement;
	price: HTMLInputElement;
	value: HTMLInputElement;
	priceCell: HTMLElement;
	valueCell: HTMLElement;
	booked: number | null;
	unit: string | null;
	note: string | null;
	orderLine: string | null;
}

interface EditorSeed {
	type: StockDocumentType;
	accounts: LedgerAccount[];
	document: StockDocument | null;
	expense: {
		uuid: string;
		supplier: string | null;
		tax_number: string | null;
		invoice_number: string | null;
		date: string;
		value: number | null;
		lines: StockPurchaseLine[];
	} | null;
	order: PurchaseOrder | null;
}

function editor(project: Project, overview: InventoryOverview, seed: EditorSeed): HTMLElement {
	const uuid = project.uuid;
	const currency = overview.currency;
	const type = seed.type;
	const existing = seed.document;
	const today = toDateInput(Date.now(), project.timezone);
	const valued = type === "receipt" || type === "opening";
	const defaultWarehouse = overview.warehouses.find((warehouse) => warehouse.is_default && !warehouse.archived) ?? overview.warehouses.find((w) => !w.archived);

	const date = input("date", { value: existing?.date ?? seed.expense?.date ?? today, max: today, required: true });
	const warehouse = warehouseSelect(overview.warehouses, existing?.warehouse ?? defaultWarehouse?.uuid ?? "", false);
	const target = warehouseSelect(
		overview.warehouses,
		existing?.target_warehouse ?? overview.warehouses.find((entry) => !entry.archived && entry.uuid !== warehouse.value)?.uuid ?? "",
		false
	);
	const reasons = type === "issue" ? overview.issue_reasons : type === "receipt" ? overview.receipt_reasons : [];
	const reason = select(
		reasons.map((value) => ({ value, label: reasonLabel(value) })),
		existing?.reason ?? reasons[0]
	);
	const reasonHint = el("span", { class: "field-hint" });
	const orderSupplier = seed.order?.supplier ?? null;
	const partner = input("text", { maxlength: "240", value: existing?.partner ?? seed.expense?.supplier ?? orderSupplier?.name ?? "" });
	const partnerTax = input("text", { maxlength: "80", value: existing?.partner_tax_number ?? seed.expense?.tax_number ?? orderSupplier?.tax_number ?? "" });
	const reference = input("text", { maxlength: "120", value: existing?.external_reference ?? seed.expense?.invoice_number ?? "" });
	const extra = input("number", { min: "0", step: "0.01", value: existing?.extra_costs ? String(toMajorUnits(existing.extra_costs, currency)) : "" });
	const chargeVat = input("checkbox");
	chargeVat.checked = existing?.charge_vat ?? false;
	const offset = select(
		[
			{ value: "none", label: t("stock.offset_none") },
			{ value: "expense", label: t("stock.offset_expense") },
		],
		existing?.opening_offset ?? "none"
	);
	const notes = el("textarea", { rows: "2", maxlength: "2000" });
	notes.value = existing?.notes ?? "";
	const invoicePicker = combobox({
		search: async (query) =>
			(await Api.invoices(uuid, { reference: query || undefined, limit: 20 })).invoices
				.filter((invoice) => invoice.issued_at !== null)
				.map((invoice) => ({ value: invoice.uuid, label: invoice.reference })),
		placeholder: t("stock.invoice_search"),
	});
	const expenseId = existing?.expense ?? seed.expense?.uuid ?? null;
	const costAccounts = seed.accounts.filter((account) => account.active && account.account_kind === "expense");
	const chosenAccount = costAccounts.find((account) => account.uuid === existing?.ledger_account);
	const account = staticCombobox(
		costAccounts.map((entry) => ({ value: entry.uuid, label: `${entry.code} ${entry.name}`, keywords: entry.code })),
		chosenAccount?.uuid ?? "",
		{ placeholder: t("stock.cost_account_default") }
	);

	const rows = el("div", { class: "stock-lines" });
	const totals = el("p", { class: "stock-total" });
	const lines: LineControls[] = [];

	const itemOptions = async (query: string): Promise<ComboOption[]> => {
		const page = await InventoryApi.stock(uuid, { search: query || undefined, warehouse: warehouse.value || undefined, limit: 30 });
		return page.items
			.filter((row) => !row.archived)
			.map((row) => ({ value: row.item, label: row.name, hint: formatQuantity(row.quantity, row.unit), keywords: row.sku ?? undefined }));
	};

	const lineValue = (line: LineControls) => (line.value.value ? toMinorUnits(Number(line.value.value), currency) : 0);
	const refreshTotals = () => {
		if (valued) {
			const sum = lines.reduce((total, line) => total + lineValue(line), 0) + (extra.value ? toMinorUnits(Number(extra.value), currency) : 0);
			totals.textContent = t("stock.total_value", { value: formatMoney(sum, currency) });
		} else if (type === "stocktake") {
			const counted = lines.filter((line) => line.item.value && line.quantity.value !== "").length;
			totals.textContent = t("stock.counted_lines", { count: counted });
		} else totals.textContent = "";
	};

	const refreshBooked = async (line: LineControls, note: HTMLElement) => {
		if (!line.item.value || !warehouse.value || !date.value) return;
		try {
			const booked = await InventoryApi.booked(uuid, warehouse.value, line.item.value, date.value);
			line.booked = booked.quantity;
			showBooked(line, note);
		} catch {
			line.booked = null;
		}
	};

	const showBooked = (line: LineControls, note: HTMLElement) => {
		if (line.booked === null) {
			note.textContent = line.note ? t("stock.supplier_line", { description: line.note }) : "";
			note.className = "stock-line-note muted";
			return;
		}
		if (type === "stocktake" && line.quantity.value !== "") {
			const difference = quantityFromInput(line.quantity.value) - line.booked;
			note.textContent = t("stock.booked_difference", {
				booked: formatQuantity(line.booked, line.unit),
				difference: `${difference > 0 ? "+" : ""}${formatQuantity(difference)}`,
			});
			note.className = difference === 0 ? "stock-line-note muted" : "stock-line-note warn";
			return;
		}
		note.textContent = t(type === "stocktake" ? "stock.booked_only" : "stock.booked_quantity", { booked: formatQuantity(line.booked, line.unit) });
		note.className = "stock-line-note muted";
	};

	const dropLine = (line: LineControls) => {
		lines.splice(lines.indexOf(line), 1);
		line.row.remove();
	};

	function addLine(initial?: {
		item: ComboOption | null;
		quantity: number | null;
		value: number | null;
		unit: string | null;
		booked?: number | null;
		note?: string | null;
		orderLine?: string | null;
	}): LineControls {
		const item = combobox({ search: itemOptions, selected: initial?.item ?? null, placeholder: t("stock.item_search"), emptyText: t("stock.item_none") });
		const quantity = input("number", {
			min: type === "stocktake" ? "0" : "0.001",
			step: "0.001",
			value: initial?.quantity === null || initial?.quantity === undefined ? "" : quantityToInput(initial.quantity),
		});
		const price = input("number", { min: "0", step: "0.0001" });
		const value = input("number", {
			min: "0",
			step: "0.01",
			value: initial?.value === null || initial?.value === undefined ? "" : String(toMajorUnits(initial.value, currency)),
		});
		if (initial?.value && initial.quantity) price.value = String(Number(((initial.value / 100) * 1000) / initial.quantity).toFixed(4)).replace(/\.?0+$/, "");
		const note = el("span", { class: "stock-line-note muted" });
		const remove = el("button", { class: "icon-button", type: "button", title: t("stock.remove_line") }, icon("trash"));
		remove.setAttribute("aria-label", t("stock.remove_line"));
		const cell = (label: string, control: HTMLElement, extra = "") =>
			el("label", { class: `stock-cell${extra}` }, el("span", { class: "stock-cell-label" }, label), control);
		const priceCell = cell(t("stock.unit_price"), price, " stock-cell-price");
		const valueCell = cell(t("stock.line_value"), value, " stock-cell-value");
		const row = el(
			"div",
			{ class: `stock-line${valued ? " valued" : ""}` },
			el("div", { class: "stock-line-item" }, cell(t("stock.item"), item.element), note),
			cell(type === "stocktake" ? t("stock.counted") : t("stock.quantity"), quantity, " stock-cell-quantity"),
			valued ? priceCell : null,
			valued ? valueCell : null,
			el("div", { class: "stock-cell stock-cell-remove" }, el("span", { class: "stock-cell-label" }, t("stock.item")), remove)
		);
		const line: LineControls = {
			row,
			item,
			quantity,
			price,
			value,
			priceCell,
			valueCell,
			booked: initial?.booked ?? null,
			unit: initial?.unit ?? null,
			note: initial?.note ?? null,
			orderLine: initial?.orderLine ?? null,
		};
		item.onChange(() => {
			if (type !== "receipt" && type !== "opening") void refreshBooked(line, note);
			refreshTotals();
		});
		quantity.addEventListener("input", () => {
			if (valued && price.value && quantity.value) value.value = (Number(price.value) * Number(quantity.value)).toFixed(2);
			showBooked(line, note);
			refreshTotals();
		});
		price.addEventListener("input", () => {
			if (price.value && quantity.value) value.value = (Number(price.value) * Number(quantity.value)).toFixed(2);
			refreshTotals();
		});
		value.addEventListener("input", () => {
			if (value.value && Number(quantity.value) > 0) price.value = String(Number((Number(value.value) / Number(quantity.value)).toFixed(4)));
			refreshTotals();
		});
		remove.addEventListener("click", () => {
			dropLine(line);
			if (lines.length === 0) addLine();
			refreshTotals();
		});
		lines.push(line);
		rows.appendChild(row);
		showBooked(line, note);
		return line;
	}

	if (existing) {
		for (const line of existing.lines) {
			addLine({
				item: { value: line.item, label: line.name, hint: line.sku ?? undefined },
				quantity: line.quantity,
				value: line.value,
				unit: line.unit,
				booked: line.expected_quantity,
				note: line.note,
				orderLine: line.order_line,
			});
		}
	}
	if (!existing) {
		for (const line of seed.expense?.lines ?? []) {
			addLine({
				item: line.item ? { value: line.item.uuid, label: line.item.name, hint: line.item.sku ?? undefined } : null,
				quantity: line.quantity,
				value: line.value,
				unit: line.item?.unit ?? null,
				note: line.description,
			});
		}
	}
	const proposed = !existing && lines.length > 0;
	if (!existing && seed.order) {
		for (const line of seed.order.lines.filter((entry) => entry.remaining > 0)) {
			addLine({
				item: { value: line.item, label: line.name, hint: line.sku ?? undefined },
				quantity: line.remaining,
				value: Math.round((line.value * line.remaining) / line.quantity),
				unit: line.unit,
				orderLine: line.uuid,
			});
		}
	}
	if (lines.length === 0) addLine();
	if (seed.expense?.value && !proposed && !existing) lines[0].value.value = String(toMajorUnits(seed.expense.value, currency));

	const addButton = el("button", { class: "button ghost small", type: "button", onClick: () => addLine().item.input.focus() }, t("stock.add_line"));
	const countSheet = (blind: boolean) =>
		el(
			"button",
			{
				class: "button ghost small",
				type: "button",
				onClick: () =>
					window.open(inventoryPath(uuid, `/count-sheet?warehouse=${warehouse.value}&date=${date.value}${blind ? "&blind=1" : ""}`), "_blank", "noopener"),
			},
			t(blind ? "stock.count_sheet_blind" : "stock.count_sheet_print")
		);
	const loadAll = el(
		"button",
		{
			class: "button ghost small",
			type: "button",
			onClick: async () => {
				if (!warehouse.value || !date.value) return;
				try {
					const sheet = await InventoryApi.countSheet(uuid, warehouse.value, date.value);
					const present = new Set(lines.map((line) => line.item.value).filter(Boolean));
					for (const line of [...lines]) if (!line.item.value) dropLine(line);
					for (const entry of sheet.items) {
						if (present.has(entry.item)) continue;
						addLine({
							item: { value: entry.item, label: entry.name, hint: entry.sku ?? undefined },
							quantity: null,
							value: null,
							unit: entry.unit,
							booked: entry.booked,
						});
					}
					if (lines.length === 0) addLine();
					refreshTotals();
				} catch (error) {
					reportError(error);
				}
			},
		},
		t("stock.load_all_items")
	);

	const partnerFields = el("div", { class: "grid" }, field(t("stock.supplier"), partner), field(t("stock.supplier_tax_number"), partnerTax));
	const extraField = field(t("stock.extra_costs"), extra, t("stock.extra_costs_hint"));
	const invoiceField = field(t("stock.return_invoice"), invoicePicker.element, t("stock.return_invoice_hint"));
	const vatSwitch = el("label", { class: "switch" }, chargeVat, el("span", {}, t(type === "stocktake" ? "stock.charge_vat_stocktake" : "stock.charge_vat")));
	const vatHint = el("p", { class: "muted" }, t("stock.charge_vat_hint"));

	const applyReason = (initial: boolean) => {
		if (type === "receipt") {
			const purchase = reason.value === "purchase";
			const returned = reason.value === "customer_return";
			partnerFields.hidden = returned;
			extraField.hidden = !purchase;
			invoiceField.hidden = !returned;
			for (const line of lines) {
				line.priceCell.hidden = returned;
				line.valueCell.hidden = returned;
				line.row.classList.toggle("valued", !returned);
			}
		}
		if (type === "issue") {
			reasonHint.textContent = t(`stock.reason_${reason.value}_hint` as UiKey);
			if (!initial) chargeVat.checked = overview.taxable_issue_reasons.includes(reason.value);
		}
	};
	reason.addEventListener("change", () => applyReason(false));
	extra.addEventListener("input", refreshTotals);
	const reloadBooked = () => {
		if (type === "receipt" || type === "opening") return;
		for (const line of lines) void refreshBooked(line, line.row.querySelector<HTMLElement>(".stock-line-note")!);
	};
	warehouse.addEventListener("change", reloadBooked);
	date.addEventListener("change", reloadBooked);

	const collect = (): StockDocumentInput | null => {
		const filled = lines.filter((line) => line.item.value);
		if (filled.length === 0 || filled.some((line) => line.quantity.value === "")) {
			toast(t("stock.lines_incomplete"), "error");
			return null;
		}
		const returned = type === "receipt" && reason.value === "customer_return";
		return {
			document_type: type,
			warehouse: warehouse.value,
			target_warehouse: type === "transfer" ? target.value : null,
			date: date.value,
			reason: type === "issue" || type === "receipt" ? reason.value : null,
			partner: type === "receipt" && !returned ? partner.value.trim() || null : null,
			partner_tax_number: type === "receipt" && !returned ? partnerTax.value.trim() || null : null,
			external_reference: reference.value.trim() || null,
			expense: type === "receipt" && reason.value === "purchase" ? expenseId : null,
			purchase_order: type === "receipt" && reason.value === "purchase" ? (existing?.purchase_order ?? seed.order?.uuid ?? null) : null,
			invoice: returned ? invoicePicker.value || existing?.invoice || null : null,
			extra_costs: type === "receipt" && reason.value === "purchase" && extra.value ? toMinorUnits(Number(extra.value), currency) : 0,
			charge_vat: (type === "issue" || type === "stocktake") && chargeVat.checked,
			ledger_account: type === "issue" ? account.value || null : null,
			opening_offset: type === "opening" ? (offset.value as "none" | "expense") : undefined,
			notes: notes.value.trim() || null,
			lines: filled.map((line) => ({
				item: line.item.value,
				quantity: quantityFromInput(line.quantity.value),
				value: valued && !returned ? lineValue(line) : null,
				note: line.note,
				order_line: line.orderLine,
			})),
		};
	};

	const saveDraft = async (): Promise<StockDocument | null> => {
		const data = collect();
		if (!data) return null;
		return existing ? await InventoryApi.updateDocument(uuid, existing.uuid, data) : await InventoryApi.createDocument(uuid, data);
	};

	const save = el("button", { class: "button ghost", type: "submit" }, t("stock.save_draft"));
	const post = el("button", { class: "button primary", type: "button" }, t("stock.post"));
	const busy = (state: boolean) => (save.disabled = post.disabled = state);
	post.addEventListener("click", async () => {
		if (!form.reportValidity()) return;
		if (!(await confirmDialog({ title: t("stock.post_title"), body: t(`stock.post_body_${type}` as UiKey), confirmLabel: t("stock.post") }))) return;
		busy(true);
		let saved: StockDocument | null = null;
		try {
			saved = await saveDraft();
			if (!saved) return busy(false);
			await InventoryApi.postDocument(uuid, saved.uuid);
			toast(t("stock.posted"), "success");
			navigate(inventoryPath(uuid, `/documents/${saved.uuid}`), true);
		} catch (error) {
			reportError(error);
			if (saved && !existing) navigate(inventoryPath(uuid, `/documents/${saved.uuid}`), true);
			else busy(false);
		}
	});
	const remove = existing
		? el(
				"button",
				{
					class: "button ghost danger",
					type: "button",
					onClick: async () => {
						if (!(await confirmDialog({ title: t("stock.delete_title"), body: t("stock.delete_body"), confirmLabel: t("ui.delete"), destructive: true })))
							return;
						try {
							await InventoryApi.deleteDocument(uuid, existing.uuid);
							navigate(inventoryPath(uuid, "/documents"));
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
					const saved = await saveDraft();
					if (!saved) return busy(false);
					toast(t("stock.draft_saved"), "success");
					navigate(inventoryPath(uuid, `/documents/${saved.uuid}`), true);
				} catch (error) {
					reportError(error);
					busy(false);
				}
			},
		},
		el(
			"div",
			{ class: "grid" },
			field(t("stock.date"), date),
			field(t(type === "transfer" ? "stock.from_warehouse" : "stock.warehouse"), warehouse),
			type === "transfer" ? field(t("stock.to_warehouse"), target) : null,
			reasons.length > 0 ? el("label", { class: "field" }, el("span", { class: "field-label" }, t("stock.reason")), reason, reasonHint) : null,
			type === "opening" ? field(t("stock.offset"), offset, t("stock.offset_hint")) : null,
			type === "issue" && costAccounts.length > 0 ? field(t("stock.cost_account"), account.element, t("stock.cost_account_hint")) : null
		),
		type === "receipt" ? partnerFields : null,
		type === "receipt" ? invoiceField : null,
		el(
			"div",
			{ class: "grid" },
			field(t(type === "receipt" ? "stock.supplier_document" : "stock.reference"), reference),
			type === "receipt" ? extraField : null
		),
		seed.expense
			? el("p", { class: "muted" }, t("stock.from_expense", { number: seed.expense.invoice_number ?? "", supplier: seed.expense.supplier ?? "" }))
			: null,
		proposed ? el("p", { class: "muted" }, t("stock.lines_proposed")) : null,
		seed.order ? el("p", { class: "muted" }, t("purchase.receiving_for", { number: seed.order.number ?? "" })) : null,
		type === "issue" || type === "stocktake" ? el("div", { class: "stack" }, vatSwitch, vatHint) : null,
		el(
			"section",
			{ class: "ledger-section" },
			el(
				"div",
				{ class: "ledger-section-head" },
				el("h3", {}, t("stock.lines")),
				type === "stocktake" ? el("div", { class: "line-actions" }, countSheet(false), countSheet(true), loadAll) : null
			),
			type === "stocktake" ? el("p", { class: "muted" }, t("stock.stocktake_hint")) : null,
			rows,
			el("div", { class: "stock-lines-foot" }, addButton, totals)
		),
		field(t("stock.notes"), notes),
		el("div", { class: "form-actions" }, remove, save, post)
	);
	applyReason(true);
	refreshTotals();
	return form;
}

function cancelDialog(project: Project, document: StockDocument) {
	const reason = input("text", { maxlength: "500", required: true });
	const submit = el("button", { class: "button danger", type: "submit" }, t("stock.cancel_document"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					await InventoryApi.cancelDocument(project.uuid, document.uuid, reason.value.trim());
					dialog.close();
					toast(t("stock.canceled"), "success");
					navigate(inventoryPath(project.uuid, `/documents/${document.uuid}`), true);
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, t("stock.cancel_hint")),
		field(t("stock.cancel_reason"), reason),
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(t("stock.cancel_title", { number: document.number ?? "" }), form, undefined, "dialog-medium");
	reason.focus();
}

function detail(label: string, value: string | HTMLElement | null): HTMLElement | null {
	if (value === null || value === "") return null;
	return el("div", { class: "stock-detail" }, el("span", { class: "muted" }, label), el("span", {}, value));
}

function posted(project: Project, overview: InventoryOverview, document: StockDocument): HTMLElement {
	const currency = document.currency;
	const names = new Map(overview.warehouses.map((warehouse) => [warehouse.uuid, `${warehouse.code} ${warehouse.name}`]));
	const type = document.document_type;
	const stocktake = type === "stocktake";
	const headers: TableHeader[] = stocktake
		? [t("stock.item"), numeric(t("stock.booked")), numeric(t("stock.counted")), numeric(t("stock.difference")), numeric(t("stock.value"))]
		: [t("stock.item"), numeric(t("stock.quantity")), numeric(t("stock.unit_cost")), numeric(t("stock.value"))];
	const total = document.lines.reduce((sum, line) => sum + (line.booked_value ?? 0), 0);
	const rows = document.lines.map((line) => {
		const name = el(
			"td",
			{},
			el("a", { href: inventoryPath(project.uuid, `/items/${line.item}`) }, line.name),
			line.sku ? el("div", { class: "muted" }, line.sku) : null
		);
		if (stocktake) {
			const difference = line.quantity - (line.expected_quantity ?? line.quantity);
			return el(
				"tr",
				{},
				name,
				el("td", { class: "num" }, formatQuantity(line.expected_quantity ?? 0, line.unit)),
				el("td", { class: "num" }, formatQuantity(line.quantity, line.unit)),
				el("td", { class: `num${difference !== 0 ? " warn" : ""}` }, difference === 0 ? "" : `${difference > 0 ? "+" : ""}${formatQuantity(difference)}`),
				moneyCell(difference === 0 ? null : (line.booked_value ?? 0), currency)
			);
		}
		const value = Math.abs(line.booked_value ?? 0);
		return el(
			"tr",
			{},
			name,
			el("td", { class: "num" }, formatQuantity(line.quantity, line.unit)),
			el("td", { class: "num" }, formatUnitCost(value, line.quantity, currency)),
			moneyCell(value, currency)
		);
	});
	const totalRow = el(
		"tr",
		{ class: "total-row" },
		el("td", {}, t("stock.total")),
		...headers.slice(2).map(() => el("td", {})),
		moneyCell(stocktake ? total : Math.abs(total), currency, { strong: true })
	);
	const dateFormat = project.date_format as DateFormat;
	const timeFormat = project.time_format as TimeFormat;
	return el(
		"div",
		{ class: "stack" },
		document.status === "canceled"
			? el("div", { class: "ledger-notice" }, el("p", { class: "warn" }, t("stock.canceled_notice", { reason: document.cancel_reason ?? "-" })))
			: null,
		el(
			"div",
			{ class: "stock-details" },
			detail(t("stock.date"), shortDate(document.date, project)),
			detail(t(type === "transfer" ? "stock.from_warehouse" : "stock.warehouse"), names.get(document.warehouse) ?? ""),
			detail(t("stock.to_warehouse"), document.target_warehouse ? (names.get(document.target_warehouse) ?? "") : null),
			detail(t("stock.reason"), type === "issue" || type === "receipt" ? reasonLabel(document.reason) : null),
			detail(t("stock.supplier"), [document.partner, document.partner_tax_number].filter(Boolean).join(" | ")),
			detail(t(type === "receipt" ? "stock.supplier_document" : "stock.reference"), document.external_reference),
			detail(t("stock.extra_costs"), document.extra_costs > 0 ? formatMoney(document.extra_costs, currency) : null),
			detail(t("stock.offset"), type === "opening" ? t(document.opening_offset === "expense" ? "stock.offset_expense" : "stock.offset_none") : null),
			detail(t("stock.vat"), document.charge_vat ? t("stock.vat_charged") : null),
			detail(
				t("purchase.order"),
				document.purchase_order ? el("a", { href: inventoryPath(project.uuid, `/orders/${document.purchase_order}`) }, t("purchase.open_order")) : null
			),
			detail(
				t("stock.linked_expense"),
				document.expense ? el("a", { href: `/projects/${project.uuid}/expenses?open=${document.expense}` }, t("stock.open_expense")) : null
			),
			detail(
				t("stock.return_invoice"),
				document.invoice ? el("a", { href: `/projects/${project.uuid}/invoices/${document.invoice}` }, t("stock.open_invoice")) : null
			),
			detail(
				t("stock.posted_by"),
				document.posted_at ? `${document.posted_by_name ?? ""} ${formatDateTime(document.posted_at, dateFormat, timeFormat, project.timezone)}`.trim() : null
			),
			detail(t("stock.notes"), document.notes)
		),
		rows.length ? table(headers, [...rows, totalRow]) : emptyState(t("stock.lines_empty"))
	);
}

export async function inventoryDocumentView(uuid: string, documentId: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const overview = await InventoryApi.overview(uuid);
	const back = el("a", { class: "back-link", href: inventoryPath(uuid, "/documents") }, t("stock.back_to_documents"));
	const keepsBooks = (project.accounting || project.accounting_until !== null) && can(project, Permission.REPORT_VIEW);
	const accounts = keepsBooks ? (await Api.ledgerAccounts(uuid).catch(() => ({ accounts: [] }))).accounts : [];
	const params = new URLSearchParams(location.search);

	if (documentId === "new") {
		const type = isType(params.get("type")) ? (params.get("type") as StockDocumentType) : "receipt";
		const expenseId = params.get("expense");
		const purchase = expenseId ? (await InventoryApi.purchases(uuid)).expenses.find((expense) => expense.uuid === expenseId) : undefined;
		const orderId = params.get("order");
		const order = orderId && type === "receipt" ? await PurchasingApi.order(uuid, orderId).catch(() => null) : null;
		const proposedLines = purchase ? await InventoryApi.purchaseLines(uuid, purchase.uuid).catch(() => ({ lines: [] })) : { lines: [] };
		return inventoryPage(
			project,
			"documents",
			{ back, title: t(`stock.new_${type}` as UiKey), intro: t(`stock.intro_${type}` as UiKey) },
			licenseNotice(project),
			overview.warehouses.some((warehouse) => !warehouse.archived)
				? editor(project, overview, {
						type,
						accounts,
						document: null,
						expense: purchase
							? {
									uuid: purchase.uuid,
									supplier: purchase.supplier,
									tax_number: purchase.supplier_tax_number,
									invoice_number: purchase.invoice_number,
									date: purchase.date,
									value: purchase.value,
									lines: proposedLines.lines,
								}
							: null,
						order: order?.status === "ordered" ? order : null,
					})
				: emptyState(t("stock.no_tracked_items"), el("a", { class: "button primary", href: inventoryPath(uuid) }, t("stock.back_to_stock")))
		);
	}

	const document = await InventoryApi.document(uuid, documentId);
	const title = `${documentTypeLabel(document.document_type)} ${document.number ?? t("stock.draft_number")}`;
	const canEdit = stockEditable(project);
	if (document.status === "draft" && canEdit) {
		return inventoryPage(
			project,
			"documents",
			{ back, title, intro: t(`stock.intro_${document.document_type}` as UiKey) },
			editor(project, overview, { type: document.document_type, accounts, document, expense: null, order: null })
		);
	}
	return inventoryPage(
		project,
		"documents",
		{
			back,
			title: el("h2", {}, title, " ", statusPill(document.status)),
			actions: [
				el("a", { class: "button ghost", href: inventoryPath(uuid, `/documents/${document.uuid}/print`) }, t("stock.print")),
				document.status === "posted" && canEdit
					? el("button", { class: "button ghost danger no-print", type: "button", onClick: () => cancelDialog(project, document) }, t("stock.cancel_document"))
					: null,
			],
		},
		licenseNotice(project),
		posted(project, overview, document)
	);
}
