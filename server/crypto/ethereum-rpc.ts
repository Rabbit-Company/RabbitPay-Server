import { JsonRpcClient } from "./rpc";
import type { AddressTransfer, EthereumChainClient } from "./etherscan";
import { ChainStatusError, ethereumNetworkName, unusedEthereumAddress, type ChainProbe, type ChainStatus } from "./chain-status";

export function syntheticHash(address: string): string {
	return `balance:${address.toLowerCase()}`;
}

export class EthereumRpcClient implements EthereumChainClient, ChainProbe {
	private readonly rpc: JsonRpcClient;
	private readonly confirmations: number;
	private readonly chainId: number | undefined;

	constructor(options: { url: string; username?: string; password?: string; confirmations: number; chainId?: number; timeoutMs?: number }) {
		this.rpc = new JsonRpcClient(options);
		this.confirmations = Math.max(options.confirmations, 0);
		this.chainId = options.chainId;
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

	async status(): Promise<ChainStatus> {
		const chainId = Number(BigInt(await this.rpc.call<string>("eth_chainId", [])));
		if (this.chainId !== undefined && chainId !== this.chainId) {
			throw new ChainStatusError(`The node is on ${ethereumNetworkName(chainId)} with chain id ${chainId}, but Chain id is set to ${this.chainId}.`);
		}

		const height = await this.tipHeight();
		const syncing = await this.rpc.call<unknown>("eth_syncing", []);
		await this.balanceAt(unusedEthereumAddress(), `0x${Math.max(height - this.confirmations, 0).toString(16)}`);

		return {
			network: ethereumNetworkName(chainId),
			height,
			warnings: syncing === false ? [] : ["The node is still syncing. Payments are seen once it catches up."],
		};
	}
}
