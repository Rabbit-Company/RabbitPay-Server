import Database from "../database/database";
import { configFor } from "./methods";
import { ethereumAddressAt, keyFingerprint, parseEthereumKey } from "../crypto/watch-only";
import { Logger } from "../logger";
import { Settings } from "../settings";
import { minorUnitDigits } from "../invoicing";
import { applyBalance } from "./ledger";
import { enqueueLater } from "../webhooks/events";
import { outstandingOf } from "./bitcoin";
import type { EthereumChainClient } from "../crypto/etherscan";
import type { CryptoAddressRow, InvoiceRow, ProjectRow, TransactionRow } from "../database/models";

export const WEI_PER_ETHER = 10n ** 18n;
export const WEI_PER_GWEI = 10n ** 9n;

export function isEnabled(): boolean {
	return Settings.eth?.enabled === true;
}

export function requiredConfirmations(): number {
	const configured = Settings.eth?.confirmations;
	return typeof configured === "number" && configured >= 0 ? configured : 12;
}

function addressLifetimeMs(): number {
	return (Settings.eth?.address_expiry || 3600) * 1000;
}

export function chainId(): number {
	return Settings.eth?.chain_id || 1;
}

export function weiFor(amountMinor: number, currency: string, rate: number): bigint {
	const scale = Math.pow(10, minorUnitDigits(currency));
	const ether = amountMinor / (scale * rate);
	return BigInt(Math.ceil(ether * 1e9)) * WEI_PER_GWEI;
}

export function minorUnitsFor(wei: bigint, currency: string, rate: number): number {
	const scale = Math.pow(10, minorUnitDigits(currency));
	const ether = Number(wei) / Number(WEI_PER_ETHER);
	return Math.floor(Math.round(ether * rate * scale * 1e6) / 1e6);
}

export function toGwei(wei: bigint): number {
	return Number(wei / WEI_PER_GWEI);
}

export function paymentUri(address: string, wei: bigint): string {
	return `ethereum:${address}@${chainId()}?value=${wei.toString()}`;
}

async function nextDerivationIndex(walletKey: string): Promise<number> {
	const [row] = (await Database`
		SELECT COALESCE(MAX(derivation_index), -1) AS highest FROM crypto_addresses WHERE wallet_key = ${walletKey} AND currency = 'ethereum'
	`) as { highest: number }[];
	return row.highest + 1;
}

export async function existingAddressFor(invoiceId: string): Promise<CryptoAddressRow | undefined> {
	const [row] = (await Database`
		SELECT * FROM crypto_addresses WHERE invoice = ${invoiceId} AND currency = 'ethereum' AND monitored = 1 ORDER BY created DESC
	`) as CryptoAddressRow[];
	return row;
}

export async function assignAddress(project: ProjectRow, invoice: InvoiceRow, rate: number): Promise<CryptoAddressRow> {
	const existing = await existingAddressFor(invoice.uuid);
	if (existing && existing.expires_at !== null && existing.expires_at > Date.now()) return existing;

	const config = await configFor(project.uuid, "ethereum");
	if (!config.xpub) throw new Error("No Ethereum wallet is configured for this project");

	const walletKey = keyFingerprint("ethereum", config.xpub);
	const index = await nextDerivationIndex(walletKey);
	const address = ethereumAddressAt(parseEthereumKey(config.xpub), index);

	const expectedWei = weiFor(outstandingOf(invoice), invoice.currency, rate);
	const timestamp = Date.now();

	await Database`
		INSERT INTO crypto_addresses(address, project, currency, derivation_index, wallet_key, invoice, label, monitored, balance, total_received,
			expected_amount, exchange_rate, invoice_currency, created, expires_at)
		VALUES(${address}, ${project.uuid}, 'ethereum', ${index}, ${walletKey}, ${invoice.uuid}, ${invoice.reference}, 1, 0, 0,
			${toGwei(expectedWei)}, ${rate}, ${invoice.currency}, ${timestamp}, ${timestamp + addressLifetimeMs()})
	`;

	Logger.audit(`[ETH] Assigned ${address} to ${invoice.reference} expecting ${expectedWei} wei`);

	const [row] = (await Database`SELECT * FROM crypto_addresses WHERE address = ${address}`) as CryptoAddressRow[];
	return row;
}

async function creditTransfer(row: CryptoAddressRow, hash: string, wei: bigint, confirmations: number): Promise<boolean> {
	if (row.invoice === null) return false;

	const rate = row.exchange_rate ?? 1;
	const currency = row.invoice_currency ?? "EUR";
	const amount = minorUnitsFor(wei, currency, rate);
	if (amount <= 0) return false;

	const settled = confirmations >= requiredConfirmations();
	const status = settled ? "completed" : "pending";
	const timestamp = Date.now();

	const [existing] = (await Database`
		SELECT * FROM transactions WHERE processor = 'ethereum' AND processor_tx_id = ${hash} AND invoice = ${row.invoice}
	`) as TransactionRow[];

	if (existing) {
		if (existing.status !== "pending" || !settled) {
			if (existing.confirmations !== confirmations) {
				await Database`UPDATE transactions SET confirmations = ${confirmations}, updated = ${timestamp} WHERE uuid = ${existing.uuid}`;
			}
			return false;
		}

		await Database`
			UPDATE transactions SET status = 'completed', amount = ${amount}, net_amount = ${amount}, confirmations = ${confirmations},
				payment_details = ${JSON.stringify({ wei: wei.toString(), address: row.address, hash })},
				confirmed_at = ${timestamp}, completed_at = ${timestamp}, updated = ${timestamp}
			WHERE uuid = ${existing.uuid}
		`;

		await applyBalance(Database, row.invoice);
		Logger.audit(`[ETH] ${hash} confirmed with ${confirmations} confirmations, credited ${amount} ${currency}`);

		enqueueLater(row.project, "payment.confirmed", {
			invoice: row.invoice,
			processor: "ethereum",
			address: row.address,
			txid: hash,
			wei: wei.toString(),
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
		VALUES(${crypto.randomUUID()}, ${row.project}, ${row.invoice}, ${invoice?.customer ?? null}, 'ethereum', ${hash}, ${status}, 'payment',
			${currency}, ${amount}, 0, ${amount}, ${rate}, ${row.address},
			${JSON.stringify({ wei: wei.toString(), address: row.address, hash })}, ${confirmations},
			${settled ? timestamp : null}, ${settled ? timestamp : null}, ${timestamp}, ${timestamp})
	`;

	if (settled) await applyBalance(Database, row.invoice);

	Logger.audit(`[ETH] Saw ${wei} wei to ${row.address} in ${hash} (${confirmations} confirmations)`);

	enqueueLater(row.project, settled ? "payment.confirmed" : "payment.received", {
		invoice: row.invoice,
		processor: "ethereum",
		address: row.address,
		txid: hash,
		wei: wei.toString(),
		amount,
		currency,
		confirmations,
		status,
	});

	return true;
}

export async function watchAddresses(chain: EthereumChainClient): Promise<{ checked: number; credited: number }> {
	const rows = (await Database`
		SELECT * FROM crypto_addresses WHERE monitored = 1 AND currency = 'ethereum'
	`) as CryptoAddressRow[];

	if (rows.length === 0) return { checked: 0, credited: 0 };

	let credited = 0;

	for (const row of rows) {
		try {
			const transfers = await chain.transfersTo(row.address);
			const receivedWei = transfers.reduce((sum, transfer) => sum + transfer.value, 0n);

			for (const transfer of transfers) {
				if (await creditTransfer(row, transfer.hash, transfer.value, transfer.confirmations)) credited++;
			}

			const receivedGwei = toGwei(receivedWei);
			const needed = requiredConfirmations();
			const fullyConfirmed = transfers.every((transfer) => transfer.confirmations >= needed);
			const satisfied = receivedGwei >= (row.expected_amount ?? 0) && fullyConfirmed && receivedGwei > 0;
			const expired = row.expires_at !== null && row.expires_at < Date.now() && receivedGwei === 0;

			await Database`
				UPDATE crypto_addresses SET balance = ${receivedGwei}, total_received = ${receivedGwei}, last_checked = ${Date.now()},
					monitored = ${satisfied || expired ? 0 : 1}
				WHERE address = ${row.address}
			`;
		} catch (err) {
			Logger.error(`[ETH] Could not check ${row.address}: ${err}`);
		}
	}

	return { checked: rows.length, credited };
}
