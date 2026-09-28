import { Logger } from "../logger";
import { bitcoinChain } from "../crypto/chains";
import { isEnabled, watchAddresses } from "../payments/bitcoin";

namespace TaskBitcoin {
	let running = false;

	export async function run() {
		if (!isEnabled() || running) return;

		running = true;
		try {
			const result = await watchAddresses(bitcoinChain());
			if (result.checked > 0) Logger.debug(`[BTC] Checked ${result.checked} addresses, credited ${result.credited} payments`);
		} catch (err) {
			Logger.error(`[BTC] Watch cycle failed: ${err}`);
		} finally {
			running = false;
		}
	}
}

export default TaskBitcoin;
