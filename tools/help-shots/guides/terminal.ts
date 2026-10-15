import { projectApi, projectPath } from "../actions";
import type { Session } from "../demo";
import type { Guide } from "../run";
import type { Studio } from "../studio";

const PRODUCTS = {
	en: {
		items: [
			{ name: "Poster print, A2", sku: "POSTER-A2", price: 2000, supply: "goods", unit: "C62" },
			{ name: "Sticker pack", sku: "STICKERS", price: 500, supply: "goods", unit: "C62" },
			{ name: "Tote bag, printed", sku: "TOTE", price: 1500, supply: "goods", unit: "C62" },
			{ name: "Design consultation, 30 min", sku: "CONSULT-30", price: 4000, supply: "services", unit: "E48" },
		],
		note: "Framing service",
		receipt: "hannah.murphy@example.com",
	},
	sl: {
		items: [
			{ name: "Tisk plakata, A2", sku: "PLAKAT-A2", price: 2000, supply: "goods", unit: "C62" },
			{ name: "Paket nalepk", sku: "NALEPKE", price: 500, supply: "goods", unit: "C62" },
			{ name: "Bombažna vrečka s potiskom", sku: "VRECKA", price: 1500, supply: "goods", unit: "C62" },
			{ name: "Svetovanje, 30 min", sku: "SVET-30", price: 4000, supply: "services", unit: "E48" },
		],
		note: "Okvirjanje",
		receipt: "nina.zupancic@example.com",
	},
};

function products(studio: Studio) {
	return PRODUCTS[studio.language as "en" | "sl"];
}

async function tap(studio: Studio, name: string, times = 1) {
	const tile = `.pos-tile >> text:${name}`;
	const visible = await studio.browser.exists(tile);
	if (!visible) await studio.browser.fill(".pos-items input[type=search]", name);
	for (let count = 0; count < times; count++) await studio.browser.click(tile, 250);
	if (!visible) await studio.browser.fill(".pos-items input[type=search]", "");
}

async function chooseTab(studio: Studio, label: string) {
	await studio.browser.eval(`[...document.querySelectorAll(".pos-tab")].find((tab) => tab.textContent === ${JSON.stringify(label)}).click()`);
	await studio.browser.wait(400);
}

async function pressKeys(studio: Studio, digits: string) {
	for (const digit of digits) {
		await studio.browser.eval(`[...document.querySelectorAll(".pos-keys .pos-key")].find((key) => key.textContent === ${JSON.stringify(digit)}).click()`);
		await studio.browser.wait(120);
	}
}

async function prepare(studio: Studio, session: Session) {
	await studio.open(projectPath(session), 800);
	const known = await projectApi<{ items: { name: string }[] } | { name: string }[]>(studio, session, "GET", "/items?limit=100");
	const names = new Set((Array.isArray(known) ? known : known.items).map((item) => item.name));
	for (const item of products(studio).items) {
		if (names.has(item.name)) continue;
		await projectApi(studio, session, "POST", "/items", {
			name: item.name,
			sku: item.sku,
			unit_price: item.price,
			currency: "EUR",
			tax_rate: session.demo.vatRate,
			supply_type: item.supply,
			tax_category: "standard",
			unit: item.unit,
		});
	}
}

async function openTerminal(studio: Studio, session: Session) {
	const page = "open-terminal";
	await studio.open(projectPath(session), 1200);
	await studio.shot(page, "nav", { mark: `.project-nav >> link:${studio.t("nav.terminal")}` });
	await studio.open(projectPath(session, "/pos"), 1800);
	await studio.shot(page, "terminal");
	await studio.shot(page, "top-bar", { target: ".pos-bar", mark: [`.pos-bar >> button:${studio.t("pos.today")}`, ".pos-currency"] });
}

async function sell(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "sell";
	const { items, note } = products(studio);
	await studio.open(projectPath(session, "/pos"), 1800);
	await tap(studio, items[0].name, 2);
	await tap(studio, items[1].name, 3);
	await studio.shot(page, "cart", { mark: ".pos-cart" });
	await studio.shot(page, "quantity", { target: ".pos-cart", padding: 16, mark: ".pos-line:first-child .pos-qty" });
	await browser.fill(".pos-items input[type=search]", items[2].name.slice(0, 4));
	await browser.wait(500);
	await studio.shot(page, "search", { target: ".pos-catalog", padding: 16 });
	await browser.fill(".pos-items input[type=search]", "");
	await chooseTab(studio, studio.t("pos.keypad"));
	await pressKeys(studio, "1500");
	await browser.fill(".pos-keypad input[type=text]", note);
	await browser.blur();
	await studio.shot(page, "keypad", { target: ".pos-catalog", padding: 16, mark: ".pos-keypad .pos-add" });
	await browser.click(".pos-keypad .pos-add", 500);
	await chooseTab(studio, studio.t("nav.items"));
	await studio.shot(page, "ready", { mark: ".pos-charge-button" });
}

async function takePayment(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "take-payment";
	await studio.open(projectPath(session, "/pos"), 1800);
	await browser.click(".pos-charge-button", 2500);
	await studio.shot(page, "scan");
	await browser.click(`button:${studio.t("pos.paid_in_cash")}`, 800);
	await browser.click(".pos-quick-cash .button:last-child", 400);
	await studio.shot(page, "cash", { target: ".dialog", padding: 32, mark: ".dialog .pos-change" });
	await browser.click(".dialog >> button[type=submit]", 3000);
	await studio.shot(page, "paid");
	await browser.fill(".pos-overlay input[type=email]", products(studio).receipt);
	await browser.click(`button:${studio.t("pos.email_receipt")}`, 2500);
	await studio.shot("receipts", "email", { target: ".pos-overlay form", padding: 24 });
	const href = await browser.eval<string>(`[...document.querySelectorAll(".pos-overlay a")].find((link) => link.href.endsWith("/print")).getAttribute("href")`);
	await studio.open(href, 2500);
	await studio.shot("receipts", "printed", { full: true });
}

async function cancelSale(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "cancel-sale";
	const { items } = products(studio);
	await studio.open(projectPath(session, "/pos"), 1800);
	if (await browser.exists(`button:${studio.t("pos.new_sale")}`)) await browser.click(`button:${studio.t("pos.new_sale")}`, 600);
	await tap(studio, items[3].name);
	await browser.click(".pos-charge-button", 2500);
	await browser.click(`button:${studio.t("pos.cancel_sale")}`, 800);
	await studio.shot(page, "confirm", { target: ".dialog", padding: 32 });
	await browser.click(`.dialog >> button:${studio.t("pos.cancel_sale")}`, 2000);
	await studio.shot(page, "back-to-cart", { keepToasts: true });
	await browser.click(`.pos-cart >> button:${studio.t("pos.clear")}`, 600);
	if (await browser.exists(".dialog")) await browser.click(`.dialog >> button:${studio.t("pos.clear")}`, 600);
}

async function salesToday(studio: Studio, session: Session) {
	const { browser } = studio;
	await studio.open(projectPath(session, "/pos"), 1800);
	await browser.click(`.pos-bar >> button:${studio.t("pos.today")}`, 1500);
	await studio.shot("sales-today", "dialog", { target: ".dialog", padding: 32 });
	await browser.click(".dialog .icon-button");
}

async function settings(studio: Studio, session: Session) {
	const { browser } = studio;
	await studio.open(projectPath(session, "/settings"), 1800);
	await studio.shot("terminal-settings", "card", { target: `card:${studio.t("nav.terminal")}` });
	await studio.open(projectPath(session, "/members"), 1500);
	if (await browser.exists(`button:${studio.t("members.invite")}`)) {
		await browser.click(`button:${studio.t("members.invite")}`, 800);
		await browser.fill(".dialog input[type=email]", studio.language === "en" ? "liam.byrne@example.com" : "jan.kos@example.com");
		await browser.choose(".dialog select", "cashier");
		await browser.blur();
		await studio.shot("terminal-settings", "cashier", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .icon-button");
	}
}

export const terminal: Guide = {
	module: "terminal",
	steps: [
		["prepare", prepare],
		["open-terminal", openTerminal],
		["sell", sell],
		["take-payment", takePayment],
		["cancel-sale", cancelSale],
		["sales-today", salesToday],
		["terminal-settings", settings],
	],
};
