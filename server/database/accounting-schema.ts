import type { SQL } from "bun";
import type { Dialect } from "./dialect";
import { run } from "./schema";
import { schemaTypes } from "./schema-types";
import { LICENSE_TYPES_WITH_SEATS, replaceCheck } from "./workforce-schema";

export const LICENSE_TYPES_WITH_ACCOUNTING = "CHECK (type IN ('transactions', 'white_label', 'storage', 'store', 'workforce', 'employees', 'accounting'))";

export async function createAccountingSchema(sql: SQL, dialect: Dialect) {
	const types = schemaTypes(dialect);
	await replaceCheck(sql, dialect, "license_keys", "white_label", "license_keys_type_check", LICENSE_TYPES_WITH_SEATS, LICENSE_TYPES_WITH_ACCOUNTING);
	await sql.unsafe(`ALTER TABLE projects ADD COLUMN accounting_until ${types.int64}`);
	await sql.unsafe(`ALTER TABLE transactions ADD COLUMN base_amount ${types.int64}`);
	await sql.unsafe(`ALTER TABLE expenses ADD COLUMN provisional_share ${types.flag} NOT NULL DEFAULT 0 CHECK (provisional_share IN (0, 1))`);
	await sql.unsafe(
		`ALTER TABLE projects ADD COLUMN bookkeeping ${types.text("bookkeeping")} NOT NULL DEFAULT 'company' CHECK (bookkeeping IN ('company', 'sole_double', 'sole_simplified', 'sole_flat_rate'))`
	);
	await run(sql, dialect, [
		`CREATE TABLE IF NOT EXISTS ledger_accounts(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					code ${types.text("code")} NOT NULL,
					name ${types.text("name")} NOT NULL,
					account_kind ${types.text("account_kind")} NOT NULL,
					system_key ${types.text("system_key")},
					iban ${types.text("iban")},
					active ${types.flag} NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					UNIQUE(project, code),
					UNIQUE(project, system_key),
					UNIQUE(project, iban),
					CHECK (account_kind IN ('asset', 'liability', 'equity', 'revenue', 'expense'))
				)`,
		`CREATE TABLE IF NOT EXISTS fixed_assets(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					name ${types.text("name")} NOT NULL,
					asset_category ${types.text("asset_category")} NOT NULL,
					expense ${types.text("expense")},
					acquired_at ${types.int64} NOT NULL,
					depreciation_from ${types.int64} NOT NULL,
					acquisition_value ${types.int64} NOT NULL,
					accumulated_before ${types.int64} NOT NULL DEFAULT 0,
					annual_rate ${types.float} NOT NULL,
					disposed_at ${types.int64},
					notes ${types.text("notes")},
					created_by ${types.text("created_by")},
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (expense) REFERENCES expenses(uuid) ON DELETE SET NULL,
					FOREIGN KEY (created_by) REFERENCES accounts(username) ON DELETE SET NULL,
					UNIQUE(expense),
					CHECK (asset_category IN ('intangible', 'building', 'equipment', 'computer', 'small_inventory')),
					CHECK (acquisition_value > 0 AND accumulated_before >= 0 AND accumulated_before <= acquisition_value),
					CHECK (annual_rate > 0 AND annual_rate <= 100)
				)`,
		`CREATE INDEX IF NOT EXISTS idx_fixed_assets_project ON fixed_assets(project, acquired_at)`,
		`CREATE TABLE IF NOT EXISTS deductible_shares(
					project ${types.text("project")} NOT NULL,
					year INTEGER NOT NULL,
					final_share ${types.float} NOT NULL,
					updated_by ${types.text("updated_by")},
					updated ${types.int64} NOT NULL,
					PRIMARY KEY (project, year),
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (updated_by) REFERENCES accounts(username) ON DELETE SET NULL,
					CHECK (final_share >= 0 AND final_share <= 100)
				)`,
		`CREATE TABLE IF NOT EXISTS accounting_years(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					year INTEGER NOT NULL,
					closed_by ${types.text("closed_by")},
					closed_at ${types.int64} NOT NULL,
					reopened_by ${types.text("reopened_by")},
					reopened_at ${types.int64},
					reopen_reason ${types.text("reopen_reason")},
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (closed_by) REFERENCES accounts(username) ON DELETE SET NULL,
					FOREIGN KEY (reopened_by) REFERENCES accounts(username) ON DELETE SET NULL
				)`,
		`CREATE INDEX IF NOT EXISTS idx_accounting_years_project ON accounting_years(project, year)`,
		`CREATE TABLE IF NOT EXISTS ledger_category_accounts(
					project ${types.text("project")} NOT NULL,
					expense_category ${types.text("expense_category")} NOT NULL,
					ledger_account ${types.text("ledger_account")} NOT NULL,
					updated ${types.int64} NOT NULL,
					PRIMARY KEY (project, expense_category),
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (ledger_account) REFERENCES ledger_accounts(uuid)
				)`,
		`CREATE TABLE IF NOT EXISTS journal_entries(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					year INTEGER NOT NULL,
					number INTEGER NOT NULL,
					entry_date ${types.int64} NOT NULL,
					description ${types.text("description")} NOT NULL,
					source_type ${types.text("source_type")} NOT NULL,
					source_id ${types.text("source_id")} NOT NULL,
					reverses ${types.text("reverses")},
					fingerprint ${types.text("sha256")} NOT NULL,
					posted_by ${types.text("posted_by")},
					created ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (reverses) REFERENCES journal_entries(uuid),
					UNIQUE(project, year, number),
					UNIQUE(reverses),
					CHECK (source_type IN ('invoice', 'credit_note', 'payment', 'refund', 'expense', 'expense_payment', 'recorded_invoice', 'recorded_payment', 'bank_transaction', 'depreciation', 'asset_disposal', 'payroll', 'deductible_share', 'year_result', 'year_closing', 'year_opening', 'manual'))
				)`,
		`CREATE INDEX IF NOT EXISTS idx_journal_entries_source ON journal_entries(project, source_type, source_id)`,
		`CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(project, entry_date)`,
		`CREATE TABLE IF NOT EXISTS journal_lines(
					uuid ${types.text("uuid")} PRIMARY KEY,
					entry ${types.text("entry")} NOT NULL,
					project ${types.text("project")} NOT NULL,
					ledger_account ${types.text("ledger_account")} NOT NULL,
					debit ${types.int64} NOT NULL DEFAULT 0,
					credit ${types.int64} NOT NULL DEFAULT 0,
					partner ${types.text("partner")},
					sort_order INTEGER NOT NULL DEFAULT 0,
					FOREIGN KEY (entry) REFERENCES journal_entries(uuid) ON DELETE CASCADE,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (ledger_account) REFERENCES ledger_accounts(uuid),
					CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0) AND debit + credit > 0)
				)`,
		`CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry)`,
		`CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(project, ledger_account)`,
		`CREATE TABLE IF NOT EXISTS recorded_invoices(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					document_type ${types.text("document_type")} NOT NULL,
					reference ${types.text("reference")} NOT NULL,
					buyer_name ${types.text("buyer_name")} NOT NULL,
					buyer_vat_number ${types.text("buyer_vat_number")},
					buyer_country ${types.text("buyer_country")},
					currency ${types.text("currency")} NOT NULL,
					tax_currency ${types.text("tax_currency")} NOT NULL,
					tax_exchange_rate ${types.float},
					tax_rate_date ${types.int64},
					issued_at ${types.int64} NOT NULL,
					supply_date ${types.int64},
					due_date ${types.int64},
					paid_at ${types.int64},
					payment_account ${types.text("payment_account")} NOT NULL DEFAULT 'bank',
					subtotal ${types.int64} NOT NULL,
					tax_amount ${types.int64} NOT NULL,
					total_amount ${types.int64} NOT NULL,
					notes ${types.text("notes")},
					created_by ${types.text("created_by")},
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (created_by) REFERENCES accounts(username) ON DELETE SET NULL,
					UNIQUE(project, document_type, reference),
					CHECK (document_type IN ('invoice', 'credit_note')),
					CHECK (payment_account IN ('bank', 'cash'))
				)`,
		`CREATE INDEX IF NOT EXISTS idx_recorded_invoices_issued ON recorded_invoices(project, issued_at)`,
		`CREATE TABLE IF NOT EXISTS recorded_invoice_lines(
					uuid ${types.text("uuid")} PRIMARY KEY,
					recorded_invoice ${types.text("recorded_invoice")} NOT NULL,
					tax_rate ${types.float} NOT NULL,
					tax_treatment ${types.text("tax_treatment")} NOT NULL,
					net_amount ${types.int64} NOT NULL,
					tax_amount ${types.int64} NOT NULL,
					sort_order INTEGER NOT NULL DEFAULT 0,
					FOREIGN KEY (recorded_invoice) REFERENCES recorded_invoices(uuid) ON DELETE CASCADE
				)`,
		`CREATE INDEX IF NOT EXISTS idx_recorded_invoice_lines_record ON recorded_invoice_lines(recorded_invoice)`,
		`CREATE TABLE IF NOT EXISTS recorded_invoice_attachments(
					recorded_invoice ${types.text("recorded_invoice")} PRIMARY KEY,
					storage_key ${types.text("storage_key")} NOT NULL,
					file_name ${types.text("file_name")} NOT NULL,
					content_type ${types.text("content_type")} NOT NULL,
					byte_size ${types.int64} NOT NULL,
					sha256 ${types.text("sha256")} NOT NULL,
					created ${types.int64} NOT NULL,
					FOREIGN KEY (recorded_invoice) REFERENCES recorded_invoices(uuid) ON DELETE CASCADE
				)`,
		`CREATE TABLE IF NOT EXISTS bank_statements(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					iban ${types.text("iban")} NOT NULL,
					statement_id ${types.text("statement_id")} NOT NULL,
					currency ${types.text("currency")} NOT NULL,
					period_from ${types.int64},
					period_to ${types.int64},
					opening_balance ${types.int64},
					closing_balance ${types.int64},
					file_name ${types.text("file_name")},
					created_by ${types.text("created_by")},
					created ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (created_by) REFERENCES accounts(username) ON DELETE SET NULL,
					UNIQUE(project, iban, statement_id)
				)`,
		`CREATE TABLE IF NOT EXISTS bank_transactions(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					statement ${types.text("statement")} NOT NULL,
					booking_date ${types.int64} NOT NULL,
					value_date ${types.int64},
					amount ${types.int64} NOT NULL,
					currency ${types.text("currency")} NOT NULL,
					counterparty_name ${types.text("counterparty_name")},
					counterparty_iban ${types.text("iban")},
					reference ${types.text("reference")},
					remittance ${types.text("remittance")},
					bank_reference ${types.text("bank_reference")},
					fingerprint ${types.text("sha256")} NOT NULL,
					status ${types.text("status")} NOT NULL DEFAULT 'open',
					match_type ${types.text("match_type")},
					match_id ${types.text("match_id")},
					ledger_account ${types.text("ledger_account")},
					payment_transaction ${types.text("payment_transaction")},
					matched_by ${types.text("matched_by")},
					matched_at ${types.int64},
					created ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (statement) REFERENCES bank_statements(uuid) ON DELETE CASCADE,
					FOREIGN KEY (ledger_account) REFERENCES ledger_accounts(uuid),
					FOREIGN KEY (matched_by) REFERENCES accounts(username) ON DELETE SET NULL,
					UNIQUE(project, fingerprint),
					CHECK (amount <> 0),
					CHECK (status IN ('open', 'matched', 'booked', 'ignored')),
					CHECK (match_type IS NULL OR match_type IN ('invoice', 'recorded_invoice', 'expense'))
				)`,
		`CREATE INDEX IF NOT EXISTS idx_bank_transactions_status ON bank_transactions(project, status, booking_date)`,
	]);
}

export async function createBankMatchSchema(sql: SQL, dialect: Dialect) {
	const types = schemaTypes(dialect);
	await run(sql, dialect, [
		`CREATE TABLE IF NOT EXISTS bank_transaction_matches(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					bank_transaction ${types.text("bank_transaction")} NOT NULL,
					match_type ${types.text("match_type")} NOT NULL,
					match_id ${types.text("match_id")} NOT NULL,
					amount ${types.int64} NOT NULL,
					payment_transaction ${types.text("payment_transaction")},
					created ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (bank_transaction) REFERENCES bank_transactions(uuid) ON DELETE CASCADE,
					UNIQUE(bank_transaction, match_type, match_id),
					CHECK (amount > 0),
					CHECK (match_type IN ('invoice', 'recorded_invoice', 'expense'))
				)`,
		`CREATE INDEX IF NOT EXISTS idx_bank_transaction_matches_document ON bank_transaction_matches(project, match_type, match_id)`,
	]);
	const matched = (await sql`
		SELECT uuid, project, match_type, match_id, amount, payment_transaction, matched_at, created FROM bank_transactions
		WHERE status = 'matched' AND match_type IS NOT NULL AND match_id IS NOT NULL
	`) as {
		uuid: string;
		project: string;
		match_type: string;
		match_id: string;
		amount: number;
		payment_transaction: string | null;
		matched_at: number | null;
		created: number;
	}[];
	for (const row of matched) {
		await sql`
			INSERT INTO bank_transaction_matches(uuid, project, bank_transaction, match_type, match_id, amount, payment_transaction, created)
			VALUES(${crypto.randomUUID()}, ${row.project}, ${row.uuid}, ${row.match_type}, ${row.match_id}, ${Math.abs(Number(row.amount))},
				${row.payment_transaction}, ${row.matched_at ?? row.created})
		`;
	}
}

export async function addExpenseDueDate(sql: SQL, dialect: Dialect) {
	await sql.unsafe(`ALTER TABLE expenses ADD COLUMN due_date ${schemaTypes(dialect).int64}`);
}
