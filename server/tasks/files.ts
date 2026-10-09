import { Logger } from "../logger";
import { discardAbandonedUploads } from "../files";
import { discardUnsentChatFiles, finishStaleRecordings } from "../workforce/chat";
import { GroupCalls } from "../workforce/calls";

namespace TaskFiles {
	let running = false;

	export async function run() {
		if (running) return;

		running = true;
		try {
			const discarded = await discardAbandonedUploads();
			if (discarded > 0) Logger.info(`[FILES] Discarded ${discarded} unfinished uploads`);
			const salvaged = await finishStaleRecordings((conversation) => GroupCalls.infoOf(conversation) !== null);
			if (salvaged > 0) Logger.info(`[FILES] Finished ${salvaged} recordings that were left open`);
			const unsent = await discardUnsentChatFiles();
			if (unsent > 0) Logger.info(`[FILES] Discarded ${unsent} chat attachments that were never sent`);
		} catch (err) {
			Logger.error(`[FILES] Upload cleanup failed: ${err}`);
		} finally {
			running = false;
		}
	}
}

export default TaskFiles;
