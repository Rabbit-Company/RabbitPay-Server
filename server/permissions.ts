import type { Context, Middleware } from "@rabbit-company/web";
import Database from "./database/database";
import Utils from "./utils";
import Validate from "./validate";
import { ErrorCode } from "./errors";
import { Logger } from "./logger";
import { Permission, ROLE_PERMISSIONS, type ProjectRole } from "./roles";
import type { AppState, ProjectMemberRow, ProjectRow } from "./database/models";

export default class Permissions {
	static resolve(member: ProjectMemberRow): Set<Permission> {
		const effective = new Set<Permission>(ROLE_PERMISSIONS[member.role as ProjectRole] ?? []);

		for (const granted of Permissions.parseList(member.additional_permissions)) effective.add(granted);
		for (const revoked of Permissions.parseList(member.restricted_permissions)) effective.delete(revoked);

		return effective;
	}

	private static parseList(json: string | null): Permission[] {
		if (!json) return [];
		try {
			const parsed = JSON.parse(json);
			return Array.isArray(parsed) ? (parsed.filter((entry) => typeof entry === "string") as Permission[]) : [];
		} catch {
			Logger.warn(`[RBAC] Ignoring malformed permission list: ${json}`);
			return [];
		}
	}

	static has(member: ProjectMemberRow, permission: Permission): boolean {
		return Permissions.resolve(member).has(permission);
	}

	static isActive(member: ProjectMemberRow): boolean {
		if (member.status !== "active") return false;
		if (member.expires_at !== null && member.expires_at <= Date.now()) return false;
		return true;
	}

	static require(permission: Permission): Middleware<AppState> {
		return async (ctx, next) => {
			const account = ctx.get("account");
			if (!account) return Utils.fail(ctx, ErrorCode.BEARER_TOKEN_MISSING);

			const uuid = ctx.params["uuid"];
			if (!Validate.uuid(uuid)) return Utils.fail(ctx, ErrorCode.INVALID_PROJECT);

			const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${uuid} AND status != 'deleted'`) as ProjectRow[];
			if (!project) return Utils.fail(ctx, ErrorCode.PROJECT_NOT_FOUND);

			const [member] = (await Database`
				SELECT * FROM project_members WHERE project_id = ${uuid} AND account_username = ${account.username}
			`) as ProjectMemberRow[];

			if (!member || !Permissions.isActive(member)) {
				await Permissions.log(ctx, uuid, permission, false);
				return Utils.fail(ctx, ErrorCode.NOT_PROJECT_MEMBER);
			}

			if (!Permissions.has(member, permission)) {
				await Permissions.log(ctx, uuid, permission, false);
				return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);
			}

			ctx.set("project", project);
			ctx.set("member", member);

			await Permissions.log(ctx, uuid, permission, true);

			return await next();
		};
	}

	private static async log(ctx: Context<AppState>, projectId: string, permission: Permission, granted: boolean) {
		try {
			const account = ctx.get("account");
			if (!account) return;

			const url = new URL(ctx.req.url);
			const action = `${ctx.req.method} ${url.pathname}`;

			await Database`
				INSERT INTO access_logs(uuid, project_id, account_username, action, permission_checked, granted, ip_address, user_agent, created)
				VALUES(${crypto.randomUUID()}, ${projectId}, ${account.username}, ${action}, ${permission},
					${granted ? 1 : 0}, ${Utils.clientIp(ctx)}, ${Utils.userAgent(ctx)}, ${Date.now()})
			`;
		} catch (err) {
			Logger.error(`[RBAC] Failed to write access log: ${err}`);
		}
	}

	static project(ctx: Context<AppState>): ProjectRow {
		const project = ctx.get("project");
		if (!project) throw new Error("Permissions.project() used outside a project scoped route");
		return project;
	}

	static member(ctx: Context<AppState>): ProjectMemberRow {
		const member = ctx.get("member");
		if (!member) throw new Error("Permissions.member() used outside a project scoped route");
		return member;
	}
}
