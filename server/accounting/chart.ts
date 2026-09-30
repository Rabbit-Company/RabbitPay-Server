import type { SQL } from "bun";
import Database from "../database/database";
import type { AccountKind, LedgerAccountRow } from "../database/models";

export type SystemAccount =
	| "intangible"
	| "real_estate"
	| "equipment"
	| "cash"
	| "bank"
	| "stripe"
	| "paypal"
	| "crypto"
	| "receivables_domestic"
	| "receivables_foreign"
	| "input_vat"
	| "advance_vat"
	| "payables_domestic"
	| "payables_foreign"
	| "advances_received"
	| "output_vat"
	| "self_assessed_vat"
	| "oss_vat"
	| "other_liabilities"
	| "utilities"
	| "office_supplies"
	| "small_equipment"
	| "services"
	| "it_services"
	| "rent"
	| "travel"
	| "payment_fees"
	| "professional_services"
	| "marketing"
	| "material"
	| "fuel"
	| "transport"
	| "maintenance"
	| "representation"
	| "contract_work"
	| "telecom"
	| "education"
	| "levies"
	| "fines"
	| "donations"
	| "depreciation_intangible"
	| "depreciation_buildings"
	| "depreciation_equipment"
	| "depreciation_small"
	| "accumulated_intangible"
	| "accumulated_buildings"
	| "accumulated_equipment"
	| "accumulated_small"
	| "small_inventory"
	| "asset_write_off"
	| "net_salaries"
	| "employer_contributions_liability"
	| "employee_contributions"
	| "payroll_tax"
	| "payroll_deductions"
	| "other_labor"
	| "employer_pension"
	| "sole_capital"
	| "sole_transfers"
	| "household_flows"
	| "sole_income"
	| "sole_loss"
	| "salaries"
	| "employer_contributions"
	| "other_costs"
	| "fx_losses"
	| "fx_gains"
	| "revenue_domestic"
	| "revenue_eu"
	| "revenue_export"
	| "capital"
	| "retained_earnings"
	| "current_result"
	| "current_loss"
	| "carried_loss"
	| "income_tax"
	| "income_tax_liability";

export interface ChartAccount {
	code: string;
	name: string;
	kind: AccountKind;
	key: SystemAccount | null;
}

export const DEFAULT_CHART: ChartAccount[] = [
	{ code: "0030", name: "Premoženjske in druge pravice", kind: "asset", key: "intangible" },
	{ code: "0080", name: "Popravek vrednosti neopredmetenih sredstev zaradi amortiziranja", kind: "asset", key: "accumulated_intangible" },
	{ code: "0200", name: "Zemljišča, vrednotena po modelu nabavne vrednosti", kind: "asset", key: null },
	{ code: "0210", name: "Zgradbe, vrednotene po modelu nabavne vrednosti", kind: "asset", key: "real_estate" },
	{ code: "0350", name: "Popravek vrednosti zgradb zaradi amortiziranja", kind: "asset", key: "accumulated_buildings" },
	{ code: "0400", name: "Oprema in nadomestni deli, vrednoteni po modelu nabavne vrednosti", kind: "asset", key: "equipment" },
	{ code: "0410", name: "Drobni inventar", kind: "asset", key: "small_inventory" },
	{ code: "0500", name: "Popravek vrednosti opreme in nadomestnih delov zaradi amortiziranja", kind: "asset", key: "accumulated_equipment" },
	{ code: "0510", name: "Popravek vrednosti drobnega inventarja zaradi amortiziranja", kind: "asset", key: "accumulated_small" },
	{ code: "1000", name: "Denarna sredstva v blagajni, razen deviznih", kind: "asset", key: "cash" },
	{ code: "1090", name: "Denar na poti", kind: "asset", key: null },
	{ code: "1100", name: "Denarna sredstva na računih, razen deviznih", kind: "asset", key: "bank" },
	{ code: "1101", name: "Denarna sredstva na računu pri ponudniku Stripe", kind: "asset", key: "stripe" },
	{ code: "1102", name: "Denarna sredstva na računu pri ponudniku PayPal", kind: "asset", key: "paypal" },
	{ code: "1120", name: "Devizna sredstva na računih", kind: "asset", key: null },
	{ code: "1200", name: "Kratkoročne terjatve do kupcev v državi", kind: "asset", key: "receivables_domestic" },
	{ code: "1210", name: "Kratkoročne terjatve do kupcev v tujini", kind: "asset", key: "receivables_foreign" },
	{ code: "1290", name: "Oslabitev vrednosti kratkoročnih terjatev do kupcev", kind: "asset", key: null },
	{ code: "1330", name: "Drugi dani kratkoročni predujmi in preplačila", kind: "asset", key: null },
	{ code: "1600", name: "Kratkoročne terjatve za odbitni DDV", kind: "asset", key: "input_vat" },
	{ code: "1610", name: "Kratkoročne terjatve za davek od dohodkov pravnih oseb", kind: "asset", key: null },
	{ code: "1650", name: "Ostale kratkoročne terjatve", kind: "asset", key: null },
	{ code: "1760", name: "Kriptosredstva, izmerjena po nabavni vrednosti", kind: "asset", key: "crypto" },
	{ code: "1900", name: "Kratkoročno odloženi stroški oziroma odhodki", kind: "asset", key: null },
	{ code: "1910", name: "Kratkoročno nezaračunani prihodki", kind: "asset", key: null },
	{ code: "1950", name: "DDV od prejetih predujmov", kind: "asset", key: "advance_vat" },
	{ code: "2200", name: "Kratkoročne obveznosti do dobaviteljev v državi", kind: "liability", key: "payables_domestic" },
	{ code: "2210", name: "Kratkoročne obveznosti do dobaviteljev v tujini", kind: "liability", key: "payables_foreign" },
	{ code: "2300", name: "Prejeti kratkoročni predujmi", kind: "liability", key: "advances_received" },
	{ code: "2510", name: "Kratkoročne obveznosti za neto plače in nadomestila plač", kind: "liability", key: "net_salaries" },
	{ code: "2520", name: "Kratkoročne obveznosti za prispevke za socialno varnost po vrstah", kind: "liability", key: "employer_contributions_liability" },
	{ code: "2530", name: "Kratkoročne obveznosti za prispevke iz bruto plač in nadomestil plač", kind: "liability", key: "employee_contributions" },
	{ code: "2540", name: "Kratkoročne obveznosti za davke iz bruto plač in nadomestil plač", kind: "liability", key: "payroll_tax" },
	{ code: "2600", name: "Obveznosti za obračunani DDV", kind: "liability", key: "output_vat" },
	{ code: "2601", name: "Obveznosti za obračunani DDV od samoobdavčitve", kind: "liability", key: "self_assessed_vat" },
	{ code: "2602", name: "Obveznosti za obračunani DDV po posebni ureditvi VEM", kind: "liability", key: "oss_vat" },
	{ code: "2610", name: "Obveznosti za DDV, carino in druge dajatve od uvoženega blaga", kind: "liability", key: null },
	{ code: "2640", name: "Obveznosti za davek od dohodkov pravnih oseb", kind: "liability", key: "income_tax_liability" },
	{ code: "2660", name: "Druge kratkoročne obveznosti do državnih in drugih inštitucij", kind: "liability", key: null },
	{ code: "2720", name: "Kratkoročna posojila, dobljena pri bankah in organizacijah v državi", kind: "liability", key: null },
	{ code: "2760", name: "Kratkoročne finančne obveznosti do fizičnih oseb", kind: "liability", key: null },
	{ code: "2820", name: "Kratkoročne obveznosti v zvezi z odtegljaji od plač in nadomestil plač", kind: "liability", key: "payroll_deductions" },
	{ code: "2850", name: "Ostale kratkoročne poslovne obveznosti", kind: "liability", key: "other_liabilities" },
	{ code: "2900", name: "Vnaprej vračunani stroški oziroma odhodki", kind: "liability", key: null },
	{ code: "2910", name: "Kratkoročno odloženi prihodki", kind: "liability", key: null },
	{ code: "4000", name: "Stroški materiala", kind: "expense", key: "material" },
	{ code: "4020", name: "Stroški energije", kind: "expense", key: "utilities" },
	{ code: "4021", name: "Stroški goriva", kind: "expense", key: "fuel" },
	{ code: "4040", name: "Odpis drobnega inventarja in embalaže", kind: "expense", key: "small_equipment" },
	{ code: "4060", name: "Stroški pisarniškega materiala in strokovne literature", kind: "expense", key: "office_supplies" },
	{ code: "4110", name: "Stroški transportnih storitev", kind: "expense", key: "transport" },
	{ code: "4120", name: "Stroški storitev v zvezi z vzdrževanjem", kind: "expense", key: "maintenance" },
	{ code: "4130", name: "Najemnine", kind: "expense", key: "rent" },
	{ code: "4140", name: "Povračila stroškov zaposlenim v zvezi z delom", kind: "expense", key: "travel" },
	{ code: "4150", name: "Stroški plačilnega prometa, stroški bančnih storitev in zavarovalne premije", kind: "expense", key: "payment_fees" },
	{ code: "4160", name: "Stroški intelektualnih in osebnih storitev", kind: "expense", key: "professional_services" },
	{ code: "4170", name: "Stroški sejmov, reklame in reprezentance", kind: "expense", key: "marketing" },
	{ code: "4175", name: "Stroški reprezentance", kind: "expense", key: "representation" },
	{ code: "4180", name: "Stroški storitev fizičnih oseb, ki ne opravljajo dejavnosti", kind: "expense", key: "contract_work" },
	{ code: "4190", name: "Stroški drugih storitev", kind: "expense", key: "services" },
	{ code: "4191", name: "Stroški storitev informacijske tehnologije in programske opreme", kind: "expense", key: "it_services" },
	{ code: "4192", name: "Stroški telekomunikacijskih storitev", kind: "expense", key: "telecom" },
	{ code: "4193", name: "Stroški izobraževanja", kind: "expense", key: "education" },
	{ code: "4300", name: "Amortizacija neopredmetenih sredstev", kind: "expense", key: "depreciation_intangible" },
	{ code: "4310", name: "Amortizacija zgradb", kind: "expense", key: "depreciation_buildings" },
	{ code: "4320", name: "Amortizacija opreme in nadomestnih delov", kind: "expense", key: "depreciation_equipment" },
	{ code: "4330", name: "Amortizacija drobnega inventarja", kind: "expense", key: "depreciation_small" },
	{ code: "4500", name: "Stroški obresti", kind: "expense", key: null },
	{ code: "4700", name: "Plače zaposlenih", kind: "expense", key: "salaries" },
	{ code: "4710", name: "Nadomestila plač zaposlenih", kind: "expense", key: null },
	{ code: "4730", name: "Regres za letni dopust, bonitete, povračila in drugi prejemki zaposlenih", kind: "expense", key: "other_labor" },
	{
		code: "4740",
		name: "Delodajalčevi prispevki od plač, nadomestil plač, bonitet, povračil in drugih prejemkov",
		kind: "expense",
		key: "employer_contributions",
	},
	{ code: "4741", name: "Delodajalčevi prispevki za pokojninsko in invalidsko zavarovanje", kind: "expense", key: "employer_pension" },
	{ code: "4800", name: "Dajatve, ki niso odvisne od stroškov dela ali drugih vrst stroškov", kind: "expense", key: "levies" },
	{ code: "4890", name: "Ostali stroški", kind: "expense", key: "other_costs" },
	{
		code: "7200",
		name: "Prevrednotovalni poslovni odhodki pri neopredmetenih sredstvih in opredmetenih osnovnih sredstvih",
		kind: "expense",
		key: "asset_write_off",
	},
	{ code: "7450", name: "Odhodki iz obveznosti do dobaviteljev, terjatev do kupcev in meničnih obveznosti", kind: "expense", key: "fx_losses" },
	{ code: "7520", name: "Denarne kazni, ki niso povezane s poslovnimi učinki", kind: "expense", key: "fines" },
	{ code: "7540", name: "Donacije", kind: "expense", key: "donations" },
	{ code: "7580", name: "Negativne evrske izravnave", kind: "expense", key: null },
	{ code: "7590", name: "Ostali odhodki, ki niso povezani s poslovnimi učinki", kind: "expense", key: null },
	{ code: "7600", name: "Prihodki od prodaje proizvodov in storitev na domačem trgu", kind: "revenue", key: "revenue_domestic" },
	{ code: "7610", name: "Prihodki od prodaje proizvodov in storitev na tujem trgu v EU", kind: "revenue", key: "revenue_eu" },
	{ code: "7611", name: "Prihodki od prodaje proizvodov in storitev na tujem trgu zunaj EU", kind: "revenue", key: "revenue_export" },
	{ code: "7620", name: "Prihodki od prodaje trgovskega blaga in materiala na domačem trgu", kind: "revenue", key: null },
	{ code: "7630", name: "Prihodki od prodaje trgovskega blaga in materiala na tujem trgu", kind: "revenue", key: null },
	{ code: "7680", name: "Drugi prihodki, povezani s poslovnimi učinki", kind: "revenue", key: null },
	{ code: "7770", name: "Finančni prihodki iz poslovnih terjatev in poslovnih obveznosti do drugih", kind: "revenue", key: "fx_gains" },
	{ code: "7880", name: "Pozitivne evrske izravnave", kind: "revenue", key: null },
	{ code: "7890", name: "Ostali prihodki, ki niso povezani s poslovnimi učinki", kind: "revenue", key: null },
	{ code: "8100", name: "Davek od dohodkov pravnih oseb", kind: "expense", key: "income_tax" },
	{ code: "9010", name: "Osnovni kapital, kapitalski deleži ali kapitalska vloga", kind: "equity", key: "capital" },
	{ code: "9020", name: "Začetni kapital samostojnega podjetnika posameznika", kind: "equity", key: "sole_capital" },
	{ code: "9180", name: "Prenosi stvarnega premoženja med opravljanjem dejavnosti", kind: "equity", key: "sole_transfers" },
	{ code: "9190", name: "Pritoki in odtoki med podjetjem in gospodinjstvom", kind: "equity", key: "household_flows" },
	{ code: "9300", name: "Preneseni čisti dobiček iz prejšnjih let", kind: "equity", key: "retained_earnings" },
	{ code: "9310", name: "Prenesena čista izguba iz prejšnjih let", kind: "equity", key: "carried_loss" },
	{ code: "9320", name: "Neuporabljeni del čistega dobička poslovnega leta", kind: "equity", key: "current_result" },
	{ code: "9330", name: "Čista izguba poslovnega leta", kind: "equity", key: "current_loss" },
	{ code: "9350", name: "Dohodek samostojnega podjetnika posameznika", kind: "equity", key: "sole_income" },
	{ code: "9370", name: "Negativni poslovni izid samostojnega podjetnika posameznika", kind: "equity", key: "sole_loss" },
];

export const CATEGORY_ACCOUNTS: Record<string, SystemAccount> = {
	Hosting: "it_services",
	Software: "it_services",
	Rent: "rent",
	Utilities: "utilities",
	Equipment: "small_equipment",
	Marketing: "marketing",
	Travel: "travel",
	"Professional services": "professional_services",
	Salaries: "salaries",
	"Office supplies": "office_supplies",
	Material: "material",
	Fuel: "fuel",
	"Transport and shipping": "transport",
	"Maintenance and repairs": "maintenance",
	"Bank fees and insurance": "payment_fees",
	"Phone and internet": "telecom",
	Education: "education",
	Memberships: "services",
	"Contract and student work": "contract_work",
	"Taxes and fees": "levies",
	Representation: "representation",
	Donations: "donations",
	Fines: "fines",
	Other: "services",
};

export const ACCOUNT_CODE = /^\d{2,8}$/;

export function isAccountKind(value: unknown): value is AccountKind {
	return typeof value === "string" && ["asset", "liability", "equity", "revenue", "expense"].includes(value);
}

export function kindForCode(code: string): AccountKind | null {
	const group = code.slice(0, 2);
	const accountClass = code[0];
	if (accountClass === "0" || accountClass === "1" || accountClass === "3" || accountClass === "6") return "asset";
	if (accountClass === "2") return "liability";
	if (accountClass === "4") return "expense";
	if (accountClass === "7") return Number(group) >= 76 ? "revenue" : "expense";
	if (accountClass === "8") return group === "81" ? "expense" : null;
	if (accountClass === "9") return group === "99" ? null : Number(group) >= 96 ? "liability" : "equity";
	return null;
}

export class Chart {
	constructor(
		readonly accounts: LedgerAccountRow[],
		private readonly categories: Map<string, string>
	) {}

	system(key: SystemAccount): LedgerAccountRow {
		const account = this.accounts.find((row) => row.system_key === key);
		if (!account) throw new Error(`The chart of accounts has no ${key} account`);
		return account;
	}

	byUuid(uuid: string): LedgerAccountRow | undefined {
		return this.accounts.find((row) => row.uuid === uuid);
	}

	byIban(iban: string | null | undefined): LedgerAccountRow | undefined {
		return iban ? this.accounts.find((row) => row.iban === iban) : undefined;
	}

	forCategory(category: string): LedgerAccountRow {
		const mapped = this.categories.get(category);
		const account = mapped ? this.byUuid(mapped) : undefined;
		return account ?? this.system(CATEGORY_ACCOUNTS[category] ?? "services");
	}
}

export function freeCode(code: string, taken: Set<string>): string | null {
	const width = code.length;
	for (let next = Number(code); String(next).padStart(width, "0").startsWith(code.slice(0, 2)); next++) {
		const candidate = String(next).padStart(width, "0");
		if (!taken.has(candidate)) return candidate;
	}
	return null;
}

export async function ensureChart(project: string, sql: SQL = Database): Promise<Chart> {
	let accounts = (await sql`SELECT * FROM ledger_accounts WHERE project = ${project} ORDER BY code`) as LedgerAccountRow[];
	const now = Date.now();
	for (const entry of DEFAULT_CHART) {
		const unkeyed =
			entry.key !== null && !accounts.some((row) => row.system_key === entry.key)
				? accounts.find((row) => row.code === entry.code && row.system_key === null && row.name === entry.name)
				: undefined;
		if (unkeyed) {
			await sql`UPDATE ledger_accounts SET system_key = ${entry.key}, updated = ${now} WHERE uuid = ${unkeyed.uuid}`;
			unkeyed.system_key = entry.key;
		}
	}
	const seeding =
		accounts.length === 0 ? DEFAULT_CHART : DEFAULT_CHART.filter((entry) => entry.key !== null && !accounts.some((row) => row.system_key === entry.key));
	if (seeding.length > 0) {
		const taken = new Set(accounts.map((row) => row.code));
		for (const entry of seeding) {
			const code = freeCode(entry.code, taken);
			if (code === null) throw new Error(`No free account code in group ${entry.code.slice(0, 2)} for the ${entry.key} account`);
			taken.add(code);
			await sql`
				INSERT INTO ledger_accounts(uuid, project, code, name, account_kind, system_key, active, created, updated)
				VALUES(${crypto.randomUUID()}, ${project}, ${code}, ${entry.name}, ${entry.kind}, ${entry.key}, 1, ${now}, ${now})
			`;
		}
		accounts = (await sql`SELECT * FROM ledger_accounts WHERE project = ${project} ORDER BY code`) as LedgerAccountRow[];
	}
	const mappings = (await sql`SELECT expense_category, ledger_account FROM ledger_category_accounts WHERE project = ${project}`) as {
		expense_category: string;
		ledger_account: string;
	}[];
	return new Chart(accounts, new Map(mappings.map((row) => [row.expense_category, row.ledger_account])));
}

export async function bankAccountFor(project: string, iban: string, sql: SQL = Database): Promise<LedgerAccountRow> {
	const chart = await ensureChart(project, sql);
	const existing = chart.byIban(iban);
	if (existing) return existing;
	const bank = chart.system("bank");
	const now = Date.now();
	if (bank.iban === null && !chart.accounts.some((row) => row.iban !== null)) {
		await sql`UPDATE ledger_accounts SET iban = ${iban}, updated = ${now} WHERE uuid = ${bank.uuid}`;
		return { ...bank, iban };
	}
	const code = freeCode("1100", new Set(chart.accounts.map((row) => row.code)));
	if (code === null) throw new Error("No free account code in group 11 for another bank account");
	const uuid = crypto.randomUUID();
	await sql`
		INSERT INTO ledger_accounts(uuid, project, code, name, account_kind, system_key, iban, active, created, updated)
		VALUES(${uuid}, ${project}, ${code}, ${`Denarna sredstva na računu ${iban}`}, 'asset', NULL, ${iban}, 1, ${now}, ${now})
	`;
	const [created] = (await sql`SELECT * FROM ledger_accounts WHERE uuid = ${uuid}`) as LedgerAccountRow[];
	return created;
}
