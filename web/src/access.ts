import { Permission } from "../../server/roles";
import type { Project } from "./api";

export { Permission };

export function can(project: Project, permission: Permission): boolean {
	return project.permissions?.includes(permission) ?? false;
}

export function canAny(project: Project, permissions: Permission[]): boolean {
	return permissions.some((permission) => can(project, permission));
}

export function sellsOnly(project: Project): boolean {
	return can(project, Permission.POS_SELL) && !can(project, Permission.INVOICE_VIEW);
}

export function terminalPath(uuid: string): string {
	return `/projects/${uuid}/pos`;
}

export function worksOnly(project: Project): boolean {
	return can(project, Permission.TIMESHEET_OWN) && !canAny(project, [Permission.INVOICE_VIEW, Permission.PAYMENT_VIEW, Permission.REPORT_VIEW]);
}

export function timesheetPath(uuid: string): string {
	return `/projects/${uuid}/timesheet`;
}
