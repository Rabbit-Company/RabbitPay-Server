import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { prepareTest } from "./environment";

await prepareTest(`sqlite://${import.meta.dir}/.accountant-package.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { vatReturnFromEvidence } = await import("../server/accountant-package");
const { diffSnapshots, runScheduledPackages } = await import("../server/accountant-package-sending");

await Server.configure();

const password = new Bun.CryptoHasher("blake2b512").update("package-owner").digest("hex");
let token = "";
let project = "";
let cardReceipt = "";
const base = () => `/api/v1/projects/${project}`;
const september = "from=2026-09-01&to=2026-09-30";

async function call(method: string, path: string, body?: unknown): Promise<any> {
	const response = await Server.app.handle(
		new Request(`http://localhost${path}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	);
	const type = response.headers.get("Content-Type") ?? "";
	if (!type.includes("application/json")) return { status: response.status, response };
	return { status: response.status, ...((await response.json()) as { error: number; data: any }) };
}

function zipNames(archive: Uint8Array): string[] {
	const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
	const end = archive.length - 22;
	const count = view.getUint16(end + 10, true);
	let cursor = view.getUint32(end + 16, true);
	const names: string[] = [];
	for (let index = 0; index < count; index++) {
		const nameLength = view.getUint16(cursor + 28, true);
		names.push(new TextDecoder().decode(archive.subarray(cursor + 46, cursor + 46 + nameLength)));
		cursor += 46 + nameLength + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
	}
	return names;
}

function expense(overrides: Record<string, unknown>) {
	return {
		description: "Office supplies",
		supplier: "Pisarna Zalokar d.o.o.",
		supplier_tax_number: "SI87654321",
		supplier_country: "SI",
		invoice_number: "DOB-2026-1",
		category: "Office",
		currency: "EUR",
		total_amount: 12200,
		tax_amount: 2200,
		deductible_tax_amount: 2200,
		expense_date: Date.UTC(2026, 8, 12),
		issue_date: Date.UTC(2026, 8, 11),
		receipt_date: Date.UTC(2026, 8, 12),
		supply_date: Date.UTC(2026, 8, 11),
		vat_treatment: "domestic",
		asset_type: "expense",
		vat_handling: "1",
		self_assessment_period: null,
		self_assessment_tax: null,
		vat_lines: [{ rate: 22, tax_base: 10000, tax_amount: 2200, deductible_tax_amount: 2200 }],
		paid_at: Date.UTC(2026, 8, 20),
		notes: null,
		...overrides,
	};
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await call("POST", "/api/v1/auth/register", { email: "package-owner@example.com", password });
	token = (await call("POST", "/api/v1/auth/login", { email: "package-owner@example.com", password })).data.token;
	project = (await call("POST", "/api/v1/projects", { name: "package-studio", currency: "EUR" })).data.uuid;
	await call("PATCH", base(), { tax_country: "SI", vat_status: "registered", tax_currency: "EUR", timezone: "Europe/Ljubljana", language: "sl" });
	await call("PUT", `${base()}/company`, {
		legal_name: "Lakirnica Zelen d.o.o.",
		address_line1: "Dunajska cesta 1",
		postal_code: "1000",
		city: "Ljubljana",
		country: "SI",
		tax_number: "12345678",
		vat_number: "SI12345678",
	});
	const invoice = (
		await call("POST", `${base()}/invoices`, {
			currency: "EUR",
			due_date: Date.UTC(2026, 9, 15),
			supply_date: Date.UTC(2026, 8, 10),
			items: [{ description: "Powder coating", quantity: 1, unit_price: 10000, tax_rate: 22, tax_treatment: "domestic" }],
		})
	).data;
	await call("POST", `${base()}/invoices/${invoice.uuid}/open`);
	await Database`UPDATE invoices SET issued_at = ${Date.UTC(2026, 8, 10)}, vat_period_date = ${Date.UTC(2026, 8, 10)} WHERE uuid = ${invoice.uuid}`;

	const domestic = await call("POST", `${base()}/expenses`, expense({}));
	expect(domestic.status).toBe(201);
	expect(domestic.data.payment_method).toBe("transfer");
	const upload = await call("PUT", `${base()}/expenses/${domestic.data.uuid}/attachment`, {
		name: "racun.pdf",
		type: "application/pdf",
		data: Buffer.from("%PDF-1.4 supplier invoice").toString("base64"),
	});
	expect(upload.error).toBe(0);

	const foreign = await call(
		"POST",
		`${base()}/expenses`,
		expense({
			supplier: "Alpenlack Beschichtung GmbH",
			supplier_tax_number: "ATU12345678",
			supplier_country: "AT",
			invoice_number: "AL-7466",
			vat_treatment: "eu_services",
			total_amount: 5000,
			tax_amount: 1100,
			deductible_tax_amount: 1100,
			vat_lines: [{ rate: 22, tax_base: 5000, tax_amount: 1100, deductible_tax_amount: 1100 }],
			paid_at: null,
		})
	);
	expect(foreign.status).toBe(201);

	const card = await call(
		"POST",
		`${base()}/expenses`,
		expense({
			description: "Fuel",
			supplier: "Bencinski servis Lipa d.o.o.",
			supplier_tax_number: "SI11223344",
			invoice_number: "2351-2-44297",
			total_amount: 6100,
			tax_amount: 1100,
			deductible_tax_amount: 1100,
			vat_lines: [{ rate: 22, tax_base: 5000, tax_amount: 1100, deductible_tax_amount: 1100 }],
			paid_at: Date.UTC(2026, 8, 12),
			payment_method: "card",
		})
	);
	expect(card.status).toBe(201);
	expect(card.data.payment_method).toBe("card");
	cardReceipt = card.data.uuid;

	const statement = crypto.randomUUID();
	const now = Date.now();
	await Database`INSERT INTO bank_statements(uuid, project, iban, statement_id, currency, period_from, period_to, opening_balance, closing_balance, file_name, created)
		VALUES(${statement}, ${project}, ${"SI56330000000397012"}, ${"2026-09"}, ${"EUR"}, ${Date.UTC(2026, 8, 1)}, ${Date.UTC(2026, 8, 30)}, ${50000}, ${43900}, ${"izpisek.xml"}, ${now})`;
	const matched = crypto.randomUUID();
	await Database`INSERT INTO bank_transactions(uuid, project, statement, booking_date, amount, currency, counterparty_name, reference, fingerprint, status, created)
		VALUES(${matched}, ${project}, ${statement}, ${Date.UTC(2026, 8, 20)}, ${-12200}, ${"EUR"}, ${"Pisarna Zalokar d.o.o."}, ${"SI00 DOB-2026-1"}, ${"f1"}, ${"matched"}, ${now})`;
	await Database`INSERT INTO bank_transaction_matches(uuid, project, bank_transaction, match_type, match_id, amount, created)
		VALUES(${crypto.randomUUID()}, ${project}, ${matched}, ${"expense"}, ${domestic.data.uuid}, ${12200}, ${now})`;
	await Database`INSERT INTO bank_transactions(uuid, project, statement, booking_date, amount, currency, counterparty_name, remittance, fingerprint, status, created)
		VALUES(${crypto.randomUUID()}, ${project}, ${statement}, ${Date.UTC(2026, 8, 30)}, ${6100}, ${"EUR"}, ${"Neznani placnik"}, ${"Akontacija"}, ${"f2"}, ${"open"}, ${now})`;
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-wal", "-shm"]) {
		try {
			unlinkSync(`${import.meta.dir}/.accountant-package.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("expense payment method", () => {
	test("rejects an unknown method and keeps the stored one", async () => {
		const invalid = await call("PATCH", `${base()}/expenses/${cardReceipt}`, { payment_method: "crypto" });
		expect(invalid.status).toBe(400);
		const kept = await call("GET", `${base()}/expenses/${cardReceipt}`);
		expect(kept.data.payment_method).toBe("card");
	});
});

describe("accountant package", () => {
	test("splits received invoices like a bookkeeping hand-off and sums the DDV-O return", async () => {
		const summary = await call("GET", `${base()}/accountant-package?${september}`);
		expect(summary.status).toBe(200);
		expect(summary.data.issued).toEqual({ count: 1, net: 10000, vat: 2200, total: 12200 });
		expect(summary.data.credit_notes.count).toBe(0);
		expect(summary.data.received_domestic).toEqual({ count: 1, net: 10000, vat: 2200, total: 12200 });
		expect(summary.data.received_foreign.count).toBe(1);
		expect(summary.data.received_on_spot).toEqual({ count: 1, net: 5000, vat: 1100, total: 6100 });

		const fields = summary.data.vat_return.fields;
		expect(fields["11"]).toBe(10000);
		expect(fields["21"]).toBe(2200);
		expect(fields["23a"]).toBe(1100);
		expect(fields["31"]).toBe(15000);
		expect(fields["32a"]).toBe(5000);
		expect(fields["41"]).toBe(4400);
		expect(fields["51"]).toBe(0);
		expect(fields["52"]).toBe(1100);

		expect(summary.data.bank).toEqual({ accounts: 1, lines: 2, unmatched: 1, used: true });
		expect(summary.data.open_items.receivable).toBe(12200);
		expect(summary.data.open_items.receivable_count).toBe(1);
		expect(summary.data.open_items.payable_count).toBe(1);
		expect(summary.data.open_items.payable).toBe(5000);
		expect(summary.data.checks.find((check: any) => check.code === "bank_unmatched")?.detail).toBe("1");

		const missing = summary.data.checks.filter((check: any) => check.code === "missing_original").map((check: any) => check.reference);
		expect(missing.sort()).toEqual(["2351-2-44297", "AL-7466"]);
	});

	test("refuses periods without both dates or longer than a year", async () => {
		for (const range of ["from=2026-09-01", "from=2026-09-30&to=2026-09-01", "from=2025-01-01&to=2026-01-31"]) {
			const response = await call("GET", `${base()}/accountant-package?${range}`);
			expect(response.status).toBe(400);
			expect(response.error).toBe(1371);
		}
	});

	test("downloads one zip with the overview, CSV files and every original", async () => {
		const result = await call("GET", `${base()}/accountant-package/zip?${september}`);
		expect(result.status).toBe(200);
		const response = result.response as Response;
		expect(response.headers.get("Content-Type")).toBe("application/zip");
		expect(decodeURIComponent(response.headers.get("Content-Disposition") ?? "")).toContain("paket za računovodstvo 2026-09.zip");
		const names = zipNames(new Uint8Array(await response.arrayBuffer()));
		expect(names[0]).toBe("Pregled 2026-09.pdf");
		expect(names).toContain("CSV/izdani-racuni.csv");
		expect(names).toContain("CSV/prejeti-racuni.csv");
		expect(names).toContain("CSV/ddv-o.csv");
		expect(names).toContain("CSV/banka.csv");
		expect(names).toContain("CSV/odprte-postavke.csv");
		expect(names.some((name) => name.startsWith("Izdani računi/") && name.endsWith(".pdf"))).toBe(true);
		expect(names).toContain("Prejeti računi/Domači/2026-09-12 Pisarna Zalokar d.o.o. DOB-2026-1.pdf");
	});

	test("renders the overview PDF on its own", async () => {
		const result = await call("GET", `${base()}/accountant-package/overview?${september}`);
		expect(result.status).toBe(200);
		const bytes = new Uint8Array(await (result.response as Response).arrayBuffer());
		expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
	});
});

describe("sending to the accountant", () => {
	const september = { from: "2026-09-01", to: "2026-09-30" };
	const tokenOf = async () => {
		const [message] =
			(await Database`SELECT body_text FROM email_messages WHERE project = ${project} AND kind = 'accountant_package' ORDER BY created DESC LIMIT 1`) as {
				body_text: string;
			}[];
		return /accountant-package\/([A-Za-z0-9_-]{43})/.exec(message.body_text)![1];
	};

	test("needs a valid address before anything is sent", async () => {
		const unset = await call("POST", `${base()}/accountant-package/send`, { ...september, kind: "full" });
		expect(unset.status).toBe(409);
		expect(unset.error).toBe(1374);
		for (const settings of [
			{ recipients: ["not an address"], send_day: null },
			{ recipients: [], send_day: 5 },
			{ recipients: ["a@example.com"], send_day: 29 },
			{ recipients: Array.from({ length: 6 }, (_, index) => `a${index}@example.com`), send_day: null },
		]) {
			const refused = await call("PUT", `${base()}/accountant-package/settings`, settings);
			expect(refused.error).toBe(1373);
		}
		const saved = await call("PUT", `${base()}/accountant-package/settings`, {
			recipients: ["Racunovodstvo@Example.com", "racunovodstvo@example.com", "partner@example.com"],
			send_day: null,
		});
		expect(saved.data.recipients).toEqual(["racunovodstvo@example.com", "partner@example.com"]);
		expect(saved.data.next_run).toBeNull();
	});

	test("emails the overview with a working download link and remembers what was sent", async () => {
		const sent = await call("POST", `${base()}/accountant-package/send`, { ...september, kind: "full" });
		expect(sent.status).toBe(201);
		expect(sent.data.kind).toBe("full");
		const messages =
			(await Database`SELECT recipient, attachment_name, subject FROM email_messages WHERE project = ${project} AND kind = 'accountant_package'`) as {
				recipient: string;
				attachment_name: string;
				subject: string;
			}[];
		expect(messages.map((message) => message.recipient).sort()).toEqual(["partner@example.com", "racunovodstvo@example.com"]);
		expect(messages[0].attachment_name).toBe("Pregled 2026-09.pdf");
		expect(messages[0].subject).toContain("paket za računovodstvo");

		const download = await Server.app.handle(new Request(`http://localhost/api/v1/accountant-package/${await tokenOf()}`));
		expect(download.status).toBe(200);
		expect(zipNames(new Uint8Array(await download.arrayBuffer()))).toContain("CSV/izdani-racuni.csv");
		const wrong = await Server.app.handle(new Request(`http://localhost/api/v1/accountant-package/${"x".repeat(43)}`));
		expect(wrong.status).toBe(404);

		const status = await call("GET", `${base()}/accountant-package/status?from=2026-09-01&to=2026-09-30`);
		expect(status.data.sends.length).toBe(1);
		expect(status.data.changes).toBeNull();
		const nothing = await call("POST", `${base()}/accountant-package/send`, { ...september, kind: "changes" });
		expect(nothing.error).toBe(1375);
	});

	test("sends only the documents that changed after the package went out", async () => {
		await call("PATCH", `${base()}/expenses/${cardReceipt}`, {
			total_amount: 6200,
			tax_amount: 1118,
			deductible_tax_amount: 1118,
			vat_lines: [{ rate: 22, tax_base: 5082, tax_amount: 1118, deductible_tax_amount: 1118 }],
		});
		const late = await call(
			"POST",
			`${base()}/expenses`,
			expense({ supplier: "Tiskarna Breza d.o.o.", supplier_tax_number: "SI55667788", invoice_number: "T-88" })
		);
		expect(late.status).toBe(201);
		await call("PATCH", `${base()}/expenses/${cardReceipt}`, { paid_at: Date.UTC(2026, 8, 13) });

		const status = await call("GET", `${base()}/accountant-package/status?from=2026-09-01&to=2026-09-30`);
		expect(status.data.changes.added).toEqual(["T-88 | Tiskarna Breza d.o.o."]);
		expect(status.data.changes.changed).toEqual(["2351-2-44297 | Bencinski servis Lipa d.o.o."]);
		expect(status.data.changes.removed).toEqual([]);

		const sent = await call("POST", `${base()}/accountant-package/send`, { ...september, kind: "changes" });
		expect(sent.status).toBe(201);
		expect(sent.data.changes.added.length).toBe(1);
		const download = await Server.app.handle(new Request(`http://localhost/api/v1/accountant-package/${await tokenOf()}`));
		const names = zipNames(new Uint8Array(await download.arrayBuffer()));
		expect(decodeURIComponent(download.headers.get("Content-Disposition") ?? "")).toContain("2026-09 spremembe.zip");
		expect(names.some((name) => name.startsWith("Izdani računi/"))).toBe(false);
		expect(names.some((name) => name.includes("Pisarna Zalokar"))).toBe(false);
		expect(names).toContain("CSV/prejeti-racuni.csv");

		const after = await call("GET", `${base()}/accountant-package/status?from=2026-09-01&to=2026-09-30`);
		expect(after.data.changes).toBeNull();
		expect(after.data.sends.map((entry: any) => entry.kind)).toEqual(["changes", "full"]);
	});

	test("sends last month once on the chosen day and leaves the rest for next month", async () => {
		await Database`DELETE FROM accountant_package_sends WHERE project = ${project}`;
		await call("PUT", `${base()}/accountant-package/settings`, { recipients: ["racunovodstvo@example.com"], send_day: 5 });
		await Database`UPDATE accountant_package_settings SET last_run = NULL WHERE project = ${project}`;
		expect(await runScheduledPackages(Date.UTC(2026, 9, 4, 10))).toBe(0);
		expect(await runScheduledPackages(Date.UTC(2026, 9, 5, 10))).toBe(1);
		expect(await runScheduledPackages(Date.UTC(2026, 9, 20, 10))).toBe(0);
		const [row] = (await Database`SELECT period_from, automatic, sent_by FROM accountant_package_sends WHERE project = ${project}`) as any[];
		expect(row.period_from).toBe("2026-09-01");
		expect(Number(row.automatic)).toBe(1);
		expect(row.sent_by).toBeNull();
		const settings = await call("GET", `${base()}/accountant-package/settings`);
		expect(settings.data.next_run).toMatch(/-05$/);
	});

	test("compares snapshots by document", () => {
		const diff = diffSnapshots(
			{ a: { hash: "1", label: "A" }, b: { hash: "2", label: "B" }, c: { hash: "3", label: "C" } },
			{ a: { hash: "1", label: "A" }, b: { hash: "9", label: "B" }, d: { hash: "4", label: "D" } }
		);
		expect(diff).toEqual({ added: ["D"], changed: ["B"], removed: ["C"], keys: ["b", "d"] });
	});
});

describe("DDV-O summary", () => {
	test("maps KIR and KPR fields and reports a surplus", () => {
		const summary = vatReturnFromEvidence(
			[{ OBRAVNAVA: "1", P7: 100, P14: 22, P10: 50 }],
			[
				{ OBRAVNAVA: "1", P8: 200, P18: 44, P13: 80 },
				{ OBRAVNAVA: "2", P10: 10, P18: 2.2 },
			]
		);
		expect(summary.fields["11"]).toBe(10000);
		expect(summary.fields["12"]).toBe(5000);
		expect(summary.fields["32"]).toBe(1000);
		expect(summary.fields["35"]).toBe(8000);
		expect(summary.fields["41"]).toBe(4620);
		expect(summary.fields["51"]).toBe(0);
		expect(summary.fields["52"]).toBe(2420);
		expect(summary.corrections).toBe(1);
	});
});
