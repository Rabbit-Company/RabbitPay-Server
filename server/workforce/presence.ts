import Database from "../database/database";
import { Logger } from "../logger";
import { Realtime } from "../realtime";

export type Presence = "online" | "away" | "dnd" | "busy" | "offline";
export type ChosenStatus = "auto" | "away" | "dnd";

export const CHOSEN_STATUSES: ChosenStatus[] = ["auto", "away", "dnd"];

type PresenceListener = (username: string, presence: Presence) => void;

export namespace PresenceBoard {
	const OFFLINE_GRACE_MS = 5 * 1000;

	const announced = new Map<string, Presence>();
	const leaving = new Map<string, ReturnType<typeof setTimeout>>();
	const chosen = new Map<string, "away" | "dnd">();
	const listeners = new Set<PresenceListener>();
	let inCall: (username: string) => boolean = () => false;

	export function provideCallCheck(check: (username: string) => boolean) {
		inCall = check;
	}

	export function onChange(listener: PresenceListener) {
		listeners.add(listener);
	}

	export function of(username: string): Presence {
		if (!Realtime.isOnline(username) && !leaving.has(username)) return "offline";
		if (inCall(username)) return "busy";
		return chosen.get(username) ?? "online";
	}

	export async function chosenBy(username: string): Promise<ChosenStatus> {
		const [row] = (await Database`SELECT chat_status FROM accounts WHERE username = ${username}`) as { chat_status: string | null }[];
		return row?.chat_status === "away" || row?.chat_status === "dnd" ? row.chat_status : "auto";
	}

	function remember(username: string, status: ChosenStatus) {
		if (status === "auto") chosen.delete(username);
		else chosen.set(username, status);
	}

	export async function choose(username: string, status: ChosenStatus) {
		await Database`UPDATE accounts SET chat_status = ${status === "auto" ? null : status} WHERE username = ${username}`;
		remember(username, status);
		refresh(username);
	}

	export function refresh(...usernames: string[]) {
		for (const username of new Set(usernames)) {
			const presence = of(username);
			if ((announced.get(username) ?? "offline") === presence) continue;
			if (presence === "offline") {
				announced.delete(username);
				chosen.delete(username);
			} else announced.set(username, presence);
			for (const listener of listeners) listener(username, presence);
		}
	}

	function stay(username: string) {
		const timer = leaving.get(username);
		if (timer !== undefined) clearTimeout(timer);
		leaving.delete(username);
	}

	async function cameOnline(username: string) {
		stay(username);
		try {
			remember(username, await chosenBy(username));
		} catch (error) {
			Logger.warn(`[CHAT] Could not read the chosen status of ${username}: ${error}`);
		}
		refresh(username);
	}

	function wentOffline(username: string) {
		if (!announced.has(username)) return;
		stay(username);
		leaving.set(
			username,
			setTimeout(() => {
				leaving.delete(username);
				refresh(username);
			}, OFFLINE_GRACE_MS)
		);
	}

	export function reset() {
		for (const timer of leaving.values()) clearTimeout(timer);
		leaving.clear();
		announced.clear();
		chosen.clear();
	}

	Realtime.onOnline((username) => void cameOnline(username));
	Realtime.onOffline(wentOffline);
}
