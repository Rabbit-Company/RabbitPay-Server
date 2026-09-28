import type { Context } from "@rabbit-company/web";
import { bodyLimit } from "@rabbit-company/web-middleware/body-limit";
import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { hasStorageCapacity, licensingEnforced, storeActive } from "../../licensing";
import { canEmail } from "../../email/mailer";
import { brandFor } from "../../email/messages";
import { emailDesignOf } from "../../branding";
import { orderUpdateEmail } from "../../email/templates";
import { deliverSoon, queueEmail } from "../../email/outbox";
import { MAX_MARKDOWN_LENGTH } from "../../markdown";
import { legalPages } from "../../store/legal";
import { isDomain, isSlug, isWebUrl, readStoreConfig, slugify } from "../../store/config";
import { brandImages, draftFor, forgetDomains, imagePath, normalizeHost, settingsFor } from "../../store/store";
import { imagesOf, MAX_PRODUCT_IMAGES, readStoreImage, removeStoreImages, STORE_IMAGE_BODY_LIMIT, storeImage } from "../../store/images";
import { attributesOf, categoriesOf, descendantsOf } from "../../store/catalog";
import { cancelOrder, findOrder, isFulfillment, orderItems, presentOrder, type OrderRow } from "../../store/orders";
import { presentCoupon, readCoupon } from "../../store/coupons";
import type {
	AppState,
	CatalogItemRow,
	ProjectRow,
	StoreCategoryRow,
	StoreCouponRow,
	StoreImageKind,
	StoreImageRow,
	StoreProductRow,
} from "../../database/models";

const base = "/api/v1/projects/:uuid/store";
const imageBody = bodyLimit<AppState>({ maxSize: STORE_IMAGE_BODY_LIMIT, message: "The image is too large." });

export const MAX_ATTRIBUTES = 40;

async function readJson(ctx: Context<AppState>): Promise<Record<string, unknown> | null> {
	try {
		const body = await ctx.body<Record<string, unknown>>();
		return typeof body === "object" && body !== null && !Array.isArray(body) ? body : null;
	} catch {
		return null;
	}
}

function licensed(ctx: Context<AppState>): boolean {
	return storeActive(Permissions.project(ctx));
}

export function storeUrl(settings: { slug: string; domain: string | null }): string {
	return settings.domain ? `https://${settings.domain}` : `${Utils.publicUrl()}/shop/${settings.slug}`;
}

async function storeState(project: ProjectRow) {
	const draft = await draftFor(project);
	const [counts] = (await Database`
		SELECT
			(SELECT COUNT(*) FROM store_products WHERE project = ${project.uuid}) AS products,
			(SELECT COUNT(*) FROM store_products sp JOIN catalog_items c ON c.uuid = sp.item WHERE sp.project = ${project.uuid} AND sp.published = 1 AND c.archived = 0) AS published,
			(SELECT COUNT(*) FROM store_orders WHERE project = ${project.uuid}) AS orders,
			(SELECT COUNT(*) FROM store_orders o JOIN invoices i ON i.uuid = o.invoice
				WHERE o.project = ${project.uuid} AND o.fulfillment IN ('pending', 'processing') AND i.status = 'paid') AS to_ship
	`) as Record<string, number>[];
	const slug = draft.slug;
	const domain = draft.settings?.domain ?? null;

	return {
		license: { enforced: licensingEnforced(), active: storeActive(project), until: project.store_until },
		exists: draft.settings !== null,
		enabled: Boolean(draft.settings?.enabled),
		slug,
		domain,
		url: storeUrl({ slug, domain: null }),
		domain_url: domain ? storeUrl({ slug, domain }) : null,
		config: draft.config,
		templates: legalPages(draft.seller, draft.config.name, draft.config.language),
		images: await brandImages(project.uuid),
		stats: {
			products: Number(counts.products),
			published: Number(counts.published),
			orders: Number(counts.orders),
			to_ship: Number(counts.to_ship),
		},
	};
}

Server.app.get(base, Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	return Utils.ok(ctx, await storeState(Permissions.project(ctx)));
});

Server.app.put(base, Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	if (!licensed(ctx)) return Utils.fail(ctx, ErrorCode.STORE_LICENSE_REQUIRED);

	const data = await readJson(ctx);
	if (!data) return Utils.fail(ctx, ErrorCode.INVALID_STORE_SETTINGS);

	const config = readStoreConfig(data.config);
	const slug = data.slug;
	const domain =
		data.domain === null || data.domain === undefined || data.domain === ""
			? null
			: typeof data.domain === "string"
				? data.domain.trim().toLowerCase()
				: undefined;
	if (!config || !isSlug(slug, 60) || domain === undefined || typeof data.enabled !== "boolean") return Utils.fail(ctx, ErrorCode.INVALID_STORE_SETTINGS);
	if (domain !== null && (!isDomain(domain) || domain === normalizeHost(new URL(Utils.publicUrl()).host)))
		return Utils.fail(ctx, ErrorCode.INVALID_STORE_SETTINGS);

	const [slugOwner] = (await Database`SELECT project FROM store_settings WHERE slug = ${slug} AND project != ${project.uuid}`) as { project: string }[];
	if (slugOwner) return Utils.fail(ctx, ErrorCode.STORE_SLUG_TAKEN);
	if (domain !== null) {
		const [domainOwner] = (await Database`SELECT project FROM store_settings WHERE domain = ${domain} AND project != ${project.uuid}`) as { project: string }[];
		if (domainOwner) return Utils.fail(ctx, ErrorCode.STORE_DOMAIN_TAKEN);
	}

	const previous = await settingsFor(project.uuid);
	const now = Date.now();
	const stored = JSON.stringify(config);
	try {
		if (previous) {
			await Database`
				UPDATE store_settings SET slug = ${slug}, domain = ${domain}, enabled = ${data.enabled ? 1 : 0}, config = ${stored}, updated = ${now}
				WHERE project = ${project.uuid}
			`;
		} else {
			await Database`
				INSERT INTO store_settings(project, slug, domain, enabled, config, created, updated)
				VALUES(${project.uuid}, ${slug}, ${domain}, ${data.enabled ? 1 : 0}, ${stored}, ${now}, ${now})
			`;
		}
	} catch {
		return Utils.fail(ctx, ErrorCode.STORE_SLUG_TAKEN);
	}
	forgetDomains();

	await Audit.record(ctx, {
		project: project.uuid,
		action: previous ? "store.updated" : "store.created",
		entityType: "store",
		entityId: project.uuid,
		oldValue: previous ? { slug: previous.slug, domain: previous.domain, enabled: Boolean(previous.enabled) } : undefined,
		newValue: { slug, domain, enabled: data.enabled },
	});

	return Utils.ok(ctx, await storeState(project));
});

function readImageKind(value: string | undefined): Exclude<StoreImageKind, "product"> | null {
	return value === "logo" || value === "hero" ? value : null;
}

Server.app.put(`${base}/images/:kind`, imageBody, Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	if (!licensed(ctx)) return Utils.fail(ctx, ErrorCode.STORE_LICENSE_REQUIRED);
	const kind = readImageKind(ctx.params["kind"]);
	if (!kind) return Utils.fail(ctx, ErrorCode.INVALID_STORE_IMAGE);

	const data = await readJson(ctx);
	const image = readStoreImage(data?.data);
	if (!image) return Utils.fail(ctx, ErrorCode.INVALID_STORE_IMAGE);

	const previous = (await Database`SELECT * FROM store_images WHERE project = ${project.uuid} AND kind = ${kind}`) as StoreImageRow[];
	const replacing = previous.reduce((sum, row) => sum + Number(row.byte_size), 0);
	if (!(await hasStorageCapacity(project.uuid, image.bytes.length, replacing))) return Utils.fail(ctx, ErrorCode.STORAGE_LIMIT_REACHED);

	const saved = await storeImage(project.uuid, kind, null, image, null, 0);
	await removeStoreImages(previous);
	await Audit.record(ctx, { project: project.uuid, action: `store.${kind}_updated`, entityType: "store", entityId: project.uuid });

	return Utils.ok(ctx, { url: imagePath(saved) });
});

Server.app.delete(`${base}/images/:kind`, Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const kind = readImageKind(ctx.params["kind"]);
	if (!kind) return Utils.fail(ctx, ErrorCode.INVALID_STORE_IMAGE);

	const previous = (await Database`SELECT * FROM store_images WHERE project = ${project.uuid} AND kind = ${kind}`) as StoreImageRow[];
	await removeStoreImages(previous);
	await Audit.record(ctx, { project: project.uuid, action: `store.${kind}_removed`, entityType: "store", entityId: project.uuid });

	return Utils.ok(ctx);
});

interface CategoryInput {
	name: string;
	slug: string;
	description: string | null;
	parent: string | null;
	sort_order: number;
}

function readCategory(data: Record<string, unknown>, existing: StoreCategoryRow | null): CategoryInput | null {
	const name = data.name === undefined && existing ? existing.name : data.name;
	if (!Validate.shortText(name, 120)) return null;
	const slug = data.slug === undefined || data.slug === "" ? (existing?.slug ?? slugify(name as string, 80)) : data.slug;
	if (!isSlug(slug, 80)) return null;
	const description = data.description === undefined ? (existing?.description ?? null) : data.description;
	if (!Validate.optionalText(description, 2000)) return null;
	const parent = data.parent === undefined ? (existing?.parent_category ?? null) : data.parent;
	if (parent !== null && !Validate.uuid(parent as string)) return null;
	const sortOrder = data.sort_order === undefined ? (existing?.sort_order ?? 0) : data.sort_order;
	if (typeof sortOrder !== "number" || !Number.isSafeInteger(sortOrder) || Math.abs(sortOrder) > 1_000_000) return null;
	return {
		name: (name as string).trim(),
		slug,
		description: typeof description === "string" && description.trim() !== "" ? description.trim() : null,
		parent: parent as string | null,
		sort_order: sortOrder,
	};
}

async function categoryCounts(projectId: string): Promise<Map<string, number>> {
	const rows = (await Database`
		SELECT store_category AS category, COUNT(*) AS count FROM store_products WHERE project = ${projectId} AND store_category IS NOT NULL GROUP BY store_category
	`) as { category: string; count: number }[];
	return new Map(rows.map((row) => [row.category, Number(row.count)]));
}

function presentCategory(category: StoreCategoryRow, counts: Map<string, number>) {
	return {
		uuid: category.uuid,
		name: category.name,
		slug: category.slug,
		description: category.description,
		parent: category.parent_category,
		sort_order: category.sort_order,
		products: counts.get(category.uuid) ?? 0,
	};
}

Server.app.get(`${base}/categories`, Auth.required(), Permissions.require(Permission.ITEM_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const [categories, counts] = await Promise.all([categoriesOf(project.uuid), categoryCounts(project.uuid)]);
	return Utils.ok(
		ctx,
		categories.map((category) => presentCategory(category, counts))
	);
});

async function saveCategory(ctx: Context<AppState>, existing: StoreCategoryRow | null) {
	const project = Permissions.project(ctx);
	if (!licensed(ctx)) return Utils.fail(ctx, ErrorCode.STORE_LICENSE_REQUIRED);

	const data = await readJson(ctx);
	const input = data ? readCategory(data, existing) : null;
	if (!input) return Utils.fail(ctx, ErrorCode.INVALID_STORE_CATEGORY);

	const all = await categoriesOf(project.uuid);
	if (input.parent !== null) {
		if (!all.some((category) => category.uuid === input.parent)) return Utils.fail(ctx, ErrorCode.STORE_CATEGORY_NOT_FOUND);
		if (existing && descendantsOf(all, existing.uuid).includes(input.parent)) return Utils.fail(ctx, ErrorCode.INVALID_STORE_CATEGORY);
	}
	if (all.some((category) => category.slug === input.slug && category.uuid !== existing?.uuid)) return Utils.fail(ctx, ErrorCode.STORE_SLUG_TAKEN);

	const now = Date.now();
	const uuid = existing?.uuid ?? crypto.randomUUID();
	if (existing) {
		await Database`
			UPDATE store_categories SET name = ${input.name}, slug = ${input.slug}, description = ${input.description}, parent_category = ${input.parent},
				sort_order = ${input.sort_order}, updated = ${now}
			WHERE uuid = ${uuid}
		`;
	} else {
		await Database`
			INSERT INTO store_categories(uuid, project, parent_category, slug, name, description, sort_order, created, updated)
			VALUES(${uuid}, ${project.uuid}, ${input.parent}, ${input.slug}, ${input.name}, ${input.description}, ${input.sort_order}, ${now}, ${now})
		`;
	}
	await Audit.record(ctx, {
		project: project.uuid,
		action: existing ? "store.category_updated" : "store.category_created",
		entityType: "store_category",
		entityId: uuid,
		newValue: { name: input.name, slug: input.slug },
	});

	const [saved] = (await Database`SELECT * FROM store_categories WHERE uuid = ${uuid}`) as StoreCategoryRow[];
	return Utils.ok(ctx, presentCategory(saved, await categoryCounts(project.uuid)), existing ? 200 : 201);
}

async function findCategory(ctx: Context<AppState>): Promise<StoreCategoryRow | null> {
	const categoryId = ctx.params["category"];
	if (!Validate.uuid(categoryId)) return null;
	const [category] = (await Database`
		SELECT * FROM store_categories WHERE uuid = ${categoryId} AND project = ${Permissions.project(ctx).uuid}
	`) as StoreCategoryRow[];
	return category ?? null;
}

Server.app.post(`${base}/categories`, Auth.required(), Permissions.require(Permission.ITEM_CREATE), async (ctx) => saveCategory(ctx, null));

Server.app.patch(`${base}/categories/:category`, Auth.required(), Permissions.require(Permission.ITEM_EDIT), async (ctx) => {
	const category = await findCategory(ctx);
	if (!category) return Utils.fail(ctx, ErrorCode.STORE_CATEGORY_NOT_FOUND);
	return saveCategory(ctx, category);
});

Server.app.delete(`${base}/categories/:category`, Auth.required(), Permissions.require(Permission.ITEM_DELETE), async (ctx) => {
	const category = await findCategory(ctx);
	if (!category) return Utils.fail(ctx, ErrorCode.STORE_CATEGORY_NOT_FOUND);

	await Database.begin(async (tx) => {
		await tx`UPDATE store_categories SET parent_category = ${category.parent_category} WHERE parent_category = ${category.uuid}`;
		await tx`UPDATE store_products SET store_category = ${category.parent_category} WHERE store_category = ${category.uuid}`;
		await tx`DELETE FROM store_categories WHERE uuid = ${category.uuid}`;
	});
	await Audit.record(ctx, {
		project: category.project,
		action: "store.category_deleted",
		entityType: "store_category",
		entityId: category.uuid,
		oldValue: { name: category.name, slug: category.slug },
	});

	return Utils.ok(ctx);
});

async function couponTotals(projectId: string): Promise<Map<string, number>> {
	const rows = (await Database`
		SELECT coupon, SUM(discount) AS total FROM store_coupon_redemptions WHERE project = ${projectId} GROUP BY coupon
	`) as { coupon: string; total: number }[];
	return new Map(rows.map((row) => [row.coupon, Number(row.total)]));
}

Server.app.get(`${base}/coupons`, Auth.required(), Permissions.require(Permission.ITEM_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const [rows, totals] = await Promise.all([
		Database`SELECT * FROM store_coupons WHERE project = ${project.uuid} ORDER BY created DESC, uuid ASC` as Promise<StoreCouponRow[]>,
		couponTotals(project.uuid),
	]);
	return Utils.ok(
		ctx,
		rows.map((row) => presentCoupon(row, totals.get(row.uuid) ?? 0))
	);
});

async function findCoupon(ctx: Context<AppState>): Promise<StoreCouponRow | null> {
	const couponId = ctx.params["coupon"];
	if (!Validate.uuid(couponId)) return null;
	const [coupon] = (await Database`
		SELECT * FROM store_coupons WHERE uuid = ${couponId} AND project = ${Permissions.project(ctx).uuid}
	`) as StoreCouponRow[];
	return coupon ?? null;
}

async function saveCoupon(ctx: Context<AppState>, existing: StoreCouponRow | null) {
	const project = Permissions.project(ctx);
	if (!licensed(ctx)) return Utils.fail(ctx, ErrorCode.STORE_LICENSE_REQUIRED);

	const data = await readJson(ctx);
	const input = data ? readCoupon(data, existing) : null;
	if (!input) return Utils.fail(ctx, ErrorCode.INVALID_STORE_COUPON);
	const [taken] = await Database`SELECT uuid FROM store_coupons WHERE project = ${project.uuid} AND code = ${input.code}`;
	if (taken && taken.uuid !== existing?.uuid) return Utils.fail(ctx, ErrorCode.STORE_COUPON_EXISTS);

	const now = Date.now();
	const uuid = existing?.uuid ?? crypto.randomUUID();
	if (existing) {
		await Database`
			UPDATE store_coupons SET code = ${input.code}, kind = ${input.kind}, amount = ${input.amount}, minimum = ${input.minimum},
				starts_at = ${input.starts_at}, ends_at = ${input.ends_at}, max_uses = ${input.max_uses}, once_per_customer = ${input.once_per_customer ? 1 : 0},
				enabled = ${input.enabled ? 1 : 0}, note = ${input.note}, updated = ${now}
			WHERE uuid = ${uuid}
		`;
	} else {
		await Database`
			INSERT INTO store_coupons(uuid, project, code, kind, amount, minimum, starts_at, ends_at, max_uses, once_per_customer, enabled, uses, note,
				created, updated)
			VALUES(${uuid}, ${project.uuid}, ${input.code}, ${input.kind}, ${input.amount}, ${input.minimum}, ${input.starts_at}, ${input.ends_at},
				${input.max_uses}, ${input.once_per_customer ? 1 : 0}, ${input.enabled ? 1 : 0}, 0, ${input.note}, ${now}, ${now})
		`;
	}
	await Audit.record(ctx, {
		project: project.uuid,
		action: existing ? "store.coupon_updated" : "store.coupon_created",
		entityType: "store_coupon",
		entityId: uuid,
		oldValue: existing ? presentCoupon(existing) : undefined,
		newValue: input,
	});

	const [saved] = (await Database`SELECT * FROM store_coupons WHERE uuid = ${uuid}`) as StoreCouponRow[];
	return Utils.ok(ctx, presentCoupon(saved, (await couponTotals(project.uuid)).get(uuid) ?? 0), existing ? 200 : 201);
}

Server.app.post(`${base}/coupons`, Auth.required(), Permissions.require(Permission.ITEM_CREATE), async (ctx) => saveCoupon(ctx, null));

Server.app.patch(`${base}/coupons/:coupon`, Auth.required(), Permissions.require(Permission.ITEM_EDIT), async (ctx) => {
	const coupon = await findCoupon(ctx);
	if (!coupon) return Utils.fail(ctx, ErrorCode.STORE_COUPON_NOT_FOUND);
	return saveCoupon(ctx, coupon);
});

Server.app.delete(`${base}/coupons/:coupon`, Auth.required(), Permissions.require(Permission.ITEM_DELETE), async (ctx) => {
	const coupon = await findCoupon(ctx);
	if (!coupon) return Utils.fail(ctx, ErrorCode.STORE_COUPON_NOT_FOUND);
	await Database`DELETE FROM store_coupons WHERE uuid = ${coupon.uuid}`;
	await Audit.record(ctx, {
		project: coupon.project,
		action: "store.coupon_deleted",
		entityType: "store_coupon",
		entityId: coupon.uuid,
		oldValue: presentCoupon(coupon),
	});
	return Utils.ok(ctx);
});

type ListedProduct = CatalogItemRow & {
	store_slug: string | null;
	published: number | null;
	featured: number | null;
	store_category: string | null;
	stock: number | null;
	summary: string | null;
	has_store: number;
};

Server.app.get(`${base}/products`, Auth.required(), Permissions.require(Permission.ITEM_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();
	const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);
	const search = query.get("search")?.trim().toLowerCase() || null;
	const pattern = `%${search ?? ""}%`;
	const status = query.get("status");
	const category = query.get("category");
	if (category !== null && category !== "none" && !Validate.uuid(category)) return Utils.fail(ctx, ErrorCode.STORE_CATEGORY_NOT_FOUND);

	const statusFilter =
		status === "published"
			? Database`AND sp.published = 1`
			: status === "draft"
				? Database`AND sp.item IS NOT NULL AND sp.published = 0`
				: status === "unlisted"
					? Database`AND sp.item IS NULL`
					: Database``;
	const categoryFilter =
		category === null ? Database`` : category === "none" ? Database`AND sp.store_category IS NULL` : Database`AND sp.store_category = ${category}`;
	const where = Database`c.project = ${project.uuid} AND c.archived = 0
		AND (LOWER(c.name) LIKE ${pattern} OR LOWER(COALESCE(c.sku, '')) LIKE ${pattern}) ${statusFilter} ${categoryFilter}`;

	const rows = (await Database`
		SELECT c.*, sp.slug AS store_slug, sp.published, sp.featured, sp.store_category, sp.summary,
			CASE WHEN c.delivers_keys = 1 THEN (SELECT COUNT(*) FROM item_keys k WHERE k.item = c.uuid AND k.status = 'available') ELSE sp.stock END AS stock,
			CASE WHEN sp.item IS NULL THEN 0 ELSE 1 END AS has_store
		FROM catalog_items c LEFT JOIN store_products sp ON sp.item = c.uuid
		WHERE ${where}
		ORDER BY c.name ASC, c.uuid ASC LIMIT ${limit} OFFSET ${offset}
	`) as ListedProduct[];
	const [counted] = (await Database`
		SELECT COUNT(*) AS count FROM catalog_items c LEFT JOIN store_products sp ON sp.item = c.uuid WHERE ${where}
	`) as { count: number }[];
	const images = await imagesOf(rows.map((row) => row.uuid));

	return Utils.ok(ctx, {
		products: rows.map((row) => ({
			uuid: row.uuid,
			name: row.name,
			sku: row.sku,
			unit_price: row.unit_price,
			currency: row.currency,
			tax_rate: row.tax_rate,
			supply_type: row.supply_type,
			delivers_keys: Boolean(row.delivers_keys),
			listed: Boolean(row.has_store),
			slug: row.store_slug,
			published: Boolean(row.published),
			featured: Boolean(row.featured),
			category: row.store_category,
			summary: row.summary,
			stock: row.stock === null ? null : Number(row.stock),
			image: images.get(row.uuid)?.[0] ? imagePath(images.get(row.uuid)![0]) : null,
		})),
		total: Number(counted.count),
		limit,
		offset,
	});
});

Server.app.get(`${base}/attributes`, Auth.required(), Permissions.require(Permission.ITEM_VIEW), async (ctx) => {
	const rows = (await Database`
		SELECT attribute, attribute_value, COUNT(*) AS count FROM store_attributes WHERE project = ${Permissions.project(ctx).uuid}
		GROUP BY attribute, attribute_value ORDER BY attribute ASC, attribute_value ASC
	`) as { attribute: string; attribute_value: string; count: number }[];
	const grouped = new Map<string, string[]>();
	for (const row of rows) {
		const values = grouped.get(row.attribute) ?? [];
		if (values.length < 200) values.push(row.attribute_value);
		grouped.set(row.attribute, values);
	}
	return Utils.ok(
		ctx,
		[...grouped.entries()].map(([name, values]) => ({ name, values }))
	);
});

async function findItem(ctx: Context<AppState>): Promise<CatalogItemRow | null> {
	const itemId = ctx.params["item"];
	if (!Validate.uuid(itemId)) return null;
	const [item] = (await Database`SELECT * FROM catalog_items WHERE uuid = ${itemId} AND project = ${Permissions.project(ctx).uuid}`) as CatalogItemRow[];
	return item ?? null;
}

async function productState(project: ProjectRow, item: CatalogItemRow) {
	const [product] = (await Database`SELECT * FROM store_products WHERE item = ${item.uuid}`) as StoreProductRow[];
	const [attributes, images, keys] = await Promise.all([
		attributesOf([item.uuid]),
		imagesOf([item.uuid]),
		item.delivers_keys
			? (Database`SELECT COUNT(*) AS count FROM item_keys WHERE item = ${item.uuid} AND status = 'available'` as Promise<{ count: number }[]>)
			: Promise.resolve(null),
	]);
	let slug = product?.slug ?? slugify(item.name, 80);
	if (!product) {
		const taken = (await Database`SELECT slug FROM store_products WHERE project = ${project.uuid} AND slug LIKE ${`${slug}%`}`) as { slug: string }[];
		const used = new Set(taken.map((row) => row.slug));
		for (let attempt = 2; used.has(slug); attempt++) slug = `${slugify(item.name, 74)}-${attempt}`;
	}

	return {
		item: {
			uuid: item.uuid,
			name: item.name,
			sku: item.sku,
			unit_price: item.unit_price,
			currency: item.currency,
			tax_rate: item.tax_rate,
			tax_category: item.tax_category,
			supply_type: item.supply_type,
			delivers_keys: Boolean(item.delivers_keys),
			archived: Boolean(item.archived),
			keys_available: keys ? Number(keys[0].count) : null,
		},
		listed: Boolean(product),
		slug,
		published: Boolean(product?.published),
		featured: Boolean(product?.featured),
		category: product?.store_category ?? null,
		summary: product?.summary ?? item.description ?? null,
		description: product?.description ?? null,
		compare_price: product?.compare_price ?? null,
		stock: product ? product.stock : null,
		allow_backorder: Boolean(product?.allow_backorder),
		delivery_min_days: product?.delivery_min_days ?? null,
		delivery_max_days: product?.delivery_max_days ?? null,
		restock_at: product?.restock_at ?? null,
		sort_order: product?.sort_order ?? 0,
		attributes: (attributes.get(item.uuid) ?? []).map((row) => ({ name: row.attribute, value: row.attribute_value })),
		images: (images.get(item.uuid) ?? []).map((row) => ({ uuid: row.uuid, url: imagePath(row), alt: row.alt, byte_size: Number(row.byte_size) })),
	};
}

Server.app.get(`${base}/products/:item`, Auth.required(), Permissions.require(Permission.ITEM_VIEW), async (ctx) => {
	const item = await findItem(ctx);
	if (!item) return Utils.fail(ctx, ErrorCode.ITEM_NOT_FOUND);
	return Utils.ok(ctx, await productState(Permissions.project(ctx), item));
});

interface ProductInput {
	slug: string;
	published: boolean;
	featured: boolean;
	category: string | null;
	summary: string | null;
	description: string | null;
	compare_price: number | null;
	stock: number | null;
	allow_backorder: boolean;
	delivery_min_days: number | null;
	delivery_max_days: number | null;
	restock_at: number | null;
	sort_order: number;
	attributes: { name: string; value: string }[];
}

function optionalWhole(value: unknown, max: number): number | null | undefined {
	if (value === null || value === undefined || value === "") return null;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
}

function readProduct(data: Record<string, unknown>): ProductInput | null {
	if (!isSlug(data.slug, 80)) return null;
	if (typeof data.published !== "boolean" || typeof data.featured !== "boolean" || typeof data.allow_backorder !== "boolean") return null;
	const category = data.category === null || data.category === undefined || data.category === "" ? null : data.category;
	if (category !== null && !Validate.uuid(category as string)) return null;
	if (!Validate.optionalText(data.summary, 300) || !Validate.optionalText(data.description, MAX_MARKDOWN_LENGTH)) return null;
	const comparePrice = optionalWhole(data.compare_price, 100_000_000_00);
	const stock = optionalWhole(data.stock, 1_000_000_000);
	const minDays = optionalWhole(data.delivery_min_days, 365);
	const maxDays = optionalWhole(data.delivery_max_days, 365);
	const restockAt = optionalWhole(data.restock_at, 8_640_000_000_000);
	const sortOrder = data.sort_order === undefined ? 0 : data.sort_order;
	if (comparePrice === undefined || stock === undefined || minDays === undefined || maxDays === undefined || restockAt === undefined) return null;
	if (minDays !== null && maxDays !== null && minDays > maxDays) return null;
	if ((minDays === null) !== (maxDays === null)) return null;
	if (typeof sortOrder !== "number" || !Number.isSafeInteger(sortOrder) || Math.abs(sortOrder) > 1_000_000) return null;

	if (!Array.isArray(data.attributes) || data.attributes.length > MAX_ATTRIBUTES) return null;
	const attributes: { name: string; value: string }[] = [];
	for (const entry of data.attributes) {
		if (typeof entry !== "object" || entry === null) return null;
		const { name, value } = entry as { name?: unknown; value?: unknown };
		if (!Validate.shortText(name, 100) || !Validate.shortText(value, 200) || name.includes("=")) return null;
		attributes.push({ name: name.trim(), value: value.trim() });
	}
	const keys = attributes.map((attribute) => `${attribute.name}\u0000${attribute.value}`);
	if (new Set(keys).size !== keys.length) return null;

	const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
	return {
		slug: data.slug,
		published: data.published,
		featured: data.featured,
		category: category as string | null,
		summary: text(data.summary),
		description: text(data.description),
		compare_price: comparePrice,
		stock,
		allow_backorder: data.allow_backorder,
		delivery_min_days: minDays,
		delivery_max_days: maxDays,
		restock_at: restockAt,
		sort_order: sortOrder,
		attributes,
	};
}

Server.app.put(`${base}/products/:item`, Auth.required(), Permissions.require(Permission.ITEM_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	if (!licensed(ctx)) return Utils.fail(ctx, ErrorCode.STORE_LICENSE_REQUIRED);
	const item = await findItem(ctx);
	if (!item) return Utils.fail(ctx, ErrorCode.ITEM_NOT_FOUND);

	const data = await readJson(ctx);
	const input = data ? readProduct(data) : null;
	if (!input) return Utils.fail(ctx, ErrorCode.INVALID_STORE_PRODUCT);
	if (input.category !== null) {
		const [category] = (await Database`SELECT uuid FROM store_categories WHERE uuid = ${input.category} AND project = ${project.uuid}`) as { uuid: string }[];
		if (!category) return Utils.fail(ctx, ErrorCode.STORE_CATEGORY_NOT_FOUND);
	}
	const [clash] = (await Database`SELECT item FROM store_products WHERE project = ${project.uuid} AND slug = ${input.slug} AND item != ${item.uuid}`) as {
		item: string;
	}[];
	if (clash) return Utils.fail(ctx, ErrorCode.STORE_SLUG_TAKEN);

	const now = Date.now();
	const [existing] = (await Database`SELECT item FROM store_products WHERE item = ${item.uuid}`) as { item: string }[];
	const stock = item.delivers_keys ? null : input.stock;
	await Database.begin(async (tx) => {
		if (existing) {
			await tx`
				UPDATE store_products SET store_category = ${input.category}, slug = ${input.slug}, published = ${input.published ? 1 : 0},
					featured = ${input.featured ? 1 : 0}, summary = ${input.summary}, description = ${input.description}, compare_price = ${input.compare_price},
					stock = ${stock}, allow_backorder = ${input.allow_backorder ? 1 : 0}, delivery_min_days = ${input.delivery_min_days},
					delivery_max_days = ${input.delivery_max_days}, restock_at = ${input.restock_at}, sort_order = ${input.sort_order}, updated = ${now}
				WHERE item = ${item.uuid}
			`;
		} else {
			await tx`
				INSERT INTO store_products(item, project, store_category, slug, published, featured, summary, description, compare_price, stock,
					allow_backorder, delivery_min_days, delivery_max_days, restock_at, sort_order, created, updated)
				VALUES(${item.uuid}, ${project.uuid}, ${input.category}, ${input.slug}, ${input.published ? 1 : 0}, ${input.featured ? 1 : 0},
					${input.summary}, ${input.description}, ${input.compare_price}, ${stock}, ${input.allow_backorder ? 1 : 0}, ${input.delivery_min_days},
					${input.delivery_max_days}, ${input.restock_at}, ${input.sort_order}, ${now}, ${now})
			`;
		}
		await tx`DELETE FROM store_attributes WHERE item = ${item.uuid}`;
		for (const [index, attribute] of input.attributes.entries()) {
			await tx`
				INSERT INTO store_attributes(uuid, project, item, attribute, attribute_value, sort_order)
				VALUES(${crypto.randomUUID()}, ${project.uuid}, ${item.uuid}, ${attribute.name}, ${attribute.value}, ${index})
			`;
		}
	});

	await Audit.record(ctx, {
		project: project.uuid,
		action: existing ? "store.product_updated" : "store.product_listed",
		entityType: "item",
		entityId: item.uuid,
		newValue: { slug: input.slug, published: input.published, stock },
	});

	return Utils.ok(ctx, await productState(project, item));
});

Server.app.delete(`${base}/products/:item`, Auth.required(), Permissions.require(Permission.ITEM_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const item = await findItem(ctx);
	if (!item) return Utils.fail(ctx, ErrorCode.ITEM_NOT_FOUND);

	const images = (await Database`SELECT * FROM store_images WHERE item = ${item.uuid} AND kind = 'product'`) as StoreImageRow[];
	await Database.begin(async (tx) => {
		await tx`DELETE FROM store_attributes WHERE item = ${item.uuid}`;
		await tx`DELETE FROM store_products WHERE item = ${item.uuid}`;
	});
	await removeStoreImages(images);
	await Audit.record(ctx, { project: project.uuid, action: "store.product_unlisted", entityType: "item", entityId: item.uuid });

	return Utils.ok(ctx);
});

Server.app.post(`${base}/products/:item/images`, imageBody, Auth.required(), Permissions.require(Permission.ITEM_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	if (!licensed(ctx)) return Utils.fail(ctx, ErrorCode.STORE_LICENSE_REQUIRED);
	const item = await findItem(ctx);
	if (!item) return Utils.fail(ctx, ErrorCode.ITEM_NOT_FOUND);

	const data = await readJson(ctx);
	const image = readStoreImage(data?.data);
	if (!image || !Validate.optionalText(data?.alt, 200)) return Utils.fail(ctx, ErrorCode.INVALID_STORE_IMAGE);

	const existing = (await imagesOf([item.uuid])).get(item.uuid) ?? [];
	if (existing.length >= MAX_PRODUCT_IMAGES) return Utils.fail(ctx, ErrorCode.STORE_IMAGE_LIMIT);
	if (!(await hasStorageCapacity(project.uuid, image.bytes.length))) return Utils.fail(ctx, ErrorCode.STORAGE_LIMIT_REACHED);

	const alt = typeof data?.alt === "string" && data.alt.trim() !== "" ? data.alt.trim() : null;
	const saved = await storeImage(project.uuid, "product", item.uuid, image, alt, Math.max(-1, ...existing.map((row) => row.sort_order)) + 1);
	await Audit.record(ctx, { project: project.uuid, action: "store.image_added", entityType: "item", entityId: item.uuid });

	return Utils.ok(ctx, { uuid: saved.uuid, url: imagePath(saved), alt: saved.alt, byte_size: saved.byte_size }, 201);
});

Server.app.put(`${base}/products/:item/images`, Auth.required(), Permissions.require(Permission.ITEM_EDIT), async (ctx) => {
	const item = await findItem(ctx);
	if (!item) return Utils.fail(ctx, ErrorCode.ITEM_NOT_FOUND);

	const data = await readJson(ctx);
	const entries = data?.images;
	const existing = (await imagesOf([item.uuid])).get(item.uuid) ?? [];
	if (!Array.isArray(entries) || entries.length !== existing.length) return Utils.fail(ctx, ErrorCode.INVALID_STORE_IMAGE);

	const known = new Set(existing.map((row) => row.uuid));
	const seen = new Set<string>();
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) return Utils.fail(ctx, ErrorCode.INVALID_STORE_IMAGE);
		const { uuid, alt } = entry as { uuid?: unknown; alt?: unknown };
		if (typeof uuid !== "string" || !known.has(uuid) || seen.has(uuid) || !Validate.optionalText(alt, 200))
			return Utils.fail(ctx, ErrorCode.INVALID_STORE_IMAGE);
		seen.add(uuid);
	}

	await Database.begin(async (tx) => {
		for (const [index, entry] of (entries as { uuid: string; alt?: string | null }[]).entries()) {
			const alt = typeof entry.alt === "string" && entry.alt.trim() !== "" ? entry.alt.trim() : null;
			await tx`UPDATE store_images SET sort_order = ${index}, alt = ${alt} WHERE uuid = ${entry.uuid}`;
		}
	});

	return Utils.ok(ctx, await productState(Permissions.project(ctx), item));
});

Server.app.delete(`${base}/products/:item/images/:image`, Auth.required(), Permissions.require(Permission.ITEM_EDIT), async (ctx) => {
	const item = await findItem(ctx);
	if (!item) return Utils.fail(ctx, ErrorCode.ITEM_NOT_FOUND);
	const imageId = ctx.params["image"];
	if (!Validate.uuid(imageId)) return Utils.fail(ctx, ErrorCode.STORE_IMAGE_NOT_FOUND);

	const [image] = (await Database`SELECT * FROM store_images WHERE uuid = ${imageId} AND item = ${item.uuid}`) as StoreImageRow[];
	if (!image) return Utils.fail(ctx, ErrorCode.STORE_IMAGE_NOT_FOUND);
	await removeStoreImages([image]);
	await Audit.record(ctx, { project: item.project, action: "store.image_removed", entityType: "item", entityId: item.uuid });

	return Utils.ok(ctx);
});

Server.app.get(`${base}/orders`, Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();
	const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);
	const fulfillment = query.get("fulfillment");
	const payment = query.get("payment");
	const search = query.get("search")?.trim().toLowerCase() || null;
	if (fulfillment !== null && !isFulfillment(fulfillment)) return Utils.fail(ctx, ErrorCode.INVALID_STORE_ORDER);

	const pattern = `%${search ?? ""}%`;
	const fulfillmentFilter = fulfillment === null ? Database`` : Database`AND o.fulfillment = ${fulfillment}`;
	const paymentFilter =
		payment === "paid"
			? Database`AND i.status = 'paid'`
			: payment === "unpaid"
				? Database`AND i.status IN ('open', 'overdue', 'partially_paid')`
				: payment === "to_ship"
					? Database`AND i.status = 'paid' AND o.fulfillment IN ('pending', 'processing')`
					: Database``;
	const where = Database`o.project = ${project.uuid} ${fulfillmentFilter} ${paymentFilter}
		AND (LOWER(i.reference) LIKE ${pattern} OR LOWER(o.email) LIKE ${pattern} OR LOWER(COALESCE(c.name, '')) LIKE ${pattern})`;

	const rows = (await Database`
		SELECT o.*, i.reference, i.status, i.currency, i.total_amount, i.paid_amount, i.refunded_amount, i.credited_amount, i.due_date, c.name AS customer_name,
			sc.code AS coupon_code, r.discount AS coupon_discount
		FROM store_orders o JOIN invoices i ON i.uuid = o.invoice LEFT JOIN customers c ON c.uuid = i.customer
			LEFT JOIN store_coupon_redemptions r ON r.invoice = o.invoice LEFT JOIN store_coupons sc ON sc.uuid = r.coupon
		WHERE ${where}
		ORDER BY o.created DESC, o.invoice ASC LIMIT ${limit} OFFSET ${offset}
	`) as OrderRow[];
	const [counted] = (await Database`
		SELECT COUNT(*) AS count FROM store_orders o JOIN invoices i ON i.uuid = o.invoice LEFT JOIN customers c ON c.uuid = i.customer WHERE ${where}
	`) as { count: number }[];

	return Utils.ok(ctx, { orders: rows.map((row) => presentOrder(row)), total: Number(counted.count), limit, offset });
});

async function orderFor(ctx: Context<AppState>): Promise<OrderRow | null> {
	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return null;
	return await findOrder(Permissions.project(ctx).uuid, invoiceId);
}

Server.app.get(`${base}/orders/:invoice`, Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const order = await orderFor(ctx);
	if (!order) return Utils.fail(ctx, ErrorCode.STORE_ORDER_NOT_FOUND);
	return Utils.ok(ctx, presentOrder(order, await orderItems(order.invoice)));
});

async function notifyCustomer(project: ProjectRow, order: OrderRow, fulfillment: "processing" | "shipped" | "delivered", trackingUrl: string | null) {
	if (!canEmail(project)) return;
	const settings = await settingsFor(project.uuid);
	if (!settings) return;
	const brand = await brandFor(project);
	const content = orderUpdateEmail(
		brand,
		{ reference: order.reference, fulfillment },
		{ tracking: trackingUrl, order: `${storeUrl(settings)}/order/${order.invoice}` },
		emailDesignOf(project).templates[`order_${fulfillment}`]
	);
	await queueEmail(Database, {
		project: project.uuid,
		invoice: order.invoice,
		kind: `order_${fulfillment}`,
		to: order.email,
		senderName: brand.merchant,
		replyTo: brand.replyTo,
		...content,
		attachment: null,
		sentBy: null,
	});
	deliverSoon();
}

Server.app.patch(`${base}/orders/:invoice`, Auth.required(), Permissions.require(Permission.INVOICE_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const order = await orderFor(ctx);
	if (!order) return Utils.fail(ctx, ErrorCode.STORE_ORDER_NOT_FOUND);
	if (order.fulfillment === "canceled") return Utils.fail(ctx, ErrorCode.INVALID_STORE_ORDER);

	const data = await readJson(ctx);
	if (!data) return Utils.fail(ctx, ErrorCode.INVALID_STORE_ORDER);
	const fulfillment = data.fulfillment === undefined ? order.fulfillment : data.fulfillment;
	if (!isFulfillment(fulfillment) || fulfillment === "canceled") return Utils.fail(ctx, ErrorCode.INVALID_STORE_ORDER);
	const tracking = data.tracking_url === undefined ? order.tracking_url : data.tracking_url === null || data.tracking_url === "" ? null : data.tracking_url;
	if (tracking !== null && (typeof tracking !== "string" || tracking.length > 1000 || !isWebUrl(tracking)))
		return Utils.fail(ctx, ErrorCode.INVALID_STORE_ORDER);
	const notify = data.notify === undefined ? true : data.notify;
	if (typeof notify !== "boolean") return Utils.fail(ctx, ErrorCode.INVALID_STORE_ORDER);

	await Database`UPDATE store_orders SET fulfillment = ${fulfillment}, tracking_url = ${tracking}, updated = ${Date.now()} WHERE invoice = ${order.invoice}`;
	if (notify && fulfillment !== order.fulfillment && fulfillment !== "pending") await notifyCustomer(project, order, fulfillment, tracking);

	await Audit.record(ctx, {
		project: project.uuid,
		action: "store.order_updated",
		entityType: "invoice",
		entityId: order.invoice,
		oldValue: { fulfillment: order.fulfillment, tracking_url: order.tracking_url },
		newValue: { fulfillment, tracking_url: tracking },
	});

	const updated = (await findOrder(project.uuid, order.invoice))!;
	return Utils.ok(ctx, presentOrder(updated, await orderItems(order.invoice)));
});

Server.app.post(`${base}/orders/:invoice/cancel`, Auth.required(), Permissions.require(Permission.INVOICE_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	const order = await orderFor(ctx);
	if (!order) return Utils.fail(ctx, ErrorCode.STORE_ORDER_NOT_FOUND);
	if (order.fulfillment === "canceled" || order.fulfillment === "shipped" || order.fulfillment === "delivered")
		return Utils.fail(ctx, ErrorCode.INVALID_STORE_ORDER);

	const data = (await readJson(ctx)) ?? {};
	if (!Validate.optionalText(data.reason, 500)) return Utils.fail(ctx, ErrorCode.INVALID_STORE_ORDER);
	const reason = typeof data.reason === "string" && data.reason.trim() !== "" ? data.reason.trim() : "Order canceled";
	if (order.status !== "canceled" && order.paid_amount === 0 && !(await hasStorageCapacity(project.uuid)))
		return Utils.fail(ctx, ErrorCode.STORAGE_LIMIT_REACHED);

	await cancelOrder(project, order, reason, account.username);
	await Audit.record(ctx, {
		project: project.uuid,
		action: "store.order_canceled",
		entityType: "invoice",
		entityId: order.invoice,
		oldValue: { fulfillment: order.fulfillment, status: order.status },
		newValue: { reason },
	});

	const updated = (await findOrder(project.uuid, order.invoice))!;
	return Utils.ok(ctx, presentOrder(updated, await orderItems(order.invoice)));
});
