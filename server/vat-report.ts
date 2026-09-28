import { minorUnitDigits } from "./invoicing";

export interface VatReportRows {
	currency: string;
	domestic: { rate: number; net: number; vat: number }[];
	oss: { country: string; rate: number; net: number; vat: number }[];
	zero_rated: { treatment: string; net: number }[];
	ec_sales_list: { vat_number: string; country: string; goods: number; services: number }[];
}

export function vatPeriod(choice: string, now = new Date()): { from?: number; to?: number } {
	const year = now.getFullYear();
	const month = now.getMonth();
	const quarter = Math.floor(month / 3) * 3;
	const span = (start: Date, end: Date) => ({ from: start.getTime(), to: end.getTime() - 1 });

	switch (choice) {
		case "this-month":
			return span(new Date(year, month, 1), new Date(year, month + 1, 1));
		case "last-month":
			return span(new Date(year, month - 1, 1), new Date(year, month, 1));
		case "this-quarter":
			return span(new Date(year, quarter, 1), new Date(year, quarter + 3, 1));
		case "last-quarter":
			return span(new Date(year, quarter - 3, 1), new Date(year, quarter, 1));
		case "this-year":
			return span(new Date(year, 0, 1), new Date(year + 1, 0, 1));
		case "last-year":
			return span(new Date(year - 1, 0, 1), new Date(year, 0, 1));
		default:
			return {};
	}
}

function csvCell(value: string | number): string {
	const text = String(value);
	return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function major(amount: number, currency: string): string {
	const digits = minorUnitDigits(currency);
	return (amount / Math.pow(10, digits)).toFixed(digits);
}

export function vatReportCsv(report: VatReportRows): string {
	const c = report.currency;
	const rows: (string | number)[][] = [["section", "key", "rate", "net", "vat"]];
	for (const row of report.domestic) rows.push(["domestic", "", row.rate, major(row.net, c), major(row.vat, c)]);
	for (const row of report.oss) rows.push(["oss", row.country, row.rate, major(row.net, c), major(row.vat, c)]);
	for (const row of report.zero_rated) rows.push(["zero_rated", row.treatment, 0, major(row.net, c), major(0, c)]);
	for (const row of report.ec_sales_list) {
		if (row.goods) rows.push(["ec_sales_list_goods", row.vat_number, 0, major(row.goods, c), major(0, c)]);
		if (row.services) rows.push(["ec_sales_list_services", row.vat_number, 0, major(row.services, c), major(0, c)]);
	}
	return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}
