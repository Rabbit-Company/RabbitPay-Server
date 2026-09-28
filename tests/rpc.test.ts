import { describe, expect, test, afterAll } from "bun:test";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://:memory:`);

const { BitcoinRpcClient, toSatoshis } = await import("../server/crypto/bitcoin-rpc");
const { EthereumRpcClient, syntheticHash } = await import("../server/crypto/ethereum-rpc");
const { MoneroWalletRpc, PICONERO_PER_XMR } = await import("../server/crypto/monero-rpc");
const { JsonRpcClient, RpcError } = await import("../server/crypto/rpc");

interface RecordedCall {
	method: string;
	params: any;
	auth: string | null;
	path: string;
}

const calls: RecordedCall[] = [];
let handler: (method: string, params: any) => unknown = () => ({});
let httpStatus = 200;

const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const body = (await request.json()) as { id: number; method: string; params: any };
		calls.push({
			method: body.method,
			params: body.params,
			auth: request.headers.get("authorization"),
			path: new URL(request.url).pathname,
		});

		let result: unknown;
		try {
			result = handler(body.method, body.params);
		} catch (err) {
			return Response.json({ id: body.id, error: { code: -32000, message: String(err) } }, { status: 500 });
		}

		return Response.json({ id: body.id, jsonrpc: "2.0", result }, { status: httpStatus });
	},
});

const base = `http://127.0.0.1:${server.port}`;

afterAll(() => server.stop(true));

function reset(next: (method: string, params: any) => unknown) {
	calls.length = 0;
	handler = next;
	httpStatus = 200;
}

describe("json rpc transport", () => {
	test("sends basic auth when credentials are given", async () => {
		reset(() => 1);
		await new JsonRpcClient({ url: base, username: "user", password: "pass" }).call("ping");

		expect(calls[0].auth).toBe(`Basic ${btoa("user:pass")}`);
	});

	test("sends no auth header without credentials", async () => {
		reset(() => 1);
		await new JsonRpcClient({ url: base }).call("ping");
		expect(calls[0].auth).toBeNull();
	});

	test("surfaces an rpc error rather than returning undefined", async () => {
		reset(() => {
			throw new Error("wallet is locked");
		});

		await expect(new JsonRpcClient({ url: base }).call("ping")).rejects.toThrow(RpcError);
	});
});

describe("bitcoin core backend", () => {
	test("reads the tip from getblockcount", async () => {
		reset((method) => (method === "getblockcount" ? 870123 : {}));
		expect(await new BitcoinRpcClient({ url: base }).tipHeight()).toBe(870123);
	});

	test("addresses the configured wallet in the url", async () => {
		reset((method) => (method === "getblockcount" ? 1 : {}));
		await new BitcoinRpcClient({ url: base, wallet: "rabbitpay" }).tipHeight();

		expect(calls[0].path).toBe("/wallet/rabbitpay");
	});

	test("converts bitcoin amounts to whole satoshis", () => {
		expect(toSatoshis(0.0001)).toBe(10000);
		expect(toSatoshis(1)).toBe(100000000);
		expect(toSatoshis(0.00000001)).toBe(1);
	});

	test("lists only receives paying the watched address", async () => {
		const address = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

		reset((method, params) => {
			if (method === "listreceivedbyaddress") {
				expect(params[3]).toBe(address);
				return [{ address, txids: ["tx-a", "tx-b"] }];
			}
			if (method === "gettransaction") {
				return params[0] === "tx-a"
					? {
							confirmations: 6,
							details: [
								{ address, category: "receive", amount: 0.005 },
								{ address: "bc1qother", category: "receive", amount: 9 },
								{ address, category: "send", amount: -1 },
							],
						}
					: { confirmations: 0, details: [{ address, category: "receive", amount: 0.001 }] };
			}
			return {};
		});

		const payments = await new BitcoinRpcClient({ url: base }).paymentsTo(address, 0);

		expect(payments).toHaveLength(2);
		expect(payments[0]).toEqual({ txid: "tx-a", value: 500000, confirmations: 6 });
		expect(payments[1]).toEqual({ txid: "tx-b", value: 100000, confirmations: 0 });
	});

	test("returns nothing for an address the wallet does not know", async () => {
		reset((method) => (method === "listreceivedbyaddress" ? [] : {}));
		expect(await new BitcoinRpcClient({ url: base }).paymentsTo("bc1qunknown", 0)).toHaveLength(0);
	});

	test("imports an address as a descriptor when watching", async () => {
		reset((method) => {
			if (method === "getdescriptorinfo") return { descriptor: "addr(bc1qexample)#checksum" };
			return {};
		});

		await new BitcoinRpcClient({ url: base }).watch("bc1qexample", "INVOICE-1");

		expect(calls.map((call) => call.method)).toEqual(["getdescriptorinfo", "importdescriptors"]);
		expect(calls[1].params[0][0].desc).toBe("addr(bc1qexample)#checksum");
		expect(calls[1].params[0][0].timestamp).toBe("now");
	});

	test("falls back to importaddress on a legacy wallet", async () => {
		reset((method) => {
			if (method === "getdescriptorinfo") throw new Error("Only legacy wallets are supported");
			return {};
		});

		await new BitcoinRpcClient({ url: base }).watch("bc1qexample", "INVOICE-1");

		expect(calls.map((call) => call.method)).toEqual(["getdescriptorinfo", "importaddress"]);
		expect(calls[1].params).toEqual(["bc1qexample", "INVOICE-1", false]);
	});
});

describe("ethereum node backend", () => {
	const address = "0x9858effd232b4033e47d90003d41ec34ecaeda94";
	const oneEther = 10n ** 18n;

	test("reports a confirmed balance as settled", async () => {
		reset((method, params) => {
			if (method === "eth_blockNumber") return "0x100";
			if (method === "eth_getBalance") return params[1] === "0xf4" ? `0x${oneEther.toString(16)}` : "0x0";
			return {};
		});

		const transfers = await new EthereumRpcClient({ url: base, confirmations: 12 }).transfersTo(address);

		expect(transfers).toHaveLength(1);
		expect(transfers[0].value).toBe(oneEther);
		expect(transfers[0].confirmations).toBe(12);
		expect(transfers[0].hash).toBe(syntheticHash(address));
	});

	test("reports an unconfirmed balance with zero confirmations", async () => {
		reset((method, params) => {
			if (method === "eth_blockNumber") return "0x100";
			if (method === "eth_getBalance") return params[1] === "latest" ? `0x${oneEther.toString(16)}` : "0x0";
			return {};
		});

		const transfers = await new EthereumRpcClient({ url: base, confirmations: 12 }).transfersTo(address);

		expect(transfers).toHaveLength(1);
		expect(transfers[0].confirmations).toBe(0);
	});

	test("reports nothing for an empty address", async () => {
		reset((method) => (method === "eth_blockNumber" ? "0x100" : "0x0"));
		expect(await new EthereumRpcClient({ url: base, confirmations: 12 }).transfersTo(address)).toHaveLength(0);
	});

	test("keeps full precision on balances beyond a safe integer", async () => {
		const huge = 123456789012345678901234n;

		reset((method, params) => {
			if (method === "eth_blockNumber") return "0x100";
			if (method === "eth_getBalance") return params[1] === "latest" ? `0x${huge.toString(16)}` : "0x0";
			return {};
		});

		const transfers = await new EthereumRpcClient({ url: base, confirmations: 12 }).transfersTo(address);
		expect(transfers[0].value).toBe(huge);
	});

	test("gives a stable hash so a payment is not recorded twice", () => {
		expect(syntheticHash(address)).toBe(syntheticHash(address.toUpperCase()));
	});
});

describe("monero wallet backend", () => {
	test("appends json_rpc to a bare url", async () => {
		reset(() => ({ account_index: 3 }));
		await new MoneroWalletRpc({ url: base }).createAccount("shop");

		expect(calls[0].path).toBe("/json_rpc");
	});

	test("does not double up json_rpc when already given", async () => {
		reset(() => ({ account_index: 3 }));
		await new MoneroWalletRpc({ url: `${base}/json_rpc` }).createAccount("shop");

		expect(calls[0].path).toBe("/json_rpc");
	});

	test("creates an account and returns its index", async () => {
		reset(() => ({ account_index: 7 }));
		expect(await new MoneroWalletRpc({ url: base }).createAccount("shop")).toBe(7);
	});

	test("creates a subaddress within an account", async () => {
		reset(() => ({ address: "8Abc...", address_index: 4 }));

		const subaddress = await new MoneroWalletRpc({ url: base }).createSubaddress(7, "INVOICE-1");

		expect(subaddress).toEqual({ address: "8Abc...", accountIndex: 7, addressIndex: 4 });
		expect(calls[0].params).toEqual({ account_index: 7, label: "INVOICE-1" });
	});

	test("reads incoming transfers including the pool", async () => {
		reset(() => ({
			in: [{ txid: "tx-a", amount: Number(PICONERO_PER_XMR), confirmations: 12, subaddr_index: { major: 1, minor: 2 } }],
			pool: [{ txid: "tx-b", amount: "500000000000", confirmations: 0, subaddr_index: { major: 1, minor: 3 } }],
		}));

		const transfers = await new MoneroWalletRpc({ url: base }).incomingTransfers(1);

		expect(transfers).toHaveLength(2);
		expect(transfers[0]).toEqual({ txid: "tx-a", amount: PICONERO_PER_XMR, confirmations: 12, addressIndex: 2 });
		expect(transfers[1]).toEqual({ txid: "tx-b", amount: 500000000000n, confirmations: 0, addressIndex: 3 });
	});

	test("ignores entries with no amount or no id", async () => {
		reset(() => ({
			in: [
				{ txid: "tx-a", amount: 0, confirmations: 5, subaddr_index: { minor: 1 } },
				{ amount: 100, confirmations: 5, subaddr_index: { minor: 1 } },
			],
		}));

		expect(await new MoneroWalletRpc({ url: base }).incomingTransfers(1)).toHaveLength(0);
	});

	test("raises when the wallet rejects the call", async () => {
		reset(() => {
			throw new Error("No wallet file");
		});

		await expect(new MoneroWalletRpc({ url: base }).incomingTransfers(0)).rejects.toThrow();
	});
});
