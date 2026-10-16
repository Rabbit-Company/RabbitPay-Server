import Blake2b from "@rabbit-company/blake2b";
import { projectPath } from "../actions";
import { Browser } from "../browser";
import type { Session } from "../demo";
import type { Guide } from "../run";
import type { Studio } from "../studio";
import { slovenianSession } from "./slovenia";
import { PEOPLE, teammatePassword } from "./workforce";

const CONTENT = ".project-content";

interface Teammate {
	name: string;
	email: string;
	token: string;
	username: string;
}

const TEXT = {
	en: {
		hello: "Hi Emily, the posters for Slovenske železnice are ready for you to check.",
		reply: "Great, I will look at them after lunch.",
		follow: "Here is the list of changes:\n\n- bigger logo\n- **darker** blue in the sky\n- date in the bottom corner",
		code: "The colour codes for the print shop:\n\n```css\n.sky { color: #22495a; }\n.sun { color: #ef8a5b; }\n```",
		group: "Spring campaign",
		groupHello: "Welcome to the spring campaign group. Files and notes go here.",
		groupReply: "Thanks, I will add the brand guide tomorrow.",
		meeting: "Campaign review with the client",
	},
	sl: {
		hello: "Živjo Ana, plakati za Slovenske železnice so pripravljeni za pregled.",
		reply: "Odlično, pogledam jih po kosilu.",
		follow: "Seznam sprememb:\n\n- večji logotip\n- **temnejša** modra na nebu\n- datum v spodnjem kotu",
		code: "Barvne kode za tiskarno:\n\n```css\n.sky { color: #22495a; }\n.sun { color: #ef8a5b; }\n```",
		group: "Pomladna akcija",
		groupHello: "Dobrodošli v skupini za pomladno akcijo. Datoteke in zapiski gredo sem.",
		groupReply: "Hvala, jutri dodam celostno grafično podobo.",
		meeting: "Pregled akcije s stranko",
	},
};

function text(studio: Studio) {
	return TEXT[studio.language as "en" | "sl"];
}

export async function call<T = any>(studio: Studio, token: string, method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(`${studio.base}/api/v1${path}`, {
		method,
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const payload = (await response.json()) as { error: number; info: string; data: T };
	if (payload.error !== 0) throw new Error(`${method} ${path} failed: ${payload.info}`);
	return payload.data;
}

export async function teammates(studio: Studio): Promise<Teammate[]> {
	const result: Teammate[] = [];
	for (const person of PEOPLE[studio.language as "en" | "sl"]) {
		const response = await fetch(`${studio.base}/api/v1/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: person.email, password: Blake2b.hash(teammatePassword(person.email)) }),
		});
		const payload = (await response.json()) as { data: { token: string; username: string } };
		result.push({ name: person.name, email: person.email, token: payload.data.token, username: payload.data.username });
	}
	return result;
}

async function ownToken(studio: Studio): Promise<string> {
	return await studio.browser.eval<string>(`localStorage.getItem("rabbitpay.token")`);
}

function chatBase(session: Session): string {
	return `/projects/${session.project}/chat`;
}

async function prepare(studio: Studio, session: Session) {
	const local = slovenianSession(session);
	await studio.open(projectPath(local), 800);
	const team = await teammates(studio);
	const me = await ownToken(studio);
	const words = text(studio);
	const base = chatBase(local);

	const direct = await call<{ uuid: string }>(studio, team[0]!.token, "POST", `${base}/conversations`, {
		kind: "direct",
		account: await studio.browser.eval<string>(`localStorage.getItem("rabbitpay.username")`),
	});
	await call(studio, team[0]!.token, "POST", `${base}/conversations/${direct.uuid}/messages`, { body: words.hello });
	await call(studio, me, "POST", `${base}/conversations/${direct.uuid}/messages`, { body: words.reply });
	await call(studio, team[0]!.token, "POST", `${base}/conversations/${direct.uuid}/messages`, { body: words.follow });
	await call(studio, team[0]!.token, "POST", `${base}/conversations/${direct.uuid}/messages`, { body: words.code });

	const group = await call<{ uuid: string }>(studio, team[1]!.token, "POST", `${base}/conversations`, {
		kind: "group",
		name: words.group,
		accounts: [team[0]!.username, await studio.browser.eval<string>(`localStorage.getItem("rabbitpay.username")`)],
	});
	await call(studio, team[1]!.token, "POST", `${base}/conversations/${group.uuid}/messages`, { body: words.groupHello });
	await call(studio, team[0]!.token, "POST", `${base}/conversations/${group.uuid}/messages`, { body: words.groupReply });
	session.marks = { ...session.marks, chatDirect: direct.uuid, chatGroup: group.uuid };
}

async function conversations(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "conversations";
	await studio.open(projectPath(local), 1500);
	await studio.shot(page, "nav", { target: ".project-nav", padding: 12, mark: `.project-nav a[href$="/chat"]` });
	await studio.open(projectPath(local, "/chat"), 2000);
	await studio.shot(page, "list", { target: CONTENT });
	await browser.click(`button:${studio.t("chat.new")}`, 600);
	await studio.shot(page, "new-menu", { target: CONTENT, mark: ".menu-panel-floating, .menu-panel" });
	await browser.eval(`document.body.click()`);
	await studio.open(projectPath(local, `/chat/${session.marks!.chatDirect}`), 2500);
	await studio.shot(page, "conversation", { target: CONTENT });
	await browser.fill(`${CONTENT} textarea`, text(studio).reply);
	await browser.blur();
	await studio.shot(page, "write", { target: `${CONTENT} form:has(textarea)`, padding: 12 });
}

async function groups(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "groups";
	await studio.open(projectPath(local, "/chat"), 2000);
	await browser.click(`button:${studio.t("chat.new")}`, 600);
	await browser.click(`menu:${studio.t("chat.new_group")}`, 800);
	if (await browser.exists(".dialog")) {
		await browser.fill(`.dialog >> field:${studio.t("chat.group_name")}`, text(studio).group);
		await browser.blur();
		await studio.shot(page, "new", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .icon-button");
	}
	await studio.open(projectPath(local, `/chat/${session.marks!.chatGroup}`), 2500);
	await studio.shot(page, "group", { target: CONTENT });
	await browser.click(`button:${studio.t("chat.group_details")}`, 1000);
	if (await browser.exists(".dialog")) {
		await studio.shot(page, "details", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .icon-button");
	}
}

async function status(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	await studio.open(projectPath(local, "/chat"), 2000);
	await studio.shot("conversations", "status", { target: `${CONTENT} .chat-list-head`, padding: 12, mark: `${CONTENT} .chat-status` });
}

async function calls(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "calls";
	const team = await teammates(studio);
	const peer = await Browser.launch(9335, studio.language === "sl" ? "sl-SI" : "en-IE");
	try {
		await peer.viewport(1280, 800);
		await peer.theme("dark");
		await peer.goto(`${studio.base}/login`, 1000);
		await peer.eval(
			`(() => { localStorage.setItem("rabbitpay.token", ${JSON.stringify(team[0]!.token)}); localStorage.setItem("rabbitpay.username", ${JSON.stringify(team[0]!.username)}); localStorage.setItem("rabbitpay.email", ${JSON.stringify(team[0]!.email)}); localStorage.setItem("rabbitpay.admin", "0"); localStorage.setItem("rabbitpay.language", ${JSON.stringify(studio.language)}); })()`
		);
		await peer.goto(`${studio.base}${projectPath(local, `/chat/${session.marks!.chatDirect}`)}`, 3000);

		await studio.open(projectPath(local, `/chat/${session.marks!.chatDirect}`), 2500);
		await studio.shot(page, "buttons", { target: `${CONTENT} .chat-thread-head`, padding: 12, mark: `${CONTENT} .chat-head-action` });
		await browser.click(`${CONTENT} button[aria-label="${studio.t("calls.call")}"]`, 2000);
		await studio.shot(page, "calling");
		await peer.wait(2500);
		const answered = await peer.eval<boolean>(
			`(() => { const button = [...document.querySelectorAll("button")].find((element) => element.title === ${JSON.stringify(studio.t("calls.accept"))} || element.getAttribute("aria-label") === ${JSON.stringify(studio.t("calls.accept"))}); if (button) button.click(); return Boolean(button); })()`
		);
		await browser.wait(4000);
		await studio.shot(page, answered ? "in-call" : "not-answered");
		await browser.eval(
			`[...document.querySelectorAll("button")].find((element) => element.title === ${JSON.stringify(studio.t("calls.hang_up"))} || element.getAttribute("aria-label") === ${JSON.stringify(studio.t("calls.hang_up"))})?.click()`
		);
		await browser.wait(1500);
		await studio.open(projectPath(local, `/chat/${session.marks!.chatDirect}`), 2000);
		await studio.shot(page, "call-line", { target: CONTENT });
	} finally {
		await peer.close();
	}
}

async function meetings(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "meetings";
	await studio.open(projectPath(local, "/chat"), 2000);
	await browser.click(`button:${studio.t("chat.new")}`, 600);
	await browser.click(`menu:${studio.t("meetings.schedule")}`, 800);
	if (await browser.exists(".dialog")) {
		await browser.fill(`.dialog >> field:${studio.t("meetings.title_label")}`, text(studio).meeting);
		await browser.eval(`[...document.querySelectorAll(".dialog .switch input")].forEach((input) => { if (!input.checked) input.click(); })`);
		await browser.blur();
		await studio.shot(page, "new", { target: ".dialog", padding: 32, mark: `.dialog >> button:${studio.t("meetings.schedule")}` });
		await browser.click(`.dialog >> button:${studio.t("meetings.schedule")}`, 2500);
	}
	await studio.shot(page, "meeting", { target: CONTENT });
	await browser.click(`button:${studio.t("chat.group_details")}`, 1000);
	if (await browser.exists(".dialog")) {
		await studio.shot(page, "guest-link", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .icon-button");
	}
}

export const chat: Guide = {
	module: "chat",
	steps: [
		["prepare", prepare],
		["conversations", conversations],
		["groups", groups],
		["status", status],
		["calls", calls],
		["meetings", meetings],
	],
};
