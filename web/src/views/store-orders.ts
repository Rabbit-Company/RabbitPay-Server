import { Api, type Project, type StoreFulfillment, type StoreOrder } from "../api";
import { el, emptyState, field, input, select, statusPill, table } from "../dom";
import { t, type UiKey } from "../i18n";
import { confirmDialog, reportError, toast } from "../ui";
import { can, Permission } from "../access";
import { formatDateTime, formatMoney } from "../money";
import { pagination, PAGE_SIZE } from "../pagination";
import { countryName } from "../countries";
import { storeSection } from "./store";

const FULFILLMENT_PILLS: Record<StoreFulfillment, string> = {
	pending: "open",
	processing: "partially_paid",
	shipped: "active",
	delivered: "paid",
	canceled: "canceled",
};

export function fulfillmentPill(fulfillment: StoreFulfillment): HTMLElement {
	return el("span", { class: `pill pill-${FULFILLMENT_PILLS[fulfillment]}` }, t(`shop.fulfillment_${fulfillment}` as UiKey));
}

export async function storeOrdersView(uuid: string): Promise<HTMLElement> {
	return storeSection(uuid, (_project, state) => {
		const view = select(
			[
				{ value: "to_ship", label: t("store.orders_to_ship") },
				{ value: "unpaid", label: t("store.orders_unpaid") },
				{ value: "paid", label: t("store.orders_paid") },
				{ value: "", label: t("store.orders_all") },
			],
			state.stats.to_ship > 0 ? "to_ship" : ""
		);
		const search = input("search", { placeholder: t("store.orders_search") });
		const body = el("div");
		const controls = pagination(() => load());
		let debounce: ReturnType<typeof setTimeout>;

		const load = async (): Promise<void> => {
			const round = controls.state.begin();
			try {
				const result = await Api.storeOrders(uuid, {
					payment: view.value || undefined,
					search: search.value.trim() || undefined,
					limit: PAGE_SIZE,
					offset: controls.state.offset,
				});
				if (!controls.state.current(round)) return;
				if (controls.update(result.total)) return await load();
				body.replaceChildren(
					result.orders.length === 0
						? emptyState(view.value === "to_ship" ? t("store.orders_none_to_ship") : t("store.orders_empty"))
						: table(
								[t("invoices.column_reference"), t("store.order_date"), t("store.customer"), t("editor.total"), t("store.payment"), t("store.fulfillment"), ""],
								result.orders.map((order) =>
									el(
										"tr",
										{},
										el("td", {}, el("a", { class: "mono", href: `/projects/${uuid}/store/orders/${order.invoice}` }, order.reference)),
										el("td", {}, formatDateTime(order.created)),
										el("td", {}, el("div", {}, order.customer_name ?? order.email), order.customer_name ? el("div", { class: "muted" }, order.email) : null),
										el("td", { class: "mono" }, formatMoney(order.total_amount, order.currency)),
										el("td", {}, statusPill(order.payment_status)),
										el("td", {}, fulfillmentPill(order.fulfillment)),
										el(
											"td",
											{ class: "actions" },
											el("a", { class: "button ghost small", href: `/projects/${uuid}/store/orders/${order.invoice}` }, t("store.open_order"))
										)
									)
								)
							)
				);
			} catch (error) {
				if (controls.state.current(round)) {
					controls.fail();
					reportError(error);
				}
			}
		};

		const reload = () => {
			controls.reset();
			void load();
		};
		view.addEventListener("change", reload);
		search.addEventListener("input", () => {
			clearTimeout(debounce);
			debounce = setTimeout(reload, 250);
		});
		void load();

		return el("div", { class: "stack" }, el("div", { class: "toolbar" }, view, search), body, controls.element);
	});
}

function addressBlock(order: StoreOrder): HTMLElement {
	const address = order.shipping_address;
	if (!address) return el("p", { class: "muted" }, order.shipping_method ? order.shipping_method : t("store.no_shipping"));
	const lines = [
		address.name,
		address.phone,
		address.address_line1,
		address.address_line2,
		[address.postal_code, address.city].filter(Boolean).join(" "),
		address.state,
		address.country ? countryName(address.country) : null,
	].filter((line): line is string => Boolean(line));
	return el("address", { class: "order-address" }, ...lines.flatMap((line, index) => (index ? [el("br"), line] : [line])));
}

function orderDetail(project: Project, initial: StoreOrder): HTMLElement {
	const uuid = project.uuid;
	const editable = can(project, Permission.INVOICE_EDIT);
	const container = el("div", { class: "stack" });

	const render = (order: StoreOrder) => {
		const tracking = input("url", { value: order.tracking_url ?? "", placeholder: "https://...", maxlength: "1000" });
		const notify = input("checkbox");
		notify.checked = true;
		const update = async (fulfillment: StoreFulfillment) => {
			try {
				const saved = await Api.updateStoreOrder(uuid, order.invoice, { fulfillment, tracking_url: tracking.value.trim() || null, notify: notify.checked });
				toast(t("store.order_updated"), "success");
				render(saved);
			} catch (error) {
				reportError(error);
			}
		};
		const open = order.fulfillment !== "canceled";
		const paid = order.payment_status === "paid";
		const actions =
			open && editable
				? el(
						"div",
						{ class: "stack" },
						field(t("store.tracking_url"), tracking, t("store.tracking_hint")),
						el("label", { class: "switch" }, notify, el("span", {}, t("store.notify_customer"))),
						el(
							"div",
							{ class: "line-actions" },
							order.fulfillment === "pending"
								? el("button", { class: "button ghost", type: "button", onClick: () => void update("processing") }, t("store.mark_processing"))
								: null,
							order.fulfillment === "pending" || order.fulfillment === "processing"
								? el("button", { class: "button primary", type: "button", onClick: () => void update("shipped") }, t("store.mark_shipped"))
								: null,
							order.fulfillment === "shipped"
								? el("button", { class: "button primary", type: "button", onClick: () => void update("delivered") }, t("store.mark_delivered"))
								: null,
							order.fulfillment === "shipped" || order.fulfillment === "delivered"
								? el("button", { class: "button ghost", type: "button", onClick: () => void update(order.fulfillment) }, t("store.save_tracking"))
								: null,
							order.fulfillment === "pending" || order.fulfillment === "processing"
								? el(
										"button",
										{
											class: "button danger",
											type: "button",
											onClick: async () => {
												const confirmed = await confirmDialog({
													title: t("store.cancel_order_title"),
													body: paid ? t("store.cancel_order_paid") : t("store.cancel_order_body"),
													confirmLabel: t("store.cancel_order"),
													destructive: true,
												});
												if (!confirmed) return;
												try {
													render(await Api.cancelStoreOrder(uuid, order.invoice, null));
													toast(t("store.order_canceled"), "success");
												} catch (error) {
													reportError(error);
												}
											},
										},
										t("store.cancel_order")
									)
								: null
						),
						!paid && order.fulfillment === "pending" ? el("p", { class: "warn" }, t("store.wait_for_payment")) : null
					)
				: null;

		const sections = [
			el(
				"div",
				{ class: "page-head" },
				el(
					"div",
					{},
					el("a", { class: "back-link", href: `/projects/${uuid}/store/orders` }, t("store.back_to_orders")),
					el("h2", {}, t("store.order_title", { reference: order.reference })),
					el("p", { class: "muted" }, formatDateTime(order.created))
				),
				el("div", { class: "line-actions" }, statusPill(order.payment_status), fulfillmentPill(order.fulfillment))
			),
			el(
				"div",
				{ class: "order-layout" },
				el(
					"section",
					{ class: "card stack" },
					el("h3", {}, t("store.order_items")),
					table(
						[t("editor.description"), t("editor.quantity"), t("editor.total")],
						(order.items ?? []).map((item) =>
							el(
								"tr",
								{},
								el("td", {}, item.description),
								el("td", { class: "mono" }, String(item.quantity)),
								el("td", { class: "mono" }, formatMoney(item.total, order.currency))
							)
						)
					),
					order.coupon
						? el(
								"div",
								{ class: "totals" },
								el("span", {}, t("shop.discount", { code: order.coupon.code })),
								el("span", { class: "mono" }, `-${formatMoney(order.coupon.discount, order.currency)}`)
							)
						: null,
					el("div", { class: "totals" }, el("strong", {}, t("editor.total")), el("strong", { class: "mono" }, formatMoney(order.total_amount, order.currency))),
					order.outstanding > 0 && order.fulfillment !== "canceled"
						? el("p", { class: "warn" }, t("store.outstanding", { amount: formatMoney(order.outstanding, order.currency) }))
						: null,
					can(project, Permission.INVOICE_VIEW)
						? el("a", { class: "button ghost", href: `/projects/${uuid}/invoices/${order.invoice}` }, t("store.open_invoice"))
						: null
				),
				el(
					"section",
					{ class: "card stack" },
					el("h3", {}, t("store.customer")),
					el("p", {}, el("strong", {}, order.customer_name ?? ""), el("br"), el("a", { href: `mailto:${order.email}` }, order.email)),
					el("h3", {}, t("store.shipping_to")),
					order.shipping_method ? el("p", {}, el("strong", {}, order.shipping_method)) : null,
					addressBlock(order),
					order.note ? el("div", { class: "order-note" }, el("strong", {}, t("shop.order_note")), el("p", {}, order.note)) : null
				)
			),
			actions ? el("section", { class: "card stack" }, el("h3", {}, t("store.fulfillment")), actions) : null,
			order.tracking_url && !actions ? el("a", { href: order.tracking_url, target: "_blank", rel: "noopener noreferrer" }, t("shop.track")) : null,
		];
		container.replaceChildren(...sections.filter((section): section is HTMLElement => section !== null));
	};

	render(initial);
	return container;
}

export async function storeOrderView(uuid: string, invoice: string): Promise<HTMLElement> {
	return storeSection(uuid, async (project) => orderDetail(project, await Api.storeOrder(uuid, invoice)));
}
