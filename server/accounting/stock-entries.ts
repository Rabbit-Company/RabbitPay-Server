import Database from "../database/database";
import { safeInteger } from "../database/numbers";
import { EntryBuilder, type PlannedEntry } from "./sources";
import { stockVat } from "../inventory/vat";
import type { Chart, SystemAccount } from "./chart";
import type { LedgerAccountRow, StockDocumentRow, StockIssueReason, StockKind, StockMovementRow } from "../database/models";

interface StockAccounts {
	stock: SystemAccount;
	clearing: SystemAccount;
	loss: SystemAccount;
}

const ACCOUNTS: Record<StockKind, StockAccounts> = {
	goods: { stock: "goods_stock", clearing: "goods_purchase_clearing", loss: "cost_of_goods_sold" },
	material: { stock: "material_stock", clearing: "material_purchase_clearing", loss: "material" },
};

const ISSUE_ACCOUNTS: Record<StockIssueReason, SystemAccount | "loss" | "clearing"> = {
	consumption: "material",
	own_use: "other_costs",
	gift: "representation",
	damage: "stock_write_down",
	expiry: "stock_write_down",
	shortage: "loss",
	natural_loss: "loss",
	theft: "loss",
	force_majeure: "other_losses",
	supplier_return: "clearing",
};

const DOCUMENT_LABELS: Record<StockDocumentRow["document_type"], string> = {
	receipt: "Prevzemnica",
	issue: "Izdajnica",
	transfer: "Medskladiščni prenos",
	stocktake: "Inventura",
	opening: "Otvoritev zaloge",
};

type PlannedMovement = StockMovementRow & { stock_kind: StockKind | null; item_tax_rate: number; line_tax_rate: number | null };

export class StockPlanner {
	constructor(
		private readonly project: string,
		private readonly chart: Chart
	) {}

	private account(key: SystemAccount): LedgerAccountRow {
		return this.chart.system(key);
	}

	private issueAccount(document: StockDocumentRow, accounts: StockAccounts): LedgerAccountRow {
		const chosen = document.ledger_account ? this.chart.byUuid(document.ledger_account) : undefined;
		if (chosen) return chosen;
		const mapped = ISSUE_ACCOUNTS[document.reason as StockIssueReason] ?? "loss";
		return this.account(mapped === "loss" ? accounts.loss : mapped === "clearing" ? accounts.clearing : mapped);
	}

	private post(entry: EntryBuilder, movement: PlannedMovement, document: StockDocumentRow | undefined) {
		if (movement.stock_kind === null) return;
		const accounts = ACCOUNTS[movement.stock_kind];
		const stock = this.account(accounts.stock);
		const sold = this.account("cost_of_goods_sold");
		const value = movement.value;
		entry.debit(sold, movement.correction);
		entry.credit(stock, movement.correction);
		if (value === 0) return;

		if (movement.movement_kind === "receipt") {
			entry.debit(stock, value);
			entry.credit(this.account(accounts.clearing), value, document?.partner ?? null);
		} else if (movement.movement_kind === "opening") {
			if (document?.opening_offset !== "expense") return;
			entry.debit(stock, value);
			entry.credit(this.account(accounts.loss), value);
		} else if (movement.movement_kind === "sale" || movement.movement_kind === "sale_return" || movement.movement_kind === "customer_return") {
			entry.debit(stock, value);
			entry.credit(sold, value);
		} else if (movement.movement_kind === "surplus") {
			entry.debit(stock, value);
			entry.credit(this.account(accounts.loss), value);
		} else if (movement.movement_kind === "shortage") {
			const loss = this.account(accounts.loss);
			entry.debit(stock, value);
			entry.credit(loss, value);
			if (document?.charge_vat) {
				const vat = stockVat(value, movement.item_tax_rate);
				entry.debit(loss, vat);
				entry.credit(this.account("output_vat"), vat);
			}
		} else if (movement.movement_kind === "issue" && document) {
			const expense = this.issueAccount(document, accounts);
			entry.debit(stock, value);
			entry.credit(expense, value);
			if (document.charge_vat) {
				const vat = stockVat(value, movement.line_tax_rate ?? movement.item_tax_rate);
				entry.debit(expense, vat);
				entry.credit(this.account("output_vat"), vat);
			}
		} else if (movement.movement_kind === "transfer_in" || movement.movement_kind === "transfer_out") {
			entry.debit(stock, value);
		}
	}

	async plan(): Promise<PlannedEntry[]> {
		const rows = (await Database`
			SELECT m.*, c.stock_kind AS stock_kind, c.tax_rate AS item_tax_rate, l.tax_rate AS line_tax_rate
			FROM stock_movements m JOIN catalog_items c ON c.uuid = m.item LEFT JOIN stock_document_lines l ON l.uuid = m.document_line
			WHERE m.project = ${this.project} ORDER BY m.movement_date ASC, m.sequence ASC
		`) as PlannedMovement[];
		if (rows.length === 0) return [];
		const documents = new Map(
			((await Database`SELECT * FROM stock_documents WHERE project = ${this.project} AND status = 'posted'`) as StockDocumentRow[]).map((row) => [
				row.uuid,
				row,
			])
		);
		const references = new Map(
			(
				(await Database`
					SELECT uuid, reference FROM invoices WHERE project = ${this.project} AND uuid IN (SELECT invoice FROM stock_movements WHERE project = ${this.project})
				`) as { uuid: string; reference: string }[]
			).map((row) => [row.uuid, row.reference])
		);

		const groups = new Map<string, { entry: EntryBuilder; planned: Omit<PlannedEntry, "lines"> }>();
		for (const row of rows) {
			const movement: PlannedMovement = {
				...row,
				value: safeInteger(row.value),
				correction: safeInteger(row.correction),
				movement_date: safeInteger(row.movement_date),
				item_tax_rate: Number(row.item_tax_rate ?? 0),
				line_tax_rate: row.line_tax_rate === null ? null : Number(row.line_tax_rate),
			};
			const document = movement.document ? documents.get(movement.document) : undefined;
			let planned: Omit<PlannedEntry, "lines"> | null = null;
			if (document) {
				const partner = document.partner ? `, ${document.partner}` : "";
				planned = {
					source_type: "stock_document",
					source_id: document.uuid,
					date: movement.movement_date,
					description: `${DOCUMENT_LABELS[document.document_type]} ${document.number ?? ""}${partner}`.trim(),
				};
			} else if (movement.invoice && movement.movement_kind === "sale_return") {
				planned = {
					source_type: "stock_return",
					source_id: movement.invoice,
					date: movement.movement_date,
					description: `Vračilo blaga v zalogo po stornu računa ${references.get(movement.invoice) ?? ""}`.trim(),
				};
			} else if (movement.invoice) {
				planned = {
					source_type: "stock_sale",
					source_id: movement.invoice,
					date: movement.movement_date,
					description: `Nabavna vrednost prodanega blaga in materiala, račun ${references.get(movement.invoice) ?? ""}`.trim(),
				};
			}
			if (!planned) continue;
			const key = `${planned.source_type}:${planned.source_id}`;
			const group = groups.get(key) ?? { entry: new EntryBuilder(), planned };
			groups.set(key, group);
			this.post(group.entry, movement, document);
		}
		return [...groups.values()].map((group) => ({ ...group.planned, lines: group.entry.lines() }));
	}
}
