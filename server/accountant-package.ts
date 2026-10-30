import { createHash } from "node:crypto";
import Database from "./database/database";
import { addIntegers } from "./database/numbers";
import { convertMinor, minorUnitDigits } from "./invoicing";
import { companyFor, displayNameOf } from "./company";
import { buildDdvEvidence, type DdvValidationIssue } from "./ddv-evidence";
import { canSubmitSlovenianDdvEvidence, isEuCountry } from "./tax";
import { reportingCurrency } from "./tax-reporting";
import { endOfLocalDate, isCompleteLocalVatPeriod, isLocalDate, localDate, startOfLocalDate } from "./timezone";
import { deliveredCreditNotePdf, deliveredInvoicePdf } from "./invoice-pdf";
import { eslogVersions, archivedEslog } from "./eslog-archive";
import { documentStorage } from "./document-storage";
import { zipArchive, type ZipEntry } from "./zip";
import { translator } from "./i18n";
import { Logger } from "./logger";
import RenderPool from "./render-pool";
import type { InvoiceRecipient } from "./invoice-recipient";
import { openItems } from "./accounting/open-items";
import type {
	BankStatementRow,
	BankTransactionMatchRow,
	BankTransactionRow,
	CreditNoteRow,
	ExpenseAttachmentRow,
	ExpenseRow,
	InvoiceRow,
	ProjectRow,
	RecordedInvoiceAttachmentRow,
	RecordedInvoiceRow,
} from "./database/models";
import type {
	AccountantPackage,
	PackageBankAccount,
	PackageCheck,
	PackageOpenItem,
	PackageCreditNote,
	PackageIssued,
	PackageReceived,
	ReceivedGroup,
	VatReturnSummary,
} from "./accountant-package-types";

export const PACKAGE_DOCUMENT_LIMIT = 3000;
const FILE_CONCURRENCY = 6;

export class PackageTooLarge extends Error {}

export interface PackagePeriod {
	from: string;
	to: string;
}

export function packagePeriod(query: URLSearchParams): PackagePeriod | null {
	const from = query.get("from");
	const to = query.get("to");
	if (!isLocalDate(from) || !isLocalDate(to) || from > to) return null;
	const [fromYear, fromMonth] = from.split("-").map(Number);
	const [toYear, toMonth] = to.split("-").map(Number);
	if ((toYear - fromYear) * 12 + toMonth - fromMonth > 11) return null;
	return { from, to };
}

function buyerName(invoice: Pick<InvoiceRow, "buyer_details" | "buyer_email">): string {
	if (invoice.buyer_details) {
		try {
			const buyer = JSON.parse(invoice.buyer_details) as InvoiceRecipient;
			if (buyer.name?.trim()) return buyer.name.trim();
		} catch {}
	}
	return invoice.buyer_email ?? "";
}

function buyerTaxNumber(invoice: Pick<InvoiceRow, "buyer_details" | "buyer_vat_number">): string | null {
	if (invoice.buyer_vat_number?.trim()) return invoice.buyer_vat_number.trim();
	if (!invoice.buyer_details) return null;
	try {
		const buyer = JSON.parse(invoice.buyer_details) as InvoiceRecipient;
		const number = buyer.tax_number?.replace(/\s+/g, "") ?? "";
		return number.replace(/^SI(?=\d{8}$)/i, "") || null;
	} catch {
		return null;
	}
}

function inBase(amount: number, currency: string, base: string, taxCurrency: string | null, rate: number | null): number | null {
	if (currency === base) return amount;
	if (rate === null || (taxCurrency !== null && taxCurrency !== base)) return null;
	return convertMinor(amount, currency, rate, base);
}

function receivedGroup(expense: ExpenseRow, homeCountry: string | null): ReceivedGroup {
	if (expense.payment_method === "card" || expense.payment_method === "cash") return "paid_on_spot";
	if (["eu_goods", "eu_services", "import"].includes(expense.vat_treatment)) return "foreign";
	if (expense.supplier_country && homeCountry && expense.supplier_country !== homeCountry) return "foreign";
	return "domestic";
}

const RETURN_FIELDS: [string, string[], "kir" | "kpr"][] = [
	["11", ["P7"], "kir"],
	["11a", ["P8"], "kir"],
	["12", ["P10"], "kir"],
	["13", ["P11"], "kir"],
	["14", ["P12"], "kir"],
	["15", ["P9"], "kir"],
	["21", ["P14"], "kir"],
	["22", ["P15"], "kir"],
	["22a", ["P16"], "kir"],
	["23", ["P17"], "kir"],
	["23a", ["P18"], "kir"],
	["24", ["P19"], "kir"],
	["24a", ["P20"], "kir"],
	["24b", ["P21"], "kir"],
	["24c", ["P22"], "kir"],
	["25", ["P23"], "kir"],
	["25a", ["P24"], "kir"],
	["25b", ["P25"], "kir"],
	["26", ["P26"], "kir"],
	["31", ["P8"], "kpr"],
	["31a", ["P9"], "kpr"],
	["32", ["P10"], "kpr"],
	["32a", ["P11"], "kpr"],
	["33", ["P14"], "kpr"],
	["34", ["P12", "P15"], "kpr"],
	["35", ["P13", "P16"], "kpr"],
	["41", ["P18"], "kpr"],
	["42", ["P19"], "kpr"],
	["42a", ["P20"], "kpr"],
	["43", ["P21"], "kpr"],
];
const OUTPUT_FIELDS = ["21", "22", "22a", "23", "23a", "24", "24a", "24b", "24c", "25", "25a", "25b", "26"];
const INPUT_FIELDS = ["41", "42", "42a", "43"];

function sumRecords(records: Record<string, string | number>[], fields: string[]): number {
	let total = 0;
	for (const record of records) for (const field of fields) total = addIntegers(total, Math.round(Number(record[field] ?? 0) * 100));
	return total;
}

export function vatReturnFromEvidence(kir: Record<string, string | number>[], kpr: Record<string, string | number>[]): VatReturnSummary {
	const fields: Record<string, number> = {};
	for (const [code, sources, list] of RETURN_FIELDS) fields[code] = sumRecords(list === "kir" ? kir : kpr, sources);
	const output = OUTPUT_FIELDS.reduce((sum, code) => addIntegers(sum, fields[code]), 0);
	const input = INPUT_FIELDS.reduce((sum, code) => addIntegers(sum, fields[code]), 0);
	const balance = output - input;
	fields["51"] = Math.max(balance, 0);
	fields["52"] = Math.max(-balance, 0);
	const corrections = [...kir, ...kpr].filter((record) => record.OBRAVNAVA !== undefined && record.OBRAVNAVA !== "1").length;
	return { fields, output_vat: output, input_vat: input, corrections };
}

function check(checks: PackageCheck[], code: string, reference: string | null, detail: string | null = null) {
	checks.push({ code, reference, detail });
}

function evidenceCheck(issue: DdvValidationIssue): PackageCheck {
	return { code: `ddv_${issue.code}`, reference: issue.reference, detail: issue.message };
}

function fingerprint<T extends { key: string; fingerprint: string }>(row: T, ignored: (keyof T)[]): string {
	const fields = Object.entries(row)
		.filter(([name]) => name !== "key" && !ignored.includes(name as keyof T))
		.sort(([left], [right]) => left.localeCompare(right));
	return createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, 32);
}

async function bankAccounts(project: string, from: number, to: number): Promise<PackageBankAccount[]> {
	const lines = (await Database`
		SELECT t.*, s.iban, s.currency AS statement_currency FROM bank_transactions t JOIN bank_statements s ON s.uuid = t.statement
		WHERE t.project = ${project} AND t.booking_date BETWEEN ${from} AND ${to}
		ORDER BY s.iban, t.booking_date, t.created
	`) as (BankTransactionRow & { iban: string; statement_currency: string })[];
	const statements = (await Database`
		SELECT * FROM bank_statements WHERE project = ${project}
			AND COALESCE(period_to, created) >= ${from} AND COALESCE(period_from, created) <= ${to}
		ORDER BY iban, COALESCE(period_from, created)
	`) as BankStatementRow[];
	const ids = lines.map((line) => line.uuid);
	const matches = ids.length
		? ((await Database`SELECT * FROM bank_transaction_matches WHERE bank_transaction IN ${Database(ids)}`) as BankTransactionMatchRow[])
		: [];
	const ofType = (type: string) => [...new Set(matches.filter((match) => match.match_type === type).map((match) => match.match_id))];
	const labels = new Map<string, string>();
	const invoiceIds = ofType("invoice");
	if (invoiceIds.length)
		for (const row of (await Database`SELECT uuid, reference FROM invoices WHERE uuid IN ${Database(invoiceIds)}`) as { uuid: string; reference: string }[])
			labels.set(row.uuid, row.reference);
	const recordedIds = ofType("recorded_invoice");
	if (recordedIds.length)
		for (const row of (await Database`SELECT uuid, reference FROM recorded_invoices WHERE uuid IN ${Database(recordedIds)}`) as {
			uuid: string;
			reference: string;
		}[])
			labels.set(row.uuid, row.reference);
	const expenseIds = ofType("expense");
	if (expenseIds.length)
		for (const row of (await Database`SELECT uuid, invoice_number, description FROM expenses WHERE uuid IN ${Database(expenseIds)}`) as {
			uuid: string;
			invoice_number: string | null;
			description: string;
		}[])
			labels.set(row.uuid, row.invoice_number ?? row.description);
	const accountIds = [...new Set(lines.map((line) => line.ledger_account).filter((value): value is string => value !== null))];
	const ledger = new Map(
		accountIds.length
			? (
					(await Database`SELECT uuid, code, name, system_key FROM ledger_accounts WHERE uuid IN ${Database(accountIds)}`) as {
						uuid: string;
						code: string;
						name: string;
						system_key: string | null;
					}[]
				).map((row) => [row.uuid, { label: `${row.code} ${row.name}`, household: row.system_key === "household_flows" }])
			: []
	);
	const matchesByLine = new Map<string, BankTransactionMatchRow[]>();
	for (const match of matches) matchesByLine.set(match.bank_transaction, [...(matchesByLine.get(match.bank_transaction) ?? []), match]);

	const accounts = new Map<string, PackageBankAccount>();
	for (const statement of statements) {
		const account = accounts.get(statement.iban) ?? {
			iban: statement.iban,
			currency: statement.currency,
			opening_balance: statement.opening_balance,
			closing_balance: null,
			statements: 0,
			lines: [],
		};
		account.statements++;
		if (statement.closing_balance !== null) account.closing_balance = statement.closing_balance;
		accounts.set(statement.iban, account);
	}
	for (const line of lines) {
		const account = accounts.get(line.iban) ?? {
			iban: line.iban,
			currency: line.statement_currency,
			opening_balance: null,
			closing_balance: null,
			statements: 0,
			lines: [],
		};
		const settles =
			line.status === "matched"
				? (matchesByLine.get(line.uuid) ?? [])
						.map((match) => labels.get(match.match_id))
						.filter(Boolean)
						.join(", ")
				: line.status === "booked"
					? (ledger.get(line.ledger_account ?? "")?.label ?? "")
					: "";
		const household = line.status === "booked" && ledger.get(line.ledger_account ?? "")?.household === true;
		account.lines.push({
			booking_date: line.booking_date,
			counterparty: line.counterparty_name ?? "",
			counterparty_iban: line.counterparty_iban,
			description: [line.reference, line.remittance].filter(Boolean).join(" | "),
			amount: line.amount,
			status: household ? "private" : line.status,
			settles,
		});
		accounts.set(line.iban, account);
	}
	return [...accounts.values()];
}

export async function collectAccountantPackage(project: ProjectRow, period: PackagePeriod): Promise<AccountantPackage> {
	const from = startOfLocalDate(period.from, project.timezone);
	const to = endOfLocalDate(period.to, project.timezone);
	const base = reportingCurrency(project);
	const details = await companyFor(project.uuid);
	const checks: PackageCheck[] = [];

	const invoices = (await Database`
		SELECT * FROM invoices WHERE project = ${project.uuid} AND status <> 'draft' AND issued_at IS NOT NULL
			AND issued_at BETWEEN ${from} AND ${to}
		ORDER BY issued_at, reference
	`) as InvoiceRow[];
	const credited = new Set(
		((await Database`SELECT DISTINCT invoice FROM credit_notes WHERE project = ${project.uuid}`) as { invoice: string }[]).map((row) => row.invoice)
	);
	const issued: PackageIssued[] = invoices.map((invoice) => {
		const net = invoice.subtotal - invoice.discount_amount;
		const values = [net, invoice.tax_amount, invoice.total_amount].map((value) =>
			inBase(value, invoice.currency, base, invoice.tax_currency, invoice.tax_exchange_rate)
		);
		if (values.includes(null)) check(checks, "missing_rate", invoice.reference);
		const counted = invoice.status !== "canceled" || credited.has(invoice.uuid);
		return {
			id: invoice.uuid,
			key: `invoice:${invoice.uuid}`,
			fingerprint: "",
			source: "invoice",
			reference: invoice.reference,
			document_type: invoice.document_type,
			customer: buyerName(invoice),
			tax_number: buyerTaxNumber(invoice),
			country: invoice.buyer_country,
			issued_at: invoice.issued_at!,
			due_date: invoice.due_date,
			currency: invoice.currency,
			total_original: invoice.total_amount,
			net: values[0],
			vat: values[1],
			total: values[2],
			status: invoice.status === "canceled" ? "canceled" : invoice.status === "paid" ? "paid" : "open",
			paid_at: invoice.paid_date,
			counted,
		};
	});

	const recorded = (await Database`
		SELECT * FROM recorded_invoices WHERE project = ${project.uuid} AND issued_at BETWEEN ${from} AND ${to}
		ORDER BY issued_at, reference
	`) as RecordedInvoiceRow[];
	for (const record of recorded) {
		const values = [record.subtotal, record.tax_amount, record.total_amount].map((value) =>
			inBase(value, record.currency, base, record.tax_currency, record.tax_exchange_rate)
		);
		if (values.includes(null)) check(checks, "missing_rate", record.reference);
		issued.push({
			id: record.uuid,
			key: `recorded:${record.uuid}`,
			fingerprint: "",
			source: "recorded",
			reference: record.reference,
			document_type: record.document_type === "credit_note" ? "credit_note" : "invoice",
			customer: record.buyer_name,
			tax_number: record.buyer_vat_number,
			country: record.buyer_country,
			issued_at: record.issued_at,
			due_date: record.due_date,
			currency: record.currency,
			total_original: record.total_amount,
			net: values[0],
			vat: values[1],
			total: values[2],
			status: record.paid_at !== null ? "paid" : "open",
			paid_at: record.paid_at,
			counted: true,
		});
	}

	const notes = (await Database`
		SELECT cn.*, i.reference AS invoice_reference, i.buyer_details, i.buyer_email, i.buyer_vat_number, i.tax_currency, i.tax_exchange_rate
		FROM credit_notes cn JOIN invoices i ON i.uuid = cn.invoice
		WHERE cn.project = ${project.uuid} AND cn.issued_at BETWEEN ${from} AND ${to}
		ORDER BY cn.issued_at, cn.reference
	`) as (CreditNoteRow &
		Pick<InvoiceRow, "buyer_details" | "buyer_email" | "buyer_vat_number" | "tax_currency" | "tax_exchange_rate"> & { invoice_reference: string })[];
	const creditNotes: PackageCreditNote[] = notes.map((note) => {
		const values = [note.subtotal, note.tax_amount, note.total_amount].map((value) =>
			inBase(value, note.currency, base, note.tax_currency, note.tax_exchange_rate)
		);
		if (values.includes(null)) check(checks, "missing_rate", note.reference);
		return {
			id: note.uuid,
			key: `credit_note:${note.uuid}`,
			fingerprint: "",
			source: "credit_note",
			reference: note.reference,
			invoice_reference: note.invoice_reference,
			customer: buyerName(note),
			tax_number: buyerTaxNumber(note),
			issued_at: note.issued_at,
			currency: note.currency,
			total_original: note.total_amount,
			net: values[0],
			vat: values[1],
			total: values[2],
			reason: note.reason,
		};
	});
	for (const row of issued.filter((entry) => entry.source === "recorded" && entry.document_type === "credit_note")) {
		creditNotes.push({
			id: row.id,
			key: row.key,
			fingerprint: "",
			source: "recorded",
			reference: row.reference,
			invoice_reference: null,
			customer: row.customer,
			tax_number: row.tax_number,
			issued_at: row.issued_at,
			currency: row.currency,
			total_original: row.total_original,
			net: row.net === null ? null : -Math.abs(row.net),
			vat: row.vat === null ? null : -Math.abs(row.vat),
			total: row.total === null ? null : -Math.abs(row.total),
			reason: null,
		});
	}
	const issuedInvoices = issued.filter((entry) => !(entry.source === "recorded" && entry.document_type === "credit_note"));

	const expenses = (await Database`
		SELECT * FROM expenses WHERE project = ${project.uuid} AND expense_date BETWEEN ${from} AND ${to}
		ORDER BY expense_date, supplier, invoice_number
	`) as ExpenseRow[];
	const expenseAttachments = expenses.length
		? ((await Database`SELECT * FROM expense_attachments WHERE expense IN ${Database(expenses.map((row) => row.uuid))}`) as ExpenseAttachmentRow[])
		: [];
	const attachedExpenses = new Set(expenseAttachments.map((row) => row.expense));
	const attachmentSha = new Map(expenseAttachments.map((row) => [row.expense, row.sha256]));
	const homeCountry = project.tax_country ?? details.country ?? null;
	const received: PackageReceived[] = expenses.map((expense) => {
		const rate = expense.currency === base ? 1 : expense.tax_exchange_rate;
		const convert = (value: number) => (rate === null ? null : expense.currency === base ? value : convertMinor(value, expense.currency, rate, base));
		const total = convert(expense.total_amount);
		const vat = convert(expense.tax_amount);
		const deductible = convert(expense.deductible_tax_amount);
		const label = expense.invoice_number ?? expense.description;
		if (total === null) check(checks, "missing_rate", label);
		if (!attachedExpenses.has(expense.uuid)) check(checks, "missing_original", label, expense.supplier);
		return {
			id: expense.uuid,
			key: `expense:${expense.uuid}`,
			fingerprint: attachmentSha.get(expense.uuid) ?? "",
			group: receivedGroup(expense, homeCountry),
			supplier: expense.supplier ?? expense.description,
			tax_number: expense.supplier_tax_number,
			country: expense.supplier_country,
			invoice_number: expense.invoice_number,
			description: expense.description,
			category: expense.category,
			issue_date: expense.issue_date,
			booked_at: expense.expense_date,
			due_date: expense.due_date,
			paid_at: expense.paid_at,
			payment_method: expense.payment_method,
			vat_treatment: expense.vat_treatment,
			currency: expense.currency,
			total_original: expense.total_amount,
			net: total === null || vat === null ? null : total - vat,
			vat,
			deductible,
			total,
			attached: attachedExpenses.has(expense.uuid),
		};
	});

	let vatReturn: VatReturnSummary | null = null;
	const monthly = isCompleteLocalVatPeriod(from, to, project.timezone);
	if (canSubmitSlovenianDdvEvidence(project.tax_country, project.vat_status) && monthly) {
		const evidence = await buildDdvEvidence(project, {
			from,
			to,
			refund: false,
			deductible_share: false,
			late_submission: null,
			insolvency: false,
			tax_authority_order: false,
			note: null,
		});
		const lists = evidence.evidence.DDV_KIR_KPR;
		vatReturn = vatReturnFromEvidence(lists.Lista_KIR.KIR, lists.Lista_KPR.KPR);
		const known = new Set(checks.map((entry) => `${entry.code}|${entry.reference}`));
		for (const issue of evidence.errors) {
			if (issue.code === "missing_attachment" && known.has(`missing_original|${issue.reference}`)) continue;
			if (issue.code === "missing_exchange_rate" && known.has(`missing_rate|${issue.reference}`)) continue;
			checks.push(evidenceCheck(issue));
		}
	}

	const unpaidDue = received.filter((row) => row.paid_at === null && row.due_date !== null && row.due_date < to).length;
	if (unpaidDue > 0) check(checks, "unpaid_received", null, String(unpaidDue));

	const bank = await bankAccounts(project.uuid, from, to);
	const [statements] = (await Database`SELECT COUNT(*) AS count FROM bank_statements WHERE project = ${project.uuid}`) as { count: number }[];
	const bankUsed = Number(statements.count) > 0;
	const unmatched = bank.reduce((sum, account) => sum + account.lines.filter((line) => line.status === "open").length, 0);
	if (unmatched > 0) check(checks, "bank_unmatched", null, String(unmatched));
	if (bankUsed && bank.length === 0) check(checks, "bank_missing", null);

	const report = await openItems(project, to, "all");
	const outstanding: PackageOpenItem[] = report.partners.flatMap((partner) =>
		partner.items
			.filter((item) => item.type !== "bank_transaction")
			.map((item) => ({
				kind: item.kind,
				partner: partner.name,
				tax_number: partner.tax_number,
				reference: item.reference ?? "",
				date: item.date,
				due_date: item.due_date,
				days_overdue: Math.max(item.days_overdue, 0),
				amount: item.kind === "payable" ? -item.amount : item.amount,
				open: item.kind === "payable" ? -item.open : item.open,
				currency: item.currency,
				open_foreign: item.kind === "payable" ? -item.open_foreign : item.open_foreign,
			}))
	);
	outstanding.sort((a, b) => a.kind.localeCompare(b.kind) || a.partner.localeCompare(b.partner) || a.date - b.date);

	for (const row of issuedInvoices) row.fingerprint = fingerprint(row, ["status", "paid_at"]);
	for (const row of creditNotes) row.fingerprint = fingerprint(row, []);
	for (const row of received) row.fingerprint = fingerprint(row, ["paid_at"]);

	return {
		company: { name: details.legal_name || displayNameOf(project), details },
		language: project.language,
		timezone: project.timezone,
		date_format: project.date_format,
		currency: base,
		period: { from: period.from, to: period.to },
		vat_registered: canSubmitSlovenianDdvEvidence(project.tax_country, project.vat_status),
		monthly_vat_period: monthly,
		generated_at: Date.now(),
		issued: issuedInvoices,
		credit_notes: creditNotes,
		received,
		vat_return: vatReturn,
		bank,
		bank_used: bankUsed,
		open_items: outstanding,
		changes: null,
		checks,
	};
}

const CSV_SEPARATOR = ";";

function csvCell(value: string | number | null): string {
	if (value === null) return "";
	const text = String(value);
	return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(rows: (string | number | null)[][]): Uint8Array {
	return new TextEncoder().encode("﻿" + rows.map((row) => row.map(csvCell).join(CSV_SEPARATOR)).join("\r\n") + "\r\n");
}

function decimal(value: number | null): string | null {
	return value === null ? null : (value / 100).toFixed(2);
}

function minorText(value: number, currency: string): string {
	const digits = minorUnitDigits(currency);
	return (value / Math.pow(10, digits)).toFixed(digits);
}

export function packageCsvFiles(data: AccountantPackage): ZipEntry[] {
	const t = translator(data.language);
	const day = (value: number | null) => (value === null ? null : localDate(value, data.timezone));
	const issued = csv([
		[
			"stevilka",
			"vir",
			"vrsta",
			"kupec",
			"davcna_stevilka",
			"drzava",
			"datum_izdaje",
			"datum_zapadlosti",
			"status",
			"datum_placila",
			"valuta",
			"znesek_v_valuti",
			"osnova",
			"ddv",
			"skupaj",
		],
		...data.issued.map((row) => [
			row.reference,
			row.source,
			row.document_type,
			row.customer,
			row.tax_number,
			row.country,
			day(row.issued_at),
			day(row.due_date),
			row.status,
			day(row.paid_at),
			row.currency,
			minorText(row.total_original, row.currency),
			decimal(row.net),
			decimal(row.vat),
			decimal(row.total),
		]),
	]);
	const notes = csv([
		["stevilka", "vir", "racun", "kupec", "davcna_stevilka", "datum_izdaje", "valuta", "znesek_v_valuti", "osnova", "ddv", "skupaj", "razlog"],
		...data.credit_notes.map((row) => [
			row.reference,
			row.source,
			row.invoice_reference,
			row.customer,
			row.tax_number,
			day(row.issued_at),
			row.currency,
			minorText(row.total_original, row.currency),
			decimal(row.net),
			decimal(row.vat),
			decimal(row.total),
			row.reason,
		]),
	]);
	const received = csv([
		[
			"skupina",
			"dobavitelj",
			"davcna_stevilka",
			"drzava",
			"stevilka_racuna",
			"opis",
			"kategorija",
			"obravnava_ddv",
			"datum_izdaje",
			"datum_knjizenja",
			"datum_zapadlosti",
			"datum_placila",
			"nacin_placila",
			"valuta",
			"znesek_v_valuti",
			"osnova",
			"ddv",
			"odbitni_ddv",
			"skupaj",
			"original",
		],
		...data.received.map((row) => [
			row.group,
			row.supplier,
			row.tax_number,
			row.country,
			row.invoice_number,
			row.description,
			row.category,
			row.vat_treatment,
			day(row.issue_date),
			day(row.booked_at),
			day(row.due_date),
			day(row.paid_at),
			row.payment_method,
			row.currency,
			minorText(row.total_original, row.currency),
			decimal(row.net),
			decimal(row.vat),
			decimal(row.deductible),
			decimal(row.total),
			row.attached ? "da" : "ne",
		]),
	]);
	const folder = t("package.folder_csv");
	const entries: ZipEntry[] = [
		{ name: `${folder}/${t("package.file_issued")}.csv`, data: issued },
		{ name: `${folder}/${t("package.file_credit_notes")}.csv`, data: notes },
		{ name: `${folder}/${t("package.file_received")}.csv`, data: received },
	];
	if (data.bank.length > 0) {
		entries.push({
			name: `${folder}/${t("package.file_bank")}.csv`,
			data: csv([
				["iban", "datum", "partner", "iban_partnerja", "opis", "valuta", "znesek", "stanje", "poravnava"],
				...data.bank.flatMap((account) =>
					account.lines.map((line) => [
						account.iban,
						day(line.booking_date),
						line.counterparty,
						line.counterparty_iban,
						line.description,
						account.currency,
						minorText(line.amount, account.currency),
						line.status,
						line.settles,
					])
				),
			]),
		});
	}
	entries.push({
		name: `${folder}/${t("package.file_open_items")}.csv`,
		data: csv([
			["vrsta", "partner", "davcna_stevilka", "dokument", "datum", "zapadlost", "dni_zamude", "znesek", "odprto", "valuta", "odprto_v_valuti"],
			...data.open_items.map((item) => [
				item.kind === "receivable" ? "terjatev" : "obveznost",
				item.partner,
				item.tax_number,
				item.reference,
				day(item.date),
				day(item.due_date),
				item.days_overdue,
				decimal(item.amount),
				decimal(item.open),
				item.currency,
				item.currency && item.currency !== data.currency ? minorText(item.open_foreign, item.currency) : null,
			]),
		]),
	});
	if (data.vat_return) {
		entries.push({
			name: `${folder}/${t("package.file_vat_return")}.csv`,
			data: csv([["polje", "znesek"], ...Object.entries(data.vat_return.fields).map(([code, value]) => [code, decimal(value)])]),
		});
	}
	return entries;
}

function safeName(value: string): string {
	return (
		value
			.normalize("NFC")
			.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 120) || "-"
	);
}

function extension(name: string, contentType: string): string {
	const match = /\.([a-z0-9]{1,8})$/i.exec(name);
	if (match) return match[1].toLowerCase();
	if (contentType === "application/pdf") return "pdf";
	if (contentType.includes("xml")) return "xml";
	if (contentType === "image/jpeg") return "jpg";
	if (contentType === "image/png") return "png";
	return "bin";
}

class NameRegistry {
	private taken = new Set<string>();

	claim(name: string): string {
		const dot = name.lastIndexOf(".");
		const stem = dot > name.lastIndexOf("/") ? name.slice(0, dot) : name;
		const suffix = dot > name.lastIndexOf("/") ? name.slice(dot) : "";
		let candidate = name;
		for (let copy = 2; this.taken.has(candidate.toLowerCase()); copy++) candidate = `${stem} (${copy})${suffix}`;
		this.taken.add(candidate.toLowerCase());
		return candidate;
	}
}

async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	for (let start = 0; start < items.length; start += FILE_CONCURRENCY)
		results.push(...(await Promise.all(items.slice(start, start + FILE_CONCURRENCY).map(work))));
	return results;
}

export function packageSpan(period: PackagePeriod): string {
	return period.from.slice(0, 7) === period.to.slice(0, 7) ? period.from.slice(0, 7) : `${period.from} - ${period.to}`;
}

export function packageFileName(project: ProjectRow, period: PackagePeriod, changes = false): string {
	const t = translator(project.language);
	const suffix = changes ? ` ${t("package.changes_suffix")}` : "";
	return `${safeName(t("package.archive_name", { company: displayNameOf(project) }))} ${packageSpan(period)}${suffix}.zip`;
}

export interface ArchiveOptions {
	data?: AccountantPackage;
	only?: Set<string> | null;
}

export async function accountantPackageArchive(
	project: ProjectRow,
	period: PackagePeriod,
	options: ArchiveOptions = {}
): Promise<{ name: string; data: Uint8Array; data_summary: AccountantPackage }> {
	const data = options.data ?? (await collectAccountantPackage(project, period));
	const wanted = (key: string) => !options.only || options.only.has(key);
	const documents = data.issued.length + data.credit_notes.length + data.received.length;
	if (documents > PACKAGE_DOCUMENT_LIMIT) throw new PackageTooLarge();
	const t = translator(project.language);
	const names = new NameRegistry();
	const entries: ZipEntry[] = [];
	const missing: PackageCheck[] = [];

	const invoiceIds = data.issued.filter((row) => row.source === "invoice" && wanted(row.key)).map((row) => row.id);
	const invoiceRows = invoiceIds.length ? ((await Database`SELECT * FROM invoices WHERE uuid IN ${Database(invoiceIds)}`) as InvoiceRow[]) : [];
	const invoiceFolder = t("package.folder_issued");
	await inBatches(invoiceRows, async (invoice) => {
		try {
			const file = await deliveredInvoicePdf(project, invoice);
			entries.push({ name: names.claim(`${invoiceFolder}/${safeName(file.name)}`), data: file.data });
		} catch (error) {
			Logger.error(`[PACKAGE] Invoice ${invoice.uuid} PDF failed: ${error}`);
			missing.push({ code: "document_unavailable", reference: invoice.reference, detail: null });
		}
		try {
			const versions = await eslogVersions({ kind: "invoice", project, invoice });
			if (versions.length > 0) {
				const latest = Math.max(...versions.map((row) => Number(row.version)));
				const file = await archivedEslog({ kind: "invoice", project, invoice }, latest);
				entries.push({ name: names.claim(`${invoiceFolder}/${safeName(file.name)}`), data: file.data });
			}
		} catch (error) {
			Logger.error(`[PACKAGE] Invoice ${invoice.uuid} e-SLOG failed: ${error}`);
		}
	});

	const noteIds = data.credit_notes.filter((row) => row.source === "credit_note" && wanted(row.key)).map((row) => row.id);
	const noteRows = noteIds.length ? ((await Database`SELECT * FROM credit_notes WHERE uuid IN ${Database(noteIds)}`) as CreditNoteRow[]) : [];
	const noteFolder = t("package.folder_credit_notes");
	await inBatches(noteRows, async (note) => {
		try {
			const file = await deliveredCreditNotePdf(project, note);
			entries.push({ name: names.claim(`${noteFolder}/${safeName(file.name)}`), data: file.data });
		} catch (error) {
			Logger.error(`[PACKAGE] Credit note ${note.uuid} PDF failed: ${error}`);
			missing.push({ code: "document_unavailable", reference: note.reference, detail: null });
		}
	});

	const storage = documentStorage();
	const recordedIds = data.issued
		.filter((row) => row.source === "recorded" && wanted(row.key))
		.map((row) => row.id)
		.concat(data.credit_notes.filter((row) => row.source === "recorded" && wanted(row.key)).map((row) => row.id));
	const recordedFiles = recordedIds.length
		? ((await Database`
				SELECT a.*, r.reference, r.document_type FROM recorded_invoice_attachments a JOIN recorded_invoices r ON r.uuid = a.recorded_invoice
				WHERE a.recorded_invoice IN ${Database(recordedIds)}
			`) as (RecordedInvoiceAttachmentRow & { reference: string; document_type: string })[])
		: [];
	await inBatches(recordedFiles, async (file) => {
		const folder = t(file.document_type === "credit_note" ? "package.folder_credit_notes" : "package.folder_issued_elsewhere");
		try {
			const bytes = await storage.get(file.storage_key);
			entries.push({ name: names.claim(`${folder}/${safeName(file.reference)}.${extension(file.file_name, file.content_type)}`), data: bytes });
		} catch (error) {
			Logger.error(`[PACKAGE] Recorded invoice attachment ${file.recorded_invoice} failed: ${error}`);
			missing.push({ code: "document_unavailable", reference: file.reference, detail: null });
		}
	});

	const receivedRows = data.received.filter((row) => wanted(row.key));
	const receivedById = new Map(receivedRows.map((row) => [row.id, row]));
	const expenseFiles = receivedRows.length
		? ((await Database`SELECT * FROM expense_attachments WHERE expense IN ${Database(receivedRows.map((row) => row.id))}`) as ExpenseAttachmentRow[])
		: [];
	const groupFolder: Record<ReceivedGroup, string> = {
		domestic: t("package.folder_received_domestic"),
		foreign: t("package.folder_received_foreign"),
		paid_on_spot: t("package.folder_received_on_spot"),
	};
	await inBatches(expenseFiles, async (file) => {
		const row = receivedById.get(file.expense)!;
		const label = [localDate(row.booked_at, data.timezone), row.supplier, row.invoice_number].filter(Boolean).join(" ");
		try {
			const bytes = await storage.get(file.storage_key);
			entries.push({
				name: names.claim(`${t("package.folder_received")}/${groupFolder[row.group]}/${safeName(label)}.${extension(file.file_name, file.content_type)}`),
				data: bytes,
			});
		} catch (error) {
			Logger.error(`[PACKAGE] Expense attachment ${file.expense} failed: ${error}`);
			missing.push({ code: "document_unavailable", reference: row.invoice_number ?? row.description, detail: null });
		}
	});

	data.checks.push(...missing);
	entries.sort((left, right) => left.name.localeCompare(right.name));
	const overview = await RenderPool.render({ kind: "accountant_package", input: data });
	entries.unshift({ name: `${t("package.file_overview")} ${packageSpan(period)}.pdf`, data: overview }, ...packageCsvFiles(data));
	return { name: packageFileName(project, period, options.only !== undefined && options.only !== null), data: zipArchive(entries), data_summary: data };
}

export async function accountantPackageOverview(
	project: ProjectRow,
	period: PackagePeriod,
	prepared?: AccountantPackage
): Promise<{ name: string; data: Uint8Array }> {
	const data = prepared ?? (await collectAccountantPackage(project, period));
	const t = translator(project.language);
	return { name: `${t("package.file_overview")} ${packageSpan(period)}.pdf`, data: await RenderPool.render({ kind: "accountant_package", input: data }) };
}

export function packageSummary(data: AccountantPackage) {
	const sum = <T>(rows: T[], value: (row: T) => number | null) => rows.reduce((total, row) => addIntegers(total, value(row) ?? 0), 0);
	const counted = data.issued.filter((row) => row.counted);
	const group = (name: ReceivedGroup) => data.received.filter((row) => row.group === name);
	const section = <T extends { net: number | null; vat: number | null; total: number | null }>(rows: T[]) => ({
		count: rows.length,
		net: sum(rows, (row) => row.net),
		vat: sum(rows, (row) => row.vat),
		total: sum(rows, (row) => row.total),
	});
	return {
		period: data.period,
		currency: data.currency,
		issued: section(counted),
		credit_notes: section(data.credit_notes),
		received_domestic: section(group("domestic")),
		received_foreign: section(group("foreign")),
		received_on_spot: section(group("paid_on_spot")),
		vat_return: data.vat_return,
		bank: {
			accounts: data.bank.length,
			lines: data.bank.reduce((sum, account) => sum + account.lines.length, 0),
			unmatched: data.bank.reduce((sum, account) => sum + account.lines.filter((line) => line.status === "open").length, 0),
			used: data.bank_used,
		},
		open_items: {
			receivable: sum(
				data.open_items.filter((item) => item.kind === "receivable"),
				(item) => item.open
			),
			payable: sum(
				data.open_items.filter((item) => item.kind === "payable"),
				(item) => item.open
			),
			receivable_count: data.open_items.filter((item) => item.kind === "receivable").length,
			payable_count: data.open_items.filter((item) => item.kind === "payable").length,
		},
		checks: data.checks,
	};
}
