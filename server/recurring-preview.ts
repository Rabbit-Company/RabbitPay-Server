import type { InvoiceItemInput } from "./invoicing";
import { unsavedInvoiceDocument, unsavedInvoicePdf, type UnsavedInvoice } from "./unsaved-invoice";
import { fillPlaceholders, occurrenceDate, periodOf, previousPeriodOf, type Schedule } from "./recurring-schedule";
import { endOfLocalDate, localDate, shiftLocalDate } from "./timezone";
import type { DateFormat } from "./formats";
import type { ProjectRow } from "./database/models";

export interface RecurringPreviewInput {
	customer: string;
	currency: string;
	items: InvoiceItemInput[];
	discount_amount: number;
	notes: string | null;
	schedule: Schedule;
	occurrence: number;
	days_until_due: number;
	bill_previous_period: boolean;
	created_by: string | null;
}

function nextInvoiceOf(project: ProjectRow, input: RecurringPreviewInput): UnsavedInvoice {
	const timezone = project.timezone;
	const runDate = occurrenceDate(input.schedule, input.occurrence, timezone);
	const period = input.bill_previous_period
		? previousPeriodOf(input.schedule, input.occurrence, timezone)
		: periodOf(input.schedule, input.occurrence, timezone);
	const fill = (text: string) => fillPlaceholders(text, period, project.language, project.date_format as DateFormat, timezone);

	return {
		customer: input.customer,
		currency: input.currency,
		items: input.items.map((item) => ({ ...item, description: fill(item.description) })),
		discount_amount: input.discount_amount,
		notes: input.notes ? fill(input.notes) : null,
		issued: runDate,
		due_date: endOfLocalDate(shiftLocalDate(localDate(runDate, timezone), input.days_until_due), timezone),
		supply_date: input.bill_previous_period ? period.end : runDate,
		created_by: input.created_by,
	};
}

export async function recurringPreviewDocument(project: ProjectRow, input: RecurringPreviewInput) {
	return await unsavedInvoiceDocument(project, nextInvoiceOf(project, input));
}

export async function recurringPreviewPdf(project: ProjectRow, input: RecurringPreviewInput): Promise<{ name: string; data: Uint8Array }> {
	return await unsavedInvoicePdf(project, nextInvoiceOf(project, input));
}
