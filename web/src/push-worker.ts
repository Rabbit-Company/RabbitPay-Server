import { fillNotice, isAppPath, readableParams } from "../../server/notifications/format";

interface PushPayload {
	id: string;
	title: string;
	body: string;
	params: Record<string, unknown>;
	language: string;
	path: string | null;
}

interface WindowClient {
	focused: boolean;
	focus(): Promise<unknown>;
	postMessage(message: unknown): void;
}

interface WaitingEvent {
	waitUntil(work: Promise<unknown>): void;
}

interface PushEvent extends WaitingEvent {
	data: { json(): unknown } | null;
}

interface ClickEvent extends WaitingEvent {
	notification: { close(): void; data: { path?: string | null } | null };
}

interface Worker {
	addEventListener(type: "install" | "activate", listener: (event: WaitingEvent) => void): void;
	addEventListener(type: "push", listener: (event: PushEvent) => void): void;
	addEventListener(type: "notificationclick", listener: (event: ClickEvent) => void): void;
	skipWaiting(): Promise<void>;
	clients: {
		claim(): Promise<void>;
		matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<WindowClient[]>;
		openWindow(url: string): Promise<unknown>;
	};
	registration: { showNotification(title: string, options: { body: string; tag: string; icon: string; data: { path: string | null } }): Promise<void> };
}

const worker = self as unknown as Worker;
const ICON_PATH = "/logo.svg";
const OPEN_MESSAGE = "notification.open";

function openWindows(): Promise<WindowClient[]> {
	return worker.clients.matchAll({ type: "window", includeUncontrolled: true });
}

function read(event: PushEvent): PushPayload | null {
	try {
		const payload = event.data?.json() as Partial<PushPayload> | undefined;
		if (!payload || typeof payload.title !== "string" || typeof payload.body !== "string" || typeof payload.id !== "string") return null;
		return {
			id: payload.id,
			title: payload.title,
			body: payload.body,
			params: payload.params ?? {},
			language: typeof payload.language === "string" ? payload.language : "en",
			path: isAppPath(payload.path) ? payload.path : null,
		};
	} catch {
		return null;
	}
}

async function show(event: PushEvent) {
	const payload = read(event);
	if (payload === null) return;
	if ((await openWindows()).some((client) => client.focused)) return;
	const params = readableParams(payload.params, payload.language);
	await worker.registration.showNotification(fillNotice(payload.title, params), {
		body: fillNotice(payload.body, params),
		tag: payload.id,
		icon: ICON_PATH,
		data: { path: payload.path },
	});
}

async function open(path: string | null) {
	const [existing] = await openWindows();
	if (!existing) {
		await worker.clients.openWindow(path ?? "/");
		return;
	}
	await existing.focus();
	if (path !== null) existing.postMessage({ type: OPEN_MESSAGE, path });
}

worker.addEventListener("install", (event) => event.waitUntil(worker.skipWaiting()));
worker.addEventListener("activate", (event) => event.waitUntil(worker.clients.claim()));
worker.addEventListener("push", (event) => event.waitUntil(show(event)));
worker.addEventListener("notificationclick", (event) => {
	event.notification.close();
	event.waitUntil(open(event.notification.data?.path ?? null));
});
