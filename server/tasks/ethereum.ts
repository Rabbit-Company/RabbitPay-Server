import { Logger } from "../logger";
import { ethereumChain } from "../crypto/chains";
import { isEnabled, watchAddresses } from "../payments/ethereum";

namespace TaskEthereum {
	let running = false;

	export async function run() {
		if (!isEnabled() || running) return;

		running = true;
		try {
			const result = await watchAddresses(ethereumChain());
			if (result.checked > 0) Logger.debug(`[ETH] Checked ${result.checked} addresses, credited ${result.credited} transfers`);
		} catch (err) {
			Logger.error(`[ETH] Watch cycle failed: ${err}`);
		} finally {
			running = false;
		}
	}
}

export default TaskEthereum;
