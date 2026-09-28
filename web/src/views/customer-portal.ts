import { el, emptyState, field, input, saveFile, select, statusPill, table } from "../dom";
import { CustomerApi, clearCustomerSession, customerToken, storeCustomerSession, type CustomerInvoice, type CustomerProforma } from "../customer-api";
import { navigate, onLeave } from "../router";
import { reportError } from "../ui";
import { language, t } from "../i18n";
import { logo } from "../logo";
import { languageSwitcher } from "../language";
import { themeSwitcher } from "../theme-switcher";
import { authBrand, authFooter, authPage } from "../auth-page";
import { pagination, PAGE_SIZE } from "../pagination";
import { formatDateIn, formatMoneyIn, type DateFormat } from "../../../server/formats";
import { creditNoteDocumentView, invoiceDocumentView, printButton } from "./print";
import { PublicApi } from "../api";

function safeReturn(value: unknown): string | null {
	return typeof value === "string" && /^\/(?![/\\])[^\s\\]*$/.test(value) ? value : null;
}

export function customerLoginView(): HTMLElement {
	const fragment = new URLSearchParams(window.location.hash.slice(1));
	const fragmentToken = fragment.get("token");
	const token = fragmentToken ?? history.state?.customerLoginToken ?? null;
	const returnTo = safeReturn(fragment.get("return")) ?? safeReturn(history.state?.customerReturn);
	if (fragmentToken) history.replaceState({ customerLoginToken: fragmentToken, customerReturn: returnTo }, "", "/customer/login");
	const email = input("email", { autocomplete: "email", required: true, placeholder: "you@example.com", maxlength: "254" });
	const submit = el("button", { class: "button primary wide", type: "submit" }, t(token ? "portal.continue" : "portal.send_link"));
	const links = el(
		"div",
		{ class: "auth-links" },
		token ? el("a", { href: "/customer/login" }, t("portal.request_new")) : null,
		customerToken() ? el("a", { href: "/customer" }, t("portal.invoices")) : null
	);
	const form = el("form", {
		class: "auth-card",
		onSubmit: async (event) => {
			event.preventDefault();
			submit.disabled = true;
			try {
				if (token) {
					const session = await CustomerApi.verify(token);
					storeCustomerSession(session.token);
					navigate(returnTo ?? "/customer", true);
				} else {
					await CustomerApi.requestLogin(email.value.trim());
					form.replaceChildren(...linkSent(email.value.trim(), () => form.replaceChildren(...request)));
				}
			} catch (error) {
				reportError(error);
			} finally {
				submit.disabled = false;
			}
		},
	});
	const request = [
		authBrand(),
		el("h1", {}, t("portal.title")),
		el("p", { class: "auth-subtitle" }, t(token ? "portal.verify_body" : "portal.subtitle")),
		token ? null : field(t("login.email"), email),
		submit,
		links.childElementCount ? links : null,
	].filter((node): node is HTMLElement => node !== null);
	form.replaceChildren(...request);
	return authPage(form, authFooter(t("portal.business_prompt"), t("portal.business_login"), "/login"));
}

function linkSent(address: string, back: () => void): HTMLElement[] {
	const status = el("div", { class: "auth-sent" }, el("h1", {}, t("portal.link_sent_title")), el("p", { class: "auth-subtitle" }, t("portal.link_sent")));
	status.setAttribute("role", "status");
	return [
		authBrand(),
		el("div", { class: "auth-sent-icon" }),
		status,
		el("p", { class: "auth-sent-address" }, address),
		el("button", { class: "button ghost wide", type: "button", onClick: back }, t("portal.use_other_email")),
	];
}

export async function customerHeader(active: "invoices" | "orders" | "tickets" | "profile" = "invoices"): Promise<HTMLElement> {
	const account = await CustomerApi.me();
	const links: { id: typeof active; href: string; label: string }[] = [
		{ id: "invoices", href: "/customer", label: t("portal.invoices") },
		{ id: "orders", href: "/customer/orders", label: t("portal.orders") },
		...(account.tickets || active === "tickets" ? [{ id: "tickets" as const, href: "/customer/tickets", label: t("portal_tickets.title") }] : []),
		{ id: "profile", href: "/customer/profile", label: t("profile.title") },
	];
	const nav = el(
		"nav",
		{ class: "app-nav" },
		...links.map((link) => {
			const anchor = el("a", { class: "app-nav-link", href: link.href }, link.label);
			if (link.id === active) anchor.setAttribute("aria-current", "page");
			return anchor;
		})
	);
	return el(
		"header",
		{ class: "app-header customer-header no-print" },
		el("div", { class: "header-left" }, el("a", { class: "brand", href: "/customer" }, logo(), el("span", {}, t("portal.title"))), nav),
		el(
			"div",
			{ class: "header-right" },
			themeSwitcher(),
			languageSwitcher(),
			el("span", { class: "muted portal-email", title: account.email }, account.email),
			el(
				"button",
				{
					class: "button ghost small",
					type: "button",
					onClick: async () => {
						try {
							await CustomerApi.logout();
						} catch {
							void 0;
						}
						clearCustomerSession();
						navigate("/customer/login", true);
					},
				},
				t("app.sign_out")
			)
		)
	);
}

export function customerRoute(render: () => Promise<HTMLElement>): Promise<HTMLElement> | HTMLElement {
	if (!customerToken()) {
		navigate("/customer/login", true);
		return el("div");
	}
	return render();
}

function invoiceRow(invoice: CustomerInvoice): HTMLElement {
	const money = (amount: number) => formatMoneyIn(amount, invoice.currency, language());
	const date = (value: number) => formatDateIn(value, invoice.date_format as DateFormat, language(), invoice.timezone);
	return el(
		"tr",
		{},
		el("td", {}, el("a", { href: `/customer/invoices/${invoice.uuid}` }, invoice.reference)),
		el("td", {}, invoice.merchant),
		el("td", {}, statusPill(invoice.status)),
		el("td", {}, date(invoice.issued)),
		el("td", {}, date(invoice.due_date)),
		el("td", { class: "numeric" }, money(invoice.total_amount)),
		el("td", { class: "numeric" }, money(invoice.outstanding))
	);
}

function proformasCard(proformas: CustomerProforma[]): HTMLElement | null {
	if (proformas.length === 0) return null;
	return el(
		"div",
		{ class: "card stack" },
		el("h2", {}, t("portal.proformas")),
		el("p", { class: "muted" }, t("portal.proformas_hint")),
		table(
			[t("invoices.column_reference"), t("portal.business"), t("invoices.valid_until"), t("portal.outstanding"), ""],
			proformas.map((proforma) =>
				el(
					"tr",
					{},
					el("td", { class: "mono" }, proforma.reference),
					el("td", {}, proforma.merchant),
					el("td", {}, formatDateIn(proforma.valid_until, proforma.date_format as DateFormat, language(), proforma.timezone)),
					el("td", { class: "numeric" }, formatMoneyIn(proforma.outstanding, proforma.currency, language())),
					el(
						"td",
						{ class: "actions" },
						el("a", { class: "button ghost small", href: PublicApi.invoicePdfUrl(proforma.uuid), target: "_blank", rel: "noopener" }, t("portal.proforma_pdf")),
						el("a", { class: "button primary small", href: `/pay/${proforma.uuid}` }, t("portal.proforma_pay"))
					)
				)
			)
		)
	);
}

export async function customerInvoicesView(): Promise<HTMLElement> {
	const header = await customerHeader();
	document.title = `${t("portal.invoices")} | RabbitPay`;
	const filter = select([
		{ value: "", label: t("portal.all") },
		{ value: "unpaid", label: t("portal.unpaid") },
		{ value: "overdue", label: t("portal.overdue") },
		{ value: "paid", label: t("portal.paid") },
	]);
	const body = el("div");
	const proformas = (await CustomerApi.proformas().catch(() => ({ proformas: [] }))).proformas;
	const controls = pagination(() => load());
	onLeave(() => controls.state.reset());
	const load = async (): Promise<void> => {
		const round = controls.state.begin();
		const page = await CustomerApi.invoices(filter.value, controls.state.offset, PAGE_SIZE);
		if (!controls.state.current(round)) return;
		if (controls.update(page.total)) return await load();
		body.replaceChildren(
			page.invoices.length
				? table(
						[
							t("invoices.column_reference"),
							t("portal.business"),
							t("portal.status"),
							t("invoices.column_issued"),
							t("invoices.column_due"),
							t("portal.total"),
							t("portal.outstanding"),
						],
						page.invoices.map(invoiceRow)
					)
				: emptyState(t("portal.empty"))
		);
	};
	filter.addEventListener("change", () => {
		controls.reset();
		void load().catch(reportError);
	});
	await load();
	return el(
		"div",
		{},
		header,
		el(
			"div",
			{ class: "page stack" },
			el("h1", {}, t("portal.invoices")),
			proformasCard(proformas),
			el("div", { class: "toolbar" }, field(t("portal.filter"), filter)),
			body,
			controls.element
		)
	);
}

function fileButton(label: string, fileName: string, load: () => Promise<Blob>): HTMLElement {
	const button = el("button", { class: "button ghost", type: "button" }, label);
	button.addEventListener("click", async () => {
		button.disabled = true;
		try {
			saveFile(await load(), fileName);
		} catch (error) {
			reportError(error);
		} finally {
			button.disabled = false;
		}
	});
	return button;
}

function pdfButton(kind: "invoices" | "credit-notes", uuid: string, reference: string): HTMLElement {
	return fileButton(t("invoices.download_pdf"), `${reference}.pdf`, () => CustomerApi.pdf(kind, uuid));
}

function eslogButton(
	kind: "invoices" | "credit-notes",
	uuid: string,
	reference: string,
	buyer: { vat_number: string | null; tax_number?: string | null } | null
) {
	if (!buyer?.vat_number && !buyer?.tax_number) return null;
	return fileButton(t("invoices.download_eslog"), `${reference}.xml`, () => CustomerApi.eslog(kind, uuid));
}

export async function customerInvoiceView(uuid: string): Promise<HTMLElement> {
	const header = await customerHeader();
	const details = await CustomerApi.invoice(uuid);
	const invoice = details.document.invoice;
	const actions = el(
		"div",
		{ class: "doc-actions no-print" },
		el("a", { class: "button ghost", href: "/customer" }, t("portal.back")),
		pdfButton("invoices", uuid, invoice.reference),
		eslogButton("invoices", uuid, invoice.reference, details.document.buyer),
		printButton(() => CustomerApi.pdf("invoices", uuid), "ghost"),
		invoice.outstanding > 0 && ["open", "overdue", "partially_paid"].includes(invoice.status)
			? el("a", { class: "button primary", href: `/pay/${uuid}`, target: "_blank", rel: "noopener noreferrer" }, t("portal.pay"))
			: null
	);
	const credits = details.credit_notes.length
		? el(
				"section",
				{ class: "page no-print" },
				el("h2", {}, t("portal.credits")),
				table(
					[t("invoices.column_reference"), t("invoices.column_issued"), t("portal.total")],
					details.credit_notes.map((note) =>
						el(
							"tr",
							{},
							el("td", {}, el("a", { href: `/customer/credit-notes/${note.uuid}` }, note.reference)),
							el("td", {}, formatDateIn(note.issued, details.document.formats.date as DateFormat, language(), details.document.formats.timezone)),
							el("td", {}, formatMoneyIn(-note.total_amount, note.currency, language()))
						)
					)
				)
			)
		: null;
	return el("div", {}, header, invoiceDocumentView(details.document, actions), credits);
}

export async function customerCreditNoteView(uuid: string): Promise<HTMLElement> {
	const header = await customerHeader();
	const note = await CustomerApi.creditNote(uuid);
	const actions = el(
		"div",
		{ class: "doc-actions no-print" },
		el("a", { class: "button ghost", href: `/customer/invoices/${note.corrects.uuid}` }, t("portal.credit_back")),
		pdfButton("credit-notes", uuid, note.credit_note.reference),
		eslogButton("credit-notes", uuid, note.credit_note.reference, note.buyer),
		printButton(() => CustomerApi.pdf("credit-notes", uuid), "ghost")
	);
	return el("div", {}, header, creditNoteDocumentView(note, actions));
}
