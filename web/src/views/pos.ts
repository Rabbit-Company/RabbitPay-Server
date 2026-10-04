import { pagination, PAGE_SIZE } from "../pagination";
import { toSVG } from "@rabbit-company/qrcode";
import { Api, ApiError, getEmail, getUsername, type CatalogItem, type Invoice } from "../api";
import { el, input, statusPill, table } from "../dom";
import { formatMoney, formatTime, minorUnitDigits, toMajorUnits, toMinorUnits } from "../money";
import { accountName, confirmDialog, modal, reportError, toast } from "../ui";
import { loadProject } from "./project";
import { convertAmount, currencyOptions, currencyRates } from "../currencies";
import { staticCombobox } from "../combobox";
import { onLeave } from "../router";
import { applyAccent } from "../theme";
import { can, Permission, sellsOnly } from "../access";
import { signOut } from "../session";
import type { TimeFormat } from "../../../server/formats";
import { calculateTotals, outstandingOf, taxIncluded } from "../../../server/invoicing";
import { filterOptions } from "../../../server/option-search";
import { STANDARD_RATES, suggestTax, type SellerTax, type SupplyType, type TaxCategory } from "../../../server/tax";
import { statusLabel, t, tn } from "../i18n";
import {
	addLine,
	changeFor,
	changeQuantity,
	grossOf,
	isCartLine,
	itemQuantity,
	keypadAmount,
	lineCount,
	pressKey,
	quickCashAmounts,
	toSaleLines,
	toTotalsInput,
	unitGross,
	type CartLine,
	type KeypadKey,
} from "../../../server/pos-cart";

const POLL_INTERVAL = 3000;
const KEYPAD_KEYS: KeypadKey[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "back"];
const CLOSED_STATUSES = ["canceled", "refunded", "draft"];
const UNPAID_STATUSES = ["open", "overdue", "partially_paid"];

interface SavedSale {
	currency: string;
	lines: CartLine[];
	invoice: string | null;
	fromCart: boolean;
}

function storageKey(uuid: string): string {
	return `rabbitpay.pos.${uuid}`;
}

function loadSale(uuid: string): SavedSale | null {
	try {
		const raw = localStorage.getItem(storageKey(uuid));
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (typeof parsed?.currency !== "string" || !Array.isArray(parsed.lines)) return null;
		return {
			currency: parsed.currency,
			lines: parsed.lines.map((line: Record<string, unknown>) => ({ gross: null, ...line })).filter(isCartLine),
			invoice: typeof parsed.invoice === "string" ? parsed.invoice : null,
			fromCart: parsed.fromCart !== false,
		};
	} catch {
		return null;
	}
}

function saveSale(uuid: string, sale: SavedSale) {
	try {
		if (sale.lines.length === 0 && sale.invoice === null) localStorage.removeItem(storageKey(uuid));
		else localStorage.setItem(storageKey(uuid), JSON.stringify(sale));
	} catch {
		void 0;
	}
}

function payLinkFor(invoiceId: string): string {
	return `${window.location.origin}/pay/${invoiceId}`;
}

function qrCode(link: string): HTMLElement {
	const box = el("div", { class: "qr" });
	try {
		box.innerHTML = toSVG(link, { scale: 6, margin: 2 });
	} catch {
		box.hidden = true;
	}
	return box;
}

function keepScreenAwake(): () => void {
	let sentinel: WakeLockSentinel | null = null;
	let active = true;

	const request = async () => {
		if (!active || document.visibilityState !== "visible" || !("wakeLock" in navigator)) return;
		try {
			const acquired = await navigator.wakeLock.request("screen");
			if (active) sentinel = acquired;
			else void acquired.release();
		} catch {
			sentinel = null;
		}
	};

	const onVisibility = () => void request();
	document.addEventListener("visibilitychange", onVisibility);
	void request();

	return () => {
		active = false;
		document.removeEventListener("visibilitychange", onVisibility);
		void sentinel?.release().catch(() => undefined);
		sentinel = null;
	};
}

function fullscreenToggle(): { element: HTMLElement | null; dispose: () => void } {
	if (!document.fullscreenEnabled) return { element: null, dispose: () => undefined };

	const button = el("button", { class: "button ghost small", type: "button" });
	const sync = () => {
		button.textContent = document.fullscreenElement ? t("pos.exit_fullscreen") : t("pos.fullscreen");
	};

	button.addEventListener("click", () => {
		if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
		else void document.documentElement.requestFullscreen().catch(() => undefined);
	});
	document.addEventListener("fullscreenchange", sync);
	sync();

	return {
		element: button,
		dispose: () => {
			document.removeEventListener("fullscreenchange", sync);
			if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
		},
	};
}

function totalsRow(label: string, amount: string, className = "totals-row"): HTMLElement {
	return el("div", { class: className }, el("span", {}, label), el("span", { class: "mono" }, amount));
}

export async function posView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid, true);
	applyAccent(project.accent_color);
	const cashierOnly = sellsOnly(project);
	const customAllowed = project.pos_custom_amounts || can(project, Permission.INVOICE_CREATE);
	const timeFormat = project.time_format as TimeFormat;

	const [known, catalog] = await Promise.all([currencyRates(), Api.allItems(uuid).catch(() => [] as CatalogItem[])]);

	const saved = loadSale(uuid);
	const seller: SellerTax = { country: project.tax_country, vatStatus: project.vat_status, ossRegistered: project.oss_registered };
	const customRate = seller.vatStatus === "registered" && project.tax_country ? (STANDARD_RATES[project.tax_country] ?? 0) : 0;
	const itemsById = new Map(catalog.map((item) => [item.uuid, item]));
	const itemOptions = catalog.map((item) => ({ value: item.uuid, label: item.name, keywords: [item.sku, item.description].filter(Boolean).join(" ") }));

	let currency = saved?.currency ?? project.currency;
	let lines: CartLine[] = (saved?.lines ?? []).filter((line) => customAllowed || line.item !== null);
	let invoiceId: string | null = saved?.invoice ?? null;
	let fromCart = saved?.fromCart ?? true;
	let entry = "";
	let tab: "items" | "keypad" = catalog.length > 0 || !customAllowed ? "items" : "keypad";
	let sequence = 0;
	let busy = false;
	let resuming = false;
	let poller: ReturnType<typeof setTimeout> | undefined;
	let shownState = "";
	let paidShown = false;
	let lastChange = 0;

	const persist = () => saveSale(uuid, { currency, lines, invoice: invoiceId, fromCart });
	const nextKey = () => `${Date.now().toString(36)}-${++sequence}`;

	const taxFor = (supplyType: SupplyType, category: TaxCategory, rate: number) => {
		const suggestion = suggestTax(seller, null, { supplyType, category, rate });
		return { taxRate: suggestion.rate, treatment: suggestion.treatment };
	};

	const priceIn = (item: CatalogItem): number | null => {
		if (item.currency === currency) return item.unit_price;
		if (!known.live) return null;
		const converted = convertAmount(toMajorUnits(item.unit_price, item.currency), item.currency, currency, known.rates);
		return converted === null ? null : toMinorUnits(converted, currency);
	};

	const cartTotals = () => calculateTotals(toTotalsInput(lines), 0);

	const screen = el("div", { class: "pos-screen" });
	const overlay = el("div", { class: "pos-overlay" });
	overlay.hidden = true;

	const currencyChoices = currencyOptions(known.currencies, project.currency, false);
	const currencyPicker = staticCombobox(currencyChoices, currency, { required: true, class: "pos-currency", emptyText: t("currency.no_match") });
	currencyPicker.onChange((option) => {
		if (!option || option.value === currency) return;
		currency = option.value;
		entry = "";
		persist();
		renderAll();
	});

	const fullscreen = fullscreenToggle();

	const leave = cashierOnly
		? el("button", { class: "button ghost small", type: "button", onClick: () => void signOut() }, t("app.sign_out"))
		: el("a", { class: "button ghost small", href: `/projects/${uuid}` }, t("pos.exit"));

	const topBar = el(
		"header",
		{ class: "pos-bar" },
		leave,
		el("div", { class: "pos-bar-title" }, el("strong", {}, project.public_name), cashierOnly ? el("span", { class: "muted" }, ` ${getEmail() ?? ""}`) : null),
		el(
			"div",
			{ class: "pos-bar-actions" },
			el("button", { class: "button ghost small", type: "button", onClick: () => void salesToday() }, t("pos.today")),
			currencyPicker.element,
			fullscreen.element
		)
	);

	const itemsTab = el("button", { class: "pos-tab", type: "button", onClick: () => switchTab("items") }, t("nav.items"));
	const keypadTab = el("button", { class: "pos-tab", type: "button", onClick: () => switchTab("keypad") }, t("pos.keypad"));

	const search = input("search", { placeholder: t("pos.search_placeholder"), autocomplete: "off" });
	const grid = el("div", { class: "pos-grid" });
	const catalogPages = pagination(() => renderItems());
	const itemsPanel = el("div", { class: "pos-items" }, search, grid, catalogPages.element);

	const keypadDisplay = el("div", { class: "pos-display mono" });
	const note = input("text", { placeholder: t("pos.note_placeholder"), maxlength: "200" });
	const addCustomButton = el("button", { class: "button primary pos-add", type: "button", onClick: () => addCustom() }, t("pos.add_to_sale"));
	const keys = el(
		"div",
		{ class: "pos-keys" },
		...KEYPAD_KEYS.map((key) =>
			el(
				"button",
				{
					class: `pos-key${key === "back" ? " pos-key-muted" : ""}`,
					type: "button",
					title: key === "back" ? t("pos.delete_digit") : undefined,
					onClick: () => press(key),
				},
				key === "back" ? t("pos.del") : key
			)
		)
	);
	const keypadPanel = el(
		"div",
		{ class: "pos-keypad" },
		el(
			"div",
			{ class: "pos-display-row" },
			keypadDisplay,
			el("button", { class: "button ghost small", type: "button", onClick: () => press("clear") }, t("pos.clear"))
		),
		note,
		keys,
		addCustomButton
	);

	const tabs = el("div", { class: "pos-tabs" }, itemsTab, keypadTab);
	tabs.hidden = !customAllowed;
	const catalogSide = el("section", { class: "pos-catalog" }, tabs, itemsPanel, keypadPanel);

	const cartLines = el("div", { class: "pos-lines" });
	const cartTotalsBox = el("div", { class: "totals pos-totals" });
	const chargeButton = el("button", { class: "button primary pos-charge-button", type: "button", onClick: () => void charge() });
	const clearButton = el("button", { class: "button ghost small", type: "button", onClick: () => void clearSale() }, t("pos.clear"));
	const backButton = el(
		"button",
		{ class: "button ghost small pos-only-narrow", type: "button", onClick: () => screen.classList.remove("show-cart") },
		t("pos.add_more")
	);

	const cartSide = el(
		"section",
		{ class: "pos-cart" },
		el("div", { class: "pos-cart-head" }, backButton, el("h2", {}, t("pos.current_sale")), clearButton),
		cartLines,
		cartTotalsBox,
		chargeButton
	);

	const cartToggle = el("button", { class: "button primary pos-cart-toggle", type: "button", onClick: () => screen.classList.add("show-cart") });

	screen.append(topBar, el("div", { class: "pos-body" }, catalogSide, cartSide), cartToggle, overlay);

	const itemTaxRate = (item: CatalogItem) => taxFor(item.supply_type as SupplyType, item.tax_category as TaxCategory, item.tax_rate).taxRate;

	const itemTile = (item: CatalogItem): HTMLElement => {
		const price = priceIn(item);
		const count = itemQuantity(lines, item.uuid);
		const shownPrice = price === null ? formatMoney(item.unit_price, item.currency) : formatMoney(grossOf(price, itemTaxRate(item)), currency);
		return el(
			"button",
			{
				class: "pos-tile",
				type: "button",
				disabled: price === null,
				title: price === null ? t("pos.no_rate", { from: item.currency, to: currency }) : undefined,
				onClick: () => addItem(item),
			},
			el("span", { class: "pos-tile-name" }, item.name),
			el("span", { class: "pos-tile-price mono" }, shownPrice),
			count > 0 ? el("span", { class: "pos-tile-count" }, String(count)) : null
		);
	};

	const matchingItems = (): CatalogItem[] => {
		const query = search.value.trim();
		if (!query) return catalog;
		return filterOptions(itemOptions, query, catalog.length).map((option) => itemsById.get(option.value)!);
	};

	const renderItems = () => {
		if (catalog.length === 0) {
			const canManage = can(project, Permission.ITEM_CREATE);
			grid.replaceChildren(
				el(
					"div",
					{ class: "pos-empty" },
					el("p", {}, "No saved items yet."),
					el("p", { class: "muted" }, canManage ? (customAllowed ? t("pos.no_items_manage_keypad") : t("pos.no_items_manage")) : t("pos.no_items_ask")),
					canManage ? el("a", { class: "button ghost", href: `/projects/${uuid}/items` }, "Manage items") : null
				)
			);
			return;
		}

		const matches = matchingItems();
		catalogPages.update(matches.length);
		const shown = matches.slice(catalogPages.state.offset, catalogPages.state.offset + PAGE_SIZE);
		grid.replaceChildren(...(shown.length > 0 ? shown.map(itemTile) : [el("p", { class: "muted pos-empty" }, "No item matches.")]));
	};

	const renderKeypad = () => {
		const amount = keypadAmount(entry);
		keypadDisplay.textContent = formatMoney(amount, currency);
		addCustomButton.disabled = amount === 0;
		addCustomButton.textContent = amount === 0 ? t("pos.add_to_sale") : t("pos.add_amount", { amount: formatMoney(amount, currency) });
	};

	const renderTabs = () => {
		itemsTab.classList.toggle("active", tab === "items");
		keypadTab.classList.toggle("active", tab === "keypad");
		itemsPanel.hidden = tab !== "items";
		keypadPanel.hidden = tab !== "keypad";
	};

	const renderCart = () => {
		const totals = cartTotals();
		const count = lineCount(lines);

		cartLines.replaceChildren(
			...(lines.length === 0
				? [el("p", { class: "muted pos-empty" }, customAllowed ? "Tap an item or use the keypad to start a sale." : "Tap an item to start a sale.")]
				: lines.map((line, index) => {
						const calculated = totals.items[index];
						return el(
							"div",
							{ class: "pos-line" },
							el(
								"div",
								{ class: "pos-line-text" },
								el("span", {}, line.description),
								el("span", { class: "muted mono" }, `${line.quantity} x ${formatMoney(unitGross(line), currency)}`)
							),
							el(
								"div",
								{ class: "pos-qty" },
								el("button", { class: "pos-qty-button", type: "button", title: "One less", onClick: () => updateQuantity(line.key, -1) }, "-"),
								el("span", { class: "mono" }, String(line.quantity)),
								el("button", { class: "pos-qty-button", type: "button", title: "One more", onClick: () => updateQuantity(line.key, 1) }, "+")
							),
							el("span", { class: "pos-line-total mono" }, formatMoney(calculated.total_price + calculated.tax_amount, currency))
						);
					}))
		);

		cartTotalsBox.replaceChildren(
			...(totals.tax_amount > 0
				? [
						totalsRow(t("stats.column_net"), formatMoney(totals.subtotal, currency)),
						totalsRow(t("customers.column_vat"), formatMoney(totals.tax_amount, currency)),
					]
				: []),
			totalsRow(t("editor.total"), formatMoney(totals.total_amount, currency), "totals-row grand")
		);

		chargeButton.textContent = lines.length === 0 ? t("pos.charge") : t("pos.charge_amount", { amount: formatMoney(totals.total_amount, currency) });
		chargeButton.disabled = lines.length === 0 || busy || resuming;
		clearButton.hidden = lines.length === 0;
		cartToggle.disabled = lines.length === 0;
		cartToggle.textContent =
			lines.length === 0 ? t("pos.no_items_yet") : t("pos.view_sale", { items: tn("count.items", count), amount: formatMoney(totals.total_amount, currency) });
		currencyPicker.input.disabled = lines.length > 0;
		currencyPicker.input.title = lines.length > 0 ? t("pos.clear_to_change_currency") : "";
		if (lines.length === 0) screen.classList.remove("show-cart");
	};

	const renderAll = () => {
		renderTabs();
		renderItems();
		renderKeypad();
		renderCart();
	};

	const changed = () => {
		persist();
		renderItems();
		renderCart();
	};

	const switchTab = (next: "items" | "keypad") => {
		tab = next;
		renderTabs();
		if (next === "items") search.focus();
	};

	const press = (key: KeypadKey) => {
		entry = pressKey(entry, key);
		renderKeypad();
	};

	const addItem = (item: CatalogItem) => {
		const price = priceIn(item);
		if (price === null) {
			toast(t("pos.item_no_rate", { item: item.name, from: item.currency, to: currency }), "error");
			return;
		}
		const tax = taxFor(item.supply_type as SupplyType, item.tax_category as TaxCategory, item.tax_rate);
		lines = addLine(lines, { item: item.uuid, description: item.name, unitPrice: price, gross: null, ...tax }, nextKey());
		changed();
	};

	const addCustom = () => {
		if (!customAllowed) return;
		const amount = keypadAmount(entry);
		if (amount === 0) {
			toast(t("pos.type_amount"), "error");
			return;
		}
		const tax = taxFor("goods", "standard", customRate);
		const unitPrice = amount - taxIncluded(amount, tax.taxRate);
		lines = addLine(lines, { item: null, description: note.value.trim() || t("pos.custom_amount"), unitPrice, gross: amount, ...tax }, nextKey());
		entry = "";
		note.value = "";
		renderKeypad();
		changed();
	};

	const updateQuantity = (key: string, delta: number) => {
		lines = changeQuantity(lines, key, delta);
		changed();
	};

	const clearSale = async () => {
		if (lines.length === 0) return;
		const confirmed = await confirmDialog({
			title: t("pos.clear_sale"),
			body: t("pos.clear_sale_body"),
			confirmLabel: t("pos.clear"),
			destructive: true,
		});
		if (!confirmed) return;
		lines = [];
		changed();
	};

	const stopWatching = () => {
		clearTimeout(poller);
		poller = undefined;
	};

	const closeOverlay = () => {
		stopWatching();
		overlay.hidden = true;
		overlay.replaceChildren();
		shownState = "";
		paidShown = false;
	};

	const newSale = () => {
		closeOverlay();
		lastChange = 0;
		screen.classList.remove("show-cart");
		renderAll();
		if (tab === "items") search.focus();
	};

	const backToCart = (message?: string) => {
		invoiceId = null;
		fromCart = true;
		persist();
		closeOverlay();
		renderAll();
		if (message) toast(message, "info");
	};

	const watch = (id: string) => {
		stopWatching();
		poller = setTimeout(async () => {
			try {
				const latest = await Api.sale(uuid, id);
				if (invoiceId === id) showSale(latest);
			} catch {
				if (invoiceId === id) watch(id);
			}
		}, POLL_INTERVAL);
	};

	const showSale = (invoice: Invoice) => {
		if (resuming) {
			resuming = false;
			renderCart();
		}
		if (invoice.status === "paid") {
			showPaid(invoice);
			return;
		}
		if (CLOSED_STATUSES.includes(invoice.status)) {
			backToCart(t("pos.sale_closed", { reference: invoice.reference, status: statusLabel(invoice.status) }));
			return;
		}

		const state = `${invoice.status}:${invoice.paid_amount}:${invoice.refunded_amount}:${invoice.credited_amount}`;
		if (state !== shownState) {
			shownState = state;
			showCharge(invoice);
		}
		watch(invoice.uuid);
	};

	const cancelSale = async (invoice: Invoice) => {
		const received = invoice.paid_amount - invoice.refunded_amount;
		if (invoice.paid_amount > 0 && !can(project, Permission.INVOICE_EDIT)) {
			toast(t("pos.partly_paid"), "error");
			return;
		}
		const keepsItems = fromCart ? ` ${t("pos.cancel_keeps_items")}` : "";
		const confirmed = await confirmDialog({
			title: t("pos.cancel_sale"),
			body:
				received > 0
					? t("pos.cancel_received", { amount: formatMoney(received, invoice.currency) })
					: `${t("pos.cancel_body", { reference: invoice.reference })}${keepsItems}`,
			confirmLabel: t("pos.cancel_sale"),
			destructive: true,
		});
		if (!confirmed) return;

		try {
			stopWatching();
			await Api.cancelSale(uuid, invoice.uuid, t("pos.cancel_reason"));
			backToCart();
			toast(t("pos.canceled_toast", { reference: invoice.reference }), "success");
		} catch (error) {
			reportError(error);
			watch(invoice.uuid);
		}
	};

	const cashDialog = (invoice: Invoice) => {
		const due = outstandingOf(invoice);
		const digits = minorUnitDigits(invoice.currency);
		const unit = Math.pow(10, digits);
		const tendered = input("number", { min: "0", step: digits === 0 ? "1" : String(1 / unit), value: String(toMajorUnits(due, invoice.currency)) });
		tendered.setAttribute("inputmode", "decimal");
		const summary = el("p", { class: "pos-change" });
		const submit = el("button", { class: "button primary pos-add", type: "submit" });

		const given = () => Math.round((Number(tendered.value) || 0) * unit);

		const refresh = () => {
			const amount = given();
			summary.classList.toggle("warn", amount < due);
			if (amount <= 0) {
				summary.textContent = t("pos.enter_tendered");
				submit.textContent = t("pos.record_cash");
				submit.disabled = true;
				return;
			}
			submit.disabled = false;
			if (amount < due) {
				summary.textContent = t("pos.still_to_pay", { amount: formatMoney(due - amount, invoice.currency) });
				submit.textContent = t("pos.record_partial", { amount: formatMoney(amount, invoice.currency) });
				return;
			}
			summary.textContent = t("pos.change_to_give", { amount: formatMoney(changeFor(amount, due), invoice.currency) });
			submit.textContent = t("pos.record_cash_payment");
		};

		const quick = el(
			"div",
			{ class: "pos-quick-cash" },
			...quickCashAmounts(due, unit).map((amount) =>
				el(
					"button",
					{
						class: "button ghost",
						type: "button",
						onClick: () => {
							tendered.value = String(toMajorUnits(amount, invoice.currency));
							refresh();
						},
					},
					amount === due ? t("pos.exact") : formatMoney(amount, invoice.currency)
				)
			)
		);

		tendered.addEventListener("input", refresh);

		const form = el(
			"form",
			{
				class: "stack",
				onSubmit: async (event) => {
					event.preventDefault();
					const amount = given();
					if (amount <= 0) return;
					const recorded = Math.min(amount, due);
					const change = changeFor(amount, due);
					submit.disabled = true;

					try {
						stopWatching();
						const updated = await Api.saleCash(uuid, invoice.uuid, { amount: recorded, tendered: amount });
						lastChange = change;
						dialog.close();
						showSale(updated);
					} catch (error) {
						reportError(error);
						submit.disabled = false;
						watch(invoice.uuid);
					}
				},
			},
			el("p", { class: "muted" }, t("pos.to_pay_amount", { amount: formatMoney(due, invoice.currency) })),
			quick,
			el("label", { class: "field" }, el("span", { class: "field-label" }, t("pos.cash_received")), tendered),
			summary,
			submit
		);

		const dialog = modal(t("pos.cash_payment"), form);
		refresh();
		tendered.focus();
		tendered.select();
	};

	const showCharge = (invoice: Invoice) => {
		const link = payLinkFor(invoice.uuid);
		const due = outstandingOf(invoice);
		const received = invoice.paid_amount - invoice.refunded_amount;
		paidShown = false;

		const copy = async () => {
			try {
				await navigator.clipboard.writeText(link);
				toast(t("pos.link_copied"), "success");
			} catch {
				toast(t("pos.link_copy_failed"), "error");
			}
		};

		overlay.replaceChildren(
			el(
				"div",
				{ class: "pos-charge" },
				el(
					"section",
					{ class: "pos-charge-summary" },
					el("p", { class: "muted" }, project.public_name),
					el("p", { class: "pos-due-label" }, received > 0 ? t("pos.left_to_pay") : t("pos.to_pay")),
					el("p", { class: "pos-total mono" }, formatMoney(due, invoice.currency)),
					received > 0
						? el(
								"p",
								{ class: "muted" },
								t("pos.received_of", { received: formatMoney(received, invoice.currency), total: formatMoney(invoice.total_amount, invoice.currency) })
							)
						: null,
					el(
						"div",
						{ class: "pos-receipt-lines" },
						...(invoice.items ?? []).map((item) =>
							el(
								"div",
								{ class: "totals-row" },
								el("span", {}, `${item.quantity} x ${item.description}`),
								el("span", { class: "mono" }, formatMoney(item.total_price + item.tax_amount, invoice.currency))
							)
						)
					),
					el(
						"div",
						{ class: "totals" },
						invoice.tax_amount > 0 ? totalsRow(t("pos.includes_vat"), formatMoney(invoice.tax_amount, invoice.currency)) : null,
						totalsRow(t("editor.total"), formatMoney(invoice.total_amount, invoice.currency), "totals-row grand")
					)
				),
				el(
					"section",
					{ class: "pos-charge-pay" },
					el("h2", {}, t("pos.scan_to_pay")),
					qrCode(link),
					el("p", { class: "muted" }, t("pos.scan_hint")),
					el("p", { class: "pos-waiting" }, el("span", { class: "pos-pulse" }), t("pos.waiting")),
					el("p", { class: "muted mono" }, invoice.reference)
				),
				el(
					"footer",
					{ class: "pos-charge-actions" },
					el("button", { class: "button danger", type: "button", onClick: () => void cancelSale(invoice) }, t("pos.cancel_sale")),
					el("button", { class: "button ghost", type: "button", onClick: () => void copy() }, t("pos.copy_link")),
					el("button", { class: "button primary pos-cash", type: "button", onClick: () => cashDialog(invoice) }, t("pos.paid_in_cash"))
				)
			)
		);
		overlay.hidden = false;
	};

	const receiptForm = (sale: Invoice): HTMLElement | null => {
		if (!project.email_enabled) return null;

		const address = input("email", { placeholder: t("pos.receipt_placeholder"), required: true, autocomplete: "off" });
		const send = el("button", { class: "button ghost", type: "submit" }, t("pos.email_receipt"));
		const status = el("p", { class: "muted" });
		status.hidden = true;

		return el(
			"form",
			{
				class: "pos-receipt-email",
				onSubmit: async (event) => {
					event.preventDefault();
					send.disabled = true;
					try {
						const sent = await Api.emailReceipt(uuid, sale.uuid, address.value.trim());
						status.textContent = sent.status === "sent" ? t("pos.receipt_sent", { to: sent.recipient }) : t("pos.receipt_sending", { to: sent.recipient });
						status.hidden = false;
						address.value = "";
					} catch (error) {
						reportError(error);
					} finally {
						send.disabled = false;
					}
				},
			},
			el("div", { class: "pos-receipt-email-row" }, address, send),
			status
		);
	};

	const showPaid = (invoice: Invoice) => {
		stopWatching();
		if (fromCart) lines = [];
		invoiceId = null;
		fromCart = true;
		persist();
		paidShown = true;
		shownState = "";

		overlay.replaceChildren(
			el(
				"div",
				{ class: "pos-done" },
				el("div", { class: "pos-done-mark" }, t("pos.paid")),
				el("p", { class: "pos-total mono" }, formatMoney(invoice.total_amount, invoice.currency)),
				lastChange > 0 ? el("p", { class: "pos-change-due" }, t("pos.give_back", { amount: formatMoney(lastChange, invoice.currency) })) : null,
				el("p", { class: "muted mono" }, invoice.reference),
				el("div", { class: "pos-receipt" }, qrCode(payLinkFor(invoice.uuid)), el("p", { class: "muted" }, t("pos.scan_receipt"))),
				receiptForm(invoice),
				el(
					"div",
					{ class: "pos-done-actions" },
					el("a", { class: "button ghost", href: `/projects/${uuid}/pos/sales/${invoice.uuid}/print` }, t("pos.print_receipt")),
					el("button", { class: "button primary pos-add", type: "button", onClick: () => newSale() }, t("pos.new_sale"))
				)
			)
		);
		overlay.hidden = false;
	};

	const charge = async () => {
		if (lines.length === 0 || busy) return;
		busy = true;
		renderCart();

		try {
			const sale = await Api.createSale(uuid, { currency, lines: toSaleLines(lines) });
			invoiceId = sale.uuid;
			fromCart = true;
			persist();
			lastChange = 0;
			showSale(sale);
		} catch (error) {
			reportError(error);
		} finally {
			busy = false;
			renderCart();
		}
	};

	const resumeSale = (sale: Invoice) => {
		invoiceId = sale.uuid;
		fromCart = false;
		lastChange = 0;
		persist();
		showSale(sale);
	};

	const dayFigure = (label: string, value: string) => el("div", {}, el("span", { class: "muted" }, label), el("strong", { class: "mono" }, value));

	const salesToday = async () => {
		const scope = el("select", {});
		scope.append(el("option", { value: "mine" }, t("pos.my_sales")), el("option", { value: "all" }, t("pos.everyone")));
		const body = el("div", { class: "stack" }, el("p", { class: "muted" }, t("ui.loading")));

		const saleAction = (sale: Invoice): HTMLElement => {
			const mayTakeOver = sale.created_by === getUsername() || can(project, Permission.PAYMENT_CREATE);
			if (!UNPAID_STATUSES.includes(sale.status) || !mayTakeOver) {
				return el("a", { class: "button ghost small", href: `/projects/${uuid}/pos/sales/${sale.uuid}/print` }, t("pos.receipt"));
			}

			return el(
				"button",
				{
					class: "button ghost small",
					type: "button",
					onClick: async () => {
						try {
							const fresh = await Api.sale(uuid, sale.uuid);
							dialog.close();
							resumeSale(fresh);
						} catch (error) {
							reportError(error);
						}
					},
				},
				t("pos.open")
			);
		};

		const salePages = pagination(() => load());
		const load = async (): Promise<void> => {
			const round = salePages.state.begin();
			try {
				const day = await Api.sales(uuid, { scope: scope.value as "mine" | "all", limit: PAGE_SIZE, offset: salePages.state.offset });
				if (!salePages.state.current(round)) return;
				if (salePages.update(day.total)) return await load();
				const everyone = day.scope === "all";

				const totals =
					day.summary.length === 0
						? [el("p", { class: "muted" }, t("pos.no_sales_today"))]
						: day.summary.map((sum) =>
								el(
									"div",
									{ class: "pos-day-totals" },
									dayFigure(t("pos.figure_sales"), String(sum.sales)),
									dayFigure(t("editor.total"), formatMoney(sum.total, sum.currency)),
									dayFigure(t("processor.cash"), formatMoney(sum.cash, sum.currency)),
									dayFigure(t("pos.figure_other"), formatMoney(sum.other, sum.currency)),
									dayFigure(t("customer.stat_unpaid"), formatMoney(sum.outstanding, sum.currency)),
									sum.canceled > 0 ? dayFigure(t("pos.figure_canceled"), String(sum.canceled)) : null
								)
							);

				const rows = day.sales.map((sale) =>
					el(
						"tr",
						{},
						el("td", {}, formatTime(sale.created, timeFormat)),
						el("td", { class: "mono" }, sale.reference),
						everyone ? el("td", {}, accountName(sale.created_by_name, sale.created_by) ?? "-") : null,
						el("td", {}, statusPill(sale.status)),
						el("td", { class: "mono" }, formatMoney(sale.total_amount, sale.currency)),
						el("td", { class: "actions" }, saleAction(sale))
					)
				);

				const headers = [
					t("pos.column_time"),
					t("credits.column_number"),
					...(everyone ? [t("role.cashier")] : []),
					t("payments.status"),
					t("editor.total"),
					"",
				];
				body.replaceChildren(...totals, ...(rows.length > 0 ? [table(headers, rows)] : []), salePages.element);
			} catch (error) {
				if (salePages.state.current(round)) {
					salePages.fail();
					reportError(error);
				}
			}
		};

		scope.addEventListener("change", () => {
			salePages.reset();
			void load();
		});
		const controls = can(project, Permission.INVOICE_VIEW) ? el("div", { class: "toolbar" }, scope) : null;
		const dialog = modal(t("pos.sales_today"), el("div", { class: "stack" }, controls, body));
		await load();
	};

	const onSearchKey = (event: KeyboardEvent) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		const query = search.value.trim().toLowerCase();
		if (!query) return;

		const exact = catalog.find((item) => item.sku?.toLowerCase() === query || item.name.toLowerCase() === query);
		const shown = matchingItems();
		const chosen = exact ?? (shown.length === 1 ? shown[0] : undefined);
		if (!chosen) {
			toast(shown.length === 0 ? t("pos.no_item_matches") : t("pos.many_items_match"), "info");
			return;
		}
		addItem(chosen);
		search.value = "";
		catalogPages.reset();
		renderItems();
	};

	const onKey = (event: KeyboardEvent) => {
		if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
		if (document.querySelector(".overlay")) return;

		const target = event.target as HTMLElement | null;
		const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

		if (!overlay.hidden) {
			if (paidShown && event.key === "Enter" && !typing) {
				event.preventDefault();
				newSale();
			}
			return;
		}

		if (tab === "keypad" && customAllowed) {
			if (typing) return;
			if (/^\d$/.test(event.key)) press(event.key as KeypadKey);
			else if (event.key === "Backspace") press("back");
			else if (event.key === "Delete" || event.key === "Escape") press("clear");
			else if (event.key === "Enter") addCustom();
			else return;
			event.preventDefault();
			return;
		}

		if (!typing && event.key.length === 1) search.focus();
	};

	search.addEventListener("input", () => {
		catalogPages.reset();
		renderItems();
	});
	search.addEventListener("keydown", onSearchKey);
	note.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		addCustom();
	});
	document.addEventListener("keydown", onKey);
	const releaseScreen = keepScreenAwake();

	onLeave(() => {
		stopWatching();
		releaseScreen();
		fullscreen.dispose();
		document.removeEventListener("keydown", onKey);
	});

	renderAll();

	if (invoiceId) {
		const resumed = invoiceId;
		try {
			showSale(await Api.sale(uuid, resumed));
		} catch (error) {
			if (error instanceof ApiError && error.status === 404) {
				backToCart();
			} else {
				resuming = true;
				renderCart();
				watch(resumed);
			}
		}
	}

	return screen;
}
