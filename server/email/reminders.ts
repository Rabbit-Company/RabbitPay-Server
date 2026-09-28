export const DAY = 24 * 60 * 60 * 1000;
export const MAX_DAYS_BEFORE = 30;
export const MAX_DAYS_AFTER = 60;
export const MAX_AFTER_REMINDERS = 3;

export type ReminderKind = "reminder_before" | "reminder_after";

export interface ReminderRules {
	daysBefore: number;
	daysAfter: number;
}

export interface ReminderInvoice {
	dueDate: number;
	issuedAt: number;
	outstanding: number;
}

export interface RemindersSent {
	before: number;
	after: number;
}

export function isReminderDays(value: unknown, max: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

export function reminderDue(invoice: ReminderInvoice, rules: ReminderRules, sent: RemindersSent, now: number): ReminderKind | null {
	if (invoice.outstanding <= 0) return null;

	if (now < invoice.dueDate) {
		if (rules.daysBefore <= 0 || sent.before > 0) return null;
		if (now < invoice.dueDate - rules.daysBefore * DAY) return null;
		if (invoice.issuedAt > now - DAY) return null;
		return "reminder_before";
	}

	if (rules.daysAfter <= 0 || sent.after >= MAX_AFTER_REMINDERS) return null;
	if (now < invoice.dueDate + rules.daysAfter * DAY * (sent.after + 1)) return null;
	return "reminder_after";
}
