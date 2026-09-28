import { Logger } from "../logger";
import { submitPendingDocuments } from "../fiscal/documents";
import { sendFiscalAlerts } from "../fiscal/alerts";

namespace TaskFiscal {
	export async function run() {
		try {
			const result = await submitPendingDocuments();
			if (result.attempted > 0) Logger.debug(`[FURS] Sent ${result.attempted} invoices, ${result.verified} verified`);
		} catch (err) {
			Logger.error(`[FURS] Sending cycle failed: ${err}`);
		}

		try {
			await sendFiscalAlerts();
		} catch (err) {
			Logger.error(`[FURS] Could not send alerts: ${err}`);
		}
	}
}

export default TaskFiscal;
