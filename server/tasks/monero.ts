import { Logger } from "../logger";
import { isEnabled, watchAddresses } from "../payments/monero";

namespace TaskMonero {
	let running = false;

	export async function run() {
		if (!isEnabled() || running) return;

		running = true;
		try {
			const result = await watchAddresses();
			if (result.checked > 0) Logger.debug(`[XMR] Checked ${result.checked} addresses, credited ${result.credited} transfers`);
		} catch (err) {
			Logger.error(`[XMR] Watch cycle failed: ${err}`);
		} finally {
			running = false;
		}
	}
}

export default TaskMonero;
