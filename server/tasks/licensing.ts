import { Logger } from "../logger";
import { activateScheduledLicenses, meterAll } from "../licensing";

namespace TaskLicensing {
	let running = false;

	export async function run() {
		if (running) return;

		running = true;
		try {
			const billed = await meterAll();
			if (billed > 0) Logger.debug(`[LICENSING] Metered ${billed} completed payments`);
			const activated = await activateScheduledLicenses();
			if (activated > 0) Logger.info(`[LICENSING] Started ${activated} scheduled licenses`);
		} catch (err) {
			Logger.error(`[LICENSING] Metering failed: ${err}`);
		} finally {
			running = false;
		}
	}
}

export default TaskLicensing;
