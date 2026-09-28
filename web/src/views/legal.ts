import { Api, type Account, type LegalDocument, type LegalInfo, type LegalKind } from "../api";
import { el } from "../dom";
import { language, t } from "../i18n";
import { languageSwitcher } from "../language";
import { logo } from "../logo";
import { markdownView } from "../markdown-editor";
import { formatDate } from "../money";
import { themeSwitcher } from "../theme-switcher";
import { reportError } from "../ui";
import { refreshAccount, signOut } from "../session";

let cached: Promise<LegalInfo> | null = null;

export function legalInfo(): Promise<LegalInfo> {
	cached ??= Api.legal().catch((error) => {
		cached = null;
		throw error;
	});
	return cached;
}

export function resetLegalInfo() {
	cached = null;
}

export function localizedContent(document: LegalDocument): { content: string; translated: boolean } {
	const preferred = language() === "sl" ? document.content_sl : document.content_en;
	const other = language() === "sl" ? document.content_en : document.content_sl;
	return { content: preferred ?? other ?? "", translated: preferred !== null };
}

export function legalLinks(info: LegalInfo, target?: "_blank"): HTMLElement[] {
	const link = (href: string, label: string) => el("a", target ? { href, target, rel: "noopener" } : { href }, label);
	return [
		info.operator ? link("/legal", t("legal.notice")) : null,
		info.terms || info.upcoming_terms ? link("/terms", t("legal.terms")) : null,
		info.privacy || info.upcoming_privacy ? link("/privacy", t("legal.privacy")) : null,
	].filter((node): node is HTMLAnchorElement => node !== null);
}

function legalLayout(info: LegalInfo, ...content: (HTMLElement | null)[]): HTMLElement {
	return el(
		"div",
		{ class: "legal-page" },
		el(
			"header",
			{ class: "legal-bar" },
			el("a", { class: "landing-brand", href: "/" }, logo(), el("span", {}, "RabbitPay")),
			el("div", { class: "landing-actions" }, themeSwitcher(), languageSwitcher())
		),
		el("main", { class: "legal-main" }, ...content),
		el("footer", { class: "legal-footer" }, el("nav", { class: "landing-footer-links" }, ...legalLinks(info)))
	);
}

function missing(info: LegalInfo): HTMLElement {
	return legalLayout(
		info,
		el("h1", {}, t("app.not_found_title")),
		el("p", { class: "muted" }, t("legal.not_published")),
		el("a", { class: "button ghost", href: "/" }, t("legal.back_home"))
	);
}

export function requiresTerms(info: LegalInfo): boolean {
	return info.required_versions.terms.length > 0;
}

export async function legalDocumentView(kind: LegalKind): Promise<HTMLElement> {
	const info = await legalInfo();
	const current = info[kind];
	const upcoming = kind === "terms" ? info.upcoming_terms : info.upcoming_privacy;
	const showUpcoming = upcoming !== null && (current === null || new URLSearchParams(window.location.search).get("upcoming") === "1");
	const document = showUpcoming ? upcoming : current;
	if (!document) return missing(info);

	const { content, translated } = localizedContent(document);
	const notice =
		upcoming === null
			? null
			: showUpcoming
				? el(
						"p",
						{ class: "legal-notice-banner" },
						t("legal.upcoming_viewing", { date: formatDate(upcoming.effective) }),
						current ? " " : null,
						current ? el("a", { href: `/${kind}` }, t("legal.read_current")) : null
					)
				: el(
						"p",
						{ class: "legal-notice-banner" },
						t("legal.upcoming_notice", { date: formatDate(upcoming.effective) }),
						" ",
						el("a", { href: `/${kind}?upcoming=1` }, t("legal.read_upcoming"))
					);

	return legalLayout(
		info,
		notice,
		translated ? null : el("p", { class: "legal-notice-banner" }, t("legal.not_translated")),
		el("article", { class: "legal-body" }, markdownView(content)),
		el("p", { class: "muted legal-meta" }, t("legal.version", { version: document.version, date: formatDate(document.effective) }))
	);
}

export async function legalNoticeView(): Promise<HTMLElement> {
	const info = await legalInfo();
	const operator = info.operator;
	if (!operator) return missing(info);

	const row = (label: string, value: string | null, href?: string) =>
		value ? el("div", { class: "legal-row" }, el("dt", {}, label), el("dd", {}, href ? el("a", { href }, value) : value)) : null;

	return legalLayout(
		info,
		el("h1", {}, t("legal.notice")),
		el("p", { class: "muted" }, t("legal.notice_intro")),
		el(
			"dl",
			{ class: "legal-details card" },
			row(t("legal.operator"), operator.name),
			row(t("legal.address"), operator.address),
			row(t("legal.register"), operator.register),
			row(t("legal.registration_number"), operator.registration_number),
			row(t("legal.tax_number"), operator.tax_number),
			row(t("legal.vat"), operator.vat_status === "registered" ? (operator.vat_number ?? t("legal.vat_registered")) : t("legal.vat_not_registered")),
			row(t("legal.email"), operator.email, operator.email ? `mailto:${operator.email}` : undefined),
			row(t("legal.phone"), operator.phone, operator.phone ? `tel:${operator.phone.replace(/\s+/g, "")}` : undefined)
		),
		operator.email ? el("h2", {}, t("legal.contact_title")) : null,
		operator.email ? el("p", {}, t("legal.contact_body"), " ", el("a", { href: `mailto:${operator.email}` }, operator.email), ".") : null,
		el("h2", {}, t("legal.software_title")),
		el("p", { class: "muted" }, t("legal.software_body"))
	);
}

const DISMISSED_KEY = "rabbitpay.terms-notice";

function dismissed(version: number): boolean {
	try {
		return localStorage.getItem(DISMISSED_KEY) === String(version);
	} catch {
		return false;
	}
}

function upcomingBanner(upcoming: NonNullable<Account["upcoming_terms"]>): void {
	if (document.querySelector(".terms-banner") || dismissed(upcoming.version)) return;

	const accept = el("button", { class: "button primary small", type: "button" }, t("legal.accept_now"));
	const close = el("button", { class: "button ghost small", type: "button" }, t("legal.later"));
	const banner = el(
		"div",
		{ class: "terms-banner" },
		el(
			"p",
			{},
			t("legal.upcoming_banner", { date: formatDate(upcoming.effective) }),
			" ",
			el("a", { href: "/terms?upcoming=1", target: "_blank", rel: "noopener" }, t("legal.read_upcoming"))
		),
		el("div", { class: "terms-banner-actions" }, close, accept)
	);
	banner.setAttribute("role", "status");

	close.addEventListener("click", () => {
		try {
			localStorage.setItem(DISMISSED_KEY, String(upcoming.version));
		} catch {
			void 0;
		}
		banner.remove();
	});
	accept.addEventListener("click", async () => {
		accept.disabled = true;
		try {
			cached = null;
			await Api.acceptTerms((await legalInfo()).required_versions);
			banner.remove();
		} catch (error) {
			reportError(error);
			accept.disabled = false;
		}
	});
	document.body.appendChild(banner);
}

export async function checkPendingTerms(): Promise<boolean> {
	const account = await refreshAccount();
	if (account?.pending_terms) termsPrompt(account.pending_terms);
	else if (account?.upcoming_terms) upcomingBanner(account.upcoming_terms);
	return account !== null;
}

export function termsPrompt(version: number): void {
	if (document.querySelector(".terms-prompt")) return;

	const accept = el("button", { class: "button primary", type: "button" }, t("legal.accept_continue"));
	const leave = el("button", { class: "button ghost", type: "button" }, t("app.sign_out"));
	const overlay = el(
		"div",
		{ class: "overlay terms-prompt" },
		el(
			"div",
			{ class: "dialog dialog-wide" },
			el("h2", {}, t("legal.updated_title")),
			el(
				"p",
				{ class: "muted" },
				t("legal.updated_body"),
				" ",
				el("a", { href: "/terms", target: "_blank", rel: "noopener" }, t("legal.read_terms", { version })),
				"."
			),
			el("div", { class: "dialog-actions" }, leave, accept)
		)
	);
	overlay.setAttribute("role", "dialog");
	overlay.setAttribute("aria-modal", "true");

	accept.addEventListener("click", async () => {
		accept.disabled = true;
		try {
			cached = null;
			const info = await legalInfo();
			await Api.acceptTerms(info.required_versions);
			overlay.remove();
			document.querySelector(".terms-banner")?.remove();
		} catch (error) {
			reportError(error);
			accept.disabled = false;
		}
	});
	leave.addEventListener("click", () => {
		overlay.remove();
		void signOut();
	});

	document.body.appendChild(overlay);
	accept.focus();
}
