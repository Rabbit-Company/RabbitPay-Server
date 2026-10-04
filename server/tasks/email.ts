import { Logger } from "../logger";
import { deliverPendingEmails, removeExpiredBodies } from "../email/outbox";

namespace TaskEmail {
	export async function run() {
		try {
			const result = await deliverPendingEmails();
			if (result.attempted > 0) Logger.debug(`[EMAIL] Attempted ${result.attempted} emails, ${result.sent} sent`);
		} catch (err) {
			Logger.error(`[EMAIL] Delivery cycle failed: ${err}`);
		}
	}

	export async function removeOldContent() {
		try {
			const removed = await removeExpiredBodies();
			if (removed > 0) Logger.info(`[EMAIL] Removed the content of ${removed} emails past retention`);
		} catch (err) {
			Logger.error(`[EMAIL] Removing old email content failed: ${err}`);
		}
	}
}

export default TaskEmail;
