import Database from "../database/database";
import Utils from "../utils";
import { escapeHtml, markdownText } from "../markdown";
import { minorUnitDigits } from "../invoicing";
import { storeActive } from "../licensing";
import { brandImages, imagePath, storeUrl, type LoadedStore } from "./store";
import { categoriesOf, descendantsOf, presentCards, productBySlug, translatedRow } from "./catalog";
import { imagesOf } from "./images";
import { localizeConfig, offeredLanguages, storeLanguages, type StoreLanguage } from "./languages";
import { productTexts, translatedCategories } from "./translations";
import type { Availability } from "./config";
import type { ProjectRow, StoreSettingsRow } from "../database/models";

const SITEMAP_LIMIT = 50000;
const STORE_ROUTE = /^\/(c|p|page)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;

const SCHEMA_AVAILABILITY: Record<Availability, string> = {
	in_stock: "https://schema.org/InStock",
	low_stock: "https://schema.org/LimitedAvailability",
	backorder: "https://schema.org/BackOrder",
	out_of_stock: "https://schema.org/OutOfStock",
};

export const STORE_PRIVATE_PATHS = ["/cart", "/checkout", "/order/", "/account", "/search"];

export interface Alternate {
	language: string;
	url: string;
}

export interface StorePageMeta {
	status: 200 | 404;
	indexable: boolean;
	language: string;
	site: string;
	title: string;
	description: string | null;
	image: string | null;
	type: "website" | "product";
	url: string | null;
	alternates: Alternate[];
	price: { amount: string; currency: string } | null;
	structured: Record<string, unknown> | null;
}

interface StoreLanguages {
	codes: string[];
	translated: StoreLanguage | null;
}

async function languagesOf(store: LoadedStore, requested: string | null): Promise<StoreLanguages> {
	const main = store.config.language;
	const offered = offeredLanguages(await storeLanguages(store.project.uuid), main);
	return {
		codes: [main, ...offered.filter((language) => language.code !== main).map((language) => language.code)],
		translated: offered.find((language) => language.code === requested && language.code !== main) ?? null,
	};
}

export function pageUrl(store: Pick<LoadedStore, "settings" | "config">, path: string, language: string): string {
	const base = storeUrl(store.settings);
	const url = path === "/" ? (store.settings.domain ? `${base}/` : base) : `${base}${path}`;
	return language === store.config.language ? url : `${url}?lang=${encodeURIComponent(language)}`;
}

function alternatesOf(store: LoadedStore, path: string, codes: string[]): Alternate[] {
	if (codes.length < 2) return [];
	return [
		...codes.map((code) => ({ language: code, url: pageUrl(store, path, code) })),
		{ language: "x-default", url: pageUrl(store, path, store.config.language) },
	];
}

function absolute(path: string | null): string | null {
	return path === null ? null : `${Utils.publicUrl()}${path}`;
}

function decimal(amount: number, currency: string): string {
	const digits = minorUnitDigits(currency);
	return (amount / Math.pow(10, digits)).toFixed(digits);
}

export async function storePageMeta(store: LoadedStore, path: string, requested: string | null): Promise<StorePageMeta> {
	const projectId = store.project.uuid;
	const { codes, translated } = await languagesOf(store, requested);
	const code = translated?.code ?? null;
	const language = code ?? store.config.language;
	const config = translated ? localizeConfig(store.config, translated.content) : store.config;
	const brand = await brandImages(projectId);

	const plain: StorePageMeta = {
		status: 200,
		indexable: false,
		language,
		site: config.name,
		title: config.name,
		description: markdownText(config.description ?? config.tagline, 300) || null,
		image: absolute(brand.hero ?? brand.logo),
		type: "website",
		url: null,
		alternates: [],
		price: null,
		structured: null,
	};
	const listed = (target: string, fields: Partial<StorePageMeta>): StorePageMeta => ({
		...plain,
		...fields,
		indexable: store.config.indexable,
		url: pageUrl(store, target, language),
		alternates: alternatesOf(store, target, codes),
	});
	const missing: StorePageMeta = { ...plain, status: 404 };

	if (path === "/" || path === "") return listed("/", { title: config.tagline ? `${config.name} | ${config.tagline}` : config.name });

	const route = path.match(STORE_ROUTE);
	if (!route) return plain;
	const [, kind, slug] = route as [string, string, string];

	if (kind === "page") {
		const page = config.pages.find((entry) => entry.slug === slug);
		if (!page) return missing;
		return listed(`/page/${slug}`, { title: `${page.title} | ${config.name}`, description: markdownText(page.content, 300) || plain.description });
	}

	if (kind === "c") {
		const categories = await translatedCategories(projectId, await categoriesOf(projectId), code);
		const category = categories.find((entry) => entry.slug === slug);
		if (!category) return missing;
		return listed(`/c/${slug}`, { title: `${category.name} | ${config.name}`, description: markdownText(category.description, 300) || plain.description });
	}

	const found = await productBySlug(projectId, slug);
	if (!found) return missing;
	const [texts, [card], images] = await Promise.all([productTexts([found.uuid], code), presentCards(store, [found], code), imagesOf([found.uuid])]);
	const row = translatedRow(found, texts.get(found.uuid));
	const pictures = (images.get(found.uuid) ?? []).map((image) => absolute(imagePath(image))!);
	const description = row.summary || markdownText(row.description, 300) || null;
	const url = pageUrl(store, `/p/${slug}`, language);
	const price = { amount: decimal(card!.price, card!.currency), currency: card!.currency };

	return listed(`/p/${slug}`, {
		title: `${row.name} | ${config.name}`,
		description: description ?? plain.description,
		image: pictures[0] ?? plain.image,
		type: "product",
		price,
		structured: {
			"@context": "https://schema.org",
			"@type": "Product",
			name: row.name,
			description: description ?? undefined,
			sku: row.sku ?? undefined,
			image: pictures.length > 0 ? pictures : undefined,
			category: card!.category?.name,
			offers: {
				"@type": "Offer",
				url,
				price: price.amount,
				priceCurrency: price.currency,
				availability: SCHEMA_AVAILABILITY[card!.availability],
				seller: { "@type": "Organization", name: store.seller.name },
			},
		},
	});
}

function isoDate(time: number): string {
	return new Date(time).toISOString();
}

export async function storeSitemap(store: LoadedStore): Promise<string | null> {
	if (!store.config.indexable) return null;
	const projectId = store.project.uuid;
	const [{ codes }, categories, products] = await Promise.all([
		languagesOf(store, null),
		categoriesOf(projectId),
		Database`
			SELECT sp.slug, sp.store_category, sp.updated, c.updated AS item_updated
			FROM store_products sp JOIN catalog_items c ON c.uuid = sp.item
			WHERE sp.project = ${projectId} AND sp.published = 1 AND c.archived = 0
			ORDER BY sp.featured DESC, sp.sort_order ASC, sp.created DESC
		` as Promise<{ slug: string; store_category: string | null; updated: number; item_updated: number }[]>,
	]);

	const used = new Set(products.map((product) => product.store_category));
	const pages = [
		{ path: "/", updated: store.settings.updated },
		...store.config.pages.map((page) => ({ path: `/page/${page.slug}`, updated: store.settings.updated })),
		...categories
			.filter((category) => descendantsOf(categories, category.uuid).some((id) => used.has(id)))
			.map((category) => ({ path: `/c/${category.slug}`, updated: category.updated })),
		...products.map((product) => ({ path: `/p/${product.slug}`, updated: Math.max(Number(product.updated), Number(product.item_updated)) })),
	].slice(0, Math.floor(SITEMAP_LIMIT / codes.length));

	const entries = pages.flatMap((page) => {
		const links = alternatesOf(store, page.path, codes)
			.map((alternate) => `<xhtml:link rel="alternate" hreflang="${escapeHtml(alternate.language)}" href="${escapeHtml(alternate.url)}"/>`)
			.join("");
		return codes.map((code) => `<url><loc>${escapeHtml(pageUrl(store, page.path, code))}</loc><lastmod>${isoDate(page.updated)}</lastmod>${links}</url>`);
	});

	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
		...entries,
		"</urlset>",
	].join("\n");
}

function indexableConfig(raw: string): boolean {
	try {
		return (JSON.parse(raw) as { indexable?: unknown }).indexable !== false;
	} catch {
		return false;
	}
}

export async function sitemapStores(): Promise<string[]> {
	const rows = (await Database`
		SELECT s.slug, s.config, p.store_until
		FROM store_settings s JOIN projects p ON p.uuid = s.project
		WHERE s.enabled = 1 AND s.domain IS NULL AND p.status = 'active'
		ORDER BY s.slug ASC
	`) as (Pick<StoreSettingsRow, "slug" | "config"> & Pick<ProjectRow, "store_until">)[];
	return rows.filter((row) => storeActive(row) && indexableConfig(row.config)).map((row) => row.slug);
}
