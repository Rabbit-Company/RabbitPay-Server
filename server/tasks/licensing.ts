import { Logger } from "../logger";
import { meterAll } from "../licensing";

namespace TaskLicensing {
	let running = false;

	export async function run() {
		if (running) return;

		running = true;
		try {
			const billed = await meterAll();
			if (billed > 0) Logger.debug(`[LICENSING] Metered ${billed} completed payments`);
		} catch (err) {
			Logger.error(`[LICENSING] Metering failed: ${err}`);
		} finally {
			running = false;
		}
	}
}

export default TaskLicensing;
