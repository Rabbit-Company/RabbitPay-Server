import { Database } from "bun:sqlite";
import Blake2b from "@rabbit-company/blake2b";
import { projectApi, projectPath } from "../actions";
import type { Session } from "../demo";
import { iban } from "../einvoice";
import type { Guide } from "../run";
import type { Studio } from "../studio";
import { slovenianSession } from "./slovenia";

const CONTENT = ".project-content";

interface Person {
	name: string;
	email: string;
	role: "employee" | "supervisor";
	job: string;
	salary: number;
	started: string;
	priorMonths: number;
	taxNumber: string;
	commuteKm: number;
	address: string;
}

export const PEOPLE: Record<"en" | "sl", Person[]> = {
	en: [
		{
			name: "James Wilson",
			email: "james.wilson@example.com",
			role: "employee",
			job: "Graphic designer",
			salary: 210000,
			started: "2023-03-01",
			priorMonths: 48,
			taxNumber: "10000004",
			commuteKm: 6,
			address: "Trubarjeva cesta 40, 1000 Ljubljana",
		},
		{
			name: "Sarah Thompson",
			email: "sarah.thompson@example.com",
			role: "supervisor",
			job: "Studio manager",
			salary: 260000,
			started: "2021-09-01",
			priorMonths: 96,
			taxNumber: "10000012",
			commuteKm: 12,
			address: "Celovška cesta 102, 1000 Ljubljana",
		},
	],
	sl: [
		{
			name: "Nejc Kos",
			email: "nejc.kos@example.com",
			role: "employee",
			job: "Grafični oblikovalec",
			salary: 210000,
			started: "2023-03-01",
			priorMonths: 48,
			taxNumber: "10000004",
			commuteKm: 6,
			address: "Trubarjeva cesta 40, 1000 Ljubljana",
		},
		{
			name: "Petra Vidmar",
			email: "petra.vidmar@example.com",
			role: "supervisor",
			job: "Vodja studia",
			salary: 260000,
			started: "2021-09-01",
			priorMonths: 96,
			taxNumber: "10000012",
			commuteKm: 12,
			address: "Celovška cesta 102, 1000 Ljubljana",
		},
	],
};

export function teammatePassword(email: string): string {
	return `${email}-Help-Shots-1`;
}

function fillReason(studio: Studio): string {
	return studio.language === "sl" ? "Prepisano s papirnate evidence" : "Copied from the paper timesheets";
}

function people(studio: Studio): Person[] {
	return PEOPLE[studio.language as "en" | "sl"];
}

function lastMonth(): string {
	const now = new Date();
	const month = new Date(now.getFullYear(), now.getMonth() - 1, 1);
	return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
}

function monthDays(month: string): { first: string; last: string } {
	const [year, number] = month.split("-").map(Number);
	const last = new Date(year!, number!, 0).getDate();
	return { first: `${month}-01`, last: `${month}-${String(last).padStart(2, "0")}` };
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

async function prepare(studio: Studio, session: Session) {
	const local = slovenianSession(session);
	await studio.open(projectPath(local), 800);
	const database = new Database(studio.database);
	database.run("PRAGMA busy_timeout = 10000");
	database.query("UPDATE projects SET workforce_until = ? WHERE uuid = ?").run(Date.now() + 365 * 86400000, local.project);
	database.close();

	const members: string[] = [];
	const legal = (await (await fetch(`${studio.base}/api/v1/legal`)).json()) as { data: { required_versions: unknown } };
	for (const person of people(studio)) {
		await fetch(`${studio.base}/api/v1/auth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: person.email,
				password: Blake2b.hash(teammatePassword(person.email)),
				accept_terms: true,
				legal_versions: legal.data.required_versions,
			}),
		});
	}
	for (const [index, person] of people(studio).entries()) {
		const invited = await projectApi<{ uuid: string }>(studio, local, "POST", "/members", { email: person.email, role: person.role });
		members.push(invited.uuid);
		const db = new Database(studio.database);
		db.run("PRAGMA busy_timeout = 10000");
		db.query("UPDATE project_members SET full_name = ? WHERE uuid = ?").run(person.name, invited.uuid);
		db.close();
		await projectApi(studio, local, "PUT", `/employees/${invited.uuid}`, {
			employee_number: String(index + 1).padStart(3, "0"),
			job_title: person.job,
			employment_type: "full_time",
			started_on: person.started,
			prior_service_months: person.priorMonths,
			weekly_minutes: 2400,
			vacation_days: 22,
			pay_type: "monthly",
			private: {
				salary: person.salary,
				tax_number: person.taxNumber,
				address: person.address,
				iban: iban("SI", `56019100${String(1000000 + index * 7331).padStart(7, "0")}`),
				commute_km: person.commuteKm,
				claims_general_relief: true,
				dependents: index === 0 ? 1 : 0,
			},
		});
	}
	session.marks = { ...session.marks, workforceMembers: members.join(",") };

	const previous = lastMonth();
	const { first, last } = monthDays(previous);
	for (const member of members) {
		await projectApi(studio, local, "POST", "/timesheets/fill", {
			member,
			from: first,
			to: last,
			start: "08:00",
			break_start: "12:00",
			reason: fillReason(studio),
		});
	}
	await projectApi(studio, local, "POST", "/absences", {
		member: members[0],
		kind: "vacation",
		starts_on: `${previous}-22`,
		ends_on: `${previous}-23`,
		note: null,
	});
	const db = new Database(studio.database);
	db.run("PRAGMA busy_timeout = 10000");
	const now = Date.now();
	for (const member of members) {
		db.query(
			`INSERT OR REPLACE INTO timesheet_periods(uuid, project, member, period, status, submitted_at, decided_at, created, updated)
			VALUES(?, ?, ?, ?, 'approved', ?, ?, ?, ?)`
		).run(crypto.randomUUID(), local.project, member, previous, now, now, now, now);
	}
	db.close();
	const current = today().slice(0, 7);
	const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
	for (const member of members) {
		await projectApi(studio, local, "POST", "/timesheets/fill", {
			member,
			from: `${current}-01`,
			to: yesterday,
			start: "08:00",
			break_start: "12:00",
			reason: fillReason(studio),
		});
	}
}

const TICKETS = {
	en: [
		{ title: "Spring campaign posters for Slovenske železnice", kind: "task", hours: 6, assignee: 0, rate: 6000 },
		{ title: "Fix the menu on the mobile website", kind: "bug", hours: 2, assignee: 0, rate: 6000 },
		{ title: "Prepare the brand guide", kind: "task", hours: 4, assignee: 1, rate: 7000 },
	],
	sl: [
		{ title: "Plakati za pomladno akcijo Slovenskih železnic", kind: "task", hours: 6, assignee: 0, rate: 6000 },
		{ title: "Popravek menija na mobilni spletni strani", kind: "bug", hours: 2, assignee: 0, rate: 6000 },
		{ title: "Priprava celostne grafične podobe", kind: "task", hours: 4, assignee: 1, rate: 7000 },
	],
};

function members(session: Session): string[] {
	return session.marks!.workforceMembers!.split(",");
}

async function choosePerson(studio: Studio, name: string) {
	await studio.browser.eval(
		`(() => { const select = [...document.querySelectorAll("${CONTENT} select")].find((element) => [...element.options].some((option) => option.text === ${JSON.stringify(name)})); select.value = [...select.options].find((option) => option.text === ${JSON.stringify(name)}).value; select.dispatchEvent(new Event("change", { bubbles: true })); })()`
	);
	await studio.browser.wait(1200);
}

async function team(studio: Studio, session: Session) {
	const local = slovenianSession(session);
	await studio.open(projectPath(local, "/members"), 1500);
	await studio.shot("roles", "team", { target: CONTENT });
}

async function employees(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "employees";
	await studio.open(projectPath(local, "/employees"), 1800);
	await studio.shot(page, "nav", { mark: `.project-nav >> link:${studio.t("nav.employees")}` });
	await studio.shot(page, "records", { target: `${CONTENT} .card:first-child`, mark: `${CONTENT} tbody tr:nth-child(2) >> button:${studio.t("ui.edit")}` });
	await browser.click(`${CONTENT} tbody tr:nth-child(2) >> button:${studio.t("ui.edit")}`, 1000);
	await studio.shot(page, "record", { target: ".dialog", padding: 32 });
	await browser.click(".dialog .icon-button");
	await studio.shot(page, "estimate", { target: `${CONTENT} .card:nth-child(2)` });
}

async function timesheet(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "timesheet";
	const person = people(studio)[0];
	await studio.open(projectPath(local, "/timesheet"), 1800);
	await studio.shot(page, "nav", { mark: `.project-nav >> link:${studio.t("nav.timesheet")}` });
	await choosePerson(studio, person.name);
	await studio.shot(page, "week", { target: CONTENT });
	await browser.click(`${CONTENT} tbody tr:has(.pill) >> button:${studio.t("timesheet.add_time")}`, 800);
	if (await browser.exists(".dialog")) {
		await studio.shot(page, "add-time", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .icon-button");
	}
	await browser.click(`button:${studio.t("timesheet.fill")}`, 800);
	if (await browser.exists(".dialog")) {
		await studio.shot(page, "fill", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .icon-button");
	}
	await browser.click(`button:${studio.t("timesheet.history")}`, 1200);
	if (await browser.exists(".dialog")) {
		await studio.shot(page, "history", { target: [".dialog h2", ".dialog tbody tr:nth-child(6)"], padding: 32 });
		await browser.click(".dialog .icon-button");
	}

	const month = new Date().toISOString().slice(0, 7);
	const db = new Database(studio.database);
	db.run("PRAGMA busy_timeout = 10000");
	const now = Date.now();
	const submitter = (db.query("SELECT account_username FROM project_members WHERE uuid = ?").get(members(session)[0]) as { account_username: string })
		.account_username;
	db.query(
		`INSERT OR REPLACE INTO timesheet_periods(uuid, project, member, period, status, submitted_by, submitted_at, created, updated) VALUES(?, ?, ?, ?, 'submitted', ?, ?, ?, ?)`
	).run(crypto.randomUUID(), local.project, members(session)[0], month, submitter, now, now, now);
	db.close();
	await studio.open(projectPath(local, "/timesheet"), 1800);
	await choosePerson(studio, person.name);
	await studio.shot(page, "approve", { target: `${CONTENT} .card:first-of-type`, mark: `button:${studio.t("timesheet.approve")}` });
	const cleanup = new Database(studio.database);
	cleanup.run("PRAGMA busy_timeout = 10000");
	cleanup.query("DELETE FROM timesheet_periods WHERE project = ? AND member = ? AND period = ?").run(local.project, members(session)[0], month);
	cleanup.close();
}

async function absences(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "absences";
	const person = people(studio)[1];
	await studio.open(projectPath(local, "/timesheet/absences"), 1800);
	await browser.click(`button:${studio.t("absence.new")}`, 800);
	await browser.eval(
		`(() => { const select = [...document.querySelectorAll(".dialog select")].find((element) => [...element.options].some((option) => option.text === ${JSON.stringify(person.name)})); select.value = [...select.options].find((option) => option.text === ${JSON.stringify(person.name)}).value; select.dispatchEvent(new Event("change", { bubbles: true })); })()`
	);
	const year = new Date().getFullYear();
	await browser.eval(
		`(() => { const set = (label, value) => { const field = [...document.querySelectorAll(".dialog label.field")].find((node) => node.querySelector(".field-label")?.textContent === label); const control = field.querySelector("input, select"); control.value = value; control.dispatchEvent(new Event("input", { bubbles: true })); control.dispatchEvent(new Event("change", { bubbles: true })); }; set(${JSON.stringify(studio.t("absence.from"))}, "${year}-12-28"); set(${JSON.stringify(studio.t("absence.to"))}, "${year}-12-31"); })()`
	);
	await browser.blur();
	await studio.shot(page, "new", { target: ".dialog", padding: 32, mark: ".dialog >> button[type=submit]" });
	await browser.click(".dialog >> button[type=submit]", 1500);
	await choosePerson(studio, person.name);
	await choosePerson(studio, studio.t("absence.status_any"));
	await studio.shot(page, "list", { target: CONTENT });
	await studio.open(projectPath(local, "/timesheet"), 1800);
	await choosePerson(studio, people(studio)[0].name);
	await studio.shot(page, "balance", { target: `${CONTENT} .card:has(input[type=number])` });
}

async function report(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "monthly-report";
	await studio.open(projectPath(local, "/timesheet/report"), 1800);
	await browser.eval(
		`(() => { const month = document.querySelector("${CONTENT} input[type=month]"); if (month) { month.value = "${lastMonth()}"; month.dispatchEvent(new Event("change", { bubbles: true })); } })()`
	);
	await browser.wait(1500);
	await choosePerson(studio, people(studio)[0].name);
	await studio.shot(page, "report", { target: CONTENT });
	await studio.open(projectPath(local, "/timesheet/settings"), 1800);
	await studio.shot(page, "settings", { target: `${CONTENT} .card:first-of-type` });
}

async function tickets(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "tickets";
	const ids = members(session);
	const list = TICKETS[studio.language as "en" | "sl"];
	const created: string[] = [];
	const starts = [8, 8];
	for (const ticket of list) {
		const saved = await projectApi<{ uuid: string }>(studio, local, "POST", "/tickets", {
			title: ticket.title,
			kind: ticket.kind,
			customer: local.customers![0],
			hourly_rate: ticket.rate,
			assignees: [ids[ticket.assignee]],
			customer_visible: false,
		});
		created.push(saved.uuid);
		const from = starts[ticket.assignee]!;
		starts[ticket.assignee] = from + ticket.hours;
		await projectApi(studio, local, "POST", "/timesheets", {
			member: ids[ticket.assignee],
			work_date: today(),
			start: `${String(from).padStart(2, "0")}:00`,
			end: `${String(from + ticket.hours).padStart(2, "0")}:00`,
			kind: "regular",
			ticket: saved.uuid,
		});
	}
	session.marks = { ...session.marks, tickets: created.join(",") };
	await studio.open(projectPath(local, "/tickets"), 1800);
	await studio.shot(page, "list", { target: CONTENT });
	await browser.click(`${CONTENT} >> button:${studio.t("ticket.view")}`, 600).catch(() => null);
	await browser.eval(
		`[...document.querySelectorAll("${CONTENT} .segmented button, ${CONTENT} button")].find((button) => button.textContent === "Board" || button.textContent === "Tabla")?.click()`
	);
	await browser.wait(1200);
	await studio.shot(page, "board", { target: CONTENT });
	await browser.click(`button:${studio.t("ticket.new")}`, 800);
	if (await browser.exists(".dialog")) {
		await browser.fill(`.dialog >> field:${studio.t("ticket.title")}`, list[0].title);
		await browser.blur();
		await studio.shot(page, "new", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .icon-button");
	}
	await studio.open(projectPath(local, `/tickets/${created[0]}`), 1800);
	await studio.shot(page, "ticket", { target: CONTENT });
}

async function payroll(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "payroll";
	await studio.open(projectPath(local, "/payroll"), 1800);
	await studio.shot(page, "nav", { mark: `.project-nav >> link:${studio.t("nav.payroll")}` });
	await studio.open(projectPath(local, "/payroll/rates"), 1800);
	await studio.shot(page, "tax-tables", { target: CONTENT });
	const prefix = studio.t("payroll.rates_preset_for", { label: "\u0000" }).split("\u0000")[0]!;
	await browser.eval(`[...document.querySelectorAll("${CONTENT} button")].find((button) => button.textContent.startsWith(${JSON.stringify(prefix)})).click()`);
	await browser.wait(1200);
	await browser.click(`${CONTENT} form label.switch:last-of-type`, 300);
	await browser.blur();
	await studio.shot(page, "tax-table", {
		target: [`${CONTENT} form label.switch:last-of-type`, `${CONTENT} form .form-actions`],
		padding: 16,
		mark: `${CONTENT} form >> button[type=submit]`,
	});
	await browser.click(`${CONTENT} form >> button[type=submit]`, 1800);
	await studio.open(projectPath(local, "/payroll/rates"), 1500);
	await studio.shot(page, "tax-tables-saved", { target: CONTENT });

	await studio.open(projectPath(local, "/payroll"), 1800);
	await browser.click(`button:${studio.t("payroll.new_run")}`, 800);
	const payDate = `${new Date().toISOString().slice(0, 7)}-18`;
	await browser.eval(
		`(() => { const month = document.querySelector(".dialog input[type=month]"); month.value = "${lastMonth()}"; month.dispatchEvent(new Event("change", { bubbles: true })); const date = document.querySelector(".dialog input[type=date]"); date.value = "${payDate}"; date.dispatchEvent(new Event("change", { bubbles: true })); })()`
	);
	await browser.blur();
	await studio.shot(page, "new-run", { target: ".dialog", padding: 32, mark: ".dialog >> button[type=submit]" });
	await browser.click(".dialog >> button[type=submit]", 2500);
	await studio.shot(page, "run", { target: CONTENT });
	await browser.click(`${CONTENT} tbody tr:first-child >> button:${studio.t("payroll.items")}`, 800).catch(() => null);
	if (await browser.exists(".dialog")) {
		await studio.shot(page, "items", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .icon-button");
	}
	await browser.click(`button:${studio.t("payroll.finalize")}`, 800);
	if (await browser.exists(".dialog")) {
		await studio.shot(page, "finalize", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .dialog-actions .button.primary", 2500);
	}
	await studio.shot(page, "finalized", { target: CONTENT });
}

export const workforce: Guide = {
	module: "workforce",
	steps: [
		["prepare", prepare],
		["team", team],
		["employees", employees],
		["timesheet", timesheet],
		["absences", absences],
		["report", report],
		["tickets", tickets],
		["payroll", payroll],
	],
};
