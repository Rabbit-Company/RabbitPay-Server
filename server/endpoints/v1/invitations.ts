import { rateLimit } from "@rabbit-company/web-middleware/rate-limit";
import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import { accountNames } from "../../accounts";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { ROLE_DESCRIPTIONS, type ProjectRole } from "../../roles";
import { reassignWorkforce } from "../../workforce/people";
import { displayNameOf } from "../../company";
import type { ProjectMemberRow, ProjectRow } from "../../database/models";

const invitationLimit = rateLimit({ windowMs: 60 * 1000, max: 30, message: "Too many requests. Please slow down." });

type Invitation = ProjectMemberRow & Pick<ProjectRow, "name" | "display_name">;

function isInvitationToken(token: string | undefined): token is string {
	return typeof token === "string" && /^[A-Za-z0-9]{64}$/.test(token);
}

async function findInvitation(token: string | undefined): Promise<Invitation | null> {
	if (!isInvitationToken(token)) return null;

	const [invitation] = (await Database`
		SELECT pm.*, p.name, p.display_name FROM project_members pm
		JOIN projects p ON p.uuid = pm.project_id
		WHERE pm.invitation_token = ${token} AND pm.status = 'pending' AND p.status != 'deleted'
	`) as Invitation[];

	return invitation ?? null;
}

async function describe(invitation: Invitation) {
	const role = invitation.role as ProjectRole;
	const inviters = await accountNames([invitation.invited_by], invitation.project_id);
	return {
		project: invitation.project_id,
		project_name: displayNameOf(invitation),
		role,
		role_name: ROLE_DESCRIPTIONS[role]?.name ?? role,
		role_description: ROLE_DESCRIPTIONS[role]?.description ?? "",
		invitation_email: invitation.invitation_email,
		invited_by: inviters.get(invitation.invited_by ?? "") ?? null,
		expired: invitation.expires_at !== null && invitation.expires_at <= Date.now(),
		created: invitation.created,
	};
}

Server.app.get("/api/v1/invitations/:token", invitationLimit, async (ctx) => {
	const invitation = await findInvitation(ctx.params["token"]);
	if (!invitation) return Utils.fail(ctx, ErrorCode.INVITATION_NOT_FOUND);
	return Utils.ok(ctx, await describe(invitation));
});

Server.app.post("/api/v1/invitations/:token/accept", invitationLimit, Auth.required(), async (ctx) => {
	const account = Auth.account(ctx);

	const invitation = await findInvitation(ctx.params["token"]);
	if (!invitation) return Utils.fail(ctx, ErrorCode.INVITATION_NOT_FOUND);
	if (invitation.expires_at !== null && invitation.expires_at <= Date.now()) return Utils.fail(ctx, ErrorCode.INVITATION_NOT_FOUND);

	const [current] = (await Database`
		SELECT uuid, status FROM project_members WHERE project_id = ${invitation.project_id} AND account_username = ${account.username}
	`) as Pick<ProjectMemberRow, "uuid" | "status">[];
	if (current && current.status !== "removed") return Utils.fail(ctx, ErrorCode.MEMBER_ALREADY_EXISTS);

	const timestamp = Date.now();

	await Database.begin(async (tx) => {
		if (current) {
			await reassignWorkforce(tx, current.uuid, invitation.uuid);
			await tx`DELETE FROM project_members WHERE uuid = ${current.uuid}`;
		}
		await tx`
			UPDATE project_members SET account_username = ${account.username}, status = 'active', invitation_token = NULL,
				accepted_at = ${timestamp}, updated = ${timestamp}
			WHERE uuid = ${invitation.uuid}
		`;
	});

	await Audit.record(ctx, {
		project: invitation.project_id,
		action: "project.member.accepted",
		entityType: "project_member",
		entityId: invitation.uuid,
		oldValue: { status: "pending", invitation_email: invitation.invitation_email },
		newValue: { status: "active", account_username: account.username, role: invitation.role },
	});
	Logger.audit(`[MEMBERS] ${account.username} accepted an invitation to ${invitation.project_id} as ${invitation.role}`);

	return Utils.ok(ctx, { ...(await describe(invitation)), account_username: account.username });
});

Server.app.post("/api/v1/invitations/:token/decline", invitationLimit, Auth.required(), async (ctx) => {
	const account = Auth.account(ctx);

	const invitation = await findInvitation(ctx.params["token"]);
	if (!invitation) return Utils.fail(ctx, ErrorCode.INVITATION_NOT_FOUND);

	await Database`
		UPDATE project_members SET status = 'removed', invitation_token = NULL, updated = ${Date.now()} WHERE uuid = ${invitation.uuid}
	`;

	await Audit.record(ctx, {
		project: invitation.project_id,
		action: "project.member.declined",
		entityType: "project_member",
		entityId: invitation.uuid,
		oldValue: { status: "pending", invitation_email: invitation.invitation_email },
		newValue: { status: "removed", declined_by: account.username },
	});
	Logger.audit(`[MEMBERS] ${account.username} declined an invitation to ${invitation.project_id}`);

	return Utils.ok(ctx);
});
