import type { SQL } from "bun";
import type { Dialect } from "./dialect";
import { run } from "./schema";
import { schemaTypes } from "./schema-types";

export async function createRegistrySchema(sql: SQL, dialect: Dialect) {
	const types = schemaTypes(dialect);
	await run(sql, dialect, [
		`CREATE TABLE IF NOT EXISTS company_registry(
					tax_number ${types.text("registry_tax_number")} PRIMARY KEY,
					registration_number ${types.text("registry_registration_number")},
					vat_registered ${types.flag} NOT NULL DEFAULT 0 CHECK (vat_registered IN (0, 1)),
					kind ${types.text("kind")} NOT NULL,
					name ${types.text("name")} NOT NULL,
					street ${types.text("address_line1")},
					postal_code ${types.text("postal_code")},
					city ${types.text("city")},
					country ${types.text("country")},
					activity ${types.text("activity")},
					search ${types.text("search")} NOT NULL,
					updated ${types.int64} NOT NULL,
					CHECK (kind IN ('company', 'sole_trader'))
				)`,
		`CREATE INDEX IF NOT EXISTS idx_company_registry_registration ON company_registry(registration_number)`,
	]);
}
