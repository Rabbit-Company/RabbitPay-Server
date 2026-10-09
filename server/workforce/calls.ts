import { createHmac } from "node:crypto";
import { Settings } from "../settings";
import { Logger } from "../logger";
import { Realtime, type RealtimeConnection, type RealtimeEvent } from "../realtime";
import { insertMessage, notify, presentMessageById, provideGroupCallInfo } from "./chat";
import { closeRoom, countJoin, joinToken, pickNode, roomPeople } from "./media-nodes";
import type { CallOutcome, ChatConversationRow } from "../database/models";

export const CLIENT_FORMAT = /^[A-Za-z0-9]{16}$/;

const TURN_CREDENTIAL_SECONDS = 6 * 60 * 60;
const MAX_CALL_MS = 12 * 60 * 60 * 1000;
const OFFLINE_GRACE_MS = 90 * 1000;

export interface CallParty {
	username: string;
	name: string;
	client: string | null;
}

export interface Call {
	uuid: string;
	conversation: ChatConversationRow;
	caller: CallParty;
	callee: CallParty;
	video: boolean;
	state: "ringing" | "active";
	created: number;
	answered: number | null;
	timer: ReturnType<typeof setTimeout> | null;
}

export interface IceServer {
	urls: string[];
	username?: string;
	credential?: string;
}

function urlList(value: string): string[] {
	return value
		.split(",")
		.map((url) => url.trim())
		.filter((url) => url !== "");
}

export function iceServers(username: string, now = Date.now()): IceServer[] {
	const servers: IceServer[] = [];
	const stun = urlList(Settings.calls.stun_urls);
	if (stun.length > 0) servers.push({ urls: stun });
	const turn = urlList(Settings.calls.turn_urls);
	if (turn.length > 0 && Settings.calls.turn_secret !== "") {
		const user = `${Math.floor(now / 1000) + TURN_CREDENTIAL_SECONDS}:${username}`;
		servers.push({ urls: turn, username: user, credential: createHmac("sha1", Settings.calls.turn_secret).update(user).digest("base64") });
	}
	return servers;
}

export namespace Calls {
	const calls = new Map<string, Call>();
	const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

	export function find(uuid: string): Call | null {
		return calls.get(uuid) ?? null;
	}

	export function callOf(username: string): Call | null {
		for (const call of calls.values()) {
			if (call.caller.username === username || call.callee.username === username) return call;
		}
		return null;
	}

	function partyOf(call: Call, username: string): CallParty | null {
		if (call.caller.username === username) return call.caller;
		if (call.callee.username === username) return call.callee;
		return null;
	}

	function send(call: Call, usernames: string[], event: RealtimeEvent) {
		Realtime.send(usernames, { ...event, call: call.uuid, project: call.conversation.project, conversation: call.conversation.uuid });
	}

	async function log(call: Call, outcome: CallOutcome, seconds: number) {
		try {
			const inserted = await insertMessage(call.conversation, call.caller, "", [], { outcome, seconds, video: call.video });
			const message = await presentMessageById(call.conversation.project, inserted.uuid);
			if (message) await notify(call.conversation, { type: "chat.message", message });
		} catch (error) {
			Logger.error(`[CALLS] Could not record call ${call.uuid}: ${error}`);
		}
	}

	async function close(call: Call, outcome: CallOutcome) {
		if (!calls.delete(call.uuid)) return;
		if (call.timer !== null) clearTimeout(call.timer);
		const seconds = call.answered === null ? 0 : Math.max(Math.round((Date.now() - call.answered) / 1000), 0);
		send(call, [call.caller.username, call.callee.username], { type: "call.ended", reason: outcome });
		await log(call, outcome, seconds);
	}

	export async function recordUnreachable(conversation: ChatConversationRow, caller: CallParty, callee: CallParty, video: boolean) {
		await log({ uuid: "", conversation, caller, callee, video, state: "ringing", created: Date.now(), answered: null, timer: null }, "missed", 0);
	}

	export async function start(conversation: ChatConversationRow, caller: CallParty, callee: CallParty, video: boolean): Promise<Call | "busy" | "offline"> {
		const previous = callOf(caller.username);
		if (previous) await end(previous.uuid, caller.username);
		const theirs = callOf(callee.username);
		if (theirs && Date.now() - theirs.created > MAX_CALL_MS) await close(theirs, "answered");
		else if (theirs) return "busy";
		if (!Realtime.isOnline(callee.username)) return "offline";

		const call: Call = { uuid: crypto.randomUUID(), conversation, caller, callee, video, state: "ringing", created: Date.now(), answered: null, timer: null };
		call.timer = setTimeout(() => void close(call, "missed"), Settings.calls.ring_seconds * 1000);
		calls.set(call.uuid, call);
		send(call, [callee.username], { type: "call.incoming", from: { account: caller.username, name: caller.name }, video });
		return call;
	}

	export function accept(uuid: string, username: string, client: string): Call | null {
		const call = calls.get(uuid);
		if (!call || call.state !== "ringing" || call.callee.username !== username) return null;
		if (call.timer !== null) clearTimeout(call.timer);
		call.timer = null;
		call.state = "active";
		call.answered = Date.now();
		call.callee.client = client;
		send(call, [call.caller.username, call.callee.username], { type: "call.accepted", client, to: call.caller.client });
		return call;
	}

	export async function end(uuid: string, username: string): Promise<boolean> {
		const call = calls.get(uuid);
		if (!call || partyOf(call, username) === null) return false;
		const outcome: CallOutcome = call.state === "active" ? "answered" : call.caller.username === username ? "cancelled" : "declined";
		await close(call, outcome);
		return true;
	}

	export function signal(connection: RealtimeConnection, event: RealtimeEvent) {
		const call = typeof event.call === "string" ? calls.get(event.call) : undefined;
		if (!call || call.state !== "active" || event.data === null || typeof event.data !== "object") return;
		const sender = partyOf(call, connection.username);
		if (!sender || sender.client !== event.client) return;
		const receiver = sender === call.caller ? call.callee : call.caller;
		send(call, [receiver.username], { type: "call.signal", to: receiver.client, data: event.data });
	}

	function wentOffline(username: string) {
		if (offlineTimers.has(username) || callOf(username) === null) return;
		offlineTimers.set(
			username,
			setTimeout(() => {
				offlineTimers.delete(username);
				const call = callOf(username);
				if (call && !Realtime.isOnline(username)) void end(call.uuid, username);
			}, OFFLINE_GRACE_MS)
		);
	}

	export function reset() {
		for (const call of calls.values()) if (call.timer !== null) clearTimeout(call.timer);
		for (const timer of offlineTimers.values()) clearTimeout(timer);
		calls.clear();
		offlineTimers.clear();
	}

	Realtime.on("call.signal", signal);
	Realtime.onOffline(wentOffline);
}

export const GUEST_PREFIX = "guest-";

export interface GroupCall {
	uuid: string;
	conversation: ChatConversationRow;
	node: string;
	starter: CallParty;
	started: number;
	people: Set<string>;
}

export interface GroupCallInfo {
	call: string;
	people: number;
	started: number;
	started_by: string;
}

export namespace GroupCalls {
	const SWEEP_MS = 60 * 1000;
	const EMPTY_GRACE_MS = 60 * 1000;

	const calls = new Map<string, GroupCall>();
	let sweeper: ReturnType<typeof setInterval> | null = null;

	function onlyGuests(people: Set<string>): boolean {
		return [...people].every((identity) => identity.startsWith(GUEST_PREFIX));
	}

	export function infoOf(conversation: string): GroupCallInfo | null {
		const call = calls.get(conversation);
		return call ? { call: call.uuid, people: call.people.size, started: call.started, started_by: call.starter.name } : null;
	}

	async function announce(call: GroupCall, active: boolean, ring: boolean) {
		await notify(call.conversation, {
			type: "call.group",
			active,
			ring,
			starter: call.starter.username,
			info: active ? infoOf(call.conversation.uuid) : null,
		});
	}

	async function finish(call: GroupCall) {
		if (calls.get(call.conversation.uuid) !== call) return;
		calls.delete(call.conversation.uuid);
		if (calls.size === 0 && sweeper !== null) {
			clearInterval(sweeper);
			sweeper = null;
		}
		await announce(call, false, false);
		void closeRoom(call.node, call.uuid);
		try {
			const seconds = Math.max(Math.round((Date.now() - call.started) / 1000), 0);
			const inserted = await insertMessage(call.conversation, call.starter, "", [], { outcome: "answered", seconds, video: true });
			const message = await presentMessageById(call.conversation.project, inserted.uuid);
			if (message) await notify(call.conversation, { type: "chat.message", message });
		} catch (error) {
			Logger.error(`[CALLS] Could not record group call ${call.uuid}: ${error}`);
		}
	}

	export async function join(
		conversation: ChatConversationRow,
		party: CallParty,
		mayStart = true
	): Promise<{ call: GroupCall; token: string } | "unavailable" | "full" | "closed"> {
		let call = calls.get(conversation.uuid);
		const created = !call;
		if (!call && !mayStart) return "closed";
		if (!call) {
			const node = await pickNode();
			if (node === null) return "unavailable";
			call = calls.get(conversation.uuid) ?? { uuid: crypto.randomUUID(), conversation, node, starter: party, started: Date.now(), people: new Set() };
			calls.set(conversation.uuid, call);
			sweeper ??= setInterval(() => void sweep(), SWEEP_MS);
		}
		if (!call.people.has(party.username) && call.people.size >= Settings.calls.max_group_people) return "full";
		if (!call.people.has(party.username)) countJoin(call.node);
		call.people.add(party.username);
		await announce(call, true, created);
		return { call, token: joinToken(call.uuid, party.username, party.name) };
	}

	export async function leave(conversation: string, username: string): Promise<boolean> {
		const call = calls.get(conversation);
		if (!call || !call.people.delete(username)) return false;
		if (onlyGuests(call.people)) await finish(call);
		else await announce(call, true, false);
		return true;
	}

	export async function sweep(now = Date.now()) {
		for (const call of [...calls.values()]) {
			const present = await roomPeople(call.node, call.uuid);
			if (present === null) continue;
			const before = call.people.size;
			call.people = new Set(present);
			if (onlyGuests(call.people) && now - call.started >= EMPTY_GRACE_MS) await finish(call);
			else if (present.length !== before) await announce(call, true, false);
		}
	}

	export function reset() {
		if (sweeper !== null) clearInterval(sweeper);
		sweeper = null;
		calls.clear();
	}
}

provideGroupCallInfo(GroupCalls.infoOf);
