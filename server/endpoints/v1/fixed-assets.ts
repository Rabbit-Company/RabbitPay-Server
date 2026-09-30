import type { Context } from "@rabbit-company/web";
import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { accountingActive } from "../../licensing";
import { closedYear } from "../../accounting-periods";
import { accumulatedAt, DEFAULT_RATES, firstDayOfNextMonth, isAssetCategory } from "../../accounting/assets";
import { expenseCost } from "../../accounting/sources";
import { syncLedger } from "../../accounting/journal";
import type { AppState, AssetCategory, ExpenseRow, FixedAssetRow, ProjectRow } from "../../database/models";

const base = "/api/v1/projects/:uuid/accounting/assets";

async function body(ctx: Context<AppState>): Promise<Record<string, unknown> | null> {
	try {
		const value = await ctx.body<Record<string, unknown>>();
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

function timestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
}

function present(project: ProjectRow, asset: FixedAssetRow) {
	const accumulated = accumulatedAt(asset, project.timezone, Date.now());
	return { ...asset, accumulated, book_value: asset.disposed_at !== null && asset.disposed_at <= Date.now() ? 0 : asset.acquisition_value - accumulated };
}

async function findAsset(project: string, uuid: string): Promise<FixedAssetRow | null> {
	const [row] = (await Database`SELECT * FROM fixed_assets WHERE project = ${project} AND uuid = ${uuid}`) as FixedAssetRow[];
	return row ?? null;
}

function categoryFor(expense: ExpenseRow): AssetCategory[] {
	if (expense.asset_type === "real_estate") return ["building"];
	if (expense.asset_type !== "fixed_asset") return [];
	return expense.category === "Software" ? ["intangible"] : ["equipment", "computer"];
}

function writable(ctx: Context<AppState>): Response | null {
	return accountingActive(Permissions.project(ctx)) ? null : Utils.fail(ctx, ErrorCode.ACCOUNTING_LICENSE_REQUIRED);
}

async function audit(ctx: Context<AppState>, action: string, uuid: string, value?: unknown, previous?: unknown) {
	await Audit.record(ctx, { project: Permissions.project(ctx).uuid, action, entityType: "fixed_asset", entityId: uuid, newValue: value, oldValue: previous });
}

Server.app.get(base, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const assets = (await Database`SELECT * FROM fixed_assets WHERE project = ${project.uuid} ORDER BY acquired_at DESC, name`) as FixedAssetRow[];
	const expenses = (await Database`
		SELECT e.* FROM expenses e WHERE e.project = ${project.uuid} AND e.asset_type IN ('fixed_asset', 'real_estate')
			AND NOT EXISTS (SELECT 1 FROM fixed_assets fa WHERE fa.expense = e.uuid)
		ORDER BY e.expense_date DESC
	`) as ExpenseRow[];
	const currency = project.tax_currency ?? project.currency;
	return Utils.ok(ctx, {
		assets: assets.map((asset) => present(project, asset)),
		candidates: expenses.map((expense) => ({
			expense: expense.uuid,
			name: expense.description,
			supplier: expense.supplier,
			acquired_at: expense.expense_date,
			value: expenseCost(expense, currency),
			categories: categoryFor(expense),
		})),
		default_rates: DEFAULT_RATES,
	});
});

Server.app.post(base, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	const refused = writable(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const data = await body(ctx);
	if (!data) return Utils.fail(ctx, ErrorCode.INVALID_FIXED_ASSET);
	let value = data.acquisition_value;
	let acquired = data.acquired_at;
	let expense: ExpenseRow | null = null;
	if (data.expense !== undefined && data.expense !== null) {
		if (typeof data.expense !== "string") return Utils.fail(ctx, ErrorCode.INVALID_FIXED_ASSET);
		[expense] = (await Database`SELECT * FROM expenses WHERE uuid = ${data.expense} AND project = ${project.uuid}`) as ExpenseRow[];
		if (!expense || !isAssetCategory(data.asset_category) || !categoryFor(expense).includes(data.asset_category))
			return Utils.fail(ctx, ErrorCode.INVALID_FIXED_ASSET);
		const [taken] = await Database`SELECT uuid FROM fixed_assets WHERE expense = ${expense.uuid}`;
		if (taken) return Utils.fail(ctx, ErrorCode.INVALID_FIXED_ASSET);
		value = expenseCost(expense, project.tax_currency ?? project.currency);
		acquired = acquired ?? expense.expense_date;
	}
	const name = typeof data.name === "string" ? data.name.trim() : (expense?.description ?? "");
	const category = data.asset_category;
	const accumulatedBefore = data.accumulated_before ?? 0;
	if (
		!name ||
		name.length > 250 ||
		!isAssetCategory(category) ||
		!timestamp(acquired) ||
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value <= 0 ||
		typeof accumulatedBefore !== "number" ||
		!Number.isSafeInteger(accumulatedBefore) ||
		accumulatedBefore < 0 ||
		accumulatedBefore > value
	)
		return Utils.fail(ctx, ErrorCode.INVALID_FIXED_ASSET);
	const rate = data.annual_rate ?? DEFAULT_RATES[category];
	const from = data.depreciation_from ?? firstDayOfNextMonth(acquired, project.timezone);
	if (
		typeof rate !== "number" ||
		!Number.isFinite(rate) ||
		rate <= 0 ||
		rate > 100 ||
		!timestamp(from) ||
		(typeof data.notes === "string" && data.notes.length > 2000)
	)
		return Utils.fail(ctx, ErrorCode.INVALID_FIXED_ASSET);
	if (await closedYear(project.uuid, from)) return Utils.fail(ctx, ErrorCode.YEAR_CLOSED);
	const uuid = crypto.randomUUID();
	const now = Date.now();
	await Database`
		INSERT INTO fixed_assets(uuid, project, name, asset_category, expense, acquired_at, depreciation_from, acquisition_value, accumulated_before, annual_rate,
			disposed_at, notes, created_by, created, updated)
		VALUES(${uuid}, ${project.uuid}, ${name}, ${category}, ${expense?.uuid ?? null}, ${acquired}, ${from}, ${value}, ${accumulatedBefore}, ${rate},
			NULL, ${typeof data.notes === "string" ? data.notes.trim() || null : null}, ${Auth.account(ctx).username}, ${now}, ${now})
	`;
	const created = (await findAsset(project.uuid, uuid))!;
	await audit(ctx, "fixed_asset.created", uuid, created);
	await syncLedger(project);
	return Utils.ok(ctx, present(project, created), 201);
});

Server.app.patch(`${base}/:asset`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	const refused = writable(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const asset = await findAsset(project.uuid, ctx.params.asset);
	if (!asset) return Utils.fail(ctx, ErrorCode.FIXED_ASSET_NOT_FOUND);
	const data = await body(ctx);
	if (!data) return Utils.fail(ctx, ErrorCode.INVALID_FIXED_ASSET);
	const name = data.name === undefined ? asset.name : typeof data.name === "string" ? data.name.trim() : "";
	const rate = data.annual_rate === undefined ? asset.annual_rate : data.annual_rate;
	const disposed = data.disposed_at === undefined ? asset.disposed_at : data.disposed_at;
	const notes = data.notes === undefined ? asset.notes : typeof data.notes === "string" ? data.notes.trim() || null : null;
	if (
		!name ||
		name.length > 250 ||
		typeof rate !== "number" ||
		rate <= 0 ||
		rate > 100 ||
		(disposed !== null && (!timestamp(disposed) || disposed < asset.acquired_at))
	)
		return Utils.fail(ctx, ErrorCode.INVALID_FIXED_ASSET);
	if (rate !== asset.annual_rate && (await closedYear(project.uuid, asset.depreciation_from))) return Utils.fail(ctx, ErrorCode.YEAR_CLOSED);
	if (disposed !== asset.disposed_at) {
		for (const moment of [asset.disposed_at, disposed]) {
			if (moment !== null && (await closedYear(project.uuid, moment))) return Utils.fail(ctx, ErrorCode.YEAR_CLOSED);
		}
	}
	await Database`
		UPDATE fixed_assets SET name = ${name}, annual_rate = ${rate}, disposed_at = ${disposed}, notes = ${notes}, updated = ${Date.now()} WHERE uuid = ${asset.uuid}
	`;
	const updated = (await findAsset(project.uuid, asset.uuid))!;
	await audit(ctx, "fixed_asset.updated", asset.uuid, updated, asset);
	await syncLedger(project);
	return Utils.ok(ctx, present(project, updated));
});

Server.app.delete(`${base}/:asset`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	const refused = writable(ctx);
	if (refused) return refused;
	const project = Permissions.project(ctx);
	const asset = await findAsset(project.uuid, ctx.params.asset);
	if (!asset) return Utils.fail(ctx, ErrorCode.FIXED_ASSET_NOT_FOUND);
	if (await closedYear(project.uuid, asset.depreciation_from)) return Utils.fail(ctx, ErrorCode.YEAR_CLOSED);
	await Database`DELETE FROM fixed_assets WHERE uuid = ${asset.uuid}`;
	await audit(ctx, "fixed_asset.deleted", asset.uuid, undefined, asset);
	await syncLedger(project);
	return Utils.ok(ctx);
});
