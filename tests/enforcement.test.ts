import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ErrorCode } from "../server/errors";
import {
	COURT_FEE_ELECTRONIC,
	COURT_FEE_PAPER,
	formatSlovenianIban,
	partyKind,
	slovenianPostalCode,
	slovenianTaxNumber,
	splitPersonName,
	splitStreet,
} from "../server/enforcement-rules";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.enforcement.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { localDate, shiftLocalDate } = await import("../server/timezone");

await Server.configure();

const SCHEMA = join(import.meta.dir, "fixtures", "covl", "eCOVL.xsd");
const xmllint = Bun.which("xmllint");

function schemaErrors(xml: string): string {
	const file = join(tmpdir(), `rabbitpay-covl-${crypto.randomUUID()}.xml`);
	writeFileSync(file, xml);
	const result = Bun.spawnSync([xmllint!, "--nonet", "--noout", "--schema", SCHEMA, file]);
	unlinkSync(file);
	return result.exitCode === 0 ? "" : result.stderr.toString();
}

const password = (seed: string) => new Bun.CryptoHasher("blake2b512").update(seed).digest("hex");

interface ApiResponse {
	status: number;
	error: number;
	info: string;
	data?: any;
	headers?: Headers;
}

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<ApiResponse> {
	const headers: Record<string, string> = {};
	if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
	if (options.body !== undefined) headers["Content-Type"] = "application/json";
	const res = await Server.app.handle(
		new Request(`http://127.0.0.1${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
	);
	if (res.headers.get("Content-Type")?.includes("application/xml"))
		return { status: res.status, error: 0, info: "xml", data: await res.text(), headers: res.headers };
	const json = (await res.json()) as { error: number; info: string; data?: unknown };
	return { status: res.status, ...json };
}

let ownerToken = "";
let viewerToken = "";
let projectUuid = "";
let businessCustomer = "";
let personCustomer = "";
let businessInvoice = "";
let finalLetter = "";
let proposalUuid = "";
const base = () => `/api/v1/projects/${projectUuid}`;
const DAY = 86400000;
const today = () => localDate(Date.now(), "Europe/Ljubljana");

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

async function letter(body: Record<string, unknown>, deadlinePassed = true): Promise<string> {
	const issued = await call("POST", `${base()}/dunning`, { token: ownerToken, body: { level: 3, ...body } });
	if (issued.error !== 0) throw new Error(issued.info);
	if (deadlinePassed) await Database`UPDATE dunning_letters SET deadline_date = ${shiftLocalDate(today(), -1)} WHERE uuid = ${issued.data.uuid}`;
	return issued.data.uuid;
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	await call("POST", "/api/v1/auth/register", { body: { email: "izv-owner@example.com", password: password("izv-owner") } });
	ownerToken = (await call("POST", "/api/v1/auth/login", { body: { email: "izv-owner@example.com", password: password("izv-owner") } })).data.token;
	await call("POST", "/api/v1/auth/register", { body: { email: "izv-viewer@example.com", password: password("izv-viewer") } });
	viewerToken = (await call("POST", "/api/v1/auth/login", { body: { email: "izv-viewer@example.com", password: password("izv-viewer") } })).data.token;

	projectUuid = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "izvrsba-shop", currency: "EUR" } })).data.uuid;
	await call("PATCH", base(), { token: ownerToken, body: { tax_country: "SI", vat_status: "registered", tax_currency: "EUR" } });
	await call("PUT", `${base()}/company`, {
		token: ownerToken,
		body: {
			legal_name: "Izvrsba Test d.o.o.",
			address_line1: "Slovenska cesta 1",
			postal_code: "1000",
			city: "Ljubljana",
			country: "SI",
			vat_number: "SI12345678",
			registration_number: "1234567000",
		},
	});
	await call("PUT", `${base()}/processors/bank_transfer`, {
		token: ownerToken,
		body: { enabled: true, config: { iban: "SI56 1910 0000 0123 438", account_holder: "Izvrsba Test d.o.o." } },
	});
	await call("POST", `${base()}/members`, { token: ownerToken, body: { email: "izv-viewer@example.com", role: "viewer" } });
	businessCustomer = (
		await call("POST", `${base()}/customers`, {
			token: ownerToken,
			body: {
				email: "racuni@neplacnik.example",
				name: "Neplacnik d.o.o.",
				address_line1: "Trg svobode 4a",
				postal_code: "2000",
				city: "Maribor",
				country: "SI",
				vat_number: "SI87654321",
				registration_number: "7654321000",
				customer_type: "business",
			},
		})
	).data.uuid;
	personCustomer = (
		await call("POST", `${base()}/customers`, {
			token: ownerToken,
			body: {
				email: "mojca@example.com",
				name: "Mojca Zakasnela",
				address_line1: "Gorenjska cesta 7",
				postal_code: "4000",
				city: "Kranj",
				country: "SI",
				customer_type: "individual",
			},
		})
	).data.uuid;
	businessInvoice = await overdueInvoice(businessCustomer, 10000, 60);
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.enforcement.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("enforcement rules", () => {
	test("the court fee is the electronic one, 20 percent below paper", () => {
		expect(COURT_FEE_PAPER).toBe(5500);
		expect(COURT_FEE_ELECTRONIC).toBe(4400);
	});

	test("splits streets, postal codes and tax numbers the way the court form wants them", () => {
		expect(splitStreet("Trg svobode 4a")).toEqual({ street: "Trg svobode", house_number: "4a" });
		expect(splitStreet("Dolenja vas 12 B")).toEqual({ street: "Dolenja vas", house_number: "12B" });
		expect(splitStreet("Cesta 5/3")).toEqual({ street: "Cesta", house_number: "5/3" });
		expect(splitStreet("Brez številke")).toBeNull();
		expect(slovenianPostalCode("SI-1000")).toBe("1000");
		expect(slovenianPostalCode("10000")).toBeNull();
		expect(slovenianTaxNumber("SI 1234 5678")).toBe("12345678");
		expect(formatSlovenianIban("SI56 1910 0000 0123 438")).toBe("SI56 191000000123438");
	});

	test("tells companies, sole traders and people apart", () => {
		expect(partyKind("Neplacnik d.o.o.", true)).toBe("company");
		expect(partyKind("Mizarstvo Lesnik, Peter Lesnik s.p.", true)).toBe("sole_trader");
		expect(partyKind("Mojca Zakasnela", false)).toBe("person");
		expect(splitPersonName("Ana Marija Kos")).toEqual({ first_name: "Ana Marija", last_name: "Kos" });
		expect(splitPersonName("Cher")).toBeNull();
	});
});

describe("enforcement proposals", () => {
	test("waits until the deadline of a final letter has passed", async () => {
		const first = await letter({ level: 1, customer: businessCustomer, invoices: [businessInvoice] });
		const notFinal = await call("POST", `${base()}/dunning/${first}/enforcement/plan`, { token: viewerToken, body: {} });
		expect(notFinal.data.issues).toContain("not_final_letter");
		expect((await call("POST", `${base()}/dunning/${first}/enforcement`, { token: ownerToken, body: {} })).error).toBe(ErrorCode.ENFORCEMENT_NOT_READY);

		const waiting = await letter({ customer: businessCustomer, invoices: [businessInvoice] }, false);
		const plan = await call("POST", `${base()}/dunning/${waiting}/enforcement/plan`, { token: viewerToken, body: {} });
		expect(plan.data.issues).toEqual(["deadline_not_passed"]);
		for (const id of [first, waiting]) await call("DELETE", `${base()}/dunning/${id}`, { token: ownerToken });
	});

	test("plans the claim, statutory interest from the day after the due date and the 40 EUR per invoice", async () => {
		finalLetter = await letter({ customer: businessCustomer, invoices: [businessInvoice], interest: true, compensation: true });
		const plan = await call("POST", `${base()}/dunning/${finalLetter}/enforcement/plan`, { token: viewerToken, body: {} });
		expect(plan.error).toBe(0);
		expect(plan.data).toMatchObject({ ready: true, issues: [], commercial: true, compensation_available: true, debtor_kind: "company", court_fee: 4400 });
		const [invoice] = (await Database`SELECT reference, due_date FROM invoices WHERE uuid = ${businessInvoice}`) as { reference: string; due_date: number }[];
		const due = localDate(invoice!.due_date, "Europe/Ljubljana");
		expect(plan.data.claims).toEqual([
			expect.objectContaining({
				kind: "invoice",
				label: `račun št. ${invoice!.reference}`,
				due_date: due,
				amount: 12200,
				interest_from: shiftLocalDate(due, 1),
			}),
			expect.objectContaining({ kind: "compensation", amount: 4000, interest_from: shiftLocalDate(shiftLocalDate(today(), -1), 1) }),
		]);

		const without = await call("POST", `${base()}/dunning/${finalLetter}/enforcement/plan`, {
			token: viewerToken,
			body: { compensation: false, interest: false },
		});
		expect(without.data.claims).toEqual([expect.objectContaining({ kind: "invoice", interest_from: null })]);
	});

	test("prepares a proposal whose XML passes the court schema", async () => {
		const created = await call("POST", `${base()}/dunning/${finalLetter}/enforcement`, { token: ownerToken, body: {} });
		expect(created.status).toBe(201);
		proposalUuid = created.data.uuid;
		expect(created.data).toMatchObject({ status: "prepared", principal: 12200, compensation: 4000, claims_total: 16200, court_fee: 4400 });
		expect(created.data.debtor).toMatchObject({ kind: "company", name: "Neplacnik d.o.o.", street: "Trg svobode", house_number: "4a", tax_number: "87654321" });
		expect(created.data.creditor).toMatchObject({ registration_number: "1234567000", iban: "SI56191000000123438" });

		const xml = await call("GET", `${base()}/enforcement/${proposalUuid}/xml`, { token: viewerToken });
		expect(xml.headers?.get("Content-Disposition")).toContain("predlog-za-izvrsbo-");
		expect(xml.data).toContain('gospodarskaZadeva="true"');
		expect(xml.data).toContain('<StrosekTaksa zahtevani="true"/>');
		expect(xml.data).toContain('<DenarnaSredstvaOPP vec="false" izbrano="true"/>');
		expect(xml.data).not.toContain("StalniDenarniPrejemki");
		expect(xml.data).toContain('stevilkaRacuna="SI56 191000000123438"');
		if (xmllint) expect(schemaErrors(xml.data)).toBe("");
	});

	test("a person gets salary enforcement and no recovery costs", async () => {
		const invoice = await overdueInvoice(personCustomer, 5000, 30);
		const personal = await letter({ customer: personCustomer, invoices: [invoice], interest: true });
		const plan = await call("POST", `${base()}/dunning/${personal}/enforcement/plan`, { token: ownerToken, body: {} });
		expect(plan.data).toMatchObject({ ready: true, commercial: false, compensation_available: false, debtor_kind: "person" });
		const created = await call("POST", `${base()}/dunning/${personal}/enforcement`, { token: ownerToken, body: {} });
		expect(created.data.debtor).toMatchObject({ kind: "person", first_name: "Mojca", name: "Zakasnela", tax_number: null });
		const xml = await call("GET", `${base()}/enforcement/${created.data.uuid}/xml`, { token: ownerToken });
		expect(xml.data).toContain('gospodarskaZadeva="false"');
		expect(xml.data).toContain("<StalniDenarniPrejemki");
		if (xmllint) expect(schemaErrors(xml.data)).toBe("");
		expect((await call("POST", `${base()}/dunning/${personal}/enforcement`, { token: ownerToken, body: { bank_accounts: false, salary: false } })).error).toBe(
			ErrorCode.INVALID_ENFORCEMENT_PROPOSAL
		);
	});

	test("asks for the issue date of invoices issued before RabbitPay", async () => {
		const due = shiftLocalDate(today(), -90);
		const manual = await letter({ customer: businessCustomer, manual: [{ reference: "2025-044", due_date: due, open: 30000 }] });
		const plan = await call("POST", `${base()}/dunning/${manual}/enforcement/plan`, { token: ownerToken, body: {} });
		expect(plan.data.issues).toEqual(["issue_date_missing"]);
		const line = plan.data.claims[0];
		expect(line.needs_issue_date).toBe(true);
		const fixed = await call("POST", `${base()}/dunning/${manual}/enforcement/plan`, {
			token: ownerToken,
			body: { issue_dates: { [line.line]: shiftLocalDate(due, -30) } },
		});
		expect(fixed.data.ready).toBe(true);
		await call("DELETE", `${base()}/dunning/${manual}`, { token: ownerToken });
	});

	test("lists missing company and customer data instead of a broken file", async () => {
		await call("PUT", `${base()}/company`, { token: ownerToken, body: { address_line1: "Slovenska cesta", registration_number: null, vat_number: null } });
		const plan = await call("POST", `${base()}/dunning/${finalLetter}/enforcement/plan`, { token: ownerToken, body: {} });
		expect(plan.data.ready).toBe(false);
		expect(plan.data.issues).toEqual(expect.arrayContaining(["creditor_address", "creditor_identifier"]));
		await call("PUT", `${base()}/company`, {
			token: ownerToken,
			body: { address_line1: "Slovenska cesta 1", registration_number: "1234567000", vat_number: "SI12345678" },
		});
	});

	test("records the filing with the court case number", async () => {
		const future = await call("PATCH", `${base()}/enforcement/${proposalUuid}`, {
			token: ownerToken,
			body: { status: "filed", court_case: "VL 1234/2026", filed_date: shiftLocalDate(today(), 2) },
		});
		expect(future.error).toBe(ErrorCode.INVALID_ENFORCEMENT_PROPOSAL);
		const filed = await call("PATCH", `${base()}/enforcement/${proposalUuid}`, { token: ownerToken, body: { status: "filed", court_case: "VL 1234/2026" } });
		expect(filed.data).toMatchObject({ status: "filed", court_case: "VL 1234/2026", filed_date: today() });

		const listed = await call("GET", `${base()}/enforcement`, { token: viewerToken });
		expect(listed.data.total).toBe(2);
		expect(listed.data.proposals.find((row: { uuid: string }) => row.uuid === proposalUuid)).toMatchObject({
			status: "filed",
			letter_number: expect.any(String),
		});
		const plan = await call("POST", `${base()}/dunning/${finalLetter}/enforcement/plan`, { token: viewerToken, body: {} });
		expect(plan.data.proposals).toEqual([expect.objectContaining({ uuid: proposalUuid, status: "filed", court_case: "VL 1234/2026" })]);
	});

	test("viewers cannot prepare, change or delete", async () => {
		expect((await call("POST", `${base()}/dunning/${finalLetter}/enforcement`, { token: viewerToken, body: {} })).status).toBe(403);
		expect((await call("PATCH", `${base()}/enforcement/${proposalUuid}`, { token: viewerToken, body: { status: "prepared" } })).status).toBe(403);
		expect((await call("DELETE", `${base()}/enforcement/${proposalUuid}`, { token: viewerToken })).status).toBe(403);
	});

	test("deletes a proposal", async () => {
		expect((await call("DELETE", `${base()}/enforcement/${proposalUuid}`, { token: ownerToken })).error).toBe(0);
		expect((await call("GET", `${base()}/enforcement/${proposalUuid}`, { token: ownerToken })).error).toBe(ErrorCode.ENFORCEMENT_PROPOSAL_NOT_FOUND);
	});
});
