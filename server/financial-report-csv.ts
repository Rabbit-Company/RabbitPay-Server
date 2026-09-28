import type { FinancialReport } from "./expense-types";

export function financialReportCsv(report: FinancialReport): string {
	const columns = ["period", "currency", "revenue", "expenses", "fees", "profit", "received", "refunds", "paid_expenses", "cash_flow"] as const;
	return [columns.join(","), ...report.periods.map((row) => columns.map((key) => row[key]).join(","))].join("\r\n") + "\r\n";
}
