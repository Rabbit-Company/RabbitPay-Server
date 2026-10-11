import { Api, getToken } from "./api";
import { language } from "./i18n";
import { navigate } from "./router";
import { isAppPath } from "../../server/notifications/format";

const WORKER_PATH = "/push-worker.js";
const OPEN_MESSAGE = "notification.open";

let listening = false;

export function pushSupported(): boolean {
	return typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof PushManager !== "undefined" && window.isSecureContext;
}

function keyBytes(key: string): Uint8Array<ArrayBuffer> {
	const padded = key.replace(/-/g, "+").replace(/_/g, "/");
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function sameKey(current: ArrayBuffer | null, wanted: Uint8Array): boolean {
	if (current === null) return false;
	const bytes = new Uint8Array(current);
	return bytes.length === wanted.length && bytes.every((byte, index) => byte === wanted[index]);
}

function listen() {
	if (listening) return;
	listening = true;
	navigator.serviceWorker.addEventListener("message", (event) => {
		const data = event.data as { type?: unknown; path?: unknown } | null;
		if (data?.type === OPEN_MESSAGE && isAppPath(data.path)) navigate(data.path);
	});
}

export async function subscribePush(): Promise<boolean> {
	if (!pushSupported() || getToken() === null) return false;
	try {
		listen();
		const registration = await navigator.serviceWorker.register(WORKER_PATH);
		await navigator.serviceWorker.ready;
		const key = keyBytes((await Api.pushKey()).public_key);
		let subscription = await registration.pushManager.getSubscription();
		if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
			await subscription.unsubscribe();
			subscription = null;
		}
		subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
		const { endpoint, keys } = subscription.toJSON();
		if (!endpoint || !keys?.p256dh || !keys.auth) return false;
		await Api.savePush({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, language: language() });
		return true;
	} catch {
		return false;
	}
}

export async function unsubscribePush(): Promise<void> {
	if (!pushSupported()) return;
	try {
		const registration = await navigator.serviceWorker.getRegistration(WORKER_PATH);
		const subscription = await registration?.pushManager.getSubscription();
		if (!subscription) return;
		await Api.forgetPush(subscription.endpoint).catch(() => undefined);
		await subscription.unsubscribe();
	} catch {
		void 0;
	}
}

export async function currentDeviceHash(): Promise<string | null> {
	if (!pushSupported()) return null;
	try {
		const registration = await navigator.serviceWorker.getRegistration(WORKER_PATH);
		const subscription = await registration?.pushManager.getSubscription();
		if (!subscription) return null;
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subscription.endpoint));
		return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	} catch {
		return null;
	}
}

const BROWSERS: [RegExp, string][] = [
	[/Edg(?:e|A|iOS)?\//, "Edge"],
	[/OPR\/|Opera/, "Opera"],
	[/Firefox\/|FxiOS\//, "Firefox"],
	[/Chrome\/|CriOS\//, "Chrome"],
	[/Safari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
	[/iPhone|iPad|iPod/, "iOS"],
	[/Android/, "Android"],
	[/Windows/, "Windows"],
	[/Mac OS X|Macintosh/, "macOS"],
	[/CrOS/, "ChromeOS"],
	[/Linux/, "Linux"],
];

export function deviceName(userAgent: string | null): { browser: string | null; system: string | null } {
	const agent = userAgent ?? "";
	return {
		browser: BROWSERS.find(([pattern]) => pattern.test(agent))?.[1] ?? null,
		system: SYSTEMS.find(([pattern]) => pattern.test(agent))?.[1] ?? null,
	};
}
