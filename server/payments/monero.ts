import Database from "../database/database";
import { Logger } from "../logger";
import { Settings } from "../settings";
import { minorUnitDigits } from "../invoicing";
import { applyBalance } from "./ledger";
import { enqueueLater } from "../webhooks/events";
import { outstandingOf } from "./bitcoin";
import { PICONERO_PER_XMR, type MoneroWallet } from "../crypto/monero-rpc";
import { moneroWalletFor } from "../crypto/chains";
import { configFor } from "./methods";
import { keyFingerprint } from "../crypto/watch-only";
import type { CryptoAddressRow, InvoiceRow, ProjectRow, TransactionRow } from "../database/models";

export function isEnabled(): boolean {
	return Settings.xmr?.enabled === true;
}

export function requiredConfirmations(): number {
	const configured = Settings.xmr?.confirmations;
	return typeof configured === "number" && configured >= 0 ? configured : 10;
}

function addressLifetimeMs(): number {
	return (Settings.xmr?.address_expiry || 3600) * 1000;
}

export function piconeroFor(amountMinor: number, currency: string, rate: number): bigint {
	const scale = Math.pow(10, minorUnitDigits(currency));
	const monero = amountMinor / (scale * rate);
	return BigInt(Math.ceil(monero * 1e6)) * (PICONERO_PER_XMR / 1_000_000n);
}

export function minorUnitsFor(piconero: bigint, currency: string, rate: number): number {
	const scale = Math.pow(10, minorUnitDigits(currency));
	const monero = Number(piconero) / Number(PICONERO_PER_XMR);
	return Math.floor(Math.round(monero * rate * scale * 1e6) / 1e6);
}

export function paymentUri(address: string, piconero: bigint, label: string): string {
	const amount = (Number(piconero) / Number(PICONERO_PER_XMR)).toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
	return `monero:${address}?tx_amount=${amount}&tx_description=${encodeURIComponent(label)}`;
}

export interface ProjectWallet {
	wallet: MoneroWallet;
	account: number;
	key: string;
}

export function walletKeyFor(config: Record<string, string>): string {
	return keyFingerprint("monero", config.wallet_rpc_url ?? "", config.rpc_username ?? "", config.account_index || "0");
}

export async function projectWallet(projectId: string): Promise<ProjectWallet> {
	const config = await configFor(projectId, "monero");
	if (!config.wallet_rpc_url) throw new Error("No Monero wallet is configured for this project");
	return { wallet: moneroWalletFor(config), account: Number(config.account_index || 0), key: walletKeyFor(config) };
}

export async function existingAddressFor(invoiceId: string): Promise<CryptoAddressRow | undefined> {
	const [row] = (await Database`
		SELECT * FROM crypto_addresses WHERE invoice = ${invoiceId} AND currency = 'monero' AND monitored = 1 ORDER BY created DESC
	`) as CryptoAddressRow[];
	return row;
}

export async function assignAddress(project: ProjectRow, invoice: InvoiceRow, rate: number): Promise<CryptoAddressRow> {
	const existing = await existingAddressFor(invoice.uuid);
	if (existing && existing.expires_at !== null && existing.expires_at > Date.now()) return existing;

	const { wallet, account, key } = await projectWallet(project.uuid);
	const subaddress = await wallet.createSubaddress(account, invoice.reference);

	const expected = piconeroFor(outstandingOf(invoice), invoice.currency, rate);
	const timestamp = Date.now();

	await Database`
		INSERT INTO crypto_addresses(address, project, currency, derivation_index, wallet_key, wallet_account, invoice, label, monitored,
			balance, total_received, expected_amount, exchange_rate, invoice_currency, created, expires_at)
		VALUES(${subaddress.address}, ${project.uuid}, 'monero', ${subaddress.addressIndex}, ${key}, ${account}, ${invoice.uuid}, ${invoice.reference}, 1,
			0, 0,
			${Number(expected)}, ${rate}, ${invoice.currency}, ${timestamp}, ${timestamp + addressLifetimeMs()})
	`;

	Logger.audit(`[XMR] Assigned ${subaddress.address} to ${invoice.reference} expecting ${expected} piconero`);

	const [row] = (await Database`SELECT * FROM crypto_addresses WHERE address = ${subaddress.address}`) as CryptoAddressRow[];
	return row;
}

async function creditTransfer(row: CryptoAddressRow, txid: string, piconero: bigint, confirmations: number): Promise<boolean> {
	if (row.invoice === null) return false;

	const rate = row.exchange_rate ?? 1;
	const currency = row.invoice_currency ?? "EUR";
	const amount = minorUnitsFor(piconero, currency, rate);
	if (amount <= 0) return false;

	const settled = confirmations >= requiredConfirmations();
	const status = settled ? "completed" : "pending";
	const timestamp = Date.now();
	const details = JSON.stringify({ piconero: piconero.toString(), address: row.address, txid });

	const [existing] = (await Database`
		SELECT * FROM transactions WHERE processor = 'monero' AND processor_tx_id = ${txid} AND invoice = ${row.invoice}
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
				payment_details = ${details}, confirmed_at = ${timestamp}, completed_at = ${timestamp}, updated = ${timestamp}
			WHERE uuid = ${existing.uuid}
		`;

		await applyBalance(Database, row.invoice);
		Logger.audit(`[XMR] ${txid} confirmed with ${confirmations} confirmations, credited ${amount} ${currency}`);

		enqueueLater(row.project, "payment.confirmed", {
			invoice: row.invoice,
			processor: "monero",
			address: row.address,
			txid,
			piconero: piconero.toString(),
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
		VALUES(${crypto.randomUUID()}, ${row.project}, ${row.invoice}, ${invoice?.customer ?? null}, 'monero', ${txid}, ${status}, 'payment',
			${currency}, ${amount}, 0, ${amount}, ${rate}, ${row.address}, ${details}, ${confirmations},
			${settled ? timestamp : null}, ${settled ? timestamp : null}, ${timestamp}, ${timestamp})
	`;

	if (settled) await applyBalance(Database, row.invoice);

	Logger.audit(`[XMR] Saw ${piconero} piconero to ${row.address} in ${txid} (${confirmations} confirmations)`);

	enqueueLater(row.project, settled ? "payment.confirmed" : "payment.received", {
		invoice: row.invoice,
		processor: "monero",
		address: row.address,
		txid,
		piconero: piconero.toString(),
		amount,
		currency,
		confirmations,
		status,
	});

	return true;
}

export async function watchAddresses(): Promise<{ checked: number; credited: number }> {
	const rows = (await Database`
		SELECT * FROM crypto_addresses WHERE monitored = 1 AND currency = 'monero' AND wallet_key IS NOT NULL
	`) as CryptoAddressRow[];

	if (rows.length === 0) return { checked: 0, credited: 0 };

	const groups = new Map<string, CryptoAddressRow[]>();
	for (const row of rows) {
		const group = `${row.project}\n${row.wallet_key}`;
		groups.set(group, [...(groups.get(group) ?? []), row]);
	}

	let credited = 0;

	for (const addresses of groups.values()) {
		const { project, wallet_key: walletKey, wallet_account: account } = addresses[0];

		let current: ProjectWallet;
		try {
			current = await projectWallet(project);
		} catch (err) {
			Logger.warn(`[XMR] Cannot watch ${addresses.length} addresses of ${project}: ${err}`);
			continue;
		}
		if (current.key !== walletKey) {
			Logger.warn(`[XMR] ${project} changed its Monero wallet, ${addresses.length} older addresses are no longer watched`);
			continue;
		}

		try {
			const transfers = await current.wallet.incomingTransfers(account ?? current.account);

			for (const row of addresses) {
				const mine = transfers.filter((transfer) => transfer.addressIndex === row.derivation_index);
				const received = mine.reduce((sum, transfer) => sum + transfer.amount, 0n);

				for (const transfer of mine) {
					if (await creditTransfer(row, transfer.txid, transfer.amount, transfer.confirmations)) credited++;
				}

				const needed = requiredConfirmations();
				const fullyConfirmed = mine.every((transfer) => transfer.confirmations >= needed);
				const satisfied = Number(received) >= (row.expected_amount ?? 0) && fullyConfirmed && received > 0n;
				const expired = row.expires_at !== null && row.expires_at < Date.now() && received === 0n;

				await Database`
					UPDATE crypto_addresses SET balance = ${Number(received)}, total_received = ${Number(received)}, last_checked = ${Date.now()},
						monitored = ${satisfied || expired ? 0 : 1}
					WHERE address = ${row.address}
				`;
			}
		} catch (err) {
			Logger.error(`[XMR] Could not check the wallet of ${project}: ${err}`);
		}
	}

	return { checked: rows.length, credited };
}
