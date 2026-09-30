import type { LicenseType } from "./database/models";

export const MAX_LICENSE_TRANSACTIONS = 100_000_000;
export const MAX_LICENSE_DAYS = 3650;
export const MAX_LICENSE_STORAGE_GB = 1_000_000;
export const MAX_LICENSE_EMPLOYEES = 1_000_000;
export const MAX_LICENSE_RATE = 100_000_000;
export const RATE_DAYS = 30;
export const RATE_PAYMENTS = 1000;

const SERVER_ID = /^RPS(?:-[0-9A-HJKMNP-TV-Z]{5}){4}$/;
const PRODUCT_TYPES: LicenseType[] = ["transactions", "white_label", "storage", "store", "workforce", "employees", "accounting"];

export interface LicenseGrant {
	type: LicenseType;
	transactions: number | null;
	duration_days: number | null;
	storage_gb: number | null;
	employees: number | null;
}

export interface LicenseProduct {
	type: LicenseType;
	rate: number;
	minimum: number;
	min_amount: number | null;
	max_amount: number | null;
	min_days: number | null;
	max_days: number | null;
}

export interface LicenseChoice {
	amount: number | null;
	days: number | null;
	server_id: string | null;
}

export function normalizeServerId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toUpperCase();
	return SERVER_ID.test(normalized) ? normalized : null;
}

export function usesAmount(type: LicenseType): boolean {
	return type === "transactions" || type === "storage" || type === "employees";
}

export function usesDays(type: LicenseType): boolean {
	return type === "white_label" || type === "store" || type === "workforce" || type === "employees" || type === "accounting";
}

export function amountLimit(type: LicenseType): number {
	if (type === "transactions") return MAX_LICENSE_TRANSACTIONS;
	if (type === "storage") return MAX_LICENSE_STORAGE_GB;
	return MAX_LICENSE_EMPLOYEES;
}

function isWhole(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function readRange(minimum: unknown, maximum: unknown, limit: number): { min: number; max: number } | null {
	if (!isWhole(minimum, 1, limit) || !isWhole(maximum, 1, limit) || minimum > maximum) return null;
	return { min: minimum, max: maximum };
}

export function readLicenseProduct(value: unknown): LicenseProduct | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const data = value as Record<string, unknown>;
	const type = data.type as LicenseType;
	if (!PRODUCT_TYPES.includes(type)) return null;
	if (!isWhole(data.rate, 0, MAX_LICENSE_RATE) || !isWhole(data.minimum, 0, MAX_LICENSE_RATE)) return null;

	const amount = usesAmount(type) ? readRange(data.min_amount, data.max_amount, amountLimit(type)) : null;
	const days = usesDays(type) ? readRange(data.min_days, data.max_days, MAX_LICENSE_DAYS) : null;
	if (usesAmount(type) && amount === null) return null;
	if (usesDays(type) && days === null) return null;

	return {
		type,
		rate: data.rate,
		minimum: data.minimum,
		min_amount: amount?.min ?? null,
		max_amount: amount?.max ?? null,
		min_days: days?.min ?? null,
		max_days: days?.max ?? null,
	};
}

export function parseLicenseProduct(stored: string | null): LicenseProduct | null {
	if (stored === null) return null;
	try {
		return readLicenseProduct(JSON.parse(stored));
	} catch {
		return null;
	}
}

export function readLicenseChoice(product: LicenseProduct, value: unknown): LicenseChoice | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const data = value as Record<string, unknown>;

	const amount = usesAmount(product.type) ? data.amount : null;
	const days = usesDays(product.type) ? data.days : null;
	if (usesAmount(product.type) && !isWhole(amount, product.min_amount!, product.max_amount!)) return null;
	if (usesDays(product.type) && !isWhole(days, product.min_days!, product.max_days!)) return null;

	const wantsServer = data.server_id !== undefined && data.server_id !== null && data.server_id !== "";
	const server = wantsServer ? normalizeServerId(data.server_id) : null;
	if (wantsServer && server === null) return null;

	return { amount: amount as number | null, days: days as number | null, server_id: server };
}

export function defaultChoice(product: LicenseProduct): LicenseChoice {
	return { amount: product.min_amount, days: product.min_days, server_id: null };
}

export function licensePrice(product: LicenseProduct, choice: Pick<LicenseChoice, "amount" | "days">): number {
	const amount = choice.amount ?? 0;
	const days = choice.days ?? 0;
	const price =
		product.type === "transactions"
			? (amount * product.rate) / RATE_PAYMENTS
			: product.type === "storage"
				? amount * product.rate
				: product.type === "employees"
					? (amount * days * product.rate) / RATE_DAYS
					: (days * product.rate) / RATE_DAYS;
	return Math.max(product.minimum, Math.round(price));
}

export function grantOf(product: LicenseProduct, choice: LicenseChoice): LicenseGrant {
	return {
		type: product.type,
		transactions: product.type === "transactions" ? choice.amount : null,
		duration_days: usesDays(product.type) ? choice.days : null,
		storage_gb: product.type === "storage" ? choice.amount : null,
		employees: product.type === "employees" ? choice.amount : null,
	};
}
