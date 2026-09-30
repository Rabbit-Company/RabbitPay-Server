import Database from "../database/database";
import { Logger } from "../logger";
import { convertMinor } from "../invoicing";
import { marketRate } from "../tax-reporting";
import { REFUND_TYPES, SETTLED_PAYMENT_STATUSES, SETTLED_REFUND_STATUSES } from "../payments/ledger";

const FRESH_MS = 3 * 86400000;

interface Pending {
	uuid: string;
	currency: string;
	amount: number;
	settled: number;
	base: string;
	invoice_currency: string | null;
	invoice_tax_currency: string | null;
	invoice_rate: number | null;
}

export async function fillPaymentValues(now = Date.now()): Promise<number> {
	const rows = (await Database`
		SELECT t.uuid, t.currency, t.amount, COALESCE(t.completed_at, t.confirmed_at, t.created) AS settled,
			COALESCE(p.tax_currency, p.currency) AS base, i.currency AS invoice_currency, i.tax_currency AS invoice_tax_currency, i.tax_exchange_rate AS invoice_rate
		FROM transactions t JOIN projects p ON p.uuid = t.project LEFT JOIN invoices i ON i.uuid = t.invoice
		WHERE t.base_amount IS NULL AND t.currency <> COALESCE(p.tax_currency, p.currency)
			AND ((t.type = 'payment' AND t.status IN ${Database(SETTLED_PAYMENT_STATUSES)})
				OR (t.type IN ${Database(REFUND_TYPES)} AND t.status IN ${Database(SETTLED_REFUND_STATUSES)}))
		LIMIT 500
	`) as Pending[];
	let filled = 0;
	for (const row of rows) {
		const fresh = now - Number(row.settled) <= FRESH_MS;
		const invoiceRate = row.invoice_tax_currency === row.base && row.invoice_currency === row.currency ? row.invoice_rate : null;
		const rate = fresh ? ((await marketRate(row.currency, row.base)) ?? invoiceRate) : invoiceRate;
		if (rate === null || !Number.isFinite(rate) || rate <= 0) continue;
		await Database`UPDATE transactions SET base_amount = ${convertMinor(Number(row.amount), row.currency, rate, row.base)} WHERE uuid = ${row.uuid} AND base_amount IS NULL`;
		filled++;
	}
	if (filled > 0) Logger.info(`[LEDGER] Valued ${filled} foreign currency payments`);
	return filled;
}
