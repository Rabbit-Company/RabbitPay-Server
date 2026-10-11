import { Api, getUsername, type ChatMessage } from "./api";
import { el } from "./dom";
import { t } from "./i18n";
import { onRealtime, type RealtimeEvent } from "./realtime";
import { currentPath } from "./router";
import { notify } from "./notifications";
import { markdownText } from "../../server/markdown";
import { watchCalls } from "./calls";
import { followOwnStatus } from "./chat-status";

const REFRESH_DELAY_MS = 250;
const PREVIEW_LENGTH = 120;
const MAX_SHOWN = 99;

const counts = new Map<string, number>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
let listening = false;

function paint(project: string) {
	const count = counts.get(project) ?? 0;
	for (const badge of document.querySelectorAll<HTMLElement>(`[data-chat-unread="${project}"]`)) {
		badge.hidden = count === 0;
		badge.textContent = count > MAX_SHOWN ? `${MAX_SHOWN}+` : String(count);
		badge.title = t("chat.unread_badge", { count });
	}
}

function refresh(project: string) {
	if (pending.has(project)) return;
	pending.set(
		project,
		setTimeout(async () => {
			pending.delete(project);
			try {
				counts.set(project, (await Api.chatUnread(project)).messages);
				paint(project);
			} catch {
				void 0;
			}
		}, REFRESH_DELAY_MS)
	);
}

function announce(project: string, conversation: string, message: ChatMessage) {
	if (message.author === getUsername() || message.deleted || message.body === null) return;
	if (message.call !== null && message.call.outcome !== "missed") return;
	const reading = currentPath().startsWith(`/projects/${project}/chat`) && document.visibilityState === "visible";
	if (reading && document.hasFocus()) return;
	const text = message.call ? t("calls.log_missed") : message.body ? markdownText(message.body, PREVIEW_LENGTH) || t("code.title") : t("chat.attachment");
	const preview = text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}...` : text;
	notify(
		{
			kind: message.call ? "call_missed" : "chat_message",
			title: message.author_name,
			body: preview,
			path: `/projects/${project}/chat/${conversation}`,
			tag: message.uuid,
		},
		{ desktopOnly: reading }
	);
}

function onEvent(event: RealtimeEvent) {
	if (event.type === "realtime.ready") {
		for (const project of counts.keys()) refresh(project);
		return;
	}
	if (!event.type.startsWith("chat.") || typeof event.project !== "string" || !counts.has(event.project)) return;
	if (event.type === "chat.message") announce(event.project, String(event.conversation), event.message as ChatMessage);
	refresh(event.project);
}

export function chatUnreadBadge(project: string): HTMLElement {
	if (!listening) {
		listening = true;
		onRealtime(onEvent);
		watchCalls();
		followOwnStatus();
	}
	const count = counts.get(project) ?? 0;
	if (!counts.has(project)) counts.set(project, 0);
	refresh(project);
	const badge = el("span", { class: "nav-badge", dataset: { chatUnread: project } }, String(count));
	badge.hidden = count === 0;
	return badge;
}

export function forgetChatUnread() {
	counts.clear();
}
