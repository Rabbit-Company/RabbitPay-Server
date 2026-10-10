import type { Context } from "@rabbit-company/web";
import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { localDate } from "../../timezone";
import { requireWorkforce } from "../../workforce/access";
import { repeatColumns, repeatOf, sameRepeat } from "../../workforce/recurrence";
import { announceCalendar, calendarFeed, readCalendarRange, readEvent, seriesRemoval, type CalendarEventInput } from "../../workforce/team-calendar";
import type { AppState, CalendarEventRow } from "../../database/models";

const base = "/api/v1/projects/:uuid/calendar";
const calendar = [Auth.required(), Permissions.require(Permission.CHAT_USE), requireWorkforce()] as const;

async function body(ctx: Context<AppState>): Promise<Record<string, unknown> | null> {
	try {
		const value = await ctx.body<Record<string, unknown>>();
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

async function ownEvent(ctx: Context<AppState>): Promise<CalendarEventRow | null> {
	if (!Validate.uuid(ctx.params.event)) return null;
	const [event] = (await Database`
		SELECT * FROM calendar_events
		WHERE uuid = ${ctx.params.event} AND project = ${Permissions.project(ctx).uuid} AND account = ${Auth.account(ctx).username}
	`) as CalendarEventRow[];
	return event ?? null;
}

function presentEvent(event: CalendarEventRow) {
	return {
		uuid: event.uuid,
		title: event.title,
		note: event.note,
		visibility: event.visibility,
		all_day: Boolean(event.all_day),
		starts_at: event.starts_at === null ? null : Number(event.starts_at),
		duration_minutes: event.duration_minutes === null ? null : Number(event.duration_minutes),
		starts_on: event.starts_on,
		ends_on: event.ends_on,
		repeat: repeatOf(event),
		created: Number(event.created),
		updated: Number(event.updated),
	};
}

async function eventById(uuid: string) {
	const [event] = (await Database`SELECT * FROM calendar_events WHERE uuid = ${uuid}`) as CalendarEventRow[];
	return presentEvent(event);
}

function keepsOccurrences(previous: CalendarEventRow, input: CalendarEventInput): boolean {
	return (
		Boolean(previous.all_day) === input.all_day &&
		(previous.starts_at === null ? null : Number(previous.starts_at)) === input.starts_at &&
		previous.starts_on === input.starts_on &&
		sameRepeat(repeatOf(previous), input.repeat)
	);
}

Server.app.get(base, ...calendar, async (ctx) => {
	const query = ctx.query();
	const range = readCalendarRange(query.get("from"), query.get("to"));
	if (!range) return Utils.fail(ctx, ErrorCode.INVALID_CALENDAR_RANGE);
	ctx.header("Cache-Control", "no-store");
	return Utils.ok(ctx, await calendarFeed(Permissions.project(ctx), Permissions.member(ctx), range));
});

Server.app.post(`${base}/events`, ...calendar, async (ctx) => {
	const project = Permissions.project(ctx);
	const data = await body(ctx);
	const input = data ? readEvent(data, project.timezone) : null;
	if (!input) return Utils.fail(ctx, ErrorCode.INVALID_CALENDAR_EVENT);

	const uuid = crypto.randomUUID();
	const now = Date.now();
	const repeat = repeatColumns(input.repeat);
	await Database`
		INSERT INTO calendar_events(uuid, project, account, title, note, visibility, all_day, starts_at, duration_minutes, starts_on, ends_on,
			repeat_unit, repeat_interval, repeat_weekdays, repeat_until, created, updated)
		VALUES(${uuid}, ${project.uuid}, ${Auth.account(ctx).username}, ${input.title}, ${input.note}, ${input.visibility}, ${input.all_day ? 1 : 0},
			${input.starts_at}, ${input.duration_minutes}, ${input.starts_on}, ${input.ends_on}, ${repeat.repeat_unit}, ${repeat.repeat_interval},
			${repeat.repeat_weekdays}, ${repeat.repeat_until}, ${now}, ${now})
	`;
	await announceCalendar(project.uuid);
	return Utils.ok(ctx, await eventById(uuid), 201);
});

Server.app.patch(`${base}/events/:event`, ...calendar, async (ctx) => {
	const project = Permissions.project(ctx);
	const previous = await ownEvent(ctx);
	if (!previous) return Utils.fail(ctx, ErrorCode.CALENDAR_EVENT_NOT_FOUND);
	const data = await body(ctx);
	const input = data ? readEvent(data, project.timezone, previous) : null;
	if (!input) return Utils.fail(ctx, ErrorCode.INVALID_CALENDAR_EVENT);

	const repeat = repeatColumns(input.repeat);
	const skips = keepsOccurrences(previous, input) ? previous.repeat_skips : null;
	await Database`
		UPDATE calendar_events SET title = ${input.title}, note = ${input.note}, visibility = ${input.visibility}, all_day = ${input.all_day ? 1 : 0},
			starts_at = ${input.starts_at}, duration_minutes = ${input.duration_minutes}, starts_on = ${input.starts_on}, ends_on = ${input.ends_on},
			repeat_unit = ${repeat.repeat_unit}, repeat_interval = ${repeat.repeat_interval}, repeat_weekdays = ${repeat.repeat_weekdays},
			repeat_until = ${repeat.repeat_until}, repeat_skips = ${skips}, updated = ${Date.now()}
		WHERE uuid = ${previous.uuid}
	`;
	await announceCalendar(project.uuid);
	return Utils.ok(ctx, await eventById(previous.uuid));
});

Server.app.delete(`${base}/events/:event`, ...calendar, async (ctx) => {
	const project = Permissions.project(ctx);
	const event = await ownEvent(ctx);
	if (!event) return Utils.fail(ctx, ErrorCode.CALENDAR_EVENT_NOT_FOUND);
	const query = ctx.query();
	const startsOn = event.all_day ? event.starts_on! : localDate(Number(event.starts_at), project.timezone);
	const removal = seriesRemoval(event, startsOn, query.get("occurrence"), query.get("scope"));
	if (removal === null) return Utils.fail(ctx, ErrorCode.INVALID_CALENDAR_EVENT);

	if (removal === "all") await Database`DELETE FROM calendar_events WHERE uuid = ${event.uuid}`;
	else if ("until" in removal) await Database`UPDATE calendar_events SET repeat_until = ${removal.until}, updated = ${Date.now()} WHERE uuid = ${event.uuid}`;
	else await Database`UPDATE calendar_events SET repeat_skips = ${removal.skips}, updated = ${Date.now()} WHERE uuid = ${event.uuid}`;
	await announceCalendar(project.uuid);
	return Utils.ok(ctx, { removed: removal === "all" });
});
