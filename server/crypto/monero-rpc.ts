import { JsonRpcClient } from "./rpc";

export const PICONERO_PER_XMR = 10n ** 12n;

export interface MoneroSubaddress {
	address: string;
	accountIndex: number;
	addressIndex: number;
}

export interface MoneroTransfer {
	txid: string;
	amount: bigint;
	confirmations: number;
	addressIndex: number;
}

export interface MoneroWallet {
	createAccount(label: string): Promise<number>;
	createSubaddress(accountIndex: number, label: string): Promise<MoneroSubaddress>;
	incomingTransfers(accountIndex: number): Promise<MoneroTransfer[]>;
}

interface CreateAccountResult {
	account_index?: number;
}

interface CreateAddressResult {
	address?: string;
	address_index?: number;
}

interface TransferEntry {
	txid?: string;
	amount?: number | string;
	confirmations?: number;
	subaddr_index?: { major?: number; minor?: number };
}

interface TransfersResult {
	in?: TransferEntry[];
	pool?: TransferEntry[];
}

function toPiconero(amount: number | string | undefined): bigint {
	if (typeof amount === "string") {
		try {
			return BigInt(amount);
		} catch {
			return 0n;
		}
	}
	if (typeof amount === "number" && Number.isFinite(amount)) return BigInt(Math.round(amount));
	return 0n;
}

export class MoneroWalletRpc implements MoneroWallet {
	private readonly rpc: JsonRpcClient;

	constructor(options: { url: string; username?: string; password?: string; timeoutMs?: number }) {
		const base = options.url.replace(/\/+$/, "");
		const url = base.endsWith("/json_rpc") ? base : `${base}/json_rpc`;
		this.rpc = new JsonRpcClient({ ...options, url });
	}

	async createAccount(label: string): Promise<number> {
		const result = await this.rpc.call<CreateAccountResult>("create_account", { label });
		if (typeof result.account_index !== "number") throw new Error("Wallet did not return an account index");
		return result.account_index;
	}

	async createSubaddress(accountIndex: number, label: string): Promise<MoneroSubaddress> {
		const result = await this.rpc.call<CreateAddressResult>("create_address", { account_index: accountIndex, label });
		if (!result.address || typeof result.address_index !== "number") throw new Error("Wallet did not return a subaddress");
		return { address: result.address, accountIndex, addressIndex: result.address_index };
	}

	async incomingTransfers(accountIndex: number): Promise<MoneroTransfer[]> {
		const result = await this.rpc.call<TransfersResult>("get_transfers", {
			in: true,
			pool: true,
			account_index: accountIndex,
		});

		const entries = [...(result.in ?? []), ...(result.pool ?? [])];
		const transfers: MoneroTransfer[] = [];

		for (const entry of entries) {
			if (!entry.txid) continue;

			const amount = toPiconero(entry.amount);
			if (amount <= 0n) continue;

			transfers.push({
				txid: entry.txid,
				amount,
				confirmations: Math.max(entry.confirmations ?? 0, 0),
				addressIndex: entry.subaddr_index?.minor ?? 0,
			});
		}

		return transfers;
	}
}
