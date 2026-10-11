import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.inventory.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { syncSales, sellableQuantities, revalueProject, forgetSalesScans } = await import("../server/inventory/stock");
const { localDate, startOfLocalDate, endOfLocalDate } = await import("../server/timezone");
const { buildDdvEvidence } = await import("../server/ddv-evidence");
const { generateLicenseCode } = await import("../server/licensing");
const { checkoutTurn } = await import("../server/store/checkout");

await Server.configure();

const password = new Bun.CryptoHasher("blake2b512").update("stock-owner").digest("hex");
const TODAY = localDate(Date.now(), "Europe/Ljubljana");
const YEAR = Number(TODAY.slice(0, 4));
const PERIOD = { from: Date.UTC(YEAR - 1, 11, 31, 23), to: Date.UTC(YEAR, 11, 31, 23) - 1 };

let token = "";
let project = "";
let warehouse = "";
let shop = "";
let widget = "";
let screws = "";
let service = "";
const base = () => `/api/v1/projects/${project}`;

async function call(method: string, path: string, body?: unknown): Promise<any> {
	const response = await Server.app.handle(
		new Request(`http://localhost${path}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	);
	return { status: response.status, ...((await response.json()) as { error: number; data: any }) };
}

async function projectRow(): Promise<any> {
	const [row] = await Database`SELECT * FROM projects WHERE uuid = ${project}`;
	return row;
}

async function createItem(name: string, price: number): Promise<string> {
	const created = await call("POST", `${base()}/items`, { name, unit_price: price, currency: "EUR", tax_rate: 22, supply_type: "goods", unit: "C62" });
	expect(created.error).toBe(0);
	return created.data.uuid;
}

async function document(input: Record<string, unknown>, post = true): Promise<any> {
	const created = await call("POST", `${base()}/inventory/documents`, { warehouse, date: TODAY, ...input });
	expect(created.error).toBe(0);
	if (!post) return created.data;
	const posted = await call("POST", `${base()}/inventory/documents/${created.data.uuid}/post`);
	expect(posted.error).toBe(0);
	return posted.data;
}

async function sell(item: string, quantity: number): Promise<string> {
	const invoice = await call("POST", `${base()}/invoices`, {
		currency: "EUR",
		due_date: Date.now() + 86_400_000,
		items: [{ item, description: "Sold item", quantity, unit_price: 2000, tax_rate: 22, tax_treatment: "domestic" }],
	});
	expect(invoice.error).toBe(0);
	expect((await call("POST", `${base()}/invoices/${invoice.data.uuid}/open`)).error).toBe(0);
	await syncSales(await projectRow());
	return invoice.data.uuid;
}

async function stock(item: string, place: string | null = null): Promise<{ quantity: number; value: number }> {
	const result = await call("GET", `${base()}/inventory/stock?limit=500${place ? `&warehouse=${place}` : ""}`);
	expect(result.error).toBe(0);
	const row = result.data.items.find((entry: any) => entry.item === item);
	return { quantity: row?.quantity ?? 0, value: row?.value ?? 0 };
}

async function balances(): Promise<Record<string, number>> {
	const result = await call("GET", `${base()}/accounting/trial-balance?from=${PERIOD.from}&to=${PERIOD.to}`);
	expect(result.error).toBe(0);
	return Object.fromEntries(result.data.accounts.map((row: any) => [row.code, row.closing]));
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await call("POST", "/api/v1/auth/register", { email: "stock-owner@example.com", password });
	token = (await call("POST", "/api/v1/auth/login", { email: "stock-owner@example.com", password })).data.token;
	project = (await call("POST", "/api/v1/projects", { name: "stock", currency: "EUR" })).data.uuid;
	await call("PATCH", base(), { tax_country: "SI", vat_status: "registered", tax_currency: "EUR", timezone: "Europe/Ljubljana" });
	await call("PUT", `${base()}/company`, {
		legal_name: "Primer trgovina d.o.o.",
		address_line1: "Dunajska cesta 1",
		postal_code: "1000",
		city: "Ljubljana",
		country: "SI",
		tax_number: "12345678",
		vat_number: "SI12345678",
	});
	widget = await createItem("Widget", 2000);
	screws = await createItem("Screws", 10);
	const created = await call("POST", `${base()}/items`, { name: "Consulting", unit_price: 5000, currency: "EUR", tax_rate: 22, supply_type: "services" });
	service = created.data.uuid;
});

afterAll(() => {
	for (const suffix of ["", "-wal", "-shm"]) {
		try {
			unlinkSync(`${import.meta.dir}/.inventory.sqlite${suffix}`);
		} catch {}
	}
});

describe("the inventory license", () => {
	test("stock cannot be changed without a license", async () => {
		expect((await call("PUT", `${base()}/inventory/items/${widget}`, { stock_kind: "goods" })).error).toBe(1339);
		const overview = await call("GET", `${base()}/inventory/overview`);
		expect(overview.error).toBe(0);
		expect(overview.data.licensed).toBe(false);
	});

	test("an inventory key switches it on", async () => {
		const code = generateLicenseCode();
		const now = Date.now();
		await Database`
			INSERT INTO license_keys(uuid, code, type, duration_days, status, created, updated)
			VALUES(${crypto.randomUUID()}, ${code}, 'inventory', 365, 'available', ${now}, ${now})
		`;
		const redeemed = await call("POST", `${base()}/license/redeem`, { code });
		expect(redeemed.error).toBe(0);
		expect((await call("GET", `${base()}/inventory/overview`)).data.licensed).toBe(true);
	});
});

describe("stock keeping on items", () => {
	test("a service cannot keep stock", async () => {
		expect((await call("PUT", `${base()}/inventory/items/${service}`, { stock_kind: "goods" })).error).toBe(1344);
	});

	test("turning stock on creates the default warehouse", async () => {
		expect((await call("PUT", `${base()}/inventory/items/${widget}`, { stock_kind: "goods", stock_minimum: 5000 })).error).toBe(0);
		expect((await call("PUT", `${base()}/inventory/items/${screws}`, { stock_kind: "material" })).error).toBe(0);
		const overview = await call("GET", `${base()}/inventory/overview`);
		expect(overview.error).toBe(0);
		expect(overview.data.warehouses).toHaveLength(1);
		expect(overview.data.settings.method).toBe("average");
		warehouse = overview.data.warehouses[0].uuid;
		const second = await call("POST", `${base()}/inventory/warehouses`, { name: "Shop", code: "02" });
		expect(second.error).toBe(0);
		shop = second.data.uuid;
		expect((await call("POST", `${base()}/inventory/warehouses`, { name: "Duplicate", code: "02" })).error).toBe(1347);
	});

	test("documents refuse items that do not keep stock", async () => {
		const created = await call("POST", `${base()}/inventory/documents`, {
			document_type: "receipt",
			warehouse,
			date: TODAY,
			lines: [{ item: service, quantity: 1000, value: 100 }],
		});
		expect(created.error).toBe(1344);
	});
});

describe("receipts and sales", () => {
	test("a receipt adds dependent costs to the purchase value", async () => {
		const receipt = await document({
			document_type: "receipt",
			partner: "Primer dobavitelj d.o.o.",
			external_reference: "DOB-17",
			extra_costs: 1000,
			lines: [
				{ item: widget, quantity: 10_000, value: 9_000 },
				{ item: screws, quantity: 1_000_000, value: 1_000 },
			],
		});
		expect(receipt.number).toBe(`PR-${YEAR}-0001`);
		expect(await stock(widget)).toEqual({ quantity: 10_000, value: 9_900 });
		expect(await stock(screws)).toEqual({ quantity: 1_000_000, value: 1_100 });
	});

	test("a draft does not move stock and can be deleted", async () => {
		const draft = await document({ document_type: "receipt", lines: [{ item: widget, quantity: 5_000, value: 5_000 }] }, false);
		expect(draft.status).toBe("draft");
		expect((await stock(widget)).quantity).toBe(10_000);
		expect((await call("DELETE", `${base()}/inventory/documents/${draft.uuid}`)).error).toBe(0);
	});

	test("an issued invoice takes goods out at the average cost", async () => {
		await document({ document_type: "receipt", lines: [{ item: widget, quantity: 10_000, value: 12_100 }] });
		expect(await stock(widget)).toEqual({ quantity: 20_000, value: 22_000 });
		await sell(widget, 5);
		expect(await stock(widget)).toEqual({ quantity: 15_000, value: 16_500 });
	});

	test("the ledger carries stock, purchase clearing, cost of goods sold and goods revenue", async () => {
		const closing = await balances();
		expect(closing["6600"]).toBe(16_500);
		expect(closing["3100"]).toBe(1_100);
		expect(closing["6590"]).toBe(-22_000);
		expect(closing["3090"]).toBe(-1_100);
		expect(closing["7020"]).toBe(5_500);
		expect(closing["7620"]).toBe(10_000);
		const overview = await call("GET", `${base()}/inventory/overview`);
		expect(overview.data.ledger.every((row: any) => row.difference === 0)).toBe(true);
		expect(overview.data.totals.goods).toBe(16_500);
	});

	test("a canceled invoice brings the goods back at their original cost", async () => {
		const invoice = await sell(widget, 2);
		expect(await stock(widget)).toEqual({ quantity: 13_000, value: 14_300 });
		expect((await call("POST", `${base()}/invoices/${invoice}/cancel`, { reason: "Wrong buyer" })).error).toBe(0);
		await syncSales(await projectRow());
		expect(await stock(widget)).toEqual({ quantity: 15_000, value: 16_500 });
		expect((await balances())["7020"]).toBe(5_500);
	});
});

describe("issues, transfers and stocktakes", () => {
	test("material issued to consumption becomes a material cost", async () => {
		await document({ document_type: "issue", reason: "consumption", lines: [{ item: screws, quantity: 500_000 }] });
		expect(await stock(screws)).toEqual({ quantity: 500_000, value: 550 });
		const closing = await balances();
		expect(closing["3100"]).toBe(550);
		expect(closing["4000"]).toBe(550);
	});

	test("a taxable shortage charges output VAT on the cost", async () => {
		const before = await balances();
		await document({ document_type: "issue", reason: "shortage", charge_vat: true, lines: [{ item: widget, quantity: 1_000 }] });
		const after = await balances();
		expect(await stock(widget)).toEqual({ quantity: 14_000, value: 15_400 });
		expect(after["7020"] - before["7020"]).toBe(1_100 + 242);
		expect(after["2600"] - before["2600"]).toBe(242);
	});

	test("the taxable shortage is listed in the VAT records as an internal document", async () => {
		const month = TODAY.slice(0, 7);
		const lastDay = new Date(Date.UTC(YEAR, Number(month.slice(5)), 0)).getUTCDate();
		const evidence = await buildDdvEvidence(await projectRow(), {
			from: startOfLocalDate(`${month}-01`, "Europe/Ljubljana"),
			to: endOfLocalDate(`${month}-${String(lastDay).padStart(2, "0")}`, "Europe/Ljubljana"),
			refund: false,
			deductible_share: false,
			late_submission: null,
			insolvency: false,
			tax_authority_order: false,
			note: null,
		});
		const record = evidence.evidence.DDV_KIR_KPR.Lista_KIR.KIR.find((row: any) => String(row.P3).startsWith("IZ-"));
		expect(record).toMatchObject({ P7: 11, P14: 2.42, P28: "Interni dokument: primanjkljaj blaga" });
		expect(evidence.reconciliation.balanced).toBe(true);
	});

	test("a transfer moves quantity and value between warehouses without a ledger effect", async () => {
		const before = await balances();
		await document({ document_type: "transfer", target_warehouse: shop, lines: [{ item: widget, quantity: 4_000 }] });
		expect(await stock(widget, warehouse)).toEqual({ quantity: 10_000, value: 11_000 });
		expect(await stock(widget, shop)).toEqual({ quantity: 4_000, value: 4_400 });
		expect((await balances())["6600"]).toBe(before["6600"]);
	});

	test("a stocktake books the difference between counted and booked stock", async () => {
		const sheet = await call("GET", `${base()}/inventory/count-sheet?warehouse=${warehouse}&date=${TODAY}`);
		expect(sheet.data.items.find((row: any) => row.item === widget).booked).toBe(10_000);
		const stocktake = await document({
			document_type: "stocktake",
			lines: [
				{ item: widget, quantity: 9_000 },
				{ item: screws, quantity: 520_000 },
			],
		});
		expect(stocktake.lines.map((line: any) => line.expected_quantity)).toEqual([10_000, 500_000]);
		expect(await stock(widget, warehouse)).toEqual({ quantity: 9_000, value: 9_900 });
		expect(await stock(screws)).toEqual({ quantity: 520_000, value: 572 });
	});

	test("nothing can be booked before a stocktake that counted the item", async () => {
		const yesterday = localDate(Date.now() - 86_400_000, "Europe/Ljubljana");
		const late = await document({ document_type: "receipt", date: yesterday, lines: [{ item: widget, quantity: 1_000, value: 1_000 }] }, false);
		expect((await call("POST", `${base()}/inventory/documents/${late.uuid}/post`)).error).toBe(1346);
		const elsewhere = await document({ document_type: "receipt", warehouse: shop, date: yesterday, lines: [{ item: widget, quantity: 1_000, value: 1_100 }] });
		expect(elsewhere.status).toBe("posted");
	});

	test("a future date is refused", async () => {
		const tomorrow = localDate(Date.now() + 2 * 86_400_000, "Europe/Ljubljana");
		const draft = await document({ document_type: "receipt", date: tomorrow, lines: [{ item: widget, quantity: 1_000, value: 1_000 }] }, false);
		expect((await call("POST", `${base()}/inventory/documents/${draft.uuid}/post`)).error).toBe(1351);
	});
});

describe("canceling and settings", () => {
	test("canceling a posted document removes its movements and reverses the ledger entry", async () => {
		const receipt = await document({ document_type: "receipt", warehouse: shop, lines: [{ item: widget, quantity: 2_000, value: 2_200 }] });
		const stocked = await stock(widget, shop);
		const canceled = await call("POST", `${base()}/inventory/documents/${receipt.uuid}/cancel`, { reason: "Entered twice" });
		expect(canceled.error).toBe(0);
		expect(canceled.data.status).toBe("canceled");
		expect(await stock(widget, shop)).toEqual({ quantity: stocked.quantity - 2_000, value: stocked.value - 2_200 });
		const overview = await call("GET", `${base()}/inventory/overview`);
		expect(overview.data.ledger.every((row: any) => row.difference === 0)).toBe(true);
		expect((await call("POST", `${base()}/inventory/documents/${receipt.uuid}/cancel`, {})).error).toBe(1343);
	});

	test("without negative stock an issue larger than the stock is refused", async () => {
		expect((await call("PUT", `${base()}/inventory/settings`, { negative_stock: false })).error).toBe(0);
		const draft = await document({ document_type: "issue", reason: "damage", warehouse: shop, lines: [{ item: widget, quantity: 900_000 }] }, false);
		expect((await call("POST", `${base()}/inventory/documents/${draft.uuid}/post`)).error).toBe(1345);
		expect((await call("PUT", `${base()}/inventory/settings`, { negative_stock: true })).error).toBe(0);
	});

	test("without negative stock a sale larger than the stock in the default warehouse is refused", async () => {
		const sellable = (await sellableQuantities(project, [widget, service])).get(widget)!;
		expect(sellable).toBe((await stock(widget, warehouse)).quantity / 1000);
		expect((await call("PUT", `${base()}/inventory/settings`, { negative_stock: false })).error).toBe(0);
		const draft = await call("POST", `${base()}/invoices`, {
			currency: "EUR",
			due_date: Date.now() + 86_400_000,
			items: [{ item: widget, description: "Too many", quantity: sellable + 1, unit_price: 2000, tax_rate: 22, tax_treatment: "domestic" }],
		});
		expect(draft.error).toBe(0);
		expect((await call("POST", `${base()}/invoices/${draft.data.uuid}/open`)).error).toBe(1345);
		expect((await call("PUT", `${base()}/inventory/settings`, { negative_stock: true })).error).toBe(0);
		expect((await call("POST", `${base()}/invoices/${draft.data.uuid}/open`)).error).toBe(0);
		await syncSales(await projectRow());
		expect((await stock(widget, warehouse)).quantity).toBe(-1000);
		await document({ document_type: "receipt", lines: [{ item: widget, quantity: 5_000, value: 6_000 }] });
		expect(await stock(widget, warehouse)).toEqual({ quantity: 4_000, value: 4_800 });
		const overview = await call("GET", `${base()}/inventory/overview`);
		expect(overview.data.ledger.every((row: any) => row.difference === 0)).toBe(true);
	});

	test("the method changes only from the first day of a business year", async () => {
		expect((await call("PUT", `${base()}/inventory/settings`, { method: "fifo", from: `${YEAR}-06-01` })).error).toBe(1350);
		const changed = await call("PUT", `${base()}/inventory/settings`, { method: "fifo", from: `${YEAR}-01-01` });
		expect(changed.error).toBe(0);
		expect(changed.data.method).toBe("fifo");
		const overview = await call("GET", `${base()}/inventory/overview`);
		expect(overview.data.ledger.every((row: any) => row.difference === 0)).toBe(true);
	});

	test("an item with movements keeps its stock type", async () => {
		expect((await call("PUT", `${base()}/inventory/items/${widget}`, { stock_kind: "material" })).error).toBe(1353);
		expect((await call("DELETE", `${base()}/items/${widget}`)).error).toBe(1067);
	});

	test("the item card lists movements with a running balance", async () => {
		const card = await call("GET", `${base()}/inventory/items/${widget}?limit=200`);
		expect(card.error).toBe(0);
		const total = card.data.levels.reduce((sum: number, level: any) => sum + level.quantity, 0);
		expect(card.data.movements[0].balance_quantity).toBe(total);
		expect(card.data.movements.at(-1).kind).toBe("receipt");
		expect(card.data.movements.at(-1).balance_quantity).toBe(card.data.movements.at(-1).quantity);
		const paged = await call("GET", `${base()}/inventory/items/${widget}?limit=3&offset=2`);
		expect(paged.data.total).toBe(card.data.total);
		expect(paged.data.movements).toEqual(card.data.movements.slice(2, 5));
		const inShop = await call("GET", `${base()}/inventory/items/${widget}?warehouse=${shop}&limit=200`);
		expect(inShop.data.movements[0].balance_quantity).toBe((await stock(widget, shop)).quantity);
	});

	test("the valuation on a date matches the stock list", async () => {
		const valuation = await call("GET", `${base()}/inventory/valuation?date=${TODAY}`);
		const list = await call("GET", `${base()}/inventory/stock?limit=500`);
		expect(valuation.error).toBe(0);
		expect(valuation.data.goods + valuation.data.material).toBe(list.data.value);
	});
});

const supplierInvoice = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
	<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
	<cbc:ID>DOB-2026-55</cbc:ID>
	<cbc:IssueDate>${TODAY}</cbc:IssueDate>
	<cbc:DueDate>${TODAY}</cbc:DueDate>
	<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
	<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
	<cac:AccountingSupplierParty>
		<cac:Party>
			<cac:PostalAddress><cbc:CityName>Maribor</cbc:CityName><cac:Country><cbc:IdentificationCode>SI</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
			<cac:PartyTaxScheme><cbc:CompanyID>SI87654321</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
			<cac:PartyLegalEntity><cbc:RegistrationName>Primer dobavitelj d.o.o.</cbc:RegistrationName></cac:PartyLegalEntity>
		</cac:Party>
	</cac:AccountingSupplierParty>
	<cac:AccountingCustomerParty>
		<cac:Party>
			<cac:PostalAddress><cac:Country><cbc:IdentificationCode>SI</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
			<cac:PartyTaxScheme><cbc:CompanyID>SI12345678</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
			<cac:PartyLegalEntity><cbc:RegistrationName>Primer trgovina d.o.o.</cbc:RegistrationName></cac:PartyLegalEntity>
		</cac:Party>
	</cac:AccountingCustomerParty>
	<cac:TaxTotal>
		<cbc:TaxAmount currencyID="EUR">33.00</cbc:TaxAmount>
		<cac:TaxSubtotal>
			<cbc:TaxableAmount currencyID="EUR">150.00</cbc:TaxableAmount>
			<cbc:TaxAmount currencyID="EUR">33.00</cbc:TaxAmount>
			<cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>22</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
		</cac:TaxSubtotal>
	</cac:TaxTotal>
	<cac:LegalMonetaryTotal>
		<cbc:LineExtensionAmount currencyID="EUR">150.00</cbc:LineExtensionAmount>
		<cbc:TaxExclusiveAmount currencyID="EUR">150.00</cbc:TaxExclusiveAmount>
		<cbc:TaxInclusiveAmount currencyID="EUR">183.00</cbc:TaxInclusiveAmount>
		<cbc:PayableAmount currencyID="EUR">183.00</cbc:PayableAmount>
	</cac:LegalMonetaryTotal>
	<cac:InvoiceLine>
		<cbc:ID>1</cbc:ID>
		<cbc:InvoicedQuantity unitCode="C62">10</cbc:InvoicedQuantity>
		<cbc:LineExtensionAmount currencyID="EUR">120.00</cbc:LineExtensionAmount>
		<cac:Item><cbc:Name>Widget</cbc:Name></cac:Item>
		<cac:Price><cbc:PriceAmount currencyID="EUR">12.00</cbc:PriceAmount></cac:Price>
	</cac:InvoiceLine>
	<cac:InvoiceLine>
		<cbc:ID>2</cbc:ID>
		<cbc:InvoicedQuantity unitCode="C62">3000</cbc:InvoicedQuantity>
		<cbc:LineExtensionAmount currencyID="EUR">30.00</cbc:LineExtensionAmount>
		<cac:Item><cbc:Name>Vijak M4 pocinkan</cbc:Name></cac:Item>
		<cac:Price><cbc:PriceAmount currencyID="EUR">0.01</cbc:PriceAmount></cac:Price>
	</cac:InvoiceLine>
</Invoice>`;

describe("receipts from a supplier e-invoice", () => {
	let expense = "";

	test("an imported invoice marked as a stock purchase waits for its receipt", async () => {
		const imported = await call("POST", `${base()}/expenses/import`, { data: Buffer.from(supplierInvoice).toString("base64"), name: "dobavnica.xml" });
		expect(imported.error).toBe(0);
		expense = imported.data.expense.uuid;
		expect((await call("GET", `${base()}/inventory/purchases`)).data.expenses).toHaveLength(0);
		expect((await call("PATCH", `${base()}/expenses/${expense}`, { stock_purchase: "goods" })).error).toBe(0);
		const waiting = (await call("GET", `${base()}/inventory/purchases`)).data.expenses;
		expect(waiting.map((row: any) => row.uuid)).toEqual([expense]);
		expect(waiting[0].value).toBe(15_000);
		expect((await balances())["6500"]).toBe(15_000);
	});

	test("its lines are proposed with the items that can be recognised", async () => {
		const proposed = (await call("GET", `${base()}/inventory/purchases/${expense}/lines`)).data.lines;
		expect(proposed).toEqual([
			{ description: "Widget", quantity: 10_000, value: 12_000, item: expect.objectContaining({ uuid: widget }) },
			{ description: "Vijak M4 pocinkan", quantity: 3_000_000, value: 3_000, item: null },
		]);
	});

	test("a chosen item is remembered for the next delivery and the receipt clears the purchase", async () => {
		const before = await balances();
		await document({
			document_type: "receipt",
			expense,
			lines: [
				{ item: widget, quantity: 10_000, value: 12_000, note: "Widget" },
				{ item: screws, quantity: 3_000_000, value: 3_000, note: "Vijak M4 pocinkan" },
			],
		});
		expect((await call("GET", `${base()}/inventory/purchases`)).data.expenses).toHaveLength(0);
		const again = (await call("GET", `${base()}/inventory/purchases/${expense}/lines`)).data.lines;
		expect(again[1].item.uuid).toBe(screws);
		const closing = await balances();
		expect(closing["6590"] - before["6590"]).toBe(-12_000);
		expect(closing["3090"] - before["3090"]).toBe(-3_000);
		expect(closing["6500"]).toBe(15_000);
	});
});

describe("purchasing", () => {
	let supplier = "";
	let order = "";
	let lines: any[] = [];

	test("a supplier keeps the details an order and a payment need", async () => {
		expect((await call("POST", `${base()}/inventory/suppliers`, { name: "Primer dobavitelj d.o.o.", iban: "SI56 0000 0000 0000 000" })).error).toBe(1354);
		const created = await call("POST", `${base()}/inventory/suppliers`, {
			name: "Primer dobavitelj d.o.o.",
			tax_number: "SI87654321",
			country: "SI",
			iban: "SI56 1910 0000 0123 438",
			payment_days: 30,
		});
		expect(created.error).toBe(0);
		expect(created.data.iban).toBe("SI56191000000123438");
		supplier = created.data.uuid;
	});

	test("an order gets its number when it is confirmed and counts as stock on order", async () => {
		const draft = await call("POST", `${base()}/inventory/orders`, {
			supplier,
			warehouse,
			date: TODAY,
			lines: [
				{ item: widget, quantity: 20_000, value: 24_000 },
				{ item: screws, quantity: 1_000_000, value: 1_000 },
			],
		});
		expect(draft.error).toBe(0);
		expect(draft.data.number).toBeNull();
		order = draft.data.uuid;
		const confirmed = await call("POST", `${base()}/inventory/orders/${order}/confirm`);
		expect(confirmed.data.number).toBe(`NA-${YEAR}-0001`);
		expect(confirmed.data.ordered_value).toBe(25_000);
		lines = confirmed.data.lines;
		expect((await call("PUT", `${base()}/inventory/orders/${order}`, { supplier, warehouse, date: TODAY, lines: [] })).error).toBe(1359);
		const listed = await call("GET", `${base()}/inventory/stock?limit=500`);
		expect(listed.data.items.find((row: any) => row.item === widget).on_order).toBe(20_000);
		expect((await call("DELETE", `${base()}/inventory/suppliers/${supplier}`)).error).toBe(1356);
	});

	test("receipts against the order track what is still open and close it when complete", async () => {
		const before = await stock(widget, warehouse);
		await document({
			document_type: "receipt",
			purchase_order: order,
			partner: "Primer dobavitelj d.o.o.",
			lines: [{ item: widget, quantity: 12_000, value: 14_400, order_line: lines[0].uuid }],
		});
		let current = (await call("GET", `${base()}/inventory/orders/${order}`)).data;
		expect(current.status).toBe("ordered");
		expect(current.lines.map((line: any) => line.remaining)).toEqual([8_000, 1_000_000]);
		expect(current.received_value).toBe(14_400);
		expect((await stock(widget, warehouse)).quantity).toBe(before.quantity + 12_000);
		expect((await call("POST", `${base()}/inventory/orders/${order}/cancel`)).error).toBe(1359);

		const rest = await document({
			document_type: "receipt",
			purchase_order: order,
			lines: [
				{ item: widget, quantity: 8_000, value: 9_600, order_line: lines[0].uuid },
				{ item: screws, quantity: 1_000_000, value: 1_000, order_line: lines[1].uuid },
			],
		});
		current = (await call("GET", `${base()}/inventory/orders/${order}`)).data;
		expect(current.status).toBe("received");
		expect(current.receipts).toHaveLength(2);

		expect((await call("POST", `${base()}/inventory/documents/${rest.uuid}/cancel`, { reason: "Wrong delivery" })).error).toBe(0);
		expect((await call("GET", `${base()}/inventory/orders/${order}`)).data.status).toBe("ordered");
		expect((await call("POST", `${base()}/inventory/orders/${order}/close`)).error).toBe(0);
	});

	test("a line of another order is refused", async () => {
		const created = await call("POST", `${base()}/inventory/documents`, {
			document_type: "receipt",
			warehouse,
			date: TODAY,
			purchase_order: order,
			lines: [{ item: screws, quantity: 1_000, value: 10, order_line: lines[0].uuid }],
		});
		expect(created.error).toBe(1340);
	});

	test("items below their minimum are suggested for reordering", async () => {
		expect((await call("PUT", `${base()}/inventory/items/${widget}`, { stock_minimum: 900_000 })).error).toBe(0);
		const suggestions = (await call("GET", `${base()}/inventory/reorder`)).data.items;
		const wanted = suggestions.find((row: any) => row.item === widget);
		const held = (await stock(widget)).quantity;
		expect(wanted.suggested).toBe(900_000 - held);
		expect(wanted.supplier).toBe(supplier);
	});

	test("unpaid received invoices become one payment file", async () => {
		const payable = (await call("GET", `${base()}/expense-payments`)).data.expenses;
		expect(payable).toHaveLength(1);
		expect(payable[0].iban).toBe("SI56191000000123438");
		const refused = await call("POST", `${base()}/expense-payments/file`, { expenses: [payable[0].uuid], execution_date: TODAY });
		expect(refused.error).not.toBe(0);
		expect(refused.data.problems).toEqual([{ field: "debtor_iban" }]);
		const response = await Server.app.handle(
			new Request(`http://localhost${base()}/expense-payments/file`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ expenses: [payable[0].uuid], execution_date: TODAY, iban: "SI56 1910 0000 0123 438" }),
			})
		);
		expect(response.status).toBe(200);
		const xml = await response.text();
		expect(xml).toContain("<IBAN>SI56191000000123438</IBAN>");
		expect(xml).toContain('<InstdAmt Ccy="EUR">183.00</InstdAmt>');
		expect(xml).toContain("<CtrlSum>183.00</CtrlSum>");
		expect((await call("GET", `${base()}/expense-payments`)).data.expenses[0].payment_ordered_at).toBeGreaterThan(0);
	});
});

describe("starting stock keeping with stock on the shelf", () => {
	test("the opening quantity is posted together with the switch", async () => {
		const kettle = await createItem("Kettle", 4500);
		expect((await call("GET", `${base()}/inventory/candidates?search=Kettle`)).data.items[0].store_stock).toBeNull();
		expect((await call("PUT", `${base()}/inventory/items/${kettle}`, { stock_kind: "goods", opening: { quantity: 0, value: 100 } })).error).toBe(1340);
		const started = await call("PUT", `${base()}/inventory/items/${kettle}`, {
			stock_kind: "goods",
			opening: { quantity: 7_000, value: 17_500, offset: "expense" },
		});
		expect(started.error).toBe(0);
		expect(await stock(kettle)).toEqual({ quantity: 7_000, value: 17_500 });
		const overview = await call("GET", `${base()}/inventory/overview`);
		expect(overview.data.ledger.every((row: any) => row.difference === 0)).toBe(true);
	});
});

describe("store checkouts", () => {
	test("take their turn one after another for the same project", async () => {
		const order: string[] = [];
		const first = await checkoutTurn("shop");
		const second = checkoutTurn("shop").then((finish) => {
			order.push("second");
			finish();
		});
		const other = await checkoutTurn("another-shop");
		other();
		await Bun.sleep(5);
		order.push("first");
		first();
		await second;
		expect(order).toEqual(["first", "second"]);
		(await checkoutTurn("shop"))();
	});
});

describe("continuing the valuation from the last movement", () => {
	test("gives the same values and levels as replaying the whole history", async () => {
		const snapshot = async () => ({
			movements: await Database`SELECT uuid, value, correction FROM stock_movements WHERE project = ${project} ORDER BY uuid`,
			levels: (await Database`SELECT item, warehouse, quantity, value, state FROM stock_levels WHERE project = ${project} ORDER BY item, warehouse`).map(
				(row: any) => ({ ...row, state: JSON.parse(row.state) })
			),
		});
		const continued = await snapshot();
		expect(continued.movements.length).toBeGreaterThan(15);
		expect(continued.levels.every((level: any) => level.state.applied.count > 0)).toBe(true);
		await Database.begin((tx: any) => revalueProject(tx, { uuid: project, timezone: "Europe/Ljubljana" }));
		expect(await snapshot()).toEqual(continued);
	});

	test("a sale issued days ago is still found by the next full scan", async () => {
		const before = await stock(widget, warehouse);
		const invoice = await call("POST", `${base()}/invoices`, {
			currency: "EUR",
			due_date: Date.now() + 86_400_000,
			items: [{ item: widget, description: "Late", quantity: 1, unit_price: 2000, tax_rate: 22, tax_treatment: "domestic" }],
		});
		expect((await call("POST", `${base()}/invoices/${invoice.data.uuid}/open`)).error).toBe(0);
		const [item] = await Database`SELECT stock_since FROM catalog_items WHERE uuid = ${widget}`;
		await Database`UPDATE invoices SET issued_at = ${Math.max(Number(item.stock_since), Date.now() - 4 * 86_400_000)} WHERE uuid = ${invoice.data.uuid}`;
		await Database`DELETE FROM stock_movements WHERE invoice = ${invoice.data.uuid}`;
		await Database.begin((tx: any) => revalueProject(tx, { uuid: project, timezone: "Europe/Ljubljana" }));
		forgetSalesScans();
		await syncSales(await projectRow());
		expect((await stock(widget, warehouse)).quantity).toBe(before.quantity - 1_000);
	});
});

describe("stock outside the inventory screens", () => {
	test("the item list carries the quantity on hand of items that keep stock", async () => {
		const listed = (await call("GET", `${base()}/items?limit=500`)).data.items;
		expect(listed.find((item: any) => item.uuid === widget).stock_quantity).toBe((await stock(widget)).quantity);
		expect(listed.find((item: any) => item.uuid === service).stock_quantity).toBeNull();
	});

	test("a past year with stock but no stocktake is flagged before it is closed", async () => {
		await Database`UPDATE stock_movements SET movement_date = movement_date - ${400 * 86_400_000} WHERE project = ${project} AND movement_kind = 'opening'`;
		const years = (await call("GET", `${base()}/accounting/years`)).data.years;
		expect(years.find((year: any) => year.year === YEAR - 1).stock_uncounted).toBe(true);
		expect(years.find((year: any) => year.year === YEAR).stock_uncounted).toBe(false);
		await Database`UPDATE stock_movements SET movement_date = movement_date + ${400 * 86_400_000} WHERE project = ${project} AND movement_kind = 'opening'`;
	});
});
