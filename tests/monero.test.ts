import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import type { MoneroSubaddress, MoneroTransfer, MoneroWallet } from "../server/crypto/monero-rpc";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.monero.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { PICONERO_PER_XMR } = await import("../server/crypto/monero-rpc");
const { assignAddress, minorUnitsFor, paymentUri, piconeroFor, watchAddresses } = await import("../server/payments/monero");
const { setMoneroWalletFactory } = await import("../server/crypto/chains");
const { setProcessor } = await import("../server/payments/methods");
const { Settings } = await import("../server/settings");

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

class FakeWallet implements MoneroWallet {
	accounts = 0;
	subaddresses = new Map<string, MoneroSubaddress>();
	transfers = new Map<number, MoneroTransfer[]>();
	private nextIndex = new Map<number, number>();

	async createAccount(): Promise<number> {
		return this.accounts++;
	}

	async createSubaddress(accountIndex: number, label: string): Promise<MoneroSubaddress> {
		const index = this.nextIndex.get(accountIndex) ?? 0;
		this.nextIndex.set(accountIndex, index + 1);

		const subaddress = { address: `8${accountIndex}_${index}_${label}`, accountIndex, addressIndex: index };
		this.subaddresses.set(subaddress.address, subaddress);
		return subaddress;
	}

	async incomingTransfers(accountIndex: number): Promise<MoneroTransfer[]> {
		return this.transfers.get(accountIndex) ?? [];
	}

	send(accountIndex: number, addressIndex: number, amount: bigint, confirmations: number, txid = crypto.randomUUID().slice(0, 12)) {
		const list = this.transfers.get(accountIndex) ?? [];
		list.push({ txid, amount, confirmations, addressIndex });
		this.transfers.set(accountIndex, list);
		return txid;
	}

	confirm(accountIndex: number, txid: string, confirmations: number) {
		for (const transfer of this.transfers.get(accountIndex) ?? []) if (transfer.txid === txid) transfer.confirmations = confirmations;
	}
}

let wallet: FakeWallet;
let otherWallet: FakeWallet;
const walletUrls: string[] = [];
const WALLET_URL = "https://wallet.xmr-shop.example/json_rpc";
let sessionToken = "";
let apiKey = "";
let projectUuid = "";

const RATE = 150;
const dueDate = () => Date.now() + 7 * 24 * 60 * 60 * 1000;

async function issueInvoice(unitPrice: number) {
	const created = await call("POST", "/api/v1/pay/invoices", {
		token: apiKey,
		body: { currency: "EUR", due_date: dueDate(), items: [{ description: "Work", quantity: 1, unit_price: unitPrice }] },
	});
	return created.data.uuid as string;
}

async function projectRow() {
	const [row] = (await Database`SELECT * FROM projects WHERE uuid = ${projectUuid}`) as any[];
	return row;
}

async function invoiceRow(uuid: string) {
	const [row] = (await Database`SELECT * FROM invoices WHERE uuid = ${uuid}`) as any[];
	return row;
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();
	wallet = new FakeWallet();
	otherWallet = new FakeWallet();
	setMoneroWalletFactory((config) => {
		walletUrls.push(config.wallet_rpc_url ?? "");
		return config.wallet_rpc_url === WALLET_URL ? wallet : otherWallet;
	});

	await call("POST", "/api/v1/auth/register", { body: { username: "xmr-owner", email: "xmr@example.com", password: password("owner") } });
	sessionToken = (await call("POST", "/api/v1/auth/login", { body: { username: "xmr-owner", password: password("owner") } })).data.token;

	const project = await call("POST", "/api/v1/projects", { token: sessionToken, body: { name: "xmr-shop" } });
	projectUuid = project.data.uuid;
	apiKey = project.data.apikey;
	await setProcessor(projectUuid, "monero", true, { wallet_rpc_url: WALLET_URL, rpc_username: "shop", rpc_password: "secret" });
});

afterAll(async () => {
	setMoneroWalletFactory(null);
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.monero.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("amount conversion", () => {
	test("converts fiat minor units to piconero", () => {
		expect(piconeroFor(15000, "EUR", 150)).toBe(PICONERO_PER_XMR);
		expect(piconeroFor(7500, "EUR", 150)).toBe(PICONERO_PER_XMR / 2n);
	});

	test("converts piconero back to fiat minor units", () => {
		expect(minorUnitsFor(PICONERO_PER_XMR, "EUR", 150)).toBe(15000);
		expect(minorUnitsFor(PICONERO_PER_XMR * 2n, "EUR", 150)).toBe(30000);
	});

	test("a round trip returns the original amount", () => {
		for (const minor of [100, 2500, 15000, 123400]) {
			expect(minorUnitsFor(piconeroFor(minor, "EUR", RATE), "EUR", RATE)).toBe(minor);
		}
	});

	test("rounds credited fiat down so a project is never over credited", () => {
		expect(minorUnitsFor(1n, "EUR", 150)).toBe(0);
	});

	test("builds a monero uri with a decimal amount", () => {
		expect(paymentUri("8abc", PICONERO_PER_XMR, "INV-1")).toBe("monero:8abc?tx_amount=1&tx_description=INV-1");
		expect(paymentUri("8abc", PICONERO_PER_XMR / 2n, "INV-1")).toContain("tx_amount=0.5");
	});
});

describe("address assignment", () => {
	test("uses the project's own wallet and account", async () => {
		const invoice = await issueInvoice(15000);
		const assigned = await assignAddress(await projectRow(), await invoiceRow(invoice), RATE);

		expect(walletUrls.at(-1)).toBe(WALLET_URL);
		expect(wallet.subaddresses.has(assigned.address)).toBe(true);
		expect(assigned.wallet_account).toBe(0);
		expect(assigned.wallet_key).toHaveLength(32);
		expect(wallet.accounts).toBe(0);
	});

	test("a chosen account receives the subaddresses", async () => {
		const other = await call("POST", "/api/v1/projects", { token: sessionToken, body: { name: "xmr-other-shop" } });
		await setProcessor(other.data.uuid, "monero", true, { wallet_rpc_url: "https://wallet.other.example/json_rpc", account_index: "3" });
		const invoice = await call("POST", "/api/v1/pay/invoices", {
			token: other.data.apikey,
			body: { currency: "EUR", due_date: dueDate(), items: [{ description: "Work", quantity: 1, unit_price: 15000 }] },
		});
		const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${other.data.uuid}`) as any[];
		const assigned = await assignAddress(project, await invoiceRow(invoice.data.uuid), RATE);

		expect(otherWallet.subaddresses.get(assigned.address)?.accountIndex).toBe(3);
		expect(assigned.wallet_account).toBe(3);
	});

	test("refuses without a configured wallet", async () => {
		const bare = await call("POST", "/api/v1/projects", { token: sessionToken, body: { name: "xmr-bare-shop" } });
		const invoice = await call("POST", "/api/v1/pay/invoices", {
			token: bare.data.apikey,
			body: { currency: "EUR", due_date: dueDate(), items: [{ description: "Work", quantity: 1, unit_price: 100 }] },
		});
		const res = await call("POST", `/api/v1/pay/invoices/${invoice.data.uuid}/monero`, { token: bare.data.apikey, body: { exchange_rate: RATE } });
		expect(res.error).toBe(1054);
	});

	test("a wallet on a private address is refused unless the server allows it", async () => {
		const res = await call("PUT", `/api/v1/projects/${projectUuid}/processors/monero`, {
			token: sessionToken,
			body: { enabled: true, config: { wallet_rpc_url: "http://127.0.0.1:18083/json_rpc" } },
		});
		expect(res.error).toBe(1092);
		expect(res.info).toContain("private address");

		Settings.payments = { allow_private_wallets: true };
		try {
			const allowed = await call("PUT", `/api/v1/projects/${projectUuid}/processors/monero`, {
				token: sessionToken,
				body: { enabled: true, config: { wallet_rpc_url: "http://127.0.0.1:18083/json_rpc" } },
			});
			expect(allowed.error).toBe(0);
		} finally {
			Settings.payments = { allow_private_wallets: false };
			await setProcessor(projectUuid, "monero", true, { wallet_rpc_url: WALLET_URL });
		}
	});

	test("gives each invoice its own subaddress", async () => {
		const first = await assignAddress(await projectRow(), await invoiceRow(await issueInvoice(15000)), RATE);
		const second = await assignAddress(await projectRow(), await invoiceRow(await issueInvoice(15000)), RATE);

		expect(first.address).not.toBe(second.address);
		expect(first.derivation_index).not.toBe(second.derivation_index);
	});

	test("returns the same subaddress while it is still live", async () => {
		const invoice = await invoiceRow(await issueInvoice(15000));
		const first = await assignAddress(await projectRow(), invoice, RATE);
		const second = await assignAddress(await projectRow(), invoice, RATE);

		expect(second.address).toBe(first.address);
	});

	test("records the expected amount in piconero", async () => {
		const assigned = await assignAddress(await projectRow(), await invoiceRow(await issueInvoice(15000)), RATE);
		expect(assigned.expected_amount).toBe(Number(PICONERO_PER_XMR));
	});
});

describe("watching for transfers", () => {
	test("an unconfirmed transfer does not settle the invoice", async () => {
		const invoiceId = await issueInvoice(15000);
		const assigned = await assignAddress(await projectRow(), await invoiceRow(invoiceId), RATE);

		wallet.send(0, assigned.derivation_index, PICONERO_PER_XMR, 1);
		await watchAddresses();

		const after = await invoiceRow(invoiceId);
		expect(after.status).toBe("open");
		expect(after.paid_amount).toBe(0);

		const [tx] = (await Database`SELECT * FROM transactions WHERE invoice = ${invoiceId}`) as any[];
		expect(tx.status).toBe("pending");
		expect(tx.processor).toBe("monero");
	});

	test("reaching enough confirmations settles the invoice", async () => {
		const invoiceId = await issueInvoice(15000);
		const assigned = await assignAddress(await projectRow(), await invoiceRow(invoiceId), RATE);

		const txid = wallet.send(0, assigned.derivation_index, PICONERO_PER_XMR, 1);
		await watchAddresses();
		expect((await invoiceRow(invoiceId)).status).toBe("open");

		wallet.confirm(0, txid, 10);
		await watchAddresses();

		const after = await invoiceRow(invoiceId);
		expect(after.status).toBe("paid");
		expect(after.paid_amount).toBe(15000);
	});

	test("only credits transfers for the matching subaddress", async () => {
		const mineId = await issueInvoice(15000);
		const theirsId = await issueInvoice(15000);
		const mine = await assignAddress(await projectRow(), await invoiceRow(mineId), RATE);
		const theirs = await assignAddress(await projectRow(), await invoiceRow(theirsId), RATE);

		wallet.send(0, mine.derivation_index, PICONERO_PER_XMR, 10);
		await watchAddresses();

		expect((await invoiceRow(mineId)).status).toBe("paid");
		expect((await invoiceRow(theirsId)).status).toBe("open");
		expect(theirs.derivation_index).not.toBe(mine.derivation_index);
	});

	test("does not create a second transaction for the same txid", async () => {
		const invoiceId = await issueInvoice(15000);
		const assigned = await assignAddress(await projectRow(), await invoiceRow(invoiceId), RATE);

		wallet.send(0, assigned.derivation_index, PICONERO_PER_XMR, 20);
		await watchAddresses();
		await watchAddresses();

		const [row] = (await Database`SELECT COUNT(*) AS count FROM transactions WHERE invoice = ${invoiceId}`) as { count: number }[];
		expect(row.count).toBe(1);
	});

	test("an underpayment leaves the invoice partially paid", async () => {
		const invoiceId = await issueInvoice(15000);
		const assigned = await assignAddress(await projectRow(), await invoiceRow(invoiceId), RATE);

		wallet.send(0, assigned.derivation_index, PICONERO_PER_XMR / 2n, 20);
		await watchAddresses();

		const after = await invoiceRow(invoiceId);
		expect(after.status).toBe("partially_paid");
		expect(after.paid_amount).toBe(7500);
	});

	test("a failing wallet call does not crash the cycle", async () => {
		const broken: MoneroWallet = {
			createAccount: () => wallet.createAccount(),
			createSubaddress: (account, label) => wallet.createSubaddress(account, label),
			incomingTransfers: async () => {
				throw new Error("wallet not synced");
			},
		};

		setMoneroWalletFactory(() => broken);
		try {
			const result = await watchAddresses();
			expect(result.credited).toBe(0);
		} finally {
			setMoneroWalletFactory((config) => (config.wallet_rpc_url === WALLET_URL ? wallet : otherWallet));
		}
	});

	test("stops watching addresses of a wallet the project replaced", async () => {
		const invoiceId = await issueInvoice(15000);
		const assigned = await assignAddress(await projectRow(), await invoiceRow(invoiceId), RATE);
		wallet.send(0, assigned.derivation_index, PICONERO_PER_XMR, 20);

		await setProcessor(projectUuid, "monero", true, { wallet_rpc_url: "https://wallet.replaced.example/json_rpc" });
		await watchAddresses();
		expect((await invoiceRow(invoiceId)).status).toBe("open");

		await setProcessor(projectUuid, "monero", true, { wallet_rpc_url: WALLET_URL });
		await watchAddresses();
		expect((await invoiceRow(invoiceId)).status).toBe("paid");
	});
});
