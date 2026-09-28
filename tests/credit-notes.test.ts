import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import { ErrorCode } from "../server/errors";
import { outstandingOf } from "../server/invoicing";
import type { InvoiceItemRow } from "../server/database/models";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.credit-notes.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { planCredit } = await import("../server/credit-notes");
const { documentStorage } = await import("../server/document-storage");
const { archivePendingCreditNotes } = await import("../server/credit-note-archive");
const { storageFor } = await import("../server/licensing");

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
let viewerToken = "";
let projectUuid = "";
let foreignCustomerUuid = "";
const base = () => `/api/v1/projects/${projectUuid}`;

async function draft(items: unknown[], extra: Record<string, unknown> = {}) {
	const created = await call("POST", `${base()}/invoices`, {
		token: ownerToken,
		body: { due_date: Date.now() + 86400000, supply_date: Date.now(), items, ...extra },
	});
	if (created.error !== 0) throw new Error(created.info);
	return created.data;
}

async function issued(items: unknown[], extra: Record<string, unknown> = {}) {
	const created = await draft(items, extra);
	return (await call("POST", `${base()}/invoices/${created.uuid}/open`, { token: ownerToken })).data;
}

const invoice = (id: string) => call("GET", `${base()}/invoices/${id}`, { token: ownerToken }).then((res) => res.data);
const credit = (id: string, body: unknown = {}, token = ownerToken) => call("POST", `${base()}/invoices/${id}/credit-notes`, { token, body });

const twoLines = [
	{ description: "Service", quantity: 1, unit_price: 10000, tax_rate: 22 },
	{ description: "Book", quantity: 1, unit_price: 5000, tax_rate: 9.5 },
];

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	await call("POST", "/api/v1/auth/register", { body: { username: "cn-owner", email: "cn@example.com", password: password("cn-owner") } });
	ownerToken = (await call("POST", "/api/v1/auth/login", { body: { username: "cn-owner", password: password("cn-owner") } })).data.token;
	await call("POST", "/api/v1/auth/register", { body: { username: "cn-viewer", email: "cn-viewer@example.com", password: password("cn-viewer") } });
	viewerToken = (await call("POST", "/api/v1/auth/login", { body: { username: "cn-viewer", password: password("cn-viewer") } })).data.token;

	projectUuid = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "cn-shop", currency: "EUR" } })).data.uuid;
	await call("PATCH", base(), { token: ownerToken, body: { tax_country: "SI", vat_status: "registered", tax_currency: "EUR" } });
	await call("PUT", `${base()}/company`, {
		token: ownerToken,
		body: {
			legal_name: "Credit Notes d.o.o.",
			address_line1: "Dunajska cesta 1",
			postal_code: "1000",
			city: "Ljubljana",
			country: "SI",
			vat_number: "SI12345678",
		},
	});
	await call("POST", `${base()}/members`, { token: ownerToken, body: { email: "cn-viewer@example.com", role: "viewer" } });
	foreignCustomerUuid = (
		await call("POST", `${base()}/customers`, {
			token: ownerToken,
			body: {
				email: "foreign-credit@example.com",
				name: "Foreign Credit GmbH",
				address_line1: "Hauptstrasse 1",
				postal_code: "10115",
				city: "Berlin",
				country: "DE",
				vat_number: "DE123456789",
				customer_type: "business",
			},
		})
	).data.uuid;
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.credit-notes.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("planning a credit", () => {
	const line = (uuid: string, total: number, tax: number, rate: number) =>
		({ uuid, total_price: total, discount_amount: 0, tax_amount: tax, tax_rate: rate, description: uuid, tax_treatment: null }) as unknown as InvoiceItemRow;
	const available = [
		{ line: line("a", 10000, 2200, 22), net: 10000, tax: 2200 },
		{ line: line("b", 5000, 475, 9.5), net: 5000, tax: 475 },
		{ line: line("c", 0, 0, 0), net: 0, tax: 0 },
	];

	test("credits everything that is left when nothing is specified", () => {
		expect(planCredit(available, {})).toEqual([
			{ line: available[0].line, net: 10000, tax: 2200 },
			{ line: available[1].line, net: 5000, tax: 475 },
		]);
	});

	test("spreads a gross amount over the lines and hits it to the cent", () => {
		const planned = planCredit(available, { amount: 5000 });
		if (!Array.isArray(planned)) throw new Error("expected a plan");

		expect(planned.reduce((sum, entry) => sum + entry.net + entry.tax, 0)).toBe(5000);
		expect(planned[0]).toEqual({ line: available[0].line, net: 2829, tax: 622 });
		expect(planned[1]).toEqual({ line: available[1].line, net: 1415, tax: 134 });
	});

	test("credits single lines with their own rate and takes the exact tax on the last cent", () => {
		expect(planCredit(available, { lines: [{ line: "a", amount: 1000 }] })).toEqual([{ line: available[0].line, net: 1000, tax: 220 }]);
		expect(planCredit(available, { lines: [{ line: "b", amount: 5000 }] })).toEqual([{ line: available[1].line, net: 5000, tax: 475 }]);
	});

	test("refuses a credit it cannot honour", () => {
		for (const request of [
			{ amount: 0 },
			{ amount: 17676 },
			{ amount: 10.5 },
			{ lines: [] },
			{ lines: [{ line: "a", amount: 10001 }] },
			{ lines: [{ line: "z", amount: 1 }] },
			{
				lines: [
					{ line: "a", amount: 1 },
					{ line: "a", amount: 1 },
				],
			},
			{ lines: [{ line: "a" }] },
			{ amount: 100, lines: [{ line: "a", amount: 1 }] },
		]) {
			expect(planCredit(available, request as never)).toBe(ErrorCode.INVALID_CREDIT_NOTE);
		}
	});

	test("says when nothing is left", () => {
		expect(planCredit([{ ...available[0], net: 0, tax: 0 }], {})).toBe(ErrorCode.NOTHING_TO_CREDIT);
	});

	test("counts credited amounts in what is still owed", () => {
		expect(outstandingOf({ total_amount: 1000, paid_amount: 300, refunded_amount: 0, credited_amount: 500 })).toBe(200);
		expect(outstandingOf({ total_amount: 1000, paid_amount: 300, refunded_amount: 100, credited_amount: 100 })).toBe(700);
		expect(outstandingOf({ total_amount: 1000, paid_amount: 0, refunded_amount: 0, credited_amount: 1000 })).toBe(0);
	});
});

describe("issuing a credit note", () => {
	test("credits a whole invoice, numbers it in its own series and closes the invoice", async () => {
		const target = await issued(twoLines);
		const res = await credit(target.uuid, { reason: "Order cancelled by customer" });

		expect(res.status).toBe(201);
		expect(res.data.reference).toMatch(/^CN[0-9]{6}000001$/);
		expect(res.data.subtotal).toBe(15000);
		expect(res.data.tax_amount).toBe(2675);
		expect(res.data.total_amount).toBe(17675);
		expect(res.data.reason).toBe("Order cancelled by customer");
		expect(res.data.items.map((item: any) => [item.description, item.net_amount, item.tax_amount])).toEqual([
			["Service", 10000, 2200],
			["Book", 5000, 475],
		]);

		const after = await invoice(target.uuid);
		expect(after.credited_amount).toBe(17675);
		expect(after.status).toBe("canceled");

		const publicView = await call("GET", `/api/v1/public/invoices/${target.uuid}`);
		expect(publicView.data.outstanding).toBe(0);
	});

	test("reduces what is owed on a partial credit and keeps the invoice open", async () => {
		const target = await issued(twoLines);
		const res = await credit(target.uuid, { amount: 7675 });

		expect(res.data.reference).toMatch(/000002$/);
		expect(res.data.total_amount).toBe(7675);

		const after = await invoice(target.uuid);
		expect(after.status).toBe("open");
		expect((await call("GET", `/api/v1/public/invoices/${target.uuid}`)).data.outstanding).toBe(10000);

		const listed = await call("GET", `${base()}/invoices/${target.uuid}/credit-notes`, { token: ownerToken });
		expect(listed.data.credit_notes).toHaveLength(1);
		expect(listed.data.creditable_total).toBe(10000);
	});

	test("does not use up invoice numbers", async () => {
		const next = await issued(twoLines);
		const earlier = await call("GET", `${base()}/invoices?limit=200`, { token: ownerToken });
		const numbers = earlier.data.invoices.map((row: any) => Number(row.reference.slice(6))).sort((a: number, b: number) => a - b);

		expect(numbers).toEqual([1, 2, 3]);
		expect(next.reference.endsWith("000003")).toBe(true);
	});

	test("credits chosen lines and stops at what is left", async () => {
		const target = await issued(twoLines);
		const lines = (await call("GET", `${base()}/invoices/${target.uuid}/credit-notes`, { token: ownerToken })).data.creditable;

		const first = await credit(target.uuid, { lines: [{ line: lines[1].line, amount: 2000 }] });
		expect(first.data.items).toHaveLength(1);
		expect([first.data.subtotal, first.data.tax_amount]).toEqual([2000, 190]);

		expect((await credit(target.uuid, { lines: [{ line: lines[1].line, amount: 3001 }] })).error).toBe(1074);

		const rest = await credit(target.uuid, { lines: [{ line: lines[1].line, amount: 3000 }] });
		expect(rest.data.tax_amount).toBe(285);

		const left = (await call("GET", `${base()}/invoices/${target.uuid}/credit-notes`, { token: ownerToken })).data;
		expect(left.creditable.map((entry: any) => [entry.net, entry.tax])).toEqual([
			[10000, 2200],
			[0, 0],
		]);
	});

	test("refuses when nothing is left, for a draft, and for a bad request", async () => {
		const target = await issued([{ description: "Tiny", quantity: 1, unit_price: 100, tax_rate: 0, tax_treatment: "exempt" }]);
		await credit(target.uuid);
		expect((await credit(target.uuid)).error).toBe(1075);

		const unissued = await draft(twoLines);
		expect((await credit(unissued.uuid)).error).toBe(1044);

		const open = await issued(twoLines);
		expect((await credit(open.uuid, { amount: -5 })).error).toBe(1074);
		expect((await credit(open.uuid, { reason: "x".repeat(501) })).error).toBe(1074);
		expect((await credit(open.uuid, { lines: [{ line: crypto.randomUUID(), amount: 1 }] })).error).toBe(1074);
	});

	test("can be read by a viewer but not issued", async () => {
		const target = await issued(twoLines);
		expect((await credit(target.uuid, {}, viewerToken)).error).toBe(9999);
		expect((await call("GET", `${base()}/credit-notes`, { token: viewerToken })).error).toBe(0);
	});
});

describe("cancelling an issued invoice", () => {
	test("issues a credit note for the full amount with the reason given", async () => {
		const target = await issued(twoLines);
		const res = await call("POST", `${base()}/invoices/${target.uuid}/cancel`, { token: ownerToken, body: { reason: "Duplicate" } });

		expect(res.data.status).toBe("canceled");
		expect(res.data.credited_amount).toBe(17675);

		const notes = (await call("GET", `${base()}/invoices/${target.uuid}/credit-notes`, { token: ownerToken })).data.credit_notes;
		expect(notes.map((note: any) => [note.total_amount, note.reason])).toEqual([[17675, "Duplicate"]]);
	});

	test("only credits what an earlier credit note left", async () => {
		const target = await issued(twoLines);
		await credit(target.uuid, { amount: 675 });
		await call("POST", `${base()}/invoices/${target.uuid}/cancel`, { token: ownerToken });

		const notes = (await call("GET", `${base()}/invoices/${target.uuid}/credit-notes`, { token: ownerToken })).data.credit_notes;
		expect(notes.map((note: any) => note.total_amount)).toEqual([675, 17000]);
		expect(notes[1].reason).toBe("Invoice cancelled");
	});

	test("writes the default reason in the invoice language", async () => {
		await call("PATCH", base(), { token: ownerToken, body: { language: "sl" } });
		const target = await issued(twoLines);
		await call("POST", `${base()}/invoices/${target.uuid}/cancel`, { token: ownerToken });
		await call("PATCH", base(), { token: ownerToken, body: { language: "en" } });

		const notes = (await call("GET", `${base()}/invoices/${target.uuid}/credit-notes`, { token: ownerToken })).data.credit_notes;
		expect(notes[0].reason).toBe("Preklic računa");
	});

	test("does not issue one for a draft", async () => {
		const target = await draft(twoLines);
		const res = await call("POST", `${base()}/invoices/${target.uuid}/cancel`, { token: ownerToken });

		expect(res.data.status).toBe("canceled");
		expect(res.data.credited_amount).toBe(0);
		expect((await call("GET", `${base()}/invoices/${target.uuid}/credit-notes`, { token: ownerToken })).data.credit_notes).toEqual([]);
	});
});

describe("refunding with a credit note", () => {
	async function paidInvoice() {
		const target = await issued(twoLines);
		const paid = await call("POST", `${base()}/transactions`, {
			token: ownerToken,
			body: { invoice: target.uuid, processor: "bank_transfer", amount: 17675 },
		});
		return { target, payment: paid.data.uuid as string };
	}

	test("credits the refunded amount and leaves the balance consistent", async () => {
		const { target, payment } = await paidInvoice();
		const res = await call("POST", `${base()}/transactions/${payment}/refund`, {
			token: ownerToken,
			body: { amount: 5000, reason: "Damaged book", credit_note: true },
		});

		expect(res.status).toBe(201);
		expect(res.data.credit_note.total_amount).toBe(5000);
		expect(res.data.credit_note.transaction_id).toBe(res.data.uuid);
		expect(res.data.credit_note.reason).toBe("Damaged book");
		expect(res.data.invoice_balance.outstanding).toBe(0);

		const after = await invoice(target.uuid);
		expect(after.status).toBe("paid");
		expect(after.credited_amount).toBe(5000);
		expect(after.refunded_amount).toBe(5000);
	});

	test("marks a fully refunded and credited invoice as refunded", async () => {
		const { target, payment } = await paidInvoice();
		const res = await call("POST", `${base()}/transactions/${payment}/refund`, { token: ownerToken, body: { credit_note: true } });

		expect(res.data.credit_note.total_amount).toBe(17675);
		expect((await invoice(target.uuid)).status).toBe("refunded");
	});

	test("issues no credit note unless asked", async () => {
		const { target, payment } = await paidInvoice();
		const res = await call("POST", `${base()}/transactions/${payment}/refund`, { token: ownerToken, body: { amount: 100 } });

		expect(res.data.credit_note).toBeNull();
		expect((await invoice(target.uuid)).credited_amount).toBe(0);
		expect((await call("POST", `${base()}/transactions/${payment}/refund`, { token: ownerToken, body: { amount: 100, credit_note: "yes" } })).error).toBe(1001);
	});

	test("credits no more than is left when the invoice was already credited", async () => {
		const { target, payment } = await paidInvoice();
		await credit(target.uuid, { amount: 17000 });
		const res = await call("POST", `${base()}/transactions/${payment}/refund`, { token: ownerToken, body: { amount: 1000, credit_note: true } });

		expect(res.data.credit_note.total_amount).toBe(675);
		expect((await invoice(target.uuid)).credited_amount).toBe(17675);
	});
});

describe("a credit note document", () => {
	test("keeps the issued document immutable after company settings change", async () => {
		await call("PUT", `${base()}/company`, {
			token: ownerToken,
			body: { legal_name: "Original Credit Seller d.o.o.", address_line1: "Original Street 1", country: "SI" },
		});
		await call("PATCH", base(), { token: ownerToken, body: { language: "en", date_format: "DD.MM.YYYY" } });
		const target = await issued(twoLines);
		const storageBeforeCredit = await storageFor(projectUuid);
		const note = (await credit(target.uuid, { reason: "Original reason" })).data;
		const firstDocument = await call("GET", `${base()}/credit-notes/${note.uuid}/document`, { token: ownerToken });
		const firstPdf = await Server.app.handle(
			new Request(`http://127.0.0.1${base()}/credit-notes/${note.uuid}/pdf`, { headers: { Authorization: `Bearer ${ownerToken}` } })
		);
		const firstBytes = new Uint8Array(await firstPdf.arrayBuffer());

		await call("PUT", `${base()}/company`, {
			token: ownerToken,
			body: { legal_name: "Changed Credit Seller d.o.o.", address_line1: "Changed Street 2", country: "AT" },
		});
		await call("PATCH", base(), {
			token: ownerToken,
			body: { language: "sl", date_format: "YYYY-MM-DD", vat_status: "small_business", tax_country: "AT" },
		});

		const secondDocument = await call("GET", `${base()}/credit-notes/${note.uuid}/document`, { token: ownerToken });
		const secondPdf = await Server.app.handle(
			new Request(`http://127.0.0.1${base()}/credit-notes/${note.uuid}/pdf`, { headers: { Authorization: `Bearer ${ownerToken}` } })
		);
		const secondBytes = new Uint8Array(await secondPdf.arrayBuffer());
		const checksum = new Bun.CryptoHasher("sha256").update(firstBytes).digest("hex");

		expect(secondDocument.data.seller).toEqual(firstDocument.data.seller);
		expect(secondDocument.data.language).toBe(firstDocument.data.language);
		expect(secondDocument.data.formats).toEqual(firstDocument.data.formats);
		expect(secondDocument.data.tax).toEqual(firstDocument.data.tax);
		expect(new Bun.CryptoHasher("sha256").update(secondBytes).digest("hex")).toBe(checksum);
		const [archive] = (await Database`SELECT * FROM credit_note_documents WHERE credit_note = ${note.uuid}`) as {
			storage_key: string;
			status: string;
			byte_size: number;
			sha256: string;
		}[];
		expect(archive.storage_key).toStartWith(`credit-notes/${projectUuid}/${note.uuid}/`);
		expect(archive.status).toBe("ready");
		expect(archive.byte_size).toBe(firstBytes.byteLength);
		expect(archive.sha256).toBe(checksum);
		expect((await storageFor(projectUuid)).storage_used - storageBeforeCredit.storage_used).toBe(archive.byte_size);
		await documentStorage().put(archive.storage_key, new Uint8Array([1, 2, 3]), "application/pdf");
		const repairedPdf = await Server.app.handle(
			new Request(`http://127.0.0.1${base()}/credit-notes/${note.uuid}/pdf`, { headers: { Authorization: `Bearer ${ownerToken}` } })
		);
		const repairedBytes = new Uint8Array(await repairedPdf.arrayBuffer());
		const [repaired] = (await Database`SELECT * FROM credit_note_documents WHERE credit_note = ${note.uuid}`) as {
			storage_key: string;
			status: string;
			byte_size: number;
			sha256: string;
		}[];
		expect(repaired.storage_key).not.toBe(archive.storage_key);
		expect(repaired.status).toBe("ready");
		expect(repaired.byte_size).toBe(repairedBytes.byteLength);
		expect(repaired.sha256).toBe(new Bun.CryptoHasher("sha256").update(repairedBytes).digest("hex"));

		await call("PUT", `${base()}/company`, {
			token: ownerToken,
			body: { legal_name: "Credit Notes d.o.o.", address_line1: "Dunajska cesta 1", postal_code: "1000", city: "Ljubljana", country: "SI" },
		});
		await call("PATCH", base(), { token: ownerToken, body: { language: "en", vat_status: "registered", tax_country: "SI" } });
	});

	test("retries a failed credit note archive in the background", async () => {
		const target = await issued(twoLines);
		const note = (await credit(target.uuid, { amount: 1000 })).data;
		const [archive] = (await Database`SELECT storage_key FROM credit_note_documents WHERE credit_note = ${note.uuid}`) as { storage_key: string }[];
		await documentStorage().remove(archive.storage_key);
		await Database`
			UPDATE credit_note_documents SET status = 'failed', byte_size = NULL, sha256 = NULL, next_attempt_at = 0
			WHERE credit_note = ${note.uuid}
		`;

		const result = await archivePendingCreditNotes();
		const [retried] = (await Database`SELECT status, byte_size, sha256 FROM credit_note_documents WHERE credit_note = ${note.uuid}`) as {
			status: string;
			byte_size: number;
			sha256: string;
		}[];
		expect(result.archived).toBeGreaterThanOrEqual(1);
		expect(retried.status).toBe("ready");
		expect(retried.byte_size).toBeGreaterThan(0);
		expect(retried.sha256).toHaveLength(64);
	});

	test("names the invoice it corrects and carries its tax notes and reporting currency", async () => {
		const target = await issued([{ description: "Consulting", quantity: 1, unit_price: 10000, tax_rate: 0, tax_treatment: "reverse_charge" }], {
			currency: "USD",
			customer: foreignCustomerUuid,
		});
		await call("PUT", `${base()}/invoices/${target.uuid}/tax-rate`, { token: ownerToken, body: { rate: 0.9 } });
		const note = (await credit(target.uuid, { reason: "Discount agreed" })).data;

		const document = await call("GET", `${base()}/credit-notes/${note.uuid}/document`, { token: ownerToken });
		expect(document.data.credit_note.reference).toBe(note.reference);
		expect(document.data.corrects).toEqual({ uuid: target.uuid, reference: target.reference, issued: target.issued_at });
		expect(document.data.items).toEqual([{ description: "Consulting", tax_rate: 0, tax_treatment: "reverse_charge", net_amount: 10000, tax_amount: 0 }]);
		expect(document.data.tax.notes).toHaveLength(1);
		expect(document.data.tax.reporting).toBeNull();

		const single = await call("GET", `${base()}/credit-notes/${note.uuid}`, { token: ownerToken });
		expect(single.data.items).toHaveLength(1);
	});

	test("is not found in another project or with a bad id", async () => {
		const other = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "cn-other", currency: "EUR" } })).data.uuid;
		const note = (await call("GET", `${base()}/credit-notes`, { token: ownerToken })).data.credit_notes[0];

		expect((await call("GET", `/api/v1/projects/${other}/credit-notes/${note.uuid}`, { token: ownerToken })).error).toBe(1076);
		expect((await call("GET", `${base()}/credit-notes/nope`, { token: ownerToken })).error).toBe(1077);
	});

	test("lists every credit note with the invoice it belongs to", async () => {
		const res = await call("GET", `${base()}/credit-notes`, { token: ownerToken });

		expect(res.data.total).toBeGreaterThan(5);
		expect(res.data.credit_notes[0].invoice_reference).toMatch(/^[0-9]{12}$/);
	});
});

describe("credit notes in the VAT report", () => {
	test("are subtracted in the period they were issued", async () => {
		const fresh = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "cn-report", currency: "EUR" } })).data.uuid;
		const path = `/api/v1/projects/${fresh}`;
		await call("PATCH", path, { token: ownerToken, body: { tax_country: "SI", vat_status: "registered", tax_currency: "EUR" } });
		await call("PUT", `${path}/company`, {
			token: ownerToken,
			body: {
				legal_name: "Credit Report d.o.o.",
				address_line1: "Trg 1",
				postal_code: "1000",
				city: "Ljubljana",
				country: "SI",
				vat_number: "SI12345678",
			},
		});

		const created = await call("POST", `${path}/invoices`, {
			token: ownerToken,
			body: { due_date: Date.now() + 86400000, supply_date: Date.now(), items: twoLines },
		});
		await call("POST", `${path}/invoices/${created.data.uuid}/open`, { token: ownerToken });
		await call("POST", `${path}/invoices/${created.data.uuid}/credit-notes`, { token: ownerToken, body: { amount: 12200 } });

		const report = (await call("POST", `${path}/reports/vat`, { token: ownerToken })).data;
		expect(report.invoices).toBe(1);
		expect(report.credit_notes).toBe(1);

		const total = report.domestic.reduce((sum: number, row: any) => sum + row.net + row.vat, 0);
		expect(total).toBe(17675 - 12200);
		expect(report.domestic.find((row: any) => row.rate === 22)).toEqual({ rate: 22, net: 10000 - 6902, vat: 2200 - 1519 });
	});
});
