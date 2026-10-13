import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { prepareTest } from "./environment";

await prepareTest();

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");

await Server.configure();

const password = new Bun.CryptoHasher("blake2b512").update("namer").digest("hex");
let token = "";

async function call(method: string, path: string, body?: unknown) {
	const response = await Server.app.handle(
		new Request(`http://127.0.0.1/api/v1${path}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	);
	return (await response.json()) as { error: number; data: any };
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await call("POST", "/auth/register", { email: "namer@example.com", password });
	token = (await call("POST", "/auth/login", { email: "namer@example.com", password })).data.token;
});

afterAll(async () => {
	await Database.close();
});

describe("naming a new project", () => {
	test("keeps the business name customers see next to the short name", async () => {
		const created = await call("POST", "/projects", { name: "primer-gradnje", display_name: "  Primer gradnje d.o.o.  " });
		expect(created.error).toBe(0);
		expect(created.data.name).toBe("primer-gradnje");
		expect(created.data.display_name).toBe("Primer gradnje d.o.o.");
		expect(created.data.public_name).toBe("Primer gradnje d.o.o.");

		const read = await call("GET", `/projects/${created.data.uuid}`);
		expect(read.data.display_name).toBe("Primer gradnje d.o.o.");
		expect(read.data.public_name).toBe("Primer gradnje d.o.o.");
	});

	test("falls back to the short name when no business name is given", async () => {
		const created = await call("POST", "/projects", { name: "primer-brez-imena", display_name: "   " });
		expect(created.data.display_name).toBeNull();
		expect(created.data.public_name).toBe("primer-brez-imena");
		expect((await call("POST", "/projects", { name: "primer-samo-ime" })).data.public_name).toBe("primer-samo-ime");
	});

	test("refuses a business name that is too long or not text", async () => {
		expect((await call("POST", "/projects", { name: "primer-dolgo", display_name: "x".repeat(121) })).error).not.toBe(0);
		expect((await call("POST", "/projects", { name: "primer-stevilka", display_name: 42 })).error).not.toBe(0);
	});
});
