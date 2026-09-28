import { Logger } from "../logger";
import { deliverPendingKeys } from "../key-delivery";

namespace TaskKeys {
	export async function run() {
		try {
			const result = await deliverPendingKeys();
			if (result.keys > 0) Logger.debug(`[KEYS] Handed over ${result.keys} keys across ${result.invoices} invoices`);
		} catch (err) {
			Logger.error(`[KEYS] Delivery cycle failed: ${err}`);
		}
	}
}

export default TaskKeys;
