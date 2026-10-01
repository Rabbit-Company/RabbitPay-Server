import Database from "../database/database";
import { safeInteger } from "../database/numbers";
import { localDate } from "../timezone";
import { ensureChart, type SystemAccount } from "./chart";
import { ledgerMovements } from "./journal";
import { PARTNER_ACCOUNTS, partnerName, partnerRef, type DocumentRef, type OpenItemMovement, type PartnerRef } from "./sources";
import type { LedgerAccountRow, ProjectRow } from "../database/models";
import type { AgingBucket, OpenItem, OpenItemsKind, OpenItemsReport, PartnerOpenItems } from "./types";

const DAY = 86400000;
const RECEIVABLES = new Set<string>(["receivables_domestic", "receivables_foreign"]);

export const AGING_BUCKETS: AgingBucket[] = ["current", "1_30", "31_60", "61_90", "91_180", "over_180"];

function bucket(days: number): AgingBucket {
	if (days <= 0) return "current";
	if (days <= 30) return "1_30";
	if (days <= 60) return "31_60";
	if (days <= 90) return "61_90";
	if (days <= 180) return "91_180";
	return "over_180";
}

function dayNumber(timestamp: number, timezone: string): number {
	return Math.floor(Date.parse(`${localDate(timestamp, timezone)}T00:00:00Z`) / DAY);
}

function kindOf(account: LedgerAccountRow): "receivable" | "payable" {
	return RECEIVABLES.has(account.system_key ?? "") ? "receivable" : "payable";
}

function partnerAccounts(accounts: LedgerAccountRow[]): LedgerAccountRow[] {
	return accounts.filter((account) => account.system_key !== null && PARTNER_ACCOUNTS.has(account.system_key as SystemAccount));
}

async function manualMovements(project: string, accounts: LedgerAccountRow[], until: number): Promise<OpenItemMovement[]> {
	const byUuid = new Map(accounts.map((account) => [account.uuid, account]));
	if (byUuid.size === 0) return [];
	const rows = (await Database`
		SELECT je.uuid, je.year, je.number, je.entry_date, je.reverses, je.source_id, jl.ledger_account, jl.debit, jl.credit, jl.partner, jl.sort_order,
			o.year AS original_year, o.number AS original_number, o.entry_date AS original_date, o.source_id AS original_source
		FROM journal_lines jl JOIN journal_entries je ON je.uuid = jl.entry LEFT JOIN journal_entries o ON o.uuid = je.reverses
		WHERE jl.project = ${project} AND je.source_type = 'manual' AND je.entry_date <= ${until} AND jl.ledger_account IN ${Database([...byUuid.keys()])}
	`) as {
		uuid: string;
		year: number;
		number: number;
		entry_date: number;
		reverses: string | null;
		source_id: string;
		ledger_account: string;
		debit: number;
		credit: number;
		partner: string | null;
		sort_order: number;
		original_year: number | null;
		original_number: number | null;
		original_date: number | null;
		original_source: string | null;
	}[];
	return rows
		.filter((row) => !(row.original_source ?? row.source_id).startsWith("fx_revaluation:"))
		.map((row) => {
			const amount = safeInteger(row.debit) - safeInteger(row.credit);
			const document: DocumentRef = {
				key: `manual:${row.reverses ?? row.uuid}:${row.ledger_account}:${row.partner ?? ""}`,
				type: "manual",
				reference: `${row.original_year ?? row.year}/${row.original_number ?? row.number}`,
				partner: partnerRef(row.partner, null),
				issued: Number(row.original_date ?? row.entry_date),
				due: null,
			};
			return {
				document,
				account: byUuid.get(row.ledger_account)!,
				currency: "",
				date: Number(row.entry_date),
				foreign: amount,
				base: amount,
				origin: row.reverses === null,
			};
		});
}

async function ledgerBalances(project: string, accounts: LedgerAccountRow[], until: number): Promise<Map<string, number>> {
	if (accounts.length === 0) return new Map();
	const rows = (await Database`
		SELECT jl.ledger_account, COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0) AS balance
		FROM journal_lines jl JOIN journal_entries je ON je.uuid = jl.entry LEFT JOIN journal_entries o ON o.uuid = je.reverses
		WHERE jl.project = ${project} AND je.entry_date <= ${until} AND jl.ledger_account IN ${Database(accounts.map((account) => account.uuid))}
			AND je.source_type NOT IN ('year_closing', 'year_opening')
			AND (o.uuid IS NULL OR o.source_type NOT IN ('year_closing', 'year_opening'))
		GROUP BY jl.ledger_account
	`) as { ledger_account: string; balance: number }[];
	return new Map(rows.map((row) => [row.ledger_account, safeInteger(row.balance)]));
}

function mergedKeys(partners: PartnerRef[]): Map<string, string> {
	const byName = new Map<string, Set<string>>();
	for (const partner of partners) {
		if (!partner.key.startsWith("tax:")) continue;
		const name = partnerName(partner.name);
		if (name) byName.set(name, new Set([...(byName.get(name) ?? []), partner.key]));
	}
	const merged = new Map<string, string>();
	for (const partner of partners) {
		if (partner.key.startsWith("tax:")) continue;
		const candidates = byName.get(partnerName(partner.name));
		if (candidates?.size === 1) merged.set(partner.key, [...candidates][0]);
	}
	return merged;
}

export async function openItems(project: ProjectRow, until: number, kind: OpenItemsKind): Promise<OpenItemsReport> {
	const chart = await ensureChart(project.uuid);
	const accounts = partnerAccounts(chart.accounts).filter((account) => kind === "all" || kindOf(account) === kind);
	const wanted = new Set(accounts.map((account) => account.uuid));
	const movements = [...(await ledgerMovements(project)), ...(await manualMovements(project.uuid, accounts, until))].filter(
		(movement) => movement.date <= until && wanted.has(movement.account.uuid)
	);
	const merged = mergedKeys(movements.map((movement) => movement.document.partner));

	const documents = new Map<string, { item: OpenItem; partner: PartnerRef; partnerKey: string }>();
	for (const movement of movements) {
		const key = `${movement.document.key}|${movement.account.uuid}`;
		const partnerKey = merged.get(movement.document.partner.key) ?? movement.document.partner.key;
		const current = documents.get(key) ?? {
			partner: movement.document.partner,
			partnerKey,
			item: {
				key: movement.document.key,
				type: movement.document.type,
				reference: movement.document.reference,
				date: movement.document.issued,
				due_date: movement.document.due,
				account: movement.account.code,
				kind: kindOf(movement.account),
				currency: movement.currency || null,
				amount: 0,
				open: 0,
				open_foreign: 0,
				days_overdue: 0,
			},
		};
		if (movement.origin) current.item.amount += movement.base;
		current.item.open += movement.base;
		current.item.open_foreign += movement.foreign;
		documents.set(key, current);
	}

	const day = dayNumber(until, project.timezone);
	const partners = new Map<string, PartnerOpenItems>();
	for (const { item, partner, partnerKey } of documents.values()) {
		if (item.open === 0) continue;
		item.days_overdue = day - dayNumber(item.due_date ?? item.date, project.timezone);
		const entry = partners.get(partnerKey) ?? {
			key: partnerKey,
			name: partner.name,
			tax_number: partner.tax_number,
			address: partner.address,
			receivable: 0,
			payable: 0,
			balance: 0,
			aging: Object.fromEntries(AGING_BUCKETS.map((name) => [name, 0])) as Record<AgingBucket, number>,
			items: [],
		};
		if (partner.key.startsWith("tax:") && !entry.tax_number) entry.tax_number = partner.tax_number;
		if (partner.address.length > entry.address.length) entry.address = partner.address;
		if (!entry.name && partner.name) entry.name = partner.name;
		if (item.kind === "receivable") entry.receivable += item.open;
		else entry.payable -= item.open;
		entry.balance += item.open;
		entry.aging[bucket(item.days_overdue)] += item.open;
		entry.items.push(item);
		partners.set(partnerKey, entry);
	}
	for (const partner of partners.values()) partner.items.sort((a, b) => a.date - b.date || (a.reference ?? "").localeCompare(b.reference ?? ""));

	const balances = await ledgerBalances(project.uuid, accounts, until);
	const listed = new Map<string, number>();
	for (const partner of partners.values()) for (const item of partner.items) listed.set(item.account, (listed.get(item.account) ?? 0) + item.open);
	return {
		date: until,
		kind,
		currency: project.tax_currency ?? project.currency,
		partners: [...partners.values()].sort((a, b) => a.name.localeCompare(b.name)),
		accounts: accounts.map((account) => {
			const ledger = balances.get(account.uuid) ?? 0;
			const items = listed.get(account.code) ?? 0;
			return { code: account.code, name: account.name, ledger, items, difference: ledger - items };
		}),
	};
}

export async function knownPartners(project: ProjectRow): Promise<{ key: string; name: string; tax_number: string | null }[]> {
	const partners = new Map<string, { key: string; name: string; tax_number: string | null }>();
	for (const movement of await ledgerMovements(project)) {
		const partner = movement.document.partner;
		if (!partner.name || movement.document.type === "bank_transaction") continue;
		partners.set(partner.key, { key: partner.key, name: partner.name, tax_number: partner.tax_number });
	}
	return [...partners.values()].sort((a, b) => a.name.localeCompare(b.name));
}
