import Database from "./database/database";
import { creditRemaining } from "./credit-notes";
import { releaseKeys } from "./item-keys";
import { enqueueLater } from "./webhooks/events";
import { prepareIssuePresentation } from "./invoice-snapshot";
import { archiveIssuedCreditNote } from "./credit-note-archive";
import type { CreditNoteRow, InvoiceRow, ProjectRow } from "./database/models";

export async function cancelInvoice(project: ProjectRow, invoice: InvoiceRow, reason: string, canceledBy: string): Promise<CreditNoteRow | null> {
	const timestamp = Date.now();
	const presentation = invoice.issued_at === null ? null : await prepareIssuePresentation(project);

	const creditNote = await Database.begin(async (tx) => {
		await tx`UPDATE invoices SET status = 'canceled', canceled_date = ${timestamp}, updated = ${timestamp} WHERE uuid = ${invoice.uuid}`;
		await releaseKeys(tx, invoice.uuid);
		if (invoice.issued_at === null) return null;

		const [canceled] = (await tx`SELECT * FROM invoices WHERE uuid = ${invoice.uuid}`) as InvoiceRow[];
		return await creditRemaining(tx as typeof Database, canceled, { reason, createdBy: canceledBy, presentation: presentation! });
	});
	if (creditNote) await archiveIssuedCreditNote(project.uuid, creditNote.uuid);

	enqueueLater(invoice.project, "invoice.canceled", {
		invoice: invoice.uuid,
		reference: invoice.reference,
		currency: invoice.currency,
		total_amount: invoice.total_amount,
	});

	return creditNote;
}
