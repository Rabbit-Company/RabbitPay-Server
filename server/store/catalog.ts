import type { SQL } from "bun";
import Database from "../database/database";
import { convertedPrice, sellerOf } from "../pos-sale";
import { currencyRates } from "../rates/forex";
import { suggestTax, type BuyerTax, type SupplyType, type TaxCategory } from "../tax";
import { imagesOf } from "./images";
import { imagePath, type LoadedStore } from "./store";
import { parseLicenseProduct } from "../license-pricing";
import { productTexts, translatedCategories, type ProductText } from "./translations";
import type { Availability } from "./config";
import type { CatalogItemRow, StoreAttributeRow, StoreCategoryRow, StoreImageRow, StoreProductRow } from "../database/models";

export const LOW_STOCK = 5;
export const MAX_FILTER_VALUES = 50;
export const PRODUCT_SORTS = ["featured", "newest", "price_asc", "price_desc", "name"] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

export type ProductRow = CatalogItemRow &
	Omit<StoreProductRow, "project" | "created" | "updated" | "sort_order" | "name"> & {
		store_name: string | null;
		store_sort: number;
		store_created: number;
		available: number | null;
	};

export type { Availability };

export interface Pricing {
	currency: string;
	rates: Record<string, number> | null;
}

export async function pricingFor(currency: string, items: Pick<CatalogItemRow, "currency">[]): Promise<Pricing> {
	if (items.every((item) => item.currency === currency)) return { currency, rates: null };
	const known = await currencyRates();
	return { currency, rates: known.live ? known.rates : null };
}

export function grossOf(net: number, rate: number): number {
	return net + Math.round((net * rate) / 100);
}

export function taxRateFor(store: LoadedStore, item: Pick<CatalogItemRow, "supply_type" | "tax_category" | "tax_rate">, buyer: BuyerTax | null) {
	return suggestTax(sellerOf(store.project), buyer, {
		supplyType: item.supply_type as SupplyType,
		category: item.tax_category as TaxCategory,
		rate: item.tax_rate,
	});
}

export function availabilityOf(row: Pick<ProductRow, "available" | "allow_backorder">, wanted = 1): Availability {
	if (row.available === null) return "in_stock";
	if (row.available >= wanted) return row.available <= LOW_STOCK ? "low_stock" : "in_stock";
	return row.allow_backorder ? "backorder" : "out_of_stock";
}

export function needsShipping(item: Pick<CatalogItemRow, "supply_type" | "delivers_keys">): boolean {
	return item.supply_type === "goods" && !item.delivers_keys;
}

function availableColumn(sql: SQL) {
	return sql`CASE WHEN c.license IS NOT NULL THEN NULL
		WHEN c.delivers_keys = 1
		THEN (SELECT COUNT(*) FROM item_keys k WHERE k.item = c.uuid AND k.status = 'available')
		ELSE sp.stock END`;
}

function selectProducts(sql: SQL) {
	return sql`
		SELECT c.*, sp.name AS store_name, sp.store_category, sp.slug, sp.published, sp.featured, sp.summary, sp.description, sp.compare_price, sp.stock,
			sp.allow_backorder, sp.delivery_min_days, sp.delivery_max_days, sp.restock_at, sp.sort_order AS store_sort, sp.created AS store_created,
			${availableColumn(sql)} AS available
		FROM store_products sp JOIN catalog_items c ON c.uuid = sp.item
	`;
}

function normalized(row: ProductRow): ProductRow {
	return { ...row, available: row.available === null ? null : Number(row.available) };
}

export async function categoriesOf(projectId: string): Promise<StoreCategoryRow[]> {
	return (await Database`SELECT * FROM store_categories WHERE project = ${projectId} ORDER BY sort_order ASC, name ASC`) as StoreCategoryRow[];
}

export function descendantsOf(categories: StoreCategoryRow[], root: string): string[] {
	const found = new Set([root]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const category of categories) {
			if (category.parent_category && found.has(category.parent_category) && !found.has(category.uuid)) {
				found.add(category.uuid);
				grew = true;
			}
		}
	}
	return [...found];
}

export interface ProductQuery {
	categories: string[] | null;
	search: string | null;
	filters: Map<string, string[]>;
	inStock: boolean;
	featured: boolean;
	sort: ProductSort;
	limit: number;
	offset: number;
	language: string | null;
}

function baseFilter(sql: SQL, projectId: string, query: Pick<ProductQuery, "categories" | "search" | "language">) {
	const pattern = query.search === null ? null : `%${query.search.toLowerCase()}%`;
	const category = query.categories === null ? sql`` : sql`AND sp.store_category IN ${sql(query.categories)}`;
	const search =
		pattern === null
			? sql``
			: sql`AND (LOWER(COALESCE(sp.name, c.name)) LIKE ${pattern} OR LOWER(COALESCE(sp.summary, '')) LIKE ${pattern} OR LOWER(COALESCE(c.sku, '')) LIKE ${pattern}
				OR c.uuid IN (SELECT a.item FROM store_attributes a WHERE a.project = ${projectId} AND LOWER(a.attribute_value) LIKE ${pattern})
				${translatedSearch(sql, projectId, query.language, pattern)})`;
	return sql`sp.project = ${projectId} AND sp.published = 1 AND c.archived = 0 ${category} ${search}`;
}

function translatedSearch(sql: SQL, projectId: string, language: string | null, pattern: string) {
	if (language === null) return sql``;
	return sql`OR c.uuid IN (SELECT t.item FROM store_product_translations t WHERE t.project = ${projectId} AND t.language = ${language}
		AND (LOWER(COALESCE(t.name, '')) LIKE ${pattern} OR LOWER(COALESCE(t.summary, '')) LIKE ${pattern}))`;
}

function attributeFilter(sql: SQL, projectId: string, filters: Map<string, string[]>) {
	let clause = sql``;
	for (const [attribute, values] of filters) {
		clause = sql`${clause} AND c.uuid IN (SELECT a.item FROM store_attributes a
			WHERE a.project = ${projectId} AND a.attribute = ${attribute} AND a.attribute_value IN ${sql(values)})`;
	}
	return clause;
}

function orderBy(sql: SQL, sort: ProductSort) {
	if (sort === "newest") return sql`ORDER BY sp.created DESC, c.uuid ASC`;
	if (sort === "price_asc") return sql`ORDER BY c.unit_price ASC, COALESCE(sp.name, c.name) ASC, c.uuid ASC`;
	if (sort === "price_desc") return sql`ORDER BY c.unit_price DESC, COALESCE(sp.name, c.name) ASC, c.uuid ASC`;
	if (sort === "name") return sql`ORDER BY COALESCE(sp.name, c.name) ASC, c.uuid ASC`;
	return sql`ORDER BY sp.featured DESC, sp.sort_order ASC, sp.created DESC, c.uuid ASC`;
}

export async function listProducts(projectId: string, query: ProductQuery): Promise<{ rows: ProductRow[]; total: number }> {
	const available = availableColumn(Database);
	const stock = query.inStock ? Database`AND (sp.allow_backorder = 1 OR ${available} IS NULL OR ${available} > 0)` : Database``;
	const featured = query.featured ? Database`AND sp.featured = 1` : Database``;
	const where = Database`${baseFilter(Database, projectId, query)} ${attributeFilter(Database, projectId, query.filters)} ${stock} ${featured}`;

	const rows = (await Database`
		${selectProducts(Database)} WHERE ${where} ${orderBy(Database, query.sort)} LIMIT ${query.limit} OFFSET ${query.offset}
	`) as ProductRow[];
	const [counted] = (await Database`
		SELECT COUNT(*) AS count FROM store_products sp JOIN catalog_items c ON c.uuid = sp.item WHERE ${where}
	`) as { count: number }[];

	return { rows: rows.map(normalized), total: Number(counted.count) };
}

export async function facetsFor(projectId: string, query: Pick<ProductQuery, "categories" | "search" | "language">) {
	const rows = (await Database`
		SELECT a.attribute AS attribute, a.attribute_value AS value, COUNT(DISTINCT a.item) AS count
		FROM store_attributes a
		JOIN store_products sp ON sp.item = a.item
		JOIN catalog_items c ON c.uuid = a.item
		WHERE a.project = ${projectId} AND ${baseFilter(Database, projectId, query)}
		GROUP BY a.attribute, a.attribute_value
		ORDER BY a.attribute ASC, a.attribute_value ASC
	`) as { attribute: string; value: string; count: number }[];

	const facets = new Map<string, { value: string; count: number }[]>();
	for (const row of rows) {
		const values = facets.get(row.attribute) ?? [];
		if (values.length < MAX_FILTER_VALUES) values.push({ value: row.value, count: Number(row.count) });
		facets.set(row.attribute, values);
	}
	return [...facets.entries()].map(([name, values]) => ({ name, values }));
}

export async function productBySlug(projectId: string, slug: string): Promise<ProductRow | null> {
	const [row] = (await Database`
		${selectProducts(Database)} WHERE sp.project = ${projectId} AND sp.slug = ${slug} AND sp.published = 1 AND c.archived = 0
	`) as ProductRow[];
	return row ? normalized(row) : null;
}

export async function productsByItem(projectId: string, itemIds: string[]): Promise<Map<string, ProductRow>> {
	if (itemIds.length === 0) return new Map();
	const rows = (await Database`
		${selectProducts(Database)} WHERE sp.project = ${projectId} AND sp.item IN ${Database(itemIds)} AND sp.published = 1 AND c.archived = 0
	`) as ProductRow[];
	return new Map(rows.map((row) => [row.uuid, normalized(row)]));
}

export async function attributesOf(itemIds: string[]): Promise<Map<string, StoreAttributeRow[]>> {
	const grouped = new Map<string, StoreAttributeRow[]>();
	if (itemIds.length === 0) return grouped;
	const rows = (await Database`
		SELECT * FROM store_attributes WHERE item IN ${Database(itemIds)} ORDER BY sort_order ASC, attribute ASC
	`) as StoreAttributeRow[];
	for (const row of rows) {
		const list = grouped.get(row.item) ?? [];
		list.push(row);
		grouped.set(row.item, list);
	}
	return grouped;
}

export function presentCard(store: LoadedStore, row: ProductRow, pricing: Pricing, images: StoreImageRow[], categories: Map<string, StoreCategoryRow>) {
	const net = convertedPrice(row, pricing.currency, pricing.rates);
	const tax = taxRateFor(store, row, null);
	const compare = row.compare_price === null ? null : convertedPrice({ ...row, unit_price: row.compare_price }, pricing.currency, pricing.rates);
	const category = row.store_category ? categories.get(row.store_category) : undefined;
	return {
		uuid: row.uuid,
		slug: row.slug,
		name: row.name,
		summary: row.summary,
		sku: row.sku,
		currency: net === null ? row.currency : pricing.currency,
		price: net === null ? grossOf(row.unit_price, tax.rate) : grossOf(net, tax.rate),
		compare_price: compare,
		tax_rate: tax.rate,
		featured: Boolean(row.featured),
		digital: Boolean(row.delivers_keys) || row.supply_type !== "goods",
		license: parseLicenseProduct(row.license),
		category: category ? { uuid: category.uuid, slug: category.slug, name: category.name } : null,
		image: images[0] ? { url: imagePath(images[0]), alt: images[0].alt } : null,
		hover_image: images[1] ? { url: imagePath(images[1]), alt: images[1].alt } : null,
		availability: availabilityOf(row),
		stock: row.available,
		restock_at: row.restock_at,
		delivery: {
			min_days: row.delivery_min_days ?? store.config.delivery.min_days,
			max_days: row.delivery_max_days ?? store.config.delivery.max_days,
		},
		created: row.store_created,
	};
}

export function storeNameOf(row: Pick<ProductRow, "name" | "store_name">, text?: Pick<ProductText, "name">): string {
	return text?.name ?? row.store_name ?? row.name;
}

export function translatedRow(row: ProductRow, text: ProductText | undefined): ProductRow {
	return {
		...row,
		name: storeNameOf(row, text),
		summary: text?.summary ?? row.summary,
		description: text?.description ?? row.description,
	};
}

export async function presentCards(store: LoadedStore, rows: ProductRow[], language: string | null = null) {
	const [pricing, images, categories, texts] = await Promise.all([
		pricingFor(store.project.currency, rows),
		imagesOf(rows.map((row) => row.uuid)),
		categoriesOf(store.project.uuid).then((list) => translatedCategories(store.project.uuid, list, language)),
		productTexts(
			rows.map((row) => row.uuid),
			language
		),
	]);
	const byId = new Map(categories.map((category) => [category.uuid, category]));
	return rows.map((row) => presentCard(store, translatedRow(row, texts.get(row.uuid)), pricing, images.get(row.uuid) ?? [], byId));
}
