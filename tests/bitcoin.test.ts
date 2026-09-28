import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import type { AddressPayment, ChainClient } from "../server/crypto/esplora";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.bitcoin.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { minorUnitsFor, satoshisFor, watchAddresses, SATOSHIS_PER_BITCOIN } = await import("../server/payments/bitcoin");
const { EsploraClient } = await import("../server/crypto/esplora");

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

class FakeChain implements ChainClient {
	tip = 800000;
	payments = new Map<string, AddressPayment[]>();
	calls = 0;

	async tipHeight() {
		return this.tip;
	}

	async paymentsTo(address: string, _tip: number) {
		this.calls++;
		return this.payments.get(address) ?? [];
	}

	pay(address: string, value: number, confirmations: number, txid = crypto.randomUUID().slice(0, 16)) {
		const list = this.payments.get(address) ?? [];
		list.push({ txid, value, confirmations });
		this.payments.set(address, list);
		return txid;
	}

	confirm(address: string, txid: string, confirmations: number) {
		const list = this.payments.get(address) ?? [];
		for (const payment of list) if (payment.txid === txid) payment.confirmations = confirmations;
	}
}

let sessionToken = "";
let projectUuid = "";
let apiKey = "";

const RATE = 50000;
const dueDate = () => Date.now() + 7 * 24 * 60 * 60 * 1000;

async function issueInvoice(unitPrice: number) {
	const created = await call("POST", "/api/v1/pay/invoices", {
		token: apiKey,
		body: { currency: "EUR", due_date: dueDate(), items: [{ description: "Work", quantity: 1, unit_price: unitPrice }] },
	});
	return created.data.uuid as string;
}

function requestAddress(invoice: string, rate = RATE) {
	return call("POST", `/api/v1/pay/invoices/${invoice}/bitcoin`, { token: apiKey, body: { exchange_rate: rate } });
}

function invoiceOf(uuid: string) {
	return call("GET", `/api/v1/pay/invoices/${uuid}`, { token: apiKey });
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	await call("POST", "/api/v1/auth/register", { body: { username: "btc-owner", email: "btc@example.com", password: password("owner") } });
	sessionToken = (await call("POST", "/api/v1/auth/login", { body: { username: "btc-owner", password: password("owner") } })).data.token;

	const project = await call("POST", "/api/v1/projects", { token: sessionToken, body: { name: "btc-shop" } });
	projectUuid = project.data.uuid;
	apiKey = project.data.apikey;
	await connectWallet(projectUuid, WALLET_KEY);
});

const WALLET_KEY = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const FIRST_ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

async function connectWallet(project: string, key: string) {
	const res = await call("PUT", `/api/v1/projects/${project}/processors/bitcoin`, { token: sessionToken, body: { enabled: true, config: { xpub: key } } });
	if (res.error !== 0) throw new Error(res.info);
}

describe("watch-only wallet", () => {
	test("the first invoice gets the first address of the project's own key", async () => {
		const res = await requestAddress(await issueInvoice(10000));
		expect(res.data.address.toLowerCase()).toBe(FIRST_ADDRESS);
		const [row] = (await Database`SELECT wallet_key FROM crypto_addresses WHERE address = ${res.data.address}`) as { wallet_key: string }[];
		expect(row.wallet_key).toHaveLength(32);
	});

	test("a project without its own wallet cannot take bitcoin", async () => {
		const bare = await call("POST", "/api/v1/projects", { token: sessionToken, body: { name: "btc-bare-shop" } });
		const invoice = await call("POST", "/api/v1/pay/invoices", {
			token: bare.data.apikey,
			body: { currency: "EUR", due_date: dueDate(), items: [{ description: "Work", quantity: 1, unit_price: 100 }] },
		});
		const res = await call("POST", `/api/v1/pay/invoices/${invoice.data.uuid}/bitcoin`, { token: bare.data.apikey, body: { exchange_rate: RATE } });
		expect(res.error).toBe(1054);
	});

	test("two projects sharing a key never get the same address", async () => {
		const twin = await call("POST", "/api/v1/projects", { token: sessionToken, body: { name: "btc-twin-shop" } });
		await connectWallet(twin.data.uuid, WALLET_KEY);
		const invoice = await call("POST", "/api/v1/pay/invoices", {
			token: twin.data.apikey,
			body: { currency: "EUR", due_date: dueDate(), items: [{ description: "Work", quantity: 1, unit_price: 100 }] },
		});
		const theirs = await call("POST", `/api/v1/pay/invoices/${invoice.data.uuid}/bitcoin`, { token: twin.data.apikey, body: { exchange_rate: RATE } });
		const [used] = (await Database`SELECT COUNT(*) AS count FROM crypto_addresses WHERE address = ${theirs.data.address}`) as { count: number }[];
		expect(Number(used.count)).toBe(1);
		expect(theirs.data.address.toLowerCase()).not.toBe(FIRST_ADDRESS);
	});
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.bitcoin.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("amount conversion", () => {
	test("converts fiat minor units to satoshis", () => {
		expect(satoshisFor(50000, "EUR", 50000)).toBe(1_000_000);
		expect(satoshisFor(100, "EUR", 50000)).toBe(2000);
	});

	test("rounds satoshis up so the payer never underpays", () => {
		expect(satoshisFor(1, "EUR", 50000)).toBe(20);
		expect(satoshisFor(3, "EUR", 33333)).toBeGreaterThanOrEqual(90);
	});

	test("an exact amount is not nudged up by floating point noise", () => {
		for (const [minor, rate, expected] of [
			[100, 50000, 2000],
			[50000, 50000, 1_000_000],
			[2500, 25000, 100_000],
			[10000, 40000, 250_000],
		] as const) {
			expect(satoshisFor(minor, "EUR", rate)).toBe(expected);
		}
	});

	test("a round trip through satoshis returns the original amount", () => {
		for (const minor of [100, 2500, 50000, 123400]) {
			expect(minorUnitsFor(satoshisFor(minor, "EUR", 50000), "EUR", 50000)).toBe(minor);
		}
	});

	test("converts satoshis back to fiat minor units", () => {
		expect(minorUnitsFor(1_000_000, "EUR", 50000)).toBe(50000);
		expect(minorUnitsFor(SATOSHIS_PER_BITCOIN, "EUR", 50000)).toBe(5_000_000);
	});

	test("rounds credited fiat down so a project is never over credited", () => {
		expect(minorUnitsFor(1, "EUR", 50000)).toBe(0);
		expect(minorUnitsFor(21, "EUR", 50000)).toBe(1);
	});
});

describe("address assignment", () => {
	test("assigns an address with the expected amount", async () => {
		const invoice = await issueInvoice(50000);
		const res = await requestAddress(invoice);

		expect(res.status).toBe(201);
		expect(res.data.address.startsWith("bc1q")).toBe(true);
		expect(res.data.amount_satoshis).toBe(1_000_000);
		expect(res.data.confirmations_required).toBe(2);
		expect(res.data.uri).toContain("bitcoin:");
		expect(res.data.uri).toContain("amount=0.01000000");
	});

	test("returns the same address while it is still live", async () => {
		const invoice = await issueInvoice(50000);
		const first = await requestAddress(invoice);
		const second = await requestAddress(invoice);
		expect(second.data.address).toBe(first.data.address);
	});

	test("gives each invoice its own address", async () => {
		const first = await requestAddress(await issueInvoice(10000));
		const second = await requestAddress(await issueInvoice(10000));
		expect(first.data.address).not.toBe(second.data.address);
	});

	test("derivation indexes never collide within a project", async () => {
		const [row] = (await Database`
			SELECT COUNT(*) AS total, COUNT(DISTINCT derivation_index) AS distinct_indexes FROM crypto_addresses WHERE project = ${projectUuid}
		`) as { total: number; distinct_indexes: number }[];
		expect(row.total).toBe(row.distinct_indexes);
	});

	test("never stores the seed alongside the address", async () => {
		const [row] = (await Database`SELECT * FROM crypto_addresses LIMIT 1`) as any[];
		expect(JSON.stringify(row)).not.toContain(" ");
	});

	test("requires an exchange rate", async () => {
		const invoice = await issueInvoice(50000);
		expect((await call("POST", `/api/v1/pay/invoices/${invoice}/bitcoin`, { token: apiKey, body: {} })).error).toBe(1055);
		expect((await requestAddress(invoice, 0)).error).toBe(1055);
		expect((await requestAddress(invoice, -5)).error).toBe(1055);
	});

	test("refuses an invoice that is not payable", async () => {
		const draft = await call("POST", "/api/v1/pay/invoices", {
			token: apiKey,
			body: { currency: "EUR", due_date: dueDate(), items: [{ description: "X", quantity: 1, unit_price: 100 }], status: "draft" },
		});
		expect((await requestAddress(draft.data.uuid)).error).toBe(1050);
	});

	test("cannot assign an address on another project's invoice", async () => {
		const other = await call("POST", "/api/v1/projects", { token: sessionToken, body: { name: "btc-other-shop" } });
		await connectWallet(other.data.uuid, WALLET_KEY);
		const invoice = await issueInvoice(10000);

		const res = await call("POST", `/api/v1/pay/invoices/${invoice}/bitcoin`, {
			token: other.data.apikey,
			body: { exchange_rate: RATE },
		});
		expect(res.error).toBe(1035);
	});
});

describe("watching for payments", () => {
	test("an unconfirmed payment is recorded but does not settle the invoice", async () => {
		const invoice = await issueInvoice(50000);
		const address = (await requestAddress(invoice)).data.address;

		const chain = new FakeChain();
		chain.pay(address, 1_000_000, 0);
		await watchAddresses(chain);

		const after = await invoiceOf(invoice);
		expect(after.data.status).toBe("open");
		expect(after.data.paid_amount).toBe(0);

		const [tx] = (await Database`SELECT * FROM transactions WHERE invoice = ${invoice}`) as any[];
		expect(tx.status).toBe("pending");
		expect(tx.processor).toBe("bitcoin");
		expect(JSON.parse(tx.payment_details).satoshis).toBe(1_000_000);
	});

	test("the same payment reaching enough confirmations settles the invoice", async () => {
		const invoice = await issueInvoice(50000);
		const address = (await requestAddress(invoice)).data.address;

		const chain = new FakeChain();
		const txid = chain.pay(address, 1_000_000, 0);
		await watchAddresses(chain);
		expect((await invoiceOf(invoice)).data.status).toBe("open");

		chain.confirm(address, txid, 2);
		await watchAddresses(chain);

		const after = await invoiceOf(invoice);
		expect(after.data.status).toBe("paid");
		expect(after.data.paid_amount).toBe(50000);
		expect(after.data.outstanding).toBe(0);
	});

	test("does not create a second transaction for the same txid", async () => {
		const invoice = await issueInvoice(50000);
		const address = (await requestAddress(invoice)).data.address;

		const chain = new FakeChain();
		const txid = chain.pay(address, 1_000_000, 3);
		await watchAddresses(chain);
		await watchAddresses(chain);
		await watchAddresses(chain);

		const [row] = (await Database`SELECT COUNT(*) AS count FROM transactions WHERE invoice = ${invoice}`) as { count: number }[];
		expect(row.count).toBe(1);

		const [tx] = (await Database`SELECT * FROM transactions WHERE invoice = ${invoice}`) as any[];
		expect(tx.processor_tx_id).toBe(txid);
	});

	test("an underpayment leaves the invoice partially paid", async () => {
		const invoice = await issueInvoice(50000);
		const address = (await requestAddress(invoice)).data.address;

		const chain = new FakeChain();
		chain.pay(address, 400_000, 3);
		await watchAddresses(chain);

		const after = await invoiceOf(invoice);
		expect(after.data.status).toBe("partially_paid");
		expect(after.data.paid_amount).toBe(20000);
		expect(after.data.outstanding).toBe(30000);
	});

	test("two payments to one address both credit", async () => {
		const invoice = await issueInvoice(50000);
		const address = (await requestAddress(invoice)).data.address;

		const chain = new FakeChain();
		chain.pay(address, 600_000, 3);
		chain.pay(address, 400_000, 3);
		await watchAddresses(chain);

		const after = await invoiceOf(invoice);
		expect(after.data.paid_amount).toBe(50000);
		expect(after.data.status).toBe("paid");
	});

	test("an overpayment is credited in full", async () => {
		const invoice = await issueInvoice(50000);
		const address = (await requestAddress(invoice)).data.address;

		const chain = new FakeChain();
		chain.pay(address, 1_200_000, 3);
		await watchAddresses(chain);

		const after = await invoiceOf(invoice);
		expect(after.data.paid_amount).toBe(60000);
		expect(after.data.status).toBe("paid");
	});

	test("stops watching an address once it is satisfied", async () => {
		const invoice = await issueInvoice(50000);
		const address = (await requestAddress(invoice)).data.address;

		const chain = new FakeChain();
		chain.pay(address, 1_000_000, 3);
		await watchAddresses(chain);

		const [row] = (await Database`SELECT monitored, total_received FROM crypto_addresses WHERE address = ${address}`) as any[];
		expect(row.monitored).toBe(0);
		expect(row.total_received).toBe(1_000_000);
	});

	test("a failing chain call does not lose other addresses", async () => {
		const invoice = await issueInvoice(50000);
		const address = (await requestAddress(invoice)).data.address;

		const chain = new FakeChain();
		chain.pay(address, 1_000_000, 3);

		const broken: ChainClient = {
			tipHeight: () => chain.tipHeight(),
			paymentsTo: async (target, tip) => {
				if (target !== address) throw new Error("chain unavailable");
				return chain.paymentsTo(target, tip);
			},
		};

		await watchAddresses(broken);
		expect((await invoiceOf(invoice)).data.status).toBe("paid");
	});

	test("records the exchange rate used on the transaction", async () => {
		const [tx] = (await Database`SELECT exchange_rate FROM transactions WHERE processor = 'bitcoin' LIMIT 1`) as any[];
		expect(tx.exchange_rate).toBe(RATE);
	});
});

describe("esplora client", () => {
	test("sums only the outputs paying the watched address", async () => {
		const address = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
		const original = globalThis.fetch;

		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify([
					{
						txid: "abc",
						status: { confirmed: true, block_height: 799_998 },
						vout: [
							{ scriptpubkey_address: address, value: 1500 },
							{ scriptpubkey_address: "bc1qsomeoneelse", value: 9999 },
							{ scriptpubkey_address: address, value: 500 },
						],
					},
					{ txid: "def", status: { confirmed: false }, vout: [{ scriptpubkey_address: address, value: 700 }] },
					{ txid: "ghi", status: { confirmed: true, block_height: 799_000 }, vout: [{ scriptpubkey_address: "bc1qother", value: 100 }] },
				])
			)) as unknown as typeof fetch;

		try {
			const payments = await new EsploraClient("https://example.test/api").paymentsTo(address, 800_000);

			expect(payments).toHaveLength(2);
			expect(payments[0]).toEqual({ txid: "abc", value: 2000, confirmations: 3 });
			expect(payments[1]).toEqual({ txid: "def", value: 700, confirmations: 0 });
		} finally {
			globalThis.fetch = original;
		}
	});

	test("raises on a failed response instead of reporting no payments", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;

		try {
			await expect(new EsploraClient("https://example.test/api").tipHeight()).rejects.toThrow();
		} finally {
			globalThis.fetch = original;
		}
	});
});
