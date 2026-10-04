import { Server } from "../../server";
import Database, { dialect } from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { Permission, ProjectRole } from "../../roles";
import { accountByEmail } from "../../accounts";
import { canEmail } from "../../email/mailer";
import { queueInvitationEmail } from "../../email/messages";
import { readSignature } from "../../member-signature";
import { ensureSignatureAsset } from "../../signature-assets";
import { hasEmployeeSeatFor, workforceActive } from "../../licensing";
import { tracksTime } from "../../workforce/people";
import type { AccountRow, ProjectMemberRow, ProjectRow } from "../../database/models";

interface InviteBody {
	email?: string;
	role?: string;
	notes?: string;
	expires_at?: number | null;
}

interface UpdateMemberBody {
	role?: string;
	expires_at?: number | null;
	notes?: string | null;
}

interface MemberProfileBody {
	full_name?: string;
	signature?: string | null;
}

async function activeOwnerCount(projectId: string): Promise<number> {
	const [row] = (await Database`
		SELECT COUNT(*) AS count FROM project_members WHERE project_id = ${projectId} AND role = 'owner' AND status = 'active'
	`) as { count: number }[];
	return row.count;
}

async function seatAvailable(project: ProjectRow, member: ProjectMemberRow, current: string | null): Promise<boolean> {
	if (!workforceActive(project) || !tracksTime(member)) return true;
	return hasEmployeeSeatFor(project.uuid, current);
}

function isValidExpiry(expiresAt: unknown): boolean {
	if (expiresAt === null || expiresAt === undefined) return true;
	return typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt > Date.now();
}

Server.app.get("/api/v1/projects/:uuid/member-profile", Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const member = Permissions.member(ctx);
	const [signature] = (await Database`
		SELECT asset.data
		FROM project_member_signature_versions version
		JOIN signature_assets asset ON asset.signature_hash = version.signature_hash
		WHERE version.member = ${member.uuid} AND version.valid_until IS NULL
		ORDER BY version.valid_from DESC LIMIT 1
	`) as { data: string }[];

	return Utils.ok(ctx, {
		full_name: member.full_name,
		signature: signature?.data ?? null,
	});
});

Server.app.put("/api/v1/projects/:uuid/member-profile", Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const member = Permissions.member(ctx);
	const actor = Auth.account(ctx);

	let data: MemberProfileBody;
	try {
		data = await ctx.body<MemberProfileBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (!Validate.shortText(data.full_name, 150)) return Utils.fail(ctx, ErrorCode.INVALID_MEMBER_PROFILE);
	const fullName = data.full_name.trim();
	const signature = data.signature === undefined || data.signature === null ? data.signature : await readSignature(data.signature);
	if (data.signature !== undefined && data.signature !== null && signature === null) return Utils.fail(ctx, ErrorCode.INVALID_MEMBER_PROFILE);

	await Database.begin(async (tx) => {
		const timestamp = Date.now();
		await tx`UPDATE project_members SET full_name = ${fullName}, updated = ${timestamp} WHERE uuid = ${member.uuid}`;
		if (signature === null) {
			await tx`
				UPDATE project_member_signature_versions SET valid_until = ${timestamp}
				WHERE member = ${member.uuid} AND valid_until IS NULL
			`;
		}
		if (typeof signature === "string") {
			const hash = await ensureSignatureAsset(tx, dialect, signature, timestamp);
			const [current] = (await tx`
				SELECT uuid, signature_hash FROM project_member_signature_versions
				WHERE member = ${member.uuid} AND valid_until IS NULL
				ORDER BY valid_from DESC LIMIT 1
			`) as { uuid: string; signature_hash: string }[];
			if (current?.signature_hash !== hash) {
				await tx`
					UPDATE project_member_signature_versions SET valid_until = ${timestamp}
					WHERE member = ${member.uuid} AND valid_until IS NULL
				`;
				await tx`
					INSERT INTO project_member_signature_versions(uuid, member, signature_hash, valid_from, valid_until)
					VALUES(${crypto.randomUUID()}, ${member.uuid}, ${hash}, ${timestamp}, ${null})
				`;
			}
		}
	});

	await Audit.record(ctx, {
		project: project.uuid,
		action: "project.member.profile_updated",
		entityType: "project_member",
		entityId: member.uuid,
		oldValue: { full_name: member.full_name },
		newValue: { full_name: fullName, signature_changed: data.signature !== undefined },
	});
	Logger.audit(`[MEMBERS] ${actor.username} updated their invoice identity on ${project.uuid}`);

	return Utils.ok(ctx, { full_name: fullName, signature: typeof signature === "string" ? signature : data.signature === null ? null : undefined });
});

Server.app.post("/api/v1/projects/:uuid/members", Auth.required(), Permissions.require(Permission.PROJECT_MEMBERS), async (ctx) => {
	const project = Permissions.project(ctx);
	const actor = Auth.account(ctx);
	const actorMember = Permissions.member(ctx);

	let data: InviteBody;
	try {
		data = await ctx.body<InviteBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (!Validate.email(data.email)) return Utils.fail(ctx, ErrorCode.INVALID_EMAIL);
	if (!Validate.role(data.role)) return Utils.fail(ctx, ErrorCode.INVALID_ROLE);
	if (!isValidExpiry(data.expires_at)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	const email = data.email!;
	const role = data.role as ProjectRole;

	if (role === ProjectRole.OWNER && actorMember.role !== ProjectRole.OWNER) return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);

	const invitee = await accountByEmail<AccountRow>(Database, email);

	const sameAccount = invitee ? Database`OR account_username = ${invitee.username}` : Database``;
	const existing = (await Database`
		SELECT uuid FROM project_members
		WHERE project_id = ${project.uuid} AND status != 'removed'
			AND (LOWER(invitation_email) = ${email.toLowerCase()} ${sameAccount})
	`) as ProjectMemberRow[];
	if (existing.length > 0) return Utils.fail(ctx, ErrorCode.MEMBER_ALREADY_EXISTS);
	const invited = { role, additional_permissions: null, restricted_permissions: null } as ProjectMemberRow;
	if (!(await seatAvailable(project, invited, null))) return Utils.fail(ctx, ErrorCode.EMPLOYEE_SEATS_EXCEEDED);

	const [removed] = invitee
		? ((await Database`
				SELECT uuid FROM project_members WHERE project_id = ${project.uuid} AND account_username = ${invitee.username} AND status = 'removed'
			`) as Pick<ProjectMemberRow, "uuid">[])
		: [];
	const uuid = removed?.uuid ?? crypto.randomUUID();
	const timestamp = Date.now();
	const invitationToken = invitee ? null : Utils.generateRandomText(64);
	const status = invitee ? "active" : "pending";

	if (removed) {
		await Database`
			UPDATE project_members SET role = ${role}, invited_by = ${actor.username}, invitation_token = NULL, invitation_email = ${email}, status = 'active',
				additional_permissions = NULL, restricted_permissions = NULL, notes = ${data.notes ?? null}, expires_at = ${data.expires_at ?? null},
				accepted_at = ${timestamp}, updated = ${timestamp}
			WHERE uuid = ${removed.uuid}
		`;
	} else {
		await Database`
			INSERT INTO project_members(uuid, project_id, account_username, role, invited_by, invitation_token, invitation_email, status, notes, expires_at, accepted_at, created, updated)
			VALUES(
				${uuid}, ${project.uuid}, ${invitee?.username ?? null}, ${role}, ${actor.username}, ${invitationToken}, ${email}, ${status},
				${data.notes ?? null}, ${data.expires_at ?? null}, ${invitee ? timestamp : null}, ${timestamp}, ${timestamp}
			)
		`;
	}

	await Audit.record(ctx, {
		project: project.uuid,
		action: "project.member.invited",
		entityType: "project_member",
		entityId: uuid,
		newValue: { email, role, status },
	});
	Logger.audit(`[MEMBERS] ${actor.username} invited ${email} to ${project.uuid} as ${role}`);

	let emailQueued = false;
	if (invitationToken && canEmail(project)) {
		const [created] = (await Database`SELECT * FROM project_members WHERE uuid = ${uuid}`) as ProjectMemberRow[];
		try {
			emailQueued = (await queueInvitationEmail(project, created, actor.username)) !== null;
		} catch (err) {
			Logger.error(`[EMAIL] Could not queue the invitation for ${email}: ${err}`);
		}
	}

	return Utils.ok(
		ctx,
		{
			uuid,
			account_username: invitee?.username ?? null,
			invitation_email: email,
			role,
			status,
			invitation_token: invitationToken,
			expires_at: data.expires_at ?? null,
			email_queued: emailQueued,
			created: timestamp,
		},
		201
	);
});

Server.app.patch("/api/v1/projects/:uuid/members/:member", Auth.required(), Permissions.require(Permission.PROJECT_MEMBERS), async (ctx) => {
	const project = Permissions.project(ctx);
	const actorMember = Permissions.member(ctx);
	const actor = Auth.account(ctx);

	const memberId = ctx.params["member"];
	if (!Validate.uuid(memberId)) return Utils.fail(ctx, ErrorCode.INVALID_MEMBER_ID);

	const [target] = (await Database`
		SELECT * FROM project_members WHERE uuid = ${memberId} AND project_id = ${project.uuid} AND status != 'removed'
	`) as ProjectMemberRow[];
	if (!target) return Utils.fail(ctx, ErrorCode.MEMBER_NOT_FOUND);

	if (target.uuid === actorMember.uuid) return Utils.fail(ctx, ErrorCode.CANNOT_MODIFY_OWN_MEMBERSHIP);

	let data: UpdateMemberBody;
	try {
		data = await ctx.body<UpdateMemberBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (data.role === undefined && data.expires_at === undefined && data.notes === undefined) {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (data.role !== undefined) {
		if (!Validate.role(data.role)) return Utils.fail(ctx, ErrorCode.INVALID_ROLE);

		const role = data.role as ProjectRole;
		if ((role === ProjectRole.OWNER || target.role === ProjectRole.OWNER) && actorMember.role !== ProjectRole.OWNER) {
			return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);
		}
		if (target.role === ProjectRole.OWNER && role !== ProjectRole.OWNER && (await activeOwnerCount(project.uuid)) <= 1) {
			return Utils.fail(ctx, ErrorCode.CANNOT_DEMOTE_LAST_OWNER);
		}
	}

	if (data.expires_at !== undefined && !isValidExpiry(data.expires_at)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	const role = data.role ?? target.role;
	if (!(await seatAvailable(project, { ...target, role: role as ProjectRole }, target.uuid))) return Utils.fail(ctx, ErrorCode.EMPLOYEE_SEATS_EXCEEDED);
	const expiresAt = data.expires_at === undefined ? target.expires_at : data.expires_at;
	const notes = data.notes === undefined ? target.notes : data.notes;

	await Database`
		UPDATE project_members SET role = ${role}, expires_at = ${expiresAt}, notes = ${notes}, updated = ${Date.now()} WHERE uuid = ${memberId}
	`;

	const [updated] = (await Database`SELECT * FROM project_members WHERE uuid = ${memberId}`) as ProjectMemberRow[];

	await Audit.record(ctx, {
		project: project.uuid,
		action: "project.member.updated",
		entityType: "project_member",
		entityId: memberId,
		oldValue: { role: target.role, expires_at: target.expires_at },
		newValue: { role: updated.role, expires_at: updated.expires_at },
	});
	Logger.audit(`[MEMBERS] ${actor.username} updated member ${memberId} on ${project.uuid}`);

	return Utils.ok(ctx, updated);
});

Server.app.delete("/api/v1/projects/:uuid/members/:member", Auth.required(), Permissions.require(Permission.PROJECT_MEMBERS), async (ctx) => {
	const project = Permissions.project(ctx);
	const actorMember = Permissions.member(ctx);
	const actor = Auth.account(ctx);

	const memberId = ctx.params["member"];
	if (!Validate.uuid(memberId)) return Utils.fail(ctx, ErrorCode.INVALID_MEMBER_ID);

	const [target] = (await Database`
		SELECT * FROM project_members WHERE uuid = ${memberId} AND project_id = ${project.uuid} AND status != 'removed'
	`) as ProjectMemberRow[];
	if (!target) return Utils.fail(ctx, ErrorCode.MEMBER_NOT_FOUND);

	if (target.uuid === actorMember.uuid) return Utils.fail(ctx, ErrorCode.CANNOT_MODIFY_OWN_MEMBERSHIP);
	if (target.role === ProjectRole.OWNER && actorMember.role !== ProjectRole.OWNER) return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);
	if (target.role === ProjectRole.OWNER && (await activeOwnerCount(project.uuid)) <= 1) return Utils.fail(ctx, ErrorCode.CANNOT_DEMOTE_LAST_OWNER);

	await Database`UPDATE project_members SET status = 'removed', invitation_token = NULL, updated = ${Date.now()} WHERE uuid = ${memberId}`;

	await Audit.record(ctx, {
		project: project.uuid,
		action: "project.member.removed",
		entityType: "project_member",
		entityId: memberId,
		oldValue: { account_username: target.account_username, role: target.role },
	});
	Logger.audit(`[MEMBERS] ${actor.username} removed member ${memberId} from ${project.uuid}`);

	return Utils.ok(ctx);
});
