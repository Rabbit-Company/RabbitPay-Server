import { archivePendingInvoices } from "../invoice-archive";
import { archivePendingCreditNotes } from "../credit-note-archive";
import { archivePendingVerifiedCopies } from "../fiscal/archive";
import { Logger } from "../logger";

namespace TaskDocuments {
	let running = false;

	export async function run() {
		if (running) return;
		running = true;
		try {
			const invoices = await archivePendingInvoices();
			const creditNotes = await archivePendingCreditNotes();
			const verified = await archivePendingVerifiedCopies();
			if (invoices.archived > 0) Logger.info(`[DOCUMENTS] Archived ${invoices.archived} invoices`);
			if (creditNotes.archived > 0) Logger.info(`[DOCUMENTS] Archived ${creditNotes.archived} credit notes`);
			if (verified.archived > 0) Logger.info(`[DOCUMENTS] Archived ${verified.archived} copies verified by FURS`);
		} catch (err) {
			Logger.error(`[DOCUMENTS] Archive run failed: ${err}`);
		} finally {
			running = false;
		}
	}
}

export default TaskDocuments;
