import Database from "../database/database";
import { splitVatNumber } from "../tax";
import { checkVatNumber, isEnabled as viesEnabled, ViesUnavailable } from "../vies";
import { fold, splitAddress } from "./furs";

export interface CompanyLookup {
	source: "furs" | "vies";
	name: string;
	tax_number: string | null;
	vat_number: string | null;
	registration_number: string | null;
	address_line1: string | null;
	postal_code: string | null;
	city: string | null;
	country: string | null;
	kind: "company" | "sole_trader" | null;
}

interface RegistryRow {
	tax_number: string;
	registration_number: string | null;
	vat_registered: number;
	kind: "company" | "sole_trader";
	name: string;
	street: string | null;
	postal_code: string | null;
	city: string | null;
	country: string | null;
}

const LIMIT = 10;
const VIES_CACHE_MS = 24 * 60 * 60 * 1000;
const viesCache = new Map<string, { at: number; result: CompanyLookup | null }>();

function present(row: RegistryRow): CompanyLookup {
	return {
		source: "furs",
		name: row.name,
		tax_number: row.tax_number,
		vat_number: Number(row.vat_registered) === 1 ? `SI${row.tax_number}` : null,
		registration_number: row.registration_number,
		address_line1: row.street,
		postal_code: row.postal_code,
		city: row.city,
		country: row.country,
		kind: row.kind,
	};
}

export async function searchRegistry(query: string): Promise<CompanyLookup[]> {
	const compact = query.toUpperCase().replace(/[\s.\-/]/g, "");
	const columns = Database`tax_number, registration_number, vat_registered, kind, name, street, postal_code, city, country`;
	if (/^(SI)?\d{8}$/.test(compact)) {
		const rows = (await Database`SELECT ${columns} FROM company_registry WHERE tax_number = ${compact.slice(-8)}`) as RegistryRow[];
		return rows.map(present);
	}
	if (/^\d{7}(\d{3})?$/.test(compact)) {
		const rows = (await Database`
			SELECT ${columns} FROM company_registry WHERE registration_number LIKE ${`${compact.slice(0, 7)}%`} ORDER BY registration_number LIMIT ${LIMIT}
		`) as RegistryRow[];
		return rows.map(present);
	}
	const words = fold(query)
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length >= 2)
		.slice(0, 6);
	if (words.length === 0) return [];
	const filters = words.map((word) => Database`AND search LIKE ${`%${word}%`}`);
	const where = filters.reduce((all, part) => Database`${all} ${part}`, Database``);
	const rows = (await Database`
		SELECT ${columns} FROM company_registry WHERE 1 = 1 ${where}
		ORDER BY CASE WHEN search LIKE ${`${words[0]}%`} THEN 0 ELSE 1 END, CASE WHEN country = 'SI' THEN 0 ELSE 1 END, vat_registered DESC, LENGTH(name), name
		LIMIT ${LIMIT}
	`) as RegistryRow[];
	return rows.map(present);
}

function viesAddress(address: string | null): Pick<CompanyLookup, "address_line1" | "postal_code" | "city"> {
	if (!address) return { address_line1: null, postal_code: null, city: null };
	const lines = address
		.split(/\n|,/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length < 2) {
		const parts = splitAddress(address);
		return { address_line1: parts.street, postal_code: parts.postal_code, city: parts.city };
	}
	const last = lines[lines.length - 1];
	const match = /^([A-Z]{0,3}-?[\dA-Z]{3,8}(?:\s\d[A-Z]{2})?)\s+(.+)$/i.exec(last);
	return {
		address_line1: lines.slice(0, -1).join(", "),
		postal_code: match ? match[1] : null,
		city: match ? match[2] : last,
	};
}

export async function lookupVat(raw: string): Promise<CompanyLookup | null> {
	if (/^\d{8}$/.test(raw.replace(/[\s.\-/]/g, ""))) return (await searchRegistry(raw))[0] ?? null;
	const parts = splitVatNumber(raw, null);
	if (!parts) return null;
	if (parts.country === "SI") {
		const [found] = await searchRegistry(parts.number);
		if (found) return found;
	}
	if (!viesEnabled()) return null;
	const key = `${parts.prefix}${parts.number}`;
	const cached = viesCache.get(key);
	if (cached && Date.now() - cached.at < VIES_CACHE_MS) return cached.result;
	try {
		const answer = await checkVatNumber(parts, null);
		const result: CompanyLookup | null =
			answer.valid && answer.name
				? {
						source: "vies",
						name: answer.name,
						tax_number: null,
						vat_number: key,
						registration_number: null,
						...viesAddress(answer.address),
						country: parts.country,
						kind: null,
					}
				: null;
		viesCache.set(key, { at: Date.now(), result });
		return result;
	} catch (error) {
		if (error instanceof ViesUnavailable) return null;
		throw error;
	}
}
