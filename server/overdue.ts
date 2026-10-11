import Database from "./database/database";
import { applyBalance } from "./payments/ledger";
import { flushOverdueNotices } from "./notifications/sales";

export const OVERDUE_BATCH = 500;

export async function markOverdueInvoices(now = Date.now()): Promise<number> {
	const due = (await Database`
		SELECT uuid FROM invoices WHERE status = 'open' AND due_date < ${now}
		ORDER BY due_date ASC LIMIT ${OVERDUE_BATCH}
	`) as { uuid: string }[];

	let marked = 0;
	for (const { uuid } of due) {
		const balance = await Database.begin(async (tx) => await applyBalance(tx, uuid));
		if (balance.status === "overdue") marked++;
	}

	await flushOverdueNotices();
	return marked;
}
