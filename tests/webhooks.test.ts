import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.webhooks.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { deliverPending, sendPinnedWebhook, sign, verify } = await import("../server/webhooks/delivery");
const { isPrivateAddress, checkTarget, resolveTarget } = await import("../server/webhooks/target");
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

interface Received {
	body: string;
	host: string;
	event: string;
	signature: string;
	timestamp: string;
	delivery: string;
}

let receiver: ReturnType<typeof Bun.serve>;
let received: Received[] = [];
let respondWith = 200;
let receiverUrl = "";

let sessionToken = "";
let projectUuid = "";
let apiKey = "";
let webhookSecret = "";
let customerUuid = "";

const dueDate = () => Date.now() + 7 * 24 * 60 * 60 * 1000;

async function makeInvoice(total: number) {
	const created = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
		token: sessionToken,
		body: { customer: customerUuid, currency: "EUR", due_date: dueDate(), items: [{ description: "Work", quantity: 1, unit_price: total }] },
	});
	await call("POST", `/api/v1/projects/${projectUuid}/invoices/${created.data.uuid}/open`, { token: sessionToken });
	return created.data.uuid as string;
}

function pay(invoice: string, amount: number) {
	return call("POST", `/api/v1/projects/${projectUuid}/transactions`, {
		token: sessionToken,
		body: { invoice, processor: "bank_transfer", amount },
	});
}

async function flush() {
	for (let round = 0; round < 6; round++) await deliverPending();
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	receiver = Bun.serve({
		port: 0,
		async fetch(request) {
			received.push({
				body: await request.text(),
				host: request.headers.get("host") ?? "",
				event: request.headers.get("X-RabbitPay-Event") ?? "",
				signature: request.headers.get("X-RabbitPay-Signature") ?? "",
				timestamp: request.headers.get("X-RabbitPay-Timestamp") ?? "",
				delivery: request.headers.get("X-RabbitPay-Delivery") ?? "",
			});
			return new Response("ok", { status: respondWith });
		},
	});
	receiverUrl = `http://127.0.0.1:${receiver.port}/hook`;

	const registration = await call("POST", "/api/v1/auth/register", {
		body: { email: "hook-owner@example.com", password: password("owner") },
	});
	if (registration.error !== 0) throw new Error(`Webhook test registration failed: ${registration.error}`);
	const login = await call("POST", "/api/v1/auth/login", { body: { email: "hook-owner@example.com", password: password("owner") } });
	if (login.error !== 0) throw new Error(`Webhook test login failed: ${login.error}`);
	sessionToken = login.data.token;

	const project = await call("POST", "/api/v1/projects", { token: sessionToken, body: { name: "hook-shop" } });
	projectUuid = project.data.uuid;
	apiKey = project.data.apikey;
	webhookSecret = project.data.webhook_secret;

	await call("PATCH", `/api/v1/projects/${projectUuid}`, { token: sessionToken, body: { webhook_url: receiverUrl } });

	customerUuid = (await call("POST", `/api/v1/projects/${projectUuid}/customers`, { token: sessionToken, body: { email: "hookbuyer@example.com" } })).data.uuid;
});

afterAll(async () => {
	receiver.stop(true);
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.webhooks.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("project webhook secret", () => {
	test("is generated when the project is created", () => {
		expect(webhookSecret).toHaveLength(64);
	});

	test("is only ever returned masked afterwards", async () => {
		const res = await call("GET", `/api/v1/projects/${projectUuid}/keys`, { token: sessionToken });
		expect(res.data.webhook_secret).toContain("*");
		expect(res.data.webhook_secret).not.toBe(webhookSecret);
	});

	test("can be rotated", async () => {
		const project = await call("POST", "/api/v1/projects", { token: sessionToken, body: { name: "hook-rotate-shop" } });
		const rotated = await call("POST", `/api/v1/projects/${project.data.uuid}/keys/webhook-secret`, { token: sessionToken, body: {} });

		expect(rotated.data.webhook_secret).toHaveLength(64);
		expect(rotated.data.webhook_secret).not.toBe(project.data.webhook_secret);
	});
});

describe("webhook URL", () => {
	test("developers set it without project edit rights, viewers cannot", async () => {
		const project = (await call("POST", "/api/v1/projects", { token: sessionToken, body: { name: "hook-url-shop" } })).data;
		const tokens: Record<string, string> = {};
		for (const role of ["developer", "viewer"]) {
			const name = `hook-${role}`;
			await call("POST", "/api/v1/auth/register", { body: { email: `${name}@example.com`, password: password(name) } });
			tokens[role] = (await call("POST", "/api/v1/auth/login", { body: { email: `${name}@example.com`, password: password(name) } })).data.token;
			await call("POST", `/api/v1/projects/${project.uuid}/members`, { token: sessionToken, body: { email: `${name}@example.com`, role } });
		}
		const path = `/api/v1/projects/${project.uuid}/webhook-url`;

		const set = await call("PUT", path, { token: tokens.developer, body: { url: "https://example.com/hooks" } });
		expect(set.error).toBe(0);
		expect(set.data.webhook_url).toBe("https://example.com/hooks");
		expect((await call("GET", `/api/v1/projects/${project.uuid}`, { token: tokens.developer })).data.webhook_url).toBe("https://example.com/hooks");

		expect((await call("PATCH", `/api/v1/projects/${project.uuid}`, { token: tokens.developer, body: { webhook_url: "https://x.example" } })).error).toBe(9999);
		expect((await call("PUT", path, { token: tokens.viewer, body: { url: "https://x.example" } })).error).toBe(9999);
		expect((await call("PUT", path, { token: tokens.developer, body: { url: "ftp://example.com" } })).error).toBe(1029);
		expect((await call("PUT", path, { token: tokens.developer, body: {} })).error).toBe(1001);

		const cleared = await call("PUT", path, { token: tokens.developer, body: { url: null } });
		expect(cleared.data.webhook_url).toBeNull();
	});
});

describe("signatures", () => {
	test("verify accepts a signature it produced", () => {
		const body = JSON.stringify({ hello: "world" });
		expect(verify("secret", 1000, body, sign("secret", 1000, body))).toBe(true);
	});

	test("rejects a tampered body, timestamp or secret", () => {
		const body = JSON.stringify({ amount: 100 });
		const signature = sign("secret", 1000, body);

		expect(verify("secret", 1000, JSON.stringify({ amount: 999 }), signature)).toBe(false);
		expect(verify("secret", 1001, body, signature)).toBe(false);
		expect(verify("other-secret", 1000, body, signature)).toBe(false);
	});
});

describe("private target protection", () => {
	test("recognises private and loopback addresses", () => {
		for (const address of [
			"127.0.0.1",
			"10.0.0.5",
			"100.64.0.1",
			"192.168.1.1",
			"172.16.0.1",
			"169.254.169.254",
			"192.0.2.1",
			"198.18.0.1",
			"198.51.100.1",
			"203.0.113.1",
			"224.0.0.1",
			"::1",
			"fd00::1",
			"fe80::1",
			"2001:db8::1",
			"2002::1",
			"::ffff:127.0.0.1",
			"::ffff:7f00:1",
			"64:ff9b::7f00:1",
		]) {
			expect(isPrivateAddress(address)).toBe(true);
		}
	});

	test("recognises public addresses", () => {
		for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:808:808"]) {
			expect(isPrivateAddress(address)).toBe(false);
		}
	});

	test("blocks hexadecimal IPv4-mapped IPv6 targets", async () => {
		const target = await checkTarget("http://[::ffff:7f00:1]/hook", false);
		expect(target.allowed).toBe(false);
		expect(target.reason).toContain("private");
	});

	test("rejects a hostname when any resolved address is private", async () => {
		const target = await resolveTarget("https://hooks.example/hook", false, async () => [
			{ address: "93.184.216.34", family: 4 },
			{ address: "::ffff:7f00:1", family: 6 },
		]);
		expect(target.allowed).toBe(false);
		expect(target.reason).toContain("private");
	});

	test("connects to the validated address without resolving the hostname again", async () => {
		received = [];
		const target = await resolveTarget(`http://webhook.invalid:${receiver.port}/hook`, true, async () => [{ address: "127.0.0.1", family: 4 }]);
		expect(target.allowed).toBe(true);
		expect(target.address).toBe("127.0.0.1");

		const status = await sendPinnedWebhook(
			target,
			{
				"Content-Type": "application/json",
				"X-RabbitPay-Event": "test.event",
				"X-RabbitPay-Delivery": "test-delivery",
				"X-RabbitPay-Timestamp": "1",
				"X-RabbitPay-Signature": "sha256=test",
			},
			"{}",
			AbortSignal.timeout(1000)
		);
		expect(status).toBe(200);
		expect(received).toHaveLength(1);
		expect(received[0].event).toBe("test.event");
		expect(received[0].host).toBe(`webhook.invalid:${receiver.port}`);
	});

	test("blocks a private target when the setting is off", async () => {
		Settings.webhooks.allow_private_targets = false;
		try {
			const blocked = await checkTarget("http://169.254.169.254/latest/meta-data/");
			expect(blocked.allowed).toBe(false);
			expect(blocked.reason).toContain("private");

			expect((await checkTarget("http://127.0.0.1:8080/hook")).allowed).toBe(false);
		} finally {
			Settings.webhooks.allow_private_targets = true;
		}
	});

	test("blocks a non http scheme", async () => {
		expect((await checkTarget("file:///etc/passwd")).allowed).toBe(false);
		expect((await checkTarget("gopher://example.com")).allowed).toBe(false);
		expect((await checkTarget("https://user:password@example.com/hook")).allowed).toBe(false);
	});

	test("allows a private target when the setting is on", async () => {
		expect((await checkTarget("http://127.0.0.1:9999/hook")).allowed).toBe(true);
	});

	test("a delivery to a blocked target fails without being sent", async () => {
		Settings.webhooks.allow_private_targets = false;
		received = [];

		try {
			const invoice = await makeInvoice(10000);
			await pay(invoice, 10000);
			await flush();

			expect(received).toHaveLength(0);

			const [row] = (await Database`
				SELECT status, last_error FROM webhook_deliveries WHERE project = ${projectUuid} ORDER BY created DESC
			`) as any[];
			expect(row.last_error).toContain("private");
		} finally {
			Settings.webhooks.allow_private_targets = true;
		}
	});
});

describe("delivering events", () => {
	test("sends invoice.issued when an invoice is opened", async () => {
		received = [];
		await makeInvoice(10000);
		await flush();

		const issued = received.find((entry) => entry.event === "invoice.issued");
		expect(issued).toBeDefined();

		const body = JSON.parse(issued!.body);
		expect(body.event).toBe("invoice.issued");
		expect(body.project).toBe(projectUuid);
		expect(body.data.total_amount).toBe(10000);
	});

	test("sends invoice.issued for an invoice created already open", async () => {
		received = [];
		const created = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: sessionToken,
			body: { customer: customerUuid, currency: "EUR", status: "open", due_date: dueDate(), items: [{ description: "Work", quantity: 1, unit_price: 4200 }] },
		});
		expect(created.error).toBe(0);
		expect(created.data.status).toBe("open");
		await flush();

		const issued = received.filter((entry) => entry.event === "invoice.issued");
		expect(issued).toHaveLength(1);
		expect(JSON.parse(issued[0].body).data).toMatchObject({ invoice: created.data.uuid, reference: created.data.reference, total_amount: 4200 });
	});

	test("issues once and sends invoice.issued once when the same request is repeated with its idempotency key", async () => {
		received = [];
		const body = {
			customer: customerUuid,
			currency: "EUR",
			status: "open",
			due_date: dueDate(),
			items: [{ description: "Work", quantity: 1, unit_price: 5100 }],
		};
		const send = (payload: unknown, key: string) =>
			Server.app.handle(
				new Request(`http://127.0.0.1/api/v1/projects/${projectUuid}/invoices`, {
					method: "POST",
					headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json", "Idempotency-Key": key },
					body: JSON.stringify(payload),
				})
			);

		const first = await send(body, "retry-1");
		const firstJson = (await first.json()) as any;
		expect(first.status).toBe(201);
		expect(first.headers.get("Idempotency-Replayed")).toBeNull();

		const second = await send(body, "retry-1");
		const secondJson = (await second.json()) as any;
		expect(second.status).toBe(200);
		expect(second.headers.get("Idempotency-Replayed")).toBe("true");
		expect(secondJson.data.uuid).toBe(firstJson.data.uuid);
		expect(secondJson.data.reference).toBe(firstJson.data.reference);

		const [first_, second_] = await Promise.all([send(body, "retry-2"), send(body, "retry-2")]);
		const together = [(await first_.json()) as any, (await second_.json()) as any];
		expect(together[0].data.uuid).toBe(together[1].data.uuid);

		const changed = (await (await send({ ...body, due_date: dueDate() + 1 }, "retry-1")).json()) as any;
		expect(changed.error).toBe(1286);
		expect(((await (await send(body, "not a key")).json()) as any).error).toBe(1285);

		const refused = (await (await send({ ...body, items: [] }, "retry-3")).json()) as any;
		expect(refused.error).not.toBe(0);
		const corrected = (await (await send(body, "retry-3")).json()) as any;
		expect(corrected.error).toBe(0);
		expect(corrected.data.uuid).not.toBe(firstJson.data.uuid);

		const [counted] = (await Database`
			SELECT COUNT(*) AS count FROM invoices WHERE project = ${projectUuid} AND total_amount = 5100 AND status != 'draft'
		`) as { count: number }[];
		expect(Number(counted.count)).toBe(3);

		await flush();
		expect(received.filter((entry) => entry.event === "invoice.issued")).toHaveLength(3);
	});

	test("signs the delivery with the project secret", async () => {
		received = [];
		await makeInvoice(10000);
		await flush();

		const entry = received[0];
		const signature = entry.signature.replace("sha256=", "");
		expect(verify(webhookSecret, Number(entry.timestamp), entry.body, signature)).toBe(true);
	});

	test("sends payment and invoice.paid when an invoice settles", async () => {
		received = [];
		const invoice = await makeInvoice(10000);
		await pay(invoice, 10000);
		await flush();

		const events = received.map((entry) => entry.event);
		expect(events).toContain("payment.confirmed");
		expect(events).toContain("invoice.paid");
	});

	test("sends invoice.partially_paid for an underpayment", async () => {
		received = [];
		const invoice = await makeInvoice(10000);
		await pay(invoice, 3000);
		await flush();

		expect(received.map((entry) => entry.event)).toContain("invoice.partially_paid");
	});

	test("sends invoice.canceled", async () => {
		received = [];
		const invoice = await makeInvoice(10000);
		await call("POST", `/api/v1/projects/${projectUuid}/invoices/${invoice}/cancel`, { token: sessionToken });
		await flush();

		expect(received.map((entry) => entry.event)).toContain("invoice.canceled");
	});

	test("sends payment.refunded", async () => {
		received = [];
		const invoice = await makeInvoice(10000);
		const payment = await pay(invoice, 10000);
		await call("POST", `/api/v1/projects/${projectUuid}/transactions/${payment.data.uuid}/refund`, { token: sessionToken, body: { amount: 2500 } });
		await flush();

		expect(received.map((entry) => entry.event)).toContain("payment.refunded");
	});

	test("sends invoice.issued for an invoice raised through the machine api", async () => {
		received = [];
		await call("POST", "/api/v1/pay/invoices", {
			token: apiKey,
			body: { currency: "EUR", due_date: dueDate(), items: [{ description: "Machine", quantity: 1, unit_price: 2500 }] },
		});
		await flush();

		const issued = received.find((entry) => entry.event === "invoice.issued");
		expect(issued).toBeDefined();
		expect(JSON.parse(issued!.body).data.total_amount).toBe(2500);
	});

	test("marks the delivery delivered and does not resend it", async () => {
		received = [];
		await makeInvoice(10000);
		await flush();

		const sent = received.length;
		expect(sent).toBeGreaterThan(0);

		await flush();
		expect(received).toHaveLength(sent);

		const [row] = (await Database`
			SELECT status, attempts, response_status FROM webhook_deliveries WHERE project = ${projectUuid} ORDER BY created DESC
		`) as any[];
		expect(row.status).toBe("delivered");
		expect(row.attempts).toBe(1);
		expect(row.response_status).toBe(200);
	});

	test("carries the event name and delivery id in headers", async () => {
		received = [];
		await makeInvoice(10000);
		await flush();

		expect(received[0].event).toBe("invoice.issued");
		expect(received[0].delivery).toHaveLength(36);
	});
});

describe("retries", () => {
	test("a rejecting target is retried and eventually given up on", async () => {
		respondWith = 500;
		received = [];

		try {
			await makeInvoice(10000);
			await deliverPending();

			const [afterOne] = (await Database`
				SELECT status, attempts, response_status, next_attempt_at FROM webhook_deliveries WHERE project = ${projectUuid} ORDER BY created DESC
			`) as any[];
			expect(afterOne.status).toBe("pending");
			expect(afterOne.attempts).toBe(1);
			expect(afterOne.response_status).toBe(500);
			expect(afterOne.next_attempt_at).toBeGreaterThan(Date.now());

			const uuid = ((await Database`SELECT uuid FROM webhook_deliveries WHERE project = ${projectUuid} ORDER BY created DESC LIMIT 1`) as any[])[0].uuid;

			for (let attempt = 0; attempt < 5; attempt++) {
				await Database`UPDATE webhook_deliveries SET next_attempt_at = ${Date.now() - 1} WHERE uuid = ${uuid}`;
				await deliverPending();
			}

			const [final] = (await Database`SELECT status, attempts FROM webhook_deliveries WHERE uuid = ${uuid}`) as any[];
			expect(final.status).toBe("failed");
			expect(final.attempts).toBe(3);
		} finally {
			respondWith = 200;
		}
	});

	test("a failed delivery is not attempted again", async () => {
		const before = received.length;
		await deliverPending();
		expect(received.length).toBe(before);
	});
});

describe("delivery log", () => {
	test("is visible to a member with the webhook permission", async () => {
		const res = await call("GET", `/api/v1/projects/${projectUuid}/webhooks`, { token: sessionToken });

		expect(res.error).toBe(0);
		expect(res.data.deliveries.length).toBeGreaterThan(0);
		expect(res.data.counts.delivered).toBeGreaterThan(0);
		expect(res.data.counts.failed).toBeGreaterThan(0);
	});

	test("never exposes the signing secret", async () => {
		const res = await call("GET", `/api/v1/projects/${projectUuid}/webhooks`, { token: sessionToken });
		expect(JSON.stringify(res.data)).not.toContain(webhookSecret);
	});

	test("is not reachable with an api key", async () => {
		expect((await call("GET", `/api/v1/projects/${projectUuid}/webhooks`, { token: apiKey })).error).toBe(1017);
	});
});

describe("projects without a webhook url", () => {
	test("queue nothing", async () => {
		const project = await call("POST", "/api/v1/projects", { token: sessionToken, body: { name: "hook-silent-shop" } });
		const customer = await call("POST", `/api/v1/projects/${project.data.uuid}/customers`, { token: sessionToken, body: { email: "s@example.com" } });

		const invoice = await call("POST", `/api/v1/projects/${project.data.uuid}/invoices`, {
			token: sessionToken,
			body: { customer: customer.data.uuid, currency: "EUR", due_date: dueDate(), items: [{ description: "X", quantity: 1, unit_price: 100 }] },
		});
		await call("POST", `/api/v1/projects/${project.data.uuid}/invoices/${invoice.data.uuid}/open`, { token: sessionToken });

		const [row] = (await Database`SELECT COUNT(*) AS count FROM webhook_deliveries WHERE project = ${project.data.uuid}`) as { count: number }[];
		expect(row.count).toBe(0);
	});
});
