import { Logger } from "../logger";
import { deliverPending } from "../webhooks/delivery";

namespace TaskWebhooks {
	let running = false;

	export async function run() {
		if (running) return;

		running = true;
		try {
			const result = await deliverPending();
			if (result.attempted > 0) Logger.debug(`[WEBHOOK] Attempted ${result.attempted} deliveries, ${result.delivered} succeeded`);
		} catch (err) {
			Logger.error(`[WEBHOOK] Delivery cycle failed: ${err}`);
		} finally {
			running = false;
		}
	}
}

export default TaskWebhooks;
