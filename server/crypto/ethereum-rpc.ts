import { JsonRpcClient } from "./rpc";
import type { AddressTransfer, EthereumChainClient } from "./etherscan";

export function syntheticHash(address: string): string {
	return `balance:${address.toLowerCase()}`;
}

export class EthereumRpcClient implements EthereumChainClient {
	private readonly rpc: JsonRpcClient;
	private readonly confirmations: number;

	constructor(options: { url: string; username?: string; password?: string; confirmations: number; timeoutMs?: number }) {
		this.rpc = new JsonRpcClient(options);
		this.confirmations = Math.max(options.confirmations, 0);
	}

	private async balanceAt(address: string, block: string): Promise<bigint> {
		return BigInt(await this.rpc.call<string>("eth_getBalance", [address, block]));
	}

	async tipHeight(): Promise<number> {
		return Number(BigInt(await this.rpc.call<string>("eth_blockNumber", [])));
	}

	async transfersTo(address: string): Promise<AddressTransfer[]> {
		const tip = await this.tipHeight();
		const settledBlock = Math.max(tip - this.confirmations, 0);

		const confirmed = await this.balanceAt(address, `0x${settledBlock.toString(16)}`);
		if (confirmed > 0n) return [{ hash: syntheticHash(address), value: confirmed, confirmations: this.confirmations }];

		const pending = await this.balanceAt(address, "latest");
		if (pending > 0n) return [{ hash: syntheticHash(address), value: pending, confirmations: 0 }];

		return [];
	}
}
