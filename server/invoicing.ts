import type { InvoiceStatus } from "./database/models";

export interface InvoiceItemInput {
	description: string;
	quantity: number;
	unit_price: number;
	tax_rate?: number;
	metadata?: Record<string, unknown> | null;
	item?: string | null;
	tax_treatment?: string | null;
	gross_amount?: number | null;
	unit?: string | null;
}

export interface CalculatedItem {
	description: string;
	quantity: number;
	unit_price: number;
	tax_rate: number;
	tax_amount: number;
	total_price: number;
	discount_amount: number;
	metadata: string | null;
	item: string | null;
	tax_treatment: string | null;
	unit: string | null;
}

export interface InvoiceTotals {
	items: CalculatedItem[];
	subtotal: number;
	tax_amount: number;
	discount_amount: number;
	total_amount: number;
}

export const INVOICE_STATUSES: InvoiceStatus[] = ["draft", "open", "paid", "partially_paid", "canceled", "overdue", "refunded"];

const digitsCache = new Map<string, number>();

export function minorUnitDigits(currency: string): number {
	const cached = digitsCache.get(currency);
	if (cached !== undefined) return cached;

	let digits = 2;
	try {
		digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
	} catch {
		digits = 2;
	}

	digitsCache.set(currency, digits);
	return digits;
}

export function convertMinor(amount: number, from: string, rate: number, to: string): number {
	const major = amount / Math.pow(10, minorUnitDigits(from));
	return Math.round(major * rate * Math.pow(10, minorUnitDigits(to)));
}

export function allocateDiscount(lineTotals: number[], discount: number): number[] {
	const subtotal = lineTotals.reduce((sum, total) => sum + total, 0);
	if (discount <= 0 || subtotal <= 0) return lineTotals.map(() => 0);

	const exact = lineTotals.map((total) => (discount * total) / subtotal);
	const shares = exact.map((value) => Math.floor(value));
	let remainder = discount - shares.reduce((sum, share) => sum + share, 0);

	const order = exact.map((value, index) => ({ index, fraction: value - Math.floor(value) })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
	for (const { index } of order) {
		if (remainder <= 0) break;
		shares[index] += 1;
		remainder -= 1;
	}

	return shares;
}

export function taxIncluded(gross: number, taxRate: number): number {
	return Math.round((gross * taxRate) / (100 + taxRate));
}

function priceIncludesTax(item: InvoiceItemInput): item is InvoiceItemInput & { gross_amount: number } {
	return typeof item.gross_amount === "number";
}

export function calculateTotals(items: InvoiceItemInput[], discountAmount: number): InvoiceTotals {
	const lineTotals = items.map((item) =>
		priceIncludesTax(item) ? item.gross_amount - taxIncluded(item.gross_amount, item.tax_rate ?? 0) : Math.round(item.quantity * item.unit_price)
	);
	const subtotal = lineTotals.reduce((sum, total) => sum + total, 0);
	const discount = Math.min(Math.max(discountAmount, 0), subtotal);
	const shares = allocateDiscount(lineTotals, discount);

	const calculated: CalculatedItem[] = items.map((item, index) => {
		const taxRate = item.tax_rate ?? 0;
		const taxAmount =
			priceIncludesTax(item) && shares[index] === 0 ? item.gross_amount - lineTotals[index] : Math.round(((lineTotals[index] - shares[index]) * taxRate) / 100);

		return {
			description: item.description,
			quantity: item.quantity,
			unit_price: item.unit_price,
			tax_rate: taxRate,
			tax_amount: taxAmount,
			total_price: lineTotals[index],
			discount_amount: shares[index],
			metadata: item.metadata ? JSON.stringify(item.metadata) : null,
			item: item.item ?? null,
			tax_treatment: item.tax_treatment ?? null,
			unit: item.unit ?? null,
		};
	});

	const tax = calculated.reduce((sum, item) => sum + item.tax_amount, 0);

	return {
		items: calculated,
		subtotal,
		tax_amount: tax,
		discount_amount: discount,
		total_amount: subtotal - discount + tax,
	};
}

export function outstandingOf(invoice: { total_amount: number; paid_amount: number; refunded_amount: number; credited_amount?: number }): number {
	return Math.max(invoice.total_amount - (invoice.credited_amount ?? 0) - (invoice.paid_amount - invoice.refunded_amount), 0);
}

export function statusForPayment(totalAmount: number, paidAmount: number, dueDate: number, now: number): InvoiceStatus {
	if (paidAmount >= totalAmount && totalAmount > 0) return "paid";
	if (paidAmount > 0) return "partially_paid";
	if (dueDate < now) return "overdue";
	return "open";
}

export function isEditable(status: InvoiceStatus): boolean {
	return status === "draft";
}

export function isCancelable(status: InvoiceStatus): boolean {
	return status !== "paid" && status !== "canceled" && status !== "refunded";
}
