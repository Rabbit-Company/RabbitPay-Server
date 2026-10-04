import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { prepareTest } from "./environment";
import { endOfLocalDate, localDate, shiftLocalDate, startOfLocalDate } from "../server/timezone";

await prepareTest(`sqlite://${import.meta.dir}/.ddv-evidence.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");

await Server.configure();

const password = new Bun.CryptoHasher("blake2b512").update("ddv-owner").digest("hex");
const timezone = "Europe/Ljubljana";
const january = { from: startOfLocalDate("2026-01-01", timezone), to: endOfLocalDate("2026-01-31", timezone) };
let token = "";
let project = "";
let expense = "";

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

function query(options: Record<string, unknown>): string {
	const values = new URLSearchParams();
	for (const [key, value] of Object.entries(options)) if (value !== null) values.set(key, String(value));
	return values.toString();
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await call("POST", "/api/v1/auth/register", { email: "ddv-owner@example.com", password });
	token = (await call("POST", "/api/v1/auth/login", { email: "ddv-owner@example.com", password })).data.token;
	project = (await call("POST", "/api/v1/projects", { name: "ddv-evidence", currency: "EUR" })).data.uuid;
	const base = `/api/v1/projects/${project}`;
	await call("PATCH", base, { tax_country: "SI", vat_status: "registered", tax_currency: "EUR" });
	await call("PUT", `${base}/company`, {
		legal_name: "DDV Test d.o.o.",
		address_line1: "Dunajska cesta 1",
		postal_code: "1000",
		city: "Ljubljana",
		country: "SI",
		tax_number: "12345678",
		vat_number: "SI12345678",
	});
	const invoice = (
		await call("POST", `${base}/invoices`, {
			currency: "EUR",
			due_date: Date.UTC(2026, 0, 31),
			supply_date: Date.UTC(2026, 0, 10),
			items: [{ description: "Consulting", quantity: 1, unit_price: 10000, tax_rate: 22, tax_treatment: "domestic" }],
		})
	).data;
	await call("POST", `${base}/invoices/${invoice.uuid}/open`);
	await Database`UPDATE invoices SET issued_at = ${Date.UTC(2026, 0, 10)} WHERE uuid = ${invoice.uuid}`;
	const created = await call("POST", `${base}/expenses`, {
		description: "Office supplies",
		supplier: "Supplier d.o.o.",
		supplier_tax_number: "SI87654321",
		supplier_country: "SI",
		invoice_number: "DOB-2026-1",
		category: "Office",
		currency: "EUR",
		total_amount: 12200,
		tax_amount: 2200,
		deductible_tax_amount: 2200,
		expense_date: Date.UTC(2026, 0, 12),
		issue_date: Date.UTC(2026, 0, 11),
		receipt_date: Date.UTC(2026, 0, 12),
		supply_date: Date.UTC(2026, 0, 11),
		vat_treatment: "domestic",
		asset_type: "expense",
		vat_handling: "1",
		self_assessment_period: null,
		self_assessment_tax: null,
		vat_lines: [{ rate: 22, tax_base: 10000, tax_amount: 2200, deductible_tax_amount: 2200 }],
		paid_at: null,
		notes: null,
	});
	expect(created.status).toBe(201);
	expense = created.data.uuid;
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-wal", "-shm"]) {
		try {
			unlinkSync(`${import.meta.dir}/.ddv-evidence.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("official FURS DDV evidence", () => {
	test("accepts complete calendar months and quarters only", async () => {
		const base = `/api/v1/projects/${project}/reports/ddv-evidence`;
		const flags = { refund: false, deductible_share: false, late_submission: null, insolvency: false, tax_authority_order: false, note: null };
		const month = await call("GET", `${base}?${query({ ...january, ...flags })}`);
		expect(month.status).toBe(200);
		const quarter = await call(
			"GET",
			`${base}?${query({ from: startOfLocalDate("2026-01-01", timezone), to: endOfLocalDate("2026-03-31", timezone), ...flags })}`
		);
		expect(quarter.status).toBe(200);
		const extraDay = await call(
			"GET",
			`${base}?${query({ from: startOfLocalDate("2026-09-01", timezone), to: endOfLocalDate("2026-10-01", timezone), ...flags })}`
		);
		expect(extraDay.status).toBe(400);
		expect(extraDay.error).toBe(1125);
		const shiftedQuarter = await call(
			"GET",
			`${base}?${query({ from: startOfLocalDate("2026-02-01", timezone), to: endOfLocalDate("2026-04-30", timezone), ...flags })}`
		);
		expect(shiftedQuarter.status).toBe(400);
		expect(shiftedQuarter.error).toBe(1125);
	});

	test("blocks export until the original supplier invoice is attached", async () => {
		const base = `/api/v1/projects/${project}/reports/ddv-evidence`;
		const options = { ...january, refund: false, deductible_share: false, late_submission: null, insolvency: false, tax_authority_order: false, note: null };
		const preview = await call("GET", `${base}?${query(options)}`);
		expect(preview.data.errors.map((entry: any) => entry.code)).toContain("missing_attachment");
		const blocked = await call("POST", `${base}/exports`, options);
		expect(blocked.status).toBe(409);
	});

	test("builds invoice-level KIR and KPR records and reconciles them", async () => {
		const base = `/api/v1/projects/${project}`;
		const uploaded = await call("PUT", `${base}/expenses/${expense}/attachment`, {
			name: "supplier-invoice.pdf",
			type: "application/pdf",
			data: Buffer.from("%PDF-1.7\ninvoice").toString("base64"),
		});
		expect(uploaded.status).toBe(200);
		const options = { ...january, refund: false, deductible_share: false, late_submission: null, insolvency: false, tax_authority_order: false, note: null };
		const preview = await call("GET", `${base}/reports/ddv-evidence?${query(options)}`);
		expect(preview.data.errors).toEqual([]);
		expect(preview.data.reconciliation.balanced).toBe(true);
		const kir = preview.data.evidence.DDV_KIR_KPR.Lista_KIR.KIR;
		const kpr = preview.data.evidence.DDV_KIR_KPR.Lista_KPR.KPR;
		expect(kir).toHaveLength(1);
		expect(kir[0]).toMatchObject({ ZAPST: 1, OBDOBJE: "0101", P7: 100, P14: 22, OBRAVNAVA: "1" });
		expect(kpr).toHaveLength(1);
		expect(kpr[0]).toMatchObject({ ZAPST: 1, OBDOBJE: "0101", P3: "DOB-2026-1", P7: "SI", P7DS: "87654321", P8: 100, P18: 22, OBRAVNAVA: "1" });
	});

	test("stores each correction as an immutable downloadable revision", async () => {
		const base = `/api/v1/projects/${project}/reports/ddv-evidence`;
		const options = { ...january, refund: false, deductible_share: false, late_submission: null, insolvency: false, tax_authority_order: false, note: null };
		const first = await call("POST", `${base}/exports`, options);
		const second = await call("POST", `${base}/exports`, options);
		expect(first.data.export.revision).toBe(1);
		expect(second.data.export.revision).toBe(2);
		const history = await call("GET", `${base}/exports`);
		expect(history.data.map((row: any) => row.revision)).toEqual([2, 1]);
		const downloaded = await call("GET", `${base}/exports/${second.data.export.uuid}`);
		const bytes = new Uint8Array(await downloaded.response.arrayBuffer());
		expect(downloaded.response.headers.get("Content-Type")).toBe("application/zip");
		expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(0x04034b50);
		expect(new TextDecoder().decode(bytes)).toContain('"DDV_KIR_KPR"');
		const locks = await call("GET", `${base}/locks`);
		expect(locks.data).toHaveLength(1);
		expect(locks.data[0].active).toBe(true);
		const blocked = await call("PATCH", `/api/v1/projects/${project}/expenses/${expense}`, { notes: "late change" });
		expect(blocked.error).toBe(1128);
		const invalidUnlock = await call("POST", `${base}/locks/${locks.data[0].uuid}/unlock`, { reason: "x" });
		expect(invalidUnlock.error).toBe(1130);
		const unlocked = await call("POST", `${base}/locks/${locks.data[0].uuid}/unlock`, { reason: "Supplier correction received" });
		expect(unlocked.data.active).toBe(false);
		const [audit] = (await Database`SELECT COUNT(*) AS count FROM audit_log WHERE action = 'accounting_period.unlocked'`) as { count: number }[];
		expect(Number(audit.count)).toBe(1);
	});
	test("books a domestic reverse charge sale in field 8 of the issued invoice book", async () => {
		const base = `/api/v1/projects/${project}`;
		const customer = await call("POST", `${base}/customers`, {
			email: "gradnje@example.com",
			name: "Gradnje d.o.o.",
			address_line1: "Cesta 1",
			postal_code: "2000",
			city: "Maribor",
			country: "SI",
			vat_number: "SI87654321",
			customer_type: "business",
		});
		const invoice = await call("POST", `${base}/invoices`, {
			customer: customer.data.uuid,
			currency: "EUR",
			due_date: Date.UTC(2026, 1, 28),
			supply_date: Date.UTC(2026, 1, 10),
			status: "open",
			items: [{ description: "Gradbena dela", quantity: 1, unit_price: 25000, tax_rate: 0, tax_treatment: "domestic_reverse_charge" }],
		});
		expect(invoice.data.issued_at).toBeGreaterThan(0);
		await Database`UPDATE invoices SET issued_at = ${Date.UTC(2026, 1, 10)} WHERE uuid = ${invoice.data.uuid}`;

		const february = { from: startOfLocalDate("2026-02-01", timezone), to: endOfLocalDate("2026-02-28", timezone) };
		const options = { ...february, refund: false, deductible_share: false, late_submission: null, insolvency: false, tax_authority_order: false, note: null };
		const preview = await call("GET", `${base}/reports/ddv-evidence?${query(options)}`);
		const kir = preview.data.evidence.DDV_KIR_KPR.Lista_KIR.KIR;
		expect(preview.data.errors).toEqual([]);
		expect(kir).toHaveLength(1);
		expect(kir[0]).toMatchObject({ P8: 250, OBRAVNAVA: "1" });
		expect(kir[0].P7).toBeUndefined();
		expect(kir[0].P10).toBeUndefined();
	});
	test("reports an invoice in the period of its supply date and a late one in the current period as a correction", async () => {
		const base = `/api/v1/projects/${project}`;
		const march = { from: startOfLocalDate("2026-03-01", timezone), to: endOfLocalDate("2026-03-31", timezone) };
		const options = { ...march, refund: false, deductible_share: false, late_submission: null, insolvency: false, tax_authority_order: false, note: null };
		const issue = (supplied: string | null, extra: Record<string, unknown> = {}) =>
			call("POST", `${base}/invoices`, {
				...extra,
				currency: "EUR",
				due_date: Date.now() + 86400000,
				supply_date: supplied === null ? null : startOfLocalDate(supplied, timezone),
				status: "open",
				items: [{ description: "Consulting", quantity: 1, unit_price: 30000, tax_rate: 22, tax_treatment: "domestic" }],
			});

		const late = await issue("2026-03-20");
		expect(late.error).toBe(0);
		expect(late.data.tax_point_date).toBe(startOfLocalDate("2026-03-20", timezone));
		expect(late.data.issued_at).toBeGreaterThan(march.to);

		const preview = await call("GET", `${base}/reports/ddv-evidence?${query(options)}`);
		const kir = preview.data.evidence.DDV_KIR_KPR.Lista_KIR.KIR;
		expect(kir).toHaveLength(1);
		expect(kir[0]).toMatchObject({ OBDOBJE: "0303", P3: late.data.reference, P7: 300, P14: 66 });
		const report = await call("POST", `${base}/reports/vat?from=${march.from}&to=${march.to}`);
		expect(report.data.invoices).toBe(1);
		expect(report.data.domestic).toEqual([{ rate: 22, net: 30000, vat: 6600 }]);

		const exported = await call("POST", `${base}/reports/ddv-evidence/exports`, options);
		expect(exported.status).toBe(201);

		const refused = await issue("2026-03-25");
		expect(refused.error).toBe(1132);
		expect(refused.data.issues.map((entry: { code: string }) => entry.code)).toEqual(["tax_period_locked"]);
		expect(refused.info).toContain("2026-03-25");
		expect((await issue(null)).error).toBe(0);

		const reported = await issue("2026-03-25", { late_vat_report: true });
		expect(reported.error).toBe(0);
		expect(reported.data).toMatchObject({
			tax_point_date: startOfLocalDate("2026-03-25", timezone),
			vat_period_date: reported.data.issued_at,
			vat_handling: "2",
			vat_correction_period: "03032026",
		});

		const draft = await call("POST", `${base}/invoices`, {
			currency: "EUR",
			due_date: Date.now() + 86400000,
			supply_date: startOfLocalDate("2026-03-26", timezone),
			items: [{ description: "Export", quantity: 1, unit_price: 5000, tax_rate: 0, tax_treatment: "export" }],
		});
		expect((await call("POST", `${base}/invoices/${draft.data.uuid}/open`)).error).toBe(1132);
		const untaxed = await call("POST", `${base}/invoices/${draft.data.uuid}/open`, { late_vat_report: true });
		expect(untaxed.data).toMatchObject({ vat_handling: "1", vat_correction_period: null, vat_period_date: untaxed.data.issued_at });

		const again = await call("GET", `${base}/reports/ddv-evidence?${query(options)}`);
		expect(again.data.evidence.DDV_KIR_KPR.Lista_KIR.KIR).toHaveLength(1);

		const currentMonth = localDate(Date.now(), timezone).slice(0, 7);
		const current = {
			...options,
			from: startOfLocalDate(`${currentMonth}-01`, timezone),
			to: startOfLocalDate(`${shiftLocalDate(`${currentMonth}-28`, 4).slice(0, 7)}-01`, timezone) - 1,
		};
		const currentPreview = await call("GET", `${base}/reports/ddv-evidence?${query(current)}`);
		const records = currentPreview.data.evidence.DDV_KIR_KPR.Lista_KIR.KIR as Record<string, unknown>[];
		const lateRecord = records.find((record) => record.P3 === reported.data.reference)!;
		expect(lateRecord).toMatchObject({ OBRAVNAVA: "2", OBDOBJE88: "03032026", DAVEK88: 66, P7: 300, P14: 66 });
		expect(records.find((record) => record.P3 === untaxed.data.reference)).toMatchObject({ OBRAVNAVA: "1", P7: 50 });
		expect(records.find((record) => record.P3 === untaxed.data.reference)!.OBDOBJE88).toBeUndefined();
	});
	test("reports sales taxed in another EU country under OSS by their net value, without the foreign VAT", async () => {
		const base = `/api/v1/projects/${project}`;
		const customer = await call("POST", `${base}/customers`, { name: "Marie Dupont", country: "FR", customer_type: "individual" });
		const invoice = await call("POST", `${base}/invoices`, {
			customer: customer.data.uuid,
			currency: "EUR",
			due_date: Date.now() + 86400000,
			supply_date: startOfLocalDate("2026-04-10", timezone),
			status: "open",
			items: [
				{ description: "App subscription", quantity: 1, unit_price: 10000, tax_rate: 20, tax_treatment: "oss" },
				{ description: "Setup", quantity: 1, unit_price: 5000, tax_rate: 22, tax_treatment: "domestic" },
			],
		});
		expect(invoice.error).toBe(0);

		const april = { from: startOfLocalDate("2026-04-01", timezone), to: endOfLocalDate("2026-04-30", timezone) };
		const options = { ...april, refund: false, deductible_share: false, late_submission: null, insolvency: false, tax_authority_order: false, note: null };
		const preview = await call("GET", `${base}/reports/ddv-evidence?${query(options)}`);
		const kir = preview.data.evidence.DDV_KIR_KPR.Lista_KIR.KIR;
		expect(preview.data.errors).toEqual([]);
		expect(preview.data.warnings).toEqual([]);
		expect(kir).toHaveLength(1);
		expect(kir[0]).toMatchObject({ P3: invoice.data.reference, P27: 100, P7: 50, P14: 11 });
		expect(preview.data.reconciliation.kir).toMatchObject({ source_base: 15000, evidence_base: 15000, source_vat: 1100, evidence_vat: 1100 });
		expect(preview.data.reconciliation.balanced).toBe(true);
	});
});
