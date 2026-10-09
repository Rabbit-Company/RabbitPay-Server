import { Api, type ChatStatus } from "./api";
import { onRealtime, type RealtimeEvent } from "./realtime";

type Watcher = (status: ChatStatus) => void;

const watchers = new Set<Watcher>();
let status: ChatStatus = "auto";
let listening = false;
let fresh = false;

function apply(next: ChatStatus) {
	status = next;
	for (const watcher of [...watchers]) watcher(next);
}

async function load() {
	fresh = true;
	try {
		apply((await Api.chatStatus()).status);
	} catch {
		void 0;
	}
}

function onEvent(event: RealtimeEvent) {
	if (event.type === "realtime.ready" && event.reconnected) void load();
	if (event.type === "presence.chosen") apply(event.status as ChatStatus);
}

export function followOwnStatus() {
	if (!listening) {
		listening = true;
		onRealtime(onEvent);
	}
	if (!fresh) void load();
}

export function ownStatus(): ChatStatus {
	return status;
}

export function watchOwnStatus(watcher: Watcher): () => void {
	followOwnStatus();
	watchers.add(watcher);
	return () => {
		watchers.delete(watcher);
	};
}

export async function chooseOwnStatus(next: ChatStatus) {
	apply((await Api.setChatStatus(next)).status);
}

export function forgetOwnStatus() {
	status = "auto";
	fresh = false;
}
