import Auth from "./auth";
import Cache from "./cache";
import Utils from "./utils";
import { Logger } from "./logger";

export const REALTIME_PATH = "/api/v1/realtime";
export const REALTIME_TICKET_SECONDS = 30;
export const REALTIME_CLOSE_UNAUTHORIZED = 4401;
export const REALTIME_CLOSE_RESTART = 4503;

const TICKET_LENGTH = 64;
const TICKET_FORMAT = /^[A-Za-z0-9]{64}$/;
const SESSION_CHECK_MS = 60 * 1000;
const MAX_CONNECTIONS_PER_ACCOUNT = 20;

export interface RealtimeSocket {
	send(data: string): unknown;
	close(code?: number, reason?: string): void;
}

export interface RealtimeEvent {
	type: string;
	[field: string]: unknown;
}

export interface RealtimeConnection {
	username: string;
	sessionToken: string;
	socket: RealtimeSocket;
	sessionChecked: number;
}

export type RealtimeHandler = (connection: RealtimeConnection, event: RealtimeEvent) => void | Promise<void>;

export namespace Realtime {
	const connections = new Map<string, Set<RealtimeConnection>>();
	const bySocket = new Map<RealtimeSocket, RealtimeConnection>();
	const handlers = new Map<string, RealtimeHandler>();
	const offlineListeners = new Set<(username: string) => void>();
	const onlineListeners = new Set<(username: string) => void>();

	export function onOnline(listener: (username: string) => void) {
		onlineListeners.add(listener);
	}

	export function onOffline(listener: (username: string) => void) {
		offlineListeners.add(listener);
	}

	async function ticketKey(ticket: string): Promise<string> {
		return `realtime-ticket:${await Utils.generateHash(ticket, "sha256")}`;
	}

	export async function issueTicket(username: string, sessionToken: string): Promise<string | null> {
		const ticket = Utils.generateRandomText(TICKET_LENGTH);
		const stored = await Cache.setString(await ticketKey(ticket), JSON.stringify({ username, sessionToken }), REALTIME_TICKET_SECONDS, REALTIME_TICKET_SECONDS);
		return stored ? ticket : null;
	}

	export async function redeemTicket(ticket: unknown): Promise<{ username: string; sessionToken: string } | null> {
		if (typeof ticket !== "string" || !TICKET_FORMAT.test(ticket)) return null;
		const key = await ticketKey(ticket);
		const stored = await Cache.getString(key);
		if (stored === null) return null;
		await Cache.deleteString(key);
		try {
			const holder = JSON.parse(stored) as { username: string; sessionToken: string };
			return (await Auth.isSessionAlive(holder.sessionToken)) ? holder : null;
		} catch {
			return null;
		}
	}

	export function attach(socket: RealtimeSocket, username: string, sessionToken: string): RealtimeConnection {
		const connection: RealtimeConnection = { username, sessionToken, socket, sessionChecked: Date.now() };
		const open = connections.get(username) ?? new Set<RealtimeConnection>();
		if (open.size >= MAX_CONNECTIONS_PER_ACCOUNT) {
			const oldest = open.values().next().value!;
			detach(oldest.socket);
			oldest.socket.close(REALTIME_CLOSE_RESTART, "Too many connections");
		}
		open.add(connection);
		connections.set(username, open);
		bySocket.set(socket, connection);
		if (open.size === 1) for (const listener of onlineListeners) listener(username);
		return connection;
	}

	export function detach(socket: RealtimeSocket) {
		const connection = bySocket.get(socket);
		if (!connection) return;
		bySocket.delete(socket);
		const open = connections.get(connection.username);
		if (!open) return;
		open.delete(connection);
		if (open.size > 0) return;
		connections.delete(connection.username);
		for (const listener of offlineListeners) listener(connection.username);
	}

	export function connectionOf(socket: RealtimeSocket): RealtimeConnection | null {
		return bySocket.get(socket) ?? null;
	}

	export function isOnline(username: string): boolean {
		return connections.has(username);
	}

	export function connectionCount(): number {
		return bySocket.size;
	}

	export function send(usernames: Iterable<string>, event: RealtimeEvent) {
		const payload = JSON.stringify(event);
		for (const username of new Set(usernames)) {
			for (const connection of connections.get(username) ?? []) {
				try {
					connection.socket.send(payload);
				} catch (error) {
					Logger.warn(`[REALTIME] Could not deliver ${event.type}: ${error}`);
				}
			}
		}
	}

	export function on(type: string, handler: RealtimeHandler) {
		handlers.set(type, handler);
	}

	async function sessionStillValid(connection: RealtimeConnection): Promise<boolean> {
		const now = Date.now();
		if (now - connection.sessionChecked < SESSION_CHECK_MS) return true;
		connection.sessionChecked = now;
		return await Auth.isSessionAlive(connection.sessionToken);
	}

	export async function receive(socket: RealtimeSocket, raw: unknown) {
		const connection = bySocket.get(socket);
		if (!connection || typeof raw !== "string") return;

		let event: RealtimeEvent;
		try {
			event = JSON.parse(raw) as RealtimeEvent;
		} catch {
			return;
		}
		if (event === null || typeof event !== "object" || typeof event.type !== "string") return;

		if (!(await sessionStillValid(connection))) {
			detach(socket);
			socket.close(REALTIME_CLOSE_UNAUTHORIZED, "Session expired");
			return;
		}
		if (event.type === "ping") {
			socket.send(JSON.stringify({ type: "pong" }));
			return;
		}
		try {
			await handlers.get(event.type)?.(connection, event);
		} catch (error) {
			Logger.error(`[REALTIME] Handling ${event.type} failed: ${error}`);
		}
	}

	export function closeAccount(username: string, sessionToken?: string) {
		for (const connection of [...(connections.get(username) ?? [])]) {
			if (sessionToken !== undefined && connection.sessionToken !== sessionToken) continue;
			detach(connection.socket);
			connection.socket.close(REALTIME_CLOSE_UNAUTHORIZED, "Signed out");
		}
	}

	export function closeAll() {
		for (const connection of [...bySocket.values()]) {
			detach(connection.socket);
			connection.socket.close(REALTIME_CLOSE_RESTART, "Server is restarting");
		}
	}
}
