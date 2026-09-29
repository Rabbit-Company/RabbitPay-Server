import { CustomerApi, clearCustomerSession, type CustomerOrder, type CustomerProfile } from "../customer-api";
import { addressForm, customerForm } from "../customer-forms";
import { el, emptyState, saveFile, statusPill, table } from "../dom";
import { locale, t } from "../i18n";
import { navigate } from "../router";
import { confirmDialog, reportError, toast } from "../ui";
import { formatMoneyIn } from "../../../server/formats";
import { customerHeader, customerRoute } from "./customer-portal";
import { fulfillmentPill } from "./store-orders";

export function profileEditor(profile: CustomerProfile, allowBusiness: boolean, onSaved: (profile: CustomerProfile) => void): HTMLElement {
	const customer = customerForm(profile, allowBusiness);
	const delivery = addressForm(profile.shipping ?? null, { prefix: "shipping" });
	const same = el("input", { type: "checkbox" });
	same.checked = profile.shipping_same;
	delivery.element.hidden = same.checked;
	delivery.setRequired(!same.checked);
	same.addEventListener("change", () => {
		delivery.element.hidden = same.checked;
		delivery.setRequired(!same.checked);
	});
	const submit = el("button", { class: "button primary", type: "submit" }, t("ui.save"));
	return el(
		"form",
		{
			class: "form-stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					const value = customer.read();
					const saved = await CustomerApi.saveProfile({ ...value, shipping_same: same.checked, shipping: same.checked ? null : delivery.read() });
					toast(t("profile.saved"), "success");
					onSaved(saved);
				} catch (error) {
					reportError(error);
				} finally {
					submit.disabled = false;
				}
			},
		},
		customer.element,
		el("label", { class: "switch" }, same, el("span", {}, t("shop.same_address"))),
		delivery.element,
		el("div", { class: "form-actions" }, submit)
	);
}

export function privacyActions(onDeleted: () => void): HTMLElement {
	const exportButton = el("button", { class: "button ghost", type: "button" }, t("profile.export"));
	exportButton.addEventListener("click", async () => {
		exportButton.disabled = true;
		try {
			saveFile(await CustomerApi.exportData(), "my-data.json");
		} catch (error) {
			reportError(error);
		} finally {
			exportButton.disabled = false;
		}
	});
	const remove = el(
		"button",
		{
			class: "button danger",
			type: "button",
			onClick: async () => {
				const confirmed = await confirmDialog({
					title: t("profile.delete_title"),
					body: t("profile.delete_body"),
					confirmLabel: t("profile.delete_confirm"),
					destructive: true,
				});
				if (!confirmed) return;
				try {
					await CustomerApi.deleteAccount();
					clearCustomerSession();
					toast(t("profile.deleted"), "success");
					onDeleted();
				} catch (error) {
					reportError(error);
				}
			},
		},
		t("profile.delete")
	);
	return el(
		"div",
		{ class: "form-stack" },
		el("p", { class: "muted" }, t("profile.privacy_body")),
		el("div", { class: "form-actions start" }, exportButton, remove)
	);
}

export async function customerProfileView(): Promise<HTMLElement> {
	return customerRoute(async () => {
		const header = await customerHeader("profile");
		document.title = `${t("profile.title")} | RabbitPay`;
		const profile = await CustomerApi.profile();
		return el(
			"div",
			{},
			header,
			el(
				"div",
				{ class: "page stack" },
				el("h1", {}, t("profile.title")),
				el(
					"section",
					{ class: "card stack" },
					el("h2", {}, t("profile.details")),
					el("p", { class: "muted" }, t("profile.details_body")),
					profileEditor(profile, true, () => undefined)
				),
				el(
					"section",
					{ class: "card stack" },
					el("h2", {}, t("profile.privacy")),
					privacyActions(() => navigate("/customer/login", true))
				)
			)
		);
	});
}

function orderRow(order: CustomerOrder): HTMLElement {
	return el(
		"tr",
		{},
		el("td", {}, el("a", { class: "mono", href: `/customer/invoices/${order.invoice}` }, order.reference)),
		el("td", {}, order.store_url ? el("a", { href: order.store_url }, order.store) : order.store),
		el("td", {}, new Date(order.created).toLocaleDateString(locale())),
		el("td", {}, statusPill(order.payment_status)),
		el(
			"td",
			{},
			fulfillmentPill(order.fulfillment),
			order.tracking_url ? el("a", { class: "tracking-link", href: order.tracking_url, target: "_blank", rel: "noopener noreferrer" }, t("shop.track")) : null
		),
		el("td", { class: "numeric" }, formatMoneyIn(order.total_amount, order.currency, locale()))
	);
}

export async function customerOrdersView(): Promise<HTMLElement> {
	return customerRoute(async () => {
		const header = await customerHeader("orders");
		document.title = `${t("portal.orders")} | RabbitPay`;
		const result = await CustomerApi.orders(0, 200);
		return el(
			"div",
			{},
			header,
			el(
				"div",
				{ class: "page stack" },
				el("h1", {}, t("portal.orders")),
				result.orders.length
					? table(
							[t("invoices.column_reference"), t("portal.store"), t("store.order_date"), t("portal.status"), t("store.fulfillment"), t("portal.total")],
							result.orders.map(orderRow)
						)
					: emptyState(t("shop.no_orders"))
			)
		);
	});
}
