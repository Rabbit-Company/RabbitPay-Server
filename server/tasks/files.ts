import { Logger } from "../logger";
import { discardAbandonedUploads } from "../files";

namespace TaskFiles {
	let running = false;

	export async function run() {
		if (running) return;

		running = true;
		try {
			const discarded = await discardAbandonedUploads();
			if (discarded > 0) Logger.info(`[FILES] Discarded ${discarded} unfinished uploads`);
		} catch (err) {
			Logger.error(`[FILES] Upload cleanup failed: ${err}`);
		} finally {
			running = false;
		}
	}
}

export default TaskFiles;
