import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { prepareTest } from "./environment";

const txt = new Map<string, string[][]>();
const cnames = new Map<string, string[]>();
const addresses = new Map<string, string[]>();
const missing = (name: string) => Object.assign(new Error(`queryA ENOTFOUND ${name}`), { code: "ENOTFOUND" });
const realDns = { ...(await import("node:dns/promises")) };
mock.module("node:dns/promises", () => ({
	...realDns,
	resolveTxt: async (name: string) => txt.get(name) ?? Promise.reject(missing(name)),
	resolveCname: async (name: string) => cnames.get(name) ?? Promise.reject(missing(name)),
	resolve4: async (name: string) => addresses.get(name) ?? Promise.reject(missing(name)),
	resolve6: async (name: string) => Promise.reject(missing(name)),
}));

await prepareTest();

const FIXTURE = `${import.meta.dir}/.store-domains-fixture`;
mkdirSync(FIXTURE, { recursive: true });
writeFileSync(
	`${FIXTURE}/index.html`,
	'<!doctype html><html lang="en"><head><meta name="robots" content="noindex, nofollow" /><title>RabbitPay</title></head><body></body></html>'
);

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { Settings } = await import("../server/settings");
const { default: Auth } = await import("../server/auth");
const { checkWaitingDomains, domainsAvailable, normalizeHostname } = await import("../server/store/domains");

Settings.web = { enabled: true, path: FIXTURE, landing_page: true, license_store_url: "" };

interface Result {
	status: number;
	error: number;
	data: any;
}

let token = "";
let project = "";
let other = "";
const defaults = structuredClone(Settings.domains);
const originalFetch = globalThis.fetch;

async function call(method: string, path: string, body?: unknown, as = token): Promise<Result> {
	const headers: Record<string, string> = { Authorization: `Bearer ${as}` };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const response = await Server.app.handle(
		new Request(`http://127.0.0.1/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
	);
	return { status: response.status, ...((await response.json()) as Omit<Result, "status">) };
}

async function page(host: string, path = "/") {
	return await Server.app.handle(new Request(`http://127.0.0.1${path}`, { headers: { host } }));
}

async function openStore(projectId: string, slug: string) {
	await Database`UPDATE projects SET store_until = ${Date.now() + 30 * 86400000} WHERE uuid = ${projectId}`;
	const state = await call("GET", `/projects/${projectId}/store`);
	expect((await call("PUT", `/projects/${projectId}/store`, { slug, enabled: true, config: state.data.config })).error).toBe(0);
}

function useProvider(provider: typeof Settings.domains.provider, extra: Partial<typeof Settings.domains> = {}) {
	Settings.domains = { ...defaults, provider, ...extra };
}

const HOSTED = {
	target: "customers.rabbitpay.test",
	cloudflare_api_token: "cloudflare-token",
	cloudflare_zone_id: "zone-id",
	burrowgate_url: "https://gateway.rabbitpay.test/_burrowgate/admin",
	burrowgate_admin_token: "burrowgate-token",
	burrowgate_site_id: "main-site",
	acme_email: "ops@rabbitpay.test",
};

type Handler = (url: string, method: string, body: Record<string, unknown> | null) => Response | undefined;

const requests: { method: string; url: string; body: Record<string, unknown> | null }[] = [];

function provide(handler: Handler) {
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
		requests.push({ method, url, body });
		const answer = handler(url, method, body);
		if (!answer) throw new Error(`Unexpected provider request: ${method} ${url}`);
		return answer;
	}) as typeof fetch;
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await Server.configure();
	const now = Date.now();
	await Database`INSERT INTO accounts(username, email, password, created, updated, accessed) VALUES('domain-owner', 'owner@domains.test', 'unused', ${now}, ${now}, ${now})`;
	token = (await Auth.createSession("domain-owner", ""))!;
	project = (await call("POST", "/projects", { name: "pixel-domains", currency: "EUR" })).data.uuid;
	other = (await call("POST", "/projects", { name: "other-domains", currency: "EUR" })).data.uuid;
	await openStore(project, "pixel-domains");
	await openStore(other, "other-domains");
});

beforeEach(async () => {
	useProvider("manual");
	globalThis.fetch = originalFetch;
	requests.length = 0;
	txt.clear();
	cnames.clear();
	addresses.clear();
	await Database`DELETE FROM store_domains`;
	await Database`UPDATE store_settings SET domain = NULL`;
});

afterAll(async () => {
	globalThis.fetch = originalFetch;
	Settings.domains = defaults;
	await Database.close();
	rmSync(FIXTURE, { recursive: true, force: true });
});

describe("store domains", () => {
	test("accepts plain and international host names and rejects everything else", () => {
		expect(normalizeHostname(" Shop.Example.COM. ")).toBe("shop.example.com");
		expect(normalizeHostname("trgovina.čokolada.si")).toMatch(/^trgovina\.xn--[a-z0-9-]+\.si$/);
		for (const value of [
			"https://shop.example.com",
			"shop.example.com:8443",
			"shop.example.com/path",
			"localhost",
			"shop.localhost",
			"10.0.0.1",
			"example",
			"-shop.example.com",
			42,
		]) {
			expect(normalizeHostname(value)).toBeNull();
		}
	});

	test("needs every credential of the selected provider", () => {
		useProvider("disabled");
		expect(domainsAvailable()).toBe(false);
		useProvider("manual");
		expect(domainsAvailable()).toBe(true);
		useProvider("burrowgate", { burrowgate_url: HOSTED.burrowgate_url });
		expect(domainsAvailable()).toBe(false);
		useProvider("burrowgate", { burrowgate_url: HOSTED.burrowgate_url, burrowgate_admin_token: "token" });
		expect(domainsAvailable()).toBe(true);
		useProvider("cloudflare", { burrowgate_url: HOSTED.burrowgate_url, burrowgate_admin_token: "token", cloudflare_api_token: "token" });
		expect(domainsAvailable()).toBe(false);
		useProvider("cloudflare", HOSTED);
		expect(domainsAvailable()).toBe(true);
	});

	test("refuses reserved, invalid, duplicate and unconfigured domains", async () => {
		const base = `/projects/${project}/store/domain`;
		expect((await call("POST", base, { hostname: "127.0.0.1" })).error).toBe(1251);
		expect((await call("POST", base, { hostname: "https://shop.example.com" })).error).toBe(1251);
		useProvider("manual", { target: "customers.rabbitpay.test" });
		expect((await call("POST", base, { hostname: "customers.rabbitpay.test" })).error).toBe(1251);

		expect((await call("POST", base, { hostname: "shop.example.com" })).error).toBe(0);
		expect((await call("POST", base, { hostname: "second.example.com" })).error).toBe(1253);
		expect((await call("POST", `/projects/${other}/store/domain`, { hostname: "shop.example.com" })).error).toBe(1165);

		useProvider("disabled");
		expect((await call("POST", `/projects/${other}/store/domain`, { hostname: "other.example.com" })).error).toBe(1252);
		expect((await call("GET", `/projects/${other}/store/domain`)).data).toMatchObject({ available: false, domain: null });
	});

	test("activates a manually provisioned domain once its TXT record and DNS are in place", async () => {
		useProvider("manual", { target: "customers.rabbitpay.test" });
		const connected = await call("POST", `/projects/${project}/store/domain`, { hostname: "shop.example.com" });
		expect(connected.data.domain.status).toBe("pending");
		const [pointer, ownership] = connected.data.domain.records;
		expect(pointer).toEqual({ type: "CNAME", name: "shop.example.com", value: "customers.rabbitpay.test" });
		expect(ownership.type).toBe("TXT");
		expect(ownership.name).toBe("_rabbitpay.shop.example.com");
		expect(ownership.value).toMatch(/^rabbitpay-verify=[A-Za-z0-9]{40}$/);

		expect((await page("shop.example.com")).status).toBe(200);
		expect(await (await page("shop.example.com")).text()).not.toContain("rabbitpay-store");

		cnames.set("shop.example.com", ["customers.rabbitpay.test."]);
		expect((await call("POST", `/projects/${project}/store/domain/check`)).data.domain.status).toBe("pending");

		txt.set("_rabbitpay.shop.example.com", [[ownership.value.slice(0, 20), ownership.value.slice(20)]]);
		const checked = await call("POST", `/projects/${project}/store/domain/check`);
		expect(checked.data.domain).toMatchObject({ hostname: "shop.example.com", status: "active", records: [] });
		expect((await call("GET", `/projects/${project}/store`)).data.domain_url).toBe("https://shop.example.com");
		expect(await (await page("shop.example.com")).text()).toContain('name="rabbitpay-store" content="pixel-domains" data-domain="1"');

		const moved = await Server.app.handle(new Request("http://127.0.0.1/shop/pixel-domains/cart?step=2"));
		expect(moved.status).toBe(302);
		expect(moved.headers.get("location")).toBe("https://shop.example.com/cart?step=2");
		expect(requests).toHaveLength(0);
	});

	test("accepts an apex domain whose A records match the target", async () => {
		useProvider("manual", { target: "customers.rabbitpay.test" });
		const connected = await call("POST", `/projects/${project}/store/domain`, { hostname: "example.com" });
		const ownership = connected.data.domain.records[1];
		txt.set(ownership.name, [[ownership.value]]);
		addresses.set("customers.rabbitpay.test", ["203.0.113.10", "203.0.113.11"]);
		addresses.set("example.com", ["203.0.113.99"]);
		expect((await call("POST", `/projects/${project}/store/domain/check`)).data.domain.status).toBe("pending");
		addresses.set("example.com", ["203.0.113.11"]);
		expect((await call("POST", `/projects/${project}/store/domain/check`)).data.domain.status).toBe("active");
	});

	test("provisions Cloudflare and BurrowGate for a hosted domain and removes both again", async () => {
		useProvider("cloudflare", HOSTED);
		Settings.server.burrowgate_secret = "origin-signing-secret";
		let tlsReads = 0;
		provide((url, method, body) => {
			if (url === "https://api.cloudflare.com/client/v4/zones/zone-id/custom_hostnames" && method === "POST") {
				expect(body).toEqual({ hostname: "shop.hosted.test", ssl: { method: "txt", type: "dv" } });
				return Response.json({
					success: true,
					result: {
						id: "cf-1",
						ownership_verification: { name: "_cf-custom-hostname.shop.hosted.test", value: "owner-token" },
						ssl: { validation_records: [{ txt_name: "_acme-challenge.shop.hosted.test", txt_value: "acme-token" }] },
					},
				});
			}
			if (url.endsWith("/custom_hostnames/cf-1") && method === "GET") {
				return Response.json({ success: true, result: { id: "cf-1", status: "active", ssl: { status: "active" } } });
			}
			if (url.endsWith("/custom_hostnames/cf-1") && method === "DELETE") return Response.json({ success: true, result: { id: "cf-1" } });
			if (url === "https://gateway.rabbitpay.test/_burrowgate/api/admin/sites" && method === "GET") {
				return Response.json({ items: [{ id: "main-site", publicHost: "127.0.0.1", originUrl: "http://10.0.0.5:8085" }] });
			}
			if (url === "https://gateway.rabbitpay.test/_burrowgate/api/admin/sites" && method === "POST") {
				expect(body).toMatchObject({
					name: "shop.hosted.test",
					publicHost: "shop.hosted.test",
					originUrl: "http://10.0.0.5:8085",
					originSigningSecret: "origin-signing-secret",
					ipExtractionPreset: "cloudflare",
					defaultAccessMode: "bypass",
				});
				return Response.json({ site: { id: "bg-1" } }, { status: 201 });
			}
			if (url.endsWith("/sites/bg-1/tls")) {
				tlsReads++;
				return Response.json(
					tlsReads === 1 ? { settings: { mode: "selfsigned" }, certificate: null } : { settings: { mode: "letsencrypt" }, certificate: { status: "active" } }
				);
			}
			if (url.endsWith("/sites/bg-1/certificate/letsencrypt") && method === "POST") {
				expect(body).toMatchObject({ email: "ops@rabbitpay.test", termsAccepted: true });
				return Response.json({ success: true });
			}
			if (url.endsWith("/sites/bg-1") && method === "DELETE") return Response.json({ success: true });
			return undefined;
		});

		try {
			const connected = await call("POST", `/projects/${project}/store/domain`, { hostname: "shop.hosted.test" });
			expect(connected.data.domain.records).toEqual([
				{ type: "CNAME", name: "shop.hosted.test", value: "customers.rabbitpay.test" },
				{ type: "TXT", name: "_cf-custom-hostname.shop.hosted.test", value: "owner-token" },
				{ type: "TXT", name: "_acme-challenge.shop.hosted.test", value: "acme-token" },
			]);

			expect(await checkWaitingDomains()).toBe(1);
			const [row] = await Database`SELECT status, provider_hostname_id, gateway_site_id FROM store_domains WHERE project = ${project}`;
			expect(row).toMatchObject({ status: "active", provider_hostname_id: "cf-1", gateway_site_id: "bg-1" });
			expect(tlsReads).toBe(2);
			expect(await (await page("shop.hosted.test")).text()).toContain('data-domain="1"');

			const removed = await call("DELETE", `/projects/${project}/store/domain`);
			expect(removed.data.domain).toBeNull();
			expect(requests.filter((request) => request.method === "DELETE").map((request) => request.url.split("/").pop())).toEqual(["cf-1", "bg-1"]);
			expect((await call("GET", `/projects/${project}/store`)).data.domain).toBeNull();
			expect(await (await page("shop.hosted.test")).text()).not.toContain("rabbitpay-store");
		} finally {
			Settings.server.burrowgate_secret = "";
		}
	});

	test("creates a BurrowGate site only after DNS reaches the gateway and never loops back to the public site", async () => {
		useProvider("burrowgate", { ...HOSTED, burrowgate_site_id: "", burrowgate_origin: "http://127.0.0.1:8099" });
		provide((url, method) => {
			if (url.endsWith("/_burrowgate/api/admin/sites") && method === "GET") return Response.json({ items: [] });
			return undefined;
		});
		const connected = await call("POST", `/projects/${project}/store/domain`, { hostname: "shop.gateway.test" });
		const ownership = connected.data.domain.records[1];
		expect((await call("POST", `/projects/${project}/store/domain/check`)).data.domain.status).toBe("pending");
		expect(requests).toHaveLength(0);

		txt.set(ownership.name, [[ownership.value]]);
		cnames.set("shop.gateway.test", ["customers.rabbitpay.test"]);
		const failed = await call("POST", `/projects/${project}/store/domain/check`);
		expect(failed.data.domain.status).toBe("error");
		const [row] = await Database`SELECT last_error FROM store_domains WHERE project = ${project}`;
		expect(row.last_error).toContain("points back at the public RabbitPay site");
		expect(JSON.stringify(failed.data)).not.toContain("points back");
	});

	test("names the address when the BurrowGate URL does not reach the BurrowGate API", async () => {
		useProvider("burrowgate", { ...HOSTED, burrowgate_url: "http://127.0.0.1:8085", burrowgate_origin: "http://10.0.0.5:8085" });
		provide((_url, method) => {
			if (method === "GET") return new Response("<!doctype html><title>RabbitPay</title>", { headers: { "Content-Type": "text/html" } });
			return Response.json({ error: 404, info: "Invalid API endpoint" }, { status: 404 });
		});
		const connected = await call("POST", `/projects/${project}/store/domain`, { hostname: "shop.misrouted.test" });
		const ownership = connected.data.domain.records[1];
		txt.set(ownership.name, [[ownership.value]]);
		cnames.set("shop.misrouted.test", ["customers.rabbitpay.test"]);

		expect((await call("POST", `/projects/${project}/store/domain/check`)).data.domain.status).toBe("error");
		const [row] = await Database`SELECT last_error FROM store_domains WHERE project = ${project}`;
		expect(row.last_error).toBe(
			"BurrowGate could not create the store domain site: POST http://127.0.0.1:8085/_burrowgate/api/admin/sites answered HTTP 404: Invalid API endpoint"
		);
	});

	test("releases the domain and its provider resources when the project is deleted", async () => {
		const doomed = (await call("POST", "/projects", { name: "doomed-domains", currency: "EUR" })).data.uuid;
		await openStore(doomed, "doomed-domains");
		await call("POST", `/projects/${doomed}/store/domain`, { hostname: "doomed.example.com" });
		await Database`UPDATE store_domains SET status = 'active', provider = 'burrowgate', gateway_site_id = 'bg-doomed' WHERE project = ${doomed}`;
		useProvider("burrowgate", HOSTED);
		provide((url, method) => (url.endsWith("/sites/bg-doomed") && method === "DELETE" ? Response.json({ success: true }) : undefined));

		expect((await call("DELETE", `/projects/${doomed}`)).error).toBe(0);
		expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
			"DELETE https://gateway.rabbitpay.test/_burrowgate/api/admin/sites/bg-doomed",
		]);
		expect(await Database`SELECT project FROM store_domains WHERE project = ${doomed}`).toHaveLength(0);
		expect((await call("POST", `/projects/${other}/store/domain`, { hostname: "doomed.example.com" })).error).toBe(0);
	});
});
