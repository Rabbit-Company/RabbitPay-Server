import { loadInvoice } from "./invoice-service";
import { creditNoteItems } from "./credit-notes";
import { partiesFor } from "./document-parts";
import { creditNoteSnapshotFor } from "./credit-note-snapshot";
import { fiscalMarks } from "./fiscal/documents";
import { withDesignDefaults } from "./invoice-design";
import type { CreditNoteRow, ProjectRow } from "./database/models";

export async function creditNoteDocument(project: ProjectRow, note: CreditNoteRow) {
	const invoice = (await loadInvoice(project.uuid, note.invoice))!;
	const items = await creditNoteItems(note.uuid);
	const snapshot = await creditNoteSnapshotFor(note.uuid);
	if (!snapshot) throw new Error("Credit note issue snapshot is missing");
	const { seller, buyer } = await partiesFor(project, invoice, snapshot.seller);
	const design = withDesignDefaults(snapshot.settings.design);

	return {
		seller,
		buyer,
		credit_note: {
			uuid: note.uuid,
			reference: note.reference,
			reason: note.reason,
			currency: note.currency,
			subtotal: note.subtotal,
			tax_amount: note.tax_amount,
			total_amount: note.total_amount,
			issued: note.issued_at,
		},
		corrects: { uuid: invoice.uuid, reference: invoice.reference, issued: invoice.issued_at ?? invoice.created },
		items: items.map((item) => ({
			description: item.description,
			tax_rate: item.tax_rate,
			tax_treatment: item.tax_treatment,
			net_amount: item.net_amount,
			tax_amount: item.tax_amount,
		})),
		tax: snapshot.settings.tax,
		fiscal: await fiscalMarks({ creditNote: note.uuid }),
		formats: { timezone: project.timezone, ...snapshot.settings.formats },
		language: snapshot.settings.language,
		design,
		closing_note: design.notes.credit_note,
		branding: {
			white_label: snapshot.settings.branding.white_label,
			logo: snapshot.settings.branding.logo_storage_key ? `/api/v1/public/projects/${project.uuid}/logo?credit_note=${encodeURIComponent(note.uuid)}` : null,
		},
	};
}
