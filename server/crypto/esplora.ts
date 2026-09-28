export interface AddressPayment {
	txid: string;
	value: number;
	confirmations: number;
}

export interface ChainClient {
	tipHeight(): Promise<number>;
	paymentsTo(address: string, tip: number): Promise<AddressPayment[]>;
	watch?(address: string, label: string): Promise<void>;
}

interface EsploraVout {
	scriptpubkey_address?: string;
	value?: number;
}

interface EsploraTransaction {
	txid: string;
	vout?: EsploraVout[];
	status?: { confirmed?: boolean; block_height?: number };
}

export class EsploraClient implements ChainClient {
	private readonly baseUrl: string;
	private readonly timeoutMs: number;

	constructor(baseUrl: string, timeoutMs = 10000) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.timeoutMs = timeoutMs;
	}

	private async get<T>(path: string, parse: "json" | "text"): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			signal: AbortSignal.timeout(this.timeoutMs),
			headers: { Accept: "application/json" },
		});

		if (!response.ok) throw new Error(`Chain API responded ${response.status} for ${path}`);

		return (parse === "json" ? await response.json() : await response.text()) as T;
	}

	async tipHeight(): Promise<number> {
		const height = Number((await this.get<string>("/blocks/tip/height", "text")).trim());
		if (!Number.isSafeInteger(height) || height <= 0) throw new Error("Chain API returned an unusable tip height");
		return height;
	}

	async paymentsTo(address: string, tip: number): Promise<AddressPayment[]> {
		const transactions = await this.get<EsploraTransaction[]>(`/address/${encodeURIComponent(address)}/txs`, "json");
		if (!Array.isArray(transactions)) return [];

		const payments: AddressPayment[] = [];

		for (const transaction of transactions) {
			const value = (transaction.vout ?? []).filter((output) => output.scriptpubkey_address === address).reduce((sum, output) => sum + (output.value ?? 0), 0);

			if (value <= 0) continue;

			const height = transaction.status?.block_height;
			const confirmed = transaction.status?.confirmed === true && typeof height === "number";

			payments.push({
				txid: transaction.txid,
				value,
				confirmations: confirmed ? Math.max(tip - height! + 1, 0) : 0,
			});
		}

		return payments;
	}
}
