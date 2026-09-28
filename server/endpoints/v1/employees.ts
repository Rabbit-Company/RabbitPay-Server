import type { Context } from "@rabbit-company/web";
import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { configFor, storedOverrides, workforceConfig } from "../../workforce/config";
import { isMonth, monthRange } from "../../workforce/calendar";
import { findMember, listPeople, personName } from "../../workforce/people";
import { requireWorkforce } from "../../workforce/access";
import { hasEmployeeSeatFor } from "../../licensing";
import { openPrivate, presentEmployee, PrivateDataUnavailable, readEmployee, sealPrivate } from "../../workforce/employees";
import { monthReport } from "../../workforce/reports";
import { payrollLine } from "../../workforce/payroll";
import type { AppState, EmployeeRow } from "../../database/models";

const base = "/api/v1/projects/:uuid";

async function body(ctx: Context<AppState>): Promise<Record<string, unknown> | null> {
	try {
		const value = await ctx.body<Record<string, unknown>>();
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

function withoutPrivate(employee: ReturnType<typeof presentEmployee>) {
	const { private: _, ...rest } = employee;
	return rest;
}

Server.app.get(`${base}/employees`, Auth.required(), Permissions.require(Permission.EMPLOYEE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const people = await listPeople(project.uuid, await workforceConfig(project.uuid));
	const employees = (await Database`SELECT * FROM employees WHERE project = ${project.uuid}`) as EmployeeRow[];
	const byMember = new Map(employees.map((employee) => [employee.member, employee]));
	return Utils.ok(
		ctx,
		people.map((person) => {
			const row = byMember.get(person.member);
			return { ...person, record: row ? presentEmployee(row) : null };
		})
	);
});

Server.app.get(`${base}/employees/:member`, Auth.required(), Permissions.require(Permission.EMPLOYEE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const member = await findMember(project.uuid, ctx.params.member);
	if (!member) return Utils.fail(ctx, ErrorCode.EMPLOYEE_NOT_FOUND);
	const [row] = (await Database`SELECT * FROM employees WHERE member = ${member.uuid}`) as EmployeeRow[];
	return Utils.ok(ctx, { member: member.uuid, name: personName(member), role: member.role, record: row ? presentEmployee(row) : null });
});

Server.app.put(`${base}/employees/:member`, Auth.required(), Permissions.require(Permission.EMPLOYEE_EDIT), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const member = await findMember(project.uuid, ctx.params.member);
	if (!member) return Utils.fail(ctx, ErrorCode.EMPLOYEE_NOT_FOUND);
	const [previous] = (await Database`SELECT * FROM employees WHERE member = ${member.uuid}`) as EmployeeRow[];
	const data = await body(ctx);
	const input = data ? readEmployee(data, previous ?? null) : null;
	if (!input) return Utils.fail(ctx, ErrorCode.INVALID_EMPLOYEE);
	if (!previous && !(await hasEmployeeSeatFor(project.uuid, member.uuid))) return Utils.fail(ctx, ErrorCode.EMPLOYEE_SEATS_EXCEEDED);

	let sealed: string | null;
	try {
		sealed = sealPrivate(input.private);
	} catch (error) {
		if (error instanceof PrivateDataUnavailable) return Utils.fail(ctx, ErrorCode.MASTER_KEY_NOT_CONFIGURED);
		throw error;
	}

	const settings = storedOverrides(input.workforce_settings);
	const now = Date.now();
	if (previous) {
		await Database`
			UPDATE employees SET employee_number = ${input.employee_number}, job_title = ${input.job_title}, employment_type = ${input.employment_type},
				started_on = ${input.started_on}, ended_on = ${input.ended_on}, prior_service_months = ${input.prior_service_months},
				weekly_minutes = ${input.weekly_minutes}, vacation_days = ${input.vacation_days}, pay_type = ${input.pay_type}, private_data = ${sealed},
				workforce_settings = ${settings}, updated = ${now}
			WHERE member = ${member.uuid}
		`;
	} else {
		await Database`
			INSERT INTO employees(member, project, employee_number, job_title, employment_type, started_on, ended_on, prior_service_months, weekly_minutes,
				vacation_days, pay_type, private_data, workforce_settings, created, updated)
			VALUES(${member.uuid}, ${project.uuid}, ${input.employee_number}, ${input.job_title}, ${input.employment_type}, ${input.started_on}, ${input.ended_on},
				${input.prior_service_months}, ${input.weekly_minutes}, ${input.vacation_days}, ${input.pay_type}, ${sealed}, ${settings}, ${now}, ${now})
		`;
	}
	const [row] = (await Database`SELECT * FROM employees WHERE member = ${member.uuid}`) as EmployeeRow[];
	const presented = presentEmployee(row);
	const changedPrivate = Object.keys(input.private).filter(
		(key) =>
			JSON.stringify(input.private[key as keyof typeof input.private]) !== JSON.stringify(openPrivate(previous ?? null)[key as keyof typeof input.private])
	);
	await Audit.record(ctx, {
		project: project.uuid,
		action: previous ? "employee.updated" : "employee.created",
		entityType: "project_member",
		entityId: member.uuid,
		oldValue: previous ? withoutPrivate(presentEmployee(previous)) : undefined,
		newValue: { ...withoutPrivate(presented), private_fields_changed: changedPrivate },
	});
	return Utils.ok(ctx, presented, previous ? 200 : 201);
});

Server.app.delete(
	`${base}/employees/:member`,
	Auth.required(),
	Permissions.require(Permission.EMPLOYEE_EDIT),
	requireWorkforce({ seats: false }),
	async (ctx) => {
		const project = Permissions.project(ctx);
		const [row] = (await Database`SELECT * FROM employees WHERE member = ${ctx.params.member} AND project = ${project.uuid}`) as EmployeeRow[];
		if (!row) return Utils.fail(ctx, ErrorCode.EMPLOYEE_NOT_FOUND);
		await Database`DELETE FROM employees WHERE member = ${row.member}`;
		await Audit.record(ctx, {
			project: project.uuid,
			action: "employee.deleted",
			entityType: "project_member",
			entityId: row.member,
			oldValue: withoutPrivate(presentEmployee(row)),
		});
		return Utils.ok(ctx);
	}
);

Server.app.get(`${base}/payroll`, Auth.required(), Permissions.require(Permission.EMPLOYEE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const month = ctx.query().get("month");
	if (!isMonth(month)) return Utils.fail(ctx, ErrorCode.INVALID_EMPLOYEE);
	const config = await workforceConfig(project.uuid);
	const employees = (await Database`SELECT * FROM employees WHERE project = ${project.uuid}`) as EmployeeRow[];
	const people = (await listPeople(project.uuid, config)).filter((person) => employees.some((employee) => employee.member === person.member));
	const report = await monthReport(project, config, month, people);
	const range = monthRange(month);

	return Utils.ok(ctx, {
		month,
		currency: project.currency,
		lines: report.people.map((person) => {
			const employee = employees.find((row) => row.member === person.member)!;
			return payrollLine(person, range, employee, openPrivate(employee), configFor(config, employee));
		}),
	});
});
