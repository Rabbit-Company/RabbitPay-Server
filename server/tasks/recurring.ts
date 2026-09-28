import { Logger } from "../logger";
import { runDueRecurring } from "../recurring-service";

import { runDueExpenses } from "../expense-service";

namespace TaskRecurring {
	let running = false;

	export async function run() {
		if (running) return;

		running = true;
		try {
			const expenses = await runDueExpenses();
			if (expenses > 0) Logger.info(`[EXPENSES] Created ${expenses} expenses`);
			const created = await runDueRecurring();
			if (created > 0) Logger.info(`[RECURRING] Created ${created} invoices`);
		} catch (err) {
			Logger.error(`[RECURRING] Run failed: ${err}`);
		} finally {
			running = false;
		}
	}
}

export default TaskRecurring;
