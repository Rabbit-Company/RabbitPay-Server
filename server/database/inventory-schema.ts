import type { SQL } from "bun";
import type { Dialect } from "./dialect";
import { run } from "./schema";
import { schemaTypes } from "./schema-types";
import { replaceCheck } from "./workforce-schema";

export const LICENSE_TYPES_BEFORE_INVENTORY =
	"CHECK (type IN ('transactions', 'white_label', 'storage', 'store', 'workforce', 'employees', 'accounting', 'emails', 'files'))";
export const LICENSE_TYPES_WITH_INVENTORY =
	"CHECK (type IN ('transactions', 'white_label', 'storage', 'store', 'workforce', 'employees', 'accounting', 'emails', 'files', 'inventory'))";

const JOURNAL_SOURCES_BEFORE =
	"CHECK (source_type IN ('invoice', 'credit_note', 'payment', 'refund', 'expense', 'expense_payment', 'recorded_invoice', 'recorded_payment', 'bank_transaction', 'depreciation', 'asset_disposal', 'payroll', 'deductible_share', 'year_result', 'year_closing', 'year_opening', 'manual'))";
const JOURNAL_SOURCES_WITH_STOCK =
	"CHECK (source_type IN ('invoice', 'credit_note', 'payment', 'refund', 'expense', 'expense_payment', 'recorded_invoice', 'recorded_payment', 'bank_transaction', 'depreciation', 'asset_disposal', 'payroll', 'deductible_share', 'year_result', 'year_closing', 'year_opening', 'manual', 'stock_document', 'stock_sale', 'stock_return'))";

export async function createInventorySchema(sql: SQL, dialect: Dialect) {
	const types = schemaTypes(dialect);
	await replaceCheck(sql, dialect, "license_keys", "white_label", "license_keys_type_check", LICENSE_TYPES_BEFORE_INVENTORY, LICENSE_TYPES_WITH_INVENTORY);
	await replaceCheck(sql, dialect, "journal_entries", "year_opening", "journal_entries_source_type_check", JOURNAL_SOURCES_BEFORE, JOURNAL_SOURCES_WITH_STOCK);
	await sql.unsafe(`ALTER TABLE projects ADD COLUMN inventory_until ${types.int64}`);
	await sql.unsafe(
		`ALTER TABLE catalog_items ADD COLUMN stock_kind ${types.text("stock_kind")} CHECK (stock_kind IS NULL OR stock_kind IN ('goods', 'material'))`
	);
	await sql.unsafe(`ALTER TABLE catalog_items ADD COLUMN stock_since ${types.int64}`);
	await sql.unsafe(`ALTER TABLE catalog_items ADD COLUMN stock_minimum ${types.int64}`);
	await sql.unsafe(
		`ALTER TABLE expenses ADD COLUMN stock_purchase ${types.text("stock_purchase")} CHECK (stock_purchase IS NULL OR stock_purchase IN ('goods', 'material', 'goods_costs', 'material_costs'))`
	);
	await run(sql, dialect, [
		`CREATE TABLE IF NOT EXISTS inventory_settings(
			project ${types.text("project")} PRIMARY KEY,
			config ${types.text("config")} NOT NULL,
			updated ${types.int64} NOT NULL,
			FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE
		)`,
		`CREATE TABLE IF NOT EXISTS warehouses(
			uuid ${types.text("uuid")} PRIMARY KEY,
			project ${types.text("project")} NOT NULL,
			name ${types.text("store_name")} NOT NULL,
			code ${types.text("warehouse_code")} NOT NULL,
			address ${types.text("address")},
			is_default ${types.flag} NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
			archived ${types.flag} NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
			created ${types.int64} NOT NULL,
			updated ${types.int64} NOT NULL,
			FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
			UNIQUE(project, code)
		)`,
		`CREATE TABLE IF NOT EXISTS stock_documents(
			uuid ${types.text("uuid")} PRIMARY KEY,
			project ${types.text("project")} NOT NULL,
			document_type ${types.text("document_type")} NOT NULL,
			status ${types.text("status")} NOT NULL DEFAULT 'draft',
			year INTEGER,
			sequence_number INTEGER,
			number ${types.text("number")},
			warehouse ${types.text("warehouse")} NOT NULL,
			target_warehouse ${types.text("target_warehouse")},
			document_date ${types.int64} NOT NULL,
			reason ${types.text("kind")},
			partner ${types.text("partner_name")},
			partner_tax_number ${types.text("partner_tax_number")},
			external_reference ${types.text("external_reference")},
			expense ${types.text("expense")},
			invoice ${types.text("invoice")},
			extra_costs ${types.int64} NOT NULL DEFAULT 0,
			charge_vat ${types.flag} NOT NULL DEFAULT 0 CHECK (charge_vat IN (0, 1)),
			opening_offset ${types.text("opening_offset")},
			ledger_account ${types.text("ledger_account")},
			notes ${types.text("notes")},
			created_by ${types.text("created_by")},
			posted_by ${types.text("posted_by")},
			posted_at ${types.int64},
			canceled_by ${types.text("canceled_by")},
			canceled_at ${types.int64},
			cancel_reason ${types.text("cancel_reason")},
			created ${types.int64} NOT NULL,
			updated ${types.int64} NOT NULL,
			FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
			FOREIGN KEY (warehouse) REFERENCES warehouses(uuid),
			FOREIGN KEY (target_warehouse) REFERENCES warehouses(uuid),
			FOREIGN KEY (expense) REFERENCES expenses(uuid) ON DELETE SET NULL,
			FOREIGN KEY (invoice) REFERENCES invoices(uuid) ON DELETE SET NULL,
			FOREIGN KEY (ledger_account) REFERENCES ledger_accounts(uuid),
			UNIQUE(project, number),
			CHECK (document_type IN ('receipt', 'issue', 'transfer', 'stocktake', 'opening')),
			CHECK (status IN ('draft', 'posted', 'canceled')),
			CHECK (extra_costs >= 0),
			CHECK (opening_offset IS NULL OR opening_offset IN ('none', 'expense'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_stock_documents_project ON stock_documents(project, document_date)`,
		`CREATE INDEX IF NOT EXISTS idx_stock_documents_type ON stock_documents(project, document_type, year, sequence_number)`,
		`CREATE INDEX IF NOT EXISTS idx_stock_documents_expense ON stock_documents(expense)`,
		`CREATE TABLE IF NOT EXISTS stock_document_lines(
			uuid ${types.text("uuid")} PRIMARY KEY,
			document ${types.text("document")} NOT NULL,
			project ${types.text("project")} NOT NULL,
			item ${types.text("item")} NOT NULL,
			quantity ${types.int64} NOT NULL,
			value ${types.int64},
			expected_quantity ${types.int64},
			tax_rate ${types.float},
			note ${types.text("note")},
			sort_order INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (document) REFERENCES stock_documents(uuid) ON DELETE CASCADE,
			FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
			FOREIGN KEY (item) REFERENCES catalog_items(uuid),
			CHECK (quantity >= 0),
			CHECK (value IS NULL OR value >= 0)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_stock_document_lines_document ON stock_document_lines(document, sort_order)`,
		`CREATE INDEX IF NOT EXISTS idx_stock_document_lines_item ON stock_document_lines(item)`,
		`CREATE TABLE IF NOT EXISTS stock_movements(
			uuid ${types.text("uuid")} PRIMARY KEY,
			project ${types.text("project")} NOT NULL,
			item ${types.text("item")} NOT NULL,
			warehouse ${types.text("warehouse")} NOT NULL,
			movement_date ${types.int64} NOT NULL,
			sequence ${types.int64} NOT NULL,
			movement_kind ${types.text("movement_kind")} NOT NULL,
			quantity ${types.int64} NOT NULL,
			entered_value ${types.int64},
			cost_source ${types.text("cost_source")},
			value ${types.int64} NOT NULL DEFAULT 0,
			correction ${types.int64} NOT NULL DEFAULT 0,
			document ${types.text("document")},
			document_line ${types.text("document_line")},
			invoice ${types.text("invoice")},
			invoice_item ${types.text("invoice_item")},
			created ${types.int64} NOT NULL,
			FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
			FOREIGN KEY (item) REFERENCES catalog_items(uuid),
			FOREIGN KEY (warehouse) REFERENCES warehouses(uuid),
			FOREIGN KEY (document) REFERENCES stock_documents(uuid) ON DELETE CASCADE,
			FOREIGN KEY (invoice) REFERENCES invoices(uuid) ON DELETE SET NULL,
			UNIQUE(project, sequence),
			CHECK (movement_kind IN ('receipt', 'opening', 'customer_return', 'sale', 'sale_return', 'issue', 'transfer_out', 'transfer_in', 'surplus', 'shortage')),
			CHECK (quantity <> 0)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(item, movement_date, sequence)`,
		`CREATE INDEX IF NOT EXISTS idx_stock_movements_document ON stock_movements(document)`,
		`CREATE INDEX IF NOT EXISTS idx_stock_movements_invoice ON stock_movements(invoice)`,
		`CREATE INDEX IF NOT EXISTS idx_stock_movements_invoice_item ON stock_movements(invoice_item, movement_kind)`,
		`CREATE INDEX IF NOT EXISTS idx_stock_movements_project ON stock_movements(project, movement_date, sequence)`,
		`CREATE TABLE IF NOT EXISTS stock_levels(
			item ${types.text("item")} NOT NULL,
			warehouse ${types.text("warehouse")} NOT NULL,
			project ${types.text("project")} NOT NULL,
			quantity ${types.int64} NOT NULL DEFAULT 0,
			value ${types.int64} NOT NULL DEFAULT 0,
			state ${types.text("state")} NOT NULL,
			updated ${types.int64} NOT NULL,
			PRIMARY KEY (item, warehouse),
			FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
			FOREIGN KEY (item) REFERENCES catalog_items(uuid) ON DELETE CASCADE,
			FOREIGN KEY (warehouse) REFERENCES warehouses(uuid) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_stock_levels_project ON stock_levels(project)`,
	]);
}
