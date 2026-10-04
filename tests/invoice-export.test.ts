import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import { prepareTest } from "./environment";
await prepareTest();

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { zipArchive } = await import("../server/zip");
const { localDate, shiftLocalDate } = await import("../server/timezone");

await Server.configure();

const password = (seed: string) => new Bun.CryptoHasher("blake2b512").update(seed).digest("hex");
const TIMEZONE = "Europe/Ljubljana";

async function raw(path: string, token: string): Promise<Response> {
	return await Server.app.handle(new Request(`http://127.0.0.1${path}`, { headers: { Authorization: `Bearer ${token}` } }));
}

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}) {
	const headers: Record<string, string> = {};
	if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
	if (options.body !== undefined) headers["Content-Type"] = "application/json";
	const res = await Server.app.handle(
		new Request(`http://127.0.0.1${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
	);
	const json = (await res.json()) as { error: number; info: string; data?: any };
	return { status: res.status, ...json };
}

async function account(name: string): Promise<string> {
	await call("POST", "/api/v1/auth/register", { body: { username: name, email: `${name}@example.com`, password: password(name) } });
	return (await call("POST", "/api/v1/auth/login", { body: { username: name, password: password(name) } })).data.token;
}

function zipEntries(archive: Uint8Array): { name: string; data: Uint8Array }[] {
	const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
	const end = archive.length - 22;
	expect(view.getUint32(end, true)).toBe(0x06054b50);
	const count = view.getUint16(end + 10, true);
	let cursor = view.getUint32(end + 16, true);
	const entries: { name: string; data: Uint8Array }[] = [];
	for (let index = 0; index < count; index++) {
		expect(view.getUint32(cursor, true)).toBe(0x02014b50);
		const checksum = view.getUint32(cursor + 16, true);
		const size = view.getUint32(cursor + 20, true);
		const nameLength = view.getUint16(cursor + 28, true);
		const local = view.getUint32(cursor + 42, true);
		const name = new TextDecoder().decode(archive.subarray(cursor + 46, cursor + 46 + nameLength));
		expect(view.getUint32(local, true)).toBe(0x04034b50);
		const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
		const data = archive.subarray(start, start + size);
		expect(Bun.hash.crc32(data)).toBe(checksum);
		entries.push({ name, data });
		cursor += 46 + nameLength;
	}
	return entries;
}

let ownerToken = "";
let outsiderToken = "";
let projectUuid = "";
const references: string[] = [];
const base = () => `/api/v1/projects/${projectUuid}`;
const today = () => localDate(Date.now(), TIMEZONE);

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();
	ownerToken = await account("export-owner");
	outsiderToken = await account("export-outsider");
	projectUuid = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "export-studio", currency: "EUR" } })).data.uuid;
	await call("PATCH", base(), { token: ownerToken, body: { timezone: TIMEZONE, language: "sl" } });
	const customer = (await call("POST", `${base()}/customers`, { token: ownerToken, body: { email: "buyer@example.com", name: "Buyer" } })).data.uuid;
	const invoice = (status: "draft" | "open") =>
		call("POST", `${base()}/invoices`, {
			token: ownerToken,
			body: {
				customer,
				currency: "EUR",
				due_date: Date.now() + 86_400_000,
				status,
				items: [{ description: "Design", quantity: 1, unit_price: 5000, tax_rate: 22 }],
			},
		});
	for (let index = 0; index < 4; index++) {
		const created = await invoice("open");
		expect(created.error).toBe(0);
		references.push(created.data.reference);
	}
	expect((await invoice("draft")).error).toBe(0);
});

afterAll(async () => {
	await Database.close();
});

describe("zip archive", () => {
	test("stores several files that read back intact", () => {
		const files = [
			{ name: "Račun 1.pdf", data: new TextEncoder().encode("first") },
			{ name: "Račun 2.pdf", data: new Uint8Array(0) },
			{ name: "Račun 3.pdf", data: crypto.getRandomValues(new Uint8Array(4096)) },
		];
		const read = zipEntries(zipArchive(files, Date.UTC(2026, 9, 4)));
		expect(read.map((entry) => entry.name)).toEqual(files.map((file) => file.name));
		expect(read.map((entry) => Buffer.from(entry.data).toString("hex"))).toEqual(files.map((file) => Buffer.from(file.data).toString("hex")));
	});
});

describe("invoice export", () => {
	test("summarises the issued invoices of a period and leaves drafts out", async () => {
		const summary = await call("GET", `${base()}/invoice-export?from=${today()}&to=${today()}`, { token: ownerToken });
		expect(summary.error).toBe(0);
		expect(summary.data.count).toBe(4);
		expect(summary.data.limit).toBe(1000);
		expect(summary.data.first.reference).toBe(references[0]);
		expect(summary.data.last.reference).toBe(references[3]);

		const earlier = shiftLocalDate(today(), -40);
		const empty = await call("GET", `${base()}/invoice-export?from=${earlier}&to=${shiftLocalDate(today(), -10)}`, { token: ownerToken });
		expect(empty.data).toEqual({ count: 0, limit: 1000, first: null, last: null });
	});

	test("selects a range of numbers in either order", async () => {
		const forward = await call("GET", `${base()}/invoice-export?first=${references[1]}&last=${references[2]}`, { token: ownerToken });
		expect(forward.data.count).toBe(2);
		expect([forward.data.first.reference, forward.data.last.reference]).toEqual([references[1], references[2]]);

		const backward = await call("GET", `${base()}/invoice-export?first=${references[3]}&last=${references[1]}`, { token: ownerToken });
		expect(backward.data.count).toBe(3);
		expect([backward.data.first.reference, backward.data.last.reference]).toEqual([references[1], references[3]]);

		const single = await call("GET", `${base()}/invoice-export?first=${references[0]}&last=${references[0]}`, { token: ownerToken });
		expect(single.data.count).toBe(1);
	});

	test("downloads one PDF per invoice in a zip named after the range", async () => {
		const response = await raw(`${base()}/invoice-export/zip?first=${references[0]}&last=${references[2]}`, ownerToken);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("application/zip");
		expect(decodeURIComponent(response.headers.get("Content-Disposition")!)).toContain(`Računi ${references[0]} - ${references[2]}.zip`);

		const entries = zipEntries(new Uint8Array(await response.arrayBuffer()));
		expect(entries.map((entry) => entry.name)).toEqual(references.slice(0, 3).map((reference) => `Račun ${reference}.pdf`));
		for (const entry of entries) expect(new TextDecoder().decode(entry.data.subarray(0, 5))).toBe("%PDF-");

		const single = await raw(
			`${base()}/invoices/${(await call("GET", `${base()}/invoices?reference=${references[0]}`, { token: ownerToken })).data.invoices[0].uuid}/pdf`,
			ownerToken
		);
		expect(Buffer.from(entries[0].data).equals(Buffer.from(await single.arrayBuffer()))).toBe(true);

		const [logged] = (await Database`SELECT new_value FROM audit_log WHERE project = ${projectUuid} AND action = 'invoices.exported'`) as {
			new_value: string;
		}[];
		expect(JSON.parse(logged.new_value)).toMatchObject({ kind: "numbers", count: 3, first: references[0], last: references[2] });
	});

	test("downloads a whole period", async () => {
		const response = await raw(`${base()}/invoice-export/zip?from=${today()}&to=${today()}`, ownerToken);
		expect(response.status).toBe(200);
		expect(zipEntries(new Uint8Array(await response.arrayBuffer()))).toHaveLength(4);
	});

	test("refuses selections that cannot be downloaded", async () => {
		const get = (query: string) => call("GET", `${base()}/invoice-export${query}`, { token: ownerToken });
		expect((await get("")).error).toBe(1288);
		expect((await get("?from=2026-02-30&to=2026-03-01")).error).toBe(1288);
		expect((await get(`?from=${today()}&to=${shiftLocalDate(today(), -1)}`)).error).toBe(1288);
		expect((await get(`?first=${references[0]}`)).error).toBe(1288);
		expect((await get(`?first=${references[0]}&last=${references[1]}&from=${today()}&to=${today()}`)).error).toBe(1288);
		expect((await get(`?first=${references[0]}&last=NOPE-1`)).error).toBe(1035);
		expect((await get("/zip?first=NOPE-1&last=NOPE-2")).error).toBe(1035);
		expect((await get(`/zip?from=${shiftLocalDate(today(), -40)}&to=${shiftLocalDate(today(), -10)}`)).error).toBe(1289);
	});

	test("is closed to people outside the project", async () => {
		const summary = await call("GET", `${base()}/invoice-export?from=${today()}&to=${today()}`, { token: outsiderToken });
		expect(summary.error).not.toBe(0);
		const archive = await raw(`${base()}/invoice-export/zip?from=${today()}&to=${today()}`, outsiderToken);
		expect(archive.headers.get("Content-Type")).not.toBe("application/zip");
	});
});
