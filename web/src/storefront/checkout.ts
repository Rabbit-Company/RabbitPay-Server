import { ApiError, PublicApi, type StoreOrder } from "../api";
import { CustomerApi, clearCustomerSession, customerToken, type CustomerOrder, type CustomerProfile } from "../customer-api";
import { customerForm, addressForm, type CustomerForm } from "../customer-forms";
import { privacyActions, profileEditor } from "../views/customer-profile";
import { el, field } from "../dom";
import { processorLabel, statusLabel, t, tn, type UiKey } from "../i18n";
import { navigate } from "../router";
import { reportError, toast } from "../ui";
import { ErrorCode } from "../../../server/errors";
import { StoreApi, type Quote, type QuoteLine } from "./api";
import { cartLines, clearCart, forgetProducts, lineKey, removeFromCart, setQuantity } from "./cart";
import { icon } from "./icons";
import { deliveryWindow, describeWindow, licenseSummary, longDate, money } from "./format";
import { breadcrumbs, emptyBlock, quantityStepper, storeContext, storeLayout, type StoreContext } from "./layout";

function summaryRow(label: string, value: string, className = ""): HTMLElement {
	return el("div", { class: `sf-summary-row ${className}` }, el("span", {}, label), el("span", {}, value));
}

function deliveryNote(ctx: StoreContext, quote: Quote): HTMLElement | null {
	if (!quote.requires_shipping) return el("p", { class: "sf-summary-note" }, icon("bolt", 16), t("shop.digital_delivery_body"));
	if (!quote.shipping) return null;
	if (quote.shipping.pickup)
		return el(
			"p",
			{ class: "sf-summary-note" },
			icon("pin", 16),
			t("shop.pickup_ready", { range: describeWindow(deliveryWindow(quote.delivery, ctx.store.config.delivery, quote.delivery.restock_at)) })
		);
	const window = deliveryWindow(quote.delivery, ctx.store.config.delivery, quote.delivery.restock_at);
	return el("p", { class: "sf-summary-note" }, icon("truck", 16), t("shop.arrives", { range: describeWindow(window) }));
}

function totals(ctx: StoreContext, quote: Quote, shippingKnown: boolean): HTMLElement {
	return el(
		"div",
		{ class: "sf-summary-totals" },
		summaryRow(t("shop.subtotal"), money(quote.items_total, quote.currency)),
		quote.requires_shipping
			? summaryRow(
					t("shop.shipping"),
					!shippingKnown || quote.shipping === null
						? t("shop.shipping_at_checkout")
						: quote.shipping_amount === 0
							? t("shop.free")
							: money(quote.shipping_amount, quote.currency)
				)
			: null,
		quote.coupon && quote.discount_amount > 0
			? summaryRow(t("shop.discount", { code: quote.coupon.code }), `-${money(quote.discount_amount, quote.currency)}`, "sf-summary-discount")
			: null,
		summaryRow(t("shop.total"), money(quote.total, quote.currency), "sf-summary-total"),
		quote.tax_amount > 0 ? el("span", { class: "sf-muted sf-summary-tax" }, t("shop.vat_included", { amount: money(quote.tax_amount, quote.currency) })) : null,
		deliveryNote(ctx, quote)
	);
}

function lineIssue(line: QuoteLine): HTMLElement | null {
	if (line.issue === "configuration") return el("span", { class: "sf-warning" }, t("shop.line_configuration"));
	if (line.issue === "unavailable") return el("span", { class: "sf-warning" }, t("shop.line_unavailable"));
	if (line.issue === "insufficient") return el("span", { class: "sf-warning" }, t("shop.line_insufficient", { count: line.available ?? 0 }));
	if (line.availability === "backorder")
		return el("span", { class: "sf-muted" }, line.restock_at ? t("shop.ships_from", { date: longDate(line.restock_at) }) : t("shop.backorder"));
	return null;
}

export async function cartView(slug: string): Promise<HTMLElement> {
	const ctx = await storeContext(slug);
	const body = el("div", { class: "sf-cart" });

	const render = async () => {
		const lines = cartLines(slug);
		if (lines.length === 0) {
			body.replaceChildren(
				emptyBlock(
					"bag",
					t("shop.cart_empty_title"),
					t("shop.cart_empty_body"),
					el("a", { class: "sf-button", href: ctx.link("/search") }, t("shop.start_shopping"))
				)
			);
			return;
		}
		const quote = await StoreApi.quote(slug, { lines });
		if (quote.unknown.length) {
			forgetProducts(slug, quote.unknown);
			toast(t("shop.cart_removed_unavailable"), "info");
		}
		const rows = quote.lines.map((line) => {
			const max = line.availability === "backorder" || line.available === null ? null : Math.max(line.available, line.quantity);
			const cartKey = lineKey({ product: line.product, license: line.requested });
			return el(
				"div",
				{ class: `sf-cart-line${line.issue ? " sf-cart-line-issue" : ""}` },
				el("a", { class: "sf-cart-thumb", href: ctx.link(`/p/${line.slug}`) }, line.image ? el("img", { src: line.image, alt: "" }) : icon("box", 26)),
				el(
					"div",
					{ class: "sf-cart-info" },
					el("a", { class: "sf-cart-name", href: ctx.link(`/p/${line.slug}`) }, line.name),
					line.license ? el("span", { class: "sf-muted" }, licenseSummary(line.license)) : null,
					el("span", { class: "sf-muted" }, money(line.unit_price, quote.currency)),
					lineIssue(line)
				),
				quantityStepper(line.quantity, max, (value) => {
					setQuantity(slug, cartKey, value);
					void render().catch(reportError);
				}),
				el("strong", { class: "sf-cart-total" }, money(line.total, quote.currency)),
				el(
					"button",
					{
						class: "sf-icon-button",
						type: "button",
						title: t("shop.remove"),
						onClick: () => {
							removeFromCart(slug, cartKey);
							void render().catch(reportError);
						},
					},
					icon("trash", 18)
				)
			);
		});
		body.replaceChildren(
			el("div", { class: "sf-cart-lines" }, ...rows, el("a", { class: "sf-link", href: ctx.link("/search") }, icon("left", 16), t("shop.continue_shopping"))),
			el(
				"aside",
				{ class: "sf-summary" },
				el("h2", {}, t("shop.order_summary")),
				totals(ctx, quote, false),
				el(
					"a",
					{ class: `sf-button sf-button-large sf-button-block${quote.lines.some((line) => line.issue) ? " disabled" : ""}`, href: ctx.link("/checkout") },
					icon("lock", 18),
					t("shop.checkout")
				),
				ctx.store.payment_methods.length
					? el(
							"div",
							{ class: "sf-methods" },
							...ctx.store.payment_methods.map((method) => el("span", { class: "sf-method" }, processorLabel(method.processor)))
						)
					: null
			)
		);
	};

	await render();
	const content = el("div", { class: "sf-container" }, breadcrumbs(ctx, [{ label: t("shop.cart") }]), el("h1", {}, t("shop.cart")), body);
	return storeLayout(ctx, content, t("shop.cart"));
}

export function signInCard(ctx: StoreContext, returnPath: string, heading: string, body: string): HTMLElement {
	const email = el("input", { type: "email", required: true, autocomplete: "email", placeholder: "you@example.com", maxlength: "254" });
	const submit = el("button", { class: "sf-button sf-button-large sf-button-block", type: "submit" }, icon("mail", 18), t("shop.email_link"));
	const card = el("div", { class: "sf-signin" });
	const form = el(
		"form",
		{
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					await CustomerApi.requestLogin(email.value.trim(), {
						store: ctx.store.slug,
						return: returnPath,
					});
					card.replaceChildren(
						el("div", { class: "sf-empty-icon" }, icon("mail", 30)),
						el("h2", {}, t("shop.check_email")),
						el("p", { class: "sf-muted" }, t("shop.check_email_body", { email: email.value.trim() })),
						el("button", { class: "sf-button sf-button-ghost", type: "button", onClick: () => card.replaceChildren(...initial) }, t("shop.use_other_email"))
					);
				} catch (error) {
					reportError(error);
				} finally {
					submit.disabled = false;
				}
			},
		},
		field(t("login.email"), email),
		submit
	);
	const initial = [
		el("div", { class: "sf-empty-icon" }, icon("user", 30)),
		el("h2", {}, heading),
		el("p", { class: "sf-muted" }, body),
		form,
		el("p", { class: "sf-fineprint" }, t("shop.passwordless")),
	];
	card.replaceChildren(...initial);
	return card;
}

function shippingChoices(ctx: StoreContext, quote: Quote, selected: string | null, onSelect: (id: string) => void): HTMLElement {
	return el(
		"div",
		{ class: "sf-options" },
		...quote.shipping_options.map((option) => {
			const radio = el("input", { type: "radio", value: option.id });
			radio.name = "shipping";
			radio.checked = option.id === (selected ?? quote.shipping?.id);
			radio.addEventListener("change", () => onSelect(option.id));
			const window = deliveryWindow(
				{
					min_days: quote.delivery.min_days - (quote.shipping?.min_days ?? 0) + option.min_days,
					max_days: quote.delivery.max_days - (quote.shipping?.max_days ?? 0) + option.max_days,
				},
				ctx.store.config.delivery,
				quote.delivery.restock_at
			);
			return el(
				"label",
				{ class: "sf-option" },
				radio,
				el("span", { class: "sf-option-icon" }, icon(option.pickup ? "pin" : "truck", 20)),
				el(
					"span",
					{ class: "sf-option-text" },
					el("strong", {}, option.name),
					el(
						"span",
						{ class: "sf-muted" },
						option.pickup ? t("shop.pickup_ready", { range: describeWindow(window) }) : t("shop.arrives", { range: describeWindow(window) })
					)
				),
				el("strong", { class: "sf-option-price" }, option.cost === 0 ? t("shop.free") : money(option.cost, quote.currency))
			);
		})
	);
}

function couponBox(quote: Quote, code: string | null, onChange: (code: string | null) => void): HTMLElement {
	if (quote.coupon) {
		return el(
			"div",
			{ class: "sf-coupon sf-coupon-applied" },
			icon("check", 16),
			el("span", {}, t("shop.coupon_applied", { code: quote.coupon.code })),
			el("button", { class: "sf-link", type: "button", onClick: () => onChange(null) }, t("shop.coupon_remove"))
		);
	}
	const entry = el("input", { type: "text", maxlength: "32", placeholder: t("shop.coupon_placeholder"), value: code ?? "", autocomplete: "off" });
	const apply = () => {
		const value = entry.value.trim().toUpperCase();
		if (value) onChange(value);
	};
	entry.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		apply();
	});
	return el(
		"div",
		{ class: "sf-coupon" },
		el(
			"div",
			{ class: "sf-coupon-row" },
			entry,
			el("button", { class: "sf-button sf-button-ghost sf-button-small", type: "button", onClick: apply }, t("shop.coupon_apply"))
		),
		code && quote.coupon_issue ? el("span", { class: "sf-coupon-issue" }, t(`shop.coupon_issue_${quote.coupon_issue}` as UiKey)) : null
	);
}

function summaryLines(quote: Quote): HTMLElement {
	return el(
		"div",
		{ class: "sf-summary-lines" },
		...quote.lines.map((line) =>
			el(
				"div",
				{ class: "sf-summary-line" },
				el(
					"span",
					{ class: "sf-summary-thumb" },
					line.image ? el("img", { src: line.image, alt: "" }) : icon("box", 18),
					el("span", { class: "sf-summary-qty" }, String(line.quantity))
				),
				el(
					"span",
					{ class: "sf-summary-name" },
					line.name,
					line.license ? el("span", { class: "sf-muted" }, ` (${licenseSummary(line.license)})`) : null,
					lineIssue(line)
				),
				el("span", {}, money(line.total, quote.currency))
			)
		)
	);
}

async function loadProfile(): Promise<CustomerProfile | null> {
	try {
		return await StoreApi.profile();
	} catch (error) {
		if (error instanceof ApiError && [1000, 1016, 1017].includes(error.code)) return null;
		throw error;
	}
}

export async function checkoutView(slug: string): Promise<HTMLElement> {
	const ctx = await storeContext(slug);
	const lines = cartLines(slug);
	if (lines.length === 0) {
		navigate(ctx.link("/cart"), true);
		return el("div");
	}

	const profile = customerToken() ? await loadProfile() : null;
	if (!profile) {
		const content = el(
			"div",
			{ class: "sf-container sf-narrow" },
			breadcrumbs(ctx, [{ label: t("shop.cart"), href: ctx.link("/cart") }, { label: t("shop.checkout") }]),
			signInCard(ctx, ctx.link("/checkout"), t("shop.signin_checkout"), t("shop.signin_checkout_body"))
		);
		return storeLayout(ctx, content, t("shop.checkout"));
	}

	const config = ctx.store.config;
	const customer: CustomerForm = customerForm(profile, config.checkout.business_customers);
	const delivery = addressForm(profile.shipping ?? null, { prefix: "shipping" });
	const same = el("input", { type: "checkbox" });
	same.checked = profile.shipping_same;
	delivery.element.hidden = same.checked;
	delivery.setRequired(!same.checked);
	same.addEventListener("change", () => {
		delivery.element.hidden = same.checked;
		delivery.setRequired(!same.checked);
		if (!same.checked && !delivery.read().name) delivery.fill({ ...customer.address.read(), country: customer.address.read().country || null });
	});
	const note = el("textarea", { rows: "3", maxlength: "1000", placeholder: t("shop.note_placeholder") });
	const save = el("input", { type: "checkbox" });
	save.checked = true;
	const terms = el("input", { type: "checkbox", required: true });
	const waiver = el("input", { type: "checkbox" });
	const waiverRow = el("label", { class: "sf-check" }, waiver, el("span", {}, t("shop.digital_waiver")));
	const scope = el("input", { type: "checkbox" });
	const scopeRow = el("label", { class: "sf-check" }, scope, el("span", {}, t("shop.license_scope")));
	const termsPage = config.pages.find((page) => page.slug === "terms");
	const privacyPage = config.pages.find((page) => page.slug === "privacy");
	const withdrawalPage = config.pages.find((page) => page.slug === "withdrawal");

	const shippingHost = el("div");
	const deliverySection = el(
		"section",
		{ class: "sf-step" },
		el("h2", {}, el("span", { class: "sf-step-number" }, "2"), t("shop.delivery")),
		el("label", { class: "sf-check sf-same-address" }, same, el("span", {}, t("shop.same_address"))),
		delivery.element,
		el("h3", {}, t("shop.shipping_method")),
		shippingHost
	);
	const summary = el("aside", { class: "sf-summary sf-summary-sticky" });
	const submit = el("button", { class: "sf-button sf-button-large sf-button-block", type: "submit" }, icon("lock", 18), t("shop.place_order"));

	let shipping: string | null = null;
	let coupon: string | null = null;
	let quote: Quote;
	let round = 0;
	const requote = async () => {
		const current = ++round;
		const buyer = { country: customer.address.read().country || null, customer_type: customer.type(), vat_number: customer.vat() };
		const next = await StoreApi.quote(slug, { lines: cartLines(slug), shipping, buyer, coupon });
		if (current !== round) return;
		quote = next;
		shipping = quote.shipping?.id ?? null;
		deliverySection.hidden = !quote.requires_shipping;
		waiverRow.hidden = !quote.withdrawal_waiver;
		waiver.required = quote.withdrawal_waiver;
		scopeRow.hidden = !quote.license_scope;
		scope.required = quote.license_scope;
		delivery.setRequired(quote.requires_shipping && !same.checked && !quote.shipping?.pickup);
		shippingHost.replaceChildren(
			shippingChoices(ctx, quote, shipping, (id) => {
				shipping = id;
				void requote().catch(reportError);
			})
		);
		summary.replaceChildren(
			el("h2", {}, t("shop.order_summary")),
			summaryLines(quote),
			couponBox(quote, coupon, (code) => {
				coupon = code;
				void requote().catch(reportError);
			}),
			totals(ctx, quote, true),
			submit
		);
		submit.disabled = !quote.ready;
	};
	customer.onChange(() => void requote().catch(reportError));
	await requote();

	const form = el(
		"form",
		{
			class: "sf-checkout",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					const placed = await StoreApi.checkout(slug, {
						lines: cartLines(slug),
						shipping,
						customer: customer.read(),
						delivery: quote.requires_shipping && !same.checked && !quote.shipping?.pickup ? delivery.read() : null,
						note: config.checkout.order_notes && note.value.trim() ? note.value.trim() : null,
						accept_terms: terms.checked,
						waive_withdrawal: quote.withdrawal_waiver && waiver.checked,
						accept_license_scope: quote.license_scope && scope.checked,
						save_profile: save.checked,
						coupon: quote.coupon?.code ?? null,
					});
					clearCart(slug);
					navigate(ctx.link(`/order/${placed.invoice}`));
				} catch (error) {
					if (
						error instanceof ApiError &&
						[ErrorCode.STORE_OUT_OF_STOCK, ErrorCode.INVALID_CART, ErrorCode.INVALID_COUPON, ErrorCode.COUPON_USED_UP].includes(error.code)
					)
						await requote().catch(() => undefined);
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el(
			"div",
			{ class: "sf-checkout-main" },
			el(
				"section",
				{ class: "sf-step" },
				el("h2", {}, el("span", { class: "sf-step-number" }, "1"), t("shop.your_details")),
				el(
					"div",
					{ class: "sf-signed-in" },
					icon("user", 18),
					el("span", {}, t("shop.signed_in_as", { email: profile.email })),
					el(
						"button",
						{
							class: "sf-link",
							type: "button",
							onClick: async () => {
								try {
									await CustomerApi.logout();
								} catch {
									void 0;
								}
								clearCustomerSession();
								navigate(ctx.link("/checkout"), true);
							},
						},
						t("shop.not_you")
					)
				),
				customer.element
			),
			deliverySection,
			el(
				"section",
				{ class: "sf-step" },
				el("h2", {}, el("span", { class: "sf-step-number" }, quote!.requires_shipping ? "3" : "2"), t("shop.review")),
				config.checkout.order_notes ? field(t("shop.order_note"), note, t("forms.optional")) : null,
				el("label", { class: "sf-check" }, save, el("span", {}, t("shop.save_details"))),
				el(
					"label",
					{ class: "sf-check" },
					terms,
					el(
						"span",
						{},
						t("shop.accept_prefix"),
						" ",
						termsPage ? el("a", { href: ctx.link("/page/terms"), target: "_blank" }, termsPage.title) : null,
						` ${t("shop.accept_and")} `,
						privacyPage ? el("a", { href: ctx.link("/page/privacy"), target: "_blank" }, privacyPage.title) : null
					)
				),
				waiverRow,
				scopeRow,
				el("p", { class: "sf-fineprint" }, t("shop.payment_after", { days: tn("count.days", config.checkout.payment_days) }))
			)
		),
		withdrawalPage
			? el(
					"p",
					{ class: "sf-fineprint" },
					t("shop.withdrawal_note"),
					" ",
					el("a", { href: ctx.link("/page/withdrawal"), target: "_blank" }, t("shop.withdrawal_link"))
				)
			: null,
		summary
	);

	const content = el(
		"div",
		{ class: "sf-container" },
		breadcrumbs(ctx, [{ label: t("shop.cart"), href: ctx.link("/cart") }, { label: t("shop.checkout") }]),
		el("h1", {}, t("shop.checkout")),
		form
	);
	return storeLayout(ctx, content, t("shop.checkout"));
}

const STEPS = ["placed", "paid", "processing", "shipped", "delivered"] as const;

function progress(order: StoreOrder): HTMLElement {
	const paid = order.payment_status === "paid";
	const reached =
		order.fulfillment === "canceled"
			? -1
			: Math.max(0, paid ? 1 : 0, ["pending", "processing", "shipped", "delivered"].indexOf(order.fulfillment) + (order.fulfillment === "pending" ? 0 : 1));
	return el(
		"ol",
		{ class: "sf-progress" },
		...STEPS.map((step, index) =>
			el(
				"li",
				{ class: index <= reached ? "done" : index === reached + 1 ? "next" : "" },
				el("span", { class: "sf-progress-dot" }, index <= reached ? icon("check", 14) : null),
				t(`shop.step_${step}`)
			)
		)
	);
}

function addressLines(address: StoreOrder["shipping_address"]): string[] {
	if (!address) return [];
	return [
		address.name,
		address.address_line1,
		address.address_line2,
		[address.postal_code, address.city].filter(Boolean).join(" "),
		address.state,
		address.country,
	].filter((line): line is string => Boolean(line));
}

export async function orderView(slug: string, invoice: string): Promise<HTMLElement> {
	const ctx = await storeContext(slug);
	if (!customerToken()) {
		const content = el(
			"div",
			{ class: "sf-container sf-narrow" },
			signInCard(ctx, ctx.link(`/order/${invoice}`), t("shop.signin_order"), t("shop.signin_order_body"))
		);
		return storeLayout(ctx, content, t("shop.order"));
	}
	const order = await StoreApi.order(slug, invoice);
	const payable = order.outstanding > 0 && ["open", "overdue", "partially_paid"].includes(order.payment_status) && order.fulfillment !== "canceled";
	const pay = payable
		? el(
				"a",
				{ class: "sf-button sf-button-large", href: `/pay/${order.invoice}?return=${encodeURIComponent(ctx.link(`/order/${order.invoice}`))}` },
				icon("card", 20),
				t("shop.pay_now", { amount: money(order.outstanding, order.currency) })
			)
		: null;

	const heading =
		order.fulfillment === "canceled"
			? el(
					"div",
					{ class: "sf-order-hero sf-order-canceled" },
					el("h1", {}, t("shop.order_canceled")),
					el("p", {}, t("shop.order_reference", { reference: order.number }))
				)
			: el(
					"div",
					{ class: "sf-order-hero" },
					el("span", { class: "sf-order-check" }, icon("check", 30)),
					el("h1", {}, payable ? t("shop.order_received") : t("shop.order_thanks")),
					el("p", {}, t("shop.order_reference", { reference: order.number })),
					order.invoice_reference ? el("p", { class: "sf-muted" }, t("shop.order_invoice", { reference: order.invoice_reference })) : null,
					order.payment_status === "canceled"
						? null
						: el(
								"a",
								{ class: "sf-link", href: PublicApi.invoicePdfUrl(order.invoice), target: "_blank", rel: "noopener" },
								icon("download", 16),
								order.invoice_reference ? t("shop.download_invoice") : t("shop.download_confirmation")
							),
					payable ? el("p", { class: "sf-muted" }, t("shop.order_pay_by", { date: longDate(order.due_date) })) : null,
					pay
				);

	const content = el(
		"div",
		{ class: "sf-container sf-order" },
		heading,
		order.fulfillment === "canceled" ? null : progress(order),
		el(
			"div",
			{ class: "sf-order-grid" },
			el(
				"section",
				{ class: "sf-panel" },
				el("h2", {}, t("shop.items")),
				el(
					"div",
					{ class: "sf-summary-lines" },
					...(order.items ?? []).map((item) =>
						el(
							"div",
							{ class: "sf-summary-line" },
							el("span", { class: "sf-summary-name" }, `${item.quantity} x ${item.description}`),
							el("span", {}, money(item.total, order.currency))
						)
					)
				),
				order.coupon && order.coupon.discount > 0
					? summaryRow(t("shop.discount", { code: order.coupon.code }), `-${money(order.coupon.discount, order.currency)}`, "sf-summary-discount")
					: null,
				summaryRow(t("shop.total"), money(order.total_amount, order.currency), "sf-summary-total")
			),
			el(
				"section",
				{ class: "sf-panel" },
				el("h2", {}, t("shop.delivery")),
				el("p", {}, el("strong", {}, order.shipping_method ?? t("shop.digital_delivery"))),
				...addressLines(order.shipping_address).map((line) => el("span", { class: "sf-line" }, line)),
				order.tracking_url
					? el(
							"a",
							{ class: "sf-button sf-button-ghost", href: order.tracking_url, target: "_blank", rel: "noopener noreferrer" },
							icon("truck", 18),
							t("shop.track")
						)
					: null,
				el(
					"p",
					{ class: "sf-muted" },
					t("shop.status_line", { status: t(`shop.fulfillment_${order.fulfillment}`), payment: statusLabel(order.payment_status) })
				)
			)
		),
		el(
			"div",
			{ class: "sf-order-actions" },
			el("a", { class: "sf-button sf-button-ghost", href: ctx.link("/account") }, t("shop.my_orders")),
			el("a", { class: "sf-link", href: ctx.link() }, t("shop.continue_shopping"))
		)
	);
	return storeLayout(ctx, content, t("shop.order"));
}

function ordersList(ctx: StoreContext, orders: CustomerOrder[]): HTMLElement {
	if (orders.length === 0) return el("p", { class: "sf-muted" }, t("shop.no_orders"));
	return el(
		"div",
		{ class: "sf-order-list" },
		...orders.map((order) => {
			const own = order.store_url === ctx.base || order.store_url === `${window.location.origin}${ctx.base}`;
			const href = own ? ctx.link(`/order/${order.invoice}`) : `/customer/invoices/${order.invoice}`;
			return el(
				"a",
				{ class: "sf-order-row", href },
				el("div", {}, el("strong", {}, order.number), el("span", { class: "sf-muted" }, `${order.store} | ${longDate(order.created)}`)),
				el("span", { class: `sf-state sf-state-${order.fulfillment}` }, t(`shop.fulfillment_${order.fulfillment}`)),
				el("span", { class: "pill pill-" + order.payment_status }, statusLabel(order.payment_status)),
				el("strong", {}, money(order.total_amount, order.currency))
			);
		})
	);
}

export async function accountView(slug: string): Promise<HTMLElement> {
	const ctx = await storeContext(slug);
	const profile = customerToken() ? await loadProfile() : null;
	if (!profile) {
		const content = el(
			"div",
			{ class: "sf-container sf-narrow" },
			signInCard(ctx, ctx.link("/account"), t("shop.signin_account"), t("shop.signin_account_body"))
		);
		return storeLayout(ctx, content, t("shop.account"));
	}
	const orders = await CustomerApi.orders(0, 50);
	const signOut = el(
		"button",
		{
			class: "sf-button sf-button-ghost",
			type: "button",
			onClick: async () => {
				try {
					await CustomerApi.logout();
				} catch {
					void 0;
				}
				clearCustomerSession();
				navigate(ctx.link(), true);
			},
		},
		icon("logout", 18),
		t("app.sign_out")
	);
	const content = el(
		"div",
		{ class: "sf-container sf-account" },
		breadcrumbs(ctx, [{ label: t("shop.account") }]),
		el("div", { class: "sf-listing-head" }, el("div", {}, el("h1", {}, t("shop.account")), el("p", { class: "sf-muted" }, profile.email)), signOut),
		el(
			"section",
			{ class: "sf-panel" },
			el("h2", {}, t("shop.my_orders")),
			ordersList(ctx, orders.orders),
			el("a", { class: "sf-link", href: "/customer" }, t("shop.all_invoices"), icon("right", 16))
		),
		el(
			"section",
			{ class: "sf-panel" },
			el("h2", {}, t("profile.details")),
			el("p", { class: "sf-muted" }, t("profile.details_body")),
			profileEditor(profile, ctx.store.config.checkout.business_customers, () => undefined)
		),
		el(
			"section",
			{ class: "sf-panel" },
			el("h2", {}, t("profile.privacy")),
			privacyActions(() => navigate(ctx.link(), true))
		)
	);
	return storeLayout(ctx, content, t("shop.account"));
}
