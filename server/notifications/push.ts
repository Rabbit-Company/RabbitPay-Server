import Database from "../database/database";
import Utils from "../utils";
import Vault from "../crypto/vault";
import { Logger } from "../logger";
import { isUiLanguage, translate, DEFAULT_UI_LANGUAGE, hasKey, type UiLanguage } from "../../web/src/i18n/dictionary";
import { encryptPush, generateVapidKeys, isPushTarget, vapidHeader, type PushTarget, type VapidKeys } from "./push-crypto";
import { noticeKey } from "./format";
import type { NotificationKind } from "./kinds";

export const PUSH_SERVICE_HOSTS = ["fcm.googleapis.com", "android.googleapis.com", ".push.services.mozilla.com", ".notify.windows.com", ".push.apple.com"];
const GOOGLE_HOSTS = ".google.com";
const GOOGLE_PUSH_PATH = "/fcm/send/";
export const MAX_SUBSCRIPTIONS_PER_ACCOUNT = 20;
export const PUSH_DEVICE_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_USER_AGENT_LENGTH = 300;
const MAX_ENDPOINT_LENGTH = 2000;
const MAX_TEXT_LENGTH = 300;
const SEND_TIMEOUT_MS = 10 * 1000;
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const GONE = [404, 410];

interface SubscriptionRow extends PushTarget {
	uuid: string;
	account: string;
	language: string;
}

export interface PushNotice {
	id: string;
	kind: NotificationKind;
	variant?: string | null;
	project: string;
	project_name: string;
	params: Record<string, string | number>;
	path: string;
	ttl?: number;
}

type Transport = (url: string, init: RequestInit) => Promise<Response>;

let transport: Transport = (url, init) => fetch(url, init);
let keys: VapidKeys | null = null;

export function setPushTransport(replacement: Transport | null) {
	transport = replacement ?? ((url, init) => fetch(url, init));
}

export function forgetPushKeys() {
	keys = null;
}

async function storedKeys(): Promise<VapidKeys | null> {
	const [row] = (await Database`SELECT public_key, private_key FROM push_keys WHERE slot = 1`) as { public_key: string; private_key: string }[];
	return row ? { publicKey: row.public_key, privateKey: Vault.decrypt(row.private_key) } : null;
}

export async function pushKeys(): Promise<VapidKeys> {
	if (keys) return keys;
	const existing = await storedKeys();
	if (existing) return (keys = existing);

	const created = await generateVapidKeys();
	try {
		await Database`INSERT INTO push_keys(slot, public_key, private_key, created) VALUES(1, ${created.publicKey}, ${Vault.encrypt(created.privateKey)}, ${Date.now()})`;
	} catch {
		void 0;
	}
	const stored = await storedKeys();
	if (!stored) throw new Error("Could not create the push notification keys");
	return (keys = stored);
}

export function isPushEndpoint(value: unknown): value is string {
	if (typeof value !== "string" || value.length > MAX_ENDPOINT_LENGTH) return false;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return false;
		if (url.hostname.endsWith(GOOGLE_HOSTS)) return url.pathname.startsWith(GOOGLE_PUSH_PATH);
		return PUSH_SERVICE_HOSTS.some((host) => (host.startsWith(".") ? url.hostname.endsWith(host) : url.hostname === host));
	} catch {
		return false;
	}
}

function hostOf(endpoint: unknown): string {
	try {
		return new URL(String(endpoint)).host || "an empty address";
	} catch {
		return "an unreadable address";
	}
}

async function endpointHash(endpoint: string): Promise<string> {
	return await Utils.generateHash(endpoint, "sha256");
}

export interface PushDevice {
	id: string;
	endpoint_hash: string;
	user_agent: string | null;
	language: string;
	created: number;
	seen: number;
}

function idleCutoff(now = Date.now()): number {
	return now - PUSH_DEVICE_IDLE_MS;
}

export async function savePushSubscription(
	account: string,
	input: { endpoint: unknown; p256dh: unknown; auth: unknown; language: unknown; userAgent?: string | null }
): Promise<boolean> {
	if (!isPushEndpoint(input.endpoint)) {
		Logger.warn(`[PUSH] Refused a push registration because ${hostOf(input.endpoint)} is not a known push service`);
		return false;
	}
	if (!isPushTarget(input.p256dh, input.auth)) {
		Logger.warn(`[PUSH] Refused a push registration from ${hostOf(input.endpoint)} because its keys are malformed`);
		return false;
	}
	const endpoint = input.endpoint;
	const language = isUiLanguage(input.language) ? input.language : DEFAULT_UI_LANGUAGE;
	const userAgent = input.userAgent?.trim().slice(0, MAX_USER_AGENT_LENGTH) || null;
	const hash = await endpointHash(endpoint);
	const now = Date.now();
	await Database.begin(async (tx) => {
		await tx`DELETE FROM push_subscriptions WHERE updated < ${idleCutoff(now)} OR (endpoint_hash = ${hash} AND account != ${account})`;
		const refreshed = await tx`
			UPDATE push_subscriptions SET endpoint = ${endpoint}, p256dh = ${input.p256dh as string}, auth = ${input.auth as string}, language = ${language},
				user_agent = ${userAgent}, updated = ${now}
			WHERE endpoint_hash = ${hash} AND account = ${account}
		`;
		if (refreshed.count === 0) {
			await tx`
				INSERT INTO push_subscriptions(uuid, account, endpoint_hash, endpoint, p256dh, auth, language, user_agent, created, updated)
				VALUES(${crypto.randomUUID()}, ${account}, ${hash}, ${endpoint}, ${input.p256dh as string}, ${input.auth as string}, ${language}, ${userAgent},
					${now}, ${now})
			`;
		}
		const kept = (await tx`
			SELECT uuid FROM push_subscriptions WHERE account = ${account} ORDER BY updated DESC, uuid ASC LIMIT ${MAX_SUBSCRIPTIONS_PER_ACCOUNT}
		`) as { uuid: string }[];
		await tx`DELETE FROM push_subscriptions WHERE account = ${account} AND uuid NOT IN ${tx(kept.map((row) => row.uuid))}`;
	});
	return true;
}

export async function removePushSubscription(account: string, endpoint: unknown): Promise<void> {
	if (typeof endpoint !== "string") return;
	await Database`DELETE FROM push_subscriptions WHERE account = ${account} AND endpoint_hash = ${await endpointHash(endpoint)}`;
}

export async function forgetPushEndpoint(endpoint: unknown): Promise<void> {
	if (!isPushEndpoint(endpoint)) return;
	await Database`DELETE FROM push_subscriptions WHERE endpoint_hash = ${await endpointHash(endpoint)}`;
}

export async function removePushDevice(account: string, device: unknown): Promise<void> {
	if (typeof device !== "string") return;
	await Database`DELETE FROM push_subscriptions WHERE account = ${account} AND uuid = ${device}`;
}

export async function pushDevices(account: string): Promise<PushDevice[]> {
	const rows = (await Database`
		SELECT uuid, endpoint_hash, user_agent, language, created, updated FROM push_subscriptions
		WHERE account = ${account} AND updated >= ${idleCutoff()} ORDER BY updated DESC, uuid ASC
	`) as { uuid: string; endpoint_hash: string; user_agent: string | null; language: string; created: number; updated: number }[];
	return rows.map((row) => ({
		id: row.uuid,
		endpoint_hash: row.endpoint_hash,
		user_agent: row.user_agent,
		language: row.language,
		created: Number(row.created),
		seen: Number(row.updated),
	}));
}

function shortened(params: Record<string, string | number>): Record<string, string | number> {
	const short: Record<string, string | number> = {};
	for (const [name, value] of Object.entries(params)) {
		short[name] = typeof value === "string" && value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH)}...` : value;
	}
	return short;
}

function payloadFor(notice: PushNotice, language: UiLanguage): string | null {
	const base = noticeKey(notice.kind, notice.variant);
	const title = `${base}.title`;
	const body = `${base}.body`;
	if (!hasKey(title) || !hasKey(body)) return null;
	return JSON.stringify({
		id: notice.id,
		kind: notice.kind,
		title: translate(language, title),
		body: translate(language, body),
		params: shortened(notice.params),
		language,
		path: notice.path,
		project_name: notice.project_name,
	});
}

async function deliver(subscription: SubscriptionRow, notice: PushNotice, vapid: VapidKeys): Promise<void> {
	const payload = payloadFor(notice, isUiLanguage(subscription.language) ? subscription.language : DEFAULT_UI_LANGUAGE);
	if (payload === null || !isPushEndpoint(subscription.endpoint)) return;
	const response = await transport(subscription.endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/octet-stream",
			"Content-Encoding": "aes128gcm",
			TTL: String(notice.ttl ?? DEFAULT_TTL_SECONDS),
			Urgency: "normal",
			Authorization: await vapidHeader(vapid, subscription.endpoint, Utils.publicUrl()),
		},
		body: await encryptPush(subscription, payload),
		redirect: "error",
		signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
	});
	if (GONE.includes(response.status)) await Database`DELETE FROM push_subscriptions WHERE uuid = ${subscription.uuid}`;
	else if (!response.ok) Logger.warn(`[PUSH] The push service answered ${response.status} for ${notice.kind}`);
}

export async function pushTo(usernames: string[], notice: PushNotice): Promise<number> {
	if (usernames.length === 0) return 0;
	try {
		const subscriptions = (await Database`
			SELECT s.uuid, s.account, s.endpoint, s.p256dh, s.auth, s.language FROM push_subscriptions s
			JOIN accounts a ON a.username = s.account
			WHERE s.account IN ${Database(usernames)} AND s.updated >= ${idleCutoff()} AND a.status = 'active'
				AND (a.chat_status IS NULL OR a.chat_status != 'dnd')
		`) as SubscriptionRow[];
		if (subscriptions.length === 0) return 0;
		const vapid = await pushKeys();
		const results = await Promise.allSettled(subscriptions.map((subscription) => deliver(subscription, notice, vapid)));
		for (const result of results) {
			if (result.status === "rejected") Logger.warn(`[PUSH] Could not push ${notice.kind}: ${result.reason}`);
		}
		return subscriptions.length;
	} catch (error) {
		Logger.error(`[PUSH] Could not push ${notice.kind}: ${error}`);
		return 0;
	}
}
