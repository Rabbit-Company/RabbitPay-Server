import Database from "../database/database";
import { safeInteger } from "../database/numbers";

export interface TaxableStockLine {
	base: number;
	rate: number;
	vat: number;
}

export interface TaxableStockDocument {
	uuid: string;
	number: string;
	date: number;
	document_type: "issue" | "stocktake";
	reason: string | null;
	lines: TaxableStockLine[];
}

export function stockVat(value: number, rate: number): number {
	return Math.round((Math.abs(value) * rate) / 100);
}

export async function taxableStockDocuments(project: string, from: number, to: number): Promise<TaxableStockDocument[]> {
	const rows = (await Database`
		SELECT d.uuid AS uuid, d.number AS number, d.document_type AS document_type, d.reason AS reason, m.movement_date AS movement_date, m.value AS value,
			COALESCE(l.tax_rate, c.tax_rate, 0) AS rate
		FROM stock_movements m JOIN stock_documents d ON d.uuid = m.document JOIN catalog_items c ON c.uuid = m.item
			LEFT JOIN stock_document_lines l ON l.uuid = m.document_line
		WHERE m.project = ${project} AND d.status = 'posted' AND d.charge_vat = 1 AND m.movement_kind IN ('issue', 'shortage')
			AND m.movement_date BETWEEN ${from} AND ${to}
		ORDER BY m.movement_date ASC, m.sequence ASC
	`) as { uuid: string; number: string; document_type: "issue" | "stocktake"; reason: string | null; movement_date: number; value: number; rate: number }[];
	const documents = new Map<string, TaxableStockDocument>();
	for (const row of rows) {
		const value = safeInteger(row.value);
		if (value === 0) continue;
		const rate = Number(row.rate);
		const document = documents.get(row.uuid) ?? {
			uuid: row.uuid,
			number: row.number,
			date: safeInteger(row.movement_date),
			document_type: row.document_type,
			reason: row.reason,
			lines: [],
		};
		documents.set(row.uuid, document);
		document.lines.push({ base: Math.abs(value), rate, vat: stockVat(value, rate) });
	}
	return [...documents.values()];
}
