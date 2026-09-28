import Database from "../database/database";
import Validate from "../validate";
import type { StoreCouponKind, StoreCouponRow } from "../database/models";

export const COUPON_KINDS: StoreCouponKind[] = ["percent", "amount", "free_shipping"];

export type CouponIssue = "unknown" | "disabled" | "not_started" | "expired" | "used_up" | "minimum" | "not_applicable";

export interface CouponInput {
	code: string;
	kind: StoreCouponKind;
	amount: number;
	minimum: number | null;
	starts_at: number | null;
	ends_at: number | null;
	max_uses: number | null;
	once_per_customer: boolean;
	enabled: boolean;
	note: string | null;
}

export function normalizeCode(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const code = value.trim().toUpperCase();
	return /^[A-Z0-9_-]{3,32}$/.test(code) ? code : null;
}

function optionalWhole(value: unknown, min: number, max: number): number | null | undefined {
	if (value === null) return null;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

export function readCoupon(data: Record<string, unknown>, existing: StoreCouponRow | null): CouponInput | null {
	const code = data.code === undefined && existing ? existing.code : normalizeCode(data.code);
	const kind = data.kind ?? existing?.kind;
	const rawAmount = data.amount ?? existing?.amount ?? 0;
	const minimum = data.minimum === undefined ? (existing?.minimum ?? null) : optionalWhole(data.minimum, 1, 1_000_000_000_000);
	const startsAt = data.starts_at === undefined ? (existing?.starts_at ?? null) : optionalWhole(data.starts_at, 0, Number.MAX_SAFE_INTEGER);
	const endsAt = data.ends_at === undefined ? (existing?.ends_at ?? null) : optionalWhole(data.ends_at, 0, Number.MAX_SAFE_INTEGER);
	const maxUses = data.max_uses === undefined ? (existing?.max_uses ?? null) : optionalWhole(data.max_uses, 1, 1_000_000_000);
	const once = data.once_per_customer ?? (existing ? Boolean(existing.once_per_customer) : false);
	const enabled = data.enabled ?? (existing ? Boolean(existing.enabled) : true);
	const note = data.note === undefined ? (existing?.note ?? null) : data.note;

	if (!code || !COUPON_KINDS.includes(kind as StoreCouponKind)) return null;
	if (minimum === undefined || startsAt === undefined || endsAt === undefined || maxUses === undefined) return null;
	if (startsAt !== null && endsAt !== null && endsAt <= startsAt) return null;
	if (typeof once !== "boolean" || typeof enabled !== "boolean" || !Validate.optionalText(note, 500)) return null;

	let amount = 0;
	if (kind === "percent") {
		if (typeof rawAmount !== "number" || !Number.isSafeInteger(rawAmount) || rawAmount < 1 || rawAmount > 100) return null;
		amount = rawAmount;
	} else if (kind === "amount") {
		if (typeof rawAmount !== "number" || !Number.isSafeInteger(rawAmount) || rawAmount < 1 || rawAmount > 1_000_000_000_000) return null;
		amount = rawAmount;
	}

	return {
		code,
		kind: kind as StoreCouponKind,
		amount,
		minimum,
		starts_at: startsAt,
		ends_at: endsAt,
		max_uses: maxUses,
		once_per_customer: once,
		enabled,
		note: typeof note === "string" && note.trim() !== "" ? note.trim() : null,
	};
}

export function presentCoupon(row: StoreCouponRow, redeemed = 0) {
	return {
		uuid: row.uuid,
		code: row.code,
		kind: row.kind,
		amount: row.amount,
		minimum: row.minimum,
		starts_at: row.starts_at,
		ends_at: row.ends_at,
		max_uses: row.max_uses,
		once_per_customer: Boolean(row.once_per_customer),
		enabled: Boolean(row.enabled),
		uses: row.uses,
		discount_total: redeemed,
		note: row.note,
		created: row.created,
		updated: row.updated,
	};
}

export async function couponByCode(projectId: string, value: unknown): Promise<StoreCouponRow | null> {
	const code = normalizeCode(value);
	if (!code) return null;
	const [row] = (await Database`SELECT * FROM store_coupons WHERE project = ${projectId} AND code = ${code}`) as StoreCouponRow[];
	return row ?? null;
}

export function couponIssue(coupon: StoreCouponRow, itemsTotal: number, now: number): CouponIssue | null {
	if (!coupon.enabled) return "disabled";
	if (coupon.starts_at !== null && now < coupon.starts_at) return "not_started";
	if (coupon.ends_at !== null && now >= coupon.ends_at) return "expired";
	if (coupon.max_uses !== null && coupon.uses >= coupon.max_uses) return "used_up";
	if (coupon.minimum !== null && itemsTotal < coupon.minimum) return "minimum";
	return null;
}

export function grossDiscountOf(coupon: StoreCouponRow, itemsTotal: number): number {
	if (coupon.kind === "percent") return Math.round((itemsTotal * coupon.amount) / 100);
	if (coupon.kind === "amount") return Math.min(coupon.amount, itemsTotal);
	return 0;
}

export async function usedBy(coupon: StoreCouponRow, email: string): Promise<boolean> {
	const [row] = await Database`SELECT invoice FROM store_coupon_redemptions WHERE coupon = ${coupon.uuid} AND email = ${email}`;
	return Boolean(row);
}

export async function claimCoupon(coupon: StoreCouponRow): Promise<boolean> {
	const claimed = await Database`
		UPDATE store_coupons SET uses = uses + 1
		WHERE uuid = ${coupon.uuid} AND enabled = 1 AND (max_uses IS NULL OR uses < max_uses)
	`;
	return claimed.count > 0;
}

export async function unclaimCoupon(couponId: string) {
	await Database`UPDATE store_coupons SET uses = uses - 1 WHERE uuid = ${couponId} AND uses > 0`;
}

export async function recordRedemption(coupon: StoreCouponRow, invoice: string, email: string, discount: number) {
	await Database`
		INSERT INTO store_coupon_redemptions(invoice, coupon, project, email, discount, created)
		VALUES(${invoice}, ${coupon.uuid}, ${coupon.project}, ${email}, ${discount}, ${Date.now()})
	`;
}

export async function releaseRedemption(invoice: string) {
	const [redemption] = (await Database`SELECT coupon FROM store_coupon_redemptions WHERE invoice = ${invoice}`) as { coupon: string }[];
	if (!redemption) return;
	const removed = await Database`DELETE FROM store_coupon_redemptions WHERE invoice = ${invoice}`;
	if (removed.count > 0) await unclaimCoupon(redemption.coupon);
}
