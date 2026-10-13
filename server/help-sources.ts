import gettingStartedEn from "../docs/help/en/getting-started/index.md" with { type: "text" };
import gettingStartedSl from "../docs/help/sl/getting-started/index.md" with { type: "text" };
import gettingStartedCreateAccountEn from "../docs/help/en/getting-started/create-account.md" with { type: "text" };
import gettingStartedCreateAccountSl from "../docs/help/sl/getting-started/create-account.md" with { type: "text" };
import gettingStartedSecureYourAccountEn from "../docs/help/en/getting-started/secure-your-account.md" with { type: "text" };
import gettingStartedSecureYourAccountSl from "../docs/help/sl/getting-started/secure-your-account.md" with { type: "text" };
import gettingStartedCreateProjectEn from "../docs/help/en/getting-started/create-project.md" with { type: "text" };
import gettingStartedCreateProjectSl from "../docs/help/sl/getting-started/create-project.md" with { type: "text" };
import gettingStartedFindYourWayEn from "../docs/help/en/getting-started/find-your-way.md" with { type: "text" };
import gettingStartedFindYourWaySl from "../docs/help/sl/getting-started/find-your-way.md" with { type: "text" };
import gettingStartedCompanyDetailsEn from "../docs/help/en/getting-started/company-details.md" with { type: "text" };
import gettingStartedCompanyDetailsSl from "../docs/help/sl/getting-started/company-details.md" with { type: "text" };
import gettingStartedFirstInvoiceEn from "../docs/help/en/getting-started/first-invoice.md" with { type: "text" };
import gettingStartedFirstInvoiceSl from "../docs/help/sl/getting-started/first-invoice.md" with { type: "text" };
import gettingStartedInviteTeamEn from "../docs/help/en/getting-started/invite-team.md" with { type: "text" };
import gettingStartedInviteTeamSl from "../docs/help/sl/getting-started/invite-team.md" with { type: "text" };
import gettingStartedNotificationsEn from "../docs/help/en/getting-started/notifications.md" with { type: "text" };
import gettingStartedNotificationsSl from "../docs/help/sl/getting-started/notifications.md" with { type: "text" };
import gettingStartedLicensesEn from "../docs/help/en/getting-started/licenses.md" with { type: "text" };
import gettingStartedLicensesSl from "../docs/help/sl/getting-started/licenses.md" with { type: "text" };
import invoicesEn from "../docs/help/en/invoices/index.md" with { type: "text" };
import invoicesSl from "../docs/help/sl/invoices/index.md" with { type: "text" };
import paymentsEn from "../docs/help/en/payments/index.md" with { type: "text" };
import paymentsSl from "../docs/help/sl/payments/index.md" with { type: "text" };
import expensesAndReportsEn from "../docs/help/en/expenses-and-reports/index.md" with { type: "text" };
import expensesAndReportsSl from "../docs/help/sl/expenses-and-reports/index.md" with { type: "text" };
import onlineStoreEn from "../docs/help/en/online-store/index.md" with { type: "text" };
import onlineStoreSl from "../docs/help/sl/online-store/index.md" with { type: "text" };
import inventoryEn from "../docs/help/en/inventory/index.md" with { type: "text" };
import inventorySl from "../docs/help/sl/inventory/index.md" with { type: "text" };
import customerPortalEn from "../docs/help/en/customer-portal/index.md" with { type: "text" };
import customerPortalSl from "../docs/help/sl/customer-portal/index.md" with { type: "text" };
import workforceEn from "../docs/help/en/workforce/index.md" with { type: "text" };
import workforceSl from "../docs/help/sl/workforce/index.md" with { type: "text" };
import sloveniaEn from "../docs/help/en/slovenia/index.md" with { type: "text" };
import sloveniaSl from "../docs/help/sl/slovenia/index.md" with { type: "text" };

export interface HelpPageSource {
	slug: string;
	en: string;
	sl: string;
}

export interface HelpModuleSource extends HelpPageSource {
	pages: HelpPageSource[];
}

export const HELP_SOURCES: HelpModuleSource[] = [
	{
		slug: "getting-started",
		en: gettingStartedEn,
		sl: gettingStartedSl,
		pages: [
			{ slug: "create-account", en: gettingStartedCreateAccountEn, sl: gettingStartedCreateAccountSl },
			{ slug: "secure-your-account", en: gettingStartedSecureYourAccountEn, sl: gettingStartedSecureYourAccountSl },
			{ slug: "create-project", en: gettingStartedCreateProjectEn, sl: gettingStartedCreateProjectSl },
			{ slug: "find-your-way", en: gettingStartedFindYourWayEn, sl: gettingStartedFindYourWaySl },
			{ slug: "company-details", en: gettingStartedCompanyDetailsEn, sl: gettingStartedCompanyDetailsSl },
			{ slug: "first-invoice", en: gettingStartedFirstInvoiceEn, sl: gettingStartedFirstInvoiceSl },
			{ slug: "invite-team", en: gettingStartedInviteTeamEn, sl: gettingStartedInviteTeamSl },
			{ slug: "notifications", en: gettingStartedNotificationsEn, sl: gettingStartedNotificationsSl },
			{ slug: "licenses", en: gettingStartedLicensesEn, sl: gettingStartedLicensesSl },
		],
	},
	{ slug: "invoices", en: invoicesEn, sl: invoicesSl, pages: [] },
	{ slug: "payments", en: paymentsEn, sl: paymentsSl, pages: [] },
	{ slug: "expenses-and-reports", en: expensesAndReportsEn, sl: expensesAndReportsSl, pages: [] },
	{ slug: "online-store", en: onlineStoreEn, sl: onlineStoreSl, pages: [] },
	{ slug: "inventory", en: inventoryEn, sl: inventorySl, pages: [] },
	{ slug: "customer-portal", en: customerPortalEn, sl: customerPortalSl, pages: [] },
	{ slug: "workforce", en: workforceEn, sl: workforceSl, pages: [] },
	{ slug: "slovenia", en: sloveniaEn, sl: sloveniaSl, pages: [] },
];
