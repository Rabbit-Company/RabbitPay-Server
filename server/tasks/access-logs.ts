import { Logger } from "../logger";
import { maintainAccessLogs } from "../access-log-archive";

namespace TaskAccessLogs {
	let running = false;

	export async function run() {
		if (running) return;
		running = true;
		try {
			const result = await maintainAccessLogs();
			if (result.archived > 0) Logger.info(`[ACCESS LOGS] Archived ${result.archived} entries from ${result.windows} hours`);
			if (result.expiredEntries > 0) Logger.info(`[ACCESS LOGS] Deleted ${result.expiredEntries} entries past retention`);
			if (result.expiredArchives > 0) Logger.info(`[ACCESS LOGS] Deleted ${result.expiredArchives} archives past retention`);
		} catch (err) {
			Logger.error(`[ACCESS LOGS] Maintenance failed: ${err}`);
		} finally {
			running = false;
		}
	}
}

export default TaskAccessLogs;
