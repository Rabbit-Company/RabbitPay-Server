import type { SQL } from "bun";
import type { Dialect } from "./dialect";
import { identifier } from "./dialect";
import { run } from "./schema";
import { schemaTypes } from "./schema-types";

const MEMBER_ROLES_BEFORE = "CHECK (role IN ('owner', 'admin', 'manager', 'accountant', 'developer', 'viewer', 'cashier'))";
const MEMBER_ROLES_AFTER = "CHECK (role IN ('owner', 'admin', 'manager', 'accountant', 'developer', 'viewer', 'cashier', 'supervisor', 'employee'))";
const LICENSE_TYPES_BEFORE = "CHECK (type IN ('transactions', 'white_label', 'storage', 'store'))";
const LICENSE_TYPES_AFTER = "CHECK (type IN ('transactions', 'white_label', 'storage', 'store', 'workforce'))";
export const LICENSE_TYPES_WITH_SEATS = "CHECK (type IN ('transactions', 'white_label', 'storage', 'store', 'workforce', 'employees'))";
const ENTRY_KINDS_BEFORE = "CHECK (kind IN ('regular', 'overtime'))";
const ENTRY_KINDS_AFTER = "CHECK (kind IN ('regular', 'overtime', 'break'))";

export async function rebuildSqliteTable(sql: SQL, table: string, before: string, after: string) {
	const [definition] = (await sql`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}`) as { sql: string }[];
	if (!definition?.sql.includes(before)) throw new Error(`The ${table} table does not have the expected definition`);

	const indexes = (await sql`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ${table} AND sql IS NOT NULL`) as { sql: string }[];
	const columns = ((await sql.unsafe(`PRAGMA table_info(${table})`)) as { name: string }[]).map((column) => column.name).join(", ");
	const next = `${table}_next`;
	const create = definition.sql.replace(before, after).replace(/^CREATE TABLE (?:IF NOT EXISTS )?(?:"\w+"|\w+)/, `CREATE TABLE ${next}`);

	await sql.unsafe(create);
	await sql.unsafe(`INSERT INTO ${next}(${columns}) SELECT ${columns} FROM ${table}`);
	await sql.unsafe(`DROP TABLE ${table}`);
	await sql.unsafe(`ALTER TABLE ${next} RENAME TO ${table}`);
	for (const index of indexes) await sql.unsafe(index.sql);
}

async function checkConstraintNames(sql: SQL, dialect: Dialect, table: string, marker: string): Promise<string[]> {
	if (dialect === "mysql") {
		const rows = (await sql`
			SELECT tc.CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS tc
			JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
			WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = ${table} AND tc.CONSTRAINT_TYPE = 'CHECK' AND cc.CHECK_CLAUSE LIKE ${`%${marker}%`}
		`) as { name: string }[];
		return rows.map((row) => row.name);
	}
	const rows = (await sql`
		SELECT conname AS name FROM pg_constraint
		WHERE conrelid = ${table}::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE ${`%${marker}%`}
	`) as { name: string }[];
	return rows.map((row) => row.name);
}

export async function replaceCheck(sql: SQL, dialect: Dialect, table: string, marker: string, name: string, before: string, after: string) {
	if (dialect === "sqlite") return rebuildSqliteTable(sql, table, before, after);

	const existing = await checkConstraintNames(sql, dialect, table, marker);
	if (existing.length === 0 && dialect !== "mysql") throw new Error(`The ${table} table does not have the expected check constraint`);
	for (const constraint of existing) {
		await sql.unsafe(`ALTER TABLE ${table} DROP ${dialect === "mysql" ? "CHECK" : "CONSTRAINT"} ${identifier(constraint, dialect)}`);
	}
	await sql.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${after}`);
}

async function allowWorkforceRoles(sql: SQL, dialect: Dialect) {
	if (dialect !== "sqlite") {
		return replaceCheck(sql, dialect, "project_members", "cashier", "project_members_role_check", MEMBER_ROLES_BEFORE, MEMBER_ROLES_AFTER);
	}
	await sql`CREATE TABLE member_signature_links AS SELECT uuid, member FROM project_member_signature_versions WHERE member IS NOT NULL`;
	await rebuildSqliteTable(sql, "project_members", MEMBER_ROLES_BEFORE, MEMBER_ROLES_AFTER);
	await sql`
		UPDATE project_member_signature_versions
		SET member = (SELECT links.member FROM member_signature_links links WHERE links.uuid = project_member_signature_versions.uuid)
		WHERE uuid IN (SELECT uuid FROM member_signature_links)
	`;
	await sql`DROP TABLE member_signature_links`;
}

export async function createWorkforceSchema(sql: SQL, dialect: Dialect) {
	const types = schemaTypes(dialect);
	await replaceCheck(sql, dialect, "license_keys", "white_label", "license_keys_type_check", LICENSE_TYPES_BEFORE, LICENSE_TYPES_AFTER);
	await allowWorkforceRoles(sql, dialect);
	await sql.unsafe(`ALTER TABLE projects ADD COLUMN workforce_until ${types.int64}`);
	await run(sql, dialect, [
		`CREATE TABLE IF NOT EXISTS workforce_settings(
					project ${types.text("project")} PRIMARY KEY,
					config ${types.text("config")} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE
				)`,
		`CREATE TABLE IF NOT EXISTS workforce_holidays(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					holiday_date ${types.text("holiday_date")} NOT NULL,
					name ${types.text("name")} NOT NULL,
					created ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					UNIQUE(project, holiday_date)
				)`,
		`CREATE TABLE IF NOT EXISTS employees(
					member ${types.text("member")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					employee_number ${types.text("employee_number")},
					job_title ${types.text("job_title")},
					employment_type ${types.text("employment_type")} NOT NULL DEFAULT 'full_time',
					started_on ${types.text("started_on")},
					ended_on ${types.text("ended_on")},
					weekly_minutes INTEGER NOT NULL DEFAULT 2400,
					vacation_days ${types.float} NOT NULL DEFAULT 20,
					pay_type ${types.text("pay_type")} NOT NULL DEFAULT 'monthly',
					private_data ${types.text("private_data")},
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (member) REFERENCES project_members(uuid) ON DELETE CASCADE,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					CHECK (employment_type IN ('full_time', 'part_time', 'student', 'contractor')),
					CHECK (pay_type IN ('monthly', 'hourly')),
					CHECK (weekly_minutes > 0 AND weekly_minutes <= 4800)
				)`,
		`CREATE INDEX IF NOT EXISTS idx_employees_project ON employees(project)`,
		`CREATE TABLE IF NOT EXISTS leave_balances(
					member ${types.text("member")} NOT NULL,
					year INTEGER NOT NULL,
					entitled_days ${types.float},
					carried_days ${types.float} NOT NULL DEFAULT 0,
					updated ${types.int64} NOT NULL,
					PRIMARY KEY (member, year),
					FOREIGN KEY (member) REFERENCES project_members(uuid) ON DELETE CASCADE
				)`,
		`CREATE TABLE IF NOT EXISTS tickets(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					number INTEGER NOT NULL,
					title ${types.text("title")} NOT NULL,
					description ${types.text("description")},
					kind ${types.text("kind")} NOT NULL DEFAULT 'task',
					status ${types.text("status")} NOT NULL DEFAULT 'open',
					priority ${types.text("priority")} NOT NULL DEFAULT 'normal',
					customer ${types.text("customer")},
					customer_visible ${types.flag} NOT NULL DEFAULT 1 CHECK (customer_visible IN (0, 1)),
					estimate_minutes INTEGER,
					hourly_rate ${types.int64},
					due_on ${types.text("due_on")},
					created_by ${types.text("created_by")},
					reported_by ${types.text("reported_by")},
					closed_at ${types.int64},
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (customer) REFERENCES customers(uuid) ON DELETE SET NULL,
					UNIQUE(project, number),
					CHECK (kind IN ('task', 'bug', 'feature', 'support')),
					CHECK (status IN ('open', 'in_progress', 'waiting', 'resolved', 'closed')),
					CHECK (priority IN ('low', 'normal', 'high', 'urgent'))
				)`,
		`CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project, status, updated)`,
		`CREATE INDEX IF NOT EXISTS idx_tickets_customer ON tickets(customer)`,
		`CREATE TABLE IF NOT EXISTS ticket_assignees(
					ticket ${types.text("ticket")} NOT NULL,
					member ${types.text("member")} NOT NULL,
					created ${types.int64} NOT NULL,
					PRIMARY KEY (ticket, member),
					FOREIGN KEY (ticket) REFERENCES tickets(uuid) ON DELETE CASCADE,
					FOREIGN KEY (member) REFERENCES project_members(uuid) ON DELETE CASCADE
				)`,
		`CREATE INDEX IF NOT EXISTS idx_ticket_assignees_member ON ticket_assignees(member)`,
		`CREATE TABLE IF NOT EXISTS ticket_comments(
					uuid ${types.text("uuid")} PRIMARY KEY,
					ticket ${types.text("ticket")} NOT NULL,
					author ${types.text("author")},
					author_email ${types.text("author_email")},
					author_name ${types.text("author_name")} NOT NULL,
					body ${types.text("body")} NOT NULL,
					internal ${types.flag} NOT NULL DEFAULT 0 CHECK (internal IN (0, 1)),
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (ticket) REFERENCES tickets(uuid) ON DELETE CASCADE,
					FOREIGN KEY (author) REFERENCES accounts(username) ON DELETE SET NULL
				)`,
		`CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket ON ticket_comments(ticket, created)`,
		`CREATE TABLE IF NOT EXISTS ticket_portal_access(
					customer ${types.text("customer")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					kinds ${types.text("kinds")} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (customer) REFERENCES customers(uuid) ON DELETE CASCADE,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE
				)`,
		`CREATE TABLE IF NOT EXISTS time_entries(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					member ${types.text("member")},
					person ${types.text("person")} NOT NULL,
					work_date ${types.text("work_date")} NOT NULL,
					start_minute INTEGER NOT NULL,
					end_minute INTEGER NOT NULL,
					break_minutes INTEGER NOT NULL DEFAULT 0,
					kind ${types.text("kind")} NOT NULL DEFAULT 'regular',
					remote ${types.flag} NOT NULL DEFAULT 0 CHECK (remote IN (0, 1)),
					ticket ${types.text("ticket")},
					note ${types.text("note")},
					invoice ${types.text("invoice")},
					created_by ${types.text("created_by")},
					updated_by ${types.text("updated_by")},
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (member) REFERENCES project_members(uuid) ON DELETE SET NULL,
					FOREIGN KEY (ticket) REFERENCES tickets(uuid) ON DELETE SET NULL,
					FOREIGN KEY (invoice) REFERENCES invoices(uuid) ON DELETE SET NULL,
					CHECK (kind IN ('regular', 'overtime')),
					CHECK (start_minute >= 0 AND start_minute < 1440 AND end_minute > start_minute AND end_minute <= start_minute + 1440),
					CHECK (break_minutes >= 0 AND break_minutes < end_minute - start_minute)
				)`,
		`CREATE INDEX IF NOT EXISTS idx_time_entries_project ON time_entries(project, work_date)`,
		`CREATE INDEX IF NOT EXISTS idx_time_entries_member ON time_entries(member, work_date)`,
		`CREATE INDEX IF NOT EXISTS idx_time_entries_ticket ON time_entries(ticket)`,
		`CREATE TABLE IF NOT EXISTS absences(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					member ${types.text("member")},
					person ${types.text("person")} NOT NULL,
					kind ${types.text("kind")} NOT NULL,
					starts_on ${types.text("starts_on")} NOT NULL,
					ends_on ${types.text("ends_on")} NOT NULL,
					minutes_per_day INTEGER,
					status ${types.text("status")} NOT NULL DEFAULT 'pending',
					note ${types.text("note")},
					decided_by ${types.text("decided_by")},
					decided_at ${types.int64},
					decision_note ${types.text("decision_note")},
					created_by ${types.text("created_by")},
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (member) REFERENCES project_members(uuid) ON DELETE SET NULL,
					CHECK (kind IN ('vacation', 'sick', 'injury', 'paid_leave', 'unpaid', 'parental', 'other')),
					CHECK (status IN ('pending', 'approved', 'rejected', 'canceled')),
					CHECK (ends_on >= starts_on),
					CHECK (minutes_per_day IS NULL OR (minutes_per_day > 0 AND minutes_per_day <= 1440))
				)`,
		`CREATE INDEX IF NOT EXISTS idx_absences_project ON absences(project, starts_on)`,
		`CREATE INDEX IF NOT EXISTS idx_absences_member ON absences(member, starts_on)`,
		`CREATE TABLE IF NOT EXISTS workforce_revisions(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					member ${types.text("member")},
					record_type ${types.text("record_type")} NOT NULL,
					record ${types.text("record")} NOT NULL,
					operation ${types.text("operation")} NOT NULL,
					old_value ${types.text("old_value")},
					new_value ${types.text("new_value")},
					changed_by ${types.text("changed_by")},
					reason ${types.text("reason")},
					created ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (member) REFERENCES project_members(uuid) ON DELETE SET NULL
				)`,
		`CREATE INDEX IF NOT EXISTS idx_workforce_revisions_record ON workforce_revisions(record, created)`,
		`CREATE INDEX IF NOT EXISTS idx_workforce_revisions_member ON workforce_revisions(project, member, created)`,
	]);
}

export async function allowBreakEntries(sql: SQL, dialect: Dialect) {
	await replaceCheck(sql, dialect, "time_entries", "overtime", "time_entries_kind_check", ENTRY_KINDS_BEFORE, ENTRY_KINDS_AFTER);
}

export async function addPriorService(sql: SQL) {
	await sql.unsafe(`ALTER TABLE employees ADD COLUMN prior_service_months INTEGER NOT NULL DEFAULT 0`);
}

export async function addEmployeeWorkforceSettings(sql: SQL, dialect: Dialect) {
	await sql.unsafe(`ALTER TABLE employees ADD COLUMN workforce_settings ${schemaTypes(dialect).text("workforce_settings")}`);
}

export async function addEmployeeSeats(sql: SQL, dialect: Dialect) {
	await replaceCheck(sql, dialect, "license_keys", "white_label", "license_keys_type_check", LICENSE_TYPES_AFTER, LICENSE_TYPES_WITH_SEATS);
	await sql.unsafe(`ALTER TABLE license_keys ADD COLUMN employees INTEGER`);
}

export async function createPayrollSchema(sql: SQL, dialect: Dialect) {
	const types = schemaTypes(dialect);
	await run(sql, dialect, [
		`CREATE TABLE IF NOT EXISTS payroll_rates(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					period ${types.text("period")} NOT NULL,
					config ${types.text("config")} NOT NULL,
					verified_by ${types.text("verified_by")},
					verified_at ${types.int64},
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					UNIQUE(project, period)
				)`,
		`CREATE TABLE IF NOT EXISTS payroll_runs(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					period ${types.text("period")} NOT NULL,
					status ${types.text("status")} NOT NULL DEFAULT 'draft',
					pay_date ${types.text("pay_date")},
					rates_period ${types.text("rates_period")},
					created_by ${types.text("created_by")},
					finalized_by ${types.text("finalized_by")},
					finalized_at ${types.int64},
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					UNIQUE(project, period),
					CHECK (status IN ('draft', 'final'))
				)`,
		`CREATE TABLE IF NOT EXISTS payroll_lines(
					uuid ${types.text("uuid")} PRIMARY KEY,
					run ${types.text("run")} NOT NULL,
					member ${types.text("member")},
					person ${types.text("person")} NOT NULL,
					items ${types.text("items")} NOT NULL,
					calculation ${types.text("calculation")} NOT NULL,
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (run) REFERENCES payroll_runs(uuid) ON DELETE CASCADE,
					FOREIGN KEY (member) REFERENCES project_members(uuid) ON DELETE SET NULL
				)`,
		`CREATE INDEX IF NOT EXISTS idx_payroll_lines_run ON payroll_lines(run)`,
	]);
}
