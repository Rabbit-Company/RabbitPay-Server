import type { EmailKind, EmailStatus } from "../database/models";

const KINDS: Record<EmailKind, true> = {
	invoice: true,
	proforma: true,
	reminder_before: true,
	reminder_after: true,
	credit_note: true,
	receipt: true,
	keys: true,
	order_placed: true,
	order_update: true,
	order_processing: true,
	order_shipped: true,
	order_delivered: true,
	ticket_reply: true,
	ticket_status: true,
	ticket_customer: true,
	ticket_assigned: true,
	absence_requested: true,
	absence_decided: true,
	invitation: true,
	fiscal_alert: true,
	ticket_comment: true,
	timesheet_submitted: true,
	timesheet_decided: true,
	meeting_scheduled: true,
	meeting_reminder: true,
	event_reminder: true,
	store_order: true,
	invoice_paid: true,
	invoice_overdue: true,
};

export const EMAIL_KINDS = Object.keys(KINDS) as EmailKind[];
export const EMAIL_STATUSES: EmailStatus[] = ["pending", "sent", "failed"];

const TEAM_EMAIL_KINDS: EmailKind[] = [
	"invitation",
	"fiscal_alert",
	"ticket_customer",
	"ticket_assigned",
	"absence_requested",
	"absence_decided",
	"ticket_comment",
	"timesheet_submitted",
	"timesheet_decided",
	"meeting_scheduled",
	"meeting_reminder",
	"event_reminder",
];

export function countsTowardAllowance(kind: EmailKind): boolean {
	return !TEAM_EMAIL_KINDS.includes(kind);
}
