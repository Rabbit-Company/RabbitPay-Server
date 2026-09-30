import Database from "../database/database";
import { endOfLocalDate, startOfLocalDate } from "../timezone";
import { positionAt, turnover } from "./statements";
import type { LedgerAccountRow, ProjectRow } from "../database/models";
import type { AjpesLine, AjpesReport } from "./types";

type Section = "balance" | "income";

interface Leaf {
	aop: string;
	label: string;
	prefixes: string[];
	deduction?: boolean;
}

interface Total {
	aop: string;
	label: string;
	sum: string[];
}

type Line = Leaf | Total | { aop: string; label: string; computed: true };

function leaf(aop: string, label: string, prefixes: string[], deduction = false): Leaf {
	return { aop, label, prefixes, deduction };
}

function total(aop: string, label: string, sum: string[]): Total {
	return { aop, label, sum };
}

function computed(aop: string, label: string): Line {
	return { aop, label, computed: true };
}

const ASSETS: Line[] = [
	total("001", "SREDSTVA", ["002", "032", "053"]),
	total("002", "A. DOLGOROČNA SREDSTVA", ["003", "010", "018", "019", "027", "031"]),
	total("003", "I. Neopredmetena sredstva in dolgoročne aktivne časovne razmejitve", ["004", "009"]),
	total("004", "1. Neopredmetena sredstva", ["005", "006", "007", "008"]),
	leaf("005", "a) Dolgoročne premoženjske pravice", ["003", "004", "008", "009"]),
	leaf("006", "b) Dobro ime", ["000"]),
	leaf("007", "c) Dolgoročno odloženi stroški razvijanja", ["002"]),
	leaf("008", "č) Druga neopredmetena sredstva", ["001", "005", "006", "131"]),
	leaf("009", "2. Dolgoročne aktivne časovne razmejitve", ["007"]),
	total("010", "II. Opredmetena osnovna sredstva", ["011", "012", "013", "014", "015", "016", "017"]),
	leaf("011", "1. Zemljišča", ["020", "022", "031", "032"]),
	leaf("012", "2. Zgradbe", ["021", "023", "026", "03"]),
	leaf("013", "3. Proizvajalne naprave in stroji", []),
	leaf("014", "4. Druge naprave in oprema, drobni inventar in druga opredmetena osnovna sredstva", ["04", "05"]),
	leaf("015", "5. Biološka sredstva", ["043", "044", "053", "054", "058"]),
	leaf("016", "6. Opredmetena osnovna sredstva v gradnji in izdelavi", ["027", "047"]),
	leaf("017", "7. Predujmi za pridobitev opredmetenih osnovnih sredstev", ["130"]),
	leaf("018", "III. Naložbene nepremičnine", ["01", "135"]),
	total("019", "IV. Dolgoročne finančne naložbe", ["020", "024"]),
	total("020", "1. Dolgoročne finančne naložbe, razen posojil", ["021", "022", "023"]),
	leaf("021", "a) Delnice in deleži v družbah v skupini", ["060"]),
	leaf("022", "b) Druge delnice in deleži", ["061", "062", "063", "064", "065"]),
	leaf("023", "c) Druge dolgoročne finančne naložbe", ["06"]),
	total("024", "2. Dolgoročna posojila", ["025", "026"]),
	leaf("025", "a) Dolgoročna posojila družbam v skupini", ["070"]),
	leaf("026", "b) Druga dolgoročna posojila", ["07"]),
	total("027", "V. Dolgoročne poslovne terjatve", ["028", "029", "030"]),
	leaf("028", "1. Dolgoročne poslovne terjatve do družb v skupini", []),
	leaf("029", "2. Dolgoročne poslovne terjatve do kupcev", []),
	leaf("030", "3. Dolgoročne poslovne terjatve do drugih", ["08"]),
	leaf("031", "VI. Odložene terjatve za davek", ["09"]),
	total("032", "B. KRATKOROČNA SREDSTVA", ["033", "034", "040", "048", "052"]),
	leaf("033", "I. Sredstva (skupine za odtujitev) za prodajo", ["67"]),
	total("034", "II. Zaloge", ["035", "036", "037", "038", "039"]),
	leaf("035", "1. Material", ["3"]),
	leaf("036", "2. Nedokončana proizvodnja", ["60"]),
	leaf("037", "3. Proizvodi", ["61", "62", "63"]),
	leaf("038", "4. Trgovsko blago", ["65", "66"]),
	leaf("039", "5. Predujmi za zaloge", ["132"]),
	total("040", "III. Kratkoročne finančne naložbe", ["041", "045"]),
	total("041", "1. Kratkoročne finančne naložbe, razen posojil", ["042", "043", "044"]),
	leaf("042", "a) Delnice in deleži v družbah v skupini", ["170", "171", "172"]),
	leaf("043", "b) Druge delnice in deleži", ["173", "174", "175"]),
	leaf("044", "c) Druge kratkoročne finančne naložbe", ["17"]),
	total("045", "2. Kratkoročna posojila", ["046", "047"]),
	leaf("046", "a) Kratkoročna posojila družbam v skupini", ["180", "181"]),
	leaf("047", "b) Druga kratkoročna posojila", ["18"]),
	total("048", "IV. Kratkoročne poslovne terjatve", ["049", "050", "051"]),
	leaf("049", "1. Kratkoročne poslovne terjatve do družb v skupini", []),
	leaf("050", "2. Kratkoročne poslovne terjatve do kupcev", ["12", "14"]),
	leaf("051", "3. Kratkoročne poslovne terjatve do drugih", ["13", "15", "16"]),
	leaf("052", "V. Denarna sredstva", ["10", "11"]),
	leaf("053", "C. KRATKOROČNE AKTIVNE ČASOVNE RAZMEJITVE", ["19"]),
];

const COMPANY_EQUITY: Line[] = [
	total("056", "A. KAPITAL", ["057", "060", "061", "067", "301", "068", "-069", "070", "-071"]),
	total("057", "I. Vpoklicani kapital", ["058", "-059"]),
	leaf("058", "1. Osnovni kapital", ["90"]),
	leaf("059", "2. Nevpoklicani kapital (kot odbitna postavka)", ["909"], true),
	leaf("060", "II. Kapitalske rezerve", ["91"]),
	total("061", "III. Rezerve iz dobička", ["062", "063", "-064", "065", "066"]),
	leaf("062", "1. Zakonske rezerve", ["920"]),
	leaf("063", "2. Rezerve za lastne delnice in lastne poslovne deleže", ["921"]),
	leaf("064", "3. Lastne delnice in lastni poslovni deleži (kot odbitna postavka)", ["929"], true),
	leaf("065", "4. Statutarne rezerve", ["922"]),
	leaf("066", "5. Druge rezerve iz dobička", ["92"]),
	leaf("067", "IV. Revalorizacijske rezerve", ["94"]),
	leaf("301", "V. Rezerve, nastale zaradi vrednotenja po pošteni vrednosti", ["95"]),
	computed("068", "VI. Preneseni čisti dobiček"),
	computed("069", "VII. Prenesena čista izguba"),
	computed("070", "VIII. Čisti dobiček poslovnega leta"),
	computed("071", "IX. Čista izguba poslovnega leta"),
];

const SOLE_EQUITY: Line[] = [
	total("056", "A. PODJETNIKOV KAPITAL", ["058", "067", "301", "070", "-071"]),
	computed("058", "I. Začetni podjetnikov kapital"),
	leaf("067", "IV. Revalorizacijske rezerve", ["94"]),
	leaf("301", "V. Rezerve, nastale zaradi vrednotenja po pošteni vrednosti", ["95"]),
	computed("070", "VI. Podjetnikov dohodek"),
	computed("071", "VII. Negativni poslovni izid"),
];

const LIABILITIES: Line[] = [
	total("072", "B. REZERVACIJE IN DOLGOROČNE PASIVNE ČASOVNE RAZMEJITVE", ["073", "074"]),
	leaf("073", "1. Rezervacije", ["960", "961", "962", "963", "964", "965"]),
	leaf("074", "2. Dolgoročne pasivne časovne razmejitve", ["96"]),
	total("075", "C. DOLGOROČNE OBVEZNOSTI", ["076", "080", "084"]),
	total("076", "I. Dolgoročne finančne obveznosti", ["077", "078", "079"]),
	leaf("077", "1. Dolgoročne finančne obveznosti do družb v skupini", ["970", "971"]),
	leaf("078", "2. Dolgoročne finančne obveznosti do bank", ["972", "973"]),
	leaf("079", "3. Druge dolgoročne finančne obveznosti", ["97"]),
	total("080", "II. Dolgoročne poslovne obveznosti", ["081", "082", "083"]),
	leaf("081", "1. Dolgoročne poslovne obveznosti do družb v skupini", ["980", "981"]),
	leaf("082", "2. Dolgoročne poslovne obveznosti do dobaviteljev", []),
	leaf("083", "3. Druge dolgoročne poslovne obveznosti", ["98"]),
	leaf("084", "III. Odložene obveznosti za davek", []),
	total("085", "Č. KRATKOROČNE OBVEZNOSTI", ["086", "087", "091"]),
	leaf("086", "I. Obveznosti, vključene v skupine za odtujitev", ["21"]),
	total("087", "II. Kratkoročne finančne obveznosti", ["088", "089", "090"]),
	leaf("088", "1. Kratkoročne finančne obveznosti do družb v skupini", ["270", "271"]),
	leaf("089", "2. Kratkoročne finančne obveznosti do bank", ["272", "273"]),
	leaf("090", "3. Druge kratkoročne finančne obveznosti", ["27"]),
	total("091", "III. Kratkoročne poslovne obveznosti", ["092", "093", "094"]),
	leaf("092", "1. Kratkoročne poslovne obveznosti do družb v skupini", []),
	leaf("093", "2. Kratkoročne poslovne obveznosti do dobaviteljev", ["22"]),
	leaf("094", "3. Druge kratkoročne poslovne obveznosti", ["20", "23", "24", "25", "26", "28"]),
	leaf("095", "D. KRATKOROČNE PASIVNE ČASOVNE RAZMEJITVE", ["29"]),
];

const INCOME: Line[] = [
	total("110", "A. ČISTI PRIHODKI OD PRODAJE", ["111", "115", "118"]),
	total("111", "I. Čisti prihodki od prodaje na domačem trgu", ["112", "113", "114"]),
	leaf("112", "1. Čisti prihodki od prodaje proizvodov in storitev razen najemnin", ["760"]),
	leaf("113", "2. Čisti prihodki od najemnin", ["765"]),
	leaf("114", "3. Čisti prihodki od prodaje blaga in materiala", ["762"]),
	total("115", "II. Čisti prihodki od prodaje na trgu EU", ["116", "117"]),
	leaf("116", "1. Čisti prihodki od prodaje proizvodov in storitev", ["7610"]),
	leaf("117", "2. Čisti prihodki od prodaje blaga in materiala", ["763"]),
	total("118", "III. Čisti prihodki od prodaje na trgu izven EU", ["119", "120"]),
	leaf("119", "1. Čisti prihodki od prodaje proizvodov in storitev", ["761"]),
	leaf("120", "2. Čisti prihodki od prodaje blaga in materiala", []),
	leaf("121", "B. POVEČANJE VREDNOSTI ZALOG PROIZVODOV IN NEDOKONČANE PROIZVODNJE", []),
	leaf("122", "C. ZMANJŠANJE VREDNOSTI ZALOG PROIZVODOV IN NEDOKONČANE PROIZVODNJE", []),
	leaf("123", "Č. USREDSTVENI LASTNI PROIZVODI IN LASTNE STORITVE", ["79"]),
	leaf("124", "D. SUBVENCIJE, DOTACIJE, REGRESI, KOMPENZACIJE IN DRUGI PRIHODKI, KI SO POVEZANI S POSLOVNIMI UČINKI", ["768"]),
	leaf("125", "E. DRUGI POSLOVNI PRIHODKI", ["76"]),
	total("126", "F. KOSMATI DONOS OD POSLOVANJA", ["110", "121", "-122", "123", "124", "125"]),
	total("127", "G. POSLOVNI ODHODKI", ["128", "139", "144", "148"]),
	total("128", "I. Stroški blaga, materiala in storitev", ["129", "130", "134"]),
	leaf("129", "1. Nabavna vrednost prodanega blaga in materiala", ["702"]),
	total("130", "2. Stroški porabljenega materiala", ["131", "132", "133"]),
	leaf("131", "a) stroški materiala", ["400", "401", "403", "405", "406"]),
	leaf("132", "b) stroški energije", ["402"]),
	leaf("133", "c) drugi stroški materiala", ["40"]),
	total("134", "3. Stroški storitev", ["135", "136", "137", "138"]),
	leaf("135", "a) transportne storitve", ["411"]),
	leaf("136", "b) najemnine", ["413"]),
	leaf("137", "c) povračila stroškov zaposlenim v zvezi z delom", ["414"]),
	leaf("138", "č) drugi stroški storitev", ["41"]),
	total("139", "II. Stroški dela", ["140", "141", "142", "143"]),
	leaf("140", "1. Stroški plač", ["470", "471"]),
	leaf("141", "2. Stroški pokojninskih zavarovanj", ["472", "4741"]),
	leaf("142", "3. Stroški drugih socialnih zavarovanj", ["474", "475"]),
	leaf("143", "4. Drugi stroški dela", ["47"]),
	total("144", "III. Odpisi vrednosti", ["145", "146", "147"]),
	leaf("145", "1. Amortizacija", ["43"]),
	leaf("146", "2. Prevrednotovalni poslovni odhodki pri neopredmetenih sredstvih in opredmetenih osnovnih sredstvih", ["720", "722"]),
	leaf("147", "3. Prevrednotovalni poslovni odhodki pri obratnih sredstvih", ["72"]),
	total("148", "IV. Drugi poslovni odhodki", ["149", "150"]),
	leaf("149", "1. Rezervacije", ["44"]),
	leaf("150", "2. Drugi stroški", ["48", "49", "70"]),
	computed("151", "H. DOBIČEK IZ POSLOVANJA"),
	computed("152", "I. IZGUBA IZ POSLOVANJA"),
	total("153", "J. FINANČNI PRIHODKI", ["155", "160", "163"]),
	total("155", "I. Finančni prihodki iz deležev", ["156", "157", "158", "159"]),
	leaf("156", "1. Finančni prihodki iz deležev v družbah v skupini", ["770"]),
	leaf("157", "2. Finančni prihodki iz deležev v pridruženih družbah", ["771"]),
	leaf("158", "3. Finančni prihodki iz deležev v drugih družbah", ["772"]),
	leaf("159", "4. Finančni prihodki iz drugih naložb", ["773"]),
	total("160", "II. Finančni prihodki iz danih posojil", ["161", "162"]),
	leaf("161", "1. Finančni prihodki iz posojil, danih družbam v skupini", ["774"]),
	leaf("162", "2. Finančni prihodki iz posojil, danih drugim", ["775"]),
	total("163", "III. Finančni prihodki iz poslovnih terjatev", ["164", "165"]),
	leaf("164", "1. Finančni prihodki iz poslovnih terjatev do družb v skupini", ["776"]),
	leaf("165", "2. Finančni prihodki iz poslovnih terjatev do drugih", ["77"]),
	total("166", "K. FINANČNI ODHODKI", ["168", "169", "174"]),
	leaf("168", "I. Finančni odhodki iz oslabitve in odpisov finančnih naložb", ["747", "748", "749"]),
	total("169", "II. Finančni odhodki iz finančnih obveznosti", ["170", "171", "172", "173"]),
	leaf("170", "1. Finančni odhodki iz posojil, prejetih od družb v skupini", ["740"]),
	leaf("171", "2. Finančni odhodki iz posojil, prejetih od bank", ["741"]),
	leaf("172", "3. Finančni odhodki iz izdanih obveznic", ["742"]),
	leaf("173", "4. Finančni odhodki iz drugih finančnih obveznosti", ["743", "45"]),
	total("174", "III. Finančni odhodki iz poslovnih obveznosti", ["175", "176", "177"]),
	leaf("175", "1. Finančni odhodki iz poslovnih obveznosti do družb v skupini", ["744"]),
	leaf("176", "2. Finančni odhodki iz obveznosti do dobaviteljev in meničnih obveznosti", ["745"]),
	leaf("177", "3. Finančni odhodki iz drugih poslovnih obveznosti", ["74"]),
	total("178", "L. DRUGI PRIHODKI", ["179", "180"]),
	leaf("179", "I. Subvencije, dotacije in podobni prihodki, ki niso povezani s poslovnimi učinki", ["785"]),
	leaf("180", "II. Ostali prihodki", ["78"]),
	leaf("181", "M. DRUGI ODHODKI", ["75"]),
];

const COMPANY_RESULT: Line[] = [
	computed("182", "N. CELOTNI DOBIČEK"),
	computed("183", "O. CELOTNA IZGUBA"),
	leaf("184", "P. DAVEK IZ DOBIČKA", ["810", "811", "812"]),
	leaf("185", "R. ODLOŽENI DAVKI", ["813"]),
	computed("186", "S. ČISTI DOBIČEK OBRAČUNSKEGA OBDOBJA"),
	computed("187", "Š. ČISTA IZGUBA OBRAČUNSKEGA OBDOBJA"),
];

const SOLE_RESULT: Line[] = [computed("182", "N. Podjetnikov dohodek"), computed("183", "O. Negativni poslovni izid")];

const SOLE_TRADER_AOP = new Set(
	"001 002 003 004 009 010 018 019 020 024 027 032 033 034 035 036 037 038 039 040 041 045 048 052 053 055 056 058 067 301 070 071 072 073 074 075 076 080 085 086 087 091 095 110 111 115 118 121 122 123 124 125 126 127 128 129 130 134 139 140 141 142 143 144 145 146 147 148 151 152 153 155 160 163 166 168 169 174 178 179 180 181 182 183".split(
		" "
	)
);

const EXPENSE_LEAVES = new Set([
	"122",
	"129",
	"131",
	"132",
	"133",
	"135",
	"136",
	"137",
	"138",
	"140",
	"141",
	"142",
	"143",
	"145",
	"146",
	"147",
	"149",
	"150",
	"168",
	"170",
	"171",
	"172",
	"173",
	"175",
	"176",
	"177",
	"181",
	"184",
]);

function isLeaf(line: Line): line is Leaf {
	return "prefixes" in line;
}

function assign(accounts: LedgerAccountRow[], leaves: Leaf[]): Map<string, Leaf> {
	const result = new Map<string, Leaf>();
	for (const account of accounts) {
		let best: { leaf: Leaf; length: number } | null = null;
		for (const candidate of leaves) {
			for (const prefix of candidate.prefixes) {
				if (account.code.startsWith(prefix) && (!best || prefix.length > best.length)) best = { leaf: candidate, length: prefix.length };
			}
		}
		if (best) result.set(account.uuid, best.leaf);
	}
	return result;
}

function evaluate(lines: Line[], values: Map<string, number>, computedValue: (aop: string, values: Map<string, number>) => number) {
	const resolve = (aop: string): number => {
		if (values.has(aop)) return values.get(aop)!;
		const line = lines.find((candidate) => candidate.aop === aop);
		let value = 0;
		if (line && "sum" in line) value = line.sum.reduce((sum, part) => sum + (part.startsWith("-") ? -resolve(part.slice(1)) : resolve(part)), 0);
		else if (line && "computed" in line) value = computedValue(aop, values);
		values.set(aop, value);
		return value;
	};
	for (const line of lines) resolve(line.aop);
}

interface Figures {
	balance: Map<string, number>;
	income: Map<string, number>;
}

async function figures(project: ProjectRow, accounts: LedgerAccountRow[], year: number, sole: boolean): Promise<Figures> {
	const from = startOfLocalDate(`${year}-01-01`, project.timezone);
	const to = endOfLocalDate(`${year}-12-31`, project.timezone);
	const position = await positionAt(project.uuid, from, to);
	const flows = await turnover(project.uuid, from, to);
	const equity = sole ? SOLE_EQUITY : COMPANY_EQUITY;
	const balanceLines = [...ASSETS, total("055", "OBVEZNOSTI DO VIROV SREDSTEV", ["056", "072", "075", "085", "095"]), ...equity, ...LIABILITIES];
	const balanceLeaves = balanceLines.filter(isLeaf);
	const ownerCapital = sole ? leaf("058", "", ["90", "91", "930", "931", "932", "933"]) : null;
	const balanceAssignment = assign(
		accounts.filter((account) => account.account_kind !== "revenue" && account.account_kind !== "expense"),
		ownerCapital ? [...balanceLeaves, ownerCapital] : balanceLeaves
	);
	const balance = new Map<string, number>();
	let carried = 0;
	let current = 0;
	for (const account of accounts) {
		const value = position.get(account.uuid);
		if (!value) continue;
		if (account.account_kind === "revenue" || account.account_kind === "expense") {
			current -= value.year;
			carried -= value.total - value.year;
			continue;
		}
		if (/^93[2357]/.test(account.code)) {
			current -= value.total;
			continue;
		}
		if (!sole && /^93[01]/.test(account.code)) {
			carried -= value.total;
			continue;
		}
		const target = balanceAssignment.get(account.uuid);
		if (!target) continue;
		const asset = ASSETS.includes(target);
		const amount = asset || target.deduction ? value.total : -value.total;
		balance.set(target.aop, (balance.get(target.aop) ?? 0) + amount);
	}
	if (sole) balance.set("058", (balance.get("058") ?? 0) + carried);
	evaluate(balanceLines, balance, (aop) => {
		if (aop === "068") return Math.max(carried, 0);
		if (aop === "069") return Math.max(-carried, 0);
		if (aop === "070") return Math.max(current, 0);
		if (aop === "071") return Math.max(-current, 0);
		return balance.get(aop) ?? 0;
	});

	const incomeLines = [...INCOME, ...(sole ? SOLE_RESULT : COMPANY_RESULT)];
	const incomeAssignment = assign(
		accounts.filter((account) => account.account_kind === "revenue" || account.account_kind === "expense"),
		incomeLines.filter(isLeaf)
	);
	const income = new Map<string, number>();
	for (const account of accounts) {
		const value = flows.get(account.uuid);
		const target = incomeAssignment.get(account.uuid);
		if (!value || !target) continue;
		const amount = EXPENSE_LEAVES.has(target.aop) ? value : -value;
		income.set(target.aop, (income.get(target.aop) ?? 0) + amount);
	}
	evaluate(incomeLines, income, (aop, values) => {
		const get = (key: string) => values.get(key) ?? 0;
		const operating = get("126") - get("127");
		const beforeTax = operating + get("153") - get("166") + get("178") - get("181");
		const net = beforeTax - get("184") + get("185");
		if (aop === "151") return Math.max(operating, 0);
		if (aop === "152") return Math.max(-operating, 0);
		if (aop === "182") return Math.max(beforeTax, 0);
		if (aop === "183") return Math.max(-beforeTax, 0);
		if (aop === "186") return Math.max(net, 0);
		if (aop === "187") return Math.max(-net, 0);
		return 0;
	});
	return { balance, income };
}

export async function ajpesReport(project: ProjectRow, year: number): Promise<AjpesReport> {
	const accounts = (await Database`SELECT * FROM ledger_accounts WHERE project = ${project.uuid} ORDER BY code`) as LedgerAccountRow[];
	const sole = project.bookkeeping !== "company";
	const now = await figures(project, accounts, year, sole);
	const before = await figures(project, accounts, year - 1, sole);
	const equity = sole ? SOLE_EQUITY : COMPANY_EQUITY;
	const describe = (lines: Line[], section: Section): AjpesLine[] =>
		lines
			.filter((line) => !sole || SOLE_TRADER_AOP.has(line.aop))
			.map((line) => ({
				aop: line.aop,
				label: line.label,
				current: (section === "balance" ? now.balance : now.income).get(line.aop) ?? 0,
				previous: (section === "balance" ? before.balance : before.income).get(line.aop) ?? 0,
				total: !isLeaf(line),
			}));
	const balance = [...ASSETS, total("055", "OBVEZNOSTI DO VIROV SREDSTEV", ["056", "072", "075", "085", "095"]), ...equity, ...LIABILITIES];
	return {
		year,
		form: sole ? "sole_trader" : "company",
		currency: project.tax_currency ?? project.currency,
		balance_sheet: describe(balance, "balance"),
		income_statement: describe([...INCOME, ...(sole ? SOLE_RESULT : COMPANY_RESULT)], "income"),
		balanced: (now.balance.get("001") ?? 0) === (now.balance.get("055") ?? 0),
	};
}

function xmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface AjpesCompany {
	registration_number: string;
	tax_number: string | null;
	name: string | null;
}

export function ajpesXml(report: AjpesReport, company: AjpesCompany, bookkeeping: ProjectRow["bookkeeping"], now = new Date()): string {
	const amount = (value: number) => (value / 100).toFixed(2);
	const lines = [...report.balance_sheet, ...report.income_statement];
	const basics = [
		`<OSN_Maticna_stevilka>${xmlText(company.registration_number)}</OSN_Maticna_stevilka>`,
		company.tax_number ? `<OSN_Davcna_stevilka>${xmlText(company.tax_number)}</OSN_Davcna_stevilka>` : null,
		company.name ? `<OSN_Ime>${xmlText(company.name)}</OSN_Ime>` : null,
		`<OSN_Datum_posl_zacetek>${report.year}-01-01</OSN_Datum_posl_zacetek>`,
		`<OSN_Datum_posl_konec>${report.year}-12-31</OSN_Datum_posl_konec>`,
		`<OSN_Racunovodimo>2</OSN_Racunovodimo>`,
		report.form === "sole_trader"
			? `<OSN_Poslovne_knjige_vodimo_po_nacelu_enostavnega_knjigovodstva>${bookkeeping === "sole_simplified" ? 1 : 0}</OSN_Poslovne_knjige_vodimo_po_nacelu_enostavnega_knjigovodstva>`
			: null,
	].filter((line): line is string => line !== null);
	return [
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<AjpesDokument xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.ajpes.si/xml_sheme/LP_V1_3.xsd">`,
		`\t<Ident Vrsta="LP">`,
		`\t\t<Datum>${now.toISOString().slice(0, 10)}</Datum>`,
		`\t\t<Ura>${now.toISOString().slice(11, 19)}</Ura>`,
		`\t\t<Nacin_predlozitve>XML datoteka</Nacin_predlozitve>`,
		`\t</Ident>`,
		`\t<Osnovni_podatki vrstaPoslovnegaSubjekta="${report.form === "sole_trader" ? "SP" : "GD"}">`,
		...basics.map((line) => `\t\t${line}`),
		`\t</Osnovni_podatki>`,
		`\t<Podatki>`,
		...lines.flatMap((line) => [
			`\t\t<AOP ID="${line.aop}">`,
			`\t\t\t<PODATEK TIP="T">${amount(line.current)}</PODATEK>`,
			`\t\t\t<PODATEK TIP="P">${amount(line.previous)}</PODATEK>`,
			`\t\t</AOP>`,
		]),
		`\t</Podatki>`,
		`</AjpesDokument>`,
		"",
	].join("\n");
}
