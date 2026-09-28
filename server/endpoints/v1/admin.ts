import type { Context } from "@rabbit-company/web";
import { Server } from "../../server";
import Database from "../../database/database";
import { safeInteger } from "../../database/numbers";
import Auth from "../../auth";
import Admin from "../../admin";
import Audit from "../../audit";
import Utils from "../../utils";
import Validate from "../../validate";
import Vault from "../../crypto/vault";
import TwoFactor from "../../two-factor";
import { deleteAccount, deletionPlan, exportAccount, exportResponse } from "../../account-data";
import { isLicenseIssuer } from "../../license-signing";
import { normalizeServerId, serverId } from "../../server-identity";
import Errors, { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { presentSettings, updateSettings } from "../../settings";
import { settingField } from "../../settings-schema";
import { refreshClients } from "../../settings-clients";
import { Settings } from "../../settings";
import { BackupInProgress, backupNow, backupRunning, backupsSupported, latestBackups, type BackupResult } from "../../backups";
import {
	MAX_LICENSE_BATCH,
	MAX_LICENSE_DAYS,
	MAX_LICENSE_STORAGE_GB,
	MAX_LICENSE_TRANSACTIONS,
	createLicenses,
	freeAllowance,
	isLicenseType,
	meterAll,
	periodOf,
	presentLicense,
	redeemLicense,
	storageFor,
	usageFor,
	storeActive,
	TIMED_LICENSE_TYPES,
	workforceActive,
	whiteLabelActive,
	type NewLicense,
} from "../../licensing";
import { MAX_INVITE_USES, createInvite, presentInvite } from "../../registration";
import type { AccountRow, LicenseKeyRow, LicenseStatus, ProjectRow, RegistrationInviteRow } from "../../database/models";

const guard = [Auth.required(), Admin.required()] as const;

const LICENSE_STATUSES: LicenseStatus[] = ["available", "redeemed", "revoked"];
const ACCOUNT_STATUSES = ["active", "suspended"];

interface CreateLicenseBody {
	type?: unknown;
	server_id?: unknown;
	transactions?: unknown;
	duration_days?: unknown;
	storage_gb?: unknown;
	quantity?: unknown;
	price?: unknown;
	currency?: unknown;
	buyer_name?: unknown;
	buyer_email?: unknown;
	note?: unknown;
}

interface PurchaseDetails {
	price: number | null;
	currency: string | null;
	buyer_name: string | null;
	buyer_email: string | null;
	note: string | null;
}

function paging(query: URLSearchParams) {
	return {
		limit: Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200),
		offset: Math.max(Number(query.get("offset")) || 0, 0),
		search: query.get("search")?.trim().toLowerCase() || null,
	};
}

function isWholeNumber(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function optionalString(value: unknown, maxLength: number): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "string" || value.length > maxLength) return undefined;
	return value.trim() || null;
}

function readPurchase(data: CreateLicenseBody, current: PurchaseDetails | null): PurchaseDetails | null {
	const price = data.price === undefined ? (current?.price ?? null) : data.price;
	if (price !== null && !isWholeNumber(price, 0, Number.MAX_SAFE_INTEGER)) return null;

	const given = typeof data.currency === "string" ? data.currency.toUpperCase() : data.currency;
	const currency = given === undefined ? (current?.currency ?? null) : given;
	if (currency !== null && (typeof currency !== "string" || !Validate.currency(currency))) return null;
	if (price !== null && currency === null) return null;

	let buyerEmail: unknown = current?.buyer_email ?? null;
	if (data.buyer_email !== undefined) buyerEmail = data.buyer_email === "" ? null : data.buyer_email;
	if (buyerEmail !== null && (typeof buyerEmail !== "string" || !Validate.email(buyerEmail))) return null;

	const buyerName = optionalString(data.buyer_name, 120);
	const note = optionalString(data.note, 500);
	if (buyerName === undefined && data.buyer_name !== undefined) return null;
	if (note === undefined && data.note !== undefined) return null;

	return {
		price,
		currency,
		buyer_name: buyerName === undefined ? (current?.buyer_name ?? null) : buyerName,
		buyer_email: buyerEmail,
		note: note === undefined ? (current?.note ?? null) : note,
	};
}

async function findLicense(uuid: string | undefined): Promise<LicenseKeyRow | null> {
	if (!Validate.uuid(uuid)) return null;
	const [license] = (await Database`SELECT * FROM license_keys WHERE uuid = ${uuid!}`) as LicenseKeyRow[];
	return license ?? null;
}

async function findProject(uuid: string | undefined): Promise<ProjectRow | null> {
	if (!Validate.uuid(uuid)) return null;
	const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${uuid!} AND status != 'deleted'`) as ProjectRow[];
	return project ?? null;
}

async function presentProject(project: ProjectRow) {
	const usage = await usageFor(project.uuid);
	return {
		uuid: project.uuid,
		name: project.name,
		display_name: project.display_name,
		status: project.status,
		created: project.created,
		created_by: project.created_by,
		free_transactions: project.free_transactions,
		free_allowance: usage.free_allowance,
		free_used: usage.free_used,
		paid_used: usage.paid_used,
		paid_balance: usage.paid_balance,
		remaining: usage.remaining,
		white_label: usage.white_label,
		white_label_until: project.white_label_until,
		store: usage.store,
		store_until: project.store_until,
		workforce: usage.workforce,
		workforce_until: project.workforce_until,
		storage_included: usage.storage_included,
		storage_licensed: usage.storage_licensed,
		storage_used: usage.storage_used,
		storage_limit: usage.storage_limit,
		storage_remaining: usage.storage_remaining,
	};
}

function presentAccount(account: AccountRow & { projects?: number }) {
	return {
		username: account.username,
		email: account.email,
		status: account.status,
		admin: Number(account.admin) === 1,
		two_factor_enabled: account.two_factor_secret !== null,
		projects: Number(account.projects ?? 0),
		created: account.created,
		accessed: account.accessed,
	};
}

Server.app.get("/api/v1/admin/overview", ...guard, async (ctx) => {
	await meterAll();
	const period = periodOf(Date.now());

	const [counts] = (await Database`
		SELECT
			(SELECT COUNT(*) FROM accounts) AS accounts,
			(SELECT COUNT(*) FROM projects WHERE status != 'deleted') AS projects,
			(SELECT COUNT(*) FROM license_keys WHERE status = 'available') AS licenses_available,
			(SELECT COUNT(*) FROM license_keys WHERE status = 'redeemed') AS licenses_redeemed,
			(SELECT COALESCE(SUM(free_used + paid_used), 0) FROM project_usage WHERE period = ${period}) AS payments_this_month,
			(SELECT COUNT(*) FROM projects WHERE status != 'deleted' AND white_label_until > ${Date.now()}) AS white_labeled,
			(SELECT COUNT(*) FROM store_settings s JOIN projects p ON p.uuid = s.project WHERE p.status != 'deleted' AND s.enabled = 1) AS stores
	`) as Record<string, number>[];

	const revenue = (await Database`
		SELECT currency, SUM(price) AS amount, COUNT(*) AS count FROM license_keys
		WHERE status != 'revoked' AND price IS NOT NULL AND currency IS NOT NULL
		GROUP BY currency ORDER BY currency
	`) as { currency: string; amount: number; count: number }[];

	return Utils.ok(ctx, {
		period,
		accounts: Number(counts.accounts),
		projects: Number(counts.projects),
		licenses_available: Number(counts.licenses_available),
		licenses_redeemed: Number(counts.licenses_redeemed),
		payments_this_month: safeInteger(counts.payments_this_month),
		white_labeled: Number(counts.white_labeled),
		stores: Number(counts.stores),
		...(await licenseIdentity()),
		revenue: revenue.map((row) => ({ currency: row.currency, amount: safeInteger(row.amount), count: safeInteger(row.count) })),
	});
});

async function licenseIdentity() {
	return { license_issuer: isLicenseIssuer(), server_id: await serverId() };
}

Server.app.get("/api/v1/admin/settings", ...guard, async (ctx) => {
	return Utils.ok(ctx, { ...presentSettings(), master_key_configured: Vault.isConfigured(), ...(await licenseIdentity()) });
});

Server.app.patch("/api/v1/admin/settings", ...guard, async (ctx) => {
	let data: { values?: Record<string, unknown> };
	try {
		data = await ctx.body<{ values?: Record<string, unknown> }>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const values = data.values;
	if (values === null || typeof values !== "object" || Array.isArray(values)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (!isLicenseIssuer() && Object.keys(values).some((key) => key.startsWith("licensing."))) return Utils.fail(ctx, ErrorCode.LICENSE_ISSUER_ONLY);

	const before = presentSettings().values;
	const problem = await updateSettings(values);
	if (problem) {
		const label = settingField(problem.key)?.label ?? problem.key;
		if (problem.reason === "master_key") return Utils.fail(ctx, ErrorCode.MASTER_KEY_NOT_CONFIGURED);
		return Utils.failWithReason(
			ctx,
			ErrorCode.INVALID_SETTING,
			problem.reason === "unknown" ? `Unknown setting ${problem.key}.` : `${label} has an invalid value.`
		);
	}
	refreshClients();

	const after = presentSettings();
	const changed = Object.keys(values).filter((key) =>
		settingField(key)?.kind === "secret" ? values[key] !== undefined && values[key] !== "" : before[key] !== after.values[key]
	);
	const restart = changed.filter((key) => settingField(key)?.restart);

	await Audit.record(ctx, { action: "settings.updated", entityType: "settings", newValue: { changed } });
	Logger.audit(`[ADMIN] ${Auth.account(ctx).username} changed settings: ${changed.join(", ") || "nothing"}`);

	return Utils.ok(ctx, { ...after, master_key_configured: Vault.isConfigured(), ...(await licenseIdentity()), changed, restart_required: restart });
});

Server.app.get("/api/v1/admin/backups", ...guard, async (ctx) => {
	const supported = backupsSupported();
	let destinations: Awaited<ReturnType<typeof latestBackups>> = [];
	let problem: string | null = null;
	if (supported) {
		try {
			destinations = await latestBackups();
		} catch (error) {
			problem = error instanceof Error ? error.message : String(error);
		}
	}
	return Utils.ok(ctx, { supported, enabled: Settings.backups.enabled, running: backupRunning(), destinations, problem });
});

Server.app.post("/api/v1/admin/backups", ...guard, async (ctx) => {
	if (!backupsSupported()) return Utils.fail(ctx, ErrorCode.BACKUPS_UNSUPPORTED);

	let result: BackupResult;
	try {
		result = await backupNow();
	} catch (error) {
		if (error instanceof BackupInProgress) return Utils.fail(ctx, ErrorCode.BACKUP_IN_PROGRESS);
		Logger.error(`[BACKUP] Manual backup failed: ${error}`);
		return Utils.failWithReason(ctx, ErrorCode.BACKUP_FAILED, error instanceof Error ? error.message : String(error));
	}

	await Audit.record(ctx, { action: "backup.created", entityType: "settings", newValue: { name: result.name, stored: result.stored } });
	Logger.audit(`[ADMIN] ${Auth.account(ctx).username} ran a backup: ${result.name}`);

	if (result.stored.length === 0) {
		return Utils.failWithReason(ctx, ErrorCode.BACKUP_FAILED, result.failed.map((failure) => `${failure.target}: ${failure.error}`).join("; "), result);
	}
	return Utils.ok(ctx, result);
});

Server.app.get("/api/v1/admin/licenses", ...guard, async (ctx) => {
	const query = ctx.query();
	const { limit, offset, search } = paging(query);
	const status = query.get("status");
	const type = query.get("type");

	const statusFilter = status !== null && LICENSE_STATUSES.includes(status as LicenseStatus) ? status : null;
	const typeFilter = isLicenseType(type) ? type : null;
	const pattern = search === null ? null : `%${search}%`;
	const byStatus = statusFilter === null ? Database`` : Database`AND l.status = ${statusFilter}`;
	const byType = typeFilter === null ? Database`` : Database`AND l.type = ${typeFilter}`;
	const bySearch =
		pattern === null
			? Database``
			: Database`AND (LOWER(l.code) LIKE ${pattern} OR LOWER(COALESCE(l.buyer_name, '')) LIKE ${pattern}
				OR LOWER(COALESCE(l.buyer_email, '')) LIKE ${pattern} OR LOWER(COALESCE(l.note, '')) LIKE ${pattern})`;

	const rows = (await Database`
		SELECT l.*, p.name AS project_name FROM license_keys l
		LEFT JOIN projects p ON p.uuid = l.redeemed_project
		WHERE 1 = 1 ${byStatus} ${byType} ${bySearch}
		ORDER BY l.created DESC, l.code ASC LIMIT ${limit} OFFSET ${offset}
	`) as (LicenseKeyRow & { project_name: string | null })[];

	const [total] = (await Database`
		SELECT COUNT(*) AS count FROM license_keys l
		WHERE 1 = 1 ${byStatus} ${byType} ${bySearch}
	`) as { count: number }[];

	return Utils.ok(ctx, {
		licenses: rows.map((row) => ({ ...presentLicense(row, true), project_name: row.project_name })),
		total: Number(total.count),
		limit,
		offset,
	});
});

Server.app.post("/api/v1/admin/licenses", ...guard, async (ctx) => {
	const account = Auth.account(ctx);

	let data: CreateLicenseBody;
	try {
		data = await ctx.body<CreateLicenseBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (!isLicenseIssuer()) return Utils.fail(ctx, ErrorCode.LICENSE_ISSUER_ONLY);
	if (!isLicenseType(data.type)) return Utils.fail(ctx, ErrorCode.INVALID_LICENSE);
	const wantsServer = data.server_id !== undefined && data.server_id !== null && data.server_id !== "";
	const server = wantsServer ? normalizeServerId(data.server_id) : null;
	if (wantsServer && server === null) return Utils.fail(ctx, ErrorCode.INVALID_LICENSE);
	const quantity = data.quantity === undefined ? 1 : data.quantity;
	if (!isWholeNumber(quantity, 1, MAX_LICENSE_BATCH)) return Utils.fail(ctx, ErrorCode.INVALID_LICENSE);

	const transactions = data.type === "transactions" ? data.transactions : null;
	const durationDays = TIMED_LICENSE_TYPES.includes(data.type) ? data.duration_days : null;
	const storageGb = data.type === "storage" ? data.storage_gb : null;
	if (data.type === "transactions" && !isWholeNumber(transactions, 1, MAX_LICENSE_TRANSACTIONS)) return Utils.fail(ctx, ErrorCode.INVALID_LICENSE);
	if (TIMED_LICENSE_TYPES.includes(data.type) && !isWholeNumber(durationDays, 1, MAX_LICENSE_DAYS)) return Utils.fail(ctx, ErrorCode.INVALID_LICENSE);
	if (data.type === "storage" && !isWholeNumber(storageGb, 1, MAX_LICENSE_STORAGE_GB)) return Utils.fail(ctx, ErrorCode.INVALID_LICENSE);

	const purchase = readPurchase(data, null);
	if (purchase === null) return Utils.fail(ctx, ErrorCode.INVALID_LICENSE);

	const license: NewLicense = {
		type: data.type,
		transactions: transactions as number | null,
		duration_days: durationDays as number | null,
		storage_gb: storageGb as number | null,
		...purchase,
	};
	const created = await createLicenses(license, quantity, account.username, server);

	await Audit.record(ctx, {
		action: "license.created",
		entityType: "license_key",
		newValue: {
			type: license.type,
			transactions: license.transactions,
			duration_days: license.duration_days,
			storage_gb: license.storage_gb,
			quantity,
			server_id: server,
			price: license.price,
		},
	});
	Logger.audit(`[ADMIN] ${account.username} created ${quantity} ${license.type} license keys`);

	return Utils.ok(
		ctx,
		created.map((row) => presentLicense(row, true)),
		201
	);
});

Server.app.patch("/api/v1/admin/licenses/:license", ...guard, async (ctx) => {
	const license = await findLicense(ctx.params["license"]);
	if (!license) return Utils.fail(ctx, ErrorCode.LICENSE_NOT_FOUND);

	let data: CreateLicenseBody;
	try {
		data = await ctx.body<CreateLicenseBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const purchase = readPurchase(data, license);
	if (purchase === null) return Utils.fail(ctx, ErrorCode.INVALID_LICENSE);

	await Database`
		UPDATE license_keys SET price = ${purchase.price}, currency = ${purchase.currency}, buyer_name = ${purchase.buyer_name},
			buyer_email = ${purchase.buyer_email}, note = ${purchase.note}, updated = ${Date.now()}
		WHERE uuid = ${license.uuid}
	`;
	await Audit.record(ctx, { action: "license.updated", entityType: "license_key", entityId: license.uuid, newValue: purchase });

	return Utils.ok(ctx, presentLicense((await findLicense(license.uuid))!, true));
});

Server.app.post("/api/v1/admin/licenses/:license/revoke", ...guard, async (ctx) => {
	const license = await findLicense(ctx.params["license"]);
	if (!license) return Utils.fail(ctx, ErrorCode.LICENSE_NOT_FOUND);

	const timestamp = Date.now();
	const revoked = await Database`
		UPDATE license_keys SET status = 'revoked', revoked_at = ${timestamp}, updated = ${timestamp}
		WHERE uuid = ${license.uuid} AND status = 'available'
	`;
	if (revoked.count === 0) return Utils.fail(ctx, ErrorCode.LICENSE_NOT_REVOCABLE);

	await Audit.record(ctx, { action: "license.revoked", entityType: "license_key", entityId: license.uuid });
	Logger.audit(`[ADMIN] ${Auth.account(ctx).username} revoked license ${license.uuid}`);

	return Utils.ok(ctx, presentLicense((await findLicense(license.uuid))!, true));
});

Server.app.get("/api/v1/admin/projects", ...guard, async (ctx) => {
	const { limit, offset, search } = paging(ctx.query());
	const pattern = search === null ? null : `%${search}%`;
	const bySearch =
		pattern === null
			? Database``
			: Database`AND (LOWER(name) LIKE ${pattern} OR LOWER(COALESCE(display_name, '')) LIKE ${pattern}
				OR LOWER(created_by) LIKE ${pattern} OR LOWER(uuid) LIKE ${pattern})`;

	await meterAll();

	const rows = (await Database`
		SELECT * FROM projects
		WHERE status != 'deleted' ${bySearch}
		ORDER BY created DESC LIMIT ${limit} OFFSET ${offset}
	`) as ProjectRow[];

	const [total] = (await Database`
		SELECT COUNT(*) AS count FROM projects
		WHERE status != 'deleted' ${bySearch}
	`) as { count: number }[];

	const period = periodOf(Date.now());
	const usage = rows.length
		? ((await Database`
				SELECT project, free_used, paid_used FROM project_usage WHERE period = ${period} AND project IN ${Database(rows.map((row) => row.uuid))}
			`) as { project: string; free_used: number; paid_used: number }[])
		: [];
	const usageByProject = new Map(usage.map((row) => [row.project, row]));
	const storage = await Promise.all(rows.map((row) => storageFor(row.uuid)));

	return Utils.ok(ctx, {
		projects: rows.map((project, index) => {
			const used = usageByProject.get(project.uuid);
			const allowance = freeAllowance(project);
			const freeUsed = used?.free_used ?? 0;
			return {
				uuid: project.uuid,
				name: project.name,
				display_name: project.display_name,
				status: project.status,
				created: project.created,
				created_by: project.created_by,
				free_transactions: project.free_transactions,
				free_allowance: allowance,
				free_used: freeUsed,
				paid_used: used?.paid_used ?? 0,
				paid_balance: project.paid_transactions,
				remaining: Math.max(allowance - freeUsed, 0) + project.paid_transactions,
				white_label: whiteLabelActive(project),
				white_label_until: project.white_label_until,
				store: storeActive(project),
				store_until: project.store_until,
				workforce: workforceActive(project),
				workforce_until: project.workforce_until,
				...storage[index],
			};
		}),
		total: Number(total.count),
		period,
		limit,
		offset,
	});
});

Server.app.patch("/api/v1/admin/projects/:project", ...guard, async (ctx) => {
	const project = await findProject(ctx.params["project"]);
	if (!project) return Utils.fail(ctx, ErrorCode.PROJECT_NOT_FOUND);

	let data: { free_transactions?: unknown };
	try {
		data = await ctx.body<{ free_transactions?: unknown }>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (!isLicenseIssuer()) return Utils.fail(ctx, ErrorCode.LICENSE_ISSUER_ONLY);
	const free = data.free_transactions;
	if (free !== null && !isWholeNumber(free, 0, MAX_LICENSE_TRANSACTIONS)) return Utils.fail(ctx, ErrorCode.INVALID_SETTING);

	await Database`UPDATE projects SET free_transactions = ${free}, updated = ${Date.now()} WHERE uuid = ${project.uuid}`;
	await Audit.record(ctx, {
		project: project.uuid,
		action: "project.free_transactions_changed",
		entityType: "project",
		entityId: project.uuid,
		oldValue: { free_transactions: project.free_transactions },
		newValue: { free_transactions: free },
	});

	return Utils.ok(ctx, await presentProject((await findProject(project.uuid))!));
});

Server.app.post("/api/v1/admin/projects/:project/licenses", ...guard, async (ctx) => {
	const project = await findProject(ctx.params["project"]);
	if (!project) return Utils.fail(ctx, ErrorCode.PROJECT_NOT_FOUND);

	let data: { code?: unknown };
	try {
		data = await ctx.body<{ code?: unknown }>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (typeof data.code !== "string" || data.code.trim() === "" || data.code.length > 2000) return Utils.fail(ctx, ErrorCode.LICENSE_NOT_FOUND);

	const account = Auth.account(ctx);
	const result = await redeemLicense(project.uuid, data.code.trim(), account.username);
	if (typeof result === "number") return Utils.fail(ctx, result);

	await Audit.record(ctx, {
		project: project.uuid,
		action: "license.applied_by_admin",
		entityType: "license_key",
		entityId: result.uuid,
		newValue: { type: result.type, transactions: result.transactions, duration_days: result.duration_days, storage_gb: result.storage_gb },
	});
	Logger.audit(`[ADMIN] ${account.username} applied a ${result.type} license to ${project.uuid}`);

	return Utils.ok(ctx, await presentProject((await findProject(project.uuid))!));
});

Server.app.get("/api/v1/admin/invites", ...guard, async (ctx) => {
	const { limit, offset, search } = paging(ctx.query());
	const pattern = search === null ? null : `%${search}%`;
	const bySearch = pattern === null ? Database`` : Database`AND (LOWER(code) LIKE ${pattern} OR LOWER(COALESCE(note, '')) LIKE ${pattern})`;

	const rows = (await Database`
		SELECT * FROM registration_invites
		WHERE 1 = 1 ${bySearch}
		ORDER BY created DESC, code ASC LIMIT ${limit} OFFSET ${offset}
	`) as RegistrationInviteRow[];

	const [total] = (await Database`
		SELECT COUNT(*) AS count FROM registration_invites
		WHERE 1 = 1 ${bySearch}
	`) as { count: number }[];

	return Utils.ok(ctx, { invites: rows.map(presentInvite), total: Number(total.count), limit, offset });
});

Server.app.post("/api/v1/admin/invites", ...guard, async (ctx) => {
	const account = Auth.account(ctx);

	let data: { max_uses?: unknown; expires_at?: unknown; note?: unknown };
	try {
		data = await ctx.body<{ max_uses?: unknown; expires_at?: unknown; note?: unknown }>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const maxUses = data.max_uses ?? null;
	if (maxUses !== null && !isWholeNumber(maxUses, 1, MAX_INVITE_USES)) return Utils.fail(ctx, ErrorCode.INVALID_INVITE);
	const expiresAt = data.expires_at ?? null;
	if (expiresAt !== null && !isWholeNumber(expiresAt, Date.now() + 1, Number.MAX_SAFE_INTEGER)) return Utils.fail(ctx, ErrorCode.INVALID_INVITE);
	const note = optionalString(data.note, 500);
	if (note === undefined && data.note !== undefined) return Utils.fail(ctx, ErrorCode.INVALID_INVITE);

	const invite = await createInvite({ max_uses: maxUses, expires_at: expiresAt, note: note ?? null }, account.username);

	await Audit.record(ctx, {
		action: "registration_invite.created",
		entityType: "registration_invite",
		entityId: invite.uuid,
		newValue: { max_uses: maxUses, expires_at: expiresAt, note: note ?? null },
	});
	Logger.audit(`[ADMIN] ${account.username} created registration invite ${invite.uuid}`);

	return Utils.ok(ctx, presentInvite(invite), 201);
});

Server.app.post("/api/v1/admin/invites/:invite/revoke", ...guard, async (ctx) => {
	const uuid = ctx.params["invite"];
	if (!Validate.uuid(uuid)) return Utils.fail(ctx, ErrorCode.INVITE_NOT_FOUND);
	const [invite] = (await Database`SELECT * FROM registration_invites WHERE uuid = ${uuid!}`) as RegistrationInviteRow[];
	if (!invite) return Utils.fail(ctx, ErrorCode.INVITE_NOT_FOUND);

	const timestamp = Date.now();
	const revoked = await Database`
		UPDATE registration_invites SET status = 'revoked', revoked_at = ${timestamp}, updated = ${timestamp}
		WHERE uuid = ${invite.uuid} AND status = 'active'
	`;
	if (revoked.count === 0) return Utils.fail(ctx, ErrorCode.INVITE_NOT_REVOCABLE);

	await Audit.record(ctx, { action: "registration_invite.revoked", entityType: "registration_invite", entityId: invite.uuid });
	Logger.audit(`[ADMIN] ${Auth.account(ctx).username} revoked registration invite ${invite.uuid}`);

	const [updated] = (await Database`SELECT * FROM registration_invites WHERE uuid = ${invite.uuid}`) as RegistrationInviteRow[];
	return Utils.ok(ctx, presentInvite(updated));
});

Server.app.get("/api/v1/admin/accounts", ...guard, async (ctx) => {
	const { limit, offset, search } = paging(ctx.query());
	const pattern = search === null ? null : `%${search}%`;
	const bySearch = pattern === null ? Database`` : Database`AND (LOWER(a.username) LIKE ${pattern} OR LOWER(a.email) LIKE ${pattern})`;

	const rows = (await Database`
		SELECT a.*, (
			SELECT COUNT(*) FROM project_members pm JOIN projects p ON p.uuid = pm.project_id
			WHERE pm.account_username = a.username AND pm.status = 'active' AND p.status != 'deleted'
		) AS projects
		FROM accounts a
		WHERE 1 = 1 ${bySearch}
		ORDER BY a.created ASC LIMIT ${limit} OFFSET ${offset}
	`) as (AccountRow & { projects: number })[];

	const [total] = (await Database`
		SELECT COUNT(*) AS count FROM accounts a
		WHERE 1 = 1 ${bySearch}
	`) as { count: number }[];

	return Utils.ok(ctx, { accounts: rows.map(presentAccount), total: Number(total.count), limit, offset });
});

Server.app.patch("/api/v1/admin/accounts/:username", ...guard, async (ctx) => {
	const actor = Auth.account(ctx);
	const username = ctx.params["username"];
	if (!Validate.username(username)) return Utils.fail(ctx, ErrorCode.INVALID_USERNAME);
	if (username === actor.username) return Utils.fail(ctx, ErrorCode.CANNOT_MODIFY_OWN_ACCOUNT);

	const [account] = (await Database`SELECT * FROM accounts WHERE username = ${username}`) as AccountRow[];
	if (!account) return Utils.fail(ctx, ErrorCode.ACCOUNT_NOT_FOUND);

	let data: { admin?: unknown; status?: unknown };
	try {
		data = await ctx.body<{ admin?: unknown; status?: unknown }>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (data.admin !== undefined && typeof data.admin !== "boolean") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (data.status !== undefined && !ACCOUNT_STATUSES.includes(data.status as string)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (data.admin === undefined && data.status === undefined) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	const admin = data.admin === undefined ? Number(account.admin) : data.admin ? 1 : 0;
	const status = (data.status as string | undefined) ?? account.status;

	await Database`UPDATE accounts SET admin = ${admin}, status = ${status}, updated = ${Date.now()} WHERE username = ${username}`;
	await Audit.record(ctx, {
		action: "account.admin_updated",
		entityType: "account",
		entityId: username,
		oldValue: { admin: Number(account.admin) === 1, status: account.status },
		newValue: { admin: admin === 1, status },
	});
	Logger.audit(`[ADMIN] ${actor.username} set ${username} to admin=${admin === 1} status=${status}`);

	const [updated] = (await Database`SELECT * FROM accounts WHERE username = ${username}`) as AccountRow[];
	return Utils.ok(ctx, presentAccount(updated));
});

Server.app.delete("/api/v1/admin/accounts/:username/two-factor", ...guard, async (ctx) => {
	const actor = Auth.account(ctx);
	const username = ctx.params["username"];
	if (!Validate.username(username)) return Utils.fail(ctx, ErrorCode.INVALID_USERNAME);
	if (username === actor.username) return Utils.fail(ctx, ErrorCode.CANNOT_MODIFY_OWN_ACCOUNT);

	const [account] = (await Database`SELECT * FROM accounts WHERE username = ${username}`) as AccountRow[];
	if (!account) return Utils.fail(ctx, ErrorCode.ACCOUNT_NOT_FOUND);
	const [keys] = (await Database`SELECT COUNT(*) AS count FROM account_security_keys WHERE account_username = ${username}`) as { count: number }[];
	if (account.two_factor_secret === null && Number(keys.count) === 0) return Utils.fail(ctx, ErrorCode.TWO_FACTOR_NOT_ENABLED);

	await TwoFactor.reset(username);
	await Audit.record(ctx, {
		action: "account.two_factor_reset",
		entityType: "account",
		entityId: username,
		oldValue: { two_factor_enabled: account.two_factor_secret !== null, security_keys: Number(keys.count) },
	});
	Logger.audit(`[ADMIN] ${actor.username} reset two-factor authentication for ${username}`);

	const [updated] = (await Database`SELECT * FROM accounts WHERE username = ${username}`) as AccountRow[];
	return Utils.ok(ctx, presentAccount(updated));
});

async function targetAccount(ctx: Context<any, any>, allowSelf = false): Promise<AccountRow | ErrorCode> {
	const username = ctx.params["username"];
	if (!Validate.username(username)) return ErrorCode.INVALID_USERNAME;
	if (!allowSelf && username === Auth.account(ctx).username) return ErrorCode.CANNOT_MODIFY_OWN_ACCOUNT;
	const [account] = (await Database`SELECT * FROM accounts WHERE username = ${username}`) as AccountRow[];
	return account ?? ErrorCode.ACCOUNT_NOT_FOUND;
}

Server.app.get("/api/v1/admin/accounts/:username/export", ...guard, async (ctx) => {
	const account = await targetAccount(ctx, true);
	if (typeof account === "number") return Utils.fail(ctx, account);
	await Audit.record(ctx, { action: "account.data_exported_by_admin", entityType: "account", entityId: account.username });
	Logger.audit(`[ADMIN] ${Auth.account(ctx).username} exported the data of ${account.username}`);
	return exportResponse(await exportAccount(account), account.username);
});

Server.app.get("/api/v1/admin/accounts/:username/deletion", ...guard, async (ctx) => {
	const account = await targetAccount(ctx);
	if (typeof account === "number") return Utils.fail(ctx, account);
	return Utils.ok(ctx, await deletionPlan(account.username));
});

Server.app.delete("/api/v1/admin/accounts/:username", ...guard, async (ctx) => {
	const account = await targetAccount(ctx);
	if (typeof account === "number") return Utils.fail(ctx, account);

	let data: { confirm?: unknown };
	try {
		data = await ctx.body<{ confirm?: unknown }>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}
	if (data.confirm !== account.username) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	const plan = await deletionPlan(account.username);
	if (plan.shared.length > 0)
		return Utils.failWithReason(ctx, ErrorCode.ACCOUNT_OWNS_SHARED_PROJECTS, Errors.get(ErrorCode.ACCOUNT_OWNS_SHARED_PROJECTS).message, plan);

	await deleteAccount(account.username, plan);
	await Audit.record(ctx, {
		action: "account.deleted",
		entityType: "account",
		entityId: account.username,
		oldValue: { closed_projects: plan.closing.map((project) => project.uuid) },
	});
	Logger.audit(`[ADMIN] ${Auth.account(ctx).username} deleted account ${account.username} and closed ${plan.closing.length} projects`);

	return Utils.ok(ctx, { deleted: account.username, closed_projects: plan.closing });
});
