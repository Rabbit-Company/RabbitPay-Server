import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { prepareTest } from "./environment";

await prepareTest();

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { Settings } = await import("../server/settings");
const { setTransport } = await import("../server/email/mailer");
const { default: Auth } = await import("../server/auth");
const { generateLicenseCode, hasStorageCapacity } = await import("../server/licensing");
const { discardAbandonedUploads } = await import("../server/files");
const { localDate } = await import("../server/timezone");
const { addDays, easterSunday, nationalHolidays } = await import("../server/workforce/holidays");
const { DEFAULT_WORKFORCE_CONFIG } = await import("../server/workforce/config");
const { payrollLine, serviceSpan } = await import("../server/workforce/payroll");
const { netPay, SLOVENIA_PRESETS } = await import("../server/workforce/net-pay");
const SLOVENIA_PRESET = SLOVENIA_PRESETS.find((preset) => preset.period === "2025-07")!;
const { join } = await import("node:path");
const { mkdtempSync, writeFileSync } = await import("node:fs");
const xmllint = Bun.which("xmllint");
const scratch = mkdtempSync("/tmp/rabbitpay-payroll-");

function schemaErrors(schema: string, xml: string): string {
	const file = join(scratch, `${crypto.randomUUID()}.xml`);
	writeFileSync(file, xml);
	const result = Bun.spawnSync([xmllint!, "--nonet", "--noout", "--schema", join(import.meta.dir, "fixtures", schema), file]);
	return result.exitCode === 0 ? "" : result.stderr.toString();
}

async function download(path: string, token: string): Promise<{ status: number; type: string | null; text: string }> {
	const response = await Server.app.handle(new Request(`http://127.0.0.1/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` } }));
	return { status: response.status, type: response.headers.get("Content-Type"), text: await response.text() };
}

interface Result {
	status: number;
	error: number;
	info: string;
	data: any;
}

async function call(method: string, path: string, token?: string, body?: unknown): Promise<Result> {
	const headers: Record<string, string> = {};
	if (token) headers.Authorization = `Bearer ${token}`;
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const response = await Server.app.handle(
		new Request(`http://127.0.0.1/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
	);
	const text = await response.text();
	try {
		return { status: response.status, ...(JSON.parse(text) as Omit<Result, "status">) };
	} catch {
		return { status: response.status, error: -1, info: text, data: text };
	}
}

const messages: { to: string; text: string }[] = [];
const tokens = { owner: "", supervisor: "", employee: "", colleague: "" };
const members = { owner: "", supervisor: "", employee: "", colleague: "" };
let project = "";
let customer = "";
let today = "";

const base = () => `/projects/${project}`;

async function account(username: string): Promise<string> {
	const now = Date.now();
	await Database`INSERT INTO accounts(username, email, password, created, updated, accessed) VALUES(${username}, ${`${username}@team.test`}, 'unused', ${now}, ${now}, ${now})`;
	return (await Auth.createSession(username, ""))!;
}

async function member(username: string, role: string, fullName: string): Promise<string> {
	const uuid = crypto.randomUUID();
	const now = Date.now();
	await Database`
		INSERT INTO project_members(uuid, project_id, account_username, role, status, full_name, created, updated)
		VALUES(${uuid}, ${project}, ${username}, ${role}, 'active', ${fullName}, ${now}, ${now})
	`;
	return uuid;
}

async function customerLogin(email: string): Promise<string> {
	const request = await call("POST", "/customer/auth/request", undefined, { email });
	expect(request.error).toBe(0);
	const token = messages.at(-1)!.text.match(/#token=([A-Za-z0-9]{128})/)![1];
	const verified = await call("POST", "/customer/auth/verify", undefined, { token });
	expect(verified.error).toBe(0);
	return verified.data.token;
}

function entry(date: string, start: string, end: string, extra: Record<string, unknown> = {}) {
	return { work_date: date, start, end, break_minutes: 30, reason: "Test time entry", ...extra };
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await Server.configure();
	Settings.email.enabled = true;
	setTransport({
		sendMail: async (message: (typeof messages)[number]) => {
			messages.push(message);
			return { messageId: "workforce-test" };
		},
	} as never);

	tokens.owner = await account("wf-owner");
	tokens.supervisor = await account("wf-super");
	tokens.employee = await account("wf-employee");
	tokens.colleague = await account("wf-colleague");
	project = (await call("POST", "/projects", tokens.owner, { name: "workforce-co", currency: "EUR" })).data.uuid;
	await Database`UPDATE projects SET tax_country = 'SI' WHERE uuid = ${project}`;
	const [owner] = await Database`SELECT uuid FROM project_members WHERE project_id = ${project} AND account_username = 'wf-owner'`;
	members.owner = owner.uuid;
	members.supervisor = await member("wf-super", "supervisor", "Sara Supervisor");
	members.employee = await member("wf-employee", "employee", "Eva Employee");
	members.colleague = await member("wf-colleague", "employee", "Cene Colleague");
	customer = crypto.randomUUID();
	const now = Date.now();
	await Database`INSERT INTO customers(uuid, project, name, email, created, updated) VALUES(${customer}, ${project}, 'Acme d.o.o.', 'client@acme.test', ${now}, ${now})`;
	const [row] = await Database`SELECT timezone FROM projects WHERE uuid = ${project}`;
	today = localDate(Date.now(), row.timezone);
});

afterAll(async () => {
	await Database.close();
});

describe("Slovenian holidays", () => {
	test("finds Easter for known years", () => {
		expect(easterSunday(2024)).toEqual({ month: 3, day: 31 });
		expect(easterSunday(2025)).toEqual({ month: 4, day: 20 });
		expect(easterSunday(2026)).toEqual({ month: 4, day: 5 });
		expect(easterSunday(2027)).toEqual({ month: 3, day: 28 });
	});

	test("lists the work-free days and the commemorative days", () => {
		const holidays = nationalHolidays("SI", 2026);
		const workFree = holidays.filter((holiday) => holiday.work_free).map((holiday) => holiday.date);
		expect(workFree).toEqual([
			"2026-01-01",
			"2026-01-02",
			"2026-02-08",
			"2026-04-05",
			"2026-04-06",
			"2026-04-27",
			"2026-05-01",
			"2026-05-02",
			"2026-05-24",
			"2026-06-25",
			"2026-08-15",
			"2026-10-31",
			"2026-11-01",
			"2026-12-25",
			"2026-12-26",
		]);
		expect(holidays.find((holiday) => holiday.date === "2026-06-08")).toMatchObject({ work_free: false });
		expect(holidays.find((holiday) => holiday.date === "2026-11-23")?.name.sl).toBe("Dan Rudolfa Maistra");
		expect(nationalHolidays("DE", 2026)).toEqual([]);
	});
});

describe("the workforce module", () => {
	test("is locked until a workforce license is redeemed", async () => {
		const state = await call("GET", `${base()}/workforce`, tokens.employee);
		expect(state.error).toBe(0);
		expect(state.data.license.active).toBe(false);
		expect(state.data.me).toMatchObject({ own: true, view: false, edit: false, name: "Eva Employee" });

		const blocked = await call("POST", `${base()}/timesheets`, tokens.employee, entry(today, "08:00", "16:00"));
		expect(blocked.status).toBe(402);
		expect(blocked.error).toBe(1189);

		const code = generateLicenseCode();
		const now = Date.now();
		await Database`INSERT INTO license_keys(uuid, code, type, duration_days, status, created, updated)
			VALUES(${crypto.randomUUID()}, ${code}, 'workforce', 365, 'available', ${now}, ${now})`;
		const redeemed = await call("POST", `${base()}/license/redeem`, tokens.owner, { code });
		expect(redeemed.error).toBe(0);
		expect(redeemed.data.workforce).toBe(true);
		expect(redeemed.data.workforce_until).toBeGreaterThan(Date.now() + 364 * 86400000);
	});

	test("lets the admin create workforce license keys", async () => {
		await Database`UPDATE accounts SET admin = 1 WHERE username = 'wf-owner'`;
		const created = await call("POST", "/admin/licenses", tokens.owner, { type: "workforce", duration_days: 30 });
		expect(created.error).toBe(0);
		expect(created.data[0]).toMatchObject({ type: "workforce", duration_days: 30 });
		const invalid = await call("POST", "/admin/licenses", tokens.owner, { type: "workforce" });
		expect(invalid.error).toBe(1095);
		await Database`UPDATE accounts SET admin = 0 WHERE username = 'wf-owner'`;
	});

	test("employees can correct older time when they provide a reason", async () => {
		const logged = await call("POST", `${base()}/timesheets`, tokens.employee, entry(today, "08:00", "16:00", { note: "Support desk", reason: null }));
		expect(logged.status).toBe(201);
		expect(logged.data).toMatchObject({ member: members.employee, person: "Eva Employee", worked_minutes: 480, start: "08:00", end: "16:00" });

		const yesterday = await call("POST", `${base()}/timesheets`, tokens.employee, entry(addDays(today, -1), "09:00", "17:00", { reason: null }));
		expect(yesterday.status).toBe(201);

		const older = await call("POST", `${base()}/timesheets`, tokens.employee, entry(addDays(today, -3), "09:00", "17:00", { reason: null }));
		expect(older.error).toBe(1299);
		const corrected = await call(
			"POST",
			`${base()}/timesheets`,
			tokens.employee,
			entry(addDays(today, -3), "09:00", "17:00", { reason: "Forgot to record this day" })
		);
		expect(corrected.status).toBe(201);
		const future = await call("POST", `${base()}/timesheets`, tokens.employee, entry(addDays(today, 1), "09:00", "17:00"));
		expect(future.error).toBe(1193);

		const overlapping = await call("POST", `${base()}/timesheets`, tokens.employee, entry(today, "15:00", "18:00"));
		expect(overlapping.error).toBe(1192);
		const invalid = await call("POST", `${base()}/timesheets`, tokens.employee, entry(today, "18:00", "18:30", { break_minutes: 45 }));
		expect(invalid.error).toBe(1190);

		const forSomeoneElse = await call("POST", `${base()}/timesheets`, tokens.employee, { ...entry(today, "08:00", "16:00"), member: members.colleague });
		expect(forSomeoneElse.error).toBe(9999);
		const othersSheet = await call("GET", `${base()}/timesheets?from=${today}&to=${today}&member=${members.colleague}`, tokens.employee);
		expect(othersSheet.error).toBe(9999);
		const everyone = await call("GET", `${base()}/timesheets?from=${today}&to=${today}&member=all`, tokens.employee);
		expect(everyone.error).toBe(9999);

		const mine = await call("GET", `${base()}/timesheets?from=${addDays(today, -7)}&to=${today}`, tokens.employee);
		expect(mine.error).toBe(0);
		expect(mine.data.entries).toHaveLength(3);
		expect(mine.data.edit_days).toBe(1);
		expect((await call("DELETE", `${base()}/timesheets/${corrected.data.uuid}?reason=Test%20cleanup`, tokens.employee)).error).toBe(0);
	});

	test("timesheet months are submitted, reviewed, locked and reopened", async () => {
		const date = "2025-02-10";
		const period = date.slice(0, 7);
		const logged = await call("POST", `${base()}/timesheets`, tokens.supervisor, {
			...entry(date, "08:00", "16:00"),
			member: members.employee,
			reason: "Historical correction",
		});
		expect(logged.error).toBe(0);
		const sheet = await call("GET", `${base()}/timesheets?from=${date}&to=${date}`, tokens.employee);
		expect(sheet.data.periods).toEqual([expect.objectContaining({ member: members.employee, period, status: "draft", submitted_at: null, decided_at: null })]);

		const draftDecision = await call("POST", `${base()}/timesheets/periods/${period}/decision`, tokens.supervisor, {
			member: members.employee,
			status: "approved",
			note: null,
		});
		expect(draftDecision.error).toBe(1298);

		const submitted = await call("POST", `${base()}/timesheets/periods/${period}/submit`, tokens.employee, {});
		expect(submitted.data).toMatchObject({ member: members.employee, period, status: "submitted", submitted_by: "wf-employee" });
		expect(submitted.data.submitted_at).toBeGreaterThan(0);
		expect((await call("POST", `${base()}/timesheets/periods/${period}/submit`, tokens.employee, {})).error).toBe(1298);
		expect((await call("PATCH", `${base()}/timesheets/${logged.data.uuid}`, tokens.supervisor, { note: "Should stay locked" })).error).toBe(1297);
		expect(
			(
				await call("POST", `${base()}/timesheets/periods/${period}/decision`, tokens.supervisor, {
					member: members.employee,
					status: "returned",
					note: null,
				})
			).error
		).toBe(1296);

		const returned = await call("POST", `${base()}/timesheets/periods/${period}/decision`, tokens.supervisor, {
			member: members.employee,
			status: "returned",
			note: "Add the customer reference",
		});
		expect(returned.data).toMatchObject({
			status: "returned",
			note: "Add the customer reference",
			decided_by: "wf-super",
			decided_by_name: "Sara Supervisor",
		});
		expect(
			(
				await call("PATCH", `${base()}/timesheets/${logged.data.uuid}`, tokens.employee, {
					note: "Support desk corrected",
					reason: "Added the requested customer reference",
				})
			).error
		).toBe(0);

		expect((await call("POST", `${base()}/timesheets/periods/${period}/submit`, tokens.employee, {})).data.status).toBe("submitted");
		const approved = await call("POST", `${base()}/timesheets/periods/${period}/decision`, tokens.supervisor, {
			member: members.employee,
			status: "approved",
			note: null,
		});
		expect(approved.data).toMatchObject({ status: "approved", decided_by: "wf-super" });
		expect((await call("PUT", `${base()}/timesheets/day`, tokens.supervisor, { member: members.employee, work_date: date, entries: [] })).error).toBe(1297);

		const report = await call("GET", `${base()}/timesheets/report?month=${period}&member=${members.employee}`, tokens.supervisor);
		expect(report.data.people[0].approval).toMatchObject({ status: "approved", member: members.employee, period });
		expect((await call("POST", `${base()}/timesheets/periods/${period}/reopen`, tokens.employee, { member: members.employee, note: "No" })).error).toBe(9999);
		const reopened = await call("POST", `${base()}/timesheets/periods/${period}/reopen`, tokens.supervisor, {
			member: members.employee,
			note: "Payroll correction requested",
		});
		expect(reopened.data).toMatchObject({ status: "draft", note: "Payroll correction requested", decided_by: "wf-super" });
		expect(
			(
				await call("PATCH", `${base()}/timesheets/${logged.data.uuid}`, tokens.supervisor, {
					note: "Support desk",
					reason: "Remove the temporary customer reference",
				})
			).error
		).toBe(0);
		expect((await call("DELETE", `${base()}/timesheets/${logged.data.uuid}?reason=Test%20cleanup`, tokens.supervisor)).error).toBe(0);
		const approvalAudit = (await Database`
			SELECT action FROM audit_log WHERE project = ${project} AND entity_type = 'timesheet_period' ORDER BY created ASC
		`) as { action: string }[];
		expect(approvalAudit.map((row) => row.action)).toEqual([
			"timesheet.submitted",
			"timesheet.returned",
			"timesheet.submitted",
			"timesheet.approved",
			"timesheet.reopened",
		]);
	});

	test("paid availability is separate from ticket work and formal waiting at home is supervisor controlled", async () => {
		const denied = await call(
			"POST",
			`${base()}/timesheets`,
			tokens.employee,
			entry(today, "17:00", "18:00", { break_minutes: 0, activity: "waiting_home", remote: true })
		);
		expect(denied.error).toBe(9999);

		const date = "2025-08-12";
		const saved = await call("PUT", `${base()}/timesheets/day`, tokens.supervisor, {
			member: members.colleague,
			work_date: date,
			entries: [
				{ start: "08:00", end: "12:00", kind: "regular", activity: "available", remote: false, ticket: null, note: "No assigned work" },
				{ start: "12:00", end: "16:00", kind: "regular", activity: "waiting_home", remote: true, ticket: null, note: "Employer order" },
			],
			reason: "Record paid availability separately",
		});
		expect(saved.error).toBe(0);
		const remoteDate = "2025-08-13";
		const remoteOnly = await call("POST", `${base()}/timesheets`, tokens.supervisor, {
			...entry(remoteDate, "08:00", "16:00", { break_minutes: 0, activity: "available", remote: true }),
			member: members.colleague,
		});
		expect(remoteOnly.error).toBe(0);

		const report = await call("GET", `${base()}/timesheets/report?month=2025-08&member=${members.colleague}`, tokens.supervisor);
		expect(report.error).toBe(0);
		expect(report.data.people[0].totals).toMatchObject({
			worked_minutes: 960,
			onsite_minutes: 240,
			activity_minutes: { available: 720, waiting_home: 240 },
			days_worked: 2,
			commute_days: 1,
		});
		const line = payrollLine(
			report.data.people[0],
			{ from: "2025-08-01", to: "2025-08-31" },
			{ employment_type: "full_time", pay_type: "hourly" },
			{ salary: 6000, commute_per_day: 500 },
			DEFAULT_WORKFORCE_CONFIG
		);
		expect(line.minutes).toMatchObject({ worked: 720, waiting_home: 240 });
		expect(line.amounts).toMatchObject({ regular: 72000, waiting_home: 19200, commute: 500 });
		await Database`DELETE FROM time_entries WHERE member = ${members.colleague} AND work_date IN (${date}, ${remoteDate})`;
	});

	test("supervisors correct anyone's timesheet on any date and every change is kept", async () => {
		const back = addDays(today, -10);
		const created = await call("POST", `${base()}/timesheets`, tokens.supervisor, {
			...entry(back, "08:00", "12:00", { break_minutes: 0 }),
			member: members.employee,
			reason: "Forgot to log",
		});
		expect(created.status).toBe(201);
		const planned = await call("POST", `${base()}/timesheets`, tokens.supervisor, {
			...entry(addDays(today, 5), "08:00", "12:00", { break_minutes: 0 }),
			member: members.employee,
		});
		expect(planned.status).toBe(201);

		const blocked = await call("PATCH", `${base()}/timesheets/${created.data.uuid}`, tokens.employee, { end: "13:00" });
		expect(blocked.error).toBe(1299);
		const corrected = await call("PATCH", `${base()}/timesheets/${created.data.uuid}`, tokens.supervisor, { end: "13:00", reason: "Stayed longer" });
		expect(corrected.error).toBe(0);
		expect(corrected.data.worked_minutes).toBe(300);

		const removed = await call("DELETE", `${base()}/timesheets/${planned.data.uuid}?reason=Plan%20changed`, tokens.supervisor);
		expect(removed.error).toBe(0);

		const revisions = await call("GET", `${base()}/workforce/revisions?record=${created.data.uuid}`, tokens.employee);
		expect(revisions.error).toBe(0);
		expect(revisions.data.revisions.map((revision: { operation: string }) => revision.operation)).toEqual(["updated", "created"]);
		expect(revisions.data.revisions[0]).toMatchObject({ changed_by: "wf-super", changed_by_name: "Sara Supervisor", reason: "Stayed longer" });
		expect(revisions.data.revisions[0].old_value.end).toBe("12:00");

		const all = await call("GET", `${base()}/workforce/revisions?member=${members.employee}`, tokens.supervisor);
		expect(
			all.data.revisions.some((revision: { operation: string; reason: string }) => revision.operation === "deleted" && revision.reason === "Plan changed")
		).toBe(true);
	});

	test("a whole day is saved at once with breaks as their own rows", async () => {
		const day = "2025-06-10";
		const saveDay = (token: string, entries: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
			call("PUT", `${base()}/timesheets/day`, token, {
				member: members.colleague,
				work_date: day,
				entries,
				reason: "Historical test correction",
				...extra,
			});

		const first = await saveDay(tokens.supervisor, [
			{ start: "07:00", end: "08:30", kind: "regular" },
			{ start: "08:30", end: "09:00", kind: "break", ticket: null, remote: true },
			{ start: "09:00", end: "15:00", kind: "regular" },
			{ start: "15:00", end: "17:00", kind: "overtime", note: "Release" },
		]);
		expect(first.error).toBe(0);
		expect(first.data.entries.map((entry: { kind: string; worked_minutes: number }) => [entry.kind, entry.worked_minutes])).toEqual([
			["regular", 90],
			["break", 30],
			["regular", 360],
			["overtime", 120],
		]);
		expect(first.data.entries[1]).toMatchObject({ remote: false, break_minutes: 0 });

		const [morning, lunch, afternoon, late] = first.data.entries;
		const second = await saveDay(
			tokens.supervisor,
			[
				{ uuid: morning.uuid, start: "07:00", end: "08:30", kind: "regular" },
				{ uuid: lunch.uuid, start: "08:30", end: "09:15", kind: "break" },
				{ start: "11:00", end: "11:15", kind: "break" },
				{ uuid: afternoon.uuid, start: "09:15", end: "11:00", kind: "regular" },
			],
			{ reason: "Longer lunch" }
		);
		expect(second.error).toBe(0);
		expect(second.data.entries.map((entry: { start: string; worked_minutes: number }) => [entry.start, entry.worked_minutes])).toEqual([
			["07:00", 90],
			["08:30", 30],
			["09:15", 105],
			["11:00", 0],
		]);
		expect(second.data.entries.some((entry: { uuid: string }) => entry.uuid === late.uuid)).toBe(false);

		const revisions = await call("GET", `${base()}/workforce/revisions?member=${members.colleague}`, tokens.supervisor);
		const latest = revisions.data.revisions.filter((revision: { reason: string | null }) => revision.reason === "Longer lunch");
		expect(latest.map((revision: { operation: string }) => revision.operation).sort()).toEqual(["created", "deleted", "updated", "updated"]);

		const report = await call("GET", `${base()}/timesheets/report?month=2025-06&member=${members.colleague}`, tokens.supervisor);
		const reported = report.data.people[0].days.find((entry: { date: string }) => entry.date === day);
		expect(reported).toMatchObject({ worked_minutes: 225, break_minutes: 60, entries: 2 });

		const overlapping = await saveDay(tokens.supervisor, [
			{ start: "08:00", end: "12:00" },
			{ start: "10:00", end: "10:30", kind: "break" },
		]);
		expect(overlapping.error).toBe(1192);
		const unknownKind = await saveDay(tokens.supervisor, [{ start: "08:00", end: "12:00", kind: "lunch" }]);
		expect(unknownKind.error).toBe(1190);
		const unknown = await saveDay(tokens.supervisor, [{ uuid: crypto.randomUUID(), start: "08:00", end: "12:00" }]);
		expect(unknown.error).toBe(1191);

		const missingReason = await call("PUT", `${base()}/timesheets/day`, tokens.colleague, {
			member: members.colleague,
			work_date: day,
			entries: [{ start: "08:00", end: "12:00" }],
		});
		expect(missingReason.error).toBe(1299);
		const correctedByEmployee = await saveDay(tokens.colleague, [{ start: "08:00", end: "12:00" }], { reason: "Correct my old work day" });
		expect(correctedByEmployee.error).toBe(0);
		const foreign = await call("PUT", `${base()}/timesheets/day`, tokens.employee, { member: members.colleague, work_date: today, entries: [] });
		expect(foreign.error).toBe(9999);

		const night = await call("PUT", `${base()}/timesheets/day`, tokens.supervisor, {
			member: members.colleague,
			work_date: "2025-06-12",
			entries: [{ start: "22:00", end: "06:00" }],
			reason: "Historical overnight entry",
		});
		expect(night.data.entries[0]).toMatchObject({ overnight: true, worked_minutes: 480 });
		const intoNight = await call("PUT", `${base()}/timesheets/day`, tokens.supervisor, {
			member: members.colleague,
			work_date: "2025-06-13",
			entries: [{ start: "05:00", end: "08:00" }],
			reason: "Historical overlapping entry",
		});
		expect(intoNight.error).toBe(1192);

		const cleared = await saveDay(tokens.supervisor, []);
		expect(cleared.error).toBe(0);
		expect(cleared.data.entries).toHaveLength(0);
		const nightCleared = await call("PUT", `${base()}/timesheets/day`, tokens.supervisor, {
			member: members.colleague,
			work_date: "2025-06-12",
			entries: [],
			reason: "Historical test cleanup",
		});
		expect(nightCleared.data.entries).toHaveLength(0);
	});

	test("supervisors fill empty working days with normal hours and a lunch break", async () => {
		const fill = (token: string, extra: Record<string, unknown> = {}) =>
			call("POST", `${base()}/timesheets/fill`, token, {
				member: members.colleague,
				from: "2025-12-01",
				to: "2025-12-31",
				start: "08:00",
				break_start: "12:00",
				reason: "Timesheet was not kept",
				...extra,
			});
		expect((await fill(tokens.colleague)).error).toBe(9999);
		expect((await fill(tokens.supervisor, { break_start: "15:50" })).error).toBe(1190);
		expect((await fill(tokens.supervisor, { to: "2026-03-31" })).error).toBe(1190);

		const logged = await call("PUT", `${base()}/timesheets/day`, tokens.supervisor, {
			member: members.colleague,
			work_date: "2025-12-01",
			entries: [{ start: "09:00", end: "13:00" }],
			reason: "Existing historical work entry",
		});
		expect(logged.error).toBe(0);
		const now = Date.now();
		const absence = crypto.randomUUID();
		await Database`
			INSERT INTO absences(uuid, project, member, person, kind, starts_on, ends_on, status, created, updated)
			VALUES(${absence}, ${project}, ${members.colleague}, 'Cene Colleague', 'vacation', '2025-12-29', '2025-12-31', 'approved', ${now}, ${now})
		`;

		const filled = await fill(tokens.supervisor);
		expect(filled.error).toBe(0);
		expect(filled.data.filled).toBe(21 - 1 - 3);
		expect(filled.data.skipped).toEqual({ absent: 3, logged: 1, not_employed: 0 });
		expect(filled.data.days).not.toContain("2025-12-25");
		expect(filled.data.days).not.toContain("2025-12-06");

		const sheet = await call("GET", `${base()}/timesheets?from=2025-12-02&to=2025-12-02&member=${members.colleague}`, tokens.supervisor);
		expect(
			sheet.data.entries.map((entry: { start: string; end: string; kind: string; worked_minutes: number }) => [
				entry.start,
				entry.end,
				entry.kind,
				entry.worked_minutes,
			])
		).toEqual([
			["08:00", "12:00", "regular", 240],
			["12:00", "12:30", "break", 30],
			["12:30", "16:00", "regular", 210],
		]);
		const history = await call("GET", `${base()}/workforce/revisions?member=${members.colleague}&limit=5`, tokens.supervisor);
		expect(history.data.revisions[0]).toMatchObject({ operation: "created", changed_by: "wf-super", reason: "Timesheet was not kept" });

		const again = await fill(tokens.supervisor);
		expect(again.data.filled).toBe(0);

		await Database`DELETE FROM time_entries WHERE member = ${members.colleague} AND work_date >= '2025-12-01' AND work_date <= '2025-12-31'`;
		await Database`DELETE FROM absences WHERE uuid = ${absence}`;
	});

	test("the supervisor controls when a correction reason becomes mandatory", async () => {
		const settings = await call("GET", `${base()}/workforce`, tokens.supervisor);
		expect(settings.data.people.map((person: { name: string }) => person.name)).toEqual(
			expect.arrayContaining(["Eva Employee", "Cene Colleague", "Sara Supervisor"])
		);
		const denied = await call("PUT", `${base()}/workforce/settings`, tokens.employee, { ...settings.data.config, edit_days: 7 });
		expect(denied.error).toBe(9999);
		const invalid = await call("PUT", `${base()}/workforce/settings`, tokens.supervisor, { ...settings.data.config, edit_days: -1 });
		expect(invalid.error).toBe(1197);
		const saved = await call("PUT", `${base()}/workforce/settings`, tokens.supervisor, { ...settings.data.config, edit_days: 7 });
		expect(saved.error).toBe(0);

		const older = await call("POST", `${base()}/timesheets`, tokens.employee, entry(addDays(today, -3), "09:00", "17:00", { reason: null }));
		expect(older.status).toBe(201);
		await call("PUT", `${base()}/workforce/settings`, tokens.supervisor, { ...settings.data.config, edit_days: 1 });
		const locked = await call("DELETE", `${base()}/timesheets/${older.data.uuid}`, tokens.employee);
		expect(locked.error).toBe(1299);
		const removed = await call("DELETE", `${base()}/timesheets/${older.data.uuid}?reason=Incorrect%20day`, tokens.employee);
		expect(removed.error).toBe(0);
		const history = await call("GET", `${base()}/workforce/revisions?member=${members.employee}&record=${older.data.uuid}`, tokens.supervisor);
		expect(history.data.revisions[0]).toMatchObject({ operation: "deleted", changed_by: "wf-employee", reason: "Incorrect day" });
	});

	test("absences are requested by employees and decided by supervisors", async () => {
		const request = await call("POST", `${base()}/absences`, tokens.employee, { kind: "vacation", starts_on: "2026-12-21", ends_on: "2026-12-31" });
		expect(request.status).toBe(201);
		expect(request.data.status).toBe("pending");
		expect(request.data.working_days).toBe(8);

		const overlapping = await call("POST", `${base()}/absences`, tokens.employee, { kind: "sick", starts_on: "2026-12-30", ends_on: "2027-01-04" });
		expect(overlapping.error).toBe(1212);
		const selfApproval = await call("POST", `${base()}/absences/${request.data.uuid}/decision`, tokens.employee, { status: "approved" });
		expect(selfApproval.error).toBe(9999);

		const pending = await call("GET", `${base()}/workforce/balance?year=2026`, tokens.employee);
		expect(pending.data).toMatchObject({ entitled_days: 20, pending_days: 8, approved_days: 0, remaining_days: 20 });

		const approved = await call("POST", `${base()}/absences/${request.data.uuid}/decision`, tokens.supervisor, { status: "approved", note: "Enjoy" });
		expect(approved.data).toMatchObject({ status: "approved", decided_by: "wf-super", decision_note: "Enjoy" });
		const again = await call("POST", `${base()}/absences/${request.data.uuid}/decision`, tokens.supervisor, { status: "rejected" });
		expect(again.error).toBe(1196);
		const lateCancel = await call("POST", `${base()}/absences/${request.data.uuid}/cancel`, tokens.employee);
		expect(lateCancel.error).toBe(1196);

		const balance = await call("GET", `${base()}/workforce/balance?year=2026`, tokens.employee);
		expect(balance.data).toMatchObject({ approved_days: 8, pending_days: 0, remaining_days: 12 });

		const carried = await call("PUT", `${base()}/workforce/balance`, tokens.supervisor, { member: members.employee, year: 2026, carried_days: 2.5 });
		expect(carried.data.remaining_days).toBe(14.5);
		const halfDay = await call("PUT", `${base()}/workforce/balance`, tokens.supervisor, { member: members.employee, year: 2026, carried_days: 2.3 });
		expect(halfDay.error).toBe(1210);

		const direct = await call("POST", `${base()}/absences`, tokens.supervisor, {
			member: members.colleague,
			kind: "sick",
			starts_on: "2026-12-01",
			ends_on: "2026-12-02",
		});
		expect(direct.data.status).toBe("approved");

		const list = await call("GET", `${base()}/absences?from=2026-12-01&to=2026-12-31&member=all&status=approved`, tokens.supervisor);
		expect(list.data).toHaveLength(2);
	});

	test("custom days off count as work-free days", async () => {
		const added = await call("POST", `${base()}/workforce/holidays`, tokens.supervisor, { date: "2026-12-24", name: "Company day off" });
		expect(added.status).toBe(201);
		const duplicate = await call("POST", `${base()}/workforce/holidays`, tokens.supervisor, { date: "2026-12-24", name: "Again" });
		expect(duplicate.error).toBe(1200);
		const calendar = await call("GET", `${base()}/workforce/holidays?year=2026`, tokens.employee);
		expect(calendar.data.holidays.find((holiday: { date: string }) => holiday.date === "2026-12-24")).toMatchObject({ source: "project", work_free: true });
		const balance = await call("GET", `${base()}/workforce/balance?year=2026`, tokens.employee);
		expect(balance.data.approved_days).toBe(7);
		await call("DELETE", `${base()}/workforce/holidays/${added.data.uuid}`, tokens.supervisor);
	});

	test("the monthly report adds up the fund, holidays, absences and special hours", async () => {
		const writes: Promise<Result>[] = [];
		for (let day = 1; day <= 30; day++) {
			const date = `2026-04-${String(day).padStart(2, "0")}`;
			const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
			if (weekday === 0 || weekday === 6 || date === "2026-04-06" || date === "2026-04-27") continue;
			if (date >= "2026-04-20" && date <= "2026-04-24") continue;
			writes.push(call("POST", `${base()}/timesheets`, tokens.supervisor, { ...entry(date, "08:00", "16:00"), member: members.colleague }));
		}
		writes.push(
			call("POST", `${base()}/timesheets`, tokens.supervisor, {
				...entry("2026-04-11", "10:00", "12:00", { break_minutes: 0, kind: "overtime" }),
				member: members.colleague,
			})
		);
		writes.push(
			call("POST", `${base()}/timesheets`, tokens.supervisor, { ...entry("2026-04-12", "22:00", "02:00", { break_minutes: 0 }), member: members.colleague })
		);
		writes.push(
			call("POST", `${base()}/timesheets`, tokens.supervisor, { ...entry("2026-04-27", "09:00", "13:00", { break_minutes: 0 }), member: members.colleague })
		);
		for (const result of await Promise.all(writes)) expect(result.status).toBe(201);
		const vacation = await call("POST", `${base()}/absences`, tokens.supervisor, {
			member: members.colleague,
			kind: "vacation",
			starts_on: "2026-04-20",
			ends_on: "2026-04-24",
		});
		expect(vacation.data.working_days).toBe(5);

		const denied = await call("GET", `${base()}/timesheets/report?month=2026-04&member=${members.colleague}`, tokens.employee);
		expect(denied.error).toBe(9999);
		const report = await call("GET", `${base()}/timesheets/report?month=2026-04&member=${members.colleague}`, tokens.supervisor);
		expect(report.error).toBe(0);
		const totals = report.data.people[0].totals;
		expect(totals).toMatchObject({
			fund_minutes: 22 * 480,
			holiday_minutes: 2 * 480,
			worked_minutes: 15 * 480 + 240 + 240,
			overtime_minutes: 120,
			night_minutes: 240,
			sunday_minutes: 120,
			holiday_work_minutes: 240,
			days_worked: 18,
			meal_days: 16,
			balance_minutes: 600,
		});
		expect(totals.absence_minutes.vacation).toBe(5 * 480);
		const easterMonday = report.data.people[0].days.find((day: { date: string }) => day.date === "2026-04-06");
		expect(easterMonday.holiday.name.sl).toBe("Velikonočni ponedeljek");

		const csv = await call("GET", `${base()}/timesheets/report?month=2026-04&member=${members.colleague}&format=csv`, tokens.supervisor);
		expect(csv.status).toBe(200);
		expect(String(csv.data)).toContain("2026-04-13,,10.00");
		expect(String(csv.data)).toContain("Cene Colleague,total");

		const response = await Server.app.handle(
			new Request(`http://127.0.0.1/api/v1${base()}/timesheets/report?month=2026-04&member=all&format=pdf`, {
				headers: { Authorization: `Bearer ${tokens.supervisor}` },
			})
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("application/pdf");
		const pdf = new Uint8Array(await response.arrayBuffer());
		expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
		const pdfDenied = await call("GET", `${base()}/timesheets/report?month=2026-04&member=all&format=pdf`, tokens.employee);
		expect(pdfDenied.error).toBe(9999);
	});

	test("tickets track work and customers see them in the portal", async () => {
		const denied = await call("POST", `${base()}/tickets`, tokens.employee, { title: "Nope" });
		expect(denied.error).toBe(9999);
		const created = await call("POST", `${base()}/tickets`, tokens.supervisor, {
			title: "Migrate the mail server",
			kind: "task",
			customer,
			hourly_rate: 5000,
			assignees: [members.employee],
		});
		expect(created.status).toBe(201);
		expect(created.data).toMatchObject({ number: 1, customer_name: "Acme d.o.o.", assignees: [{ member: members.employee, name: "Eva Employee" }] });
		const ticket = created.data.uuid;

		const closedPortal = await customerLogin("client@acme.test");
		expect((await call("GET", "/customer/auth/me", closedPortal)).data.tickets).toBe(false);
		expect((await call("GET", "/customer/tickets", closedPortal)).data).toEqual([]);
		expect((await call("GET", `/customer/tickets/${ticket}`, closedPortal)).error).toBe(1202);
		const shown = await call("PUT", `${base()}/customers/${customer}/ticket-access`, tokens.supervisor, { enabled: true, kinds: [] });
		expect(shown.data).toEqual({ customer, enabled: true, kinds: [] });
		expect((await call("GET", `${base()}/customers/${customer}/ticket-access`, tokens.supervisor)).data).toEqual({ customer, enabled: true, kinds: [] });
		expect((await call("GET", "/customer/auth/me", closedPortal)).data.tickets).toBe(true);

		const second = await call("POST", `${base()}/tickets`, tokens.supervisor, { title: "Internal cleanup" });
		expect(second.data.number).toBe(2);

		const work = await call("POST", `${base()}/timesheets`, tokens.employee, entry(today, "17:00", "19:30", { break_minutes: 0, ticket }));
		expect(work.status).toBe(201);

		const statusOnly = await call("PATCH", `${base()}/tickets/${ticket}`, tokens.employee, { status: "in_progress" });
		expect(statusOnly.data.status).toBe("in_progress");
		expect(statusOnly.data.logged_minutes).toBe(150);
		expect(statusOnly.data).toMatchObject({ hourly_rate: null, fixed_price: null, fixed_price_invoiced: false });
		const retitle = await call("PATCH", `${base()}/tickets/${ticket}`, tokens.employee, { title: "Other" });
		expect(retitle.error).toBe(9999);

		const internal = await call("POST", `${base()}/tickets/${ticket}/comments`, tokens.employee, { body: "DNS needs a new MX record", internal: true });
		expect(internal.status).toBe(201);
		const reply = await call("POST", `${base()}/tickets/${ticket}/comments`, tokens.supervisor, { body: "We will switch over on Friday." });
		expect(reply.status).toBe(201);

		const mine = await call("GET", `${base()}/tickets?assignee=me&search=mail`, tokens.employee);
		expect(mine.data.tickets.map((row: { number: number }) => row.number)).toEqual([1]);
		expect(mine.data.tickets[0]).toMatchObject({ hourly_rate: null, fixed_price: null, fixed_price_invoiced: false });
		expect((await call("GET", `${base()}/tickets/${ticket}`, tokens.employee)).data).toMatchObject({ hourly_rate: null, fixed_price: null });
		const byNumber = await call("GET", `${base()}/tickets?search=1`, tokens.employee);
		expect(byNumber.data.tickets.map((row: { number: number }) => row.number)).toEqual([1]);
		const byHashNumber = await call("GET", `${base()}/tickets?search=%231`, tokens.employee);
		expect(byHashNumber.data.tickets.map((row: { number: number }) => row.number)).toEqual([1]);

		const portal = await customerLogin("client@acme.test");
		const list = await call("GET", "/customer/tickets", portal);
		expect(list.data).toHaveLength(1);
		expect(list.data[0]).toMatchObject({ number: 1, status: "in_progress", assignees: ["Eva Employee"], merchant: "workforce-co" });
		const detail = await call("GET", `/customer/tickets/${ticket}`, portal);
		expect(detail.data.comments.map((comment: { body: string }) => comment.body)).toEqual(["We will switch over on Friday."]);
		expect(detail.data.comments[0].author).toBeUndefined();

		await call("PATCH", `${base()}/tickets/${ticket}`, tokens.supervisor, { status: "waiting" });
		const answer = await call("POST", `/customer/tickets/${ticket}/comments`, portal, { body: "Friday works for us." });
		expect(answer.status).toBe(201);
		const reopened = await call("GET", `${base()}/tickets/${ticket}`, tokens.supervisor);
		expect(reopened.data.status).toBe("open");
		expect(reopened.data.comments.at(-1)).toMatchObject({ from_customer: true, author_name: "Acme d.o.o." });

		await call("PATCH", `${base()}/tickets/${ticket}`, tokens.supervisor, { customer_visible: false });
		const hidden = await call("GET", `/customer/tickets/${ticket}`, portal);
		expect(hidden.error).toBe(1202);
		await call("PATCH", `${base()}/tickets/${ticket}`, tokens.supervisor, { customer_visible: true });
	});

	test("customers only open the kinds of tickets they were allowed", async () => {
		const portal = await customerLogin("client@acme.test");
		const before = await call("GET", "/customer/ticket-access", portal);
		expect(before.data).toEqual([]);
		const blocked = await call("POST", "/customer/tickets", portal, { project, kind: "bug", title: "Login page is blank" });
		expect(blocked.error).toBe(1205);

		const granted = await call("PUT", `${base()}/customers/${customer}/ticket-access`, tokens.supervisor, { kinds: ["bug", "support"] });
		expect(granted.data.kinds).toEqual(["support", "bug"]);
		const access = await call("GET", "/customer/ticket-access", portal);
		expect(access.data).toEqual([{ project, merchant: "workforce-co", kinds: ["support", "bug"] }]);

		const bug = await call("POST", "/customer/tickets", portal, { project, kind: "bug", title: "Login page is blank", description: "Since the update" });
		expect(bug.status).toBe(201);
		expect(bug.data).toMatchObject({ number: 3, kind: "bug", status: "open", reported_by_me: true });
		const feature = await call("POST", "/customer/tickets", portal, { project, kind: "feature", title: "Dark mode" });
		expect(feature.error).toBe(1205);

		const inbox = await call("GET", `${base()}/tickets?status=open`, tokens.supervisor);
		expect(inbox.data.tickets.find((row: { number: number }) => row.number === 3)).toMatchObject({ reported_by: "client@acme.test", customer });
	});

	test("tickets sort by custom order, priority, creation and last activity", async () => {
		await Database`UPDATE tickets SET priority = 'low', created = 100, updated = 1 WHERE project = ${project} AND number = 1`;
		await Database`UPDATE tickets SET priority = 'urgent', created = 300, updated = 1 WHERE project = ${project} AND number = 2`;
		await Database`UPDATE tickets SET priority = 'high', created = 200, updated = 1 WHERE project = ${project} AND number = 3`;

		const numbers = async (sort: string) =>
			(await call("GET", `${base()}/tickets?status=all&sort=${sort}`, tokens.employee)).data.tickets.map((ticket: { number: number }) => ticket.number);
		expect(await numbers("priority")).toEqual([2, 3, 1]);
		expect(await numbers("created")).toEqual([2, 3, 1]);

		const [first] = await Database`SELECT uuid FROM tickets WHERE project = ${project} AND number = 1`;
		const [second] = await Database`SELECT uuid FROM tickets WHERE project = ${project} AND number = 2`;
		const [third] = await Database`SELECT uuid FROM tickets WHERE project = ${project} AND number = 3`;
		expect(
			(await call("POST", `${base()}/tickets/${first.uuid}/comments`, tokens.employee, { body: "This changed most recently", internal: true })).status
		).toBe(201);
		expect((await numbers("updated"))[0]).toBe(1);

		expect((await call("POST", `${base()}/tickets/${first.uuid}/order`, tokens.employee, { before: third.uuid })).error).toBe(0);
		expect(await numbers("custom")).toEqual([1, 3, 2]);
		expect((await call("POST", `${base()}/tickets/${second.uuid}/order`, tokens.employee, { before: first.uuid })).error).toBe(0);
		expect(await numbers("custom")).toEqual([2, 1, 3]);
		expect((await call("POST", `${base()}/tickets/${second.uuid}/order`, tokens.employee, { before: null })).error).toBe(0);
		expect(await numbers("custom")).toEqual([1, 3, 2]);
		expect((await call("GET", `${base()}/tickets?sort=unknown`, tokens.employee)).error).toBe(1201);
	});

	test("turning the ticket portal off hides tickets and stops ticket emails to the customer", async () => {
		const portal = await customerLogin("client@acme.test");
		const [bug] = await Database`SELECT uuid FROM tickets WHERE project = ${project} AND number = 3`;
		const replies = async () =>
			Number((await Database`SELECT COUNT(*) AS count FROM email_messages WHERE project = ${project} AND kind = 'ticket_reply'`)[0].count);

		const hidden = await call("PUT", `${base()}/customers/${customer}/ticket-access`, tokens.supervisor, { enabled: false, kinds: ["bug"] });
		expect(hidden.data).toEqual({ customer, enabled: false, kinds: [] });
		expect((await call("GET", "/customer/auth/me", portal)).data.tickets).toBe(false);
		expect((await call("GET", "/customer/tickets", portal)).data).toEqual([]);
		expect((await call("GET", "/customer/ticket-access", portal)).data).toEqual([]);
		expect((await call("POST", `/customer/tickets/${bug.uuid}/comments`, portal, { body: "Still broken" })).error).toBe(1202);
		expect((await call("POST", "/customer/tickets", portal, { project, kind: "bug", title: "Again" })).error).toBe(1205);

		const before = await replies();
		await call("POST", `${base()}/tickets/${bug.uuid}/comments`, tokens.supervisor, { body: "Looking into it." });
		expect(await replies()).toBe(before);

		expect((await call("PUT", `${base()}/customers/${customer}/ticket-access`, tokens.supervisor, { enabled: "yes" })).error).toBe(1201);
		const restored = await call("PUT", `${base()}/customers/${customer}/ticket-access`, tokens.supervisor, { enabled: true, kinds: ["bug", "support"] });
		expect(restored.data).toEqual({ customer, enabled: true, kinds: ["support", "bug"] });
		expect((await call("GET", "/customer/tickets", portal)).data.map((row: { number: number }) => row.number)).toContain(3);
	});

	test("tickets and absences notify the right people by email", async () => {
		const rows = (await Database`SELECT kind, recipient, subject, body_text FROM email_messages WHERE project = ${project} ORDER BY created ASC`) as {
			kind: string;
			recipient: string;
			subject: string;
			body_text: string;
		}[];
		const sent = (kind: string) => rows.filter((row) => row.kind === kind);

		expect(sent("ticket_assigned").map((row) => row.recipient)).toContain("wf-employee@team.test");
		expect(sent("ticket_assigned")[0].subject).toContain("#1");
		expect(sent("ticket_reply").map((row) => row.recipient)).toEqual(["client@acme.test"]);
		expect(sent("ticket_reply")[0].body_text).toContain("We will switch over on Friday.");
		expect(rows.some((row) => row.body_text.includes("DNS needs a new MX record"))).toBe(false);
		expect(sent("ticket_status").every((row) => row.recipient === "client@acme.test")).toBe(true);
		expect(sent("ticket_status").length).toBeGreaterThan(0);
		expect(sent("ticket_customer").map((row) => row.recipient)).toContain("wf-employee@team.test");
		expect(sent("ticket_customer").some((row) => row.body_text.includes("Friday works for us."))).toBe(true);
		expect(sent("ticket_customer").some((row) => row.subject.includes("Login page is blank"))).toBe(true);
		expect(new Set(sent("absence_requested").map((row) => row.recipient))).toEqual(new Set(["wf-owner@team.test", "wf-super@team.test"]));
		expect(sent("absence_decided").map((row) => row.recipient)).toContain("wf-employee@team.test");
		expect(sent("absence_decided").find((row) => row.body_text.includes("Enjoy"))).toBeDefined();

		const settings = await call("GET", `${base()}/workforce`, tokens.supervisor);
		await call("PUT", `${base()}/workforce/settings`, tokens.supervisor, { ...settings.data.config, email_notifications: false });
		const before = rows.length;
		const quiet = await call("POST", `${base()}/absences`, tokens.employee, { kind: "paid_leave", starts_on: "2026-11-16", ends_on: "2026-11-16" });
		expect(quiet.status).toBe(201);
		const [count] = await Database`SELECT COUNT(*) AS count FROM email_messages WHERE project = ${project}`;
		expect(Number(count.count)).toBe(before);
		await call("PUT", `${base()}/workforce/settings`, tokens.supervisor, { ...settings.data.config, email_notifications: true });
		await call("POST", `${base()}/absences/${quiet.data.uuid}/cancel`, tokens.employee);
	});

	test("uninvoiced ticket hours become a draft invoice", async () => {
		const [ticket] = await Database`SELECT uuid FROM tickets WHERE project = ${project} AND number = 1`;
		const supervisorInvoice = await call("POST", `${base()}/tickets/${ticket.uuid}/invoice`, tokens.supervisor, {});
		expect(supervisorInvoice.error).toBe(9999);

		const invoiced = await call("POST", `${base()}/tickets/${ticket.uuid}/invoice`, tokens.owner, {});
		expect(invoiced.status).toBe(201);
		expect(invoiced.data).toMatchObject({ minutes: 150, quantity: 2.5, rate: 5000 });
		const invoice = await call("GET", `${base()}/invoices/${invoiced.data.invoice}`, tokens.owner);
		expect(invoice.data.status).toBe("draft");
		expect(invoice.data.items[0]).toMatchObject({ description: "#1 Migrate the mail server", quantity: 2.5, unit_price: 5000, unit: "HUR" });

		const again = await call("POST", `${base()}/tickets/${ticket.uuid}/invoice`, tokens.owner, {});
		expect(again.error).toBe(1206);
		const [billed] = await Database`SELECT uuid FROM time_entries WHERE ticket = ${ticket.uuid}`;
		const locked = await call("PATCH", `${base()}/timesheets/${billed.uuid}`, tokens.supervisor, { end: "20:00" });
		expect(locked.error).toBe(1209);

		const [other] = await Database`SELECT uuid FROM tickets WHERE project = ${project} AND number = 2`;
		const missingRate = await call("POST", `${base()}/tickets/${other.uuid}/invoice`, tokens.owner, {});
		expect(missingRate.error).toBe(1211);
	});

	test("uninvoiced hours from several tickets share one draft invoice", async () => {
		const first = await call("POST", `${base()}/tickets`, tokens.supervisor, {
			title: "Configure mailboxes",
			customer,
			hourly_rate: 5000,
		});
		const second = await call("POST", `${base()}/tickets`, tokens.supervisor, {
			title: "Document mail setup",
			customer,
			hourly_rate: 7000,
		});
		expect(
			(await call("POST", `${base()}/timesheets`, tokens.employee, entry(today, "20:00", "21:00", { break_minutes: 0, ticket: first.data.uuid }))).status
		).toBe(201);
		expect(
			(await call("POST", `${base()}/timesheets`, tokens.employee, entry(today, "21:00", "22:30", { break_minutes: 0, ticket: second.data.uuid }))).status
		).toBe(201);

		const [differentCustomer] = await Database`SELECT uuid FROM tickets WHERE project = ${project} AND number = 2`;
		const mixed = await call("POST", `${base()}/tickets/invoice`, tokens.owner, { tickets: [first.data.uuid, differentCustomer.uuid] });
		expect(mixed.error).toBe(1295);
		const denied = await call("POST", `${base()}/tickets/invoice`, tokens.supervisor, { tickets: [first.data.uuid, second.data.uuid] });
		expect(denied.error).toBe(9999);

		const created = await call("POST", `${base()}/tickets/invoice`, tokens.owner, { tickets: [first.data.uuid, second.data.uuid] });
		expect(created.status).toBe(201);
		expect(created.data).toMatchObject({ minutes: 150, quantity: 2.5, rate: null });
		const invoice = await call("GET", `${base()}/invoices/${created.data.invoice}`, tokens.owner);
		expect(invoice.data.status).toBe("draft");
		expect(invoice.data.customer).toBe(customer);
		expect(invoice.data.metadata).toEqual({ tickets: [first.data.uuid, second.data.uuid] });
		expect(invoice.data.items).toHaveLength(2);
		expect(invoice.data.items[0]).toMatchObject({ description: `#${first.data.number} Configure mailboxes`, quantity: 1, unit_price: 5000, unit: "HUR" });
		expect(invoice.data.items[1]).toMatchObject({ description: `#${second.data.number} Document mail setup`, quantity: 1.5, unit_price: 7000, unit: "HUR" });
		expect((await call("POST", `${base()}/tickets/invoice`, tokens.owner, { tickets: [first.data.uuid, second.data.uuid] })).error).toBe(1206);
	});

	test("a fixed-price ticket is invoiced once without needing logged hours", async () => {
		const ticket = await call("POST", `${base()}/tickets`, tokens.supervisor, {
			title: "Deliver the migration",
			customer,
			hourly_rate: 5000,
			fixed_price: 1_500_000,
		});
		expect(ticket.data).toMatchObject({ fixed_price: 1_500_000, fixed_price_invoiced: false, hourly_rate: null, uninvoiced_minutes: 0 });

		const created = await call("POST", `${base()}/tickets/${ticket.data.uuid}/invoice`, tokens.owner, {});
		expect(created.status).toBe(201);
		expect(created.data).toMatchObject({ minutes: 0, quantity: 1, rate: 1_500_000 });
		const invoice = await call("GET", `${base()}/invoices/${created.data.invoice}`, tokens.owner);
		expect(invoice.data.items[0]).toMatchObject({
			description: `#${ticket.data.number} Deliver the migration`,
			quantity: 1,
			unit_price: 1_500_000,
			unit: "C62",
		});
		expect((await call("GET", `${base()}/tickets/${ticket.data.uuid}`, tokens.owner)).data.fixed_price_invoiced).toBe(true);
		expect((await call("GET", `${base()}/tickets/${ticket.data.uuid}`, tokens.employee)).data).toMatchObject({
			hourly_rate: null,
			fixed_price: null,
			fixed_price_invoiced: false,
		});
		expect((await call("POST", `${base()}/tickets/${ticket.data.uuid}/invoice`, tokens.owner, {})).error).toBe(1206);

		expect((await call("DELETE", `${base()}/invoices/${created.data.invoice}`, tokens.owner)).status).toBe(200);
		expect((await call("GET", `${base()}/tickets/${ticket.data.uuid}`, tokens.owner)).data.fixed_price_invoiced).toBe(false);
		expect((await call("POST", `${base()}/tickets/${ticket.data.uuid}/invoice`, tokens.owner, {})).status).toBe(201);
	});

	test("employee records keep private details encrypted and feed payroll", async () => {
		const supervisor = await call("GET", `${base()}/employees`, tokens.supervisor);
		expect(supervisor.error).toBe(9999);

		const invalid = await call("PUT", `${base()}/employees/${members.colleague}`, tokens.owner, { private: { personal_id: "123" } });
		expect(invalid.error).toBe(1207);
		const saved = await call("PUT", `${base()}/employees/${members.colleague}`, tokens.owner, {
			employee_number: "007",
			job_title: "Technician",
			started_on: "2025-06-01",
			prior_service_months: 1,
			vacation_days: 25,
			private: { salary: 200000, personal_id: "0101990500123", iban: "SI56 1910 0000 0123 438", commute_per_day: 500 },
		});
		expect(saved.status).toBe(201);
		expect(saved.data.private).toMatchObject({ salary: 200000, iban: "SI56191000000123438" });
		expect(saved.data.prior_service_months).toBe(1);
		const tooLong = await call("PUT", `${base()}/employees/${members.colleague}`, tokens.owner, { prior_service_months: 721 });
		expect(tooLong.error).toBe(1207);

		const [stored] = await Database`SELECT private_data FROM employees WHERE member = ${members.colleague}`;
		expect(stored.private_data).not.toContain("200000");
		expect(stored.private_data).not.toContain("0101990500123");
		const [logged] = await Database`SELECT new_value FROM audit_log WHERE action = 'employee.created'`;
		expect(logged.new_value).not.toContain("0101990500123");
		expect(logged.new_value).toContain("personal_id");

		const settings = await call("GET", `${base()}/workforce`, tokens.owner);
		await call("PUT", `${base()}/workforce/settings`, tokens.owner, { ...settings.data.config, meal_allowance: 796 });

		const payroll = await call("GET", `${base()}/payroll?month=2026-04`, tokens.owner);
		expect(payroll.error).toBe(0);
		expect(payroll.data.lines).toHaveLength(1);
		expect(payroll.data.lines[0].approval_status).toBe("draft");
		expect(payroll.data.lines[0].amounts).toEqual({
			regular: 145455,
			waiting_home: 0,
			overtime: 2273,
			holidays: 18182,
			leave: 45455,
			sick: 0,
			overtime_supplement: 682,
			night_supplement: 2273,
			sunday_supplement: 1136,
			holiday_supplement: 4545,
			seniority: 0,
			gross: 220001,
			meal: 16 * 796,
			commute: 18 * 500,
			reimbursements: 16 * 796 + 18 * 500,
		});

		const halfNight = await call("PUT", `${base()}/employees/${members.colleague}`, tokens.owner, { workforce_settings: { night_from: 1320 } });
		expect(halfNight.error).toBe(1207);
		const unknown = await call("PUT", `${base()}/employees/${members.colleague}`, tokens.owner, { workforce_settings: { daily_minutes: 300 } });
		expect(unknown.error).toBe(1207);
		const overridden = await call("PUT", `${base()}/employees/${members.colleague}`, tokens.owner, {
			workforce_settings: { rates: { night: 100 }, meal_allowance: 1000, edit_days: 5 },
		});
		expect(overridden.data.workforce_settings).toEqual({ rates: { night: 100 }, meal_allowance: 1000, edit_days: 5 });
		const custom = await call("GET", `${base()}/payroll?month=2026-04`, tokens.owner);
		expect(custom.data.lines[0].amounts.night_supplement).toBe(4545);
		expect(custom.data.lines[0].amounts.meal).toBe(16 * 1000);
		const people = await call("GET", `${base()}/workforce/people`, tokens.owner);
		expect(people.data.find((person: { member: string }) => person.member === members.colleague).edit_days).toBe(5);

		const cleared = await call("PUT", `${base()}/employees/${members.colleague}`, tokens.owner, { workforce_settings: null });
		expect(cleared.data.workforce_settings).toEqual({});
		const [row] = await Database`SELECT workforce_settings FROM employees WHERE member = ${members.colleague}`;
		expect(row.workforce_settings).toBeNull();

		const balance = await call("GET", `${base()}/workforce/balance?year=2026&member=${members.colleague}`, tokens.supervisor);
		expect(balance.data.entitled_days).toBe(25);
	});

	test("net pay follows the contribution rates, reliefs and tax brackets of the table", () => {
		const rates = SLOVENIA_PRESET.rates;
		const high = netPay({ gross: 200000, claims_general_relief: true, dependents: 0 }, rates);
		expect(high.employee_contributions).toEqual({ pension: 31000, health: 12720, unemployment: 280, parental: 200, long_term_care: 2000 });
		expect(high.employee_contributions_total).toBe(46200);
		expect(high.general_relief).toBe(43833);
		expect(high.tax_base).toBe(200000 - 46200 - 3717 - 43833);
		expect(high.income_tax).toBe(19950);
		expect(high.health_flat).toBe(3717);
		expect(high.net).toBe(130133);
		expect(high.employer_contributions_total).toBe(34200);

		const low = netPay({ gross: 120000, claims_general_relief: true, dependents: 0 }, rates);
		expect(low.employee_contributions_total).toBe(27720);
		expect(low.general_relief).toBe(67597);
		expect(low.income_tax).toBe(3355);
		expect(low.net).toBe(85208);

		const family = netPay({ gross: 200000, claims_general_relief: true, dependents: 2 }, rates);
		expect(family.dependent_relief).toBe(52106);
		expect(family.income_tax).toBeLessThan(high.income_tax);
		const elsewhere = netPay({ gross: 200000, claims_general_relief: false, dependents: 0 }, rates);
		expect(elsewhere.general_relief).toBe(0);
		expect(elsewhere.net).toBeLessThan(high.net);
	});

	test("payroll runs are calculated, checked, finalized and exported", async () => {
		const tables = await call("GET", `${base()}/payroll/rates`, tokens.owner);
		expect(tables.data.tables).toEqual([]);
		const supervisor = await call("PUT", `${base()}/payroll/rates/2025-07`, tokens.supervisor, { rates: SLOVENIA_PRESET.rates, verified: false });
		expect(supervisor.error).toBe(9999);
		const invalid = await call("PUT", `${base()}/payroll/rates/2025-07`, tokens.owner, {
			rates: { ...SLOVENIA_PRESET.rates, brackets: [{ up_to: 100, rate: 16 }] },
			verified: false,
		});
		expect(invalid.error).toBe(1213);
		const saved = await call("PUT", `${base()}/payroll/rates/2025-07`, tokens.owner, { rates: SLOVENIA_PRESET.rates, verified: false });
		expect(saved.data).toMatchObject({ period: "2025-07", verified: false });

		const created = await call("POST", `${base()}/payroll/runs`, tokens.owner, { period: "2026-04", pay_date: "2026-05-18" });
		expect(created.status).toBe(201);
		expect(created.data.rates).toEqual({ period: "2025-07", verified: false });
		expect(created.data.lines).toHaveLength(1);
		const line = created.data.lines[0];
		expect(line.calculation.gross).toBe(220001);
		expect(line.calculation.warnings).toContain("timesheet_not_approved");
		expect(line.calculation.net).toEqual(netPay({ gross: 220001, claims_general_relief: true, dependents: 0 }, SLOVENIA_PRESET.rates));
		expect(line.calculation.payout).toBe(line.calculation.net.net + line.calculation.reimbursements);
		const duplicate = await call("POST", `${base()}/payroll/runs`, tokens.owner, { period: "2026-04" });
		expect(duplicate.error).toBe(1217);

		const early = await call(
			"GET",
			`${base()}/payroll/runs/${created.data.uuid}/rek-o?responsible=Ana&contact=041000000&collective_agreement=999`,
			tokens.owner
		);
		expect(early.error).toBe(1224);

		const unchecked = await call("POST", `${base()}/payroll/runs/${created.data.uuid}/finalize`, tokens.owner);
		expect(unchecked.error).toBe(1215);
		await call("PUT", `${base()}/payroll/rates/2025-07`, tokens.owner, { rates: SLOVENIA_PRESET.rates, verified: true });

		const bonus = await call("PUT", `${base()}/payroll/runs/${created.data.uuid}/lines/${line.uuid}/items`, tokens.owner, {
			items: [
				{ type: "gross", description: "Performance bonus", amount: 10000 },
				{ type: "deduction", description: "Loan repayment", amount: 5000 },
			],
		});
		const updated = bonus.data.lines[0].calculation;
		expect(updated.gross).toBe(230001);
		expect(updated.deductions).toBe(5000);
		expect(updated.payout).toBe(updated.net.net + updated.reimbursements - 5000);

		const final = await call("POST", `${base()}/payroll/runs/${created.data.uuid}/finalize`, tokens.owner);
		expect(final.data.status).toBe("final");
		expect(final.data.lines[0].calculation.items).toHaveLength(2);
		expect(final.data.totals.gross).toBe(230001);
		const locked = await call("PUT", `${base()}/payroll/runs/${created.data.uuid}/lines/${line.uuid}/items`, tokens.owner, { items: [] });
		expect(locked.error).toBe(1218);

		const csv = await Server.app.handle(
			new Request(`http://127.0.0.1/api/v1${base()}/payroll/runs/${created.data.uuid}/export`, { headers: { Authorization: `Bearer ${tokens.owner}` } })
		);
		const text = await csv.text();
		expect(text.split("\r\n")[0]).toContain("income_tax");
		expect(text).toContain("SI56191000000123438");
		expect(text).toContain("2300.01");

		const payslips = await Server.app.handle(
			new Request(`http://127.0.0.1/api/v1${base()}/payroll/runs/${created.data.uuid}/payslips?line=${line.uuid}`, {
				headers: { Authorization: `Bearer ${tokens.owner}` },
			})
		);
		expect(payslips.headers.get("Content-Type")).toBe("application/pdf");
		expect(new TextDecoder().decode(new Uint8Array(await payslips.arrayBuffer()).slice(0, 5))).toBe("%PDF-");

		const missing = await call(
			"GET",
			`${base()}/payroll/runs/${created.data.uuid}/rek-o?responsible=Ana%20Owner&contact=041000000%20ana%40team.test&collective_agreement=999`,
			tokens.owner
		);
		expect(missing.error).toBe(1222);
		expect(missing.data.problems).toEqual(
			expect.arrayContaining([
				{ field: "company_tax_number" },
				{ field: "company_registration_number" },
				{ field: "employee_tax_number", person: "Cene Colleague" },
			])
		);

		await call("POST", `${base()}/payroll/runs/${created.data.uuid}/reopen`, tokens.owner);
		await call("PUT", `${base()}/company`, tokens.owner, {
			legal_name: "Workforce d.o.o.",
			address_line1: "Dunajska cesta 5",
			postal_code: "1000",
			city: "Ljubljana",
			tax_number: "SI12345678",
			registration_number: "1234567",
		});
		await call("PUT", `${base()}/employees/${members.colleague}`, tokens.owner, { private: { tax_number: "87654321" } });
		await call("POST", `${base()}/payroll/runs/${created.data.uuid}/finalize`, tokens.owner);

		const rek = await download(
			`${base()}/payroll/runs/${created.data.uuid}/rek-o?responsible=Ana%20Owner&contact=041000000%20ana%40team.test&collective_agreement=999`,
			tokens.owner
		);
		expect(rek.status).toBe(200);
		expect(rek.type).toContain("application/xml");
		expect(rek.text).toContain("<F010>1001</F010>");
		expect(rek.text).toContain("<F011Start>04.2026</F011Start>");
		expect(rek.text).toContain("<podo:A052>2300.01</podo:A052>");
		expect(rek.text).toContain("<podo:A001>87654321</podo:A001>");
		expect(rek.text).toContain("<podo:A003>Cene</podo:A003><podo:A003a>Colleague</podo:A003a>");
		expect(rek.text).toContain("<podo:A072bO>23.00</podo:A072bO>");
		expect(rek.text).toContain("<podo:S01>1234567000</podo:S01><podo:S02>999</podo:S02>");
		expect(rek.text).toContain("<F202bO>23.00</F202bO>");
		expect(rek.text).toContain("<edp:taxNumber>12345678</edp:taxNumber>");
		if (xmllint) {
			expect(schemaErrors("rek/REK_O_1.xsd", rek.text)).toBe("");
			expect(schemaErrors("rek/REK_O_1.xsd", rek.text.replace("<podo:A004>R</podo:A004>", ""))).not.toBe("");
		}

		const noIban = await call("GET", `${base()}/payroll/runs/${created.data.uuid}/sepa`, tokens.owner);
		expect(noIban.error).toBe(1223);
		expect(noIban.data.problems).toEqual([{ field: "debtor_iban" }]);
		const sepa = await download(`${base()}/payroll/runs/${created.data.uuid}/sepa?iban=SI62020100015986525`, tokens.owner);
		expect(sepa.status).toBe(200);
		expect(sepa.text).toContain("<CtgyPurp><Cd>SALA</Cd></CtgyPurp>");
		expect(sepa.text).toContain("<IBAN>SI56191000000123438</IBAN>");
		expect(sepa.text).toContain("<ReqdExctnDt>2026-05-18</ReqdExctnDt>");
		expect(sepa.text).toContain("<Nm>Workforce d.o.o.</Nm>");
		expect(sepa.text).toContain(`<InstdAmt Ccy="EUR">${(final.data.lines[0].calculation.payout / 100).toFixed(2)}</InstdAmt>`);
		if (xmllint) {
			expect(schemaErrors("sepa/pain.001.001.03.xsd", sepa.text)).toBe("");
			expect(schemaErrors("sepa/pain.001.001.03.xsd", sepa.text.replace("<ChrgBr>SLEV</ChrgBr>", "<ChrgBr>NOPE</ChrgBr>"))).not.toBe("");
		}

		const reopened = await call("POST", `${base()}/payroll/runs/${created.data.uuid}/reopen`, tokens.owner);
		expect(reopened.data.status).toBe("draft");
		const employeeView = await call("GET", `${base()}/payroll/runs`, tokens.employee);
		expect(employeeView.error).toBe(9999);
	});

	test("the minimum contribution base and secondary employers change contributions and tax", () => {
		const rates = SLOVENIA_PRESETS.find((preset) => preset.period === "2026-03")!.rates;
		expect(rates.minimum_contribution_base).toBe(152162);
		expect(rates.health_flat).toBe(3936);
		const low = netPay({ gross: 120000, claims_general_relief: true, dependents: 0, contribution_floor: 152162 }, rates);
		expect(low.contribution_base).toBe(152162);
		expect(low.base_difference).toBe(32162);
		expect(low.employee_contributions_total).toBe(
			Math.round(120000 * 0.155) + Math.round(120000 * 0.0636) + Math.round(120000 * 0.0014) + Math.round(120000 * 0.001) + Math.round(120000 * 0.01)
		);
		expect(low.employee_on_difference.pension).toBe(Math.round(32162 * 0.155));
		expect(low.employer_contributions.pension).toBe(Math.round(152162 * 0.0885));
		expect(low.net).toBe(netPay({ gross: 120000, claims_general_relief: true, dependents: 0 }, rates).net);

		const secondary = netPay({ gross: 200000, claims_general_relief: true, dependents: 2, secondary_employer: true }, rates);
		expect(secondary.general_relief).toBe(0);
		expect(secondary.dependent_relief).toBe(0);
		expect(secondary.income_tax).toBe(Math.round(secondary.tax_base * 0.25));
		expect(secondary.health_flat).toBe(0);

		const year2026 = SLOVENIA_PRESETS.find((preset) => preset.period === "2026-01")!.rates;
		const typical = netPay({ gross: 200000, claims_general_relief: true, dependents: 0 }, year2026);
		expect(typical.general_relief).toBe(Math.round(555193 / 12));
		expect(typical.tax_base).toBe(200000 - 46200 - 3717 - 46266);
		expect(typical.income_tax).toBe(Math.round(81012 * 0.16 + (103817 - 81012) * 0.26));

		const payslip = netPay({ gross: 303000, claims_general_relief: true, dependents: 0 }, year2026);
		expect(payslip.employee_contributions_total + payslip.health_flat).toBe(73710);
		expect(payslip.tax_base).toBe(183024);
		expect(payslip.income_tax).toBe(39485);
		expect(payslip.net).toBe(189805);
	});

	test("regres, winter regres, benefits and refunds follow their tax-free limits", async () => {
		const runs = await call("GET", `${base()}/payroll/runs`, tokens.owner);
		const run = runs.data.find((entry: { period: string }) => entry.period === "2026-04");
		expect(run.status).toBe("draft");
		await call("PUT", `${base()}/payroll/rates/2025-07`, tokens.owner, {
			rates: { ...SLOVENIA_PRESET.rates, average_wage: 250000, minimum_wage: 148188 },
			verified: true,
		});
		await call("PUT", `${base()}/employees/${members.colleague}`, tokens.owner, { private: { commute_km: 10 } });
		const recalculated = await call("POST", `${base()}/payroll/runs/${run.uuid}/recalculate`, tokens.owner);
		const line = recalculated.data.lines[0];
		expect(line.calculation.taxable_reimbursements).toEqual({ meal: 0, commute: 18 * 500 - 18 * 10 * 21 });
		expect(line.calculation.exempt_reimbursements.commute).toBe(18 * 10 * 21);

		const withExtras = await call("PUT", `${base()}/payroll/runs/${run.uuid}/lines/${line.uuid}/items`, tokens.owner, {
			items: [
				{ type: "benefit", description: "Company phone", amount: 5000 },
				{ type: "regres", description: "Regres 2026", amount: 300000 },
				{ type: "winter_regres", description: "Winter regres", amount: 80000 },
				{ type: "business_performance", description: "Christmas bonus", amount: 50000 },
			],
		});
		expect(withExtras.error).toBe(0);
		const calculation = withExtras.data.lines[0].calculation;
		expect(calculation.benefits).toBe(5000);
		expect(calculation.gross).toBe(calculation.salary_gross + 5000 + calculation.taxable_reimbursements.commute);
		expect(calculation.regres).toMatchObject({ amount: 300000, exempt: 250000, taxable: 50000 });
		expect(calculation.regres.income_tax).toBe(
			Math.round(
				(50000 - Object.values(calculation.regres.employee_contributions as Record<string, number>).reduce((sum, value) => sum + value, 0)) *
					(calculation.net.income_tax / calculation.net.tax_base)
			)
		);
		expect(calculation.performance.winter).toEqual({ amount: 80000, exempt: 74094 });
		expect(calculation.performance.business).toEqual({ amount: 50000, exempt: 50000 });
		expect(calculation.performance.taxable).toBe(80000 - 74094);
		expect(calculation.payout).toBe(
			calculation.net.net -
				5000 -
				calculation.taxable_reimbursements.commute +
				calculation.reimbursements +
				calculation.regres.net +
				calculation.performance.net -
				calculation.deductions
		);

		await call("PUT", `${base()}/employees/${members.colleague}`, tokens.owner, { private: { salary: 100000 } });
		const final = await call("POST", `${base()}/payroll/runs/${run.uuid}/finalize`, tokens.owner);
		expect(final.data.status).toBe("final");
		const low = final.data.lines[0].calculation;
		expect(low.net.base_difference).toBeGreaterThan(0);
		expect(low.contribution_floor).toBe(143695);

		const query = "responsible=Ana%20Owner&contact=041000000&collective_agreement=999";
		const salary = await download(`${base()}/payroll/runs/${run.uuid}/rek-o?${query}&kind=salary`, tokens.owner);
		expect(salary.status).toBe(200);
		expect(salary.text).toContain("<podo:A051>1102</podo:A051><podo:A052>50.00</podo:A052>");
		expect(salary.text).toContain("<podo:A054a>B05</podo:A054a>");
		expect(salary.text).toContain("<podo:A061>P02</podo:A061>");
		expect(salary.text).toContain("<podo:M08>");
		expect(salary.text).toContain("<podo:B017>50.00</podo:B017>");
		const regres = await download(`${base()}/payroll/runs/${run.uuid}/rek-o?${query}&kind=regres`, tokens.owner);
		expect(regres.text).toContain("<F010>1090</F010>");
		expect(regres.text).toContain("<podo:A051>1103</podo:A051><podo:A052>3000.00</podo:A052><podo:A052a>500.00</podo:A052a>");
		const performance = await download(`${base()}/payroll/runs/${run.uuid}/rek-o?${query}&kind=performance`, tokens.owner);
		expect(performance.text).toContain("<F010>1151</F010>");
		expect(performance.text).toContain("<podo:A051>1112</podo:A051><podo:A052>800.00</podo:A052><podo:A052a>59.06</podo:A052a>");
		if (xmllint) {
			for (const file of [salary, regres, performance]) expect(schemaErrors("rek/REK_O_1.xsd", file.text)).toBe("");
		}

		const payslip = await Server.app.handle(
			new Request(`http://127.0.0.1/api/v1${base()}/payroll/runs/${run.uuid}/payslips`, { headers: { Authorization: `Bearer ${tokens.owner}` } })
		);
		expect(payslip.headers.get("Content-Type")).toBe("application/pdf");
		const pdf = new TextDecoder("latin1").decode(await payslip.arrayBuffer());
		expect(pdf.match(/\/Type \/Page\b/g)!.length).toBeLessThanOrEqual(2);
		await call("POST", `${base()}/payroll/runs/${run.uuid}/reopen`, tokens.owner);
		await call("PUT", `${base()}/employees/${members.colleague}`, tokens.owner, { private: { salary: 200000 } });
	});

	test("employers pay sick leave only for the first days of each case", () => {
		const days = Array.from({ length: 25 }, (_, index) => ({
			date: `2026-01-${String(index + 1).padStart(2, "0")}`,
			weekday: 1,
			holiday: null,
			working_day: true,
			employed: true,
			worked_minutes: 0,
			overtime_minutes: 0,
			night_minutes: 0,
			break_minutes: 0,
			onsite_minutes: 0,
			activity_minutes: { ticket: 0, internal: 0, administration: 0, training: 0, available: 0, waiting_home: 0 },
			entries: 0,
			shifts: [],
			absences: [{ uuid: "case", kind: "sick" as const, status: "approved" as const, minutes: 480, case_day: index + 1 }],
		}));
		const line = payrollLine(
			{
				member: "m",
				person: "Sick Person",
				daily_minutes: 480,
				days,
				totals: {
					fund_minutes: 0,
					worked_minutes: 0,
					overtime_minutes: 0,
					night_minutes: 0,
					sunday_minutes: 0,
					holiday_work_minutes: 0,
					holiday_minutes: 0,
					onsite_minutes: 0,
					activity_minutes: { ticket: 0, internal: 0, administration: 0, training: 0, available: 0, waiting_home: 0 },
					absence_minutes: { vacation: 0, sick: 25 * 480, injury: 0, paid_leave: 0, unpaid: 0, parental: 0, other: 0 },
					days_worked: 0,
					meal_days: 0,
					commute_days: 0,
					balance_minutes: 0,
				},
			},
			{ from: "2026-02-01", to: "2026-02-28" },
			{ employment_type: "full_time", pay_type: "hourly" },
			{ salary: 1000, commute_per_day: null },
			DEFAULT_WORKFORCE_CONFIG
		);
		expect(line.minutes.sick_employer).toBe(20 * 480);
		expect(line.minutes.sick_insurance).toBe(5 * 480);
		expect(line.amounts.sick).toBe(Math.round(20 * 8 * 1000 * 0.8));
	});

	test("the seniority bonus grows with each full year of total service", () => {
		expect(serviceSpan("2023-07-10", 0, "2025-12-31")).toEqual({ months: 29, days: 21 });
		expect(serviceSpan("2023-07-10", 0, "2023-08-09")).toEqual({ months: 0, days: 30 });
		expect(serviceSpan("2023-07-10", 0, "2023-08-10")).toEqual({ months: 1, days: 0 });
		expect(serviceSpan("2027-01-01", 14, "2026-01-31")).toEqual({ months: 14, days: 0 });
		expect(serviceSpan(null, 25, "2026-01-31")).toEqual({ months: 25, days: 0 });

		const days = Array.from({ length: 20 }, (_, index) => ({
			date: `2026-01-${String(index + 5).padStart(2, "0")}`,
			weekday: 1,
			holiday: null,
			working_day: true,
			employed: true,
			worked_minutes: 480,
			overtime_minutes: 0,
			night_minutes: 0,
			break_minutes: 0,
			onsite_minutes: 480,
			activity_minutes: { ticket: 0, internal: 480, administration: 0, training: 0, available: 0, waiting_home: 0 },
			entries: 1,
			shifts: [],
			absences: [],
		}));
		const month = {
			member: "m",
			person: "Long Serving",
			daily_minutes: 480,
			days,
			totals: {
				fund_minutes: 22 * 480,
				worked_minutes: 20 * 480,
				overtime_minutes: 0,
				night_minutes: 0,
				sunday_minutes: 0,
				holiday_work_minutes: 0,
				holiday_minutes: 2 * 480,
				onsite_minutes: 20 * 480,
				activity_minutes: { ticket: 0, internal: 20 * 480, administration: 0, training: 0, available: 0, waiting_home: 0 },
				absence_minutes: { vacation: 0, sick: 0, injury: 0, paid_leave: 0, unpaid: 0, parental: 0, other: 0 },
				days_worked: 20,
				meal_days: 20,
				commute_days: 20,
				balance_minutes: 0,
			},
		};
		const range = { from: "2026-01-01", to: "2026-01-31" };
		const details = { salary: 300000, commute_per_day: null };
		const seasoned = payrollLine(
			month,
			range,
			{ employment_type: "full_time", pay_type: "monthly", started_on: "2023-07-10", prior_service_months: 0 },
			details,
			DEFAULT_WORKFORCE_CONFIG
		);
		expect(seasoned.service_months).toBe(29);
		expect(seasoned.service_days).toBe(21);
		expect(seasoned.seniority_percent).toBe(1);
		expect(seasoned.amounts.seniority).toBe(3000);
		expect(seasoned.amounts.gross).toBe(303000);

		const veteran = payrollLine(
			month,
			range,
			{ employment_type: "full_time", pay_type: "monthly", started_on: "2023-07-10", prior_service_months: 15 * 12 + 7 },
			details,
			{ ...DEFAULT_WORKFORCE_CONFIG, seniority_rate: 0.6 }
		);
		expect(veteran.seniority_percent).toBe(10.8);
		expect(veteran.amounts.seniority).toBe(32400);

		const student = payrollLine(
			month,
			range,
			{ employment_type: "student", pay_type: "hourly", started_on: "2010-01-01", prior_service_months: 60 },
			{ salary: 1000, commute_per_day: null },
			DEFAULT_WORKFORCE_CONFIG
		);
		expect(student.service_months).toBeNull();
		expect(student.amounts.seniority).toBe(0);
	});

	test("removed members who are invited again keep their records", async () => {
		const [before] = await Database`SELECT COUNT(*) AS count FROM time_entries WHERE member = ${members.employee}`;
		expect(Number(before.count)).toBeGreaterThan(0);
		const removed = await call("DELETE", `${base()}/members/${members.employee}`, tokens.owner);
		expect(removed.error).toBe(0);
		const locked = await call("GET", `${base()}/workforce`, tokens.employee);
		expect(locked.error).not.toBe(0);

		const invited = await call("POST", `${base()}/members`, tokens.owner, { email: "wf-employee@team.test", role: "supervisor" });
		expect(invited.error).toBe(0);
		expect(invited.data.uuid).toBe(members.employee);
		const back = await call("GET", `${base()}/workforce`, tokens.employee);
		expect(back.data.me).toMatchObject({ member: members.employee, edit: true });
		const [after] = await Database`SELECT COUNT(*) AS count FROM time_entries WHERE member = ${members.employee}`;
		expect(Number(after.count)).toBe(Number(before.count));
	});

	test("an accepted invitation takes over the records of an earlier membership", async () => {
		await call("DELETE", `${base()}/members/${members.colleague}`, tokens.owner);
		const invitation = crypto.randomUUID();
		const token = "t".repeat(64);
		const now = Date.now();
		await Database`
			INSERT INTO project_members(uuid, project_id, role, invitation_token, invitation_email, status, created, updated)
			VALUES(${invitation}, ${project}, 'employee', ${token}, 'new-address@team.test', 'pending', ${now}, ${now})
		`;
		const accepted = await call("POST", `/invitations/${token}/accept`, tokens.colleague);
		expect(accepted.error).toBe(0);
		const [moved] = await Database`SELECT COUNT(*) AS count FROM time_entries WHERE member = ${invitation}`;
		expect(Number(moved.count)).toBe(18);
		const [employee] = await Database`SELECT member FROM employees WHERE member = ${invitation}`;
		expect(employee).toBeDefined();
	});
});

describe("employee seats", () => {
	const seatMembers: string[] = [];

	test("a workforce license covers five people, counting everyone who logs time", async () => {
		const state = (await call("GET", `${base()}/license`, tokens.owner)).data;
		expect(state).toMatchObject({ employees_included: 5, employees_licensed: 0, employees_used: 4, employees_limit: 5, employee_seats: [] });
		const workforce = (await call("GET", `${base()}/workforce`, tokens.owner)).data;
		expect(workforce.license).toMatchObject({ active: true, seats_exceeded: false, employees_used: 4, employees_limit: 5 });
	});

	test("invitations and role changes past the limit are refused, other roles are not", async () => {
		const held = await call("POST", `${base()}/members`, tokens.owner, { email: "seat-held@team.test", role: "employee" });
		expect(held.error).toBe(0);
		const refused = await call("POST", `${base()}/members`, tokens.owner, { email: "seat-over@team.test", role: "supervisor" });
		expect(refused.status).toBe(402);
		expect(refused.error).toBe(1243);

		const viewer = await call("POST", `${base()}/members`, tokens.owner, { email: "seat-viewer@team.test", role: "viewer" });
		expect(viewer.error).toBe(0);
		expect((await call("PATCH", `${base()}/members/${viewer.data.uuid}`, tokens.owner, { role: "employee" })).error).toBe(1243);
		expect((await call("PATCH", `${base()}/members/${held.data.uuid}`, tokens.owner, { role: "supervisor" })).error).toBe(0);
		expect((await call("PUT", `${base()}/employees/${viewer.data.uuid}`, tokens.owner, { employment_type: "full_time" })).error).toBe(1243);
	});

	test("seat keys add people for their own number of days", async () => {
		await Database`UPDATE accounts SET admin = 1 WHERE username = 'wf-owner'`;
		expect((await call("POST", "/admin/licenses", tokens.owner, { type: "employees", duration_days: 30 })).error).toBe(1095);
		expect((await call("POST", "/admin/licenses", tokens.owner, { type: "employees", employees: 2 })).error).toBe(1095);
		expect((await call("POST", "/admin/licenses", tokens.owner, { type: "employees", employees: 0, duration_days: 30 })).error).toBe(1095);
		const created = await call("POST", "/admin/licenses", tokens.owner, { type: "employees", employees: 2, duration_days: 30 });
		expect(created.data[0]).toMatchObject({ type: "employees", employees: 2, duration_days: 30 });
		await Database`UPDATE accounts SET admin = 0 WHERE username = 'wf-owner'`;

		const redeemed = await call("POST", `${base()}/license/redeem`, tokens.owner, { code: created.data[0].code });
		expect(redeemed.error).toBe(0);
		expect(redeemed.data).toMatchObject({ employees_licensed: 2, employees_limit: 7 });
		expect(redeemed.data.employee_seats[0].until).toBeGreaterThan(Date.now() + 29 * 86400000);

		for (const name of ["wf-seat-a", "wf-seat-b"]) {
			await account(name);
			seatMembers.push(await member(name, "employee", name));
		}
		const state = (await call("GET", `${base()}/license`, tokens.owner)).data;
		expect(state).toMatchObject({ employees_used: 6, employees_limit: 7 });
		expect((await call("POST", `${base()}/members`, tokens.owner, { email: "seat-over@team.test", role: "supervisor" })).error).toBe(1243);
	});

	test("when seat keys run out, the workforce is read only until people are removed", async () => {
		await Database`UPDATE license_keys SET redeemed_at = ${Date.now() - 31 * 86400000} WHERE type = 'employees' AND redeemed_project = ${project}`;

		const state = (await call("GET", `${base()}/workforce`, tokens.employee)).data;
		expect(state.license).toMatchObject({ active: false, seats_exceeded: true, employees_used: 6, employees_limit: 5 });
		const blocked = await call("POST", `${base()}/timesheets`, tokens.owner, entry(today, "06:00", "07:00"));
		expect(blocked.status).toBe(402);
		expect(blocked.error).toBe(1243);
		expect((await call("DELETE", `${base()}/employees/${seatMembers[0]}`, tokens.owner)).error).toBe(1208);

		for (const uuid of seatMembers) expect((await call("DELETE", `${base()}/members/${uuid}`, tokens.owner)).error).toBe(0);
		const restored = (await call("GET", `${base()}/workforce`, tokens.owner)).data;
		expect(restored.license).toMatchObject({ active: true, seats_exceeded: false, employees_used: 4, employees_limit: 5 });
	});
});

describe("ticket files", () => {
	let ticket = "";
	let file = "";

	async function sendPart(uuid: string, index: number, bytes: Uint8Array, token: string): Promise<Result> {
		const response = await Server.app.handle(
			new Request(`http://127.0.0.1/api/v1${base()}/files/${uuid}/parts/${index}`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
				body: bytes,
			})
		);
		return { status: response.status, ...((await response.json()) as Omit<Result, "status">) };
	}

	async function attach(name: string, type: string, bytes: Uint8Array, token = tokens.employee): Promise<Result> {
		const begun = await call("POST", `${base()}/tickets/${ticket}/files`, token, { name, type, size: bytes.length });
		if (begun.error !== 0) return begun;
		let stored = begun;
		for (let index = 0; index < begun.data.parts; index++) {
			stored = await sendPart(begun.data.uuid, index, bytes.subarray(index * begun.data.part_bytes, (index + 1) * begun.data.part_bytes), token);
			if (stored.error !== 0) return stored;
		}
		return stored;
	}

	const text = (value: string) => new TextEncoder().encode(value);

	test("files are attached to tickets and downloaded as attachments", async () => {
		ticket = (await call("POST", `${base()}/tickets`, tokens.supervisor, { title: "Broken printer" })).data.uuid;
		const uploaded = await attach("C:\\photos\\printer.png", "image/png", text("screenshot bytes"));
		expect(uploaded.error).toBe(0);
		expect(uploaded.data).toMatchObject({ file_name: "printer.png", content_type: "image/png", byte_size: 16, ready: true, removed: false });
		expect(uploaded.data.created_by_name).toBe("Eva Employee");
		file = uploaded.data.uuid;

		const detail = await call("GET", `${base()}/tickets/${ticket}`, tokens.colleague);
		expect(detail.data.files.map((row: { uuid: string }) => row.uuid)).toEqual([file]);
		expect(detail.data.max_file_bytes).toBe(25_000_000);

		const response = await Server.app.handle(
			new Request(`http://127.0.0.1/api/v1${base()}/files/${file}`, { headers: { Authorization: `Bearer ${tokens.colleague}` } })
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Disposition")).toContain('attachment; filename="printer.png"');
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(await response.text()).toBe("screenshot bytes");

		const link = await call("POST", `${base()}/files/${file}/link`, tokens.colleague);
		expect(link.data.path).toMatch(/^\/api\/v1\/file-downloads\/[0-9a-f]{64}$/);
		const linked = await Server.app.handle(new Request(`http://127.0.0.1${link.data.path}`));
		expect(linked.status).toBe(200);
		expect(await linked.text()).toBe("screenshot bytes");
		const guessed = await Server.app.handle(new Request(`http://127.0.0.1/api/v1/file-downloads/${"0".repeat(64)}`));
		expect(guessed.status).toBe(404);
	});

	test("large files arrive in ordered parts and unfinished uploads stay hidden", async () => {
		await call("PUT", `${base()}/files/settings`, tokens.owner, { max_file_mb: 40 });
		const bytes = new Uint8Array(16_000_000 + 5);
		bytes.fill(7);
		bytes[bytes.length - 1] = 9;
		const begun = await call("POST", `${base()}/tickets/${ticket}/files`, tokens.employee, { name: "clip.mp4", type: "video/mp4", size: bytes.length });
		expect(begun.data).toMatchObject({ parts: 2, part_bytes: 16_000_000, ready: false });
		const uuid = begun.data.uuid;

		expect((await sendPart(uuid, 1, bytes.subarray(16_000_000), tokens.employee)).error).toBe(1308);
		expect((await sendPart(uuid, 0, bytes.subarray(0, 100), tokens.employee)).error).toBe(1308);
		expect((await sendPart(uuid, 0, bytes.subarray(0, 16_000_000), tokens.colleague)).error).toBe(9999);
		expect((await sendPart(uuid, 0, bytes.subarray(0, 16_000_000), tokens.employee)).data.ready).toBe(false);
		expect((await call("GET", `${base()}/tickets/${ticket}`, tokens.employee)).data.files).toHaveLength(1);
		expect((await call("GET", `${base()}/files/${uuid}`, tokens.employee)).error).toBe(1305);
		expect((await call("GET", `${base()}/license`, tokens.owner)).data.file_storage_used).toBe(16 + bytes.length);
		expect((await sendPart(uuid, 0, bytes.subarray(0, 16_000_000), tokens.employee)).error).toBe(0);
		expect((await sendPart(uuid, 1, bytes.subarray(16_000_000), tokens.employee)).data.ready).toBe(true);
		expect((await sendPart(uuid, 1, bytes.subarray(16_000_000), tokens.employee)).error).toBe(1308);

		const response = await Server.app.handle(
			new Request(`http://127.0.0.1/api/v1${base()}/files/${uuid}`, { headers: { Authorization: `Bearer ${tokens.employee}` } })
		);
		expect(response.headers.get("Content-Length")).toBe(String(bytes.length));
		const downloaded = new Uint8Array(await response.arrayBuffer());
		expect(downloaded.length).toBe(bytes.length);
		expect(downloaded[0]).toBe(7);
		expect(downloaded[downloaded.length - 1]).toBe(9);
		expect((await call("DELETE", `${base()}/files/${uuid}`, tokens.employee)).error).toBe(0);

		const abandoned = await call("POST", `${base()}/tickets/${ticket}/files`, tokens.employee, { name: "half.mp4", type: "video/mp4", size: 1000 });
		await Database`UPDATE project_files SET created = ${Date.now() - 25 * 3600000} WHERE uuid = ${abandoned.data.uuid}`;
		expect(await discardAbandonedUploads()).toBe(1);
		expect((await call("GET", `${base()}/license`, tokens.owner)).data.file_storage_used).toBe(16);
		await call("PUT", `${base()}/files/settings`, tokens.owner, { max_file_mb: 25 });
	});

	test("the project chooses its largest file up to what the server allows", async () => {
		const path = `${base()}/tickets/${ticket}/files`;
		expect((await call("POST", path, tokens.employee, { name: "big.mov", type: "video/quicktime", size: 25_000_001 })).error).toBe(1307);
		expect((await call("PUT", `${base()}/files/settings`, tokens.supervisor, { max_file_mb: 100 })).error).toBe(9999);
		expect((await call("PUT", `${base()}/files/settings`, tokens.owner, { max_file_mb: 0 })).error).toBe(1309);
		expect((await call("PUT", `${base()}/files/settings`, tokens.owner, { max_file_mb: 5001 })).error).toBe(1309);
		const raised = await call("PUT", `${base()}/files/settings`, tokens.owner, { max_file_mb: 2000 });
		expect(raised.data).toEqual({ max_file_bytes: 2_000_000_000, max_file_bytes_ceiling: 5_000_000_000, max_member_file_bytes: null });
		const begun = await call("POST", path, tokens.employee, { name: "big.mov", type: "video/quicktime", size: 25_000_001 });
		expect(begun.status).toBe(201);
		expect(begun.data.parts).toBe(2);
		expect((await call("DELETE", `${base()}/files/${begun.data.uuid}`, tokens.employee)).error).toBe(0);

		Settings.licensing.max_file_mb = 10;
		try {
			expect((await call("GET", `${base()}/tickets/${ticket}`, tokens.employee)).data.max_file_bytes).toBe(10_000_000);
			expect((await call("POST", path, tokens.employee, { name: "big.mov", type: "video/quicktime", size: 10_000_001 })).error).toBe(1307);
		} finally {
			Settings.licensing.max_file_mb = 5000;
		}
		await call("PUT", `${base()}/files/settings`, tokens.owner, { max_file_mb: 25 });
	});

	test("invalid uploads are refused", async () => {
		const path = `${base()}/tickets/${ticket}/files`;
		expect((await call("POST", path, tokens.employee, { name: "", type: "image/png", size: 1 })).error).toBe(1304);
		expect((await call("POST", path, tokens.employee, { name: "empty.txt", type: "text/plain", size: 0 })).error).toBe(1304);
		expect((await call("POST", path, tokens.employee, { name: "odd.txt", type: "text/plain", size: 1.5 })).error).toBe(1304);
		expect((await call("POST", `${base()}/tickets/${crypto.randomUUID()}/files`, tokens.employee, { name: "a.txt", size: 1 })).error).toBe(1202);
		const untyped = await attach("notes", "<script>", text("plain"));
		expect(untyped.data.content_type).toBe("application/octet-stream");
		expect((await call("DELETE", `${base()}/files/${untyped.data.uuid}`, tokens.employee)).error).toBe(0);
	});

	test("file storage has its own limit that never blocks invoices", async () => {
		const state = (await call("GET", `${base()}/license`, tokens.owner)).data;
		expect(state).toMatchObject({ file_storage_included: 10_000_000_000, file_storage_licensed: 0, file_storage_used: 16, file_storage_grants: [] });
		expect(state.storage_used).toBe(0);

		Settings.licensing.free_file_storage_gb = 0;
		try {
			const full = await attach("more.txt", "text/plain", text("more"));
			expect(full.status).toBe(402);
			expect(full.error).toBe(1303);
			expect((await call("GET", `${base()}/files/${file}`, tokens.employee)).status).toBe(200);
			expect(await hasStorageCapacity(project)).toBe(true);

			const code = generateLicenseCode();
			const now = Date.now();
			await Database`INSERT INTO license_keys(uuid, code, type, duration_days, storage_gb, status, created, updated)
				VALUES(${crypto.randomUUID()}, ${code}, 'files', 30, 5, 'available', ${now}, ${now})`;
			const redeemed = await call("POST", `${base()}/license/redeem`, tokens.owner, { code });
			expect(redeemed.data).toMatchObject({ file_storage_included: 0, file_storage_licensed: 5_000_000_000, storage_licensed: 0 });
			expect(redeemed.data.file_storage_grants).toHaveLength(1);
			expect((await attach("more.txt", "text/plain", text("more"))).data.ready).toBe(true);
		} finally {
			Settings.licensing.free_file_storage_gb = 10;
		}
	});

	test("administrators see the largest files and removing one leaves a trace on the ticket", async () => {
		expect((await call("GET", `${base()}/files`, tokens.supervisor)).error).toBe(9999);
		const list = await call("GET", `${base()}/files`, tokens.owner);
		expect(list.data.total).toBe(2);
		expect(list.data.files.map((row: { file_name: string }) => row.file_name)).toEqual(["printer.png", "more.txt"]);
		expect(list.data.files[0].tickets).toMatchObject([{ uuid: ticket, title: "Broken printer" }]);
		expect(list.data).toMatchObject({ file_storage_used: 20, max_file_bytes: 25_000_000, max_file_bytes_ceiling: 5_000_000_000 });

		expect((await call("DELETE", `${base()}/files/${file}`, tokens.colleague)).error).toBe(9999);
		const removed = await call("DELETE", `${base()}/files/${file}`, tokens.owner);
		expect(removed.data).toMatchObject({ uuid: file, removed: true, removed_by: "wf-owner" });
		expect((await call("DELETE", `${base()}/files/${file}`, tokens.owner)).error).toBe(1306);
		const gone = await call("GET", `${base()}/files/${file}`, tokens.employee);
		expect(gone.status).toBe(410);
		expect(gone.error).toBe(1306);

		const detail = await call("GET", `${base()}/tickets/${ticket}`, tokens.employee);
		expect(detail.data.files[0]).toMatchObject({ uuid: file, file_name: "printer.png", removed: true });
		expect(detail.data.files[0].removed_at).toBeGreaterThan(0);
		const after = await call("GET", `${base()}/files`, tokens.owner);
		expect(after.data.total).toBe(1);
		expect(after.data.file_storage_used).toBe(4);
	});

	test("customers do not see ticket files and deleting a ticket frees its files", async () => {
		await call("PATCH", `${base()}/tickets/${ticket}`, tokens.supervisor, { customer, customer_visible: true });
		await call("PUT", `${base()}/customers/${customer}/ticket-access`, tokens.supervisor, { enabled: true, kinds: [] });
		const portal = await customerLogin("client@acme.test");
		const seen = await call("GET", `/customer/tickets/${ticket}`, portal);
		expect(seen.error).toBe(0);
		expect(seen.data.files).toBeUndefined();

		expect((await call("DELETE", `${base()}/tickets/${ticket}`, tokens.supervisor)).error).toBe(0);
		const [left] = await Database`SELECT COUNT(*) AS count FROM project_files WHERE project = ${project}`;
		expect(Number(left.count)).toBe(0);
		expect((await call("GET", `${base()}/license`, tokens.owner)).data.file_storage_used).toBe(0);
	});
});

describe("file explorer", () => {
	let contracts = "";
	let drafts = "";
	let contract = "";

	async function store(name: string, bytes: Uint8Array, token: string, folder: string | null = null): Promise<Result> {
		const begun = await call("POST", `${base()}/explorer/files`, token, { name, type: "text/plain", size: bytes.length, folder });
		if (begun.error !== 0) return begun;
		const response = await Server.app.handle(
			new Request(`http://127.0.0.1/api/v1${base()}/files/${begun.data.uuid}/parts/0`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
				body: bytes,
			})
		);
		return { status: response.status, ...((await response.json()) as Omit<Result, "status">) };
	}

	const names = (rows: { name?: string; file_name?: string }[]) => rows.map((row) => row.name ?? row.file_name);
	const sharedBy = async (owner: string, token: string) => {
		const listed = await call("GET", `${base()}/explorer?scope=shared&owner=${owner}`, token);
		return listed.error === 1311 ? { folders: [], files: [] } : listed.data;
	};
	const text = (value: string) => new TextEncoder().encode(value);

	test("folders and files start out private to the person who made them", async () => {
		const created = await call("POST", `${base()}/explorer/folders`, tokens.employee, { name: " Contracts " });
		expect(created.status).toBe(201);
		expect(created.data).toMatchObject({ name: "Contracts", parent: null, access: "private", members: [], can_manage: true });
		contracts = created.data.uuid;
		expect((await call("POST", `${base()}/explorer/folders`, tokens.employee, { name: "a/b" })).error).toBe(1312);
		expect((await call("POST", `${base()}/explorer/folders`, tokens.employee, { name: "" })).error).toBe(1312);

		const stored = await store("agreement.txt", text("signed agreement"), tokens.employee, contracts);
		expect(stored.data).toMatchObject({ file_name: "agreement.txt", ready: true });
		contract = stored.data.uuid;
		expect((await store("notes.txt", text("my notes"), tokens.employee)).error).toBe(0);

		const mine = await call("GET", `${base()}/explorer`, tokens.employee);
		expect(names(mine.data.folders)).toEqual(["Contracts"]);
		expect(names(mine.data.files)).toEqual(["notes.txt"]);
		expect(mine.data).toMatchObject({ used: 24, limit: null, folder: null, path: [] });
		const inside = await call("GET", `${base()}/explorer?folder=${contracts}`, tokens.employee);
		expect(names(inside.data.files)).toEqual(["agreement.txt"]);
		expect(inside.data.path).toEqual([{ uuid: contracts, name: "Contracts" }]);

		const other = await call("GET", `${base()}/explorer`, tokens.colleague);
		expect(other.data.folders).toEqual([]);
		expect(other.data.files).toEqual([]);
		expect((await call("GET", `${base()}/explorer?folder=${contracts}`, tokens.colleague)).error).toBe(1311);
		expect((await call("GET", `${base()}/files/${contract}`, tokens.colleague)).error).toBe(1305);
		expect((await call("POST", `${base()}/files/${contract}/link`, tokens.colleague)).error).toBe(1305);
		expect((await call("DELETE", `${base()}/files/${contract}`, tokens.colleague)).error).toBe(1305);
		expect((await store("sneak.txt", text("x"), tokens.colleague, contracts)).error).toBe(1311);
		expect((await call("GET", `${base()}/files/${contract}`, tokens.owner)).status).toBe(200);
	});

	test("a top folder is shared with everyone or with chosen people", async () => {
		const everyone = await call("PATCH", `${base()}/explorer/folders/${contracts}`, tokens.employee, { access: "everyone" });
		expect(everyone.data).toMatchObject({ access: "everyone", members: [] });
		expect(names((await sharedBy("wf-employee", tokens.colleague)).folders)).toEqual(["Contracts"]);
		const landing = await call("GET", `${base()}/explorer`, tokens.colleague);
		expect(landing.data).toMatchObject({ folders: [], files: [], shared_people: 1, everyone_people: null, scope: null });
		const givers = await call("GET", `${base()}/explorer?scope=shared`, tokens.colleague);
		expect(givers.data.people).toEqual([{ username: "wf-employee", name: "Eva Employee", email: "wf-employee@team.test", items: 1 }]);
		expect((await call("GET", `${base()}/explorer?scope=all`, tokens.colleague)).error).toBe(1311);
		const opened = await call("GET", `${base()}/explorer?folder=${contracts}`, tokens.colleague);
		expect(opened.data.origin).toEqual({ scope: "shared", owner: { username: "wf-employee", name: "Eva Employee", email: "wf-employee@team.test" } });
		expect((await call("GET", `${base()}/explorer?folder=${contracts}`, tokens.employee)).data.origin).toBe(null);
		expect((await call("GET", `${base()}/files/${contract}`, tokens.colleague)).status).toBe(200);
		expect((await call("DELETE", `${base()}/files/${contract}`, tokens.colleague)).error).toBe(9999);
		expect((await call("PATCH", `${base()}/explorer/folders/${contracts}`, tokens.colleague, { access: "private" })).error).toBe(9999);
		expect((await call("PATCH", `${base()}/explorer/folders/${contracts}`, tokens.colleague, { name: "Mine now" })).error).toBe(9999);
		expect((await store("addendum.txt", text("addendum"), tokens.colleague, contracts)).data.ready).toBe(true);

		const chosen = await call("PATCH", `${base()}/explorer/folders/${contracts}`, tokens.employee, {
			access: "members",
			members: ["wf-super", "wf-super", "nobody-here"],
		});
		expect(chosen.data).toMatchObject({ access: "members", members: ["wf-super"] });
		expect((await sharedBy("wf-employee", tokens.colleague)).folders).toEqual([]);
		expect((await call("GET", `${base()}/explorer`, tokens.colleague)).data.shared_people).toBe(0);
		expect((await call("GET", `${base()}/files/${contract}`, tokens.colleague)).error).toBe(1305);
		const shared = await call("GET", `${base()}/explorer?folder=${contracts}`, tokens.supervisor);
		expect(names(shared.data.files)).toEqual(["addendum.txt", "agreement.txt"]);
		expect(shared.data.sharing).toEqual([{ uuid: contracts, name: "Contracts", access: "members", members: ["wf-super"] }]);
		expect(shared.data.folder).toMatchObject({ can_manage: false });
		expect((await call("PATCH", `${base()}/explorer/folders/${contracts}`, tokens.employee, { access: "nobody" })).error).toBe(1312);
		expect((await call("PATCH", `${base()}/explorer/folders/${contracts}`, tokens.owner, { access: "everyone" })).data.access).toBe("everyone");
	});

	test("folders nest, move and rename without ending up inside themselves", async () => {
		drafts = (await call("POST", `${base()}/explorer/folders`, tokens.colleague, { name: "Drafts", parent: contracts })).data.uuid;
		const nested = await call("GET", `${base()}/explorer?folder=${drafts}`, tokens.supervisor);
		expect(nested.data.path.map((step: { name: string }) => step.name)).toEqual(["Contracts", "Drafts"]);
		expect(nested.data.folder).toMatchObject({ access: "private", can_manage: false });
		expect((await call("PATCH", `${base()}/explorer/folders/${contracts}`, tokens.employee, { parent: drafts })).error).toBe(1313);
		expect((await call("PATCH", `${base()}/explorer/folders/${contracts}`, tokens.employee, { parent: contracts })).error).toBe(1313);

		const renamed = await call("PATCH", `${base()}/explorer/folders/${drafts}`, tokens.colleague, { name: "Old drafts" });
		expect(renamed.data.name).toBe("Old drafts");
		const moved = await call("PATCH", `${base()}/explorer/files/${contract}`, tokens.employee, { folder: drafts, name: "agreement-v2.txt" });
		expect(moved.data.file_name).toBe("agreement-v2.txt");
		expect(names((await call("GET", `${base()}/explorer?folder=${drafts}`, tokens.colleague)).data.files)).toEqual(["agreement-v2.txt"]);
		expect((await call("PATCH", `${base()}/explorer/files/${contract}`, tokens.supervisor, { name: "taken.txt" })).error).toBe(9999);

		const picker = await call("GET", `${base()}/explorer/folders`, tokens.supervisor);
		expect(picker.data.map((row: { path: string[] }) => row.path.join(" / "))).toEqual(["Contracts", "Contracts / Old drafts"]);

		const archive = (await call("POST", `${base()}/explorer/folders`, tokens.employee, { name: "Archive" })).data.uuid;
		const tucked = await call("PATCH", `${base()}/explorer/folders/${archive}`, tokens.employee, { parent: drafts });
		expect(tucked.data).toMatchObject({ parent: drafts, access: "private" });
		const surfaced = await call("PATCH", `${base()}/explorer/folders/${archive}`, tokens.employee, { parent: null });
		expect(surfaced.data).toMatchObject({ parent: null, access: "private" });
		expect((await call("DELETE", `${base()}/explorer/folders/${archive}`, tokens.employee)).data.files).toBe(0);
	});

	test("a subfolder or a single file is shared without opening the folder around it", async () => {
		await call("PATCH", `${base()}/explorer/folders/${contracts}`, tokens.employee, { access: "private" });
		expect((await call("GET", `${base()}/explorer`, tokens.supervisor)).data.shared_people).toBe(0);
		expect((await call("GET", `${base()}/explorer?folder=${drafts}`, tokens.supervisor)).error).toBe(1311);

		const shared = await call("PATCH", `${base()}/explorer/folders/${drafts}`, tokens.employee, { access: "members", members: ["wf-super"] });
		expect(shared.data).toMatchObject({ parent: contracts, access: "members", members: ["wf-super"] });
		const top = { data: await sharedBy("wf-colleague", tokens.supervisor) };
		expect(names(top.data.folders)).toEqual(["Old drafts"]);
		expect(top.data.folders[0]).toMatchObject({ can_manage: false, access: "members" });
		const inside = await call("GET", `${base()}/explorer?folder=${drafts}`, tokens.supervisor);
		expect(inside.data.path).toEqual([{ uuid: drafts, name: "Old drafts" }]);
		expect(names(inside.data.files)).toEqual(["agreement-v2.txt"]);
		expect(inside.data.sharing).toEqual([{ uuid: drafts, name: "Old drafts", access: "members", members: ["wf-super"] }]);
		expect((await call("GET", `${base()}/explorer?folder=${contracts}`, tokens.supervisor)).error).toBe(1311);
		expect((await call("GET", `${base()}/files/${contract}`, tokens.supervisor)).status).toBe(200);
		const picker = await call("GET", `${base()}/explorer/folders`, tokens.supervisor);
		expect(picker.data.map((row: { path: string[] }) => row.path.join(" / "))).toEqual(["Old drafts"]);
		expect((await call("PATCH", `${base()}/explorer/folders/${drafts}`, tokens.supervisor, { access: "everyone" })).error).toBe(9999);
		expect((await store("review.txt", text("looks fine"), tokens.supervisor, drafts)).data.ready).toBe(true);
		const review = (await call("GET", `${base()}/explorer?folder=${drafts}`, tokens.supervisor)).data.files.find(
			(file: { file_name: string }) => file.file_name === "review.txt"
		);
		expect((await call("DELETE", `${base()}/files/${review.uuid}`, tokens.supervisor)).error).toBe(0);

		await call("PATCH", `${base()}/explorer/folders/${drafts}`, tokens.employee, { access: "private" });
		expect((await call("GET", `${base()}/files/${contract}`, tokens.supervisor)).error).toBe(1305);
		const single = await call("PATCH", `${base()}/explorer/files/${contract}`, tokens.employee, { access: "members", members: ["wf-super"] });
		expect(single.data).toMatchObject({ access: "members", members: ["wf-super"], folder: drafts });
		const alone = { data: await sharedBy("wf-employee", tokens.supervisor) };
		expect(alone.data.folders).toEqual([]);
		expect(names(alone.data.files)).toEqual(["agreement-v2.txt"]);
		expect(alone.data.files[0]).toMatchObject({ can_manage: false, access: "members" });
		expect((await call("GET", `${base()}/files/${contract}`, tokens.supervisor)).status).toBe(200);
		expect((await call("PATCH", `${base()}/explorer/files/${contract}`, tokens.supervisor, { name: "mine.txt" })).error).toBe(9999);
		expect((await call("DELETE", `${base()}/files/${contract}`, tokens.supervisor)).error).toBe(9999);
		expect((await call("GET", `${base()}/explorer?folder=${drafts}`, tokens.supervisor)).error).toBe(1311);

		const notes = (await call("GET", `${base()}/explorer`, tokens.employee)).data.files.find((file: { file_name: string }) => file.file_name === "notes.txt");
		expect((await call("PATCH", `${base()}/explorer/files/${notes.uuid}`, tokens.employee, { access: "everyone" })).data.access).toBe("everyone");
		expect(names((await sharedBy("wf-employee", tokens.colleague)).files)).toEqual(["notes.txt"]);
		expect(names((await call("GET", `${base()}/explorer`, tokens.colleague)).data.files)).toEqual(["addendum.txt"]);
		expect((await call("PATCH", `${base()}/explorer/files/${notes.uuid}`, tokens.employee, { access: "nobody" })).error).toBe(1312);

		await call("PATCH", `${base()}/explorer/files/${notes.uuid}`, tokens.employee, { access: "private" });
		await call("PATCH", `${base()}/explorer/files/${contract}`, tokens.employee, { access: "private" });
		expect((await call("GET", `${base()}/explorer`, tokens.supervisor)).data.shared_people).toBe(0);
		expect((await sharedBy("wf-employee", tokens.colleague)).files).toEqual([]);
		await call("PATCH", `${base()}/explorer/folders/${contracts}`, tokens.owner, { access: "everyone" });
	});

	test("administrators browse everyone's files by person next to what was shared with them", async () => {
		const landing = await call("GET", `${base()}/explorer`, tokens.owner);
		expect(landing.data).toMatchObject({ folders: [], files: [], shared_people: 1, everyone_people: 1 });
		const everyone = await call("GET", `${base()}/explorer?scope=all`, tokens.owner);
		expect(everyone.data.people).toEqual([{ username: "wf-employee", name: "Eva Employee", email: "wf-employee@team.test", items: 2 }]);
		const theirs = await call("GET", `${base()}/explorer?scope=all&owner=wf-employee`, tokens.owner);
		expect(names(theirs.data.folders)).toEqual(["Contracts"]);
		expect(names(theirs.data.files)).toEqual(["notes.txt"]);
		expect(theirs.data.files[0].can_manage).toBe(true);
		expect(theirs.data.origin).toMatchObject({ scope: "all", owner: { username: "wf-employee" } });
		expect((await call("GET", `${base()}/explorer?scope=all&owner=wf-super`, tokens.owner)).error).toBe(1311);

		await call("PATCH", `${base()}/explorer/folders/${contracts}`, tokens.employee, { access: "private" });
		expect((await call("GET", `${base()}/explorer`, tokens.owner)).data).toMatchObject({ shared_people: 0, everyone_people: 1 });
		const inside = await call("GET", `${base()}/explorer?folder=${drafts}`, tokens.owner);
		expect(inside.data.origin).toMatchObject({ scope: "all", owner: { username: "wf-employee" } });
		expect(inside.data.path.map((step: { name: string }) => step.name)).toEqual(["Contracts", "Old drafts"]);
		await call("PATCH", `${base()}/explorer/folders/${contracts}`, tokens.owner, { access: "everyone" });
	});

	test("each person has a storage limit that administrators set and override", async () => {
		expect((await call("PUT", `${base()}/files/settings`, tokens.supervisor, { max_member_file_mb: 1 })).error).toBe(9999);
		expect((await call("PUT", `${base()}/files/settings`, tokens.owner, { max_member_file_mb: 1.5 })).error).toBe(1309);
		const limited = await call("PUT", `${base()}/files/settings`, tokens.owner, { max_member_file_mb: 1 });
		expect(limited.data).toMatchObject({ max_file_bytes: 25_000_000, max_member_file_bytes: 1_000_000 });
		expect((await call("GET", `${base()}/explorer`, tokens.employee)).data).toMatchObject({ used: 24, limit: 1_000_000 });

		const large = new Uint8Array(600_000);
		expect((await store("first.bin", large, tokens.employee)).data.ready).toBe(true);
		const refused = await store("second.bin", large, tokens.employee);
		expect(refused.status).toBe(403);
		expect(refused.error).toBe(1310);
		expect((await store("theirs.bin", large, tokens.colleague)).data.ready).toBe(true);

		const raised = await call("PUT", `${base()}/file-limits/wf-employee`, tokens.owner, { max_mb: 2 });
		expect(raised.data).toEqual({ username: "wf-employee", max_bytes: 2_000_000 });
		expect((await call("PUT", `${base()}/file-limits/nobody-here`, tokens.owner, { max_mb: 2 })).error).toBe(1208);
		expect((await store("second.bin", large, tokens.employee)).data.ready).toBe(true);

		const people = await call("GET", `${base()}/file-limits`, tokens.owner);
		expect(people.data.max_member_file_bytes).toBe(1_000_000);
		expect(people.data.people[0]).toEqual({ username: "wf-employee", name: "Eva Employee", used: 1_200_024, max_bytes: 2_000_000 });
		expect(people.data.people.find((row: { username: string }) => row.username === "wf-colleague")).toMatchObject({ used: 600_008, max_bytes: null });
		expect((await call("GET", `${base()}/file-limits`, tokens.supervisor)).error).toBe(9999);

		await call("PUT", `${base()}/file-limits/wf-employee`, tokens.owner, { max_mb: null });
		expect((await call("GET", `${base()}/explorer`, tokens.employee)).data.limit).toBe(1_000_000);
		await call("PUT", `${base()}/files/settings`, tokens.owner, { max_member_file_mb: null });
		expect((await call("GET", `${base()}/explorer`, tokens.employee)).data.limit).toBe(null);
	});

	test("administrators see where every file lives and deleting a folder frees everything in it", async () => {
		const list = await call("GET", `${base()}/files?sort=created`, tokens.owner);
		const located = Object.fromEntries(list.data.files.map((row: { file_name: string; location: string[] }) => [row.file_name, row.location]));
		expect(located["agreement-v2.txt"]).toEqual(["Contracts", "Old drafts"]);
		expect(located["notes.txt"]).toEqual([]);
		expect(list.data.file_storage_used).toBe(1_800_032);

		expect((await call("DELETE", `${base()}/explorer/folders/${contracts}`, tokens.supervisor)).error).toBe(9999);
		const deleted = await call("DELETE", `${base()}/explorer/folders/${contracts}`, tokens.employee);
		expect(deleted.data.files).toBe(2);
		expect((await call("GET", `${base()}/explorer?folder=${drafts}`, tokens.employee)).error).toBe(1311);
		expect((await call("GET", `${base()}/files/${contract}`, tokens.owner)).error).toBe(1305);
		expect((await call("GET", `${base()}/license`, tokens.owner)).data.file_storage_used).toBe(1_800_008);

		const mine = await call("GET", `${base()}/explorer`, tokens.employee);
		for (const file of mine.data.files) expect((await call("DELETE", `${base()}/files/${file.uuid}`, tokens.employee)).error).toBe(0);
		expect((await call("GET", `${base()}/explorer`, tokens.employee)).data).toMatchObject({ files: [], used: 0 });
	});
});

describe("permanent project deletion", () => {
	test("an administrator removes a deleted project with all of its records and stored files", async () => {
		const { documentStorage } = await import("../server/document-storage");
		await Database`UPDATE accounts SET admin = 1 WHERE username = 'wf-supervisor-admin'`;
		const now = Date.now();
		await Database`INSERT INTO accounts(username, email, password, admin, created, updated, accessed) VALUES('wf-admin', 'wf-admin@team.test', 'unused', 1, ${now}, ${now}, ${now})`;
		const admin = (await Auth.createSession("wf-admin", ""))!;

		const ticket = (await call("POST", `${base()}/tickets`, tokens.supervisor, { title: "Last ticket" })).data.uuid;
		const begun = await call("POST", `${base()}/tickets/${ticket}/files`, tokens.employee, { name: "last.txt", type: "text/plain", size: 4 });
		const part = await Server.app.handle(
			new Request(`http://127.0.0.1/api/v1${base()}/files/${begun.data.uuid}/parts/0`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${tokens.employee}`, "Content-Type": "application/octet-stream" },
				body: new TextEncoder().encode("last"),
			})
		);
		expect(part.status).toBe(200);
		const [stored] = await Database`SELECT storage_key FROM project_files WHERE uuid = ${begun.data.uuid}`;
		expect(await documentStorage().exists(`${stored.storage_key}/0`)).toBe(true);
		const [name] = await Database`SELECT name FROM projects WHERE uuid = ${project}`;

		expect((await call("DELETE", `/admin/projects/${project}`, tokens.owner, { name: name.name })).status).toBe(403);
		expect((await call("DELETE", `/admin/projects/${project}`, admin, { name: name.name })).error).toBe(1314);
		expect((await call("GET", "/admin/projects?deleted=1", admin)).data.projects).toEqual([]);

		expect((await call("DELETE", base(), tokens.owner)).error).toBe(0);
		const listed = await call("GET", "/admin/projects?deleted=1", admin);
		expect(listed.data.projects.map((row: { uuid: string; status: string }) => [row.uuid, row.status])).toEqual([[project, "deleted"]]);
		expect((await call("GET", "/admin/projects", admin)).data.projects.some((row: { uuid: string }) => row.uuid === project)).toBe(false);
		expect((await call("DELETE", `/admin/projects/${project}`, admin, { name: "something else" })).error).toBe(1315);
		expect((await call("DELETE", `/admin/projects/${crypto.randomUUID()}`, admin, { name: name.name })).status).toBe(404);

		const purged = await call("DELETE", `/admin/projects/${project}`, admin, { name: name.name });
		expect(purged.error).toBe(0);
		expect(purged.data).toMatchObject({ missed_files: 0 });
		expect(purged.data.stored_files).toBeGreaterThan(0);

		expect(await documentStorage().exists(`${stored.storage_key}/0`)).toBe(false);
		for (const table of ["projects", "project_members", "tickets", "time_entries", "invoices", "customers", "project_files", "employees"]) {
			const column = table === "projects" ? "uuid" : table === "project_members" ? "project_id" : "project";
			const [left] = await Database.unsafe(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = '${project}'`);
			expect([table, Number(left.count)]).toEqual([table, 0]);
		}
		const [trail] = await Database`SELECT COUNT(*) AS count FROM audit_log WHERE project = ${project}`;
		expect(Number(trail.count)).toBe(0);
		const [record] = await Database`SELECT old_value FROM audit_log WHERE action = 'project.purged' AND entity_id = ${project}`;
		expect(JSON.parse(record.old_value).name).toBe(name.name);
		expect((await Database.unsafe("PRAGMA foreign_key_check")).length).toBe(0);
	});
});
