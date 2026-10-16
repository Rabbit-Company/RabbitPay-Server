import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectApi, projectPath } from "../actions";
import { cardSet, framedPrint, HARBOUR, hero, LINDEN, logo, mug, printDetail, stickerSheet, toteBag, writeArtwork } from "../artwork";
import type { Session } from "../demo";
import type { Guide } from "../run";
import type { Studio } from "../studio";

const CONTENT = ".project-content";
const ART = join(tmpdir(), "rabbitpay-help-shots-files", "store");

type Key = Parameters<Studio["t"]>[0];

interface Product {
	name: string;
	sku: string;
	price: number;
	category: number;
	summary: string;
	description: string;
	attributes: { name: string; value: string }[];
	images: string[];
	stock: number | null;
	featured: boolean;
}

interface StoreDemo {
	motif: "harbour" | "linden";
	accent: string;
	name: string;
	slug: string;
	tagline: string;
	announcement: string;
	heroTitle: string;
	heroSubtitle: string;
	cta: string;
	shipping: { name: string; price: string; free: string; min: string; max: string };
	pickup: string;
	location: { name: string; address: string; note: string };
	categories: { name: string; slug: string; description: string }[];
	products: Product[];
	coupon: { code: string; note: string };
	customer: { name: string; email: string; address: string; postalCode: string; city: string; phone: string };
	tracking: string;
}

const PAPER = { en: "Matte, 200 g", sl: "Mat, 200 g" };

const DATA: Record<"en" | "sl", StoreDemo> = {
	en: {
		motif: "harbour",
		accent: "#2f6f86",
		name: "Harbour Lane Shop",
		slug: "harbour-lane",
		tagline: "Prints and gifts from our Dublin studio",
		announcement: "Free shipping in Ireland on orders over 50 euro",
		heroTitle: "Art prints from the harbour",
		heroSubtitle: "Designed in our Dublin studio and printed on heavy matte paper.",
		cta: "Shop the prints",
		shipping: { name: "An Post, standard post", price: "4.50", free: "50", min: "2", max: "4" },
		pickup: "Pick up at the studio",
		location: { name: "Harbour Lane Studio", address: "14 Harbour Lane\nDublin D02 XK71", note: "Ring the bell at the blue door." },
		categories: [
			{ name: "Prints", slug: "prints", description: "Art prints in A3, ready for a frame." },
			{ name: "Gifts", slug: "gifts", description: "Bags and mugs with our harbour designs." },
			{ name: "Stationery", slug: "stationery", description: "Cards and stickers." },
		],
		products: [
			{
				name: "Harbour at Dawn, art print",
				sku: "PRINT-DAWN",
				price: 2000,
				category: 0,
				summary: "Sunrise over the harbour, printed on heavy matte paper.",
				description:
					"Our best known design: the first light over the harbour, the lighthouse and two boats heading out.\n\n- A3 size, 297 x 420 mm\n- Heavy matte paper, 200 g\n- Shipped flat between card\n\nThe frame is not included.",
				attributes: [
					{ name: "Size", value: "A3" },
					{ name: "Paper", value: PAPER.en },
				],
				images: ["dawn-framed", "dawn-detail"],
				stock: 24,
				featured: true,
			},
			{
				name: "Lighthouse at Night, art print",
				sku: "PRINT-NIGHT",
				price: 2000,
				category: 0,
				summary: "The lighthouse keeps watch under a full moon.",
				description: "A calm night at the harbour, in deep blues.\n\n- A3 size, 297 x 420 mm\n- Heavy matte paper, 200 g",
				attributes: [
					{ name: "Size", value: "A3" },
					{ name: "Paper", value: PAPER.en },
				],
				images: ["night-framed", "night-detail"],
				stock: 3,
				featured: true,
			},
			{
				name: "Harbour tote bag",
				sku: "TOTE-HARBOUR",
				price: 1500,
				category: 1,
				summary: "Strong cotton tote with the harbour print.",
				description: "Heavy natural cotton with long handles, printed in Ireland.",
				attributes: [{ name: "Material", value: "Cotton" }],
				images: ["tote"],
				stock: null,
				featured: false,
			},
			{
				name: "Harbour mug",
				sku: "MUG-HARBOUR",
				price: 1200,
				category: 1,
				summary: "A white mug with the harbour at dawn.",
				description: "Holds 330 ml. Dishwasher safe.",
				attributes: [{ name: "Material", value: "Porcelain" }],
				images: ["mug"],
				stock: 18,
				featured: false,
			},
			{
				name: "Harbour sticker pack",
				sku: "STICKERS-HARBOUR",
				price: 500,
				category: 2,
				summary: "Four round vinyl stickers.",
				description: "Weatherproof vinyl, 7 to 9 cm across.",
				attributes: [{ name: "Material", value: "Vinyl" }],
				images: ["stickers"],
				stock: null,
				featured: false,
			},
			{
				name: "Greeting cards, set of three",
				sku: "CARDS-3",
				price: 900,
				category: 2,
				summary: "Three folded cards with envelopes.",
				description: "Blank inside, A6 when folded.",
				attributes: [{ name: "Size", value: "A6" }],
				images: ["cards"],
				stock: 40,
				featured: false,
			},
		],
		coupon: { code: "WELCOME10", note: "Newsletter welcome offer" },
		customer: {
			name: "Hannah Murphy",
			email: "hannah.murphy@example.com",
			address: "8 Seaview Terrace",
			postalCode: "H91 T2X4",
			city: "Galway",
			phone: "+353 91 555 018",
		},
		tracking: "https://www.anpost.com/track/RX481203556IE",
	},
	sl: {
		motif: "linden",
		accent: "#3d6b3a",
		name: "Trgovina Pod lipo",
		slug: "pod-lipo",
		tagline: "Plakati in darila iz našega ljubljanskega studia",
		announcement: "Brezplačna dostava po Sloveniji za naročila nad 50 evrov",
		heroTitle: "Plakati izpod lipe",
		heroSubtitle: "Oblikovani v našem studiu v Ljubljani in natisnjeni na debel mat papir.",
		cta: "Na plakate",
		shipping: { name: "Pošta Slovenije, paket", price: "3.90", free: "50", min: "1", max: "3" },
		pickup: "Prevzem v studiu",
		location: { name: "Studio Pod lipo", address: "Pod lipo 14\n1000 Ljubljana", note: "Pozvonite pri zelenih vratih." },
		categories: [
			{ name: "Plakati", slug: "plakati", description: "Plakati velikosti A3, pripravljeni za okvir." },
			{ name: "Darila", slug: "darila", description: "Vrečke in skodelice z našimi motivi." },
			{ name: "Papirnica", slug: "papirnica", description: "Voščilnice in nalepke." },
		],
		products: [
			{
				name: "Lipa ob zori, plakat",
				sku: "PLAKAT-ZORA",
				price: 2000,
				category: 0,
				summary: "Lipa v jutranji svetlobi, natisnjena na debel mat papir.",
				description:
					"Naš najbolj znan motiv: stara lipa v prvi jutranji svetlobi.\n\n- Velikost A3, 297 x 420 mm\n- Debel mat papir, 200 g\n- Pošljemo ravno, med kartonom\n\nOkvir ni vključen.",
				attributes: [
					{ name: "Velikost", value: "A3" },
					{ name: "Papir", value: PAPER.sl },
				],
				images: ["dawn-framed", "dawn-detail"],
				stock: 24,
				featured: true,
			},
			{
				name: "Lipa ponoči, plakat",
				sku: "PLAKAT-NOC",
				price: 2000,
				category: 0,
				summary: "Lipa pod polno luno, v temno zelenih tonih.",
				description: "Mirna noč pod lipo.\n\n- Velikost A3, 297 x 420 mm\n- Debel mat papir, 200 g",
				attributes: [
					{ name: "Velikost", value: "A3" },
					{ name: "Papir", value: PAPER.sl },
				],
				images: ["night-framed", "night-detail"],
				stock: 3,
				featured: true,
			},
			{
				name: "Bombažna vrečka z lipo",
				sku: "VRECKA-LIPA",
				price: 1500,
				category: 1,
				summary: "Trpežna bombažna vrečka z motivom lipe.",
				description: "Debel naravni bombaž z dolgimi ročaji.",
				attributes: [{ name: "Material", value: "Bombaž" }],
				images: ["tote"],
				stock: null,
				featured: false,
			},
			{
				name: "Skodelica z lipo",
				sku: "SKODELICA-LIPA",
				price: 1200,
				category: 1,
				summary: "Bela skodelica z lipo ob zori.",
				description: "Prostornina 330 ml. Primerna za pomivalni stroj.",
				attributes: [{ name: "Material", value: "Porcelan" }],
				images: ["mug"],
				stock: 18,
				featured: false,
			},
			{
				name: "Paket nalepk Pod lipo",
				sku: "NALEPKE-LIPA",
				price: 500,
				category: 2,
				summary: "Štiri okrogle vinilne nalepke.",
				description: "Vodoodporen vinil, premer od 7 do 9 cm.",
				attributes: [{ name: "Material", value: "Vinil" }],
				images: ["stickers"],
				stock: null,
				featured: false,
			},
			{
				name: "Voščilnice, komplet treh",
				sku: "VOSCILNICE-3",
				price: 900,
				category: 2,
				summary: "Tri zložene voščilnice s kuverto.",
				description: "Notranjost je prazna, velikost A6 v zloženem stanju.",
				attributes: [{ name: "Velikost", value: "A6" }],
				images: ["cards"],
				stock: 40,
				featured: false,
			},
		],
		coupon: { code: "DOBRODOSLI10", note: "Ponudba ob prijavi na novice" },
		customer: {
			name: "Nina Zupančič",
			email: "nina.zupancic@example.com",
			address: "Cankarjeva ulica 5",
			postalCode: "2000",
			city: "Maribor",
			phone: "+386 2 555 01 18",
		},
		tracking: "https://sledenje.posta.si/?ids=PS481203556SI",
	},
};

function data(studio: Studio): StoreDemo {
	return DATA[studio.language as "en" | "sl"];
}

function artFolder(studio: Studio): string {
	return join(ART, studio.language);
}

async function drawArtwork(studio: Studio) {
	const { motif } = data(studio);
	const palette = motif === "harbour" ? HARBOUR : LINDEN;
	const folder = artFolder(studio);
	const pieces: Record<string, string> = {
		logo: logo(palette, motif),
		hero: hero(palette, motif),
		"dawn-framed": framedPrint(palette, motif),
		"dawn-detail": printDetail(palette, motif),
		"night-framed": framedPrint(palette, motif, true),
		"night-detail": printDetail(palette, motif, true),
		tote: toteBag(palette, motif),
		mug: mug(palette, motif),
		stickers: stickerSheet(palette, motif),
		cards: cardSet(palette, motif),
	};
	for (const [name, content] of Object.entries(pieces)) await writeArtwork(folder, name, content);
}

function art(studio: Studio, name: string): string {
	return join(artFolder(studio), `${name}.webp`);
}

async function base64Of(path: string): Promise<string> {
	return Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64");
}

async function prepare(studio: Studio, session: Session) {
	await studio.open(projectPath(session), 800);
	const database = new Database(studio.database);
	database.run("PRAGMA busy_timeout = 10000");
	database.query("UPDATE projects SET store_until = ? WHERE uuid = ?").run(Date.now() + 365 * 86400000, session.project);
	database.close();
	await drawArtwork(studio);

	const demo = data(studio);
	session.storeItems = [];
	for (const product of demo.products) {
		const saved = await projectApi<{ uuid: string }>(studio, session, "POST", "/items", {
			name: product.name,
			sku: product.sku,
			unit_price: product.price,
			currency: "EUR",
			tax_rate: session.demo.vatRate,
			supply_type: "goods",
			tax_category: "standard",
			unit: "C62",
		});
		session.storeItems.push(saved.uuid);
	}
}

async function openStore(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "open-store";
	const demo = data(studio);
	const general = `card:${studio.t("store.general")}`;

	await studio.open(projectPath(session, "/store"), 1800);
	await studio.shot(page, "nav", { mark: `.project-nav >> link:${studio.t("nav.store")}` });
	await studio.shot(page, "setup", { target: `${CONTENT} .store-hero-card` });
	await browser.fill(`${general} >> field:${studio.t("store.name")}`, demo.name);
	await browser.fill(`${general} >> field:${studio.t("store.tagline")}`, demo.tagline);
	await browser.fill(`${general} >> field:${studio.t("store.slug")}`, demo.slug);
	await browser.blur();
	await studio.shot(page, "general", { target: general });
	await browser.click(`button:${studio.t("store.create")}`, 2500);
	await studio.open(projectPath(session, "/store"), 1800);
	await studio.shot(page, "created", {
		target: [`${CONTENT} .store-bar`, `${CONTENT} .store-hero-card`],
		mark: `${CONTENT} .store-bar >> link:${studio.t("store.open_store")}`,
	});
	await studio.shot(page, "legal-pages", { target: `card:${studio.t("store.pages")}` });
}

async function appearance(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "look-and-feel";
	const demo = data(studio);
	const card = `card:${studio.t("store.appearance")}`;
	const general = `card:${studio.t("store.general")}`;

	await studio.open(projectPath(session, "/store"), 1800);
	await browser.chooseFile(`${card} >> .store-image-logo + .line-actions button`, art(studio, "logo"));
	await browser.chooseFile(`${card} >> .store-image-hero + .line-actions button`, art(studio, "hero"));
	await browser.wait(1500);
	await browser.fill(`${card} >> field:${studio.t("store.hero_title")}`, demo.heroTitle);
	await browser.fill(`${card} >> field:${studio.t("store.hero_subtitle")}`, demo.heroSubtitle);
	await browser.fill(`${card} >> field:${studio.t("store.cta_label")}`, demo.cta);
	await browser.fill(`${card} >> field:${studio.t("store.cta_link")}`, `/shop/${demo.slug}/c/${demo.categories[0].slug}`);
	await browser.choose(`${card} >> field:${studio.t("store.hero_style")}`, "split");
	await browser.eval(
		`(() => { const accent = document.querySelector(".accent-row input[type=color]"); accent.value = ${JSON.stringify(demo.accent)}; accent.dispatchEvent(new Event("input", { bubbles: true })); })()`
	);
	await browser.fill(`${general} >> field:${studio.t("store.announcement")}`, demo.announcement);
	await browser.blur();
	await studio.shot(page, "appearance", { target: card });
	await studio.shot(page, "announcement", { target: `${general} >> fieldbox:${studio.t("store.announcement")}`, padding: 16 });
	await browser.click(`button:${studio.t("ui.save")}`, 2000);
}

async function shipping(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "shipping-and-checkout";
	const demo = data(studio);
	const card = `card:${studio.t("store.shipping")}`;
	await studio.open(projectPath(session, "/store"), 1800);
	const rows = `${card} >> .store-shipping`;
	const existing = await browser.eval<number>(`window.__helpShots.all(${JSON.stringify(rows)}).length`);
	for (let row = existing; row < 2; row++) await browser.click(`${card} >> button:+ ${studio.t("store.add_shipping")}`, 300);
	const fill = async (row: number, values: string[], pickup: boolean) => {
		await browser.eval(
			`(() => { const row = window.__helpShots.all(${JSON.stringify(rows)})[${row}]; const inputs = row.querySelectorAll("input:not([type=checkbox])"); ${JSON.stringify(values)}.forEach((value, index) => { inputs[index].value = value; inputs[index].dispatchEvent(new Event("input", { bubbles: true })); }); const box = row.querySelector("input[type=checkbox]"); if (box.checked !== ${pickup}) box.click(); })()`
		);
	};
	await fill(0, [demo.shipping.name, demo.shipping.price, demo.shipping.free, demo.shipping.min, demo.shipping.max], false);
	await fill(1, [demo.pickup, "0", "", "0", "1"], true);
	const location = `card:${studio.t("store.location")}`;
	await browser.click(`${location} >> .switch`, 400);
	await browser.fill(`${location} >> field:${studio.t("store.location_name")}`, demo.location.name);
	await browser.fill(`${location} >> field:${studio.t("store.location_address")}`, demo.location.address);
	await browser.fill(`${location} >> field:${studio.t("store.location_note")}`, demo.location.note);
	await browser.blur();
	await studio.shot(page, "shipping", { target: card });
	await studio.shot(page, "location", { target: location });
	await studio.shot(page, "checkout", { target: `card:${studio.t("store.checkout")}` });
	await browser.click(`button:${studio.t("ui.save")}`, 2000);
}

async function categories(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "categories";
	const demo = data(studio);
	await studio.open(projectPath(session, "/store/categories"), 1500);
	await studio.shot(page, "empty", { target: CONTENT, mark: `button:${studio.t("store.new_category")}` });
	await browser.click(`button:${studio.t("store.new_category")}`, 800);
	await browser.fill(`.dialog >> field:${studio.t("store.category_name")}`, demo.categories[0].name);
	await browser.fill(`.dialog >> field:${studio.t("store.product_slug")}`, demo.categories[0].slug);
	await browser.fill(`.dialog >> field:${studio.t("store.category_description")}`, demo.categories[0].description);
	await browser.blur();
	await studio.shot(page, "new", { target: ".dialog", padding: 32, mark: ".dialog >> button[type=submit]" });
	await browser.click(".dialog >> button[type=submit]", 1500);
	for (const category of demo.categories.slice(1)) {
		await projectApi(studio, session, "POST", "/store/categories", { name: category.name, slug: category.slug, description: category.description });
	}
	await studio.open(projectPath(session, "/store/categories"), 1500);
	await studio.shot(page, "list", { target: CONTENT });
}

async function categoryIds(studio: Studio, session: Session): Promise<string[]> {
	const all = await projectApi<{ uuid: string; slug: string }[]>(studio, session, "GET", "/store/categories");
	return data(studio).categories.map((category) => all.find((entry) => entry.slug === category.slug)!.uuid);
}

function productBody(product: Product, category: string) {
	return {
		name: null,
		slug: product.sku.toLowerCase(),
		published: true,
		featured: product.featured,
		category,
		summary: product.summary,
		description: product.description,
		compare_price: null,
		stock: product.stock,
		allow_backorder: false,
		delivery_min_days: null,
		delivery_max_days: null,
		restock_at: null,
		sort_order: 0,
		attributes: product.attributes,
		translations: {},
	};
}

async function products(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "products";
	const demo = data(studio);
	const ids = await categoryIds(studio, session);
	const first = demo.products[0];
	const item = session.storeItems![0];

	await studio.open(projectPath(session, "/store/products"), 1500);
	await studio.shot(page, "list", { target: CONTENT, mark: `${CONTENT} tbody tr:has(a[href$="${item}"]) td.actions` });
	await studio.open(projectPath(session, `/store/products/${item}`), 1500);
	await browser.fill(`field:${studio.t("store.product_slug")}`, first.sku.toLowerCase());
	await browser.fill(`field:${studio.t("store.summary")}`, first.summary);
	await browser.fill(".markdown-split textarea", first.description);
	await browser.choose(`field:${studio.t("store.category")}`, ids[0]);
	for (const attribute of first.attributes) {
		await browser.click(`button:+ ${studio.t("store.add_attribute")}`, 200);
		await browser.eval(
			`(() => { const rows = document.querySelectorAll(".attribute-row"); const row = rows[rows.length - 1]; const [name, value] = row.querySelectorAll("input"); name.value = ${JSON.stringify(attribute.name)}; value.value = ${JSON.stringify(attribute.value)}; })()`
		);
	}
	await browser.click(`label.switch >> text:${studio.t("store.featured")}`, 200);
	await browser.click(`label.switch >> text:${studio.t("store.track_stock")}`, 200);
	await browser.fill(`field:${studio.t("store.stock_quantity")}`, String(first.stock));
	await browser.blur();
	await studio.shot(page, "content", { target: ".product-editor-main > .card:first-child" });
	await studio.shot(page, "side", { target: ".product-editor-side", mark: ".product-editor-side >> button[type=submit]" });
	await browser.click(".product-editor-side >> button[type=submit]", 2500);
	for (const image of first.images) await browser.chooseFile(`button:+ ${studio.t("store.add_images")}`, art(studio, image));
	await browser.wait(1500);
	await studio.shot(page, "images", { target: ".product-editor-main > .card:nth-child(2)" });
	await studio.shot(page, "attributes", { target: ".product-editor-main > .card:nth-child(3)" });

	for (const [index, product] of demo.products.entries()) {
		if (index === 0) continue;
		const id = session.storeItems![index];
		await projectApi(studio, session, "PUT", `/store/products/${id}`, productBody(product, ids[product.category]));
		for (const image of product.images) {
			await projectApi(studio, session, "POST", `/store/products/${id}/images`, { data: await base64Of(art(studio, image)), alt: null });
		}
	}
	await studio.open(projectPath(session, "/store/products"), 1500);
	await browser.choose(`${CONTENT} .toolbar select`, "published");
	await browser.wait(900);
	await studio.shot(page, "published", { target: CONTENT });
}

async function coupons(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "coupons";
	const { coupon } = data(studio);
	await studio.open(projectPath(session, "/store/coupons"), 1500);
	await browser.click(`button:${studio.t("store.new_coupon")}`, 800);
	await browser.fill(`.dialog >> field:${studio.t("store.coupon_code")}`, coupon.code);
	await browser.choose(`.dialog >> field:${studio.t("store.coupon_kind")}`, "percent");
	await browser.fill(`.dialog >> field:${studio.t("store.coupon_percent")}`, "10");
	await browser.fill(`.dialog >> field:${studio.t("store.coupon_max_uses")}`, "200");
	await browser.fill(`.dialog >> field:${studio.t("store.coupon_note")}`, coupon.note);
	await browser.blur();
	await studio.shot(page, "new", { target: ".dialog", padding: 32, mark: ".dialog >> button[type=submit]" });
	await browser.click(".dialog >> button[type=submit]", 1500);
	await studio.shot(page, "list", { target: CONTENT });
}

async function translations(studio: Studio, session: Session) {
	await studio.open(projectPath(session, "/store/translations"), 1500);
	await studio.shot("translations", "languages", { target: CONTENT });
}

function shop(studio: Studio, path = ""): string {
	return `/shop/${data(studio).slug}${path}`;
}

async function customerView(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "what-customers-see";
	const demo = data(studio);
	await studio.open(shop(studio), 2500);
	await studio.shot(page, "privacy-notice", { mark: `button:${studio.t("shop.notice_ok")}` });
	await browser.click(`button:${studio.t("shop.notice_ok")}`, 500);
	await studio.shot(page, "home");
	await studio.shot(page, "home-full", { full: true });
	await studio.open(shop(studio, `/c/${demo.categories[0].slug}`), 2000);
	await studio.shot(page, "category");
	await studio.open(shop(studio, `/p/${demo.products[0].sku.toLowerCase()}`), 2000);
	await studio.shot(page, "product");
}

async function linkFor(studio: Studio, path: string): Promise<string> {
	for (let attempt = 0; attempt < 40; attempt++) {
		for (const message of [...studio.mailbox].reverse()) {
			const flat = message.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
			const match = new RegExp(`https?://[^\\s"<>]*${path}#token=[^\\s"<>]+`).exec(flat);
			if (match) return match[0].replace(/&amp;/g, "&");
		}
		await Bun.sleep(500);
	}
	throw new Error(`No email with a ${path} link arrived`);
}

async function checkout(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "checkout";
	const demo = data(studio);
	const { customer } = demo;

	await studio.open(shop(studio, `/p/${demo.products[0].sku.toLowerCase()}`), 2000);
	await browser.click(`.sf-buy >> button:${studio.t("shop.add_to_cart")}`, 1200);
	await studio.shot(page, "added");
	await studio.open(shop(studio, `/p/${demo.products[3].sku.toLowerCase()}`), 2000);
	await browser.click(`.sf-buy >> button:${studio.t("shop.add_to_cart")}`, 1200);
	await studio.open(shop(studio, "/cart"), 2000);
	await studio.shot(page, "cart");
	await studio.open(shop(studio, "/checkout"), 2000);
	await browser.fill(`.sf-signin input[type=email]`, customer.email);
	await browser.blur();
	await studio.shot(page, "sign-in");
	studio.mailbox.length = 0;
	await browser.click(".sf-signin >> button[type=submit]", 2000);
	await studio.shot(page, "link-sent");
	const link = await linkFor(studio, "/sign-in");
	await browser.goto(link.replace(/^https?:\/\/[^/]+/, studio.base), 2000);
	await studio.shot(page, "confirm-sign-in", { mark: ".sf-signin >> button[type=submit]" });
	await browser.click(".sf-signin >> button[type=submit]", 3000);
	await studio.open(shop(studio, "/checkout"), 2500);
	const country = session.demo.company.country;
	await browser.eval(
		`(() => { const set = (selector, value) => { const field = document.querySelector(selector); field.value = value; field.dispatchEvent(new Event("input", { bubbles: true })); field.dispatchEvent(new Event("change", { bubbles: true })); }; const step = ".sf-checkout-main .sf-step"; set(step + " [autocomplete=name]", ${JSON.stringify(customer.name)}); set(step + " [autocomplete=tel]", ${JSON.stringify(customer.phone)}); set(step + " [autocomplete=address-line1]", ${JSON.stringify(customer.address)}); set(step + " [autocomplete=postal-code]", ${JSON.stringify(customer.postalCode)}); set(step + " [autocomplete=address-level2]", ${JSON.stringify(customer.city)}); set(step + " select[autocomplete=country]", ${JSON.stringify(country)}); })()`
	);
	await browser.wait(1200);
	await browser.click(".sf-option", 1200);
	await browser.fill(".sf-coupon input", demo.coupon.code);
	await browser.click(`.sf-coupon >> button:${studio.t("shop.coupon_apply")}`, 1500);
	await browser.blur();
	await studio.shot(page, "details", { target: ".sf-checkout-main > .sf-step:first-child", padding: 16 });
	await studio.shot(page, "delivery", { target: ".sf-checkout-main > .sf-step:nth-child(2)", padding: 16 });
	await studio.shot(page, "summary", { target: ".sf-summary", padding: 16, mark: ".sf-coupon" });
	await browser.eval(
		`[...document.querySelectorAll(".sf-checkout-main label.sf-check")].find((label) => label.querySelector("a[href$='/page/terms']")).querySelector("input").click()`
	);
	await browser.blur();
	await studio.shot(page, "place-order", { target: ".sf-checkout-main > .sf-step:last-child", padding: 16, mark: `button:${studio.t("shop.place_order")}` });
	await browser.click(`button:${studio.t("shop.place_order")}`, 4000);
	await studio.shot(page, "order-placed", { full: true });
	session.marks = { ...session.marks, storeOrder: (await browser.eval<string>("location.pathname")).split("/").pop()! };
}

async function orders(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "orders";
	const order = session.marks!.storeOrder;
	await studio.open(projectPath(session, "/store/orders"), 1500);
	await browser.choose(`${CONTENT} .toolbar select`, "");
	await browser.wait(900);
	await studio.shot(page, "unpaid", { target: CONTENT });

	const detail = await projectApi<{ total_amount: number; outstanding: number }>(studio, session, "GET", `/store/orders/${order}`);
	await projectApi(studio, session, "POST", "/transactions", {
		invoice: order,
		processor: "bank_transfer",
		amount: detail.outstanding || detail.total_amount,
		fee_amount: 0,
		processor_tx_id: "SEPA 7731",
		status: "completed",
		notes: null,
		paid_at: Date.now(),
	});
	await browser.wait(2000);
	await studio.open(projectPath(session, "/store/orders"), 1500);
	await studio.shot(page, "to-ship", { target: CONTENT, mark: `${CONTENT} tbody tr:first-child td.actions` });
	await studio.open(projectPath(session, `/store/orders/${order}`), 1500);
	await studio.shot(page, "order", { target: CONTENT });
	await browser.click(`button:${studio.t("store.mark_processing")}`, 1500);
	await browser.fill(`field:${studio.t("store.tracking_url")}`, data(studio).tracking);
	await browser.blur();
	await studio.shot(page, "ship", { target: `${CONTENT} section.card:has(input[type=url])`, mark: `button:${studio.t("store.mark_shipped")}` });
	await browser.click(`button:${studio.t("store.mark_shipped")}`, 2000);
	await studio.shot(page, "shipped", { target: CONTENT });
}

export const store: Guide = {
	module: "online-store",
	steps: [
		["prepare", prepare],
		["open-store", openStore],
		["look-and-feel", appearance],
		["shipping-and-checkout", shipping],
		["categories", categories],
		["products", products],
		["coupons", coupons],
		["translations", translations],
		["what-customers-see", customerView],
		["checkout", checkout],
		["orders", orders],
	],
};
