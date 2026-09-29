import { Logger } from "../logger";
import { checkWaitingDomains } from "../store/domains";

namespace TaskDomains {
	let running = false;

	export async function run() {
		if (running) return;

		running = true;
		try {
			const activated = await checkWaitingDomains();
			if (activated > 0) Logger.info(`[DOMAINS] Activated ${activated} store domains`);
		} catch (err) {
			Logger.error(`[DOMAINS] Checking store domains failed: ${err}`);
		} finally {
			running = false;
		}
	}
}

export default TaskDomains;
