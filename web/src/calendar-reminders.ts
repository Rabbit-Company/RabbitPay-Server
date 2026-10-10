import { t } from "./i18n";
import { formatTime } from "./money";
import { onRealtime, type RealtimeEvent } from "./realtime";
import { toast } from "./ui";
import { ownStatus } from "./chat-status";

let watching = false;

function onEvent(event: RealtimeEvent) {
	if (event.type !== "calendar.reminder" || ownStatus() === "dnd") return;
	if (typeof event.title !== "string" || typeof event.starts_at !== "number") return;
	const key = event.kind === "meeting" ? "calendar.reminder_meeting" : "calendar.reminder_event";
	toast(t(key, { title: event.title, time: formatTime(event.starts_at) }), "info");
}

export function watchCalendarReminders() {
	if (watching) return;
	watching = true;
	onRealtime(onEvent);
}
