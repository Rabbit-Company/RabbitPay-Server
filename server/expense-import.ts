import Database from "./database/database";
import Validate from "./validate";
import { csvHeader, CsvUnreadable, parseCsv } from "./csv";
import { isCountryCode } from "./countries";
import { MAX_IMPORT_CHARACTERS, MAX_IMPORT_ROWS, parseImportAmount, parseImportDate } from "./accounting/recorded-import";
import { validExpense } from "./expense-service";
import { accountingPeriodLocked } from "./accounting-periods";
import { EXPENSE_VAT_TREATMENTS, type ExpenseInput, type ExpenseVatTreatment } from "./expense-types";
import type { ProjectRow } from "./database/models";

export type ExpenseImportColumn =
	| "invoice_number"
	| "supplier"
	| "supplier_tax_number"
	| "supplier_country"
	| "description"
	| "category"
	| "issue_date"
	| "receipt_date"
	| "due_date"
	| "expense_date"
	| "currency"
	| "exchange_rate"
	| "vat_treatment"
	| "vat_rate"
	| "net_amount"
	| "vat_amount"
	| "deductible_vat"
	| "paid_date"
	| "notes";

export interface ExpenseImportError {
	row: number | null;
	column: ExpenseImportColumn | null;
	reference: string | null;
	code:
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
}

export interface ExpenseImportResult {
	documents: { rows: number[]; input: ExpenseInput }[];
	errors: ExpenseImportError[];
}

const ALIASES: Record<ExpenseImportColumn, string[]> = {
	invoice_number: ["invoice_number", "number", "reference", "stevilka", "stevilka_racuna"],
	supplier: ["supplier", "supplier_name", "dobavitelj", "izdajatelj"],
	supplier_tax_number: ["supplier_tax_number", "supplier_vat_number", "vat_number", "tax_number", "id_za_ddv", "davcna_stevilka"],
	supplier_country: ["supplier_country", "country", "drzava"],
	description: ["description", "opis"],
	category: ["category", "kategorija"],
	issue_date: ["issue_date", "invoice_date", "date", "datum", "datum_izdaje"],
	receipt_date: ["receipt_date", "received", "datum_prejema"],
	due_date: ["due_date", "due", "zapadlost", "datum_zapadlosti", "rok_placila"],
	expense_date: ["expense_date", "booking_date", "datum_knjizenja"],
	currency: ["currency", "valuta"],
	exchange_rate: ["exchange_rate", "tecaj"],
	vat_treatment: ["vat_treatment", "tax_treatment", "treatment", "obravnava", "obravnava_ddv"],
	vat_rate: ["vat_rate", "tax_rate", "rate", "stopnja", "stopnja_ddv"],
	net_amount: ["net_amount", "net", "tax_base", "osnova"],
	vat_amount: ["vat_amount", "vat", "tax", "ddv", "znesek_ddv"],
	deductible_vat: ["deductible_vat", "deductible", "odbitni_ddv"],
	paid_date: ["paid_date", "paid", "paid_at", "placano", "datum_placila"],
	notes: ["notes", "note", "opombe"],
};

const REQUIRED: ExpenseImportColumn[] = ["invoice_number", "supplier", "issue_date", "net_amount"];
const DOCUMENT_COLUMNS: ExpenseImportColumn[] = [
	"supplier_tax_number",
	"supplier_country",
	"description",
	"category",
	"issue_date",
	"receipt_date",
	"due_date",
	"expense_date",
	"currency",
	"exchange_rate",
	"vat_treatment",
	"paid_date",
	"notes",
];
const SELF_ASSESSED: ExpenseVatTreatment[] = ["domestic_reverse_charge", "eu_goods", "eu_services"];

export async function parseExpenseImport(content: string, project: ProjectRow): Promise<ExpenseImportResult> {
	const errors: ExpenseImportError[] = [];
	const fail = (code: ExpenseImportError["code"], row: number | null = null, column: ExpenseImportColumn | null = null, reference: string | null = null) =>
		errors.push({ row, column, reference, code });
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
	if (table.length < 2) fail("empty");
	else if (table.length - 1 > MAX_IMPORT_ROWS) fail("too_large");
	if (errors.length) return { documents: [], errors };

	const headers = table[0].map(csvHeader);
	const columns = new Map<ExpenseImportColumn, number>();
	for (const [column, aliases] of Object.entries(ALIASES) as [ExpenseImportColumn, string[]][]) {
		const index = headers.findIndex((header) => aliases.includes(header));
		if (index >= 0) columns.set(column, index);
	}
	for (const column of REQUIRED) if (!columns.has(column)) fail("missing_column", null, column);
	if (errors.length) return { documents: [], errors };

	const cell = (cells: string[], column: ExpenseImportColumn) => {
		const index = columns.get(column);
		return index === undefined ? "" : (cells[index] ?? "").trim();
	};
	const base = project.tax_currency ?? project.currency;
	const groups = new Map<string, { rows: number[]; values: Map<ExpenseImportColumn, string>; input: ExpenseInput; lines: number }>();

	for (let index = 1; index < table.length; index++) {
		const cells = table[index];
		const row = index + 1;
		const reference = cell(cells, "invoice_number");
		const supplier = cell(cells, "supplier");
		if (!reference || !supplier) {
			fail("invalid_value", row, reference ? "supplier" : "invoice_number", reference || null);
			continue;
		}
		const key = `${csvHeader(supplier)}|${reference}`;
		let group = groups.get(key);
		if (!group) {
			const date = (column: ExpenseImportColumn): number | null => {
				const text = cell(cells, column);
				if (!text) return null;
				const parsed = parseImportDate(text, project.timezone);
				if (parsed === null) fail("invalid_date", row, column, reference);
				return parsed;
			};
			const issued = date("issue_date");
			if (issued === null && !cell(cells, "issue_date")) fail("invalid_date", row, "issue_date", reference);
			const received = date("receipt_date") ?? issued;
			const currency = (cell(cells, "currency") || base).toUpperCase();
			if (!Validate.currency(currency)) fail("invalid_value", row, "currency", reference);
			const countryText = cell(cells, "supplier_country").toUpperCase();
			if (countryText && !isCountryCode(countryText)) fail("invalid_value", row, "supplier_country", reference);
			const treatmentText = csvHeader(cell(cells, "vat_treatment"));
			if (treatmentText && !EXPENSE_VAT_TREATMENTS.includes(treatmentText as ExpenseVatTreatment)) fail("invalid_value", row, "vat_treatment", reference);
			const rateText = cell(cells, "exchange_rate").replace(",", ".");
			const exchangeRate = rateText ? Number(rateText) : null;
			if (rateText && !(Number.isFinite(exchangeRate) && exchangeRate! > 0)) fail("invalid_value", row, "exchange_rate", reference);
			group = {
				rows: [],
				lines: 0,
				values: new Map(DOCUMENT_COLUMNS.map((column) => [column, cell(cells, column)])),
				input: {
					description: cell(cells, "description") || `${supplier} ${reference}`.slice(0, 240),
					supplier,
					supplier_tax_number: cell(cells, "supplier_tax_number") || null,
					supplier_country: countryText || null,
					invoice_number: reference,
					category: cell(cells, "category") || "Other",
					currency,
					total_amount: 0,
					tax_amount: 0,
					deductible_tax_amount: 0,
					expense_date: date("expense_date") ?? received ?? 0,
					issue_date: issued,
					receipt_date: received,
					supply_date: null,
					due_date: date("due_date"),
					vat_treatment: (treatmentText || "not_reported") as ExpenseVatTreatment,
					asset_type: "expense",
					vat_handling: "1",
					self_assessment_period: null,
					self_assessment_tax: null,
					tax_exchange_rate: exchangeRate,
					tax_rate_date: currency !== base ? issued : null,
					paid_at: date("paid_date"),
					notes: cell(cells, "notes") || null,
					vat_lines: [],
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
		const net = parseImportAmount(cell(cells, "net_amount"), currency);
		if (net === null) fail("invalid_amount", row, "net_amount", reference);
		const vatText = cell(cells, "vat_amount");
		const vat = vatText ? parseImportAmount(vatText, currency) : 0;
		if (vat === null || vat < 0) fail("invalid_amount", row, "vat_amount", reference);
		const deductibleText = cell(cells, "deductible_vat");
		const deductible = deductibleText ? parseImportAmount(deductibleText, currency) : vat;
		if (deductible === null || deductible < 0 || (vat !== null && deductible > vat)) fail("invalid_amount", row, "deductible_vat", reference);
		const rateText = cell(cells, "vat_rate").replace("%", "").replace(",", ".").trim();
		const rate = rateText ? Number(rateText) : 0;
		if (!Number.isFinite(rate) || rate < 0 || rate > 100) fail("invalid_value", row, "vat_rate", reference);
		if (net === null || vat === null || deductible === null) continue;
		const input = group.input;
		if (rateText || vat > 0) {
			input.vat_lines.push({ rate, tax_base: net, tax_amount: vat, deductible_tax_amount: deductible });
			if (!cell(cells, "vat_treatment") && input.vat_treatment === "not_reported") input.vat_treatment = "domestic";
		}
		input.tax_amount += vat;
		input.deductible_tax_amount += deductible;
		input.total_amount += net + vat;
		group.lines++;
	}

	const documents: ExpenseImportResult["documents"] = [];
	const seen = new Set<string>();
	for (const group of groups.values()) {
		if (errors.some((error) => error.row !== null && group.rows.includes(error.row))) continue;
		const input = group.input;
		if (SELF_ASSESSED.includes(input.vat_treatment as ExpenseVatTreatment)) input.total_amount -= input.tax_amount;
		const reference = input.invoice_number!;
		if (!validExpense(input)) {
			fail("invalid_document", group.rows[0], null, reference);
			continue;
		}
		const key = `${input.supplier_tax_number ?? input.supplier}|${reference}`;
		if (seen.has(key)) {
			fail("duplicate_in_file", group.rows[0], "invoice_number", reference);
			continue;
		}
		seen.add(key);
		const [existing] = await Database`
			SELECT uuid FROM expenses WHERE project = ${project.uuid} AND invoice_number = ${reference}
				AND (supplier = ${input.supplier} OR (supplier_tax_number IS NOT NULL AND supplier_tax_number = ${input.supplier_tax_number}))
		`;
		if (existing) {
			fail("already_recorded", group.rows[0], "invoice_number", reference);
			continue;
		}
		if (await accountingPeriodLocked(project.uuid, input.expense_date)) {
			fail("period_locked", group.rows[0], "expense_date", reference);
			continue;
		}
		documents.push({ rows: group.rows, input });
	}
	return { documents, errors: errors.sort((a, b) => (a.row ?? 0) - (b.row ?? 0)) };
}
