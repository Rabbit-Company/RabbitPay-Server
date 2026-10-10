import { Logger } from "../logger";
import { dueReminders, REMINDER_LEAD_MINUTES, sendReminders } from "../workforce/team-calendar";

namespace TaskCalendar {
	const LEAD_MS = REMINDER_LEAD_MINUTES * 60 * 1000;
	let running = false;
	let remindedUntil: number | null = null;

	export async function run(now = Date.now()) {
		if (running) return;

		running = true;
		try {
			const until = now + LEAD_MS;
			const after = remindedUntil ?? until;
			remindedUntil = until;
			sendReminders(await dueReminders(after, until));
		} catch (err) {
			Logger.error(`[CALENDAR] Reminder check failed: ${err}`);
		} finally {
			running = false;
		}
	}
}

export default TaskCalendar;
