import { JsonRpcClient, RpcError } from "./rpc";
import { Logger } from "../logger";
import type { AddressPayment, ChainClient } from "./esplora";
import { ChainStatusError, bitcoinCoreNetworkName, type ChainProbe, type ChainStatus } from "./chain-status";

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

interface BlockchainInfo {
	chain: string;
	blocks: number;
	headers?: number;
	initialblockdownload?: boolean;
}

interface WalletInfo {
	descriptors?: boolean;
	private_keys_enabled?: boolean;
}

const WALLET_NOT_FOUND = -18;
const WALLET_NOT_SPECIFIED = -19;
const METHOD_UNAVAILABLE = new Set([-32601, -32701]);

export function toSatoshis(bitcoin: number): number {
	return Math.round(bitcoin * SATOSHIS_PER_BITCOIN);
}

export class BitcoinRpcClient implements ChainClient, ChainProbe {
	private readonly rpc: JsonRpcClient;
	private readonly wallet: string;

	constructor(options: { url: string; username?: string; password?: string; wallet?: string; timeoutMs?: number }) {
		const base = options.url.replace(/\/+$/, "");
		const url = options.wallet ? `${base}/wallet/${encodeURIComponent(options.wallet)}` : base;
		this.rpc = new JsonRpcClient({ url, username: options.username, password: options.password, timeoutMs: options.timeoutMs });
		this.wallet = options.wallet ?? "";
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

	private async walletInfo(): Promise<WalletInfo> {
		try {
			return await this.rpc.call<WalletInfo>("getwalletinfo");
		} catch (err) {
			if (err instanceof RpcError && err.code === WALLET_NOT_FOUND) {
				throw new ChainStatusError(
					this.wallet
						? `The node has no loaded wallet named ${this.wallet}. Create or load it on the node.`
						: "The node has no loaded wallet. Create or load one."
				);
			}
			if (err instanceof RpcError && err.code === WALLET_NOT_SPECIFIED) {
				throw new ChainStatusError("The node has several wallets loaded. Enter the name of the one to use as the RPC wallet.");
			}
			if (err instanceof RpcError && METHOD_UNAVAILABLE.has(err.code)) {
				throw new ChainStatusError(
					"This node does not offer wallet methods, which Bitcoin Core RPC needs to watch addresses. Use your own node with a wallet, or the Esplora API."
				);
			}
			throw err;
		}
	}

	async status(): Promise<ChainStatus> {
		const chain = await this.rpc.call<BlockchainInfo>("getblockchaininfo");
		const wallet = await this.walletInfo();

		if (wallet.descriptors && wallet.private_keys_enabled) {
			throw new ChainStatusError(
				"The wallet holds private keys, so payment addresses cannot be imported into it. Use a wallet created with private keys disabled."
			);
		}

		const warnings = chain.initialblockdownload
			? [`The node is still syncing, at block ${chain.blocks} of ${chain.headers ?? chain.blocks}. Payments are seen once it catches up.`]
			: [];

		return { network: bitcoinCoreNetworkName(chain.chain), height: chain.blocks, warnings };
	}
}
