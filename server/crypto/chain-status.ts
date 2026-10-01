import * as bitcoin from "bitcoinjs-lib";
import { RpcError } from "./rpc";

export interface ChainStatus {
	network: string | null;
	height: number | null;
	warnings: string[];
}

export interface ChainProbe {
	status(): Promise<ChainStatus>;
}

export class ChainStatusError extends Error {}

export interface BitcoinNetwork {
	name: string;
	params: bitcoin.Network;
}

const BITCOIN_NETWORK_BY_GENESIS: Record<string, BitcoinNetwork> = {
	"000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f": { name: "mainnet", params: bitcoin.networks.bitcoin },
	"000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943": { name: "testnet", params: bitcoin.networks.testnet },
	"00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043": { name: "testnet4", params: bitcoin.networks.testnet },
	"00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6": { name: "signet", params: bitcoin.networks.testnet },
	"0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206": { name: "regtest", params: bitcoin.networks.regtest },
};

const BITCOIN_CORE_CHAINS: Record<string, string> = { main: "mainnet", test: "testnet" };

const ETHEREUM_NETWORKS: Record<number, string> = { 1: "mainnet", 17000: "Holesky", 560048: "Hoodi", 11155111: "Sepolia" };

export function bitcoinNetworkOf(genesisHash: string): BitcoinNetwork | undefined {
	return BITCOIN_NETWORK_BY_GENESIS[genesisHash.trim().toLowerCase()];
}

export function bitcoinCoreNetworkName(chain: string): string {
	return BITCOIN_CORE_CHAINS[chain] ?? chain;
}

export function ethereumNetworkName(chainId: number): string {
	return ETHEREUM_NETWORKS[chainId] ?? `chain ${chainId}`;
}

export function unusedBitcoinAddress(network: bitcoin.Network): string {
	return bitcoin.payments.p2wpkh({ hash: crypto.getRandomValues(new Uint8Array(20)), network }).address!;
}

export function unusedEthereumAddress(): string {
	return `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString("hex")}`;
}

export function failureReason(err: unknown): string {
	if (err instanceof RpcError && err.code === 401) return "The node rejected the RPC username or password.";
	if (err instanceof RpcError && err.code === 403) return "The node refused this server. Check which addresses it allows to connect.";
	if (err instanceof Error && err.name === "TimeoutError") return "No answer in time. Check the address and that the service is running.";
	return err instanceof Error ? err.message : String(err);
}
