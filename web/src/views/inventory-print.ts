import { Api, InventoryApi, PurchasingApi, type Company, type Project, type StockDocument } from "../api";
import { el, emptyState } from "../dom";
import { formatMoney, toDateInput } from "../money";
import { t, type UiKey } from "../i18n";
import { unitLabel } from "../options";
import { loadProject } from "./project";
import { documentTypeLabel, formatQuantity, formatUnitCost, inventoryPath, methodLabel, reasonLabel, shortDate } from "./inventory";

function companyLines(company: Company | null, fallback: string): string[] {
	if (!company) return [fallback];
	return [
		company.legal_name || fallback,
		company.address_line1,
		company.address_line2,
		[company.postal_code, company.city].filter(Boolean).join(" "),
		company.tax_number || company.vat_number ? t("iop.tax_number", { number: (company.vat_number || company.tax_number)! }) : null,
	].filter((line): line is string => Boolean(line));
}

function party(label: string, lines: string[]): HTMLElement {
	const [first, ...rest] = lines;
	return el(
		"div",
		{ class: "iop-party" },
		el("p", { class: "doc-muted" }, label),
		el("p", {}, el("strong", {}, first ?? "")),
		...rest.map((line) => el("p", {}, line))
	);
}

function fact(label: string, value: string | null): HTMLElement | null {
	return value ? el("p", {}, el("span", { class: "doc-muted" }, `${label}: `), value) : null;
}

function signatures(labels: string[]): HTMLElement {
	return el(
		"div",
		{ class: "iop-signatures stock-signatures" },
		...labels.map((label) => el("div", {}, el("div", { class: "iop-sign-line" }), el("p", { class: "doc-muted" }, label)))
	);
}

function sheet(...content: (HTMLElement | null)[]): HTMLElement {
	return el("div", { class: "document iop-sheet stock-sheet" }, ...content);
}

function printPage(back: string, content: HTMLElement): HTMLElement {
	return el(
		"div",
		{ class: "print-page" },
		el(
			"div",
			{ class: "doc-actions no-print" },
			el("a", { class: "button ghost", href: back }, t("stock.print_back")),
			el("button", { class: "button primary", type: "button", onClick: () => window.print() }, t("stock.print"))
		),
		content
	);
}

function head(labels: string[], numericFrom: number): HTMLElement {
	return el("thead", {}, el("tr", {}, ...labels.map((label, index) => el("th", { class: index >= numericFrom ? "num" : "" }, label))));
}

function spanning(cell: HTMLTableCellElement, columns: number): HTMLTableCellElement {
	cell.colSpan = columns;
	return cell;
}

const SIGNATURES: Record<StockDocument["document_type"], UiKey[]> = {
	receipt: ["stock.print_delivered_by", "stock.print_received_by"],
	issue: ["stock.print_issued_by", "stock.print_received_by"],
	transfer: ["stock.print_issued_by", "stock.print_received_by"],
	stocktake: ["stock.print_committee", "stock.print_committee", "stock.print_responsible"],
	opening: ["stock.print_prepared_by", "stock.print_responsible"],
};

function documentSheet(project: Project, company: Company | null, document: StockDocument, warehouses: Map<string, string>, method: string): HTMLElement {
	const currency = document.currency;
	const type = document.document_type;
	const stocktake = type === "stocktake";
	const money = (value: number) => formatMoney(value, currency);
	let surplus = 0;
	let shortage = 0;
	let total = 0;
	const rows = document.lines.map((line, index) => {
		const start = [el("td", {}, String(index + 1)), el("td", {}, line.sku ?? ""), el("td", {}, line.name), el("td", {}, unitLabel(line.unit) ?? "")];
		if (stocktake) {
			const booked = line.expected_quantity ?? line.quantity;
			const difference = line.quantity - booked;
			const value = line.booked_value ?? 0;
			if (value > 0) surplus += value;
			else shortage -= value;
			return el(
				"tr",
				{},
				...start,
				el("td", { class: "num" }, formatQuantity(booked)),
				el("td", { class: "num" }, formatQuantity(line.quantity)),
				el("td", { class: "num" }, difference === 0 ? "" : `${difference > 0 ? "+" : ""}${formatQuantity(difference)}`),
				el("td", { class: "num" }, difference === 0 ? "" : money(value))
			);
		}
		const value = document.status === "draft" ? (line.value ?? 0) : Math.abs(line.booked_value ?? 0);
		total += value;
		return el(
			"tr",
			{},
			...start,
			el("td", { class: "num" }, formatQuantity(line.quantity)),
			el("td", { class: "num" }, formatUnitCost(value, line.quantity, currency)),
			el("td", { class: "num" }, value === 0 && document.status === "draft" ? "" : money(value))
		);
	});
	const common = [t("stock.print_no"), t("stock.warehouse_code"), t("stock.item"), t("stock.print_unit")];
	const labels = stocktake
		? [...common, t("stock.booked"), t("stock.counted"), t("stock.difference"), t("stock.value")]
		: [...common, t("stock.quantity"), t("stock.unit_cost"), t("stock.value")];
	const totalRow = (label: string, value: number) =>
		el(
			"tr",
			{ class: "iop-total" },
			spanning(el("td", {}, el("strong", {}, label)), labels.length - 1),
			el("td", { class: "num" }, el("strong", {}, money(value)))
		);
	const title = `${documentTypeLabel(type)} ${document.number ?? t("stock.draft_number")}`;
	const supplier = [document.partner, document.partner_tax_number ? t("iop.tax_number", { number: document.partner_tax_number }) : null].filter(
		(line): line is string => Boolean(line)
	);
	return sheet(
		el(
			"div",
			{ class: "iop-parties" },
			party(t("stock.print_company"), companyLines(company, project.display_name ?? project.name)),
			supplier.length > 0 ? party(t("stock.supplier"), supplier) : null
		),
		el("h1", { class: "iop-title" }, title),
		document.status === "canceled" ? el("p", {}, el("strong", {}, t("stock.canceled_notice", { reason: document.cancel_reason ?? "-" }))) : null,
		el(
			"div",
			{ class: "stock-facts" },
			fact(t("stock.date"), shortDate(document.date, project)),
			fact(t(type === "transfer" ? "stock.from_warehouse" : "stock.warehouse"), warehouses.get(document.warehouse) ?? null),
			fact(t("stock.to_warehouse"), document.target_warehouse ? (warehouses.get(document.target_warehouse) ?? null) : null),
			fact(t("stock.reason"), type === "issue" || type === "receipt" ? reasonLabel(document.reason) : null),
			fact(t(type === "receipt" ? "stock.supplier_document" : "stock.reference"), document.external_reference),
			fact(t("stock.method"), type === "receipt" || type === "opening" ? null : method),
			fact(t("stock.vat"), document.charge_vat ? t("stock.vat_charged") : null)
		),
		el(
			"table",
			{ class: "iop-table stock-print-table" },
			head(labels, 4),
			el(
				"tbody",
				{},
				...rows,
				...(stocktake
					? [totalRow(t("stock.print_surplus_total"), surplus), totalRow(t("stock.print_shortage_total"), shortage)]
					: type === "transfer"
						? []
						: [totalRow(document.extra_costs > 0 ? t("stock.print_total_with_costs", { costs: money(document.extra_costs) }) : t("stock.total"), total)])
			)
		),
		document.notes ? el("p", {}, el("span", { class: "doc-muted" }, `${t("stock.notes")}: `), document.notes) : null,
		signatures(SIGNATURES[type].map((key) => t(key)))
	);
}

export async function inventoryDocumentPrintView(uuid: string, documentId: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const [document, overview, company] = await Promise.all([
		InventoryApi.document(uuid, documentId),
		InventoryApi.overview(uuid),
		Api.company(uuid).catch(() => null),
	]);
	const warehouses = new Map(overview.warehouses.map((warehouse) => [warehouse.uuid, `${warehouse.code} ${warehouse.name}`]));
	return printPage(
		inventoryPath(uuid, `/documents/${documentId}`),
		documentSheet(project, company, document, warehouses, methodLabel(overview.settings.method))
	);
}

export async function inventoryCountSheetView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const params = new URLSearchParams(location.search);
	const overview = await InventoryApi.overview(uuid);
	const warehouse = overview.warehouses.find((entry) => entry.uuid === params.get("warehouse")) ?? overview.warehouses.find((entry) => entry.is_default);
	const date = params.get("date") ?? toDateInput(Date.now(), project.timezone);
	const back = inventoryPath(uuid, "/documents");
	if (!warehouse) return printPage(back, emptyState(t("stock.warehouses_empty")));
	const [sheetData, company] = await Promise.all([InventoryApi.countSheet(uuid, warehouse.uuid, date), Api.company(uuid).catch(() => null)]);
	const blind = params.get("blind") === "1";
	const labels = [
		t("stock.print_no"),
		t("stock.warehouse_code"),
		t("stock.item"),
		t("stock.print_unit"),
		...(blind ? [] : [t("stock.booked")]),
		t("stock.counted"),
		t("stock.notes"),
	];
	return printPage(
		back,
		sheet(
			el("div", { class: "iop-parties" }, party(t("stock.print_company"), companyLines(company, project.display_name ?? project.name))),
			el("h1", { class: "iop-title" }, t("stock.count_sheet_title")),
			el(
				"div",
				{ class: "stock-facts" },
				fact(t("stock.on_date"), shortDate(date, project)),
				fact(t("stock.warehouse"), `${warehouse.code} ${warehouse.name}`)
			),
			el(
				"table",
				{ class: "iop-table stock-print-table stock-count-table" },
				head(labels, 4),
				el(
					"tbody",
					{},
					...sheetData.items.map((item, index) =>
						el(
							"tr",
							{},
							el("td", {}, String(index + 1)),
							el("td", {}, item.sku ?? ""),
							el("td", {}, item.name),
							el("td", {}, unitLabel(item.unit) ?? ""),
							blind ? null : el("td", { class: "num" }, formatQuantity(item.booked)),
							el("td", { class: "stock-count-blank" }),
							el("td", { class: "stock-count-blank" })
						)
					)
				)
			),
			signatures([t("stock.print_committee"), t("stock.print_committee"), t("stock.print_responsible")])
		)
	);
}

export async function inventoryOrderPrintView(uuid: string, orderId: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const [order, overview, company] = await Promise.all([PurchasingApi.order(uuid, orderId), InventoryApi.overview(uuid), Api.company(uuid).catch(() => null)]);
	const warehouse = overview.warehouses.find((entry) => entry.uuid === order.warehouse);
	const supplier = order.supplier;
	const labels = [
		t("stock.print_no"),
		t("stock.warehouse_code"),
		t("stock.item"),
		t("stock.print_unit"),
		t("stock.quantity"),
		t("stock.unit_price"),
		t("stock.value"),
	];
	const supplierLines = supplier
		? [
				supplier.name,
				supplier.address_line1,
				[supplier.postal_code, supplier.city].filter(Boolean).join(" "),
				supplier.tax_number ? t("iop.tax_number", { number: supplier.tax_number }) : null,
			].filter((line): line is string => Boolean(line))
		: [];
	return printPage(
		inventoryPath(uuid, `/orders/${orderId}`),
		sheet(
			el(
				"div",
				{ class: "iop-parties" },
				party(t("purchase.print_buyer"), companyLines(company, project.display_name ?? project.name)),
				supplierLines.length > 0 ? party(t("stock.supplier"), supplierLines) : null
			),
			el("h1", { class: "iop-title" }, `${t("purchase.order")} ${order.number ?? t("stock.draft_number")}`),
			el(
				"div",
				{ class: "stock-facts" },
				fact(t("purchase.order_date"), shortDate(order.date, project)),
				fact(t("purchase.expected"), order.expected_date ? shortDate(order.expected_date, project) : null),
				fact(t("purchase.deliver_to"), warehouse ? [warehouse.name, warehouse.address].filter(Boolean).join(", ") : null),
				fact(t("purchase.supplier_reference"), order.supplier_reference)
			),
			el(
				"table",
				{ class: "iop-table stock-print-table" },
				head(labels, 4),
				el(
					"tbody",
					{},
					...order.lines.map((line, index) =>
						el(
							"tr",
							{},
							el("td", {}, String(index + 1)),
							el("td", {}, line.sku ?? ""),
							el("td", {}, line.name),
							el("td", {}, unitLabel(line.unit) ?? ""),
							el("td", { class: "num" }, formatQuantity(line.quantity)),
							el("td", { class: "num" }, formatUnitCost(line.value, line.quantity, order.currency)),
							el("td", { class: "num" }, line.value ? formatMoney(line.value, order.currency) : "")
						)
					),
					el(
						"tr",
						{ class: "iop-total" },
						spanning(el("td", {}, el("strong", {}, t("purchase.print_total"))), labels.length - 1),
						el("td", { class: "num" }, el("strong", {}, formatMoney(order.ordered_value, order.currency)))
					)
				)
			),
			order.notes ? el("p", {}, order.notes) : null,
			signatures([t("purchase.print_ordered_by")])
		)
	);
}
