import type { SQL } from "bun";
import Database from "../database/database";
import Validate from "../validate";
import { addIntegers } from "../database/numbers";
import { isTaxTreatment } from "../tax";
import { taxPointDate } from "../tax-reporting";
import type { ProjectRow, RecordedInvoiceLineRow, RecordedInvoiceRow } from "../database/models";
import type { RecordedInvoiceInput, RecordedInvoiceLineInput } from "./types";

export type { RecordedInvoiceInput, RecordedInvoiceLineInput };

export type RecordedInvoice = RecordedInvoiceRow & { lines: RecordedInvoiceLineRow[] };

const MAX_LINES = 50;

function timestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
}

function optionalTimestamp(value: unknown): boolean {
	return value === null || timestamp(value);
}

function validLine(line: unknown): line is RecordedInvoiceLineInput {
	if (!line || typeof line !== "object") return false;
	const data = line as Record<string, unknown>;
	return (
		typeof data.tax_rate === "number" &&
		Number.isFinite(data.tax_rate) &&
		data.tax_rate >= 0 &&
		data.tax_rate <= 100 &&
		isTaxTreatment(data.tax_treatment) &&
		typeof data.net_amount === "number" &&
		Number.isSafeInteger(data.net_amount) &&
		data.net_amount !== 0 &&
		Validate.minorUnitAmount(data.tax_amount)
	);
}

export function totalsOf(lines: RecordedInvoiceLineInput[]) {
	const subtotal = addIntegers(...lines.map((line) => line.net_amount));
	const tax = addIntegers(...lines.map((line) => line.tax_amount));
	return { subtotal, tax_amount: tax, total_amount: addIntegers(subtotal, tax) };
}

export function recordedInvoiceInput(data: Record<string, unknown>, previous?: RecordedInvoice): RecordedInvoiceInput {
	const base: Partial<RecordedInvoiceInput> = previous
		? {
				...previous,
				lines: previous.lines.map(({ tax_rate, tax_treatment, net_amount, tax_amount }) => ({ tax_rate, tax_treatment, net_amount, tax_amount })),
			}
		: {
				document_type: "invoice",
				buyer_vat_number: null,
				buyer_country: null,
				tax_exchange_rate: null,
				tax_rate_date: null,
				supply_date: null,
				due_date: null,
				paid_at: null,
				payment_account: "bank",
				notes: null,
			};
	const merged = { ...base, ...data } as RecordedInvoiceInput;
	return {
		document_type: merged.document_type,
		reference: typeof merged.reference === "string" ? merged.reference.trim() : merged.reference,
		buyer_name: typeof merged.buyer_name === "string" ? merged.buyer_name.trim() : merged.buyer_name,
		buyer_vat_number: typeof merged.buyer_vat_number === "string" ? merged.buyer_vat_number.trim() || null : merged.buyer_vat_number,
		buyer_country: merged.buyer_country,
		currency: merged.currency,
		tax_exchange_rate: merged.tax_exchange_rate,
		tax_rate_date: merged.tax_rate_date,
		issued_at: merged.issued_at,
		supply_date: merged.supply_date,
		due_date: merged.due_date,
		paid_at: merged.paid_at,
		payment_account: merged.payment_account,
		notes: typeof merged.notes === "string" ? merged.notes.trim() || null : merged.notes,
		lines: merged.lines,
	};
}

export function validRecordedInvoice(data: RecordedInvoiceInput, baseCurrency: string): boolean {
	const lines = Array.isArray(data.lines) ? data.lines : [];
	return (
		(data.document_type === "invoice" || data.document_type === "credit_note") &&
		typeof data.reference === "string" &&
		data.reference.length > 0 &&
		data.reference.length <= 64 &&
		typeof data.buyer_name === "string" &&
		data.buyer_name.length > 0 &&
		data.buyer_name.length <= 250 &&
		Validate.optionalText(data.buyer_vat_number, 80) &&
		(data.buyer_country === null || Validate.country(data.buyer_country)) &&
		Validate.currency(data.currency) &&
		(data.tax_exchange_rate === null ||
			(typeof data.tax_exchange_rate === "number" && Number.isFinite(data.tax_exchange_rate) && data.tax_exchange_rate > 0)) &&
		optionalTimestamp(data.tax_rate_date) &&
		(data.currency === baseCurrency || (data.tax_exchange_rate !== null && data.tax_rate_date !== null)) &&
		timestamp(data.issued_at) &&
		optionalTimestamp(data.supply_date) &&
		optionalTimestamp(data.due_date) &&
		optionalTimestamp(data.paid_at) &&
		(data.payment_account === "bank" || data.payment_account === "cash") &&
		Validate.optionalText(data.notes, 5000) &&
		lines.length > 0 &&
		lines.length <= MAX_LINES &&
		lines.every(validLine) &&
		totalsOf(lines).total_amount > 0
	);
}

export async function loadRecordedInvoice(project: string, uuid: string, sql: SQL = Database): Promise<RecordedInvoice | null> {
	const [row] = (await sql`SELECT * FROM recorded_invoices WHERE project = ${project} AND uuid = ${uuid}`) as RecordedInvoiceRow[];
	if (!row) return null;
	const lines = (await sql`SELECT * FROM recorded_invoice_lines WHERE recorded_invoice = ${uuid} ORDER BY sort_order`) as RecordedInvoiceLineRow[];
	return { ...row, lines };
}

async function writeLines(sql: SQL, uuid: string, lines: RecordedInvoiceLineInput[]) {
	await sql`DELETE FROM recorded_invoice_lines WHERE recorded_invoice = ${uuid}`;
	for (const [index, line] of lines.entries()) {
		await sql`
			INSERT INTO recorded_invoice_lines(uuid, recorded_invoice, tax_rate, tax_treatment, net_amount, tax_amount, sort_order)
			VALUES(${crypto.randomUUID()}, ${uuid}, ${line.tax_rate}, ${line.tax_treatment}, ${line.net_amount}, ${line.tax_amount}, ${index})
		`;
	}
}

export async function referenceTaken(project: string, data: RecordedInvoiceInput, except: string | null = null): Promise<boolean> {
	const [row] = (await Database`
		SELECT uuid FROM recorded_invoices WHERE project = ${project} AND document_type = ${data.document_type} AND reference = ${data.reference}
	`) as { uuid: string }[];
	return row !== undefined && row.uuid !== except;
}

export function recordedTaxPoint(project: Pick<ProjectRow, "timezone">, data: RecordedInvoiceInput): number {
	if (data.document_type === "credit_note") return data.issued_at;
	return taxPointDate(project.timezone, data.supply_date, data.issued_at, data.lines);
}

export async function insertRecordedInvoice(sql: SQL, project: ProjectRow, data: RecordedInvoiceInput, author: string): Promise<string> {
	const uuid = crypto.randomUUID();
	const now = Date.now();
	const totals = totalsOf(data.lines);
	await sql`
		INSERT INTO recorded_invoices(uuid, project, document_type, reference, buyer_name, buyer_vat_number, buyer_country, currency, tax_currency,
			tax_exchange_rate, tax_rate_date, issued_at, supply_date, tax_point_date, due_date, paid_at, payment_account, subtotal, tax_amount,
			total_amount, notes, created_by, created, updated)
		VALUES(${uuid}, ${project.uuid}, ${data.document_type}, ${data.reference}, ${data.buyer_name}, ${data.buyer_vat_number}, ${data.buyer_country},
			${data.currency}, ${project.tax_currency ?? project.currency}, ${data.tax_exchange_rate}, ${data.tax_rate_date}, ${data.issued_at},
			${data.supply_date}, ${recordedTaxPoint(project, data)}, ${data.due_date}, ${data.paid_at}, ${data.payment_account}, ${totals.subtotal},
			${totals.tax_amount},
			${totals.total_amount}, ${data.notes}, ${author}, ${now}, ${now})
	`;
	await writeLines(sql, uuid, data.lines);
	return uuid;
}

export async function replaceRecordedInvoice(sql: SQL, project: ProjectRow, uuid: string, data: RecordedInvoiceInput) {
	const totals = totalsOf(data.lines);
	await sql`
		UPDATE recorded_invoices SET document_type = ${data.document_type}, reference = ${data.reference}, buyer_name = ${data.buyer_name},
			buyer_vat_number = ${data.buyer_vat_number}, buyer_country = ${data.buyer_country}, currency = ${data.currency},
			tax_currency = ${project.tax_currency ?? project.currency}, tax_exchange_rate = ${data.tax_exchange_rate}, tax_rate_date = ${data.tax_rate_date},
			issued_at = ${data.issued_at}, supply_date = ${data.supply_date}, tax_point_date = ${recordedTaxPoint(project, data)},
			due_date = ${data.due_date}, paid_at = ${data.paid_at},
			payment_account = ${data.payment_account}, subtotal = ${totals.subtotal}, tax_amount = ${totals.tax_amount},
			total_amount = ${totals.total_amount}, notes = ${data.notes}, updated = ${Date.now()}
		WHERE uuid = ${uuid} AND project = ${project.uuid}
	`;
	await writeLines(sql, uuid, data.lines);
}
