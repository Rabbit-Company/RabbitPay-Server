import { Logger } from "../logger";
import { backupIfDue, recordFailure } from "../backups";

namespace TaskBackups {
	let running = false;

	export async function run() {
		if (running) return;

		running = true;
		try {
			await backupIfDue();
		} catch (err) {
			recordFailure();
			Logger.error(`[BACKUP] Backup failed: ${err}`);
		} finally {
			running = false;
		}
	}

	export function isRunning(): boolean {
		return running;
	}
}

export default TaskBackups;
