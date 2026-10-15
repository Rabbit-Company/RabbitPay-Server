import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { daysFromNow, projectApi, projectPath } from "../actions";
import { iban, writeSupplierInvoice } from "../einvoice";
import type { Session } from "../demo";
import type { Guide } from "../run";
import type { Studio } from "../studio";

const CONTENT = ".project-content";
const FILES = join(tmpdir(), "rabbitpay-help-shots-files");

interface Spend {
	description: string;
	supplier: string;
	category: string;
	total: number;
	rate: number;
	daysAgo: number;
	paid: boolean;
}

const DATA = {
	en: {
		manual: {
			description: "Postage and courier, October",
			supplier: "An Post",
			category: "Transport and shipping",
			total: "86.10",
			invoice: "AP-2026-10-0412",
		},
		einvoiceCategory: "expenses.category_utilities" as const,
		seeded: [
			{ description: "Office rent, October", supplier: "Patrick Doyle", category: "Rent", total: 145000, rate: 0, daysAgo: 12, paid: true },
			{ description: "Train tickets, client visit in Cork", supplier: "Iarnród Éireann", category: "Travel", total: 11880, rate: 0, daysAgo: 6, paid: true },
			{
				description: "Illustrations for the An Post campaign",
				supplier: "Aoife Kelly",
				category: "Professional services",
				total: 98400,
				rate: 23,
				daysAgo: 4,
				paid: false,
			},
		] as Spend[],
		einvoice: {
			reference: "ESB-2026-48213",
			supplier: {
				name: "Electricity Supply Board",
				address: "27 Fitzwilliam Street Lower",
				postalCode: "D02 KT92",
				city: "Dublin",
				country: "IE",
				vatNumber: "IE8F52100V",
				email: "billing.esb@example.com",
			},
			lines: [{ description: "Electricity, September 2026", quantity: 1, unit: "E48", price: 14260, rate: 13.5 }],
			iban: iban("IE", "BOFI90001712345678"),
		},
		recurring: { description: "Office rent", supplier: "Patrick Doyle", category: "Rent", total: "1450" },
		payer: "IE29 AIBK 9311 5212 3456 78",
		csv: [
			"supplier,supplier_country,invoice_number,issue_date,category,description,vat_rate,net_amount,vat_amount",
			"An Post,IE,AP-118204,2026-10-02,Transport and shipping,Parcel post,23,42.00,9.66",
			"Iarnród Éireann,IE,IR-55021,2026-10-05,Travel,Train tickets Galway,,64.50,",
		],
	},
	sl: {
		manual: {
			description: "Poštnine, oktober",
			supplier: "POŠTA SLOVENIJE D.O.O.",
			category: "Prevoz in pošiljanje",
			total: "86.10",
			invoice: "PS-2026-10-0412",
		},
		einvoiceCategory: "expenses.category_telecom" as const,
		seeded: [
			{ description: "Najemnina pisarne, oktober", supplier: "Marjan Zupan", category: "Rent", total: 145000, rate: 0, daysAgo: 12, paid: true },
			{
				description: "Vozovnice, obisk stranke v Mariboru",
				supplier: "SLOVENSKE ŽELEZNICE, D.O.O.",
				category: "Travel",
				total: 4280,
				rate: 0,
				daysAgo: 6,
				paid: true,
			},
			{
				description: "Ilustracije za kampanjo Pošte Slovenije",
				supplier: "Tina Mlakar s.p.",
				category: "Professional services",
				total: 97600,
				rate: 22,
				daysAgo: 4,
				paid: false,
			},
		] as Spend[],
		einvoice: {
			reference: "TS-2026-0918734",
			supplier: {
				name: "TELEKOM SLOVENIJE, D.D.",
				address: "Cigaletova ulica 15",
				postalCode: "1000",
				city: "Ljubljana",
				country: "SI",
				vatNumber: "SI98511734",
				email: "eracuni.telekom@example.com",
			},
			lines: [
				{ description: "Internet in telefonija, oktober 2026", quantity: 1, unit: "MON", price: 3270, rate: 22 },
				{ description: "Mobilni paket, oktober 2026", quantity: 2, unit: "MON", price: 1475, rate: 22 },
			],
			iban: iban("SI", "560291000123456"),
		},
		recurring: { description: "Najemnina pisarne", supplier: "Marjan Zupan", category: "Najemnina", total: "1450" },
		payer: "SI56 1910 0000 0123 438",
		csv: [
			"supplier,supplier_country,invoice_number,issue_date,category,description,vat_rate,net_amount,vat_amount",
			"POŠTA SLOVENIJE D.O.O.,SI,PS-118204,2026-10-02,Transport and shipping,Paketi,22,42.00,9.24",
			"SLOVENSKE ŽELEZNICE D.O.O.,SI,SZ-55021,2026-10-05,Travel,Vozovnice Koper,,22.90,",
		],
	},
};

function data(studio: Studio) {
	return DATA[studio.language as "en" | "sl"];
}

async function seed(studio: Studio, session: Session) {
	await studio.open(projectPath(session), 800);
	for (const spend of data(studio).seeded) {
		const tax = spend.rate === 0 ? 0 : Math.round((spend.total / (100 + spend.rate)) * spend.rate);
		const date = daysFromNow(-spend.daysAgo);
		await projectApi(studio, session, "POST", "/expenses", {
			description: spend.description,
			supplier: spend.supplier,
			supplier_tax_number: null,
			supplier_country: session.demo.company.country,
			invoice_number: `${spend.supplier.slice(0, 2).toUpperCase()}-${1000 + spend.daysAgo}`,
			category: spend.category,
			currency: "EUR",
			total_amount: spend.total,
			tax_amount: tax,
			deductible_tax_amount: tax,
			expense_date: date,
			issue_date: date,
			receipt_date: date,
			supply_date: null,
			due_date: daysFromNow(10),
			vat_treatment: spend.rate === 0 ? "not_reported" : "domestic",
			asset_type: spend.category === "Equipment" ? "fixed_asset" : "expense",
			vat_handling: "1",
			self_assessment_period: null,
			self_assessment_tax: null,
			tax_exchange_rate: null,
			tax_rate_date: null,
			paid_at: spend.paid ? date : null,
			notes: null,
			vat_lines: spend.rate === 0 ? [] : [{ rate: spend.rate, tax_base: spend.total - tax, tax_amount: tax, deductible_tax_amount: tax }],
		});
	}
}

async function recordExpense(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "record-expense";
	const manual = data(studio).manual;
	const field = (key: Parameters<Studio["t"]>[0]) => `.dialog >> field:${studio.t(key)}`;

	await studio.open(projectPath(session, "/expenses"), 1500);
	await studio.shot(page, "open-expenses", { mark: `.project-nav >> link:${studio.t("nav.expenses")}` });
	await studio.shot(page, "expenses", { target: CONTENT, mark: `button:${studio.t("expenses.add")}` });
	await browser.click(`button:${studio.t("expenses.add")}`, 1000);
	await browser.fill(field("expenses.description"), manual.description);
	await browser.fill(field("expenses.supplier"), manual.supplier);
	await browser.wait(900);
	await browser.click(".dialog .combo-option", 800);
	await browser.fill(field("expenses.category"), manual.category.slice(0, 5));
	await browser.wait(500);
	await studio.shot(page, "choose-category", { target: ".dialog", padding: 24, mark: ".dialog .combo-list" });
	await browser.click(".dialog .combo-option", 600);
	await browser.fill(field("expenses.amount"), manual.total);
	if (await browser.exists(field("expenses.vat_treatment"))) {
		await browser.choose(field("expenses.vat_treatment"), "domestic");
		const net = (Number(manual.total) / (1 + session.demo.vatRate / 100)).toFixed(2);
		await browser.fill(".dialog tbody tr:first-child td:nth-child(2) input", net);
		await browser.fill(field("expenses.invoice_number"), manual.invoice);
	}
	if (await browser.exists(`button:${studio.t("expenses.tax_use_rate", { rate: session.demo.vatRate })}`)) {
		await browser.click(`button:${studio.t("expenses.tax_use_rate", { rate: session.demo.vatRate })}`, 400);
	}
	await browser.blur();
	await studio.shot(page, "amounts", { target: ".dialog", padding: 24 });
	await browser.click(`.dialog >> switch:${studio.t("expenses.paid")}`, 400);
	await browser.blur();
	await studio.shot(page, "filled", { target: ".dialog", padding: 24, mark: `.dialog >> button[type=submit]` });
	await browser.click(".dialog >> button[type=submit]", 1800);
	await studio.shot(page, "list", { target: CONTENT });

	await studio.shot(page, "row-actions", { target: `${CONTENT} table`, mark: `${CONTENT} tbody tr:first-child td:last-child` });
	await browser.choose(`${CONTENT} select`, "unpaid");
	await browser.wait(900);
	await studio.shot(page, "unpaid", { target: CONTENT });
}

async function importEinvoice(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "import-e-invoice";
	mkdirSync(FILES, { recursive: true });
	const source = data(studio).einvoice;
	const file = await writeSupplierInvoice(FILES, { ...source, buyer: session.demo.company, language: studio.language, dueInDays: 5 });

	await studio.open(projectPath(session, "/expenses"), 1500);
	await studio.shot(page, "import-button", { target: CONTENT, mark: `button:${studio.t("expenses.import")}` });
	await browser.chooseFile(`button:${studio.t("expenses.import")}`, file);
	await browser.waitFor(".dialog");
	await studio.shot(page, "review", { target: ".dialog", padding: 24 });
	await browser.fill(`.dialog >> field:${studio.t("expenses.category")}`, studio.t(data(studio).einvoiceCategory).slice(0, 5));
	await browser.wait(500);
	await browser.click(".dialog .combo-option", 600);
	await browser.blur();
	await studio.shot(page, "save", { target: ".dialog", padding: 24, mark: `.dialog >> button[type=submit]` });
	await browser.click(".dialog >> button[type=submit]", 2000);
	await studio.shot(page, "imported", { target: CONTENT });
}

async function importCsv(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "import-csv";
	const file = join(FILES, `expenses-${studio.language}.csv`);
	await Bun.write(file, `${data(studio).csv.join("\n")}\n`);
	await studio.open(projectPath(session, "/expenses"), 1500);
	await browser.click(`button:${studio.t("expenses.import_csv")}`, 1000);
	if (await browser.exists(".dialog")) {
		await studio.shot(page, "dialog", { target: ".dialog", padding: 24 });
		await browser.chooseFile(".dialog input[type=file]", file);
		await browser.wait(1200);
		await studio.shot(page, "preview", { target: ".dialog", padding: 24, mark: ".dialog >> button[type=submit]" });
		await browser.click(".dialog >> button[type=submit]", 2000);
		if (await browser.exists(".dialog")) await browser.click(".dialog .icon-button");
		await studio.shot(page, "imported", { target: CONTENT });
	}
}

async function recurring(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "recurring-expenses";
	const rent = data(studio).recurring;
	const field = (key: Parameters<Studio["t"]>[0]) => `.dialog >> field:${studio.t(key)}`;
	await studio.open(projectPath(session, "/expenses"), 1500);
	await browser.click(`button:${studio.t("expenses.add_recurring")}`, 1000);
	await browser.fill(field("expenses.description"), rent.description);
	await browser.fill(field("expenses.supplier"), rent.supplier);
	await browser.click(".dialog h2");
	await browser.fill(field("expenses.category"), rent.category.slice(0, 5));
	await browser.wait(500);
	await browser.click(".dialog .combo-option", 600);
	await browser.fill(field("expenses.amount"), rent.total);
	await browser.blur();
	await studio.shot(page, "form", { target: ".dialog", padding: 24, mark: `.dialog >> button[type=submit]` });
	await browser.click(".dialog >> button[type=submit]", 1800);
	await studio.shot(page, "schedules", { target: CONTENT });
}

async function paymentFile(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "pay-suppliers";
	await studio.open(projectPath(session, "/expenses"), 1500);
	await studio.shot(page, "button", { target: CONTENT, mark: `button:${studio.t("payments_file.button")}` });
	await browser.click(`button:${studio.t("payments_file.button")}`, 1200);
	await browser.fill(`.dialog >> field:${studio.t("payments_file.payer_iban")}`, data(studio).payer);
	await browser.blur();
	await studio.shot(page, "dialog", { target: ".dialog", padding: 24, mark: `.dialog >> button[type=submit]` });
	await browser.click(".dialog .icon-button");
}

async function generate(studio: Studio, card: string) {
	await studio.browser.click(`${card} >> button:${studio.t("reports.generate")}`, 3000);
}

async function reports(studio: Studio, session: Session) {
	const { browser } = studio;
	const financial = `section:${studio.t("financial.title")}`;
	const vat = `section:${studio.t("stats.vat_report")}`;
	const itemsHead = `section:${studio.t("stats.item_sales")}`;
	const items = [itemsHead, `${CONTENT} > .stack > :last-child`];

	await studio.open(projectPath(session, "/statistics"), 1500);
	await studio.shot("financial-report", "open-statistics", { mark: `.project-nav >> link:${studio.t("nav.statistics")}` });
	await studio.shot("financial-report", "empty", { target: financial });
	await browser.choose(`${financial} >> select`, "year");
	await generate(studio, financial);
	await studio.shot("financial-report", "report", { target: financial });

	await browser.choose(`${vat} >> select`, studio.t("stats.period_this_month"));
	await generate(studio, vat);
	await studio.shot("vat-report", "report", { target: vat });
	if (await browser.exists(`section:${studio.t("ddv.title")}`)) await studio.shot("vat-report", "ddv-evidence", { target: `section:${studio.t("ddv.title")}` });

	await studio.browser.click(`${CONTENT} > .stack > :nth-last-child(2) >> button:${studio.t("reports.generate")}`, 3000);
	await studio.shot("item-sales", "report", { target: items });
}

export const expenses: Guide = {
	module: "expenses-and-reports",
	steps: [
		["seed", seed],
		["record-expense", recordExpense],
		["import-e-invoice", importEinvoice],
		["import-csv", importCsv],
		["recurring-expenses", recurring],
		["pay-suppliers", paymentFile],
		["reports", reports],
	],
};
