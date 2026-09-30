import Database from "../database/database";
import { Logger } from "../logger";
import { licensingEnforced } from "../licensing";
import { syncLedger } from "../accounting/journal";
import { fillPaymentValues } from "../accounting/payment-values";
import type { ProjectRow } from "../database/models";

namespace TaskLedger {
	let running = false;

	export async function run() {
		if (running) return;

		running = true;
		try {
			await fillPaymentValues().catch((err) => Logger.error(`[LEDGER] Valuing payments failed: ${err}`));
			const projects = licensingEnforced()
				? ((await Database`
						SELECT * FROM projects p WHERE p.status <> 'deleted'
							AND (p.accounting_until IS NOT NULL OR EXISTS (SELECT 1 FROM ledger_accounts la WHERE la.project = p.uuid))
					`) as ProjectRow[])
				: ((await Database`SELECT * FROM projects WHERE status <> 'deleted'`) as ProjectRow[]);
			let posted = 0;
			for (const project of projects) {
				try {
					const result = await syncLedger(project);
					posted += result.posted + result.reversed;
				} catch (err) {
					Logger.error(`[LEDGER] Posting for project ${project.uuid} failed: ${err}`);
				}
			}
			if (posted > 0) Logger.info(`[LEDGER] Posted ${posted} journal entries`);
		} finally {
			running = false;
		}
	}
}

export default TaskLedger;
