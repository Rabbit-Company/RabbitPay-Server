import { Logger } from "../logger";
import { runScheduledPackages } from "../accountant-package-sending";

namespace TaskAccountantPackages {
	let running = false;

	export async function run() {
		if (running) return;

		running = true;
		try {
			const sent = await runScheduledPackages();
			if (sent > 0) Logger.info(`[PACKAGE] Sent ${sent} accountant packages`);
		} catch (err) {
			Logger.error(`[PACKAGE] Scheduled accountant packages failed: ${err}`);
		} finally {
			running = false;
		}
	}
}

export default TaskAccountantPackages;
