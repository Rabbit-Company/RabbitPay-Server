import type { SQL } from "bun";
import Database from "../database/database";
import { FISCAL_PROCESSORS } from "../fiscal/config";
import { closedYear } from "../accounting-periods";
import { applyBalance, type InvoiceBalance } from "./ledger";
import type { TransactionRow } from "../database/models";

export const BANK_PAYMENT_NOTE = "Bank statement";

export type RemovalRefusal = "not_payment" | "not_manual" | "linked" | "refunded" | "fiscal" | "closed_year";

interface PaymentDetails {
	notes?: string;
	recorded_by?: string | null;
	[key: string]: unknown;
}

function detailsOf(payment: Pick<TransactionRow, "payment_details">): PaymentDetails {
	try {
		return payment.payment_details ? (JSON.parse(payment.payment_details) as PaymentDetails) : {};
	} catch {
		return {};
	}
}

export async function removalRefusal(payment: TransactionRow): Promise<RemovalRefusal | null> {
	if (payment.type !== "payment" || payment.invoice === null || !["completed", "confirmed"].includes(payment.status)) return "not_payment";
	const details = detailsOf(payment);
	if (!details.recorded_by || details.notes === BANK_PAYMENT_NOTE || payment.payment_method === "terminal") return "not_manual";
	const [linked] = (await Database`
		SELECT
			(SELECT COUNT(*) FROM bank_transaction_matches WHERE payment_transaction = ${payment.uuid})
			+ (SELECT COUNT(*) FROM bank_transactions WHERE payment_transaction = ${payment.uuid}) AS links,
			(SELECT COUNT(*) FROM transactions WHERE parent_transaction = ${payment.uuid})
			+ (SELECT COUNT(*) FROM refunds WHERE transaction_id = ${payment.uuid}) AS refunds,
			(SELECT COUNT(*) FROM fiscal_documents WHERE invoice = ${payment.invoice}) AS fiscal
	`) as { links: number; refunds: number; fiscal: number }[];
	if (Number(linked.links) > 0) return "linked";
	if (Number(linked.refunds) > 0) return "refunded";
	if (FISCAL_PROCESSORS.has(payment.processor) && Number(linked.fiscal) > 0) return "fiscal";
	if (await closedYear(payment.project, payment.completed_at ?? payment.confirmed_at ?? payment.created)) return "closed_year";
	return null;
}

export async function removePayment(payment: TransactionRow, author: string, reason: string | null): Promise<InvoiceBalance> {
	const now = Date.now();
	const removed = JSON.stringify({ ...detailsOf(payment), removed_by: author, removed_at: now, removed_reason: reason ?? "Recorded by mistake" });
	return Database.begin(async (tx) => {
		await tx`UPDATE transactions SET status = 'failed', payment_details = ${removed}, updated = ${now} WHERE uuid = ${payment.uuid}`;
		return applyBalance(tx as SQL, payment.invoice!);
	});
}
