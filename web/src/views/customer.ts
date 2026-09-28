import { Api, type Customer, type CustomerStats } from "../api";
import { el, emptyState, table } from "../dom";
import { formatDate, formatMoney } from "../money";
import { loadProject, projectLayout } from "./project";
import { customerForm, vatBadge, vatPrefixMissing } from "./customers";
import { invoiceBrowser } from "./invoices";
import { recurringTable } from "./recurring";
import { can, Permission } from "../access";
import { countryName } from "../countries";
import { customerTypeLabel } from "../options";
import { t, tn } from "../i18n";
import { formatIban, type DateFormat } from "../../../server/formats";
import { ticketAccessCard } from "./tickets";

function statCard(label: string, value: string, detail?: string): HTMLElement {
	return el(
		"div",
		{ class: "card stat" },
		el("span", { class: "stat-value" }, value),
		el("span", { class: "stat-label" }, label),
		detail ? el("span", { class: "muted" }, detail) : null
	);
}

function paymentCards(stats: CustomerStats): HTMLElement {
	const onTimeShare = stats.settled > 0 ? `${Math.round((stats.paid_on_time / stats.settled) * 100)}%` : "-";
	const daysToPay = stats.average_days_to_pay === null ? "-" : tn("count.days", Math.round(stats.average_days_to_pay));

	return el(
		"div",
		{ class: "grid stats" },
		statCard(t("customer.stat_issued"), String(stats.issued), stats.drafts > 0 ? t("customer.drafts_not_issued", { count: stats.drafts }) : undefined),
		statCard(
			t("customer.stat_unpaid"),
			String(stats.unpaid),
			stats.overdue > 0 ? t("customer.past_due_count", { count: stats.overdue }) : t("customer.nothing_past_due")
		),
		statCard(
			t("customer.stat_on_time"),
			onTimeShare,
			stats.settled > 0
				? t("customer.on_time_of", { paid: stats.paid_on_time, total: tn("count.paid_invoices", stats.settled) })
				: t("customer.no_paid_invoices")
		),
		statCard(
			t("customer.stat_time_to_pay"),
			daysToPay,
			stats.average_days_late === null ? undefined : t("customer.late_average", { days: tn("count.days", stats.average_days_late) })
		)
	);
}

function paymentHistory(stats: CustomerStats, dateFormat: DateFormat, timezone: string): HTMLElement {
	const lines: HTMLElement[] = [];

	if (stats.overdue > 0) {
		const amounts = stats.currencies.filter((sum) => sum.overdue > 0).map((sum) => formatMoney(sum.overdue, sum.currency));
		lines.push(el("p", { class: "warn" }, t("customer.overdue_summary", { invoices: tn("count.invoices", stats.overdue), amounts: amounts.join(", ") })));
	}
	if (stats.paid_late > 0) lines.push(el("p", {}, t("customer.paid_late", { invoices: tn("count.invoices", stats.paid_late) })));
	if (stats.first_invoice !== null)
		lines.push(el("p", { class: "muted" }, t("customer.first_invoice", { date: formatDate(stats.first_invoice, dateFormat, timezone) })));
	if (stats.last_invoice !== null)
		lines.push(el("p", { class: "muted" }, t("customer.last_invoice", { date: formatDate(stats.last_invoice, dateFormat, timezone) })));
	lines.push(
		el(
			"p",
			{ class: "muted" },
			stats.last_payment === null ? t("customer.no_payments") : t("customer.last_payment", { date: formatDate(stats.last_payment, dateFormat, timezone) })
		)
	);

	return el("div", { class: "card" }, el("h3", {}, t("customer.history")), ...lines);
}

function currencyTotals(stats: CustomerStats): HTMLElement | null {
	if (stats.currencies.length === 0) return null;

	return el(
		"div",
		{ class: "card" },
		el("h3", {}, t("customer.totals")),
		table(
			[
				t("customer.column_currency"),
				t("nav.invoices"),
				t("customer.column_billed"),
				t("customer.column_received"),
				t("customer.column_outstanding"),
				t("customer.column_past_due"),
			],
			stats.currencies.map((sum) =>
				el(
					"tr",
					{},
					el("td", { class: "mono" }, sum.currency),
					el("td", {}, String(sum.invoices)),
					el("td", { class: "mono" }, formatMoney(sum.billed, sum.currency)),
					el("td", { class: "mono" }, formatMoney(sum.paid, sum.currency)),
					el("td", { class: "mono" }, sum.outstanding > 0 ? formatMoney(sum.outstanding, sum.currency) : "-"),
					el("td", { class: sum.overdue > 0 ? "mono warn" : "mono" }, sum.overdue > 0 ? formatMoney(sum.overdue, sum.currency) : "-")
				)
			)
		),
		el("p", { class: "muted" }, t("customer.totals_note"))
	);
}

function contactDetails(customer: Customer): HTMLElement {
	const address = [
		customer.address_line1,
		customer.address_line2,
		[customer.postal_code, customer.city].filter(Boolean).join(" "),
		customer.state,
		customer.country ? countryName(customer.country) : null,
	].filter(Boolean);
	const type = customerTypeLabel(customer.customer_type);

	return el(
		"div",
		{ class: "card" },
		el("h3", {}, t("customer.details")),
		el("p", {}, el("a", { href: `mailto:${customer.email}` }, customer.email), customer.phone ? `, ${customer.phone}` : null),
		address.length > 0 ? el("p", {}, address.join(", ")) : null,
		type ? el("p", { class: "muted" }, type) : null,
		customer.vat_number ? el("p", {}, `${t("customers.vat_number")}: `, el("span", { class: "mono" }, customer.vat_number), " ", vatBadge(customer)) : null,
		customer.tax_number ? el("p", {}, `${t("customers.tax_number")}: `, el("span", { class: "mono" }, customer.tax_number)) : null,
		customer.registration_number ? el("p", {}, `${t("customers.registration_number")}: `, el("span", { class: "mono" }, customer.registration_number)) : null,
		customer.iban
			? el("p", {}, `${t("customers.iban")}: `, el("span", { class: "mono" }, formatIban(customer.iban)), customer.bic ? ` (${customer.bic})` : null)
			: null,
		vatPrefixMissing(customer) ? el("p", { class: "warn" }, t("customers.vat_prefix_missing")) : null
	);
}

export async function customerView(uuid: string, customerId: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const dateFormat = project.date_format as DateFormat;
	const container = el("div", { class: "stack" });

	const render = async () => {
		const customer = await Api.customer(uuid, customerId);
		const stats = customer.stats!;
		const newInvoiceHref = `/projects/${uuid}/invoices/new?customer=${customer.uuid}`;

		const recurring = can(project, Permission.SUBSCRIPTION_VIEW) ? await Api.recurringList(uuid, { customer: customer.uuid }).catch(() => []) : null;
		const recurringCard =
			recurring === null
				? null
				: el(
						"div",
						{ class: "stack" },
						el(
							"div",
							{ class: "toolbar" },
							el("h3", { class: "toolbar-title" }, t("customer.recurring_title")),
							can(project, Permission.SUBSCRIPTION_CREATE)
								? el("a", { class: "button ghost", href: `/projects/${uuid}/recurring/new?customer=${customer.uuid}` }, t("recurring.new"))
								: el("span", {})
						),
						recurring.length === 0
							? el("p", { class: "muted" }, t("customer.no_recurring"))
							: recurringTable(uuid, recurring, dateFormat, project.timezone, false)
					);

		const invoices = await invoiceBrowser(
			uuid,
			dateFormat,
			project.timezone,
			{ customer: customer.uuid },
			emptyState(
				t("customer.no_invoices"),
				can(project, Permission.INVOICE_CREATE) ? el("a", { class: "button primary", href: newInvoiceHref }, t("customer.create_invoice")) : undefined
			)
		);

		const children: (HTMLElement | null)[] = [
			el("a", { class: "back-link", href: `/projects/${uuid}/customers` }, t("nav.customers")),
			el(
				"div",
				{ class: "page-head" },
				el(
					"div",
					{},
					el("h2", {}, customer.name || customer.email),
					el("p", { class: "muted" }, t("customer.since", { date: formatDate(customer.created, dateFormat, project.timezone) }))
				),
				el(
					"div",
					{ class: "toolbar" },
					can(project, Permission.CUSTOMER_EDIT)
						? el("button", { class: "button ghost", type: "button", onClick: () => customerForm(uuid, customer, () => void render()) }, t("ui.edit"))
						: null,
					el("a", { class: "button ghost", href: `/projects/${uuid}/invoices?customer=${customer.uuid}` }, t("customer.open_in_invoices")),
					can(project, Permission.INVOICE_CREATE) ? el("a", { class: "button primary", href: newInvoiceHref }, t("invoices.new")) : null
				)
			),
			paymentCards(stats),
			currencyTotals(stats),
			el("div", { class: "grid" }, contactDetails(customer), paymentHistory(stats, dateFormat, project.timezone)),
			recurringCard,
			await ticketAccessCard(project, customer.uuid).catch(() => null),
			el("div", { class: "stack" }, el("h3", { class: "toolbar-title" }, t("nav.invoices")), invoices),
		];

		container.replaceChildren(...children.filter((child): child is HTMLElement => child !== null));
	};

	await render();
	return projectLayout(project, container);
}
