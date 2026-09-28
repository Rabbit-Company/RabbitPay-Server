import { Logger } from "../logger";
import { markOverdueInvoices } from "../overdue";

namespace TaskOverdue {
	let running = false;

	export async function run() {
		if (running) return;

		running = true;
		try {
			const marked = await markOverdueInvoices();
			if (marked > 0) Logger.info(`[INVOICES] Marked ${marked} invoices as overdue`);
		} catch (err) {
			Logger.error(`[INVOICES] Overdue check failed: ${err}`);
		} finally {
			running = false;
		}
	}
}

export default TaskOverdue;
