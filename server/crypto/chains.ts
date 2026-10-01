import { Settings, type ServerSettings } from "../settings";
import { EsploraClient, type ChainClient } from "./esplora";
import { BitcoinRpcClient } from "./bitcoin-rpc";
import { EtherscanClient, type EthereumChainClient } from "./etherscan";
import { EthereumRpcClient } from "./ethereum-rpc";
import { MoneroWalletRpc, type MoneroWallet } from "./monero-rpc";
import type { ChainProbe } from "./chain-status";
import { StripeApiClient, type StripeClient } from "../processors/stripe";
import { PaypalApiClient, type PaypalClient } from "../processors/paypal";

let bitcoin: ChainClient | null = null;
let ethereum: EthereumChainClient | null = null;

export function bitcoinBackend(): "rpc" | "esplora" {
	return Settings.btc?.backend === "rpc" ? "rpc" : "esplora";
}

export function ethereumBackend(): "rpc" | "etherscan" {
	return Settings.eth?.backend === "rpc" ? "rpc" : "etherscan";
}

export function bitcoinClientFor(config: ServerSettings["btc"]): ChainClient & ChainProbe {
	return config.backend === "rpc"
		? new BitcoinRpcClient({
				url: config.rpc_url || "http://127.0.0.1:8332",
				username: config.rpc_username,
				password: config.rpc_password,
				wallet: config.rpc_wallet,
			})
		: new EsploraClient(config.api_url || "https://mempool.space/api");
}

export function ethereumClientFor(config: ServerSettings["eth"]): EthereumChainClient & ChainProbe {
	return config.backend === "rpc"
		? new EthereumRpcClient({
				url: config.rpc_url || "http://127.0.0.1:8545",
				username: config.rpc_username,
				password: config.rpc_password,
				confirmations: config.confirmations ?? 12,
				chainId: config.chain_id || 1,
			})
		: new EtherscanClient(config.api_url || "https://api.etherscan.io/v2/api", config.api_key || "", config.chain_id || 1);
}

export function bitcoinChain(): ChainClient {
	if (!bitcoin) bitcoin = bitcoinClientFor(Settings.btc);
	return bitcoin;
}

export function ethereumChain(): EthereumChainClient {
	if (!ethereum) ethereum = ethereumClientFor(Settings.eth);
	return ethereum;
}

export interface MoneroWalletConfig {
	wallet_rpc_url?: string;
	rpc_username?: string;
	rpc_password?: string;
}

type MoneroWalletFactory = (config: MoneroWalletConfig) => MoneroWallet;

let moneroFactory: MoneroWalletFactory | null = null;
const moneroWallets = new Map<string, MoneroWallet>();

export function setMoneroWalletFactory(factory: MoneroWalletFactory | null) {
	moneroFactory = factory;
	moneroWallets.clear();
}

export function moneroWalletFor(config: MoneroWalletConfig): MoneroWallet {
	if (moneroFactory) return moneroFactory(config);
	if (!config.wallet_rpc_url) throw new Error("No Monero wallet RPC is configured for this project");

	const key = `${config.wallet_rpc_url}\n${config.rpc_username ?? ""}\n${config.rpc_password ?? ""}`;
	const cached = moneroWallets.get(key);
	if (cached) return cached;

	const wallet = new MoneroWalletRpc({ url: config.wallet_rpc_url, username: config.rpc_username, password: config.rpc_password });
	moneroWallets.set(key, wallet);
	return wallet;
}

export function stripeClient(config: Record<string, string>): StripeClient {
	return new StripeApiClient({ baseUrl: Settings.stripe?.api_url, secretKey: config.secret_key || "" });
}

export function paypalClient(config: Record<string, string>): PaypalClient {
	return new PaypalApiClient({
		baseUrl: Settings.paypal?.api_url,
		clientId: config.client_id || "",
		clientSecret: config.client_secret || "",
		webhookId: config.webhook_id || "",
	});
}

export function resetChains() {
	bitcoin = null;
	ethereum = null;
	moneroWallets.clear();
}
