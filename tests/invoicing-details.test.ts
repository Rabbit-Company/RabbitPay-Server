import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.details.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { displayNameOf, addressLines } = await import("../server/company");
const { ErrorCode } = await import("../server/errors");
const { bankInstruction, chooseFormat, isPlausibleIban, normalizeIban, majorUnits } = await import("../server/payments/bank");
const { setProcessor } = await import("../server/payments/methods");
const { creditorReference, formatReference, isCreditorReference } = await import("../server/payments/reference");

await Server.configure();

const password = (seed: string) => new Bun.CryptoHasher("blake2b512").update(seed).digest("hex");

const GERMAN_IBAN = "DE89370400440532013000";
const SLOVENIAN_IBAN = "SI56263300012039086";

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

const COMPANY = {
	legal_name: "Bloggy d.o.o.",
	address_line1: "Dunajska cesta 1",
	address_line2: null,
	postal_code: "1000",
	city: "Ljubljana",
	state: null,
	country: "SI",
	vat_number: "SI12345678",
	tax_number: null,
	registration_number: "1234567000",
	email: "racuni@example.com",
	phone: null,
	website: null,
	footer_note: null,
};

let ownerToken = "";
let viewerToken = "";
let projectUuid = "";
let customerUuid = "";

const dueDate = () => Date.now() + 7 * 24 * 60 * 60 * 1000;

async function issueInvoice(unitPrice = 4900, taxRate = 0) {
	const created = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
		token: ownerToken,
		body: { customer: customerUuid, due_date: dueDate(), items: [{ description: "Annual plan", quantity: 1, unit_price: unitPrice, tax_rate: taxRate }] },
	});

	await call("POST", `/api/v1/projects/${projectUuid}/invoices/${created.data.uuid}/open`, { token: ownerToken });
	return created.data.uuid as string;
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	await call("POST", "/api/v1/auth/register", { body: { email: "doc-owner@example.com", password: password("doc-owner") } });
	await call("POST", "/api/v1/auth/register", { body: { email: "doc-viewer@example.com", password: password("doc-viewer") } });

	ownerToken = (await call("POST", "/api/v1/auth/login", { body: { email: "doc-owner@example.com", password: password("doc-owner") } })).data.token;
	viewerToken = (await call("POST", "/api/v1/auth/login", { body: { email: "doc-viewer@example.com", password: password("doc-viewer") } })).data.token;

	const project = await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "bloggy", currency: "EUR" } });
	projectUuid = project.data.uuid;

	const customer = await call("POST", `/api/v1/projects/${projectUuid}/customers`, {
		token: ownerToken,
		body: {
			name: "Ada Lovelace",
			email: "ada@example.com",
			address_line1: "1 Analytical Way",
			postal_code: "1000",
			city: "Ljubljana",
			vat_number: "SI99999999",
		},
	});
	customerUuid = customer.data.uuid;
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.details.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("the name a customer sees", () => {
	test("falls back to the project name when nothing is chosen", () => {
		expect(displayNameOf({ name: "bloggy", display_name: null })).toBe("bloggy");
		expect(displayNameOf({ name: "bloggy", display_name: "   " })).toBe("bloggy");
	});

	test("uses the display name once it is set", () => {
		expect(displayNameOf({ name: "bloggy", display_name: "Bloggy" })).toBe("Bloggy");
	});

	test("is saved and returned by the API", async () => {
		const updated = await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { display_name: "Bloggy" } });

		expect(updated.data.display_name).toBe("Bloggy");
		expect(updated.data.public_name).toBe("Bloggy");
	});

	test("reaches the public payment page", async () => {
		const invoice = await issueInvoice();
		const res = await call("GET", `/api/v1/public/invoices/${invoice}`);

		expect(res.data.merchant).toBe("Bloggy");
	});

	test("clears back to the project name when emptied", async () => {
		await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { display_name: "" } });
		const res = await call("GET", `/api/v1/projects/${projectUuid}`, { token: ownerToken });

		expect(res.data.display_name).toBeNull();
		expect(res.data.public_name).toBe("bloggy");

		await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { display_name: "Bloggy" } });
	});
});

describe("company details", () => {
	test("start empty", async () => {
		const res = await call("GET", `/api/v1/projects/${projectUuid}/company`, { token: ownerToken });

		expect(res.error).toBe(0);
		expect(res.data.legal_name).toBeNull();
		expect(res.data.vat_number).toBeNull();
	});

	test("are saved and read back", async () => {
		const saved = await call("PUT", `/api/v1/projects/${projectUuid}/company`, { token: ownerToken, body: COMPANY });

		expect(saved.error).toBe(0);
		expect(saved.data.legal_name).toBe("Bloggy d.o.o.");

		const read = await call("GET", `/api/v1/projects/${projectUuid}/company`, { token: ownerToken });
		expect(read.data.vat_number).toBe("SI12345678");
		expect(read.data.registration_number).toBe("1234567000");
	});

	test("change one field without losing the others", async () => {
		await call("PUT", `/api/v1/projects/${projectUuid}/company`, { token: ownerToken, body: { phone: "+386 1 234 5678" } });
		const res = await call("GET", `/api/v1/projects/${projectUuid}/company`, { token: ownerToken });

		expect(res.data.phone).toBe("+386 1 234 5678");
		expect(res.data.legal_name).toBe("Bloggy d.o.o.");
	});

	test("treat a blank string as clearing the field", async () => {
		await call("PUT", `/api/v1/projects/${projectUuid}/company`, { token: ownerToken, body: { phone: "  " } });
		const res = await call("GET", `/api/v1/projects/${projectUuid}/company`, { token: ownerToken });

		expect(res.data.phone).toBeNull();
	});

	test("cannot be changed by someone outside the project", async () => {
		const res = await call("PUT", `/api/v1/projects/${projectUuid}/company`, { token: viewerToken, body: { legal_name: "Not mine" } });
		expect(res.error).not.toBe(0);
	});

	test("keeps the country as a code and rejects anything that is not one", async () => {
		const lowered = await call("PUT", `/api/v1/projects/${projectUuid}/company`, { token: ownerToken, body: { country: "si" } });
		expect(lowered.data.country).toBe("SI");

		const named = await call("PUT", `/api/v1/projects/${projectUuid}/company`, { token: ownerToken, body: { country: "Slovenia" } });
		expect(named.error).toBe(ErrorCode.INVALID_COUNTRY_CODE);
	});

	test("build an address a human would write", () => {
		expect(addressLines({ ...COMPANY })).toEqual(["Dunajska cesta 1", "1000 Ljubljana", "SI"]);
		expect(addressLines({ ...COMPANY }, "en")).toEqual(["Dunajska cesta 1", "1000 Ljubljana", "Slovenia"]);
		expect(addressLines({ ...COMPANY }, "sl")).toEqual(["Dunajska cesta 1", "1000 Ljubljana", "Slovenija"]);
	});
});

describe("reading an IBAN", () => {
	test("strips the spaces people type", () => {
		expect(normalizeIban("si56 2633 0001 2039 086")).toBe(SLOVENIAN_IBAN);
	});

	test("accepts a real one and rejects a mistyped one", () => {
		expect(isPlausibleIban(SLOVENIAN_IBAN)).toBe(true);
		expect(isPlausibleIban(GERMAN_IBAN)).toBe(true);
		expect(isPlausibleIban("SI56263300012039087")).toBe(false);
		expect(isPlausibleIban("not an iban")).toBe(false);
	});
});

describe("choosing a payment code", () => {
	test("reads a Slovenian account as UPN and the rest of SEPA as GiroCode", () => {
		expect(chooseFormat("auto", SLOVENIAN_IBAN, "EUR")).toBe("upn");
		expect(chooseFormat("auto", GERMAN_IBAN, "EUR")).toBe("epc");
	});

	test("makes no code outside the euro", () => {
		expect(chooseFormat("auto", GERMAN_IBAN, "USD")).toBeNull();
		expect(chooseFormat("epc", GERMAN_IBAN, "GBP")).toBeNull();
	});

	test("honours a merchant who picked one", () => {
		expect(chooseFormat("upn", GERMAN_IBAN, "EUR")).toBe("upn");
		expect(chooseFormat("none", SLOVENIAN_IBAN, "EUR")).toBeNull();
	});
});

describe("the bank transfer instruction", () => {
	const base = { company: COMPANY, merchant: "Bloggy", reference: "ABC123", totalMinorUnits: 4900, currency: "EUR", language: "en" };

	test("needs an IBAN before it offers anything", () => {
		expect(bankInstruction({ ...base, config: {} })).toBeNull();
	});

	test("names the company when no account holder is given", () => {
		const instruction = bankInstruction({ ...base, config: { iban: SLOVENIAN_IBAN } })!;
		expect(instruction.account.holder).toBe("Bloggy d.o.o.");
	});

	test("prefers an account holder the merchant typed", () => {
		const instruction = bankInstruction({ ...base, config: { iban: SLOVENIAN_IBAN, account_holder: "Bloggy Trading" } })!;
		expect(instruction.account.holder).toBe("Bloggy Trading");
	});

	test("a UPN payload names a long sole trader without the activity", () => {
		const holder = "JAGER SIMONCA ZAJC S.P. RAČUNOVODSKE, KNJIGOVODSKE STORITVE";
		const instruction = bankInstruction({ ...base, config: { iban: SLOVENIAN_IBAN, account_holder: holder } })!;

		expect(instruction.account.holder).toBe(holder);
		expect(instruction.qr!.payload).toContain("\nJAGER SIMONCA ZAJC S.P.\n");
		expect(instruction.qr!.payload).not.toContain("RAČUNOVOD");
	});

	test("builds a UPN payload carrying the amount in cents", () => {
		const instruction = bankInstruction({ ...base, config: { iban: SLOVENIAN_IBAN } })!;

		expect(instruction.qr?.format).toBe("upn");
		expect(instruction.qr?.encoding).toBe("latin2");
		expect(instruction.qr!.payload.startsWith("UPNQR")).toBe(true);
		expect(instruction.qr!.payload).toContain("00000004900");
		expect(instruction.qr!.payload).toContain(SLOVENIAN_IBAN);
		expect(instruction.qr!.payload).toContain("Invoice ABC123");
	});

	test("writes the payment purpose in the invoice language", () => {
		const upn = bankInstruction({ ...base, reference: "001/26", language: "sl", config: { iban: SLOVENIAN_IBAN } })!;
		expect(upn.qr!.payload).toContain("Račun 001/26");
		expect(upn.qr!.payload).not.toContain("Invoice");

		const giro = bankInstruction({ ...base, reference: "001/26", language: "sl", config: { iban: GERMAN_IBAN } })!;
		expect(giro.qr!.payload).toContain("Račun 001/26");
	});

	test("builds a GiroCode for a German account", () => {
		const instruction = bankInstruction({ ...base, config: { iban: GERMAN_IBAN } })!;

		expect(instruction.qr?.format).toBe("epc");
		expect(instruction.qr?.encoding).toBe("utf8");
		expect(instruction.qr!.payload.startsWith("BCD")).toBe(true);
		expect(instruction.qr!.payload).toContain("EUR49.00");
	});

	test("says why there is no code when the invoice is not in euro", () => {
		const instruction = bankInstruction({ ...base, currency: "USD", config: { iban: GERMAN_IBAN } })!;

		expect(instruction.qr).toBeNull();
		expect(instruction.qr_unavailable).toBe("not_euro");
	});

	test("says why there is no code when the IBAN is mistyped", () => {
		const instruction = bankInstruction({ ...base, config: { iban: "SI56263300012039087" } })!;

		expect(instruction.qr).toBeNull();
		expect(instruction.qr_unavailable).toBe("bad_iban");
	});

	test("stays quiet when the merchant asked for no code", () => {
		const instruction = bankInstruction({ ...base, config: { iban: SLOVENIAN_IBAN, qr_format: "none" } })!;

		expect(instruction.qr).toBeNull();
		expect(instruction.qr_unavailable).toBeNull();
	});

	test("converts minor units for a currency with no decimals", () => {
		expect(majorUnits(4900, "EUR")).toBeCloseTo(49, 10);
		expect(majorUnits(5000, "JPY")).toBeCloseTo(5000, 10);
	});
});

describe("the printable document", () => {
	test("carries both parties, the items and the totals", async () => {
		const invoice = await issueInvoice(10000, 22);
		const res = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoice}/document`, { token: ownerToken });

		expect(res.error).toBe(0);
		expect(res.data.seller.legal_name).toBe("Bloggy d.o.o.");
		expect(res.data.seller.vat_number).toBe("SI12345678");
		expect(res.data.seller.name).toBe("Bloggy");
		expect(res.data.buyer.name).toBe("Ada Lovelace");
		expect(res.data.buyer.vat_number).toBe("SI99999999");
		expect(res.data.items).toHaveLength(1);
		expect(res.data.invoice.total_amount).toBe(12200);
		expect(res.data.invoice.tax_amount).toBe(2200);
		expect(res.data.invoice.due_date).toBeGreaterThan(Date.now());
		expect(res.data.pay_url).toContain(`/pay/${invoice}`);
	});

	test("offers a bank block once an IBAN is configured", async () => {
		await setProcessor(projectUuid, "bank_transfer", true, { iban: SLOVENIAN_IBAN });

		const invoice = await issueInvoice();
		const res = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoice}/document`, { token: ownerToken });

		expect(res.data.bank.account.iban).toBe(SLOVENIAN_IBAN);
		expect(res.data.bank.qr.format).toBe("upn");
		expect(res.data.bank.reference).toBe(creditorReference(res.data.invoice.reference));
		expect(res.data.bank.qr.payload.split("\n")).toContain(res.data.bank.reference);
		expect(res.data.bank.qr.payload).toContain(res.data.invoice.reference);
	});

	test("leaves the bank block out when the method is switched off", async () => {
		await setProcessor(projectUuid, "bank_transfer", false, {});

		const invoice = await issueInvoice();
		const res = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoice}/document`, { token: ownerToken });

		expect(res.data.bank).toBeNull();

		await setProcessor(projectUuid, "bank_transfer", true, { iban: SLOVENIAN_IBAN });
	});

	test("keeps issued seller and payment settings after the project changes", async () => {
		await call("PUT", `/api/v1/projects/${projectUuid}/company`, {
			token: ownerToken,
			body: { legal_name: "Original Seller d.o.o.", address_line1: "Old Street 1", footer_note: "Original footer" },
		});
		await setProcessor(projectUuid, "bank_transfer", true, { iban: SLOVENIAN_IBAN, account_holder: "Original Seller" });
		const invoice = await issueInvoice(10000);
		const firstDocument = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoice}/document`, { token: ownerToken });
		const firstPdf = await Server.app.handle(
			new Request(`http://127.0.0.1/api/v1/projects/${projectUuid}/invoices/${invoice}/pdf`, { headers: { Authorization: `Bearer ${ownerToken}` } })
		);
		const firstBytes = new Uint8Array(await firstPdf.arrayBuffer());

		await call("PUT", `/api/v1/projects/${projectUuid}/company`, {
			token: ownerToken,
			body: { legal_name: "Changed Seller d.o.o.", address_line1: "New Street 2", footer_note: "Changed footer" },
		});
		await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { language: "sl", invoice_issuer_details: false } });
		await setProcessor(projectUuid, "bank_transfer", true, { iban: "DE89370400440532013000", account_holder: "Changed Seller" });

		const secondDocument = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoice}/document`, { token: ownerToken });
		const secondPdf = await Server.app.handle(
			new Request(`http://127.0.0.1/api/v1/projects/${projectUuid}/invoices/${invoice}/pdf`, { headers: { Authorization: `Bearer ${ownerToken}` } })
		);
		const secondBytes = new Uint8Array(await secondPdf.arrayBuffer());

		expect(secondDocument.data.seller).toEqual(firstDocument.data.seller);
		expect(secondDocument.data.language).toBe(firstDocument.data.language);
		expect(secondDocument.data.bank.account).toEqual(firstDocument.data.bank.account);
		expect(new Bun.CryptoHasher("sha256").update(secondBytes).digest("hex")).toBe(new Bun.CryptoHasher("sha256").update(firstBytes).digest("hex"));
		const [archive] = (await Database`SELECT status, byte_size, sha256 FROM invoice_documents WHERE invoice = ${invoice}`) as {
			status: string;
			byte_size: number;
			sha256: string;
		}[];
		expect(archive.status).toBe("ready");
		expect(archive.byte_size).toBe(firstBytes.byteLength);
		expect(archive.sha256).toBe(new Bun.CryptoHasher("sha256").update(firstBytes).digest("hex"));

		await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: ownerToken, body: { language: "en", invoice_issuer_details: true } });
		await setProcessor(projectUuid, "bank_transfer", true, { iban: SLOVENIAN_IBAN, account_holder: "" });
	});

	test("refuses to replace an archived invoice that fails its integrity check", async () => {
		const { documentStorage } = await import("../server/document-storage");
		const invoice = await issueInvoice(10000);
		const pdf = () =>
			Server.app.handle(
				new Request(`http://127.0.0.1/api/v1/projects/${projectUuid}/invoices/${invoice}/pdf`, { headers: { Authorization: `Bearer ${ownerToken}` } })
			);
		const original = new Uint8Array(await (await pdf()).arrayBuffer());
		const archiveRow = async () =>
			(
				(await Database`SELECT storage_key, status, sha256, last_error FROM invoice_documents WHERE invoice = ${invoice}`) as {
					storage_key: string;
					status: string;
					sha256: string;
					last_error: string | null;
				}[]
			)[0];
		const archived = await archiveRow();

		await documentStorage().put(archived.storage_key, new Uint8Array([1, 2, 3]), "application/pdf");
		const tampered = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoice}/pdf`, { token: ownerToken });
		expect(tampered.error).toBe(ErrorCode.DOCUMENT_ARCHIVE_DAMAGED);
		expect(await archiveRow()).toMatchObject({ storage_key: archived.storage_key, status: "ready", sha256: archived.sha256 });
		expect((await archiveRow()).last_error).toContain("checksum");

		await documentStorage().remove(archived.storage_key);
		const missing = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoice}/pdf`, { token: ownerToken });
		expect(missing.error).toBe(ErrorCode.DOCUMENT_ARCHIVE_DAMAGED);
		expect(await archiveRow()).toMatchObject({ storage_key: archived.storage_key, status: "ready", sha256: archived.sha256 });

		await documentStorage().put(archived.storage_key, original, "application/pdf");
		const restored = new Uint8Array(await (await pdf()).arrayBuffer());
		expect(new Bun.CryptoHasher("sha256").update(restored).digest("hex")).toBe(archived.sha256);
		expect((await archiveRow()).last_error).toBeNull();
	});

	test("asks the customer for what is still owed, not the whole invoice", async () => {
		const invoice = await issueInvoice(10000);
		await call("POST", `/api/v1/projects/${projectUuid}/transactions`, {
			token: ownerToken,
			body: { invoice, processor: "bank_transfer", amount: 4000 },
		});

		const res = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoice}/document`, { token: ownerToken });

		expect(res.data.invoice.outstanding).toBe(6000);
		expect(res.data.bank.amount).toBe(6000);
		expect(res.data.bank.qr.payload).toContain("00000006000");
	});

	test("drops the bank block once nothing is owed, so a paid invoice cannot be paid twice", async () => {
		const invoice = await issueInvoice(10000);
		await call("POST", `/api/v1/projects/${projectUuid}/transactions`, {
			token: ownerToken,
			body: { invoice, processor: "bank_transfer", amount: 10000 },
		});

		const res = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoice}/document`, { token: ownerToken });

		expect(res.data.invoice.outstanding).toBe(0);
		expect(res.data.bank).toBeNull();
	});

	test("turns an invoice number into an RF creditor reference a bank accepts", () => {
		expect(creditorReference("539007547034")).toBe("RF18539007547034");
		expect(formatReference("RF18539007547034")).toBe("RF18 5390 0754 7034");
		expect(creditorReference("2026-00042")).toBe("RF89202600042");
		expect(creditorReference("PP1-SPLET-3")).toBe("RF482525128252114293");
		expect(creditorReference("ABC123")).toBe("RF47101112123");
		expect(isCreditorReference(creditorReference("2026-00042")!)).toBe(true);
		expect(isCreditorReference("RF19539007547034")).toBe(false);
		expect(creditorReference("A".repeat(22))).toBeNull();
		expect(formatReference("2026-00042")).toBe("2026-00042");
	});

	test("offers no online payment code when only bank transfer is on", async () => {
		const invoice = await issueInvoice();
		const res = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoice}/document`, { token: ownerToken });

		expect(res.data.bank).not.toBeNull();
		expect(res.data.online).toEqual({ card: false, crypto: false });
		expect(res.data.pay_qr).toBeNull();
	});

	test("says which online methods the payment code leads to", async () => {
		await setProcessor(projectUuid, "stripe", true, { secret_key: "sk_test_x", webhook_secret: "whsec_x" });
		const invoice = await issueInvoice();
		const res = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoice}/document`, { token: ownerToken });

		expect(res.data.online).toEqual({ card: true, crypto: false });
		expect(res.data.pay_qr).not.toBeNull();
	});

	test("carries a scannable link to the payment page instead of a printed URL", async () => {
		const invoice = await issueInvoice();
		const res = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoice}/document`, { token: ownerToken });

		expect(res.data.pay_qr.payload).toBe(res.data.pay_url);
		expect(res.data.pay_qr.encoding).toBe("utf8");
		expect(res.data.pay_qr.payload).toContain(`/pay/${invoice}`);
	});

	test("leaves the link out of a draft, which nobody can pay yet", async () => {
		const created = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { customer: customerUuid, due_date: dueDate(), items: [{ description: "Draft", quantity: 1, unit_price: 1000, tax_rate: 0 }] },
		});

		const res = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${created.data.uuid}/document`, { token: ownerToken });
		expect(res.data.pay_qr).toBeNull();
	});

	test("leaves the link out once the invoice is settled", async () => {
		const invoice = await issueInvoice(10000);
		await call("POST", `/api/v1/projects/${projectUuid}/transactions`, {
			token: ownerToken,
			body: { invoice, processor: "bank_transfer", amount: 10000 },
		});

		const res = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoice}/document`, { token: ownerToken });

		expect(res.data.invoice.outstanding).toBe(0);
		expect(res.data.pay_qr).toBeNull();
	});

	test("is refused for an invoice that is not there", async () => {
		expect((await call("GET", `/api/v1/projects/${projectUuid}/invoices/${crypto.randomUUID()}/document`, { token: ownerToken })).error).toBe(1035);
	});

	test("is refused to someone outside the project", async () => {
		const invoice = await issueInvoice();
		expect((await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoice}/document`, { token: viewerToken })).error).not.toBe(0);
	});
});

describe("paying by bank transfer from the payment page", () => {
	test("is offered once an IBAN is set", async () => {
		const invoice = await issueInvoice();
		const res = await call("GET", `/api/v1/public/invoices/${invoice}`);

		expect(res.data.methods.map((method: any) => method.processor)).toContain("bank_transfer");
	});

	test("returns the account, the reference and a payment code", async () => {
		const invoice = await issueInvoice();
		const res = await call("POST", `/api/v1/public/invoices/${invoice}/pay/bank_transfer`, { body: {} });

		expect(res.error).toBe(0);
		expect(res.data.kind).toBe("bank");
		expect(res.data.account.iban).toBe(SLOVENIAN_IBAN);
		expect(res.data.qr.format).toBe("upn");
		const issued = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${invoice}`, { token: ownerToken });
		expect(res.data.reference).toBe(creditorReference(issued.data.reference));
		expect(res.data.reference).toMatch(/^RF\d{4,23}$/);
	});

	test("never leaks the IBAN of a project that has not switched it on", async () => {
		await setProcessor(projectUuid, "bank_transfer", false, {});

		const invoice = await issueInvoice();
		const res = await call("POST", `/api/v1/public/invoices/${invoice}/pay/bank_transfer`, { body: {} });

		expect(res.error).toBe(1054);
		expect(JSON.stringify(res)).not.toContain(SLOVENIAN_IBAN);

		await setProcessor(projectUuid, "bank_transfer", true, { iban: SLOVENIAN_IBAN });
	});
});

describe("characters a UPN QR cannot carry", () => {
	const base = { merchant: "Bloggy", reference: "ABC123", totalMinorUnits: 4900, currency: "EUR", language: "en" };
	const withName = (legal_name: string) => ({ ...COMPANY, legal_name });

	test("accepts the Slovenian alphabet", () => {
		const instruction = bankInstruction({ ...base, company: withName("Trgovina Čevlji d.o.o."), config: { iban: SLOVENIAN_IBAN } })!;

		expect(instruction.qr).not.toBeNull();
		expect(instruction.qr!.payload).toContain("Čevlji");
	});

	test("refuses rather than shipping a code nothing can draw", () => {
		const instruction = bankInstruction({ ...base, company: withName("Здравствуйте OOO"), config: { iban: SLOVENIAN_IBAN } })!;

		expect(instruction.qr).toBeNull();
		expect(instruction.qr_unavailable).toBe("unsupported_characters");
	});

	test("still makes a GiroCode for the same name, since that one is UTF-8", () => {
		const instruction = bankInstruction({ ...base, company: withName("Здравствуйте OOO"), config: { iban: SLOVENIAN_IBAN, qr_format: "epc" } })!;

		expect(instruction.qr?.format).toBe("epc");
		expect(instruction.qr_unavailable).toBeNull();
	});
});
