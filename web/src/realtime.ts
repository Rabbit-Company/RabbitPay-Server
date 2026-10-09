import { Api, getToken } from "./api";

export interface RealtimeEvent {
	type: string;
	[field: string]: unknown;
}

type Listener = (event: RealtimeEvent) => void;

const PING_INTERVAL_MS = 30 * 1000;
const PONG_TIMEOUT_MS = 10 * 1000;
const MAX_RETRY_MS = 30 * 1000;
const CLOSE_UNAUTHORIZED = 4401;

const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let connecting = false;
let attempts = 0;
let everReady = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let pongTimer: ReturnType<typeof setTimeout> | null = null;
let watchingNetwork = false;

function emit(event: RealtimeEvent) {
	for (const listener of [...listeners]) listener(event);
}

function clearTimers() {
	if (pingTimer !== null) clearInterval(pingTimer);
	if (pongTimer !== null) clearTimeout(pongTimer);
	pingTimer = null;
	pongTimer = null;
}

function scheduleRetry() {
	if (retryTimer !== null || listeners.size === 0 || getToken() === null) return;
	const delay = Math.min(MAX_RETRY_MS, 1000 * 2 ** attempts) * (0.75 + Math.random() * 0.5);
	attempts++;
	retryTimer = setTimeout(() => {
		retryTimer = null;
		void connect();
	}, delay);
}

function retryNow() {
	if (socket !== null || connecting) return;
	if (retryTimer !== null) clearTimeout(retryTimer);
	retryTimer = null;
	void connect();
}

function watchNetwork() {
	if (watchingNetwork) return;
	watchingNetwork = true;
	window.addEventListener("online", retryNow);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") retryNow();
	});
}

function ping(current: WebSocket) {
	if (current.readyState !== WebSocket.OPEN) return;
	current.send(JSON.stringify({ type: "ping" }));
	if (pongTimer === null) pongTimer = setTimeout(() => current.close(), PONG_TIMEOUT_MS);
}

async function connect() {
	if (socket !== null || connecting || listeners.size === 0 || getToken() === null) return;
	connecting = true;
	let ticket: string;
	try {
		ticket = (await Api.realtimeTicket()).ticket;
	} catch {
		connecting = false;
		scheduleRetry();
		return;
	}
	if (listeners.size === 0) {
		connecting = false;
		return;
	}

	const scheme = window.location.protocol === "https:" ? "wss" : "ws";
	const current = new WebSocket(`${scheme}://${window.location.host}/api/v1/realtime?ticket=${ticket}`);
	socket = current;
	connecting = false;

	current.addEventListener("message", (message) => {
		let event: RealtimeEvent;
		try {
			event = JSON.parse(String(message.data)) as RealtimeEvent;
		} catch {
			return;
		}
		if (event.type === "pong") {
			if (pongTimer !== null) clearTimeout(pongTimer);
			pongTimer = null;
			return;
		}
		if (event.type === "ready") {
			attempts = 0;
			pingTimer = setInterval(() => ping(current), PING_INTERVAL_MS);
			emit({ type: "realtime.ready", reconnected: everReady });
			everReady = true;
			return;
		}
		emit(event);
	});
	current.addEventListener("close", (event) => {
		if (socket !== current) return;
		socket = null;
		clearTimers();
		if (event.code === CLOSE_UNAUTHORIZED && getToken() === null) return;
		scheduleRetry();
	});
}

export function sendRealtime(event: RealtimeEvent): boolean {
	if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
	socket.send(JSON.stringify(event));
	return true;
}

export function onRealtime(listener: Listener): () => void {
	listeners.add(listener);
	watchNetwork();
	void connect();
	return () => {
		listeners.delete(listener);
	};
}

export function stopRealtime() {
	everReady = false;
	attempts = 0;
	if (retryTimer !== null) clearTimeout(retryTimer);
	retryTimer = null;
	clearTimers();
	const current = socket;
	socket = null;
	current?.close();
}
