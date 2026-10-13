import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { prepareTest } from "./environment";

await prepareTest();

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { searchPatterns } = await import("../server/text-search");

await Server.configure();

const password = new Bun.CryptoHasher("blake2b512").update("searcher").digest("hex");
let token = "";
let project = "";

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

async function customersFor(search: string): Promise<string[]> {
	const found = await call("GET", `/projects/${project}/customers?search=${encodeURIComponent(search)}`);
	return found.data.customers.map((customer: { name: string }) => customer.name).sort();
}

async function itemsFor(search: string): Promise<string[]> {
	const found = await call("GET", `/projects/${project}/items?search=${encodeURIComponent(search)}`);
	return found.data.items.map((item: { name: string }) => item.name).sort();
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await call("POST", "/auth/register", { email: "searcher@example.com", password });
	token = (await call("POST", "/auth/login", { email: "searcher@example.com", password })).data.token;
	project = (await call("POST", "/projects", { name: "primer-iskanje" })).data.uuid;
	for (const name of ["PRIMER ŠIVILJSTVO ČEŠNJA D.O.O.", "Primer Žaga Šmarje s.p.", "primer čistilni servis", "Primer Gradnje d.o.o.", "100% Primer_Les"]) {
		await call("POST", `/projects/${project}/customers`, { name, email: `${name.length}@example.com` });
	}
	for (const name of ["ČIŠČENJE PISARN", "Šivanje zaves", "Žaganje drv"]) {
		await call("POST", `/projects/${project}/items`, { name, unit_price: 1000, tax_rate: 22 });
	}
});

afterAll(async () => {
	await Database.close();
});

describe("search patterns", () => {
	test("are one lowered pattern where the database folds every letter", () => {
		expect(searchPatterns("Pošta", true)).toEqual(["%pošta%"]);
	});

	test("cover every casing of letters outside ASCII where the database folds only ASCII", () => {
		expect(searchPatterns("Pošta", false).sort()).toEqual(["%poŠta%", "%pošta%"]);
		expect(searchPatterns("ČEŠNJA", false).sort()).toEqual(["%ČeŠnja%", "%Češnja%", "%čeŠnja%", "%češnja%"]);
		expect(searchPatterns("gradnje", false)).toEqual(["%gradnje%"]);
	});

	test("fall back to lower, upper and title case for long text with many such letters", () => {
		const patterns = searchPatterns("žaga šmarje čistilni šivilja žužek čebela", false);
		expect(patterns).toContain("%žaga šmarje čistilni šivilja žužek čebela%");
		expect(patterns).toContain("%Žaga Šmarje Čistilni Šivilja ŽuŽek Čebela%");
		expect(patterns).toContain("%Žaga Šmarje Čistilni Šivilja Žužek Čebela%");
		expect(patterns.length).toBe(3);
	});

	test("treat percent and underscore as text", () => {
		expect(searchPatterns("100%_a!", true)).toEqual(["%100!%!_a!!%"]);
	});
});

describe("searching names with č, š and ž", () => {
	test("finds a customer whatever the casing typed or stored", async () => {
		expect(await customersFor("češnja")).toEqual(["PRIMER ŠIVILJSTVO ČEŠNJA D.O.O."]);
		expect(await customersFor("Šiviljstvo")).toEqual(["PRIMER ŠIVILJSTVO ČEŠNJA D.O.O."]);
		expect(await customersFor("ŽAGA ŠMARJE")).toEqual(["Primer Žaga Šmarje s.p."]);
		expect(await customersFor("žaga")).toEqual(["Primer Žaga Šmarje s.p."]);
		expect(await customersFor("ČISTILNI")).toEqual(["primer čistilni servis"]);
		expect(await customersFor("gradnje")).toEqual(["Primer Gradnje d.o.o."]);
		expect((await customersFor("PRIMER")).length).toBe(5);
		expect(await customersFor("šmarna")).toEqual([]);
	});

	test("finds an item the same way", async () => {
		expect(await itemsFor("čiščenje")).toEqual(["ČIŠČENJE PISARN"]);
		expect(await itemsFor("ŠIVANJE")).toEqual(["Šivanje zaves"]);
		expect(await itemsFor("žag")).toEqual(["Žaganje drv"]);
	});

	test("does not read percent or underscore as wildcards", async () => {
		expect(await customersFor("100%")).toEqual(["100% Primer_Les"]);
		expect(await customersFor("r_l")).toEqual(["100% Primer_Les"]);
		expect(await customersFor("_")).toEqual(["100% Primer_Les"]);
	});
});
