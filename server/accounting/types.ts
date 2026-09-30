import type { BankMatchType, JournalEntryRow, JournalSourceType, LedgerAccountRow, RecordedInvoiceRow } from "../database/models";

export interface LedgerIssue {
	source_type: JournalSourceType;
	source_id: string;
	reference: string | null;
	code: "missing_exchange_rate" | "closed_year" | "payroll_overlap";
}

export interface JournalLineView {
	account: string;
	code: string;
	name: string;
	debit: number;
	credit: number;
	partner: string | null;
}

export interface JournalEntryView extends JournalEntryRow {
	reversed_by: string | null;
	lines: JournalLineView[];
}

export interface TrialBalanceRow {
	account: string;
	code: string;
	name: string;
	kind: LedgerAccountRow["account_kind"];
	opening: number;
	debit: number;
	credit: number;
	closing: number;
}

export interface AccountLedgerRow {
	entry: string;
	year: number;
	number: number;
	entry_date: number;
	description: string;
	debit: number;
	credit: number;
	balance: number;
	partner: string | null;
}

export interface RecordedInvoiceLineInput {
	tax_rate: number;
	tax_treatment: string;
	net_amount: number;
	tax_amount: number;
}

export interface RecordedInvoiceInput {
	document_type: RecordedInvoiceRow["document_type"];
	reference: string;
	buyer_name: string;
	buyer_vat_number: string | null;
	buyer_country: string | null;
	currency: string;
	tax_exchange_rate: number | null;
	tax_rate_date: number | null;
	issued_at: number;
	supply_date: number | null;
	due_date: number | null;
	paid_at: number | null;
	payment_account: RecordedInvoiceRow["payment_account"];
	notes: string | null;
	lines: RecordedInvoiceLineInput[];
}

export interface BankSuggestion {
	type: BankMatchType;
	id: string;
	reference: string | null;
	name: string | null;
	amount: number;
	currency: string;
	exact: boolean;
}

export type YearCloseRefusal = "year_not_over" | "earlier_year_open" | "ledger_issues" | "already_closed" | "nothing_to_close" | "later_year_closed";

export interface AccountingYear {
	year: number;
	entries: number;
	closed: boolean;
	closed_at: number | null;
	closed_by: string | null;
	result: number | null;
	final_share: number | null;
	provisional_expenses: number;
	share_adjustment: number | null;
}

export interface StatementLine {
	id: string;
	label: string;
	level: number;
	amount: number;
	previous?: number;
}

export interface UnmappedAccount {
	code: string;
	name: string;
	amount: number;
}

export interface FinancialStatements {
	year: number;
	currency: string;
	balance_sheet: {
		assets: StatementLine[];
		sources: StatementLine[];
		total_assets: number;
		total_sources: number;
		previous_total_assets: number;
		previous_total_sources: number;
		balanced: boolean;
		unmapped: UnmappedAccount[];
	};
	income_statement: {
		lines: StatementLine[];
		result: number;
		previous_result: number;
		reconciled: boolean;
		unmapped: UnmappedAccount[];
	};
}

export type KpoColumn =
	| "revenue_sales"
	| "revenue_other"
	| "material"
	| "services"
	| "labor"
	| "depreciation"
	| "interest"
	| "taxes_contributions"
	| "other_costs";

export interface KpoRow {
	entry: string;
	sequence?: number;
	number: string;
	date: number;
	description: string;
	amounts: Partial<Record<KpoColumn, number>>;
}

export interface KpoBook {
	year: number;
	rows: KpoRow[];
	totals: Record<KpoColumn, number>;
	revenue: number;
	expenses: number;
	result: number;
}

export interface AjpesLine {
	aop: string;
	label: string;
	current: number;
	previous: number;
	total: boolean;
}

export interface AjpesReport {
	year: number;
	form: "company" | "sole_trader";
	currency: string;
	balance_sheet: AjpesLine[];
	income_statement: AjpesLine[];
	balanced: boolean;
}
