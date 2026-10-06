import { Api, type LegalInfo, type RegistrationMode } from "../api";
import { el } from "../dom";
import { DEFAULT_UI_LANGUAGE, t, type UiKey, type UiLanguage } from "../i18n";
import { navigate } from "../router";
import { languageSwitcher } from "../language";
import { logo } from "../logo";
import { themeSwitcher } from "../theme-switcher";
import { legalInfo, legalLinks } from "./legal";

const REPOSITORY = "https://github.com/Rabbit-Company/RabbitPay-Server";

const ICONS: Record<string, string> = {
	invoice: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
	repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
	portal: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
	store: '<path d="M6 7h12l1 14H5Z"/><path d="M9 10V6a3 3 0 0 1 6 0v4"/>',
	terminal: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 6h6M9 11h.01M12 11h.01M15 11h.01M9 15h.01M12 15h.01M15 15h.01M9 18h6"/>',
	chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
	team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
	clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
	code: '<path d="M8 8l-5 4 5 4M16 8l5 4-5 4M14 4l-4 16"/>',
	card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
	wallet: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/><path d="M21 9h-5a3 3 0 0 0 0 6h5Z"/>',
	bank: '<path d="M3 10l9-6 9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18"/>',
	bitcoin:
		'<circle cx="12" cy="12" r="9"/><path d="M9.5 7.5h4a2 2 0 0 1 0 4h-4Zm0 4h4.5a2 2 0 0 1 0 4H9.5ZM9.5 7.5v8M11 6v1.5M11 15.5V17M13 6v1.5M13 15.5V17"/>',
	ethereum: '<path d="M12 2l6.5 10.5L12 16l-6.5-3.5Z"/><path d="M5.5 14.5 12 22l6.5-7.5L12 18Z"/>',
	monero: '<circle cx="12" cy="12" r="9"/><path d="M7 16V8l5 5 5-5v8"/>',
	shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6Z"/><path d="M9 12l2 2 4-4"/>',
	key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 20 3M16 7l3 3M14 9l2 2"/>',
	history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
	archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
	brush:
		'<path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L12 14.8 9.2 12Z"/><path d="M7 14.5c-2 0-3.5 1.5-3.5 3.5 0 1.2-.5 2-1.5 2.5 1 .5 2.5 1 4 1 2.5 0 4.5-2 4.5-4.5Z"/>',
	check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
	arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
	github:
		'<path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
};

function glyph(name: string, size = 22): HTMLElement {
	const node = el("span", { class: "landing-icon" });
	node.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
	return node;
}

export function landingPath(language: UiLanguage): string {
	return language === DEFAULT_UI_LANGUAGE ? "/" : `/${language}`;
}

function landingFlag(): HTMLMetaElement | null {
	return document.querySelector<HTMLMetaElement>('meta[name="rabbitpay-landing"]');
}

export function landingEnabled(): boolean {
	return landingFlag() !== null;
}

function licenseStore(): string | null {
	const value = landingFlag()?.dataset.licenseStore;
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
	} catch {
		return null;
	}
}

function allowance(key: "freePayments" | "freeStorage"): number | null {
	const value = landingFlag()?.dataset[key];
	return value ? Number(value) : null;
}

async function registrationMode(): Promise<RegistrationMode> {
	try {
		return (await Api.registration()).mode;
	} catch {
		return "closed";
	}
}

function jump(target: string, label: UiKey): HTMLElement {
	return el(
		"a",
		{
			href: `#${target}`,
			onClick: (event) => {
				event.preventDefault();
				document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
			},
		},
		t(label)
	);
}

function section(id: string, eyebrow: UiKey, title: UiKey, lead: UiKey | null, ...content: HTMLElement[]): HTMLElement {
	return el(
		"section",
		{ class: "landing-section", id },
		el(
			"div",
			{ class: "landing-heading" },
			el("p", { class: "landing-eyebrow" }, t(eyebrow)),
			el("h2", {}, t(title)),
			lead ? el("p", { class: "landing-lead" }, t(lead)) : null
		),
		...content
	);
}

function invoicePreview(): HTMLElement {
	const line = (label: UiKey, amount: string) => el("div", { class: "preview-line" }, el("span", {}, t(label)), el("span", { class: "mono" }, amount));

	const preview = el(
		"div",
		{ class: "landing-preview" },
		el(
			"div",
			{ class: "preview-invoice" },
			el(
				"div",
				{ class: "preview-top" },
				el("div", {}, el("span", { class: "preview-label" }, t("landing.preview_invoice")), el("strong", { class: "mono" }, "2609000042")),
				el("span", { class: "pill pill-active" }, t("landing.preview_paid"))
			),
			el("div", { class: "preview-customer" }, el("span", { class: "preview-label" }, t("landing.preview_billed_to")), el("strong", {}, "Northwind d.o.o.")),
			el(
				"div",
				{ class: "preview-lines" },
				line("landing.preview_hosting", "240.00"),
				line("landing.preview_domain", "15.00"),
				line("landing.preview_vat", "56.10")
			),
			el("div", { class: "preview-total" }, el("span", {}, t("landing.preview_total")), el("strong", { class: "mono" }, "311.10 EUR")),
			el(
				"div",
				{ class: "preview-methods" },
				...["card", "bank", "bitcoin", "ethereum", "monero"].map((name) =>
					el("span", { class: `preview-method${name === "monero" ? " selected" : ""}` }, glyph(name, 16))
				)
			)
		),
		el(
			"div",
			{ class: "preview-toast" },
			el("span", { class: "preview-toast-icon" }, glyph("check", 16)),
			el("div", {}, el("strong", {}, t("landing.preview_received")), el("span", { class: "muted" }, t("landing.preview_confirmations")))
		)
	);
	preview.setAttribute("aria-hidden", "true");
	return preview;
}

function paymentMethods(): HTMLElement {
	const methods: [string, UiKey, UiKey][] = [
		["card", "landing.pay_card", "landing.pay_card_body"],
		["wallet", "landing.pay_paypal", "landing.pay_paypal_body"],
		["bank", "landing.pay_bank", "landing.pay_bank_body"],
		["bitcoin", "landing.pay_bitcoin", "landing.pay_crypto_body"],
		["ethereum", "landing.pay_ethereum", "landing.pay_crypto_body"],
		["monero", "landing.pay_monero", "landing.pay_monero_body"],
	];
	return el(
		"div",
		{ class: "landing-methods" },
		...methods.map(([icon, title, body]) => el("div", { class: "landing-method" }, glyph(icon), el("div", {}, el("h3", {}, t(title)), el("p", {}, t(body)))))
	);
}

function features(): HTMLElement {
	const items: [string, UiKey, UiKey][] = [
		["invoice", "landing.feature_invoices", "landing.feature_invoices_body"],
		["repeat", "landing.feature_recurring", "landing.feature_recurring_body"],
		["portal", "landing.feature_portal", "landing.feature_portal_body"],
		["store", "landing.feature_store", "landing.feature_store_body"],
		["terminal", "landing.feature_pos", "landing.feature_pos_body"],
		["chart", "landing.feature_reports", "landing.feature_reports_body"],
		["team", "landing.feature_team", "landing.feature_team_body"],
		["clock", "landing.feature_workforce", "landing.feature_workforce_body"],
		["code", "landing.feature_api", "landing.feature_api_body"],
	];
	return el(
		"div",
		{ class: "landing-features" },
		...items.map(([icon, title, body]) => el("article", { class: "landing-feature" }, glyph(icon), el("h3", {}, t(title)), el("p", {}, t(body))))
	);
}

function compliance(): HTMLElement {
	const items: UiKey[] = [
		"landing.eu_eslog",
		"landing.eu_furs",
		"landing.eu_ddv",
		"landing.eu_vies",
		"landing.eu_oss",
		"landing.eu_sepa",
		"landing.eu_import",
		"landing.eu_languages",
	];
	return el(
		"div",
		{ class: "landing-band" },
		el(
			"div",
			{ class: "landing-band-text" },
			el("p", { class: "landing-eyebrow" }, t("landing.eu_eyebrow")),
			el("h2", {}, t("landing.eu_title")),
			el("p", { class: "landing-lead" }, t("landing.eu_lead")),
			el("p", { class: "landing-note" }, t("landing.eu_scope"))
		),
		el("ul", { class: "landing-checks" }, ...items.map((item) => el("li", {}, glyph("check", 18), el("span", {}, t(item)))))
	);
}

function selfHosting(): HTMLElement {
	const points: [string, UiKey][] = [
		["key", "landing.host_two_factor"],
		["shield", "landing.host_vault"],
		["history", "landing.host_audit"],
		["archive", "landing.host_backups"],
		["brush", "landing.host_white_label"],
	];
	const commands = [
		"git clone https://github.com/Rabbit-Company/RabbitPay-Server",
		"cd RabbitPay-Server",
		"cp .env.example .env",
		"docker compose up -d --build",
	];
	return el(
		"div",
		{ class: "landing-split" },
		el(
			"div",
			{ class: "stack" },
			el("ul", { class: "landing-points" }, ...points.map(([icon, text]) => el("li", {}, glyph(icon, 20), el("span", {}, t(text))))),
			el(
				"a",
				{ class: "button ghost landing-github", href: REPOSITORY, target: "_blank", rel: "noopener" },
				glyph("github", 18),
				el("span", {}, t("landing.host_github"))
			)
		),
		el(
			"div",
			{ class: "landing-terminal" },
			el("div", { class: "landing-terminal-bar" }, el("span", {}), el("span", {}), el("span", {})),
			el("pre", { class: "mono" }, ...commands.map((command) => el("div", {}, el("span", { class: "landing-prompt" }, "$ "), command))),
			el("p", { class: "landing-terminal-note" }, t("landing.host_terminal_note"))
		)
	);
}

function pricing(signUp: HTMLElement | null): HTMLElement | null {
	const payments = allowance("freePayments");
	const storage = allowance("freeStorage");
	if (payments === null || storage === null) return null;

	const included: string[] = [
		t("landing.price_payments", { count: payments.toLocaleString() }),
		t("landing.price_storage", { size: storage.toLocaleString() }),
		t("landing.price_everything"),
	];
	const extras: UiKey[] = [
		"landing.license_payments",
		"landing.license_storage",
		"landing.license_store",
		"landing.license_workforce",
		"landing.license_accounting",
		"landing.license_white_label",
	];
	const store = licenseStore();
	const buy = store
		? el("a", { class: "button secondary wide", href: store, target: "_blank", rel: "noopener" }, el("span", {}, t("landing.buy_licenses")), glyph("arrow", 18))
		: null;

	return section(
		"pricing",
		"landing.price_eyebrow",
		"landing.price_title",
		"landing.price_lead",
		el(
			"div",
			{ class: "landing-plans" },
			el(
				"div",
				{ class: "landing-plan featured" },
				el("h3", {}, t("landing.price_free")),
				el("p", { class: "landing-plan-price" }, "0 EUR", el("span", {}, t("landing.price_per_month"))),
				el("ul", { class: "landing-checks" }, ...included.map((item) => el("li", {}, glyph("check", 18), el("span", {}, item)))),
				signUp
			),
			el(
				"div",
				{ class: "landing-plan" },
				el("h3", {}, t("landing.price_licenses")),
				el("p", { class: "muted" }, t("landing.price_licenses_body")),
				el("ul", { class: "landing-checks" }, ...extras.map((item) => el("li", {}, glyph("check", 18), el("span", {}, t(item))))),
				el("p", { class: "landing-note" }, t("landing.license_scope")),
				buy
			)
		)
	);
}

export async function landingView(): Promise<HTMLElement> {
	const [registration, legal] = await Promise.all([registrationMode(), legalInfo().catch((): LegalInfo | null => null)]);
	const canRegister = registration !== "closed";
	const register = (label: UiKey, extra = "") =>
		canRegister ? el("a", { class: `button primary ${extra}`.trim(), href: "/login?mode=register" }, el("span", {}, t(label)), glyph("arrow", 18)) : null;
	const signIn = (className: string) => el("a", { class: className, href: "/login" }, t("login.sign_in"));

	const nav = el(
		"header",
		{ class: "landing-nav" },
		el(
			"div",
			{ class: "landing-nav-inner" },
			el("a", { class: "landing-brand", href: "/" }, logo(), el("span", {}, "RabbitPay")),
			el(
				"nav",
				{ class: "landing-links" },
				jump("payments", "landing.nav_payments"),
				jump("features", "landing.nav_features"),
				allowance("freePayments") !== null ? jump("pricing", "landing.nav_pricing") : null,
				jump("self-hosting", "landing.nav_self_hosting")
			),
			el(
				"div",
				{ class: "landing-actions" },
				themeSwitcher(),
				languageSwitcher((next) => navigate(landingPath(next))),
				signIn("button ghost small"),
				canRegister ? el("a", { class: "button primary small landing-nav-register", href: "/login?mode=register" }, t("landing.get_started")) : null
			)
		)
	);

	const hero = el(
		"section",
		{ class: "landing-hero" },
		el(
			"div",
			{ class: "landing-hero-text" },
			el("p", { class: "landing-eyebrow" }, t("landing.hero_eyebrow")),
			el("h1", {}, t("landing.hero_title")),
			el("p", { class: "landing-lead" }, t("landing.hero_lead")),
			el("div", { class: "landing-cta" }, register("landing.create_account"), signIn(canRegister ? "button ghost" : "button primary")),
			el("p", { class: "landing-note" }, t("landing.hero_note"))
		),
		invoicePreview()
	);

	const closing = el(
		"section",
		{ class: "landing-closing" },
		el("h2", {}, t("landing.closing_title")),
		el("p", { class: "landing-lead" }, t("landing.closing_lead")),
		el("div", { class: "landing-cta" }, register("landing.create_account"), signIn(canRegister ? "button ghost" : "button primary"))
	);

	const legalNav = legal ? legalLinks(legal) : [];
	const footer = el(
		"footer",
		{ class: "landing-footer" },
		el(
			"div",
			{ class: "landing-footer-top" },
			el("div", { class: "landing-brand" }, logo(), el("span", {}, "RabbitPay")),
			el(
				"nav",
				{ class: "landing-footer-links" },
				el("a", { href: "/login" }, t("login.sign_in")),
				el("a", { href: "/customer/login" }, t("portal.title")),
				el("a", { href: "/help" }, t("help.title")),
				el("a", { href: REPOSITORY, target: "_blank", rel: "noopener" }, "GitHub")
			)
		),
		el(
			"div",
			{ class: "landing-footer-bottom" },
			el(
				"p",
				{ class: "muted" },
				legal?.operator
					? t("landing.footer_operator", { operator: legal.operator.name, year: new Date().getFullYear() })
					: t("landing.footer", { year: new Date().getFullYear() })
			),
			legalNav.length ? el("nav", { class: "landing-footer-links" }, ...legalNav) : null
		)
	);

	return el(
		"div",
		{ class: "landing" },
		nav,
		el(
			"main",
			{ class: "landing-main" },
			hero,
			section("payments", "landing.pay_eyebrow", "landing.pay_title", "landing.pay_lead", paymentMethods()),
			section("features", "landing.features_eyebrow", "landing.features_title", "landing.features_lead", features()),
			compliance(),
			pricing(register("landing.create_account", "wide")),
			section("self-hosting", "landing.host_eyebrow", "landing.host_title", "landing.host_lead", selfHosting()),
			closing
		),
		footer
	);
}
