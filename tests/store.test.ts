import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { prepareTest } from "./environment";

await prepareTest();

const FIXTURE = `${import.meta.dir}/.store-web-fixture`;
mkdirSync(FIXTURE, { recursive: true });
writeFileSync(
	`${FIXTURE}/index.html`,
	'<!doctype html><html lang="en"><head><meta name="robots" content="noindex, nofollow" /><title>RabbitPay</title></head><body></body></html>'
);

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { Settings } = await import("../server/settings");
const { setTransport } = await import("../server/email/mailer");
const { default: Auth } = await import("../server/auth");
const { generateLicenseCode, storageFor } = await import("../server/licensing");
const { expireUnpaidOrders, issuePaidDrafts, UNPAID_ORDER_GRACE_DAYS } = await import("../server/paid-drafts");

Settings.web = { enabled: true, path: FIXTURE, landing_page: true, license_store_url: "" };

interface Result {
	status: number;
	error: number;
	info: string;
	data: any;
}

async function call(method: string, path: string, token?: string, body?: unknown): Promise<Result> {
	const headers: Record<string, string> = {};
	if (token) headers.Authorization = `Bearer ${token}`;
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const response = await Server.app.handle(
		new Request(`http://127.0.0.1/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
	);
	return { status: response.status, ...((await response.json()) as Omit<Result, "status">) };
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64").toString("base64");

const messages: { to: string; text: string; subject: string; from?: unknown }[] = [];
let ownerToken = "";
let project = "";
let otherProject = "";
let gpu = "";
let giftCard = "";
let parentCategory = "";
let childCategory = "";
let customerToken = "";
let firstOrder = "";
const slug = "pixel-parts";

const base = () => `/projects/${project}`;

async function redeemStore(projectId: string, days = 30) {
	const code = generateLicenseCode();
	const now = Date.now();
	await Database`
		INSERT INTO license_keys(uuid, code, type, duration_days, status, created, updated)
		VALUES(${crypto.randomUUID()}, ${code}, 'store', ${days}, 'available', ${now}, ${now})
	`;
	return await call("POST", `/projects/${projectId}/license/redeem`, ownerToken, { code });
}

async function customerLogin(email: string): Promise<string> {
	const request = await call("POST", "/customer/auth/request", undefined, { email, store: slug, return: `/shop/${slug}/checkout` });
	expect(request.error).toBe(0);
	const token = messages.at(-1)!.text.match(/#token=([A-Za-z0-9]{128})/)![1];
	const verified = await call("POST", "/customer/auth/verify", undefined, { token });
	expect(verified.error).toBe(0);
	return verified.data.token;
}

const address = {
	name: "Ana Novak",
	phone: "+386 40 123 456",
	address_line1: "Slovenska cesta 1",
	address_line2: null,
	postal_code: "1000",
	city: "Ljubljana",
	state: null,
	country: "SI",
};

function checkout(overrides: Record<string, unknown> = {}) {
	return {
		lines: [{ product: gpu, quantity: 1 }],
		shipping: null,
		customer: { ...address, customer_type: "individual", company: null, vat_number: null, tax_number: null },
		delivery: null,
		note: "Please ring twice",
		accept_terms: true,
		save_profile: true,
		...overrides,
	};
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await Server.configure();
	Settings.email.enabled = true;
	setTransport({
		sendMail: async (message: (typeof messages)[number]) => {
			messages.push(message);
			return { messageId: "store-test" };
		},
	} as never);

	const now = Date.now();
	await Database`INSERT INTO accounts(username, email, password, created, updated, accessed) VALUES('store-owner', 'owner@pixel.test', 'unused', ${now}, ${now}, ${now})`;
	ownerToken = (await Auth.createSession("store-owner", ""))!;
	project = (await call("POST", "/projects", ownerToken, { name: "pixel-parts", currency: "EUR" })).data.uuid;
	otherProject = (await call("POST", "/projects", ownerToken, { name: "other-shop", currency: "EUR" })).data.uuid;
	await call("PATCH", `/projects/${project}`, ownerToken, { display_name: "Pixel Parts" });

	gpu = (
		await call("POST", `${base()}/items`, ownerToken, {
			name: "Asus Dual Radeon RX 9060 XT",
			sku: "RX9060XT",
			unit_price: 30000,
			currency: "EUR",
			tax_rate: 22,
			supply_type: "goods",
		})
	).data.uuid;
	giftCard = (await call("POST", `${base()}/items`, ownerToken, { name: "Gift card", unit_price: 5000, currency: "EUR", tax_rate: 0, supply_type: "services" }))
		.data.uuid;
});

afterAll(async () => {
	await Database.close();
	rmSync(FIXTURE, { recursive: true, force: true });
});

describe("the online store module", () => {
	test("is locked until an online store license is redeemed", async () => {
		const state = await call("GET", `${base()}/store`, ownerToken);
		expect(state.error).toBe(0);
		expect(state.data.license.active).toBe(false);
		expect(state.data.exists).toBe(false);
		expect(state.data.slug).toBe("pixel-parts");

		const blocked = await call("PUT", `${base()}/store`, ownerToken, { slug, domain: null, enabled: true, config: state.data.config });
		expect(blocked.status).toBe(402);
		expect(blocked.error).toBe(1150);

		const redeemed = await redeemStore(project);
		expect(redeemed.error).toBe(0);
		expect(redeemed.data.store).toBe(true);
		expect(redeemed.data.store_until).toBeGreaterThan(Date.now() + 29 * 86400000);
	});

	test("saves the store settings and rejects invalid or taken addresses", async () => {
		const state = await call("GET", `${base()}/store`, ownerToken);
		const config = {
			...state.data.config,
			announcement: "Free shipping over 100 EUR",
			socials: [
				{ network: "discord", url: "https://discord.gg/pixelparts" },
				{ network: "instagram", url: "https://instagram.com/pixelparts" },
			],
			location: { ...state.data.config.location, enabled: true, name: "Showroom", address: "Slovenska cesta 1\n1000 Ljubljana" },
			shipping: [
				{ id: "post", name: "Pošta", price: 499, free_from: 10000, min_days: 1, max_days: 2, pickup: false },
				{ id: "pickup", name: "Pickup", price: 0, free_from: null, min_days: 0, max_days: 1, pickup: true },
			],
		};

		const invalid = await call("PUT", `${base()}/store`, ownerToken, { slug: "Bad Slug", domain: null, enabled: true, config });
		expect(invalid.error).toBe(1151);
		const badSocial = await call("PUT", `${base()}/store`, ownerToken, {
			slug,
			domain: null,
			enabled: true,
			config: { ...config, socials: [{ network: "discord", url: "javascript:alert(1)" }] },
		});
		expect(badSocial.error).toBe(1151);
		const missingPrivacy = await call("PUT", `${base()}/store`, ownerToken, {
			slug,
			domain: null,
			enabled: true,
			config: { ...config, pages: config.pages.filter((page: { slug: string }) => page.slug !== "privacy") },
		});
		expect(missingPrivacy.error).toBe(1151);

		const saved = await call("PUT", `${base()}/store`, ownerToken, { slug, domain: "shop.pixel.test", enabled: true, config });
		expect(saved.error).toBe(0);
		expect(saved.data.exists).toBe(true);
		expect(saved.data.config.socials).toHaveLength(2);
		expect(saved.data.domain).toBe("shop.pixel.test");

		await redeemStore(otherProject);
		const otherState = await call("GET", `/projects/${otherProject}/store`, ownerToken);
		const taken = await call("PUT", `/projects/${otherProject}/store`, ownerToken, { slug, domain: null, enabled: true, config: otherState.data.config });
		expect(taken.error).toBe(1152);
		const domainTaken = await call("PUT", `/projects/${otherProject}/store`, ownerToken, {
			slug: "other-shop",
			domain: "shop.pixel.test",
			enabled: true,
			config: otherState.data.config,
		});
		expect(domainTaken.error).toBe(1165);
	});

	test("organizes products into nested categories", async () => {
		const parent = await call("POST", `${base()}/store/categories`, ownerToken, { name: "Grafične kartice" });
		expect(parent.status).toBe(201);
		expect(parent.data.slug).toBe("graficne-kartice");
		parentCategory = parent.data.uuid;
		const child = await call("POST", `${base()}/store/categories`, ownerToken, { name: "AMD", parent: parentCategory });
		childCategory = child.data.uuid;

		const cycle = await call("PATCH", `${base()}/store/categories/${parentCategory}`, ownerToken, { parent: childCategory });
		expect(cycle.error).toBe(1154);
		const duplicate = await call("POST", `${base()}/store/categories`, ownerToken, { name: "AMD again", slug: "amd" });
		expect(duplicate.error).toBe(1152);
	});

	test("lists catalog items with a Markdown description, filter attributes, stock and photos", async () => {
		const listed = await call("PUT", `${base()}/store/products/${gpu}`, ownerToken, {
			slug: "asus-dual-rx-9060-xt",
			published: true,
			featured: true,
			category: childCategory,
			summary: "16 GB for 1440p gaming",
			description: "## Highlights\n- **Quiet** cooler\n\n<script>alert(1)</script>",
			compare_price: 39900,
			stock: 2,
			allow_backorder: false,
			delivery_min_days: 1,
			delivery_max_days: 3,
			restock_at: null,
			sort_order: 0,
			attributes: [
				{ name: "Proizvajalec", value: "Asus" },
				{ name: "Grafična kartica", value: "Radeon RX 9060 XT" },
			],
		});
		expect(listed.error).toBe(0);
		expect(listed.data.attributes).toHaveLength(2);
		expect(listed.data.stock).toBe(2);

		const invalid = await call("PUT", `${base()}/store/products/${giftCard}`, ownerToken, { ...listed.data, slug: "asus-dual-rx-9060-xt", attributes: [] });
		expect(invalid.error).toBe(1152);

		const gift = await call("PUT", `${base()}/store/products/${giftCard}`, ownerToken, {
			...listed.data,
			slug: "gift-card",
			category: parentCategory,
			featured: false,
			compare_price: null,
			stock: null,
			attributes: [{ name: "Proizvajalec", value: "Pixel Parts" }],
		});
		expect(gift.error).toBe(0);

		const image = await call("POST", `${base()}/store/products/${gpu}/images`, ownerToken, { data: PNG, alt: "Front" });
		expect(image.status).toBe(201);
		const notImage = await call("POST", `${base()}/store/products/${gpu}/images`, ownerToken, {
			data: Buffer.from("hello world, not an image").toString("base64"),
		});
		expect(notImage.error).toBe(1158);

		const served = await Server.app.handle(new Request(`http://127.0.0.1${image.data.url}`));
		expect(served.headers.get("Content-Type")).toBe("image/png");
		expect(served.headers.get("Cache-Control")).toContain("immutable");
		expect((await storageFor(project)).storage_used).toBeGreaterThan(0);
	});

	test("shows the storefront with categories, facets and attribute filters", async () => {
		const store = await call("GET", `/store/${slug}`);
		expect(store.error).toBe(0);
		expect(store.data.config.name).toBe("Pixel Parts");
		expect(store.data.categories.find((category: { slug: string }) => category.slug === "graficne-kartice").count).toBe(2);
		expect(store.data.product_count).toBe(2);

		const all = await call("GET", `/store/${slug}/products?facets=1`);
		expect(all.data.total).toBe(2);
		const maker = all.data.facets.find((facet: { name: string }) => facet.name === "Proizvajalec");
		expect(maker.values.map((value: { value: string }) => value.value)).toEqual(["Asus", "Pixel Parts"]);

		const asus = await call("GET", `/store/${slug}/products?f=${encodeURIComponent("Proizvajalec=Asus")}`);
		expect(asus.data.products.map((product: { slug: string }) => product.slug)).toEqual(["asus-dual-rx-9060-xt"]);
		const none = await call("GET", `/store/${slug}/products?f=${encodeURIComponent("Proizvajalec=MSI")}`);
		expect(none.data.total).toBe(0);
		const either = await call("GET", `/store/${slug}/products?f=${encodeURIComponent("Proizvajalec=MSI")}&f=${encodeURIComponent("Proizvajalec=Asus")}`);
		expect(either.data.total).toBe(1);

		const parent = await call("GET", `/store/${slug}/products?category=graficne-kartice`);
		expect(parent.data.total).toBe(2);
		expect(parent.data.category.children).toEqual([{ slug: "amd", name: "AMD" }]);
		const child = await call("GET", `/store/${slug}/products?category=amd`);
		expect(child.data.total).toBe(1);
		expect(child.data.category.trail.map((entry: { slug: string }) => entry.slug)).toEqual(["graficne-kartice", "amd"]);

		const search = await call("GET", `/store/${slug}/products?q=radeon`);
		expect(search.data.total).toBe(1);

		const product = await call("GET", `/store/${slug}/products/asus-dual-rx-9060-xt`);
		expect(product.data.price).toBe(36600);
		expect(product.data.compare_price).toBe(39900);
		expect(product.data.availability).toBe("low_stock");
		expect(product.data.images).toHaveLength(1);
		expect(product.data.attributes).toEqual([
			{ name: "Proizvajalec", value: "Asus" },
			{ name: "Grafična kartica", value: "Radeon RX 9060 XT" },
		]);
		expect(product.data.description).toContain("<script>");
	});

	test("prices a cart with shipping and flags lines that exceed the stock", async () => {
		const small = await call("POST", `/store/${slug}/quote`, undefined, { lines: [{ product: gpu, quantity: 1 }] });
		expect(small.data.items_total).toBe(36600);
		expect(small.data.requires_shipping).toBe(true);
		expect(small.data.shipping.id).toBe("post");
		expect(small.data.shipping_amount).toBe(0);
		expect(small.data.total).toBe(36600);
		expect(small.data.ready).toBe(true);
		expect(small.data.invoice_items).toBeUndefined();

		const gift = await call("POST", `/store/${slug}/quote`, undefined, { lines: [{ product: giftCard, quantity: 1 }] });
		expect(gift.data.requires_shipping).toBe(false);
		expect(gift.data.shipping_amount).toBe(0);

		const tooMany = await call("POST", `/store/${slug}/quote`, undefined, { lines: [{ product: gpu, quantity: 3 }] });
		expect(tooMany.data.lines[0].issue).toBe("insufficient");
		expect(tooMany.data.ready).toBe(false);

		const unknown = await call("POST", `/store/${slug}/quote`, undefined, { lines: [{ product: crypto.randomUUID(), quantity: 1 }] });
		expect(unknown.data.unknown).toHaveLength(1);
		expect((await call("POST", `/store/${slug}/quote`, undefined, { lines: [] })).error).toBe(1161);
	});

	test("offers the languages the merchant adds with their own texts", async () => {
		const before = await call("GET", `/store/${slug}`);
		const fallback = before.data.config.language;
		expect(before.data.languages.map((language: { code: string }) => language.code)).toEqual([fallback]);

		const italian = { name: "Italiano", enabled: false, strings: { "shop.add_to_cart": "Aggiungi al carrello", "count.products.many": "{count} prodotti" } };
		expect((await call("PUT", `${base()}/store/languages/Italian`, ownerToken, italian)).error).toBe(1246);
		expect((await call("PUT", `${base()}/store/languages/it`, ownerToken, { ...italian, strings: { "<b>": "x" } })).error).toBe(1246);
		expect((await call("PUT", `${base()}/store/languages/it`, ownerToken, { ...italian, name: "x".repeat(61) })).error).toBe(1246);
		const added = await call("PUT", `${base()}/store/languages/it`, ownerToken, italian);
		expect(added.error).toBe(0);
		expect(added.data.languages.map((language: { code: string }) => language.code)).toEqual(["en", "sl", "it"]);

		const hidden = await call("GET", `/store/${slug}?lang=it`);
		expect(hidden.data.language.code).toBe(fallback);

		await call("PUT", `${base()}/store/languages/it`, ownerToken, { ...italian, enabled: true });
		const shown = await call("GET", `/store/${slug}?lang=it`);
		expect(shown.data.languages.map((language: { code: string }) => language.code)).toEqual([fallback, "it"]);
		expect(shown.data.language).toEqual({ code: "it", strings: italian.strings });

		const badContent = await call("PUT", `${base()}/store/languages/it`, ownerToken, { ...italian, enabled: true, content: { "hero.colour": "Blu" } });
		expect(badContent.error).toBe(1246);
		const content = { "hero.title": "Benvenuti", "shipping.post": "Posta", "page.privacy.title": "Privacy" };
		expect((await call("PUT", `${base()}/store/languages/it`, ownerToken, { ...italian, enabled: true, content })).error).toBe(0);
		const kept = await call("PUT", `${base()}/store/languages/it`, ownerToken, { ...italian, enabled: true });
		expect(kept.data.languages.find((language: { code: string }) => language.code === "it").content).toEqual(content);

		const product = await call("GET", `${base()}/store/products/${gpu}`, ownerToken);
		const translations = { it: { name: "Scheda grafica Asus", summary: null, description: "## Punti di forza" } };
		expect((await call("PUT", `${base()}/store/products/${gpu}`, ownerToken, { ...product.data, translations: { de: translations.it } })).error).toBe(1156);
		const translated = await call("PUT", `${base()}/store/products/${gpu}`, ownerToken, { ...product.data, translations });
		expect(translated.error).toBe(0);
		expect(translated.data.translations).toEqual(translations);
		const { translations: _, ...withoutTranslations } = product.data;
		const untouched = await call("PUT", `${base()}/store/products/${gpu}`, ownerToken, withoutTranslations);
		expect(untouched.data.translations).toEqual(translations);
		const category = await call("PATCH", `${base()}/store/categories/${parentCategory}`, ownerToken, {
			translations: { it: { name: "Schede grafiche", description: null } },
		});
		expect(category.data.translations).toEqual({ it: { name: "Schede grafiche", description: null } });

		const italianStore = await call("GET", `/store/${slug}?lang=it`);
		expect(italianStore.data.config.hero.title).toBe("Benvenuti");
		expect(italianStore.data.config.shipping.find((option: { id: string }) => option.id === "post").name).toBe("Posta");
		expect(italianStore.data.config.pages.find((page: { slug: string }) => page.slug === "privacy").title).toBe("Privacy");
		expect(italianStore.data.categories.find((entry: { uuid: string }) => entry.uuid === parentCategory).name).toBe("Schede grafiche");
		expect((await call("GET", `/store/${slug}`)).data.config.hero.title).not.toBe("Benvenuti");

		const found = await call("GET", `/store/${slug}/products?q=scheda&lang=it`);
		expect(found.data.products.map((entry: { name: string }) => entry.name)).toEqual(["Scheda grafica Asus"]);
		expect((await call("GET", `/store/${slug}/products?q=scheda`)).data.total).toBe(0);
		const page = await call("GET", `/store/${slug}/products/asus-dual-rx-9060-xt?lang=it`);
		expect(page.data.name).toBe("Scheda grafica Asus");
		expect(page.data.summary).toBe(product.data.summary);
		expect(page.data.description).toBe("## Punti di forza");
		expect(page.data.trail[0].name).toBe("Schede grafiche");
		const quote = await call("POST", `/store/${slug}/quote?lang=it`, undefined, { lines: [{ product: gpu, quantity: 1, license: null }] });
		expect(quote.data.lines[0].name).toBe("Scheda grafica Asus");
		expect(quote.data.shipping_options.find((option: { id: string }) => option.id === "post").name).toBe("Posta");
		const plain = await call("POST", `/store/${slug}/quote`, undefined, { lines: [{ product: gpu, quantity: 1, license: null }] });
		expect(plain.data.lines[0].name).not.toBe("Scheda grafica Asus");

		const english = await call("PUT", `${base()}/store/languages/en`, ownerToken, { name: null, enabled: false, strings: { "shop.add_to_cart": " Buy now " } });
		expect(english.data.languages.find((language: { code: string }) => language.code === "en").strings).toEqual({ "shop.add_to_cart": "Buy now" });

		const state = await call("GET", `${base()}/store`, ownerToken);
		const save = (language: string) =>
			call("PUT", `${base()}/store`, ownerToken, { slug, domain: state.data.domain, enabled: true, config: { ...state.data.config, language } });
		expect((await save("de")).error).toBe(1151);
		expect((await save("it")).error).toBe(0);
		expect((await call("GET", `/store/${slug}`)).data.language.code).toBe("it");
		expect((await call("DELETE", `${base()}/store/languages/it`, ownerToken)).error).toBe(1248);
		expect((await call("DELETE", `${base()}/store/languages/en`, ownerToken)).error).toBe(1247);

		expect((await save(fallback)).error).toBe(0);
		const removed = await call("DELETE", `${base()}/store/languages/it`, ownerToken);
		expect(removed.error).toBe(0);
		expect(removed.data.languages.map((language: { code: string }) => language.code)).toEqual(["en", "sl"]);
		expect((await call("GET", `${base()}/store/products/${gpu}`, ownerToken)).data.translations).toEqual({});
		const categories = await call("GET", `${base()}/store/categories`, ownerToken);
		expect(categories.data.find((entry: { uuid: string }) => entry.uuid === parentCategory).translations).toEqual({});
		await call("PUT", `${base()}/store/languages/en`, ownerToken, { name: null, enabled: false, strings: {} });
	});

	test("sends a store branded sign in link that returns to the checkout", async () => {
		customerToken = await customerLogin("ana@example.com");
		const link = messages.at(-1)!;
		expect(link.subject).toContain("Pixel Parts");
		expect(link.text).toContain("https://shop.pixel.test/customer/login#token=");
		expect(link.text).toContain(`return=${encodeURIComponent(`/shop/${slug}/checkout`)}`);
	});

	test("keeps the shopper's language through the sign in link", async () => {
		const request = (email: string, extra: Record<string, unknown>) =>
			call("POST", "/customer/auth/request", undefined, { email, store: slug, return: `/shop/${slug}/checkout?step=2`, ...extra });

		expect((await request("lang-en@example.com", { language: "en", store_language: "en" })).error).toBe(0);
		const english = messages.at(-1)!;
		expect(english.subject).toContain("Pixel Parts");
		expect(english.text).toContain(`&lang=en&return=${encodeURIComponent(`/shop/${slug}/checkout?step=2&lang=en`)}`);

		expect((await request("lang-sl@example.com", { language: "sl", store_language: "sl" })).error).toBe(0);
		expect(messages.at(-1)!.text).toContain(`&lang=sl&return=${encodeURIComponent(`/shop/${slug}/checkout?step=2&lang=sl`)}`);

		expect((await request("lang-bad@example.com", { language: "xx", store_language: '"><script>' })).error).toBe(0);
		const fallback = messages.at(-1)!.text;
		expect(fallback).toContain(`return=${encodeURIComponent(`/shop/${slug}/checkout?step=2`)}`);
		expect(fallback).not.toContain("script");
	});

	test("places an unnumbered order that takes the stock and can be paid", async () => {
		expect((await call("POST", `/store/${slug}/checkout`, undefined, checkout())).error).toBe(1000);
		expect((await call("POST", `/store/${slug}/checkout`, customerToken, checkout())).error).toBe(1168);

		const bank = await call("PUT", `${base()}/processors/bank_transfer`, ownerToken, {
			enabled: true,
			config: { iban: "SI56 1910 0000 0123 438", account_holder: "Pixel Parts d.o.o." },
		});
		expect(bank.error).toBe(0);

		expect((await call("POST", `/store/${slug}/checkout`, customerToken, checkout({ accept_terms: false }))).error).toBe(1167);
		expect((await call("POST", `/store/${slug}/checkout`, customerToken, checkout({ customer: { customer_type: "individual" } }))).error).toBe(1166);

		const placed = await call("POST", `/store/${slug}/checkout`, customerToken, checkout());
		expect(placed.status).toBe(201);
		expect(placed.data.total_amount).toBe(36600);
		firstOrder = placed.data.invoice;

		const [invoice] = await Database`SELECT * FROM invoices WHERE uuid = ${firstOrder}`;
		expect(invoice.status).toBe("draft");
		expect(invoice.reference).toBe(`ORDER-${String(new Date().getFullYear() % 100)}000001`);
		expect(invoice.issued_at).toBeNull();
		expect(invoice.supply_date).toBeNull();
		expect(placed.data.reference).toBe(invoice.reference);
		const [product] = await Database`SELECT stock FROM store_products WHERE item = ${gpu}`;
		expect(Number(product.stock)).toBe(1);

		const [email] = await Database`SELECT kind, subject, body_text, attachment_name FROM email_messages WHERE invoice = ${firstOrder}`;
		expect(email.kind).toBe("order_placed");
		expect(email.subject).toContain(invoice.reference);
		expect(email.body_text).toContain(`/pay/${firstOrder}`);
		expect(email.attachment_name).toBe(`Order confirmation ${invoice.reference}.pdf`);

		const page = await call("GET", `/public/invoices/${firstOrder}`);
		expect(page.data).toMatchObject({ document: "order", reference: invoice.reference, status: "draft", outstanding: 36600 });
		expect(page.data.methods.map((method: { processor: string }) => method.processor)).toContain("bank_transfer");
		const transfer = await call("POST", `/public/invoices/${firstOrder}/pay/bank_transfer`, undefined, {});
		expect(transfer.error).toBe(0);
		expect(transfer.data.reference).toMatch(/^RF[0-9]{2}/);
		const pdf = await Server.app.handle(new Request(`http://127.0.0.1/api/v1/public/invoices/${firstOrder}/pdf`));
		expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
		expect(pdf.headers.get("Content-Disposition")).toContain(`Order confirmation ${invoice.reference}.pdf`);
		expect((await call("PATCH", `${base()}/invoices/${firstOrder}`, ownerToken, { notes: "Edited" })).error).toBe(1041);
		expect((await call("DELETE", `${base()}/invoices/${firstOrder}`, ownerToken)).error).toBe(1041);

		const tooMany = await call("POST", `/store/${slug}/checkout`, customerToken, checkout({ lines: [{ product: gpu, quantity: 2 }] }));
		expect(tooMany.error).toBe(1162);
	});

	test("requires waiving the right of withdrawal before selling digital content", async () => {
		const key = (
			await call("POST", `${base()}/items`, ownerToken, { name: "Game key", unit_price: 1000, currency: "EUR", tax_rate: 22, supply_type: "services" })
		).data.uuid;
		expect((await call("POST", `${base()}/items/${key}/keys`, ownerToken, { keys: "AAAA-1111\nBBBB-2222" })).error).toBe(0);
		const listed = await call("PUT", `${base()}/store/products/${key}`, ownerToken, {
			slug: "game-key",
			published: true,
			featured: false,
			category: null,
			summary: null,
			description: null,
			compare_price: null,
			stock: null,
			allow_backorder: false,
			delivery_min_days: null,
			delivery_max_days: null,
			restock_at: null,
			sort_order: 0,
			attributes: [],
		});
		expect(listed.error).toBe(0);

		const quote = await call("POST", `/store/${slug}/quote`, undefined, { lines: [{ product: key, quantity: 1 }] });
		expect(quote.data.withdrawal_waiver).toBe(true);
		const refused = await call("POST", `/store/${slug}/checkout`, customerToken, checkout({ lines: [{ product: key, quantity: 1 }] }));
		expect(refused.error).toBe(1169);

		const placed = await call("POST", `/store/${slug}/checkout`, customerToken, checkout({ lines: [{ product: key, quantity: 1 }], waive_withdrawal: true }));
		expect(placed.status).toBe(201);
		const [invoice] = await Database`SELECT metadata FROM invoices WHERE uuid = ${placed.data.invoice}`;
		const metadata = JSON.parse(invoice.metadata);
		expect(metadata.withdrawal_waived_at).toBeGreaterThan(0);
		expect(metadata.terms_accepted_at).toBe(metadata.withdrawal_waived_at);
		await call("POST", `${base()}/store/orders/${placed.data.invoice}/cancel`, ownerToken, {});
		await call("DELETE", `${base()}/store/products/${key}`, ownerToken);
	});

	test("remembers the customer's details and lists their orders", async () => {
		const profile = await call("GET", "/customer/profile", customerToken);
		expect(profile.data.saved).toBe(true);
		expect(profile.data.city).toBe("Ljubljana");

		const orders = await call("GET", "/customer/orders", customerToken);
		expect(orders.data.orders).toHaveLength(2);
		const first = orders.data.orders.find((order: { invoice: string }) => order.invoice === firstOrder);
		expect(first.store).toBe("Pixel Parts");
		expect(first.fulfillment).toBe("pending");

		const order = await call("GET", `/store/${slug}/orders/${firstOrder}`, customerToken);
		expect(order.data.note).toBe("Please ring twice");
		expect(order.data.shipping_address.city).toBe("Ljubljana");

		const stranger = await customerLogin("someone@example.com");
		expect((await call("GET", `/store/${slug}/orders/${firstOrder}`, stranger)).error).toBe(1163);
	});

	test("lets the merchant ship an order and cancel one that was not paid", async () => {
		const orders = await call("GET", `${base()}/store/orders?payment=unpaid`, ownerToken);
		expect(orders.data.total).toBe(1);

		const invalid = await call("PATCH", `${base()}/store/orders/${firstOrder}`, ownerToken, { fulfillment: "shipped", tracking_url: "not a url" });
		expect(invalid.error).toBe(1164);
		const shipped = await call("PATCH", `${base()}/store/orders/${firstOrder}`, ownerToken, {
			fulfillment: "shipped",
			tracking_url: "https://tracking.posta.si/RR123456789SI",
		});
		expect(shipped.data.fulfillment).toBe("shipped");
		const [update] = await Database`SELECT subject, body_text FROM email_messages WHERE invoice = ${firstOrder} AND kind = 'order_shipped'`;
		expect(update.body_text).toContain("https://tracking.posta.si/RR123456789SI");
		expect((await call("POST", `${base()}/store/orders/${firstOrder}/cancel`, ownerToken, {})).error).toBe(1164);

		const second = await call("POST", `/store/${slug}/checkout`, customerToken, checkout());
		expect(second.status).toBe(201);
		const [emptied] = await Database`SELECT stock FROM store_products WHERE item = ${gpu}`;
		expect(Number(emptied.stock)).toBe(0);
		const soldOut = await call("GET", `/store/${slug}/products/asus-dual-rx-9060-xt`);
		expect(soldOut.data.availability).toBe("out_of_stock");

		const canceled = await call("POST", `${base()}/store/orders/${second.data.invoice}/cancel`, ownerToken, { reason: "Customer asked" });
		expect(canceled.data.fulfillment).toBe("canceled");
		expect(canceled.data.payment_status).toBe("canceled");
		const [restored] = await Database`SELECT stock FROM store_products WHERE item = ${gpu}`;
		expect(Number(restored.stock)).toBe(1);
	});

	test("cancels orders that are not paid in time without using an invoice number", async () => {
		const placed = await call("POST", `/store/${slug}/checkout`, customerToken, checkout());
		expect(placed.status).toBe(201);
		const [taken] = await Database`SELECT stock FROM store_products WHERE item = ${gpu}`;
		expect(Number(taken.stock)).toBe(0);

		expect(await expireUnpaidOrders()).toBe(0);
		await Database`UPDATE invoices SET due_date = ${Date.now() - (UNPAID_ORDER_GRACE_DAYS + 1) * 86400000} WHERE uuid = ${placed.data.invoice}`;
		expect(await expireUnpaidOrders()).toBe(1);

		const [invoice] = await Database`SELECT status, reference, issued_at FROM invoices WHERE uuid = ${placed.data.invoice}`;
		expect(invoice).toMatchObject({ status: "canceled", reference: placed.data.reference, issued_at: null });
		const notes = await Database`SELECT uuid FROM credit_notes WHERE invoice = ${placed.data.invoice}`;
		expect(notes).toHaveLength(0);
		const [restored] = await Database`SELECT stock FROM store_products WHERE item = ${gpu}`;
		expect(Number(restored.stock)).toBe(1);
		expect((await call("POST", `/public/invoices/${placed.data.invoice}/pay/bank_transfer`, undefined, {})).error).not.toBe(0);
	});

	test("issues the invoice with the next number once the order is paid", async () => {
		const order = firstOrder;
		const [{ number }] = await Database`SELECT number FROM store_orders WHERE invoice = ${order}`;
		const paid = await call("POST", `${base()}/transactions`, ownerToken, { invoice: order, processor: "bank_transfer", amount: 36600 });
		expect(paid.error).toBe(0);
		expect(await issuePaidDrafts()).toBe(0);
		const [invoice] = await Database`SELECT * FROM invoices WHERE uuid = ${order}`;
		expect(invoice.status).toBe("paid");
		expect(invoice.reference).toMatch(/^[0-9]{12}$/);
		expect(invoice.issued_at).toBeGreaterThan(0);
		expect(invoice.supply_date).toBe(invoice.issued_at);
		expect(invoice.buyer_email).toBe("ana@example.com");

		const [issuedEmail] = await Database`SELECT kind, attachment_name FROM email_messages WHERE invoice = ${order} AND kind = 'invoice'`;
		expect(issuedEmail.attachment_name).not.toBeNull();
		const view = await call("GET", `/store/${slug}/orders/${order}`, customerToken);
		expect(view.data).toMatchObject({ number, invoice_reference: invoice.reference, payment_status: "paid" });
		const listed = await call("GET", `${base()}/store/orders?search=${number.toLowerCase()}`, ownerToken);
		expect(listed.data.total).toBe(1);
	});

	test("serves the storefront page with store search engine tags and keeps the admin hidden", async () => {
		const storefront = await Server.app.handle(new Request(`http://127.0.0.1/shop/${slug}/p/asus-dual-rx-9060-xt`));
		const html = await storefront.text();
		expect(storefront.status).toBe(200);
		expect(html).toMatch(/<title>[^<]+ \| Pixel Parts<\/title>/);
		expect(html).toContain('content="index, follow"');
		expect(html).toContain('name="rabbitpay-store" content="pixel-parts" data-domain="0"');
		expect(html).toContain('<link rel="canonical" href="https://shop.pixel.test/p/asus-dual-rx-9060-xt" />');
		expect(html).toContain('<meta property="og:type" content="product" />');
		expect(html).toContain('<meta property="og:image" content="http://127.0.0.1:8099/api/v1/public/store-images/');
		expect(html).not.toContain('hreflang="');
		const structured = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)![1]!);
		expect(structured).toMatchObject({
			"@type": "Product",
			offers: { "@type": "Offer", priceCurrency: "EUR", url: "https://shop.pixel.test/p/asus-dual-rx-9060-xt" },
		});
		expect(structured.offers.price).toMatch(/^\d+\.\d{2}$/);
		expect(structured.offers.availability).toMatch(/^https:\/\/schema\.org\//);

		const category = await (await Server.app.handle(new Request(`http://127.0.0.1/shop/${slug}/c/amd?sort=price_asc`))).text();
		expect(category).toContain("<title>AMD | Pixel Parts</title>");
		expect(category).toContain('<link rel="canonical" href="https://shop.pixel.test/c/amd" />');

		const missing = await Server.app.handle(new Request(`http://127.0.0.1/shop/${slug}/p/no-such-product`));
		expect(missing.status).toBe(404);
		expect(await missing.text()).toContain('content="noindex, nofollow"');
		expect((await Server.app.handle(new Request("http://127.0.0.1/shop/no-such-store"))).status).toBe(404);

		const cart = await (await Server.app.handle(new Request(`http://127.0.0.1/shop/${slug}/cart`))).text();
		expect(cart).toContain('content="noindex, nofollow"');
		expect(cart).not.toContain("canonical");

		const domain = await Server.app.handle(new Request("http://127.0.0.1/", { headers: { host: "shop.pixel.test" } }));
		const domainHtml = await domain.text();
		expect(domainHtml).toContain('data-domain="1"');
		expect(domainHtml).toContain('<link rel="canonical" href="https://shop.pixel.test/" />');

		const admin = await Server.app.handle(new Request("http://127.0.0.1/projects"));
		const adminHtml = await admin.text();
		expect(adminHtml).toContain('content="noindex, nofollow"');
		expect(adminHtml).not.toContain("rabbitpay-store");
	});

	test("links every language version of a storefront page", async () => {
		const fallback = (await call("GET", `/store/${slug}`)).data.config.language;
		const italian = { name: "Italiano", enabled: true, strings: {} };
		expect((await call("PUT", `${base()}/store/languages/it`, ownerToken, italian)).error).toBe(0);
		try {
			const html = await (await Server.app.handle(new Request(`http://127.0.0.1/shop/${slug}/c/amd?lang=it`))).text();
			expect(html).toContain('<html lang="it">');
			expect(html).toContain('<link rel="canonical" href="https://shop.pixel.test/c/amd?lang=it" />');
			expect(html).toContain(`<link rel="alternate" hreflang="${fallback}" href="https://shop.pixel.test/c/amd" />`);
			expect(html).toContain('<link rel="alternate" hreflang="it" href="https://shop.pixel.test/c/amd?lang=it" />');
			expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://shop.pixel.test/c/amd" />');

			const unknown = await (await Server.app.handle(new Request(`http://127.0.0.1/shop/${slug}/c/amd?lang=de`))).text();
			expect(unknown).toContain('<link rel="canonical" href="https://shop.pixel.test/c/amd" />');

			const sitemap = await (await Server.app.handle(new Request("http://127.0.0.1/sitemap.xml", { headers: { host: "shop.pixel.test" } }))).text();
			expect(sitemap).toContain("<loc>https://shop.pixel.test/c/amd?lang=it</loc>");
			expect(sitemap).toContain('<xhtml:link rel="alternate" hreflang="it" href="https://shop.pixel.test/p/asus-dual-rx-9060-xt?lang=it"/>');
		} finally {
			expect((await call("DELETE", `${base()}/store/languages/it`, ownerToken)).error).toBe(0);
		}
	});

	test("publishes robots rules and sitemaps for the store and the site", async () => {
		const domainRobots = await Server.app.handle(new Request("http://127.0.0.1/robots.txt", { headers: { host: "shop.pixel.test" } }));
		expect(domainRobots.headers.get("content-type")).toContain("text/plain");
		const robots = await domainRobots.text();
		expect(robots).toContain("Disallow: /checkout");
		expect(robots).toContain("Sitemap: https://shop.pixel.test/sitemap.xml");

		const domainSitemap = await Server.app.handle(new Request("http://127.0.0.1/sitemap.xml", { headers: { host: "shop.pixel.test" } }));
		expect(domainSitemap.headers.get("content-type")).toContain("application/xml");
		const sitemap = await domainSitemap.text();
		expect(sitemap).toContain("<loc>https://shop.pixel.test/</loc>");
		expect(sitemap).toContain("<loc>https://shop.pixel.test/c/amd</loc>");
		expect(sitemap).toContain("<loc>https://shop.pixel.test/p/asus-dual-rx-9060-xt</loc>");
		expect(sitemap).not.toContain("hreflang");

		const siteRobots = await (await Server.app.handle(new Request("http://127.0.0.1/robots.txt"))).text();
		expect(siteRobots).toContain("Disallow: /projects");
		expect(siteRobots).toContain("Disallow: /shop/*/checkout");
		expect(siteRobots).toContain("Sitemap: http://127.0.0.1:8099/sitemap.xml");

		const index = await (await Server.app.handle(new Request("http://127.0.0.1/sitemap.xml"))).text();
		expect(index).toContain("<loc>http://127.0.0.1:8099/sitemap-home.xml</loc>");
		expect(index).not.toContain(`/shop/${slug}/sitemap.xml`);
		expect((await Server.app.handle(new Request(`http://127.0.0.1/shop/${slug}/sitemap.xml`))).status).toBe(404);

		await Database`UPDATE store_settings SET domain = NULL WHERE project = ${project}`;
		try {
			expect(await (await Server.app.handle(new Request("http://127.0.0.1/sitemap.xml"))).text()).toContain(
				`<loc>http://127.0.0.1:8099/shop/${slug}/sitemap.xml</loc>`
			);
			const own = await (await Server.app.handle(new Request(`http://127.0.0.1/shop/${slug}/sitemap.xml`))).text();
			expect(own).toContain(`<loc>http://127.0.0.1:8099/shop/${slug}</loc>`);
			expect(own).toContain(`<loc>http://127.0.0.1:8099/shop/${slug}/p/asus-dual-rx-9060-xt</loc>`);
		} finally {
			await Database`UPDATE store_settings SET domain = 'shop.pixel.test' WHERE project = ${project}`;
		}
	});

	test("exports and deletes the customer's data on request", async () => {
		const exported = await Server.app.handle(new Request("http://127.0.0.1/api/v1/customer/export", { headers: { Authorization: `Bearer ${customerToken}` } }));
		expect(exported.headers.get("Content-Disposition")).toContain("my-data.json");
		const data = (await exported.json()) as { profile: { city: string }; orders: unknown[] };
		expect(data.profile.city).toBe("Ljubljana");
		expect(data.orders.length).toBe(4);

		const deleted = await call("DELETE", "/customer/account", customerToken);
		expect(deleted.error).toBe(0);
		expect(await Database`SELECT * FROM customer_profiles WHERE email = 'ana@example.com'`).toHaveLength(0);
		expect(await Database`SELECT * FROM customer_accounts WHERE email = 'ana@example.com'`).toHaveLength(0);
		expect((await Database`SELECT * FROM invoices WHERE uuid = ${firstOrder}`).length).toBe(1);
		expect((await call("GET", "/customer/profile", customerToken)).error).not.toBe(0);
	});

	test("closes the storefront when the store is switched off or the license ends", async () => {
		await Database`UPDATE projects SET store_until = ${Date.now() - 1000} WHERE uuid = ${project}`;
		const expired = await call("GET", `/store/${slug}`);
		expect(expired.error).toBe(1153);
		const products = await call("GET", `${base()}/store/products`, ownerToken);
		expect(products.error).toBe(0);
		expect((await call("PUT", `${base()}/store/products/${gpu}`, ownerToken, {})).error).toBe(1150);
	});
});
