import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.chain-status.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { Settings } = await import("../server/settings");
const { EsploraClient } = await import("../server/crypto/esplora");
const { BitcoinRpcClient } = await import("../server/crypto/bitcoin-rpc");
const { EtherscanClient } = await import("../server/crypto/etherscan");
const { EthereumRpcClient } = await import("../server/crypto/ethereum-rpc");

await Server.configure();

const MAINNET_GENESIS = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
const SIGNET_GENESIS = "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6";

const password = (seed: string) => new Bun.CryptoHasher("blake2b512").update(seed).digest("hex");

interface ApiResponse {
	status: number;
	error: number;
	info: string;
	data?: any;
}

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<ApiResponse> {
	const headers: Record<string, string> = {};
	if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
	if (options.body !== undefined) headers["Content-Type"] = "application/json";

	const res = await Server.app.handle(
		new Request(`http://127.0.0.1${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
	);

	const json = (await res.json()) as { error: number; info: string; data?: unknown };
	return { status: res.status, ...json };
}

async function account(name: string): Promise<string> {
	await call("POST", "/api/v1/auth/register", { body: { email: `${name}@example.com`, password: password(name) } });
	return (await call("POST", "/api/v1/auth/login", { body: { email: `${name}@example.com`, password: password(name) } })).data.token;
}

class RpcFailure extends Error {
	constructor(
		readonly code: number,
		message: string
	) {
		super(message);
	}
}

const requests: { path: string; query: URLSearchParams; method: string | null; auth: string | null }[] = [];
let genesis = MAINNET_GENESIS;
let etherscanAnswer: unknown = { status: "0", message: "No transactions found", result: "No transactions found" };
let rpc: (method: string, params: any) => unknown = () => ({});
let rpcPassword: string | null = null;
let rpcFailureStatus = 500;

const upstream = Bun.serve({
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const auth = request.headers.get("authorization");

		if (request.method === "POST") {
			const body = (await request.json()) as { id: number; method: string; params: any };
			requests.push({ path: url.pathname, query: url.searchParams, method: body.method, auth });
			if (rpcPassword !== null && auth !== `Basic ${btoa(`rabbit:${rpcPassword}`)}`) return new Response("", { status: 401 });
			try {
				return Response.json({ id: body.id, jsonrpc: "2.0", result: rpc(body.method, body.params) });
			} catch (err) {
				const failure = err as RpcFailure;
				return Response.json({ id: body.id, error: { code: failure.code ?? -32000, message: failure.message } }, { status: rpcFailureStatus });
			}
		}

		requests.push({ path: url.pathname, query: url.searchParams, method: null, auth });
		if (url.pathname === "/esplora/blocks/tip/height") return new Response("870123");
		if (url.pathname === "/esplora/block-height/0") return new Response(genesis);
		if (url.pathname.startsWith("/esplora/address/")) return Response.json([]);
		if (url.pathname === "/etherscan") return Response.json(etherscanAnswer);
		return new Response("Not found", { status: 404 });
	},
});

const base = `http://127.0.0.1:${upstream.port}`;

function reset() {
	requests.length = 0;
	genesis = MAINNET_GENESIS;
	etherscanAnswer = { status: "0", message: "No transactions found", result: "No transactions found" };
	rpc = () => ({});
	rpcPassword = null;
	rpcFailureStatus = 500;
}

function bitcoinCore(overrides: { chain?: Record<string, unknown>; wallet?: Record<string, unknown> | RpcFailure } = {}) {
	return (method: string) => {
		if (method === "getblockchaininfo") return { chain: "main", blocks: 870123, headers: 870123, initialblockdownload: false, ...overrides.chain };
		if (method === "getwalletinfo") {
			if (overrides.wallet instanceof RpcFailure) throw overrides.wallet;
			return { walletname: "rabbitpay", descriptors: true, private_keys_enabled: false, ...overrides.wallet };
		}
		throw new RpcFailure(-32601, `Method ${method} not found`);
	};
}

function ethereumNode(overrides: { chainId?: number; syncing?: unknown; height?: number } = {}) {
	return (method: string) => {
		if (method === "eth_chainId") return `0x${(overrides.chainId ?? 1).toString(16)}`;
		if (method === "eth_blockNumber") return `0x${(overrides.height ?? 21000000).toString(16)}`;
		if (method === "eth_syncing") return overrides.syncing ?? false;
		if (method === "eth_getBalance") return "0x0";
		throw new RpcFailure(-32601, `Method ${method} not found`);
	};
}

let adminToken = "";
let memberToken = "";

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	adminToken = await account("chain-admin");
	memberToken = await account("chain-member");
});

afterAll(async () => {
	upstream.stop(true);
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.chain-status.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("esplora status", () => {
	test("reports the network and tip, and looks up an address on that network", async () => {
		reset();
		const status = await new EsploraClient(`${base}/esplora`).status();

		expect(status).toEqual({ network: "mainnet", height: 870123, warnings: [] });
		const lookup = requests.find((request) => request.path.startsWith("/esplora/address/"));
		expect(lookup?.path).toMatch(/^\/esplora\/address\/bc1q[0-9a-z]+\/txs$/);
	});

	test("uses a test network address on signet", async () => {
		reset();
		genesis = SIGNET_GENESIS;
		const status = await new EsploraClient(`${base}/esplora`).status();

		expect(status.network).toBe("signet");
		expect(requests.some((request) => request.path.startsWith("/esplora/address/tb1q"))).toBe(true);
	});

	test("warns about a chain it does not know without looking up an address", async () => {
		reset();
		genesis = "00".repeat(32);
		const status = await new EsploraClient(`${base}/esplora`).status();

		expect(status.network).toBeNull();
		expect(status.warnings).toHaveLength(1);
		expect(requests.some((request) => request.path.startsWith("/esplora/address/"))).toBe(false);
	});

	test("fails when the API does not answer like Esplora", async () => {
		reset();
		await expect(new EsploraClient(`${base}/nothing`).status()).rejects.toThrow("404");
	});
});

describe("bitcoin core status", () => {
	const client = () => new BitcoinRpcClient({ url: base, wallet: "rabbitpay" });

	test("reports the network and tip through the wallet endpoint", async () => {
		reset();
		rpc = bitcoinCore();

		expect(await client().status()).toEqual({ network: "mainnet", height: 870123, warnings: [] });
		expect(requests.every((request) => request.path === "/wallet/rabbitpay")).toBe(true);
	});

	test("warns while the node is syncing", async () => {
		reset();
		rpc = bitcoinCore({ chain: { chain: "test", blocks: 100, headers: 2500000, initialblockdownload: true } });
		const status = await client().status();

		expect(status.network).toBe("testnet");
		expect(status.warnings[0]).toContain("block 100 of 2500000");
	});

	test("names the wallet when the node has not loaded it", async () => {
		reset();
		rpc = bitcoinCore({ wallet: new RpcFailure(-18, "Requested wallet does not exist or is not loaded") });
		await expect(client().status()).rejects.toThrow("no loaded wallet named rabbitpay");
	});

	test("asks for a wallet name when several are loaded", async () => {
		reset();
		rpc = bitcoinCore({ wallet: new RpcFailure(-19, "Wallet file not specified") });
		await expect(new BitcoinRpcClient({ url: base }).status()).rejects.toThrow("several wallets");
	});

	test("explains a node that does not offer wallet methods", async () => {
		reset();
		rpc = bitcoinCore({ wallet: new RpcFailure(-32601, "Method not found") });
		await expect(client().status()).rejects.toThrow("does not offer wallet methods");
	});

	test("explains a public node that blocks wallet methods with another http status", async () => {
		reset();
		rpcFailureStatus = 501;
		rpc = bitcoinCore({ wallet: new RpcFailure(-32701, "Method getwalletinfo is not allowed") });
		await expect(client().status()).rejects.toThrow("does not offer wallet methods");
	});

	test("refuses a descriptor wallet that holds private keys", async () => {
		reset();
		rpc = bitcoinCore({ wallet: { private_keys_enabled: true } });
		await expect(client().status()).rejects.toThrow("private keys");
	});

	test("accepts a legacy wallet that holds private keys", async () => {
		reset();
		rpc = bitcoinCore({ wallet: { descriptors: false, private_keys_enabled: true } });
		expect((await client().status()).warnings).toEqual([]);
	});
});

describe("ethereum node status", () => {
	test("reports the network and tip, and reads a balance at the settled block", async () => {
		reset();
		rpc = ethereumNode({ chainId: 11155111, height: 5000 });
		const status = await new EthereumRpcClient({ url: base, confirmations: 12, chainId: 11155111 }).status();

		expect(status).toEqual({ network: "Sepolia", height: 5000, warnings: [] });
		expect(requests.map((request) => request.method)).toContain("eth_getBalance");
	});

	test("fails when the node is on another chain than the configured chain id", async () => {
		reset();
		rpc = ethereumNode({ chainId: 11155111 });
		await expect(new EthereumRpcClient({ url: base, confirmations: 12, chainId: 1 }).status()).rejects.toThrow("Sepolia");
	});

	test("warns while the node is syncing", async () => {
		reset();
		rpc = ethereumNode({ syncing: { currentBlock: "0x10", highestBlock: "0x1000" } });
		const status = await new EthereumRpcClient({ url: base, confirmations: 12, chainId: 1 }).status();
		expect(status.warnings).toHaveLength(1);
	});
});

describe("etherscan status", () => {
	test("passes when an address lookup is answered", async () => {
		reset();
		const status = await new EtherscanClient(`${base}/etherscan`, "key", 11155111).status();

		expect(status).toEqual({ network: null, height: null, warnings: [] });
		expect(requests[0].query.get("action")).toBe("txlist");
		expect(requests[0].query.get("chainid")).toBe("11155111");
		expect(requests[0].query.get("apikey")).toBe("key");
	});

	test("fails with the reason the API gives", async () => {
		reset();
		etherscanAnswer = { status: "0", message: "NOTOK", result: "Missing/Invalid API Key" };
		await expect(new EtherscanClient(`${base}/etherscan`).status()).rejects.toThrow("Missing/Invalid API Key");
	});
});

describe("testing settings as an administrator", () => {
	const testSettings = (group: string, values?: Record<string, unknown>, token = adminToken) =>
		call("POST", `/api/v1/admin/settings/${group}/test`, { token, body: values === undefined ? {} : { values } });

	test("is refused for anyone else", async () => {
		expect((await testSettings("btc", {}, memberToken)).status).toBe(403);
	});

	test("fails with the saved settings that point nowhere", async () => {
		reset();
		const res = await testSettings("btc");
		expect(res.status).toBe(502);
		expect(res.error).toBe(1282);
		expect(requests).toHaveLength(0);
	});

	test("uses unsaved values without storing them", async () => {
		reset();
		const res = await testSettings("btc", { "btc.api_url": `${base}/esplora` });

		expect(res.error).toBe(0);
		expect(res.data).toEqual({ network: "mainnet", height: 870123, warnings: [] });
		expect(Settings.btc.api_url).not.toContain(String(upstream.port));
	});

	test("switches backend and sends an unsaved password", async () => {
		reset();
		rpc = bitcoinCore();
		rpcPassword = "hunter2";
		const values = { "btc.backend": "rpc", "btc.rpc_url": base, "btc.rpc_username": "rabbit", "btc.rpc_wallet": "rabbitpay" };

		const refused = await testSettings("btc", { ...values, "btc.rpc_password": "wrong" });
		expect(refused.error).toBe(1282);
		expect(refused.info).toContain("username or password");

		const accepted = await testSettings("btc", { ...values, "btc.rpc_password": "hunter2" });
		expect(accepted.error).toBe(0);
		expect(Settings.btc.backend).toBe("esplora");
		expect(Settings.btc.rpc_password).toBe("");
	});

	test("keeps the stored password when the field is left blank", async () => {
		reset();
		rpc = bitcoinCore();
		rpcPassword = "stored-secret";
		const values = { "btc.backend": "rpc", "btc.rpc_url": base, "btc.rpc_username": "rabbit", "btc.rpc_wallet": "rabbitpay" };
		await call("PATCH", "/api/v1/admin/settings", { token: adminToken, body: { values: { "btc.rpc_password": "stored-secret" } } });

		expect((await testSettings("btc", { ...values, "btc.rpc_password": "" })).error).toBe(0);
		expect((await testSettings("btc", { ...values, "btc.rpc_password": null })).error).toBe(1282);

		await call("PATCH", "/api/v1/admin/settings", { token: adminToken, body: { values: { "btc.rpc_password": null } } });
	});

	test("checks the unsaved chain id against an Ethereum node", async () => {
		reset();
		rpc = ethereumNode({ chainId: 11155111 });
		const values = { "eth.backend": "rpc", "eth.rpc_url": base };

		const mismatch = await testSettings("eth", values);
		expect(mismatch.error).toBe(1282);
		expect(mismatch.info).toContain("Chain id is set to 1");

		const matching = await testSettings("eth", { ...values, "eth.chain_id": 11155111 });
		expect(matching.error).toBe(0);
		expect(matching.data.network).toBe("Sepolia");
	});

	test("tests the Etherscan API", async () => {
		reset();
		const res = await testSettings("eth", { "eth.api_url": `${base}/etherscan`, "eth.chain_id": 17000 });
		expect(res.error).toBe(0);
		expect(requests[0].query.get("chainid")).toBe("17000");
		expect(res.data).toEqual({ network: null, height: null, warnings: [] });
	});

	test("refuses sections without a test, unknown keys and invalid values", async () => {
		expect((await testSettings("email")).error).toBe(1099);
		expect((await testSettings("btc", { "btc.nothing": 1 })).error).toBe(1099);
		expect((await testSettings("btc", { "btc.confirmations": -1 })).error).toBe(1099);
	});
});
