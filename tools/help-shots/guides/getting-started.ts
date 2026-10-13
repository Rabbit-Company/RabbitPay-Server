import { ACCOUNT_MENU, currentCode, fillSignIn, projectPath, signOut } from "../actions";
import type { Session } from "../demo";
import type { Guide } from "../run";
import type { Studio } from "../studio";

async function createAccount(studio: Studio, session: Session) {
	const { browser } = studio;
	const { owner } = session.demo;
	const page = "create-account";

	await studio.open(studio.language === "en" ? "/" : `/${studio.language}`);
	await studio.shot(page, "home", { mark: `link:${studio.t("landing.get_started")}` });

	await studio.open("/login?mode=register");
	await browser.fill(`field:${studio.t("login.email")}`, owner.email);
	await browser.fill(`field:${studio.t("login.password")}`, owner.password);
	await browser.click(".legal-accept input");
	await browser.blur();
	await studio.shot(page, "register", { target: ".auth-card", mark: `button:${studio.t("login.create_account")}` });

	await browser.click(`button:${studio.t("login.create_account")}`, 1500);
	await browser.waitFor(".page-head h1");
	await studio.shot(page, "signed-in");

	await browser.click(ACCOUNT_MENU);
	await studio.shot(page, "sign-out", { mark: `menu:${studio.t("app.sign_out")}` });
	await browser.click(`menu:${studio.t("app.sign_out")}`, 1000);

	await fillSignIn(studio, session);
	await studio.shot(page, "sign-in", { target: ".auth-card", mark: `.auth-card button[type=submit]` });
	await studio.shot(page, "forgot-password", { target: ".auth-card", mark: ".auth-forgot" });

	await browser.click(".auth-forgot", 800);
	await browser.fill(`field:${studio.t("login.email")}`, owner.email);
	await browser.blur();
	await studio.shot(page, "request-link", { target: ".auth-card", mark: `button:${studio.t("account.password_reset_send")}` });
	await browser.click(`button:${studio.t("account.password_reset_send")}`, 1500);
	await studio.shot(page, "link-sent", { target: ".auth-card" });

	await studio.open(studio.linkFromEmail("/account/password"), 1000);
	await browser.fill(`field:${studio.t("account.password_new")}`, owner.password);
	await browser.fill(`field:${studio.t("account.password_repeat")}`, owner.password);
	await browser.blur();
	await studio.shot(page, "choose-password", { target: ".auth-card", mark: `button:${studio.t("account.password_choose")}` });

	await fillSignIn(studio, session);
	await browser.click(".auth-card button[type=submit]", 1500);
	await browser.waitFor(".page-head h1");
}

async function secureAccount(studio: Studio, session: Session) {
	const { browser } = studio;
	const { owner } = session.demo;
	const page = "secure-your-account";
	const password = `field:${studio.t("login.password")}`;

	await browser.click(ACCOUNT_MENU);
	await studio.shot(page, "open-account-security", { mark: `menu:${studio.t("account.title")}` });
	await studio.open("/account");

	const authenticator = `card:${studio.t("account.authenticator_title")}`;
	await studio.shot(page, "set-up-authenticator", { target: authenticator, mark: `button:${studio.t("account.setup")}` });
	await browser.click(`button:${studio.t("account.setup")}`, 1200);
	const setup = `card:${studio.t("account.setup_title")}`;
	await browser.waitFor(setup);
	session.totpSecret = await browser.eval<string>(`window.__helpShots.find(${JSON.stringify(setup)}).querySelector("code").textContent.trim()`);
	await studio.shot(page, "scan-code", { target: setup });

	await browser.fill(`${setup} >> ${password}`, owner.password);
	await browser.fill(`${setup} >> field:${studio.t("account.authenticator_code")}`, await currentCode(session));
	await browser.blur();
	await studio.shot(page, "confirm-code", { target: setup, mark: `button:${studio.t("account.enable")}` });
	await browser.click(`button:${studio.t("account.enable")}`, 1500);

	const recovery = `card:${studio.t("account.recovery_title")}`;
	await browser.waitFor(recovery);
	await studio.shot(page, "recovery-codes", { target: recovery, mark: `button:${studio.t("account.copy_recovery")}` });
	await studio.shot(page, "enabled", { target: `card:${studio.t("account.two_factor_title")}` });

	await signOut(studio);
	await fillSignIn(studio, session);
	await browser.click(".auth-card button[type=submit]", 1200);
	await browser.fill(`field:${studio.t("login.two_factor_code")}`, await currentCode(session));
	await browser.blur();
	await studio.shot(page, "sign-in-code", { target: ".auth-card", mark: `field:${studio.t("login.two_factor_code")}` });
	await browser.click(".auth-card button[type=submit]", 1500);
	await browser.waitFor(".app-header");

	await browser.send("WebAuthn.enable");
	await browser.send("WebAuthn.addVirtualAuthenticator", {
		options: { protocol: "ctap2", transport: "usb", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
	});
	await studio.open("/account");
	const keys = `card:${studio.t("security_key.title")}`;
	await browser.fill(`${keys} >> field:${studio.t("security_key.name")}`, "YubiKey 5C");
	await browser.fill(`${keys} >> ${password}`, owner.password);
	await browser.blur();
	await studio.shot(page, "add-security-key", { target: keys, mark: `button:${studio.t("security_key.add")}` });
	await browser.click(`button:${studio.t("security_key.add")}`, 2000);
	await studio.shot(page, "security-key-added", { target: keys });
	await studio.shot(page, "change-password", { target: `card:${studio.t("account.password_title")}` });
	await studio.shot(page, "account-security", { full: true });
}

async function createProject(studio: Studio, session: Session) {
	const { browser } = studio;
	const { demo } = session;
	const page = "create-project";

	await studio.open("/");
	await browser.waitFor(".page-head h1");
	await studio.shot(page, "projects-empty", { mark: `.page-head >> button:${studio.t("projects.new")}` });

	await browser.click(`.page-head >> button:${studio.t("projects.new")}`);
	await browser.fill(`.dialog >> field:${studio.t("projects.business_name")}`, demo.displayName);
	await browser.blur();
	await studio.shot(page, "new-project", { target: ".dialog", padding: 32, mark: `button:${studio.t("projects.create")}` });
	await browser.click(`button:${studio.t("projects.create")}`, 1500);
	await browser.waitFor(".project-nav");
	session.project = (await browser.eval<string>(`location.pathname`)).split("/")[2];
	await studio.shot(page, "overview");

	await studio.open("/");
	await browser.waitFor(".project-card");
	await studio.shot(page, "project-card", { mark: ".project-card" });

	await studio.open(projectPath(session, "/settings"), 1500);
	const details = `card:${studio.t("customer.details")}`;
	await studio.shot(page, "details", { target: details });

	const keys = `card:${studio.t("settings.api_keys")}`;
	await studio.shot(page, "api-keys", { target: keys });
}

async function findYourWay(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "find-your-way";

	await studio.open(projectPath(session), 1200);
	await studio.shot(page, "top-bar", { target: ".app-header", padding: 0 });
	await studio.shot(page, "project-menu", { full: true, mark: ".project-nav" });
	await studio.shot(page, "all-projects", { target: ".page-head", mark: ".back-link" });

	await browser.click(ACCOUNT_MENU);
	await studio.shot(page, "account-menu", { target: [ACCOUNT_MENU, ".menu-panel"], padding: 24 });
	await studio.shot(page, "theme-and-language", { target: [ACCOUNT_MENU, ".menu-panel"], padding: 24, mark: ".menu-panel .menu-section:has(.menu-setting)" });
	await browser.press("Escape", 27);

	await browser.press("F1", 112);
	await browser.waitFor(".shortcut-list");
	await studio.shot(page, "keyboard-shortcuts", { target: ".dialog", padding: 32 });
	await browser.press("Escape", 27);

	await browser.viewport(390, 780);
	await studio.open(projectPath(session), 1200);
	await studio.shot(page, "phone");
	await browser.click(".project-nav-toggle");
	await studio.shot(page, "phone-menu");
	await browser.viewport(1280, 800);
}

async function companyDetails(studio: Studio, session: Session) {
	const { browser } = studio;
	const { company } = session.demo;
	const page = "company-details";

	await studio.open(projectPath(session, "/settings"), 1500);
	await studio.shot(page, "open-settings", { mark: `.project-nav >> link:${studio.t("nav.settings")}` });

	const invoiceCard = `card:${studio.t("payments.invoice")}`;
	await browser.choose(`${invoiceCard} >> field:${studio.t("app.language")}`, studio.language);
	await browser.choose(`${invoiceCard} >> field:${studio.t("settings.date_format")}`, session.demo.dateFormat);
	await browser.fill(`${invoiceCard} >> field:${studio.t("settings.timezone")}`, session.demo.timezone);
	await browser.blur();
	await studio.shot(page, "invoice-language", { target: invoiceCard, mark: `button:${studio.t("settings.save_invoice")}` });
	await browser.click(`button:${studio.t("settings.save_invoice")}`, 1000);
	await studio.open(projectPath(session, "/settings"), 1500);

	const card = `card:${studio.t("settings.company")}`;
	const input = (key: Parameters<Studio["t"]>[0]) => `${card} >> field:${studio.t(key)}`;
	if (company.country === "SI") {
		await browser.fill(input("settings.legal_name"), company.search);
		await browser.waitFor(".combo-option");
		await studio.shot(page, "find-company", { target: card, mark: ".combo-option" });
		await browser.click(".combo-option", 800);
	} else {
		await browser.fill(input("settings.legal_name"), company.legalName);
		await browser.fill(input("customers.address"), company.address);
		await browser.fill(input("customers.postal_code"), company.postalCode);
		await browser.fill(input("customers.city"), company.city);
		await browser.pick(input("customers.country"), company.countryName);
		await browser.fill(input("customers.vat_number"), company.vatNumber);
		await browser.fill(input("settings.tax_number"), company.taxNumber);
		await browser.fill(input("settings.registration_number"), company.registrationNumber);
	}
	await browser.fill(input("customers.email"), company.email);
	await browser.fill(input("customers.phone"), company.phone);
	await browser.fill(input("settings.website"), company.website);
	await browser.blur();
	if (await browser.exists(`${card} >> button:${studio.t("settings.disclosure_add")}`)) {
		await studio.shot(page, "register-entry", { target: card, mark: `button:${studio.t("settings.disclosure_add")}` });
		await browser.click(`button:${studio.t("settings.disclosure_add")}`);
		const footer = `${card} >> textarea`;
		const text = await browser.eval<string>(`window.__helpShots.find(${JSON.stringify(footer)}).value`);
		await browser.fill(
			footer,
			company.footer.reduce((filled, value) => filled.replace("___", value), text)
		);
		await browser.blur();
	}
	await studio.shot(page, "company-details", { target: card, mark: `button:${studio.t("settings.save_company")}` });
	await browser.click(`button:${studio.t("settings.save_company")}`, 1000);

	await studio.open(projectPath(session, "/settings"), 1500);
	const tax = `card:${studio.t("settings.tax")}`;
	await browser.pick(`${tax} >> field:${studio.t("settings.tax_country")}`, company.countryName);
	await browser.choose(`${tax} >> field:${studio.t("settings.vat_status")}`, "registered");
	await browser.blur();
	await studio.shot(page, "tax", { target: tax, mark: `button:${studio.t("settings.save_tax")}` });
	await browser.click(`button:${studio.t("settings.save_tax")}`, 1000);
}

async function firstInvoice(studio: Studio, session: Session) {
	const { browser } = studio;
	const { company, customer, service } = session.demo;
	const page = "first-invoice";

	await studio.open(projectPath(session, "/settings"), 1500);
	const bank = `processor:${studio.t("processor.bank_transfer")}`;
	const bankField = (label: string) => `${bank} >> field:${label}`;
	await browser.fill(bankField("IBAN"), session.demo.iban);
	await browser.fill(bankField(studio.t("field.bank_transfer.bic")), session.demo.bic);
	await browser.fill(bankField(studio.t("field.bank_transfer.bank_name")), session.demo.bank);
	await browser.blur();
	await studio.shot(page, "bank-transfer", { target: bank, mark: `${bank} >> button[type=submit]` });
	await browser.click(`${bank} >> button[type=submit]`, 1200);
	if (!(await browser.eval<boolean>(`window.__helpShots.find(${JSON.stringify(bank)}).querySelector(".switch input").checked`))) {
		await browser.click(`${bank} >> .switch`, 1200);
	}
	await studio.shot(page, "bank-transfer-on", { target: `${bank} >> .processor-head`, mark: `${bank} >> .switch` });

	await studio.open(projectPath(session, "/invoices"), 1200);
	await studio.shot(page, "invoices-empty", { mark: `button:${studio.t("invoices.new")}` });
	await browser.click(`button:${studio.t("invoices.new")}`, 1200);
	await browser.click(".combo-input");
	await studio.shot(page, "add-customer", { mark: ".combo-action" });
	await browser.click(".combo-action", 800);

	const dialogField = (key: Parameters<Studio["t"]>[0]) => `.dialog >> field:${studio.t(key)}`;
	if (company.country === "SI") {
		await browser.fill(dialogField("customers.name"), customer.search);
		await browser.waitFor(".dialog .combo-option");
		await studio.shot(page, "find-customer", { target: ".dialog", padding: 32, mark: ".dialog .combo-option" });
		await browser.click(".dialog .combo-option", 800);
	} else {
		await browser.fill(dialogField("customers.name"), customer.name);
		await browser.click(".dialog h2");
		await browser.fill(dialogField("customers.address"), customer.address);
		await browser.fill(dialogField("customers.city"), customer.city);
		await browser.fill(dialogField("customers.postal_code"), customer.postalCode);
		await browser.pick(dialogField("customers.country"), customer.countryName);
	}
	await browser.fill(dialogField("customers.email"), customer.email);
	await browser.choose(dialogField("customers.type"), "business");
	await browser.blur();
	await studio.shot(page, "new-customer", { target: ".dialog", padding: 32, mark: `button:${studio.t("customers.create")}` });
	await browser.click(`button:${studio.t("customers.create")}`, 1500);

	await browser.fill(".item-row .combo-input", service.description);
	await browser.click(`card:${studio.t("editor.line_items")} >> h2`);
	await browser.fill(".item-row > input:nth-child(4)", service.price);
	await browser.blur();
	await studio.shot(page, "invoice-form", { target: ".project-content", mark: `button:${studio.t("invoices.create_and_issue")}` });
	await studio.shot(page, "line-items", { target: `card:${studio.t("editor.line_items")}` });
	await browser.click(`button:${studio.t("invoices.create_and_issue")}`, 2500);
	await browser.waitFor(`button:${studio.t("invoices.menu_send")}`);
	await studio.shot(page, "invoice-issued", { target: ".project-content" });
	const invoice = (await browser.eval<string>(`location.pathname`)).split("/").pop();

	await browser.click(`button:${studio.t("invoices.menu_send")}`);
	await studio.shot(page, "send-menu", { mark: `menu:${studio.t("invoices.email_invoice")}` });
	await browser.click(`menu:${studio.t("invoices.email_invoice")}`, 1000);
	await studio.shot(page, "email-invoice", { target: ".dialog", padding: 32, mark: `button:${studio.t("invoices.send_invoice")}` });
	await browser.click(`button:${studio.t("invoices.send_invoice")}`, 1500);

	await studio.open(`/pay/${invoice}`, 1500);
	await studio.shot(page, "payment-page", { full: true });
	await studio.open(projectPath(session), 1000);
}

async function inviteTeam(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "invite-team";
	const [accountant] = session.demo.teammates;

	await studio.open(projectPath(session, "/members"), 1200);
	await studio.shot(page, "team", { target: ".project-content", mark: `button:${studio.t("members.invite")}` });
	await browser.click(`button:${studio.t("members.invite")}`);
	await browser.fill(`.dialog >> field:${studio.t("login.email")}`, accountant.email);
	await browser.choose(`.dialog >> field:${studio.t("members.role")}`, "accountant");
	await browser.blur();
	await studio.shot(page, "invite", { target: ".dialog", padding: 32, mark: `button:${studio.t("members.send_invite")}` });
	await browser.click(`button:${studio.t("members.send_invite")}`, 1500);
	await studio.shot(page, "invitation-link", { target: ".dialog", padding: 32 });
	await browser.click(".dialog .icon-button");
	await studio.shot(page, "invited", { target: ".project-content" });
}

async function notifications(studio: Studio) {
	const { browser } = studio;
	const page = "notifications";

	await studio.open("/", 800);
	await browser.click(ACCOUNT_MENU);
	await studio.shot(page, "open-notifications", { target: [ACCOUNT_MENU, ".menu-panel"], padding: 24, mark: `menu:${studio.t("notifications.title")}` });
	await studio.open("/account/notifications", 1200);
	await studio.shot(page, "channels", { target: ".notify-channels" });
	await studio.shot(page, "choices", { target: [".notify-toolbar", ".notify-group"] });
	await studio.shot(page, "notifications", { target: ".notify-content" });
}

async function licenses(studio: Studio, session: Session) {
	const page = "licenses";
	await studio.open(projectPath(session, "/license"), 1500);
	await studio.shot(page, "open-license", { mark: `.project-nav >> link:${studio.t("nav.license")}` });
	await studio.shot(page, "timeline", { target: `card:${studio.t("license.timeline")}` });
	await studio.shot(page, "payments", { target: `card:${studio.t("license.payments_this_month")}` });
	await studio.shot(page, "redeem", { target: `card:${studio.t("license.redeem_title")}` });
}

export const gettingStarted: Guide = {
	module: "getting-started",
	steps: [
		["create-account", createAccount],
		["secure-your-account", secureAccount],
		["create-project", createProject],
		["find-your-way", findYourWay],
		["company-details", companyDetails],
		["first-invoice", firstInvoice],
		["invite-team", inviteTeam],
		["notifications", notifications],
		["licenses", licenses],
	],
};
