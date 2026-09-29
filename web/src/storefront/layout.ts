import { accentTextFor } from "../../../server/colors";
import { ApiError } from "../api";
import { el } from "../dom";
import { errorText, isUiLanguage, locale, processorLabel, t, useStoreTexts } from "../i18n";
import { navigate, onLeave, render } from "../router";
import { applyTheme } from "../theme";
import { logo } from "../logo";
import { StoreApi, useShopperLanguage, type ProductCard, type StoreCategoryNode, type Storefront } from "./api";
import { addToCart, cartCount, onCartChange } from "./cart";
import { icon, socialIcon, SOCIAL_LABELS } from "./icons";
import { zoomableImages } from "../lightbox";
import { money, openState, percentOff, weekdayName } from "./format";

const CACHE_MS = 60 * 1000;
const NOTICE_KEY = "rabbitpay.store.notice";

function languageKey(slug: string): string {
	return `rabbitpay.store.${slug}.language`;
}

function visitorLanguage(slug: string): string | null {
	const requested = new URLSearchParams(window.location.search).get("lang");
	try {
		if (requested) localStorage.setItem(languageKey(slug), requested);
		return requested ?? localStorage.getItem(languageKey(slug));
	} catch {
		return requested;
	}
}

function browserLanguage(offered: { code: string }[]): string | null {
	const codes = new Set(offered.map((language) => language.code));
	for (const tag of navigator.languages ?? [navigator.language]) {
		const code = tag.toLowerCase().split("-")[0];
		if (code && codes.has(code)) return code;
	}
	return null;
}

async function loadStore(slug: string, language: string | null): Promise<Storefront> {
	const key = `${slug}:${language ?? ""}`;
	const cached = cache.get(key);
	if (cached && Date.now() - cached.loaded < CACHE_MS) return cached.store;
	const store = await StoreApi.store(slug, language);
	cache.set(key, { store, loaded: Date.now() });
	return store;
}

function chooseLanguage(slug: string, next: string) {
	try {
		localStorage.setItem(languageKey(slug), next);
	} catch {
		void 0;
	}
	void render();
}

const FONTS: Record<string, string> = {
	system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
	geometric: 'Avenir, Montserrat, Corbel, "URW Gothic", source-sans-pro, system-ui, sans-serif',
	humanist: 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, system-ui, sans-serif',
	serif: '"Iowan Old Style", "Palatino Linotype", Palatino, "URW Palladio L", P052, Georgia, serif',
	rounded: 'ui-rounded, "Hiragino Maru Gothic ProN", Quicksand, Comfortaa, Manjari, "Arial Rounded MT", Calibri, system-ui, sans-serif',
	mono: 'ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, "DejaVu Sans Mono", monospace',
};

const RADII: Record<string, string> = { sharp: "2px", soft: "12px", round: "22px" };

export interface StoreContext {
	store: Storefront;
	base: string;
	link(path?: string): string;
}

const cache = new Map<string, { store: Storefront; loaded: number }>();

export function domainStore(): string | null {
	const meta = document.querySelector<HTMLMetaElement>('meta[name="rabbitpay-store"]');
	return meta && meta.dataset.domain === "1" ? meta.content : null;
}

export async function storeContext(slug: string): Promise<StoreContext> {
	const wanted = visitorLanguage(slug);
	let store = await loadStore(slug, wanted);
	if (wanted === null) {
		const detected = browserLanguage(store.languages);
		if (detected && detected !== store.language.code) store = await loadStore(slug, detected);
	}
	const code = store.language.code;
	const base = isUiLanguage(code) ? code : isUiLanguage(store.config.language) ? store.config.language : "en";
	useStoreTexts({ code, base, strings: store.language.strings });
	useShopperLanguage(code === store.config.language ? null : code);
	const prefix = domainStore() === slug ? "" : `/shop/${slug}`;
	return {
		store,
		base: prefix,
		link(path = "/") {
			if (path === "/") return prefix || "/";
			return `${prefix}${path}`;
		},
	};
}

function applyStoreTheme(store: Storefront) {
	const root = document.documentElement;
	const theme = store.config.theme;
	if (theme.mode === "auto") applyTheme();
	else root.dataset.theme = theme.mode;
	root.style.setProperty("--accent", theme.accent);
	root.style.setProperty("--accent-text", accentTextFor(theme.accent));

	let custom = document.getElementById("sf-custom-css");
	if (theme.custom_css.trim()) {
		if (!custom) {
			custom = document.createElement("style");
			custom.id = "sf-custom-css";
			document.head.appendChild(custom);
		}
		custom.textContent = theme.custom_css;
	} else {
		custom?.remove();
	}

	const link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
	if (link && store.logo) {
		link.removeAttribute("type");
		link.href = store.logo;
	}
}

function resetStoreTheme() {
	document.getElementById("sf-custom-css")?.remove();
	document.documentElement.style.removeProperty("--accent");
	document.documentElement.style.removeProperty("--accent-text");
	useStoreTexts(null);
	applyTheme();
}

export function setTitle(ctx: StoreContext, title: string | null) {
	document.title = title
		? `${title} | ${ctx.store.config.name}`
		: ctx.store.config.tagline
			? `${ctx.store.config.name} | ${ctx.store.config.tagline}`
			: ctx.store.config.name;
}

export function topCategories(store: Storefront): StoreCategoryNode[] {
	return store.categories.filter((category) => category.parent === null && category.count > 0);
}

export function childCategories(store: Storefront, parent: string): StoreCategoryNode[] {
	return store.categories.filter((category) => category.parent === parent && category.count > 0);
}

function brand(ctx: StoreContext): HTMLElement {
	const { store } = ctx;
	const mark = store.logo ? el("img", { class: "sf-brand-logo", src: store.logo, alt: store.config.name }) : null;
	return el("a", { class: "sf-brand", href: ctx.link() }, mark, mark ? null : el("span", { class: "sf-brand-name" }, store.config.name));
}

function cartButton(ctx: StoreContext): HTMLElement {
	const badge = el("span", { class: "sf-badge" });
	const button = el("a", { class: "sf-icon-button sf-cart-button", href: ctx.link("/cart"), title: t("shop.cart") }, icon("bag", 22), badge);
	button.setAttribute("aria-label", t("shop.cart"));
	const sync = () => {
		const count = cartCount(ctx.store.slug);
		badge.textContent = count > 99 ? "99+" : String(count);
		badge.hidden = count === 0;
	};
	sync();
	const stop = onCartChange(sync);
	onLeave(stop);
	return button;
}

function searchForm(ctx: StoreContext, className = "sf-search"): HTMLFormElement {
	const current = new URLSearchParams(window.location.search).get("q") ?? "";
	const field = el("input", { type: "search", placeholder: t("shop.search_placeholder"), value: current, maxlength: "100" });
	field.setAttribute("aria-label", t("shop.search"));
	return el(
		"form",
		{
			class: className,
			onSubmit: (event) => {
				event.preventDefault();
				const query = field.value.trim();
				navigate(query ? `${ctx.link("/search")}?q=${encodeURIComponent(query)}` : ctx.link("/search"));
			},
		},
		icon("search", 18),
		field
	);
}

function categoryNav(ctx: StoreContext): HTMLElement {
	const nav = el("nav", { class: "sf-nav" });
	nav.setAttribute("aria-label", t("shop.categories"));
	const path = window.location.pathname;
	for (const category of topCategories(ctx.store).slice(0, 7)) {
		const href = ctx.link(`/c/${category.slug}`);
		const children = childCategories(ctx.store, category.uuid);
		const anchor = el("a", { class: "sf-nav-link", href }, category.name, children.length ? icon("down", 14) : null);
		if (path === href) anchor.setAttribute("aria-current", "page");
		if (!children.length) {
			nav.append(anchor);
			continue;
		}
		nav.append(
			el(
				"div",
				{ class: "sf-nav-group" },
				anchor,
				el(
					"div",
					{ class: "sf-nav-menu" },
					...children.map((child) => el("a", { href: ctx.link(`/c/${child.slug}`) }, child.name, el("span", { class: "sf-count" }, String(child.count))))
				)
			)
		);
	}
	nav.append(el("a", { class: "sf-nav-link", href: ctx.link("/search") }, t("shop.all_products")));
	return nav;
}

function drawer(ctx: StoreContext): { open: () => void; element: HTMLElement } {
	const picker = languagePicker(ctx);
	const panel = el("div", { class: "sf-drawer" });
	const overlay = el("div", { class: "sf-drawer-overlay" }, panel);
	overlay.hidden = true;
	const close = () => {
		overlay.hidden = true;
		document.body.classList.remove("sf-locked");
	};
	overlay.addEventListener("click", (event) => {
		if (event.target === overlay || (event.target as HTMLElement).closest("a")) close();
	});
	const tree = (parent: string | null, depth: number): HTMLElement[] =>
		ctx.store.categories
			.filter((category) => category.parent === parent && category.count > 0)
			.flatMap((category) => [
				el(
					"a",
					{ class: `sf-drawer-link depth-${Math.min(depth, 2)}`, href: ctx.link(`/c/${category.slug}`) },
					category.name,
					el("span", { class: "sf-count" }, String(category.count))
				),
				...tree(category.uuid, depth + 1),
			]);
	panel.append(
		el(
			"div",
			{ class: "sf-drawer-head" },
			brand(ctx),
			el("button", { class: "sf-icon-button", type: "button", title: t("ui.close"), onClick: close }, icon("close", 22))
		),
		searchForm(ctx, "sf-search sf-search-wide"),
		el("a", { class: "sf-drawer-link", href: ctx.link("/search") }, t("shop.all_products")),
		...tree(null, 0),
		el("div", { class: "sf-divider" }),
		el("a", { class: "sf-drawer-link", href: ctx.link("/account") }, icon("user", 18), t("shop.account")),
		...ctx.store.config.pages
			.filter((page) => page.footer)
			.map((page) => el("a", { class: "sf-drawer-link", href: ctx.link(`/page/${page.slug}`) }, page.title)),
		...(picker ? [el("div", { class: "sf-divider" }), picker] : [])
	);
	return {
		element: overlay,
		open: () => {
			overlay.hidden = false;
			document.body.classList.add("sf-locked");
			panel.querySelector("input")?.focus();
		},
	};
}

function languagePicker(ctx: StoreContext): HTMLElement | null {
	const { languages } = ctx.store;
	if (languages.length < 2) return null;
	const current = locale();
	const picker = el(
		"select",
		{ class: "sf-language-select" },
		...languages.map((option) => {
			const entry = el("option", { value: option.code }, option.name);
			entry.lang = option.code;
			entry.selected = option.code === current;
			return entry;
		})
	);
	picker.setAttribute("aria-label", t("app.language"));
	picker.addEventListener("change", () => {
		if (picker.value !== current) chooseLanguage(ctx.store.slug, picker.value);
	});
	return el("label", { class: "sf-language", title: t("app.language") }, icon("globe", 16), picker);
}

function languageMenu(ctx: StoreContext): HTMLElement | null {
	const { languages } = ctx.store;
	if (languages.length < 2) return null;
	const current = locale();
	const button = el(
		"button",
		{ class: "sf-icon-button sf-language-button", type: "button", title: t("app.language") },
		icon("globe", 20),
		el("span", { class: "sf-language-code" }, current.toUpperCase())
	);
	button.setAttribute("aria-label", t("app.language"));
	button.setAttribute("aria-haspopup", "menu");
	button.setAttribute("aria-expanded", "false");

	const options = languages.map((option) => {
		const selected = option.code === current;
		const entry = el(
			"button",
			{ class: `sf-language-option${selected ? " active" : ""}`, type: "button", onClick: () => pick(option.code) },
			el("span", {}, option.name),
			selected ? icon("check", 16) : null
		);
		entry.lang = option.code;
		entry.setAttribute("role", "menuitemradio");
		entry.setAttribute("aria-checked", String(selected));
		return entry;
	});
	const menu = el("div", { class: "sf-language-menu" }, ...options);
	menu.setAttribute("role", "menu");
	menu.hidden = true;
	const wrapper = el("div", { class: "sf-language-switch" }, button, menu);

	const close = () => {
		menu.hidden = true;
		button.setAttribute("aria-expanded", "false");
		document.removeEventListener("click", outside, true);
		document.removeEventListener("keydown", escape, true);
	};
	const outside = (event: Event) => {
		if (!wrapper.contains(event.target as Node)) close();
	};
	const escape = (event: KeyboardEvent) => {
		if (event.key !== "Escape") return;
		close();
		button.focus();
	};
	const pick = (code: string) => {
		close();
		if (code !== current) chooseLanguage(ctx.store.slug, code);
	};
	button.addEventListener("click", () => {
		if (!menu.hidden) return close();
		menu.hidden = false;
		button.setAttribute("aria-expanded", "true");
		document.addEventListener("click", outside, true);
		document.addEventListener("keydown", escape, true);
		(options.find((option) => option.classList.contains("active")) ?? options[0])?.focus();
	});
	onLeave(close);
	return wrapper;
}

function header(ctx: StoreContext): HTMLElement[] {
	const menu = drawer(ctx);
	const announcement = ctx.store.config.announcement ? el("div", { class: "sf-announcement" }, ctx.store.config.announcement) : null;
	const menuButton = el("button", { class: "sf-icon-button sf-menu-button", type: "button", title: t("shop.menu"), onClick: menu.open }, icon("menu", 22));
	menuButton.setAttribute("aria-label", t("shop.menu"));
	const account = el("a", { class: "sf-icon-button", href: ctx.link("/account"), title: t("shop.account") }, icon("user", 22));
	account.setAttribute("aria-label", t("shop.account"));

	return [
		...(announcement ? [announcement] : []),
		el(
			"header",
			{ class: "sf-header" },
			el(
				"div",
				{ class: "sf-container sf-header-row" },
				menuButton,
				brand(ctx),
				categoryNav(ctx),
				el("div", { class: "sf-header-actions" }, searchForm(ctx), languageMenu(ctx), account, cartButton(ctx))
			)
		),
		menu.element,
	];
}

function hoursTable(ctx: StoreContext): HTMLElement {
	const { location } = ctx.store.config;
	const state = openState(location.hours, ctx.store.timezone);
	const status = state.open
		? el("span", { class: "sf-open" }, el("span", { class: "sf-dot" }), t("shop.open_until", { time: state.closesAt ?? "" }))
		: el(
				"span",
				{ class: "sf-closed" },
				el("span", { class: "sf-dot" }),
				state.opensAt
					? state.opensAt.day === state.today
						? t("shop.opens_today", { time: state.opensAt.time })
						: t("shop.opens_on", { day: weekdayName(state.opensAt.day), time: state.opensAt.time })
					: t("shop.closed")
			);

	return el(
		"div",
		{ class: "sf-hours" },
		status,
		el(
			"table",
			{},
			el(
				"tbody",
				{},
				...location.hours.map((day, index) =>
					el(
						"tr",
						{ class: index === state.today ? "today" : "" },
						el("th", {}, weekdayName(index)),
						el("td", {}, day.closed ? t("shop.closed") : `${day.open} - ${day.close}`)
					)
				)
			)
		)
	);
}

export function locationBlock(ctx: StoreContext, heading = true): HTMLElement | null {
	const { location } = ctx.store.config;
	if (!location.enabled) return null;
	return el(
		"div",
		{ class: "sf-location" },
		heading ? el("h4", {}, location.name ?? t("shop.visit_us")) : null,
		location.address
			? el(
					"p",
					{ class: "sf-address" },
					icon("pin", 16),
					el("span", {}, ...location.address.split("\n").flatMap((line, index) => (index ? [el("br"), line] : [line])))
				)
			: null,
		hoursTable(ctx),
		location.note ? el("p", { class: "sf-muted" }, location.note) : null,
		location.map_url
			? el("a", { class: "sf-link", href: location.map_url, target: "_blank", rel: "noopener noreferrer" }, t("shop.directions"), icon("external", 14))
			: null
	);
}

function footer(ctx: StoreContext): HTMLElement {
	const { store } = ctx;
	const config = store.config;
	const socials = config.socials.length
		? el(
				"div",
				{ class: "sf-socials" },
				...config.socials.map((social) => {
					const href = social.network === "email" ? `mailto:${social.url}` : social.url;
					const label =
						social.network === "email" ? t("shop.social_email") : social.network === "website" ? t("shop.social_website") : SOCIAL_LABELS[social.network];
					const anchor = el("a", { class: "sf-social", href, target: "_blank", rel: "noopener noreferrer me", title: label }, socialIcon(social.network, 20));
					anchor.setAttribute("aria-label", label);
					return anchor;
				})
			)
		: null;

	const shop = el(
		"div",
		{},
		el("h4", {}, t("shop.shop")),
		el("a", { href: ctx.link("/search") }, t("shop.all_products")),
		...topCategories(store)
			.slice(0, 8)
			.map((category) => el("a", { href: ctx.link(`/c/${category.slug}`) }, category.name))
	);

	const info = el(
		"div",
		{},
		el("h4", {}, t("shop.information")),
		...config.pages.filter((page) => page.footer).map((page) => el("a", { href: ctx.link(`/page/${page.slug}`) }, page.title)),
		el("a", { href: ctx.link("/account") }, t("shop.account")),
		config.contact.email ? el("a", { class: "sf-contact", href: `mailto:${config.contact.email}` }, icon("mail", 16), config.contact.email) : null,
		config.contact.phone
			? el("a", { class: "sf-contact", href: `tel:${config.contact.phone.replace(/\s/g, "")}` }, icon("phone", 16), config.contact.phone)
			: null
	);

	const legal = [
		`© ${new Date().getFullYear()} ${store.seller.legal_name ?? store.seller.name}`,
		store.seller.vat_number ? `${t("shop.vat_id")} ${store.seller.vat_number}` : null,
		store.seller.registration_number ? `${t("shop.registration")} ${store.seller.registration_number}` : null,
	].filter(Boolean);

	return el(
		"footer",
		{ class: "sf-footer" },
		el(
			"div",
			{ class: "sf-container sf-footer-grid" },
			el(
				"div",
				{ class: "sf-footer-brand" },
				brand(ctx),
				config.tagline ? el("p", { class: "sf-muted" }, config.tagline) : null,
				config.footer_text ? el("p", { class: "sf-muted" }, config.footer_text) : null,
				socials
			),
			shop,
			info,
			locationBlock(ctx) ??
				(store.seller.address.length ? el("div", {}, el("h4", {}, t("shop.company")), ...store.seller.address.map((line) => el("span", {}, line))) : el("div"))
		),
		el(
			"div",
			{ class: "sf-container sf-footer-bottom" },
			el("span", {}, legal.join(" | ")),
			languagePicker(ctx),
			store.payment_methods.length
				? el("div", { class: "sf-methods" }, ...store.payment_methods.map((method) => el("span", { class: "sf-method" }, processorLabel(method.processor))))
				: null,
			store.branding.white_label
				? null
				: el(
						"a",
						{ class: "sf-powered", href: "https://github.com/Rabbit-Company/RabbitPay-Server", target: "_blank", rel: "noopener noreferrer" },
						logo(),
						"RabbitPay"
					)
		)
	);
}

function privacyNotice(ctx: StoreContext): HTMLElement | null {
	try {
		if (localStorage.getItem(NOTICE_KEY) === "1") return null;
	} catch {
		return null;
	}
	const notice = el(
		"div",
		{ class: "sf-notice" },
		el("p", {}, t("shop.notice"), " ", el("a", { href: ctx.link("/page/privacy") }, t("shop.privacy_policy"))),
		el(
			"button",
			{
				class: "sf-button sf-button-small",
				type: "button",
				onClick: () => {
					try {
						localStorage.setItem(NOTICE_KEY, "1");
					} catch {
						void 0;
					}
					notice.remove();
				},
			},
			t("shop.notice_ok")
		)
	);
	notice.setAttribute("role", "region");
	notice.setAttribute("aria-label", t("shop.privacy_policy"));
	return notice;
}

export function storeLayout(ctx: StoreContext, content: HTMLElement, title: string | null = null): HTMLElement {
	applyStoreTheme(ctx.store);
	setTitle(ctx, title);
	onLeave(() => {
		document.body.classList.remove("sf-locked");
		resetStoreTheme();
	});
	const theme = ctx.store.config.theme;
	const root = el(
		"div",
		{ class: `sf sf-radius-${theme.radius} sf-cards-${theme.card_style} sf-columns-${theme.columns}` },
		...header(ctx),
		el("main", { class: "sf-main" }, content),
		footer(ctx),
		privacyNotice(ctx)
	);
	applyThemeShape(root, theme);
	return root;
}

export function applyThemeShape(node: HTMLElement, theme: Pick<Storefront["config"]["theme"], "font" | "radius">) {
	node.style.setProperty("--sf-font", FONTS[theme.font] ?? FONTS.system);
	node.style.setProperty("--sf-radius", RADII[theme.radius] ?? RADII.soft);
}

export function applyStorePreviewTheme(node: HTMLElement, theme: Pick<Storefront["config"]["theme"], "font" | "radius" | "accent">) {
	applyThemeShape(node, theme);
	node.style.setProperty("--accent", theme.accent);
	node.style.setProperty("--accent-text", accentTextFor(theme.accent));
	node.classList.add("sf-prose-preview");
}

export function availabilityLabel(product: Pick<ProductCard, "availability" | "stock" | "restock_at" | "digital">): HTMLElement {
	const labels: Record<ProductCard["availability"], string> = {
		in_stock: product.digital ? t("shop.instant_delivery") : t("shop.in_stock"),
		low_stock: t("shop.low_stock", { count: product.stock ?? 0 }),
		backorder: t("shop.backorder"),
		out_of_stock: t("shop.out_of_stock"),
	};
	return el("span", { class: `sf-stock sf-stock-${product.availability}` }, el("span", { class: "sf-dot" }), labels[product.availability]);
}

export function priceBlock(product: Pick<ProductCard, "price" | "compare_price" | "currency">, large = false): HTMLElement {
	const off = percentOff(product.price, product.compare_price);
	return el(
		"div",
		{ class: `sf-price${large ? " sf-price-large" : ""}` },
		el("span", { class: off ? "sf-price-now sf-sale" : "sf-price-now" }, money(product.price, product.currency)),
		off ? el("s", { class: "sf-price-was" }, money(product.compare_price!, product.currency)) : null
	);
}

export function quantityStepper(value: number, max: number | null, onChange: (value: number) => void): HTMLElement {
	const limit = Math.min(max ?? 999, 999);
	const field = el("input", { type: "number", min: "1", max: String(limit), step: "1", value: String(value) });
	field.setAttribute("aria-label", t("shop.quantity"));
	const set = (next: number) => {
		const clamped = Math.min(Math.max(Math.round(next) || 1, 1), limit);
		field.value = String(clamped);
		onChange(clamped);
	};
	field.addEventListener("change", () => set(Number(field.value)));
	return el(
		"div",
		{ class: "sf-stepper" },
		el("button", { type: "button", title: t("shop.decrease"), onClick: () => set(Number(field.value) - 1) }, icon("minus", 16)),
		field,
		el("button", { type: "button", title: t("shop.increase"), onClick: () => set(Number(field.value) + 1) }, icon("plus", 16))
	);
}

let drawerOverlay: HTMLElement | null = null;

export function showAdded(ctx: StoreContext, product: Pick<ProductCard, "name" | "image" | "price" | "currency">, quantity: number) {
	drawerOverlay?.remove();
	const close = () => {
		overlay.remove();
		drawerOverlay = null;
	};
	const panel = el(
		"div",
		{ class: "sf-added" },
		el(
			"div",
			{ class: "sf-added-head" },
			el("span", { class: "sf-added-check" }, icon("check", 16)),
			el("strong", {}, t("shop.added")),
			el("button", { class: "sf-icon-button", type: "button", onClick: close }, icon("close", 18))
		),
		el(
			"div",
			{ class: "sf-added-line" },
			product.image ? el("img", { src: product.image.url, alt: "" }) : el("div", { class: "sf-thumb-empty" }, icon("box", 22)),
			el("div", {}, el("strong", {}, product.name), el("span", { class: "sf-muted" }, `${quantity} x ${money(product.price, product.currency)}`))
		),
		el(
			"div",
			{ class: "sf-added-actions" },
			el("a", { class: "sf-button sf-button-ghost", href: ctx.link("/cart"), onClick: close }, t("shop.view_cart", { count: cartCount(ctx.store.slug) })),
			el("a", { class: "sf-button", href: ctx.link("/checkout"), onClick: close }, t("shop.checkout"))
		)
	);
	const overlay = el("div", { class: "sf-added-overlay" }, panel);
	overlay.addEventListener("click", (event) => {
		if (event.target === overlay) close();
	});
	document.querySelector(".sf")?.append(overlay);
	drawerOverlay = overlay;
	setTimeout(() => {
		if (drawerOverlay === overlay) close();
	}, 6000);
	onLeave(close);
}

export function productCard(ctx: StoreContext, product: ProductCard): HTMLElement {
	const href = ctx.link(`/p/${product.slug}`);
	const off = percentOff(product.price, product.compare_price);
	const media = el(
		"a",
		{ class: "sf-card-media", href },
		product.image
			? el("img", { src: product.image.url, alt: product.image.alt ?? product.name, class: "sf-card-image" })
			: el("div", { class: "sf-card-placeholder" }, icon("box", 36)),
		product.hover_image ? el("img", { src: product.hover_image.url, alt: "", class: "sf-card-image sf-card-hover" }) : null,
		el(
			"div",
			{ class: "sf-card-badges" },
			off ? el("span", { class: "sf-tag sf-tag-sale" }, `-${off}%`) : null,
			product.availability === "out_of_stock" ? el("span", { class: "sf-tag sf-tag-muted" }, t("shop.sold_out")) : null,
			product.digital ? el("span", { class: "sf-tag" }, icon("bolt", 12), t("shop.digital")) : null
		)
	);
	for (const image of media.querySelectorAll("img")) image.loading = "lazy";

	const quickAdd =
		product.availability === "out_of_stock" || product.license
			? null
			: el(
					"button",
					{
						class: "sf-card-add",
						type: "button",
						title: t("shop.add_to_cart"),
						onClick: (event) => {
							event.preventDefault();
							addToCart(
								ctx.store.slug,
								{
									product: product.uuid,
									slug: product.slug,
									name: product.name,
									image: product.image?.url ?? null,
									price: product.price,
									currency: product.currency,
								},
								1
							);
							showAdded(ctx, product, 1);
						},
					},
					icon("plus", 18)
				);
	quickAdd?.setAttribute("aria-label", `${t("shop.add_to_cart")}: ${product.name}`);

	return el(
		"article",
		{ class: "sf-card" },
		media,
		el(
			"div",
			{ class: "sf-card-body" },
			product.category ? el("a", { class: "sf-card-category", href: ctx.link(`/c/${product.category.slug}`) }, product.category.name) : null,
			el("a", { class: "sf-card-title", href }, product.name),
			product.summary ? el("p", { class: "sf-card-summary" }, product.summary) : null,
			el(
				"div",
				{ class: "sf-card-foot" },
				el("div", {}, product.license ? el("span", { class: "sf-muted" }, t("shop.price_from")) : null, priceBlock(product), availabilityLabel(product)),
				quickAdd
			)
		)
	);
}

export function productGrid(ctx: StoreContext, products: ProductCard[]): HTMLElement {
	return el("div", { class: "sf-grid" }, ...products.map((product) => productCard(ctx, product)));
}

export function breadcrumbs(ctx: StoreContext, trail: { label: string; href?: string }[]): HTMLElement {
	const nav = el(
		"nav",
		{ class: "sf-breadcrumbs" },
		el("a", { href: ctx.link() }, t("shop.home")),
		...trail.flatMap((entry) => [
			el("span", { class: "sf-crumb-sep" }, icon("right", 14)),
			entry.href ? el("a", { href: entry.href }, entry.label) : el("span", {}, entry.label),
		])
	);
	nav.setAttribute("aria-label", t("shop.breadcrumbs"));
	return nav;
}

export function emptyBlock(iconName: string, title: string, body: string, action?: HTMLElement): HTMLElement {
	return el(
		"div",
		{ class: "sf-empty" },
		el("div", { class: "sf-empty-icon" }, icon(iconName, 32)),
		el("h2", {}, title),
		el("p", { class: "sf-muted" }, body),
		action
	);
}

export function markdownBlock(html: string): HTMLElement {
	const block = el("div", { class: "sf-prose" });
	block.innerHTML = html;
	zoomableImages(block);
	return block;
}

export function storeError(error: unknown): HTMLElement {
	const message = error instanceof ApiError ? errorText(error.code, error.message) : error instanceof Error ? error.message : t("ui.load_failed");
	return el(
		"div",
		{ class: "sf-closed-store" },
		el("div", { class: "sf-empty-icon" }, icon("bag", 32)),
		el("h1", {}, t("shop.unavailable")),
		el("p", {}, message)
	);
}
