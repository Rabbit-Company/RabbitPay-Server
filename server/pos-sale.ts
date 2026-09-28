import Validate from "./validate";
import { ErrorCode } from "./errors";
import { minorUnitDigits, taxIncluded, type InvoiceItemInput } from "./invoicing";
import { STANDARD_RATES, suggestTax, type SellerTax, type SupplyType, type TaxCategory } from "./tax";
import type { CatalogItemRow, ProjectRow } from "./database/models";

export const MAX_SALE_LINES = 200;
export const MAX_LINE_QUANTITY = 9999;
export const CUSTOM_LINE_LABEL = "Custom amount";

export interface SaleLineInput {
	item?: string | null;
	amount?: number | null;
	description?: string | null;
	quantity?: number;
}

export type SaleProject = Pick<ProjectRow, "tax_country" | "vat_status" | "oss_registered">;

export interface SalePricing {
	currency: string;
	catalog: Map<string, CatalogItemRow>;
	rates: Record<string, number> | null;
	allowCustomAmounts: boolean;
}

export function sellerOf(project: SaleProject): SellerTax {
	return { country: project.tax_country, vatStatus: project.vat_status, ossRegistered: Boolean(project.oss_registered) };
}

export function customAmountRate(project: SaleProject): number {
	return project.vat_status === "registered" && project.tax_country ? (STANDARD_RATES[project.tax_country] ?? 0) : 0;
}

export function isSaleLines(value: unknown): value is SaleLineInput[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SALE_LINES) return false;

	return value.every((line) => {
		if (typeof line !== "object" || line === null) return false;
		const quantity = line.quantity ?? 1;
		if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) return false;

		const hasItem = line.item !== undefined && line.item !== null;
		const hasAmount = line.amount !== undefined && line.amount !== null;
		if (hasItem === hasAmount) return false;
		if (hasItem) return Validate.uuid(line.item);

		if (!Validate.minorUnitAmount(line.amount) || line.amount === 0) return false;
		return Validate.optionalText(line.description, 200);
	});
}

export function convertedPrice(item: CatalogItemRow, currency: string, rates: Record<string, number> | null): number | null {
	if (item.currency === currency) return item.unit_price;
	if (!rates) return null;

	const source = rates[item.currency.toUpperCase()];
	const target = rates[currency.toUpperCase()];
	if (!source || !target) return null;

	const major = item.unit_price / Math.pow(10, minorUnitDigits(item.currency));
	return Math.round((major / source) * target * Math.pow(10, minorUnitDigits(currency)));
}

export function priceSale(project: SaleProject, lines: SaleLineInput[], pricing: SalePricing): InvoiceItemInput[] | ErrorCode {
	const seller = sellerOf(project);
	const priced: InvoiceItemInput[] = [];

	for (const line of lines) {
		const quantity = line.quantity ?? 1;

		if (line.item) {
			const item = pricing.catalog.get(line.item);
			if (!item || item.archived) return ErrorCode.ITEM_NOT_FOUND;

			const price = convertedPrice(item, pricing.currency, pricing.rates);
			if (price === null) return ErrorCode.RATE_UNAVAILABLE;

			const tax = suggestTax(seller, null, { supplyType: item.supply_type as SupplyType, category: item.tax_category as TaxCategory, rate: item.tax_rate });
			priced.push({ description: item.name, quantity, unit_price: price, tax_rate: tax.rate, item: item.uuid, tax_treatment: tax.treatment, unit: item.unit });
			continue;
		}

		if (!pricing.allowCustomAmounts) return ErrorCode.CUSTOM_AMOUNTS_DISABLED;

		const tax = suggestTax(seller, null, { supplyType: "goods", category: "standard", rate: customAmountRate(project) });
		const gross = line.amount! * quantity;
		priced.push({
			description: line.description?.trim() || CUSTOM_LINE_LABEL,
			quantity,
			unit_price: Math.round((gross - taxIncluded(gross, tax.rate)) / quantity),
			tax_rate: tax.rate,
			item: null,
			tax_treatment: tax.treatment,
			gross_amount: gross,
		});
	}

	return priced;
}

export function startOfDay(timestamp: number): number {
	const date = new Date(timestamp);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

export function endOfDay(timestamp: number): number {
	const date = new Date(timestamp);
	date.setHours(23, 59, 59, 999);
	return date.getTime();
}

export function formatMinor(amount: number, currency: string): string {
	const digits = minorUnitDigits(currency);
	return `${(amount / Math.pow(10, digits)).toFixed(digits)} ${currency}`;
}

export function cashNote(amount: number, tendered: number | null, currency: string): string | null {
	if (tendered === null || tendered <= amount) return null;
	return `Cash received ${formatMinor(tendered, currency)}, change given ${formatMinor(tendered - amount, currency)}`;
}

export interface SaleFacts {
	status: string;
	currency: string;
	total_amount: number;
	credited_amount: number;
	paid_amount: number;
	refunded_amount: number;
}

export interface CashMovement {
	currency: string;
	type: string;
	amount: number;
}

export interface SalesSummary {
	currency: string;
	sales: number;
	canceled: number;
	total: number;
	received: number;
	cash: number;
	other: number;
	outstanding: number;
}

const OPEN_SALE_STATUSES = new Set(["open", "overdue", "partially_paid"]);

export function summarizeSales(sales: SaleFacts[], cash: CashMovement[]): SalesSummary[] {
	const byCurrency = new Map<string, SalesSummary>();
	const entry = (currency: string) => {
		let found = byCurrency.get(currency);
		if (!found) {
			found = { currency, sales: 0, canceled: 0, total: 0, received: 0, cash: 0, other: 0, outstanding: 0 };
			byCurrency.set(currency, found);
		}
		return found;
	};

	for (const sale of sales) {
		const summary = entry(sale.currency);
		const received = sale.paid_amount - sale.refunded_amount;
		summary.received += received;

		if (sale.status === "canceled") {
			summary.canceled++;
			continue;
		}

		summary.sales++;
		summary.total += sale.total_amount - sale.credited_amount;
		if (OPEN_SALE_STATUSES.has(sale.status)) {
			summary.outstanding += Math.max(sale.total_amount - sale.credited_amount - received, 0);
		}
	}

	for (const movement of cash) {
		entry(movement.currency).cash += movement.type === "payment" ? movement.amount : -movement.amount;
	}

	for (const summary of byCurrency.values()) summary.other = summary.received - summary.cash;

	return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}
