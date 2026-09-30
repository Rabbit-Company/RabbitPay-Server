import { csvHeader, CsvUnreadable, parseCsv } from "../csv";
import { minorUnitDigits } from "../invoicing";
import { isTaxTreatment } from "../tax";
import { isLocalDate, startOfLocalDate } from "../timezone";
import Validate from "../validate";
import { isCountryCode } from "../countries";
import { totalsOf, validRecordedInvoice } from "./recorded-invoices";
import type { ProjectRow } from "../database/models";
import type { RecordedInvoiceInput } from "./types";

export const MAX_IMPORT_CHARACTERS = 2_000_000;
export const MAX_IMPORT_ROWS = 5000;

export type ImportColumn =
	| "document_type"
	| "number"
	| "issue_date"
	| "buyer_name"
	| "buyer_vat_number"
	| "buyer_country"
	| "supply_date"
	| "due_date"
	| "currency"
	| "exchange_rate"
	| "exchange_rate_date"
	| "vat_rate"
	| "vat_treatment"
	| "net_amount"
	| "vat_amount"
	| "paid_date"
	| "paid_to"
	| "notes";

export type ImportErrorCode =
	| "unreadable"
	| "too_large"
	| "empty"
	| "missing_column"
	| "invalid_date"
	| "invalid_amount"
	| "invalid_value"
	| "conflicting_value"
	| "invalid_document"
	| "duplicate_in_file"
	| "already_recorded"
	| "period_locked";

export interface ImportError {
	row: number | null;
	column: ImportColumn | null;
	reference: string | null;
	code: ImportErrorCode;
}

export interface ImportedDocument {
	rows: number[];
	input: RecordedInvoiceInput;
	total_amount: number;
}

export interface ImportResult {
	documents: ImportedDocument[];
	errors: ImportError[];
}

const ALIASES: Record<ImportColumn, string[]> = {
	document_type: ["document_type", "type", "document", "vrsta", "vrsta_listine", "listina"],
	number: ["number", "invoice_number", "reference", "stevilka", "stevilka_racuna", "izvirna_stevilka"],
	issue_date: ["issue_date", "issued", "date", "invoice_date", "datum", "datum_izdaje"],
	buyer_name: ["buyer_name", "buyer", "customer", "kupec", "naziv_kupca", "stranka"],
	buyer_vat_number: ["buyer_vat_number", "vat_number", "vat_id", "tax_number", "id_za_ddv", "davcna_stevilka", "ddv_stevilka"],
	buyer_country: ["buyer_country", "country", "drzava", "drzava_kupca"],
	supply_date: ["supply_date", "service_date", "datum_opravljene_storitve", "datum_dobave"],
	due_date: ["due_date", "due", "rok_placila", "zapadlost"],
	currency: ["currency", "valuta"],
	exchange_rate: ["exchange_rate", "rate_to_base", "tecaj"],
	exchange_rate_date: ["exchange_rate_date", "datum_tecaja"],
	vat_rate: ["vat_rate", "tax_rate", "rate", "stopnja", "stopnja_ddv"],
	vat_treatment: ["vat_treatment", "tax_treatment", "treatment", "obravnava", "obravnava_ddv"],
	net_amount: ["net_amount", "net", "tax_base", "osnova", "davcna_osnova"],
	vat_amount: ["vat_amount", "vat", "tax", "tax_amount", "ddv", "znesek_ddv"],
	paid_date: ["paid_date", "paid", "paid_at", "payment_date", "placano", "datum_placila"],
	paid_to: ["paid_to", "payment_account", "placano_na"],
	notes: ["notes", "note", "opombe", "opomba"],
};

const REQUIRED: ImportColumn[] = ["number", "issue_date", "buyer_name", "vat_rate", "net_amount", "vat_amount"];
const DOCUMENT_COLUMNS: ImportColumn[] = [
	"document_type",
	"issue_date",
	"buyer_name",
	"buyer_vat_number",
	"buyer_country",
	"supply_date",
	"due_date",
	"currency",
	"exchange_rate",
	"exchange_rate_date",
	"paid_date",
	"paid_to",
	"notes",
];

const DOCUMENT_TYPES: Record<string, RecordedInvoiceInput["document_type"]> = {
	invoice: "invoice",
	racun: "invoice",
	credit_note: "credit_note",
	creditnote: "credit_note",
	credit: "credit_note",
	dobropis: "credit_note",
};

const PAYMENT_ACCOUNTS: Record<string, RecordedInvoiceInput["payment_account"]> = {
	bank: "bank",
	banka: "bank",
	transakcijski_racun: "bank",
	trr: "bank",
	cash: "cash",
	gotovina: "cash",
	blagajna: "cash",
};

export function parseImportDate(value: string, timezone: string): number | null {
	const text = value.trim();
	let date: string | null = null;
	const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
	const dotted = text.match(/^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})\.?$/);
	if (iso) date = `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
	else if (dotted) date = `${dotted[3]}-${dotted[2].padStart(2, "0")}-${dotted[1].padStart(2, "0")}`;
	if (date === null || !isLocalDate(date)) return null;
	return startOfLocalDate(date, timezone);
}

export function parseImportAmount(value: string, currency: string): number | null {
	let text = value.trim().replace(/[\s\u00a0']/g, "");
	const negative = text.startsWith("-");
	if (negative) text = text.slice(1);
	if (!/^\d[\d.,]*$/.test(text)) return null;
	const commas = text.split(",").length - 1;
	const dots = text.split(".").length - 1;
	let integer = text;
	let fraction = "";
	if (commas > 0 && dots > 0) {
		const decimal = text.lastIndexOf(",") > text.lastIndexOf(".") ? "," : ".";
		const [whole, tail, ...rest] = text.split(decimal);
		if (rest.length > 0) return null;
		integer = whole.split(decimal === "," ? "." : ",").join("");
		fraction = tail;
	} else if (commas > 1 || dots > 1) {
		integer = text.split(commas > 1 ? "," : ".").join("");
	} else if (commas === 1 || dots === 1) {
		[integer, fraction] = text.split(commas === 1 ? "," : ".");
	}
	const digits = minorUnitDigits(currency);
	if (!/^\d+$/.test(integer) || !/^\d*$/.test(fraction) || fraction.length > digits) return null;
	const minor = Number(integer) * 10 ** digits + Number(fraction.padEnd(digits, "0") || "0");
	if (!Number.isSafeInteger(minor)) return null;
	return negative ? -minor : minor;
}

function parseRate(value: string): number | null {
	const text = value.trim().replace("%", "").replace(",", ".");
	if (!/^\d+(\.\d+)?$/.test(text)) return null;
	const rate = Number(text);
	return rate >= 0 && rate <= 100 ? rate : null;
}

export function parseRecordedInvoices(content: string, project: ProjectRow): ImportResult {
	const errors: ImportError[] = [];
	const fail = (code: ImportErrorCode, row: number | null = null, column: ImportColumn | null = null, reference: string | null = null) => {
		errors.push({ row, column, reference, code });
	};
	if (content.length > MAX_IMPORT_CHARACTERS) {
		fail("too_large");
		return { documents: [], errors };
	}
	let table: string[][];
	try {
		table = parseCsv(content);
	} catch (error) {
		if (!(error instanceof CsvUnreadable)) throw error;
		fail("unreadable");
		return { documents: [], errors };
	}
	if (table.length < 2) {
		fail("empty");
		return { documents: [], errors };
	}
	if (table.length - 1 > MAX_IMPORT_ROWS) {
		fail("too_large");
		return { documents: [], errors };
	}

	const headers = table[0].map(csvHeader);
	const columns = new Map<ImportColumn, number>();
	for (const [column, aliases] of Object.entries(ALIASES) as [ImportColumn, string[]][]) {
		const index = headers.findIndex((header) => aliases.includes(header));
		if (index >= 0) columns.set(column, index);
	}
	for (const column of REQUIRED) if (!columns.has(column)) fail("missing_column", null, column);
	if (errors.length > 0) return { documents: [], errors };

	const base = project.tax_currency ?? project.currency;
	const cell = (cells: string[], column: ImportColumn) => {
		const index = columns.get(column);
		return index === undefined ? "" : (cells[index] ?? "").trim();
	};

	const groups = new Map<string, { rows: number[]; values: Map<ImportColumn, string>; input: RecordedInvoiceInput }>();
	for (let index = 1; index < table.length; index++) {
		const cells = table[index];
		const row = index + 1;
		const reference = cell(cells, "number");
		const typeText = csvHeader(cell(cells, "document_type") || "invoice");
		const documentType = DOCUMENT_TYPES[typeText];
		if (!documentType) {
			fail("invalid_value", row, "document_type", reference || null);
			continue;
		}
		if (!reference || reference.length > 64) {
			fail("invalid_value", row, "number", reference || null);
			continue;
		}
		const key = `${documentType}|${reference}`;
		let group = groups.get(key);
		if (!group) {
			const currency = (cell(cells, "currency") || base).toUpperCase();
			const date = (column: ImportColumn, required = false): number | null => {
				const text = cell(cells, column);
				if (!text) {
					if (required) fail("invalid_date", row, column, reference);
					return null;
				}
				const parsed = parseImportDate(text, project.timezone);
				if (parsed === null) fail("invalid_date", row, column, reference);
				return parsed;
			};
			const countryText = cell(cells, "buyer_country");
			const country = countryText && isCountryCode(countryText.toUpperCase()) ? countryText.toUpperCase() : null;
			if (countryText && !country) fail("invalid_value", row, "buyer_country", reference);
			if (!Validate.currency(currency)) fail("invalid_value", row, "currency", reference);
			const rateText = cell(cells, "exchange_rate").replace(",", ".");
			const exchangeRate = rateText ? Number(rateText) : null;
			if (rateText && !(Number.isFinite(exchangeRate) && exchangeRate! > 0)) fail("invalid_value", row, "exchange_rate", reference);
			const paidToText = csvHeader(cell(cells, "paid_to") || "bank");
			const paymentAccount = PAYMENT_ACCOUNTS[paidToText];
			if (!paymentAccount) fail("invalid_value", row, "paid_to", reference);
			group = {
				rows: [],
				values: new Map(DOCUMENT_COLUMNS.map((column) => [column, cell(cells, column)])),
				input: {
					document_type: documentType,
					reference,
					buyer_name: cell(cells, "buyer_name"),
					buyer_vat_number: cell(cells, "buyer_vat_number") || null,
					buyer_country: country,
					currency,
					tax_exchange_rate: exchangeRate,
					tax_rate_date: date("exchange_rate_date") ?? (currency !== base ? date("issue_date") : null),
					issued_at: date("issue_date", true) ?? 0,
					supply_date: date("supply_date"),
					due_date: date("due_date"),
					paid_at: date("paid_date"),
					payment_account: paymentAccount ?? "bank",
					notes: cell(cells, "notes") || null,
					lines: [],
				},
			};
			groups.set(key, group);
		} else {
			for (const column of DOCUMENT_COLUMNS) {
				const value = cell(cells, column);
				if (value && group.values.get(column) && value !== group.values.get(column)) fail("conflicting_value", row, column, reference);
			}
		}
		group.rows.push(row);

		const currency = group.input.currency;
		const rate = parseRate(cell(cells, "vat_rate"));
		if (rate === null) fail("invalid_value", row, "vat_rate", reference);
		const treatment = csvHeader(cell(cells, "vat_treatment") || "domestic");
		if (!isTaxTreatment(treatment)) fail("invalid_value", row, "vat_treatment", reference);
		const net = parseImportAmount(cell(cells, "net_amount"), currency);
		if (net === null) fail("invalid_amount", row, "net_amount", reference);
		const vat = parseImportAmount(cell(cells, "vat_amount"), currency);
		if (vat === null || vat < 0) fail("invalid_amount", row, "vat_amount", reference);
		if (rate !== null && isTaxTreatment(treatment) && net !== null && vat !== null && vat >= 0) {
			group.input.lines.push({ tax_rate: rate, tax_treatment: treatment, net_amount: net, tax_amount: vat });
		}
	}

	const documents: ImportedDocument[] = [];
	for (const group of groups.values()) {
		const failed = errors.some((error) => error.row !== null && group.rows.includes(error.row));
		if (failed) continue;
		if (!validRecordedInvoice(group.input, base)) {
			fail("invalid_document", group.rows[0], null, group.input.reference);
			continue;
		}
		documents.push({ rows: group.rows, input: group.input, total_amount: totalsOf(group.input.lines).total_amount });
	}
	return { documents, errors };
}
