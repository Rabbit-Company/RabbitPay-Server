import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import { LANGUAGES, DEFAULT_LANGUAGE, TRANSLATION_KEYS, isLanguage, t, translator } from "../server/i18n";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.i18n.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { setProcessor } = await import("../server/payments/methods");

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

	const json = (await res.json()) as { error: number; info: string; data?: unknown };
	return { status: res.status, ...json };
}

let ownerToken = "";
let projectUuid = "";
let customerUuid = "";

const dueDate = () => Date.now() + 7 * 24 * 60 * 60 * 1000;

async function issueInvoice() {
	const created = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
		token: ownerToken,
		body: { customer: customerUuid, due_date: dueDate(), items: [{ description: "Delo", quantity: 1, unit_price: 10000, tax_rate: 22 }] },
	});

	await call("POST", `/api/v1/projects/${projectUuid}/invoices/${created.data.uuid}/open`, { token: ownerToken });
	return created.data.uuid as string;
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	await call("POST", "/api/v1/auth/register", { body: { email: "i18n-owner@example.com", password: password("i18n-owner") } });
	ownerToken = (await call("POST", "/api/v1/auth/login", { body: { email: "i18n-owner@example.com", password: password("i18n-owner") } })).data.token;

	projectUuid = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "sl-shop", currency: "EUR" } })).data.uuid;

	const customer = await call("POST", `/api/v1/projects/${projectUuid}/customers`, { token: ownerToken, body: { name: "Ada", email: "ada@example.com" } });
	customerUuid = customer.data.uuid;
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.i18n.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("the dictionaries", () => {
	test("every language carries every key, with nothing left blank", () => {
		expect(TRANSLATION_KEYS.length).toBeGreaterThan(50);

		for (const language of LANGUAGES) {
			for (const key of TRANSLATION_KEYS) {
				const translated = t(language.value, key);
				expect(typeof translated).toBe("string");
				expect(translated.trim().length).toBeGreaterThan(0);
			}
		}
	});

	test("no key is left as its own name, which is what a missing entry looks like", () => {
		for (const language of LANGUAGES) {
			for (const key of TRANSLATION_KEYS) expect(t(language.value, key)).not.toBe(key);
		}
	});

	test("Slovenian actually differs from English where it matters", () => {
		expect(t("sl", "invoice.title")).toBe("Račun");
		expect(t("sl", "invoice.total")).toBe("Skupaj");
		expect(t("sl", "bank.reference")).toBe("Sklic");
		expect(t("sl", "invoice.vat_number")).toBe("ID za DDV");
		expect(t("sl", "invoice.title")).not.toBe(t("en", "invoice.title"));
	});

	test("leaves brand names alone", () => {
		expect(t("sl", "qr.upn")).toBe("UPN QR");
		expect(t("sl", "qr.epc")).toBe("GiroCode");
		expect(t("sl", "bank.iban")).toBe("IBAN");
	});

	test("falls back to English for a language it does not know", () => {
		expect(t("de", "invoice.title")).toBe("Invoice");
		expect(t(null, "invoice.title")).toBe("Invoice");
		expect(t(undefined, "invoice.title")).toBe("Invoice");
	});

	test("fills in the values a sentence needs", () => {
		expect(t("en", "pay.amount_in", { ticker: "BTC" })).toBe("Amount in BTC");
		expect(t("sl", "pay.amount_in", { ticker: "BTC" })).toBe("Znesek v BTC");
		expect(t("sl", "pay.confirmations", { count: 2 })).toContain("2");
	});

	test("leaves a placeholder alone when nothing is given for it", () => {
		expect(t("en", "pay.amount_in", {})).toBe("Amount in {ticker}");
	});

	test("hands back a translator bound to one language", () => {
		const slovenian = translator("sl");
		expect(slovenian("invoice.notes")).toBe("Opombe");
	});
});

describe("choosing a language", () => {
	test("starts as English", async () => {
		const res = await call("GET", `/api/v1/projects/${projectUuid}`, { token: ownerToken });
		expect(res.data.language).toBe("en");
	});

	test("is saved and read back", async () => {
		const updated = await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { language: "sl" } });
		expect(updated.data.language).toBe("sl");
	});

	test("is refused when this server does not have it", async () => {
		expect((await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { language: "de" } })).error).toBe(1062);
		expect((await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { language: "" } })).error).toBe(1062);
	});

	test("is checked the same way by the validator", () => {
		expect(isLanguage("sl")).toBe(true);
		expect(isLanguage("en")).toBe(true);
		expect(isLanguage("de")).toBe(false);
		expect(isLanguage(7)).toBe(false);
		expect(DEFAULT_LANGUAGE).toBe("en");
	});

	test("leaves the other invoice settings alone", async () => {
		await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { date_format: "d. m. yyyy" } });
		await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { language: "sl" } });

		const res = await call("GET", `/api/v1/projects/${projectUuid}`, { token: ownerToken });
		expect(res.data.date_format).toBe("d. m. yyyy");
		expect(res.data.language).toBe("sl");
	});
});

describe("the language reaching what a customer sees", () => {
	test("travels with the printable invoice", async () => {
		const invoice = await issueInvoice();
		const res = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoice}/document`, { token: ownerToken });

		expect(res.data.language).toBe("sl");
	});

	test("travels to the payment page", async () => {
		const invoice = await issueInvoice();
		const res = await call("GET", `/api/v1/public/invoices/${invoice}`);

		expect(res.data.language).toBe("sl");
	});
});

describe("why a payment code is missing", () => {
	test("comes back as a reason the interface can translate, not as English prose", async () => {
		await setProcessor(projectUuid, "bank_transfer", true, { iban: "DE89370400440532013000" });

		const created = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { customer: customerUuid, currency: "USD", due_date: dueDate(), items: [{ description: "Delo", quantity: 1, unit_price: 10000, tax_rate: 0 }] },
		});
		await call("POST", `/api/v1/projects/${projectUuid}/invoices/${created.data.uuid}/open`, { token: ownerToken });

		const res = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${created.data.uuid}/document`, { token: ownerToken });

		expect(res.data.bank.qr_unavailable).toBe("not_euro");
		expect(t("sl", "qr.unavailable.not_euro")).toContain("evrih");
		expect(t("en", "qr.unavailable.not_euro")).toContain("euro");
	});

	test("says a mistyped IBAN is a checksum problem, in either language", async () => {
		await setProcessor(projectUuid, "bank_transfer", true, { iban: "SI56263300012039087" });

		const invoice = await issueInvoice();
		const res = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoice}/document`, { token: ownerToken });

		expect(res.data.bank.qr_unavailable).toBe("bad_iban");
		expect(t("sl", "qr.unavailable.bad_iban")).toContain("IBAN");

		await setProcessor(projectUuid, "bank_transfer", true, { iban: "SI56263300012039086" });
	});
});
