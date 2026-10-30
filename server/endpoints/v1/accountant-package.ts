import type { Context } from "@rabbit-company/web";
import { rateLimit } from "@rabbit-company/web-middleware/rate-limit";
import { Server } from "../../server";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { downloadResponse, pdfResponse } from "../../invoice-pdf";
import {
	accountantPackageArchive,
	accountantPackageOverview,
	collectAccountantPackage,
	packagePeriod,
	packageSummary,
	PackageTooLarge,
	PACKAGE_DOCUMENT_LIMIT,
} from "../../accountant-package";
import {
	NeverSent,
	NoRecipients,
	NothingChanged,
	packageByToken,
	packageSettings,
	packageStatus,
	savePackageSettings,
	sendAccountantPackage,
	validPackageSettings,
} from "../../accountant-package-sending";
import type { AppState } from "../../database/models";

const base = "/api/v1/projects/:uuid/accountant-package";
const downloadLimit = rateLimit({ windowMs: 60 * 1000, max: 10, message: "Too many downloads. Please slow down." });
const guards = [Auth.required(), Permissions.require(Permission.REPORT_EXPORT), Permissions.require(Permission.EXPENSE_VIEW)] as const;

function period(ctx: Context<AppState>) {
	return packagePeriod(ctx.query());
}

Server.app.get(base, ...guards, async (ctx) => {
	const range = period(ctx);
	if (!range) return Utils.fail(ctx, ErrorCode.INVALID_PACKAGE_PERIOD);
	const data = await collectAccountantPackage(Permissions.project(ctx), range);
	return Utils.ok(ctx, { ...packageSummary(data), limit: PACKAGE_DOCUMENT_LIMIT });
});

Server.app.get(`${base}/overview`, downloadLimit, ...guards, async (ctx) => {
	const range = period(ctx);
	if (!range) return Utils.fail(ctx, ErrorCode.INVALID_PACKAGE_PERIOD);
	return pdfResponse(await accountantPackageOverview(Permissions.project(ctx), range));
});

Server.app.get(`${base}/zip`, downloadLimit, ...guards, async (ctx) => {
	const range = period(ctx);
	if (!range) return Utils.fail(ctx, ErrorCode.INVALID_PACKAGE_PERIOD);
	const project = Permissions.project(ctx);
	try {
		const archive = await accountantPackageArchive(project, range);
		const summary = packageSummary(archive.data_summary);
		await Audit.record(ctx, {
			project: project.uuid,
			action: "accountant_package.exported",
			entityType: "project",
			entityId: project.uuid,
			newValue: {
				...range,
				issued: summary.issued.count,
				credit_notes: summary.credit_notes.count,
				received: summary.received_domestic.count + summary.received_foreign.count + summary.received_on_spot.count,
			},
		});
		return downloadResponse(archive, "application/zip");
	} catch (error) {
		if (error instanceof PackageTooLarge) return Utils.fail(ctx, ErrorCode.PACKAGE_TOO_LARGE);
		throw error;
	}
});

const sendLimit = rateLimit({ windowMs: 60 * 1000, max: 5, message: "Too many packages sent. Please slow down." });
const tokenLimit = rateLimit({ windowMs: 60 * 1000, max: 20, message: "Too many downloads. Please slow down." });

async function body(ctx: Context<AppState>): Promise<Record<string, unknown> | null> {
	try {
		const value = await ctx.body<Record<string, unknown>>();
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

Server.app.get(`${base}/settings`, ...guards, async (ctx) => {
	return Utils.ok(ctx, await packageSettings(Permissions.project(ctx)));
});

Server.app.put(`${base}/settings`, ...guards, async (ctx) => {
	const data = await body(ctx);
	if (!validPackageSettings(data)) return Utils.fail(ctx, ErrorCode.INVALID_PACKAGE_SETTINGS);
	const project = Permissions.project(ctx);
	const previous = await packageSettings(project);
	const saved = await savePackageSettings(project, data, Auth.account(ctx).username);
	await Audit.record(ctx, {
		project: project.uuid,
		action: "accountant_package.settings_updated",
		entityType: "project",
		entityId: project.uuid,
		newValue: saved,
		oldValue: previous,
	});
	return Utils.ok(ctx, saved);
});

Server.app.get(`${base}/status`, ...guards, async (ctx) => {
	const range = period(ctx);
	if (!range) return Utils.fail(ctx, ErrorCode.INVALID_PACKAGE_PERIOD);
	return Utils.ok(ctx, await packageStatus(Permissions.project(ctx), range));
});

Server.app.post(`${base}/send`, sendLimit, ...guards, async (ctx) => {
	const data = await body(ctx);
	const range = data ? packagePeriod(new URLSearchParams({ from: String(data.from ?? ""), to: String(data.to ?? "") })) : null;
	if (!data || !range || (data.kind !== "full" && data.kind !== "changes")) return Utils.fail(ctx, ErrorCode.INVALID_PACKAGE_PERIOD);
	const project = Permissions.project(ctx);
	try {
		const sent = await sendAccountantPackage(project, range, { kind: data.kind, author: Auth.account(ctx).username, automatic: false });
		await Audit.record(ctx, {
			project: project.uuid,
			action: "accountant_package.sent",
			entityType: "project",
			entityId: project.uuid,
			newValue: { ...range, kind: sent.kind, recipients: sent.recipients, changes: sent.changes },
		});
		return Utils.ok(ctx, sent, 201);
	} catch (error) {
		if (error instanceof NoRecipients) return Utils.fail(ctx, ErrorCode.PACKAGE_NO_RECIPIENTS);
		if (error instanceof NeverSent || error instanceof NothingChanged) return Utils.fail(ctx, ErrorCode.PACKAGE_NOTHING_CHANGED);
		if (error instanceof PackageTooLarge) return Utils.fail(ctx, ErrorCode.PACKAGE_TOO_LARGE);
		throw error;
	}
});

Server.app.get("/api/v1/accountant-package/:token", tokenLimit, async (ctx) => {
	const archive = await packageByToken(ctx.params.token);
	if (!archive) return Utils.fail(ctx, ErrorCode.PACKAGE_LINK_EXPIRED);
	return downloadResponse(archive, "application/zip");
});
