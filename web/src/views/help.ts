import { Api, ApiError, getToken, type HelpArticle, type HelpIndex, type LegalInfo } from "../api";
import { el } from "../dom";
import { isUiLanguage, language, setLanguage, t, type UiLanguage } from "../i18n";
import { languageSwitcher } from "../language";
import { logo } from "../logo";
import { markdownView } from "../markdown-editor";
import { navigate } from "../router";
import { themeSwitcher } from "../theme-switcher";
import { headingAnchor } from "../../../server/markdown";
import { legalInfo, legalLinks } from "./legal";

const ARTICLE_LINK = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const indexes = new Map<string, Promise<HelpIndex>>();
const articles = new Map<string, Promise<HelpArticle | null>>();

function remembered<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
	let pending = cache.get(key);
	if (!pending) {
		pending = load().catch((error) => {
			cache.delete(key);
			throw error;
		});
		cache.set(key, pending);
	}
	return pending;
}

function helpIndex(code: UiLanguage): Promise<HelpIndex> {
	return remembered(indexes, code, () => Api.help(code));
}

function helpArticle(code: UiLanguage, slug: string): Promise<HelpArticle | null> {
	return remembered(articles, `${code}/${slug}`, () =>
		Api.helpArticle(code, slug).catch((error) => {
			if (error instanceof ApiError && error.status === 404) return null;
			throw error;
		})
	);
}

function helpPath(code: UiLanguage, slug: string | null): string {
	return slug === null ? `/help/${code}` : `/help/${code}/${slug}`;
}

function routeLanguage(code: string): UiLanguage {
	const requested = isUiLanguage(code) ? code : language();
	if (requested !== language()) setLanguage(requested);
	return requested;
}

function scrollToAnchor(page: HTMLElement, anchor: string): boolean {
	const target = [...page.querySelectorAll<HTMLElement>("[id]")].find((node) => node.id === anchor);
	if (!target) return false;
	target.scrollIntoView({ block: "start" });
	return true;
}

function afterRouterRender(page: HTMLElement, title: string) {
	setTimeout(() => {
		if (!page.isConnected) return;
		document.title = `${title} | RabbitPay`;
		const anchor = decodeURIComponent(window.location.hash.slice(1));
		if (anchor) scrollToAnchor(page, anchor);
	}, 0);
}

function helpLayout(code: UiLanguage, slug: string | null, title: string, legal: LegalInfo | null, ...content: (HTMLElement | null)[]): HTMLElement {
	const legalNav = legal ? legalLinks(legal) : [];
	const page = el(
		"div",
		{ class: "help-page" },
		el(
			"header",
			{ class: "help-bar" },
			el("a", { class: "landing-brand", href: "/" }, logo(), el("span", {}, "RabbitPay")),
			el("a", { class: "help-bar-title", href: helpPath(code, null) }, t("help.title")),
			el(
				"div",
				{ class: "landing-actions" },
				themeSwitcher(),
				languageSwitcher((next) => navigate(helpPath(next, slug))),
				getToken() === null ? el("a", { class: "button ghost small", href: "/login" }, t("login.sign_in")) : null
			)
		),
		el("div", { class: "help-body" }, ...content),
		legalNav.length ? el("footer", { class: "help-footer" }, el("nav", { class: "landing-footer-links" }, ...legalNav)) : null
	);

	page.addEventListener("click", (event) => {
		const link = (event.target as HTMLElement).closest("a");
		const href = link?.getAttribute("href");
		if (!href) return;
		if (ARTICLE_LINK.test(href)) {
			event.preventDefault();
			navigate(helpPath(code, href));
			return;
		}
		if (!href.startsWith("#")) return;
		event.preventDefault();
		if (scrollToAnchor(page, decodeURIComponent(href.slice(1)))) history.replaceState({}, "", href);
	});

	afterRouterRender(page, title);
	return page;
}

function articleList(code: UiLanguage, index: HelpIndex, current: string | null): HTMLElement {
	const nav = el(
		"nav",
		{ class: "help-nav" },
		el("p", { class: "help-nav-title" }, t("help.articles")),
		...index.articles.map((article) => {
			const link = el("a", { class: "help-nav-link", href: helpPath(code, article.slug) }, article.title);
			if (article.slug === current) link.setAttribute("aria-current", "page");
			return link;
		})
	);
	nav.setAttribute("aria-label", t("help.articles"));
	return nav;
}

function sectionList(body: HTMLElement): HTMLElement | null {
	const used = new Set<string>();
	const links = [...body.querySelectorAll("h2")].map((heading) => {
		const base = headingAnchor(heading.textContent ?? "") || "section";
		let anchor = base;
		for (let copy = 2; used.has(anchor); copy++) anchor = `${base}-${copy}`;
		used.add(anchor);
		heading.id = anchor;
		return el("a", { class: "help-nav-link", href: `#${anchor}` }, heading.textContent ?? "");
	});
	if (links.length < 2) return null;

	const nav = el("nav", { class: "help-nav help-sections" }, el("p", { class: "help-nav-title" }, t("help.on_this_page")), ...links);
	nav.setAttribute("aria-label", t("help.on_this_page"));
	return nav;
}

export async function helpIndexView(code: string): Promise<HTMLElement> {
	const current = routeLanguage(code);
	const [index, legal] = await Promise.all([helpIndex(current), legalInfo().catch((): LegalInfo | null => null)]);

	return helpLayout(
		current,
		null,
		index.title,
		legal,
		el(
			"main",
			{ class: "help-main help-index" },
			el("h1", {}, index.title),
			el("p", { class: "help-lead" }, index.description),
			el(
				"div",
				{ class: "help-cards" },
				...index.articles.map((article) =>
					el(
						"a",
						{ class: "card help-card", href: helpPath(current, article.slug) },
						el("h2", {}, article.title),
						el("p", { class: "muted" }, article.description)
					)
				)
			)
		)
	);
}

export async function helpArticleView(code: string, slug: string): Promise<HTMLElement> {
	const current = routeLanguage(code);
	const [index, article, legal] = await Promise.all([helpIndex(current), helpArticle(current, slug), legalInfo().catch((): LegalInfo | null => null)]);

	if (article === null) {
		return helpLayout(
			current,
			null,
			index.title,
			legal,
			el(
				"main",
				{ class: "help-main help-index" },
				el("h1", {}, t("app.not_found_title")),
				el("p", { class: "help-lead" }, t("help.not_found")),
				el("a", { class: "button ghost", href: helpPath(current, null) }, t("help.all"))
			)
		);
	}

	const body = markdownView(article.content, "legal-body help-article");
	const sections = sectionList(body);

	return helpLayout(
		current,
		slug,
		`${article.title} | ${index.title}`,
		legal,
		articleList(current, index, slug),
		el("main", { class: "help-main" }, el("h1", {}, article.title), body),
		sections
	);
}
