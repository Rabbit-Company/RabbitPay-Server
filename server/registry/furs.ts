import { inflateRawSync } from "node:zlib";
import Database from "../database/database";

export const FURS_FILES = {
	companies: "https://www.fu.gov.si/fileadmin/prenosi/DURS_zavezanci_PO_csv.zip",
	soleTraders: "https://www.fu.gov.si/fileadmin/prenosi/DURS_zavezanci_DEJ_csv.zip",
	vatPersons: "https://www.fu.gov.si/fileadmin/prenosi/DURS_zavezanci_FO_csv.zip",
} as const;

const BATCH = 500;

export interface RegistryEntry {
	tax_number: string;
	registration_number: string | null;
	vat_registered: number;
	kind: "company" | "sole_trader";
	name: string;
	street: string | null;
	postal_code: string | null;
	city: string | null;
	country: string | null;
	activity: string | null;
	search: string;
	updated: number;
}

export class RegistryFileUnreadable extends Error {}

export function unzipFirst(bytes: Uint8Array): Uint8Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let end = -1;
	for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
		if (view.getUint32(offset, true) === 0x06054b50) {
			end = offset;
			break;
		}
	}
	if (end < 0) throw new RegistryFileUnreadable("The file is not a ZIP archive");
	const directory = view.getUint32(end + 16, true);
	if (view.getUint32(directory, true) !== 0x02014b50) throw new RegistryFileUnreadable("The ZIP directory is damaged");
	const method = view.getUint16(directory + 10, true);
	const compressedSize = view.getUint32(directory + 20, true);
	const local = view.getUint32(directory + 42, true);
	if (view.getUint32(local, true) !== 0x04034b50) throw new RegistryFileUnreadable("The ZIP entry is damaged");
	const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
	const data = bytes.subarray(start, start + compressedSize);
	if (method === 0) return data;
	if (method === 8) return new Uint8Array(inflateRawSync(data));
	throw new RegistryFileUnreadable(`Unsupported ZIP compression ${method}`);
}

export function rows(text: string): string[][] {
	return text
		.replace(/^﻿/, "")
		.split(/\r?\n/)
		.slice(1)
		.map((line) => line.trim())
		.filter((line) => line.startsWith('"') && line.endsWith('"'))
		.map((line) =>
			line
				.slice(1, -1)
				.split('";"')
				.map((cell) => cell.trim())
		);
}

export function fold(value: string): string {
	return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function splitAddress(value: string): { street: string | null; postal_code: string | null; city: string | null } {
	const text = value.replace(/\s+/g, " ").replace(/ ,/g, ",").trim();
	const match = /^(.*),\s*([A-Z]{0,3}-?\d{2,6}(?:-\d{3})?|\d{4}\s?[A-Z]{2})\s+(.+)$/.exec(text);
	if (!match) return { street: text || null, postal_code: null, city: null };
	return { street: match[1].trim() || null, postal_code: match[2], city: match[3].trim() };
}

function entry(
	kind: RegistryEntry["kind"],
	tax: string,
	registration: string,
	vat: boolean,
	name: string,
	address: string,
	activity: string,
	foreign: boolean,
	now: number
): RegistryEntry | null {
	if (!/^\d{8}$/.test(tax) || !name) return null;
	const parts = splitAddress(address);
	return {
		tax_number: tax,
		registration_number: /^\d{7,10}$/.test(registration) ? registration : null,
		vat_registered: vat ? 1 : 0,
		kind,
		name: name.replace(/\s+/g, " ").slice(0, 300),
		...parts,
		country: foreign ? null : "SI",
		activity: activity || null,
		search: fold(`${name} ${parts.city ?? ""} ${tax} ${registration}`),
		updated: now,
	};
}

function placeKey(address: string): string | null {
	const parts = splitAddress(address);
	return parts.postal_code && /^\d{4}$/.test(parts.postal_code) && parts.city ? `${parts.postal_code} ${parts.city}` : null;
}

export function registryEntries(companies: string, soleTraders: string, vatPersons: string, now = Date.now()): RegistryEntry[] {
	const vat = new Set(rows(vatPersons).map((cells) => cells[1]));
	const traders = rows(soleTraders);
	const slovenian = new Set(traders.map((cells) => placeKey(cells[4] ?? "")).filter((key): key is string => key !== null));
	const result = new Map<string, RegistryEntry>();
	for (const cells of rows(companies)) {
		const [limited, registered, tax, registration, , activity, name, address] = cells;
		const place = placeKey(address ?? "");
		const foreign = limited === "O" || place === null || !slovenian.has(place);
		const row = entry("company", tax, registration, registered === "*", name, address ?? "", activity, foreign, now);
		if (row) result.set(row.tax_number, row);
	}
	for (const cells of traders) {
		const [tax, registration, activity, name, address] = cells;
		if (result.has(tax)) continue;
		const row = entry("sole_trader", tax, registration, vat.has(tax), name, address ?? "", activity, false, now);
		if (row) result.set(row.tax_number, row);
	}
	return [...result.values()];
}

export async function replaceRegistry(entries: RegistryEntry[]): Promise<void> {
	await Database.begin(async (tx) => {
		await tx`DELETE FROM company_registry`;
		for (let start = 0; start < entries.length; start += BATCH) {
			const batch = entries.slice(start, start + BATCH).map((row) => ({ ...row }));
			await tx`INSERT INTO company_registry ${tx(
				batch,
				"tax_number",
				"registration_number",
				"vat_registered",
				"kind",
				"name",
				"street",
				"postal_code",
				"city",
				"country",
				"activity",
				"search",
				"updated"
			)}`;
		}
	});
}

async function download(url: string): Promise<string> {
	const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
	if (!response.ok) throw new RegistryFileUnreadable(`${url} answered ${response.status}`);
	return new TextDecoder().decode(unzipFirst(new Uint8Array(await response.arrayBuffer())));
}

export async function refreshRegistry(): Promise<number> {
	const companies = await download(FURS_FILES.companies);
	const soleTraders = await download(FURS_FILES.soleTraders);
	const vatPersons = await download(FURS_FILES.vatPersons);
	const entries = registryEntries(companies, soleTraders, vatPersons);
	if (entries.length < 1000) throw new RegistryFileUnreadable(`Only ${entries.length} taxpayers were read, keeping the previous list`);
	await replaceRegistry(entries);
	return entries.length;
}

export async function registryAge(): Promise<number | null> {
	const [row] = (await Database`SELECT MAX(updated) AS updated FROM company_registry`) as { updated: number | null }[];
	return row?.updated === null || row?.updated === undefined ? null : Date.now() - Number(row.updated);
}
