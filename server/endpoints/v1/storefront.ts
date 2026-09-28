import type { Context } from "@rabbit-company/web";
import { rateLimit } from "@rabbit-company/web-middleware/rate-limit";
import { Server } from "../../server";
import Database from "../../database/database";
import CustomerAuth from "../../customer-auth";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { DAY, hasCapacity, hasStorageCapacity } from "../../licensing";
import { brandingOf } from "../../branding";
import { availableFor } from "../../payments/methods";
import { accountingPeriodLocked } from "../../accounting-periods";
import { createInvoice } from "../../invoice-service";
import { InvoiceDataIncomplete, prepareInvoiceIssue } from "../../invoice-validation";
import { calculateTotals } from "../../invoicing";
import { orderReference } from "../../invoice-numbers";
import { OutOfStock, stockShortage } from "../../item-keys";
import { canEmail } from "../../email/mailer";
import { queueInvoiceEmail } from "../../email/messages";
import { documentStorage } from "../../document-storage";
import { brandImages, imagePath, storeBySlug, type LoadedStore } from "../../store/store";
import { isSlug } from "../../store/config";
import {
	attributesOf,
	categoriesOf,
	descendantsOf,
	facetsFor,
	listProducts,
	presentCards,
	productBySlug,
	productsByItem,
	PRODUCT_SORTS,
	type ProductSort,
} from "../../store/catalog";
import { imagesOf } from "../../store/images";
import {
	checkoutProblem,
	profileFromCheckout,
	quoteCart,
	readAddress,
	readCartLines,
	readCustomer,
	returnStock,
	shippingAddressOf,
	takeStock,
	upsertCustomer,
	writeProfile,
	type CheckoutInput,
	type Quote,
} from "../../store/checkout";
import { findOrder, orderItems, presentOrder } from "../../store/orders";
import { claimCoupon, couponByCode, normalizeCode, recordRedemption, unclaimCoupon, usedBy } from "../../store/coupons";
import { recordLicenseOrder } from "../../license-orders";
import type { AppState, InvoiceRow, StoreImageRow } from "../../database/models";

const browseLimit = rateLimit({ windowMs: 60 * 1000, max: 240, message: "Too many requests. Please slow down." });
const imageLimit = rateLimit({ windowMs: 60 * 1000, max: 600, message: "Too many requests. Please slow down." });
const cartLimit = rateLimit({ windowMs: 60 * 1000, max: 60, message: "Too many requests. Please slow down." });
const checkoutLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, message: "Too many orders. Please try again later." });

const MAX_PAGE = 60;

async function openStore(ctx: Context<AppState>): Promise<LoadedStore | null> {
	const slug = ctx.params["slug"];
	if (!isSlug(slug, 100)) return null;
	return await storeBySlug(slug);
}

async function readJson(ctx: Context<AppState>): Promise<Record<string, unknown> | null> {
	try {
		const body = await ctx.body<Record<string, unknown>>();
		return typeof body === "object" && body !== null && !Array.isArray(body) ? body : null;
	} catch {
		return null;
	}
}

function publicQuote(quote: Quote) {
	const { invoice_items: _, invoice_discount: __, licenses: ___, ...visible } = quote;
	return visible;
}

Server.app.get("/api/v1/store/:slug", browseLimit, async (ctx) => {
	const store = await openStore(ctx);
	if (!store) return Utils.fail(ctx, ErrorCode.STORE_NOT_FOUND);

	const [categories, counts, images, methods] = await Promise.all([
		categoriesOf(store.project.uuid),
		Database`
			SELECT sp.store_category AS category, COUNT(*) AS count FROM store_products sp JOIN catalog_items c ON c.uuid = sp.item
			WHERE sp.project = ${store.project.uuid} AND sp.published = 1 AND c.archived = 0 GROUP BY sp.store_category
		` as Promise<{ category: string | null; count: number }[]>,
		brandImages(store.project.uuid),
		availableFor(store.project.uuid),
	]);
	const direct = new Map(counts.map((row) => [row.category, Number(row.count)]));

	ctx.header("Cache-Control", "no-cache");
	return Utils.ok(ctx, {
		slug: store.settings.slug,
		domain: store.settings.domain,
		currency: store.project.currency,
		timezone: store.project.timezone,
		config: store.config,
		logo: images.logo,
		hero: images.hero,
		branding: brandingOf(store.project),
		seller: {
			name: store.seller.name,
			legal_name: store.seller.legal_name,
			address: store.seller.address,
			email: store.seller.email,
			phone: store.seller.phone,
			vat_number: store.seller.vat_number,
			registration_number: store.seller.registration_number,
		},
		payment_methods: methods.map((method) => ({ processor: method.processor, label: method.label, kind: method.kind })),
		categories: categories.map((category) => ({
			uuid: category.uuid,
			slug: category.slug,
			name: category.name,
			description: category.description,
			parent: category.parent_category,
			count: descendantsOf(categories, category.uuid).reduce((sum, id) => sum + (direct.get(id) ?? 0), 0),
		})),
		product_count: [...direct.values()].reduce((sum, count) => sum + count, 0),
	});
});

function readFilters(params: URLSearchParams): Map<string, string[]> | null {
	const filters = new Map<string, string[]>();
	for (const raw of params.getAll("f")) {
		const split = raw.indexOf("=");
		if (split <= 0 || raw.length > 320) return null;
		const name = raw.slice(0, split);
		const value = raw.slice(split + 1);
		if (name.length > 100 || value.length === 0 || value.length > 200) return null;
		const values = filters.get(name) ?? [];
		if (values.length >= 50) return null;
		if (!values.includes(value)) values.push(value);
		filters.set(name, values);
	}
	return filters.size > 20 ? null : filters;
}

Server.app.get("/api/v1/store/:slug/products", browseLimit, async (ctx) => {
	const store = await openStore(ctx);
	if (!store) return Utils.fail(ctx, ErrorCode.STORE_NOT_FOUND);

	const params = ctx.query();
	const limit = Math.min(Math.max(Number(params.get("limit")) || 24, 1), MAX_PAGE);
	const offset = Math.max(Number(params.get("offset")) || 0, 0);
	const search = params.get("q")?.trim().slice(0, 100) || null;
	const sortParam = params.get("sort") ?? "featured";
	const sort: ProductSort = PRODUCT_SORTS.includes(sortParam as ProductSort) ? (sortParam as ProductSort) : "featured";
	const filters = readFilters(params);
	if (filters === null) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	const all = await categoriesOf(store.project.uuid);
	const categorySlug = params.get("category");
	const category = categorySlug ? all.find((entry) => entry.slug === categorySlug) : undefined;
	if (categorySlug && !category) return Utils.fail(ctx, ErrorCode.STORE_CATEGORY_NOT_FOUND);
	const categories = category ? descendantsOf(all, category.uuid) : null;

	const query = {
		categories,
		search,
		filters,
		inStock: params.get("stock") === "1",
		featured: params.get("featured") === "1",
		sort,
		limit,
		offset,
	};
	const [listed, facets] = await Promise.all([
		listProducts(store.project.uuid, query),
		params.get("facets") === "1" ? facetsFor(store.project.uuid, query) : Promise.resolve(null),
	]);

	const trail = [];
	for (let current = category; current; current = all.find((entry) => entry.uuid === current!.parent_category)) {
		trail.unshift({ slug: current.slug, name: current.name });
		if (trail.length > 10) break;
	}

	return Utils.ok(ctx, {
		products: await presentCards(store, listed.rows),
		total: listed.total,
		limit,
		offset,
		facets,
		category: category
			? {
					uuid: category.uuid,
					slug: category.slug,
					name: category.name,
					description: category.description,
					trail,
					children: all.filter((entry) => entry.parent_category === category.uuid).map((entry) => ({ slug: entry.slug, name: entry.name })),
				}
			: null,
	});
});

Server.app.get("/api/v1/store/:slug/products/:product", browseLimit, async (ctx) => {
	const store = await openStore(ctx);
	if (!store) return Utils.fail(ctx, ErrorCode.STORE_NOT_FOUND);

	const slug = ctx.params["product"];
	if (!isSlug(slug, 100)) return Utils.fail(ctx, ErrorCode.STORE_PRODUCT_NOT_FOUND);
	const row = await productBySlug(store.project.uuid, slug);
	if (!row) return Utils.fail(ctx, ErrorCode.STORE_PRODUCT_NOT_FOUND);

	const [[card], images, attributes, categories] = await Promise.all([
		presentCards(store, [row]),
		imagesOf([row.uuid]),
		attributesOf([row.uuid]),
		categoriesOf(store.project.uuid),
	]);

	const trail = [];
	for (
		let current = categories.find((entry) => entry.uuid === row.store_category);
		current;
		current = categories.find((entry) => entry.uuid === current!.parent_category)
	) {
		trail.unshift({ slug: current.slug, name: current.name });
		if (trail.length > 10) break;
	}

	const related = row.store_category
		? (
				await listProducts(store.project.uuid, {
					categories: [row.store_category],
					search: null,
					filters: new Map(),
					inStock: false,
					featured: false,
					sort: "featured",
					limit: 5,
					offset: 0,
				})
			).rows.filter((entry) => entry.uuid !== row.uuid)
		: [];

	return Utils.ok(ctx, {
		...card,
		description: row.description,
		images: (images.get(row.uuid) ?? []).map((image: StoreImageRow) => ({ uuid: image.uuid, url: imagePath(image), alt: image.alt })),
		attributes: (attributes.get(row.uuid) ?? []).map((attribute) => ({ name: attribute.attribute, value: attribute.attribute_value })),
		trail,
		related: await presentCards(store, related.slice(0, 4)),
	});
});

Server.app.post("/api/v1/store/:slug/quote", cartLimit, async (ctx) => {
	const store = await openStore(ctx);
	if (!store) return Utils.fail(ctx, ErrorCode.STORE_NOT_FOUND);

	const data = await readJson(ctx);
	const lines = readCartLines(data?.lines);
	if (!data || !lines) return Utils.fail(ctx, ErrorCode.INVALID_CART);

	const buyer = typeof data.buyer === "object" && data.buyer !== null ? (data.buyer as Record<string, unknown>) : null;
	const country = typeof buyer?.country === "string" && Validate.country(buyer.country.toUpperCase()) ? buyer.country.toUpperCase() : null;
	const type = buyer?.customer_type === "business" && store.config.checkout.business_customers ? "business" : "individual";
	const vat = typeof buyer?.vat_number === "string" && buyer.vat_number.length <= 40 ? buyer.vat_number.trim() || null : null;
	const shipping = typeof data.shipping === "string" ? data.shipping : null;
	const code = typeof data.coupon === "string" && data.coupon.trim() !== "" ? data.coupon : null;
	const coupon = code ? await couponByCode(store.project.uuid, code) : null;

	const quote = await quoteCart(store, lines, shipping, buyer ? { country, customer_type: type, vat_number: vat } : null, coupon);
	return Utils.ok(ctx, { ...publicQuote(quote), coupon_issue: code && !coupon ? "unknown" : quote.coupon_issue });
});

function readCheckout(data: Record<string, unknown>, store: LoadedStore): CheckoutInput | null {
	const lines = readCartLines(data.lines);
	const customer = readCustomer(data.customer, store.config.checkout.business_customers);
	const delivery = data.delivery === null || data.delivery === undefined ? null : readAddress(data.delivery);
	if (!lines || !customer || (delivery === null && data.delivery !== null && data.delivery !== undefined)) return null;
	const note = data.note === null || data.note === undefined ? null : data.note;
	if (note !== null && (typeof note !== "string" || note.length > 1000 || !store.config.checkout.order_notes)) return null;
	if (data.shipping !== null && data.shipping !== undefined && typeof data.shipping !== "string") return null;
	if (typeof data.accept_terms !== "boolean" || (data.save_profile !== undefined && typeof data.save_profile !== "boolean")) return null;
	if (data.waive_withdrawal !== undefined && typeof data.waive_withdrawal !== "boolean") return null;
	const coupon = data.coupon === null || data.coupon === undefined || data.coupon === "" ? null : normalizeCode(data.coupon);
	if (coupon === null && data.coupon !== null && data.coupon !== undefined && data.coupon !== "") return null;
	return {
		lines,
		shipping: (data.shipping as string | null | undefined) ?? null,
		customer,
		delivery,
		note: typeof note === "string" && note.trim() !== "" ? note.trim() : null,
		accept_terms: data.accept_terms,
		waive_withdrawal: data.waive_withdrawal === true,
		save_profile: data.save_profile === true,
		coupon,
	};
}

async function canTakeOrders(store: LoadedStore): Promise<boolean> {
	const projectId = store.project.uuid;
	if (!(await hasCapacity(projectId)) || !(await hasStorageCapacity(projectId))) return false;
	if (await accountingPeriodLocked(projectId, Date.now())) return false;
	return (await availableFor(projectId)).length > 0;
}

Server.app.post("/api/v1/store/:slug/checkout", checkoutLimit, CustomerAuth.required(), async (ctx) => {
	const store = await openStore(ctx);
	if (!store) return Utils.fail(ctx, ErrorCode.STORE_NOT_FOUND);
	const email = CustomerAuth.email(ctx);

	const data = await readJson(ctx);
	const input = data ? readCheckout(data, store) : null;
	if (!input) return Utils.fail(ctx, data && !readCartLines(data.lines) ? ErrorCode.INVALID_CART : ErrorCode.INVALID_CUSTOMER_PROFILE);

	const coupon = input.coupon ? await couponByCode(store.project.uuid, input.coupon) : null;
	if (input.coupon && !coupon) return Utils.fail(ctx, ErrorCode.INVALID_COUPON);
	const quote = await quoteCart(
		store,
		input.lines,
		input.shipping,
		{
			country: input.customer.country,
			customer_type: input.customer.customer_type,
			vat_number: input.customer.vat_number,
		},
		coupon
	);
	const problem = checkoutProblem(input, quote);
	if (problem !== null) return Utils.fail(ctx, problem);
	if (coupon?.once_per_customer && (await usedBy(coupon, email))) return Utils.fail(ctx, ErrorCode.COUPON_USED_UP);
	if (!(await canTakeOrders(store))) return Utils.fail(ctx, ErrorCode.STORE_CHECKOUT_UNAVAILABLE);
	if ((await stockShortage(store.project.uuid, quote.invoice_items)) !== null) return Utils.fail(ctx, ErrorCode.STORE_OUT_OF_STOCK);

	const products = await productsByItem(
		store.project.uuid,
		input.lines.map((line) => line.product)
	);
	if (coupon && !(await claimCoupon(coupon))) return Utils.fail(ctx, ErrorCode.COUPON_USED_UP);
	if (!(await takeStock(store.project.uuid, products, input.lines))) {
		if (coupon) await unclaimCoupon(coupon.uuid);
		return Utils.fail(ctx, ErrorCode.STORE_OUT_OF_STOCK);
	}

	const now = Date.now();
	const number = orderReference();
	let invoice: InvoiceRow;
	try {
		const customer = await upsertCustomer(store.project.uuid, email, input.customer);
		const totals = calculateTotals(quote.invoice_items, quote.invoice_discount);
		await prepareInvoiceIssue(
			store.project,
			{ currency: quote.currency, customer, due_date: now, supply_date: now, tax_amount: totals.tax_amount },
			totals.items,
			now
		);
		invoice = await createInvoice(
			store.project.uuid,
			{
				customer,
				currency: quote.currency,
				items: quote.invoice_items,
				discount_amount: quote.invoice_discount,
				due_date: now + store.config.checkout.payment_days * DAY,
				supply_date: null,
				notes: null,
				metadata: {
					store: store.settings.slug,
					order: number,
					terms_accepted_at: now,
					...(quote.withdrawal_waiver ? { withdrawal_waived_at: now } : {}),
					...(quote.coupon ? { coupon: quote.coupon.code } : {}),
				},
				status: "draft",
				source: "invoice",
				created_by: null,
			},
			{ draftReference: number, holdKeys: true }
		);
	} catch (err) {
		await returnStock(store.project.uuid, input.lines);
		if (coupon) await unclaimCoupon(coupon.uuid);
		if (err instanceof OutOfStock) return Utils.fail(ctx, ErrorCode.STORE_OUT_OF_STOCK);
		if (err instanceof InvoiceDataIncomplete) return Utils.failWithReason(ctx, ErrorCode.STORE_CHECKOUT_UNAVAILABLE, err.message);
		throw err;
	}

	const address = shippingAddressOf(input, quote);
	await Database`
		INSERT INTO store_orders(invoice, project, email, fulfillment, shipping_method, shipping_address, note, tracking_url, stock_returned, number,
			created, updated)
		VALUES(${invoice.uuid}, ${store.project.uuid}, ${email}, 'pending', ${quote.shipping?.name ?? null}, ${address ? JSON.stringify(address) : null},
			${input.note}, NULL, 0, ${number}, ${now}, ${now})
	`;
	if (coupon && quote.coupon) await recordRedemption(coupon, invoice.uuid, email, quote.discount_amount);
	await recordLicenseOrder(invoice.uuid, store.project.uuid, quote.licenses);
	if (input.save_profile) await writeProfile(email, profileFromCheckout(input));

	if (canEmail(store.project)) {
		try {
			await queueInvoiceEmail(store.project, invoice, {
				to: email,
				kind: "order_placed",
				message: null,
				sentBy: null,
				attachInvoice: false,
				attachEslog: false,
				payLink: true,
			});
		} catch (err) {
			Logger.error(`[STORE] Could not queue the order email for ${invoice.reference}: ${err}`);
		}
	}

	Logger.info(`[STORE] Order ${invoice.reference} placed in ${store.settings.slug}`);

	return Utils.ok(ctx, { invoice: invoice.uuid, reference: invoice.reference, total_amount: invoice.total_amount, currency: invoice.currency }, 201);
});

Server.app.get("/api/v1/store/:slug/orders/:invoice", browseLimit, CustomerAuth.required(), async (ctx) => {
	const store = await openStore(ctx);
	if (!store) return Utils.fail(ctx, ErrorCode.STORE_NOT_FOUND);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.STORE_ORDER_NOT_FOUND);
	const order = await findOrder(store.project.uuid, invoiceId);
	if (!order || order.email !== CustomerAuth.email(ctx)) return Utils.fail(ctx, ErrorCode.STORE_ORDER_NOT_FOUND);

	return Utils.ok(ctx, presentOrder(order, await orderItems(order.invoice)));
});

Server.app.get("/api/v1/public/store-images/:image", imageLimit, async (ctx) => {
	const imageId = ctx.params["image"];
	if (!Validate.uuid(imageId)) return Utils.fail(ctx, ErrorCode.STORE_IMAGE_NOT_FOUND);

	const [image] = (await Database`SELECT * FROM store_images WHERE uuid = ${imageId}`) as StoreImageRow[];
	if (!image) return Utils.fail(ctx, ErrorCode.STORE_IMAGE_NOT_FOUND);

	let bytes: Uint8Array;
	try {
		bytes = await documentStorage().get(image.storage_key);
	} catch {
		return Utils.fail(ctx, ErrorCode.STORE_IMAGE_NOT_FOUND);
	}

	return new Response(bytes, {
		headers: {
			"Content-Type": image.content_type,
			"Content-Length": String(bytes.length),
			"Cache-Control": "public, max-age=31536000, immutable",
			ETag: `"${image.sha256}"`,
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "default-src 'none'",
			"Cross-Origin-Resource-Policy": "cross-origin",
		},
	});
});
