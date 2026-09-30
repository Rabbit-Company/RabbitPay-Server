import Database from "../database/database";
import { safeInteger } from "../database/numbers";
import { endOfLocalDate, startOfLocalDate } from "../timezone";
import type { ProjectRow } from "../database/models";
import type { KpoColumn, KpoRow, KpoBook } from "./types";

const COLUMNS: { column: KpoColumn; prefixes: string[] }[] = [
	{ column: "revenue_sales", prefixes: ["760", "761", "762", "763"] },
	{ column: "revenue_other", prefixes: ["7"] },
	{ column: "material", prefixes: ["40", "702"] },
	{ column: "services", prefixes: ["41"] },
	{ column: "labor", prefixes: ["47"] },
	{ column: "depreciation", prefixes: ["43", "720"] },
	{ column: "interest", prefixes: ["45", "74"] },
	{ column: "taxes_contributions", prefixes: ["48", "81"] },
	{ column: "other_costs", prefixes: ["4", "7"] },
];

function columnFor(code: string, kind: string): KpoColumn | null {
	for (const { column, prefixes } of COLUMNS) {
		const revenueColumn = column.startsWith("revenue");
		if (revenueColumn !== (kind === "revenue")) continue;
		if (prefixes.some((prefix) => code.startsWith(prefix))) return column;
	}
	return null;
}

export async function kpoBook(project: ProjectRow, year: number): Promise<KpoBook> {
	const from = startOfLocalDate(`${year}-01-01`, project.timezone);
	const to = endOfLocalDate(`${year}-12-31`, project.timezone);
	const lines = (await Database`
		SELECT je.uuid, je.year, je.number, je.entry_date, je.description, je.source_type, la.code, la.account_kind, jl.debit, jl.credit
		FROM journal_lines jl
		JOIN journal_entries je ON je.uuid = jl.entry
		JOIN ledger_accounts la ON la.uuid = jl.ledger_account
		WHERE jl.project = ${project.uuid} AND je.entry_date BETWEEN ${from} AND ${to} AND la.account_kind IN ('revenue', 'expense')
			AND je.source_type NOT IN ('year_result', 'year_closing', 'year_opening')
			AND NOT (je.reverses IS NOT NULL AND EXISTS (
				SELECT 1 FROM journal_entries o WHERE o.uuid = je.reverses AND o.source_type IN ('year_result', 'year_closing', 'year_opening')))
		ORDER BY je.entry_date, je.year, je.number
	`) as {
		uuid: string;
		year: number;
		number: number;
		entry_date: number;
		description: string;
		code: string;
		account_kind: string;
		debit: number;
		credit: number;
	}[];
	const rows = new Map<string, KpoRow>();
	const totals: Record<KpoColumn, number> = {
		revenue_sales: 0,
		revenue_other: 0,
		material: 0,
		services: 0,
		labor: 0,
		depreciation: 0,
		interest: 0,
		taxes_contributions: 0,
		other_costs: 0,
	};
	for (const line of lines) {
		const column = columnFor(line.code, line.account_kind);
		if (column === null) continue;
		const amount = line.account_kind === "revenue" ? safeInteger(line.credit) - safeInteger(line.debit) : safeInteger(line.debit) - safeInteger(line.credit);
		const row = rows.get(line.uuid) ?? {
			entry: line.uuid,
			number: `${line.year}/${line.number}`,
			date: line.entry_date,
			description: line.description,
			amounts: {},
		};
		row.amounts[column] = (row.amounts[column] ?? 0) + amount;
		rows.set(line.uuid, row);
		totals[column] += amount;
	}
	const revenue = totals.revenue_sales + totals.revenue_other;
	const expenses = Object.entries(totals)
		.filter(([column]) => !column.startsWith("revenue"))
		.reduce((sum, [, value]) => sum + value, 0);
	return {
		year,
		rows: [...rows.values()].map((row, index) => ({ ...row, sequence: index + 1 })),
		totals,
		revenue,
		expenses,
		result: revenue - expenses,
	};
}
