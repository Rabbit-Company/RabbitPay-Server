import { Api, ApiError, getToken, type HelpDocument, type HelpIndex, type HelpSummary, type LegalInfo } from "../api";
import { el, input } from "../dom";
import { isUiLanguage, language, setLanguage, t, type UiLanguage } from "../i18n";
import { languageSwitcher } from "../language";
import { openLightbox } from "../lightbox";
import { logo } from "../logo";
import { withCodeTools } from "../code-blocks";
import { navigate, onLeave } from "../router";
import { icon } from "../storefront/icons";
import { themeSwitcher } from "../theme-switcher";
import { toast } from "../ui";
import { renderHelp } from "../../../server/help-render";
import { legalInfo, legalLinks } from "./legal";

const HELP_SEED_ID = "rabbitpay-help";
const SEARCH_DELAY = 150;
const COMPACT_LAYOUT = "(max-width: 760px)";

const indexes = new Map<string, Promise<HelpIndex>>();
const documents = new Map<string, Promise<HelpDocument | null>>();

function documentPath(module: string, page: string | null): string {
	return page === null ? module : `${module}/${page}`;
}

function seedFromPage() {
	try {
		const seed = JSON.parse(document.getElementById(HELP_SEED_ID)?.textContent ?? "null") as {
			language: string;
			index: HelpIndex;
			document: HelpDocument | null;
		} | null;
		if (seed === null) return;
		indexes.set(seed.language, Promise.resolve(seed.index));
		if (seed.document) documents.set(`${seed.language}/${documentPath(seed.document.module, seed.document.page)}`, Promise.resolve(seed.document));
	} catch {
		void 0;
	}
}

seedFromPage();

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

function helpDocument(code: UiLanguage, module: string, page: string | null): Promise<HelpDocument | null> {
	return remembered(documents, `${code}/${documentPath(module, page)}`, () =>
		Api.helpDocument(code, module, page).catch((error) => {
			if (error instanceof ApiError && error.status === 404) return null;
			throw error;
		})
	);
}

function helpPath(code: UiLanguage, path: string | null): string {
	return path === null ? `/help/${code}` : `/help/${code}/${path}`;
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

function searchBox(code: UiLanguage, onQuery?: (searching: boolean) => void): HTMLElement {
	const field = input("search", { placeholder: t("help.search"), autocomplete: "off", maxlength: "100" });
	field.setAttribute("aria-label", t("help.search"));
	const results = el("div", { class: "help-results" });
	results.hidden = true;
	let round = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const show = async () => {
		const query = field.value.trim();
		const current = ++round;
		results.hidden = query === "";
		onQuery?.(query !== "");
		if (query === "") return;
		const matches = await Api.helpSearch(code, query).catch(() => []);
		if (current !== round) return;
		results.replaceChildren(
			...(matches.length === 0
				? [el("p", { class: "muted help-results-empty" }, t("help.no_results"))]
				: matches.map((match) =>
						el(
							"a",
							{ class: "help-result", href: helpPath(code, match.path) },
							el("span", { class: "help-result-title" }, match.title),
							el("span", { class: "help-result-context" }, match.context),
							match.snippet ? el("span", { class: "help-result-snippet" }, match.snippet) : null
						)
					))
		);
	};
	field.addEventListener("input", () => {
		clearTimeout(timer);
		timer = setTimeout(() => void show(), SEARCH_DELAY);
	});
	field.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			field.value = "";
			void show();
			return;
		}
		if (event.key !== "Enter") return;
		const first = results.querySelector<HTMLAnchorElement>("a.help-result");
		if (!first) return;
		event.preventDefault();
		navigate(first.getAttribute("href")!);
	});

	return el("div", { class: "help-search" }, el("div", { class: "help-search-field" }, icon("search", 16, "help-search-icon"), field), results);
}

function helpLayout(code: UiLanguage, path: string | null, title: string, legal: LegalInfo | null, ...content: (HTMLElement | null)[]): HTMLElement {
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
				languageSwitcher((next) => navigate(helpPath(next, path))),
				getToken() === null ? el("a", { class: "button ghost small", href: "/login" }, t("login.sign_in")) : null
			)
		),
		el("div", { class: "help-body" }, ...content),
		legalNav.length ? el("footer", { class: "help-footer" }, el("nav", { class: "landing-footer-links" }, ...legalNav)) : null
	);

	page.addEventListener("click", (event) => {
		const link = (event.target as HTMLElement).closest("a");
		const href = link?.getAttribute("href");
		if (!href || !href.startsWith("#")) return;
		event.preventDefault();
		if (scrollToAnchor(page, decodeURIComponent(href.slice(1)))) history.replaceState({}, "", href);
	});

	const onKey = (event: KeyboardEvent) => {
		const target = event.target as HTMLElement | null;
		if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
		if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
		const field = page.querySelector<HTMLInputElement>(".help-search input");
		if (!page.isConnected || !field) return;
		event.preventDefault();
		field.focus();
	};
	document.addEventListener("keydown", onKey);
	onLeave(() => document.removeEventListener("keydown", onKey));

	afterRouterRender(page, title);
	return page;
}

function moduleList(code: UiLanguage, index: HelpIndex, current: HelpDocument): HTMLElement {
	const currentPath = documentPath(current.module, current.page);
	const groups = el(
		"div",
		{ class: "help-nav-modules" },
		...index.modules.map((module) => {
			const link = el("a", { class: "help-nav-link", href: helpPath(code, module.slug) }, module.title);
			if (module.slug === currentPath) link.setAttribute("aria-current", "page");
			const pages = el(
				"div",
				{ class: "help-nav-pages" },
				...module.pages.map((page) => {
					const path = documentPath(module.slug, page.slug);
					const pageLink = el("a", { class: "help-nav-link help-nav-page", href: helpPath(code, path) }, page.title);
					if (path === currentPath) pageLink.setAttribute("aria-current", "page");
					return pageLink;
				})
			);
			pages.hidden = module.slug !== current.module;
			const toggle =
				module.pages.length > 0
					? el("button", {
							class: "help-nav-toggle",
							type: "button",
							title: module.title,
							onClick: () => {
								pages.hidden = !pages.hidden;
								toggle?.setAttribute("aria-expanded", String(!pages.hidden));
							},
						})
					: null;
			toggle?.setAttribute("aria-expanded", String(!pages.hidden));
			return el("div", { class: "help-nav-module" }, el("div", { class: "help-nav-head" }, link, toggle), module.pages.length > 0 ? pages : null);
		})
	);
	const menu = el("details", { class: "help-nav-menu" }, el("summary", { class: "help-nav-title" }, t("help.articles")), groups);
	menu.open = !window.matchMedia(COMPACT_LAYOUT).matches;
	const nav = el(
		"nav",
		{ class: "help-nav" },
		searchBox(code, (searching) => {
			menu.hidden = searching;
		}),
		menu
	);
	nav.setAttribute("aria-label", t("help.articles"));
	return nav;
}

function sectionList(body: HTMLElement): HTMLElement | null {
	const links = [...body.querySelectorAll<HTMLElement>("h2[id], h3[id]")].map((heading) =>
		el("a", { class: `help-nav-link${heading.tagName === "H3" ? " help-nav-page" : ""}`, href: `#${heading.id}` }, heading.textContent ?? "")
	);
	if (links.length < 2) return null;

	const nav = el("nav", { class: "help-nav help-sections" }, el("p", { class: "help-nav-title" }, t("help.on_this_page")), ...links);
	nav.setAttribute("aria-label", t("help.on_this_page"));
	return nav;
}

function headingLinks(body: HTMLElement) {
	for (const heading of body.querySelectorAll<HTMLElement>("h2[id], h3[id]")) {
		const link = el("a", { class: "help-anchor", href: `#${heading.id}`, title: t("help.copy_link") }, "#");
		link.setAttribute("aria-label", t("help.copy_link"));
		link.addEventListener("click", () => {
			const url = `${window.location.origin}${window.location.pathname}#${heading.id}`;
			void navigator.clipboard?.writeText(url).then(() => toast(t("help.link_copied"), "success"));
		});
		heading.append(link);
	}
}

function visibleShot(pair: Element): HTMLImageElement {
	const [dark, light] = [...pair.querySelectorAll("img")];
	return light && getComputedStyle(dark).display === "none" ? light : dark;
}

function zoomableShots(body: HTMLElement) {
	const pairs = [...body.querySelectorAll(".help-shot-pair")];
	pairs.forEach((pair, position) => {
		pair.addEventListener("click", () =>
			openLightbox(
				pairs.map((candidate) => {
					const image = visibleShot(candidate);
					return { src: image.src, alt: image.alt };
				}),
				position
			)
		);
	});
}

function articleBody(content: string, code: UiLanguage): HTMLElement {
	const body = el("div", { class: "sf-prose markdown-body legal-body help-article" });
	body.innerHTML = renderHelp(content, code);
	withCodeTools(body);
	zoomableShots(body);
	return body;
}

function card(code: UiLanguage, path: string, entry: HelpSummary, pages: HelpSummary[] = []): HTMLElement {
	return el(
		"div",
		{ class: "card help-card" },
		el("a", { class: "help-card-link", href: helpPath(code, path) }, el("h2", {}, entry.title), el("p", { class: "muted" }, entry.description)),
		pages.length > 0
			? el(
					"ul",
					{ class: "help-card-pages" },
					...pages.map((page) => el("li", {}, el("a", { href: helpPath(code, documentPath(path, page.slug)) }, page.title)))
				)
			: null
	);
}

function neighbours(index: HelpIndex, current: HelpDocument): { previous: [string, string] | null; next: [string, string] | null } {
	const order = index.modules.flatMap((module) => [
		[module.slug, module.title] as [string, string],
		...module.pages.map((page) => [documentPath(module.slug, page.slug), page.title] as [string, string]),
	]);
	const position = order.findIndex(([path]) => path === documentPath(current.module, current.page));
	return { previous: order[position - 1] ?? null, next: order[position + 1] ?? null };
}

function pager(code: UiLanguage, index: HelpIndex, current: HelpDocument): HTMLElement {
	const { previous, next } = neighbours(index, current);
	const step = (target: [string, string] | null, label: string, className: string) =>
		target === null
			? el("span", {})
			: el("a", { class: `help-pager-link ${className}`, href: helpPath(code, target[0]) }, el("span", { class: "muted" }, label), el("strong", {}, target[1]));
	return el(
		"nav",
		{ class: "help-pager" },
		step(previous, `← ${t("help.previous")}`, "help-pager-previous"),
		step(next, `${t("help.next")} →`, "help-pager-next")
	);
}

export async function helpIndexView(code: string): Promise<HTMLElement> {
	const current = routeLanguage(code);
	const [index, legal] = await Promise.all([helpIndex(current), legalInfo().catch((): LegalInfo | null => null)]);
	const cards = el("div", { class: "help-cards" }, ...index.modules.map((module) => card(current, module.slug, module, module.pages)));

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
			searchBox(current, (searching) => {
				cards.hidden = searching;
			}),
			cards
		)
	);
}

export async function helpDocumentView(code: string, module: string, page: string | null): Promise<HTMLElement> {
	const current = routeLanguage(code);
	const [index, article, legal] = await Promise.all([helpIndex(current), helpDocument(current, module, page), legalInfo().catch((): LegalInfo | null => null)]);

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

	const owner = index.modules.find((entry) => entry.slug === article.module)!;
	const body = articleBody(article.content, current);
	const sections = sectionList(body);
	headingLinks(body);
	const trail = el(
		"p",
		{ class: "help-trail" },
		el("a", { href: helpPath(current, null) }, index.title),
		...(article.page === null ? [] : [" / ", el("a", { href: helpPath(current, owner.slug) }, owner.title)])
	);
	const children =
		article.page === null && owner.pages.length > 0
			? [
					el("h2", { class: "help-children-title" }, t("help.in_this_guide")),
					el("div", { class: "help-cards" }, ...owner.pages.map((child) => card(current, documentPath(owner.slug, child.slug), child))),
				]
			: [];

	return helpLayout(
		current,
		documentPath(article.module, article.page),
		`${article.title} | ${index.title}`,
		legal,
		moduleList(current, index, article),
		el("main", { class: "help-main" }, trail, el("h1", {}, article.title), body, ...children, pager(current, index, article)),
		sections
	);
}
