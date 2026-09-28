import { Logger } from "../logger";
import { sendDueReminders } from "../email/messages";

namespace TaskReminders {
	let running = false;

	export async function run() {
		if (running) return;

		running = true;
		try {
			const queued = await sendDueReminders();
			if (queued > 0) Logger.info(`[EMAIL] Queued ${queued} payment reminders`);
		} catch (err) {
			Logger.error(`[EMAIL] Reminder check failed: ${err}`);
		} finally {
			running = false;
		}
	}
}

export default TaskReminders;
