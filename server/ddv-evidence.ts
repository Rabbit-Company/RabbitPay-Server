import Database from "./database/database";
import { addIntegers, safeInteger } from "./database/numbers";
import type {
	CreditNoteItemRow,
	DdvExportRow,
	ExpenseAttachmentRow,
	ExpenseRow,
	ExpenseVatLineRow,
	InvoiceItemRow,
	InvoiceRow,
	ProjectCompanyRow,
	ProjectRow,
} from "./database/models";
import { convertMinor } from "./tax-reporting";
import { canSubmitSlovenianDdvEvidence, isTaxTreatment, splitVatNumber, type TaxTreatment } from "./tax";
import type { InvoiceRecipient } from "./invoice-recipient";
import { DEFAULT_TIMEZONE, isCompleteLocalVatPeriod, localDate, zonedParts } from "./timezone";

export interface DdvExportOptions {
	from: number;
	to: number;
	refund: boolean;
	deductible_share: boolean;
	late_submission: "1" | "2" | "3" | null;
	insolvency: boolean;
	tax_authority_order: boolean;
	note: string | null;
}

export interface DdvValidationIssue {
	code: string;
	source: "header" | "invoice" | "credit_note" | "expense";
	id: string | null;
	reference: string | null;
	message: string;
}

export interface DdvReconciliation {
	kir: { records: number; source_base: number; evidence_base: number; source_vat: number; evidence_vat: number };
	kpr: {
		records: number;
		source_base: number;
		evidence_base: number;
		source_deductible_vat: number;
		evidence_deductible_vat: number;
		non_deductible_vat: number;
	};
	balanced: boolean;
}

export interface DdvEvidenceResult {
	period: { from: number; to: number; code: string };
	currency: "EUR";
	errors: DdvValidationIssue[];
	warnings: DdvValidationIssue[];
	reconciliation: DdvReconciliation;
	evidence: DdvEvidenceFile;
}

export interface DdvEvidenceFile {
	DDV_KIR_KPR: {
		Glava: Record<string, string | boolean>;
		Lista_KIR: { KIR: Record<string, string | number>[] };
		Lista_KPR: { KPR: Record<string, string | number>[] };
	};
}

interface NoteInvoice extends InvoiceRow {
	note_uuid: string;
	note_reference: string;
	note_issued_at: number;
}

const rates = new Map([
	[22, { output: "P14", euGoods: "P17", euServices: "P18", reverse: "P23", deductible: "P18" }],
	[9.5, { output: "P15", euGoods: "P19", euServices: "P20", reverse: "P24", deductible: "P19" }],
	[5, { output: "P16", euGoods: "P21", euServices: "P22", reverse: "P25", deductible: "P20" }],
]);

function date(value: number, timezone: string): string {
	return localDate(value, timezone);
}

function monthCode(from: number, to: number, timezone: string): string {
	return `${String(zonedParts(from, timezone).month).padStart(2, "0")}${String(zonedParts(to, timezone).month).padStart(2, "0")}`;
}

export function validDdvExportOptions(value: unknown, timezone = DEFAULT_TIMEZONE): value is DdvExportOptions {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const data = value as Record<string, unknown>;
	return (
		isCompleteLocalVatPeriod(data.from as number, data.to as number, timezone) &&
		typeof data.refund === "boolean" &&
		typeof data.deductible_share === "boolean" &&
		(data.late_submission === null || ["1", "2", "3"].includes(data.late_submission as string)) &&
		typeof data.insolvency === "boolean" &&
		typeof data.tax_authority_order === "boolean" &&
		(data.note === null || (typeof data.note === "string" && data.note.length <= 250))
	);
}

function amount(value: number): number {
	return Number((value / 100).toFixed(2));
}

function add(record: Record<string, string | number>, field: string, value: number) {
	if (value === 0) return;
	record[field] = Number((Number(record[field] ?? 0) + amount(value)).toFixed(2));
}

function sumFields(record: Record<string, string | number>, fields: string[]): number {
	return Math.round(fields.reduce((sum, field) => sum + Number(record[field] ?? 0), 0) * 100);
}

function partyTax(vatNumber: string | null, country: string | null): { country?: string; number?: string } {
	const split = splitVatNumber(vatNumber, country);
	if (split) return { country: split.prefix, number: split.number };
	const raw = vatNumber?.replace(/[\s.-]/g, "").toUpperCase() ?? "";
	if (!raw) return country ? { number: country } : {};
	if (/^[A-Z]{2}/.test(raw)) return { number: raw };
	return { country: country ?? undefined, number: raw };
}

function partyName(invoice: InvoiceRow): string | undefined {
	if (!invoice.buyer_details) return undefined;
	try {
		const buyer = JSON.parse(invoice.buyer_details) as InvoiceRecipient;
		if (buyer.customer_type === "individual" || (!buyer.customer_type && !invoice.buyer_vat_number)) return undefined;
		return (
			[buyer.name, buyer.address_line1, buyer.address_line2, [buyer.postal_code, buyer.city].filter(Boolean).join(" "), buyer.country]
				.filter(Boolean)
				.join(", ")
				.slice(0, 250) || undefined
		);
	} catch {
		return undefined;
	}
}

function assignParty(
	record: Record<string, string | number>,
	name: string | undefined,
	vatNumber: string | null,
	country: string | null,
	prefix: "P6" | "P7",
	fallbackCountry = false
) {
	if (name) record[prefix === "P6" ? "P5" : "P6"] = name;
	if (!vatNumber && !fallbackCountry) return;
	const tax = partyTax(vatNumber, country);
	if (tax.country) record[prefix] = tax.country;
	if (tax.number) record[`${prefix}DS`] = tax.number;
}

function grouped<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
	const result = new Map<string, T[]>();
	for (const row of rows) result.set(key(row), [...(result.get(key(row)) ?? []), row]);
	return result;
}

function issue(errors: DdvValidationIssue[], source: DdvValidationIssue["source"], id: string | null, reference: string | null, code: string, message: string) {
	errors.push({ source, id, reference, code, message });
}

function taxPayerId(company: ProjectCompanyRow | undefined): string | null {
	for (const value of [company?.tax_number, company?.vat_number]) {
		const number = value?.replace(/^SI/i, "").replace(/\D/g, "") ?? "";
		if (/^\d{8}$/.test(number)) return number;
	}
	return null;
}

function convert(invoice: InvoiceRow, value: number): number | null {
	if (invoice.currency === "EUR") return value;
	if (invoice.tax_currency !== "EUR" || invoice.tax_exchange_rate === null) return null;
	return safeInteger(convertMinor(value, invoice.currency, invoice.tax_exchange_rate, "EUR"));
}

function convertExpense(expense: ExpenseRow, value: number): number | null {
	if (expense.currency === "EUR") return value;
	if (expense.tax_exchange_rate === null) return null;
	return safeInteger(convertMinor(value, expense.currency, expense.tax_exchange_rate, "EUR"));
}

function kirInvoiceRecord(
	invoice: InvoiceRow,
	reference: string,
	issued: number,
	lines: { net: number; vat: number; rate: number; treatment: string | null }[],
	sign: 1 | -1,
	period: string,
	errors: DdvValidationIssue[],
	source: "invoice" | "credit_note",
	timezone: string
): { record: Record<string, string | number>; base: number; vat: number; omitted: boolean } {
	const record: Record<string, string | number> = {
		ZAPST: 0,
		OBDOBJE: period,
		P2: date(issued, timezone),
		P3: reference.slice(0, 250),
		P4: date(issued, timezone),
		OBRAVNAVA: "1",
	};
	assignParty(record, partyName(invoice), invoice.buyer_vat_number, invoice.buyer_country, "P6");
	let sourceBase = 0;
	let sourceVat = 0;
	let included = false;
	for (const line of lines) {
		const convertedNet = convert(invoice, line.net);
		const convertedVat = convert(invoice, line.vat);
		if (convertedNet === null || convertedVat === null) {
			issue(errors, source, invoice.uuid, reference, "missing_exchange_rate", `No recorded exchange rate from ${invoice.currency} to EUR.`);
			continue;
		}
		const net = sign * convertedNet;
		const vat = sign * convertedVat;
		const treatment: TaxTreatment = isTaxTreatment(line.treatment) ? line.treatment : "domestic";
		if (treatment === "oss") continue;
		included = true;
		sourceBase = addIntegers(sourceBase, net);
		sourceVat = addIntegers(sourceVat, vat);
		if (treatment === "domestic") {
			add(record, "P7", net);
			const mapping = rates.get(line.rate);
			if (!mapping && vat !== 0)
				issue(errors, source, invoice.uuid, reference, "unsupported_vat_rate", `VAT rate ${line.rate}% cannot be mapped to a FURS KIR field.`);
			else if (mapping) add(record, mapping.output, vat);
		} else if (treatment === "export") add(record, "P7", net);
		else if (treatment === "exempt" || treatment === "small_business") add(record, "P9", net);
		else if (treatment === "reverse_charge" || treatment === "intra_eu_goods") add(record, "P10", net);
		else if (treatment === "outside_scope") add(record, "P27", net);
	}
	return { record, base: sourceBase, vat: sourceVat, omitted: !included };
}

function kirExpenseRecord(
	expense: ExpenseRow,
	lines: ExpenseVatLineRow[],
	period: string,
	errors: DdvValidationIssue[],
	timezone: string
): { record: Record<string, string | number>; vat: number } | null {
	if (!["domestic_reverse_charge", "eu_goods", "eu_services", "import"].includes(expense.vat_treatment)) return null;
	const record: Record<string, string | number> = {
		ZAPST: 0,
		OBDOBJE: period,
		P2: date(expense.expense_date, timezone),
		P3: expense.invoice_number!.slice(0, 250),
		P4: date(expense.issue_date!, timezone),
		P5: expense.supplier!.slice(0, 250),
		OBRAVNAVA: expense.vat_handling,
	};
	assignParty(record, undefined, expense.supplier_tax_number, expense.supplier_country, "P6");
	let total = 0;
	for (const line of lines) {
		const tax = convertExpense(expense, line.tax_amount);
		if (tax === null) {
			issue(errors, "expense", expense.uuid, expense.invoice_number, "missing_exchange_rate", `No recorded exchange rate from ${expense.currency} to EUR.`);
			continue;
		}
		total = addIntegers(total, tax);
		const mapping = rates.get(line.rate);
		if (expense.vat_treatment === "import") add(record, "P26", tax);
		else if (!mapping)
			issue(errors, "expense", expense.uuid, expense.invoice_number, "unsupported_vat_rate", `VAT rate ${line.rate}% cannot be mapped to a FURS KIR field.`);
		else if (expense.vat_treatment === "eu_goods") add(record, mapping.euGoods, tax);
		else if (expense.vat_treatment === "eu_services") add(record, mapping.euServices, tax);
		else add(record, mapping.reverse, tax);
	}
	if (expense.vat_handling !== "1") {
		record.OBDOBJE88 = expense.self_assessment_period!;
		record.DAVEK88 = amount(convertExpense(expense, expense.self_assessment_tax!) ?? 0);
	}
	return { record, vat: total };
}

function kprRecord(expense: ExpenseRow, lines: ExpenseVatLineRow[], period: string, errors: DdvValidationIssue[], timezone: string) {
	const record: Record<string, string | number> = {
		ZAPST: 0,
		OBDOBJE: period,
		P2: date(expense.expense_date, timezone),
		P3: expense.invoice_number!.slice(0, 250),
		P4: date(expense.receipt_date!, timezone),
		P5: date(expense.issue_date!, timezone),
		P6: expense.supplier!.slice(0, 250),
		OBRAVNAVA: expense.vat_handling,
	};
	assignParty(record, undefined, expense.supplier_tax_number, expense.supplier_country, "P7", true);
	let base = 0;
	let deductible = 0;
	let nonDeductible = 0;
	for (const line of lines) {
		const convertedBase = convertExpense(expense, line.tax_base);
		const convertedTax = convertExpense(expense, line.tax_amount);
		const convertedDeductible = convertExpense(expense, line.deductible_tax_amount);
		if (convertedBase === null || convertedTax === null || convertedDeductible === null) {
			issue(errors, "expense", expense.uuid, expense.invoice_number, "missing_exchange_rate", `No recorded exchange rate from ${expense.currency} to EUR.`);
			continue;
		}
		base = addIntegers(base, convertedBase);
		deductible = addIntegers(deductible, convertedDeductible);
		nonDeductible = addIntegers(nonDeductible, convertedTax - convertedDeductible);
		const baseField =
			expense.vat_treatment === "domestic_reverse_charge"
				? "P9"
				: expense.vat_treatment === "eu_goods"
					? "P10"
					: expense.vat_treatment === "eu_services"
						? "P11"
						: expense.vat_treatment === "exempt"
							? "P14"
							: "P8";
		add(record, baseField, convertedBase);
		if (expense.asset_type === "real_estate") add(record, expense.vat_treatment === "exempt" ? "P15" : "P12", convertedBase);
		if (expense.asset_type === "fixed_asset") add(record, expense.vat_treatment === "exempt" ? "P16" : "P13", convertedBase);
		add(record, "P17", convertedTax - convertedDeductible);
		if (line.rate === 8) add(record, "P21", convertedDeductible);
		else {
			const mapping = rates.get(line.rate);
			if (!mapping && convertedDeductible !== 0)
				issue(errors, "expense", expense.uuid, expense.invoice_number, "unsupported_vat_rate", `VAT rate ${line.rate}% cannot be mapped to a FURS KPR field.`);
			else if (mapping) add(record, mapping.deductible, convertedDeductible);
		}
	}
	if (expense.notes) record.P22 = expense.notes.slice(0, 250);
	if (expense.vat_handling !== "1") {
		record.OBDOBJE88 = expense.self_assessment_period!;
		record.DAVEK88 = amount(convertExpense(expense, expense.self_assessment_tax!) ?? 0);
	}
	return { record, base, deductible, nonDeductible };
}

export async function buildDdvEvidence(project: ProjectRow, options: DdvExportOptions): Promise<DdvEvidenceResult> {
	const errors: DdvValidationIssue[] = [];
	const warnings: DdvValidationIssue[] = [];
	const [company] = (await Database`SELECT * FROM project_company WHERE project = ${project.uuid}`) as ProjectCompanyRow[];
	const taxpayer = taxPayerId(company);
	if (!taxpayer) issue(errors, "header", null, null, "missing_tax_number", "Company details need an eight digit Slovenian tax number.");
	if (!canSubmitSlovenianDdvEvidence(project.tax_country, project.vat_status))
		issue(errors, "header", null, null, "invalid_tax_profile", "The project must be VAT registered in Slovenia.");
	if ((project.tax_currency ?? project.currency) !== "EUR")
		issue(errors, "header", null, null, "invalid_currency", "Slovenian DDV evidence must be reported in EUR.");

	const invoices = (await Database`
		SELECT * FROM invoices WHERE project = ${project.uuid} AND status <> 'draft' AND issued_at BETWEEN ${options.from} AND ${options.to}
			AND (status <> 'canceled' OR EXISTS (SELECT 1 FROM credit_notes cn WHERE cn.invoice = invoices.uuid)) ORDER BY issued_at, reference
	`) as InvoiceRow[];
	const invoiceLines = (await Database`
		SELECT ii.* FROM invoice_items ii JOIN invoices i ON i.uuid = ii.invoice
		WHERE i.project = ${project.uuid} AND i.status <> 'draft' AND i.issued_at BETWEEN ${options.from} AND ${options.to}
	`) as InvoiceItemRow[];
	const notes = (await Database`
		SELECT cn.uuid AS note_uuid, cn.reference AS note_reference, cn.issued_at AS note_issued_at, i.*
		FROM credit_notes cn JOIN invoices i ON i.uuid = cn.invoice
		WHERE cn.project = ${project.uuid} AND cn.issued_at BETWEEN ${options.from} AND ${options.to} ORDER BY cn.issued_at, cn.reference
	`) as NoteInvoice[];
	const noteLines = (await Database`
		SELECT cni.* FROM credit_note_items cni JOIN credit_notes cn ON cn.uuid = cni.credit_note
		WHERE cn.project = ${project.uuid} AND cn.issued_at BETWEEN ${options.from} AND ${options.to}
	`) as CreditNoteItemRow[];
	const expenses = (await Database`
		SELECT * FROM expenses WHERE project = ${project.uuid} AND vat_treatment <> 'not_reported' AND expense_date BETWEEN ${options.from} AND ${options.to}
		ORDER BY expense_date, invoice_number
	`) as ExpenseRow[];
	const expenseLines = (await Database`
		SELECT evl.* FROM expense_vat_lines evl JOIN expenses e ON e.uuid = evl.expense
		WHERE e.project = ${project.uuid} AND e.vat_treatment <> 'not_reported' AND e.expense_date BETWEEN ${options.from} AND ${options.to}
		ORDER BY e.expense_date, evl.sort_order
	`) as ExpenseVatLineRow[];
	const attachments = (await Database`
		SELECT ea.* FROM expense_attachments ea JOIN expenses e ON e.uuid = ea.expense
		WHERE e.project = ${project.uuid} AND e.vat_treatment <> 'not_reported' AND e.expense_date BETWEEN ${options.from} AND ${options.to}
	`) as ExpenseAttachmentRow[];

	const invoiceGroups = grouped(invoiceLines, (row) => row.invoice);
	const noteGroups = grouped(noteLines, (row) => row.credit_note);
	const expenseGroups = grouped(expenseLines, (row) => row.expense);
	const attached = new Set(attachments.map((row) => row.expense));
	const period = monthCode(options.from, options.to, project.timezone);
	const kir: Record<string, string | number>[] = [];
	const kpr: Record<string, string | number>[] = [];
	let kirSourceBase = 0;
	let kirSourceVat = 0;
	let kprSourceBase = 0;
	let kprSourceDeductible = 0;
	let nonDeductible = 0;

	for (const invoice of invoices) {
		const built = kirInvoiceRecord(
			invoice,
			invoice.reference,
			invoice.issued_at!,
			(invoiceGroups.get(invoice.uuid) ?? []).map((line) => ({
				net: line.total_price - line.discount_amount,
				vat: line.tax_amount,
				rate: line.tax_rate,
				treatment: line.tax_treatment,
			})),
			1,
			period,
			errors,
			"invoice",
			project.timezone
		);
		if (!built.omitted) {
			kir.push(built.record);
			kirSourceBase = addIntegers(kirSourceBase, built.base);
			kirSourceVat = addIntegers(kirSourceVat, built.vat);
		} else issue(warnings, "invoice", invoice.uuid, invoice.reference, "oss_omitted", "OSS transactions are not reported in KIR under the Union OSS scheme.");
	}
	for (const note of notes) {
		const built = kirInvoiceRecord(
			note,
			note.note_reference,
			note.note_issued_at,
			(noteGroups.get(note.note_uuid) ?? []).map((line) => ({
				net: line.net_amount,
				vat: line.tax_amount,
				rate: line.tax_rate,
				treatment: line.tax_treatment,
			})),
			-1,
			period,
			errors,
			"credit_note",
			project.timezone
		);
		built.record.P28 = `Popravek računa ${note.reference}`.slice(0, 250);
		if (!built.omitted) {
			kir.push(built.record);
			kirSourceBase = addIntegers(kirSourceBase, built.base);
			kirSourceVat = addIntegers(kirSourceVat, built.vat);
		}
	}
	for (const expense of expenses) {
		const lines = expenseGroups.get(expense.uuid) ?? [];
		if (!attached.has(expense.uuid))
			issue(errors, "expense", expense.uuid, expense.invoice_number, "missing_attachment", "Attach the original supplier invoice.");
		const input = kprRecord(expense, lines, period, errors, project.timezone);
		kpr.push(input.record);
		kprSourceBase = addIntegers(kprSourceBase, input.base);
		kprSourceDeductible = addIntegers(kprSourceDeductible, input.deductible);
		nonDeductible = addIntegers(nonDeductible, input.nonDeductible);
		const output = kirExpenseRecord(expense, lines, period, errors, project.timezone);
		if (output) {
			kir.push(output.record);
			kirSourceVat = addIntegers(kirSourceVat, output.vat);
		}
	}

	kir.forEach((record, index) => (record.ZAPST = index + 1));
	kpr.forEach((record, index) => (record.ZAPST = index + 1));
	for (const [kind, records] of [
		["KIR", kir],
		["KPR", kpr],
	] as const) {
		for (const record of records) {
			for (const [field, value] of Object.entries(record)) {
				if (field.startsWith("P") && typeof value === "number" && Math.abs(value) >= 5_000_000_000) {
					issue(errors, "header", null, null, "amount_out_of_range", `${kind} record ${record.ZAPST}, field ${field}, exceeds the FURS amount limit.`);
				}
			}
		}
	}
	const baseFields = ["P7", "P8", "P9", "P10", "P11", "P12", "P13", "P27"];
	const outputFields = ["P14", "P15", "P16", "P17", "P18", "P19", "P20", "P21", "P22", "P23", "P24", "P25", "P26"];
	const kprBaseFields = ["P8", "P9", "P10", "P11", "P14"];
	const deductibleFields = ["P18", "P19", "P20", "P21"];
	const kirEvidenceBase = kir.reduce((sum, row) => addIntegers(sum, sumFields(row, baseFields)), 0);
	const kirEvidenceVat = kir.reduce((sum, row) => addIntegers(sum, sumFields(row, outputFields)), 0);
	const kprEvidenceBase = kpr.reduce((sum, row) => addIntegers(sum, sumFields(row, kprBaseFields)), 0);
	const kprEvidenceDeductible = kpr.reduce((sum, row) => addIntegers(sum, sumFields(row, deductibleFields)), 0);
	const reconciliation: DdvReconciliation = {
		kir: { records: kir.length, source_base: kirSourceBase, evidence_base: kirEvidenceBase, source_vat: kirSourceVat, evidence_vat: kirEvidenceVat },
		kpr: {
			records: kpr.length,
			source_base: kprSourceBase,
			evidence_base: kprEvidenceBase,
			source_deductible_vat: kprSourceDeductible,
			evidence_deductible_vat: kprEvidenceDeductible,
			non_deductible_vat: nonDeductible,
		},
		balanced:
			kirSourceBase === kirEvidenceBase &&
			kirSourceVat === kirEvidenceVat &&
			kprSourceBase === kprEvidenceBase &&
			kprSourceDeductible === kprEvidenceDeductible,
	};
	if (!reconciliation.balanced) issue(errors, "header", null, null, "reconciliation_failed", "Evidence totals do not reconcile with the source documents.");

	const header: Record<string, string | boolean> = {
		TaxPayerID: taxpayer ?? "00000000",
		OBDOBJE_OD: date(options.from, project.timezone),
		OBDOBJE_DO: date(options.to, project.timezone),
		KIR: true,
		KPR: true,
		VRACILO: options.refund,
		ODBDELEZ: options.deductible_share,
		INSPOS: options.insolvency,
		PREDLODO: options.tax_authority_order,
	};
	if (options.late_submission) header.NACIN = options.late_submission;
	if (options.note?.trim()) header.OPOMBA = options.note.trim();
	return {
		period: { from: options.from, to: options.to, code: period },
		currency: "EUR",
		errors,
		warnings,
		reconciliation,
		evidence: { DDV_KIR_KPR: { Glava: header, Lista_KIR: { KIR: kir }, Lista_KPR: { KPR: kpr } } },
	};
}

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(timestamp: number): { date: number; time: number } {
	const value = new Date(timestamp);
	return {
		date: ((Math.max(1980, value.getUTCFullYear()) - 1980) << 9) | ((value.getUTCMonth() + 1) << 5) | value.getUTCDate(),
		time: (value.getUTCHours() << 11) | (value.getUTCMinutes() << 5) | Math.floor(value.getUTCSeconds() / 2),
	};
}

export function zipFile(name: string, content: Uint8Array, timestamp = Date.now()): Uint8Array {
	const fileName = new TextEncoder().encode(name);
	const checksum = crc32(content);
	const stamp = dosDateTime(timestamp);
	const localSize = 30 + fileName.length + content.length;
	const centralSize = 46 + fileName.length;
	const output = new Uint8Array(localSize + centralSize + 22);
	const view = new DataView(output.buffer);
	let offset = 0;
	const write16 = (value: number) => {
		view.setUint16(offset, value, true);
		offset += 2;
	};
	const write32 = (value: number) => {
		view.setUint32(offset, value, true);
		offset += 4;
	};
	write32(0x04034b50);
	write16(20);
	write16(0x800);
	write16(0);
	write16(stamp.time);
	write16(stamp.date);
	write32(checksum);
	write32(content.length);
	write32(content.length);
	write16(fileName.length);
	write16(0);
	output.set(fileName, offset);
	offset += fileName.length;
	output.set(content, offset);
	offset += content.length;
	write32(0x02014b50);
	write16(20);
	write16(20);
	write16(0x800);
	write16(0);
	write16(stamp.time);
	write16(stamp.date);
	write32(checksum);
	write32(content.length);
	write32(content.length);
	write16(fileName.length);
	write16(0);
	write16(0);
	write16(0);
	write16(0);
	write32(0);
	write32(0);
	output.set(fileName, offset);
	offset += fileName.length;
	write32(0x06054b50);
	write16(0);
	write16(0);
	write16(1);
	write16(1);
	write32(centralSize);
	write32(localSize);
	write16(0);
	return output;
}

export function ddvExportView(row: DdvExportRow) {
	return {
		uuid: row.uuid,
		period_from: row.period_from,
		period_to: row.period_to,
		revision: row.revision,
		file_name: row.file_name,
		byte_size: row.byte_size,
		sha256: row.sha256,
		created_by: row.created_by,
		created: row.created,
	};
}
