import type { SQL } from "bun";
import type { Dialect } from "./dialect";
import { run } from "./schema";
import { schemaTypes } from "./schema-types";

export async function addDunningNumbering(sql: SQL, dialect: Dialect) {
	const types = schemaTypes(dialect);
	await sql.unsafe(`ALTER TABLE projects ADD COLUMN dunning_format ${types.text("dunning_format")}`);
	await run(sql, dialect, [`CREATE UNIQUE INDEX IF NOT EXISTS idx_dunning_letters_number ON dunning_letters(project, number)`]);
}

export async function createDunningSchema(sql: SQL, dialect: Dialect) {
	const types = schemaTypes(dialect);
	await run(sql, dialect, [
		`CREATE TABLE IF NOT EXISTS dunning_letters(
			uuid ${types.text("uuid")} PRIMARY KEY,
			project ${types.text("project")} NOT NULL,
			customer ${types.text("customer")},
			level INTEGER NOT NULL,
			year INTEGER NOT NULL,
			sequence_number INTEGER NOT NULL,
			number ${types.text("number")} NOT NULL,
			language ${types.text("language")} NOT NULL,
			currency ${types.text("currency")} NOT NULL,
			issue_date ${types.text("issue_date")} NOT NULL,
			deadline_date ${types.text("deadline_date")} NOT NULL,
			principal ${types.int64} NOT NULL,
			interest ${types.int64} NOT NULL,
			compensation ${types.int64} NOT NULL,
			total_amount ${types.int64} NOT NULL,
			interest_included ${types.flag} NOT NULL DEFAULT 0,
			compensation_included ${types.flag} NOT NULL DEFAULT 0,
			note ${types.text("notes")},
			buyer_details ${types.text("buyer_details")} NOT NULL,
			document ${types.text("document_snapshot")} NOT NULL,
			created_by ${types.text("created_by")},
			created ${types.int64} NOT NULL,
			updated ${types.int64} NOT NULL,
			FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
			FOREIGN KEY (customer) REFERENCES customers(uuid) ON DELETE SET NULL,
			FOREIGN KEY (created_by) REFERENCES accounts(username) ON DELETE SET NULL,
			UNIQUE(project, year, sequence_number),
			CHECK (level IN (1, 2, 3)),
			CHECK (interest_included IN (0, 1)),
			CHECK (compensation_included IN (0, 1))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_dunning_letters_project ON dunning_letters(project, issue_date)`,
		`CREATE INDEX IF NOT EXISTS idx_dunning_letters_customer ON dunning_letters(customer)`,
		`CREATE TABLE IF NOT EXISTS dunning_letter_lines(
			uuid ${types.text("uuid")} PRIMARY KEY,
			dunning_letter ${types.text("dunning_letter")} NOT NULL,
			invoice ${types.text("invoice")},
			recorded_invoice ${types.text("recorded_invoice")},
			reference ${types.text("reference")} NOT NULL,
			issue_date ${types.text("issue_date")},
			due_on ${types.text("due_on")} NOT NULL,
			amount ${types.int64} NOT NULL,
			open_amount ${types.int64} NOT NULL,
			days_overdue INTEGER NOT NULL,
			interest ${types.int64} NOT NULL,
			compensation ${types.int64} NOT NULL,
			sort_order INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (dunning_letter) REFERENCES dunning_letters(uuid) ON DELETE CASCADE,
			FOREIGN KEY (invoice) REFERENCES invoices(uuid) ON DELETE SET NULL,
			FOREIGN KEY (recorded_invoice) REFERENCES recorded_invoices(uuid) ON DELETE SET NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_dunning_letter_lines_letter ON dunning_letter_lines(dunning_letter)`,
		`CREATE INDEX IF NOT EXISTS idx_dunning_letter_lines_invoice ON dunning_letter_lines(invoice)`,
	]);
	await sql.unsafe(`ALTER TABLE email_messages ADD COLUMN dunning_letter ${types.text("dunning_letter")}`);
}
