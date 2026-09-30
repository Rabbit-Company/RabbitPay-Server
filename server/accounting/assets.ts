import { zonedParts, startOfLocalDate } from "../timezone";
import type { AssetCategory, FixedAssetRow } from "../database/models";
import type { SystemAccount } from "./chart";

export const ASSET_CATEGORIES: AssetCategory[] = ["intangible", "building", "equipment", "computer", "small_inventory"];

export const DEFAULT_RATES: Record<AssetCategory, number> = {
	intangible: 20,
	building: 3,
	equipment: 20,
	computer: 50,
	small_inventory: 100,
};

export const CATEGORY_ACCOUNTS: Record<AssetCategory, { asset: SystemAccount; accumulated: SystemAccount; expense: SystemAccount }> = {
	intangible: { asset: "intangible", accumulated: "accumulated_intangible", expense: "depreciation_intangible" },
	building: { asset: "real_estate", accumulated: "accumulated_buildings", expense: "depreciation_buildings" },
	equipment: { asset: "equipment", accumulated: "accumulated_equipment", expense: "depreciation_equipment" },
	computer: { asset: "equipment", accumulated: "accumulated_equipment", expense: "depreciation_equipment" },
	small_inventory: { asset: "small_inventory", accumulated: "accumulated_small", expense: "depreciation_small" },
};

export function isAssetCategory(value: unknown): value is AssetCategory {
	return typeof value === "string" && ASSET_CATEGORIES.includes(value as AssetCategory);
}

export function monthIndex(timestamp: number, timezone: string): number {
	const parts = zonedParts(timestamp, timezone);
	return parts.year * 12 + parts.month - 1;
}

export function monthStart(index: number, timezone: string): number {
	const year = Math.floor(index / 12);
	const month = (index % 12) + 1;
	return startOfLocalDate(`${year}-${String(month).padStart(2, "0")}-01`, timezone);
}

export function lastDayOfMonth(index: number, timezone: string): number {
	const year = Math.floor(index / 12);
	const month = (index % 12) + 1;
	const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return startOfLocalDate(`${year}-${String(month).padStart(2, "0")}-${String(days).padStart(2, "0")}`, timezone);
}

export function firstDayOfNextMonth(timestamp: number, timezone: string): number {
	return monthStart(monthIndex(timestamp, timezone) + 1, timezone);
}

function cumulative(asset: Pick<FixedAssetRow, "acquisition_value" | "accumulated_before" | "annual_rate">, months: number): number {
	const depreciable = asset.acquisition_value - asset.accumulated_before;
	return Math.min(depreciable, Math.round((asset.acquisition_value * asset.annual_rate * months) / 1200));
}

export interface DepreciationMonth {
	month: number;
	amount: number;
}

export function depreciationSchedule(asset: FixedAssetRow, timezone: string, now: number): DepreciationMonth[] {
	const start = monthIndex(asset.depreciation_from, timezone);
	const stop = Math.min(monthIndex(now, timezone), asset.disposed_at === null ? Number.MAX_SAFE_INTEGER : monthIndex(asset.disposed_at, timezone));
	const schedule: DepreciationMonth[] = [];
	for (let month = start; month < stop; month++) {
		const amount = cumulative(asset, month - start + 1) - cumulative(asset, month - start);
		if (amount <= 0) break;
		schedule.push({ month, amount });
	}
	return schedule;
}

export function accumulatedAt(asset: FixedAssetRow, timezone: string, now: number): number {
	return asset.accumulated_before + depreciationSchedule(asset, timezone, now).reduce((sum, month) => sum + month.amount, 0);
}
