import {
	InventoryApi,
	type InventoryOverview,
	type Project,
	type StockDocumentType,
	type StockFilter,
	type StockKind,
	type StockMovement,
	type StockRow,
	type ValuationMethod,
	type Warehouse,
} from "../api";
import { el, emptyState, field, input, replaceContent, saveFile, select, table, type TableHeader } from "../dom";
import { formatDate, formatDateTime, formatMoney, minorUnitDigits, toDateInput, toMinorUnits } from "../money";
import { can, Permission } from "../access";
import { locale, t, type UiKey } from "../i18n";
import { actionMenu } from "../menu";
import { unitLabel } from "../options";
import { remoteTable } from "../pagination";
import { combobox } from "../combobox";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { loadProject, projectLayout } from "./project";
import { searchFilter } from "./list-filters";
import type { DateFormat, TimeFormat } from "../../../server/formats";

export type InventoryTab = "stock" | "documents" | "orders" | "suppliers" | "valuation" | "settings";

const TABS: { id: InventoryTab; label: UiKey; suffix: string }[] = [
	{ id: "stock", label: "stock.tab_stock", suffix: "" },
	{ id: "documents", label: "stock.tab_documents", suffix: "/documents" },
	{ id: "orders", label: "purchase.tab_orders", suffix: "/orders" },
	{ id: "suppliers", label: "purchase.tab_suppliers", suffix: "/suppliers" },
	{ id: "valuation", label: "stock.tab_valuation", suffix: "/valuation" },
	{ id: "settings", label: "stock.tab_settings", suffix: "/settings" },
];

export const DOCUMENT_TYPES: StockDocumentType[] = ["receipt", "issue", "transfer", "stocktake", "opening"];

type Child = Parameters<typeof el>[2];

interface PageHead {
	title: string | HTMLElement;
	intro?: string;
	actions?: (HTMLElement | null)[];
	back?: HTMLElement;
}

export function inventoryPath(project: string, suffix = ""): string {
	return `/projects/${project}/inventory${suffix}`;
}

export function inventoryPage(project: Project, active: InventoryTab, head: PageHead, ...content: Child[]): HTMLElement {
	const actions = (head.actions ?? []).filter((action): action is HTMLElement => action !== null);
	return projectLayout(
		project,
		el(
			"div",
			{ class: "stack ledger-page stock-page" },
			el(
				"div",
				{ class: "store-bar" },
				el(
					"nav",
					{ class: "subtabs" },
					...TABS.map((tab) => el("a", { class: `subtab${tab.id === active ? " active" : ""}`, href: inventoryPath(project.uuid, tab.suffix) }, t(tab.label)))
				)
			),
			el(
				"div",
				{ class: "ledger-head" },
				head.back ?? null,
				el(
					"div",
					{ class: "ledger-head-row" },
					typeof head.title === "string" ? el("h2", {}, head.title) : head.title,
					actions.length ? el("div", { class: "line-actions" }, ...actions) : null
				),
				head.intro ? el("p", { class: "muted" }, head.intro) : null
			),
			...content
		)
	);
}

export function stockEditable(project: Project): boolean {
	return project.inventory && can(project, Permission.STOCK_EDIT);
}

export function numeric(label: string): TableHeader {
	return { label, class: "num" };
}

export function formatQuantity(thousandths: number, unit: string | null | undefined = null): string {
	const text = new Intl.NumberFormat(locale(), { maximumFractionDigits: 3 }).format(thousandths / 1000).replace("\u2212", "-");
	const symbol = unitLabel(unit);
	return symbol ? `${text} ${symbol}` : text;
}

export function formatUnitCost(value: number, thousandths: number, currency: string): string {
	if (thousandths === 0) return "";
	const digits = minorUnitDigits(currency);
	const cost = (value * 1000) / thousandths / Math.pow(10, digits);
	return new Intl.NumberFormat(locale(), { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits + 2 }).format(cost);
}

export function quantityFromInput(value: string): number {
	return Math.round(Number(value.replace(",", ".")) * 1000);
}

export function quantityToInput(thousandths: number): string {
	return String(thousandths / 1000);
}

export function kindLabel(kind: StockKind): string {
	return t(kind === "goods" ? "stock.kind_goods" : "stock.kind_material");
}

export function documentTypeLabel(type: StockDocumentType): string {
	return t(`stock.type_${type}` as UiKey);
}

export function reasonLabel(reason: string | null): string {
	return reason ? t(`stock.reason_${reason}` as UiKey) : "";
}

export function methodLabel(method: ValuationMethod): string {
	return t(method === "fifo" ? "stock.method_fifo" : "stock.method_average");
}

export function moneyCell(value: number | null, currency: string, options: { strong?: boolean; warn?: boolean } = {}): HTMLElement {
	const text = value === null ? "" : formatMoney(value, currency);
	return el("td", { class: `num${options.warn ? " warn" : ""}` }, options.strong ? el("strong", {}, text) : text);
}

export function licenseNotice(project: Project): HTMLElement | null {
	if (project.inventory) return null;
	return el(
		"div",
		{ class: "ledger-notice" },
		el("p", { class: "warn" }, t("stock.read_only")),
		can(project, Permission.PROJECT_EDIT)
			? el("div", {}, el("a", { class: "button primary small", href: `/projects/${project.uuid}/license` }, t("stock.open_license")))
			: null
	);
}

function statCard(label: string, value: string, tone: "" | "warn" = ""): HTMLElement {
	return el("div", { class: "card stat" }, el("span", { class: `stat-value${tone ? " warn" : ""}` }, value), el("span", { class: "stat-label" }, label));
}

export function warehouseSelect(warehouses: Warehouse[], selected: string, all: boolean): HTMLSelectElement {
	const options = warehouses
		.filter((warehouse) => !warehouse.archived || warehouse.uuid === selected)
		.map((warehouse) => ({ value: warehouse.uuid, label: `${warehouse.code} ${warehouse.name}` }));
	return select(all ? [{ value: "", label: t("stock.all_warehouses") }, ...options] : options, selected);
}

function newDocumentActions(project: Project): (HTMLElement | null)[] {
	if (!stockEditable(project)) return [];
	const href = (type: StockDocumentType) => inventoryPath(project.uuid, `/documents/new?type=${type}`);
	return [
		el("a", { class: "button primary", href: href("receipt") }, t("stock.new_receipt")),
		actionMenu(t("stock.more_documents"), [
			(["issue", "transfer", "stocktake", "opening"] as StockDocumentType[]).map((type) => ({ label: t(`stock.new_${type}` as UiKey), href: href(type) })),
		]),
	];
}

function trackDialog(project: Project, onSaved: () => void, preset: { uuid: string; name: string; store_stock: number | null } | null = null) {
	const storeStock = new Map<string, number | null>();
	const picker = combobox({
		search: async (query) =>
			(await InventoryApi.candidates(project.uuid, query)).items.map((item) => {
				storeStock.set(item.uuid, item.store_stock);
				return { value: item.uuid, label: item.name, hint: item.sku ?? undefined };
			}),
		placeholder: t("stock.track_search"),
		required: true,
		emptyText: t("stock.track_none"),
	});
	const kind = select(
		[
			{ value: "goods", label: `${t("stock.kind_goods")} (${t("stock.kind_goods_hint")})` },
			{ value: "material", label: `${t("stock.kind_material")} (${t("stock.kind_material_hint")})` },
		],
		"goods"
	);
	const minimum = input("number", { min: "0", step: "0.001" });
	const currency = project.tax_currency ?? project.currency;
	const onHand = input("number", { min: "0", step: "0.001" });
	const unitCost = input("number", { min: "0", step: "0.0001" });
	const offset = select(
		[
			{ value: "none", label: t("stock.offset_none") },
			{ value: "expense", label: t("stock.offset_expense") },
		],
		"none"
	);
	const storeNotice = el("p", { class: "warn" });
	storeNotice.hidden = true;
	const showStoreStock = (item: string | null) => {
		const listed = item ? (storeStock.get(item) ?? null) : null;
		storeNotice.hidden = listed === null || listed <= 0;
		if (listed !== null && listed > 0) {
			storeNotice.textContent = t("stock.track_store_stock", { quantity: listed });
			if (!onHand.value) onHand.value = String(listed);
		}
	};
	picker.onChange((option) => showStoreStock(option?.value ?? null));
	const submit = el("button", { class: "button primary", type: "submit" }, t("stock.track_save"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				if (!picker.value) return;
				const quantity = onHand.value ? quantityFromInput(onHand.value) : 0;
				if (quantity > 0 && !unitCost.value) {
					toast(t("stock.track_cost_needed"), "error");
					unitCost.focus();
					return;
				}
				submit.disabled = true;
				try {
					await InventoryApi.trackItem(project.uuid, picker.value, {
						stock_kind: kind.value as StockKind,
						stock_minimum: minimum.value ? quantityFromInput(minimum.value) : null,
						opening:
							quantity > 0
								? {
										quantity,
										value: toMinorUnits((Number(unitCost.value) * quantity) / 1000, currency),
										offset: offset.value as "none" | "expense",
									}
								: null,
					});
					dialog.close();
					toast(t("stock.track_saved"), "success");
					onSaved();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, t("stock.track_hint")),
		field(t("stock.item"), picker.element),
		el("div", { class: "grid" }, field(t("stock.kind"), kind), field(t("stock.minimum"), minimum, t("stock.minimum_hint"))),
		el("h3", {}, t("stock.track_opening")),
		el("p", { class: "muted" }, t("stock.track_opening_hint")),
		storeNotice,
		el("div", { class: "grid" }, field(t("stock.track_on_hand"), onHand), field(t("stock.track_unit_cost"), unitCost, t("stock.track_unit_cost_hint"))),
		field(t("stock.offset"), offset, t("stock.offset_hint")),
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(t("stock.track_title"), form, undefined, "dialog-medium");
	if (preset) {
		storeStock.set(preset.uuid, preset.store_stock);
		picker.select({ value: preset.uuid, label: preset.name });
		showStoreStock(preset.uuid);
		onHand.focus();
	} else picker.input.focus();
}

function stockStatus(row: StockRow): HTMLElement | null {
	if (row.quantity < 0) return el("span", { class: "pill pill-overdue" }, t("stock.status_negative"));
	if (row.low) return el("span", { class: "pill pill-pending" }, t("stock.status_low"));
	return null;
}

function stockRow(project: Project, row: StockRow, currency: string): HTMLElement {
	const available = row.quantity - row.reserved;
	return el(
		"tr",
		{ class: row.archived ? "muted" : "" },
		el(
			"td",
			{},
			el("a", { href: inventoryPath(project.uuid, `/items/${row.item}`) }, row.name),
			el("div", { class: "muted" }, [row.sku, kindLabel(row.stock_kind)].filter(Boolean).join(" | "))
		),
		el(
			"td",
			{ class: `num${row.quantity < 0 ? " warn" : ""}` },
			formatQuantity(row.quantity, row.unit),
			row.reserved > 0 ? el("div", { class: "muted" }, t("stock.available", { quantity: formatQuantity(available, row.unit) })) : null,
			row.on_order > 0 ? el("div", { class: "muted" }, t("purchase.on_order_quantity", { quantity: formatQuantity(row.on_order, row.unit) })) : null
		),
		el("td", { class: "num stock-optional" }, row.minimum === null ? "" : formatQuantity(row.minimum, row.unit)),
		el("td", { class: "num" }, formatUnitCost(row.value, row.quantity, currency)),
		moneyCell(row.value, currency),
		el("td", { class: "actions" }, stockStatus(row))
	);
}

function overviewNotices(project: Project, overview: InventoryOverview): HTMLElement[] {
	const notices: HTMLElement[] = [];
	const license = licenseNotice(project);
	if (license) notices.push(license);
	const differing = overview.ledger.filter((row) => row.difference !== 0);
	if (differing.length > 0) {
		notices.push(
			el(
				"div",
				{ class: "ledger-notice" },
				el("p", { class: "warn" }, t("stock.ledger_differs")),
				el(
					"ul",
					{},
					...differing.map((row) =>
						el(
							"li",
							{},
							t("stock.ledger_differs_line", {
								account: `${row.code} ${row.name}`,
								ledger: formatMoney(row.ledger, overview.currency),
								stock: formatMoney(row.stock, overview.currency),
							})
						)
					)
				)
			)
		);
	}
	if (overview.totals.drafts > 0) {
		notices.push(
			el(
				"div",
				{ class: "ledger-notice" },
				el("p", {}, t("stock.drafts_waiting", { count: overview.totals.drafts })),
				el("div", {}, el("a", { class: "button ghost small", href: inventoryPath(project.uuid, "/documents?status=draft") }, t("stock.open_drafts")))
			)
		);
	}
	return notices;
}

async function purchasesSection(project: Project): Promise<HTMLElement | null> {
	if (!stockEditable(project)) return null;
	const purchases = await InventoryApi.purchases(project.uuid).catch(() => null);
	if (!purchases || purchases.expenses.length === 0) return null;
	return el(
		"section",
		{ class: "ledger-section" },
		el("h3", {}, t("stock.purchases_title")),
		el("p", { class: "muted" }, t("stock.purchases_hint")),
		table(
			[t("stock.supplier"), t("stock.date"), numeric(t("stock.value")), ""],
			purchases.expenses.map((expense) =>
				el(
					"tr",
					{},
					el("td", {}, expense.supplier ?? expense.description, el("div", { class: "muted" }, expense.invoice_number ?? expense.description)),
					el("td", { class: "date" }, shortDate(expense.date, project)),
					moneyCell(expense.value, purchases.currency),
					el(
						"td",
						{ class: "actions" },
						el(
							"a",
							{ class: "button primary small", href: inventoryPath(project.uuid, `/documents/new?type=receipt&expense=${expense.uuid}`) },
							t("stock.create_receipt")
						)
					)
				)
			)
		)
	);
}

export async function inventoryStockView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid, true);
	const overview = await InventoryApi.overview(uuid);
	const currency = overview.currency;
	const params = new URLSearchParams(location.search);
	const warehouse = warehouseSelect(overview.warehouses, params.get("warehouse") ?? "", true);
	const filter = select(
		(["all", "in_stock", "low", "negative", "empty"] as StockFilter[]).map((value) => ({ value, label: t(`stock.filter_${value}` as UiKey) })),
		params.get("filter") ?? "all"
	);
	const list = el("div", {});
	const total = el("p", { class: "muted" });
	const renderList = () => {
		replaceContent(
			list,
			remoteTable(
				[
					t("stock.item"),
					numeric(t("stock.quantity")),
					{ label: t("stock.minimum"), class: "num stock-optional" },
					numeric(t("stock.unit_cost")),
					numeric(t("stock.value")),
					"",
				],
				async (offset, limit) => {
					const page = await InventoryApi.stock(uuid, {
						warehouse: warehouse.value || undefined,
						search: search.value.trim() || undefined,
						filter: filter.value as StockFilter,
						limit,
						offset,
					});
					total.textContent = t("stock.list_total", { count: page.total, value: formatMoney(page.value, currency) });
					return { rows: page.items.map((row) => stockRow(project, row, currency)), total: page.total };
				},
				overview.totals.items === 0 ? t("stock.empty") : t("stock.empty_filtered")
			)
		);
	};
	const search = searchFilter("", t("stock.search_placeholder"), renderList);
	warehouse.addEventListener("change", renderList);
	filter.addEventListener("change", renderList);
	renderList();

	const canEdit = stockEditable(project);
	const wanted = params.get("track");
	if (canEdit && wanted) {
		history.replaceState({}, "", inventoryPath(uuid));
		const [candidate] = (await InventoryApi.candidates(uuid, "", wanted).catch(() => ({ items: [] }))).items;
		if (candidate) setTimeout(() => trackDialog(project, () => renderList(), candidate), 0);
	}
	const track = canEdit
		? el("button", { class: "button ghost", type: "button", onClick: () => trackDialog(project, () => renderList()) }, t("stock.track_button"))
		: null;

	return inventoryPage(
		project,
		"stock",
		{ title: t("stock.title"), intro: t("stock.intro"), actions: [...newDocumentActions(project), track] },
		...overviewNotices(project, overview),
		el(
			"div",
			{ class: "grid stats" },
			statCard(t("stock.stat_goods"), formatMoney(overview.totals.goods, currency)),
			statCard(t("stock.stat_material"), formatMoney(overview.totals.material, currency)),
			statCard(t("stock.stat_low"), String(overview.totals.low), overview.totals.low > 0 ? "warn" : ""),
			statCard(t("stock.stat_negative"), String(overview.totals.negative), overview.totals.negative > 0 ? "warn" : "")
		),
		await purchasesSection(project),
		el(
			"section",
			{ class: "ledger-section" },
			el(
				"div",
				{ class: "ledger-controls" },
				field(t("ui.search"), search),
				overview.warehouses.length > 1 ? field(t("stock.warehouse"), warehouse) : null,
				field(t("stock.show"), filter)
			),
			list,
			total
		)
	);
}

function movementLabel(movement: StockMovement): string {
	const kind = t(`stock.movement_${movement.kind}` as UiKey);
	if (movement.kind === "issue" && movement.reason) return `${kind} | ${reasonLabel(movement.reason)}`;
	return kind;
}

function movementSource(project: Project, movement: StockMovement): Child {
	if (movement.document) {
		return el(
			"a",
			{ href: inventoryPath(project.uuid, `/documents/${movement.document}`) },
			movement.document_number ?? t(("stock.type_" + movement.document_type) as UiKey)
		);
	}
	if (movement.invoice) return el("a", { href: `/projects/${project.uuid}/invoices/${movement.invoice}` }, movement.invoice_reference ?? "");
	return "";
}

export async function inventoryItemView(uuid: string, item: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const [overview, first] = await Promise.all([InventoryApi.overview(uuid), InventoryApi.item(uuid, item, { limit: 50 })]);
	const currency = first.currency;
	const details = first.item;
	const names = new Map(overview.warehouses.map((warehouse) => [warehouse.uuid, `${warehouse.code} ${warehouse.name}`]));
	const dateFormat = project.date_format as DateFormat;
	const timeFormat = project.time_format as TimeFormat;
	const canEdit = stockEditable(project);
	const quantity = first.levels.reduce((sum, level) => sum + level.quantity, 0);
	const value = first.levels.reduce((sum, level) => sum + level.value, 0);

	const kind = select(
		[
			{ value: "", label: t("stock.kind_off") },
			{ value: "goods", label: t("stock.kind_goods") },
			{ value: "material", label: t("stock.kind_material") },
		],
		details.stock_kind ?? ""
	);
	const minimum = input("number", { min: "0", step: "0.001", value: details.stock_minimum === null ? "" : quantityToInput(details.stock_minimum) });
	const save = el("button", { class: "button primary", type: "submit" }, t("ui.save"));
	const settings = el(
		"form",
		{
			class: "ledger-controls",
			onSubmit: async (event) => {
				event.preventDefault();
				save.disabled = true;
				try {
					await InventoryApi.trackItem(uuid, item, {
						stock_kind: (kind.value || null) as StockKind | null,
						stock_minimum: minimum.value ? quantityFromInput(minimum.value) : null,
					});
					toast(t("stock.item_saved"), "success");
				} catch (error) {
					reportError(error);
				}
				save.disabled = false;
			},
		},
		field(t("stock.kind"), kind),
		field(t("stock.minimum"), minimum),
		save
	);

	const warehouseFilter = warehouseSelect(overview.warehouses, "", true);
	const movements = el("div", {});
	const renderMovements = () => {
		const headers: TableHeader[] = [
			t("stock.date"),
			t("stock.movement"),
			t("stock.document"),
			numeric(t("stock.in")),
			numeric(t("stock.out")),
			numeric(t("stock.value")),
			numeric(t("stock.balance")),
			numeric(t("stock.balance_value")),
		];
		replaceContent(
			movements,
			remoteTable(
				headers,
				async (offset, limit) => {
					const page = await InventoryApi.item(uuid, item, { warehouse: warehouseFilter.value || undefined, limit, offset });
					return {
						rows: page.movements.map((movement) =>
							el(
								"tr",
								{},
								el("td", { class: "date" }, formatDateTime(movement.date, dateFormat, timeFormat, project.timezone)),
								el(
									"td",
									{ class: "stock-movement" },
									movementLabel(movement),
									overview.warehouses.length > 1 ? el("div", { class: "muted" }, names.get(movement.warehouse) ?? "") : null
								),
								el("td", {}, movementSource(project, movement), movement.partner ? el("div", { class: "muted" }, movement.partner) : null),
								el("td", { class: "num" }, movement.quantity > 0 ? formatQuantity(movement.quantity) : ""),
								el("td", { class: "num" }, movement.quantity < 0 ? formatQuantity(-movement.quantity) : ""),
								el(
									"td",
									{ class: "num" },
									formatMoney(movement.value, currency),
									movement.correction !== 0
										? el("div", { class: "muted" }, t("stock.correction", { value: formatMoney(-movement.correction, currency) }))
										: null
								),
								el("td", { class: `num${movement.balance_quantity < 0 ? " warn" : ""}` }, formatQuantity(movement.balance_quantity)),
								moneyCell(movement.balance_value, currency)
							)
						),
						total: page.total,
					};
				},
				t("stock.no_movements")
			)
		);
	};
	warehouseFilter.addEventListener("change", renderMovements);
	renderMovements();

	const layered = first.levels.filter((level) => level.layers.length > 1);

	return inventoryPage(
		project,
		"stock",
		{
			back: el("a", { class: "back-link", href: inventoryPath(uuid) }, t("stock.back_to_stock")),
			title: details.name,
			intro: [details.sku, details.stock_kind ? kindLabel(details.stock_kind) : t("stock.kind_off"), methodLabel(overview.settings.method)]
				.filter(Boolean)
				.join(" | "),
			actions: [el("a", { class: "button ghost", href: `/projects/${uuid}/items/${item}` }, t("stock.open_item"))],
		},
		licenseNotice(project),
		el(
			"div",
			{ class: "grid stats" },
			statCard(t("stock.quantity"), formatQuantity(quantity, details.unit), quantity < 0 ? "warn" : ""),
			statCard(t("stock.value"), formatMoney(value, currency)),
			statCard(t("stock.unit_cost"), formatUnitCost(value, quantity, currency) || "-"),
			statCard(t("stock.minimum"), details.stock_minimum === null ? "-" : formatQuantity(details.stock_minimum, details.unit))
		),
		canEdit ? el("section", { class: "ledger-section" }, el("h3", {}, t("stock.item_settings")), settings) : null,
		first.levels.length > 1
			? el(
					"section",
					{ class: "ledger-section" },
					el("h3", {}, t("stock.by_warehouse")),
					table(
						[t("stock.warehouse"), numeric(t("stock.quantity")), numeric(t("stock.unit_cost")), numeric(t("stock.value"))],
						first.levels.map((level) =>
							el(
								"tr",
								{},
								el("td", {}, names.get(level.warehouse) ?? ""),
								el("td", { class: "num" }, formatQuantity(level.quantity, details.unit)),
								el("td", { class: "num" }, formatUnitCost(level.value, level.quantity, currency)),
								moneyCell(level.value, currency)
							)
						)
					)
				)
			: null,
		layered.length > 0
			? el(
					"section",
					{ class: "ledger-section" },
					el("h3", {}, t("stock.layers_title")),
					el("p", { class: "muted" }, t("stock.layers_hint")),
					table(
						[t("stock.warehouse"), numeric(t("stock.quantity")), numeric(t("stock.unit_cost")), numeric(t("stock.value"))],
						layered.flatMap((level) =>
							level.layers.map((layer) =>
								el(
									"tr",
									{},
									el("td", {}, names.get(level.warehouse) ?? ""),
									el("td", { class: "num" }, formatQuantity(layer.quantity, details.unit)),
									el("td", { class: "num" }, formatUnitCost(layer.value, layer.quantity, currency)),
									moneyCell(layer.value, currency)
								)
							)
						)
					)
				)
			: null,
		el(
			"section",
			{ class: "ledger-section" },
			el(
				"div",
				{ class: "ledger-section-head" },
				el("h3", {}, t("stock.card_title")),
				overview.warehouses.length > 1 ? field(t("stock.warehouse"), warehouseFilter) : null
			),
			movements
		)
	);
}

export async function inventoryValuationView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const overview = await InventoryApi.overview(uuid);
	const date = input("date", { value: toDateInput(Date.now(), project.timezone), max: toDateInput(Date.now(), project.timezone), required: true });
	const warehouse = warehouseSelect(overview.warehouses, "", true);
	const body = el("div", { class: "stack" });
	const render = async () => {
		if (!date.value) return;
		try {
			const report = await InventoryApi.valuation(uuid, date.value, warehouse.value || undefined);
			const total = report.goods + report.material;
			const rows = report.items.map((row) =>
				el(
					"tr",
					{},
					el("td", {}, el("a", { href: inventoryPath(uuid, `/items/${row.item}`) }, row.name), row.sku ? el("div", { class: "muted" }, row.sku) : null),
					el("td", {}, kindLabel(row.stock_kind)),
					el("td", { class: `num${row.quantity < 0 ? " warn" : ""}` }, formatQuantity(row.quantity, row.unit)),
					el("td", { class: "num" }, formatUnitCost(row.value, row.quantity, report.currency)),
					moneyCell(row.value, report.currency)
				)
			);
			const totalRow = (label: string, amount: number) =>
				el("tr", { class: "total-row" }, el("td", {}, label), el("td", {}), el("td", {}), el("td", {}), moneyCell(amount, report.currency, { strong: true }));
			replaceContent(
				body,
				el("p", { class: "muted" }, t("stock.valuation_method", { method: methodLabel(report.method) })),
				rows.length
					? table(
							[t("stock.item"), t("stock.kind"), numeric(t("stock.quantity")), numeric(t("stock.unit_cost")), numeric(t("stock.value"))],
							[
								...rows,
								report.goods !== 0 && report.material !== 0 ? totalRow(t("stock.stat_goods"), report.goods) : null,
								report.goods !== 0 && report.material !== 0 ? totalRow(t("stock.stat_material"), report.material) : null,
								totalRow(t("stock.total"), total),
							].filter((row): row is HTMLTableRowElement => row !== null)
						)
					: emptyState(t("stock.valuation_empty"))
			);
		} catch (error) {
			reportError(error);
		}
	};
	date.addEventListener("change", () => void render());
	warehouse.addEventListener("change", () => void render());
	await render();

	const download = el(
		"button",
		{
			class: "button ghost",
			type: "button",
			onClick: async () => {
				try {
					const file = await InventoryApi.valuationCsv(uuid, date.value, warehouse.value || undefined);
					saveFile(file.blob, file.name);
				} catch (error) {
					reportError(error);
				}
			},
		},
		t("stock.download_csv")
	);
	const print = el("button", { class: "button ghost", type: "button", onClick: () => window.print() }, t("stock.print"));

	return inventoryPage(
		project,
		"valuation",
		{ title: t("stock.valuation_title"), intro: t("stock.valuation_intro"), actions: [download, print] },
		el("div", { class: "ledger-controls" }, field(t("stock.on_date"), date), overview.warehouses.length > 1 ? field(t("stock.warehouse"), warehouse) : null),
		body
	);
}

function warehouseDialog(project: Project, warehouse: Warehouse | null, onSaved: () => void) {
	const name = input("text", { maxlength: "200", required: true, value: warehouse?.name ?? "" });
	const code = input("text", { maxlength: "16", required: true, value: warehouse?.code ?? "" });
	const address = input("text", { maxlength: "255", value: warehouse?.address ?? "" });
	const submit = el("button", { class: "button primary", type: "submit" }, t("ui.save"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				const data = { name: name.value.trim(), code: code.value.trim(), address: address.value.trim() || null };
				try {
					if (warehouse) await InventoryApi.updateWarehouse(project.uuid, warehouse.uuid, data);
					else await InventoryApi.createWarehouse(project.uuid, data);
					dialog.close();
					onSaved();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("div", { class: "grid" }, field(t("stock.warehouse_name"), name), field(t("stock.warehouse_code"), code, t("stock.warehouse_code_hint"))),
		field(t("stock.warehouse_address"), address),
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(warehouse ? t("stock.warehouse_edit") : t("stock.warehouse_new"), form, undefined, "dialog-medium");
	name.focus();
}

export async function inventorySettingsView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid, true);
	const canEdit = project.inventory && can(project, Permission.PROJECT_EDIT);
	const body = el("div", { class: "stack" });

	const render = async () => {
		const overview = await InventoryApi.overview(uuid);
		const settings = overview.settings;
		const year = Number(toDateInput(Date.now(), project.timezone).slice(0, 4));
		const method = select(
			[
				{ value: "average", label: t("stock.method_average") },
				{ value: "fifo", label: t("stock.method_fifo") },
			],
			settings.method
		);
		const from = select(
			[year, year + 1].map((value) => ({ value: `${value}-01-01`, label: t("stock.method_from_year", { year: value }) })),
			`${year}-01-01`
		);
		const fromField = field(t("stock.method_from"), from);
		fromField.hidden = true;
		method.addEventListener("change", () => (fromField.hidden = !settings.has_movements || method.value === settings.method));
		const negative = input("checkbox");
		negative.checked = settings.negative_stock;
		const save = el("button", { class: "button primary", type: "submit" }, t("ui.save"));
		const terminal = select(
			[
				{ value: "", label: t("stock.terminal_default") },
				...overview.warehouses
					.filter((warehouse) => !warehouse.archived && !warehouse.is_default)
					.map((warehouse) => ({ value: warehouse.uuid, label: `${warehouse.code} ${warehouse.name}` })),
			],
			settings.pos_warehouse ?? ""
		);
		method.disabled = from.disabled = negative.disabled = terminal.disabled = !canEdit;

		const form = el(
			"form",
			{
				class: "stack",
				onSubmit: async (event) => {
					event.preventDefault();
					const changesMethod = method.value !== settings.method;
					if (
						changesMethod &&
						settings.has_movements &&
						!(await confirmDialog({ title: t("stock.method_confirm_title"), body: t("stock.method_confirm_body"), confirmLabel: t("stock.method_confirm") }))
					)
						return;
					save.disabled = true;
					try {
						await InventoryApi.saveSettings(uuid, {
							negative_stock: negative.checked,
							pos_warehouse: terminal.value || null,
							...(changesMethod ? { method: method.value as ValuationMethod, from: from.value } : {}),
						});
						toast(t("stock.settings_saved"), "success");
						await render();
					} catch (error) {
						reportError(error);
						save.disabled = false;
					}
				},
			},
			el("div", { class: "ledger-controls" }, field(t("stock.method"), method, t("stock.method_hint")), fromField),
			settings.methods.length > 1
				? el(
						"p",
						{ class: "muted" },
						t("stock.method_history", {
							history: settings.methods
								.map((period, index) => (index === 0 ? methodLabel(period.method) : `${methodLabel(period.method)} (${period.from.slice(0, 4)})`))
								.join(" → "),
						})
					)
				: null,
			el("label", { class: "switch" }, negative, el("span", {}, t("stock.negative_allowed"))),
			el("p", { class: "muted" }, t("stock.negative_hint")),
			overview.warehouses.filter((warehouse) => !warehouse.archived).length > 1
				? el("div", { class: "ledger-controls" }, field(t("stock.terminal_warehouse"), terminal, t("stock.terminal_warehouse_hint")))
				: null,
			canEdit ? el("div", { class: "form-actions" }, save) : null
		);

		const warehouseRows = overview.warehouses.map((warehouse) =>
			el(
				"tr",
				{ class: warehouse.archived ? "muted" : "" },
				el("td", { class: "code" }, warehouse.code),
				el("td", {}, warehouse.name, warehouse.address ? el("div", { class: "muted" }, warehouse.address) : null),
				el(
					"td",
					{},
					warehouse.is_default ? el("span", { class: "pill pill-active" }, t("stock.warehouse_default")) : null,
					warehouse.archived ? el("span", { class: "pill" }, t("stock.warehouse_archived")) : null
				),
				el(
					"td",
					{ class: "actions" },
					canEdit
						? el(
								"button",
								{ class: "button ghost small", type: "button", onClick: () => warehouseDialog(project, warehouse, () => void render()) },
								t("ui.edit")
							)
						: null,
					canEdit && !warehouse.is_default && !warehouse.archived
						? el(
								"button",
								{
									class: "button ghost small",
									type: "button",
									onClick: async () => {
										try {
											await InventoryApi.updateWarehouse(uuid, warehouse.uuid, { is_default: true });
											await render();
										} catch (error) {
											reportError(error);
										}
									},
								},
								t("stock.warehouse_make_default")
							)
						: null,
					canEdit && !warehouse.is_default
						? el(
								"button",
								{
									class: "button ghost small",
									type: "button",
									onClick: async () => {
										try {
											await InventoryApi.updateWarehouse(uuid, warehouse.uuid, { archived: !warehouse.archived });
											await render();
										} catch (error) {
											reportError(error);
										}
									},
								},
								warehouse.archived ? t("stock.warehouse_restore") : t("stock.warehouse_archive")
							)
						: null
				)
			)
		);

		replaceContent(
			body,
			el("section", { class: "ledger-section" }, el("h3", {}, t("stock.settings_valuation")), form),
			el(
				"section",
				{ class: "ledger-section" },
				el(
					"div",
					{ class: "ledger-section-head" },
					el("h3", {}, t("stock.warehouses")),
					canEdit
						? el(
								"button",
								{ class: "button ghost small", type: "button", onClick: () => warehouseDialog(project, null, () => void render()) },
								t("stock.warehouse_new")
							)
						: null
				),
				el("p", { class: "muted" }, t("stock.warehouses_hint")),
				warehouseRows.length ? table([t("stock.warehouse_code"), t("stock.warehouse_name"), "", ""], warehouseRows) : emptyState(t("stock.warehouses_empty"))
			),
			overview.ledger.length > 0
				? el(
						"section",
						{ class: "ledger-section" },
						el("h3", {}, t("stock.ledger_title")),
						el("p", { class: "muted" }, t("stock.ledger_hint")),
						table(
							[t("stock.ledger_account"), numeric(t("stock.ledger_balance")), numeric(t("stock.ledger_stock")), numeric(t("stock.ledger_difference"))],
							overview.ledger.map((row) =>
								el(
									"tr",
									{},
									el("td", {}, `${row.code} ${row.name}`),
									moneyCell(row.ledger, overview.currency),
									moneyCell(row.stock, overview.currency),
									moneyCell(row.difference, overview.currency, { warn: row.difference !== 0 })
								)
							)
						)
					)
				: null
		);
	};
	await render();

	return inventoryPage(project, "settings", { title: t("stock.settings_title"), intro: t("stock.settings_intro") }, licenseNotice(project), body);
}

export function shortDate(date: string, project: Project): string {
	const [year, month, day] = date.split("-").map(Number);
	return formatDate(new Date(year, month - 1, day, 12).getTime(), project.date_format as DateFormat);
}
