import Database from "../database/database";
import { addIntegers, safeInteger } from "../database/numbers";
import { endOfLocalDate, startOfLocalDate } from "../timezone";
import type { LedgerAccountRow, ProjectRow } from "../database/models";
import type { FinancialStatements, StatementLine } from "./types";

interface LineDefinition {
	id: string;
	label: string;
	prefixes?: string[];
	children?: LineDefinition[];
	result?: "current" | "carried";
	negate?: boolean;
}

const ASSETS: LineDefinition[] = [
	{
		id: "A",
		label: "Dolgoročna sredstva",
		children: [
			{
				id: "A.I",
				label: "Neopredmetena sredstva in dolgoročne aktivne časovne razmejitve",
				children: [
					{ id: "A.I.1", label: "Neopredmetena sredstva", prefixes: ["000", "001", "002", "003", "004", "005", "006", "008", "009"] },
					{ id: "A.I.2", label: "Dolgoročne aktivne časovne razmejitve", prefixes: ["007"] },
				],
			},
			{ id: "A.II", label: "Opredmetena osnovna sredstva", prefixes: ["02", "03", "04", "05"] },
			{ id: "A.III", label: "Naložbene nepremičnine", prefixes: ["01"] },
			{
				id: "A.IV",
				label: "Dolgoročne finančne naložbe",
				children: [
					{ id: "A.IV.1", label: "Dolgoročne finančne naložbe razen posojil", prefixes: ["06"] },
					{ id: "A.IV.2", label: "Dolgoročna posojila", prefixes: ["07"] },
				],
			},
			{ id: "A.V", label: "Dolgoročne poslovne terjatve", prefixes: ["08"] },
			{ id: "A.VI", label: "Odložene terjatve za davek", prefixes: ["09"] },
		],
	},
	{
		id: "B",
		label: "Kratkoročna sredstva",
		children: [
			{ id: "B.I", label: "Sredstva (skupine za odtujitev) za prodajo", prefixes: ["67"] },
			{ id: "B.II", label: "Zaloge", prefixes: ["3", "60", "61", "62", "63", "64", "65", "66", "68", "69"] },
			{
				id: "B.III",
				label: "Kratkoročne finančne naložbe",
				children: [
					{ id: "B.III.1", label: "Kratkoročne finančne naložbe razen posojil", prefixes: ["17"] },
					{ id: "B.III.2", label: "Kratkoročna posojila", prefixes: ["18"] },
				],
			},
			{ id: "B.IV", label: "Kratkoročne poslovne terjatve", prefixes: ["12", "13", "14", "15", "16"] },
			{ id: "B.V", label: "Denarna sredstva", prefixes: ["10", "11"] },
		],
	},
	{ id: "C", label: "Kratkoročne aktivne časovne razmejitve", prefixes: ["19"] },
];

const SOURCES: LineDefinition[] = [
	{
		id: "A",
		label: "Kapital",
		children: [
			{
				id: "A.I",
				label: "Vpoklicani kapital",
				children: [
					{ id: "A.I.1", label: "Osnovni kapital", prefixes: ["900", "901", "902", "903", "904", "905", "906", "907", "908"] },
					{ id: "A.I.2", label: "Nevpoklicani kapital (kot odbitna postavka)", prefixes: ["909"] },
				],
			},
			{ id: "A.II", label: "Kapitalske rezerve", prefixes: ["91"] },
			{ id: "A.III", label: "Rezerve iz dobička", prefixes: ["92"] },
			{ id: "A.IV", label: "Revalorizacijske rezerve", prefixes: ["94"] },
			{ id: "A.V", label: "Rezerve, nastale zaradi vrednotenja po pošteni vrednosti", prefixes: ["95"] },
			{ id: "A.VI", label: "Preneseni čisti poslovni izid", prefixes: ["930", "931", "934", "936", "938", "939"], result: "carried" },
			{ id: "A.VII", label: "Čisti poslovni izid poslovnega leta", prefixes: ["932", "933", "935", "937"], result: "current" },
		],
	},
	{
		id: "B",
		label: "Rezervacije in dolgoročne pasivne časovne razmejitve",
		children: [
			{ id: "B.1", label: "Rezervacije", prefixes: ["960", "961", "962", "963", "964", "965"] },
			{ id: "B.2", label: "Dolgoročne pasivne časovne razmejitve", prefixes: ["966", "967", "968", "969"] },
		],
	},
	{
		id: "C",
		label: "Dolgoročne obveznosti",
		children: [
			{ id: "C.I", label: "Dolgoročne finančne obveznosti", prefixes: ["97"] },
			{ id: "C.II", label: "Dolgoročne poslovne obveznosti", prefixes: ["98"] },
		],
	},
	{
		id: "Č",
		label: "Kratkoročne obveznosti",
		children: [
			{ id: "Č.I", label: "Obveznosti, vključene v skupine za odtujitev", prefixes: ["21"] },
			{ id: "Č.II", label: "Kratkoročne finančne obveznosti", prefixes: ["27"] },
			{ id: "Č.III", label: "Kratkoročne poslovne obveznosti", prefixes: ["20", "22", "23", "24", "25", "26", "28"] },
		],
	},
	{ id: "D", label: "Kratkoročne pasivne časovne razmejitve", prefixes: ["29"] },
];

const INCOME: LineDefinition[] = [
	{ id: "1", label: "Čisti prihodki od prodaje", prefixes: ["760", "761", "762", "763"] },
	{ id: "3", label: "Usredstveni lastni proizvodi in lastne storitve", prefixes: ["79"] },
	{ id: "4", label: "Drugi poslovni prihodki (s prevrednotovalnimi poslovnimi prihodki)", prefixes: ["764", "765", "766", "767", "768", "769"] },
	{
		id: "5",
		label: "Stroški blaga, materiala in storitev",
		negate: true,
		children: [
			{ id: "5.a", label: "Nabavna vrednost prodanih blaga in materiala ter stroški porabljenega materiala", prefixes: ["40", "702"], negate: true },
			{ id: "5.b", label: "Stroški storitev", prefixes: ["41"], negate: true },
		],
	},
	{
		id: "6",
		label: "Stroški dela",
		negate: true,
		children: [
			{ id: "6.a", label: "Stroški plač", prefixes: ["470", "471"], negate: true },
			{ id: "6.b", label: "Stroški socialnih zavarovanj", prefixes: ["472", "474", "475"], negate: true },
			{ id: "6.c", label: "Drugi stroški dela", prefixes: ["473", "476", "477", "478", "479"], negate: true },
		],
	},
	{
		id: "7",
		label: "Odpisi vrednosti",
		negate: true,
		children: [
			{ id: "7.a", label: "Amortizacija", prefixes: ["43"], negate: true },
			{
				id: "7.b",
				label: "Prevrednotovalni poslovni odhodki pri neopredmetenih sredstvih in opredmetenih osnovnih sredstvih",
				prefixes: ["720", "722"],
				negate: true,
			},
			{ id: "7.c", label: "Prevrednotovalni poslovni odhodki pri obratnih sredstvih", prefixes: ["721", "723", "724"], negate: true },
		],
	},
	{ id: "8", label: "Drugi poslovni odhodki", prefixes: ["44", "48", "49", "700", "701", "703", "704"], negate: true },
	{ id: "9", label: "Finančni prihodki iz deležev", prefixes: ["770", "771", "772", "773"] },
	{ id: "10", label: "Finančni prihodki iz danih posojil", prefixes: ["774", "775"] },
	{ id: "11", label: "Finančni prihodki iz poslovnih terjatev", prefixes: ["776", "777", "778", "779"] },
	{ id: "12", label: "Finančni odhodki iz oslabitve in odpisov finančnih naložb", prefixes: ["747", "748", "749"], negate: true },
	{ id: "13", label: "Finančni odhodki iz finančnih obveznosti", prefixes: ["45", "740", "741", "742", "743"], negate: true },
	{ id: "14", label: "Finančni odhodki iz poslovnih obveznosti", prefixes: ["744", "745", "746"], negate: true },
	{ id: "15", label: "Drugi prihodki", prefixes: ["78"] },
	{ id: "16", label: "Drugi odhodki", prefixes: ["75"], negate: true },
	{ id: "17", label: "Davek iz dobička", prefixes: ["810", "811", "812"], negate: true },
	{ id: "18", label: "Odloženi davki", prefixes: ["813"] },
];

function matches(code: string, prefixes: string[]): boolean {
	return prefixes.some((prefix) => code.startsWith(prefix));
}

function leaves(definitions: LineDefinition[]): LineDefinition[] {
	return definitions.flatMap((definition) => (definition.children ? leaves(definition.children) : [definition]));
}

export async function turnover(project: string, from: number, to: number): Promise<Map<string, number>> {
	const rows = (await Database`
		SELECT jl.ledger_account, COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0) AS balance
		FROM journal_lines jl JOIN journal_entries je ON je.uuid = jl.entry
		WHERE jl.project = ${project} AND je.entry_date BETWEEN ${from} AND ${to}
			AND je.source_type NOT IN ('year_result', 'year_closing', 'year_opening')
			AND NOT (je.reverses IS NOT NULL AND EXISTS (
				SELECT 1 FROM journal_entries o WHERE o.uuid = je.reverses AND o.source_type IN ('year_result', 'year_closing', 'year_opening')))
		GROUP BY jl.ledger_account
	`) as { ledger_account: string; balance: number }[];
	return new Map(rows.map((row) => [row.ledger_account, safeInteger(row.balance)]));
}

export async function positionAt(project: string, yearStart: number, until: number) {
	const rows = (await Database`
		SELECT jl.ledger_account,
			COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0) AS balance,
			COALESCE(SUM(CASE WHEN je.entry_date >= ${yearStart} THEN jl.debit - jl.credit ELSE 0 END), 0) AS year_balance
		FROM journal_lines jl JOIN journal_entries je ON je.uuid = jl.entry
		WHERE jl.project = ${project} AND je.entry_date <= ${until}
			AND NOT (je.source_type = 'year_closing' AND je.entry_date >= ${yearStart})
			AND NOT (je.reverses IS NOT NULL AND je.entry_date >= ${yearStart} AND EXISTS (
				SELECT 1 FROM journal_entries o WHERE o.uuid = je.reverses AND o.source_type = 'year_closing'))
		GROUP BY jl.ledger_account
	`) as { ledger_account: string; balance: number; year_balance: number }[];
	return new Map(rows.map((row) => [row.ledger_account, { total: safeInteger(row.balance), year: safeInteger(row.year_balance) }]));
}

function build(definitions: LineDefinition[], amountOf: (definition: LineDefinition) => number, level = 0): StatementLine[] {
	const lines: StatementLine[] = [];
	for (const definition of definitions) {
		if (definition.children) {
			const children = build(definition.children, amountOf, level + 1);
			const direct = children.filter((line) => line.level === level + 1);
			lines.push({ id: definition.id, label: definition.label, level, amount: addIntegers(...direct.map((line) => line.amount)) }, ...children);
		} else {
			lines.push({ id: definition.id, label: definition.label, level, amount: amountOf(definition) });
		}
	}
	return lines;
}

function balanceSheet(accounts: LedgerAccountRow[], position: Map<string, { total: number; year: number }>) {
	const sum = (prefixes: string[], sign: 1 | -1) =>
		addIntegers(...accounts.filter((account) => matches(account.code, prefixes)).map((account) => sign * (position.get(account.uuid)?.total ?? 0)));
	const openResult = (part: "year" | "carried") =>
		addIntegers(
			...accounts
				.filter((account) => account.account_kind === "revenue" || account.account_kind === "expense")
				.map((account) => {
					const value = position.get(account.uuid);
					if (!value) return 0;
					return -(part === "year" ? value.year : value.total - value.year);
				})
		);
	const assets = build(ASSETS, (definition) => sum(definition.prefixes ?? [], 1));
	const sources = build(SOURCES, (definition) => {
		const base = sum(definition.prefixes ?? [], -1);
		if (definition.result === "current") return addIntegers(base, openResult("year"));
		if (definition.result === "carried") return addIntegers(base, openResult("carried"));
		return base;
	});
	const covered = [...leaves(ASSETS), ...leaves(SOURCES)].flatMap((definition) => definition.prefixes ?? []);
	const unmapped = accounts
		.filter(
			(account) =>
				(account.account_kind === "asset" || account.account_kind === "liability" || account.account_kind === "equity") && !matches(account.code, covered)
		)
		.map((account) => ({ code: account.code, name: account.name, amount: position.get(account.uuid)?.total ?? 0 }))
		.filter((row) => row.amount !== 0);
	const total = (lines: StatementLine[]) => addIntegers(...lines.filter((line) => line.level === 0).map((line) => line.amount));
	return { assets, sources, total_assets: total(assets), total_sources: total(sources), unmapped };
}

function incomeStatement(accounts: LedgerAccountRow[], turnover: Map<string, number>) {
	const sum = (definition: LineDefinition) =>
		addIntegers(
			...accounts
				.filter((account) => matches(account.code, definition.prefixes ?? []))
				.map((account) => (definition.negate ? 1 : -1) * (turnover.get(account.uuid) ?? 0))
		);
	const lines = build(INCOME, sum);
	const signed = (line: StatementLine) => (INCOME.find((definition) => definition.id === line.id)?.negate ? -line.amount : line.amount);
	const result = addIntegers(...lines.filter((line) => line.level === 0).map(signed));
	const ledgerResult = addIntegers(
		...accounts
			.filter((account) => account.account_kind === "revenue" || account.account_kind === "expense")
			.map((account) => -(turnover.get(account.uuid) ?? 0))
	);
	const covered = leaves(INCOME).flatMap((definition) => definition.prefixes ?? []);
	const unmapped = accounts
		.filter((account) => (account.account_kind === "revenue" || account.account_kind === "expense") && !matches(account.code, covered))
		.map((account) => ({ code: account.code, name: account.name, amount: -(turnover.get(account.uuid) ?? 0) }))
		.filter((row) => row.amount !== 0);
	return { lines, result, ledger_result: ledgerResult, unmapped };
}

export async function financialStatements(project: ProjectRow, year: number): Promise<FinancialStatements> {
	const accounts = (await Database`SELECT * FROM ledger_accounts WHERE project = ${project.uuid} ORDER BY code`) as LedgerAccountRow[];
	const period = (value: number) => ({
		from: startOfLocalDate(`${value}-01-01`, project.timezone),
		to: endOfLocalDate(`${value}-12-31`, project.timezone),
	});
	const current = period(year);
	const previous = period(year - 1);
	const sole = project.bookkeeping !== "company";
	const relabel = (lines: StatementLine[]) =>
		sole
			? lines.map((line) => (line.id === "A" ? { ...line, label: "Podjetnikov kapital" } : line.id === "A.I.1" ? { ...line, label: "Začetni kapital" } : line))
			: lines;
	const sheet = balanceSheet(accounts, await positionAt(project.uuid, current.from, current.to));
	const previousSheet = balanceSheet(accounts, await positionAt(project.uuid, previous.from, previous.to));
	const income = incomeStatement(accounts, await turnover(project.uuid, current.from, current.to));
	const previousIncome = incomeStatement(accounts, await turnover(project.uuid, previous.from, previous.to));
	const merge = (now: StatementLine[], before: StatementLine[]) =>
		now.map((line) => ({ ...line, previous: before.find((other) => other.id === line.id)?.amount ?? 0 }));
	return {
		year,
		currency: project.tax_currency ?? project.currency,
		balance_sheet: {
			assets: merge(sheet.assets, previousSheet.assets),
			sources: relabel(merge(sheet.sources, previousSheet.sources)),
			total_assets: sheet.total_assets,
			total_sources: sheet.total_sources,
			previous_total_assets: previousSheet.total_assets,
			previous_total_sources: previousSheet.total_sources,
			balanced: sheet.total_assets === sheet.total_sources,
			unmapped: sheet.unmapped,
		},
		income_statement: {
			lines: merge(income.lines, previousIncome.lines),
			result: income.result,
			previous_result: previousIncome.result,
			reconciled: income.result === income.ledger_result,
			unmapped: income.unmapped,
		},
	};
}
