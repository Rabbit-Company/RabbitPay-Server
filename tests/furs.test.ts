import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createVerify, X509Certificate } from "node:crypto";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.furs.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { ErrorCode } = await import("../server/errors");
const { readPkcs12, Pkcs12Error } = await import("../server/furs/pkcs12");
const { certificateInfo, credentialsFromPkcs12 } = await import("../server/furs/credentials");
const { signedToken, verifiedPayload, FursSignatureError } = await import("../server/furs/jws");
const { fursAmount, fursTime, protectedId, verificationCode } = await import("../server/furs/zoi");
const { setFursEndpoint } = await import("../server/furs/client");
const { submitPendingDocuments, taxesFor, workingDaysAfter } = await import("../server/fiscal/documents");
const { fixture, startFursMock, TAXPAYER_PASSWORD, TAXPAYER_TAX_NUMBER } = await import("./furs-mock");
const { updateSettings } = await import("../server/settings");
const alerts = await import("../server/fiscal/alerts");
type ProjectRow = import("../server/database/models").ProjectRow;
type InvoiceRow = import("../server/database/models").InvoiceRow;
type EmailMessageRow = import("../server/database/models").EmailMessageRow;
type FiscalDocumentRow = import("../server/database/models").FiscalDocumentRow;

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

async function account(name: string): Promise<string> {
	await call("POST", "/api/v1/auth/register", { body: { username: name, email: `${name}@example.com`, password: password(name) } });
	return (await call("POST", "/api/v1/auth/login", { body: { username: name, password: password(name) } })).data.token;
}

let mock: Awaited<ReturnType<typeof startFursMock>>;
let token = "";
let projectUuid = "";
let coffee = "";
const base = () => `/api/v1/projects/${projectUuid}`;
const certificateBody = async (name = "taxpayer.p12", secret = TAXPAYER_PASSWORD) => ({
	file: Buffer.from(await fixture(name)).toString("base64"),
	password: secret,
});
const later = () => Date.now() + 24 * 60 * 60 * 1000;

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();
	mock = await startFursMock();
	setFursEndpoint("test", mock.endpoint);

	token = await account("furs-owner");
	projectUuid = (await call("POST", "/api/v1/projects", { token, body: { name: "furs-shop", currency: "EUR" } })).data.uuid;
	await call("PATCH", base(), { token, body: { tax_country: "SI", vat_status: "registered" } });
	await call("PUT", `${base()}/company`, {
		token,
		body: {
			legal_name: "Testno podjetje d.o.o.",
			address_line1: "Tržaška cesta 24",
			postal_code: "1000",
			city: "Ljubljana",
			country: "SI",
			vat_number: "SI10148019",
		},
	});
	coffee = (await call("POST", `${base()}/items`, { token, body: { name: "Kava", unit_price: 250, currency: "EUR", tax_rate: 22, supply_type: "services" } }))
		.data.uuid;
});

afterAll(async () => {
	setFursEndpoint("test", null);
	mock.stop();
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.furs.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("reading the FURS certificate", () => {
	test("opens a legacy .p12 file with its password", async () => {
		const contents = readPkcs12(await fixture("taxpayer.p12"), TAXPAYER_PASSWORD);
		expect(contents.privateKey.asymmetricKeyType).toBe("rsa");
		expect(contents.certificate.checkPrivateKey(contents.privateKey)).toBe(true);
		expect(contents.chain).toHaveLength(1);
	});

	test("refuses a wrong password and a file that is not a certificate", async () => {
		expect(() => readPkcs12(fixture("taxpayer.p12") as never, "nope")).toThrow();
		try {
			readPkcs12(await fixture("taxpayer.p12"), "nope");
			throw new Error("expected a failure");
		} catch (err) {
			expect(err).toBeInstanceOf(Pkcs12Error);
			expect((err as InstanceType<typeof Pkcs12Error>).reason).toBe("password");
		}
		expect(() => readPkcs12(new TextEncoder().encode("not a certificate"), "x")).toThrow(Pkcs12Error);
	});

	test("names the holder the way FURS expects in the signature header", async () => {
		const { certificate } = readPkcs12(await fixture("taxpayer.p12"), TAXPAYER_PASSWORD);
		const info = certificateInfo(certificate);
		expect(info.subjectName).toBe("CN=TESTNO PODJETJE 342,2.5.4.5=#130131,OU=10148019,OU=DavPotRacTEST,O=state-institutions,C=SI");
		expect(info.issuerName).toBe("CN=Tax CA Test,O=state-institutions,C=SI");
		expect(info.serial).toBe("9071438869705344859");
		expect(info.taxNumber).toBe(TAXPAYER_TAX_NUMBER);
		expect(info.test).toBe(true);
	});
});

describe("the protective mark and the printed code", () => {
	test("match both examples in the FURS specification", () => {
		const issued = Date.UTC(2015, 7, 15, 8, 13, 32);
		expect(verificationCode("a7e5f55e1dbb48b799268e1a6d8618a3", 12345678, issued)).toBe("223175087923687075112234402528973166755123456781508151013321");
		expect(verificationCode("3024e56bf1ddd2e7eeb5715c6859a913", 12345678, issued)).toBe("063994519708649896901260100447252359443123456781508151013320");
	});

	test("use Slovenian local time and a decimal point", () => {
		expect(fursTime(Date.UTC(2026, 0, 5, 23, 30, 0))).toEqual({ iso: "2026-01-06T00:30:00", printed: "06.01.2026 00:30:00", compact: "260106003000" });
		expect(fursTime(Date.UTC(2026, 6, 1, 10, 0, 0)).iso).toBe("2026-07-01T12:00:00");
		expect(fursAmount(104776)).toBe("1047.76");
		expect(fursAmount(-1230)).toBe("-12.30");
		expect(fursAmount(5)).toBe("0.05");
	});

	test("is a stable 32 character mark for the same invoice", async () => {
		const { privateKey } = readPkcs12(await fixture("taxpayer.p12"), TAXPAYER_PASSWORD);
		const input = {
			taxNumber: TAXPAYER_TAX_NUMBER,
			issuedAt: Date.UTC(2026, 8, 23, 8, 0, 0),
			invoiceNumber: "7",
			premise: "SPLET",
			device: "RP1",
			amount: 1220,
		};
		const zoi = protectedId(privateKey, input);
		expect(zoi).toMatch(/^[0-9a-f]{32}$/);
		expect(protectedId(privateKey, input)).toBe(zoi);
		expect(protectedId(privateKey, { ...input, amount: 1221 })).not.toBe(zoi);
	});
});

describe("signed FURS messages", () => {
	test("carry the certificate identity with a bare serial number", async () => {
		const credentials = credentialsFromPkcs12(await fixture("taxpayer.p12"), TAXPAYER_PASSWORD);
		const tokenText = signedToken({ EchoRequest: "furs" }, credentials);
		const [header, payload, signature] = tokenText.split(".") as [string, string, string];
		const rawHeader = Buffer.from(header, "base64url").toString("utf8");
		expect(rawHeader).toContain('"serial":9071438869705344859}');
		expect(JSON.parse(rawHeader)).toMatchObject({ alg: "RS256", issuer_name: "CN=Tax CA Test,O=state-institutions,C=SI" });
		expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toEqual({ EchoRequest: "furs" });
		expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(credentials.certificate.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
	});

	test("accept only responses signed under a trusted authority", async () => {
		const credentials = credentialsFromPkcs12(await fixture("taxpayer.p12"), TAXPAYER_PASSWORD);
		const unsigned = signedToken({ InvoiceResponse: {} }, credentials);
		expect(() => verifiedPayload(unsigned, mock.endpoint.anchors)).toThrow(FursSignatureError);
		const rogue = new X509Certificate(await Bun.file(`${import.meta.dir}/fixtures/furs/rogue.pem`).text());
		expect(() => verifiedPayload(unsigned, [rogue])).toThrow(FursSignatureError);
	});
});

describe("amounts sent to FURS", () => {
	const same = (amount: number) => amount;

	test("group VAT by rate and keep untaxed supplies apart", () => {
		const taxes = taxesFor(
			[
				{ rate: 22, treatment: "domestic", net: 1000, tax: 220 },
				{ rate: 22, treatment: null, net: 500, tax: 110 },
				{ rate: 9.5, treatment: "domestic", net: 200, tax: 19 },
				{ rate: 0, treatment: "reverse_charge", net: 300, tax: 0 },
				{ rate: 0, treatment: "export", net: 400, tax: 0 },
			],
			"registered",
			same
		);
		expect(taxes).toEqual({
			VAT: [
				{ TaxRate: 22, TaxableAmount: 15, TaxAmount: 3.3 },
				{ TaxRate: 9.5, TaxableAmount: 2, TaxAmount: 0.19 },
			],
			ReverseVATTaxableAmount: 3,
			ExemptVATTaxableAmount: 4,
		});
	});

	test("report everything as not taxable for a seller outside the VAT system", () => {
		expect(taxesFor([{ rate: 0, treatment: "small_business", net: 1250, tax: 0 }], "small_business", same)).toEqual({ NontaxableAmount: 12.5 });
		expect(taxesFor([{ rate: 0, treatment: "domestic_reverse_charge", net: 25000, tax: 0 }], "registered", same)).toEqual({ ReverseVATTaxableAmount: 250 });
	});

	test("give ten working days, skipping the weekend", () => {
		const friday = Date.UTC(2026, 8, 25, 10);
		expect(new Date(workingDaysAfter(friday, 1)).getUTCDay()).toBe(1);
		expect(new Date(workingDaysAfter(friday, 10)).toISOString().slice(0, 10)).toBe("2026-10-09");
	});
});

describe("a Slovenian project before fiscal verification is set up", () => {
	test("cannot take cash at the terminal or record a card or cash payment", async () => {
		const sale = await call("POST", `${base()}/pos/sales`, { token, body: { lines: [{ item: coffee, quantity: 1 }] } });
		expect(sale.status).toBe(201);
		const cash = await call("POST", `${base()}/pos/sales/${sale.data.uuid}/cash`, { token, body: {} });
		expect(cash.error).toBe(ErrorCode.FISCAL_NOT_CONFIGURED);

		const recorded = await call("POST", `${base()}/transactions`, { token, body: { invoice: sale.data.uuid, processor: "cash", amount: 250 } });
		expect(recorded.error).toBe(ErrorCode.FISCAL_NOT_CONFIGURED);
		const transfer = await call("POST", `${base()}/transactions`, { token, body: { invoice: sale.data.uuid, processor: "bank_transfer", amount: 250 } });
		expect(transfer.error).toBe(0);
		expect(mock.invoices).toHaveLength(0);
	});

	test("says fiscal verification is required but not active", async () => {
		const res = await call("GET", `${base()}/fiscal`, { token });
		expect(res.data).toMatchObject({ required: true, active: false, certificate: null, premises: [] });
	});
});

describe("setting up fiscal verification", () => {
	test("rejects a wrong certificate password", async () => {
		const res = await call("PUT", `${base()}/fiscal/certificate`, { token, body: await certificateBody("taxpayer.p12", "wrong") });
		expect(res.error).toBe(ErrorCode.FISCAL_CERTIFICATE_INVALID);
		expect(res.info).toContain("password");
	});

	test("cannot reach FURS with a certificate FURS does not trust", async () => {
		await call("PUT", `${base()}/fiscal/certificate`, { token, body: await certificateBody("stranger.p12") });
		const echo = await call("POST", `${base()}/fiscal/echo`, { token });
		expect(echo.error).toBe(ErrorCode.FURS_UNAVAILABLE);
		expect(mock.echoes).toBe(0);
	});

	test("stores the certificate, picks the test environment and reaches FURS", async () => {
		const res = await call("PUT", `${base()}/fiscal/certificate`, { token, body: await certificateBody() });
		expect(res.error).toBe(0);
		expect(res.data.environment).toBe("test");
		expect(res.data.certificate).toMatchObject({ holder: "TESTNO PODJETJE 342", tax_number: TAXPAYER_TAX_NUMBER, serial: "9071438869705344859" });

		const echo = await call("POST", `${base()}/fiscal/echo`, { token });
		expect(echo.error).toBe(0);
		expect(mock.echoes).toBe(1);
	});

	test("cannot switch on without a registered premise", async () => {
		const res = await call("PATCH", `${base()}/fiscal`, { token, body: { enabled: true, online_premise: "SPLET", online_device: "RP1" } });
		expect(res.error).toBe(ErrorCode.FISCAL_PREMISE_NOT_REGISTERED);
	});

	test("registers the business premise with FURS", async () => {
		const invalid = await call("POST", `${base()}/fiscal/premises`, { token, body: { premise_id: "SPLET 1", kind: "movable", premise_type: "C" } });
		expect(invalid.error).toBe(ErrorCode.FISCAL_INVALID_PREMISE);

		const res = await call("POST", `${base()}/fiscal/premises`, {
			token,
			body: {
				premise_id: "SPLET",
				kind: "real_estate",
				cadastral_number: 365,
				building_number: 12,
				building_section_number: 3,
				street: "Tržaška cesta",
				house_number: "24",
				house_number_additional: "B",
				community: "Ljubljana",
				city: "Ljubljana",
				postal_code: "1000",
				validity_date: "2026-09-01",
			},
		});
		expect(res.status).toBe(201);
		expect(res.data.premises).toHaveLength(1);
		expect(mock.premises.get("SPLET")).toMatchObject({
			TaxNumber: TAXPAYER_TAX_NUMBER,
			BPIdentifier: {
				RealEstateBP: {
					PropertyID: { CadastralNumber: 365, BuildingNumber: 12, BuildingSectionNumber: 3 },
					Address: { Street: "Tržaška cesta", HouseNumber: "24", HouseNumberAdditional: "B", PostalCode: "1000" },
				},
			},
			ValidityDate: "2026-09-01",
			SoftwareSupplier: [{ NameForeign: "RabbitPay" }],
		});
	});

	test("switches on with one device for invoices and one for the terminal", async () => {
		const res = await call("PATCH", `${base()}/fiscal`, {
			token,
			body: { enabled: true, online_premise: "SPLET", online_device: "RP1", pos_premise: "SPLET", pos_device: "BLAG1" },
		});
		expect(res.error).toBe(0);
		expect(res.data).toMatchObject({ active: true, enabled: true, online_device: "RP1", pos_device: "BLAG1" });
	});
});

describe("verifying invoices", () => {
	test("a cash sale at the terminal is numbered for FURS and verified at once", async () => {
		const sale = await call("POST", `${base()}/pos/sales`, { token, body: { lines: [{ item: coffee, quantity: 2 }] } });
		expect(sale.data.reference).toBe("SPLET-BLAG1-1");

		const cash = await call("POST", `${base()}/pos/sales/${sale.data.uuid}/cash`, { token, body: { tendered: 1000 } });
		expect(cash.error).toBe(0);

		const [received] = mock.invoices;
		expect(received!.zoiMatches).toBe(true);
		expect(received!.invoice).toMatchObject({
			TaxNumber: TAXPAYER_TAX_NUMBER,
			NumberingStructure: "B",
			InvoiceIdentifier: { BusinessPremiseID: "SPLET", ElectronicDeviceID: "BLAG1", InvoiceNumber: "1" },
			InvoiceAmount: 6.1,
			PaymentAmount: 6.1,
			TaxesPerSeller: [{ VAT: [{ TaxRate: 22, TaxableAmount: 5, TaxAmount: 1.1 }] }],
		});
		expect(received!.invoice.SubsequentSubmit).toBeUndefined();

		const document = await call("GET", `${base()}/pos/sales/${sale.data.uuid}/document`, { token });
		expect(document.data.fiscal).toMatchObject({ status: "verified", eor: received!.eor, zoi: received!.invoice.ProtectedID, environment: "test" });
		expect(document.data.fiscal.code).toMatch(/^\d{60}$/);
		expect(document.data.fiscal.code.slice(39, 47)).toBe(String(TAXPAYER_TAX_NUMBER));
	});

	test("the next sale on the same device takes the next number", async () => {
		const sale = await call("POST", `${base()}/pos/sales`, { token, body: { lines: [{ item: coffee, quantity: 1 }] } });
		expect(sale.data.reference).toBe("SPLET-BLAG1-2");
	});

	test("an invoice paid by bank transfer is never sent", async () => {
		const invoice = await call("POST", `${base()}/invoices`, {
			token,
			body: { status: "open", due_date: later(), items: [{ description: "Svetovanje", quantity: 1, unit_price: 10000, tax_rate: 22 }] },
		});
		expect(invoice.data.reference).toBe("SPLET-RP1-1");
		const before = mock.invoices.length;
		await call("POST", `${base()}/transactions`, { token, body: { invoice: invoice.data.uuid, processor: "bank_transfer", amount: 12200 } });
		await submitPendingDocuments();
		expect(mock.invoices).toHaveLength(before);
	});

	test("an invoice issued earlier and paid later in cash is verified with its original issue time", async () => {
		const invoice = await call("POST", `${base()}/invoices`, {
			token,
			body: { status: "open", due_date: later(), items: [{ description: "Izdelava spletne strani", quantity: 1, unit_price: 50000, tax_rate: 22 }] },
		});
		const paid = await call("POST", `${base()}/transactions`, { token, body: { invoice: invoice.data.uuid, processor: "cash", amount: 61000 } });
		expect(paid.error).toBe(0);
		await submitPendingDocuments(later());

		const received = mock.invoices.at(-1)!;
		expect(received.invoice.InvoiceIdentifier).toEqual({ BusinessPremiseID: "SPLET", ElectronicDeviceID: "RP1", InvoiceNumber: "2" });
		expect(received.invoice.IssueDateTime).toBe(fursTime(invoice.data.issued_at).iso);
		expect(received.zoiMatches).toBe(true);
	});

	test("a sale made while FURS is down is sent later as a subsequent submission", async () => {
		mock.outage = true;
		const sale = await call("POST", `${base()}/pos/sales`, { token, body: { lines: [{ item: coffee, quantity: 1 }] } });
		const cash = await call("POST", `${base()}/pos/sales/${sale.data.uuid}/cash`, { token, body: {} });
		expect(cash.error).toBe(0);

		const waiting = await call("GET", `${base()}/pos/sales/${sale.data.uuid}/document`, { token });
		expect(waiting.data.fiscal).toMatchObject({ status: "pending", eor: null });
		expect(waiting.data.fiscal.zoi).toMatch(/^[0-9a-f]{32}$/);

		const listed = await call("GET", `${base()}/fiscal/documents?status=pending`, { token });
		expect(listed.data.documents[0]).toMatchObject({ reference: sale.data.reference, attempts: 1, subsequent: true });
		expect(listed.data.documents[0].last_error).toContain("503");

		mock.outage = false;
		await submitPendingDocuments(later());
		const received = mock.invoices.at(-1)!;
		expect(received.invoice.InvoiceIdentifier.InvoiceNumber).toBe(sale.data.reference.split("-")[2]);
		expect(received.invoice.SubsequentSubmit).toBe(true);
		expect(received.zoiMatches).toBe(true);
	});

	test("a rejection is kept with its FURS code and can be retried", async () => {
		mock.reject = { code: "S002", message: "Sporočilo ni v skladu s shemo JSON" };
		const sale = await call("POST", `${base()}/pos/sales`, { token, body: { lines: [{ item: coffee, quantity: 1 }] } });
		await call("POST", `${base()}/pos/sales/${sale.data.uuid}/cash`, { token, body: {} });

		const rejected = await call("GET", `${base()}/fiscal/documents?status=rejected`, { token });
		expect(rejected.data.documents).toHaveLength(1);
		expect(rejected.data.documents[0]).toMatchObject({ error_code: "S002", status: "rejected" });
		expect((await call("GET", `${base()}/fiscal`, { token })).data.rejected).toBe(1);

		const retried = await call("POST", `${base()}/fiscal/documents/${rejected.data.documents[0].uuid}/retry`, { token });
		expect(retried.data.status).toBe("verified");
	});

	test("a credit note for a verified sale is sent as a negative invoice that points to the original", async () => {
		const sale = await call("POST", `${base()}/pos/sales`, { token, body: { lines: [{ item: coffee, quantity: 4 }] } });
		await call("POST", `${base()}/pos/sales/${sale.data.uuid}/cash`, { token, body: {} });
		const original = mock.invoices.at(-1)!;

		const credited = await call("POST", `${base()}/invoices/${sale.data.uuid}/credit-notes`, { token, body: { reason: "Vračilo" } });
		expect(credited.error).toBe(0);
		const note = credited.data.credit_note ?? credited.data;
		expect(note.reference).toMatch(/^SPLET-BLAG1-\d+$/);
		await submitPendingDocuments(later());

		const received = mock.invoices.at(-1)!;
		expect(received.zoiMatches).toBe(true);
		expect(received.invoice.InvoiceAmount).toBe(-12.2);
		expect(received.invoice.TaxesPerSeller).toEqual([{ VAT: [{ TaxRate: 22, TaxableAmount: -10, TaxAmount: -2.2 }] }]);
		expect(received.invoice.ReferenceInvoice).toEqual([
			{ ReferenceInvoiceIdentifier: original.invoice.InvoiceIdentifier, ReferenceInvoiceIssueDateTime: original.invoice.IssueDateTime },
		]);
	});
});

describe("the person who issued the invoice", () => {
	test("is sent to FURS with their own tax number and shown on the invoice", async () => {
		const bad = await call("PUT", `${base()}/fiscal/operators/furs-owner`, { token, body: { tax_number: 1234 } });
		expect(bad.error).toBe(ErrorCode.REQUIRED_DATA_MISSING);
		expect((await call("PUT", `${base()}/fiscal/operators/nobody`, { token, body: { tax_number: 12345678 } })).error).toBe(ErrorCode.MEMBER_NOT_FOUND);

		const saved = await call("PUT", `${base()}/fiscal/operators/furs-owner`, { token, body: { tax_number: 12345678 } });
		expect(saved.data.operators).toContainEqual({ username: "furs-owner", name: "furs-owner", role: "owner", tax_number: 12345678 });

		const sale = await call("POST", `${base()}/pos/sales`, { token, body: { lines: [{ item: coffee, quantity: 1 }] } });
		await call("POST", `${base()}/pos/sales/${sale.data.uuid}/cash`, { token, body: {} });
		expect(mock.invoices.at(-1)!.invoice.OperatorTaxNumber).toBe(12345678);

		const document = await call("GET", `${base()}/pos/sales/${sale.data.uuid}/document`, { token });
		expect(document.data.fiscal.operator).toBe("furs-owner");
	});

	test("falls back to the project tax number when the cashier has none", async () => {
		const cashier = await account("furs-cashier");
		await call("POST", `${base()}/members`, { token, body: { email: "furs-cashier@example.com", role: "cashier" } });
		await call("PATCH", `${base()}/fiscal`, { token, body: { operator_tax_number: 87654321 } });

		const sale = await call("POST", `${base()}/pos/sales`, { token: cashier, body: { lines: [{ item: coffee, quantity: 1 }] } });
		expect((await call("POST", `${base()}/pos/sales/${sale.data.uuid}/cash`, { token: cashier, body: {} })).error).toBe(0);
		expect(mock.invoices.at(-1)!.invoice.OperatorTaxNumber).toBe(87654321);

		const document = await call("GET", `${base()}/pos/sales/${sale.data.uuid}/document`, { token });
		expect(document.data.fiscal.operator).toBe("furs-cashier");
	});
});

describe("refunds", () => {
	const paidInvoice = async (processor: string) => {
		const invoice = await call("POST", `${base()}/invoices`, {
			token,
			body: { status: "open", due_date: later(), items: [{ description: "Vzdrževanje", quantity: 1, unit_price: 10000, tax_rate: 22 }] },
		});
		const payment = await call("POST", `${base()}/transactions`, { token, body: { invoice: invoice.data.uuid, processor, amount: 12200 } });
		await submitPendingDocuments(later());
		return { invoice: invoice.data, payment: payment.data };
	};

	test("of an invoice verified by FURS always issue a credit note that FURS receives", async () => {
		const { invoice, payment } = await paidInvoice("cash");
		const original = mock.invoices.at(-1)!;
		expect(original.invoice.InvoiceIdentifier.InvoiceNumber).toBe(invoice.reference.split("-")[2]);

		const detail = await call("GET", `${base()}/invoices/${invoice.uuid}`, { token });
		expect(detail.data.fiscal_status).toBe("verified");

		const refund = await call("POST", `${base()}/transactions/${payment.uuid}/refund`, { token, body: { amount: 6100, credit_note: false } });
		expect(refund.error).toBe(0);
		expect(refund.data.credit_note.reference).toMatch(/^SPLET-RP1-\d+$/);
		await submitPendingDocuments(later());

		const received = mock.invoices.at(-1)!;
		expect(received.zoiMatches).toBe(true);
		expect(received.invoice.InvoiceAmount).toBe(-61);
		expect(received.invoice.ReferenceInvoice[0].ReferenceInvoiceIdentifier).toEqual(original.invoice.InvoiceIdentifier);
	});

	test("of an invoice paid by bank transfer still leave the credit note optional", async () => {
		const { invoice, payment } = await paidInvoice("bank_transfer");
		expect((await call("GET", `${base()}/invoices/${invoice.uuid}`, { token })).data.fiscal_status).toBeNull();
		const sent = mock.invoices.length;

		const refund = await call("POST", `${base()}/transactions/${payment.uuid}/refund`, { token, body: { amount: 6100, credit_note: false } });
		expect(refund.error).toBe(0);
		expect(refund.data.credit_note).toBeNull();
		await submitPendingDocuments(later());
		expect(mock.invoices).toHaveLength(sent);
	});
});

describe("emailed documents", () => {
	test("a receipt for a verified sale attaches the copy with the fiscal marks, not the one archived before payment", async () => {
		const { queueReceiptEmail } = await import("../server/email/messages");
		const { storedAttachment } = await import("../server/email/outbox");
		const { documentStorage } = await import("../server/document-storage");

		const sale = await call("POST", `${base()}/pos/sales`, { token, body: { lines: [{ item: coffee, quantity: 1 }] } });
		await call("POST", `${base()}/pos/sales/${sale.data.uuid}/cash`, { token, body: {} });
		const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${projectUuid}`) as ProjectRow[];
		const [invoice] = (await Database`SELECT * FROM invoices WHERE uuid = ${sale.data.uuid}`) as InvoiceRow[];
		const [fiscal] = (await Database`SELECT status FROM fiscal_documents WHERE invoice = ${invoice.uuid}`) as { status: string }[];
		expect(fiscal.status).toBe("verified");

		const uuid = await queueReceiptEmail(project, invoice, "buyer@example.com", "furs-owner", [], { attachDocument: true });
		const [message] = (await Database`SELECT * FROM email_messages WHERE uuid = ${uuid}`) as EmailMessageRow[];
		const sent = await storedAttachment(message);
		const archived = await documentStorage().get(message.attachment_storage_key!);

		expect(sent).not.toBeNull();
		expect(sent!.length).toBeGreaterThan(archived.length + 1000);
		await Database`DELETE FROM email_messages WHERE uuid = ${uuid}`;
	});

	test("the copy FURS verified is stored once and served unchanged from then on", async () => {
		const { documentStorage } = await import("../server/document-storage");
		const { storageFor } = await import("../server/licensing");
		const before = (await storageFor(projectUuid)).storage_used;

		const sale = await call("POST", `${base()}/pos/sales`, { token, body: { lines: [{ item: coffee, quantity: 3 }] } });
		await call("POST", `${base()}/pos/sales/${sale.data.uuid}/cash`, { token, body: {} });

		const [fiscal] = (await Database`SELECT * FROM fiscal_documents WHERE invoice = ${sale.data.uuid}`) as FiscalDocumentRow[];
		expect(fiscal.status).toBe("verified");
		expect(fiscal.archive_key).toContain(`invoices/${projectUuid}/${sale.data.uuid}/verified-`);
		const stored = await documentStorage().get(fiscal.archive_key!);
		expect(stored.byteLength).toBe(fiscal.archive_size!);
		expect(new Bun.CryptoHasher("sha256").update(stored).digest("hex")).toBe(fiscal.archive_sha256!);

		const download = async () =>
			new Uint8Array(
				await (
					await Server.app.handle(new Request(`http://127.0.0.1${base()}/invoices/${sale.data.uuid}/pdf`, { headers: { Authorization: `Bearer ${token}` } }))
				).arrayBuffer()
			);
		expect(Buffer.from(await download()).equals(Buffer.from(stored))).toBe(true);
		expect(Buffer.from(await download()).equals(Buffer.from(stored))).toBe(true);

		await documentStorage().put(fiscal.archive_key!, new Uint8Array([1, 2, 3]), "application/pdf");
		const damaged = await call("GET", `${base()}/invoices/${sale.data.uuid}/pdf`, { token });
		expect(damaged.error).toBe(1283);
		await documentStorage().put(fiscal.archive_key!, stored, "application/pdf");
		expect(Buffer.from(await download()).equals(Buffer.from(stored))).toBe(true);

		const archivedAtIssue = await Database`SELECT byte_size FROM invoice_documents WHERE invoice = ${sale.data.uuid}`;
		expect((await storageFor(projectUuid)).storage_used - before).toBe(Number(archivedAtIssue[0].byte_size) + fiscal.archive_size!);
	});

	test("a verified record without a stored copy is archived by the next document run", async () => {
		const { archivePendingVerifiedCopies } = await import("../server/fiscal/archive");
		const sale = await call("POST", `${base()}/pos/sales`, { token, body: { lines: [{ item: coffee, quantity: 1 }] } });
		await call("POST", `${base()}/pos/sales/${sale.data.uuid}/cash`, { token, body: {} });
		await Database`UPDATE fiscal_documents SET archive_key = NULL, archive_size = NULL, archive_sha256 = NULL WHERE invoice = ${sale.data.uuid}`;

		expect((await archivePendingVerifiedCopies()).archived).toBeGreaterThanOrEqual(1);
		const [fiscal] = (await Database`SELECT archive_key FROM fiscal_documents WHERE invoice = ${sale.data.uuid}`) as FiscalDocumentRow[];
		expect(fiscal.archive_key).not.toBeNull();
		expect((await archivePendingVerifiedCopies()).attempted).toBe(0);
	});
});

describe("telling owners about invoices FURS has not verified", () => {
	const { DUE_SOON_MS, alertFor, sendFiscalAlerts } = alerts;
	const hour = 60 * 60 * 1000;

	beforeAll(async () => {
		setFursEndpoint("production", mock.endpoint);
		await updateSettings({ "email.enabled": true });
	});

	afterAll(async () => {
		await Database`UPDATE fiscal_documents SET environment = 'test' WHERE project = ${projectUuid}`;
		setFursEndpoint("production", null);
		await updateSettings({ "email.enabled": false });
	});

	async function alertEmails(): Promise<EmailMessageRow[]> {
		return (await Database`SELECT * FROM email_messages WHERE project = ${projectUuid} AND kind = 'fiscal_alert'`) as EmailMessageRow[];
	}

	test("decides once per problem", () => {
		const now = Date.now();
		expect(alertFor({ status: "pending", deadline: now + DUE_SOON_MS + hour, alerted: null }, now)).toBeNull();
		expect(alertFor({ status: "pending", deadline: now + hour, alerted: null }, now)).toBe("deadline");
		expect(alertFor({ status: "pending", deadline: now - hour, alerted: "deadline" }, now)).toBeNull();
		expect(alertFor({ status: "rejected", deadline: now + 5 * DUE_SOON_MS, alerted: "deadline" }, now)).toBe("rejected");
		expect(alertFor({ status: "rejected", deadline: now, alerted: "rejected" }, now)).toBeNull();
		expect(alertFor({ status: "verified", deadline: now - hour, alerted: null }, now)).toBeNull();
	});

	test("emails the owners once about a record near its deadline and one FURS rejected", async () => {
		mock.outage = true;
		const waiting = await call("POST", `${base()}/pos/sales`, { token, body: { lines: [{ item: coffee, quantity: 1 }] } });
		await call("POST", `${base()}/pos/sales/${waiting.data.uuid}/cash`, { token, body: {} });
		mock.outage = false;

		mock.reject = { code: "S002", message: "Sporočilo ni v skladu s shemo JSON" };
		const refused = await call("POST", `${base()}/pos/sales`, { token, body: { lines: [{ item: coffee, quantity: 1 }] } });
		await call("POST", `${base()}/pos/sales/${refused.data.uuid}/cash`, { token, body: {} });
		mock.reject = null;

		const now = Date.now();
		await Database`UPDATE fiscal_documents SET environment = 'production', next_attempt_at = ${later()}, deadline = ${now + 2 * hour} WHERE invoice = ${waiting.data.uuid}`;
		await Database`UPDATE fiscal_documents SET environment = 'production' WHERE invoice = ${refused.data.uuid}`;

		const summary = await call("GET", `${base()}/fiscal`, { token });
		expect(summary.data).toMatchObject({ due_soon: 1, rejected: 1 });

		expect(await sendFiscalAlerts(now)).toEqual({ projects: 1, documents: 2 });
		const [email] = await alertEmails();
		expect(email.recipient).toBe("furs-owner@example.com");
		expect(email.body_text).toContain(waiting.data.reference);
		expect(email.body_text).toContain(refused.data.reference);
		expect(email.body_text).toContain("S002");

		expect(await sendFiscalAlerts(now + hour)).toEqual({ projects: 0, documents: 0 });
		expect(await alertEmails()).toHaveLength(1);
	});

	test("a record that fails again after a retry is reported again", async () => {
		const [rejected] = (await Database`
			SELECT uuid FROM fiscal_documents WHERE project = ${projectUuid} AND environment = 'production' AND status = 'rejected'
		`) as { uuid: string }[];
		mock.reject = { code: "S002", message: "Sporočilo ni v skladu s shemo JSON" };
		await call("POST", `${base()}/fiscal/documents/${rejected.uuid}/retry`, { token });
		mock.reject = null;

		expect(await sendFiscalAlerts()).toEqual({ projects: 1, documents: 1 });
		expect(await alertEmails()).toHaveLength(2);
	});

	test("records in the FURS test environment never raise an alert", async () => {
		await Database`UPDATE fiscal_documents SET environment = 'test', alerted = NULL WHERE project = ${projectUuid}`;
		expect(await sendFiscalAlerts()).toEqual({ projects: 0, documents: 0 });
	});
});

describe("closing the premise", () => {
	test("tells FURS, switches fiscal verification off and blocks cash again", async () => {
		const res = await call("POST", `${base()}/fiscal/premises/SPLET/close`, { token });
		expect(res.error).toBe(0);
		expect(res.data).toMatchObject({ active: false, enabled: false, online_premise: null, pos_premise: null });
		expect(mock.premises.get("SPLET")!.ClosingTag).toBe("Z");

		const sale = await call("POST", `${base()}/pos/sales`, { token, body: { lines: [{ item: coffee, quantity: 1 }] } });
		expect((await call("POST", `${base()}/pos/sales/${sale.data.uuid}/cash`, { token, body: {} })).error).toBe(ErrorCode.FISCAL_NOT_CONFIGURED);
	});
});
