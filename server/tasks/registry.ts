import { Logger } from "../logger";
import { Settings } from "../settings";
import { refreshRegistry, registryAge } from "../registry/furs";

const STALE_MS = 20 * 60 * 60 * 1000;

namespace TaskRegistry {
	let running = false;

	export async function run() {
		if (running || Settings.registry?.enabled === false) return;

		running = true;
		try {
			const age = await registryAge();
			if (age !== null && age < STALE_MS) return;
			const count = await refreshRegistry();
			Logger.info(`[REGISTRY] Loaded ${count} Slovenian taxpayers from FURS`);
		} catch (err) {
			Logger.error(`[REGISTRY] Refreshing the FURS taxpayer lists failed: ${err}`);
		} finally {
			running = false;
		}
	}
}

export default TaskRegistry;
