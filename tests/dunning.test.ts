import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import { ErrorCode } from "../server/errors";
import { compensationAllowed, lineFigures, nextLevel, possiblyTimeBarred, STATUTORY_RATES, statutoryInterest } from "../server/dunning-rules";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.dunning.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { localDate, shiftLocalDate } = await import("../server/timezone");

await Server.configure();

const password = (seed: string) => new Bun.CryptoHasher("blake2b512").update(seed).digest("hex");

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
	if (res.headers.get("Content-Type")?.includes("application/pdf"))
		return { status: res.status, error: 0, info: "pdf", data: new Uint8Array(await res.arrayBuffer()) };
	const json = (await res.json()) as { error: number; info: string; data?: unknown };
	return { status: res.status, ...json };
}

let ownerToken = "";
let viewerToken = "";
let projectUuid = "";
let businessCustomer = "";
let personCustomer = "";
const base = () => `/api/v1/projects/${projectUuid}`;
const DAY = 86400000;

async function overdueInvoice(customer: string, unitPrice: number, daysLate: number): Promise<string> {
	const created = await call("POST", `${base()}/invoices`, {
		token: ownerToken,
		body: {
			customer,
			due_date: Date.now() + DAY,
			supply_date: Date.now(),
			items: [{ description: "Consulting", quantity: 1, unit_price: unitPrice, tax_rate: 22 }],
		},
	});
	if (created.error !== 0) throw new Error(created.info);
	const opened = await call("POST", `${base()}/invoices/${created.data.uuid}/open`, { token: ownerToken });
	if (opened.error !== 0) throw new Error(opened.info);
	await Database`UPDATE invoices SET due_date = ${Date.now() - daysLate * DAY}, status = 'overdue' WHERE uuid = ${created.data.uuid}`;
	return created.data.uuid;
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	await call("POST", "/api/v1/auth/register", { body: { email: "dun-owner@example.com", password: password("dun-owner") } });
	ownerToken = (await call("POST", "/api/v1/auth/login", { body: { email: "dun-owner@example.com", password: password("dun-owner") } })).data.token;
	await call("POST", "/api/v1/auth/register", { body: { email: "dun-viewer@example.com", password: password("dun-viewer") } });
	viewerToken = (await call("POST", "/api/v1/auth/login", { body: { email: "dun-viewer@example.com", password: password("dun-viewer") } })).data.token;

	projectUuid = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "dunning-shop", currency: "EUR" } })).data.uuid;
	await call("PATCH", base(), { token: ownerToken, body: { tax_country: "SI", vat_status: "registered", tax_currency: "EUR" } });
	await call("PUT", `${base()}/company`, {
		token: ownerToken,
		body: {
			legal_name: "Opomini Test d.o.o.",
			address_line1: "Slovenska cesta 1",
			postal_code: "1000",
			city: "Ljubljana",
			country: "SI",
			vat_number: "SI12345678",
		},
	});
	await call("POST", `${base()}/members`, { token: ownerToken, body: { email: "dun-viewer@example.com", role: "viewer" } });
	businessCustomer = (
		await call("POST", `${base()}/customers`, {
			token: ownerToken,
			body: {
				email: "billing@zamudnik.example",
				name: "Zamudnik d.o.o.",
				address_line1: "Trg 1",
				postal_code: "2000",
				city: "Maribor",
				country: "SI",
				vat_number: "SI87654321",
				customer_type: "business",
			},
		})
	).data.uuid;
	personCustomer = (
		await call("POST", `${base()}/customers`, {
			token: ownerToken,
			body: {
				email: "ana@example.com",
				name: "Ana Novak",
				address_line1: "Ulica 2",
				postal_code: "4000",
				city: "Kranj",
				country: "SI",
				customer_type: "individual",
			},
		})
	).data.uuid;
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.dunning.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("statutory interest", () => {
	test("splits at rate changes and uses the simple method", () => {
		const result = statutoryInterest(100000, "2025-12-31", "2026-07-10");
		expect(result.days).toBe(191);
		expect(result.periods).toEqual([
			{ from: "2026-01-01", to: "2026-06-30", days: 181, rate: 10.15, interest: 5033 },
			{ from: "2026-07-01", to: "2026-07-10", days: 10, rate: 10.4, interest: 285 },
		]);
		expect(result.interest).toBe(5318);
	});

	test("counts leap years with 366 days", () => {
		expect(statutoryInterest(366000, "2023-12-31", "2024-01-01").interest).toBe(Math.round((366000 * 12.5) / 100 / 366));
	});

	test("stops when unpaid interest reaches the principal", () => {
		const result = statutoryInterest(100000, "2010-01-01", "2026-10-17");
		expect(result.capped).toBe(true);
		expect(result.interest).toBe(100000);
	});

	test("nothing accrues on or before the due date", () => {
		expect(statutoryInterest(100000, "2026-10-17", "2026-10-17").interest).toBe(0);
	});

	test("rate table is ordered by half years", () => {
		for (let index = 1; index < STATUTORY_RATES.length; index++) expect(STATUTORY_RATES[index]!.from > STATUTORY_RATES[index - 1]!.from).toBe(true);
		expect(STATUTORY_RATES.every((entry) => entry.from.endsWith("-01-01") || entry.from.endsWith("-07-01"))).toBe(true);
	});
});

describe("dunning rules", () => {
	test("recovery costs only for business claims in EUR younger than three years", () => {
		const check = { currency: "EUR", business: true, dueDate: "2023-01-01", until: "2025-12-31" };
		expect(compensationAllowed(check)).toBe(true);
		expect(compensationAllowed({ ...check, until: "2026-01-02" })).toBe(false);
		expect(compensationAllowed({ ...check, business: false })).toBe(false);
		expect(compensationAllowed({ ...check, currency: "USD" })).toBe(false);
	});

	test("line figures combine interest and compensation", () => {
		const figures = lineFigures(
			{ open: 100000, due: "2025-12-31" },
			{ until: "2026-07-10", interest: true, compensation: true, business: true, currency: "EUR" }
		);
		expect(figures).toEqual({ days: 191, interest: 5318, compensation: 4000 });
	});

	test("levels escalate and stop at the final reminder", () => {
		expect([nextLevel(null), nextLevel(1), nextLevel(2), nextLevel(3)]).toEqual([1, 2, 3, 3]);
	});

	test("warns about claims older than three years", () => {
		expect(possiblyTimeBarred("2023-01-01", "2026-01-02")).toBe(true);
		expect(possiblyTimeBarred("2024-01-01", "2026-01-02")).toBe(false);
	});
});

describe("dunning letters", () => {
	let firstInvoice = "";
	let secondInvoice = "";
	let letterUuid = "";

	test("lists customers with overdue invoices", async () => {
		firstInvoice = await overdueInvoice(businessCustomer, 10000, 40);
		secondInvoice = await overdueInvoice(businessCustomer, 5000, 10);
		await overdueInvoice(personCustomer, 2000, 5);

		const listed = await call("GET", `${base()}/dunning/debtors`, { token: viewerToken });
		expect(listed.error).toBe(0);
		const business = listed.data.debtors.find((row: { customer: string }) => row.customer === businessCustomer);
		expect(business).toMatchObject({ invoices: 2, overdue_amount: 18300, currency: "EUR", last_letter: null });
		expect(listed.data.debtors[0].customer).toBe(businessCustomer);
	});

	test("offers overdue invoices and the next level", async () => {
		const candidates = await call("GET", `${base()}/dunning/candidates?customer=${businessCustomer}`, { token: ownerToken });
		expect(candidates.error).toBe(0);
		expect(candidates.data.invoices.map((line: { uuid: string }) => line.uuid)).toEqual([firstInvoice, secondInvoice]);
		expect(candidates.data).toMatchObject({ suggested_level: 1, interest_available: true, compensation_available: true, customer: { business: true } });
	});

	test("previews a PDF without issuing", async () => {
		const preview = await call("POST", `${base()}/dunning/preview`, {
			token: ownerToken,
			body: { customer: businessCustomer, invoices: [firstInvoice], interest: true },
		});
		expect(preview.status).toBe(200);
		expect(new TextDecoder().decode(preview.data.slice(0, 5))).toBe("%PDF-");
		const [count] = (await Database`SELECT COUNT(*) AS count FROM dunning_letters`) as { count: number }[];
		expect(Number(count!.count)).toBe(0);
	});

	test("issues a letter with interest, recovery costs and invoices issued before RabbitPay", async () => {
		const today = localDate(Date.now(), "Europe/Ljubljana");
		const oldDue = shiftLocalDate(today, -400);
		const issued = await call("POST", `${base()}/dunning`, {
			token: ownerToken,
			body: {
				customer: businessCustomer,
				invoices: [firstInvoice, secondInvoice],
				manual: [{ reference: "2024-117", issue_date: shiftLocalDate(oldDue, -30), due_date: oldDue, amount: 50000, open: 20000 }],
				interest: true,
				compensation: true,
				deadline_days: 8,
				note: "Prosimo za hitro ureditev.",
			},
		});
		expect(issued.status).toBe(201);
		letterUuid = issued.data.uuid;
		expect(issued.data).toMatchObject({ level: 1, number: `OP-${today.slice(0, 4)}-0001`, deadline_date: shiftLocalDate(today, 8), compensation: 12000 });
		expect(issued.data.lines.map((line: { reference: string }) => line.reference)[0]).toBe("2024-117");
		expect(issued.data.principal).toBe(20000 + 12200 + 6100);
		const manual = issued.data.lines[0];
		expect(manual.interest).toBe(statutoryInterest(20000, oldDue, today).interest);
		expect(issued.data.total_amount).toBe(issued.data.principal + issued.data.interest + issued.data.compensation);
	});

	test("downloads the stored PDF and suggests the next level", async () => {
		const pdf = await call("GET", `${base()}/dunning/${letterUuid}/pdf`, { token: viewerToken });
		expect(new TextDecoder().decode(pdf.data.slice(0, 5))).toBe("%PDF-");
		const candidates = await call("GET", `${base()}/dunning/candidates?customer=${businessCustomer}`, { token: ownerToken });
		expect(candidates.data.suggested_level).toBe(2);
		expect(candidates.data.previous_manual).toEqual([expect.objectContaining({ reference: "2024-117", open: 20000 })]);
		const debtors = await call("GET", `${base()}/dunning/debtors`, { token: ownerToken });
		expect(debtors.data.debtors.find((row: { customer: string }) => row.customer === businessCustomer).last_letter).toMatchObject({
			uuid: letterUuid,
			level: 1,
		});
	});

	test("shows what is still open on linked invoices", async () => {
		await Database`UPDATE invoices SET paid_amount = total_amount, status = 'paid' WHERE uuid = ${secondInvoice}`;
		const detail = await call("GET", `${base()}/dunning/${letterUuid}`, { token: viewerToken });
		const byReference = new Map(detail.data.lines.map((line: { invoice: string | null; open_now: number | null }) => [line.invoice, line.open_now]));
		expect(byReference.get(secondInvoice)).toBe(0);
		expect(byReference.get(firstInvoice)).toBe(12200);
		expect(byReference.get(null)).toBeNull();
	});

	test("refuses options the law does not allow", async () => {
		const personInvoice = (await Database`SELECT uuid FROM invoices WHERE customer = ${personCustomer}`) as { uuid: string }[];
		const refused = await call("POST", `${base()}/dunning`, {
			token: ownerToken,
			body: { customer: personCustomer, invoices: [personInvoice[0]!.uuid], compensation: true },
		});
		expect(refused.error).toBe(ErrorCode.DUNNING_OPTION_UNAVAILABLE);
		const notDue = await call("POST", `${base()}/dunning`, {
			token: ownerToken,
			body: { customer: personCustomer, manual: [{ reference: "X-1", due_date: shiftLocalDate(localDate(Date.now(), "Europe/Ljubljana"), 3), open: 100 }] },
		});
		expect(notDue.error).toBe(ErrorCode.INVALID_DUNNING_LETTER);
		const foreign = await call("POST", `${base()}/dunning`, { token: ownerToken, body: { customer: personCustomer, invoices: [firstInvoice] } });
		expect(foreign.error).toBe(ErrorCode.NOTHING_TO_DUN);
		const empty = await call("POST", `${base()}/dunning`, { token: ownerToken, body: { customer: personCustomer } });
		expect(empty.error).toBe(ErrorCode.NOTHING_TO_DUN);
	});

	test("viewers cannot issue or delete", async () => {
		expect((await call("POST", `${base()}/dunning`, { token: viewerToken, body: { customer: businessCustomer, invoices: [firstInvoice] } })).status).toBe(403);
		expect((await call("DELETE", `${base()}/dunning/${letterUuid}`, { token: viewerToken })).status).toBe(403);
	});

	test("deletes a letter", async () => {
		expect((await call("DELETE", `${base()}/dunning/${letterUuid}`, { token: ownerToken })).error).toBe(0);
		expect((await call("GET", `${base()}/dunning/${letterUuid}`, { token: ownerToken })).error).toBe(ErrorCode.DUNNING_LETTER_NOT_FOUND);
		const [lines] = (await Database`SELECT COUNT(*) AS count FROM dunning_letter_lines`) as { count: number }[];
		expect(Number(lines!.count)).toBe(0);
	});
});
