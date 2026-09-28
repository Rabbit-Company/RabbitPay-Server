import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import type { AddressTransfer, EthereumChainClient } from "../server/crypto/etherscan";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.ethereum.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { minorUnitsFor, watchAddresses, weiFor, toGwei, WEI_PER_ETHER } = await import("../server/payments/ethereum");
const { EtherscanClient } = await import("../server/crypto/etherscan");

await Server.configure();

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

class FakeChain implements EthereumChainClient {
	transfers = new Map<string, AddressTransfer[]>();

	async transfersTo(address: string) {
		return this.transfers.get(address) ?? [];
	}

	send(address: string, wei: bigint, confirmations: number, hash = `0x${crypto.randomUUID().replace(/-/g, "")}`) {
		const list = this.transfers.get(address) ?? [];
		list.push({ hash, value: wei, confirmations });
		this.transfers.set(address, list);
		return hash;
	}

	confirm(address: string, hash: string, confirmations: number) {
		for (const transfer of this.transfers.get(address) ?? []) if (transfer.hash === hash) transfer.confirmations = confirmations;
	}
}

let sessionToken = "";
let apiKey = "";
let projectUuid = "";

const RATE = 2000;
const dueDate = () => Date.now() + 7 * 24 * 60 * 60 * 1000;

async function issueInvoice(unitPrice: number) {
	const created = await call("POST", "/api/v1/pay/invoices", {
		token: apiKey,
		body: { currency: "EUR", due_date: dueDate(), items: [{ description: "Work", quantity: 1, unit_price: unitPrice }] },
	});
	return created.data.uuid as string;
}

function requestAddress(invoice: string, rate = RATE) {
	return call("POST", `/api/v1/pay/invoices/${invoice}/ethereum`, { token: apiKey, body: { exchange_rate: rate } });
}

function invoiceOf(uuid: string) {
	return call("GET", `/api/v1/pay/invoices/${uuid}`, { token: apiKey });
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	await call("POST", "/api/v1/auth/register", { body: { username: "eth-owner", email: "eth@example.com", password: password("owner") } });
	sessionToken = (await call("POST", "/api/v1/auth/login", { body: { username: "eth-owner", password: password("owner") } })).data.token;

	const project = await call("POST", "/api/v1/projects", { token: sessionToken, body: { name: "eth-shop" } });
	projectUuid = project.data.uuid;
	apiKey = project.data.apikey;
	await connectWallet(projectUuid, WALLET_KEY);
});

const WALLET_KEY = "xpub6DCoCpSuQZB2jawqnGMEPS63ePKWkwWPH4TU45Q7LPXWuNd8TMtVxRrgjtEshuqpK3mdhaWHPFsBngh5GFZaM6si3yZdUsT8ddYM3PwnATt";
const FIRST_ADDRESS = "0x9858effd232b4033e47d90003d41ec34ecaeda94";

async function connectWallet(project: string, key: string) {
	const res = await call("PUT", `/api/v1/projects/${project}/processors/ethereum`, { token: sessionToken, body: { enabled: true, config: { xpub: key } } });
	if (res.error !== 0) throw new Error(res.info);
}

describe("watch-only wallet", () => {
	test("the first invoice gets the first address of the project's own key", async () => {
		const res = await requestAddress(await issueInvoice(10000));
		expect(res.data.address.toLowerCase()).toBe(FIRST_ADDRESS);
		const [row] = (await Database`SELECT wallet_key FROM crypto_addresses WHERE address = ${res.data.address}`) as { wallet_key: string }[];
		expect(row.wallet_key).toHaveLength(32);
	});

	test("a project without its own wallet cannot take ethereum", async () => {
		const bare = await call("POST", "/api/v1/projects", { token: sessionToken, body: { name: "eth-bare-shop" } });
		const invoice = await call("POST", "/api/v1/pay/invoices", {
			token: bare.data.apikey,
			body: { currency: "EUR", due_date: dueDate(), items: [{ description: "Work", quantity: 1, unit_price: 100 }] },
		});
		const res = await call("POST", `/api/v1/pay/invoices/${invoice.data.uuid}/ethereum`, { token: bare.data.apikey, body: { exchange_rate: RATE } });
		expect(res.error).toBe(1054);
	});

	test("two projects sharing a key never get the same address", async () => {
		const twin = await call("POST", "/api/v1/projects", { token: sessionToken, body: { name: "eth-twin-shop" } });
		await connectWallet(twin.data.uuid, WALLET_KEY);
		const invoice = await call("POST", "/api/v1/pay/invoices", {
			token: twin.data.apikey,
			body: { currency: "EUR", due_date: dueDate(), items: [{ description: "Work", quantity: 1, unit_price: 100 }] },
		});
		const theirs = await call("POST", `/api/v1/pay/invoices/${invoice.data.uuid}/ethereum`, { token: twin.data.apikey, body: { exchange_rate: RATE } });
		const [used] = (await Database`SELECT COUNT(*) AS count FROM crypto_addresses WHERE address = ${theirs.data.address}`) as { count: number }[];
		expect(Number(used.count)).toBe(1);
		expect(theirs.data.address.toLowerCase()).not.toBe(FIRST_ADDRESS);
	});
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.ethereum.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("amount conversion", () => {
	test("converts fiat minor units to wei", () => {
		expect(weiFor(200000, "EUR", 2000)).toBe(WEI_PER_ETHER);
		expect(weiFor(100000, "EUR", 2000)).toBe(WEI_PER_ETHER / 2n);
	});

	test("rounds wei up so the payer never underpays", () => {
		expect(weiFor(1, "EUR", 2000) > 0n).toBe(true);
	});

	test("converts wei back to fiat minor units", () => {
		expect(minorUnitsFor(WEI_PER_ETHER, "EUR", 2000)).toBe(200000);
		expect(minorUnitsFor(WEI_PER_ETHER / 2n, "EUR", 2000)).toBe(100000);
	});

	test("handles amounts far beyond a 64 bit integer", () => {
		const hundredEther = WEI_PER_ETHER * 100n;
		expect(hundredEther > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
		expect(minorUnitsFor(hundredEther, "EUR", 2000)).toBe(20_000_000);
	});

	test("a round trip returns the original amount", () => {
		for (const minor of [100, 2500, 200000, 1234500]) {
			expect(minorUnitsFor(weiFor(minor, "EUR", RATE), "EUR", RATE)).toBe(minor);
		}
	});

	test("rounds credited fiat down so a project is never over credited", () => {
		expect(minorUnitsFor(1n, "EUR", 2000)).toBe(0);
	});
});

describe("address assignment", () => {
	test("assigns an address with the expected amount", async () => {
		const invoice = await issueInvoice(200000);
		const res = await requestAddress(invoice);

		expect(res.status).toBe(201);
		expect(res.data.address.startsWith("0x")).toBe(true);
		expect(res.data.amount_wei).toBe(WEI_PER_ETHER.toString());
		expect(res.data.chain_id).toBe(1);
		expect(res.data.confirmations_required).toBe(12);
		expect(res.data.uri).toBe(`ethereum:${res.data.address}@1?value=${WEI_PER_ETHER.toString()}`);
	});

	test("returns the same address while it is still live", async () => {
		const invoice = await issueInvoice(200000);
		const first = await requestAddress(invoice);
		const second = await requestAddress(invoice);
		expect(second.data.address).toBe(first.data.address);
	});

	test("keeps its own derivation index space, separate from bitcoin", async () => {
		const invoice = await issueInvoice(200000);
		await requestAddress(invoice);
		const bitcoin = await call("PUT", `/api/v1/projects/${projectUuid}/processors/bitcoin`, {
			token: sessionToken,
			body: {
				enabled: true,
				config: { xpub: "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs" },
			},
		});
		expect(bitcoin.error).toBe(0);
		await call("POST", `/api/v1/pay/invoices/${invoice}/bitcoin`, { token: apiKey, body: { exchange_rate: 50000 } });

		const rows = (await Database`
			SELECT currency, derivation_index FROM crypto_addresses WHERE project = ${projectUuid} ORDER BY currency, derivation_index
		`) as { currency: string; derivation_index: number }[];

		const bitcoinIndexes = rows.filter((row) => row.currency === "bitcoin").map((row) => row.derivation_index);
		const ethereum = rows.filter((row) => row.currency === "ethereum").map((row) => row.derivation_index);

		expect(bitcoinIndexes[0]).toBe(0);
		expect(ethereum[0]).toBe(0);
		expect(new Set(ethereum).size).toBe(ethereum.length);
	});

	test("requires an exchange rate", async () => {
		const invoice = await issueInvoice(200000);
		expect((await call("POST", `/api/v1/pay/invoices/${invoice}/ethereum`, { token: apiKey, body: {} })).error).toBe(1055);
		expect((await requestAddress(invoice, -1)).error).toBe(1055);
	});

	test("refuses an invoice that is not payable", async () => {
		const draft = await call("POST", "/api/v1/pay/invoices", {
			token: apiKey,
			body: { currency: "EUR", due_date: dueDate(), items: [{ description: "X", quantity: 1, unit_price: 100 }], status: "draft" },
		});
		expect((await requestAddress(draft.data.uuid)).error).toBe(1050);
	});
});

describe("watching for transfers", () => {
	test("an unconfirmed transfer does not settle the invoice", async () => {
		const invoice = await issueInvoice(200000);
		const address = (await requestAddress(invoice)).data.address;

		const chain = new FakeChain();
		chain.send(address, WEI_PER_ETHER, 1);
		await watchAddresses(chain);

		const after = await invoiceOf(invoice);
		expect(after.data.status).toBe("open");
		expect(after.data.paid_amount).toBe(0);

		const [tx] = (await Database`SELECT * FROM transactions WHERE invoice = ${invoice}`) as any[];
		expect(tx.status).toBe("pending");
		expect(tx.processor).toBe("ethereum");
		expect(JSON.parse(tx.payment_details).wei).toBe(WEI_PER_ETHER.toString());
	});

	test("reaching enough confirmations settles the invoice", async () => {
		const invoice = await issueInvoice(200000);
		const address = (await requestAddress(invoice)).data.address;

		const chain = new FakeChain();
		const hash = chain.send(address, WEI_PER_ETHER, 1);
		await watchAddresses(chain);
		expect((await invoiceOf(invoice)).data.status).toBe("open");

		chain.confirm(address, hash, 12);
		await watchAddresses(chain);

		const after = await invoiceOf(invoice);
		expect(after.data.status).toBe("paid");
		expect(after.data.paid_amount).toBe(200000);
	});

	test("does not create a second transaction for the same hash", async () => {
		const invoice = await issueInvoice(200000);
		const address = (await requestAddress(invoice)).data.address;

		const chain = new FakeChain();
		chain.send(address, WEI_PER_ETHER, 20);
		await watchAddresses(chain);
		await watchAddresses(chain);
		await watchAddresses(chain);

		const [row] = (await Database`SELECT COUNT(*) AS count FROM transactions WHERE invoice = ${invoice}`) as { count: number }[];
		expect(row.count).toBe(1);
	});

	test("an underpayment leaves the invoice partially paid", async () => {
		const invoice = await issueInvoice(200000);
		const address = (await requestAddress(invoice)).data.address;

		const chain = new FakeChain();
		chain.send(address, WEI_PER_ETHER / 4n, 20);
		await watchAddresses(chain);

		const after = await invoiceOf(invoice);
		expect(after.data.status).toBe("partially_paid");
		expect(after.data.paid_amount).toBe(50000);
	});

	test("two transfers to one address both credit", async () => {
		const invoice = await issueInvoice(200000);
		const address = (await requestAddress(invoice)).data.address;

		const chain = new FakeChain();
		chain.send(address, WEI_PER_ETHER / 2n, 20);
		chain.send(address, WEI_PER_ETHER / 2n, 20);
		await watchAddresses(chain);

		expect((await invoiceOf(invoice)).data.paid_amount).toBe(200000);
	});

	test("stops watching once satisfied", async () => {
		const invoice = await issueInvoice(200000);
		const address = (await requestAddress(invoice)).data.address;

		const chain = new FakeChain();
		chain.send(address, WEI_PER_ETHER, 20);
		await watchAddresses(chain);

		const [row] = (await Database`SELECT monitored, total_received FROM crypto_addresses WHERE address = ${address}`) as any[];
		expect(row.monitored).toBe(0);
		expect(row.total_received).toBe(toGwei(WEI_PER_ETHER));
	});

	test("a failing chain call does not lose other addresses", async () => {
		const invoice = await issueInvoice(200000);
		const address = (await requestAddress(invoice)).data.address;

		const chain = new FakeChain();
		chain.send(address, WEI_PER_ETHER, 20);

		const broken: EthereumChainClient = {
			transfersTo: async (target) => {
				if (target !== address) throw new Error("chain unavailable");
				return chain.transfersTo(target);
			},
		};

		await watchAddresses(broken);
		expect((await invoiceOf(invoice)).data.status).toBe("paid");
	});
});

describe("etherscan client", () => {
	const address = "0x9858effd232b4033e47d90003d41ec34ecaeda94";

	function withFetch(payload: unknown, run: () => Promise<void>, status = 200) {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch;
		return run().finally(() => {
			globalThis.fetch = original;
		});
	}

	test("keeps only successful inbound transfers", async () => {
		await withFetch(
			{
				status: "1",
				result: [
					{ hash: "0xa", to: address, value: "1000000000000000000", confirmations: "30", isError: "0" },
					{ hash: "0xb", to: "0xsomeoneelse", value: "500", confirmations: "30", isError: "0" },
					{ hash: "0xc", to: address, value: "2000", confirmations: "5", isError: "1" },
					{ hash: "0xd", to: address, value: "0", confirmations: "5", isError: "0" },
					{ hash: "0xe", to: address.toUpperCase(), value: "7", confirmations: "2", isError: "0" },
				],
			},
			async () => {
				const transfers = await new EtherscanClient("https://example.test/api").transfersTo(address);

				expect(transfers).toHaveLength(2);
				expect(transfers[0]).toEqual({ hash: "0xa", value: WEI_PER_ETHER, confirmations: 30 });
				expect(transfers[1].hash).toBe("0xe");
			}
		);
	});

	test("treats no transactions found as an empty result", async () => {
		await withFetch({ status: "0", message: "No transactions found", result: "No transactions found" }, async () => {
			expect(await new EtherscanClient("https://example.test/api").transfersTo(address)).toHaveLength(0);
		});
	});

	test("raises on a rate limit message instead of reporting no payments", async () => {
		await withFetch({ status: "0", result: "Max rate limit reached" }, async () => {
			await expect(new EtherscanClient("https://example.test/api").transfersTo(address)).rejects.toThrow();
		});
	});

	test("raises on a failed response", async () => {
		await withFetch(
			{},
			async () => {
				await expect(new EtherscanClient("https://example.test/api").transfersTo(address)).rejects.toThrow();
			},
			502
		);
	});
});
