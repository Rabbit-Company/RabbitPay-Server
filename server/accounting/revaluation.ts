import Database from "../database/database";
import { convertMinor } from "../invoicing";
import { endOfLocalDate, startOfLocalDate } from "../timezone";
import { ensureChart } from "./chart";
import { ledgerMovements, postEntry, withLedger, type PostingLine } from "./journal";
import type { OpenItemMovement } from "./sources";
import type { JournalEntryRow, ProjectRow } from "../database/models";
import type { RevaluationItem, RevaluationPreview } from "./types";

export class RevaluationRefused extends Error {
	constructor(readonly reason: "year_not_over" | "year_closed" | "invalid_rates" | "already_revalued") {
		super(reason);
	}
}

export function revaluationSource(year: number): string {
	return `fx_revaluation:${year}`;
}

async function activeRevaluation(project: string, year: number): Promise<JournalEntryRow | null> {
	const [entry] = (await Database`
		SELECT * FROM journal_entries e WHERE e.project = ${project} AND e.source_type = 'manual' AND e.source_id = ${revaluationSource(year)}
			AND e.reverses IS NULL AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses = e.uuid)
		LIMIT 1
	`) as JournalEntryRow[];
	return entry ?? null;
}

async function openItems(project: ProjectRow, until: number) {
	const base = project.tax_currency ?? project.currency;
	const documents = new Map<string, Omit<RevaluationItem, "revalued" | "difference"> & { movement: OpenItemMovement }>();
	for (const movement of await ledgerMovements(project)) {
		if (movement.date > until || movement.currency === base) continue;
		const current = documents.get(movement.document.key) ?? {
			reference: movement.document.reference,
			partner: movement.document.partner.name || null,
			currency: movement.currency,
			account: movement.account.code,
			open: 0,
			booked: 0,
			movement,
		};
		current.open += movement.foreign;
		current.booked += movement.base;
		documents.set(movement.document.key, current);
	}
	return [...documents.values()].filter((item) => item.open !== 0);
}

export async function revaluationPreview(project: ProjectRow, year: number, rates: Record<string, number>): Promise<RevaluationPreview> {
	const base = project.tax_currency ?? project.currency;
	const items = await openItems(project, endOfLocalDate(`${year}-12-31`, project.timezone));
	const lines = items.map(({ movement: _movement, ...item }) => {
		const rate = rates[item.currency];
		const revalued = rate ? convertMinor(item.open, item.currency, rate, base) : null;
		return { ...item, revalued, difference: revalued === null ? null : revalued - item.booked };
	});
	return {
		year,
		currency: base,
		currencies: [...new Set(items.map((item) => item.currency))].sort(),
		items: lines,
		difference: lines.reduce((sum, line) => sum + (line.difference ?? 0), 0),
		posted: (await activeRevaluation(project.uuid, year))?.uuid ?? null,
	};
}

export async function postRevaluation(project: ProjectRow, year: number, rates: Record<string, number>, author: string) {
	const end = endOfLocalDate(`${year}-12-31`, project.timezone);
	if (Date.now() <= end) throw new RevaluationRefused("year_not_over");
	const closed = (await Database`
		SELECT year FROM accounting_years WHERE project = ${project.uuid} AND year IN (${year}, ${year + 1}) AND reopened_at IS NULL
	`) as { year: number }[];
	if (closed.length > 0) throw new RevaluationRefused("year_closed");
	const items = await openItems(project, end);
	return await withLedger(project.uuid, async () => {
		if (await activeRevaluation(project.uuid, year)) throw new RevaluationRefused("already_revalued");
		const base = project.tax_currency ?? project.currency;
		const chart = await ensureChart(project.uuid);
		if (items.some((item) => !(rates[item.currency] > 0))) throw new RevaluationRefused("invalid_rates");
		const balances = new Map<string, PostingLine>();
		const add = (account: string, partner: string | null, amount: number) => {
			const key = `${account}|${partner ?? ""}`;
			const line = balances.get(key) ?? { ledger_account: account, partner, debit: 0, credit: 0 };
			const net = line.debit - line.credit + amount;
			line.debit = net > 0 ? net : 0;
			line.credit = net < 0 ? -net : 0;
			balances.set(key, line);
		};
		for (const item of items) {
			const difference = convertMinor(item.open, item.currency, rates[item.currency], base) - item.booked;
			if (difference === 0) continue;
			add(item.movement.account.uuid, item.partner, difference);
			add(chart.system(difference > 0 ? "fx_gains" : "fx_losses").uuid, null, -difference);
		}
		const lines = [...balances.values()].filter((line) => line.debit !== 0 || line.credit !== 0);
		if (lines.length < 2) return null;
		const used = [...new Set(items.map((item) => item.currency))].sort();
		const rateText = used.map((currency) => `1 ${currency} = ${rates[currency]} ${base}`).join(", ");
		return await Database.begin(async (tx) => {
			const entry = await postEntry(
				tx,
				project,
				{
					source_type: "manual",
					source_id: revaluationSource(year),
					date: startOfLocalDate(`${year}-12-31`, project.timezone),
					description: `Prevrednotenje terjatev in obveznosti v tuji valuti na dan 31. 12. ${year} (${rateText})`.slice(0, 500),
					lines,
				},
				author
			);
			const reversal = await postEntry(
				tx,
				project,
				{
					source_type: "manual",
					source_id: `${revaluationSource(year)}:reversal`,
					date: startOfLocalDate(`${year + 1}-01-01`, project.timezone),
					description: `Odprava prevrednotenja terjatev in obveznosti v tuji valuti z dne 31. 12. ${year}`,
					lines: lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit })),
				},
				author
			);
			return { entry: entry.uuid, reversal: reversal.uuid };
		});
	});
}
