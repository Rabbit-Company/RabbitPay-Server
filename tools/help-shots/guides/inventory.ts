import { Database } from "bun:sqlite";
import { fold } from "../../../server/registry/furs";
import { daysFromNow, projectApi, projectPath } from "../actions";
import type { Session } from "../demo";
import { iban } from "../einvoice";
import type { Guide } from "../run";
import { taxNumberAfter } from "../setup";
import type { Studio } from "../studio";
import { storeProductNames } from "./store";

const CONTENT = ".project-content";

interface InventoryDemo {
	supplier: { name: string; address: string; postalCode: string; city: string; country: string; email: string; iban: string };
	deliveryNote: string;
	orderReference: string;
	warehouse: { name: string; code: string; address: string };
	damage: string;
}

const DATA: Record<"en" | "sl", InventoryDemo> = {
	en: {
		supplier: {
			name: "Northbank Print Works Limited",
			address: "22 North Wall Quay",
			postalCode: "D01 H104",
			city: "Dublin",
			country: "IE",
			email: "orders@northbankprint.example",
			iban: iban("IE", "BOFI90001798765432"),
		},
		deliveryNote: "NPW-DN-2207",
		orderReference: "Quote Q-1184",
		warehouse: { name: "Studio shop", code: "SHOP", address: "14 Harbour Lane, Dublin" },
		damage: "Two prints creased in transport",
	},
	sl: {
		supplier: {
			name: "TISKARNA TRNOVO d.o.o.",
			address: "Kolezijska ulica 9",
			postalCode: "1000",
			city: "Ljubljana",
			country: "SI",
			email: "narocila@tiskarna-trnovo.example",
			iban: iban("SI", "560291000987654"),
		},
		deliveryNote: "TT-DOB-2207",
		orderReference: "Ponudba P-1184",
		warehouse: { name: "Prodajalna v studiu", code: "STUDIO", address: "Pod lipo 14, Ljubljana" },
		damage: "Dva plakata zmečkana pri prevozu",
	},
};

const COSTS = [600, 600, 550, 420, 110, 240];
const OPENING = [12, 2, 15, 0, 60, 30];

function data(studio: Studio): InventoryDemo {
	return DATA[studio.language as "en" | "sl"];
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function inventSupplier(studio: Studio, session: Session): string | null {
	const { supplier } = data(studio);
	if (supplier.country !== "SI") return null;
	const database = new Database(studio.database);
	database.run("PRAGMA busy_timeout = 10000");
	const existing = database.query("SELECT tax_number FROM company_registry WHERE name = ?").get(supplier.name) as { tax_number: string } | null;
	if (existing) {
		database.close();
		return existing.tax_number;
	}
	const taken = (candidate: string) => database.query("SELECT 1 FROM company_registry WHERE tax_number = ?").get(candidate) !== null;
	const taxNumber = taxNumberAfter(58_140_000 / 10 + 5 * 7_919, taken);
	database
		.query(
			`INSERT INTO company_registry(tax_number, registration_number, vat_registered, kind, name, street, postal_code, city, country, activity, search, updated)
			VALUES(?, '8914271000', 1, 'company', ?, ?, ?, ?, 'SI', '18.120', ?, ?)`
		)
		.run(taxNumber, supplier.name, supplier.address, supplier.postalCode, supplier.city, fold(supplier.name), Date.now());
	database.close();
	session.marks = { ...session.marks, supplierTax: taxNumber };
	return taxNumber;
}

async function prepare(studio: Studio, session: Session) {
	await studio.open(projectPath(session), 800);
	const database = new Database(studio.database);
	database.run("PRAGMA busy_timeout = 10000");
	database.query("UPDATE projects SET inventory_until = ? WHERE uuid = ?").run(Date.now() + 365 * 86400000, session.project);
	database.close();
	inventSupplier(studio, session);
	await projectApi(studio, session, "PUT", "/member-profile", { full_name: session.demo.owner.name });
}

function items(session: Session): string[] {
	if (!session.storeItems) throw new Error("The online store guide must run before inventory");
	return session.storeItems;
}

async function startKeepingStock(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "start";
	const names = storeProductNames(studio.language);
	await studio.open(projectPath(session, "/inventory"), 1500);
	await studio.shot(page, "nav", { mark: `.project-nav >> link:${studio.t("nav.inventory")}` });
	await studio.shot(page, "empty", { target: CONTENT, mark: `button:${studio.t("stock.track_button")}` });

	await browser.click(`button:${studio.t("stock.track_button")}`, 800);
	await browser.fill(".dialog .combo-input", names[0].slice(0, 8));
	await browser.waitFor(".dialog .combo-option");
	await browser.click(".dialog .combo-option", 600);
	await browser.fill(`.dialog >> field:${studio.t("stock.minimum")}`, "5");
	await browser.fill(`.dialog >> field:${studio.t("stock.track_on_hand")}`, String(OPENING[0]));
	await browser.fill(`.dialog >> field:${studio.t("stock.track_unit_cost")}`, (COSTS[0] / 100).toFixed(2));
	await browser.blur();
	await studio.shot(page, "dialog", { target: ".dialog", padding: 32, mark: ".dialog >> button[type=submit]" });
	await browser.click(".dialog >> button[type=submit]", 1500);

	for (const [index, item] of items(session).entries()) {
		if (index === 0) continue;
		await projectApi(studio, session, "PUT", `/inventory/items/${item}`, {
			stock_kind: "goods",
			stock_minimum: index === 1 ? 5000 : 3000,
			opening: OPENING[index] > 0 ? { quantity: OPENING[index] * 1000, value: OPENING[index] * COSTS[index], offset: "none" } : null,
		});
	}
	await studio.open(projectPath(session, "/inventory"), 1500);
	await studio.shot(page, "stock", { target: CONTENT });
}

async function overview(studio: Studio, session: Session) {
	return await projectApi<{ warehouses: { uuid: string; name: string; is_default: boolean }[] }>(studio, session, "GET", "/inventory/overview");
}

async function chooseLineItem(studio: Studio, row: number, name: string) {
	const line = `.stock-lines .stock-line:nth-child(${row})`;
	await studio.browser.fill(`${line} .combo-input`, name);
	await studio.browser.waitFor(`${line} .combo-option >> text:${name}`);
	await studio.browser.click(`${line} .combo-option >> text:${name}`, 400);
}

async function receiveGoods(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "receive-goods";
	const names = storeProductNames(studio.language);
	const demo = data(studio);
	await studio.open(projectPath(session, "/inventory"), 1500);
	await studio.shot(page, "new-receipt", { target: `${CONTENT} .ledger-head`, mark: `link:${studio.t("stock.new_receipt")}` });
	await studio.open(projectPath(session, "/inventory/documents/new?type=receipt"), 1500);
	await browser.fill(`field:${studio.t("stock.supplier")}`, demo.supplier.name);
	if (session.marks?.supplierTax) await browser.fill(`field:${studio.t("stock.supplier_tax_number")}`, session.marks.supplierTax);
	await browser.fill(`field:${studio.t("stock.supplier_document")}`, demo.deliveryNote);
	await chooseLineItem(studio, 1, names[0]);
	await browser.fill(".stock-lines .stock-line:nth-child(1) .stock-cell-quantity input", "20");
	await browser.fill(".stock-lines .stock-line:nth-child(1) .stock-cell-price input", (COSTS[0] / 100).toFixed(2));
	await browser.click(`button:${studio.t("stock.add_line")}`, 300);
	await chooseLineItem(studio, 2, names[1]);
	await browser.fill(".stock-lines .stock-line:nth-child(2) .stock-cell-quantity input", "20");
	await browser.fill(".stock-lines .stock-line:nth-child(2) .stock-cell-price input", (COSTS[1] / 100).toFixed(2));
	await browser.fill(`field:${studio.t("stock.extra_costs")}`, "18.00");
	await browser.blur();
	await studio.shot(page, "receipt", { target: CONTENT, mark: `button:${studio.t("stock.post")}` });
	await browser.click(`button:${studio.t("stock.post")}`, 1200);
	if (await browser.exists(".dialog")) {
		await studio.shot(page, "confirm", { target: ".dialog", padding: 32 });
		await browser.click(".dialog >> button[type=submit], .dialog .dialog-actions .button.primary", 2000);
	}
	await browser.wait(1200);
	await studio.shot(page, "posted", { target: CONTENT });
	session.marks = { ...session.marks, receipt: (await browser.eval<string>("location.pathname")).split("/").pop()! };
}

async function confirmDialog(studio: Studio) {
	if (await studio.browser.exists(".dialog")) await studio.browser.click(".dialog .dialog-actions .button.primary", 2000);
}

async function suppliers(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "suppliers-and-orders";
	const demo = data(studio);
	const input = (key: Parameters<Studio["t"]>[0]) => `.dialog >> field:${studio.t(key)}`;
	await studio.open(projectPath(session, "/inventory/suppliers"), 1500);
	await studio.shot(page, "suppliers-empty", { target: CONTENT, mark: `button:${studio.t("purchase.supplier_new")}` });
	await browser.click(`button:${studio.t("purchase.supplier_new")}`, 800);
	if (demo.supplier.country === "SI") {
		await browser.fill(".dialog .combo-input", "Tiskarna Trnovo");
		await browser.waitFor(".dialog .combo-option");
		await browser.click(".dialog .combo-option", 1000);
	} else {
		await browser.fill(".dialog .combo-input", demo.supplier.name);
		await browser.click(".dialog h2", 300);
		await browser.fill(input("stock.warehouse_address"), demo.supplier.address);
		await browser.fill(input("purchase.postal_code"), demo.supplier.postalCode);
		await browser.fill(input("purchase.city"), demo.supplier.city);
	}
	await browser.fill(input("purchase.email"), demo.supplier.email);
	await browser.fill(input("purchase.payment_days"), "30");
	await browser.fill(input("purchase.iban"), demo.supplier.iban);
	await browser.blur();
	await studio.shot(page, "supplier", { target: ".dialog", padding: 32, mark: ".dialog >> button[type=submit]" });
	await browser.click(".dialog >> button[type=submit]", 1500);
	await studio.shot(page, "suppliers", { target: CONTENT });
}

async function orders(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "suppliers-and-orders";
	const demo = data(studio);
	await studio.open(projectPath(session, "/inventory/orders"), 1500);
	await studio.shot(page, "reorder", { target: CONTENT, mark: `${CONTENT} >> button:${studio.t("purchase.reorder_create")}` });
	await browser.click(`button:${studio.t("purchase.reorder_create")}`, 1500);
	if (!(await browser.eval<boolean>(`!!document.querySelector(".purchase-supplier .combo-input")?.value`))) {
		await browser.fill(".purchase-supplier .combo-input", demo.supplier.name.slice(0, 8));
		await browser.waitFor(".purchase-supplier .combo-option");
		await browser.click(".purchase-supplier .combo-option", 600);
	}
	await browser.fill(`field:${studio.t("purchase.supplier_reference")}`, demo.orderReference);
	await browser.eval(
		`[...document.querySelectorAll(".stock-lines .stock-line")].forEach((row) => { const price = row.querySelector(".stock-cell-price input"); if (price && !price.value) { price.value = "4.20"; price.dispatchEvent(new Event("input", { bubbles: true })); } })`
	);
	await browser.blur();
	await studio.shot(page, "order", { target: CONTENT, mark: `button:${studio.t("purchase.order_confirm")}` });
	await browser.click(`button:${studio.t("purchase.order_confirm")}`, 1000);
	await studio.shot(page, "confirm", { target: ".dialog", padding: 32 });
	await confirmDialog(studio);
	await browser.wait(1000);
	await studio.shot(page, "confirmed", { target: CONTENT, mark: `button:${studio.t("purchase.receive")}` });
	const order = (await browser.eval<string>("location.pathname")).split("/").pop()!;
	session.marks = { ...session.marks, order };
	await studio.open(projectPath(session, `/inventory/orders/${order}/print`), 2000);
	await studio.shot(page, "printed", { full: true });
	await studio.open(projectPath(session, `/inventory/orders/${order}`), 1500);
	await browser.click(`button:${studio.t("purchase.receive")}`, 1500);
	await browser.fill(`field:${studio.t("stock.supplier_document")}`, `${demo.deliveryNote}-2`);
	await browser.blur();
	await studio.shot(page, "receive", { target: CONTENT, mark: `button:${studio.t("stock.post")}` });
	await browser.click(`button:${studio.t("stock.post")}`, 1200);
	await confirmDialog(studio);
	await studio.open(projectPath(session, `/inventory/orders/${order}`), 1500);
	await studio.shot(page, "received", { target: CONTENT });
}

async function purchaseInvoice(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "receive-goods";
	const demo = data(studio);
	const slovenian = session.demo.company.country === "SI";
	const total = 12300;
	const rate = session.demo.vatRate;
	const tax = slovenian ? Math.round((total / (100 + rate)) * rate) : 0;
	const date = Date.now();
	await studio.open(projectPath(session), 800);
	await projectApi(studio, session, "POST", "/expenses", {
		description: storeProductNames(studio.language)[5],
		supplier: demo.supplier.name,
		supplier_tax_number: session.marks?.supplierTax ?? null,
		supplier_country: demo.supplier.country,
		invoice_number: "NPW-INV-3381",
		category: "Goods for resale",
		currency: "EUR",
		total_amount: total,
		tax_amount: tax,
		deductible_tax_amount: tax,
		expense_date: date,
		issue_date: date,
		receipt_date: date,
		supply_date: null,
		due_date: daysFromNow(30),
		vat_treatment: slovenian ? "domestic" : "not_reported",
		asset_type: "expense",
		vat_handling: "1",
		self_assessment_period: null,
		self_assessment_tax: null,
		tax_exchange_rate: null,
		tax_rate_date: null,
		paid_at: null,
		notes: null,
		stock_purchase: "goods",
		vat_lines: slovenian ? [{ rate, tax_base: total - tax, tax_amount: tax, deductible_tax_amount: tax }] : [],
	});
	await studio.open(projectPath(session, "/inventory"), 1500);
	const section = `${CONTENT} .ledger-section:has(a[href*="expense="])`;
	await browser.waitFor(section);
	await studio.shot(page, "purchases", { target: section, padding: 12, mark: `${section} >> link:${studio.t("stock.create_receipt")}` });
	await browser.click(`${section} >> link:${studio.t("stock.create_receipt")}`, 1800);
	await chooseLineItem(studio, 1, storeProductNames(studio.language)[5]);
	await browser.fill(".stock-lines .stock-line:nth-child(1) .stock-cell-quantity input", "40");
	await browser.blur();
	await studio.shot(page, "from-invoice", { target: CONTENT, mark: `button:${studio.t("stock.post")}` });
	await browser.click(`button:${studio.t("stock.post")}`, 1200);
	await confirmDialog(studio);
	await browser.wait(1000);
}

async function sales(studio: Studio, session: Session) {
	const page = "sales";
	const item = items(session)[0];
	await studio.open(projectPath(session), 800);
	const customer = session.customers![0];
	await projectApi(studio, session, "POST", "/invoices", {
		customer,
		currency: "EUR",
		due_date: daysFromNow(14),
		items: [{ description: storeProductNames(studio.language)[0], quantity: 3, unit_price: 2000, tax_rate: session.demo.vatRate, item, unit: "C62" }],
		discount_amount: 0,
		notes: null,
		status: "open",
	});
	await studio.browser.wait(1500);
	await studio.open(projectPath(session, `/inventory/items/${item}`), 2000);
	await studio.shot(page, "item-card", { target: CONTENT });
}

async function issue(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "issue-stock";
	const names = storeProductNames(studio.language);
	await studio.open(projectPath(session, "/inventory/documents/new?type=issue"), 1500);
	await browser.choose(`field:${studio.t("stock.reason")}`, "damage");
	await chooseLineItem(studio, 1, names[0]);
	await browser.fill(".stock-lines .stock-line:nth-child(1) .stock-cell-quantity input", "2");
	await browser.fill(`field:${studio.t("stock.notes")}`, data(studio).damage);
	await browser.blur();
	await browser.wait(800);
	await studio.shot(page, "issue", { target: CONTENT, mark: `fieldbox:${studio.t("stock.reason")}` });
	await browser.click(`button:${studio.t("stock.post")}`, 1200);
	await confirmDialog(studio);
	await browser.wait(1000);
	await studio.shot(page, "posted", { target: CONTENT });
	await browser.click(`button:${studio.t("stock.cancel_document")}`, 800);
	if (await browser.exists(".dialog")) {
		await studio.shot(page, "cancel", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .icon-button");
	}
}

async function warehouses(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "warehouses-and-transfers";
	const demo = data(studio);
	const names = storeProductNames(studio.language);
	await studio.open(projectPath(session, "/inventory/settings"), 1500);
	await browser.click(`button:${studio.t("stock.warehouse_new")}`, 800);
	await browser.fill(`.dialog >> field:${studio.t("stock.warehouse_name")}`, demo.warehouse.name);
	await browser.fill(`.dialog >> field:${studio.t("stock.warehouse_code")}`, demo.warehouse.code);
	await browser.fill(`.dialog >> field:${studio.t("stock.warehouse_address")}`, demo.warehouse.address);
	await browser.blur();
	await studio.shot(page, "new-warehouse", { target: ".dialog", padding: 32, mark: ".dialog >> button[type=submit]" });
	await browser.click(".dialog >> button[type=submit]", 1500);
	await studio.shot(page, "warehouses", { target: `${CONTENT} .ledger-section:has(.ledger-section-head)` });

	const { warehouses: list } = await overview(studio, session);
	const shop = list.find((entry) => !entry.is_default)!;
	await studio.open(projectPath(session, "/inventory/documents/new?type=transfer"), 1500);
	await browser.choose(`field:${studio.t("stock.to_warehouse")}`, shop.uuid);
	await chooseLineItem(studio, 1, names[2]);
	await browser.fill(".stock-lines .stock-line:nth-child(1) .stock-cell-quantity input", "5");
	await browser.click(`button:${studio.t("stock.add_line")}`, 300);
	await chooseLineItem(studio, 2, names[4]);
	await browser.fill(".stock-lines .stock-line:nth-child(2) .stock-cell-quantity input", "20");
	await browser.blur();
	await browser.wait(800);
	await studio.shot(page, "transfer", { target: CONTENT, mark: `button:${studio.t("stock.post")}` });
	await browser.click(`button:${studio.t("stock.post")}`, 1200);
	await confirmDialog(studio);
	await browser.wait(1000);
}

async function stocktake(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "stocktake";
	const { warehouses: list } = await overview(studio, session);
	const main = list.find((entry) => entry.is_default)!;
	await studio.open(projectPath(session, "/inventory/documents/new?type=stocktake"), 1500);
	await browser.click(`button:${studio.t("stock.load_all_items")}`, 2000);
	await browser.eval(
		`(() => { const rows = [...document.querySelectorAll(".stock-lines .stock-line")]; rows.forEach((row, index) => { const note = row.querySelector(".stock-line-note")?.textContent ?? ""; const booked = Number((note.match(/[\\d.,]+/) ?? ["0"])[0].replace(",", ".")); const input = row.querySelector(".stock-cell-quantity input"); input.value = String(index === rows.length - 1 ? Math.max(0, booked - 2) : booked); input.dispatchEvent(new Event("input", { bubbles: true })); }); })()`
	);
	await browser.blur();
	await browser.wait(800);
	await studio.shot(page, "count", { target: CONTENT, mark: `button:${studio.t("stock.post")}` });
	await studio.open(projectPath(session, `/inventory/count-sheet?warehouse=${main.uuid}&date=${today()}&blind=1`), 2000);
	await studio.shot(page, "count-sheet", { full: true });
	await studio.open(projectPath(session, "/inventory/documents/new?type=stocktake"), 1500);
	await browser.click(`button:${studio.t("stock.load_all_items")}`, 2000);
	await browser.eval(
		`(() => { const rows = [...document.querySelectorAll(".stock-lines .stock-line")]; rows.forEach((row, index) => { const note = row.querySelector(".stock-line-note")?.textContent ?? ""; const booked = Number((note.match(/[\\d.,]+/) ?? ["0"])[0].replace(",", ".")); const input = row.querySelector(".stock-cell-quantity input"); input.value = String(index === rows.length - 1 ? Math.max(0, booked - 2) : booked); input.dispatchEvent(new Event("input", { bubbles: true })); }); })()`
	);
	await browser.click(`button:${studio.t("stock.post")}`, 1200);
	await confirmDialog(studio);
	await browser.wait(1200);
	await studio.shot(page, "posted", { target: CONTENT });
}

async function reports(studio: Studio, session: Session) {
	const page = "stock-reports";
	await studio.open(projectPath(session, "/inventory"), 1500);
	await studio.shot(page, "stock", { target: CONTENT });
	await studio.open(projectPath(session, "/inventory/documents"), 1500);
	await studio.shot(page, "documents", { target: CONTENT });
	await studio.open(projectPath(session, "/inventory/valuation"), 1500);
	await studio.shot(page, "valuation", { target: CONTENT });
}

async function settings(studio: Studio, session: Session) {
	await studio.open(projectPath(session, "/inventory/settings"), 1500);
	await studio.shot("settings", "valuation", { target: `${CONTENT} .ledger-section:has(form)` });
}

export const inventory: Guide = {
	module: "inventory",
	steps: [
		["prepare", prepare],
		["start", startKeepingStock],
		["receive-goods", receiveGoods],
		["purchase-invoice", purchaseInvoice],
		["suppliers", suppliers],
		["orders", orders],
		["sales", sales],
		["issue", issue],
		["warehouses", warehouses],
		["stocktake", stocktake],
		["reports", reports],
		["settings", settings],
	],
};
