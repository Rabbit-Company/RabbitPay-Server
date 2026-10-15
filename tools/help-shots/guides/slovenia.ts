import { Database } from "bun:sqlite";
import { fold } from "../../../server/registry/furs";
import { api, projectApi, projectPath } from "../actions";
import { DEMOS, SLOVENIAN_BRANCH, type Branch, type Company, type Session } from "../demo";
import type { Guide } from "../run";
import { taxNumberAfter } from "../setup";
import type { Studio } from "../studio";
import { issueTaxpayer, CERTIFICATE_PASSWORD } from "../furs";
import { addLine, chooseCustomer, createInvoice, customerDetails } from "./invoices";

const CONTENT = ".project-content";
const FISCAL = "#fiscal";
const STEP = {
	status: `${FISCAL} .fiscal-status`,
	certificate: `${FISCAL} .fiscal-step:nth-child(2)`,
	premises: `${FISCAL} .fiscal-step:nth-child(3)`,
	devices: `${FISCAL} .fiscal-step:nth-child(4)`,
	operators: `${FISCAL} .fiscal-step:nth-child(5)`,
	documents: `${FISCAL} .fiscal-step:nth-child(6)`,
};
const LOCAL = {
	en: {
		reverseItem: { name: "Shop fit-out, installation work", sku: "FITOUT", price: 185000 },
		reference: "PO-2026-1187",
		expense: { description: "Printing of brochures", supplier: "Tiskarna Demo d.o.o." },
		unlockReason: "A supplier invoice for September arrived late",
	},
	sl: {
		reverseItem: { name: "Montaža opreme prodajalne", sku: "MONTAZA", price: 185000 },
		reference: "NAR-2026-1187",
		expense: { description: "Tisk brošur", supplier: "Tiskarna Demo d.o.o." },
		unlockReason: "Račun dobavitelja za september je prispel prepozno",
	},
};
const PERSONAL_TAX_NUMBER = "12345679";
const PREMISE = {
	id: "PP1",
	cadastral: "1725",
	building: "312",
	section: "4",
};

function openDatabase(studio: Studio): Database {
	const database = new Database(studio.database);
	database.run("PRAGMA busy_timeout = 10000");
	return database;
}

function inventBranchCompany(studio: Studio): Company {
	const company = structuredClone(SLOVENIAN_BRANCH.company);
	const database = openDatabase(studio);
	const taken = (candidate: string) => database.query("SELECT 1 FROM company_registry WHERE tax_number = ?").get(candidate) !== null;
	company.taxNumber = taxNumberAfter(58_140_000 / 10 + 3 * 7_919, taken);
	company.vatNumber = `SI${company.taxNumber}`;
	database
		.query(
			`INSERT INTO company_registry(tax_number, registration_number, vat_registered, kind, name, street, postal_code, city, country, activity, search, updated)
			VALUES(?, ?, 1, 'company', ?, ?, ?, ?, 'SI', '62.010', ?, ?)`
		)
		.run(
			company.taxNumber,
			company.registrationNumber,
			company.legalName,
			company.address,
			company.postalCode,
			company.city,
			fold(company.legalName),
			Date.now()
		);
	database.close();
	return company;
}

export function slovenianSession(session: Session): Session {
	if (session.demo.company.country === "SI" || !session.branch) return session;
	const { branch } = session;
	return {
		...session,
		project: branch.project,
		items: branch.items,
		customers: branch.customers,
		customerNames: branch.customerNames,
		demo: { ...session.demo, ...SLOVENIAN_BRANCH, company: branch.company },
	};
}

async function openBranch(studio: Studio, session: Session) {
	if (session.demo.company.country === "SI" || session.branch) return;
	const company = inventBranchCompany(studio);
	const created = await api<{ uuid: string }>(studio, "POST", "/projects", { name: SLOVENIAN_BRANCH.project, display_name: SLOVENIAN_BRANCH.displayName });
	const branch: Branch = { project: created.uuid, company, items: [], customers: [], customerNames: [] };
	const scoped: Session = { ...session, project: created.uuid };
	await projectApi(studio, scoped, "PUT", "/company", {
		legal_name: company.legalName,
		address_line1: company.address,
		postal_code: company.postalCode,
		city: company.city,
		country: company.country,
		vat_number: company.vatNumber,
		tax_number: company.taxNumber,
		registration_number: company.registrationNumber,
		email: company.email,
		phone: company.phone,
		website: company.website,
	});
	await projectApi(studio, scoped, "PATCH", "", { tax_country: "SI", vat_status: "registered" });
	for (const item of DEMOS.en.items) {
		const saved = await projectApi<{ uuid: string }>(studio, scoped, "POST", "/items", {
			name: item.name,
			sku: item.sku,
			unit_price: item.price,
			currency: "EUR",
			tax_rate: SLOVENIAN_BRANCH.vatRate,
			supply_type: "services",
			tax_category: "standard",
			unit: item.unit,
		});
		branch.items.push(saved.uuid);
	}
	for (const customer of SLOVENIAN_BRANCH.customers) {
		const saved = await projectApi<{ uuid: string; name: string }>(studio, scoped, "POST", "/customers", await customerDetails(studio, customer));
		branch.customers.push(saved.uuid);
		branch.customerNames.push(saved.name);
	}
	session.branch = branch;
}

function forgetFakeFiscalSetup(studio: Studio, session: Session) {
	if (session.demo.company.country !== "SI") return;
	const database = openDatabase(studio);
	database.query("DELETE FROM fiscal_settings WHERE project = ? AND certificate = 'help-shots'").run(session.project);
	database.query("DELETE FROM fiscal_premises WHERE project = ? AND environment = 'production'").run(session.project);
	database.close();
}

async function prepare(studio: Studio, session: Session) {
	await studio.open("/projects", 800);
	forgetFakeFiscalSetup(studio, session);
	await openBranch(studio, session);
}

async function setControl(studio: Studio, selector: string, index: number, value: string) {
	await studio.browser.eval(
		`(() => { const control = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; control.value = ${JSON.stringify(value)}; control.dispatchEvent(new Event("input", { bubbles: true })); control.dispatchEvent(new Event("change", { bubbles: true })); })()`
	);
}

async function nameOwner(studio: Studio, session: Session) {
	await projectApi(studio, session, "PUT", "/member-profile", { full_name: session.demo.owner.name });
}

async function fiscalSetup(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "fiscal-verification";
	const { company } = local.demo;
	await studio.open(projectPath(local), 800);
	await nameOwner(studio, local);
	const certificate = issueTaxpayer(company.taxNumber, company.legalName.replace(/,.*$/, "").toUpperCase() + " D.O.O.");
	studio.furs?.trust(certificate);

	await studio.open(projectPath(local, "/settings#fiscal"), 2000);
	await studio.shot(page, "open-settings", { mark: `.project-nav >> link:${studio.t("nav.settings")}` });
	await studio.shot(page, "not-active", { target: [`${FISCAL} > h2`, STEP.status] });
	await browser.chooseFile(`${STEP.certificate} input[type=file]`, certificate);
	await browser.fill(`${STEP.certificate} input[type=password]`, CERTIFICATE_PASSWORD);
	await browser.blur();
	await studio.shot(page, "certificate-form", { target: STEP.certificate, mark: `${STEP.certificate} >> button[type=submit]` });
	await browser.click(`${STEP.certificate} >> button[type=submit]`, 1800);
	await browser.click(`${STEP.certificate} >> button:${studio.t("fiscal.check")}`, 1500);
	await studio.shot(page, "certificate-saved", {
		target: [STEP.status, STEP.certificate],
		mark: `${STEP.certificate} >> button:${studio.t("fiscal.check")}`,
		keepToasts: true,
	});

	await browser.click(`${STEP.premises} summary`, 500);
	const premise = (key: Parameters<Studio["t"]>[0]) => `${STEP.premises} >> field:${studio.t(key)}`;
	await browser.fill(premise("fiscal.premise_id"), PREMISE.id);
	await browser.fill(premise("fiscal.cadastral"), PREMISE.cadastral);
	await browser.fill(premise("fiscal.building"), PREMISE.building);
	await browser.fill(premise("fiscal.section"), PREMISE.section);
	await browser.fill(premise("fiscal.street"), company.address.replace(/\s+\d+\w*$/, ""));
	await browser.fill(premise("fiscal.house"), company.address.match(/(\d+\w*)$/)?.[1] ?? "1");
	await browser.fill(premise("fiscal.community"), company.city);
	await browser.fill(premise("fiscal.postal"), company.postalCode);
	await browser.fill(premise("fiscal.city"), company.city);
	await browser.blur();
	await studio.shot(page, "premise-form", { target: STEP.premises, mark: `${STEP.premises} >> button[type=submit]` });
	await browser.click(`${STEP.premises} >> button[type=submit]`, 1800);
	await studio.shot(page, "premise-registered", { target: STEP.premises });

	const form = `${STEP.devices} form`;
	await setControl(studio, `${form} input[type=text]`, 0, "SPLET1");
	await setControl(studio, `${form} select`, 1, PREMISE.id);
	await setControl(studio, `${form} input[type=text]`, 1, "BLAG1");
	await browser.click(`${STEP.devices} .switch`, 300);
	await browser.blur();
	await studio.shot(page, "devices", { target: STEP.devices, mark: [`${STEP.devices} .switch`, `${STEP.devices} >> button[type=submit]`] });
	await browser.click(`${STEP.devices} >> button[type=submit]`, 1800);

	await browser.fill(`${STEP.operators} tbody tr:first-child input`, PERSONAL_TAX_NUMBER);
	await browser.blur();
	await studio.shot(page, "operators", { target: STEP.operators, mark: `${STEP.operators} tbody tr:first-child button` });
	await browser.click(`${STEP.operators} tbody tr:first-child button`, 1500);
	await studio.shot(page, "active", { target: [`${FISCAL} > h2`, STEP.status] });
}

async function verifiedInvoice(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "verified-invoices";
	await studio.open(projectPath(local), 800);
	const invoice = await createInvoice(studio, local, local.customers![0], [{ item: 1, quantity: 3 }]);
	await projectApi(studio, local, "POST", "/transactions", {
		invoice: invoice.uuid,
		processor: "cash",
		amount: invoice.total_amount,
		fee_amount: 0,
		processor_tx_id: null,
		status: "completed",
		notes: null,
		paid_at: Date.now(),
	});
	session.marks = { ...session.marks, verified: invoice.uuid };
	await browser.wait(2500);
	await studio.open(projectPath(local, `/invoices/${invoice.uuid}`), 1800);
	await studio.shot(page, "invoice", { target: CONTENT });
	await studio.open(projectPath(local, `/invoices/${invoice.uuid}/print`), 2500);
	await studio.shot(page, "printed", { full: true });
	await studio.open(projectPath(local, "/settings#fiscal"), 2500);
	await studio.shot(page, "sent", { target: STEP.documents });
}

function local(studio: Studio) {
	return LOCAL[studio.language as "en" | "sl"];
}

function septemberDay(day: number): number {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth() - 1, day, 12).getTime();
}

async function einvoices(studio: Studio, session: Session) {
	const { browser } = studio;
	const scoped = slovenianSession(session);
	const page = "e-invoices";
	const verified = session.marks!.verified;

	await studio.open(projectPath(scoped, `/invoices/${verified}`), 1500);
	await browser.click(`button:${studio.t("invoices.menu_documents")}`);
	await studio.shot(page, "download", { mark: `menu:${studio.t("invoices.download_eslog")}` });
	await browser.click(`menu:${studio.t("invoices.download_eslog")}`, 2000);
	await studio.open(projectPath(scoped, `/invoices/${verified}`), 1500);
	await studio.shot(page, "versions", { target: `card:${studio.t("invoices.eslog_versions")}` });

	await browser.click(`button:${studio.t("invoices.menu_send")}`);
	await browser.click(`menu:${studio.t("invoices.email_invoice")}`, 800);
	await studio.shot(page, "attach", { target: ".dialog", padding: 32, mark: `.dialog >> switch:${studio.t("invoices.email_attach_eslog")}` });
	await browser.click(".dialog .icon-button");

	await studio.open(projectPath(scoped, "/invoices/new"), 1500);
	await browser.click(`text:${studio.t("invoices.reference_document")}`, 400);
	await browser.fill(`details[open] input`, local(studio).reference);
	await browser.blur();
	await studio.shot(page, "reference", { target: `${CONTENT} form > .card:first-child`, mark: "details[open]" });

	await studio.open(projectPath(scoped, `/customers/${scoped.customers![0]}`), 1500);
	await browser.click(`button:${studio.t("ui.edit")}`, 800);
	if (await browser.exists(".dialog")) {
		await browser.eval(`document.querySelectorAll(".dialog details.form-more").forEach((details) => { details.open = true; })`);
		await studio.shot(page, "customer", { target: ".dialog", padding: 32, mark: ".dialog details.form-more" });
		await browser.click(".dialog .icon-button");
	}

	await studio.open(projectPath(scoped, "/settings#einvoice"), 2000);
	await studio.shot(page, "signing", { target: "#einvoice" });
}

async function companyDetails(studio: Studio, session: Session) {
	const { browser } = studio;
	const scoped = slovenianSession(session);
	const page = "company-details";
	const { company } = scoped.demo;
	await studio.open(projectPath(scoped), 800);
	await projectApi(studio, scoped, "PUT", "/company", { footer_note: null });
	await studio.open(projectPath(scoped, "/settings"), 1800);
	const card = `card:${studio.t("settings.company")}`;
	const add = `${card} >> button:${studio.t("settings.disclosure_add")}`;
	await studio.shot(page, "missing", { target: [`${card} >> fieldbox:${studio.t("settings.invoice_footer")}`, add], padding: 16, mark: add });
	await browser.click(add);
	await browser.blur();
	await studio.shot(page, "suggested", { target: `${card} >> fieldbox:${studio.t("settings.invoice_footer")}`, padding: 16 });
	const footer = `${card} >> textarea`;
	const text = await browser.eval<string>(`window.__helpShots.find(${JSON.stringify(footer)}).value`);
	await browser.fill(
		footer,
		company.footer.reduce((filled, value) => filled.replace("___", value), text)
	);
	await browser.blur();
	await studio.shot(page, "filled", {
		target: [`${card} >> fieldbox:${studio.t("settings.invoice_footer")}`, `button:${studio.t("settings.save_company")}`],
		padding: 16,
		mark: `button:${studio.t("settings.save_company")}`,
	});
	await browser.click(`button:${studio.t("settings.save_company")}`, 1200);
}

async function reverseCharge(studio: Studio, session: Session) {
	const { browser } = studio;
	const scoped = slovenianSession(session);
	const page = "reverse-charge";
	const item = local(studio).reverseItem;
	const input = (key: Parameters<Studio["t"]>[0]) => `.dialog >> field:${studio.t(key)}`;

	await studio.open(projectPath(scoped, "/items"), 1500);
	await browser.click(`button:${studio.t("items.new")}`);
	await browser.fill(input("customers.name"), item.name);
	await browser.fill(input("items.sku"), item.sku);
	await browser.fill(input("items.unit_price"), (item.price / 100).toFixed(2));
	await browser.choose(input("editor.unit"), "E48");
	await browser.choose(input("items.vat_category"), "domestic_reverse");
	await browser.blur();
	await studio.shot(page, "item", { target: ".dialog", padding: 32, mark: `.dialog >> fieldbox:${studio.t("items.vat_category")}` });
	await browser.click(`button:${studio.t("items.add")}`, 1200);

	await studio.open(projectPath(scoped, `/customers/${scoped.customers![1]}`), 1500);
	await browser.click(`button:${studio.t("ui.edit")}`, 800);
	await browser.click(`.dialog >> button:${studio.t("customers.save_and_check")}`, 3000);
	if (await browser.exists(".dialog")) await browser.click(".dialog .icon-button");

	await studio.open(projectPath(scoped, "/invoices/new"), 1500);
	await chooseCustomer(studio, scoped.customerNames![1]);
	await browser.click(".combo-customer .combo-option", 1500);
	await addLine(studio, 1, item.name);
	await browser.wait(1500);
	await browser.blur();
	await studio.shot(page, "invoice", { target: `card:${studio.t("editor.line_items")}` });
}

async function foreignCurrency(studio: Studio, session: Session) {
	const { browser } = studio;
	const scoped = slovenianSession(session);
	const page = "vat-periods";
	await studio.open(projectPath(scoped, "/invoices/new"), 1500);
	await chooseCustomer(studio, scoped.customerNames![0]);
	await browser.click(".combo-customer .combo-option", 800);
	await browser.pick(`field:${studio.t("items.currency")}`, "USD");
	await browser.wait(600);
	await browser.blur();
	await studio.shot(page, "currency", {
		target: `${CONTENT} form > .card:first-child`,
		mark: `fieldbox:${studio.t("invoices.rate_field", { reporting: "EUR", currency: "USD" })}`,
	});
	await studio.shot(page, "supply-date", { target: `${CONTENT} form > .card:first-child`, mark: `fieldbox:${studio.t("invoices.supply_date")}` });

	const invoice = await projectApi<{ uuid: string }>(studio, scoped, "POST", "/invoices", {
		customer: scoped.customers![0],
		currency: "USD",
		due_date: Date.now() + 14 * 86400000,
		items: [{ description: scoped.demo.items[0].name, quantity: 1, unit_price: 260000, tax_rate: scoped.demo.vatRate, unit: scoped.demo.items[0].unit }],
		discount_amount: 0,
		notes: null,
		status: "open",
	});
	await studio.open(projectPath(scoped, `/invoices/${invoice.uuid}`), 2000);
	await studio.shot(page, "issued", { target: `card:${studio.t("invoices.vat_reporting")}` });
}

async function seedSeptember(studio: Studio, scoped: Session) {
	const invoice = await projectApi<{ uuid: string; total_amount: number }>(studio, scoped, "POST", "/invoices", {
		customer: scoped.customers![1],
		currency: "EUR",
		due_date: Date.now() + 14 * 86400000,
		supply_date: septemberDay(18),
		items: [
			{
				description: scoped.demo.items[1].name,
				quantity: 10,
				unit_price: scoped.demo.items[1].price,
				tax_rate: scoped.demo.vatRate,
				item: scoped.items![1],
				unit: scoped.demo.items[1].unit,
			},
		],
		discount_amount: 0,
		notes: null,
		status: "open",
	});
	const date = septemberDay(22);
	const total = 61000;
	const tax = Math.round((total / 122) * 22);
	const { expense } = local(studio);
	const saved = await projectApi<{ uuid: string }>(studio, scoped, "POST", "/expenses", {
		description: expense.description,
		supplier: expense.supplier,
		supplier_tax_number: null,
		supplier_country: "SI",
		invoice_number: "TD-2026-0931",
		category: "Marketing",
		currency: "EUR",
		total_amount: total,
		tax_amount: tax,
		deductible_tax_amount: tax,
		expense_date: date,
		issue_date: date,
		receipt_date: date,
		supply_date: null,
		due_date: date + 15 * 86400000,
		vat_treatment: "domestic",
		asset_type: "expense",
		vat_handling: "1",
		self_assessment_period: null,
		self_assessment_tax: null,
		tax_exchange_rate: null,
		tax_rate_date: null,
		paid_at: date,
		notes: null,
		vat_lines: [{ rate: 22, tax_base: total - tax, tax_amount: tax, deductible_tax_amount: tax }],
	});
	return { invoice, expense: saved.uuid };
}

const SUPPLIER_PDF = [
	"%PDF-1.4",
	"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
	"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
	"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj",
	"trailer << /Root 1 0 R >>",
	"%%EOF",
].join("\n");

async function ddvEvidence(studio: Studio, session: Session) {
	const { browser } = studio;
	const scoped = slovenianSession(session);
	const page = "ddv-evidence";
	const ddv = `section:${studio.t("ddv.title")}`;
	await studio.open(projectPath(scoped), 800);
	const seeded = await seedSeptember(studio, scoped);

	await studio.open(projectPath(scoped, "/statistics"), 2000);
	await studio.shot(page, "form", { target: ddv, mark: `${ddv} >> button:${studio.t("ddv.validate")}` });
	await browser.click(`${ddv} >> button:${studio.t("ddv.validate")}`, 2500);
	await studio.shot(page, "errors", { target: ddv, mark: `${ddv} >> .card.notice` });
	await projectApi(studio, scoped, "PUT", `/expenses/${seeded.expense}/attachment`, {
		name: "TD-2026-0931.pdf",
		type: "application/pdf",
		data: Buffer.from(SUPPLIER_PDF).toString("base64"),
	});
	await browser.click(`${ddv} >> button:${studio.t("ddv.validate")}`, 2500);
	await studio.shot(page, "validated", { target: ddv, mark: `${ddv} >> button:${studio.t("ddv.export")}` });
	await browser.click(`${ddv} >> button:${studio.t("ddv.export")}`, 3500);
	await studio.shot(page, "exported", { target: ddv });
	await browser.click(`${ddv} >> button:${studio.t("ddv.unlock")}`, 800);
	await browser.fill(".dialog textarea", local(studio).unlockReason);
	await browser.blur();
	await studio.shot(page, "unlock", { target: ".dialog", padding: 32 });
	await browser.click(".dialog .icon-button");
}

async function lateReport(studio: Studio, session: Session) {
	const { browser } = studio;
	const scoped = slovenianSession(session);
	const page = "vat-periods";
	await studio.open(projectPath(scoped), 800);
	const draft = await projectApi<{ uuid: string }>(studio, scoped, "POST", "/invoices", {
		customer: scoped.customers![0],
		currency: "EUR",
		due_date: Date.now() + 14 * 86400000,
		supply_date: septemberDay(28),
		items: [
			{
				description: scoped.demo.items[1].name,
				quantity: 4,
				unit_price: scoped.demo.items[1].price,
				tax_rate: scoped.demo.vatRate,
				item: scoped.items![1],
				unit: scoped.demo.items[1].unit,
			},
		],
		discount_amount: 0,
		notes: null,
		status: "draft",
	});
	await studio.open(projectPath(scoped, `/invoices/${draft.uuid}`), 1500);
	await browser.click(`button:${studio.t("invoices.issue")}`, 1500);
	await studio.shot(page, "late-dialog", { target: ".dialog", padding: 32, mark: `.dialog >> button:${studio.t("invoices.late_report_confirm")}` });
	await browser.click(`.dialog >> button:${studio.t("invoices.late_report_confirm")}`, 2000);
	await studio.shot(page, "late-note", { target: `card:${studio.t("invoices.late_report_title")}` });
}

export const slovenia: Guide = {
	module: "slovenia",
	steps: [
		["prepare", prepare],
		["fiscal-verification", fiscalSetup],
		["verified-invoices", verifiedInvoice],
		["e-invoices", einvoices],
		["company-details", companyDetails],
		["reverse-charge", reverseCharge],
		["foreign-currency", foreignCurrency],
		["ddv-evidence", ddvEvidence],
		["late-report", lateReport],
	],
};
