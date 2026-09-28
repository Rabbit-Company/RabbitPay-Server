import Database from "./database/database";
import { Logger } from "./logger";
import { canEmail } from "./email/mailer";
import { deliverSoon } from "./email/outbox";
import { prepareKeysEmail, queueKeysEmail } from "./email/messages";
import type { KeyGroup } from "./email/templates";
import type { CustomerRow, InvoiceRow, ItemKeyRow, ProjectRow } from "./database/models";

const DELIVERY_BATCH = 100;
const SETTLE_DELAY_MS = 500;

export type NamedKeyRow = ItemKeyRow & { item_name: string };

export function groupKeys(keys: NamedKeyRow[]): KeyGroup[] {
	const groups = new Map<string, KeyGroup>();

	for (const key of keys) {
		const group = groups.get(key.item) ?? { name: key.item_name, codes: [] };
		group.codes.push(key.secret);
		groups.set(key.item, group);
	}

	return [...groups.values()];
}

export async function heldKeysOf(invoiceId: string, status: "reserved" | "delivered"): Promise<NamedKeyRow[]> {
	return (await Database`
		SELECT k.*, c.name AS item_name FROM item_keys k JOIN catalog_items c ON c.uuid = k.item
		WHERE k.invoice = ${invoiceId} AND k.status = ${status}
		ORDER BY c.name ASC, k.sequence ASC
	`) as NamedKeyRow[];
}

export async function recipientFor(invoice: InvoiceRow): Promise<string | null> {
	if (invoice.customer === null) return null;

	const [customer] = (await Database`SELECT email FROM customers WHERE uuid = ${invoice.customer}`) as Pick<CustomerRow, "email">[];
	return customer?.email ?? null;
}

export async function deliverKeysFor(invoiceId: string): Promise<number> {
	const [invoice] = (await Database`SELECT * FROM invoices WHERE uuid = ${invoiceId}`) as InvoiceRow[];
	if (!invoice || invoice.status !== "paid") return 0;

	const keys = await heldKeysOf(invoiceId, "reserved");
	if (keys.length === 0) return 0;

	const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${invoice.project}`) as ProjectRow[];
	const recipient = await recipientFor(invoice);
	const sending = recipient !== null && canEmail(project);
	const prepared = sending ? await prepareKeysEmail(project, invoice, groupKeys(keys)) : null;
	const timestamp = Date.now();

	const delivered = await Database.begin(async (tx) => {
		const claimed = await tx`
			UPDATE item_keys SET status = 'delivered', delivered_at = ${timestamp}, recipient = ${recipient}
			WHERE invoice = ${invoiceId} AND status = 'reserved'
		`;
		if (claimed.count === 0) return 0;

		if (prepared) await queueKeysEmail(tx, project, invoice, { prepared, to: recipient!, sentBy: null });
		return claimed.count;
	});

	if (delivered === 0) return 0;

	if (prepared) deliverSoon();
	Logger.info(
		`[KEYS] Handed over ${delivered} keys on ${invoice.reference}${recipient === null ? ", which has no email address to send them to" : ` to ${recipient}`}`
	);

	return delivered;
}

let delivering: Promise<{ invoices: number; keys: number }> | null = null;

async function deliverBatch(): Promise<{ invoices: number; keys: number }> {
	const waiting = (await Database`
		SELECT k.invoice AS invoice FROM item_keys k JOIN invoices i ON i.uuid = k.invoice
		WHERE k.status = 'reserved' AND i.status = 'paid'
		GROUP BY k.invoice ORDER BY MIN(k.reserved_at) ASC LIMIT ${DELIVERY_BATCH}
	`) as { invoice: string }[];

	const total = { invoices: 0, keys: 0 };

	for (const row of waiting) {
		try {
			const keys = await deliverKeysFor(row.invoice);
			if (keys > 0) {
				total.invoices++;
				total.keys += keys;
			}
		} catch (err) {
			Logger.error(`[KEYS] Could not hand over the keys on invoice ${row.invoice}: ${err}`);
		}
	}

	return total;
}

export async function deliverPendingKeys(): Promise<{ invoices: number; keys: number }> {
	if (delivering) return await delivering;

	delivering = deliverBatch();
	try {
		return await delivering;
	} finally {
		delivering = null;
	}
}

export function deliverKeysSoon() {
	setTimeout(() => {
		void deliverPendingKeys().catch((err) => Logger.error(`[KEYS] Delivery failed: ${err}`));
	}, SETTLE_DELAY_MS).unref?.();
}
