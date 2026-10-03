import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.recurring.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { Settings } = await import("../server/settings");
const { setTransport } = await import("../server/email/mailer");
const { runDueRecurring, generateNext, loadRecurring, MAX_FAILURES } = await import("../server/recurring-service");
const schedule = await import("../server/recurring-schedule");
const { recurringPreviewDocument } = await import("../server/recurring-preview");

await Server.configure();
Settings.email.enabled = true;

const sent: { to: string; subject: string }[] = [];
setTransport({
	sendMail: async (message: { to: string; subject: string }) => {
		sent.push(message);
		return { messageId: "x" };
	},
} as never);

const password = (seed: string) => new Bun.CryptoHasher("blake2b512").update(seed).digest("hex");
const DAY = schedule.DAY;
const TIMEZONE = "Europe/Ljubljana";

interface ApiResponse {
	status: number;
	error: number;
	info: string;
	data?: any;
}

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<ApiResponse> {
	const headers: Record<string, string> = {};
	if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
	if (options.body !== undefined) headers["Content-Type"] = "application/json";

	const res = await Server.app.handle(
		new Request(`http://127.0.0.1${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
	);

	const json = (await res.json()) as { error: number; info: string; data?: unknown };
	return { status: res.status, ...json };
}

async function account(name: string): Promise<string> {
	await call("POST", "/api/v1/auth/register", { body: { username: name, email: `${name}@example.com`, password: password(name) } });
	return (await call("POST", "/api/v1/auth/login", { body: { username: name, password: password(name) } })).data.token;
}

const local = (year: number, month: number, day: number) => new Date(year, month - 1, day).getTime();
const today = () => schedule.startOfDay(Date.now(), TIMEZONE);

let ownerToken = "";
let accountantToken = "";
let viewerToken = "";
let projectUuid = "";
let customerUuid = "";
let otherCustomerUuid = "";
const base = () => `/api/v1/projects/${projectUuid}`;

function template(overrides: Record<string, unknown> = {}) {
	return {
		title: "Hosting",
		customer: customerUuid,
		interval_unit: "month",
		interval_count: 1,
		start_date: today(),
		days_until_due: 10,
		items: [{ description: "Hosting for {month} {year}", quantity: 1, unit_price: 2000, tax_rate: 22 }],
		...overrides,
	};
}

async function createTemplate(overrides: Record<string, unknown> = {}) {
	const res = await call("POST", `${base()}/recurring`, { token: ownerToken, body: template(overrides) });
	if (res.error !== 0) throw new Error(res.info);
	return res.data;
}

async function projectRow() {
	const [row] = (await Database`SELECT * FROM projects WHERE uuid = ${projectUuid}`) as any[];
	return row;
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	ownerToken = await account("rec-owner");
	accountantToken = await account("rec-accountant");
	viewerToken = await account("rec-viewer");

	projectUuid = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "rec-agency", currency: "EUR" } })).data.uuid;
	await call("PATCH", base(), { token: ownerToken, body: { date_format: "dd.mm.yyyy" } });
	await call("POST", `${base()}/members`, { token: ownerToken, body: { email: "rec-accountant@example.com", role: "accountant" } });
	await call("POST", `${base()}/members`, { token: ownerToken, body: { email: "rec-viewer@example.com", role: "viewer" } });

	customerUuid = (await call("POST", `${base()}/customers`, { token: ownerToken, body: { email: "retainer@example.com", name: "Retainer" } })).data.uuid;
	otherCustomerUuid = (await call("POST", `${base()}/customers`, { token: ownerToken, body: { email: "other@example.com" } })).data.uuid;
});

afterAll(async () => {
	setTransport(null);
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.recurring.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("schedule", () => {
	const monthly = (anchor: number) => ({ interval_unit: "month", interval_count: 1, anchor_date: anchor, anchor_occurrence: 0 });
	const noLimits = { max_occurrences: null, end_date: null };

	test("keeps the end of the month without drifting", () => {
		const s = monthly(local(2027, 1, 31));
		expect(schedule.occurrenceDate(s, 1)).toBe(local(2027, 2, 28));
		expect(schedule.occurrenceDate(s, 2)).toBe(local(2027, 3, 31));
		expect(schedule.occurrenceDate(s, 3)).toBe(local(2027, 4, 30));
		expect(schedule.addInterval(local(2028, 1, 31), "month", 1, 1)).toBe(local(2028, 2, 29));
	});

	test("counts weeks, quarters and years", () => {
		expect(schedule.addInterval(local(2027, 3, 1), "week", 2, 1)).toBe(local(2027, 3, 15));
		expect(schedule.addInterval(local(2027, 11, 15), "month", 3, 1)).toBe(local(2028, 2, 15));
		expect(schedule.addInterval(local(2028, 2, 29), "year", 1, 1)).toBe(local(2029, 2, 28));
		expect(schedule.addInterval(local(2028, 2, 29), "year", 1, 4)).toBe(local(2032, 2, 29));
	});

	test("stops at the last occurrence or end date", () => {
		const s = monthly(local(2027, 1, 10));
		expect(schedule.upcomingRuns(s, { max_occurrences: 3, end_date: null }, 0, 10)).toEqual([local(2027, 1, 10), local(2027, 2, 10), local(2027, 3, 10)]);
		expect(schedule.upcomingRuns(s, { max_occurrences: null, end_date: local(2027, 2, 10) }, 0, 10)).toEqual([local(2027, 1, 10), local(2027, 2, 10)]);
		expect(schedule.nextRunAfter(s, { max_occurrences: 3, end_date: null }, 3)).toBeNull();
		expect(schedule.upcomingRuns(s, noLimits, 5, 2)).toEqual([local(2027, 6, 10), local(2027, 7, 10)]);
	});

	test("skips to the first run on or after a date", () => {
		const s = monthly(local(2027, 1, 10));
		expect(schedule.firstRunFrom(s, 0, local(2027, 4, 11))).toBe(local(2027, 5, 10));
		expect(schedule.firstRunFrom(s, 0, local(2027, 4, 10))).toBe(local(2027, 4, 10));
		expect(schedule.firstRunFrom(s, 2, local(2027, 1, 1))).toBe(local(2027, 3, 10));
	});

	test("describes the billed period", () => {
		const s = monthly(local(2027, 3, 1));
		const period = schedule.periodOf(s, 0);
		expect(period).toEqual({ start: local(2027, 3, 1), end: local(2027, 3, 31) });
		expect(schedule.fillPlaceholders("Hosting {month} {year}, {period}", period, "en", "dd.mm.yyyy")).toBe("Hosting March 2027, 01.03.2027 to 31.03.2027");
		expect(schedule.fillPlaceholders("Gostovanje {month} {year}, {period}", period, "sl", "d. m. yyyy")).toBe(
			"Gostovanje marec 2027, 1. 3. 2027 do 31. 3. 2027"
		);
		expect(schedule.fillPlaceholders("No {placeholders} here", period, "en", "auto")).toBe("No {placeholders} here");
	});

	test("describes the period before the invoice date in whole calendar months", () => {
		const period = schedule.previousPeriodOf(monthly(local(2026, 9, 4)), 0);
		expect(period).toEqual({ start: local(2026, 8, 1), end: local(2026, 8, 31) });
		expect(schedule.fillPlaceholders("Knjizenje za mesec {month} {year}", period, "sl", "d. m. yyyy")).toBe("Knjizenje za mesec avgust 2026");

		expect(schedule.previousPeriodOf(monthly(local(2026, 9, 4)), 4)).toEqual({ start: local(2026, 12, 1), end: local(2026, 12, 31) });
		expect(schedule.previousPeriodOf({ ...monthly(local(2026, 10, 4)), interval_count: 3 }, 0)).toEqual({
			start: local(2026, 7, 1),
			end: local(2026, 9, 30),
		});
		expect(schedule.previousPeriodOf({ ...monthly(local(2027, 1, 4)), interval_unit: "year" }, 0)).toEqual({
			start: local(2026, 1, 1),
			end: local(2026, 12, 31),
		});
		expect(schedule.previousPeriodOf({ ...monthly(local(2026, 9, 14)), interval_unit: "week" }, 0)).toEqual({
			start: local(2026, 9, 7),
			end: local(2026, 9, 13),
		});

		const zoned = schedule.previousPeriodOf(monthly(schedule.startOfDay(local(2026, 9, 4), TIMEZONE)), 0, TIMEZONE);
		expect(new Date(zoned.start).toLocaleDateString("en-GB", { timeZone: TIMEZONE })).toBe("01/08/2026");
		expect(new Date(zoned.end).toLocaleDateString("en-GB", { timeZone: TIMEZONE })).toBe("31/08/2026");
	});
});

describe("creating", () => {
	test("sets the first run to the start date and totals the lines", async () => {
		const created = await createTemplate({ start_date: today() + 3 * DAY });
		expect(created).toMatchObject({ status: "active", occurrences: 0, next_run_at: today() + 3 * DAY, total_amount: 2440, auto_issue: true, auto_send: true });
		expect(created.upcoming).toHaveLength(5);
		expect(created.customer_detail.email).toBe("retainer@example.com");
		expect(created.invoices).toEqual([]);

		const list = await call("GET", `${base()}/recurring`, { token: ownerToken });
		const row = list.data.find((entry: any) => entry.uuid === created.uuid);
		expect(row).toMatchObject({ customer_name: "Retainer", first_line: "Hosting for {month} {year}", total_amount: 2440 });
	});

	test("a start date later today still starts at the beginning of the day", async () => {
		const endOfToday = today() + DAY - 1000;
		const created = await createTemplate({ start_date: endOfToday, customer: otherCustomerUuid });
		expect(created.start_date).toBe(today());
		expect(created.next_run_at).toBe(today());
		expect(await runDueRecurring()).toBeGreaterThanOrEqual(1);
		expect((await loadRecurring(projectUuid, created.uuid))!.occurrences).toBe(1);

		const moved = await call("PATCH", `${base()}/recurring/${created.uuid}`, { token: ownerToken, body: { next_date: today() + 2 * DAY + 5000 } });
		expect(moved.data.next_run_at).toBe(schedule.startOfDay(today() + 2 * DAY + 5000, TIMEZONE));
	});

	test("searches by title, customer and line description", async () => {
		const backup = await createTemplate({
			title: "Offsite backups",
			customer: otherCustomerUuid,
			items: [{ description: "Encrypted storage", quantity: 1, unit_price: 500, tax_rate: 22 }],
		});
		const search = async (query: string) =>
			(await call("GET", `${base()}/recurring?search=${encodeURIComponent(query)}`, { token: ownerToken })).data.map((row: any) => row.uuid);

		expect(await search("OFFSITE")).toEqual([backup.uuid]);
		expect(await search("encrypted stor")).toEqual([backup.uuid]);
		expect(await search("other@example")).toContain(backup.uuid);
		expect(await search("retainer")).not.toContain(backup.uuid);
		expect(await search("no such template")).toEqual([]);
		expect((await call("GET", `${base()}/recurring?search=${"x".repeat(65)}`, { token: ownerToken })).error).toBe(1001);
	});

	test("rejects bad templates", async () => {
		const post = (body: unknown) => call("POST", `${base()}/recurring`, { token: ownerToken, body });
		expect((await post(template({ customer: undefined }))).error).toBe(1087);
		expect((await post(template({ customer: crypto.randomUUID() }))).error).toBe(1031);
		expect((await post(template({ items: [] }))).error).toBe(1038);
		expect((await post(template({ items: [{ description: "X", quantity: 1, unit_price: 100, gross_amount: 1 }] }))).error).toBe(1038);
		expect((await post(template({ interval_unit: "day" }))).error).toBe(1087);
		expect((await post(template({ interval_count: 0 }))).error).toBe(1087);
		expect((await post(template({ interval_count: 61 }))).error).toBe(1087);
		expect((await post(template({ start_date: today() - DAY }))).error).toBe(1087);
		expect((await post(template({ days_until_due: 366 }))).error).toBe(1087);
		expect((await post(template({ max_occurrences: 0 }))).error).toBe(1087);
		expect((await post(template({ end_date: today() + 3 * DAY, start_date: today() + 5 * DAY }))).error).toBe(1087);
		expect((await post(template({ currency: "euro" }))).error).toBe(1037);
	});

	test("refuses a customer from another project", async () => {
		const other = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "rec-other" } })).data.uuid;
		const foreign = (await call("POST", `/api/v1/projects/${other}/customers`, { token: ownerToken, body: { email: "foreign@example.com" } })).data.uuid;
		expect((await call("POST", `${base()}/recurring`, { token: ownerToken, body: template({ customer: foreign }) })).error).toBe(1031);
	});

	test("an accountant can look but not change anything", async () => {
		const created = await createTemplate();
		expect((await call("GET", `${base()}/recurring/${created.uuid}`, { token: accountantToken })).error).toBe(0);
		expect((await call("POST", `${base()}/recurring`, { token: accountantToken, body: template() })).error).toBe(9999);
		expect((await call("PATCH", `${base()}/recurring/${created.uuid}`, { token: accountantToken, body: { title: "x" } })).error).toBe(9999);
		expect((await call("POST", `${base()}/recurring/${created.uuid}/cancel`, { token: accountantToken })).error).toBe(9999);
		expect((await call("GET", `${base()}/recurring`, { token: viewerToken })).error).toBe(0);
	});
});

describe("running", () => {
	test("issues, links and emails the invoice, then waits for the next period", async () => {
		sent.length = 0;
		await call("PUT", `${base()}/member-profile`, { token: ownerToken, body: { full_name: "Recurring Owner" } });
		const created = await createTemplate({ notes: "Covers {period}" });
		await Database`UPDATE recurring_invoices SET created_by = 'rec-accountant' WHERE uuid = ${created.uuid}`;
		const now = Date.now();

		expect(await runDueRecurring(now)).toBeGreaterThanOrEqual(1);
		const detail = (await call("GET", `${base()}/recurring/${created.uuid}`, { token: ownerToken })).data;
		expect(detail.occurrences).toBe(1);
		expect(detail.next_run_at).toBe(schedule.addInterval(today(), "month", 1, 1, TIMEZONE));
		expect(detail.invoices).toHaveLength(1);
		expect(detail.last_error).toBeNull();

		const invoice = (await call("GET", `${base()}/invoices/${detail.invoices[0].uuid}`, { token: ownerToken })).data;
		expect(invoice.status).toBe("open");
		expect(invoice.recurring).toBe(created.uuid);
		expect(invoice.customer).toBe(customerUuid);
		expect(invoice.created_by).toBe("rec-owner");
		expect(invoice.issuer_name).toBe("Recurring Owner");
		expect(invoice.total_amount).toBe(2440);
		expect(invoice.reference.startsWith("DRAFT")).toBe(false);
		const period = new Date(today()).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: TIMEZONE });
		expect(invoice.items[0].description).toBe(`Hosting for ${period}`);
		expect(invoice.notes).toStartWith("Covers ");
		expect(invoice.notes).not.toContain("{period}");
		expect(schedule.startOfDay(invoice.due_date, TIMEZONE)).toBe(schedule.startOfDay(now + 10 * DAY, TIMEZONE));
		expect(detail.last_invoice).toBe(invoice.uuid);

		await Bun.sleep(20);
		expect(sent.some((mail) => mail.to === "retainer@example.com" && mail.subject.includes(invoice.reference))).toBe(true);

		expect(await runDueRecurring(now)).toBe(0);
	});

	test("creates drafts without emailing when asked to", async () => {
		sent.length = 0;
		const created = await createTemplate({ auto_issue: false, customer: otherCustomerUuid });
		await runDueRecurring();
		const detail = (await call("GET", `${base()}/recurring/${created.uuid}`, { token: ownerToken })).data;
		expect(detail.invoices[0].status).toBe("draft");
		await Bun.sleep(20);
		expect(sent.some((mail) => mail.to === "other@example.com")).toBe(false);
	});

	test("bills the previous month and supplies on its last day", async () => {
		const created = await createTemplate({ bill_previous_period: true, auto_send: false, customer: otherCustomerUuid });
		expect(created.bill_previous_period).toBe(true);
		await runDueRecurring();
		const detail = (await call("GET", `${base()}/recurring/${created.uuid}`, { token: ownerToken })).data;
		const invoice = (await call("GET", `${base()}/invoices/${detail.invoices[0].uuid}`, { token: ownerToken })).data;

		const previous = schedule.previousPeriodOf({ interval_unit: "month", interval_count: 1, anchor_date: today(), anchor_occurrence: 0 }, 0, TIMEZONE);
		const label = new Date(previous.start).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: TIMEZONE });
		expect(invoice.status).toBe("open");
		expect(invoice.items[0].description).toBe(`Hosting for ${label}`);
		expect(invoice.supply_date).toBe(previous.end);

		const edited = await call("PATCH", `${base()}/recurring/${created.uuid}`, { token: ownerToken, body: { bill_previous_period: false } });
		expect(edited.data.bill_previous_period).toBe(false);
		const rejected = await call("PATCH", `${base()}/recurring/${created.uuid}`, { token: ownerToken, body: { bill_previous_period: "yes" } });
		expect(rejected.error).not.toBe(0);
	});

	test("issues without emailing when sending is off", async () => {
		sent.length = 0;
		const created = await createTemplate({ auto_send: false, customer: otherCustomerUuid });
		await runDueRecurring();
		const detail = (await call("GET", `${base()}/recurring/${created.uuid}`, { token: ownerToken })).data;
		expect(detail.invoices[0].status).toBe("open");
		await Bun.sleep(20);
		expect(sent.some((mail) => mail.to === "other@example.com")).toBe(false);
	});

	test("catches up missed periods a few at a time and finishes at the limit", async () => {
		const created = await createTemplate({ max_occurrences: 15 });
		const farFuture = schedule.addInterval(today(), "month", 1, 30, TIMEZONE);

		expect(await runDueRecurring(farFuture)).toBeGreaterThanOrEqual(12);
		let row = (await loadRecurring(projectUuid, created.uuid))!;
		expect(row.occurrences).toBe(12);
		expect(row.status).toBe("active");

		await runDueRecurring(farFuture);
		row = (await loadRecurring(projectUuid, created.uuid))!;
		expect(row.occurrences).toBe(15);
		expect(row.status).toBe("completed");
		expect(row.next_run_at).toBeNull();
	}, 10_000);

	test("ends after the end date", async () => {
		const created = await createTemplate({ interval_unit: "week", end_date: today() + 10 * DAY });
		await runDueRecurring(today() + 30 * DAY);
		const row = (await loadRecurring(projectUuid, created.uuid))!;
		expect(row.occurrences).toBe(2);
		expect(row.status).toBe("completed");
	});

	test("never bills the same period twice", async () => {
		const created = await createTemplate();
		const project = await projectRow();
		const row = (await loadRecurring(projectUuid, created.uuid))!;
		const results = await Promise.all([generateNext(project, row), generateNext(project, row), generateNext(project, row)]);
		expect(results.filter(Boolean)).toHaveLength(1);
		const [linked] = (await Database`SELECT COUNT(*) AS count FROM invoices WHERE recurring = ${created.uuid}`) as { count: number }[];
		expect(Number(linked.count)).toBe(1);
	});

	test("keeps the schedule when an invoice cannot be created and pauses after repeated failures", async () => {
		const created = await createTemplate();
		await Database`DELETE FROM recurring_invoice_items WHERE recurring = ${created.uuid}`;

		await runDueRecurring();
		let row = (await loadRecurring(projectUuid, created.uuid))!;
		expect(row.occurrences).toBe(0);
		expect(row.next_run_at).toBe(today());
		expect(row.failures).toBe(1);
		expect(row.last_error).toBe("The recurring invoice has no lines");

		for (let attempt = 1; attempt < MAX_FAILURES; attempt++) await runDueRecurring();
		row = (await loadRecurring(projectUuid, created.uuid))!;
		expect(row.status).toBe("paused");
		expect(row.failures).toBe(MAX_FAILURES);
	});
});

describe("previewing", () => {
	async function pdfOf(method: string, path: string, body?: unknown) {
		const res = await Server.app.handle(
			new Request(`http://127.0.0.1${path}`, {
				method,
				headers: { Authorization: `Bearer ${ownerToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
				body: body === undefined ? undefined : JSON.stringify(body),
			})
		);
		return { type: res.headers.get("Content-Type"), start: new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()).slice(0, 5)) };
	}

	test("shows the next invoice of an unsaved template without creating anything", async () => {
		const [before] = (await Database`SELECT COUNT(*) AS count FROM invoices`) as { count: number }[];
		const pdf = await pdfOf("POST", `${base()}/recurring/preview`, template({ bill_previous_period: true }));
		expect(pdf).toEqual({ type: "application/pdf", start: "%PDF-" });

		const [after] = (await Database`SELECT COUNT(*) AS count FROM invoices`) as { count: number }[];
		expect(Number(after.count)).toBe(Number(before.count));

		const missing = await call("POST", `${base()}/recurring/preview`, { token: ownerToken, body: template({ items: undefined }) });
		expect(missing.error).not.toBe(0);
		const foreign = await call("POST", `${base()}/recurring/preview`, { token: ownerToken, body: template({ customer: crypto.randomUUID() }) });
		expect(foreign.error).not.toBe(0);
	});

	test("shows the next invoice of a saved template and leaves its schedule alone", async () => {
		const created = await createTemplate({ start_date: today() + 3 * DAY });
		const pdf = await pdfOf("GET", `${base()}/recurring/${created.uuid}/preview`);
		expect(pdf).toEqual({ type: "application/pdf", start: "%PDF-" });

		const detail = (await call("GET", `${base()}/recurring/${created.uuid}`, { token: ownerToken })).data;
		expect(detail.occurrences).toBe(0);
		expect(detail.next_run_at).toBe(created.next_run_at);
		expect(detail.invoices).toHaveLength(0);
	});

	test("fills the previous month, the dates and the totals the way a run would", async () => {
		const anchor = schedule.startOfDay(local(2026, 9, 4), TIMEZONE);
		const document = await recurringPreviewDocument(await projectRow(), {
			customer: customerUuid,
			currency: "EUR",
			items: [{ description: "Knjizenje za mesec {month} {year}", quantity: 1, unit_price: 8800, tax_rate: 22 }],
			discount_amount: 0,
			notes: "Obdobje {period}",
			schedule: { interval_unit: "month", interval_count: 1, anchor_date: anchor, anchor_occurrence: 0 },
			occurrence: 0,
			days_until_due: 10,
			bill_previous_period: true,
			created_by: "rec-owner",
		});

		const previous = schedule.previousPeriodOf({ interval_unit: "month", interval_count: 1, anchor_date: anchor, anchor_occurrence: 0 }, 0, TIMEZONE);
		expect(document.items[0].description).toBe("Knjizenje za mesec August 2026");
		expect(document.invoice.notes).toBe("Obdobje 01.08.2026 to 31.08.2026");
		expect(document.invoice.total_amount).toBe(10736);
		expect(document.invoice.status).toBe("draft");
		expect(document.invoice.issued).toBe(anchor);
		expect(document.invoice.supply_date).toBe(previous.end);
		expect(schedule.startOfDay(document.invoice.due_date!, TIMEZONE)).toBe(schedule.startOfDay(local(2026, 9, 14), TIMEZONE));
		expect(document.buyer?.name).toBe("Retainer");
	});
});

describe("managing", () => {
	test("pausing stops runs and resuming skips the missed periods", async () => {
		const created = await createTemplate({ start_date: today() + DAY });
		expect((await call("POST", `${base()}/recurring/${created.uuid}/pause`, { token: ownerToken })).data.status).toBe("paused");
		expect((await call("POST", `${base()}/recurring/${created.uuid}/pause`, { token: ownerToken })).error).toBe(1088);

		await runDueRecurring(today() + 70 * DAY);
		expect((await loadRecurring(projectUuid, created.uuid))!.occurrences).toBe(0);

		await Database`UPDATE recurring_invoices SET next_run_at = ${today() - 40 * DAY}, anchor_date = ${today() - 40 * DAY} WHERE uuid = ${created.uuid}`;
		const resumed = (await call("POST", `${base()}/recurring/${created.uuid}/resume`, { token: ownerToken })).data;
		expect(resumed.status).toBe("active");
		expect(resumed.next_run_at).toBeGreaterThanOrEqual(today());
		expect(resumed.next_run_at).toBeLessThan(today() + 32 * DAY);
		expect(resumed.occurrences).toBe(0);
	});

	test("creates the next invoice on demand, also while paused", async () => {
		const created = await createTemplate({ start_date: today() + 20 * DAY });
		const run = await call("POST", `${base()}/recurring/${created.uuid}/run`, { token: ownerToken });
		expect(run.status).toBe(201);
		expect(run.data.occurrences).toBe(1);
		expect(run.data.created_invoice).toBe(run.data.invoices[0].uuid);
		expect(run.data.next_run_at).toBe(schedule.addInterval(today() + 20 * DAY, "month", 1, 1, TIMEZONE));

		await call("POST", `${base()}/recurring/${created.uuid}/pause`, { token: ownerToken });
		const paused = await call("POST", `${base()}/recurring/${created.uuid}/run`, { token: ownerToken });
		expect(paused.data.occurrences).toBe(2);
		expect(paused.data.status).toBe("paused");

		expect((await call("POST", `${base()}/recurring/${created.uuid}/run`, { token: accountantToken })).error).toBe(9999);
	});

	test("edits lines and schedule for the next invoices", async () => {
		const created = await createTemplate({ start_date: today() + 5 * DAY });
		const res = await call("PATCH", `${base()}/recurring/${created.uuid}`, {
			token: ownerToken,
			body: {
				title: "Support",
				interval_unit: "week",
				interval_count: 2,
				next_date: today() + DAY,
				items: [{ description: "Support {period}", quantity: 2, unit_price: 5000, tax_rate: 0 }],
			},
		});
		expect(res.data).toMatchObject({ title: "Support", interval_unit: "week", interval_count: 2, next_run_at: today() + DAY, total_amount: 10000 });
		expect(res.data.upcoming[1]).toBe(schedule.addInterval(today() + DAY, "week", 2, 1, TIMEZONE));

		await runDueRecurring(today() + DAY);
		const detail = (await call("GET", `${base()}/recurring/${created.uuid}`, { token: ownerToken })).data;
		const invoice = (await call("GET", `${base()}/invoices/${detail.invoices[0].uuid}`, { token: ownerToken })).data;
		expect(invoice.total_amount).toBe(10000);
		expect(invoice.items[0].description).toContain(" to ");

		expect((await call("PATCH", `${base()}/recurring/${created.uuid}`, { token: ownerToken, body: { start_date: today() + 9 * DAY } })).error).toBe(1087);
		expect((await call("PATCH", `${base()}/recurring/${created.uuid}`, { token: ownerToken, body: { next_date: today() - DAY } })).error).toBe(1087);
	});

	test("a finished schedule restarts from today when its limit is raised", async () => {
		const created = await createTemplate({ max_occurrences: 1 });
		await runDueRecurring();
		expect((await loadRecurring(projectUuid, created.uuid))!.status).toBe("completed");

		await Database`UPDATE recurring_invoices SET anchor_date = ${today() - 90 * DAY} WHERE uuid = ${created.uuid}`;
		const reopened = (await call("PATCH", `${base()}/recurring/${created.uuid}`, { token: ownerToken, body: { max_occurrences: 3 } })).data;
		expect(reopened.status).toBe("active");
		expect(reopened.next_run_at).toBeGreaterThanOrEqual(today());
		expect(await runDueRecurring(today() + 1000)).toBeLessThanOrEqual(1);
	});

	test("canceled templates are closed for good", async () => {
		const created = await createTemplate();
		expect((await call("POST", `${base()}/recurring/${created.uuid}/cancel`, { token: ownerToken })).data).toMatchObject({
			status: "canceled",
			next_run_at: null,
		});
		expect((await call("PATCH", `${base()}/recurring/${created.uuid}`, { token: ownerToken, body: { title: "x" } })).error).toBe(1088);
		expect((await call("POST", `${base()}/recurring/${created.uuid}/run`, { token: ownerToken })).error).toBe(1088);
		expect((await call("POST", `${base()}/recurring/${created.uuid}/resume`, { token: ownerToken })).error).toBe(1088);
		await runDueRecurring(today() + 100 * DAY);
		expect((await loadRecurring(projectUuid, created.uuid))!.occurrences).toBe(0);
	});

	test("only unused templates can be deleted", async () => {
		const unused = await createTemplate({ start_date: today() + 9 * DAY });
		expect((await call("DELETE", `${base()}/recurring/${unused.uuid}`, { token: ownerToken })).error).toBe(0);
		expect((await call("GET", `${base()}/recurring/${unused.uuid}`, { token: ownerToken })).error).toBe(1086);

		const used = await createTemplate();
		await call("POST", `${base()}/recurring/${used.uuid}/run`, { token: ownerToken });
		expect((await call("DELETE", `${base()}/recurring/${used.uuid}`, { token: ownerToken })).error).toBe(1089);
	});

	test("filters by status and customer", async () => {
		const canceled = await call("GET", `${base()}/recurring?status=canceled`, { token: ownerToken });
		expect(canceled.data.length).toBeGreaterThan(0);
		expect(canceled.data.every((row: any) => row.status === "canceled")).toBe(true);

		const other = await call("GET", `${base()}/recurring?customer=${otherCustomerUuid}`, { token: ownerToken });
		expect(other.data.every((row: any) => row.customer === otherCustomerUuid)).toBe(true);
		expect((await call("GET", `${base()}/recurring?status=weird`, { token: ownerToken })).error).toBe(1087);
	});

	test("a customer with recurring invoices cannot be deleted", async () => {
		const lonely = (await call("POST", `${base()}/customers`, { token: ownerToken, body: { email: "lonely@example.com" } })).data.uuid;
		await createTemplate({ customer: lonely, start_date: today() + 9 * DAY });
		expect((await call("DELETE", `${base()}/customers/${lonely}`, { token: ownerToken })).error).toBe(1090);
	});

	test("the invoice API cannot pretend an invoice is recurring", async () => {
		const created = await createTemplate({ start_date: today() + 9 * DAY });
		const res = await call("POST", `${base()}/invoices`, {
			token: ownerToken,
			body: { due_date: Date.now() + DAY, recurring: created.uuid, items: [{ description: "X", quantity: 1, unit_price: 100 }] },
		});
		expect(res.data.recurring).toBeNull();
	});
});
