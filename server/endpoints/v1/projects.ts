import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import Vault from "../../crypto/vault";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { Permission, ProjectRole } from "../../roles";
import { displayNameOf } from "../../company";
import { isDateFormat, isTimeFormat } from "../../formats";
import { isLanguage } from "../../i18n";
import { isAccentColor } from "../../colors";
import { isVatStatus } from "../../tax";
import { isCountryCode } from "../../countries";
import { canEmail } from "../../email/mailer";
import { storeActive, whiteLabelActive, workforceActive } from "../../licensing";
import { MAX_DAYS_AFTER, MAX_DAYS_BEFORE, isReminderDays } from "../../email/reminders";
import { isTimezone } from "../../timezone";
import type { ProjectMemberRow, ProjectRow } from "../../database/models";

interface CreateProjectBody {
	name?: string;
	currency?: string;
}

interface UpdateProjectBody {
	name?: string;
	display_name?: string | null;
	webhook_url?: string | null;
	currency?: string;
	date_format?: string;
	time_format?: string;
	timezone?: string;
	language?: string;
	accent_color?: string | null;
	tax_country?: string | null;
	vat_status?: string | null;
	oss_registered?: boolean;
	tax_currency?: string | null;
	vat_exemption_note?: string | null;
	pos_custom_amounts?: boolean;
	email_reminders?: boolean;
	reminder_days_before?: number;
	reminder_days_after?: number;
	email_attach_invoice?: boolean;
	email_attach_eslog?: boolean;
	email_pay_link?: boolean;
	email_portal_link?: boolean;
	invoice_issuer_details?: boolean;
}

function withoutSecrets(project: ProjectRow, role: ProjectRole) {
	return {
		uuid: project.uuid,
		name: project.name,
		display_name: project.display_name,
		public_name: displayNameOf(project),
		role,
		webhook_url: project.webhook_url,
		currency: project.currency,
		date_format: project.date_format,
		time_format: project.time_format,
		timezone: project.timezone,
		language: project.language,
		accent_color: project.accent_color,
		tax_country: project.tax_country,
		vat_status: project.vat_status,
		oss_registered: Boolean(project.oss_registered),
		tax_currency: project.tax_currency,
		vat_exemption_note: project.vat_exemption_note,
		pos_custom_amounts: Boolean(project.pos_custom_amounts),
		email_enabled: canEmail(project),
		white_label: whiteLabelActive(project),
		white_label_until: project.white_label_until,
		store: storeActive(project),
		store_until: project.store_until,
		workforce: workforceActive(project),
		workforce_until: project.workforce_until,
		has_logo: project.logo_updated !== null,
		custom_email_server: project.email_server !== null,
		email_reminders: Boolean(project.email_reminders),
		reminder_days_before: project.reminder_days_before,
		reminder_days_after: project.reminder_days_after,
		email_attach_invoice: Boolean(project.email_attach_invoice),
		email_attach_eslog: Boolean(project.email_attach_eslog),
		email_pay_link: Boolean(project.email_pay_link),
		email_portal_link: Boolean(project.email_portal_link),
		invoice_format: project.invoice_format,
		invoice_issuer_details: Boolean(project.invoice_issuer_details),
		status: project.status,
		created: project.created,
		updated: project.updated,
		created_by: project.created_by,
	};
}

Server.app.get("/api/v1/projects", Auth.required(), async (ctx) => {
	const account = Auth.account(ctx);

	const rows = (await Database`
		SELECT p.*, pm.role AS member_role, pm.additional_permissions AS member_additional, pm.restricted_permissions AS member_restricted FROM projects p
		JOIN project_members pm ON pm.project_id = p.uuid
		WHERE pm.account_username = ${account.username}
			AND pm.status = 'active'
			AND (pm.expires_at IS NULL OR pm.expires_at > ${Date.now()})
			AND p.status != 'deleted'
		ORDER BY p.created DESC
	`) as (ProjectRow & { member_role: ProjectRole; member_additional: string | null; member_restricted: string | null })[];

	return Utils.ok(
		ctx,
		rows.map((row) => {
			const permissions = Permissions.resolve({
				role: row.member_role,
				additional_permissions: row.member_additional,
				restricted_permissions: row.member_restricted,
			} as ProjectMemberRow);
			return { ...withoutSecrets(row, row.member_role), permissions: [...permissions] };
		})
	);
});

Server.app.post("/api/v1/projects", Auth.required(), async (ctx) => {
	const account = Auth.account(ctx);

	if (!Vault.isConfigured()) {
		Logger.error("[PROJECT] Refusing to create a project, RABBITPAY_MASTER_KEY is not set");
		return Utils.fail(ctx, ErrorCode.MASTER_KEY_NOT_CONFIGURED);
	}

	let data: CreateProjectBody;
	try {
		data = await ctx.body<CreateProjectBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (!Validate.project(data.name)) return Utils.fail(ctx, ErrorCode.INVALID_PROJECT_NAME);
	if (data.currency !== undefined && !Validate.currency(data.currency)) return Utils.fail(ctx, ErrorCode.INVALID_CURRENCY);

	const name = data.name!;
	const currency = data.currency ?? "EUR";

	const duplicates = (await Database`
		SELECT p.uuid FROM projects p
		JOIN project_members pm ON pm.project_id = p.uuid
		WHERE p.name = ${name} AND pm.account_username = ${account.username} AND pm.role = 'owner' AND p.status != 'deleted'
	`) as { uuid: string }[];
	if (duplicates.length > 0) return Utils.fail(ctx, ErrorCode.PROJECT_ALREADY_EXISTS);

	const uuid = crypto.randomUUID();
	const apikey = Utils.generateRandomText(128);
	const apikey2 = Utils.generateRandomText(128);
	const webhookSecret = Utils.generateRandomText(64);
	const timestamp = Date.now();

	await Database.begin(async (tx) => {
		await tx`
			INSERT INTO projects(uuid, name, apikey, apikey2, webhook_secret, currency, status, created, updated, created_by)
			VALUES(${uuid}, ${name}, ${apikey}, ${apikey2}, ${webhookSecret}, ${currency}, 'active', ${timestamp}, ${timestamp}, ${account.username})
		`;

		await tx`
			INSERT INTO project_members(uuid, project_id, account_username, role, status, accepted_at, created, updated)
			VALUES(${crypto.randomUUID()}, ${uuid}, ${account.username}, 'owner', 'active', ${timestamp}, ${timestamp}, ${timestamp})
		`;
	});

	await Audit.record(ctx, { project: uuid, action: "project.created", entityType: "project", entityId: uuid, newValue: { name } });
	Logger.audit(`[PROJECT] Created "${name}" (${uuid}) by ${account.username}`);

	return Utils.ok(
		ctx,
		{
			uuid,
			name,
			role: ProjectRole.OWNER,
			currency,
			status: "active",
			created: timestamp,
			apikey,
			apikey2,
			webhook_secret: webhookSecret,
		},
		201
	);
});

Server.app.get("/api/v1/projects/:uuid", Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const member = Permissions.member(ctx);

	const [stats] = (await Database`
		SELECT
			(SELECT COUNT(*) FROM project_members WHERE project_id = ${project.uuid} AND status = 'active') AS members,
			(SELECT COUNT(*) FROM invoices WHERE project = ${project.uuid}) AS invoices,
			(SELECT COUNT(*) FROM transactions WHERE project = ${project.uuid}) AS transactions,
			(SELECT COUNT(*) FROM customers WHERE project = ${project.uuid}) AS customers
	`) as Record<string, number>[];

	const permissions = [...Permissions.resolve(member)];
	if (!permissions.includes(Permission.INVOICE_VIEW)) {
		return Utils.ok(ctx, { ...withoutSecrets(project, member.role), permissions });
	}

	return Utils.ok(ctx, { ...withoutSecrets(project, member.role), permissions, stats });
});

Server.app.patch("/api/v1/projects/:uuid", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const member = Permissions.member(ctx);

	let data: UpdateProjectBody;
	try {
		data = await ctx.body<UpdateProjectBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const nothingGiven =
		data.name === undefined &&
		data.webhook_url === undefined &&
		data.currency === undefined &&
		data.display_name === undefined &&
		data.date_format === undefined &&
		data.time_format === undefined &&
		data.timezone === undefined &&
		data.language === undefined &&
		data.accent_color === undefined &&
		data.tax_country === undefined &&
		data.vat_status === undefined &&
		data.oss_registered === undefined &&
		data.tax_currency === undefined &&
		data.vat_exemption_note === undefined &&
		data.pos_custom_amounts === undefined &&
		data.email_reminders === undefined &&
		data.reminder_days_before === undefined &&
		data.reminder_days_after === undefined &&
		data.email_attach_invoice === undefined &&
		data.email_attach_eslog === undefined &&
		data.email_pay_link === undefined &&
		data.email_portal_link === undefined &&
		data.invoice_issuer_details === undefined;

	if (nothingGiven) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	if (data.date_format !== undefined && !isDateFormat(data.date_format)) return Utils.fail(ctx, ErrorCode.INVALID_DATE_FORMAT);
	if (data.time_format !== undefined && !isTimeFormat(data.time_format)) return Utils.fail(ctx, ErrorCode.INVALID_DATE_FORMAT);
	if (data.timezone !== undefined && !isTimezone(data.timezone)) return Utils.fail(ctx, ErrorCode.INVALID_TIMEZONE);
	if (data.timezone !== undefined && data.timezone !== project.timezone) {
		const [records] = (await Database`
			SELECT
				(SELECT COUNT(*) FROM invoices WHERE project = ${project.uuid}) +
				(SELECT COUNT(*) FROM expenses WHERE project = ${project.uuid}) +
				(SELECT COUNT(*) FROM recurring_invoices WHERE project = ${project.uuid}) +
				(SELECT COUNT(*) FROM recurring_expenses WHERE project = ${project.uuid}) AS count
		`) as { count: number }[];
		if (Number(records.count) > 0) return Utils.fail(ctx, ErrorCode.ACCOUNTING_TIMEZONE_LOCKED);
	}
	if (data.language !== undefined && !isLanguage(data.language)) return Utils.fail(ctx, ErrorCode.INVALID_LANGUAGE);
	if (data.accent_color !== undefined && data.accent_color !== null && !isAccentColor(data.accent_color)) {
		return Utils.fail(ctx, ErrorCode.INVALID_ACCENT_COLOR);
	}
	if (data.tax_country !== undefined && data.tax_country !== null && !isCountryCode(data.tax_country)) {
		return Utils.fail(ctx, ErrorCode.INVALID_TAX_PROFILE);
	}
	if (data.vat_status !== undefined && data.vat_status !== null && !isVatStatus(data.vat_status)) {
		return Utils.fail(ctx, ErrorCode.INVALID_TAX_PROFILE);
	}
	if (data.oss_registered !== undefined && typeof data.oss_registered !== "boolean") return Utils.fail(ctx, ErrorCode.INVALID_TAX_PROFILE);
	if (data.tax_currency !== undefined && data.tax_currency !== null && !Validate.currency(data.tax_currency)) {
		return Utils.fail(ctx, ErrorCode.INVALID_TAX_PROFILE);
	}
	if (!Validate.optionalText(data.vat_exemption_note, 500)) return Utils.fail(ctx, ErrorCode.INVALID_TAX_PROFILE);
	if (data.pos_custom_amounts !== undefined && typeof data.pos_custom_amounts !== "boolean") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (data.email_reminders !== undefined && typeof data.email_reminders !== "boolean") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (data.reminder_days_before !== undefined && !isReminderDays(data.reminder_days_before, MAX_DAYS_BEFORE)) {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}
	if (data.reminder_days_after !== undefined && !isReminderDays(data.reminder_days_after, MAX_DAYS_AFTER)) {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}
	if (data.email_attach_invoice !== undefined && typeof data.email_attach_invoice !== "boolean") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (data.email_attach_eslog !== undefined && typeof data.email_attach_eslog !== "boolean") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (data.email_pay_link !== undefined && typeof data.email_pay_link !== "boolean") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (data.email_portal_link !== undefined && typeof data.email_portal_link !== "boolean") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (data.invoice_issuer_details !== undefined && typeof data.invoice_issuer_details !== "boolean") {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (data.name !== undefined && !Validate.project(data.name)) return Utils.fail(ctx, ErrorCode.INVALID_PROJECT_NAME);
	if (data.currency !== undefined && !Validate.currency(data.currency)) return Utils.fail(ctx, ErrorCode.INVALID_CURRENCY);
	if (data.display_name !== undefined && data.display_name !== null && !Validate.optionalText(data.display_name, 120)) {
		return Utils.fail(ctx, ErrorCode.INVALID_PROJECT_NAME);
	}
	if (data.webhook_url !== undefined && data.webhook_url !== null && !Validate.webhookUrl(data.webhook_url)) {
		return Utils.fail(ctx, ErrorCode.INVALID_WEBHOOK_URL);
	}

	const name = data.name ?? project.name;
	const currency = data.currency ?? project.currency;
	const webhookUrl = data.webhook_url === undefined ? project.webhook_url : data.webhook_url;
	const displayName =
		data.display_name === undefined ? project.display_name : data.display_name === null || data.display_name.trim() === "" ? null : data.display_name.trim();
	const dateFormat = data.date_format ?? project.date_format;
	const timeFormat = data.time_format ?? project.time_format;
	const timezone = data.timezone ?? project.timezone;
	const language = data.language ?? project.language;
	const taxCountry = data.tax_country === undefined ? project.tax_country : data.tax_country;
	const vatStatus = data.vat_status === undefined ? project.vat_status : data.vat_status;
	const ossRegistered = data.oss_registered === undefined ? project.oss_registered : data.oss_registered ? 1 : 0;
	const taxCurrency = data.tax_currency === undefined ? project.tax_currency : data.tax_currency;
	const exemptionNote =
		data.vat_exemption_note === undefined
			? project.vat_exemption_note
			: data.vat_exemption_note === null || data.vat_exemption_note.trim() === ""
				? null
				: data.vat_exemption_note.trim();
	const posCustomAmounts = data.pos_custom_amounts === undefined ? project.pos_custom_amounts : data.pos_custom_amounts ? 1 : 0;
	const emailReminders = data.email_reminders === undefined ? project.email_reminders : data.email_reminders ? 1 : 0;
	const daysBefore = data.reminder_days_before ?? project.reminder_days_before;
	const daysAfter = data.reminder_days_after ?? project.reminder_days_after;
	const attachInvoice = data.email_attach_invoice === undefined ? project.email_attach_invoice : data.email_attach_invoice ? 1 : 0;
	const attachEslog = data.email_attach_eslog === undefined ? project.email_attach_eslog : data.email_attach_eslog ? 1 : 0;
	const payLink = data.email_pay_link === undefined ? project.email_pay_link : data.email_pay_link ? 1 : 0;
	const portalLink = data.email_portal_link === undefined ? project.email_portal_link : data.email_portal_link ? 1 : 0;
	const issuerDetails = data.invoice_issuer_details === undefined ? project.invoice_issuer_details : data.invoice_issuer_details ? 1 : 0;
	const accentColor = data.accent_color === undefined ? project.accent_color : data.accent_color === null ? null : data.accent_color.toLowerCase();

	await Database`
		UPDATE projects SET name = ${name}, display_name = ${displayName}, currency = ${currency}, webhook_url = ${webhookUrl},
			date_format = ${dateFormat}, time_format = ${timeFormat}, timezone = ${timezone}, language = ${language}, accent_color = ${accentColor},
			tax_country = ${taxCountry}, vat_status = ${vatStatus}, oss_registered = ${ossRegistered}, tax_currency = ${taxCurrency},
			vat_exemption_note = ${exemptionNote}, pos_custom_amounts = ${posCustomAmounts},
			email_reminders = ${emailReminders}, reminder_days_before = ${daysBefore}, reminder_days_after = ${daysAfter},
			email_attach_invoice = ${attachInvoice}, email_attach_eslog = ${attachEslog}, email_pay_link = ${payLink}, email_portal_link = ${portalLink},
			invoice_issuer_details = ${issuerDetails}, updated = ${Date.now()}
		WHERE uuid = ${project.uuid}
	`;

	const [updated] = (await Database`SELECT * FROM projects WHERE uuid = ${project.uuid}`) as ProjectRow[];

	await Audit.record(ctx, {
		project: project.uuid,
		action: "project.updated",
		entityType: "project",
		entityId: project.uuid,
		oldValue: {
			name: project.name,
			webhook_url: project.webhook_url,
			currency: project.currency,
			timezone: project.timezone,
			pos_custom_amounts: Boolean(project.pos_custom_amounts),
			email_reminders: Boolean(project.email_reminders),
			reminder_days_before: project.reminder_days_before,
			reminder_days_after: project.reminder_days_after,
			email_attach_invoice: Boolean(project.email_attach_invoice),
			email_attach_eslog: Boolean(project.email_attach_eslog),
			email_pay_link: Boolean(project.email_pay_link),
			email_portal_link: Boolean(project.email_portal_link),
			invoice_issuer_details: Boolean(project.invoice_issuer_details),
		},
		newValue: {
			name: updated.name,
			webhook_url: updated.webhook_url,
			currency: updated.currency,
			timezone: updated.timezone,
			pos_custom_amounts: Boolean(updated.pos_custom_amounts),
			email_reminders: Boolean(updated.email_reminders),
			reminder_days_before: updated.reminder_days_before,
			reminder_days_after: updated.reminder_days_after,
			email_attach_invoice: Boolean(updated.email_attach_invoice),
			email_attach_eslog: Boolean(updated.email_attach_eslog),
			email_pay_link: Boolean(updated.email_pay_link),
			email_portal_link: Boolean(updated.email_portal_link),
			invoice_issuer_details: Boolean(updated.invoice_issuer_details),
		},
	});

	return Utils.ok(ctx, withoutSecrets(updated, member.role));
});

Server.app.delete("/api/v1/projects/:uuid", Auth.required(), Permissions.require(Permission.PROJECT_DELETE), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	await Database`UPDATE projects SET status = 'deleted', updated = ${Date.now()} WHERE uuid = ${project.uuid}`;

	await Audit.record(ctx, {
		project: project.uuid,
		action: "project.deleted",
		entityType: "project",
		entityId: project.uuid,
		oldValue: { status: project.status },
		newValue: { status: "deleted" },
	});
	Logger.audit(`[PROJECT] Deleted "${project.name}" (${project.uuid}) by ${account.username}`);

	return Utils.ok(ctx);
});

Server.app.get("/api/v1/projects/:uuid/members", Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);

	const member = Permissions.member(ctx);

	const members = (await Database`
		SELECT pm.uuid, pm.account_username, pm.full_name, pm.role, pm.status, pm.invitation_email, pm.invitation_token, pm.invited_by,
			pm.expires_at, pm.accepted_at, pm.created,
			CASE WHEN EXISTS(
				SELECT 1 FROM project_member_signature_versions signature
				WHERE signature.member = pm.uuid AND signature.valid_until IS NULL
			) THEN 1 ELSE 0 END AS has_signature
		FROM project_members pm WHERE pm.project_id = ${project.uuid} AND pm.status != 'removed' ORDER BY pm.created ASC
	`) as (ProjectMemberRow & { has_signature: number })[];

	const managesMembers = Permissions.has(member, Permission.PROJECT_MEMBERS);
	return Utils.ok(
		ctx,
		members.map((row) => ({ ...row, has_signature: Boolean(row.has_signature), invitation_token: managesMembers ? row.invitation_token : null }))
	);
});
