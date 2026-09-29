import "./styles.css";
import "./storefront/storefront.css";
import { ApiError, getToken, getUsername, isAdmin, setUnauthorizedHandler } from "./api";
import { el } from "./dom";
import { installSelectPicker } from "./select-picker";
import { configure, define, navigate, setErrorView, start } from "./router";
import { toast } from "./ui";
import { signOut } from "./session";
import { logo } from "./logo";
import { applyAccent, applyTheme } from "./theme";
import { resetBranding } from "./branding";
import { accountMenu, type MenuLink } from "./account-menu";
import { language, t } from "./i18n";
import { loginView } from "./views/login";
import { customerCreditNoteView, customerInvoiceView, customerInvoicesView, customerLoginView, customerRoute } from "./views/customer-portal";
import { projectsView } from "./views/projects";
import { landingEnabled, landingView } from "./views/landing";
import { checkPendingTerms, legalDocumentView, legalNoticeView } from "./views/legal";
import { LICENSE_PERMISSIONS, loadProject, noAccessView, overviewView, SETTINGS_PERMISSIONS } from "./views/project";
import { canAny, Permission, sellsOnly, terminalPath, timesheetPath, worksOnly } from "./access";
import { customersView } from "./views/customers";
import { customerView } from "./views/customer";
import { itemsView } from "./views/items";
import { expensesView } from "./views/expenses";
import { statisticsView } from "./views/statistics";
import { editInvoiceView, invoicesView, invoiceView, newInvoiceView } from "./views/invoices";
import { transactionsView } from "./views/transactions";
import { membersView } from "./views/members";
import { settingsView } from "./views/settings";
import { payView } from "./views/pay";
import { posView } from "./views/pos";
import { converterView } from "./views/converter";
import { inviteView } from "./views/invite";
import { recurringFormView, recurringListView, recurringView } from "./views/recurring";
import { creditNotePrintView, printView } from "./views/print";
import { licenseView } from "./views/license";
import { adminAccountsView, adminInvitesView, adminLegalView, adminLicensesView, adminOverviewView, adminProjectsView, adminSettingsView } from "./views/admin";
import { handleShortcutRender, installKeyboardShortcuts, showShortcutModal } from "./keyboard";
import { accountView } from "./views/account";
import { customerOrdersView, customerProfileView } from "./views/customer-profile";
import { storeSettingsView } from "./views/store";
import { storeCategoriesView, storeProductsView, storeProductView } from "./views/store-products";
import { storeOrdersView, storeOrderView } from "./views/store-orders";
import { storeCouponsView } from "./views/store-coupons";
import { storeTranslationView, storeTranslationsView } from "./views/store-translations";
import { categoryView, homeView, pageView, productView, searchView } from "./storefront/pages";
import { accountView as shopAccountView, cartView, checkoutView, orderView } from "./storefront/checkout";
import { domainStore, storeError } from "./storefront/layout";
import { absencesView, timesheetReportView, timesheetSettingsView, timesheetView } from "./views/timesheet";
import { ticketsView, ticketView } from "./views/tickets";
import { employeesView } from "./views/employees";
import { payrollRatesView, payrollRunsView, payrollRunView } from "./views/payroll";
import { customerTicketsView, customerTicketView } from "./views/customer-tickets";

const root = document.querySelector("#app") as HTMLElement;
const domainSlug = domainStore();
const outlet = el("main", { class: "outlet" });
const shell = el("div", { class: "shell" });

function primaryLinks(): MenuLink[] {
	const path = window.location.pathname;
	return [
		{ label: t("projects.title"), href: "/", current: path === "/" || path.startsWith("/projects/") },
		{ label: t("app.converter"), href: "/converter", current: path === "/converter" },
		...(isAdmin() ? [{ label: t("app.admin"), href: "/admin", current: path === "/admin" || path.startsWith("/admin/") }] : []),
	];
}

function header(): HTMLElement {
	const links = primaryLinks();
	const nav = el(
		"nav",
		{ class: "app-nav" },
		...links.map((link) => {
			const anchor = el("a", { class: "app-nav-link", href: link.href }, link.label);
			if (link.current) anchor.setAttribute("aria-current", "page");
			return anchor;
		})
	);
	nav.setAttribute("aria-label", t("app.main_navigation"));

	return el(
		"header",
		{ class: "app-header" },
		el("div", { class: "header-left" }, el("a", { class: "brand", href: "/" }, logo(), el("span", {}, "RabbitPay")), nav),
		accountMenu(
			getUsername() ?? t("account.title"),
			[
				{ links, compactOnly: true },
				{
					links: [
						{ label: t("account.title"), href: "/account", current: window.location.pathname === "/account" },
						{ label: t("portal.title"), href: "/customer" },
						{ label: t("shortcuts.open"), hint: "F1", onSelect: showShortcutModal },
					],
				},
			],
			() => void signOut()
		)
	);
}

function isStorefront(path: string): boolean {
	if (path.startsWith("/shop/")) return true;
	return domainSlug !== null && !path.startsWith("/customer") && !path.startsWith("/pay/");
}

function isStandalone(): boolean {
	const path = window.location.pathname;
	return (
		isStorefront(path) ||
		path === "/customer" ||
		path.startsWith("/customer/") ||
		path.startsWith("/pay/") ||
		path === "/legal" ||
		path === "/terms" ||
		path === "/privacy" ||
		path.endsWith("/print") ||
		/^\/projects\/[^/]+\/pos$/.test(path)
	);
}

function mountShell() {
	const path = window.location.pathname;
	const storefront = isStorefront(path);
	if (!path.startsWith("/projects/") && !path.startsWith("/pay/") && !storefront) applyAccent(null);
	if (!path.startsWith("/pay/") && !path.endsWith("/print") && !storefront) resetBranding();

	const chrome = getToken() !== null && !isStandalone();
	shell.replaceChildren(...(chrome ? [header(), outlet] : [outlet]));
}

function notFoundView(): HTMLElement {
	return el(
		"div",
		{ class: "page" },
		el("h1", {}, t("app.not_found_title")),
		el("p", { class: "muted" }, t("app.not_found_body")),
		el("a", { class: "button primary", href: "/" }, t("app.back_to_projects"))
	);
}

function failureView(error: unknown): HTMLElement {
	const message = error instanceof ApiError ? error.message : t("app.failed_body");
	const customer = window.location.pathname === "/customer" || window.location.pathname.startsWith("/customer/");

	return el(
		"div",
		{ class: "page" },
		el("h1", {}, t("app.failed_title")),
		el("p", { class: "muted" }, message),
		el("a", { class: "button ghost", href: customer ? "/customer" : "/" }, t(customer ? "portal.back" : "app.back_to_projects"))
	);
}

define(
	"/projects/:uuid/expenses",
	projectRoute([Permission.EXPENSE_VIEW], (params) => expensesView(params.uuid))
);

function shop(render: () => Promise<HTMLElement>): Promise<HTMLElement> {
	return render().catch((error) => storeError(error));
}

function storefrontRoutes(prefix: string, slugOf: (params: Record<string, string>) => string) {
	define(prefix || "/", (params) => shop(() => homeView(slugOf(params))), false);
	define(`${prefix}/c/:category`, (params) => shop(() => categoryView(slugOf(params), params.category)), false);
	define(`${prefix}/p/:product`, (params) => shop(() => productView(slugOf(params), params.product)), false);
	define(`${prefix}/search`, (params) => shop(() => searchView(slugOf(params))), false);
	define(`${prefix}/cart`, (params) => shop(() => cartView(slugOf(params))), false);
	define(`${prefix}/checkout`, (params) => shop(() => checkoutView(slugOf(params))), false);
	define(`${prefix}/order/:invoice`, (params) => shop(() => orderView(slugOf(params), params.invoice)), false);
	define(`${prefix}/page/:page`, (params) => shop(() => pageView(slugOf(params), params.page)), false);
	define(`${prefix}/account`, (params) => shop(() => shopAccountView(slugOf(params))), false);
}

if (domainSlug) storefrontRoutes("", () => domainSlug);
storefrontRoutes("/shop/:slug", (params) => params.slug);

define("/login", () => loginView(), false);
define("/legal", () => legalNoticeView(), false);
define("/terms", () => legalDocumentView("terms"), false);
define("/privacy", () => legalDocumentView("privacy"), false);
define("/customer/login", () => customerLoginView(), false);
define("/customer", () => customerRoute(customerInvoicesView), false);
define("/customer/invoices/:invoice", (params) => customerRoute(() => customerInvoiceView(params.invoice)), false);
define("/customer/credit-notes/:note", (params) => customerRoute(() => customerCreditNoteView(params.note)), false);
define("/customer/orders", () => customerOrdersView(), false);
define("/customer/profile", () => customerProfileView(), false);
define("/customer/tickets", () => customerRoute(customerTicketsView), false);
define("/customer/tickets/:ticket", (params) => customerRoute(() => customerTicketView(params.ticket)), false);
define("/pay/:invoice", (params) => payView(params.invoice), false);
define("/invite/:token", (params) => inviteView(params.token), false);
define(
	"/",
	() => {
		if (getToken() !== null) return projectsView();
		if (landingEnabled()) return landingView();
		navigate("/login", true);
		return el("div");
	},
	false
);
define("/account", () => accountView());
define("/converter", () => converterView());
define("/admin", () => adminOverviewView());
define("/admin/licenses", () => adminLicensesView());
define("/admin/projects", () => adminProjectsView());
define("/admin/accounts", () => adminAccountsView());
define("/admin/invites", () => adminInvitesView());
define("/admin/settings", () => adminSettingsView());
define("/admin/legal", () => adminLegalView());

type ProjectRender = (params: Record<string, string>) => Promise<HTMLElement>;

function guarded(permissions: Permission[], render: ProjectRender): ProjectRender {
	return async (params) => {
		const project = await loadProject(params.uuid);
		return canAny(project, permissions) ? render(params) : noAccessView(project);
	};
}

function projectRoute(permissions: Permission[], render: ProjectRender): ProjectRender {
	return async (params) => {
		const project = await loadProject(params.uuid);
		if (sellsOnly(project)) {
			history.replaceState({}, "", terminalPath(params.uuid));
			return posView(params.uuid);
		}
		return canAny(project, permissions) ? render(params) : noAccessView(project);
	};
}

define(
	"/projects/:uuid",
	projectRoute([Permission.PROJECT_VIEW], async (params) => {
		const project = await loadProject(params.uuid);
		if (worksOnly(project) && (project.workforce || project.workforce_until !== null)) {
			history.replaceState({}, "", timesheetPath(params.uuid));
			return timesheetView(params.uuid);
		}
		return overviewView(params.uuid);
	})
);
define(
	"/projects/:uuid/timesheet",
	projectRoute([Permission.TIMESHEET_OWN, Permission.TIMESHEET_VIEW], (params) => timesheetView(params.uuid))
);
define(
	"/projects/:uuid/timesheet/absences",
	projectRoute([Permission.TIMESHEET_OWN, Permission.TIMESHEET_VIEW], (params) => absencesView(params.uuid))
);
define(
	"/projects/:uuid/timesheet/report",
	projectRoute([Permission.TIMESHEET_OWN, Permission.TIMESHEET_VIEW], (params) => timesheetReportView(params.uuid))
);
define(
	"/projects/:uuid/timesheet/settings",
	projectRoute([Permission.TIMESHEET_EDIT], (params) => timesheetSettingsView(params.uuid))
);
define(
	"/projects/:uuid/tickets",
	projectRoute([Permission.TICKET_VIEW], (params) => ticketsView(params.uuid))
);
define(
	"/projects/:uuid/tickets/:ticket",
	projectRoute([Permission.TICKET_VIEW], (params) => ticketView(params.uuid, params.ticket))
);
define(
	"/projects/:uuid/employees",
	projectRoute([Permission.EMPLOYEE_VIEW], (params) => employeesView(params.uuid))
);
define(
	"/projects/:uuid/payroll",
	projectRoute([Permission.EMPLOYEE_VIEW], (params) => payrollRunsView(params.uuid))
);
define(
	"/projects/:uuid/payroll/rates",
	projectRoute([Permission.EMPLOYEE_VIEW], (params) => payrollRatesView(params.uuid))
);
define(
	"/projects/:uuid/payroll/:run",
	projectRoute([Permission.EMPLOYEE_VIEW], (params) => payrollRunView(params.uuid, params.run))
);
define(
	"/projects/:uuid/invoices",
	projectRoute([Permission.INVOICE_VIEW], (params) => invoicesView(params.uuid))
);
define(
	"/projects/:uuid/invoices/new",
	projectRoute([Permission.INVOICE_CREATE], (params) => newInvoiceView(params.uuid))
);
define(
	"/projects/:uuid/invoices/:invoice",
	projectRoute([Permission.INVOICE_VIEW], (params) => invoiceView(params.uuid, params.invoice))
);
define(
	"/projects/:uuid/invoices/:invoice/edit",
	projectRoute([Permission.INVOICE_EDIT], (params) => editInvoiceView(params.uuid, params.invoice))
);
define(
	"/projects/:uuid/invoices/:invoice/print",
	guarded([Permission.INVOICE_VIEW], (params) => printView(params.uuid, params.invoice))
);
define(
	"/projects/:uuid/pos/sales/:sale/print",
	guarded([Permission.POS_SELL], (params) => printView(params.uuid, params.sale, true))
);
define(
	"/projects/:uuid/credit-notes/:note/print",
	guarded([Permission.INVOICE_VIEW], (params) => creditNotePrintView(params.uuid, params.note))
);
define(
	"/projects/:uuid/recurring",
	projectRoute([Permission.SUBSCRIPTION_VIEW], (params) => recurringListView(params.uuid))
);
define(
	"/projects/:uuid/recurring/new",
	projectRoute([Permission.SUBSCRIPTION_CREATE], (params) => recurringFormView(params.uuid, null))
);
define(
	"/projects/:uuid/recurring/:recurring",
	projectRoute([Permission.SUBSCRIPTION_VIEW], (params) => recurringView(params.uuid, params.recurring))
);
define(
	"/projects/:uuid/recurring/:recurring/edit",
	projectRoute([Permission.SUBSCRIPTION_EDIT], (params) => recurringFormView(params.uuid, params.recurring))
);
define(
	"/projects/:uuid/transactions",
	projectRoute([Permission.PAYMENT_VIEW], (params) => transactionsView(params.uuid))
);
define(
	"/projects/:uuid/customers",
	projectRoute([Permission.CUSTOMER_VIEW], (params) => customersView(params.uuid))
);
define(
	"/projects/:uuid/customers/:customer",
	projectRoute([Permission.CUSTOMER_VIEW], (params) => customerView(params.uuid, params.customer))
);
define(
	"/projects/:uuid/items",
	projectRoute([Permission.ITEM_VIEW], (params) => itemsView(params.uuid))
);
define(
	"/projects/:uuid/store",
	projectRoute([Permission.PROJECT_VIEW], (params) => storeSettingsView(params.uuid))
);
define(
	"/projects/:uuid/store/products",
	projectRoute([Permission.ITEM_VIEW], (params) => storeProductsView(params.uuid))
);
define(
	"/projects/:uuid/store/products/:item",
	projectRoute([Permission.ITEM_VIEW], (params) => storeProductView(params.uuid, params.item))
);
define(
	"/projects/:uuid/store/categories",
	projectRoute([Permission.ITEM_VIEW], (params) => storeCategoriesView(params.uuid))
);
define(
	"/projects/:uuid/store/coupons",
	projectRoute([Permission.ITEM_VIEW], (params) => storeCouponsView(params.uuid))
);
define(
	"/projects/:uuid/store/translations",
	projectRoute([Permission.PROJECT_VIEW], (params) => storeTranslationsView(params.uuid))
);
define(
	"/projects/:uuid/store/translations/:language",
	projectRoute([Permission.PROJECT_VIEW], (params) => storeTranslationView(params.uuid, params.language))
);
define(
	"/projects/:uuid/store/orders",
	projectRoute([Permission.INVOICE_VIEW], (params) => storeOrdersView(params.uuid))
);
define(
	"/projects/:uuid/store/orders/:invoice",
	projectRoute([Permission.INVOICE_VIEW], (params) => storeOrderView(params.uuid, params.invoice))
);
define(
	"/projects/:uuid/statistics",
	projectRoute([Permission.REPORT_VIEW], (params) => statisticsView(params.uuid))
);
define(
	"/projects/:uuid/members",
	projectRoute([Permission.PROJECT_VIEW], (params) => membersView(params.uuid))
);
define(
	"/projects/:uuid/pos",
	guarded([Permission.POS_SELL], (params) => posView(params.uuid))
);
define(
	"/projects/:uuid/license",
	projectRoute(LICENSE_PERMISSIONS, (params) => licenseView(params.uuid))
);
define(
	"/projects/:uuid/settings",
	projectRoute(SETTINGS_PERMISSIONS, (params) => settingsView(params.uuid))
);

configure({
	outlet,
	notFound: notFoundView,
	guard: () => getToken() !== null,
	afterRender: () => {
		mountShell();
		handleShortcutRender();
	},
});
setErrorView(failureView);

setUnauthorizedHandler(() => {
	if (window.location.pathname === "/customer" || window.location.pathname.startsWith("/customer/")) return;
	if (isStorefront(window.location.pathname)) return;
	toast(t("app.session_expired"), "error");
	navigate("/login", true);
});

document.documentElement.lang = language();
applyTheme();

root.appendChild(shell);
mountShell();
installKeyboardShortcuts();
installSelectPicker();
start();

void checkPendingTerms().then((refreshed) => {
	if (refreshed) mountShell();
});
