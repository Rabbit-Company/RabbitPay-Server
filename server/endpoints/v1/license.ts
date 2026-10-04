import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import { okWithNames } from "../../accounts";
import Validate from "../../validate";
import Vault from "../../crypto/vault";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { Permission } from "../../roles";
import { LICENSE_TYPES, presentLicense, readLicenseStart, previewLicense, redeemLicense, usageFor, whiteLabelActive } from "../../licensing";
import { isLicenseIssuer } from "../../license-signing";
import { serverId } from "../../server-identity";
import { logoPath, readLogo, removeLogo, saveLogo } from "../../branding";
import { isEmailServer, sealEmailServer, sendEmail, storedEmailServer, type EmailServer } from "../../email/mailer";
import { displayNameOf } from "../../company";
import { rateLimit } from "@rabbit-company/web-middleware/rate-limit";
import { emailDesignOf, invoiceDesignOf } from "../../branding";
import { CUSTOMER_EMAIL_KINDS, parseEmailDesign, readEmailDesign, type CustomerEmailKind } from "../../email-design";
import { defaultEmailTexts, previewEmail } from "../../email/design-preview";
import { parseInvoiceDesign, readInvoiceDesign } from "../../invoice-design";
import { previewDocument, renderDesignPreview, type PreviewKind } from "../../invoice-preview";
import type { LicenseKeyRow, ProjectRow } from "../../database/models";

interface RedeemBody {
	code?: string;
	starts_at?: unknown;
}

interface LogoBody {
	data?: string;
}

type EmailServerBody = Partial<Omit<EmailServer, "password">> & { password?: string | null };

interface TestEmailBody {
	to?: string;
}

async function licenseState(project: ProjectRow) {
	const licenses = (await Database`
		SELECT * FROM license_keys WHERE redeemed_project = ${project.uuid} ORDER BY redeemed_at DESC
	`) as LicenseKeyRow[];

	return {
		...(await usageFor(project.uuid)),
		logo: whiteLabelActive(project) ? logoPath(project) : null,
		licenses: licenses.map((license) => presentLicense(license, false)),
		server_id: await serverId(),
		license_issuer: isLicenseIssuer(),
	};
}

async function reload(uuid: string): Promise<ProjectRow> {
	const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${uuid}`) as ProjectRow[];
	return project;
}

function presentEmailServer(project: ProjectRow) {
	const server = storedEmailServer(project);
	if (!server) return null;
	const { password, ...rest } = server;
	return { ...rest, password_set: password !== "" };
}

Server.app.get("/api/v1/projects/:uuid/license", Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	return await okWithNames(ctx, await licenseState(Permissions.project(ctx)));
});

Server.app.post("/api/v1/projects/:uuid/license/preview", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);

	let data: RedeemBody;
	try {
		data = await ctx.body<RedeemBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (typeof data.code !== "string" || data.code.trim() === "" || data.code.length > 2000) return Utils.fail(ctx, ErrorCode.LICENSE_NOT_FOUND);

	const result = await previewLicense(project.uuid, data.code.trim());
	if (typeof result === "number") return Utils.fail(ctx, result);
	return await okWithNames(ctx, result);
});

Server.app.post("/api/v1/projects/:uuid/license/redeem", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	let data: RedeemBody;
	try {
		data = await ctx.body<RedeemBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (typeof data.code !== "string" || data.code.trim() === "" || data.code.length > 2000) return Utils.fail(ctx, ErrorCode.LICENSE_NOT_FOUND);
	const startsAt = readLicenseStart(data.starts_at);
	if (startsAt === undefined) return Utils.fail(ctx, ErrorCode.INVALID_LICENSE);

	const result = await redeemLicense(project.uuid, data.code.trim(), account.username, LICENSE_TYPES, startsAt);
	if (typeof result === "number") return Utils.fail(ctx, result);

	await Audit.record(ctx, {
		project: project.uuid,
		action: "license.redeemed",
		entityType: "license_key",
		entityId: result.uuid,
		newValue: {
			type: result.type,
			transactions: result.transactions,
			duration_days: result.duration_days,
			storage_gb: result.storage_gb,
			employees: result.employees,
			emails: result.emails,
			starts_at: result.starts_at,
		},
	});
	Logger.audit(`[LICENSE] ${account.username} redeemed a ${result.type} license on ${project.uuid}`);

	return await okWithNames(ctx, await licenseState(await reload(project.uuid)));
});

Server.app.put("/api/v1/projects/:uuid/branding/logo", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	if (!whiteLabelActive(project)) return Utils.fail(ctx, ErrorCode.WHITE_LABEL_REQUIRED);

	let data: LogoBody;
	try {
		data = await ctx.body<LogoBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.INVALID_LOGO);
	}

	const logo = readLogo(data.data);
	if (logo === null) return Utils.fail(ctx, ErrorCode.INVALID_LOGO);

	const updated = await saveLogo(project.uuid, logo);
	await Audit.record(ctx, { project: project.uuid, action: "branding.logo_updated", entityType: "project", entityId: project.uuid });

	return await okWithNames(ctx, { logo: logoPath({ uuid: project.uuid, logo_updated: updated }) });
});

Server.app.delete("/api/v1/projects/:uuid/branding/logo", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);

	await removeLogo(project.uuid);
	await Audit.record(ctx, { project: project.uuid, action: "branding.logo_removed", entityType: "project", entityId: project.uuid });

	return Utils.ok(ctx);
});

Server.app.get("/api/v1/projects/:uuid/email-server", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	return await okWithNames(ctx, presentEmailServer(Permissions.project(ctx)));
});

Server.app.put("/api/v1/projects/:uuid/email-server", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	if (!whiteLabelActive(project)) return Utils.fail(ctx, ErrorCode.WHITE_LABEL_REQUIRED);
	if (!Vault.isConfigured()) return Utils.fail(ctx, ErrorCode.MASTER_KEY_NOT_CONFIGURED);

	let data: EmailServerBody;
	try {
		data = await ctx.body<EmailServerBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.INVALID_EMAIL_SERVER);
	}

	const previous = storedEmailServer(project);
	const password = data.password === undefined || data.password === "" ? (previous?.password ?? "") : (data.password ?? "");
	const server = {
		host: typeof data.host === "string" ? data.host.trim() : data.host,
		port: data.port,
		secure: data.secure,
		username: typeof data.username === "string" ? data.username.trim() : (data.username ?? ""),
		password,
		from_address: typeof data.from_address === "string" ? data.from_address.trim() : data.from_address,
	};
	if (!isEmailServer(server)) return Utils.fail(ctx, ErrorCode.INVALID_EMAIL_SERVER);

	await Database`UPDATE projects SET email_server = ${sealEmailServer(server)}, updated = ${Date.now()} WHERE uuid = ${project.uuid}`;
	await Audit.record(ctx, {
		project: project.uuid,
		action: "email_server.updated",
		entityType: "project",
		entityId: project.uuid,
		newValue: { host: server.host, port: server.port, from_address: server.from_address },
	});

	return await okWithNames(ctx, presentEmailServer(await reload(project.uuid)));
});

Server.app.delete("/api/v1/projects/:uuid/email-server", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);

	await Database`UPDATE projects SET email_server = NULL, updated = ${Date.now()} WHERE uuid = ${project.uuid}`;
	await Audit.record(ctx, { project: project.uuid, action: "email_server.removed", entityType: "project", entityId: project.uuid });

	return Utils.ok(ctx);
});

Server.app.post("/api/v1/projects/:uuid/email-server/test", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	if (!whiteLabelActive(project)) return Utils.fail(ctx, ErrorCode.WHITE_LABEL_REQUIRED);

	const server = storedEmailServer(project);
	if (!server) return Utils.fail(ctx, ErrorCode.EMAIL_NOT_CONFIGURED);

	let data: TestEmailBody;
	try {
		data = await ctx.body<TestEmailBody>();
	} catch {
		data = {};
	}
	const to = data.to?.trim() || account.email;
	if (!Validate.email(to)) return Utils.fail(ctx, ErrorCode.INVALID_EMAIL);

	const merchant = displayNameOf(project);
	try {
		await sendEmail(
			{
				to,
				senderName: merchant,
				replyTo: null,
				subject: `Test email from ${merchant}`,
				text: `Your email server works. This message was sent through ${server.host}.`,
				html: `<p>Your email server works. This message was sent through ${Bun.escapeHTML(server.host)}.</p>`,
			},
			{ projectId: project.uuid, server }
		);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return Utils.failWithReason(ctx, ErrorCode.EMAIL_SERVER_FAILED, `The email server did not accept the test message: ${reason.slice(0, 300)}`);
	}

	return await okWithNames(ctx, { to });
});

const previewLimit = rateLimit({ windowMs: 60 * 1000, max: 30, message: "Too many previews. Please slow down." });

function designState(project: ProjectRow) {
	return {
		design: parseInvoiceDesign(project.invoice_design),
		white_label: whiteLabelActive(project),
		applied: invoiceDesignOf(project),
	};
}

Server.app.get("/api/v1/projects/:uuid/invoice-design", Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	return await okWithNames(ctx, designState(Permissions.project(ctx)));
});

Server.app.put("/api/v1/projects/:uuid/invoice-design", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	if (!whiteLabelActive(project)) return Utils.fail(ctx, ErrorCode.WHITE_LABEL_REQUIRED);

	let data: unknown;
	try {
		data = await ctx.body();
	} catch {
		return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_DESIGN);
	}
	const design = readInvoiceDesign(data);
	if (!design) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_DESIGN);

	const previous = parseInvoiceDesign(project.invoice_design);
	await Database`UPDATE projects SET invoice_design = ${JSON.stringify(design)}, updated = ${Date.now()} WHERE uuid = ${project.uuid}`;
	await Audit.record(ctx, {
		project: project.uuid,
		action: "invoice_design.updated",
		entityType: "project",
		entityId: project.uuid,
		oldValue: previous,
		newValue: design,
	});

	return await okWithNames(ctx, designState(await reload(project.uuid)));
});

Server.app.post("/api/v1/projects/:uuid/invoice-design/preview", previewLimit, Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	let data: { design?: unknown; kind?: unknown; format?: unknown };
	try {
		data = (await ctx.body()) ?? {};
	} catch {
		return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_DESIGN);
	}
	const design = readInvoiceDesign(data.design);
	const kind = data.kind ?? "invoice";
	if (!design || (kind !== "invoice" && kind !== "receipt" && kind !== "credit_note")) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_DESIGN);

	if (data.format === "document") return await okWithNames(ctx, await previewDocument(Permissions.project(ctx), design, kind as PreviewKind));
	const pdf = await renderDesignPreview(Permissions.project(ctx), design, kind as PreviewKind);
	return new Response(pdf, {
		headers: {
			"Content-Type": "application/pdf",
			"Content-Disposition": 'inline; filename="preview.pdf"',
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
});

function emailDesignState(project: ProjectRow) {
	return {
		design: parseEmailDesign(project.email_design),
		white_label: whiteLabelActive(project),
		applied: emailDesignOf(project),
		defaults: defaultEmailTexts(project.language),
	};
}

Server.app.get("/api/v1/projects/:uuid/email-design", Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	return await okWithNames(ctx, emailDesignState(Permissions.project(ctx)));
});

Server.app.put("/api/v1/projects/:uuid/email-design", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	if (!whiteLabelActive(project)) return Utils.fail(ctx, ErrorCode.WHITE_LABEL_REQUIRED);

	let data: unknown;
	try {
		data = await ctx.body();
	} catch {
		return Utils.fail(ctx, ErrorCode.INVALID_EMAIL_DESIGN);
	}
	const design = readEmailDesign(data);
	if (!design) return Utils.fail(ctx, ErrorCode.INVALID_EMAIL_DESIGN);

	await Database`UPDATE projects SET email_design = ${JSON.stringify(design)}, updated = ${Date.now()} WHERE uuid = ${project.uuid}`;
	await Audit.record(ctx, {
		project: project.uuid,
		action: "email_design.updated",
		entityType: "project",
		entityId: project.uuid,
		oldValue: parseEmailDesign(project.email_design),
		newValue: design,
	});

	return await okWithNames(ctx, emailDesignState(await reload(project.uuid)));
});

Server.app.post("/api/v1/projects/:uuid/email-design/preview", previewLimit, Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	let data: { design?: unknown; kind?: unknown };
	try {
		data = (await ctx.body()) ?? {};
	} catch {
		return Utils.fail(ctx, ErrorCode.INVALID_EMAIL_DESIGN);
	}
	const design = readEmailDesign(data.design);
	const kind = data.kind ?? "invoice";
	if (!design || !(CUSTOMER_EMAIL_KINDS as readonly unknown[]).includes(kind)) return Utils.fail(ctx, ErrorCode.INVALID_EMAIL_DESIGN);

	const email = await previewEmail(Permissions.project(ctx), design, kind as CustomerEmailKind);
	return await okWithNames(ctx, { subject: email.subject, html: email.html });
});
