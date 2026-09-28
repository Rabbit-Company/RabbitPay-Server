import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const FIXTURE = `${import.meta.dir}/.web-fixture`;

import { prepareTest } from "./environment";
await prepareTest();

mkdirSync(FIXTURE, { recursive: true });
writeFileSync(
	`${FIXTURE}/index.html`,
	'<!doctype html><html lang="en"><head><meta name="robots" content="noindex, nofollow" /><title>RabbitPay</title></head><body></body></html>'
);
writeFileSync(`${FIXTURE}/index-abcd1234.js`, "console.log(1)");
writeFileSync(`${FIXTURE}/plain.js`, "console.log(2)");

const { Settings } = await import("../server/settings");
Settings.web = { enabled: true, path: FIXTURE, landing_page: true };

const { Server } = await import("../server/server");
await Server.configure();

async function get(path: string, method = "GET") {
	return await Server.app.handle(new Request(`http://127.0.0.1${path}`, { method }));
}

afterAll(() => {
	rmSync(FIXTURE, { recursive: true, force: true });
});

describe("web interface", () => {
	test("rejects a streamed body over the request limit without Content-Length", async () => {
		const request = new Request("http://127.0.0.1/api/v1/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(300 * 1024));
					controller.close();
				},
			}),
			duplex: "half",
		});
		expect(request.headers.get("Content-Length")).toBeNull();

		const response = await Server.app.handle(request);
		expect(response.status).toBe(413);
		expect(await response.text()).toContain("Request body too large");
	});

	test("preserves a streamed body below the request limit", async () => {
		const request = new Request("http://127.0.0.1/api/v1/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("{}"));
					controller.close();
				},
			}),
			duplex: "half",
		});

		const response = await Server.app.handle(request);
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: number }).error).toBe(1003);
	});

	test("serves the app at the root", async () => {
		const res = await get("/");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(await res.text()).toContain("RabbitPay");
	});

	test("lets search engines index the home page and describes it", async () => {
		const html = await (await get("/")).text();
		expect(html).toContain('<meta name="robots" content="index, follow" />');
		expect(html).toContain('<meta name="rabbitpay-landing" content="1" data-free-payments="50" data-free-storage="1" />');
		expect(html).toContain('<meta property="og:url" content="http://127.0.0.1:8099/" />');
		expect(html).toContain("<title>RabbitPay | Invoicing and payments</title>");
	});

	test("keeps application pages out of search engines", async () => {
		const html = await (await get("/login")).text();
		expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
		expect(html).toContain('<meta name="rabbitpay-landing" content="1"');
		expect(html).not.toContain('name="description"');
	});

	test("leaves the page untouched when the home page is turned off", async () => {
		Settings.web.landing_page = false;
		try {
			const html = await (await get("/")).text();
			expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
			expect(html).not.toContain("rabbitpay-landing");
		} finally {
			Settings.web.landing_page = true;
		}
	});

	test("serves a built asset", async () => {
		const res = await get("/index-abcd1234.js");
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("console.log(1)");
	});

	test("caches hashed assets immutably", async () => {
		const res = await get("/index-abcd1234.js");
		expect(res.headers.get("cache-control")).toContain("immutable");
	});

	test("does not cache unhashed assets immutably", async () => {
		const res = await get("/plain.js");
		expect(res.headers.get("cache-control")).not.toContain("immutable");
	});

	test("never caches the shell", async () => {
		const res = await get("/");
		expect(res.headers.get("cache-control")).toBe("no-cache");
	});

	test("falls back to the app for client side routes", async () => {
		const res = await get("/projects/2f1c5f0c-2b1a-4f1e-9d7a-9a6b1f0c4d3e/invoices");
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("RabbitPay");
	});

	test("keeps API 404s as JSON", async () => {
		const res = await get("/api/v1/nope");
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(((await res.json()) as { error: number }).error).toBe(404);
	});

	test("does not serve the app for missing asset files", async () => {
		const res = await get("/missing-asset.js");
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("application/json");
	});

	test("never serves a file from outside the web root", async () => {
		for (const attempt of ["/../.env", "/../../etc/passwd", "/..%2f.env", "/%2e%2e/.env", "/%2e%2e%2f.env"]) {
			const body = await (await get(attempt)).text();
			expect(body).not.toContain("RABBITPAY_MASTER_KEY");
			expect(body).not.toContain("root:");
		}
	});

	test("rejects encoded traversal to a real file", async () => {
		const res = await get("/%2e%2e/package.json");
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("application/json");
	});

	test("refuses non read methods", async () => {
		const res = await get("/", "DELETE");
		expect(res.status).toBe(404);
	});

	test("sets nosniff on the shell", async () => {
		const res = await get("/");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	});
});

const builtShell = Bun.file(`${import.meta.dir}/../web/dist/index.html`);
const isBuilt = await builtShell.exists();

describe.skipIf(!isBuilt)("built bundle", () => {
	test("references assets from an absolute path", async () => {
		const html = await builtShell.text();
		const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);

		expect(references.length).toBeGreaterThan(0);
		for (const reference of references) {
			expect(reference.startsWith("/")).toBe(true);
		}
	});
});
