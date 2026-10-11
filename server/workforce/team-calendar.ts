import Database from "../database/database";
import Permissions from "../permissions";
import { Permission } from "../roles";
import { Realtime } from "../realtime";
import { workforceActive } from "../licensing";
import { endOfLocalDate, isLocalDate, localDate, startOfLocalDate } from "../timezone";
import { holidayCalendar } from "./calendar";
import { Calls, GroupCalls } from "./calls";
import { chatMembers, participantsOf, recipientsOf } from "./chat";
import { mediaNodes } from "./media-nodes";
import { personName } from "./people";
import { notifyStartingSoon } from "./notifications";
import { PresenceBoard, type Presence } from "./presence";
import {
	daysApart,
	occurrenceDates,
	readRepeat,
	repeatOf,
	shiftDate,
	skipsOf,
	timedOccurrences,
	withSkip,
	type Repeat,
	type RepeatColumns,
} from "./recurrence";
import type { AbsenceKind, AbsenceRow, CalendarEventRow, CalendarVisibility, ChatMeetingRow, ProjectMemberRow, ProjectRow } from "../database/models";

export const CALENDAR_VISIBILITIES: CalendarVisibility[] = ["details", "busy", "private"];
export const MAX_CALENDAR_RANGE_DAYS = 100;
export const MAX_EVENT_TITLE_LENGTH = 80;
export const MAX_EVENT_NOTE_LENGTH = 2000;
export const MAX_EVENT_DAYS = 31;
export const MIN_EVENT_MINUTES = 5;
export const MAX_EVENT_MINUTES = 24 * 60;
export const REMINDER_LEAD_MINUTES = 10;

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_BEFORE_MS = 30 * 60 * 1000;
const LIVE_AFTER_MS = 2 * 60 * 60 * 1000;

export type CalendarEntryKind = "meeting" | "event" | "absence" | "holiday";

export interface CalendarEntry {
	id: string;
	kind: CalendarEntryKind;
	series: string | null;
	occurrence: string;
	accounts: string[];
	title: string | null;
	note: string | null;
	all_day: boolean;
	starts_at: number | null;
	ends_at: number | null;
	starts_on: string | null;
	ends_on: string | null;
	mine: boolean;
	editable: boolean;
	repeat: Repeat | null;
	series_starts_at: number | null;
	series_starts_on: string | null;
	series_ends_on: string | null;
	conversation: string | null;
	live: boolean;
	guests: boolean;
	visibility: CalendarVisibility | null;
	absence_kind: AbsenceKind | null;
	pending: boolean;
	holiday_name: { en: string; sl: string } | null;
	work_free: boolean;
}

export interface CalendarPerson {
	account: string;
	member: string;
	name: string;
	presence: Presence;
	call: { conversation: string | null; title: string | null } | null;
}

export interface CalendarEventInput {
	title: string;
	note: string | null;
	visibility: CalendarVisibility;
	all_day: boolean;
	starts_at: number | null;
	duration_minutes: number | null;
	starts_on: string | null;
	ends_on: string | null;
	repeat: Repeat | null;
}

export interface CalendarReminder {
	project: string;
	accounts: string[];
	kind: "meeting" | "event";
	title: string;
	starts_at: number;
	conversation: string | null;
}

function blankEntry(kind: CalendarEntryKind, id: string, occurrence: string): CalendarEntry {
	return {
		id,
		kind,
		series: null,
		occurrence,
		accounts: [],
		title: null,
		note: null,
		all_day: false,
		starts_at: null,
		ends_at: null,
		starts_on: null,
		ends_on: null,
		mine: false,
		editable: false,
		repeat: null,
		series_starts_at: null,
		series_starts_on: null,
		series_ends_on: null,
		conversation: null,
		live: false,
		guests: false,
		visibility: null,
		absence_kind: null,
		pending: false,
		holiday_name: null,
		work_free: false,
	};
}

export function readCalendarRange(from: unknown, to: unknown): { from: string; to: string } | null {
	if (!isLocalDate(from) || !isLocalDate(to) || to < from) return null;
	return daysApart(from, to) < MAX_CALENDAR_RANGE_DAYS ? { from, to } : null;
}

export function readEvent(data: Record<string, unknown>, timezone: string, previous?: CalendarEventRow): CalendarEventInput | null {
	const title = data.title ?? previous?.title;
	const note = data.note === undefined ? (previous?.note ?? null) : data.note;
	const visibility = data.visibility ?? previous?.visibility ?? "details";
	const allDay = data.all_day === undefined ? Boolean(previous?.all_day) : data.all_day;
	const repeatSource = data.repeat === undefined && previous ? repeatOf(previous) : data.repeat;

	if (typeof title !== "string" || title.trim() === "" || title.trim().length > MAX_EVENT_TITLE_LENGTH) return null;
	if (note !== null && (typeof note !== "string" || note.length > MAX_EVENT_NOTE_LENGTH)) return null;
	if (!CALENDAR_VISIBILITIES.includes(visibility as CalendarVisibility) || typeof allDay !== "boolean") return null;
	const shared = {
		title: title.trim(),
		note: typeof note === "string" && note.trim() ? note.trim() : null,
		visibility: visibility as CalendarVisibility,
	};

	if (allDay) {
		const startsOn = data.starts_on ?? previous?.starts_on;
		const endsOn = data.ends_on ?? data.starts_on ?? previous?.ends_on;
		if (!isLocalDate(startsOn) || !isLocalDate(endsOn) || endsOn < startsOn || daysApart(startsOn, endsOn) >= MAX_EVENT_DAYS) return null;
		const repeat = readRepeat(repeatSource, startsOn);
		if (repeat === undefined) return null;
		return { ...shared, all_day: true, starts_at: null, duration_minutes: null, starts_on: startsOn, ends_on: endsOn, repeat };
	}

	const startsAt = data.starts_at ?? (previous?.starts_at === null || previous?.starts_at === undefined ? undefined : Number(previous.starts_at));
	const minutes = data.duration_minutes ?? previous?.duration_minutes;
	if (typeof startsAt !== "number" || !Number.isSafeInteger(startsAt) || startsAt <= 0) return null;
	if (typeof minutes !== "number" || !Number.isSafeInteger(minutes) || minutes < MIN_EVENT_MINUTES || minutes > MAX_EVENT_MINUTES) return null;
	const repeat = readRepeat(repeatSource, localDate(startsAt, timezone));
	if (repeat === undefined) return null;
	return { ...shared, all_day: false, starts_at: startsAt, duration_minutes: minutes, starts_on: null, ends_on: null, repeat };
}

export function seriesRemoval(row: RepeatColumns, startsOn: string, occurrence: unknown, scope: unknown): "all" | { until: string } | { skips: string } | null {
	const repeat = repeatOf(row);
	if (!repeat || scope === "all" || scope === undefined || scope === null) return "all";
	if (!isLocalDate(occurrence) || occurrenceDates(startsOn, repeat, occurrence, occurrence, skipsOf(row)).length === 0) return null;
	if (scope === "following") return occurrence <= startsOn ? "all" : { until: shiftDate(occurrence, -1) };
	if (scope !== "one") return null;
	const skips = withSkip(row, occurrence);
	return skips === null ? null : { skips };
}

async function meetingEntries(
	project: ProjectRow,
	username: string,
	active: Set<string>,
	fromMs: number,
	toMs: number,
	earliestUntil: string
): Promise<CalendarEntry[]> {
	const meetings = (await Database`
		SELECT m.*, c.name AS conversation_name FROM chat_meetings m JOIN chat_conversations c ON c.uuid = m.conversation
		WHERE c.project = ${project.uuid} AND m.starts_at <= ${toMs}
			AND ((m.repeat_unit IS NULL AND m.starts_at >= ${fromMs - DAY_MS})
				OR (m.repeat_unit IS NOT NULL AND (m.repeat_until IS NULL OR m.repeat_until >= ${earliestUntil})))
	`) as (ChatMeetingRow & { conversation_name: string | null })[];
	const participants = await participantsOf(meetings.map((meeting) => meeting.conversation));

	const entries: CalendarEntry[] = [];
	meetings.forEach((meeting, index) => {
		const joined = participants.get(meeting.conversation) ?? [];
		const own = joined.find((participant) => participant.account === username);
		const accounts = joined.map((participant) => participant.account).filter((account) => active.has(account));
		if (accounts.length === 0) return;
		const repeat = repeatOf(meeting);
		const running = own !== undefined && GroupCalls.infoOf(meeting.conversation) !== null;
		const now = Date.now();
		const occurrences = timedOccurrences(Number(meeting.starts_at), Number(meeting.duration_minutes), repeat, skipsOf(meeting), fromMs, toMs, project.timezone);
		for (const occurrence of occurrences) {
			const shown = own !== undefined;
			entries.push({
				...blankEntry("meeting", `meeting:${shown ? meeting.conversation : `busy${index}`}:${occurrence.date}`, occurrence.date),
				series: shown ? meeting.conversation : null,
				accounts,
				title: shown ? meeting.conversation_name : null,
				starts_at: occurrence.starts_at,
				ends_at: occurrence.ends_at,
				mine: shown,
				editable: Boolean(own?.admin),
				repeat: shown ? repeat : null,
				series_starts_at: shown ? Number(meeting.starts_at) : null,
				conversation: shown ? meeting.conversation : null,
				live: running && now >= occurrence.starts_at - LIVE_BEFORE_MS && now <= occurrence.ends_at + LIVE_AFTER_MS,
				guests: shown && meeting.guest_token_hash !== null,
			});
		}
	});
	return entries;
}

async function eventEntries(
	project: ProjectRow,
	username: string,
	active: Set<string>,
	range: { from: string; to: string },
	fromMs: number,
	toMs: number,
	earliestUntil: string
): Promise<CalendarEntry[]> {
	const events = (await Database`
		SELECT * FROM calendar_events WHERE project = ${project.uuid} AND (account = ${username} OR visibility != 'private')
			AND ((repeat_unit IS NOT NULL AND (repeat_until IS NULL OR repeat_until >= ${earliestUntil})
					AND ((all_day = 0 AND starts_at <= ${toMs}) OR (all_day = 1 AND starts_on <= ${range.to})))
				OR (repeat_unit IS NULL AND all_day = 0 AND starts_at <= ${toMs} AND starts_at >= ${fromMs - DAY_MS})
				OR (repeat_unit IS NULL AND all_day = 1 AND starts_on <= ${range.to} AND ends_on >= ${range.from}))
	`) as CalendarEventRow[];

	const entries: CalendarEntry[] = [];
	events.forEach((event, index) => {
		if (!active.has(event.account)) return;
		const mine = event.account === username;
		const shown = mine || event.visibility === "details";
		const repeat = repeatOf(event);
		const common = (occurrence: string): CalendarEntry => ({
			...blankEntry("event", `event:${shown ? event.uuid : `busy${index}`}:${occurrence}`, occurrence),
			series: shown ? event.uuid : null,
			accounts: [event.account],
			title: shown ? event.title : null,
			note: shown ? event.note : null,
			all_day: Boolean(event.all_day),
			mine,
			editable: mine,
			repeat: shown ? repeat : null,
			visibility: mine ? event.visibility : null,
		});

		if (event.all_day) {
			const span = daysApart(event.starts_on!, event.ends_on!);
			for (const date of occurrenceDates(event.starts_on!, repeat, shiftDate(range.from, -span), range.to, skipsOf(event))) {
				const endsOn = shiftDate(date, span);
				if (endsOn < range.from) continue;
				entries.push({
					...common(date),
					starts_on: date,
					ends_on: endsOn,
					series_starts_on: shown ? event.starts_on : null,
					series_ends_on: shown ? event.ends_on : null,
				});
			}
			return;
		}
		const occurrences = timedOccurrences(Number(event.starts_at), Number(event.duration_minutes), repeat, skipsOf(event), fromMs, toMs, project.timezone);
		for (const occurrence of occurrences) {
			entries.push({
				...common(occurrence.date),
				starts_at: occurrence.starts_at,
				ends_at: occurrence.ends_at,
				series_starts_at: shown ? Number(event.starts_at) : null,
			});
		}
	});
	return entries;
}

async function absenceEntries(project: ProjectRow, self: ProjectMemberRow, members: ProjectMemberRow[], range: { from: string; to: string }) {
	if (members.length === 0) return [];
	const accountOf = new Map(members.map((member) => [member.uuid, member.account_username!]));
	const seesKinds = Permissions.has(self, Permission.TIMESHEET_VIEW);
	const absences = (await Database`
		SELECT * FROM absences WHERE project = ${project.uuid} AND starts_on <= ${range.to} AND ends_on >= ${range.from}
			AND member IN ${Database([...accountOf.keys()])} AND (status = 'approved' OR (status = 'pending' AND member = ${self.uuid}))
		ORDER BY starts_on ASC, created ASC
	`) as AbsenceRow[];
	return absences.map((absence): CalendarEntry => {
		const mine = absence.member === self.uuid;
		return {
			...blankEntry("absence", `absence:${absence.uuid}`, absence.starts_on),
			series: absence.uuid,
			accounts: [accountOf.get(absence.member!)!],
			all_day: true,
			starts_on: absence.starts_on,
			ends_on: absence.ends_on,
			mine,
			absence_kind: mine || seesKinds ? absence.kind : null,
			pending: absence.status === "pending",
		};
	});
}

async function holidayEntries(project: ProjectRow, range: { from: string; to: string }): Promise<CalendarEntry[]> {
	const holidays = await holidayCalendar(project, range.from, range.to);
	return [...holidays].map(([date, day]) => ({
		...blankEntry("holiday", `holiday:${date}`, date),
		all_day: true,
		starts_on: date,
		ends_on: date,
		holiday_name: day.name,
		work_free: day.work_free,
	}));
}

async function presentPeople(members: ProjectMemberRow[], username: string): Promise<CalendarPerson[]> {
	const inGroupCall = new Map<string, string>();
	for (const member of members) {
		const conversation = GroupCalls.conversationOf(member.account_username!);
		if (conversation !== null) inGroupCall.set(member.account_username!, conversation);
	}
	const running = [...new Set(inGroupCall.values())];
	const joined =
		running.length === 0
			? []
			: ((await Database`
					SELECT c.uuid, c.name FROM chat_conversations c JOIN chat_participants cp ON cp.conversation = c.uuid AND cp.account = ${username}
					WHERE c.uuid IN ${Database(running)}
				`) as { uuid: string; name: string | null }[]);
	const titles = new Map(joined.map((conversation) => [conversation.uuid, conversation.name]));

	return members
		.map((member) => {
			const account = member.account_username!;
			const conversation = inGroupCall.get(account);
			const shown = conversation !== undefined && titles.has(conversation);
			const call =
				conversation !== undefined
					? { conversation: shown ? conversation : null, title: shown ? (titles.get(conversation) ?? null) : null }
					: Calls.callOf(account) !== null
						? { conversation: null, title: null }
						: null;
			return { account, member: member.uuid, name: personName(member), presence: PresenceBoard.of(account), call };
		})
		.sort((first, second) => first.name.localeCompare(second.name));
}

export async function calendarFeed(project: ProjectRow, self: ProjectMemberRow, range: { from: string; to: string }) {
	const username = self.account_username!;
	const members = await chatMembers(project.uuid);
	const active = new Set(members.map((member) => member.account_username!));
	const fromMs = startOfLocalDate(shiftDate(range.from, -1), project.timezone);
	const toMs = endOfLocalDate(shiftDate(range.to, 1), project.timezone);
	const earliestUntil = shiftDate(range.from, -MAX_EVENT_DAYS);

	const [meetings, events, absences, holidays, people] = await Promise.all([
		meetingEntries(project, username, active, fromMs, toMs, earliestUntil),
		eventEntries(project, username, active, range, fromMs, toMs, earliestUntil),
		absenceEntries(project, self, members, range),
		holidayEntries(project, range),
		presentPeople(members, username),
	]);
	return {
		timezone: project.timezone,
		today: localDate(Date.now(), project.timezone),
		me: username,
		meetings: mediaNodes().length > 0,
		reminder_minutes: REMINDER_LEAD_MINUTES,
		people,
		entries: [...holidays, ...absences, ...events, ...meetings],
	};
}

export async function announceCalendar(projectId: string) {
	const accounts = (await chatMembers(projectId)).map((member) => member.account_username!);
	Realtime.send(accounts, { type: "calendar.changed", project: projectId });
}

export async function dueReminders(after: number, until: number): Promise<CalendarReminder[]> {
	if (until <= after) return [];
	const earliestUntil = shiftDate(new Date(after).toISOString().slice(0, 10), -2);
	const meetings = (await Database`
		SELECT m.*, c.name AS conversation_name, c.project AS conversation_project FROM chat_meetings m
		JOIN chat_conversations c ON c.uuid = m.conversation
		WHERE m.starts_at <= ${until} AND ((m.repeat_unit IS NULL AND m.starts_at > ${after})
			OR (m.repeat_unit IS NOT NULL AND (m.repeat_until IS NULL OR m.repeat_until >= ${earliestUntil})))
	`) as (ChatMeetingRow & { conversation_name: string | null; conversation_project: string })[];
	const events = (await Database`
		SELECT * FROM calendar_events WHERE all_day = 0 AND starts_at <= ${until} AND ((repeat_unit IS NULL AND starts_at > ${after})
			OR (repeat_unit IS NOT NULL AND (repeat_until IS NULL OR repeat_until >= ${earliestUntil})))
	`) as CalendarEventRow[];

	const projectIds = [...new Set([...meetings.map((meeting) => meeting.conversation_project), ...events.map((event) => event.project)])];
	if (projectIds.length === 0) return [];
	const projects = new Map(
		((await Database`SELECT * FROM projects WHERE uuid IN ${Database(projectIds)} AND status != 'deleted'`) as ProjectRow[])
			.filter((project) => workforceActive(project))
			.map((project) => [project.uuid, project])
	);
	const startsWithin = (row: RepeatColumns & { starts_at: number | null; duration_minutes: number | null }, timezone: string) =>
		timedOccurrences(Number(row.starts_at), Number(row.duration_minutes), repeatOf(row), skipsOf(row), after, until, timezone)
			.map((occurrence) => occurrence.starts_at)
			.filter((startsAt) => startsAt > after && startsAt <= until);

	const reminders: CalendarReminder[] = [];
	for (const meeting of meetings) {
		const project = projects.get(meeting.conversation_project);
		if (!project) continue;
		const starts = startsWithin(meeting, project.timezone);
		if (starts.length === 0) continue;
		const accounts = await recipientsOf({ uuid: meeting.conversation, project: project.uuid });
		for (const startsAt of starts) {
			reminders.push({
				project: project.uuid,
				accounts,
				kind: "meeting",
				title: meeting.conversation_name ?? "",
				starts_at: startsAt,
				conversation: meeting.conversation,
			});
		}
	}
	for (const event of events) {
		const project = projects.get(event.project);
		if (!project) continue;
		for (const startsAt of startsWithin(event, project.timezone)) {
			reminders.push({ project: project.uuid, accounts: [event.account], kind: "event", title: event.title, starts_at: startsAt, conversation: null });
		}
	}
	return reminders;
}

export async function sendReminders(reminders: CalendarReminder[]) {
	for (const reminder of reminders) await notifyStartingSoon(reminder);
}
