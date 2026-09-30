import type { ExpenseRow } from "./database/models";

export const EXPENSE_VAT_TREATMENTS = ["not_reported", "domestic", "domestic_reverse_charge", "eu_goods", "eu_services", "import", "exempt"] as const;
export type ExpenseVatTreatment = (typeof EXPENSE_VAT_TREATMENTS)[number];
export const EXPENSE_ASSET_TYPES = ["expense", "real_estate", "fixed_asset"] as const;
export type ExpenseAssetType = (typeof EXPENSE_ASSET_TYPES)[number];
export type ExpenseVatHandling = "1" | "2" | "3";

export interface ExpenseVatLineInput {
	rate: number;
	tax_base: number;
	tax_amount: number;
	deductible_tax_amount: number;
}

export function includedTaxAtRate(total: number, rate: number): number {
	if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(rate) || rate <= 0) return 0;
	return Math.round((total / (100 + rate)) * rate);
}

export type ExpenseInput = Pick<
	ExpenseRow,
	| "description"
	| "supplier"
	| "supplier_tax_number"
	| "supplier_country"
	| "invoice_number"
	| "category"
	| "currency"
	| "total_amount"
	| "tax_amount"
	| "deductible_tax_amount"
	| "expense_date"
	| "issue_date"
	| "receipt_date"
	| "supply_date"
	| "vat_treatment"
	| "asset_type"
	| "vat_handling"
	| "self_assessment_period"
	| "self_assessment_tax"
	| "tax_exchange_rate"
	| "tax_rate_date"
	| "paid_at"
	| "notes"
> & { vat_lines: ExpenseVatLineInput[]; provisional_share?: boolean | number };
export type ExpenseScheduleInput = Omit<ExpenseInput, "expense_date" | "paid_at"> & {
	interval_unit: string;
	interval_count: number;
	start_date: number;
	end_date: number | null;
	max_occurrences: number | null;
	auto_paid: boolean;
};

export interface FinancialValues {
	revenue: number;
	expenses: number;
	fees: number;
	profit: number;
	received: number;
	refunds: number;
	paid_expenses: number;
	cash_flow: number;
}
export interface FinancialPeriod extends FinancialValues {
	period: string;
	currency: string;
}
export interface FinancialReport {
	from: number;
	to: number;
	group: "month" | "year";
	periods: FinancialPeriod[];
	totals: (FinancialValues & { currency: string })[];
	categories: { currency: string; category: string; amount: number }[];
}
