import Database from "../database/database";
import { configFor } from "./methods";
import { bitcoinAddressAt, ethereumAddressAt, keyFingerprint, parseBitcoinKey, parseEthereumKey } from "../crypto/watch-only";
import { Logger } from "../logger";
import { Settings } from "../settings";
import { minorUnitDigits, outstandingOf } from "../invoicing";
import { applyBalance } from "./ledger";
import { enqueueLater } from "../webhooks/events";
import { bitcoinChain } from "../crypto/chains";
import type { ChainClient } from "../crypto/esplora";
import type { CryptoAddressRow, InvoiceRow, ProjectRow, TransactionRow } from "../database/models";

export const SATOSHIS_PER_BITCOIN = 100_000_000;

export function isEnabled(): boolean {
	return Settings.btc?.enabled === true;
}

export function requiredConfirmations(): number {
	const configured = Settings.btc?.confirmations;
	return typeof configured === "number" && configured >= 0 ? configured : 2;
}

function addressLifetimeMs(): number {
	return (Settings.btc?.address_expiry || 3600) * 1000;
}

function withoutFloatNoise(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}

export function satoshisFor(amountMinor: number, currency: string, rate: number): number {
	const scale = Math.pow(10, minorUnitDigits(currency));
	return Math.ceil(withoutFloatNoise((amountMinor * SATOSHIS_PER_BITCOIN) / (scale * rate)));
}

export function minorUnitsFor(satoshis: number, currency: string, rate: number): number {
	const scale = Math.pow(10, minorUnitDigits(currency));
	return Math.floor(withoutFloatNoise((satoshis * rate * scale) / SATOSHIS_PER_BITCOIN));
}

export { outstandingOf };

async function nextDerivationIndex(walletKey: string): Promise<number> {
	const [row] = (await Database`
		SELECT COALESCE(MAX(derivation_index), -1) AS highest FROM crypto_addresses WHERE wallet_key = ${walletKey} AND currency = 'bitcoin'
	`) as { highest: number }[];
	return row.highest + 1;
}

export async function existingAddressFor(invoiceId: string): Promise<CryptoAddressRow | undefined> {
	const [row] = (await Database`
		SELECT * FROM crypto_addresses WHERE invoice = ${invoiceId} AND currency = 'bitcoin' AND monitored = 1 ORDER BY created DESC
	`) as CryptoAddressRow[];
	return row;
}

export function paymentUri(address: string, satoshis: number, label: string): string {
	const amount = (satoshis / SATOSHIS_PER_BITCOIN).toFixed(8);
	return `bitcoin:${address}?amount=${amount}&label=${encodeURIComponent(label)}`;
}

export async function assignAddress(project: ProjectRow, invoice: InvoiceRow, rate: number): Promise<CryptoAddressRow> {
	const existing = await existingAddressFor(invoice.uuid);
	if (existing && existing.expires_at !== null && existing.expires_at > Date.now()) return existing;

	const config = await configFor(project.uuid, "bitcoin");
	if (!config.xpub) throw new Error("No Bitcoin wallet is configured for this project");

	const key = parseBitcoinKey(config.xpub, config.address_type);
	const walletKey = keyFingerprint("bitcoin", config.xpub, key.script);
	const index = await nextDerivationIndex(walletKey);
	const address = bitcoinAddressAt(key, index);

	const chain = bitcoinChain();
	if (chain.watch) await chain.watch(address, invoice.reference);

	const expected = satoshisFor(outstandingOf(invoice), invoice.currency, rate);
	const timestamp = Date.now();

	await Database`
		INSERT INTO crypto_addresses(address, project, currency, derivation_index, wallet_key, invoice, label, monitored, balance, total_received,
			expected_amount, exchange_rate, invoice_currency, created, expires_at)
		VALUES(${address}, ${project.uuid}, 'bitcoin', ${index}, ${walletKey}, ${invoice.uuid}, ${invoice.reference}, 1, 0, 0,
			${expected}, ${rate}, ${invoice.currency}, ${timestamp}, ${timestamp + addressLifetimeMs()})
	`;

	Logger.audit(`[BTC] Assigned ${address} to ${invoice.reference} expecting ${expected} sats`);

	const [row] = (await Database`SELECT * FROM crypto_addresses WHERE address = ${address}`) as CryptoAddressRow[];
	return row;
}

async function creditPayment(row: CryptoAddressRow, txid: string, satoshis: number, confirmations: number): Promise<boolean> {
	if (row.invoice === null) return false;

	const rate = row.exchange_rate ?? 1;
	const currency = row.invoice_currency ?? "EUR";
	const amount = minorUnitsFor(satoshis, currency, rate);
	if (amount <= 0) return false;

	const settled = confirmations >= requiredConfirmations();
	const status = settled ? "completed" : "pending";
	const timestamp = Date.now();

	const [existing] = (await Database`
		SELECT * FROM transactions WHERE processor = 'bitcoin' AND processor_tx_id = ${txid} AND invoice = ${row.invoice}
	`) as TransactionRow[];

	if (existing) {
		if (existing.status === status || existing.status !== "pending") {
			if (existing.confirmations !== confirmations) {
				await Database`UPDATE transactions SET confirmations = ${confirmations}, updated = ${timestamp} WHERE uuid = ${existing.uuid}`;
			}
			return false;
		}

		await Database`
			UPDATE transactions SET status = ${status}, confirmations = ${confirmations}, confirmed_at = ${timestamp},
				completed_at = ${timestamp}, updated = ${timestamp}
			WHERE uuid = ${existing.uuid}
		`;

		await applyBalance(Database, row.invoice);
		Logger.audit(`[BTC] ${txid} confirmed with ${confirmations} confirmations, credited ${amount} ${currency}`);

		enqueueLater(row.project, "payment.confirmed", {
			invoice: row.invoice,
			processor: "bitcoin",
			address: row.address,
			txid,
			satoshis,
			amount,
			currency,
			confirmations,
			status,
		});

		return true;
	}

	const [invoice] = (await Database`SELECT customer FROM invoices WHERE uuid = ${row.invoice}`) as { customer: string | null }[];

	await Database`
		INSERT INTO transactions(uuid, project, invoice, customer, processor, processor_tx_id, status, type, currency, amount,
			fee_amount, net_amount, exchange_rate, payment_method, payment_details, confirmations, confirmed_at, completed_at, created, updated)
		VALUES(${crypto.randomUUID()}, ${row.project}, ${row.invoice}, ${invoice?.customer ?? null}, 'bitcoin', ${txid}, ${status}, 'payment',
			${currency}, ${amount}, 0, ${amount}, ${rate}, ${row.address},
			${JSON.stringify({ satoshis, address: row.address, txid })}, ${confirmations},
			${settled ? timestamp : null}, ${settled ? timestamp : null}, ${timestamp}, ${timestamp})
	`;

	if (settled) await applyBalance(Database, row.invoice);

	Logger.audit(`[BTC] Saw ${satoshis} sats to ${row.address} in ${txid} (${confirmations} confirmations)`);

	enqueueLater(row.project, settled ? "payment.confirmed" : "payment.received", {
		invoice: row.invoice,
		processor: "bitcoin",
		address: row.address,
		txid,
		satoshis,
		amount,
		currency,
		confirmations,
		status,
	});

	return true;
}

export async function watchAddresses(chain: ChainClient): Promise<{ checked: number; credited: number }> {
	const rows = (await Database`
		SELECT * FROM crypto_addresses WHERE monitored = 1 AND currency = 'bitcoin'
	`) as CryptoAddressRow[];

	if (rows.length === 0) return { checked: 0, credited: 0 };

	const tip = await chain.tipHeight();
	let credited = 0;

	for (const row of rows) {
		try {
			const payments = await chain.paymentsTo(row.address, tip);
			const received = payments.reduce((sum, payment) => sum + payment.value, 0);

			for (const payment of payments) {
				if (await creditPayment(row, payment.txid, payment.value, payment.confirmations)) credited++;
			}

			const settledConfirmations = requiredConfirmations();
			const fullyConfirmed = payments.every((payment) => payment.confirmations >= settledConfirmations);
			const satisfied = received >= (row.expected_amount ?? 0) && fullyConfirmed && received > 0;
			const expired = row.expires_at !== null && row.expires_at < Date.now() && received === 0;

			await Database`
				UPDATE crypto_addresses SET balance = ${received}, total_received = ${received}, last_checked = ${Date.now()},
					monitored = ${satisfied || expired ? 0 : 1}
				WHERE address = ${row.address}
			`;
		} catch (err) {
			Logger.error(`[BTC] Could not check ${row.address}: ${err}`);
		}
	}

	return { checked: rows.length, credited };
}
