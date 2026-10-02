import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.accounting.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { generateLicenseCode } = await import("../server/licensing");
const { issuePaidDrafts } = await import("../server/paid-drafts");
const { creditorReference } = await import("../server/payments/reference");
const { fillPaymentValues } = await import("../server/accounting/payment-values");

await Server.configure();

const password = new Bun.CryptoHasher("blake2b512").update("ledger-owner").digest("hex");
const YEAR = { from: Date.UTC(2025, 11, 31, 23), to: Date.UTC(2026, 11, 31, 23) - 1 };

let token = "";
let project = "";
let expense = "";
let paidInvoice = "";
let canceledInvoice = "";
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

async function issueInvoice(unitPrice: number, day: number): Promise<string> {
	const invoice = (
		await call("POST", `${base()}/invoices`, {
			currency: "EUR",
			due_date: Date.UTC(2026, 1, 28),
			supply_date: Date.UTC(2026, 0, day),
			items: [{ description: "Consulting", quantity: 1, unit_price: unitPrice, tax_rate: 22, tax_treatment: "domestic" }],
		})
	).data;
	expect((await call("POST", `${base()}/invoices/${invoice.uuid}/open`)).error).toBe(0);
	await Database`UPDATE invoices SET issued_at = ${Date.UTC(2026, 0, day)} WHERE uuid = ${invoice.uuid}`;
	return invoice.uuid;
}

async function trialBalance(): Promise<Record<string, { debit: number; credit: number; closing: number }>> {
	const result = await call("GET", `${base()}/accounting/trial-balance?from=${YEAR.from}&to=${YEAR.to}`);
	expect(result.error).toBe(0);
	return Object.fromEntries(result.data.accounts.map((row: any) => [row.code, row]));
}

async function accountId(code: string): Promise<string> {
	const accounts = (await call("GET", `${base()}/accounting/accounts`)).data.accounts as { uuid: string; code: string }[];
	return accounts.find((account) => account.code === code)!.uuid;
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await call("POST", "/api/v1/auth/register", { username: "ledger-owner", email: "ledger@example.com", password });
	token = (await call("POST", "/api/v1/auth/login", { username: "ledger-owner", password })).data.token;
	project = (await call("POST", "/api/v1/projects", { name: "ledger", currency: "EUR" })).data.uuid;
	await call("PATCH", base(), { tax_country: "SI", vat_status: "registered", tax_currency: "EUR" });
	await call("PUT", `${base()}/company`, {
		legal_name: "Knjige d.o.o.",
		address_line1: "Dunajska cesta 1",
		postal_code: "1000",
		city: "Ljubljana",
		country: "SI",
		tax_number: "12345678",
		vat_number: "SI12345678",
	});

	paidInvoice = await issueInvoice(10000, 10);
	const payment = await call("POST", `${base()}/transactions`, { invoice: paidInvoice, processor: "bank_transfer", amount: 12200 });
	expect(payment.error).toBe(0);
	await Database`UPDATE transactions SET completed_at = ${Date.UTC(2026, 0, 15)}, confirmed_at = ${Date.UTC(2026, 0, 15)} WHERE uuid = ${payment.data.uuid}`;

	canceledInvoice = await issueInvoice(5000, 11);
	expect((await call("POST", `${base()}/invoices/${canceledInvoice}/cancel`, { reason: "Duplicate" })).error).toBe(0);
	await Database`UPDATE credit_notes SET issued_at = ${Date.UTC(2026, 0, 12)} WHERE invoice = ${canceledInvoice}`;

	const created = await call("POST", `${base()}/expenses`, {
		description: "Server hosting",
		supplier: "Host d.o.o.",
		supplier_tax_number: "SI87654321",
		supplier_country: "SI",
		invoice_number: "HOST-1",
		category: "Hosting",
		currency: "EUR",
		total_amount: 6100,
		tax_amount: 1100,
		deductible_tax_amount: 1100,
		expense_date: Date.UTC(2026, 0, 20),
		issue_date: Date.UTC(2026, 0, 20),
		receipt_date: Date.UTC(2026, 0, 20),
		supply_date: Date.UTC(2026, 0, 20),
		vat_treatment: "domestic",
		asset_type: "expense",
		vat_handling: "1",
		self_assessment_period: null,
		self_assessment_tax: null,
		vat_lines: [{ rate: 22, tax_base: 5000, tax_amount: 1100, deductible_tax_amount: 1100 }],
		paid_at: Date.UTC(2026, 0, 25),
		notes: null,
	});
	expect(created.status).toBe(201);
	expense = created.data.uuid;
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-wal", "-shm"]) {
		try {
			unlinkSync(`${import.meta.dir}/.accounting.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("automatic posting", () => {
	test("posts invoices, payments, credit notes and expenses to the Slovenian chart of accounts", async () => {
		const accounts = await trialBalance();
		expect(accounts["7600"]).toMatchObject({ debit: 5000, credit: 15000, closing: 10000 });
		expect(accounts["2600"]).toMatchObject({ debit: 1100, credit: 3300, closing: 2200 });
		expect(accounts["1200"]).toMatchObject({ debit: 18300, credit: 18300, closing: 0 });
		expect(accounts["1100"]).toMatchObject({ debit: 12200, credit: 6100, closing: 6100 });
		expect(accounts["4191"]).toMatchObject({ debit: 5000, credit: 0, closing: 5000 });
		expect(accounts["1600"]).toMatchObject({ debit: 1100, closing: 1100 });
		expect(accounts["2200"]).toMatchObject({ debit: 6100, credit: 6100, closing: 0 });
	});

	test("every entry balances and is numbered in sequence within the year", async () => {
		const result = await call("GET", `${base()}/accounting/journal?from=${YEAR.from}&to=${YEAR.to}&limit=200`);
		expect(result.data.issues).toEqual([]);
		const entries = result.data.entries as { year: number; number: number; lines: { debit: number; credit: number }[] }[];
		expect(entries.length).toBe(6);
		entries.forEach((entry, index) => {
			expect(entry.year).toBe(2026);
			expect(entry.number).toBe(index + 1);
			const debit = entry.lines.reduce((sum, line) => sum + line.debit, 0);
			const credit = entry.lines.reduce((sum, line) => sum + line.credit, 0);
			expect(debit).toBe(credit);
		});
	});

	test("syncing again posts nothing new", async () => {
		const sync = await call("POST", `${base()}/accounting/sync`);
		expect(sync.data).toMatchObject({ posted: 0, reversed: 0 });
	});

	test("a changed document is corrected with a storno and a new entry, never by editing the old one", async () => {
		const before = (await Database`SELECT * FROM journal_entries WHERE source_id = ${expense} AND source_type = 'expense'`) as { uuid: string }[];
		expect((await call("PATCH", `${base()}/expenses/${expense}`, { category: "Marketing" })).error).toBe(0);
		const sync = await call("POST", `${base()}/accounting/sync`);
		expect(sync.data).toMatchObject({ posted: 1, reversed: 1 });

		const entries = (await Database`SELECT * FROM journal_entries WHERE source_id = ${expense} AND source_type = 'expense' ORDER BY number`) as {
			uuid: string;
			reverses: string | null;
			description: string;
		}[];
		expect(entries.length).toBe(3);
		expect(entries[0].uuid).toBe(before[0].uuid);
		expect(entries[1].reverses).toBe(before[0].uuid);
		expect(entries[1].description).toStartWith("Storno");

		const accounts = await trialBalance();
		expect(accounts["4191"]).toMatchObject({ debit: 5000, credit: 5000, closing: 0 });
		expect(accounts["4170"]).toMatchObject({ debit: 5000, closing: 5000 });
	});

	test("expense categories can be mapped to another account", async () => {
		const rent = await accountId("4130");
		expect((await call("PUT", `${base()}/accounting/category-accounts`, { category: "Marketing", account: rent })).error).toBe(1256);
	});
});

describe("manual entries", () => {
	test("need the accounting license, which only limits editing and never posting or reading", async () => {
		const cash = await accountId("1000");
		const capital = await accountId("9010");
		const refused = await call("POST", `${base()}/accounting/journal`, {
			date: Date.UTC(2026, 0, 2),
			description: "Opening cash",
			lines: [
				{ account: cash, debit: 50000 },
				{ account: capital, credit: 50000 },
			],
		});
		expect(refused.status).toBe(402);
		expect(refused.error).toBe(1256);
		expect((await call("GET", `${base()}/accounting/journal`)).error).toBe(0);

		const code = generateLicenseCode();
		const now = Date.now();
		await Database`INSERT INTO license_keys(uuid, code, type, duration_days, status, created, updated)
			VALUES(${crypto.randomUUID()}, ${code}, 'accounting', 365, 'available', ${now}, ${now})`;
		expect((await call("POST", `${base()}/license/redeem`, { code })).data.accounting).toBe(true);
	});

	test("must balance and use active accounts", async () => {
		const cash = await accountId("1000");
		const capital = await accountId("9010");
		const unbalanced = await call("POST", `${base()}/accounting/journal`, {
			date: Date.UTC(2026, 0, 2),
			description: "Opening cash",
			lines: [
				{ account: cash, debit: 50000 },
				{ account: capital, credit: 40000 },
			],
		});
		expect(unbalanced.error).toBe(1260);
		const both = await call("POST", `${base()}/accounting/journal`, {
			date: Date.UTC(2026, 0, 2),
			description: "Opening cash",
			lines: [
				{ account: cash, debit: 100, credit: 100 },
				{ account: capital, credit: 0, debit: 0 },
			],
		});
		expect(both.error).toBe(1260);
	});

	test("are posted and reversed with a storno", async () => {
		const cash = await accountId("1000");
		const capital = await accountId("9010");
		const posted = await call("POST", `${base()}/accounting/journal`, {
			date: Date.UTC(2026, 0, 2),
			description: "Opening cash",
			lines: [
				{ account: cash, debit: 50000 },
				{ account: capital, credit: 50000 },
			],
		});
		expect(posted.error).toBe(0);
		expect(posted.data.posted_by).toBe("ledger-owner");
		expect((await trialBalance())["1000"].closing).toBe(50000);

		const reversed = await call("POST", `${base()}/accounting/journal/${posted.data.uuid}/reverse`);
		expect(reversed.error).toBe(0);
		expect(reversed.data.reverses).toBe(posted.data.uuid);
		expect((await trialBalance())["1000"].closing).toBe(0);
		expect((await call("POST", `${base()}/accounting/journal/${posted.data.uuid}/reverse`)).error).toBe(1262);
		expect((await call("POST", `${base()}/accounting/journal/${reversed.data.uuid}/reverse`)).error).toBe(1262);

		const [automatic] = (await Database`SELECT uuid FROM journal_entries WHERE source_type = 'invoice' AND source_id = ${paidInvoice}`) as {
			uuid: string;
		}[];
		expect((await call("POST", `${base()}/accounting/journal/${automatic.uuid}/reverse`)).error).toBe(1262);
	});

	test("category mappings repost affected expenses", async () => {
		const rent = await accountId("4130");
		const mapped = await call("PUT", `${base()}/accounting/category-accounts`, { category: "Marketing", account: rent });
		expect(mapped.error).toBe(0);
		expect(mapped.data.sync).toMatchObject({ posted: 1, reversed: 1 });
		expect((await trialBalance())["4130"].closing).toBe(5000);
	});
});

describe("chart of accounts", () => {
	test("default expense categories post to their own accounts, with tax relevant costs kept apart", async () => {
		const accounts = (await call("GET", `${base()}/accounting/accounts`)).data.accounts as { uuid: string; code: string }[];
		const categories = (await call("GET", `${base()}/accounting/category-accounts`)).data.categories as { category: string; account: string }[];
		const codeOf = (category: string) => accounts.find((account) => account.uuid === categories.find((row) => row.category === category)!.account)!.code;
		expect(codeOf("Representation")).toBe("4175");
		expect(codeOf("Donations")).toBe("7540");
		expect(codeOf("Fines")).toBe("7520");
		expect(codeOf("Office supplies")).toBe("4060");
		expect(codeOf("Fuel")).toBe("4021");
		expect(codeOf("Phone and internet")).toBe("4192");
		expect(codeOf("Contract and student work")).toBe("4180");
		expect(codeOf("Taxes and fees")).toBe("4800");
		expect(codeOf("Salaries")).toBe("4700");
	});

	test("accepts new accounts inside a class of the chart and derives their kind", async () => {
		const created = await call("POST", `${base()}/accounting/accounts`, { code: "1103", name: "Denarna sredstva pri drugi banki" });
		expect(created.data).toMatchObject({ code: "1103", account_kind: "asset", active: true });
		expect((await call("POST", `${base()}/accounting/accounts`, { code: "1103", name: "Duplicate" })).error).toBe(1259);
		expect((await call("POST", `${base()}/accounting/accounts`, { code: "8000", name: "Result" })).error).toBe(1257);
		expect((await call("POST", `${base()}/accounting/accounts`, { code: "7600A", name: "Letters" })).error).toBe(1257);
	});

	test("off balance sheet accounts in group 99 are refused until they have their own kind", async () => {
		expect((await call("POST", `${base()}/accounting/accounts`, { code: "9900", name: "Zunajbilančni konto" })).error).toBe(1257);
	});

	test("a new system account moves to the next free code in its group when the user already took its code", async () => {
		await Database`DELETE FROM ledger_category_accounts WHERE project = ${project}`;
		const [fees] = (await Database`SELECT uuid FROM ledger_accounts WHERE project = ${project} AND system_key = 'payment_fees'`) as { uuid: string }[];
		await Database`UPDATE ledger_accounts SET system_key = NULL, name = 'Moji stroški' WHERE uuid = ${fees.uuid}`;
		const accounts = (await call("GET", `${base()}/accounting/accounts`)).data.accounts as { code: string; system_key: string | null }[];
		expect(accounts.find((account) => account.code === "4150")!.system_key).toBeNull();
		expect(accounts.find((account) => account.system_key === "payment_fees")!.code).toBe("4151");
		expect((await call("POST", `${base()}/accounting/sync`)).error).toBe(0);
	});

	test("system accounts cannot be deactivated", async () => {
		const bank = await accountId("1100");
		expect((await call("PATCH", `${base()}/accounting/accounts/${bank}`, { active: false })).error).toBe(1257);
		expect((await call("PATCH", `${base()}/accounting/accounts/${bank}`, { name: "Poslovni račun NLB" })).data.name).toBe("Poslovni račun NLB");
	});

	test("the account ledger shows a running balance", async () => {
		const ledger = await call("GET", `${base()}/accounting/ledger/${await accountId("1100")}?from=${YEAR.from}&to=${YEAR.to}`);
		expect(ledger.data.opening).toBe(0);
		expect(ledger.data.lines.map((line: { balance: number }) => line.balance)).toEqual([12200, 6100]);
		expect(ledger.data.closing).toBe(6100);
	});
});

describe("advance invoices", () => {
	test("advances go to 2300 with their VAT on 1950 and are cleared by the final invoice", async () => {
		const main = project;
		project = (await call("POST", "/api/v1/projects", { name: "ledger-advances", currency: "EUR" })).data.uuid;
		try {
			await call("PATCH", base(), { tax_country: "SI", vat_status: "registered", tax_currency: "EUR" });
			await call("PUT", `${base()}/company`, {
				legal_name: "Predujmi d.o.o.",
				address_line1: "Dunajska cesta 1",
				postal_code: "1000",
				city: "Ljubljana",
				country: "SI",
				tax_number: "12345678",
				vat_number: "SI12345678",
			});
			const draft = await call("POST", `${base()}/invoices`, {
				currency: "EUR",
				due_date: Date.now() + 15 * 86400000,
				supply_date: Date.now(),
				items: [{ description: "Website", quantity: 1, unit_price: 100000, tax_rate: 22, tax_treatment: "domestic" }],
			});
			const proforma = (await call("POST", `${base()}/invoices/${draft.data.uuid}/proforma`, { settlement: "advance" })).data;
			expect((await call("POST", `${base()}/transactions`, { invoice: proforma.uuid, processor: "bank_transfer", amount: 61000 })).error).toBe(0);
			await issuePaidDrafts();

			const range = "";
			const balances = async () =>
				Object.fromEntries(
					((await call("GET", `${base()}/accounting/trial-balance?${range}`)).data.accounts as { code: string; closing: number }[]).map((row) => [
						row.code,
						row.closing,
					])
				);
			let accounts = await balances();
			expect(accounts).toMatchObject({ "2300": 61000, "1950": 11000, "2600": 11000, "1100": 61000, "1200": 0 });
			expect(accounts["7600"]).toBeUndefined();

			expect((await call("POST", `${base()}/invoices/${proforma.uuid}/open`)).error).toBe(0);
			accounts = await balances();
			expect(accounts).toMatchObject({ "2300": 0, "1950": 0, "7600": 100000, "2600": 22000, "1200": 61000, "1100": 61000 });
		} finally {
			project = main;
		}
	});
});

describe("accounting firms", () => {
	test("an accountant member redeems accounting keys but no other license types, and sees clients in one overview", async () => {
		const owner = token;
		const accountantPassword = new Bun.CryptoHasher("blake2b512").update("ledger-accountant").digest("hex");
		await call("POST", "/api/v1/auth/register", { username: "ledger-accountant", email: "accountant@example.com", password: accountantPassword });
		const accountant = (await call("POST", "/api/v1/auth/login", { username: "ledger-accountant", password: accountantPassword })).data.token;
		const client = (await call("POST", "/api/v1/projects", { name: "ledger-client", currency: "EUR" })).data.uuid;
		const now = Date.now();
		await Database`
			INSERT INTO project_members(uuid, project_id, account_username, role, status, created, updated)
			VALUES(${crypto.randomUUID()}, ${client}, 'ledger-accountant', 'accountant', 'active', ${now}, ${now})
		`;
		const key = async (type: string) => {
			const code = generateLicenseCode();
			await Database`INSERT INTO license_keys(uuid, code, type, duration_days, status, created, updated)
				VALUES(${crypto.randomUUID()}, ${code}, ${type}, 30, 'available', ${now}, ${now})`;
			return code;
		};

		token = accountant;
		try {
			const path = `/api/v1/projects/${client}`;
			expect((await call("POST", `${path}/license/redeem`, { code: await key("accounting") })).error).toBe(9999);
			const store = await key("store");
			const refused = await call("POST", `${path}/accounting/license/redeem`, { code: store });
			expect(refused.status).toBe(403);
			expect(refused.error).toBe(1264);
			const [unused] = await Database`SELECT status FROM license_keys WHERE code = ${store}`;
			expect(unused.status).toBe("available");
			expect((await call("POST", `${path}/accounting/license/preview`, { code: store })).error).toBe(1264);

			const later = await key("accounting");
			const checked = await call("POST", `${path}/accounting/license/preview`, { code: later });
			expect(checked.data).toMatchObject({ type: "accounting", duration_days: 30, timed: true, adds_up: false, running_until: null });
			expect((await call("POST", `${path}/accounting/license/redeem`, { code: later, starts_at: "soon" })).error).toBe(1095);
			const scheduled = await call("POST", `${path}/accounting/license/redeem`, { code: later, starts_at: now + 400 * 86400000 });
			expect(scheduled.data).toMatchObject({ accounting: false, accounting_until: null, starts_at: now + 400 * 86400000 });

			const redeemed = await call("POST", `${path}/accounting/license/redeem`, { code: await key("accounting") });
			expect(redeemed.data.accounting).toBe(true);
			expect(redeemed.data.accounting_until).toBeGreaterThan(now + 29 * 86400000);

			const overview = await call("GET", "/api/v1/accounting/clients");
			expect(overview.data.clients).toHaveLength(1);
			expect(overview.data.clients[0]).toMatchObject({ uuid: client, role: "accountant", accounting: true, entries_this_year: 0 });
		} finally {
			token = owner;
		}
		const own = (await call("GET", "/api/v1/accounting/clients")).data.clients as { uuid: string }[];
		expect(own.map((row) => row.uuid)).toContain(project);
	});
});

describe("invoices issued in other systems", () => {
	const record = (overrides: Record<string, unknown> = {}) => ({
		reference: "2026-00017",
		buyer_name: "Stranka d.o.o.",
		buyer_vat_number: "SI11111111",
		buyer_country: "SI",
		issued_at: Date.UTC(2026, 0, 5),
		paid_at: Date.UTC(2026, 0, 20),
		payment_account: "cash",
		lines: [{ tax_rate: 22, tax_treatment: "domestic", net_amount: 20000, tax_amount: 4400 }],
		...overrides,
	});
	let recorded = "";

	test("are recorded with their original number and never become RabbitPay invoices", async () => {
		const created = await call("POST", `${base()}/recorded-invoices`, record());
		expect(created.status).toBe(201);
		expect(created.data).toMatchObject({ reference: "2026-00017", subtotal: 20000, tax_amount: 4400, total_amount: 24400, currency: "EUR" });
		recorded = created.data.uuid;
		const [invoices] = (await Database`SELECT COUNT(*) AS total FROM invoices WHERE reference = '2026-00017'`) as { total: number }[];
		expect(Number(invoices.total)).toBe(0);

		expect((await call("POST", `${base()}/recorded-invoices`, record())).error).toBe(1267);
		expect((await call("POST", `${base()}/recorded-invoices`, record({ reference: "X", lines: [] }))).error).toBe(1265);
		expect((await call("POST", `${base()}/recorded-invoices`, record({ reference: "X", currency: "USD" }))).error).toBe(1265);
	});

	test("post to revenue, VAT and the chosen money account", async () => {
		const accounts = await trialBalance();
		expect(accounts["7600"].credit).toBe(35000);
		expect(accounts["1000"].closing).toBe(24400);
		const credit = await call(
			"POST",
			`${base()}/recorded-invoices`,
			record({
				document_type: "credit_note",
				reference: "D-1",
				paid_at: null,
				lines: [{ tax_rate: 22, tax_treatment: "domestic", net_amount: 5000, tax_amount: 1100 }],
			})
		);
		expect(credit.status).toBe(201);
		const after = await trialBalance();
		expect(after["7600"].closing).toBe(10000 + 20000 - 5000);
		expect(after["1200"].closing).toBe(-6100);
	});

	test("appear in the DDV records and the VAT report", async () => {
		const range = { from: Date.UTC(2025, 11, 31, 23), to: Date.UTC(2026, 0, 31, 22, 59, 59, 999) };
		const flags = "refund=false&deductible_share=false&insolvency=false&tax_authority_order=false";
		const evidence = await call("GET", `${base()}/reports/ddv-evidence?from=${range.from}&to=${range.to}&${flags}`);
		expect(evidence.error).toBe(0);
		const kir = evidence.data.evidence.DDV_KIR_KPR.Lista_KIR.KIR as Record<string, string | number>[];
		expect(kir.find((row) => row.P3 === "2026-00017")).toMatchObject({ P7: 200, P14: 44 });
		expect(kir.find((row) => row.P3 === "D-1")).toMatchObject({ P7: -50, P14: -11 });
		expect(evidence.data.reconciliation.balanced).toBe(true);

		const vat = await call("POST", `${base()}/reports/vat?from=${range.from}&to=${range.to}`);
		expect(vat.error).toBe(0);
		expect(vat.data.domestic.find((row: { rate: number }) => row.rate === 22)).toMatchObject({ net: 15000 - 5000 + 20000 - 5000 });
	});

	test("changes are posted as a storno and a new entry, and deleting reverses the entries", async () => {
		const updated = await call("PATCH", `${base()}/recorded-invoices/${recorded}`, {
			lines: [{ tax_rate: 9.5, tax_treatment: "domestic", net_amount: 20000, tax_amount: 1900 }],
		});
		expect(updated.data).toMatchObject({ reference: "2026-00017", tax_amount: 1900, total_amount: 21900 });
		expect((await call("POST", `${base()}/accounting/sync`)).data).toMatchObject({ posted: 2, reversed: 2 });
		expect((await trialBalance())["1000"].closing).toBe(21900);

		expect((await call("DELETE", `${base()}/recorded-invoices/${recorded}`)).error).toBe(0);
		expect((await call("POST", `${base()}/accounting/sync`)).data).toMatchObject({ posted: 0, reversed: 2 });
		expect((await trialBalance())["1000"].closing).toBe(0);
	});
});

describe("importing invoices issued elsewhere from CSV", () => {
	const csv = [
		"Številka;Vrsta;Datum izdaje;Kupec;ID za DDV;Država;Stopnja DDV;Osnova;DDV;Plačano;Plačano na",
		"BL-101;račun;3.2.2026;Stranka d.o.o.;SI11111111;SI;22;1.000,00;220,00;5.2.2026;blagajna",
		"BL-101;račun;3.2.2026;Stranka d.o.o.;SI11111111;SI;9,5;200,00;19,00;5.2.2026;blagajna",
		'"BL-102";racun;2026-02-04;"Kupec; s podpičjem";;;22;50;11;;',
	].join("\n");

	test("the preview groups VAT lines into documents and reads Slovenian headers and number formats", async () => {
		const preview = await call("POST", `${base()}/recorded-invoices/import/preview`, { content: csv });
		expect(preview.data.errors).toEqual([]);
		expect(preview.data.documents).toHaveLength(2);
		const [first, second] = preview.data.documents;
		expect(first).toMatchObject({ rows: [2, 3], total_amount: 143900 });
		expect(first.input).toMatchObject({ reference: "BL-101", payment_account: "cash", buyer_country: "SI" });
		expect(first.input.lines).toEqual([
			{ tax_rate: 22, tax_treatment: "domestic", net_amount: 100000, tax_amount: 22000 },
			{ tax_rate: 9.5, tax_treatment: "domestic", net_amount: 20000, tax_amount: 1900 },
		]);
		expect(second.input).toMatchObject({ reference: "BL-102", buyer_name: "Kupec; s podpičjem", paid_at: null });
		const [count] = (await Database`SELECT COUNT(*) AS total FROM recorded_invoices WHERE reference LIKE 'BL-%'`) as { total: number }[];
		expect(Number(count.total)).toBe(0);
	});

	test("rows with errors are reported and nothing is imported until they are fixed", async () => {
		const broken = csv + "\nBL-103;račun;31.2.2026;Kupec;;;22;12,500;2,75;;\nBL-101;dobropis;2026-02-10;Stranka d.o.o.;;;22;10;2,2;;banka";
		const refused = await call("POST", `${base()}/recorded-invoices/import`, { content: broken });
		expect(refused.error).toBe(1265);
		expect(refused.data.errors).toEqual([
			{ row: 5, column: "issue_date", reference: "BL-103", code: "invalid_date" },
			{ row: 5, column: "net_amount", reference: "BL-103", code: "invalid_amount" },
		]);
		const [count] = (await Database`SELECT COUNT(*) AS total FROM recorded_invoices WHERE reference LIKE 'BL-%'`) as { total: number }[];
		expect(Number(count.total)).toBe(0);

		const missing = await call("POST", `${base()}/recorded-invoices/import/preview`, { content: "Številka;Kupec\nX;Y" });
		expect(missing.data.errors.map((error: { column: string }) => error.column)).toEqual(["issue_date", "vat_rate", "net_amount", "vat_amount"]);
	});

	test("a valid file is imported at once, posted, and cannot be imported twice", async () => {
		const imported = await call("POST", `${base()}/recorded-invoices/import`, { content: csv });
		expect(imported.status).toBe(201);
		expect(imported.data.imported).toBe(2);
		const again = await call("POST", `${base()}/recorded-invoices/import/preview`, { content: csv });
		expect(again.data.documents).toHaveLength(0);
		expect(again.data.errors.map((error: { code: string }) => error.code)).toEqual(["already_recorded", "already_recorded"]);
		expect((await trialBalance())["1000"].closing).toBe(143900);
	});
});

function camt(entries: string[]): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
	<BkToCstmrStmt>
		<GrpHdr><MsgId>MSG-1</MsgId><CreDtTm>2026-03-31T18:00:00</CreDtTm></GrpHdr>
		<Stmt>
			<Id>2026-03-001</Id>
			<Acct><Id><IBAN>SI56 0201 0001 2345 678</IBAN></Id><Ccy>EUR</Ccy></Acct>
			<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">0.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-03-01</Dt></Dt></Bal>
			<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1245.50</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-03-31</Dt></Dt></Bal>
			${entries.join("\n")}
		</Stmt>
	</BkToCstmrStmt>
</Document>`;
}

function entry(amount: string, indicator: "CRDT" | "DBIT", day: string, reference: string, party: string, remittance: string, ref = ""): string {
	const role = indicator === "CRDT" ? "Dbtr" : "Cdtr";
	return `<Ntry><Amt Ccy="EUR">${amount}</Amt><CdtDbtInd>${indicator}</CdtDbtInd><Sts>BOOK</Sts>
		<BookgDt><Dt>${day}</Dt></BookgDt><ValDt><Dt>${day}</Dt></ValDt><AcctSvcrRef>${reference}</AcctSvcrRef>
		<NtryDtls><TxDtls><RltdPties><${role}><Nm>${party}</Nm></${role}></RltdPties>
		<RmtInf><Ustrd>${remittance}</Ustrd>${ref ? `<Strd><CdtrRefInf><Ref>${ref}</Ref></CdtrRefInf></Strd>` : ""}</RmtInf></TxDtls></NtryDtls></Ntry>`;
}

describe("bank statements", () => {
	let invoice = "";
	let invoiceReference = "";
	let telekom = "";
	let file = "";

	test("a camt.053 statement is previewed and imported once", async () => {
		invoice = await issueInvoice(100000, 1);
		await Database`UPDATE invoices SET issued_at = ${Date.UTC(2026, 2, 1)} WHERE uuid = ${invoice}`;
		invoiceReference = ((await Database`SELECT reference FROM invoices WHERE uuid = ${invoice}`) as { reference: string }[])[0].reference;
		telekom = (
			await call("POST", `${base()}/expenses`, {
				description: "Internet",
				supplier: "Telekom Slovenije d.d.",
				invoice_number: "T-9",
				category: "Utilities",
				currency: "EUR",
				total_amount: 3050,
				tax_amount: 0,
				deductible_tax_amount: 0,
				expense_date: Date.UTC(2026, 2, 3),
			})
		).data.uuid;
		file = Buffer.from(
			camt([
				entry("1220.00", "CRDT", "2026-03-10", "B-1", "Stranka d.o.o.", `Placilo racuna ${invoiceReference}`, creditorReference(invoiceReference)!),
				entry("61.00", "CRDT", "2026-03-11", "B-2", "Kupec", "Racun BL-102"),
				entry("30.50", "DBIT", "2026-03-12", "B-3", "Telekom Slovenije d.d.", "Racun T-9"),
				entry("5.00", "DBIT", "2026-03-31", "B-4", "Banka", "Provizija za vodenje racuna"),
			])
		).toString("base64");

		const preview = await call("POST", `${base()}/accounting/bank-statements/preview`, { name: "marec.xml", data: file });
		expect(preview.data).toMatchObject({ new_lines: 4, known_lines: 0 });
		expect(preview.data.statements[0]).toMatchObject({ iban: "SI56020100012345678", statement_id: "2026-03-001", opening_balance: 0, closing_balance: 124550 });

		const imported = await call("POST", `${base()}/accounting/bank-statements`, { name: "marec.xml", data: file });
		expect(imported.data).toMatchObject({ statements: 1, imported: 4, skipped: 0 });
		expect((await call("POST", `${base()}/accounting/bank-statements`, { name: "marec.xml", data: file })).data).toMatchObject({ imported: 0, skipped: 4 });
		expect((await call("POST", `${base()}/accounting/bank-statements`, { name: "bad.xml", data: Buffer.from("<x/>").toString("base64") })).error).toBe(1268);
	});

	test("open lines come with suggestions and exact ones are matched in one step", async () => {
		const open = await call("GET", `${base()}/accounting/bank-transactions?status=open`);
		expect(open.data.total).toBe(4);
		const byReference = Object.fromEntries(open.data.transactions.map((row: { bank_reference: string }) => [row.bank_reference, row]));
		expect(byReference["B-1"].suggestions[0]).toMatchObject({ type: "invoice", id: invoice, exact: true, amount: 122000 });
		expect(byReference["B-2"].suggestions[0]).toMatchObject({ type: "recorded_invoice", reference: "BL-102", exact: true });
		expect(byReference["B-3"].suggestions[0]).toMatchObject({ type: "expense", id: telekom, exact: true });
		expect(byReference["B-4"].suggestions).toEqual([]);

		expect((await call("POST", `${base()}/accounting/bank-transactions/match-exact`)).data.matched).toBe(3);
		const [payment] = (await Database`SELECT completed_at, processor FROM transactions WHERE invoice = ${invoice}`) as {
			completed_at: number;
			processor: string;
		}[];
		expect(payment).toMatchObject({ processor: "bank_transfer", completed_at: Date.UTC(2026, 2, 9, 23) });
		const [expense] = (await Database`SELECT paid_at FROM expenses WHERE uuid = ${telekom}`) as { paid_at: number }[];
		expect(expense.paid_at).toBe(Date.UTC(2026, 2, 11, 23));
	});

	test("other lines are booked to an account, and matches can be reopened except invoice payments", async () => {
		const fee = (await call("GET", `${base()}/accounting/bank-transactions?status=open`)).data.transactions[0];
		expect(fee.bank_reference).toBe("B-4");
		const before = (await trialBalance())["4150"]?.closing ?? 0;
		const booked = await call("POST", `${base()}/accounting/bank-transactions/${fee.uuid}/book`, { account: await accountId("4150") });
		expect(booked.data.status).toBe("booked");
		expect((await trialBalance())["4150"].closing).toBe(before + 500);

		const reopened = await call("POST", `${base()}/accounting/bank-transactions/${fee.uuid}/reopen`);
		expect(reopened.data.status).toBe("open");
		expect((await trialBalance())["4150"].closing).toBe(before);

		const matched = (await call("GET", `${base()}/accounting/bank-transactions?status=matched`)).data.transactions as { uuid: string; match_type: string }[];
		const invoiceLine = matched.find((row) => row.match_type === "invoice")!;
		const expenseLine = matched.find((row) => row.match_type === "expense")!;
		expect((await call("POST", `${base()}/accounting/bank-transactions/${invoiceLine.uuid}/reopen`)).error).toBe(1271);
		expect((await call("POST", `${base()}/accounting/bank-transactions/${expenseLine.uuid}/reopen`)).data.status).toBe("open");
		const [expense] = (await Database`SELECT paid_at FROM expenses WHERE uuid = ${telekom}`) as { paid_at: number | null }[];
		expect(expense.paid_at).toBeNull();
		expect((await call("POST", `${base()}/accounting/bank-transactions/${expenseLine.uuid}/match`, { type: "invoice", id: invoice })).error).toBe(1270);
	});
});

describe("several bank accounts", () => {
	test("a statement from another IBAN gets the next free account in group 110 and its lines post there", async () => {
		const xml = camt([entry("12.00", "DBIT", "2026-03-20", "S-1", "SKB", "Nadomestilo za vodenje")])
			.replace("<Id>2026-03-001</Id>", "<Id>SKB-03</Id>")
			.replace("SI56 0201 0001 2345 678", "SI56 0310 0100 0000 123");
		expect((await call("POST", `${base()}/accounting/bank-statements`, { name: "skb.xml", data: Buffer.from(xml).toString("base64") })).data.imported).toBe(1);
		const accounts = (await call("GET", `${base()}/accounting/accounts`)).data.accounts as { code: string; iban: string | null; system_key: string | null }[];
		expect(accounts.find((account) => account.system_key === "bank")!.iban).toBe("SI56020100012345678");
		const skb = accounts.find((account) => account.iban === "SI56031001000000123")!;
		expect(skb.code).toBe("1104");

		const line = (
			(await call("GET", `${base()}/accounting/bank-transactions?status=open`)).data.transactions as { uuid: string; bank_reference: string }[]
		).find((row) => row.bank_reference === "S-1")!;
		expect((await call("POST", `${base()}/accounting/bank-transactions/${line.uuid}/book`, { account: await accountId("1104") })).error).toBe(1270);
		expect((await call("POST", `${base()}/accounting/bank-transactions/${line.uuid}/book`, { account: await accountId("4150") })).error).toBe(0);
		expect((await trialBalance())["1104"]).toMatchObject({ credit: 1200, closing: -1200 });
		const statements = (await call("GET", `${base()}/accounting/bank-statements`)).data.statements as { statement_id: string; ledger_balance: number }[];
		expect(statements.find((statement) => statement.statement_id === "SKB-03")!.ledger_balance).toBe(-1200);
	});
});

describe("originals of invoices issued elsewhere", () => {
	test("a scan or PDF larger than the usual request limit is attached, downloaded and counted as storage", async () => {
		const [record] = (await Database`SELECT uuid FROM recorded_invoices WHERE reference = 'BL-101'`) as { uuid: string }[];
		const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(400 * 1024, 7)]);
		const before = (await call("GET", `${base()}/license`)).data.storage_used;
		const attached = await call("PUT", `${base()}/recorded-invoices/${record.uuid}/attachment`, {
			name: "BL-101.pdf",
			type: "application/pdf",
			data: pdf.toString("base64"),
		});
		expect(attached.status).toBe(200);
		expect(attached.data).toMatchObject({ file_name: "BL-101.pdf", byte_size: pdf.length });
		expect((await call("GET", `${base()}/license`)).data.storage_used).toBe(before + pdf.length);

		const list = await call("GET", `${base()}/recorded-invoices?limit=200`);
		expect(list.data.recorded_invoices.find((row: { uuid: string }) => row.uuid === record.uuid).attachment).toMatchObject({ file_name: "BL-101.pdf" });

		const response = await Server.app.handle(
			new Request(`http://localhost${base()}/recorded-invoices/${record.uuid}/attachment`, { headers: { Authorization: `Bearer ${token}` } })
		);
		expect(response.headers.get("content-type")).toBe("application/pdf");
		expect(Buffer.from(await response.arrayBuffer()).equals(pdf)).toBe(true);

		const refused = await call("PUT", `${base()}/recorded-invoices/${record.uuid}/attachment`, {
			name: "x.exe",
			type: "application/x-msdownload",
			data: "AAAA",
		});
		expect(refused.error).toBe(1272);
		expect((await call("DELETE", `${base()}/recorded-invoices/${record.uuid}/attachment`)).error).toBe(0);
		expect((await call("GET", `${base()}/license`)).data.storage_used).toBe(before);
	});
});

describe("closing the business year", () => {
	test("closing posts the result, the closing sheet and the opening sheet, locks the year and can be reopened", async () => {
		const main = project;
		project = (await call("POST", "/api/v1/projects", { name: "ledger-years", currency: "EUR" })).data.uuid;
		try {
			await call("PATCH", base(), { tax_country: "SI", vat_status: "registered", tax_currency: "EUR" });
			await call("PUT", `${base()}/company`, {
				legal_name: "Leto d.o.o.",
				address_line1: "Dunajska cesta 1",
				postal_code: "1000",
				city: "Ljubljana",
				country: "SI",
				tax_number: "12345678",
				vat_number: "SI12345678",
			});
			const code = generateLicenseCode();
			const now = Date.now();
			await Database`INSERT INTO license_keys(uuid, code, type, duration_days, status, created, updated)
				VALUES(${crypto.randomUUID()}, ${code}, 'accounting', 365, 'available', ${now}, ${now})`;
			await call("POST", `${base()}/license/redeem`, { code });

			const sale = await issueInvoice(100000, 1);
			await Database`UPDATE invoices SET issued_at = ${Date.UTC(2025, 5, 1)} WHERE uuid = ${sale}`;
			const paid = await call("POST", `${base()}/transactions`, { invoice: sale, processor: "bank_transfer", amount: 122000 });
			await Database`UPDATE transactions SET completed_at = ${Date.UTC(2025, 5, 10)}, confirmed_at = ${Date.UTC(2025, 5, 10)} WHERE uuid = ${paid.data.uuid}`;
			const rent = await call("POST", `${base()}/expenses`, {
				description: "Najem",
				category: "Rent",
				currency: "EUR",
				total_amount: 12200,
				tax_amount: 2200,
				deductible_tax_amount: 2200,
				expense_date: Date.UTC(2025, 6, 1),
			});
			const capital = await call("POST", `${base()}/accounting/journal`, {
				date: Date.UTC(2025, 0, 2),
				description: "Ustanovitveni vložek",
				lines: [
					{ account: await accountId("1000"), debit: 50000 },
					{ account: await accountId("9010"), credit: 50000 },
				],
			});
			expect(capital.error).toBe(0);

			const line = (lines: { id: string; amount: number; previous: number }[], id: string) => lines.find((row) => row.id === id)!;
			const open = (await call("GET", `${base()}/accounting/statements?year=2025`)).data;
			expect(open.balance_sheet).toMatchObject({ total_assets: 174200, total_sources: 174200, balanced: true, unmapped: [] });
			expect(line(open.balance_sheet.sources, "A.VII").amount).toBe(90000);
			expect(line(open.income_statement.lines, "1").amount).toBe(100000);
			expect(line(open.income_statement.lines, "5.b").amount).toBe(10000);
			expect(open.income_statement).toMatchObject({ result: 90000, reconciled: true, unmapped: [] });

			expect((await call("POST", `${base()}/accounting/years/2026/close`)).data.reason).toBe("year_not_over");
			const closed = await call("POST", `${base()}/accounting/years/2025/close`);
			expect(closed.error).toBe(0);
			expect(closed.data).toMatchObject({ year: 2025, closed: true, result: 90000 });
			expect((await call("POST", `${base()}/accounting/years/2025/close`)).data.reason).toBe("already_closed");

			const range = (year: number) => `from=${Date.UTC(year - 1, 11, 31, 23)}&to=${Date.UTC(year, 11, 31, 22, 59, 59, 999)}`;
			const balances = async (year: number) =>
				Object.fromEntries(
					((await call("GET", `${base()}/accounting/trial-balance?${range(year)}`)).data.accounts as { code: string; opening: number }[]).map((row) => [
						row.code,
						row,
					])
				);
			const last = await balances(2025);
			expect(last["7600"]).toMatchObject({ credit: 100000, closing: 100000 });
			expect(last["4130"]).toMatchObject({ closing: 10000 });
			expect(last["1100"]).toMatchObject({ closing: 122000 });
			expect(last["9320"]).toBeUndefined();

			const next = await balances(2026);
			expect(next["1100"]).toMatchObject({ opening: 122000, debit: 0, credit: 0, closing: 122000 });
			expect(next["9300"]).toMatchObject({ opening: 90000 });
			expect(next["2200"]).toMatchObject({ opening: 12200 });
			expect(next["7600"]).toBeUndefined();

			const closedStatements = (await call("GET", `${base()}/accounting/statements?year=2025`)).data;
			expect(closedStatements.balance_sheet).toMatchObject({ total_assets: 174200, balanced: true });
			expect(line(closedStatements.balance_sheet.assets, "B.V").amount).toBe(172000);
			expect(line(closedStatements.balance_sheet.sources, "A.VII").amount).toBe(90000);
			expect(line(closedStatements.balance_sheet.sources, "Č.III").amount).toBe(34200);
			expect(closedStatements.income_statement.result).toBe(90000);
			const ajpes = (await call("GET", `${base()}/accounting/ajpes?year=2025`)).data;
			const aop = (lines: { aop: string; current: number }[]) => Object.fromEntries(lines.map((row) => [row.aop, row.current]));
			expect(ajpes).toMatchObject({ form: "company", balanced: true });
			expect(aop(ajpes.balance_sheet)).toMatchObject({
				"001": 174200,
				"032": 174200,
				"048": 2200,
				"051": 2200,
				"052": 172000,
				"055": 174200,
				"056": 140000,
				"058": 50000,
				"070": 90000,
				"071": 0,
				"085": 34200,
				"093": 12200,
				"094": 22000,
			});
			expect(aop(ajpes.income_statement)).toMatchObject({
				"110": 100000,
				"112": 100000,
				"126": 100000,
				"127": 10000,
				"134": 10000,
				"136": 10000,
				"151": 90000,
				"182": 90000,
				"186": 90000,
				"187": 0,
			});
			const download = async () =>
				await Server.app.handle(new Request(`http://localhost${base()}/accounting/ajpes/export?year=2025`, { headers: { Authorization: `Bearer ${token}` } }));
			expect(((await (await download()).json()) as { error: number }).error).toBe(1278);
			await Database`UPDATE project_company SET registration_number = '1234567000' WHERE project = ${project}`;
			const xml = await (await download()).text();
			expect(xml).toContain('<Osnovni_podatki vrstaPoslovnegaSubjekta="GD">');
			expect(xml).toContain("<OSN_Maticna_stevilka>1234567000</OSN_Maticna_stevilka>");
			expect(xml).toContain("<OSN_Davcna_stevilka>12345678</OSN_Davcna_stevilka>");
			expect(xml).toContain('<AOP ID="186">\n\t\t\t<PODATEK TIP="T">900.00</PODATEK>');
			const kpo = (await call("GET", `${base()}/accounting/kpo?year=2025`)).data;
			expect(kpo).toMatchObject({ revenue: 100000, expenses: 10000, result: 90000 });
			expect(kpo.totals).toMatchObject({ revenue_sales: 100000, services: 10000, labor: 0 });
			expect(kpo.rows.map((row: { sequence: number; amounts: object }) => [row.sequence, row.amounts])).toEqual([
				[1, { revenue_sales: 100000 }],
				[2, { services: 10000 }],
			]);
			const following = (await call("GET", `${base()}/accounting/statements?year=2026`)).data;
			expect(line(following.balance_sheet.sources, "A.VI")).toMatchObject({ amount: 90000, previous: 0 });
			expect(line(following.balance_sheet.sources, "A.VII")).toMatchObject({ amount: 0, previous: 90000 });
			expect(following.balance_sheet).toMatchObject({ total_assets: 174200, previous_total_assets: 174200, balanced: true });
			expect(following.income_statement).toMatchObject({ result: 0, previous_result: 90000 });

			expect((await call("PATCH", `${base()}/expenses/${rent.data.uuid}`, { description: "Changed" })).error).toBe(1128);
			const late = await call("POST", `${base()}/accounting/journal`, {
				date: Date.UTC(2025, 11, 30),
				description: "Late",
				lines: [
					{ account: await accountId("1000"), debit: 100 },
					{ account: await accountId("9010"), credit: 100 },
				],
			});
			expect(late.error).toBe(1275);

			expect((await call("POST", `${base()}/accounting/years/2025/reopen`, { reason: "" })).error).toBe(1274);
			const reopened = await call("POST", `${base()}/accounting/years/2025/reopen`, { reason: "Popravek najemnine" });
			expect(reopened.data).toMatchObject({ year: 2025, closed: false });
			const reopenedNext = await balances(2026);
			expect(reopenedNext["1100"]).toMatchObject({ opening: 122000 });
			expect(reopenedNext["9300"]?.opening ?? 0).toBe(0);
			expect((await call("PATCH", `${base()}/expenses/${rent.data.uuid}`, { description: "Changed" })).error).toBe(0);
			expect((await call("POST", `${base()}/accounting/years/2025/close`)).data).toMatchObject({ closed: true, result: 90000 });
		} finally {
			project = main;
		}
	});
});

describe("fixed assets", () => {
	test("an asset bought as an expense is registered, depreciated monthly and written off when disposed", async () => {
		const laptop = await call("POST", `${base()}/expenses`, {
			description: "Prenosnik",
			category: "Equipment",
			currency: "EUR",
			total_amount: 146400,
			tax_amount: 26400,
			deductible_tax_amount: 26400,
			expense_date: Date.UTC(2026, 0, 15),
			asset_type: "fixed_asset",
		});
		expect(laptop.status).toBe(201);
		const listed = await call("GET", `${base()}/accounting/assets`);
		const candidate = listed.data.candidates.find((row: { expense: string }) => row.expense === laptop.data.uuid);
		expect(candidate).toMatchObject({ value: 120000, categories: ["equipment", "computer"] });

		expect((await call("POST", `${base()}/accounting/assets`, { expense: laptop.data.uuid, asset_category: "building" })).error).toBe(1276);
		const created = await call("POST", `${base()}/accounting/assets`, { expense: laptop.data.uuid, asset_category: "computer" });
		expect(created.status).toBe(201);
		expect(created.data).toMatchObject({ name: "Prenosnik", acquisition_value: 120000, annual_rate: 50, depreciation_from: Date.UTC(2026, 0, 31, 23) });
		expect((await call("POST", `${base()}/accounting/assets`, { expense: laptop.data.uuid, asset_category: "computer" })).error).toBe(1276);

		const [months] = (await Database`SELECT COUNT(*) AS total FROM journal_entries WHERE project = ${project} AND source_type = 'depreciation'`) as {
			total: number;
		}[];
		const today = new Date();
		const elapsed = Math.min(24, (today.getUTCFullYear() - 2026) * 12 + today.getUTCMonth() - 1);
		const thisYear = Math.min(elapsed, 11);
		expect(Number(months.total)).toBe(elapsed);
		const accounts = await trialBalance();
		expect(accounts["4320"].closing).toBe(thisYear * 5000);
		expect(accounts["0500"].closing).toBe(-thisYear * 5000);
		expect(created.data).toMatchObject({ accumulated: elapsed * 5000, book_value: 120000 - elapsed * 5000 });

		const disposed = await call("PATCH", `${base()}/accounting/assets/${created.data.uuid}`, { disposed_at: Date.UTC(2026, 5, 20) });
		expect(disposed.data).toMatchObject({ accumulated: 20000, book_value: 0 });
		const after = await trialBalance();
		expect(after["4320"].closing).toBe(20000);
		expect(after["0500"].closing).toBe(0);
		expect(after["7200"].closing).toBe(100000);
		expect((await call("DELETE", `${base()}/accounting/assets/${created.data.uuid}`)).error).toBe(0);
		expect((await trialBalance())["4320"]?.closing ?? 0).toBe(0);
	});
});

describe("payroll", () => {
	test("a finalized payroll run posts salary costs and the liabilities for net pay, tax, contributions and deductions", async () => {
		const run = crypto.randomUUID();
		const now = Date.now();
		await Database`INSERT INTO payroll_runs(uuid, project, period, status, created, updated) VALUES(${run}, ${project}, '2026-04', 'final', ${now}, ${now})`;
		const calculation = {
			person: "Ana Novak",
			net: {
				gross: 200000,
				net: 131864,
				income_tax: 20000,
				employer_contributions_total: 32200,
				employer_contributions: { pension: 17700, health: 13100, injury: 1060, unemployment: 120, parental: 200, long_term_care: 20 },
				health_flat: 3936,
				employee_contributions_total: 44200,
			},
			regres: null,
			performance: null,
			reimbursements: 10000,
			deductions: 5000,
			payout: 136864,
		};
		await Database`INSERT INTO payroll_lines(uuid, run, person, items, calculation, created, updated)
			VALUES(${crypto.randomUUID()}, ${run}, 'Ana Novak', '[]', ${JSON.stringify(calculation)}, ${now}, ${now})`;
		expect((await call("POST", `${base()}/accounting/sync`)).error).toBe(0);
		const [entry] = (await Database`SELECT entry_date, description FROM journal_entries WHERE source_type = 'payroll' AND source_id = ${run}`) as {
			entry_date: number;
			description: string;
		}[];
		expect(entry).toMatchObject({ entry_date: Date.UTC(2026, 3, 29, 22), description: "Obračun plač 04/2026" });
		const accounts = await trialBalance();
		expect(accounts["4700"].closing).toBe(200000);
		expect(accounts["4730"].closing).toBe(10000);
		expect(accounts["4741"].closing).toBe(17700);
		expect(accounts["4740"].closing).toBe(32200 - 17700);
		expect(accounts["2510"].closing).toBe(136864);
		expect(accounts["2530"].closing).toBe(48136);
		expect(accounts["2540"].closing).toBe(20000);
		expect(accounts["2520"].closing).toBe(32200);
		expect(accounts["2820"].closing).toBe(5000);
	});

	test("a salary expense in a month with a finalized payroll run is posted but flagged as a possible double count", async () => {
		const salary = (day: number, month: number) =>
			call("POST", `${base()}/expenses`, {
				description: `Plače ${month}`,
				supplier: "Računovodstvo d.o.o.",
				category: "Salaries",
				currency: "EUR",
				total_amount: 50000,
				tax_amount: 0,
				deductible_tax_amount: 0,
				expense_date: Date.UTC(2026, month - 1, day),
				vat_treatment: "not_reported",
				asset_type: "expense",
				vat_handling: "1",
				self_assessment_period: null,
				self_assessment_tax: null,
				vat_lines: [],
				paid_at: null,
				notes: null,
			});
		const april = (await salary(15, 4)).data.uuid as string;
		const may = (await salary(15, 5)).data.uuid as string;
		const sync = await call("POST", `${base()}/accounting/sync`);
		const flagged = (sync.data.issues as { source_id: string; code: string }[]).filter((issue) => issue.code === "payroll_overlap");
		expect(flagged.map((issue) => issue.source_id)).toEqual([april]);
		expect((await trialBalance())["4700"].closing).toBe(300000);

		for (const uuid of [april, may]) expect((await call("DELETE", `${base()}/expenses/${uuid}`)).error).toBe(0);
		const after = await call("POST", `${base()}/accounting/sync`);
		expect((after.data.issues as { code: string }[]).some((issue) => issue.code === "payroll_overlap")).toBe(false);
	});
});

describe("sole traders", () => {
	test("the income of a sole trader is closed to 9350 and carried with household flows into the owner's capital", async () => {
		const main = project;
		project = (await call("POST", "/api/v1/projects", { name: "ledger-sp", currency: "EUR" })).data.uuid;
		try {
			await call("PATCH", base(), { tax_country: "SI", vat_status: "registered", tax_currency: "EUR" });
			await Database`UPDATE projects SET accounting_until = ${Date.now() + 86400000 * 30} WHERE uuid = ${project}`;
			expect((await call("PUT", `${base()}/accounting/settings`, { bookkeeping: "sole_simplified" })).data.bookkeeping).toBe("sole_simplified");
			expect((await call("PUT", `${base()}/accounting/settings`, { bookkeeping: "partnership" })).error).toBe(1257);
			const post = async (description: string, debit: string, credit: string, amount: number) =>
				expect(
					(
						await call("POST", `${base()}/accounting/journal`, {
							date: Date.UTC(2025, 1, 1),
							description,
							lines: [
								{ account: await accountId(debit), debit: amount },
								{ account: await accountId(credit), credit: amount },
							],
						})
					).error
				).toBe(0);
			await post("Začetni kapital", "1100", "9020", 100000);
			await post("Dvig za gospodinjstvo", "9190", "1100", 20000);
			expect(
				(
					await call("POST", `${base()}/recorded-invoices`, {
						reference: "SP-1",
						buyer_name: "Kupec",
						issued_at: Date.UTC(2025, 2, 1),
						paid_at: Date.UTC(2025, 2, 5),
						lines: [{ tax_rate: 22, tax_treatment: "domestic", net_amount: 500000, tax_amount: 110000 }],
					})
				).status
			).toBe(201);
			expect((await call("POST", `${base()}/accounting/years/2025/close`)).data).toMatchObject({ closed: true, result: 500000 });
			const range = `from=${Date.UTC(2025, 11, 31, 23)}&to=${Date.UTC(2026, 11, 31, 22, 59, 59, 999)}`;
			const next = Object.fromEntries(
				((await call("GET", `${base()}/accounting/trial-balance?${range}`)).data.accounts as { code: string; opening: number }[]).map((row) => [row.code, row])
			);
			expect(next["9020"]).toMatchObject({ opening: 580000 });
			expect(next["9350"]).toBeUndefined();
			expect(next["9190"]).toBeUndefined();
			const statements = (await call("GET", `${base()}/accounting/statements?year=2026`)).data;
			expect(statements.balance_sheet.sources.find((line: { id: string }) => line.id === "A")).toMatchObject({ label: "Podjetnikov kapital", amount: 580000 });
			expect(statements.balance_sheet.balanced).toBe(true);
			const ajpes = (await call("GET", `${base()}/accounting/ajpes?year=2026`)).data;
			const lines = Object.fromEntries(
				(ajpes.balance_sheet as { aop: string; current: number; previous: number; label: string }[]).map((row) => [row.aop, row])
			);
			expect(ajpes).toMatchObject({ form: "sole_trader", balanced: true });
			expect(lines["056"]).toMatchObject({ label: "A. PODJETNIKOV KAPITAL", current: 580000 });
			expect(lines["058"]).toMatchObject({ current: 580000, previous: 80000 });
			expect(lines["070"]).toMatchObject({ current: 0, previous: 500000 });
			expect(lines["005"]).toBeUndefined();
			expect(lines["068"]).toBeUndefined();
			expect(Object.fromEntries((ajpes.income_statement as { aop: string; previous: number }[]).map((row) => [row.aop, row.previous]))["182"]).toBe(500000);
		} finally {
			project = main;
		}
	});
});

describe("exchange differences", () => {
	test("a foreign currency payment is valued on its own date and the difference goes to financial revenue or expenses", async () => {
		const main = project;
		project = (await call("POST", "/api/v1/projects", { name: "ledger-fx", currency: "EUR" })).data.uuid;
		try {
			await call("PATCH", base(), { tax_country: "SI", vat_status: "registered", tax_currency: "EUR" });
			await call("PUT", `${base()}/company`, {
				legal_name: "Tečaj d.o.o.",
				address_line1: "Dunajska cesta 1",
				postal_code: "1000",
				city: "Ljubljana",
				country: "SI",
				tax_number: "12345678",
				vat_number: "SI12345678",
			});
			const pay = async (unitPrice: number, day: number) => {
				const invoice = (
					await call("POST", `${base()}/invoices`, {
						currency: "USD",
						due_date: Date.UTC(2026, 5, 30),
						supply_date: Date.UTC(2026, 4, day),
						items: [{ description: "Consulting", quantity: 1, unit_price: unitPrice, tax_rate: 0, tax_treatment: "export" }],
					})
				).data;
				expect((await call("POST", `${base()}/invoices/${invoice.uuid}/open`)).error).toBe(0);
				await Database`UPDATE invoices SET issued_at = ${Date.UTC(2026, 4, day)}, tax_currency = 'EUR', tax_exchange_rate = 0.9 WHERE uuid = ${invoice.uuid}`;
				const payment = await call("POST", `${base()}/transactions`, { invoice: invoice.uuid, processor: "bank_transfer", amount: unitPrice });
				await Database`UPDATE transactions SET completed_at = ${Date.UTC(2026, 4, day + 5)}, confirmed_at = ${Date.UTC(2026, 4, day + 5)} WHERE uuid = ${payment.data.uuid}`;
				return payment.data.uuid as string;
			};
			const gained = await pay(12200, 1);
			await Database`UPDATE transactions SET base_amount = 11102 WHERE uuid = ${gained}`;
			const old = await pay(10000, 2);
			expect(await fillPaymentValues()).toBeGreaterThanOrEqual(1);
			const [valued] = (await Database`SELECT base_amount FROM transactions WHERE uuid = ${old}`) as { base_amount: number }[];
			expect(Number(valued.base_amount)).toBe(9000);

			const accounts = await trialBalance();
			expect(accounts["7620"]).toBeUndefined();
			expect(accounts["7611"].closing).toBe(10980 + 9000);
			expect(accounts["1210"]?.closing ?? 0).toBe(0);
			expect(accounts["1100"].closing).toBe(11102 + 9000);
			expect(accounts["7770"].closing).toBe(122);
			expect(accounts["7450"]).toBeUndefined();
		} finally {
			project = main;
		}
	});
});

describe("exports for accountants", () => {
	test("the journal and the trial balance download as semicolon separated CSV", async () => {
		const get = async (path: string) =>
			await Server.app.handle(new Request(`http://localhost${base()}${path}`, { headers: { Authorization: `Bearer ${token}` } }));
		const journal = await get(`/accounting/journal/export?from=${YEAR.from}&to=${YEAR.to}`);
		expect(journal.status).toBe(200);
		expect(journal.headers.get("content-disposition")).toContain("dnevnik.csv");
		const lines = (await journal.text())
			.replace(/^\uFEFF/, "")
			.trim()
			.split("\n");
		expect(lines[0]).toBe("temeljnica;datum;opis;vir;konto;naziv_konta;breme;dobro;partner");
		expect(lines[1]).toMatch(/^2026\/1;2026-01-/);
		const trial = await (await get(`/accounting/trial-balance/export?from=${YEAR.from}&to=${YEAR.to}`)).text();
		expect(trial).toContain("konto;naziv_konta;zacetno_breme;zacetno_dobro;promet_breme;promet_dobro;saldo_breme;saldo_dobro");
		expect(trial).toMatch(/\n1100;/);
	});
});

describe("deductible share adjustment", () => {
	test("the final share corrects input VAT on expenses deducted with the provisional share, against costs and asset values", async () => {
		const main = project;
		project = (await call("POST", "/api/v1/projects", { name: "ledger-share", currency: "EUR" })).data.uuid;
		try {
			await call("PATCH", base(), { tax_country: "SI", vat_status: "registered", tax_currency: "EUR" });
			await Database`UPDATE projects SET accounting_until = ${Date.now() + 86400000 * 30} WHERE uuid = ${project}`;
			const expense = async (body: Record<string, unknown>) =>
				(
					await call("POST", `${base()}/expenses`, {
						currency: "EUR",
						expense_date: Date.UTC(2025, 3, 10),
						provisional_share: true,
						...body,
					})
				).data;
			const rent = await expense({ description: "Najem", category: "Rent", total_amount: 12200, tax_amount: 2200, deductible_tax_amount: 1100 });
			expect(rent.provisional_share).toBe(1);
			await expense({
				description: "Stroj",
				category: "Equipment",
				asset_type: "fixed_asset",
				total_amount: 24400,
				tax_amount: 4400,
				deductible_tax_amount: 2200,
			});
			await expense({ description: "Brez", category: "Rent", total_amount: 1220, tax_amount: 220, deductible_tax_amount: 110, provisional_share: false });

			const range = `from=${Date.UTC(2024, 11, 31, 23)}&to=${Date.UTC(2025, 11, 31, 22, 59, 59, 999)}`;
			const balances = async () =>
				Object.fromEntries(
					((await call("GET", `${base()}/accounting/trial-balance?${range}`)).data.accounts as { code: string; closing: number }[]).map((row) => [
						row.code,
						row.closing,
					])
				);
			const higher = await call("PUT", `${base()}/accounting/years/2025/deductible-share`, { final_share: 70 });
			expect(higher.data).toMatchObject({ final_share: 70, provisional_expenses: 2, share_adjustment: 1320 });
			expect(await balances()).toMatchObject({ "1600": 1100 + 2200 + 110 + 1320, "4130": 11100 - 440 + 1110, "0400": 22200 - 880 });

			const lower = await call("PUT", `${base()}/accounting/years/2025/deductible-share`, { final_share: 40 });
			expect(lower.data.share_adjustment).toBe(-660);
			expect(await balances()).toMatchObject({ "1600": 3410 - 660, "4130": 12210 + 220, "0400": 22200 + 440 });

			expect((await call("PUT", `${base()}/accounting/years/2025/deductible-share`, { final_share: 120 })).error).toBe(1263);
			const cleared = await call("PUT", `${base()}/accounting/years/2025/deductible-share`, { final_share: null });
			expect(cleared.data).toMatchObject({ final_share: null, share_adjustment: 0 });
			expect((await balances())["1600"]).toBe(3410);
		} finally {
			project = main;
		}
	});
});

describe("balances follow the business year", () => {
	test("periods across a year end are refused and revenue and expense accounts start the year at zero", async () => {
		const main = project;
		project = (await call("POST", "/api/v1/projects", { name: "ledger-business-year", currency: "EUR" })).data.uuid;
		try {
			await call("PATCH", base(), { tax_country: "SI", vat_status: "registered", tax_currency: "EUR" });
			const code = generateLicenseCode();
			const now = Date.now();
			await Database`INSERT INTO license_keys(uuid, code, type, duration_days, status, created, updated)
				VALUES(${crypto.randomUUID()}, ${code}, 'accounting', 365, 'available', ${now}, ${now})`;
			await call("POST", `${base()}/license/redeem`, { code });
			const sale = await call("POST", `${base()}/accounting/journal`, {
				date: Date.UTC(2025, 2, 1),
				description: "Gotovinska prodaja",
				lines: [
					{ account: await accountId("1000"), debit: 50000 },
					{ account: await accountId("7600"), credit: 50000 },
				],
			});
			expect(sale.error).toBe(0);

			const across = `from=${Date.UTC(2025, 5, 1)}&to=${Date.UTC(2026, 5, 1)}`;
			expect((await call("GET", `${base()}/accounting/trial-balance?${across}`)).error).toBe(1279);
			expect((await call("GET", `${base()}/accounting/ledger/${await accountId("1000")}?${across}`)).error).toBe(1279);

			const year2026 = `from=${Date.UTC(2025, 11, 31, 23)}&to=${Date.UTC(2026, 11, 31, 22, 59, 59, 999)}`;
			const rows = (await call("GET", `${base()}/accounting/trial-balance?${year2026}`)).data.accounts as { code: string; opening: number }[];
			expect(rows.find((row) => row.code === "1000")!.opening).toBe(50000);
			expect(rows.find((row) => row.code === "7600")).toBeUndefined();
			const ledger = (await call("GET", `${base()}/accounting/ledger/${await accountId("7600")}?${year2026}`)).data;
			expect(ledger).toMatchObject({ opening: 0, closing: 0 });
		} finally {
			project = main;
		}
	});
});

describe("manual entries in a submitted DDV period", () => {
	test("entries on VAT accounts are refused while other entries are allowed", async () => {
		const exportId = crypto.randomUUID();
		const now = Date.now();
		await Database`INSERT INTO ddv_exports(uuid, project, period_from, period_to, revision, file_name, storage_key, byte_size, sha256, created_by, created)
			VALUES(${exportId}, ${project}, ${Date.UTC(2026, 6, 31, 22)}, ${Date.UTC(2026, 7, 31, 21, 59, 59, 999)}, 1, 'ddv.zip', 'ddv/test.zip', 1, 'x', NULL, ${now})`;
		await Database`INSERT INTO accounting_period_locks(uuid, project, period_from, period_to, timezone, source, source_id, locked_by, locked_at)
			VALUES(${crypto.randomUUID()}, ${project}, ${Date.UTC(2026, 6, 31, 22)}, ${Date.UTC(2026, 7, 31, 21, 59, 59, 999)}, 'Europe/Ljubljana', 'ddv_export', ${exportId}, NULL, ${now})`;
		try {
			const date = Date.UTC(2026, 7, 15);
			const vat = await call("POST", `${base()}/accounting/journal`, {
				date,
				description: "Popravek DDV",
				lines: [
					{ account: await accountId("1600"), debit: 1000 },
					{ account: await accountId("2600"), credit: 1000 },
				],
			});
			expect(vat.error).toBe(1128);
			const accrual = await call("POST", `${base()}/accounting/journal`, {
				date,
				description: "Vnaprej vracunani stroski",
				lines: [
					{ account: await accountId("4190"), debit: 1000 },
					{ account: await accountId("2900"), credit: 1000 },
				],
			});
			expect(accrual.error).toBe(0);
			expect((await call("POST", `${base()}/accounting/journal/${accrual.data.uuid}/reverse`)).error).toBe(0);
		} finally {
			await Database`DELETE FROM ddv_exports WHERE uuid = ${exportId}`;
		}
	});
});

describe("bank lines settling several documents", () => {
	test("one payment covers an invoice in full and another in part, and a foreign supplier invoice is paid with an exchange difference", async () => {
		const first = await issueInvoice(10000, 5);
		const second = await issueInvoice(20000, 6);
		const vendor = (
			await call("POST", `${base()}/expenses`, {
				description: "Licenca",
				supplier: "US Vendor Inc.",
				supplier_country: "US",
				invoice_number: "US-7",
				category: "Software",
				currency: "USD",
				total_amount: 11000,
				tax_amount: 0,
				deductible_tax_amount: 0,
				tax_exchange_rate: 0.9,
				tax_rate_date: Date.UTC(2026, 2, 2),
				expense_date: Date.UTC(2026, 2, 2),
			})
		).data.uuid;
		const xml = camt([
			entry("300.00", "CRDT", "2026-03-15", "M-1", "Stranka d.o.o.", "Placilo vec racunov"),
			entry("95.00", "DBIT", "2026-03-16", "M-2", "US Vendor Inc.", "Invoice US-7"),
		]).replace("<Id>2026-03-001</Id>", "<Id>2026-03-002</Id>");
		expect((await call("POST", `${base()}/accounting/bank-statements`, { name: "vec.xml", data: Buffer.from(xml).toString("base64") })).data.imported).toBe(2);
		const lines = (await call("GET", `${base()}/accounting/bank-transactions?status=open`)).data.transactions as {
			uuid: string;
			bank_reference: string;
			suggestions: { id: string }[];
		}[];
		const many = lines.find((row) => row.bank_reference === "M-1")!;
		const foreign = lines.find((row) => row.bank_reference === "M-2")!;
		expect(foreign.suggestions[0]).toMatchObject({ id: vendor });

		const candidates = (await call("GET", `${base()}/accounting/bank-transactions/${many.uuid}/candidates`)).data.candidates as { id: string }[];
		expect(candidates.some((candidate) => candidate.id === first) && candidates.some((candidate) => candidate.id === second)).toBe(true);
		const wrong = await call("POST", `${base()}/accounting/bank-transactions/${many.uuid}/match`, {
			matches: [
				{ type: "invoice", id: first },
				{ type: "invoice", id: second },
			],
		});
		expect(wrong.error).toBe(1270);
		const matched = await call("POST", `${base()}/accounting/bank-transactions/${many.uuid}/match`, {
			matches: [
				{ type: "invoice", id: first },
				{ type: "invoice", id: second, amount: 17800 },
			],
		});
		expect(matched.data).toMatchObject({ status: "matched", match_type: "invoice", match_id: null });
		const statuses = (await Database`SELECT uuid, status FROM invoices WHERE uuid IN (${first}, ${second})`) as { uuid: string; status: string }[];
		expect(Object.fromEntries(statuses.map((row) => [row.uuid, row.status]))).toEqual({ [first]: "paid", [second]: "partially_paid" });
		expect((await call("POST", `${base()}/accounting/bank-transactions/${many.uuid}/reopen`)).error).toBe(1271);

		const before = await trialBalance();
		expect((await call("POST", `${base()}/accounting/bank-transactions/${foreign.uuid}/match`, { type: "expense", id: vendor })).data.status).toBe("matched");
		const after = await trialBalance();
		expect(after["7770"].credit - (before["7770"]?.credit ?? 0)).toBe(400);
		expect(after["1100"].credit - before["1100"].credit).toBe(9500);
		expect(after["2210"].debit - (before["2210"]?.debit ?? 0)).toBe(9900);
	});
});

describe("foreign currency revaluation on 31 December", () => {
	test("open items are revalued at the year end rate, reversed on 1 January, and both entries are reversed together", async () => {
		const main = project;
		project = (await call("POST", "/api/v1/projects", { name: "ledger-revaluation", currency: "EUR" })).data.uuid;
		try {
			await call("PATCH", base(), { tax_country: "SI", vat_status: "registered", tax_currency: "EUR" });
			const code = generateLicenseCode();
			const now = Date.now();
			await Database`INSERT INTO license_keys(uuid, code, type, duration_days, status, created, updated)
				VALUES(${crypto.randomUUID()}, ${code}, 'accounting', 365, 'available', ${now}, ${now})`;
			await call("POST", `${base()}/license/redeem`, { code });
			const created = await call("POST", `${base()}/expenses`, {
				description: "Gostovanje",
				supplier: "US Host LLC",
				supplier_country: "US",
				invoice_number: "H-25",
				category: "Hosting",
				currency: "USD",
				total_amount: 11000,
				tax_amount: 0,
				deductible_tax_amount: 0,
				tax_exchange_rate: 0.9,
				tax_rate_date: Date.UTC(2025, 10, 10),
				expense_date: Date.UTC(2025, 10, 10),
			});
			expect(created.status).toBe(201);

			const preview = (await call("GET", `${base()}/accounting/years/2025/revaluation`)).data;
			expect(preview).toMatchObject({ currencies: ["USD"], posted: null });
			expect(preview.items[0]).toMatchObject({ reference: "H-25", account: "2210", open: -11000, booked: -9900 });
			expect((await call("POST", `${base()}/accounting/years/2025/revaluation`, { rates: {} })).error).toBe(1280);
			expect((await call("POST", `${base()}/accounting/years/2026/revaluation`, { rates: { USD: 0.95 } })).error).toBe(1274);

			const posted = await call("POST", `${base()}/accounting/years/2025/revaluation`, { rates: { USD: 0.95 } });
			expect(posted.data).toMatchObject({ difference: -550 });
			expect(posted.data.posted).not.toBeNull();
			expect((await call("POST", `${base()}/accounting/years/2025/revaluation`, { rates: { USD: 0.95 } })).error).toBe(1281);

			const balances = async (from: number, to: number) =>
				Object.fromEntries(
					((await call("GET", `${base()}/accounting/trial-balance?from=${from}&to=${to}`)).data.accounts as { code: string; closing: number }[]).map((row) => [
						row.code,
						row.closing,
					])
				);
			const yearEnd = await balances(Date.UTC(2024, 11, 31, 23), Date.UTC(2025, 11, 31, 22, 59, 59, 999));
			expect(yearEnd).toMatchObject({ "2210": 10450, "7450": 550 });
			const nextYear = await balances(Date.UTC(2025, 11, 31, 23), Date.UTC(2026, 11, 31, 22, 59, 59, 999));
			expect(nextYear["2210"]).toBe(9900);

			expect((await call("POST", `${base()}/accounting/journal/${posted.data.posted}/reverse`)).error).toBe(0);
			expect((await call("GET", `${base()}/accounting/years/2025/revaluation`)).data.posted).toBeNull();
			expect((await balances(Date.UTC(2025, 11, 31, 23), Date.UTC(2026, 11, 31, 22, 59, 59, 999)))["2210"]).toBe(9900);
			expect((await balances(Date.UTC(2024, 11, 31, 23), Date.UTC(2025, 11, 31, 22, 59, 59, 999)))["2210"]).toBe(9900);
		} finally {
			project = main;
		}
	});
});

describe("open items by partner", () => {
	test("documents, credit notes and manual postings are grouped per partner with aging and reconcile to the ledger", async () => {
		const main = project;
		project = (await call("POST", "/api/v1/projects", { name: "ledger-open-items", currency: "EUR" })).data.uuid;
		try {
			await call("PATCH", base(), { tax_country: "SI", vat_status: "registered", tax_currency: "EUR" });
			const code = generateLicenseCode();
			const now = Date.now();
			await Database`INSERT INTO license_keys(uuid, code, type, duration_days, status, created, updated)
				VALUES(${crypto.randomUUID()}, ${code}, 'accounting', 365, 'available', ${now}, ${now})`;
			await call("POST", `${base()}/license/redeem`, { code });
			const recorded = (reference: string, buyer: string, vat: string, issued: number, due: number | null, net: number, type = "invoice") =>
				call("POST", `${base()}/recorded-invoices`, {
					document_type: type,
					reference,
					buyer_name: buyer,
					buyer_vat_number: vat,
					buyer_country: "SI",
					issued_at: issued,
					due_date: due,
					lines: [{ tax_rate: 22, tax_treatment: "domestic", net_amount: net, tax_amount: net * 0.22 }],
				});
			expect((await recorded("R-1", "Stranka d.o.o.", "SI11111111", Date.UTC(2026, 0, 5), Date.UTC(2026, 0, 20), 20000)).status).toBe(201);
			expect((await recorded("R-2", "STRANKA DOO", "11111111", Date.UTC(2026, 2, 1), Date.UTC(2026, 2, 31), 10000)).status).toBe(201);
			expect((await recorded("D-1", "Stranka d.o.o.", "SI 1111 1111", Date.UTC(2026, 2, 5), null, 2000, "credit_note")).status).toBe(201);
			const expense = (supplier: string, tax: string | null, total: number, date: number, number: string) =>
				call("POST", `${base()}/expenses`, {
					description: "Storitev",
					supplier,
					supplier_tax_number: tax,
					supplier_country: "SI",
					invoice_number: number,
					category: "Other",
					currency: "EUR",
					total_amount: total,
					tax_amount: 0,
					deductible_tax_amount: 0,
					expense_date: date,
				});
			expect((await expense("Stranka d.o.o.", "SI11111111", 6100, Date.UTC(2026, 1, 10), "S-9")).status).toBe(201);
			expect((await expense("Host d.o.o.", null, 3050, Date.UTC(2026, 3, 1), "H-1")).status).toBe(201);
			expect(
				(
					await call("POST", `${base()}/accounting/journal`, {
						date: Date.UTC(2026, 0, 1),
						description: "Otvoritev terjatev",
						lines: [
							{ account: await accountId("1200"), debit: 10000, partner: "Stari kupec" },
							{ account: await accountId("9300"), credit: 10000 },
						],
					})
				).error
			).toBe(0);

			const report = (await call("GET", `${base()}/accounting/open-items?date=${Date.UTC(2026, 3, 30, 21, 59, 59, 999)}`)).data;
			const partner = (name: string) => report.partners.find((row: { name: string }) => row.name === name);
			const customer = report.partners.find((row: { tax_number: string | null }) => row.tax_number?.includes("11111111"));
			expect(customer).toMatchObject({ receivable: 34160, payable: 6100, balance: 28060 });
			expect(customer.items).toHaveLength(4);
			expect(customer.aging).toEqual({ current: 0, "1_30": 12200, "31_60": -2440, "61_90": -6100, "91_180": 24400, over_180: 0 });
			expect(partner("Host d.o.o.")).toMatchObject({ payable: 3050, balance: -3050 });
			expect(partner("Stari kupec")).toMatchObject({ receivable: 10000 });
			expect(report.partners).toHaveLength(3);
			expect(report.accounts.find((row: { code: string }) => row.code === "1200")).toMatchObject({ ledger: 44160, difference: 0 });
			expect(report.accounts.find((row: { code: string }) => row.code === "2200")).toMatchObject({ ledger: -9150, difference: 0 });

			const suppliers = (await call("GET", `${base()}/accounting/open-items?kind=payable&date=${Date.UTC(2026, 3, 30, 21)}`)).data;
			expect(suppliers.partners.map((row: { payable: number }) => row.payable).sort()).toEqual([3050, 6100]);
			const before = (await call("GET", `${base()}/accounting/open-items?date=${Date.UTC(2026, 1, 1)}`)).data;
			expect(before.partners.map((row: { balance: number }) => row.balance).sort()).toEqual([10000, 24400]);

			const csv = await (
				await Server.app.handle(
					new Request(`http://localhost${base()}/accounting/open-items/export?date=${Date.UTC(2026, 3, 30, 21)}`, {
						headers: { Authorization: `Bearer ${token}` },
					})
				)
			).text();
			expect(csv).toContain("R-1");
			const partners = (await call("GET", `${base()}/accounting/partners`)).data.partners as { name: string }[];
			expect(partners.map((row) => row.name)).toContain("Host d.o.o.");
		} finally {
			project = main;
		}
	});
});

describe("finding entries and balances", () => {
	test("the journal filters by source, text, amount and account and links entries to their invoice", async () => {
		const query = (extra: string) => call("GET", `${base()}/accounting/journal?from=${YEAR.from}&to=${YEAR.to}&limit=200&${extra}`);
		const payments = (await query("source=payment")).data;
		expect(payments.total).toBeGreaterThan(0);
		for (const entry of payments.entries) {
			expect(entry.source_type).toBe("payment");
			expect(entry.invoice).not.toBeNull();
		}
		const host = (await query("text=HOST-1")).data;
		expect(host.entries.some((entry: { source_id: string }) => entry.source_id === expense)).toBe(true);
		const byAmount = (await query("amount=6100")).data;
		expect(byAmount.total).toBeGreaterThan(0);
		for (const entry of byAmount.entries)
			expect(entry.lines.some((line: { debit: number; credit: number }) => line.debit === 6100 || line.credit === 6100)).toBe(true);
		const bank = await accountId("1100");
		for (const entry of (await query(`account=${bank}`)).data.entries)
			expect(entry.lines.some((line: { account: string }) => line.account === bank)).toBe(true);
		expect((await query("source=nonsense")).error).toBe(1263);
		expect((await call("GET", `${base()}/expenses/${expense}`)).data).toMatchObject({ uuid: expense, invoice_number: "HOST-1" });
	});

	test("trial balance rows carry debit and credit sides and account cards filter by partner", async () => {
		const result = await call("GET", `${base()}/accounting/trial-balance?from=${YEAR.from}&to=${YEAR.to}`);
		for (const row of result.data.accounts as {
			kind: string;
			opening: number;
			closing: number;
			opening_debit: number;
			opening_credit: number;
			closing_debit: number;
			closing_credit: number;
		}[]) {
			const side = row.kind === "asset" || row.kind === "expense" ? 1 : -1;
			expect(side * (row.closing_debit - row.closing_credit) + 0).toBe(row.closing + 0);
			expect(side * (row.opening_debit - row.opening_credit) + 0).toBe(row.opening + 0);
			expect(row.closing_debit === 0 || row.closing_credit === 0).toBe(true);
		}
		const payables = await accountId("2200");
		const card = (await call("GET", `${base()}/accounting/ledger/${payables}?from=${YEAR.from}&to=${YEAR.to}&partner=host`)).data;
		expect(card.lines.length).toBeGreaterThan(0);
		for (const line of card.lines) expect(line.partner.toLowerCase()).toContain("host");
		const csv = await (
			await Server.app.handle(
				new Request(`http://localhost${base()}/accounting/ledger/${payables}/export?from=${YEAR.from}&to=${YEAR.to}&partner=host`, {
					headers: { Authorization: `Bearer ${token}` },
				})
			)
		).text();
		expect(csv).toContain("temeljnica;datum;opis;partner;breme;dobro;saldo");
		expect(csv).toContain("HOST-1");
	});

	test("the clients overview reports open bank lines, unclosed years and DDV submissions", async () => {
		const clients = (await call("GET", "/api/v1/accounting/clients")).data.clients as {
			uuid: string;
			open_bank_lines: number;
			unclosed_years: number[];
			ddv_submitted_until: number | null;
		}[];
		const main = clients.find((client) => client.uuid === project)!;
		const [open] = (await Database`SELECT COUNT(*) AS total FROM bank_transactions WHERE project = ${project} AND status = 'open'`) as { total: number }[];
		expect(main.open_bank_lines).toBe(Number(open.total));
		expect(Array.isArray(main.unclosed_years)).toBe(true);
		const revalued = clients.find((client) => client.unclosed_years.includes(2025));
		expect(revalued).toBeDefined();
	});
});

describe("supplier due dates", () => {
	test("expenses carry a due date that drives supplier aging, and CSV import reads it", async () => {
		const main = project;
		project = (await call("POST", "/api/v1/projects", { name: "ledger-due-dates", currency: "EUR" })).data.uuid;
		try {
			await call("PATCH", base(), { tax_country: "SI", vat_status: "registered", tax_currency: "EUR" });
			const expense = (overrides: Record<string, unknown>) =>
				call("POST", `${base()}/expenses`, {
					description: "Storitev",
					supplier: "Dobavitelj d.o.o.",
					supplier_tax_number: "SI66666666",
					supplier_country: "SI",
					category: "Other",
					currency: "EUR",
					total_amount: 12200,
					tax_amount: 0,
					deductible_tax_amount: 0,
					expense_date: Date.UTC(2026, 2, 1),
					issue_date: Date.UTC(2026, 2, 1),
					...overrides,
				});
			expect((await expense({ invoice_number: "D-0", due_date: Date.UTC(2026, 1, 1) })).error).toBe(1112);
			const created = await expense({ invoice_number: "D-1", due_date: Date.UTC(2026, 3, 30) });
			expect(created.data).toMatchObject({ due_date: Date.UTC(2026, 3, 30) });
			expect((await call("PATCH", `${base()}/expenses/${created.data.uuid}`, { due_date: Date.UTC(2026, 4, 15) })).data.due_date).toBe(Date.UTC(2026, 4, 15));
			expect((await expense({ invoice_number: "D-2" })).data.due_date).toBeNull();

			const report = (await call("GET", `${base()}/accounting/open-items?kind=payable&date=${Date.UTC(2026, 4, 1, 21)}`)).data;
			const items = report.partners[0].items as { reference: string; due_date: number | null; days_overdue: number }[];
			expect(items.find((item) => item.reference === "D-1")).toMatchObject({ due_date: Date.UTC(2026, 4, 15), days_overdue: -14 });
			expect(items.find((item) => item.reference === "D-2")).toMatchObject({ due_date: null, days_overdue: 61 });
			expect(report.partners[0].aging).toMatchObject({ current: -12200, "61_90": -12200 });

			const csv = ["Dobavitelj;Številka;Datum izdaje;Datum zapadlosti;Osnova", "Najem d.o.o.;N-5;1.3.2026;31.3.2026;500,00"].join("\n");
			const preview = (await call("POST", `${base()}/expenses/import-csv/preview`, { content: csv })).data;
			expect(preview.errors).toEqual([]);
			expect(preview.documents[0].input.due_date).toBe(Date.UTC(2026, 2, 30, 22));
		} finally {
			project = main;
		}
	});
});
