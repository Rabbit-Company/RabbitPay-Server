import { Logger } from "../logger";
import { ecbRatesAge, isEnabled, refreshEcbRates } from "../rates/ecb";

const STALE_MS = 3 * 60 * 60 * 1000;

namespace TaskRates {
	let running = false;
	let lastRun = 0;

	export async function run() {
		if (running || !isEnabled()) return;

		running = true;
		try {
			const age = await ecbRatesAge();
			if (age !== null && Date.now() - lastRun < STALE_MS) return;
			const stored = await refreshEcbRates();
			lastRun = Date.now();
			if (stored > 0) Logger.info(`[RATES] Stored ${stored} ECB reference rates`);
		} catch (err) {
			Logger.error(`[RATES] Refreshing the ECB reference rates failed: ${err}`);
		} finally {
			running = false;
		}
	}
}

export default TaskRates;
