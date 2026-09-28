import Database from "./database/database";
import { convertMinor } from "./invoicing";
import { isEnabled as ratesEnabled, rateProvider } from "./rates/forex";
import type { CustomerRow, ProjectRow } from "./database/models";

export { convertMinor };

export interface IssueSnapshot {
	issued_at: number;
	tax_currency: string;
	tax_exchange_rate: number | null;
	tax_rate_source: string | null;
	tax_rate_date: number | null;
	buyer_country: string | null;
	buyer_vat_number: string | null;
}

export function reportingCurrency(project: Pick<ProjectRow, "tax_currency" | "currency">): string {
	return project.tax_currency ?? project.currency;
}

export async function marketRate(from: string, to: string): Promise<number | null> {
	if (from === to) return 1;
	if (!ratesEnabled()) return null;

	const rates = await rateProvider().fiatRates?.(from);
	const rate = rates?.[to];
	return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : null;
}

export async function issueSnapshot(
	project: Pick<ProjectRow, "tax_currency" | "currency">,
	invoice: { currency: string; customer: string | null },
	issuedAt: number
): Promise<IssueSnapshot> {
	const taxCurrency = reportingCurrency(project);
	const rate = await marketRate(invoice.currency, taxCurrency);

	const [customer] = invoice.customer
		? ((await Database`SELECT country, vat_number FROM customers WHERE uuid = ${invoice.customer}`) as Pick<CustomerRow, "country" | "vat_number">[])
		: [];

	return {
		issued_at: issuedAt,
		tax_currency: taxCurrency,
		tax_exchange_rate: rate,
		tax_rate_source: rate === null ? null : invoice.currency === taxCurrency ? "same" : "RabbitForex",
		tax_rate_date: rate === null ? null : issuedAt,
		buyer_country: customer?.country ?? null,
		buyer_vat_number: customer?.vat_number ?? null,
	};
}
