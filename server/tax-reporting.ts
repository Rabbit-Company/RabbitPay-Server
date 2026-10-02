import Database from "./database/database";
import { convertMinor } from "./invoicing";
import { isEnabled as ratesEnabled, rateProvider } from "./rates/forex";
import { ECB_SOURCE, ecbReferenceRate } from "./rates/ecb";
import { localDate, startOfLocalDate, endOfLocalDate } from "./timezone";
import type { CustomerRow, InvoiceRow, ProjectRow } from "./database/models";

export { convertMinor };

export const MANUAL_RATE_SOURCE = "manual";
export const MARKET_RATE_SOURCE = "RabbitForex";
export const ECB_REPORTING_CURRENCY = "EUR";

export interface IssueSnapshot {
	issued_at: number;
	tax_point_date: number;
	tax_currency: string;
	tax_exchange_rate: number | null;
	tax_rate_source: string | null;
	tax_rate_date: number | null;
	buyer_country: string | null;
	buyer_vat_number: string | null;
}

export interface TaxRate {
	rate: number;
	source: string;
	date: number;
}

export type RatedInvoice = Pick<InvoiceRow, "currency" | "supply_date"> & Partial<Pick<InvoiceRow, "tax_exchange_rate" | "tax_rate_source">>;

export interface TaxPointLine {
	tax_rate: number;
	tax_treatment: string | null;
}

const INTRA_EU_INVOICE_DAY = 15;

export function taxPointDate(timezone: string, supplyDate: number | null, issuedAt: number, lines: TaxPointLine[]): number {
	const supplied = supplyDate ?? issuedAt;
	const intraEuGoods = lines.some((line) => line.tax_treatment === "intra_eu_goods") && lines.every((line) => line.tax_rate === 0);
	if (!intraEuGoods) return supplied;

	const [year, month] = localDate(supplied, timezone).split("-").map(Number);
	const following = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
	const latest = endOfLocalDate(`${following}-${INTRA_EU_INVOICE_DAY}`, timezone);
	return Math.min(issuedAt, latest);
}

export function reportingCurrency(project: Pick<ProjectRow, "tax_currency" | "currency">): string {
	return project.tax_currency ?? project.currency;
}

export function validTaxExchangeRate(rate: unknown): rate is number {
	return typeof rate === "number" && Number.isFinite(rate) && rate > 0 && rate < 1e9;
}

export function taxRatePrinted(invoice: Pick<InvoiceRow, "currency" | "tax_currency" | "tax_exchange_rate" | "tax_amount">): boolean {
	return invoice.tax_amount !== 0 && invoice.tax_exchange_rate !== null && invoice.tax_currency !== null && invoice.tax_currency !== invoice.currency;
}

export async function marketRate(from: string, to: string): Promise<number | null> {
	if (from === to) return 1;
	if (!ratesEnabled()) return null;

	const rates = await rateProvider().fiatRates?.(from);
	const rate = rates?.[to];
	return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : null;
}

export async function taxRateFor(
	project: Pick<ProjectRow, "tax_currency" | "currency" | "timezone">,
	invoice: RatedInvoice,
	issuedAt: number,
	taxPoint: number = invoice.supply_date ?? issuedAt
): Promise<TaxRate | null> {
	const taxCurrency = reportingCurrency(project);
	if (invoice.currency === taxCurrency) return { rate: 1, source: "same", date: issuedAt };

	if (invoice.tax_rate_source === MANUAL_RATE_SOURCE && validTaxExchangeRate(invoice.tax_exchange_rate)) {
		return { rate: invoice.tax_exchange_rate, source: MANUAL_RATE_SOURCE, date: taxPoint };
	}

	if (taxCurrency === ECB_REPORTING_CURRENCY) {
		const reference = await ecbReferenceRate(invoice.currency, localDate(taxPoint, project.timezone));
		return reference ? { rate: 1 / reference.rate, source: ECB_SOURCE, date: startOfLocalDate(reference.day, project.timezone) } : null;
	}

	const rate = await marketRate(invoice.currency, taxCurrency);
	return rate === null ? null : { rate, source: MARKET_RATE_SOURCE, date: issuedAt };
}

export async function issueSnapshot(
	project: Pick<ProjectRow, "tax_currency" | "currency" | "timezone">,
	invoice: RatedInvoice & { customer: string | null },
	issuedAt: number,
	lines: TaxPointLine[] = []
): Promise<IssueSnapshot> {
	const taxPoint = taxPointDate(project.timezone, invoice.supply_date, issuedAt, lines);
	const rate = await taxRateFor(project, invoice, issuedAt, taxPoint);

	const [customer] = invoice.customer
		? ((await Database`SELECT country, vat_number FROM customers WHERE uuid = ${invoice.customer}`) as Pick<CustomerRow, "country" | "vat_number">[])
		: [];

	return {
		issued_at: issuedAt,
		tax_point_date: taxPoint,
		tax_currency: reportingCurrency(project),
		tax_exchange_rate: rate?.rate ?? null,
		tax_rate_source: rate?.source ?? null,
		tax_rate_date: rate?.date ?? null,
		buyer_country: customer?.country ?? null,
		buyer_vat_number: customer?.vat_number ?? null,
	};
}
