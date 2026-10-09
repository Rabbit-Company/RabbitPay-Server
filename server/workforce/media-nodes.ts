import { createHmac } from "node:crypto";
import { Settings } from "../settings";
import { Logger } from "../logger";

const LOAD_CACHE_MS = 15 * 1000;
const NODE_TIMEOUT_MS = 4000;
const SERVICE_TOKEN_SECONDS = 60;
const JOIN_TOKEN_SECONDS = 6 * 60 * 60;

interface VideoGrant {
	room?: string;
	roomJoin?: boolean;
	roomList?: boolean;
	roomCreate?: boolean;
	roomAdmin?: boolean;
	canPublish?: boolean;
	canSubscribe?: boolean;
	canPublishData?: boolean;
}

const loads = new Map<string, { people: number | null; checked: number }>();

export function mediaNodes(): string[] {
	if (Settings.calls.livekit_api_key === "" || Settings.calls.livekit_api_secret === "") return [];
	return Settings.calls.livekit_urls
		.split(",")
		.map((url) => url.trim().replace(/\/+$/, ""))
		.filter((url) => /^wss?:\/\/[^\s/]+/.test(url));
}

function encode(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function nodeToken(grant: VideoGrant, seconds: number, identity?: string, name?: string, now = Date.now()): string {
	const issued = Math.floor(now / 1000);
	const payload = { iss: Settings.calls.livekit_api_key, sub: identity, name, nbf: issued - 10, exp: issued + seconds, video: grant };
	const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}`;
	return `${unsigned}.${createHmac("sha256", Settings.calls.livekit_api_secret).update(unsigned).digest("base64url")}`;
}

export function joinToken(room: string, identity: string, name: string): string {
	return nodeToken({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true }, JOIN_TOKEN_SECONDS, identity, name);
}

async function service<Answer>(node: string, method: string, grant: VideoGrant, body: object): Promise<Answer | null> {
	try {
		const response = await fetch(`${node.replace(/^ws/, "http")}/twirp/livekit.RoomService/${method}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${nodeToken(grant, SERVICE_TOKEN_SECONDS)}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(NODE_TIMEOUT_MS),
		});
		if (!response.ok) {
			Logger.warn(`[CALLS] Media server ${node} answered ${response.status} to ${method}`);
			return null;
		}
		return (await response.json()) as Answer;
	} catch (error) {
		Logger.warn(`[CALLS] Media server ${node} is unreachable: ${error}`);
		return null;
	}
}

export async function nodeLoad(node: string, now = Date.now()): Promise<number | null> {
	const cached = loads.get(node);
	if (cached && now - cached.checked < LOAD_CACHE_MS) return cached.people;
	const answer = await service<{ rooms?: { num_participants?: number }[] }>(node, "ListRooms", { roomList: true }, {});
	const people = answer === null ? null : (answer.rooms ?? []).reduce((sum, room) => sum + Number(room.num_participants ?? 0), 0);
	loads.set(node, { people, checked: now });
	return people;
}

export async function pickNode(): Promise<string | null> {
	const measured = await Promise.all(mediaNodes().map(async (node) => ({ node, people: await nodeLoad(node) })));
	const reachable = measured.filter((entry): entry is { node: string; people: number } => entry.people !== null);
	if (reachable.length === 0) return null;
	return reachable.reduce((best, entry) => (entry.people < best.people ? entry : best)).node;
}

export function countJoin(node: string) {
	const cached = loads.get(node);
	if (cached && cached.people !== null) cached.people++;
}

export async function roomPeople(node: string, room: string): Promise<string[] | null> {
	const answer = await service<{ participants?: { identity?: string }[] }>(node, "ListParticipants", { room, roomAdmin: true }, { room });
	return answer === null ? null : (answer.participants ?? []).map((participant) => String(participant.identity ?? ""));
}

export async function closeRoom(node: string, room: string): Promise<void> {
	await service(node, "DeleteRoom", { roomCreate: true }, { room });
}

export function forgetNodeLoads() {
	loads.clear();
}
