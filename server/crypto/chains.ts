import { Settings } from "../settings";
import { EsploraClient, type ChainClient } from "./esplora";
import { BitcoinRpcClient } from "./bitcoin-rpc";
import { EtherscanClient, type EthereumChainClient } from "./etherscan";
import { EthereumRpcClient } from "./ethereum-rpc";
import { MoneroWalletRpc, type MoneroWallet } from "./monero-rpc";
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

export function bitcoinChain(): ChainClient {
	if (bitcoin) return bitcoin;

	bitcoin =
		bitcoinBackend() === "rpc"
			? new BitcoinRpcClient({
					url: Settings.btc?.rpc_url || "http://127.0.0.1:8332",
					username: Settings.btc?.rpc_username,
					password: Settings.btc?.rpc_password,
					wallet: Settings.btc?.rpc_wallet,
				})
			: new EsploraClient(Settings.btc?.api_url || "https://mempool.space/api");

	return bitcoin;
}

export function ethereumChain(): EthereumChainClient {
	if (ethereum) return ethereum;

	ethereum =
		ethereumBackend() === "rpc"
			? new EthereumRpcClient({
					url: Settings.eth?.rpc_url || "http://127.0.0.1:8545",
					username: Settings.eth?.rpc_username,
					password: Settings.eth?.rpc_password,
					confirmations: Settings.eth?.confirmations ?? 12,
				})
			: new EtherscanClient(Settings.eth?.api_url || "https://api.etherscan.io/api", Settings.eth?.api_key || "");

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
