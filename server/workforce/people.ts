import type { SQL } from "bun";
import Database from "../database/database";
import Permissions from "../permissions";
import { Permission } from "../roles";
import { configFor, type WorkforceConfig } from "./config";
import type { EmployeeRow, ProjectMemberRow } from "../database/models";

export interface Person {
	member: string;
	name: string;
	username: string | null;
	role: string;
	status: ProjectMemberRow["status"];
	daily_minutes: number;
	edit_days: number;
	paid_break_minutes: number;
	employee: Pick<EmployeeRow, "employee_number" | "job_title" | "employment_type" | "started_on" | "ended_on" | "weekly_minutes"> | null;
}

export function membersWithEmail() {
	return Database`SELECT pm.*, a.email AS account_email FROM project_members pm LEFT JOIN accounts a ON a.username = pm.account_username`;
}

export function personName(member: Pick<ProjectMemberRow, "full_name" | "account_email" | "invitation_email">): string {
	return member.full_name?.trim() || member.account_email || member.invitation_email || "";
}

export function dailyMinutesOf(employee: Pick<EmployeeRow, "weekly_minutes"> | null | undefined, config: WorkforceConfig): number {
	return employee ? Math.round(employee.weekly_minutes / 5) : config.daily_minutes;
}

export async function findMember(projectId: string, uuid: unknown): Promise<ProjectMemberRow | null> {
	if (typeof uuid !== "string") return null;
	const [member] = (await Database`
		${membersWithEmail()} WHERE pm.uuid = ${uuid} AND pm.project_id = ${projectId} AND pm.status != 'removed'
	`) as ProjectMemberRow[];
	return member ?? null;
}

export async function employeeOf(memberId: string): Promise<EmployeeRow | null> {
	const [employee] = (await Database`SELECT * FROM employees WHERE member = ${memberId}`) as EmployeeRow[];
	return employee ?? null;
}

export function tracksTime(member: ProjectMemberRow): boolean {
	return Permissions.has(member, Permission.TIMESHEET_OWN);
}

async function workforceMembers(projectId: string): Promise<{ members: ProjectMemberRow[]; byMember: Map<string, EmployeeRow> }> {
	const members = (await Database`
		${membersWithEmail()} WHERE pm.project_id = ${projectId} AND pm.status IN ('active', 'suspended') ORDER BY pm.created ASC
	`) as ProjectMemberRow[];
	const employees = (await Database`SELECT * FROM employees WHERE project = ${projectId}`) as EmployeeRow[];
	const byMember = new Map(employees.map((employee) => [employee.member, employee]));
	return { members: members.filter((member) => byMember.has(member.uuid) || tracksTime(member)), byMember };
}

export async function countedMembers(projectId: string): Promise<Set<string>> {
	return new Set((await workforceMembers(projectId)).members.map((member) => member.uuid));
}

export async function pendingTimeTrackers(projectId: string, except: string | null): Promise<number> {
	const pending = (await Database`SELECT * FROM project_members WHERE project_id = ${projectId} AND status = 'pending'`) as ProjectMemberRow[];
	return pending.filter((member) => member.uuid !== except && tracksTime(member)).length;
}

export async function listPeople(projectId: string, config: WorkforceConfig): Promise<Person[]> {
	const { members, byMember } = await workforceMembers(projectId);

	return members
		.map((member) => {
			const employee = byMember.get(member.uuid) ?? null;
			const rules = configFor(config, employee);
			return {
				member: member.uuid,
				name: personName(member),
				username: member.account_username,
				role: member.role,
				status: member.status,
				daily_minutes: dailyMinutesOf(employee, config),
				edit_days: rules.edit_days,
				paid_break_minutes: rules.paid_break_minutes,
				employee: employee
					? {
							employee_number: employee.employee_number,
							job_title: employee.job_title,
							employment_type: employee.employment_type,
							started_on: employee.started_on,
							ended_on: employee.ended_on,
							weekly_minutes: employee.weekly_minutes,
						}
					: null,
			};
		})
		.sort((first, second) => first.name.localeCompare(second.name));
}

export async function reassignWorkforce(sql: SQL, from: string, to: string) {
	await sql`UPDATE time_entries SET member = ${to} WHERE member = ${from}`;
	await sql`UPDATE absences SET member = ${to} WHERE member = ${from}`;
	await sql`UPDATE workforce_revisions SET member = ${to} WHERE member = ${from}`;
	await sql`UPDATE employees SET member = ${to} WHERE member = ${from}`;
	await sql`UPDATE leave_balances SET member = ${to} WHERE member = ${from}`;
	await sql`UPDATE ticket_assignees SET member = ${to} WHERE member = ${from}`;
	await sql`UPDATE payroll_lines SET member = ${to} WHERE member = ${from}`;
}
