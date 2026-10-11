import { Permission } from "../roles";

export const NOTIFICATION_CHANNELS = ["browser", "email"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_GROUPS = ["chat", "calendar", "tickets", "time", "sales", "compliance"] as const;
export type NotificationGroup = (typeof NOTIFICATION_GROUPS)[number];

export interface NotificationSpec {
	group: NotificationGroup;
	browser: boolean;
	email: boolean | null;
	locked?: NotificationChannel[];
	audience: Permission[] | "owner";
}

export const NOTIFICATION_KINDS = {
	chat_message: { group: "chat", browser: true, email: null, audience: [Permission.CHAT_USE] },
	call_incoming: { group: "chat", browser: true, email: null, audience: [Permission.CHAT_USE] },
	call_missed: { group: "chat", browser: true, email: null, audience: [Permission.CHAT_USE] },
	meeting_scheduled: { group: "calendar", browser: true, email: true, audience: [Permission.CHAT_USE] },
	meeting_reminder: { group: "calendar", browser: true, email: false, audience: [Permission.CHAT_USE] },
	event_reminder: { group: "calendar", browser: true, email: false, audience: [Permission.CHAT_USE] },
	ticket_assigned: { group: "tickets", browser: true, email: true, audience: [Permission.TICKET_WORK] },
	ticket_customer: { group: "tickets", browser: true, email: true, audience: [Permission.TICKET_WORK] },
	ticket_comment: { group: "tickets", browser: true, email: false, audience: [Permission.TICKET_WORK] },
	absence_requested: { group: "time", browser: true, email: true, audience: [Permission.TIMESHEET_EDIT] },
	absence_decided: { group: "time", browser: true, email: true, audience: [Permission.TIMESHEET_OWN] },
	timesheet_submitted: { group: "time", browser: true, email: false, audience: [Permission.TIMESHEET_EDIT] },
	timesheet_decided: { group: "time", browser: true, email: true, audience: [Permission.TIMESHEET_OWN] },
	store_order: { group: "sales", browser: true, email: true, audience: [Permission.INVOICE_VIEW] },
	invoice_paid: { group: "sales", browser: true, email: false, audience: [Permission.INVOICE_VIEW] },
	invoice_overdue: { group: "sales", browser: true, email: false, audience: [Permission.INVOICE_VIEW] },
	fiscal_alert: { group: "compliance", browser: true, email: true, locked: ["email"], audience: "owner" },
} as const satisfies Record<string, NotificationSpec>;

export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

export const NOTIFICATION_KIND_NAMES = Object.keys(NOTIFICATION_KINDS) as NotificationKind[];

export const WORKFORCE_GROUPS: NotificationGroup[] = ["chat", "calendar", "tickets", "time"];

export function notificationSpec(kind: NotificationKind): NotificationSpec {
	return NOTIFICATION_KINDS[kind];
}

export function isNotificationKind(value: unknown): value is NotificationKind {
	return typeof value === "string" && Object.hasOwn(NOTIFICATION_KINDS, value);
}

export function isNotificationChannel(value: unknown): value is NotificationChannel {
	return NOTIFICATION_CHANNELS.includes(value as NotificationChannel);
}

export function offersChannel(kind: NotificationKind, channel: NotificationChannel): boolean {
	return notificationSpec(kind)[channel] !== null;
}

export function channelLocked(kind: NotificationKind, channel: NotificationChannel): boolean {
	return notificationSpec(kind).locked?.includes(channel) ?? false;
}

export function channelDefault(kind: NotificationKind, channel: NotificationChannel): boolean {
	return notificationSpec(kind)[channel] === true;
}

export function channelEnabled(kind: NotificationKind, channel: NotificationChannel, chosen: boolean | null | undefined): boolean {
	if (!offersChannel(kind, channel)) return false;
	if (channelLocked(kind, channel)) return true;
	return chosen ?? channelDefault(kind, channel);
}
