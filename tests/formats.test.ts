import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import {
	DATE_FORMATS,
	TIME_FORMATS,
	formatDate,
	formatDateTime,
	formatIban,
	formatMoneyIn,
	formatPercentIn,
	formatTime,
	isDateFormat,
	isTimeFormat,
	type DateFormat,
	type TimeFormat,
} from "../server/formats";
import { ACCENT_PRESETS, BRAND_BLUE, accentTextFor, isAccentColor } from "../server/colors";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.formats.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");

await Server.configure();

const password = (seed: string) => new Bun.CryptoHasher("blake2b512").update(seed).digest("hex");

const AFTERNOON = new Date(2026, 8, 16, 14, 5, 0).getTime();
const MORNING = new Date(2026, 0, 3, 9, 7, 0).getTime();
const MIDNIGHT = new Date(2026, 8, 16, 0, 30, 0).getTime();
const NOON = new Date(2026, 8, 16, 12, 30, 0).getTime();

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

let ownerToken = "";
let projectUuid = "";
let customerUuid = "";

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	await call("POST", "/api/v1/auth/register", { body: { username: "fmt-owner", email: "fmt@example.com", password: password("fmt-owner") } });
	ownerToken = (await call("POST", "/api/v1/auth/login", { body: { username: "fmt-owner", password: password("fmt-owner") } })).data.token;

	const project = await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "fmt-shop", currency: "EUR" } });
	projectUuid = project.data.uuid;

	const customer = await call("POST", `/api/v1/projects/${projectUuid}/customers`, { token: ownerToken, body: { name: "Ada", email: "ada@example.com" } });
	customerUuid = customer.data.uuid;
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.formats.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("writing an amount", () => {
	test("groups thousands from four digits, the way Slovenian invoices do", () => {
		expect(formatMoneyIn(120000, "EUR", "sl").replace(/\s/g, " ")).toBe("1.200,00 €");
		expect(formatMoneyIn(99950, "EUR", "sl").replace(/\s/g, " ")).toBe("999,50 €");
		expect(formatMoneyIn(1234567890, "EUR", "sl").replace(/\s/g, " ")).toBe("12.345.678,90 €");
		expect(formatMoneyIn(120000, "EUR", "en")).toBe("€1,200.00");
	});
});

describe("writing a tax rate", () => {
	test("follows Slovenian convention with a decimal comma and a space before the sign", () => {
		expect(formatPercentIn(9.5, "sl").replace(/\s/g, " ")).toBe("9,5 %");
		expect(formatPercentIn(22, "sl").replace(/\s/g, " ")).toBe("22 %");
		expect(formatPercentIn(8.25, "sl").replace(/\s/g, " ")).toBe("8,25 %");
	});

	test("keeps the English form without a space", () => {
		expect(formatPercentIn(9.5, "en")).toBe("9.5%");
		expect(formatPercentIn(0, "en")).toBe("0%");
	});
});

describe("writing a date", () => {
	test("reads the way each country writes it", () => {
		expect(formatDate(AFTERNOON, "d. m. yyyy")).toBe("16. 9. 2026");
		expect(formatDate(AFTERNOON, "dd.mm.yyyy")).toBe("16.09.2026");
		expect(formatDate(AFTERNOON, "dd/mm/yyyy")).toBe("16/09/2026");
		expect(formatDate(AFTERNOON, "mm/dd/yyyy")).toBe("09/16/2026");
		expect(formatDate(AFTERNOON, "yyyy-mm-dd")).toBe("2026-09-16");
	});

	test("pads a single digit day and month only where the format asks", () => {
		expect(formatDate(MORNING, "d. m. yyyy")).toBe("3. 1. 2026");
		expect(formatDate(MORNING, "dd.mm.yyyy")).toBe("03.01.2026");
		expect(formatDate(MORNING, "yyyy-mm-dd")).toBe("2026-01-03");
	});

	test("never confuses day with month", () => {
		expect(formatDate(MORNING, "dd/mm/yyyy")).toBe("03/01/2026");
		expect(formatDate(MORNING, "mm/dd/yyyy")).toBe("01/03/2026");
	});

	test("shows a dash rather than 1970 when there is no date", () => {
		expect(formatDate(null, "yyyy-mm-dd")).toBe("-");
		expect(formatDate(0, "yyyy-mm-dd")).toBe("-");
		expect(formatDate(undefined, "yyyy-mm-dd")).toBe("-");
	});

	test("every offered format produces something different from the others", () => {
		const written = DATE_FORMATS.filter((entry) => entry.value !== "auto").map((entry) => formatDate(AFTERNOON, entry.value));
		expect(new Set(written).size).toBe(written.length);
	});
});

describe("writing a time", () => {
	test("uses a 24 hour clock when asked", () => {
		expect(formatTime(AFTERNOON, "24")).toBe("14:05");
		expect(formatTime(MORNING, "24")).toBe("09:07");
	});

	test("uses a 12 hour clock when asked", () => {
		expect(formatTime(AFTERNOON, "12")).toBe("2:05 PM");
		expect(formatTime(MORNING, "12")).toBe("9:07 AM");
	});

	test("gets midnight and noon right, where 12 hour clocks usually go wrong", () => {
		expect(formatTime(MIDNIGHT, "12")).toBe("12:30 AM");
		expect(formatTime(NOON, "12")).toBe("12:30 PM");
		expect(formatTime(MIDNIGHT, "24")).toBe("00:30");
		expect(formatTime(NOON, "24")).toBe("12:30");
	});
});

describe("writing a date and time together", () => {
	test("joins the two chosen formats", () => {
		expect(formatDateTime(AFTERNOON, "d. m. yyyy", "24")).toBe("16. 9. 2026 14:05");
		expect(formatDateTime(AFTERNOON, "mm/dd/yyyy", "12")).toBe("09/16/2026 2:05 PM");
	});

	test("falls back to the reader's device only when both are auto", () => {
		expect(formatDateTime(AFTERNOON, "auto", "24")).toContain("14:05");
		expect(formatDateTime(null, "auto", "auto")).toBe("-");
	});
});

describe("checking a format a caller sent", () => {
	test("accepts the ones on offer", () => {
		for (const entry of DATE_FORMATS) expect(isDateFormat(entry.value)).toBe(true);
		for (const entry of TIME_FORMATS) expect(isTimeFormat(entry.value)).toBe(true);
	});

	test("refuses anything else", () => {
		expect(isDateFormat("dd-mm-yyyy")).toBe(false);
		expect(isDateFormat("")).toBe(false);
		expect(isDateFormat(7)).toBe(false);
		expect(isTimeFormat("48")).toBe(false);
	});
});

describe("a project's chosen format", () => {
	test("starts as the reader's device for dates and a 24 hour clock", async () => {
		const res = await call("GET", `/api/v1/projects/${projectUuid}`, { token: ownerToken });

		expect(res.data.date_format).toBe("auto");
		expect(res.data.time_format).toBe("24");
		expect(res.data.timezone).toBe("Europe/Ljubljana");
	});

	test("saves a valid accounting timezone and rejects an unknown one", async () => {
		const updated = await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { timezone: "Europe/Ljubljana" } });
		expect(updated.data.timezone).toBe("Europe/Ljubljana");
		expect((await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { timezone: "Mars/Olympus" } })).error).toBe(1127);
	});

	test("is saved and read back", async () => {
		const updated = await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { date_format: "d. m. yyyy", time_format: "12" } });

		expect(updated.data.date_format).toBe("d. m. yyyy");
		expect(updated.data.time_format).toBe("12");
	});

	test("is refused when it is not one this server offers", async () => {
		expect((await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { date_format: "dd-mm-yyyy" } })).error).toBe(1060);
		expect((await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { time_format: "48" } })).error).toBe(1060);
	});

	test("leaves the other project settings alone", async () => {
		await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { date_format: "dd.mm.yyyy" } });
		const res = await call("GET", `/api/v1/projects/${projectUuid}`, { token: ownerToken });

		expect(res.data.name).toBe("fmt-shop");
		expect(res.data.currency).toBe("EUR");
		expect(res.data.time_format).toBe("12");
	});
});

describe("the format reaching a document", () => {
	async function issueInvoice() {
		const created = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { customer: customerUuid, due_date: Date.now() + 86400000, items: [{ description: "Work", quantity: 1, unit_price: 1000, tax_rate: 0 }] },
		});

		await call("POST", `/api/v1/projects/${projectUuid}/invoices/${created.data.uuid}/open`, { token: ownerToken });
		return created.data.uuid as string;
	}

	test("travels with the printable invoice", async () => {
		await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { date_format: "d. m. yyyy", time_format: "24" } });

		const invoice = await issueInvoice();
		const res = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoice}/document`, { token: ownerToken });

		expect(res.data.formats.date).toBe("d. m. yyyy");
		expect(res.data.formats.time).toBe("24");
		expect(res.data.formats.timezone).toBe("Europe/Ljubljana");
		expect((await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { timezone: "UTC" } })).error).toBe(1131);
	});

	test("travels to the page a customer pays from", async () => {
		const invoice = await issueInvoice();
		const res = await call("GET", `/api/v1/public/invoices/${invoice}`);

		expect(res.data.date_format).toBe("d. m. yyyy");
	});

	test("means the same invoice reads the same to everyone who opens it", async () => {
		const invoice = await issueInvoice();
		const document_ = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoice}/document`, { token: ownerToken });

		const issued = document_.data.invoice.issued;
		const merchantSees = formatDate(issued, document_.data.formats.date as DateFormat);
		const customerSees = formatDate(issued, (await call("GET", `/api/v1/public/invoices/${invoice}`)).data.date_format as DateFormat);

		expect(customerSees).toBe(merchantSees);
	});
});

describe("the formats on offer", () => {
	test("include the Slovenian one this was asked for", () => {
		expect(DATE_FORMATS.map((entry) => entry.value)).toContain("d. m. yyyy");
	});

	test("are all understood by the validator and the formatter", () => {
		for (const entry of DATE_FORMATS) {
			expect(isDateFormat(entry.value)).toBe(true);
			expect(formatDate(AFTERNOON, entry.value as DateFormat)).not.toBe("-");
		}

		for (const entry of TIME_FORMATS) {
			expect(isTimeFormat(entry.value)).toBe(true);
			expect(formatTime(AFTERNOON, entry.value as TimeFormat)).not.toBe("-");
		}
	});

	test("label each numeric one with the date it actually produces", () => {
		for (const entry of DATE_FORMATS) {
			if (entry.value === "auto") continue;
			expect(entry.label).toBe(formatDate(AFTERNOON, entry.value));
		}
	});
});

describe("a project's accent color", () => {
	test("starts unset so the default blue is used", async () => {
		const res = await call("GET", `/api/v1/projects/${projectUuid}`, { token: ownerToken });

		expect(res.data.accent_color).toBeNull();
	});

	test("is saved in lowercase and read back", async () => {
		const updated = await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { accent_color: "#0D9488" } });

		expect(updated.error).toBe(0);
		expect(updated.data.accent_color).toBe("#0d9488");
		expect(updated.data.currency).toBe("EUR");
	});

	test("travels to the page a customer pays from", async () => {
		const created = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { customer: customerUuid, due_date: Date.now() + 86400000, items: [{ description: "Work", quantity: 1, unit_price: 1000, tax_rate: 0 }] },
		});
		await call("POST", `/api/v1/projects/${projectUuid}/invoices/${created.data.uuid}/open`, { token: ownerToken });

		const res = await call("GET", `/api/v1/public/invoices/${created.data.uuid}`);

		expect(res.data.accent_color).toBe("#0d9488");
	});

	test("is refused when it is not a six digit hex color", async () => {
		for (const accent_color of ["blue", "#fff", "4f46e5", "#4f46e5ff", "#zzzzzz", 42]) {
			expect((await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { accent_color } })).error).toBe(1063);
		}
	});

	test("goes back to the default when cleared", async () => {
		const updated = await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { accent_color: null } });

		expect(updated.data.accent_color).toBeNull();
	});

	test("gets readable text on top of it", () => {
		expect(accentTextFor(BRAND_BLUE)).toBe("#ffffff");
		expect(accentTextFor("#1f2937")).toBe("#ffffff");
		expect(accentTextFor("#fde047")).toBe("#111827");
		expect(accentTextFor("#ffffff")).toBe("#111827");
	});

	test("offers presets the validator accepts", () => {
		for (const preset of ACCENT_PRESETS) expect(isAccentColor(preset.value)).toBe(true);
		expect(ACCENT_PRESETS.map((preset) => preset.value)).toContain(BRAND_BLUE);
	});
});

describe("IBAN display", () => {
	test("groups the account number in fours", () => {
		expect(formatIban("SI56040010048886437")).toBe("SI56 0400 1004 8886 437");
		expect(formatIban("de89 3704 0044 0532 0130 00")).toBe("DE89 3704 0044 0532 0130 00");
		expect(formatIban("  BE71096123456769 ")).toBe("BE71 0961 2345 6769");
	});
});
