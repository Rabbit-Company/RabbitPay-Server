import { projectApi, projectPath } from "../actions";
import type { Session } from "../demo";
import type { Guide } from "../run";
import type { Studio } from "../studio";
import { call, teammates } from "./chat";
import { slovenianSession } from "./slovenia";

const CONTENT = ".project-content";

const EVENTS = {
	en: {
		mine: [
			{ title: "Studio planning", day: 0, hour: 9, minutes: 60, visibility: "details" },
			{ title: "Dentist", day: 2, hour: 15, minutes: 60, visibility: "busy" },
			{ title: "Print shop visit", day: 3, hour: 10, minutes: 90, visibility: "details" },
		],
		james: [{ title: "Photo shoot for the brochure", day: 1, hour: 9, minutes: 180, visibility: "details" }],
		sarah: [{ title: "Client call with Telekom Slovenije", day: 3, hour: 14, minutes: 60, visibility: "busy" }],
		newEvent: "Website launch",
		newMeeting: "Weekly studio meeting",
	},
	sl: {
		mine: [
			{ title: "Načrtovanje v studiu", day: 0, hour: 9, minutes: 60, visibility: "details" },
			{ title: "Zobozdravnik", day: 2, hour: 15, minutes: 60, visibility: "busy" },
			{ title: "Obisk tiskarne", day: 3, hour: 10, minutes: 90, visibility: "details" },
		],
		james: [{ title: "Fotografiranje za brošuro", day: 1, hour: 9, minutes: 180, visibility: "details" }],
		sarah: [{ title: "Klic s stranko Telekom Slovenije", day: 3, hour: 14, minutes: 60, visibility: "busy" }],
		newEvent: "Zagon spletne strani",
		newMeeting: "Tedenski sestanek studia",
	},
};

function text(studio: Studio) {
	return EVENTS[studio.language as "en" | "sl"];
}

function monday(): Date {
	const now = new Date();
	const day = (now.getDay() + 6) % 7;
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
}

function at(day: number, hour: number): number {
	const start = monday();
	return new Date(start.getFullYear(), start.getMonth(), start.getDate() + day, hour).getTime();
}

async function prepare(studio: Studio, session: Session) {
	const local = slovenianSession(session);
	await studio.open(projectPath(local), 800);
	const words = text(studio);
	const body = (event: { title: string; day: number; hour: number; minutes: number; visibility: string }) => ({
		title: event.title,
		note: null,
		visibility: event.visibility,
		all_day: false,
		starts_at: at(event.day, event.hour),
		duration_minutes: event.minutes,
	});
	for (const event of words.mine) await projectApi(studio, local, "POST", "/calendar/events", body(event));
	const team = await teammates(studio);
	for (const event of words.james) await call(studio, team[0]!.token, "POST", `/projects/${local.project}/calendar/events`, body(event));
	for (const event of words.sarah) await call(studio, team[1]!.token, "POST", `/projects/${local.project}/calendar/events`, body(event));
}

async function views(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "views";
	await studio.open(projectPath(local), 1500);
	await studio.shot(page, "nav", { target: ".project-nav", padding: 12, mark: `.project-nav a[href$="/calendar"]` });
	await studio.open(projectPath(local, "/calendar"), 2500);
	for (const index of [2, 3]) {
		await browser.click(`${CONTENT} .calendar-people .calendar-person:nth-child(${index})`, 800);
	}
	await browser.wait(1200);
	await studio.shot(page, "week", { target: CONTENT });
	for (const view of ["team", "month", "day"]) {
		const clicked = await browser.eval<boolean>(
			`(() => { const button = [...document.querySelectorAll("${CONTENT} button")].find((element) => element.textContent === ${JSON.stringify(studio.t(`calendar.mode_${view}` as never))}); if (button) button.click(); return Boolean(button); })()`
		);
		if (!clicked) continue;
		await browser.wait(1500);
		await studio.shot(page, view, { target: CONTENT });
	}
}

async function events(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "events";
	await studio.open(projectPath(local, "/calendar"), 2500);
	await studio.shot(page, "new-button", { target: `${CONTENT} .calendar-tools`, padding: 12, mark: `button:${studio.t("calendar.new")}` });
	await browser.click(`button:${studio.t("calendar.new")}`, 800);
	if (await browser.exists(".dialog")) {
		await browser.fill(".dialog input[type=text]", text(studio).newEvent);
		await browser.blur();
		await studio.shot(page, "event", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .icon-button");
	}
	await browser.click(`button:${studio.t("calendar.new")}`, 800);
	if (await browser.exists(".dialog")) {
		await browser.click(`.dialog >> button:${studio.t("calendar.kind_meeting")}`, 600);
		await browser.fill(".dialog input[type=text]", text(studio).newMeeting);
		await browser.eval(`document.querySelectorAll(".dialog input[type=checkbox]").forEach((input) => { if (!input.checked) input.click(); })`);
		await browser.blur();
		await browser.wait(800);
		await studio.shot(page, "meeting", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .icon-button");
	}
}

export const calendar: Guide = {
	module: "calendar",
	steps: [
		["prepare", prepare],
		["views", views],
		["events", events],
	],
};
