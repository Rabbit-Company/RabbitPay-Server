import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Web } from "@rabbit-company/web";

import { prepareTest } from "./environment";
await prepareTest();

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { default: Metrics } = await import("../server/metrics");
const { Settings, updateSettings } = await import("../server/settings");
const { DEFAULT_SETTINGS } = await import("../server/settings-schema");
const { clientIpMiddleware, trustedProxies } = await import("../server/client-ip");

await Server.configure();

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();
});

afterAll(async () => {
	await Database.close();
});

async function seenIp(headers: Record<string, string>, from = "203.0.113.50"): Promise<string | undefined> {
	const app = new Web();
	app.use(async (ctx, next) => {
		ctx.clientIp = from;
		return await next();
	});
	app.use(clientIpMiddleware() as never);
	app.get("/ip", (ctx) => ctx.json({ ip: ctx.clientIp ?? null }));
	const response = await app.handle(new Request("http://127.0.0.1/ip", { headers }));
	return ((await response.json()) as { ip: string | null }).ip ?? undefined;
}

describe("production defaults", () => {
	test("metrics are off until an administrator turns them on", () => {
		expect(DEFAULT_SETTINGS.metrics.method).toBe(0);
	});

	test("request metrics never carry the request path", async () => {
		await updateSettings({ "metrics.method": 2 });
		for (let index = 0; index < 5; index++) {
			await Server.app.handle(new Request(`http://127.0.0.1/api/v1/invoices/${crypto.randomUUID()}`));
		}
		await Server.app.handle(new Request("http://127.0.0.1/api/health"));
		const text = Metrics.registry.metricsText();
		expect(text).not.toContain("/api/");
		expect(text).not.toContain("endpoint=");
		expect(text).toContain('method="GET"');
		await updateSettings({ "metrics.method": 0 });
	});

	test("unknown methods share one label", () => {
		expect(Metrics.methodLabel("PATCH")).toBe("PATCH");
		expect(Metrics.methodLabel("BREW")).toBe("OTHER");
	});
});

describe("client IP source", () => {
	test("offers every preset the middleware supports", async () => {
		const { IP_EXTRACTION_PRESETS } = await import("@rabbit-company/web-middleware/ip-extract");
		const { settingField } = await import("../server/settings-schema");
		const offered = settingField("server.proxy")!
			.choices!.map((choice) => choice.value)
			.sort();
		expect(offered).toEqual(Object.keys(IP_EXTRACTION_PRESETS).sort());
	});

	test("direct connections ignore forwarded headers", async () => {
		await updateSettings({ "server.proxy": "direct" });
		expect(await seenIp({ "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.9" })).not.toBe("203.0.113.9");
	});

	test("a reverse proxy passes the client IP through", async () => {
		await updateSettings({ "server.proxy": "nginx", "server.trusted_proxies": "" });
		expect(await seenIp({ "x-real-ip": "198.51.100.7" })).toBe("198.51.100.7");
	});

	test("trusted proxies stop headers from anyone else", async () => {
		await updateSettings({ "server.proxy": "nginx", "server.trusted_proxies": "10.0.0.0/8, 192.168.1.1" });
		expect(trustedProxies()).toEqual(["10.0.0.0/8", "192.168.1.1"]);
		expect(await seenIp({ "x-real-ip": "198.51.100.7" })).toBe("203.0.113.50");
		expect(await seenIp({ "x-real-ip": "198.51.100.7" }, "10.1.2.3")).toBe("198.51.100.7");
		await updateSettings({ "server.proxy": "direct", "server.trusted_proxies": "" });
	});

	test("BurrowGate with a signing secret rejects unsigned requests", async () => {
		await updateSettings({ "server.proxy": "burrowgate", "server.burrowgate_secret": "origin-signing-secret-for-tests" });
		const app = new Web();
		app.use(clientIpMiddleware() as never);
		app.get("/api/health", (ctx) => ctx.json({ ok: true }));
		app.get("/api/v1/anything", (ctx) => ctx.json({ ok: true }));

		expect((await app.handle(new Request("http://127.0.0.1/api/v1/anything", { headers: { "x-burrowgate-client-ip": "198.51.100.7" } }))).status).toBe(403);
		expect((await app.handle(new Request("http://127.0.0.1/api/health"))).status).toBe(200);
		await updateSettings({ "server.proxy": "direct", "server.burrowgate_secret": null });
		expect(Settings.server.burrowgate_secret).toBe("");
	});
});

describe("health and shutdown", () => {
	test("reports healthy while the database answers", async () => {
		const response = await Server.app.handle(new Request("http://127.0.0.1/api/health"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});

	test("stops accepting work and reports it to the health check", async () => {
		const { default: Scheduler } = await import("../server/scheduler");
		expect(await Scheduler.stop(1000)).toBe(true);
		await Server.stop();
		const response = await Server.app.handle(new Request("http://127.0.0.1/api/health"));
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ status: "stopping" });
	});
});
