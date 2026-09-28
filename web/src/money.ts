import { endOfLocalDate, localDate, startOfLocalDate } from "../../server/timezone";

const formatterCache = new Map<string, Intl.NumberFormat>();

function formatter(currency: string): Intl.NumberFormat | null {
	const cached = formatterCache.get(currency);
	if (cached) return cached;

	try {
		const created = new Intl.NumberFormat(undefined, { style: "currency", currency });
		formatterCache.set(currency, created);
		return created;
	} catch {
		return null;
	}
}

export function minorUnitDigits(currency: string): number {
	const resolved = formatter(currency);
	if (!resolved) return 2;
	return resolved.resolvedOptions().maximumFractionDigits ?? 2;
}

export function formatMoney(minorUnits: number, currency: string): string {
	const resolved = formatter(currency);
	const digits = minorUnitDigits(currency);
	const major = minorUnits / Math.pow(10, digits);

	if (!resolved) return `${major.toFixed(digits)} ${currency}`;
	return resolved.format(major);
}

export function formatBytes(bytes: number): string {
	const units = [
		{ size: 1_000_000_000, label: "GB" },
		{ size: 1_000_000, label: "MB" },
		{ size: 1_000, label: "KB" },
	];
	const unit = units.find((candidate) => Math.abs(bytes) >= candidate.size) ?? { size: 1, label: "B" };
	return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(bytes / unit.size)} ${unit.label}`;
}

export function toMinorUnits(major: number, currency: string): number {
	return Math.round(major * Math.pow(10, minorUnitDigits(currency)));
}

export function toMajorUnits(minorUnits: number, currency: string): number {
	return minorUnits / Math.pow(10, minorUnitDigits(currency));
}

export { formatDate, formatDateTime, formatTime } from "../../server/formats";

export function toDateInput(timestamp: number, timezone?: string): string {
	if (timezone) return localDate(timestamp, timezone);
	const date = new Date(timestamp);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

export function dayStartFromDateInput(value: string, timezone?: string): number {
	if (timezone) return startOfLocalDate(value, timezone);
	return new Date(`${value}T00:00:00`).getTime();
}

export function fromDateInput(value: string, timezone?: string): number {
	if (timezone) return endOfLocalDate(value, timezone);
	const parsed = new Date(`${value}T23:59:59`);
	return parsed.getTime();
}
