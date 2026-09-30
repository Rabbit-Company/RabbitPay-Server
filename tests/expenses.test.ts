import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { prepareTest } from "./environment";
await prepareTest();
const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { generateExpense, runDueExpenses } = await import("../server/expense-service");
const { financialReport, financialReportCsv } = await import("../server/financial-report");
const { createInvoice } = await import("../server/invoice-service");
const { Permission, ProjectRole, ROLE_PERMISSIONS } = await import("../server/roles");
import type { RecurringExpenseRow } from "../server/database/models";
await Server.configure();
let token = "";
let viewer = "";
let accountant = "";
let project = "";
let other = "";
const date = (month: number, day = 1) => Date.UTC(2025, month - 1, day);
const base = () => `/api/v1/projects/${project}`;

async function call(method: string, path: string, data?: unknown, auth = token) {
	const response = await Server.app.handle(
		new Request(`http://localhost${path}`, {
			method,
			headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
			body: data === undefined ? undefined : JSON.stringify(data),
		})
	);
	return { status: response.status, ...((await response.json()) as { error: number; data: any }) };
}
async function account(name: string) {
	const password = new Bun.CryptoHasher("blake2b512").update(name).digest("hex");
	await call("POST", "/api/v1/auth/register", { username: name, email: `${name}@example.com`, password });
	return (await call("POST", "/api/v1/auth/login", { username: name, password })).data.token as string;
}
function expense(overrides: Record<string, unknown> = {}) {
	return {
		description: "Hosting",
		category: "Infrastructure",
		currency: "EUR",
		total_amount: 12200,
		tax_amount: 2200,
		deductible_tax_amount: 2200,
		expense_date: date(1),
		paid_at: date(2),
		...overrides,
	};
}
async function schedule(overrides: Record<string, unknown> = {}) {
	const result = await call("POST", `${base()}/expense-schedules`, {
		...expense(),
		start_date: date(1, 31),
		interval_unit: "month",
		interval_count: 1,
		max_occurrences: 3,
		...overrides,
	});
	expect(result.error).toBe(0);
	return result.data;
}
async function loadSchedule(uuid: string) {
	const [row] = await Database`SELECT * FROM recurring_expenses WHERE uuid = ${uuid}`;
	return row as RecurringExpenseRow;
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	token = await account("expense-owner");
	viewer = await account("expense-viewer");
	accountant = await account("expense-accountant");
	project = (await call("POST", "/api/v1/projects", { name: "expenses-test", currency: "EUR" })).data.uuid;
	other = (await call("POST", "/api/v1/projects", { name: "expenses-other", currency: "EUR" })).data.uuid;
	await call("PATCH", base(), { timezone: "UTC" });
	await call("POST", `${base()}/members`, { email: "expense-viewer@example.com", role: "viewer" });
	await call("POST", `${base()}/members`, { email: "expense-accountant@example.com", role: "accountant" });
});
afterAll(async () => {
	await Database.close();
});

describe("expense records", () => {
	test("creates, edits, filters and deletes expenses", async () => {
		const created = await call("POST", `${base()}/expenses`, expense());
		expect(created.status).toBe(201);
		expect(created.data.deductible_tax_amount).toBe(2200);
		const updated = await call("PATCH", `${base()}/expenses/${created.data.uuid}`, { paid_at: null, description: "Updated hosting" });
		expect(updated.data.paid_at).toBeNull();
		const listed = await call("GET", `${base()}/expenses?status=unpaid&from=${date(1)}&to=${date(2)}`);
		expect(listed.data.expenses.map((row: any) => row.uuid)).toContain(created.data.uuid);
		expect((await call("DELETE", `${base()}/expenses/${created.data.uuid}`)).error).toBe(0);
		expect((await call("PATCH", `${base()}/expenses/${created.data.uuid}`, { notes: "missing" })).status).toBe(404);
	});
	test("accepts supplier invoices larger than the general request limit", async () => {
		const created = await call("POST", `${base()}/expenses`, expense());
		const scan = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(900 * 1024, 3)]);
		const uploaded = await call("PUT", `${base()}/expenses/${created.data.uuid}/attachment`, {
			name: "scan.pdf",
			type: "application/pdf",
			data: scan.toString("base64"),
		});
		expect(uploaded.status).toBe(200);
		expect(uploaded.data.byte_size).toBe(scan.length);
		await call("DELETE", `${base()}/expenses/${created.data.uuid}`);
	});
	test("defaults tax and payment status without recording a payment", async () => {
		const created = await call("POST", `${base()}/expenses`, { description: "Rent", category: "Office", total_amount: 50000, expense_date: date(3) });
		expect(created.data.currency).toBe("EUR");
		expect(created.data.tax_amount).toBe(0);
		expect(created.data.paid_at).toBeNull();
		await call("DELETE", `${base()}/expenses/${created.data.uuid}`);
	});
	test("rejects invalid amounts, tax, text, dates and bodies", async () => {
		for (const changes of [
			{ total_amount: 0 },
			{ total_amount: -1 },
			{ total_amount: 1.2 },
			{ total_amount: Number.MAX_SAFE_INTEGER + 1 },
			{ tax_amount: 12201 },
			{ deductible_tax_amount: 2201 },
			{ description: " " },
			{ category: "" },
			{ currency: "eur" },
			{ expense_date: 8640000000000001 },
			{ paid_at: "today" },
			{ supplier: 42 },
		]) {
			expect((await call("POST", `${base()}/expenses`, expense(changes))).status).toBe(400);
		}
		for (const value of [null, [], "expense"]) expect((await call("POST", `${base()}/expenses`, value)).status).toBe(400);
	});
	test("checks permissions and keeps projects isolated", async () => {
		const created = await call("POST", `${base()}/expenses`, expense(), accountant);
		expect(created.status).toBe(201);
		expect((await call("GET", `${base()}/expenses`, undefined, viewer)).error).toBe(0);
		expect((await call("POST", `${base()}/expenses`, expense(), viewer)).status).toBe(403);
		expect((await call("PATCH", `/api/v1/projects/${other}/expenses/${created.data.uuid}`, { description: "Other" })).status).toBe(404);
		expect((await call("DELETE", `/api/v1/projects/${other}/expenses/${created.data.uuid}`)).status).toBe(404);
		expect((await call("DELETE", `${base()}/expenses/${created.data.uuid}`, undefined, accountant)).status).toBe(403);
		await call("DELETE", `${base()}/expenses/${created.data.uuid}`);
	});
	test("validates pagination and period filters", async () => {
		for (const query of ["limit=-1", "offset=1.2", "from=10&to=2", "status=unknown"])
			expect((await call("GET", `${base()}/expenses?${query}`)).status).toBe(400);
	});
});

describe("expense CSV import", () => {
	const csv = [
		"Dobavitelj;Številka;ID za DDV;Država;Datum izdaje;Kategorija;Obravnava;Stopnja DDV;Osnova;DDV;Plačano",
		"Petrol d.d.;P-77;SI80267432;SI;4.3.2026;Travel;;22;100,00;22,00;4.3.2026",
		"Petrol d.d.;P-77;SI80267432;SI;4.3.2026;Travel;;9,5;50,00;4,75;4.3.2026",
		"Kavarna;K-5;;;5.3.2026;Marketing;;;12,00;;",
		"Google Ireland;G-9;IE6388047V;IE;6.3.2026;Software;eu_services;22;80,00;17,60;",
	].join("\n");

	test("groups VAT lines per supplier invoice, handles reverse charge and imports once", async () => {
		const preview = await call("POST", `${base()}/expenses/import-csv/preview`, { content: csv });
		expect(preview.data.errors).toEqual([]);
		const [fuel, coffee, google] = preview.data.documents.map((document: { input: any }) => document.input);
		expect(fuel).toMatchObject({ total_amount: 17675, tax_amount: 2675, deductible_tax_amount: 2675, vat_treatment: "domestic", category: "Travel" });
		expect(fuel.vat_lines).toHaveLength(2);
		expect(coffee).toMatchObject({ total_amount: 1200, tax_amount: 0, vat_treatment: "not_reported", paid_at: null });
		expect(google).toMatchObject({ total_amount: 8000, tax_amount: 1760, vat_treatment: "eu_services", supplier_country: "IE" });

		const imported = await call("POST", `${base()}/expenses/import-csv`, { content: csv });
		expect(imported.status).toBe(201);
		expect(imported.data.imported).toBe(3);
		const again = await call("POST", `${base()}/expenses/import-csv`, { content: csv });
		expect(again.error).toBe(1112);
		expect(again.data.errors.map((error: { code: string }) => error.code)).toEqual(["already_recorded", "already_recorded", "already_recorded"]);
		const broken = await call("POST", `${base()}/expenses/import-csv/preview`, { content: "Dobavitelj;Številka;Datum izdaje;Osnova\nX;1;32.1.2026;abc" });
		expect(broken.data.errors.map((error: { code: string }) => error.code)).toEqual(["invalid_date", "invalid_amount"]);
	});
});

describe("recurring expense generation", () => {
	test("keeps month end dates and prevents duplicates from stale claims", async () => {
		const created = await schedule();
		const original = await loadSchedule(created.uuid);
		const uuid = await generateExpense(original, date(2, 28));
		expect(uuid).not.toBeNull();
		expect(await generateExpense(original, date(2, 28))).toBeNull();
		let next = await loadSchedule(created.uuid);
		expect(next.next_run_at).toBe(date(2, 28));
		await generateExpense(next, date(3, 31));
		next = await loadSchedule(created.uuid);
		expect(next.next_run_at).toBe(date(3, 31));
		await generateExpense(next, date(3, 31));
		next = await loadSchedule(created.uuid);
		expect(next.status).toBe("completed");
		expect(next.occurrences).toBe(3);
		const rows = await Database`SELECT * FROM expenses WHERE recurring = ${created.uuid} ORDER BY occurrence`;
		expect(rows.length).toBe(3);
		expect(rows[0].expense_date).toBe(date(1, 31));
		expect(rows[0].paid_at).toBeNull();
	});
	test("template edits invalidate pending claims and preserve the original schedule anchor", async () => {
		const created = await schedule();
		const stale = await loadSchedule(created.uuid);
		await call("PATCH", `${base()}/expense-schedules/${created.uuid}`, { total_amount: 15000, interval_unit: "month", interval_count: 1 });
		expect(await generateExpense(stale, date(2))).toBeNull();
		const fresh = await loadSchedule(created.uuid);
		expect(fresh.anchor_date).toBe(date(1, 31));
		expect(fresh.updated).toBeGreaterThan(stale.updated);
		await generateExpense(fresh, date(2));
		const next = await loadSchedule(created.uuid);
		expect(next.next_run_at).toBe(date(2, 28));
		await call("PATCH", `${base()}/expense-schedules/${created.uuid}`, { status: "canceled" });
	});
	test("concurrent runs create one entry and advance once", async () => {
		const created = await schedule({ max_occurrences: 1 });
		const row = await loadSchedule(created.uuid);
		const results = await Promise.all([generateExpense(row, date(2)), generateExpense(row, date(2))]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect((await loadSchedule(created.uuid)).occurrences).toBe(1);
	});
	test("interval edits start from the next scheduled date", async () => {
		const created = await schedule();
		await generateExpense(await loadSchedule(created.uuid), date(2));
		await call("PATCH", `${base()}/expense-schedules/${created.uuid}`, { interval_unit: "year" });
		const row = await loadSchedule(created.uuid);
		expect(row.anchor_date).toBe(date(2, 28));
		expect(row.next_run_at).toBe(date(2, 28));
		await call("PATCH", `${base()}/expense-schedules/${created.uuid}`, { status: "canceled" });
	});
	test("only records payment automatically when enabled", async () => {
		const created = await schedule({ auto_paid: true, max_occurrences: 1 });
		const uuid = await generateExpense(await loadSchedule(created.uuid), date(2));
		const [row] = await Database`SELECT * FROM expenses WHERE uuid = ${uuid}`;
		expect(row.paid_at).toBe(date(1, 31));
	});
	test("rolls back the schedule when inserting an expense fails", async () => {
		const created = await schedule();
		const row = await loadSchedule(created.uuid);
		await expect(generateExpense({ ...row, total_amount: -1 }, date(2))).rejects.toThrow();
		const fresh = await loadSchedule(created.uuid);
		expect(fresh.occurrences).toBe(0);
		expect(fresh.next_run_at).toBe(row.next_run_at);
		await call("PATCH", `${base()}/expense-schedules/${row.uuid}`, { status: "canceled" });
	});
	test("pauses, resumes, edits and cancels schedules without changing past entries", async () => {
		const created = await schedule({ start_date: Date.now(), max_occurrences: 5 });
		const original = await loadSchedule(created.uuid);
		expect((await call("PATCH", `${base()}/expense-schedules/${created.uuid}`, { status: "paused" })).error).toBe(0);
		expect(await generateExpense(original, Date.now())).toBeNull();
		expect(await generateExpense(await loadSchedule(created.uuid), Date.now())).toBeNull();
		await call("PATCH", `${base()}/expense-schedules/${created.uuid}`, { status: "active" });
		const resumed = await loadSchedule(created.uuid);
		const uuid = await generateExpense(resumed, resumed.next_run_at! + 1000);
		expect(uuid).not.toBeNull();
		await call("PATCH", `${base()}/expense-schedules/${created.uuid}`, { total_amount: 15000 });
		const [entry] = await Database`SELECT * FROM expenses WHERE uuid = ${uuid}`;
		expect(entry.total_amount).toBe(12200);
		await call("PATCH", `${base()}/expense-schedules/${created.uuid}`, { status: "canceled" });
		expect((await call("PATCH", `${base()}/expense-schedules/${created.uuid}`, { status: "active" })).status).toBe(409);
	});
	test("validates schedule limits and protects schedule access", async () => {
		for (const change of [{ interval_unit: "day" }, { interval_count: 0 }, { max_occurrences: 0 }, { auto_paid: 1 }, { end_date: date(1) }])
			expect((await call("POST", `${base()}/expense-schedules`, { ...expense(), start_date: date(1, 31), interval_unit: "month", ...change })).status).toBe(
				400
			);
		const created = await schedule();
		expect((await call("PATCH", `/api/v1/projects/${other}/expense-schedules/${created.uuid}`, { status: "paused" })).status).toBe(404);
		expect((await call("PATCH", `${base()}/expense-schedules/${created.uuid}`, { status: "paused" }, viewer)).status).toBe(403);
		await call("PATCH", `${base()}/expense-schedules/${created.uuid}`, { status: "canceled" });
	});
	test("catches up overdue entries and respects the end date", async () => {
		const created = await schedule({ end_date: date(2, 28), max_occurrences: null });
		await runDueExpenses(date(4));
		const row = await loadSchedule(created.uuid);
		expect(row.occurrences).toBe(2);
		expect(row.status).toBe("completed");
	});
});

describe("financial reports", () => {
	test("separates costs from cash dates, includes fees and refunds and keeps currencies separate", async () => {
		const reportProject = other;
		const invoice = await createInvoice(reportProject, {
			customer: null,
			currency: "EUR",
			items: [{ description: "Service", quantity: 1, unit_price: 10000, tax_rate: 22 }],
			status: "open",
			due_date: date(2),
		});
		await Database`UPDATE invoices SET issued_at = ${date(1)} WHERE uuid = ${invoice.uuid}`;
		await call("POST", `/api/v1/projects/${reportProject}/expenses`, expense());
		await call(
			"POST",
			`/api/v1/projects/${reportProject}/expenses`,
			expense({ currency: "USD", total_amount: 5000, tax_amount: 0, deductible_tax_amount: 0, paid_at: null })
		);
		for (const payment of [
			{ type: "payment", status: "partially_refunded", amount: 12200, fee: 200, date: date(2) },
			{ type: "partial_refund", status: "completed", amount: 1220, fee: 0, date: date(3) },
			{ type: "payment", status: "pending", amount: 9000, fee: 100, date: date(1) },
		]) {
			await Database`INSERT INTO transactions(uuid, project, invoice, processor, status, type, currency, amount, fee_amount, completed_at, created, updated)
				VALUES(${crypto.randomUUID()}, ${reportProject}, ${invoice.uuid}, 'bank_transfer', ${payment.status}, ${payment.type}, 'EUR', ${payment.amount}, ${payment.fee}, ${payment.date}, ${payment.date}, ${payment.date})`;
		}
		await Database`INSERT INTO credit_notes(uuid, project, invoice, reference, currency, subtotal, tax_amount, total_amount, issued_at, created)
			VALUES(${crypto.randomUUID()}, ${reportProject}, ${invoice.uuid}, 'CN-TEST', 'EUR', 1000, 220, 1220, ${date(3)}, ${date(3)})`;
		const report = await financialReport(reportProject, date(1), date(4) - 1, "month");
		const eur = report.totals.find((row) => row.currency === "EUR")!;
		expect(eur.revenue).toBe(9000);
		expect(eur.expenses).toBe(10000);
		expect(eur.fees).toBe(200);
		expect(eur.profit).toBe(-1200);
		expect(eur.cash_flow).toBe(-1420);
		const january = report.periods.find((row) => row.currency === "EUR" && row.period === "2025-01")!;
		expect(january.profit).toBe(0);
		expect(january.cash_flow).toBe(0);
		const february = report.periods.find((row) => row.currency === "EUR" && row.period === "2025-02")!;
		expect(february.cash_flow).toBe(-200);
		expect(report.totals.find((row) => row.currency === "USD")!.profit).toBe(-5000);
		expect(report.categories.find((row) => row.currency === "EUR")!.amount).toBe(10000);
		const annual = await financialReport(reportProject, date(1), Date.UTC(2027, 0, 1) - 1, "year");
		expect(annual.periods.find((row) => row.currency === "EUR" && row.period === "2026")!.revenue).toBe(0);
		expect(annual.periods.find((row) => row.currency === "EUR" && row.period === "2025")!.profit).toBe(eur.profit);
		expect(financialReportCsv(report)).toContain("2025-01,EUR,10000,10000,0,0");
	});
	test("includes tax in expense costs unless entered as deductible", async () => {
		const start = Date.UTC(2024, 0, 1);
		await call("POST", `/api/v1/projects/${other}/expenses`, expense({ expense_date: start, paid_at: null, deductible_tax_amount: 0 }));
		await call("POST", `/api/v1/projects/${other}/expenses`, expense({ expense_date: start, paid_at: null, deductible_tax_amount: 1100 }));
		const report = await financialReport(other, start, Date.UTC(2025, 0, 1) - 1, "year");
		expect(report.totals[0].expenses).toBe(23300);
		expect(report.totals[0].profit).toBe(-23300);
		expect(report.totals[0].cash_flow).toBe(0);
	});
	test("requires export permission and rejects invalid report ranges", async () => {
		for (const query of ["from=-1", "from=20&to=10", "from=0&to=9999999999999", "group=day"])
			expect((await call("GET", `${base()}/reports/financial?${query}`)).status).toBe(400);
		expect((await call("GET", `${base()}/reports/financial/export`, undefined, viewer)).status).toBe(403);
		expect((await call("POST", `${base()}/reports/financial`)).status).toBe(200);
		const response = await Server.app.handle(
			new Request(`http://localhost${base()}/reports/financial/export`, { headers: { Authorization: `Bearer ${token}` } })
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/csv");
		expect(await response.text()).toStartWith("period,currency,revenue");
	});
	test("preserves exact large amounts and rejects overflowing report totals", async () => {
		const uuid = (await call("POST", "/api/v1/projects", { name: "report-overflow", currency: "EUR" })).data.uuid;
		const first = await call(
			"POST",
			`/api/v1/projects/${uuid}/expenses`,
			expense({
				total_amount: Number.MAX_SAFE_INTEGER,
				tax_amount: 0,
				deductible_tax_amount: 0,
				paid_at: null,
			})
		);
		expect(first.status).toBe(201);
		const report = await financialReport(uuid, date(1), date(4), "month");
		expect(report.totals[0].expenses).toBe(Number.MAX_SAFE_INTEGER);
		expect(report.totals[0].profit).toBe(-Number.MAX_SAFE_INTEGER);
		const second = await call(
			"POST",
			`/api/v1/projects/${uuid}/expenses`,
			expense({
				total_amount: 1,
				tax_amount: 0,
				deductible_tax_amount: 0,
				paid_at: null,
			})
		);
		expect(second.status).toBe(201);
		await expect(financialReport(uuid, date(1), date(4), "month")).rejects.toThrow("safe integer range");
	});
	test("grants expense access to financial roles and excludes cashiers and developers", () => {
		for (const role of [ProjectRole.OWNER, ProjectRole.ADMIN, ProjectRole.MANAGER, ProjectRole.ACCOUNTANT])
			expect(ROLE_PERMISSIONS[role]).toContain(Permission.EXPENSE_CREATE);
		for (const role of [ProjectRole.CASHIER, ProjectRole.DEVELOPER]) expect(ROLE_PERMISSIONS[role]).not.toContain(Permission.EXPENSE_VIEW);
	});
});
