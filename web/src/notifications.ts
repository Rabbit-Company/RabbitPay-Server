import { Api, getToken, type NotificationPreference } from "./api";
import { hasKey, language, t } from "./i18n";
import { onRealtime, type RealtimeEvent } from "./realtime";
import { navigate } from "./router";
import { noticeToast } from "./ui";
import { followOwnStatus, ownStatus } from "./chat-status";
import { channelDefault, isNotificationKind, type NotificationKind } from "../../server/notifications/kinds";
import { isAppPath, noticeKey, readableParams } from "../../server/notifications/format";
import { subscribePush, unsubscribePush } from "./push";

const DEVICE_KEY = "rabbitpay.desktop_notifications";
const ICON_PATH = "/logo.svg";

export type DesktopState = "unsupported" | "blocked" | "off" | "on";

export interface Notice {
	kind: NotificationKind;
	title: string;
	body: string;
	path: string | null;
	tag: string;
}

type Watcher = (preferences: NotificationPreference[]) => void;

const chosen = new Map<NotificationKind, boolean>();
const watchers = new Set<Watcher>();
let watching = false;
let loaded = false;
let pushedFor: string | null = null;

function supported(): boolean {
	return typeof Notification !== "undefined";
}

function deviceChoice(): boolean {
	try {
		return localStorage.getItem(DEVICE_KEY) !== "off";
	} catch {
		return true;
	}
}

function rememberDevice(enabled: boolean) {
	try {
		localStorage.setItem(DEVICE_KEY, enabled ? "on" : "off");
	} catch {
		void 0;
	}
}

export function desktopState(): DesktopState {
	if (!supported()) return "unsupported";
	if (Notification.permission === "denied") return "blocked";
	return Notification.permission === "granted" && deviceChoice() ? "on" : "off";
}

export async function setDesktop(enabled: boolean): Promise<DesktopState> {
	if (!supported()) return "unsupported";
	if (enabled && Notification.permission === "default") await Notification.requestPermission();
	rememberDevice(enabled);
	if (desktopState() === "on") await subscribePush();
	else await unsubscribePush();
	return desktopState();
}

export function rememberPreferences(preferences: NotificationPreference[]) {
	chosen.clear();
	for (const preference of preferences) chosen.set(preference.kind, preference.browser.enabled);
	loaded = true;
	for (const watcher of [...watchers]) watcher(preferences);
}

export function watchPreferences(watcher: Watcher): () => void {
	watchers.add(watcher);
	return () => {
		watchers.delete(watcher);
	};
}

async function load() {
	if (getToken() === null) return;
	try {
		rememberPreferences((await Api.notificationPreferences()).preferences);
	} catch {
		void 0;
	}
}

export function wantsInBrowser(kind: NotificationKind): boolean {
	return chosen.get(kind) ?? channelDefault(kind, "browser");
}

function away(): boolean {
	return document.visibilityState !== "visible" || !document.hasFocus();
}

function open(path: string | null) {
	window.focus();
	if (path !== null) navigate(path);
}

function showOnDesktop(notice: Notice) {
	if (desktopState() !== "on") return;
	try {
		const shown = new Notification(notice.title, { body: notice.body, tag: notice.tag, icon: ICON_PATH });
		shown.addEventListener("click", () => {
			shown.close();
			open(notice.path);
		});
	} catch {
		void 0;
	}
}

export function notify(notice: Notice, options: { always?: boolean; desktopOnly?: boolean } = {}) {
	if (!options.always && (ownStatus() === "dnd" || !wantsInBrowser(notice.kind))) return;
	if (!options.desktopOnly) noticeToast(notice.title, notice.body, notice.path === null ? null : () => open(notice.path));
	if (away() || options.always) showOnDesktop(notice);
}

export function noticeOf(event: RealtimeEvent): Notice | null {
	if (!isNotificationKind(event.kind)) return null;
	const base = noticeKey(event.kind, event.variant);
	const title = `${base}.title`;
	const body = `${base}.body`;
	if (!hasKey(title) || !hasKey(body)) return null;
	const params = readableParams((event.params ?? {}) as Record<string, unknown>, language());
	return {
		kind: event.kind,
		title: t(title, params),
		body: t(body, params),
		path: isAppPath(event.path) ? event.path : null,
		tag: typeof event.id === "string" ? event.id : `${event.kind}:${Date.now()}`,
	};
}

function onEvent(event: RealtimeEvent) {
	if (event.type === "notifications.changed" || (event.type === "realtime.ready" && (event.reconnected || !loaded))) {
		void load();
		return;
	}
	if (event.type !== "notification") return;
	const notice = noticeOf(event);
	if (notice) notify(notice);
}

function keepPushCurrent() {
	const token = getToken();
	if (token === pushedFor || desktopState() !== "on") return;
	pushedFor = token;
	void subscribePush();
}

export function watchNotifications() {
	keepPushCurrent();
	if (watching) return;
	watching = true;
	onRealtime(onEvent);
	followOwnStatus();
	void load();
}

export function forgetNotifications() {
	chosen.clear();
	loaded = false;
	pushedFor = null;
}

export async function releaseDevice() {
	await unsubscribePush();
}

export function sendTestNotice() {
	notify(
		{ kind: "chat_message", title: t("notifications.test_title"), body: t("notifications.test_body"), path: null, tag: "rabbitpay-test" },
		{ always: true }
	);
}
