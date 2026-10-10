import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { prepareTest } from "./environment";

await prepareTest();

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { default: Auth } = await import("../server/auth");
const { Realtime } = await import("../server/realtime");
const { occurrenceDates, readRepeat, timedOccurrences, timestampOfLocalTime } = await import("../server/workforce/recurrence");
const { dueReminders, sendReminders } = await import("../server/workforce/team-calendar");

interface Result {
	status: number;
	error: number;
	info: string;
	data: any;
}

const ZONE = "Europe/Ljubljana";

async function call(method: string, path: string, token?: string, body?: unknown): Promise<Result> {
	const headers: Record<string, string> = {};
	if (token) headers.Authorization = `Bearer ${token}`;
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const response = await Server.app.handle(
		new Request(`http://127.0.0.1/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
	);
	return { status: response.status, ...((await response.json()) as Omit<Result, "status">) };
}

const tokens = { owner: "", anna: "", boris: "", cashier: "" };
const members: Record<string, string> = {};
let project = "";

const calendar = () => `/projects/${project}/calendar`;
const chat = () => `/projects/${project}/chat`;
const at = (date: string, clock: string) => {
	const [hours, minutes] = clock.split(":").map(Number);
	return timestampOfLocalTime(date, hours * 60 + minutes, ZONE);
};

async function account(username: string): Promise<string> {
	const now = Date.now();
	await Database`INSERT INTO accounts(username, email, password, created, updated, accessed) VALUES(${username}, ${`${username}@team.test`}, 'unused', ${now}, ${now}, ${now})`;
	return (await Auth.createSession(username, ""))!;
}

async function member(username: string, role: string, fullName: string) {
	const now = Date.now();
	members[username] = crypto.randomUUID();
	await Database`
		INSERT INTO project_members(uuid, project_id, account_username, role, status, full_name, created, updated)
		VALUES(${members[username]}, ${project}, ${username}, ${role}, 'active', ${fullName}, ${now}, ${now})
	`;
}

async function feed(token: string, from: string, to: string): Promise<any> {
	const shown = (await call("GET", `${calendar()}?from=${from}&to=${to}`, token)).data;
	const inRange = (entry: any) => entry.all_day || (entry.occurrence >= from && entry.occurrence <= to);
	return { ...shown, entries: shown.entries.filter(inRange) };
}

function listen(username: string) {
	const events: any[] = [];
	const socket = { send: (data: string) => events.push(JSON.parse(data)), close() {} };
	Realtime.attach(socket, username, "");
	return { events, stop: () => Realtime.detach(socket) };
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await Server.configure();

	tokens.owner = await account("cal-owner");
	tokens.anna = await account("cal-anna");
	tokens.boris = await account("cal-boris");
	tokens.cashier = await account("cal-cashier");
	project = (await call("POST", "/projects", tokens.owner, { name: "calendar-co", currency: "EUR" })).data.uuid;
	await Database`UPDATE projects SET workforce_until = ${Date.now() + 86400000}, timezone = ${ZONE} WHERE uuid = ${project}`;
	await member("cal-anna", "employee", "Anna Employee");
	await member("cal-boris", "supervisor", "Boris Supervisor");
	await member("cal-cashier", "cashier", "Cene Cashier");
});

afterAll(async () => {
	await Database.close();
});

describe("repeat rules", () => {
	test("daily, weekly, monthly and yearly dates", () => {
		expect(occurrenceDates("2027-03-01", null, "2027-03-01", "2027-03-31")).toEqual(["2027-03-01"]);
		expect(occurrenceDates("2027-03-01", null, "2027-03-02", "2027-03-31")).toEqual([]);
		expect(occurrenceDates("2027-03-01", { unit: "day", interval: 3, weekdays: null, until: null }, "2027-03-05", "2027-03-12")).toEqual([
			"2027-03-07",
			"2027-03-10",
		]);
		expect(occurrenceDates("2027-03-01", { unit: "week", interval: 2, weekdays: null, until: null }, "2027-03-01", "2027-04-01")).toEqual([
			"2027-03-01",
			"2027-03-15",
			"2027-03-29",
		]);
		expect(occurrenceDates("2027-03-03", { unit: "week", interval: 1, weekdays: [1, 3, 5], until: "2027-03-10" }, "2027-03-01", "2027-03-31")).toEqual([
			"2027-03-03",
			"2027-03-05",
			"2027-03-08",
			"2027-03-10",
		]);
		expect(occurrenceDates("2027-01-31", { unit: "month", interval: 1, weekdays: null, until: null }, "2027-02-01", "2027-04-30")).toEqual([
			"2027-02-28",
			"2027-03-31",
			"2027-04-30",
		]);
		expect(occurrenceDates("2024-02-29", { unit: "year", interval: 1, weekdays: null, until: null }, "2027-01-01", "2028-12-31")).toEqual([
			"2027-02-28",
			"2028-02-29",
		]);
		expect(
			occurrenceDates("2027-03-01", { unit: "day", interval: 1, weekdays: null, until: null }, "2027-03-01", "2027-03-04", new Set(["2027-03-02"]))
		).toEqual(["2027-03-01", "2027-03-03", "2027-03-04"]);
	});

	test("read and reject rules", () => {
		expect(readRepeat(null, "2027-03-01")).toBeNull();
		expect(readRepeat({ unit: "week" }, "2027-03-01")).toEqual({ unit: "week", interval: 1, weekdays: null, until: null });
		expect(readRepeat({ unit: "week", weekdays: [3] }, "2027-03-01")).toEqual({ unit: "week", interval: 1, weekdays: [1, 3], until: null });
		expect(readRepeat({ unit: "week", weekdays: [1] }, "2027-03-01")!.weekdays).toBeNull();
		expect(readRepeat({ unit: "hour" }, "2027-03-01")).toBeUndefined();
		expect(readRepeat({ unit: "day", interval: 0 }, "2027-03-01")).toBeUndefined();
		expect(readRepeat({ unit: "day", until: "2027-02-28" }, "2027-03-01")).toBeUndefined();
		expect(readRepeat({ unit: "week", weekdays: [8] }, "2027-03-01")).toBeUndefined();
	});

	test("keep the local time across a clock change", () => {
		const weekly = { unit: "week" as const, interval: 1, weekdays: null, until: null };
		const occurrences = timedOccurrences(at("2027-03-22", "09:00"), 30, weekly, new Set(), at("2027-03-22", "00:00"), at("2027-04-05", "23:59"), ZONE);
		expect(occurrences.map((occurrence) => new Date(occurrence.starts_at).toISOString())).toEqual([
			"2027-03-22T08:00:00.000Z",
			"2027-03-29T07:00:00.000Z",
			"2027-04-05T07:00:00.000Z",
		]);
		expect(occurrences[1].ends_at - occurrences[1].starts_at).toBe(30 * 60 * 1000);
	});
});

describe("calendar feed", () => {
	test("needs the chat permission, the license and a sane range", async () => {
		expect((await call("GET", `${calendar()}?from=2027-03-01&to=2027-03-07`)).status).toBe(401);
		expect((await call("GET", `${calendar()}?from=2027-03-01&to=2027-03-07`, tokens.cashier)).status).toBe(403);
		expect((await call("GET", `${calendar()}?from=2027-03-07&to=2027-03-01`, tokens.anna)).error).toBe(1336);
		expect((await call("GET", `${calendar()}?from=2027-01-01&to=2027-12-31`, tokens.anna)).error).toBe(1336);
		await Database`UPDATE projects SET workforce_until = NULL WHERE uuid = ${project}`;
		expect((await call("GET", `${calendar()}?from=2027-03-01&to=2027-03-07`, tokens.anna)).error).toBe(1189);
		await Database`UPDATE projects SET workforce_until = ${Date.now() + 86400000} WHERE uuid = ${project}`;

		const shown = await feed(tokens.anna, "2027-03-01", "2027-03-07");
		expect(shown).toMatchObject({ timezone: ZONE, me: "cal-anna", entries: [] });
		expect(shown.people.map((person: any) => person.name)).toEqual(["Anna Employee", "Boris Supervisor", "cal-owner@team.test"]);
		expect(shown.people[0]).toMatchObject({ account: "cal-anna", member: members["cal-anna"], presence: "offline", call: null });
	});

	test("personal events follow their visibility", async () => {
		const events = `${calendar()}/events`;
		expect((await call("POST", events, tokens.anna, { title: "", starts_at: at("2027-03-02", "10:00"), duration_minutes: 60 })).error).toBe(1334);
		expect((await call("POST", events, tokens.anna, { title: "Focus", starts_at: at("2027-03-02", "10:00"), duration_minutes: 2 })).error).toBe(1334);
		expect((await call("POST", events, tokens.anna, { title: "Trip", all_day: true, starts_on: "2027-03-05", ends_on: "2027-03-04" })).error).toBe(1334);
		expect((await call("POST", events, tokens.anna, { title: "Focus", starts_at: 1, duration_minutes: 60, repeat: { unit: "never" } })).error).toBe(1334);

		const open = await call("POST", events, tokens.anna, {
			title: "Client visit",
			note: "At their office",
			starts_at: at("2027-03-02", "10:00"),
			duration_minutes: 90,
		});
		expect(open.status).toBe(201);
		expect(open.data).toMatchObject({ title: "Client visit", visibility: "details", all_day: false, duration_minutes: 90, repeat: null });
		await call("POST", events, tokens.anna, { title: "Dentist", visibility: "busy", starts_at: at("2027-03-03", "08:00"), duration_minutes: 60 });
		await call("POST", events, tokens.anna, { title: "Birthday gift", visibility: "private", starts_at: at("2027-03-04", "12:00"), duration_minutes: 30 });
		await call("POST", events, tokens.anna, { title: "Conference", all_day: true, starts_on: "2027-03-05", ends_on: "2027-03-08" });

		const own = (await feed(tokens.anna, "2027-03-01", "2027-03-07")).entries;
		expect(own.map((entry: any) => entry.title).sort()).toEqual(["Birthday gift", "Client visit", "Conference", "Dentist"]);
		expect(own.every((entry: any) => entry.mine && entry.editable)).toBe(true);
		expect(own.find((entry: any) => entry.title === "Conference")).toMatchObject({ all_day: true, starts_on: "2027-03-05", ends_on: "2027-03-08" });

		const seen = (await feed(tokens.boris, "2027-03-01", "2027-03-07")).entries;
		expect(seen.map((entry: any) => entry.title).sort()).toEqual(["Client visit", "Conference", null]);
		const hidden = seen.find((entry: any) => entry.title === null);
		expect(hidden).toMatchObject({
			kind: "event",
			series: null,
			note: null,
			accounts: ["cal-anna"],
			mine: false,
			editable: false,
			starts_at: at("2027-03-03", "08:00"),
		});
		expect(JSON.stringify(seen)).not.toContain("Dentist");
		expect(JSON.stringify(seen)).not.toContain("Birthday");
		expect(seen.find((entry: any) => entry.title === "Client visit")).toMatchObject({ note: "At their office", visibility: null, editable: false });

		expect((await feed(tokens.anna, "2027-03-08", "2027-03-14")).entries.map((entry: any) => entry.title)).toEqual(["Conference"]);
		expect((await feed(tokens.anna, "2027-03-09", "2027-03-14")).entries).toEqual([]);
	});

	test("only the owner changes or removes an event", async () => {
		const created = await call("POST", `${calendar()}/events`, tokens.boris, { title: "Gym", starts_at: at("2027-04-05", "17:00"), duration_minutes: 60 });
		const path = `${calendar()}/events/${created.data.uuid}`;
		expect((await call("PATCH", path, tokens.anna, { title: "Stolen" })).error).toBe(1335);
		expect((await call("DELETE", path, tokens.anna)).error).toBe(1335);
		expect((await call("PATCH", path, tokens.boris, { title: " " })).error).toBe(1334);

		const changed = await call("PATCH", path, tokens.boris, { title: "Swimming", visibility: "busy", duration_minutes: 45 });
		expect(changed.data).toMatchObject({ title: "Swimming", visibility: "busy", duration_minutes: 45, starts_at: at("2027-04-05", "17:00") });
		const wholeDay = await call("PATCH", path, tokens.boris, { all_day: true, starts_on: "2027-04-06" });
		expect(wholeDay.data).toMatchObject({ all_day: true, starts_on: "2027-04-06", ends_on: "2027-04-06", starts_at: null, duration_minutes: null });

		expect((await call("DELETE", path, tokens.boris)).data).toEqual({ removed: true });
		expect((await feed(tokens.boris, "2027-04-05", "2027-04-11")).entries).toEqual([]);
	});

	test("repeating events can lose one date, the rest or everything", async () => {
		const anna = listen("cal-anna");
		const created = await call("POST", `${calendar()}/events`, tokens.boris, {
			title: "Standup notes",
			starts_at: at("2027-05-03", "09:00"),
			duration_minutes: 15,
			repeat: { unit: "week", weekdays: [1, 2, 3, 4, 5] },
		});
		expect(created.data.repeat).toEqual({ unit: "week", interval: 1, weekdays: [1, 2, 3, 4, 5], until: null });
		expect(anna.events).toEqual([{ type: "calendar.changed", project }]);
		anna.stop();

		const path = `${calendar()}/events/${created.data.uuid}`;
		const dates = async (from: string, to: string) => (await feed(tokens.boris, from, to)).entries.map((entry: any) => entry.occurrence);
		expect(await dates("2027-05-03", "2027-05-09")).toEqual(["2027-05-03", "2027-05-04", "2027-05-05", "2027-05-06", "2027-05-07"]);

		expect((await call("DELETE", `${path}?occurrence=2027-05-08&scope=one`, tokens.boris)).error).toBe(1334);
		expect((await call("DELETE", `${path}?occurrence=2027-05-05&scope=some`, tokens.boris)).error).toBe(1334);
		expect((await call("DELETE", `${path}?occurrence=2027-05-05&scope=one`, tokens.boris)).data).toEqual({ removed: false });
		expect(await dates("2027-05-03", "2027-05-09")).toEqual(["2027-05-03", "2027-05-04", "2027-05-06", "2027-05-07"]);

		expect((await call("PATCH", path, tokens.boris, { title: "Daily notes" })).data.title).toBe("Daily notes");
		expect(await dates("2027-05-03", "2027-05-09")).toHaveLength(4);

		expect((await call("DELETE", `${path}?occurrence=2027-05-12&scope=following`, tokens.boris)).data).toEqual({ removed: false });
		expect(await dates("2027-05-10", "2027-05-16")).toEqual(["2027-05-10", "2027-05-11"]);

		expect((await call("PATCH", path, tokens.boris, { repeat: { unit: "day" } })).data.repeat).toEqual({
			unit: "day",
			interval: 1,
			weekdays: null,
			until: null,
		});
		expect(await dates("2027-05-03", "2027-05-09")).toHaveLength(7);
		expect((await call("PATCH", path, tokens.boris, { repeat: null })).data.repeat).toBeNull();
		expect(await dates("2027-05-03", "2027-05-09")).toEqual(["2027-05-03"]);

		await call("PATCH", path, tokens.boris, { repeat: { unit: "week" } });
		expect((await call("DELETE", `${path}?occurrence=2027-05-03&scope=following`, tokens.boris)).data).toEqual({ removed: true });
	});

	test("meetings show details to the people in them and a busy block to the rest", async () => {
		const scheduled = await call("POST", `${chat()}/meetings`, tokens.owner, {
			title: "Weekly sync",
			starts_at: at("2027-06-07", "09:00"),
			duration_minutes: 30,
			accounts: ["cal-anna"],
			repeat: { unit: "week" },
		});
		expect(scheduled.status).toBe(201);
		expect(scheduled.data.meeting.repeat).toEqual({ unit: "week", interval: 1, weekdays: null, until: null });
		expect(
			(
				await call("POST", `${chat()}/meetings`, tokens.owner, {
					title: "Bad",
					starts_at: at("2027-06-07", "09:00"),
					duration_minutes: 30,
					repeat: { unit: "x" },
				})
			).error
		).toBe(1328);

		const conversation = scheduled.data.uuid;
		const invited = (await feed(tokens.anna, "2027-06-07", "2027-06-20")).entries;
		expect(invited).toHaveLength(2);
		expect(invited[0]).toMatchObject({
			kind: "meeting",
			title: "Weekly sync",
			series: conversation,
			conversation,
			accounts: ["cal-anna", "cal-owner"],
			starts_at: at("2027-06-07", "09:00"),
			ends_at: at("2027-06-07", "09:30"),
			mine: true,
			editable: false,
			live: false,
		});
		expect((await feed(tokens.owner, "2027-06-07", "2027-06-13")).entries[0].editable).toBe(true);

		const outside = (await feed(tokens.boris, "2027-06-07", "2027-06-13")).entries;
		expect(outside).toHaveLength(1);
		expect(outside[0]).toMatchObject({ kind: "meeting", title: null, series: null, conversation: null, mine: false, accounts: ["cal-anna", "cal-owner"] });
		expect(JSON.stringify(outside)).not.toContain(conversation);

		const meeting = `${chat()}/conversations/${conversation}/meeting`;
		expect((await call("DELETE", `${meeting}?occurrence=2027-06-14&scope=one`, tokens.anna)).error).toBe(1320);
		expect((await call("DELETE", `${meeting}?occurrence=2027-06-15&scope=one`, tokens.owner)).error).toBe(1328);
		await call("DELETE", `${meeting}?occurrence=2027-06-14&scope=one`, tokens.owner);
		expect((await feed(tokens.anna, "2027-06-07", "2027-06-27")).entries.map((entry: any) => entry.occurrence)).toEqual(["2027-06-07", "2027-06-21"]);

		const moved = await call("PATCH", meeting, tokens.owner, {
			starts_at: at("2027-06-08", "14:00"),
			repeat: { unit: "week", interval: 2, until: "2027-07-31" },
		});
		expect(moved.data.meeting.repeat).toEqual({ unit: "week", interval: 2, weekdays: null, until: "2027-07-31" });
		expect((await feed(tokens.anna, "2027-06-07", "2027-07-04")).entries.map((entry: any) => entry.occurrence)).toEqual(["2027-06-08", "2027-06-22"]);
		expect((await call("PATCH", meeting, tokens.owner, { duration_minutes: 45 })).data.meeting.repeat.interval).toBe(2);

		const cancelled = await call("DELETE", meeting, tokens.owner);
		expect(cancelled.data).toMatchObject({ uuid: conversation, meeting: null });
		expect((await feed(tokens.anna, "2027-06-07", "2027-07-04")).entries).toEqual([]);
	});

	test("absences hide their reason from colleagues and holidays show for everyone", async () => {
		const now = Date.now();
		const absence = (member: string, kind: string, status: string, from: string, to: string) => Database`
			INSERT INTO absences(uuid, project, member, person, kind, starts_on, ends_on, status, created, updated)
			VALUES(${crypto.randomUUID()}, ${project}, ${member}, 'Somebody', ${kind}, ${from}, ${to}, ${status}, ${now}, ${now})
		`;
		await absence(members["cal-anna"], "sick", "approved", "2027-08-02", "2027-08-04");
		await absence(members["cal-anna"], "vacation", "pending", "2027-08-09", "2027-08-10");
		await absence(members["cal-boris"], "vacation", "rejected", "2027-08-02", "2027-08-03");
		await absence(members["cal-cashier"], "vacation", "approved", "2027-08-02", "2027-08-03");
		await Database`UPDATE projects SET tax_country = 'SI' WHERE uuid = ${project}`;

		const own = (await feed(tokens.anna, "2027-08-01", "2027-08-15")).entries;
		expect(own.filter((entry: any) => entry.kind === "absence")).toMatchObject([
			{ absence_kind: "sick", pending: false, starts_on: "2027-08-02", ends_on: "2027-08-04", mine: true, accounts: ["cal-anna"] },
			{ absence_kind: "vacation", pending: true, mine: true },
		]);
		expect(own.find((entry: any) => entry.kind === "holiday")).toMatchObject({
			starts_on: "2027-08-15",
			holiday_name: { en: "Assumption Day", sl: "Marijino vnebovzetje" },
			work_free: true,
			accounts: [],
		});

		const colleague = (await feed(tokens.owner, "2027-08-01", "2027-08-14")).entries;
		expect(colleague).toHaveLength(1);
		expect(colleague[0]).toMatchObject({ kind: "absence", absence_kind: "sick", accounts: ["cal-anna"], mine: false });
		await Database`UPDATE project_members SET role = 'employee' WHERE uuid = ${members["cal-boris"]}`;
		const peer = (await feed(tokens.boris, "2027-08-01", "2027-08-14")).entries;
		expect(peer).toHaveLength(1);
		expect(peer[0]).toMatchObject({ kind: "absence", absence_kind: null, title: null, note: null });
		await Database`UPDATE project_members SET role = 'supervisor' WHERE uuid = ${members["cal-boris"]}`;
	});
});

describe("reminders", () => {
	test("reach the people of a meeting and the owner of an event once", async () => {
		const now = Date.now();
		const soon = now + 10 * 60 * 1000;
		const scheduled = await call("POST", `${chat()}/meetings`, tokens.owner, {
			title: "Planning",
			starts_at: soon,
			duration_minutes: 30,
			accounts: ["cal-anna"],
		});
		await call("POST", `${calendar()}/events`, tokens.boris, { title: "Call supplier", visibility: "private", starts_at: soon + 1000, duration_minutes: 15 });
		await call("POST", `${calendar()}/events`, tokens.boris, {
			title: "Daily check",
			starts_at: soon - 7 * 86400000,
			duration_minutes: 15,
			repeat: { unit: "day" },
		});
		await call("POST", `${calendar()}/events`, tokens.boris, { title: "Later", starts_at: soon + 3600_000, duration_minutes: 15 });

		const reminders = await dueReminders(soon - 30_000, soon + 30_000);
		expect(reminders.map((reminder) => reminder.title).sort()).toEqual(["Call supplier", "Daily check", "Planning"]);
		expect(reminders.find((reminder) => reminder.title === "Planning")).toMatchObject({
			kind: "meeting",
			project,
			starts_at: soon,
			conversation: scheduled.data.uuid,
		});
		expect(reminders.find((reminder) => reminder.title === "Planning")!.accounts.sort()).toEqual(["cal-anna", "cal-owner"]);
		expect(await dueReminders(soon + 30_000, soon + 60_000)).toEqual([]);

		const anna = listen("cal-anna");
		const boris = listen("cal-boris");
		sendReminders(reminders);
		expect(anna.events).toEqual([
			{ type: "calendar.reminder", project, kind: "meeting", title: "Planning", starts_at: soon, conversation: scheduled.data.uuid },
		]);
		expect(boris.events.map((event) => event.title).sort()).toEqual(["Call supplier", "Daily check"]);
		anna.stop();
		boris.stop();
	});
});
