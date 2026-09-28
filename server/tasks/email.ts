import { Logger } from "../logger";
import { deliverPendingEmails } from "../email/outbox";

namespace TaskEmail {
	export async function run() {
		try {
			const result = await deliverPendingEmails();
			if (result.attempted > 0) Logger.debug(`[EMAIL] Attempted ${result.attempted} emails, ${result.sent} sent`);
		} catch (err) {
			Logger.error(`[EMAIL] Delivery cycle failed: ${err}`);
		}
	}
}

export default TaskEmail;
