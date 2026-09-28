import { JsonRpcClient } from "./rpc";
import { Logger } from "../logger";
import type { AddressPayment, ChainClient } from "./esplora";

const SATOSHIS_PER_BITCOIN = 100_000_000;

interface ReceivedByAddress {
	address?: string;
	txids?: string[];
}

interface TransactionDetail {
	address?: string;
	category?: string;
	amount?: number;
}

interface WalletTransaction {
	confirmations?: number;
	details?: TransactionDetail[];
}

export function toSatoshis(bitcoin: number): number {
	return Math.round(bitcoin * SATOSHIS_PER_BITCOIN);
}

export class BitcoinRpcClient implements ChainClient {
	private readonly rpc: JsonRpcClient;

	constructor(options: { url: string; username?: string; password?: string; wallet?: string; timeoutMs?: number }) {
		const base = options.url.replace(/\/+$/, "");
		const url = options.wallet ? `${base}/wallet/${encodeURIComponent(options.wallet)}` : base;
		this.rpc = new JsonRpcClient({ url, username: options.username, password: options.password, timeoutMs: options.timeoutMs });
	}

	async tipHeight(): Promise<number> {
		const height = await this.rpc.call<number>("getblockcount");
		if (!Number.isSafeInteger(height) || height <= 0) throw new Error("Node returned an unusable block count");
		return height;
	}

	async watch(address: string, label: string): Promise<void> {
		try {
			const info = await this.rpc.call<{ descriptor: string }>("getdescriptorinfo", [`addr(${address})`]);
			await this.rpc.call("importdescriptors", [[{ desc: info.descriptor, timestamp: "now", label, internal: false }]]);
			return;
		} catch (err) {
			Logger.debug(`[BTC] importdescriptors unavailable, falling back to importaddress: ${err}`);
		}

		await this.rpc.call("importaddress", [address, label, false]);
	}

	async paymentsTo(address: string, _tip?: number): Promise<AddressPayment[]> {
		const received = await this.rpc.call<ReceivedByAddress[]>("listreceivedbyaddress", [0, true, true, address]);

		const entry = received.find((item) => item.address === address);
		if (!entry?.txids?.length) return [];

		const payments: AddressPayment[] = [];

		for (const txid of entry.txids) {
			const transaction = await this.rpc.call<WalletTransaction>("gettransaction", [txid, true]);

			const value = (transaction.details ?? [])
				.filter((detail) => detail.address === address && detail.category === "receive")
				.reduce((sum, detail) => sum + toSatoshis(detail.amount ?? 0), 0);

			if (value <= 0) continue;

			payments.push({ txid, value, confirmations: Math.max(transaction.confirmations ?? 0, 0) });
		}

		return payments;
	}
}
