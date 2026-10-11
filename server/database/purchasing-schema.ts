import type { SQL } from "bun";
import type { Dialect } from "./dialect";
import { run } from "./schema";
import { schemaTypes } from "./schema-types";

export async function createPurchasingSchema(sql: SQL, dialect: Dialect) {
	const types = schemaTypes(dialect);
	await sql.unsafe(`ALTER TABLE expenses ADD COLUMN payee_iban ${types.text("iban")}`);
	await sql.unsafe(`ALTER TABLE expenses ADD COLUMN payee_reference ${types.text("reference")}`);
	await sql.unsafe(`ALTER TABLE expenses ADD COLUMN payment_ordered_at ${types.int64}`);
	await run(sql, dialect, [
		`CREATE TABLE IF NOT EXISTS suppliers(
			uuid ${types.text("uuid")} PRIMARY KEY,
			project ${types.text("project")} NOT NULL,
			name ${types.text("partner_name")} NOT NULL,
			tax_number ${types.text("partner_tax_number")},
			country ${types.text("country")},
			address_line1 ${types.text("address")},
			postal_code ${types.text("postal_code")},
			city ${types.text("city")},
			email ${types.text("email")},
			phone ${types.text("phone")},
			iban ${types.text("iban")},
			bic ${types.text("bic")},
			payment_days INTEGER,
			notes ${types.text("notes")},
			archived ${types.flag} NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
			created ${types.int64} NOT NULL,
			updated ${types.int64} NOT NULL,
			FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
			CHECK (payment_days IS NULL OR (payment_days >= 0 AND payment_days <= 365))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_suppliers_project ON suppliers(project, archived)`,
		`CREATE TABLE IF NOT EXISTS purchase_orders(
			uuid ${types.text("uuid")} PRIMARY KEY,
			project ${types.text("project")} NOT NULL,
			supplier ${types.text("supplier_id")} NOT NULL,
			status ${types.text("status")} NOT NULL DEFAULT 'draft',
			year INTEGER,
			sequence_number INTEGER,
			number ${types.text("number")},
			warehouse ${types.text("warehouse")} NOT NULL,
			order_date ${types.int64} NOT NULL,
			expected_date ${types.int64},
			supplier_reference ${types.text("external_reference")},
			notes ${types.text("notes")},
			created_by ${types.text("created_by")},
			ordered_by ${types.text("posted_by")},
			ordered_at ${types.int64},
			closed_at ${types.int64},
			created ${types.int64} NOT NULL,
			updated ${types.int64} NOT NULL,
			FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
			FOREIGN KEY (supplier) REFERENCES suppliers(uuid),
			FOREIGN KEY (warehouse) REFERENCES warehouses(uuid),
			UNIQUE(project, number),
			CHECK (status IN ('draft', 'ordered', 'received', 'canceled'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_purchase_orders_project ON purchase_orders(project, order_date)`,
		`CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier)`,
		`CREATE TABLE IF NOT EXISTS purchase_order_lines(
			uuid ${types.text("uuid")} PRIMARY KEY,
			purchase_order ${types.text("purchase_order")} NOT NULL,
			project ${types.text("project")} NOT NULL,
			item ${types.text("item")} NOT NULL,
			quantity ${types.int64} NOT NULL,
			value ${types.int64} NOT NULL DEFAULT 0,
			note ${types.text("note")},
			sort_order INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (purchase_order) REFERENCES purchase_orders(uuid) ON DELETE CASCADE,
			FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
			FOREIGN KEY (item) REFERENCES catalog_items(uuid),
			CHECK (quantity > 0 AND value >= 0)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_order ON purchase_order_lines(purchase_order, sort_order)`,
		`CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_item ON purchase_order_lines(item)`,
	]);
	await sql.unsafe(`ALTER TABLE stock_documents ADD COLUMN purchase_order ${types.text("purchase_order")}`);
	await sql.unsafe(`ALTER TABLE stock_document_lines ADD COLUMN order_line ${types.text("order_line")}`);
	await run(sql, dialect, [`CREATE INDEX IF NOT EXISTS idx_stock_documents_order ON stock_documents(purchase_order)`]);
}
