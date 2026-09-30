import Database from "../database/database";
import { convertMinor } from "../invoicing";
import { isEuCountry, isTaxTreatment } from "../tax";
import { REFUND_TYPES, SETTLED_PAYMENT_STATUSES, SETTLED_REFUND_STATUSES } from "../payments/ledger";
import type { Chart, SystemAccount } from "./chart";
import type { LedgerIssue } from "./types";
import { accumulatedAt, CATEGORY_ACCOUNTS, depreciationSchedule, lastDayOfMonth } from "./assets";
import { startOfLocalDate, zonedParts } from "../timezone";
import type { PayrollCalculation } from "../workforce/payroll-runs";

function sumValues(values: Record<string, number>): number {
	return Object.values(values).reduce((sum, value) => sum + value, 0);
}
import type { InvoiceRecipient } from "../invoice-recipient";
import type {
	BankTransactionRow,
	CreditNoteItemRow,
	CreditNoteRow,
	ExpenseRow,
	FixedAssetRow,
	InvoiceItemRow,
	InvoiceRow,
	JournalSourceType,
	LedgerAccountRow,
	PayrollLineRow,
	PayrollRunRow,
	ProjectRow,
	RecordedInvoiceLineRow,
	RecordedInvoiceRow,
	TransactionRow,
} from "../database/models";

export interface PlannedLine {
	account: LedgerAccountRow;
	debit: number;
	credit: number;
	partner: string | null;
}

export interface PlannedEntry {
	source_type: Exclude<JournalSourceType, "manual">;
	source_id: string;
	date: number;
	description: string;
	lines: PlannedLine[];
}

interface Amounts {
	currency: string;
	tax_currency: string | null;
	tax_exchange_rate: number | null;
}

const REVERSE_CHARGE_PURCHASES = ["domestic_reverse_charge", "eu_goods", "eu_services"];

const MONEY_ACCOUNTS: Record<string, SystemAccount> = {
	cash: "cash",
	bank_transfer: "bank",
	stripe: "stripe",
	paypal: "paypal",
	bitcoin: "crypto",
	ethereum: "crypto",
	monero: "crypto",
};

class EntryBuilder {
	private readonly balances = new Map<string, { account: LedgerAccountRow; partner: string | null; amount: number }>();

	debit(account: LedgerAccountRow, amount: number, partner: string | null = null) {
		this.add(account, amount, partner);
	}

	credit(account: LedgerAccountRow, amount: number, partner: string | null = null) {
		this.add(account, -amount, partner);
	}

	private add(account: LedgerAccountRow, amount: number, partner: string | null) {
		if (amount === 0) return;
		const key = `${account.uuid}|${partner ?? ""}`;
		const current = this.balances.get(key) ?? { account, partner, amount: 0 };
		current.amount += amount;
		this.balances.set(key, current);
	}

	lines(): PlannedLine[] {
		return [...this.balances.values()]
			.filter((line) => line.amount !== 0)
			.map((line) => ({
				account: line.account,
				partner: line.partner,
				debit: line.amount > 0 ? line.amount : 0,
				credit: line.amount < 0 ? -line.amount : 0,
			}));
	}
}

function grouped<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
	const result = new Map<string, T[]>();
	for (const row of rows) result.set(key(row), [...(result.get(key(row)) ?? []), row]);
	return result;
}

function buyerName(invoice: InvoiceRow): string | null {
	if (!invoice.buyer_details) return null;
	try {
		const name = (JSON.parse(invoice.buyer_details) as InvoiceRecipient).name?.trim();
		return name ? name.slice(0, 200) : null;
	} catch {
		return null;
	}
}

interface SalesDocument extends Amounts {
	buyer_country: string | null;
	advance: boolean;
	partner: string | null;
}

interface SalesLine {
	net: number;
	vat: number;
	treatment: string | null;
	advance: boolean;
}

function advanceDeduction(item: InvoiceItemRow): boolean {
	if (!item.metadata) return false;
	try {
		return (JSON.parse(item.metadata) as { advance_deduction?: boolean }).advance_deduction === true;
	} catch {
		return false;
	}
}

function salesDocument(invoice: InvoiceRow): SalesDocument {
	return { ...invoice, advance: invoice.document_type === "advance", partner: buyerName(invoice) };
}

export function expenseCost(expense: ExpenseRow, base: string): number | null {
	const convert = (value: number) =>
		expense.currency === base ? value : expense.tax_exchange_rate === null ? null : convertMinor(value, expense.currency, expense.tax_exchange_rate, base);
	const total = convert(expense.total_amount);
	const tax = convert(expense.tax_amount);
	const deductible = convert(expense.deductible_tax_amount);
	if (total === null || tax === null || deductible === null) return null;
	return REVERSE_CHARGE_PURCHASES.includes(expense.vat_treatment) ? total + tax - deductible : total - deductible;
}

function settledAt(transaction: TransactionRow): number {
	return transaction.completed_at ?? transaction.confirmed_at ?? transaction.created;
}

export class LedgerPlanner {
	readonly entries: PlannedEntry[] = [];
	readonly issues: LedgerIssue[] = [];
	private readonly settledThrough = new Map<string, LedgerAccountRow>();
	private readonly base: string;
	private readonly home: string;

	constructor(
		private readonly project: ProjectRow,
		private readonly chart: Chart
	) {
		this.base = project.tax_currency ?? project.currency;
		this.home = project.tax_country ?? "SI";
	}

	private convert(document: Amounts, value: number): number | null {
		if (document.currency === this.base) return value;
		if (document.tax_currency !== this.base || document.tax_exchange_rate === null) return null;
		return convertMinor(value, document.currency, document.tax_exchange_rate, this.base);
	}

	private region(country: string | null): "domestic" | "eu" | "export" {
		if (!country || country === this.home) return "domestic";
		return isEuCountry(country) && isEuCountry(this.home) ? "eu" : "export";
	}

	private receivable(document: Pick<SalesDocument, "buyer_country">): LedgerAccountRow {
		return this.chart.system(this.region(document.buyer_country) === "domestic" ? "receivables_domestic" : "receivables_foreign");
	}

	private revenue(document: SalesDocument, treatment: string | null): LedgerAccountRow {
		const kind = isTaxTreatment(treatment) ? treatment : "domestic";
		if (kind === "oss" || kind === "reverse_charge" || kind === "intra_eu_goods") return this.chart.system("revenue_eu");
		if (kind === "export") return this.chart.system("revenue_export");
		const region = this.region(document.buyer_country);
		return this.chart.system(region === "domestic" ? "revenue_domestic" : region === "eu" ? "revenue_eu" : "revenue_export");
	}

	private vat(treatment: string | null): LedgerAccountRow {
		return this.chart.system(treatment === "oss" ? "oss_vat" : "output_vat");
	}

	private missing(source_type: JournalSourceType, source_id: string, reference: string | null) {
		this.issues.push({ source_type, source_id, reference, code: "missing_exchange_rate" });
	}

	private salesLines(entry: EntryBuilder, document: SalesDocument, lines: SalesLine[], sign: 1 | -1): boolean {
		let receivable = 0;
		for (const line of lines) {
			const net = this.convert(document, line.net);
			const vat = this.convert(document, line.vat);
			if (net === null || vat === null) return false;
			if (document.advance || line.advance) {
				entry.credit(this.chart.system("advances_received"), sign * (net + vat));
				entry.debit(this.chart.system("advance_vat"), sign * vat);
			} else entry.credit(this.revenue(document, line.treatment), sign * net);
			entry.credit(this.vat(line.treatment), sign * vat);
			receivable += net + vat;
		}
		entry.debit(this.receivable(document), sign * receivable, document.partner);
		return true;
	}

	private async loadBankLinks(project: string) {
		const lines = (await Database`
			SELECT bt.match_type, bt.match_id, bt.payment_transaction, bs.iban FROM bank_transactions bt
			JOIN bank_statements bs ON bs.uuid = bt.statement
			WHERE bt.project = ${project} AND bt.status = 'matched'
		`) as { match_type: string; match_id: string; payment_transaction: string | null; iban: string }[];
		for (const line of lines) {
			const account = this.chart.byIban(line.iban);
			if (!account) continue;
			if (line.match_type === "invoice" && line.payment_transaction) this.settledThrough.set(`payment:${line.payment_transaction}`, account);
			else this.settledThrough.set(`${line.match_type}:${line.match_id}`, account);
		}
	}

	private moneyFor(key: string, fallback: SystemAccount): LedgerAccountRow {
		return this.settledThrough.get(key) ?? this.chart.system(fallback);
	}

	async plan(): Promise<void> {
		const project = this.project.uuid;
		await this.loadBankLinks(project);
		const invoices = (await Database`
			SELECT * FROM invoices WHERE project = ${project} AND status <> 'draft' AND issued_at IS NOT NULL
				AND (status <> 'canceled' OR EXISTS (SELECT 1 FROM credit_notes cn WHERE cn.invoice = invoices.uuid))
		`) as InvoiceRow[];
		const items = grouped(
			(await Database`
				SELECT ii.* FROM invoice_items ii JOIN invoices i ON i.uuid = ii.invoice
				WHERE i.project = ${project} AND i.status <> 'draft' AND i.issued_at IS NOT NULL
			`) as InvoiceItemRow[],
			(row) => row.invoice
		);
		const notes = (await Database`SELECT * FROM credit_notes WHERE project = ${project}`) as CreditNoteRow[];
		const noteItems = grouped(
			(await Database`
				SELECT cni.* FROM credit_note_items cni JOIN credit_notes cn ON cn.uuid = cni.credit_note WHERE cn.project = ${project}
			`) as CreditNoteItemRow[],
			(row) => row.credit_note
		);
		const byInvoice = new Map(invoices.map((row) => [row.uuid, row]));
		const notesByInvoice = grouped(notes, (row) => row.invoice);

		const deductions = new Set(
			[...items.values()]
				.flat()
				.filter(advanceDeduction)
				.map((item) => item.uuid)
		);
		const invoiceLines = (invoice: InvoiceRow): SalesLine[] =>
			(items.get(invoice.uuid) ?? []).map((line) => ({
				net: line.total_price - line.discount_amount,
				vat: line.tax_amount,
				treatment: line.tax_treatment,
				advance: deductions.has(line.uuid),
			}));
		const noteLines = (note: CreditNoteRow): SalesLine[] =>
			(noteItems.get(note.uuid) ?? []).map((line) => ({
				net: line.net_amount,
				vat: line.tax_amount,
				treatment: line.tax_treatment,
				advance: line.invoice_item !== null && deductions.has(line.invoice_item),
			}));

		for (const invoice of invoices) {
			const entry = new EntryBuilder();
			if (!this.salesLines(entry, salesDocument(invoice), invoiceLines(invoice), 1)) {
				this.missing("invoice", invoice.uuid, invoice.reference);
				continue;
			}
			this.entries.push({
				source_type: "invoice",
				source_id: invoice.uuid,
				date: invoice.issued_at!,
				description: `${invoice.document_type === "advance" ? "Avansni račun" : "Račun"} ${invoice.reference}`,
				lines: entry.lines(),
			});
		}

		for (const note of notes) {
			const invoice = byInvoice.get(note.invoice);
			if (!invoice) continue;
			const entry = new EntryBuilder();
			if (!this.salesLines(entry, salesDocument(invoice), noteLines(note), -1)) {
				this.missing("credit_note", note.uuid, note.reference);
				continue;
			}
			this.entries.push({
				source_type: "credit_note",
				source_id: note.uuid,
				date: note.issued_at,
				description: `Dobropis ${note.reference} za račun ${invoice.reference}`,
				lines: entry.lines(),
			});
		}

		const transactions = (await Database`
			SELECT * FROM transactions WHERE project = ${project} AND invoice IS NOT NULL AND (
				(type = 'payment' AND status IN ${Database(SETTLED_PAYMENT_STATUSES)})
				OR (type IN ${Database(REFUND_TYPES)} AND status IN ${Database(SETTLED_REFUND_STATUSES)})
			)
		`) as TransactionRow[];
		for (const transaction of transactions) {
			const invoice = byInvoice.get(transaction.invoice!);
			if (!invoice) continue;
			const refund = transaction.type !== "payment";
			const sourceType = refund ? "refund" : "payment";
			const document: Amounts = { ...invoice, currency: transaction.currency };
			const amount = this.convert(document, transaction.amount);
			const valued = transaction.base_amount === null ? amount : Number(transaction.base_amount);
			const fee =
				transaction.base_amount === null || transaction.amount === 0
					? this.convert(document, transaction.fee_amount)
					: Math.round((transaction.fee_amount * Number(transaction.base_amount)) / transaction.amount);
			if (amount === null || valued === null || fee === null) {
				this.missing(sourceType, transaction.uuid, invoice.reference);
				continue;
			}
			const money = this.moneyFor(`payment:${transaction.uuid}`, MONEY_ACCOUNTS[transaction.processor] ?? "bank");
			const sign = refund ? -1 : 1;
			const entry = new EntryBuilder();
			entry.debit(money, sign * valued);
			entry.credit(this.receivable(invoice), sign * amount, buyerName(invoice));
			const difference = sign * (valued - amount);
			if (difference > 0) entry.credit(this.chart.system("fx_gains"), difference);
			if (difference < 0) entry.debit(this.chart.system("fx_losses"), -difference);
			entry.debit(this.chart.system("payment_fees"), fee);
			entry.credit(money, fee);
			this.entries.push({
				source_type: sourceType,
				source_id: transaction.uuid,
				date: settledAt(transaction),
				description: `${refund ? "Vračilo" : "Plačilo"} računa ${invoice.reference}`,
				lines: entry.lines(),
			});
		}

		const expenses = (await Database`SELECT * FROM expenses WHERE project = ${project}`) as ExpenseRow[];
		for (const expense of expenses) this.planExpense(expense);
		const shares = (await Database`SELECT year, final_share FROM deductible_shares WHERE project = ${project}`) as { year: number; final_share: number }[];
		this.planDeductibleShares(shares, expenses);

		const recorded = (await Database`SELECT * FROM recorded_invoices WHERE project = ${project}`) as RecordedInvoiceRow[];
		const recordedLines = grouped(
			(await Database`
				SELECT rl.* FROM recorded_invoice_lines rl JOIN recorded_invoices r ON r.uuid = rl.recorded_invoice WHERE r.project = ${project}
			`) as RecordedInvoiceLineRow[],
			(row) => row.recorded_invoice
		);
		for (const record of recorded) this.planRecordedInvoice(record, recordedLines.get(record.uuid) ?? []);

		const booked = (await Database`
			SELECT bt.*, bs.iban AS statement_iban FROM bank_transactions bt JOIN bank_statements bs ON bs.uuid = bt.statement
			WHERE bt.project = ${project} AND bt.status = 'booked' AND bt.ledger_account IS NOT NULL
		`) as (BankTransactionRow & { statement_iban: string })[];
		for (const line of booked) this.planBankLine(line);

		const assets = (await Database`SELECT * FROM fixed_assets WHERE project = ${project}`) as FixedAssetRow[];
		this.planDepreciation(assets);

		const runs = (await Database`SELECT * FROM payroll_runs WHERE project = ${project} AND status = 'final'`) as PayrollRunRow[];
		const payrollLines = grouped(
			(await Database`
				SELECT pl.* FROM payroll_lines pl JOIN payroll_runs pr ON pr.uuid = pl.run WHERE pr.project = ${project} AND pr.status = 'final'
			`) as PayrollLineRow[],
			(row) => row.run
		);
		for (const run of runs) this.planPayroll(run, payrollLines.get(run.uuid) ?? []);
		this.flagPayrollOverlap(expenses, runs);
	}

	private flagPayrollOverlap(expenses: ExpenseRow[], runs: PayrollRunRow[]) {
		const periods = new Set(runs.map((run) => run.period));
		if (periods.size === 0) return;
		const salaries = this.chart.system("salaries").uuid;
		for (const expense of expenses) {
			if (expense.asset_type !== "expense" || this.chart.forCategory(expense.category).uuid !== salaries) continue;
			const parts = zonedParts(expense.expense_date, this.project.timezone);
			if (!periods.has(`${parts.year}-${String(parts.month).padStart(2, "0")}`)) continue;
			this.issues.push({ source_type: "expense", source_id: expense.uuid, reference: expense.invoice_number ?? expense.description, code: "payroll_overlap" });
		}
	}

	private planPayroll(run: PayrollRunRow, lines: PayrollLineRow[]) {
		const entry = new EntryBuilder();
		let employerTotal = 0;
		let employerPension = 0;
		let otherLabor = 0;
		let credits = 0;
		for (const line of lines) {
			const calculation = JSON.parse(line.calculation) as PayrollCalculation;
			const net = calculation.net;
			if (!net || calculation.payout === null) continue;
			const extras = [calculation.regres, calculation.performance].filter((part): part is NonNullable<typeof part> => part !== null && part !== undefined);
			const employer = net.employer_contributions_total + extras.reduce((sum, part) => sum + sumValues(part.employer_contributions), 0);
			const tax = net.income_tax + extras.reduce((sum, part) => sum + part.income_tax, 0);
			const withheld = net.gross + extras.reduce((sum, part) => sum + part.amount, 0) - net.net - extras.reduce((sum, part) => sum + part.net, 0);
			const person = calculation.person.slice(0, 200);
			entry.credit(this.chart.system("net_salaries"), calculation.payout, person);
			entry.credit(this.chart.system("payroll_tax"), tax);
			entry.credit(this.chart.system("employee_contributions"), withheld - tax);
			entry.credit(this.chart.system("employer_contributions_liability"), employer);
			entry.credit(this.chart.system("payroll_deductions"), calculation.deductions);
			employerTotal += employer;
			employerPension += (net.employer_contributions.pension ?? 0) + extras.reduce((sum, part) => sum + (part.employer_contributions.pension ?? 0), 0);
			otherLabor += calculation.reimbursements + extras.reduce((sum, part) => sum + part.amount, 0);
			credits += calculation.payout + withheld + employer + calculation.deductions;
		}
		if (credits === 0) return;
		entry.debit(this.chart.system("employer_pension"), employerPension);
		entry.debit(this.chart.system("employer_contributions"), employerTotal - employerPension);
		entry.debit(this.chart.system("other_labor"), otherLabor);
		entry.debit(this.chart.system("salaries"), credits - employerTotal - otherLabor);
		const [year, month] = run.period.split("-").map(Number);
		const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
		this.entries.push({
			source_type: "payroll",
			source_id: run.uuid,
			date: startOfLocalDate(`${run.period}-${String(days).padStart(2, "0")}`, this.project.timezone),
			description: `Obračun plač ${String(month).padStart(2, "0")}/${year}`,
			lines: entry.lines(),
		});
	}

	private planDepreciation(assets: FixedAssetRow[]) {
		const timezone = this.project.timezone;
		const now = Date.now();
		const months = new Map<number, EntryBuilder>();
		for (const asset of assets) {
			const accounts = CATEGORY_ACCOUNTS[asset.asset_category];
			for (const { month, amount } of depreciationSchedule(asset, timezone, now)) {
				const entry = months.get(month) ?? new EntryBuilder();
				entry.debit(this.chart.system(accounts.expense), amount);
				entry.credit(this.chart.system(accounts.accumulated), amount);
				months.set(month, entry);
			}
			if (asset.disposed_at !== null && asset.disposed_at <= now) {
				const accumulated = accumulatedAt(asset, timezone, now);
				const disposal = new EntryBuilder();
				disposal.debit(this.chart.system(accounts.accumulated), accumulated);
				disposal.debit(this.chart.system("asset_write_off"), asset.acquisition_value - accumulated);
				disposal.credit(this.chart.system(accounts.asset), asset.acquisition_value);
				this.entries.push({
					source_type: "asset_disposal",
					source_id: asset.uuid,
					date: asset.disposed_at,
					description: `Izločitev osnovnega sredstva ${asset.name}`,
					lines: disposal.lines(),
				});
			}
		}
		for (const [month, entry] of months) {
			const label = `${String((month % 12) + 1).padStart(2, "0")}/${Math.floor(month / 12)}`;
			this.entries.push({
				source_type: "depreciation",
				source_id: label,
				date: lastDayOfMonth(month, timezone),
				description: `Obračun amortizacije ${label}`,
				lines: entry.lines(),
			});
		}
	}

	private planBankLine(line: BankTransactionRow & { statement_iban: string }) {
		const account = this.chart.byUuid(line.ledger_account!);
		if (!account) return;
		if (line.currency !== this.base) {
			this.missing("bank_transaction", line.uuid, line.bank_reference);
			return;
		}
		const entry = new EntryBuilder();
		entry.debit(this.chart.byIban(line.statement_iban) ?? this.chart.system("bank"), line.amount);
		entry.credit(account, line.amount, line.counterparty_name?.slice(0, 200) ?? null);
		const details = [line.counterparty_name, line.remittance].filter(Boolean).join(", ");
		this.entries.push({
			source_type: "bank_transaction",
			source_id: line.uuid,
			date: line.booking_date,
			description: `Bančni izpisek${details ? `: ${details}` : ""}`,
			lines: entry.lines(),
		});
	}

	private planRecordedInvoice(record: RecordedInvoiceRow, lines: RecordedInvoiceLineRow[]) {
		const document: SalesDocument = { ...record, advance: false, partner: record.buyer_name.slice(0, 200) };
		const sign = record.document_type === "credit_note" ? -1 : 1;
		const entry = new EntryBuilder();
		const planned = lines.map((line) => ({ net: line.net_amount, vat: line.tax_amount, treatment: line.tax_treatment, advance: false }));
		if (!this.salesLines(entry, document, planned, sign)) {
			this.missing("recorded_invoice", record.uuid, record.reference);
			return;
		}
		const label = `${record.document_type === "credit_note" ? "Dobropis" : "Račun"} ${record.reference}, ${record.buyer_name}`;
		this.entries.push({ source_type: "recorded_invoice", source_id: record.uuid, date: record.issued_at, description: label, lines: entry.lines() });
		if (record.paid_at === null) return;
		const total = this.convert(document, record.total_amount);
		if (total === null) return;
		const money = this.moneyFor(`recorded_invoice:${record.uuid}`, record.payment_account === "cash" ? "cash" : "bank");
		const payment = new EntryBuilder();
		payment.debit(money, sign * total);
		payment.credit(this.receivable(document), sign * total, document.partner);
		this.entries.push({
			source_type: "recorded_payment",
			source_id: record.uuid,
			date: record.paid_at,
			description: `${record.document_type === "credit_note" ? "Vračilo po dobropisu" : "Plačilo računa"} ${record.reference}`,
			lines: payment.lines(),
		});
	}

	private costAccount(expense: ExpenseRow): LedgerAccountRow {
		if (expense.asset_type === "real_estate") return this.chart.system("real_estate");
		if (expense.asset_type === "fixed_asset") return this.chart.system(expense.category === "Software" ? "intangible" : "equipment");
		return this.chart.forCategory(expense.category);
	}

	private planDeductibleShares(shares: { year: number; final_share: number }[], expenses: ExpenseRow[]) {
		const timezone = this.project.timezone;
		for (const share of shares) {
			const year = Number(share.year);
			const entry = new EntryBuilder();
			for (const expense of expenses) {
				if (!expense.provisional_share || zonedParts(expense.expense_date, timezone).year !== year) continue;
				const document: Amounts = { currency: expense.currency, tax_currency: this.base, tax_exchange_rate: expense.tax_exchange_rate };
				const tax = this.convert(document, expense.tax_amount);
				const deducted = this.convert(document, expense.deductible_tax_amount);
				if (tax === null || deducted === null) continue;
				const difference = Math.round((tax * Number(share.final_share)) / 100) - deducted;
				entry.debit(this.chart.system("input_vat"), difference);
				entry.credit(this.costAccount(expense), difference);
			}
			const lines = entry.lines();
			if (lines.length === 0) continue;
			this.entries.push({
				source_type: "deductible_share",
				source_id: String(year),
				date: startOfLocalDate(`${year}-12-31`, timezone),
				description: `Popravek odbitka DDV po končnem odbitnem deležu ${Number(share.final_share)} % za ${year}`,
				lines,
			});
		}
	}

	private planExpense(expense: ExpenseRow) {
		const document: Amounts = { currency: expense.currency, tax_currency: this.base, tax_exchange_rate: expense.tax_exchange_rate };
		const total = this.convert(document, expense.total_amount);
		const tax = this.convert(document, expense.tax_amount);
		const deductible = this.convert(document, expense.deductible_tax_amount);
		const label = expense.invoice_number ?? expense.description;
		if (total === null || tax === null || deductible === null) {
			this.missing("expense", expense.uuid, label);
			return;
		}
		const payable = this.chart.system(this.region(expense.supplier_country) === "domestic" ? "payables_domestic" : "payables_foreign");
		const cost = this.costAccount(expense);
		const supplier = expense.supplier;
		const entry = new EntryBuilder();
		if (REVERSE_CHARGE_PURCHASES.includes(expense.vat_treatment)) {
			entry.debit(cost, total + tax - deductible);
			entry.debit(this.chart.system("input_vat"), deductible);
			entry.credit(payable, total, supplier);
			entry.credit(this.chart.system("self_assessed_vat"), tax);
		} else {
			entry.debit(cost, total - deductible);
			entry.debit(this.chart.system("input_vat"), deductible);
			entry.credit(payable, total, supplier);
		}
		this.entries.push({
			source_type: "expense",
			source_id: expense.uuid,
			date: expense.expense_date,
			description: `Prejeti račun ${label}${supplier ? `, ${supplier}` : ""}`,
			lines: entry.lines(),
		});
		if (expense.paid_at !== null) {
			const payment = new EntryBuilder();
			payment.debit(payable, total, supplier);
			payment.credit(this.moneyFor(`expense:${expense.uuid}`, "bank"), total);
			this.entries.push({
				source_type: "expense_payment",
				source_id: expense.uuid,
				date: expense.paid_at,
				description: `Plačilo prejetega računa ${label}`,
				lines: payment.lines(),
			});
		}
	}
}
