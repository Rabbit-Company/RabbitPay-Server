import { el } from "../dom";
import { t, tn } from "../i18n";
import { navigate, onLeave } from "../router";
import { openLightbox } from "../lightbox";
import { renderMarkdown } from "../../../server/markdown";
import { StoreApi, type Facet, type ProductCard, type ProductDetails, type ProductPage } from "./api";
import { addToCart } from "./cart";
import { icon } from "./icons";
import { cutoffLeft, deliveryWindow, describeWindow, duration, longDate, money } from "./format";
import {
	availabilityLabel,
	breadcrumbs,
	childCategories,
	emptyBlock,
	locationBlock,
	markdownBlock,
	priceBlock,
	productGrid,
	quantityStepper,
	showAdded,
	storeContext,
	storeLayout,
	topCategories,
	type StoreContext,
} from "./layout";

const PAGE_SIZE = 24;

function section(title: string, action: HTMLElement | null, ...content: HTMLElement[]): HTMLElement {
	return el("section", { class: "sf-section" }, el("div", { class: "sf-section-head" }, el("h2", {}, title), action), ...content);
}

function hero(ctx: StoreContext): HTMLElement {
	const { config, hero: image } = ctx.store;
	const style = config.theme.hero_style === "image" && !image ? "gradient" : config.theme.hero_style;
	const cta = el(
		"a",
		{ class: "sf-button sf-button-large", href: config.hero.cta_link ?? ctx.link("/search") },
		config.hero.cta_label ?? t("shop.shop_now"),
		icon("right", 18)
	);
	const copy = el(
		"div",
		{ class: "sf-hero-copy" },
		config.tagline ? el("span", { class: "sf-eyebrow" }, config.tagline) : null,
		el("h1", {}, config.hero.title ?? config.name),
		config.hero.subtitle ? el("p", {}, config.hero.subtitle) : null,
		el("div", { class: "sf-hero-actions" }, cta)
	);
	const node = el(
		"section",
		{ class: `sf-hero sf-hero-${style}` },
		el(
			"div",
			{ class: "sf-container sf-hero-inner" },
			copy,
			style === "split" && image ? el("div", { class: "sf-hero-media" }, el("img", { src: image, alt: "" })) : null
		)
	);
	if (style === "image" && image) node.style.backgroundImage = `url("${image}")`;
	return node;
}

function categoryTiles(ctx: StoreContext): HTMLElement | null {
	const categories = topCategories(ctx.store).slice(0, 8);
	if (categories.length < 2) return null;
	return section(
		t("shop.browse_categories"),
		null,
		el(
			"div",
			{ class: "sf-tiles" },
			...categories.map((category, index) => {
				const tile = el(
					"a",
					{ class: "sf-tile", href: ctx.link(`/c/${category.slug}`) },
					el("span", { class: "sf-tile-name" }, category.name),
					el("span", { class: "sf-tile-count" }, tn("count.products", category.count)),
					el("span", { class: "sf-tile-arrow" }, icon("right", 18))
				);
				tile.style.setProperty("--tile", String(index));
				return tile;
			})
		)
	);
}

function perks(ctx: StoreContext): HTMLElement {
	const { config, payment_methods: methods } = ctx.store;
	const shipping = config.shipping.filter((option) => !option.pickup);
	const cheapest = shipping.reduce<(typeof shipping)[number] | null>((best, option) => (best === null || option.price < best.price ? option : best), null);
	const freeFrom = shipping.map((option) => option.free_from).filter((value): value is number => value !== null);
	const shippingText =
		freeFrom.length > 0
			? t("shop.perk_free_shipping", { amount: money(Math.min(...freeFrom), ctx.store.currency) })
			: cheapest
				? t("shop.perk_delivery_days", { min: cheapest.min_days + config.delivery.min_days, max: cheapest.max_days + config.delivery.max_days })
				: t("shop.perk_fast");
	const items = [
		{ icon: "truck", title: t("shop.perk_shipping"), body: shippingText },
		{
			icon: "lock",
			title: t("shop.perk_secure"),
			body: methods.length
				? methods
						.map((method) => method.label)
						.slice(0, 4)
						.join(", ")
				: t("shop.perk_secure_body"),
		},
		{ icon: "undo", title: t("shop.perk_returns"), body: t("shop.perk_returns_body") },
		config.location.enabled
			? { icon: "pin", title: t("shop.perk_pickup"), body: config.location.name ?? t("shop.perk_pickup_body") }
			: { icon: "shield", title: t("shop.perk_privacy"), body: t("shop.perk_privacy_body") },
	];
	return el(
		"section",
		{ class: "sf-perks" },
		...items.map((item) =>
			el(
				"div",
				{ class: "sf-perk" },
				el("span", { class: "sf-perk-icon" }, icon(item.icon, 22)),
				el("div", {}, el("strong", {}, item.title), el("span", {}, item.body))
			)
		)
	);
}

export async function homeView(slug: string): Promise<HTMLElement> {
	const ctx = await storeContext(slug);
	const [featured, newest] = await Promise.all([StoreApi.products(slug, { featured: true, limit: 8 }), StoreApi.products(slug, { sort: "newest", limit: 8 })]);
	const spotlight = featured.products.length ? featured.products : newest.products;
	const newestOnly = newest.products.filter((product) => !spotlight.some((entry) => entry.uuid === product.uuid));
	const location = locationBlock(ctx, false);

	const content = el(
		"div",
		{},
		hero(ctx),
		el(
			"div",
			{ class: "sf-container" },
			perks(ctx),
			categoryTiles(ctx),
			spotlight.length
				? section(
						featured.products.length ? t("shop.featured") : t("shop.new_arrivals"),
						el("a", { class: "sf-link", href: ctx.link("/search") }, t("shop.view_all"), icon("right", 16)),
						productGrid(ctx, spotlight)
					)
				: emptyBlock("box", t("shop.empty_store_title"), t("shop.empty_store_body")),
			newestOnly.length && featured.products.length
				? section(
						t("shop.new_arrivals"),
						el("a", { class: "sf-link", href: `${ctx.link("/search")}?sort=newest` }, t("shop.view_all"), icon("right", 16)),
						productGrid(ctx, newestOnly.slice(0, 4))
					)
				: null,
			location
				? el(
						"section",
						{ class: "sf-visit" },
						el(
							"div",
							{},
							el("span", { class: "sf-eyebrow" }, t("shop.visit_us")),
							el("h2", {}, ctx.store.config.location.name ?? ctx.store.config.name),
							el("p", { class: "sf-muted" }, t("shop.visit_body"))
						),
						location
					)
				: null
		)
	);
	return storeLayout(ctx, content);
}

interface ListingState {
	sort: string;
	stock: boolean;
	filters: [string, string][];
	query: string;
}

function readState(): ListingState {
	const params = new URLSearchParams(window.location.search);
	return {
		sort: params.get("sort") ?? "featured",
		stock: params.get("stock") === "1",
		filters: params
			.getAll("f")
			.map((raw) => {
				const split = raw.indexOf("=");
				return split > 0 ? ([raw.slice(0, split), raw.slice(split + 1)] as [string, string]) : null;
			})
			.filter((entry): entry is [string, string] => entry !== null),
		query: params.get("q") ?? "",
	};
}

function writeState(state: ListingState) {
	const params = new URLSearchParams();
	if (state.query) params.set("q", state.query);
	if (state.sort !== "featured") params.set("sort", state.sort);
	if (state.stock) params.set("stock", "1");
	for (const [name, value] of state.filters) params.append("f", `${name}=${value}`);
	const text = params.toString();
	history.replaceState(history.state, "", `${window.location.pathname}${text ? `?${text}` : ""}`);
}

function facetPanel(facets: Facet[], state: ListingState, onChange: () => void): HTMLElement {
	const stock = el("input", { type: "checkbox" });
	stock.checked = state.stock;
	stock.addEventListener("change", () => {
		state.stock = stock.checked;
		onChange();
	});

	const groups = facets.map((facet) => {
		const selected = new Set(state.filters.filter(([name]) => name === facet.name).map(([, value]) => value));
		const details = el(
			"details",
			{ class: "sf-facet" },
			el("summary", {}, facet.name, selected.size ? el("span", { class: "sf-facet-count" }, String(selected.size)) : null, icon("down", 16)),
			el(
				"div",
				{ class: "sf-facet-options" },
				...facet.values.map((option) => {
					const box = el("input", { type: "checkbox" });
					box.checked = selected.has(option.value);
					box.addEventListener("change", () => {
						state.filters = box.checked
							? [...state.filters, [facet.name, option.value]]
							: state.filters.filter(([name, value]) => !(name === facet.name && value === option.value));
						onChange();
					});
					return el("label", { class: "sf-check" }, box, el("span", {}, option.value), el("span", { class: "sf-count" }, String(option.count)));
				})
			)
		);
		details.open = selected.size > 0 || facets.length <= 4;
		return details;
	});

	return el(
		"div",
		{ class: "sf-facets" },
		el("label", { class: "sf-switch" }, stock, el("span", {}, t("shop.in_stock_only"))),
		...groups,
		state.filters.length || state.stock
			? el(
					"button",
					{
						class: "sf-button sf-button-ghost sf-button-small",
						type: "button",
						onClick: () => {
							state.filters = [];
							state.stock = false;
							onChange();
						},
					},
					t("shop.clear_filters")
				)
			: null
	);
}

async function listingView(slug: string, category: string | null): Promise<HTMLElement> {
	const ctx = await storeContext(slug);
	const state = readState();
	const load = (offset: number, facets: boolean) =>
		StoreApi.products(slug, {
			category: category ?? undefined,
			q: state.query || undefined,
			sort: state.sort,
			stock: state.stock,
			filters: state.filters,
			facets,
			limit: PAGE_SIZE,
			offset,
		});

	let page: ProductPage = await load(0, true);
	let loaded: ProductCard[] = page.products;
	const grid = el("div", {});
	const count = el("span", { class: "sf-muted" });
	const more = el("button", { class: "sf-button sf-button-ghost", type: "button" }, t("shop.load_more"));
	const sidebar = el("aside", { class: "sf-sidebar" });
	const chips = el("div", { class: "sf-chips" });

	const sort = el(
		"select",
		{ class: "sf-select" },
		...[
			["featured", t("shop.sort_featured")],
			["newest", t("shop.sort_newest")],
			["price_asc", t("shop.sort_price_asc")],
			["price_desc", t("shop.sort_price_desc")],
			["name", t("shop.sort_name")],
		].map(([value, label]) => {
			const option = el("option", { value }, label);
			option.selected = value === state.sort;
			return option;
		})
	);
	sort.setAttribute("aria-label", t("shop.sort"));

	let round = 0;
	const refresh = async () => {
		const current = ++round;
		writeState(state);
		grid.classList.add("sf-loading");
		try {
			const next = await load(0, true);
			if (current !== round) return;
			page = next;
			loaded = next.products;
			render();
		} finally {
			grid.classList.remove("sf-loading");
		}
	};

	const render = () => {
		count.textContent = tn("count.products", page.total);
		grid.replaceChildren(
			loaded.length
				? productGrid(ctx, loaded)
				: emptyBlock(
						"search",
						t("shop.no_results_title"),
						state.query ? t("shop.no_results_query", { query: state.query }) : t("shop.no_results_body"),
						state.filters.length || state.stock
							? el(
									"button",
									{
										class: "sf-button sf-button-ghost",
										type: "button",
										onClick: () => {
											state.filters = [];
											state.stock = false;
											void refresh();
										},
									},
									t("shop.clear_filters")
								)
							: undefined
					)
		);
		more.hidden = loaded.length >= page.total;
		sidebar.replaceChildren(page.facets && (page.facets.length || loaded.length) ? facetPanel(page.facets, state, () => void refresh()) : el("div"));
		chips.replaceChildren(
			...state.filters.map(([name, value]) =>
				el(
					"button",
					{
						class: "sf-chip",
						type: "button",
						onClick: () => {
							state.filters = state.filters.filter(([entry, option]) => !(entry === name && option === value));
							void refresh();
						},
					},
					`${name}: ${value}`,
					icon("close", 14)
				)
			)
		);
	};

	sort.addEventListener("change", () => {
		state.sort = sort.value;
		void refresh();
	});
	more.addEventListener("click", async () => {
		more.disabled = true;
		try {
			const next = await load(loaded.length, false);
			loaded = [...loaded, ...next.products];
			page = { ...page, total: next.total };
			render();
		} finally {
			more.disabled = false;
		}
	});

	const filterToggle = el(
		"button",
		{
			class: "sf-button sf-button-ghost sf-filter-toggle",
			type: "button",
			onClick: () => {
				const open = !sidebar.classList.contains("open");
				sidebar.classList.toggle("open", open);
				document.body.classList.toggle("sf-locked", open);
			},
		},
		icon("filter", 18),
		t("shop.filters")
	);
	onLeave(() => document.body.classList.remove("sf-locked"));

	render();

	const info = page.category;
	const children = info ? childCategories(ctx.store, info.uuid) : [];
	const title = info ? info.name : state.query ? t("shop.results_for", { query: state.query }) : t("shop.all_products");
	const trail = info
		? info.trail.map((entry, index) => ({ label: entry.name, href: index < info.trail.length - 1 ? ctx.link(`/c/${entry.slug}`) : undefined }))
		: [{ label: title }];

	const content = el(
		"div",
		{ class: "sf-container sf-listing" },
		breadcrumbs(ctx, trail),
		el(
			"div",
			{ class: "sf-listing-head" },
			el("div", {}, el("h1", {}, title), info?.description ? el("p", { class: "sf-muted sf-lead" }, info.description) : null),
			el("div", { class: "sf-listing-tools" }, count, filterToggle, sort)
		),
		children.length
			? el(
					"div",
					{ class: "sf-subcategories" },
					...children.map((child) =>
						el("a", { class: "sf-pill", href: ctx.link(`/c/${child.slug}`) }, child.name, el("span", { class: "sf-count" }, String(child.count)))
					)
				)
			: null,
		chips,
		el("div", { class: "sf-listing-body" }, sidebar, el("div", { class: "sf-listing-results" }, grid, el("div", { class: "sf-more" }, more)))
	);
	return storeLayout(ctx, content, title);
}

export function categoryView(slug: string, category: string): Promise<HTMLElement> {
	return listingView(slug, category);
}

export function searchView(slug: string): Promise<HTMLElement> {
	return listingView(slug, null);
}

function gallery(product: ProductDetails): HTMLElement {
	if (product.images.length === 0) return el("div", { class: "sf-gallery" }, el("div", { class: "sf-gallery-main sf-card-placeholder" }, icon("box", 64)));
	let index = 0;
	const main = el("img", { class: "sf-gallery-image", src: product.images[0].url, alt: product.images[0].alt ?? product.name });
	const thumbs = product.images.map((image, position) => {
		const button = el("button", { class: "sf-thumb", type: "button", onClick: () => show(position) }, el("img", { src: image.url, alt: image.alt ?? "" }));
		button.setAttribute("aria-label", `${t("shop.image")} ${position + 1}`);
		return button;
	});
	const show = (next: number) => {
		index = (next + product.images.length) % product.images.length;
		main.src = product.images[index].url;
		main.alt = product.images[index].alt ?? product.name;
		thumbs.forEach((thumb, position) => thumb.classList.toggle("active", position === index));
	};
	show(0);

	const zoom = () =>
		openLightbox(
			product.images.map((image) => ({ src: image.url, alt: image.alt ?? product.name })),
			index,
			show
		);

	const mainButton = el("button", { class: "sf-gallery-main", type: "button", title: t("shop.zoom"), onClick: zoom }, main);
	return el("div", { class: "sf-gallery" }, mainButton, product.images.length > 1 ? el("div", { class: "sf-thumbs" }, ...thumbs) : null);
}

function deliveryPanel(ctx: StoreContext, product: ProductDetails): HTMLElement | null {
	const rules = ctx.store.config.delivery;
	if (product.digital)
		return el(
			"div",
			{ class: "sf-delivery" },
			icon("bolt", 20),
			el("div", {}, el("strong", {}, t("shop.digital_delivery")), el("span", {}, t("shop.digital_delivery_body")))
		);
	if (product.availability === "out_of_stock") {
		return el(
			"div",
			{ class: "sf-delivery sf-delivery-muted" },
			icon("calendar", 20),
			el(
				"div",
				{},
				el("strong", {}, product.restock_at ? t("shop.restock_on", { date: longDate(product.restock_at) }) : t("shop.restock_unknown")),
				el("span", {}, t("shop.restock_body"))
			)
		);
	}
	const restock = product.availability === "backorder" ? product.restock_at : null;
	const shipping = ctx.store.config.shipping.find((option) => !option.pickup);
	const days = { min_days: product.delivery.min_days + (shipping?.min_days ?? 0), max_days: product.delivery.max_days + (shipping?.max_days ?? 0) };
	const window = deliveryWindow(days, rules, restock);
	const left = restock === null ? cutoffLeft(rules.cutoff_hour) : null;
	return el(
		"div",
		{ class: "sf-delivery" },
		icon("truck", 20),
		el(
			"div",
			{},
			el("strong", {}, t("shop.arrives", { range: describeWindow(window) })),
			el(
				"span",
				{},
				window.shipsFrom
					? t("shop.ships_from", { date: longDate(window.shipsFrom) })
					: left
						? t("shop.order_within", { time: duration(left) })
						: t("shop.delivery_estimate")
			)
		)
	);
}

export async function productView(slug: string, productSlug: string): Promise<HTMLElement> {
	const ctx = await storeContext(slug);
	const product = await StoreApi.product(slug, productSlug);
	let quantity = 1;
	const maxQuantity = product.availability === "backorder" || product.stock === null ? null : product.stock;
	const unavailable = product.availability === "out_of_stock";

	const add = el(
		"button",
		{
			class: "sf-button sf-button-large sf-add",
			type: "button",
			disabled: unavailable,
			onClick: () => {
				addToCart(
					slug,
					{
						product: product.uuid,
						slug: product.slug,
						name: product.name,
						image: product.images[0]?.url ?? null,
						price: product.price,
						currency: product.currency,
					},
					quantity
				);
				showAdded(ctx, product, quantity);
			},
		},
		icon("bag", 20),
		unavailable ? t("shop.sold_out") : product.availability === "backorder" ? t("shop.preorder") : t("shop.add_to_cart")
	);

	const specs = product.attributes.length
		? el(
				"section",
				{ class: "sf-specs" },
				el("h2", {}, t("shop.specifications")),
				el("table", {}, el("tbody", {}, ...product.attributes.map((attribute) => el("tr", {}, el("th", {}, attribute.name), el("td", {}, attribute.value)))))
			)
		: null;
	const description = product.description
		? el("section", { class: "sf-description" }, el("h2", {}, t("shop.description")), markdownBlock(renderMarkdown(product.description)))
		: null;

	const trail = [...product.trail.map((entry) => ({ label: entry.name, href: ctx.link(`/c/${entry.slug}`) })), { label: product.name }];
	const content = el(
		"div",
		{ class: "sf-container sf-product" },
		breadcrumbs(ctx, trail),
		el(
			"div",
			{ class: "sf-product-top" },
			gallery(product),
			el(
				"div",
				{ class: "sf-product-info" },
				product.category ? el("a", { class: "sf-card-category", href: ctx.link(`/c/${product.category.slug}`) }, product.category.name) : null,
				el("h1", {}, product.name),
				product.sku ? el("span", { class: "sf-sku" }, `${t("shop.sku")} ${product.sku}`) : null,
				priceBlock(product, true),
				el("span", { class: "sf-muted sf-tax-note" }, product.tax_rate > 0 ? t("shop.includes_vat", { rate: product.tax_rate }) : t("shop.no_vat")),
				product.summary ? el("p", { class: "sf-lead" }, product.summary) : null,
				availabilityLabel(product),
				deliveryPanel(ctx, product),
				el("div", { class: "sf-buy" }, unavailable ? null : quantityStepper(1, maxQuantity, (value) => (quantity = value)), add),
				el(
					"ul",
					{ class: "sf-assurances" },
					el("li", {}, icon("lock", 16), t("shop.perk_secure")),
					product.digital ? el("li", {}, icon("bolt", 16), t("shop.digital_delivery")) : el("li", {}, icon("undo", 16), t("shop.perk_returns_body"))
				)
			)
		),
		el("div", { class: "sf-product-details" }, description, specs),
		product.related.length ? section(t("shop.related"), null, productGrid(ctx, product.related)) : null
	);
	return storeLayout(ctx, content, product.name);
}

export async function pageView(slug: string, pageSlug: string): Promise<HTMLElement> {
	const ctx = await storeContext(slug);
	const page = ctx.store.config.pages.find((entry) => entry.slug === pageSlug);
	if (!page) {
		navigate(ctx.link(), true);
		return el("div");
	}
	const seller = ctx.store.seller;
	const legal =
		page.slug === "privacy" || page.slug === "terms"
			? el(
					"aside",
					{ class: "sf-legal-card" },
					el("strong", {}, seller.legal_name ?? seller.name),
					...seller.address.map((line) => el("span", {}, line)),
					seller.vat_number ? el("span", {}, `${t("shop.vat_id")} ${seller.vat_number}`) : null,
					seller.registration_number ? el("span", {}, `${t("shop.registration")} ${seller.registration_number}`) : null,
					seller.email ? el("a", { href: `mailto:${seller.email}` }, seller.email) : null
				)
			: null;
	const content = el(
		"div",
		{ class: "sf-container sf-page" },
		breadcrumbs(ctx, [{ label: page.title }]),
		el("h1", {}, page.title),
		el("div", { class: "sf-page-body" }, markdownBlock(renderMarkdown(page.content)), legal)
	);
	return storeLayout(ctx, content, page.title);
}
