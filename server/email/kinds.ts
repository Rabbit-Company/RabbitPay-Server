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
};

export const EMAIL_KINDS = Object.keys(KINDS) as EmailKind[];
export const EMAIL_STATUSES: EmailStatus[] = ["pending", "sent", "failed"];

const TEAM_EMAIL_KINDS: EmailKind[] = ["invitation", "fiscal_alert", "ticket_customer", "ticket_assigned", "absence_requested", "absence_decided"];

export function countsTowardAllowance(kind: EmailKind): boolean {
	return !TEAM_EMAIL_KINDS.includes(kind);
}
