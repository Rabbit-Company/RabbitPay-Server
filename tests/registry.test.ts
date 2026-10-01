import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { deflateRawSync } from "node:zlib";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.registry.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { Settings } = await import("../server/settings");
const { registryEntries, replaceRegistry, splitAddress, unzipFirst } = await import("../server/registry/furs");

await Server.configure();

const password = new Bun.CryptoHasher("blake2b512").update("registry-owner").digest("hex");
let token = "";

async function call(path: string): Promise<any> {
	const response = await Server.app.handle(new Request(`http://localhost${path}`, { headers: { Authorization: `Bearer ${token}` } }));
	return (await response.json()) as { error: number; data: any };
}

function zip(name: string, content: string): Uint8Array {
	const data = new TextEncoder().encode(content);
	const packed = deflateRawSync(data);
	const file = new TextEncoder().encode(name);
	const local = new DataView(new ArrayBuffer(30));
	local.setUint32(0, 0x04034b50, true);
	local.setUint16(8, 8, true);
	local.setUint32(18, packed.length, true);
	local.setUint32(22, data.length, true);
	local.setUint16(26, file.length, true);
	const central = new DataView(new ArrayBuffer(46));
	central.setUint32(0, 0x02014b50, true);
	central.setUint16(10, 8, true);
	central.setUint32(20, packed.length, true);
	central.setUint32(24, data.length, true);
	central.setUint16(28, file.length, true);
	central.setUint32(42, 0, true);
	const directoryOffset = 30 + file.length + packed.length;
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, 1, true);
	end.setUint16(10, 1, true);
	end.setUint32(12, 46 + file.length, true);
	end.setUint32(16, directoryOffset, true);
	return new Uint8Array(Buffer.concat([new Uint8Array(local.buffer), file, packed, new Uint8Array(central.buffer), file, new Uint8Array(end.buffer)]));
}

const COMPANIES = [
	'﻿"Omejen obseg identifikacije";"Zavezanost za DDV";"Davčna številka zavezanca";"Matična številka";"Datum registracije za DDV";"Šifra dejavnosti";"Ime zavezanca";"Naslov zavezanca";"Finančni urad";"ID skupine za DDV"',
	'"";"*";"10000658";"6311881000";"23.04.2013";"68.310";"RONI NEPREMIČNINE, POSREDOVANJE IN SVETOVANJE V PROMETU Z NEPREMIČNINAMI, D.O.O.";"HACQUETOVA ULICA 9, 1000 LJUBLJANA";"08";""',
	'"";"";"10001514";"";"";"41.200";"KW KRANWERKE GMBH";"CLAUS-VON STAUFFENBERG-STRAßE 11-15, 68163 MANNHEIM";"08";""',
	'"O";"*";"10022821";"";"24.05.2022";"49.320";"SIA "EMINE"";"TIRAINES STACIJA 2, LV1058 TIRAINE";"12";""',
].join("\r\n");

const SOLE_TRADERS = [
	'﻿"Davčna številka";"Matična številka";"Šifra dejavnosti";"Ime zavezanca";"Naslov zavezanca";"Finančni urad"',
	'"10003878";"6379753000";"71.111";"AING PROJEKTIVNI BIRO, GREGOR GODINA S.P.                    ";"TRSTENJAKOVA ULICA 5 , 2250 PTUJ                    ";"14"',
	'"10002561";"7409125000";"70.200";"POSLOVNO SVETOVANJE, CVETKO KRIŽAN, S.P.                ";"CESTA BRATSTVA 4 , 6000 KOPER - CAPODISTRIA         ";"06"',
	'"10004688";"9582541000";"95.310";"PRIPRAVA VOZIL, KRISTIAN KLAVŽAR S.P.           ";"TRŽAŠKA CESTA 4 , 1000 LJUBLJANA                  ";"08"',
].join("\r\n");

const VAT_PERSONS = [
	'﻿"Omejen obseg identifikacije";"Davčna številka";"Ime in priimek zavezanca";"Naslov zavezanca";"Datum registracije za DDV";"Finančni urad "',
	'"";"10003878";"GREGOR GODINA          ";"TIBOLCI 41 B, 2272 GORIŠNICA        ";"01.11.2019";"14"',
].join("\r\n");

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await Server.app.handle(
		new Request("http://localhost/api/v1/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "registry-owner", email: "registry@example.com", password }),
		})
	);
	const login = await Server.app.handle(
		new Request("http://localhost/api/v1/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "registry-owner", password }),
		})
	);
	token = ((await login.json()) as { data: { token: string } }).data.token;
});

afterAll(async () => {
	Settings.registry.enabled = false;
	await Database.close();
	for (const suffix of ["", "-wal", "-shm"]) {
		try {
			unlinkSync(`${import.meta.dir}/.registry.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("FURS taxpayer lists", () => {
	test("deflated ZIP files are read without extra libraries", () => {
		expect(new TextDecoder().decode(unzipFirst(zip("DURS_zavezanci_PO.csv", COMPANIES)))).toBe(COMPANIES.slice(1));
		expect(() => unzipFirst(new Uint8Array([1, 2, 3]))).toThrow();
	});

	test("companies and sole traders are parsed with VAT status, address parts and foreign entities", () => {
		const entries = registryEntries(COMPANIES, SOLE_TRADERS, VAT_PERSONS, 1000);
		expect(entries).toHaveLength(6);
		const byTax = Object.fromEntries(entries.map((entry) => [entry.tax_number, entry]));
		expect(byTax["10000658"]).toMatchObject({
			kind: "company",
			vat_registered: 1,
			registration_number: "6311881000",
			street: "HACQUETOVA ULICA 9",
			postal_code: "1000",
			city: "LJUBLJANA",
			country: "SI",
		});
		expect(byTax["10022821"]).toMatchObject({ name: 'SIA "EMINE"', country: null, vat_registered: 1 });
		expect(byTax["10001514"]).toMatchObject({ country: null, postal_code: "68163", city: "MANNHEIM" });
		expect(byTax["10003878"]).toMatchObject({ kind: "sole_trader", vat_registered: 1, name: "AING PROJEKTIVNI BIRO, GREGOR GODINA S.P.", postal_code: "2250" });
		expect(byTax["10002561"]).toMatchObject({ vat_registered: 0, city: "KOPER - CAPODISTRIA" });
		expect(splitAddress("BOŻEJOWICE 1K, 59-700 BOLESŁAWIEC")).toEqual({ street: "BOŻEJOWICE 1K", postal_code: "59-700", city: "BOLESŁAWIEC" });
	});

	test("search finds companies by name without diacritics, tax number, VAT number and registration number", async () => {
		await replaceRegistry(registryEntries(COMPANIES, SOLE_TRADERS, VAT_PERSONS));
		Settings.registry.enabled = true;

		const byName = (await call("/api/v1/registry/companies?q=nepremicnine%20roni")).data.results;
		expect(byName).toHaveLength(1);
		expect(byName[0]).toMatchObject({
			source: "furs",
			name: "RONI NEPREMIČNINE, POSREDOVANJE IN SVETOVANJE V PROMETU Z NEPREMIČNINAMI, D.O.O.",
			tax_number: "10000658",
			vat_number: "SI10000658",
			registration_number: "6311881000",
			address_line1: "HACQUETOVA ULICA 9",
			postal_code: "1000",
			city: "LJUBLJANA",
			country: "SI",
			kind: "company",
		});
		expect((await call("/api/v1/registry/companies?q=SI%201000%200658")).data.results[0].tax_number).toBe("10000658");
		expect((await call("/api/v1/registry/companies?q=6379753")).data.results[0]).toMatchObject({ tax_number: "10003878", kind: "sole_trader" });
		expect((await call("/api/v1/registry/companies?q=krizan")).data.results[0]).toMatchObject({ tax_number: "10002561", vat_number: null });
		expect((await call("/api/v1/registry/companies?q=x")).data.results).toEqual([]);

		expect((await call("/api/v1/registry/vat/SI10003878")).data.result).toMatchObject({ source: "furs", name: "AING PROJEKTIVNI BIRO, GREGOR GODINA S.P." });
		expect((await call("/api/v1/registry/vat/DE123456789")).data.result).toBeNull();
		expect((await call("/api/v1/registry/vat/10000658")).data.result).toMatchObject({ source: "furs", vat_number: "SI10000658" });

		Settings.registry.enabled = false;
		expect((await call("/api/v1/registry/companies?q=roni")).data.results).toEqual([]);
		const anonymous = await Server.app.handle(new Request("http://localhost/api/v1/registry/companies?q=roni"));
		expect(anonymous.status).toBe(401);
	});
});
