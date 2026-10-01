import { unusedEthereumAddress, type ChainProbe, type ChainStatus } from "./chain-status";

export interface AddressTransfer {
	hash: string;
	value: bigint;
	confirmations: number;
}

export interface EthereumChainClient {
	transfersTo(address: string): Promise<AddressTransfer[]>;
}

interface EtherscanTransaction {
	hash?: string;
	to?: string;
	value?: string;
	isError?: string;
	txreceipt_status?: string;
	confirmations?: string;
}

interface EtherscanResponse {
	status?: string;
	message?: string;
	result?: EtherscanTransaction[] | string;
}

export class EtherscanClient implements EthereumChainClient, ChainProbe {
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly chainId: number;
	private readonly timeoutMs: number;

	constructor(baseUrl: string, apiKey = "", chainId = 1, timeoutMs = 10000) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.apiKey = apiKey;
		this.chainId = chainId;
		this.timeoutMs = timeoutMs;
	}

	async transfersTo(address: string): Promise<AddressTransfer[]> {
		const query = new URLSearchParams({
			chainid: String(this.chainId),
			module: "account",
			action: "txlist",
			address,
			startblock: "0",
			endblock: "99999999",
			page: "1",
			offset: "50",
			sort: "desc",
		});
		if (this.apiKey) query.set("apikey", this.apiKey);

		const response = await fetch(`${this.baseUrl}?${query}`, {
			signal: AbortSignal.timeout(this.timeoutMs),
			headers: { Accept: "application/json" },
		});

		if (!response.ok) throw new Error(`Chain API responded ${response.status}`);

		const payload = (await response.json()) as EtherscanResponse;

		if (typeof payload.result === "string") {
			if (payload.status === "0" && /no transactions found/i.test(payload.result)) return [];
			throw new Error(`Chain API error: ${payload.result}`);
		}

		if (!Array.isArray(payload.result)) return [];

		const wanted = address.toLowerCase();
		const transfers: AddressTransfer[] = [];

		for (const transaction of payload.result) {
			if (!transaction.hash || transaction.to?.toLowerCase() !== wanted) continue;
			if (transaction.isError === "1" || transaction.txreceipt_status === "0") continue;

			let value: bigint;
			try {
				value = BigInt(transaction.value ?? "0");
			} catch {
				continue;
			}

			if (value <= 0n) continue;

			transfers.push({
				hash: transaction.hash,
				value,
				confirmations: Math.max(Number(transaction.confirmations ?? "0") || 0, 0),
			});
		}

		return transfers;
	}

	async status(): Promise<ChainStatus> {
		await this.transfersTo(unusedEthereumAddress());
		return { network: null, height: null, warnings: [] };
	}
}
