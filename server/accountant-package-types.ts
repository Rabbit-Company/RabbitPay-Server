import type { CompanyDetails } from "./company";
import type { ExpensePaymentMethod } from "./expense-types";

export type ReceivedGroup = "domestic" | "foreign" | "paid_on_spot";

export interface PackageIssued {
	id: string;
	key: string;
	fingerprint: string;
	source: "invoice" | "recorded";
	reference: string;
	document_type: string;
	customer: string;
	tax_number: string | null;
	country: string | null;
	issued_at: number;
	due_date: number | null;
	currency: string;
	total_original: number;
	net: number | null;
	vat: number | null;
	total: number | null;
	status: "open" | "paid" | "canceled";
	paid_at: number | null;
	counted: boolean;
}

export interface PackageCreditNote {
	id: string;
	key: string;
	fingerprint: string;
	source: "credit_note" | "recorded";
	reference: string;
	invoice_reference: string | null;
	customer: string;
	tax_number: string | null;
	issued_at: number;
	currency: string;
	total_original: number;
	net: number | null;
	vat: number | null;
	total: number | null;
	reason: string | null;
}

export interface PackageReceived {
	id: string;
	key: string;
	fingerprint: string;
	group: ReceivedGroup;
	supplier: string;
	tax_number: string | null;
	country: string | null;
	invoice_number: string | null;
	description: string;
	category: string;
	issue_date: number | null;
	booked_at: number;
	due_date: number | null;
	paid_at: number | null;
	payment_method: ExpensePaymentMethod;
	vat_treatment: string;
	currency: string;
	total_original: number;
	net: number | null;
	vat: number | null;
	deductible: number | null;
	total: number | null;
	attached: boolean;
}

export interface VatReturnSummary {
	fields: Record<string, number>;
	output_vat: number;
	input_vat: number;
	corrections: number;
}

export interface PackageBankLine {
	booking_date: number;
	counterparty: string;
	counterparty_iban: string | null;
	description: string;
	amount: number;
	status: "open" | "matched" | "booked" | "ignored" | "private";
	settles: string;
}

export interface PackageBankAccount {
	iban: string;
	currency: string;
	opening_balance: number | null;
	closing_balance: number | null;
	statements: number;
	lines: PackageBankLine[];
}

export interface PackageOpenItem {
	kind: "receivable" | "payable";
	partner: string;
	tax_number: string | null;
	reference: string;
	date: number;
	due_date: number | null;
	days_overdue: number;
	amount: number;
	open: number;
	currency: string | null;
	open_foreign: number;
}

export interface PackageChanges {
	since: number;
	added: string[];
	changed: string[];
	removed: string[];
}

export interface PackageCheck {
	code: string;
	reference: string | null;
	detail: string | null;
}

export interface AccountantPackage {
	company: { name: string; details: CompanyDetails };
	language: string;
	timezone: string;
	date_format: string;
	currency: string;
	period: { from: string; to: string };
	vat_registered: boolean;
	monthly_vat_period: boolean;
	generated_at: number;
	issued: PackageIssued[];
	credit_notes: PackageCreditNote[];
	received: PackageReceived[];
	vat_return: VatReturnSummary | null;
	bank: PackageBankAccount[];
	bank_used: boolean;
	open_items: PackageOpenItem[];
	changes: PackageChanges | null;
	checks: PackageCheck[];
}
