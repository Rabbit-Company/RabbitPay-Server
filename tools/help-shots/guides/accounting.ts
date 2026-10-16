import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectApi, projectPath } from "../actions";
import { iban } from "../einvoice";
import type { Session } from "../demo";
import type { Guide } from "../run";
import type { Studio } from "../studio";
import { slovenianSession } from "./slovenia";

const CONTENT = ".project-content";
const FILES = join(tmpdir(), "rabbitpay-help-shots-files", "accounting");
const YEAR = new Date().getFullYear() - 1;

const BUYERS = {
	post: { name: "POŠTA SLOVENIJE D.O.O.", vat: "SI25028022" },
	telekom: { name: "TELEKOM SLOVENIJE, D.D.", vat: "SI98511734" },
	railways: { name: "SLOVENSKE ŽELEZNICE, D.O.O.", vat: "SI18190995" },
	motorways: { name: "DRUŽBA ZA AVTOCESTE V REPUBLIKI SLOVENIJI D.D.", vat: "SI92473717" },
};

const RECORDED: { number: string; buyer: keyof typeof BUYERS; issued: string; net: number; paid: string | null }[] = [
	{ number: "001", buyer: "post", issued: "01-20", net: 2400, paid: "02-10" },
	{ number: "002", buyer: "telekom", issued: "03-05", net: 3850, paid: "03-30" },
	{ number: "003", buyer: "railways", issued: "04-18", net: 1250, paid: "05-12" },
	{ number: "004", buyer: "motorways", issued: "06-09", net: 4600, paid: "07-03" },
	{ number: "005", buyer: "post", issued: "09-22", net: 2900, paid: "10-15" },
	{ number: "006", buyer: "telekom", issued: "11-14", net: 3200, paid: "12-09" },
	{ number: "007", buyer: "railways", issued: "12-12", net: 1800, paid: null },
];

const LAPTOP_SUPPLIER = "SAVSKI RAČUNALNIKI d.o.o.";

const TEXT = {
	en: {
		rent: (month: string) => `Office rent, ${month}`,
		internet: (quarter: number) => `Internet and phone, quarter ${quarter}`,
		laptop: "Laptop for the design studio",
		internetNow: "Internet and phone, September",
		opening: "Opening balances",
		account: { code: "4135", name: "Warehouse rent" },
		months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
		client: { business: "Linden Tree Bakery", name: "Linden Tree Bakery" },
	},
	sl: {
		rent: (month: string) => `Najemnina pisarne, ${month}`,
		internet: (quarter: number) => `Internet in telefonija, ${quarter}. četrtletje`,
		laptop: "Prenosni računalnik za studio",
		internetNow: "Internet in telefonija, september",
		opening: "Otvoritev začetnih stanj",
		account: { code: "4135", name: "Najemnina skladišča" },
		months: ["januar", "februar", "marec", "april", "maj", "junij", "julij", "avgust", "september", "oktober", "november", "december"],
		client: { business: "Pekarna Pod lipo", name: "Pekarna Pod lipo" },
	},
};

function internetNumber(): string {
	return `TS-${new Date().getFullYear()}-1004512`;
}

function text(studio: Studio) {
	return TEXT[studio.language as "en" | "sl"];
}

function day(value: string): string {
	return `${YEAR}-${value}`;
}

function at(date: string): number {
	return new Date(`${date}T10:00:00+01:00`).getTime();
}

function money(value: number): string {
	return value.toFixed(2);
}

function bankIban(session: Session): string {
	return session.demo.company.country === "SI" && session.demo.project === "studio-pod-lipo" ? "SI56191000000123438" : iban("SI", "020100045678912");
}

interface Ledger {
	uuid: string;
	code: string;
	name: string;
}

async function ledgerAccounts(studio: Studio, session: Session): Promise<Ledger[]> {
	return (await projectApi<{ accounts: Ledger[] }>(studio, session, "GET", "/accounting/accounts")).accounts;
}

async function accountOf(studio: Studio, session: Session, code: string): Promise<Ledger> {
	const found = (await ledgerAccounts(studio, session)).find((account) => account.code === code);
	if (!found) throw new Error(`No ledger account ${code}`);
	return found;
}

function license(studio: Studio, session: Session, until: number | null) {
	const database = new Database(studio.database);
	database.run("PRAGMA busy_timeout = 10000");
	database.query("UPDATE projects SET accounting_until = ? WHERE uuid = ?").run(until, session.project);
	database.close();
}

async function expense(
	studio: Studio,
	session: Session,
	spend: {
		description: string;
		supplier: string;
		category: string;
		net: number;
		rate: number;
		date: string;
		paid: boolean;
		asset?: boolean;
		provisional?: boolean;
		number: string;
	}
) {
	const net = Math.round(spend.net * 100);
	const tax = Math.round((net * spend.rate) / 100);
	const date = at(spend.date);
	await projectApi(studio, session, "POST", "/expenses", {
		description: spend.description,
		supplier: spend.supplier,
		supplier_tax_number: null,
		supplier_country: "SI",
		invoice_number: spend.number,
		category: spend.category,
		currency: "EUR",
		total_amount: net + tax,
		tax_amount: tax,
		deductible_tax_amount: tax,
		expense_date: date,
		issue_date: date,
		receipt_date: date,
		supply_date: null,
		due_date: date + 15 * 86400000,
		vat_treatment: spend.rate === 0 ? "not_reported" : "domestic",
		asset_type: spend.asset ? "fixed_asset" : "expense",
		vat_handling: "1",
		self_assessment_period: null,
		self_assessment_tax: null,
		tax_exchange_rate: null,
		tax_rate_date: null,
		paid_at: spend.paid ? date : null,
		provisional_share: spend.provisional ?? false,
		notes: null,
		vat_lines: spend.rate === 0 ? [] : [{ rate: spend.rate, tax_base: net, tax_amount: tax, deductible_tax_amount: tax }],
	});
}

function recordedCsv(): string {
	const header =
		"number,document_type,issue_date,buyer_name,buyer_vat_number,buyer_country,due_date,currency,vat_rate,vat_treatment,net_amount,vat_amount,paid_date,paid_to";
	const rows = RECORDED.map((row) => {
		const buyer = BUYERS[row.buyer];
		const issued = day(row.issued);
		const due = new Date(at(issued) + 30 * 86400000).toISOString().slice(0, 10);
		return [
			`${YEAR}-${row.number}`,
			"invoice",
			issued,
			`"${buyer.name}"`,
			buyer.vat,
			"SI",
			due,
			"EUR",
			"22",
			"domestic",
			money(row.net),
			money(row.net * 0.22),
			row.paid ? day(row.paid) : "",
			row.paid ? "bank" : "",
		].join(",");
	});
	return `${[header, ...rows].join("\n")}\n`;
}

interface OpenInvoice {
	reference: string;
	total: number;
	buyer: string;
}

function openInvoice(studio: Studio, session: Session): OpenInvoice | null {
	const database = new Database(studio.database, { readonly: true });
	const row = database
		.query(
			`SELECT i.reference AS reference, i.total_amount AS total, r.name AS buyer FROM invoices i JOIN company_registry r ON 'SI' || r.tax_number = i.buyer_vat_number
			WHERE i.project = ? AND i.document_type = 'invoice' AND i.status IN ('open', 'overdue') AND i.paid_amount = 0 AND i.currency = 'EUR'
			ORDER BY i.total_amount DESC LIMIT 1`
		)
		.get(session.project) as OpenInvoice | null;
	database.close();
	return row;
}

function entry(date: string, amount: number, party: string | null, details: string, reference: string): string {
	const indicator = amount < 0 ? "DBIT" : "CRDT";
	const role = amount < 0 ? "Cdtr" : "Dbtr";
	return `<Ntry><Amt Ccy="EUR">${money(Math.abs(amount) / 100)}</Amt><CdtDbtInd>${indicator}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${date}</Dt></BookgDt><ValDt><Dt>${date}</Dt></ValDt><AcctSvcrRef>${reference}</AcctSvcrRef><NtryDtls><TxDtls><Refs><EndToEndId>${reference}</EndToEndId></Refs>${
		party ? `<RltdPties><${role}><Nm>${party}</Nm></${role}></RltdPties>` : ""
	}<RmtInf><Ustrd>${details}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`;
}

function statement(session: Session, invoice: OpenInvoice | null, opening: number): string {
	const now = new Date();
	const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
	const today = `${month}-${String(now.getDate()).padStart(2, "0")}`;
	const earlier = (days: number) => `${month}-${String(Math.max(1, now.getDate() - days)).padStart(2, "0")}`;
	const lines: [string, number, string | null, string, string][] = [
		[earlier(9), Math.round(1800 * 1.22 * 100), BUYERS.railways.name, `Placilo racuna ${YEAR}-007`, `${month.replace("-", "")}0017`],
		[earlier(5), -10858, BUYERS.telekom.name, `Internet in telefonija ${internetNumber()}`, `${month.replace("-", "")}0042`],
		[today, -450, null, "Nadomestilo za vodenje racuna", `${month.replace("-", "")}0003`],
	];
	if (invoice) lines.splice(2, 0, [today, invoice.total, invoice.buyer, `Placilo racuna ${invoice.reference}`, `${month.replace("-", "")}0021`]);
	const closing = opening + lines.reduce((sum, line) => sum + line[1], 0);
	const balance = (code: string, amount: number, date: string) =>
		`<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${money(amount / 100)}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${date}</Dt></Dt></Bal>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><GrpHdr><MsgId>IZPISEK-${month}</MsgId><CreDtTm>${month}-10T08:00:00</CreDtTm></GrpHdr><Stmt><Id>${month.replace("-", "")}-001</Id><FrToDt><FrDtTm>${month}-01T00:00:00</FrDtTm><ToDtTm>${today}T23:59:59</ToDtTm></FrToDt><Acct><Id><IBAN>${bankIban(session)}</IBAN></Id><Ccy>EUR</Ccy></Acct>${balance("OPBD", opening, `${month}-01`)}${balance("CLBD", closing, today)}${lines
		.map((line) => entry(...line))
		.join("")}</Stmt></BkToCstmrStmt></Document>
`;
}

async function prepare(studio: Studio, session: Session) {
	const local = slovenianSession(session);
	await studio.open(projectPath(local), 800);
	const words = text(studio);
	license(studio, local, Date.now() + 365 * 86400000);
	const [bank, capital, retained] = await Promise.all(["1100", "9010", "9300"].map((code) => accountOf(studio, local, code)));
	await projectApi(studio, local, "POST", "/accounting/journal", {
		date: at(day("01-01")),
		description: words.opening,
		lines: [
			{ account: bank!.uuid, debit: 985000, credit: 0, partner: null },
			{ account: capital!.uuid, debit: 0, credit: 750000, partner: null },
			{ account: retained!.uuid, debit: 0, credit: 235000, partner: null },
		],
	});
	for (let month = 1; month <= 12; month++) {
		const date = day(`${String(month).padStart(2, "0")}-05`);
		await expense(studio, local, {
			description: words.rent(words.months[month - 1]!),
			supplier: "Marjan Zupan",
			category: "Rent",
			net: 650,
			rate: 0,
			date,
			paid: true,
			number: `NP-${YEAR}-${String(month).padStart(2, "0")}`,
		});
	}
	for (let quarter = 1; quarter <= 4; quarter++) {
		await expense(studio, local, {
			description: words.internet(quarter),
			supplier: BUYERS.telekom.name,
			category: "Phone and internet",
			net: 89,
			rate: 22,
			date: day(`${String(quarter * 3).padStart(2, "0")}-28`),
			paid: true,
			provisional: quarter === 4,
			number: `TS-${YEAR}-${String(quarter * 3).padStart(2, "0")}771${quarter}`,
		});
	}
	await expense(studio, local, {
		description: words.laptop,
		supplier: LAPTOP_SUPPLIER,
		category: "Equipment",
		net: 1690,
		rate: 22,
		date: day("03-14"),
		paid: true,
		asset: true,
		number: `SR-${YEAR}-0318`,
	});
	const now = new Date();
	await expense(studio, local, {
		description: words.internetNow,
		supplier: BUYERS.telekom.name,
		category: "Phone and internet",
		net: 89,
		rate: 22,
		date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`,
		paid: false,
		number: internetNumber(),
	});
	mkdirSync(FILES, { recursive: true });
	await Bun.write(join(FILES, `issued-elsewhere-${studio.language}.csv`), recordedCsv());
}

async function start(studio: Studio, session: Session) {
	const local = slovenianSession(session);
	const page = "start";
	license(studio, local, Date.now() + 365 * 86400000);
	await studio.open(projectPath(local), 1500);
	await studio.shot(page, "nav", { target: ".project-nav", padding: 12, mark: `.project-nav a[href$="/accounting"]` });
	license(studio, local, Date.now() - 86400000);
	await studio.open(projectPath(local, "/accounting"), 2500);
	await studio.shot(page, "license", { target: `${CONTENT} .ledger-notice`, padding: 16 });
	license(studio, local, Date.now() + 365 * 86400000);
	await studio.open(projectPath(local, "/accounting/accounts"), 2500);
	await studio.shot(page, "bookkeeping", { target: `${CONTENT} .ledger-controls`, padding: 16 });
}

async function unclamp(studio: Studio) {
	await studio.browser.eval(
		`document.querySelectorAll(".dialog, .dialog *").forEach((node) => { const style = getComputedStyle(node); if (style.overflowY === "auto" || style.overflowY === "scroll" || style.maxHeight !== "none") { node.style.maxHeight = "none"; node.style.overflow = "visible"; } })`
	);
}

async function setDate(studio: Studio, spec: string, value: string) {
	await studio.browser.eval(
		`(() => { const node = document.querySelector(${JSON.stringify(spec)}); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event("input", { bubbles: true })); node.dispatchEvent(new Event("change", { bubbles: true })); })()`
	);
}

async function chooseAccount(studio: Studio, spec: string, code: string) {
	await studio.browser.fill(spec, code);
	await studio.browser.wait(500);
	await studio.browser.click(".combo-option", 400);
}

async function journal(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "journal";
	const words = text(studio);
	await studio.open(projectPath(local, "/accounting"), 2500);
	await browser.click(`button:${studio.t("accounting.new_entry")}`, 1000);
	if (await browser.exists(".dialog")) {
		await setDate(studio, ".dialog input[type=date]", day("01-01"));
		await browser.fill(".dialog input[type=text]", words.opening);
		const line = (index: number) => `.dialog .journal-line:nth-child(${index})`;
		await chooseAccount(studio, `${line(1)} .account-select input`, "1100");
		await browser.fill(`${line(1)} input[type=number]:nth-of-type(1)`, "9850");
		await chooseAccount(studio, `${line(2)} .account-select input`, "9010");
		await browser.eval(
			`(() => { const node = document.querySelectorAll(".dialog .journal-line")[1].querySelectorAll("input[type=number]")[1]; node.focus(); node.select(); })()`
		);
		await browser.type("7500");
		await browser.click(`.dialog >> button:${studio.t("accounting.add_line")}`, 600);
		await chooseAccount(studio, `${line(3)} .account-select input`, "9300");
		await browser.blur();
		await browser.wait(400);
		await studio.shot(page, "new-entry", { target: ".dialog", padding: 32, mark: `.dialog >> button:${studio.t("accounting.post")}` });
		await browser.click(".dialog .icon-button", 600);
	}
	await studio.open(projectPath(local, "/accounting"), 2500);
	await browser.choose(`${CONTENT} .ledger-controls select`, "last_year");
	await browser.wait(1800);
	await studio.shot(page, "list", { target: [`${CONTENT} .store-bar`, `${CONTENT} tbody tr:nth-child(12)`] });
	await studio.shot(page, "filters", { target: `${CONTENT} .ledger-controls`, padding: 16 });
}

async function recorded(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "issued-elsewhere";
	await studio.open(projectPath(local, "/accounting/recorded-invoices"), 2500);
	await browser.click(`button:${studio.t("recorded.import")}`, 1000);
	if (await browser.exists(".dialog")) {
		await browser.chooseFile(".dialog input[type=file]", join(FILES, `issued-elsewhere-${studio.language}.csv`));
		await browser.wait(1500);
		await studio.shot(page, "import", { target: ".dialog", padding: 24, mark: ".dialog >> button[type=submit]" });
		await browser.click(".dialog >> button[type=submit]", 2500);
		if (await browser.exists(".dialog")) await browser.click(".dialog .icon-button");
	}
	await browser.choose(`${CONTENT} .ledger-controls select`, "last_year");
	await browser.wait(1800);
	await studio.shot(page, "list", { target: CONTENT });
	await browser.click(`button:${studio.t("recorded.new")}`, 1000);
	if (await browser.exists(".dialog")) {
		await unclamp(studio);
		await studio.shot(page, "new", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .icon-button", 600);
	}
}

async function assets(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "fixed-assets";
	await studio.open(projectPath(local, "/accounting/assets"), 2500);
	await browser.eval(
		`(() => { const select = document.querySelector("${CONTENT} .ledger-section select"); if (!select) return; select.value = "computer"; select.dispatchEvent(new Event("change", { bubbles: true })); })()`
	);
	await studio.shot(page, "candidates", { target: CONTENT, mark: `${CONTENT} .ledger-section button.primary` });
	await browser.click(`${CONTENT} .ledger-section button.primary`, 2500);
	await studio.open(projectPath(local, "/accounting/assets"), 2500);
	await studio.shot(page, "register", { target: CONTENT });
	await browser.click(`button:${studio.t("assets.new")}`, 1000);
	if (await browser.exists(".dialog")) {
		await studio.shot(page, "new", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .icon-button", 600);
	}
}

async function bank(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "bank-statements";
	const bankAccount = await accountOf(studio, local, "1100");
	const now = new Date();
	const ledger = await projectApi<{ closing: number }>(
		studio,
		local,
		"GET",
		`/accounting/ledger/${bankAccount.uuid}?from=${new Date(now.getFullYear(), 0, 1).getTime()}&to=${now.getTime()}`
	);
	await Bun.write(join(FILES, `statement-${studio.language}.xml`), statement(local, openInvoice(studio, local), ledger.closing));
	await studio.open(projectPath(local, "/accounting/bank"), 2500);
	await browser.click(`button:${studio.t("bank.import")}`, 1000);
	if (await browser.exists(".dialog")) {
		await browser.chooseFile(".dialog input[type=file]", join(FILES, `statement-${studio.language}.xml`));
		await browser.wait(1500);
		await studio.shot(page, "import", { target: ".dialog", padding: 24, mark: ".dialog >> button[type=submit]" });
		await browser.click(".dialog >> button[type=submit]", 2500);
		if (await browser.exists(".dialog")) await browser.click(".dialog .icon-button");
	}
	await studio.open(projectPath(local, "/accounting/bank"), 2500);
	await studio.shot(page, "lines", { target: CONTENT, mark: `button:${studio.t("bank.match_exact")}` });
	await browser.click(`button:${studio.t("bank.match_exact")}`, 2500);
	await studio.shot(page, "matched", { target: CONTENT });
	await browser.click(`${CONTENT} >> button:${studio.t("bank.book")}`, 1000);
	if (await browser.exists(".dialog")) {
		await chooseAccount(studio, ".dialog .account-select input", "4150");
		await browser.blur();
		await studio.shot(page, "book", { target: ".dialog", padding: 32, mark: ".dialog >> button[type=submit]" });
		await browser.click(".dialog >> button[type=submit]", 2500);
	}
	await browser.choose(`${CONTENT} .ledger-section-head select`, "all");
	await browser.wait(1800);
	await studio.shot(page, "all-lines", { target: CONTENT });
}

async function openItems(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "open-items";
	await studio.open(projectPath(local, "/accounting/open-items"), 2500);
	await browser.choose(`${CONTENT} .ledger-controls select`, "all");
	await browser.wait(1800);
	await browser.click(`${CONTENT} tbody tr:first-child >> button:${studio.t("open.items")}`, 600);
	await browser.eval(`document.querySelectorAll("${CONTENT} *").forEach((node) => { node.scrollLeft = 0; })`);
	await studio.shot(page, "list", { target: CONTENT });
	const date = new Date().toISOString().slice(0, 10);
	const report = await projectApi<{ partners: { key: string }[] }>(studio, local, "GET", `/accounting/open-items?date=${Date.now()}&kind=receivable`);
	const partner = report.partners[0]?.key;
	await studio.open(projectPath(local, `/accounting/open-items/print?date=${date}${partner ? `&partner=${encodeURIComponent(partner)}` : ""}`), 2500);
	await studio.shot(page, "iop", { full: true });
}

async function trialBalance(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "trial-balance";
	await studio.open(projectPath(local, "/accounting/trial-balance"), 2500);
	await browser.choose(`${CONTENT} .ledger-controls select`, "last_year");
	await browser.wait(1800);
	await studio.shot(page, "accounts", { target: CONTENT });
	await browser.eval(
		`(() => { const selects = document.querySelectorAll("${CONTENT} .ledger-controls select"); const level = selects[selects.length - 1]; level.value = "classes"; level.dispatchEvent(new Event("change", { bubbles: true })); })()`
	);
	await browser.wait(1500);
	await studio.shot(page, "classes", { target: CONTENT });
	const bankAccount = await accountOf(studio, local, "1100");
	await studio.open(projectPath(local, `/accounting/ledger/${bankAccount.uuid}`), 2500);
	await browser.choose(`${CONTENT} .ledger-controls select`, "last_year");
	await browser.wait(1800);
	await studio.shot(page, "account-card", { target: [`${CONTENT} .store-bar`, `${CONTENT} tbody tr:nth-child(12)`] });
}

async function kpo(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "kpo";
	await projectApi(studio, local, "PUT", "/accounting/settings", { bookkeeping: "sole_simplified" });
	try {
		await studio.open(projectPath(local, "/accounting/kpo"), 2500);
		await browser.choose(`${CONTENT} .ledger-controls select`, String(YEAR));
		await browser.wait(1800);
		await studio.shot(page, "book", { target: CONTENT });
	} finally {
		await projectApi(studio, local, "PUT", "/accounting/settings", { bookkeeping: "company" });
	}
}

async function years(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "year-end";
	await studio.open(projectPath(local, "/accounting/years"), 2500);
	await studio.shot(page, "years", { target: CONTENT, mark: `${CONTENT} >> button:${studio.t("years.close")}` });
	await browser.click(`${CONTENT} >> button:${studio.t("years.set_share")}`, 1000);
	if (await browser.exists(".dialog")) {
		await browser.fill(".dialog input[type=number]", "85");
		await browser.blur();
		await studio.shot(page, "share", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .icon-button", 600);
	}
	await browser.click(`${CONTENT} >> button:${studio.t("years.revalue")}`, 1200);
	if (await browser.exists(".dialog")) {
		await studio.shot(page, "revalue", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .icon-button", 600);
	}
	await browser.click(`${CONTENT} >> button:${studio.t("years.close")}`, 1000);
	if (await browser.exists(".dialog")) {
		await studio.shot(page, "close", { target: ".dialog", padding: 32 });
		await browser.click(`.dialog >> button:${studio.t("years.close")}`, 3000);
	}
	await studio.open(projectPath(local, "/accounting/years"), 2500);
	await studio.shot(page, "closed", { target: CONTENT });
	await browser.click(`${CONTENT} >> button:${studio.t("years.reopen")}`, 1000);
	if (await browser.exists(".dialog")) {
		await studio.shot(page, "reopen", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .icon-button", 600);
	}
}

async function statements(studio: Studio, session: Session) {
	const local = slovenianSession(session);
	await studio.open(projectPath(local, "/accounting/statements"), 3000);
	await studio.shot("financial-statements", "statements", { target: CONTENT });
	await studio.open(projectPath(local, "/accounting/ajpes"), 3000);
	await studio.shot("financial-statements", "ajpes", { target: CONTENT, mark: `button:${studio.t("ajpes.download")}` });
}

async function chart(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "chart-of-accounts";
	const words = text(studio);
	await studio.open(projectPath(local, "/accounting/accounts"), 2500);
	await studio.shot(page, "categories", { target: `${CONTENT} .ledger-section:first-of-type`, padding: 16 });
	await studio.shot(page, "accounts", {
		target: [`${CONTENT} .ledger-section:last-of-type h3`, `${CONTENT} .ledger-section:last-of-type tbody tr:nth-child(16)`],
	});
	await browser.click(`button:${studio.t("accounting.new_account")}`, 1000);
	if (await browser.exists(".dialog")) {
		await browser.fill(".dialog input[inputmode=numeric]", words.account.code);
		await browser.eval(`(() => { const node = document.querySelectorAll(".dialog input[type=text]")[1]; node.focus(); })()`);
		await browser.type(words.account.name);
		await browser.blur();
		await studio.shot(page, "new-account", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .icon-button", 600);
	}
}

async function clients(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "accounting-firms";
	await studio.open("/accounting", 2500);
	await studio.shot(page, "clients", { target: ".page" });
	await browser.click(`button:${studio.t("accounting.add_client")}`, 1000);
	if (await browser.exists(".dialog")) {
		await browser.fill(".dialog input[type=text]", text(studio).client.business);
		await browser.blur();
		await studio.shot(page, "add-client", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .icon-button", 600);
	}
	const local = slovenianSession(session);
	await studio.open(projectPath(local, "/accounting"), 2000);
	await studio.shot(page, "all-clients", { target: `${CONTENT} .store-bar`, padding: 12, mark: `${CONTENT} .store-bar a.button` });
}

export const accounting: Guide = {
	module: "accounting",
	steps: [
		["prepare", prepare],
		["start", start],
		["journal", journal],
		["recorded", recorded],
		["assets", assets],
		["bank", bank],
		["open-items", openItems],
		["trial-balance", trialBalance],
		["kpo", kpo],
		["years", years],
		["statements", statements],
		["chart", chart],
		["clients", clients],
	],
};
