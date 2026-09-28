import type { Context, Middleware } from "@rabbit-company/web";
import Permissions from "../permissions";
import Utils from "../utils";
import { ErrorCode } from "../errors";
import { Permission } from "../roles";
import { workforceActive } from "../licensing";
import { localDate } from "../timezone";
import { findMember } from "./people";
import type { AppState, ProjectMemberRow, ProjectRow } from "../database/models";

export interface WorkforceAccess {
	self: ProjectMemberRow;
	own: boolean;
	view: boolean;
	edit: boolean;
}

export function requireWorkforce(): Middleware<AppState> {
	return async (ctx, next) => {
		if (!workforceActive(Permissions.project(ctx))) return Utils.fail(ctx, ErrorCode.WORKFORCE_LICENSE_REQUIRED);
		return await next();
	};
}

export function accessOf(ctx: Context<AppState>): WorkforceAccess {
	const self = Permissions.member(ctx);
	return {
		self,
		own: Permissions.has(self, Permission.TIMESHEET_OWN),
		view: Permissions.has(self, Permission.TIMESHEET_VIEW),
		edit: Permissions.has(self, Permission.TIMESHEET_EDIT),
	};
}

export function todayIn(project: Pick<ProjectRow, "timezone">): string {
	return localDate(Date.now(), project.timezone);
}

export async function subjectOf(
	ctx: Context<AppState>,
	requested: unknown,
	need: "view" | "edit"
): Promise<ProjectMemberRow | ErrorCode.INSUFFICIENT_PERMISSIONS | ErrorCode.EMPLOYEE_NOT_FOUND> {
	const access = accessOf(ctx);
	if (requested === undefined || requested === null || requested === "" || requested === access.self.uuid) {
		return access.own || access.edit || (need === "view" && access.view) ? access.self : ErrorCode.INSUFFICIENT_PERMISSIONS;
	}
	if (need === "view" ? !access.view : !access.edit) return ErrorCode.INSUFFICIENT_PERMISSIONS;
	const member = await findMember(Permissions.project(ctx).uuid, requested);
	return member ?? ErrorCode.EMPLOYEE_NOT_FOUND;
}
