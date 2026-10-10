import { Api, type FiscalSettings, type ProcessorState, type Project } from "../api";
import { el } from "../dom";
import { formatMoney } from "../money";
import { currentPath } from "../router";
import { applyAccent } from "../theme";
import { can, canAny, Permission } from "../access";
import { roleLabel, statusLabel, t, type UiKey } from "../i18n";
import { chatUnreadBadge } from "../chat-unread";

const cache = new Map<string, Project>();

export async function loadProject(uuid: string, refresh = false): Promise<Project> {
	const cached = cache.get(uuid);
	if (cached && !refresh) return cached;

	const project = await Api.project(uuid);
	cache.set(uuid, project);
	return project;
}

export function invalidateProject(uuid: string) {
	cache.delete(uuid);
}

type TabGroup = "sales" | "finance" | "work" | "project";

export const STORE_PERMISSIONS = [Permission.PROJECT_EDIT, Permission.ITEM_VIEW, Permission.INVOICE_VIEW];

const TABS: { id: string; label: UiKey; suffix: string; permissions: Permission[]; group?: TabGroup; workforce?: boolean; accounting?: boolean }[] = [
	{ id: "overview", label: "nav.overview", suffix: "", permissions: [Permission.PROJECT_VIEW] },
	{ id: "invoices", label: "nav.invoices", suffix: "/invoices", permissions: [Permission.INVOICE_VIEW], group: "sales" },
	{ id: "recurring", label: "nav.recurring", suffix: "/recurring", permissions: [Permission.SUBSCRIPTION_VIEW], group: "sales" },
	{ id: "transactions", label: "nav.payments", suffix: "/transactions", permissions: [Permission.PAYMENT_VIEW], group: "sales" },
	{ id: "emails", label: "nav.emails", suffix: "/emails", permissions: [Permission.EMAIL_VIEW], group: "sales" },
	{ id: "customers", label: "nav.customers", suffix: "/customers", permissions: [Permission.CUSTOMER_VIEW], group: "sales" },
	{ id: "items", label: "nav.items", suffix: "/items", permissions: [Permission.ITEM_VIEW], group: "sales" },
	{ id: "store", label: "nav.store", suffix: "/store", permissions: STORE_PERMISSIONS, group: "sales" },
	{ id: "pos", label: "nav.terminal", suffix: "/pos", permissions: [Permission.POS_SELL], group: "sales" },
	{ id: "expenses", label: "nav.expenses", suffix: "/expenses", permissions: [Permission.EXPENSE_VIEW], group: "finance" },
	{ id: "statistics", label: "nav.statistics", suffix: "/statistics", permissions: [Permission.REPORT_VIEW], group: "finance" },
	{ id: "accounting", label: "nav.accounting", suffix: "/accounting", permissions: [Permission.REPORT_VIEW], group: "finance", accounting: true },
	{
		id: "timesheet",
		label: "nav.timesheet",
		suffix: "/timesheet",
		permissions: [Permission.TIMESHEET_OWN, Permission.TIMESHEET_VIEW],
		group: "work",
		workforce: true,
	},
	{ id: "tickets", label: "nav.tickets", suffix: "/tickets", permissions: [Permission.TICKET_VIEW], group: "work", workforce: true },
	{ id: "chat", label: "nav.chat", suffix: "/chat", permissions: [Permission.CHAT_USE], group: "work", workforce: true },
	{ id: "calendar", label: "nav.calendar", suffix: "/calendar", permissions: [Permission.CHAT_USE], group: "work", workforce: true },
	{ id: "files", label: "nav.files", suffix: "/files", permissions: [Permission.FILE_USE], group: "work" },
	{ id: "employees", label: "nav.employees", suffix: "/employees", permissions: [Permission.EMPLOYEE_VIEW], group: "work", workforce: true },
	{ id: "payroll", label: "nav.payroll", suffix: "/payroll", permissions: [Permission.EMPLOYEE_VIEW], group: "work", workforce: true },
	{ id: "members", label: "nav.team", suffix: "/members", permissions: [Permission.PROJECT_VIEW], group: "project" },
	{ id: "license", label: "nav.license", suffix: "/license", permissions: [Permission.PROJECT_EDIT], group: "project" },
	{
		id: "settings",
		label: "nav.settings",
		suffix: "/settings",
		permissions: [Permission.PROJECT_EDIT, Permission.API_KEYS, Permission.API_WEBHOOKS],
		group: "project",
	},
];

const GROUP_LABELS: Record<TabGroup, UiKey> = {
	sales: "nav.group_sales",
	finance: "nav.group_finance",
	work: "nav.group_work",
	project: "nav.group_project",
};

export const SETTINGS_PERMISSIONS = TABS.find((tab) => tab.id === "settings")!.permissions;
export const LICENSE_PERMISSIONS = TABS.find((tab) => tab.id === "license")!.permissions;

export function projectLayout(project: Project, content: HTMLElement): HTMLElement {
	const path = currentPath();
	applyAccent(project.accent_color);
	const shortcutActions = [
		can(project, Permission.INVOICE_CREATE) ? "new-invoice" : null,
		can(project, Permission.CUSTOMER_CREATE) ? "new-customer" : null,
		can(project, Permission.ITEM_CREATE) ? "new-item" : null,
		can(project, Permission.EXPENSE_CREATE) ? "new-expense" : null,
		can(project, Permission.SUBSCRIPTION_CREATE) ? "new-recurring" : null,
		can(project, Permission.LEDGER_EDIT) && project.accounting ? "new-accounting-entry" : null,
	].filter((action): action is string => action !== null);

	const workforce = project.workforce || project.workforce_until !== null;
	const accounting = project.accounting || project.accounting_until !== null;
	const available = TABS.filter((tab) => canAny(project, tab.permissions) && (!tab.workforce || workforce) && (!tab.accounting || accounting));
	let activeLabel = t("nav.menu");
	const groups = new Map<TabGroup | null, HTMLElement[]>();
	for (const tab of available) {
		const href = `/projects/${project.uuid}${tab.suffix}`;
		const active = tab.suffix === "" ? path === href : path.startsWith(href);
		if (active) activeLabel = t(tab.label);
		const link = el("a", { class: `tab ${active ? "active" : ""}`, href }, t(tab.label), tab.id === "chat" ? chatUnreadBadge(project.uuid) : null);
		if (active) link.setAttribute("aria-current", "page");
		const key = tab.group ?? null;
		groups.set(key, [...(groups.get(key) ?? []), link]);
	}

	const nav = el(
		"nav",
		{ class: "project-nav", id: "project-nav" },
		...[...groups].map(([group, links]) =>
			el("div", { class: "nav-group" }, group ? el("span", { class: "nav-group-title" }, t(GROUP_LABELS[group])) : null, ...links)
		)
	);
	nav.setAttribute("aria-label", project.name);
	const toggle = el("button", { type: "button", class: "project-nav-toggle" }, activeLabel);
	toggle.setAttribute("aria-expanded", "false");
	toggle.setAttribute("aria-controls", "project-nav");
	toggle.addEventListener("click", () => {
		const open = nav.classList.toggle("open");
		toggle.setAttribute("aria-expanded", String(open));
	});

	return el(
		"div",
		{ class: "page page-project", dataset: { projectUuid: project.uuid, shortcutActions: shortcutActions.join(" ") } },
		el(
			"div",
			{ class: "page-head" },
			el(
				"div",
				{},
				el("a", { class: "back-link", href: "/" }, t("project.all_projects")),
				el("h1", {}, project.name),
				el("p", { class: "muted mono" }, project.uuid)
			),
			el("span", { class: `pill pill-${project.role}` }, roleLabel(project.role))
		),
		el("div", { class: "project-body" }, el("div", { class: "project-side" }, toggle, nav), el("div", { class: "project-content" }, content))
	);
}

export function noAccessView(project: Project): HTMLElement {
	return projectLayout(
		project,
		el(
			"div",
			{ class: "empty" },
			el("p", {}, t("access.denied")),
			el("a", { class: "button ghost", href: `/projects/${project.uuid}` }, t("access.back_to_overview"))
		)
	);
}

function statCard(label: string, value: string): HTMLElement {
	return el("div", { class: "card stat" }, el("span", { class: "stat-value" }, value), el("span", { class: "stat-label" }, label));
}

const MANUAL_METHODS = new Set(["bank_transfer"]);

function isReady(state: ProcessorState): boolean {
	return state.enabled && state.server_available && state.configured;
}

function paymentMethodsCard(uuid: string, states: ProcessorState[] | null, configures: boolean): HTMLElement | null {
	if (states === null) return null;

	const ready = states.filter(isReady);
	const automatic = ready.filter((state) => !MANUAL_METHODS.has(state.processor));
	const manual = ready.filter((state) => MANUAL_METHODS.has(state.processor));
	const names = (list: ProcessorState[]) => list.map((state) => state.label).join(", ");
	const settingsLink = configures ? el("a", { class: "button ghost", href: `/projects/${uuid}/settings` }, t("overview.payment_settings")) : null;

	if (ready.length === 0) {
		return el("div", { class: "card notice" }, el("h2", {}, t("overview.no_methods_title")), el("p", {}, t("overview.no_methods_body")), settingsLink);
	}

	return el(
		"div",
		{ class: "card" },
		el("h2", {}, t("overview.methods_title")),
		automatic.length > 0 ? el("p", {}, el("strong", {}, t("overview.methods_automatic")), names(automatic)) : null,
		manual.length > 0 ? el("p", {}, el("strong", {}, t("overview.methods_manual")), `${names(manual)}. ${t("overview.methods_manual_hint")}`) : null,
		automatic.length === 0 ? el("p", { class: "muted" }, t("overview.methods_none_automatic")) : el("p", { class: "muted" }, t("overview.methods_cash_note")),
		settingsLink
	);
}

function fiscalAttentionCard(uuid: string, fiscal: FiscalSettings | null): HTMLElement | null {
	if (!fiscal || fiscal.rejected + fiscal.late + fiscal.due_soon === 0) return null;

	const counts: [UiKey, number][] = [
		["overview.fiscal_rejected", fiscal.rejected],
		["overview.fiscal_late", fiscal.late],
		["overview.fiscal_due", fiscal.due_soon],
	];
	return el(
		"div",
		{ class: "card notice" },
		el("h2", {}, t("overview.fiscal_title")),
		el("p", {}, t("overview.fiscal_body")),
		...counts.filter(([, count]) => count > 0).map(([key, count]) => el("p", { class: "warn" }, t(key, { count }))),
		el("a", { class: "button ghost", href: `/projects/${uuid}/settings#fiscal` }, t("overview.fiscal_open"))
	);
}

export async function overviewView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid, true);
	const seesInvoices = can(project, Permission.INVOICE_VIEW);
	const [totals, methods, fiscal] = await Promise.all([
		seesInvoices ? Api.invoices(uuid, { limit: 5 }) : Promise.resolve({ invoices: [] }),
		Api.processors(uuid).catch(() => null),
		project.tax_country === "SI" ? Api.fiscal(uuid).catch(() => null) : Promise.resolve(null),
	]);

	const stats = el(
		"div",
		{ class: "grid stats" },
		statCard(t("nav.invoices"), String(project.stats?.invoices ?? 0)),
		statCard(t("nav.customers"), String(project.stats?.customers ?? 0)),
		statCard(t("overview.stat_members"), String(project.stats?.members ?? 0)),
		statCard(t("overview.stat_transactions"), String(project.stats?.transactions ?? 0))
	);

	const recent =
		totals.invoices.length === 0
			? el("p", { class: "muted" }, t("invoices.empty"))
			: el(
					"ul",
					{ class: "recent" },
					...totals.invoices.map((invoice) =>
						el(
							"li",
							{},
							el("a", { href: `/projects/${uuid}/invoices/${invoice.uuid}` }, invoice.reference),
							el("span", { class: `pill pill-${invoice.status}` }, statusLabel(invoice.status)),
							el("span", { class: "mono" }, formatMoney(invoice.total_amount, invoice.currency))
						)
					)
				);

	const content = el(
		"div",
		{ class: "stack" },
		fiscalAttentionCard(uuid, fiscal),
		project.stats ? stats : null,
		seesInvoices
			? el(
					"div",
					{ class: "card" },
					el("h2", {}, t("overview.recent_invoices")),
					recent,
					el("a", { class: "button ghost", href: `/projects/${uuid}/invoices` }, t("overview.view_all_invoices"))
				)
			: null,
		paymentMethodsCard(uuid, methods, can(project, Permission.PROJECT_EDIT))
	);

	return projectLayout(project, content);
}
