import { toSVG } from "@rabbit-company/qrcode";
import { ApiError, PublicApi, type PaymentInstruction, type PublicInvoice } from "../api";
import { append, el } from "../dom";
import { coinAmount } from "../../../server/units";
import { qrBlock, qrCaption } from "../qr";
import { formatDate, formatDateTime, formatMoney, toMinorUnits } from "../money";
import { formatIban, type DateFormat, type TimeFormat } from "../../../server/formats";
import { reportError, toast } from "../ui";
import { translator, type TranslationKey } from "../../../server/i18n";
import { quantityWithUnit } from "../../../server/measure-units";
import { applyAccent } from "../theme";
import { applyBranding, brandLogo, poweredBy } from "../branding";
import { t as ui } from "../i18n";

function statusPill(status: string, t: ReturnType<typeof translator>) {
	return el("span", { class: `pill pill-${status}` }, t(`status.${status}` as TranslationKey));
}

function qrFor(uri: string): HTMLElement {
	const wrapper = el("div", { class: "qr" });

	try {
		wrapper.innerHTML = toSVG(uri, { scale: 6, margin: 2 });
	} catch {
		wrapper.appendChild(el("p", { class: "muted" }, "Could not draw a QR code. Use the address below."));
	}

	return wrapper;
}

function copyRow(label: string, value: string, t: ReturnType<typeof translator>, shown = value): HTMLElement {
	return el(
		"div",
		{ class: "copy-row" },
		el("div", {}, el("span", { class: "field-label" }, label), el("code", { class: "mono" }, shown)),
		el(
			"button",
			{
				class: "button ghost small",
				type: "button",
				onClick: async () => {
					try {
						await navigator.clipboard.writeText(value);
						toast(t("pay.copied"), "success");
					} catch {
						toast(t("pay.copy_failed"), "error");
					}
				},
			},
			t("pay.copy")
		)
	);
}

function returnPath(): string | null {
	const value = new URLSearchParams(window.location.search).get("return");
	return value && /^\/(?![/\\])[^\s\\]*$/.test(value) ? value : null;
}

function processorName(processor: string): string {
	return processor.charAt(0).toUpperCase() + processor.slice(1);
}

function rateNote(instruction: PaymentInstruction, invoice: PublicInvoice, coin: ReturnType<typeof coinAmount>, t: ReturnType<typeof translator>): string {
	const base = coin.baseUnit ? `${Number(coin.base).toLocaleString()} ${coin.baseUnit}` : coin.base;

	if (!instruction.exchange_rate) return t("pay.rate_plain", { base });

	return t("pay.rate_with_price", {
		base,
		price: formatMoney(toMinorUnits(instruction.exchange_rate, invoice.currency), invoice.currency),
		ticker: coin.ticker,
	});
}

function keysCard(invoice: PublicInvoice, t: ReturnType<typeof translator>): HTMLElement | null {
	if (invoice.keys_pending) {
		return el("div", { class: "card" }, el("h3", {}, t("pay.keys_heading")), el("p", { class: "muted" }, t("pay.keys_pending")));
	}

	if (invoice.keys.length === 0) return null;

	return el(
		"div",
		{ class: "card" },
		el("h3", {}, t("pay.keys_heading")),
		el("p", { class: "muted" }, t("pay.keys_body")),
		...invoice.keys.flatMap((group) => group.codes.map((code) => copyRow(group.name, code, t)))
	);
}

const EXPIRY_WARNING_MS = 10 * 60 * 1000;
const COUNTDOWN_WINDOW_MS = 24 * 60 * 60 * 1000;

function countdown(milliseconds: number): string {
	const total = Math.max(Math.ceil(milliseconds / 1000), 0);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const clock = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

	return hours > 0 ? `${hours}:${clock}` : clock;
}

function expiryNotice(expiresAt: number, invoice: PublicInvoice, t: ReturnType<typeof translator>, onExpired: () => void): HTMLElement {
	const label = el("span", { class: "field-label" });
	const time = el("strong", { class: "expiry-time mono" });
	const hint = el("p", { class: "muted" });
	const notice = el("div", { class: "expiry" }, el("div", { class: "expiry-row" }, label, time), hint);

	const update = (): boolean => {
		const left = expiresAt - Date.now();
		if (left <= 0) return false;

		const soon = left <= EXPIRY_WARNING_MS;
		notice.classList.toggle("expiry-soon", soon);
		hint.textContent = soon ? t("pay.expiry_soon") : t("pay.expiry_hint");

		if (left > COUNTDOWN_WINDOW_MS) {
			label.textContent = t("pay.valid_until");
			time.textContent = formatDateTime(expiresAt, invoice.date_format as DateFormat, invoice.time_format as TimeFormat, invoice.timezone);
		} else {
			label.textContent = t("pay.time_left");
			time.textContent = countdown(left);
		}

		return true;
	};

	if (!update()) {
		queueMicrotask(onExpired);
		return notice;
	}

	const timer = setInterval(() => {
		if (!notice.isConnected) {
			clearInterval(timer);
			return;
		}

		if (!update()) {
			clearInterval(timer);
			onExpired();
		}
	}, 1000);

	return notice;
}

function expiredCard(t: ReturnType<typeof translator>, renew: () => Promise<void>): HTMLElement[] {
	const button = el("button", { class: "button primary", type: "button" }, t("pay.renew"));

	button.addEventListener("click", async () => {
		button.disabled = true;
		await renew();
		button.disabled = false;
	});

	return [el("h3", {}, t("pay.expired_heading")), el("p", { class: "warn" }, t("pay.expired_body")), button];
}

function instructionCard(instruction: PaymentInstruction, invoice: PublicInvoice, t: ReturnType<typeof translator>, renew: () => Promise<void>): HTMLElement {
	if (instruction.kind === "card" && instruction.checkout_url) {
		window.location.href = instruction.checkout_url;
		return el("div", { class: "card" }, el("p", {}, t("pay.redirecting")));
	}

	const card = el("div", { class: "card" });
	const expiry =
		typeof instruction.expires_at === "number"
			? expiryNotice(instruction.expires_at, invoice, t, () => {
					card.classList.add("expired");
					card.replaceChildren(...expiredCard(t, renew));
				})
			: null;

	if (instruction.kind === "bank") {
		const account = instruction.account;

		append(card, [
			el("h3", {}, t("processor.bank_transfer")),
			el("p", { class: "muted" }, t("pay.send_to_account", { amount: formatMoney(Number(instruction.amount ?? 0), instruction.currency ?? invoice.currency) })),
			expiry,
			instruction.qr ? qrBlock(instruction.qr, qrCaption(instruction.qr.format, invoice.language)) : null,
			account ? copyRow(t("bank.account_holder"), account.holder, t) : null,
			account ? copyRow(t("bank.iban"), account.iban, t, formatIban(account.iban)) : null,
			account?.bic ? copyRow(t("bank.bic"), account.bic, t) : null,
			account?.bank_name ? copyRow(t("bank.bank_name"), account.bank_name, t) : null,
			copyRow(t("bank.reference"), instruction.reference ?? "", t),
			el("p", { class: "warn" }, t("bank.reference_warning")),
			instruction.qr_unavailable ? el("p", { class: "muted" }, t(`qr.unavailable.${instruction.qr_unavailable}` as TranslationKey)) : null,
			el("p", { class: "muted" }, t("bank.manual_notice")),
		]);

		return card;
	}

	const coin = coinAmount(instruction.amount, instruction.unit);

	append(card, [
		el("h3", {}, t("pay.with", { processor: processorName(instruction.processor) })),
		expiry,
		instruction.uri ? qrFor(instruction.uri) : null,
		copyRow(t("pay.address"), instruction.address ?? "", t),
		copyRow(t("pay.amount_in", { ticker: coin.ticker }), coin.amount, t),
		el("p", { class: "muted" }, rateNote(instruction, invoice, coin, t)),
		instruction.confirmations_required !== undefined
			? el("p", { class: "muted" }, t("pay.confirmations", { count: instruction.confirmations_required }))
			: null,
		el("p", { class: "muted" }, t("pay.watching")),
	]);

	return card;
}

function pdfLink(invoiceId: string, t: ReturnType<typeof translator>): HTMLElement {
	const link = el("a", { class: "button ghost pay-pdf", href: PublicApi.invoicePdfUrl(invoiceId) }, t("pay.download_pdf"));
	link.download = "";
	return link;
}

export async function payView(invoiceId: string): Promise<HTMLElement> {
	const container = el("div", { class: "pay" });
	const brand = el("div", { class: "pay-brand" });
	const body = el("div", { class: "stack" });
	const footer = el("div", {});
	let poller: ReturnType<typeof setInterval> | undefined;

	const render = (invoice: PublicInvoice, instruction?: PaymentInstruction) => {
		const t = translator(invoice.language);
		applyAccent(invoice.accent_color);
		applyBranding(invoice.branding, invoice.merchant);
		const mark = brandLogo(invoice.branding, invoice.merchant, "pay-logo");
		brand.replaceChildren(...(mark ? [mark] : []));
		brand.hidden = mark === null;
		const back = returnPath();
		footer.replaceChildren(
			...[back ? el("a", { class: "button ghost", href: back }, ui("shop.back_to_order")) : null, poweredBy(invoice.branding, t("brand.powered_by"))].filter(
				(node): node is HTMLElement => node !== null
			)
		);
		const settled = invoice.status === "paid";
		const closed = invoice.status === "canceled";
		const order = invoice.document === "order";
		const date = formatDate(invoice.due_date, invoice.date_format as DateFormat, invoice.timezone);

		const summary = el(
			"div",
			{ class: "card pay-summary" },
			el(
				"div",
				{ class: "pay-head" },
				el("div", {}, el("p", { class: "muted" }, invoice.merchant), el("h1", {}, formatMoney(invoice.outstanding || invoice.total_amount, invoice.currency))),
				statusPill(order && invoice.status === "draft" ? "open" : invoice.status, t)
			),
			el("p", { class: "muted mono" }, order ? t("pay.order_number", { reference: invoice.reference }) : invoice.reference),
			el(
				"div",
				{ class: "totals" },
				el(
					"div",
					{ class: "totals-row" },
					el("span", {}, t("invoice.total")),
					el("span", { class: "mono" }, formatMoney(invoice.total_amount, invoice.currency))
				),
				invoice.paid_amount > 0
					? el(
							"div",
							{ class: "totals-row" },
							el("span", {}, t("invoice.paid")),
							el("span", { class: "mono" }, formatMoney(invoice.paid_amount, invoice.currency))
						)
					: null,
				el(
					"div",
					{ class: "totals-row grand" },
					el("span", {}, t("invoice.outstanding")),
					el("span", { class: "mono" }, formatMoney(invoice.outstanding, invoice.currency))
				)
			),
			el("p", { class: "muted" }, order ? t("pay.pay_by", { date }) : t("pay.due_on", { date })),
			order ? el("p", { class: "muted" }, t("pay.order_note")) : pdfLink(invoiceId, t)
		);

		const items =
			invoice.items.length === 0
				? null
				: el(
						"div",
						{ class: "card" },
						el("h3", {}, t("pay.items")),
						el(
							"ul",
							{ class: "recent" },
							...invoice.items.map((item) =>
								el(
									"li",
									{},
									el("span", {}, `${item.description} x ${quantityWithUnit(String(item.quantity), item.unit, invoice.language)}`),
									el("span", { class: "mono" }, formatMoney(item.total_price, invoice.currency))
								)
							)
						)
					);

		if (settled && window.parent !== window) {
			window.parent.postMessage({ source: "rabbitpay", type: "paid", invoice: invoiceId }, "*");
		}

		if (settled) {
			body.replaceChildren(
				summary,
				el("div", { class: "card paid-banner" }, el("h2", {}, t("pay.paid_heading")), el("p", {}, t("pay.paid_body"))),
				keysCard(invoice, t) ?? el("div", {}),
				items ?? el("div", {})
			);
			return;
		}

		if (closed) {
			body.replaceChildren(summary, el("div", { class: "card" }, el("h2", {}, t("pay.canceled_heading")), el("p", { class: "muted" }, t("pay.canceled_body"))));
			return;
		}

		if (instruction) {
			body.replaceChildren(
				summary,
				instructionCard(instruction, invoice, t, async () => {
					try {
						const latest = await PublicApi.invoice(invoiceId);
						if (latest.status === "paid" || latest.status === "canceled") {
							render(latest);
							return;
						}
						render(latest, await PublicApi.start(invoiceId, instruction.processor));
					} catch (error) {
						reportError(error);
					}
				}),
				el("button", { class: "button ghost", type: "button", onClick: () => render(invoice) }, t("pay.choose_another"))
			);
			return;
		}

		const methods =
			invoice.methods.length === 0
				? el("p", { class: "muted" }, t("pay.none_enabled"))
				: el(
						"div",
						{ class: "methods" },
						...invoice.methods.map((method) =>
							el(
								"button",
								{
									class: "button secondary method",
									type: "button",
									onClick: async () => {
										try {
											const started = await PublicApi.start(invoiceId, method.processor);
											render(invoice, started);
										} catch (error) {
											reportError(error);
										}
									},
								},
								method.processor === "bank_transfer" ? t("processor.bank_transfer") : method.label
							)
						)
					);

		body.replaceChildren(summary, el("div", { class: "card" }, el("h3", {}, t("pay.choose")), methods), items ?? el("div", {}));
	};

	const refresh = async (quiet = true) => {
		try {
			const invoice = await PublicApi.invoice(invoiceId);

			if (invoice.status === "paid" || invoice.status === "canceled") {
				if (poller && !invoice.keys_pending) clearInterval(poller);
				render(invoice);
			} else if (!quiet) {
				render(invoice);
			}

			return invoice;
		} catch (error) {
			if (poller) clearInterval(poller);
			if (!quiet) throw error;
			return null;
		}
	};

	try {
		const invoice = await PublicApi.invoice(invoiceId);
		render(invoice);
		poller = setInterval(() => void refresh(true), 6000);
	} catch (error) {
		const message = error instanceof ApiError ? error.message : ui("pay.load_failed");
		body.replaceChildren(el("div", { class: "card" }, el("h2", {}, ui("pay.unavailable")), el("p", { class: "muted" }, message)));
	}

	container.append(brand, body, footer);
	return container;
}
