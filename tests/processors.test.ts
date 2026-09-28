import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.processors.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { availableFor, configFor, isEnabledFor, setProcessor, statesFor } = await import("../server/payments/methods");
const { setRateProvider } = await import("../server/rates/forex");

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

let ownerToken = "";
let viewerToken = "";
let apiKey = "";
let projectUuid = "";

const ZPUB = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const ETH_XPUB = "xpub6DCoCpSuQZB2jawqnGMEPS63ePKWkwWPH4TU45Q7LPXWuNd8TMtVxRrgjtEshuqpK3mdhaWHPFsBngh5GFZaM6si3yZdUsT8ddYM3PwnATt";
const XPRV = "xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu";

const dueDate = () => Date.now() + 7 * 24 * 60 * 60 * 1000;

async function issueInvoice(unitPrice = 10000) {
	const created = await call("POST", "/api/v1/pay/invoices", {
		token: apiKey,
		body: { currency: "EUR", due_date: dueDate(), items: [{ description: "Work", quantity: 1, unit_price: unitPrice }] },
	});
	return created.data.uuid as string;
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	await call("POST", "/api/v1/auth/register", { body: { username: "proc-owner", email: "proc@example.com", password: password("owner") } });
	ownerToken = (await call("POST", "/api/v1/auth/login", { body: { username: "proc-owner", password: password("owner") } })).data.token;

	await call("POST", "/api/v1/auth/register", { body: { username: "proc-viewer", email: "procview@example.com", password: password("viewer") } });
	viewerToken = (await call("POST", "/api/v1/auth/login", { body: { username: "proc-viewer", password: password("viewer") } })).data.token;

	const project = await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "proc-shop" } });
	projectUuid = project.data.uuid;
	apiKey = project.data.apikey;

	await call("POST", `/api/v1/projects/${projectUuid}/members`, { token: ownerToken, body: { email: "procview@example.com", role: "viewer" } });
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.processors.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("listing processors", () => {
	test("lists every processor the server knows about", async () => {
		const res = await call("GET", `/api/v1/projects/${projectUuid}/processors`, { token: ownerToken });
		const names = res.data.map((state: any) => state.processor);

		expect(names).toEqual(["bitcoin", "ethereum", "monero", "bank_transfer", "stripe", "paypal"]);
	});

	test("asks for a watch-only key for each chain", async () => {
		const states = await statesFor(projectUuid);
		const bitcoin = states.find((state) => state.processor === "bitcoin");
		const monero = states.find((state) => state.processor === "monero");

		expect(bitcoin?.fields.map((entry) => entry.key)).toEqual(["xpub", "address_type"]);
		expect(bitcoin?.configured).toBe(false);
		expect(monero?.fields.map((entry) => entry.key)).toEqual(["wallet_rpc_url", "rpc_username", "rpc_password", "account_index"]);
	});

	test("describes the credentials a card processor needs", async () => {
		const states = await statesFor(projectUuid);
		const stripe = states.find((state) => state.processor === "stripe");

		expect(stripe?.fields.map((entry) => entry.key)).toEqual(["secret_key", "webhook_secret"]);
	});

	test("is off until the project connects its own account", async () => {
		expect(await isEnabledFor(projectUuid, "bitcoin")).toBe(false);
		expect(await isEnabledFor(projectUuid, "stripe")).toBe(false);
		expect(await availableFor(projectUuid)).toEqual([]);
	});
});

describe("connecting a wallet", () => {
	test("switching bitcoin on without a key is refused", async () => {
		const res = await call("PUT", `/api/v1/projects/${projectUuid}/processors/bitcoin`, { token: ownerToken, body: { enabled: true } });
		expect(res.error).toBe(1092);
		expect(res.info).toContain("Extended public key");
	});

	test("a private key is refused and never stored", async () => {
		const res = await call("PUT", `/api/v1/projects/${projectUuid}/processors/bitcoin`, {
			token: ownerToken,
			body: { enabled: true, config: { xpub: XPRV } },
		});
		expect(res.error).toBe(1092);
		expect(res.info).toContain("private key");
		expect(await configFor(projectUuid, "bitcoin")).toEqual({});
	});

	test("a garbled key is refused", async () => {
		const res = await call("PUT", `/api/v1/projects/${projectUuid}/processors/ethereum`, {
			token: ownerToken,
			body: { enabled: true, config: { xpub: "xpub-not-a-key" } },
		});
		expect(res.error).toBe(1092);
	});

	test("shows the first receiving address so the owner can compare it with the wallet", async () => {
		const res = await call("PUT", `/api/v1/projects/${projectUuid}/processors/bitcoin`, {
			token: ownerToken,
			body: { enabled: true, config: { xpub: ZPUB } },
		});
		expect(res.error).toBe(0);
		expect(res.data).toMatchObject({ enabled: true, configured: true, preview: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", problem: null });
		expect(await isEnabledFor(projectUuid, "bitcoin")).toBe(true);
	});

	test("an ethereum account key shows its first address", async () => {
		const legacy = await call("PUT", `/api/v1/projects/${projectUuid}/processors/ethereum`, {
			token: ownerToken,
			body: { enabled: false, config: { xpub: ETH_XPUB } },
		});
		expect(legacy.data.preview).toBe("0x9858effd232b4033e47d90003d41ec34ecaeda94");
	});
});

describe("switching processors on and off", () => {
	test("an owner can switch one off", async () => {
		const res = await call("PUT", `/api/v1/projects/${projectUuid}/processors/bitcoin`, { token: ownerToken, body: { enabled: false } });

		expect(res.error).toBe(0);
		expect(res.data.enabled).toBe(false);
		expect(await isEnabledFor(projectUuid, "bitcoin")).toBe(false);
	});

	test("switching it off blocks the payment endpoint", async () => {
		const invoice = await issueInvoice();
		const res = await call("POST", `/api/v1/pay/invoices/${invoice}/bitcoin`, { token: apiKey, body: { exchange_rate: 50000 } });

		expect(res.error).toBe(1054);
	});

	test("switching it back on unblocks it", async () => {
		await call("PUT", `/api/v1/projects/${projectUuid}/processors/bitcoin`, { token: ownerToken, body: { enabled: true } });

		const invoice = await issueInvoice();
		const res = await call("POST", `/api/v1/pay/invoices/${invoice}/bitcoin`, { token: apiKey, body: { exchange_rate: 50000 } });

		expect(res.error).toBe(0);
	});

	test("one project's wallet does not switch on another", async () => {
		const other = await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "proc-other-shop" } });

		expect(await isEnabledFor(projectUuid, "bitcoin")).toBe(true);
		expect(await isEnabledFor(other.data.uuid, "bitcoin")).toBe(false);
		expect(await configFor(other.data.uuid, "bitcoin")).toEqual({});
	});

	test("rejects an unknown processor", async () => {
		const res = await call("PUT", `/api/v1/projects/${projectUuid}/processors/dogecoin`, { token: ownerToken, body: { enabled: true } });
		expect(res.error).toBe(1048);
	});

	test("a viewer cannot change payment methods", async () => {
		const res = await call("PUT", `/api/v1/projects/${projectUuid}/processors/stripe`, { token: viewerToken, body: { enabled: false } });
		expect(res.error).toBe(9999);
	});

	test("an api key cannot change payment methods", async () => {
		const res = await call("PUT", `/api/v1/projects/${projectUuid}/processors/stripe`, { token: apiKey, body: { enabled: false } });
		expect(res.error).toBe(1017);
	});
});

describe("per project credentials", () => {
	test("saves and reads back a processor config", async () => {
		await call("PUT", `/api/v1/projects/${projectUuid}/processors/stripe`, {
			token: ownerToken,
			body: { enabled: true, config: { secret_key: "sk_live_project", webhook_secret: "whsec_project" } },
		});

		const config = await configFor(projectUuid, "stripe");
		expect(config.secret_key).toBe("sk_live_project");
		expect(config.webhook_secret).toBe("whsec_project");
	});

	test("stores the credentials encrypted, never in the clear", async () => {
		const [row] = (await Database`SELECT config FROM payment_methods WHERE project = ${projectUuid} AND processor = 'stripe'`) as any[];

		expect(row.config).not.toContain("sk_live_project");
		expect(row.config.startsWith("v1.")).toBe(true);
	});

	test("never returns a secret through the API", async () => {
		const res = await call("GET", `/api/v1/projects/${projectUuid}/processors`, { token: ownerToken });
		const stripe = res.data.find((state: any) => state.processor === "stripe");

		expect(JSON.stringify(res.data)).not.toContain("sk_live_project");
		expect(stripe.fields.find((entry: any) => entry.key === "secret_key").value).toBeNull();
		expect(stripe.fields.find((entry: any) => entry.key === "secret_key").set).toBe(true);
	});

	test("a blank field leaves the stored secret alone", async () => {
		await call("PUT", `/api/v1/projects/${projectUuid}/processors/stripe`, {
			token: ownerToken,
			body: { enabled: true, config: { secret_key: "", webhook_secret: "whsec_rotated" } },
		});

		const config = await configFor(projectUuid, "stripe");
		expect(config.secret_key).toBe("sk_live_project");
		expect(config.webhook_secret).toBe("whsec_rotated");
	});

	test("a project without its own account has nothing to fall back on", async () => {
		const other = await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "proc-fallback-shop" } });

		expect(await configFor(other.data.uuid, "stripe")).toEqual({});
		await setProcessor(other.data.uuid, "stripe", true, {});
		expect(await isEnabledFor(other.data.uuid, "stripe")).toBe(false);

		const res = await call("PUT", `/api/v1/projects/${other.data.uuid}/processors/paypal`, { token: ownerToken, body: { enabled: true } });
		expect(res.error).toBe(1092);
	});

	test("changing the wallet URL forgets the old wallet password", async () => {
		await setProcessor(projectUuid, "monero", false, { wallet_rpc_url: "https://one.example/json_rpc", rpc_password: "first" });
		await setProcessor(projectUuid, "monero", false, { wallet_rpc_url: "https://two.example/json_rpc" });
		expect((await configFor(projectUuid, "monero")).rpc_password).toBeUndefined();

		await setProcessor(projectUuid, "monero", false, { wallet_rpc_url: "https://two.example/json_rpc", rpc_password: "second" });
		await setProcessor(projectUuid, "monero", false, { rpc_username: "shop" });
		expect((await configFor(projectUuid, "monero")).rpc_password).toBe("second");
	});

	test("reports a card processor as configured only once its fields are set", async () => {
		const states = await statesFor(projectUuid);
		expect(states.find((state) => state.processor === "stripe")?.configured).toBe(true);
	});

	test("excludes a switched off processor from what a customer can use", async () => {
		await setProcessor(projectUuid, "paypal", true, { client_id: "id", client_secret: "secret", webhook_id: "hook" });
		expect((await availableFor(projectUuid)).map((state) => state.processor)).toContain("paypal");

		await setProcessor(projectUuid, "paypal", false, {});
		expect((await availableFor(projectUuid)).map((state) => state.processor)).not.toContain("paypal");
	});
});

describe("public payment api", () => {
	test("shows an invoice without any credentials", async () => {
		const invoice = await issueInvoice(25000);
		const res = await call("GET", `/api/v1/public/invoices/${invoice}`);

		expect(res.error).toBe(0);
		expect(res.data.merchant).toBe("proc-shop");
		expect(res.data.outstanding).toBe(25000);
		expect(res.data.methods.length).toBeGreaterThan(0);
	});

	test("never exposes anything sensitive about the project", async () => {
		const invoice = await issueInvoice();
		const res = await call("GET", `/api/v1/public/invoices/${invoice}`);
		const body = JSON.stringify(res.data);

		expect(body).not.toContain("seed");
		expect(body).not.toContain("apikey");
		expect(body).not.toContain(projectUuid);
	});

	test("hides a draft invoice", async () => {
		const draft = await call("POST", "/api/v1/pay/invoices", {
			token: apiKey,
			body: { currency: "EUR", due_date: dueDate(), items: [{ description: "X", quantity: 1, unit_price: 100 }], status: "draft" },
		});

		expect((await call("GET", `/api/v1/public/invoices/${draft.data.uuid}`)).error).toBe(1035);
	});

	test("rejects an unknown or malformed invoice", async () => {
		expect((await call("GET", `/api/v1/public/invoices/${crypto.randomUUID()}`)).error).toBe(1035);
		expect((await call("GET", "/api/v1/public/invoices/not-a-uuid")).error).toBe(1036);
	});

	test("only offers methods the project has switched on", async () => {
		await setProcessor(projectUuid, "ethereum", false, { xpub: ETH_XPUB });

		const invoice = await issueInvoice();
		const res = await call("GET", `/api/v1/public/invoices/${invoice}`);

		expect(res.data.methods.map((method: any) => method.processor)).not.toContain("ethereum");

		await setProcessor(projectUuid, "ethereum", true, {});
	});

	test("starts a crypto payment and returns an address and uri", async () => {
		setRateProvider({ unitsPerAsset: async () => 50000 });

		try {
			const invoice = await issueInvoice(50000);
			const res = await call("POST", `/api/v1/public/invoices/${invoice}/pay/bitcoin`, { body: {} });

			expect(res.error).toBe(0);
			expect(res.data.address.startsWith("bc1q")).toBe(true);
			expect(res.data.uri).toContain("bitcoin:");
			expect(res.data.amount).toBe(1000000);
		} finally {
			setRateProvider(null);
		}
	});

	test("refuses a processor the project switched off", async () => {
		await setProcessor(projectUuid, "bitcoin", false, {});

		const invoice = await issueInvoice();
		const res = await call("POST", `/api/v1/public/invoices/${invoice}/pay/bitcoin`, { body: { exchange_rate: 50000 } });

		expect(res.error).toBe(1054);
		await setProcessor(projectUuid, "bitcoin", true, {});
	});

	test("says so plainly when no rate can be found", async () => {
		const invoice = await issueInvoice();
		expect((await call("POST", `/api/v1/public/invoices/${invoice}/pay/bitcoin`, { body: {} })).error).toBe(1059);
	});

	test("prices the payment itself when the customer supplies no rate", async () => {
		setRateProvider({ unitsPerAsset: async () => 50000 });

		try {
			const invoice = await issueInvoice(50000);
			const res = await call("POST", `/api/v1/public/invoices/${invoice}/pay/bitcoin`, { body: {} });

			expect(res.error).toBe(0);
			expect(res.data.amount).toBe(1000000);
			expect(res.data.address.startsWith("bc1q")).toBe(true);
		} finally {
			setRateProvider(null);
		}
	});

	test("locks the priced amount to the address so a later move does not change it", async () => {
		setRateProvider({ unitsPerAsset: async () => 50000 });
		const invoice = await issueInvoice(50000);

		try {
			const first = await call("POST", `/api/v1/public/invoices/${invoice}/pay/bitcoin`, { body: {} });

			setRateProvider({ unitsPerAsset: async () => 100000 });
			const second = await call("POST", `/api/v1/public/invoices/${invoice}/pay/bitcoin`, { body: {} });

			expect(second.data.address).toBe(first.data.address);
			expect(second.data.amount).toBe(first.data.amount);
		} finally {
			setRateProvider(null);
		}
	});

	test("ignores a rate supplied by the caller and uses the server rate", async () => {
		setRateProvider({ unitsPerAsset: async () => 50000 });

		try {
			const invoice = await issueInvoice(50000);
			const res = await call("POST", `/api/v1/public/invoices/${invoice}/pay/bitcoin`, { body: { exchange_rate: 10_000_000_000 } });

			expect(res.error).toBe(0);
			expect(res.data.exchange_rate).toBe(50000);
			expect(res.data.amount).toBe(1000000);
		} finally {
			setRateProvider(null);
		}
	});

	test("does not fall back to a rate supplied by the caller", async () => {
		const invoice = await issueInvoice();
		expect((await call("POST", `/api/v1/public/invoices/${invoice}/pay/bitcoin`, { body: { exchange_rate: 50000 } })).error).toBe(1059);
	});

	test("refuses to start a payment on a paid invoice", async () => {
		const invoice = await issueInvoice(10000);
		await call("POST", `/api/v1/projects/${projectUuid}/transactions`, {
			token: ownerToken,
			body: { invoice, processor: "bank_transfer", amount: 10000 },
		});

		const res = await call("POST", `/api/v1/public/invoices/${invoice}/pay/bitcoin`, { body: { exchange_rate: 50000 } });
		expect(res.error).toBe(1050);
	});

	test("shows a paid invoice as paid with no methods left", async () => {
		const invoice = await issueInvoice(10000);
		await call("POST", `/api/v1/projects/${projectUuid}/transactions`, {
			token: ownerToken,
			body: { invoice, processor: "bank_transfer", amount: 10000 },
		});

		const res = await call("GET", `/api/v1/public/invoices/${invoice}`);
		expect(res.data.status).toBe("paid");
		expect(res.data.outstanding).toBe(0);
		expect(res.data.methods).toHaveLength(0);
	});
});
