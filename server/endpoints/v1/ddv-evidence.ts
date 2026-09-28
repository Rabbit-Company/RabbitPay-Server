import { createHash } from "node:crypto";
import type { Context } from "@rabbit-company/web";
import { Server } from "../../server";
import Auth from "../../auth";
import Audit from "../../audit";
import Database from "../../database/database";
import { documentStorage } from "../../document-storage";
import Errors, { ErrorCode } from "../../errors";
import Permissions from "../../permissions";
import { Permission } from "../../roles";
import Utils from "../../utils";
import { buildDdvEvidence, ddvExportView, validDdvExportOptions, zipFile, type DdvExportOptions } from "../../ddv-evidence";
import { hasStorageCapacity } from "../../licensing";
import type { AccountingPeriodLockRow, AppState, DdvExportRow } from "../../database/models";
import { createAccountingPeriodLock, presentAccountingPeriodLock } from "../../accounting-periods";
import { previousLocalMonth } from "../../timezone";

const base = "/api/v1/projects/:uuid/reports/ddv-evidence";

function optionsFromQuery(ctx: Context<AppState>, timezone: string): DdvExportOptions | null {
	const query = ctx.query();
	const fallback = previousLocalMonth(Date.now(), timezone);
	const value = {
		from: Number(query.get("from") ?? fallback.from),
		to: Number(query.get("to") ?? fallback.to),
		refund: query.get("refund") === "true",
		deductible_share: query.get("deductible_share") === "true",
		late_submission: query.get("late_submission") || null,
		insolvency: query.get("insolvency") === "true",
		tax_authority_order: query.get("tax_authority_order") === "true",
		note: query.get("note") || null,
	};
	return validDdvExportOptions(value, timezone) ? value : null;
}

async function optionsFromBody(ctx: Context<AppState>, timezone: string): Promise<DdvExportOptions | null> {
	try {
		const value = await ctx.body<unknown>();
		return validDdvExportOptions(value, timezone) ? value : null;
	} catch {
		return null;
	}
}

Server.app.get(base, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const options = optionsFromQuery(ctx, project.timezone);
	if (!options) return Utils.fail(ctx, ErrorCode.INVALID_DDV_PERIOD);
	return Utils.ok(ctx, await buildDdvEvidence(project, options));
});

Server.app.post(`${base}/exports`, Auth.required(), Permissions.require(Permission.REPORT_EXPORT), async (ctx) => {
	const project = Permissions.project(ctx);
	const options = await optionsFromBody(ctx, project.timezone);
	if (!options) return Utils.fail(ctx, ErrorCode.INVALID_DDV_PERIOD);
	const result = await buildDdvEvidence(project, options);
	if (result.errors.length > 0) {
		return ctx.json({ ...Errors.getJson(ErrorCode.DDV_EVIDENCE_INVALID), data: result }, Errors.get(ErrorCode.DDV_EVIDENCE_INVALID).httpCode);
	}
	const [latest] = (await Database`
		SELECT MAX(revision) AS revision FROM ddv_exports WHERE project = ${project.uuid} AND period_from = ${options.from} AND period_to = ${options.to}
	`) as { revision: number | null }[];
	const revision = Number(latest?.revision ?? 0) + 1;
	const uuid = crypto.randomUUID();
	const taxNumber = String(result.evidence.DDV_KIR_KPR.Glava.TaxPayerID);
	const range = `${String(result.evidence.DDV_KIR_KPR.Glava.OBDOBJE_OD).replace(/-/g, "")}_${String(result.evidence.DDV_KIR_KPR.Glava.OBDOBJE_DO).replace(/-/g, "")}`;
	const jsonName = `DDV_KIR_KPR_${taxNumber}_${range}_r${revision}.json`;
	const fileName = `DDV_KIR_KPR_${taxNumber}_${range}_r${revision}.zip`;
	const bytes = zipFile(jsonName, new TextEncoder().encode(`${JSON.stringify(result.evidence, null, 2)}\n`));
	if (!(await hasStorageCapacity(project.uuid, bytes.length))) return Utils.fail(ctx, ErrorCode.STORAGE_LIMIT_REACHED);
	const storageKey = `ddv/${project.uuid}/${options.from}-${options.to}/${uuid}.zip`;
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const created = Date.now();
	await documentStorage().put(storageKey, bytes, "application/zip");
	let lock;
	try {
		lock = await Database.begin(async (tx) => {
			await tx`INSERT INTO ddv_exports(uuid, project, period_from, period_to, revision, file_name, storage_key, byte_size, sha256, created_by, created)
				VALUES(${uuid}, ${project.uuid}, ${options.from}, ${options.to}, ${revision}, ${fileName}, ${storageKey}, ${bytes.length}, ${sha256}, ${Auth.account(ctx).username}, ${created})`;
			return await createAccountingPeriodLock(tx, {
				project: project.uuid,
				from: options.from,
				to: options.to,
				timezone: project.timezone,
				sourceId: uuid,
				account: Auth.account(ctx).username,
				timestamp: created,
			});
		});
	} catch (error) {
		await documentStorage().remove(storageKey);
		throw error;
	}
	const [row] = (await Database`SELECT * FROM ddv_exports WHERE uuid = ${uuid}`) as DdvExportRow[];
	await Audit.record(ctx, {
		project: project.uuid,
		action: revision === 1 ? "ddv_export.created" : "ddv_export.corrected",
		entityType: "ddv_export",
		entityId: uuid,
		newValue: ddvExportView(row),
	});
	if (lock.source_id === uuid) {
		await Audit.record(ctx, {
			project: project.uuid,
			action: "accounting_period.locked",
			entityType: "accounting_period_lock",
			entityId: lock.uuid,
			newValue: presentAccountingPeriodLock(lock),
		});
	}
	return Utils.ok(ctx, { export: ddvExportView(row), lock: presentAccountingPeriodLock(lock), validation: result }, 201);
});

Server.app.get(`${base}/exports`, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const rows =
		(await Database`SELECT * FROM ddv_exports WHERE project = ${Permissions.project(ctx).uuid} ORDER BY period_from DESC, revision DESC`) as DdvExportRow[];
	return Utils.ok(ctx, rows.map(ddvExportView));
});

Server.app.get(`${base}/exports/:export`, Auth.required(), Permissions.require(Permission.REPORT_EXPORT), async (ctx) => {
	const [row] = (await Database`SELECT * FROM ddv_exports WHERE uuid = ${ctx.params.export} AND project = ${Permissions.project(ctx).uuid}`) as DdvExportRow[];
	if (!row) return Utils.fail(ctx, ErrorCode.DDV_EXPORT_NOT_FOUND);
	const bytes = await documentStorage().get(row.storage_key);
	return new Response(bytes, {
		headers: {
			"Content-Type": "application/zip",
			"Content-Length": String(bytes.length),
			"Content-Disposition": `attachment; filename="${row.file_name}"`,
			"X-Content-Type-Options": "nosniff",
		},
	});
});

Server.app.get(`${base}/locks`, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const rows = (await Database`
		SELECT * FROM accounting_period_locks WHERE project = ${Permissions.project(ctx).uuid}
		ORDER BY period_from DESC, locked_at DESC
	`) as AccountingPeriodLockRow[];
	return Utils.ok(ctx, rows.map(presentAccountingPeriodLock));
});

Server.app.post(`${base}/locks/:lock/unlock`, Auth.required(), Permissions.require(Permission.REPORT_EXPORT), async (ctx) => {
	const project = Permissions.project(ctx);
	let body: { reason?: unknown };
	try {
		body = await ctx.body<{ reason?: unknown }>();
	} catch {
		return Utils.fail(ctx, ErrorCode.INVALID_UNLOCK_REASON);
	}
	const reason = typeof body.reason === "string" ? body.reason.trim() : "";
	if (reason.length < 3 || reason.length > 500) return Utils.fail(ctx, ErrorCode.INVALID_UNLOCK_REASON);
	const [row] = (await Database`
		SELECT * FROM accounting_period_locks WHERE uuid = ${ctx.params.lock} AND project = ${project.uuid} AND unlocked_at IS NULL
	`) as AccountingPeriodLockRow[];
	if (!row) return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCK_NOT_FOUND);
	const timestamp = Date.now();
	const account = Auth.account(ctx).username;
	const changed = await Database`
		UPDATE accounting_period_locks SET unlocked_by = ${account}, unlocked_at = ${timestamp}, unlock_reason = ${reason}
		WHERE uuid = ${row.uuid} AND unlocked_at IS NULL
	`;
	if (changed.count === 0) return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCK_NOT_FOUND);
	const [updated] = (await Database`SELECT * FROM accounting_period_locks WHERE uuid = ${row.uuid}`) as AccountingPeriodLockRow[];
	await Audit.record(ctx, {
		project: project.uuid,
		action: "accounting_period.unlocked",
		entityType: "accounting_period_lock",
		entityId: row.uuid,
		oldValue: presentAccountingPeriodLock(row),
		newValue: presentAccountingPeriodLock(updated),
	});
	return Utils.ok(ctx, presentAccountingPeriodLock(updated));
});
