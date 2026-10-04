import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { numericClient } from "../server/database/client";
import { MIGRATIONS, SchemaTooNew, appliedVersions, migrate, validateMigrations, type Migration } from "../server/database/migrations";

function memory(): SQL {
	return numericClient(new SQL("sqlite://:memory:", { safeIntegers: true }));
}

async function columns(sql: SQL, table: string): Promise<string[]> {
	const rows = (await sql.unsafe(`PRAGMA table_info(${table})`)) as { name: string }[];
	return rows.map((row) => row.name);
}

describe("schema migrations", () => {
	test("a fresh database runs every migration once", async () => {
		const sql = memory();
		expect(await migrate(sql, "sqlite")).toEqual(MIGRATIONS.map((migration) => migration.version));
		expect(await migrate(sql, "sqlite")).toEqual([]);
		expect(await appliedVersions(sql)).toEqual(MIGRATIONS.map((migration) => migration.version));
		expect(await columns(sql, "accounts")).toContain("username");
		expect(await columns(sql, "timesheet_periods")).toEqual(
			expect.arrayContaining(["project", "member", "period", "status", "submitted_by", "submitted_at", "decided_by", "decided_at"])
		);
		await sql.close();
	});

	test("a database created before migrations adopts the baseline without losing rows", async () => {
		const sql = memory();
		await MIGRATIONS[0].up(sql, "sqlite");
		await sql`INSERT INTO accounts(username, email, password, created, updated, accessed, admin) VALUES('legacy', 'legacy@example.com', 'x', 1, 1, 1, 0)`;

		expect(await migrate(sql, "sqlite")).toEqual(MIGRATIONS.map((migration) => migration.version));
		const [row] = await sql`SELECT username FROM accounts`;
		expect(row.username).toBe("legacy");
		await sql.close();
	});

	test("the query indexes replace the ones they cover", async () => {
		const sql = memory();
		await migrate(sql, "sqlite");
		const names = ((await sql`SELECT name FROM sqlite_master WHERE type = 'index'`) as { name: string }[]).map((row) => row.name);
		for (const added of [
			"idx_item_keys_reserved",
			"idx_invoices_status_due",
			"idx_invoices_created",
			"idx_tx_unbilled",
			"idx_tx_processor_id",
			"idx_tx_project_created",
			"idx_session_external",
			"idx_session_invoice",
			"idx_customers_created",
			"idx_webhook_deliveries_created",
			"idx_tickets_updated",
		]) {
			expect(names).toContain(added);
		}
		for (const replaced of ["idx_invoices_status", "idx_tx_license_billing", "idx_tx_processor"]) expect(names).not.toContain(replaced);

		const plan = (query: string) => sql.unsafe(`EXPLAIN QUERY PLAN ${query}`).then((rows: { detail: string }[]) => rows.map((row) => row.detail).join(" | "));
		expect(await plan("SELECT uuid FROM invoices WHERE status = 'open' AND due_date < 1 ORDER BY due_date ASC LIMIT 100")).toBe(
			"SEARCH invoices USING INDEX idx_invoices_status_due (status=? AND due_date<?)"
		);
		expect(await plan("SELECT DISTINCT project FROM transactions WHERE type = 'payment' AND license_billing IS NULL LIMIT 1000")).toContain("idx_tx_unbilled");
		expect(await plan("SELECT * FROM payment_sessions WHERE processor = 'stripe' AND processor_session_id = 's'")).toContain("idx_session_external");
		await sql.close();
	});

	test("later migrations only run on databases that have not seen them", async () => {
		const sql = memory();
		await migrate(sql, "sqlite");

		const next: Migration = {
			version: MIGRATIONS.length + 1,
			name: "add nickname",
			up: async (tx) => {
				await tx.unsafe("ALTER TABLE accounts ADD COLUMN nickname TEXT");
			},
		};
		expect(await migrate(sql, "sqlite", [...MIGRATIONS, next])).toEqual([next.version]);
		expect(await columns(sql, "accounts")).toContain("nickname");
		expect(await migrate(sql, "sqlite", [...MIGRATIONS, next])).toEqual([]);
		await sql.close();
	});

	test("a failing migration is rolled back and not recorded", async () => {
		const sql = memory();
		await migrate(sql, "sqlite");

		const broken: Migration = {
			version: MIGRATIONS.length + 1,
			name: "broken",
			up: async (tx) => {
				await tx.unsafe("CREATE TABLE half_done(id INTEGER)");
				await tx.unsafe("ALTER TABLE missing_table ADD COLUMN nope TEXT");
			},
		};
		await expect(migrate(sql, "sqlite", [...MIGRATIONS, broken])).rejects.toThrow();
		expect(await appliedVersions(sql)).toEqual(MIGRATIONS.map((migration) => migration.version));
		const tables = await sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half_done'`;
		expect(tables).toHaveLength(0);
		await sql.close();
	});

	test("refuses to start an older server on a newer schema", async () => {
		const sql = memory();
		const future: Migration = { version: MIGRATIONS.length + 1, name: "future", up: async () => {} };
		await migrate(sql, "sqlite", [...MIGRATIONS, future]);
		await expect(migrate(sql, "sqlite")).rejects.toBeInstanceOf(SchemaTooNew);
		await sql.close();
	});

	test("the workforce migration adds roles and license types without losing members or signatures", async () => {
		const sql = memory();
		await sql`PRAGMA foreign_keys = ON`;
		const workforce = MIGRATIONS.findIndex((migration) => migration.name === "workforce");
		await migrate(sql, "sqlite", MIGRATIONS.slice(0, workforce));
		await sql`INSERT INTO accounts(username, email, password, created, updated, accessed) VALUES('ana', 'ana@example.com', 'x', 1, 1, 1)`;
		await sql`INSERT INTO projects(uuid, name, apikey, apikey2, currency, created, updated, created_by) VALUES('p', 'shop', 'k1', 'k2', 'EUR', 1, 1, 'ana')`;
		await sql`INSERT INTO project_members(uuid, project_id, account_username, role, created, updated) VALUES('m', 'p', 'ana', 'owner', 1, 1)`;
		await sql`INSERT INTO signature_assets(signature_hash, data, created) VALUES('h', 'd', 1)`;
		await sql`INSERT INTO project_member_signature_versions(uuid, member, signature_hash, valid_from) VALUES('s', 'm', 'h', 1)`;
		await sql`INSERT INTO license_keys(uuid, code, type, duration_days, status, created, updated) VALUES('l', 'RPAY-1', 'store', 30, 'available', 1, 1)`;

		await migrate(sql, "sqlite");

		const [signature] = await sql`SELECT member FROM project_member_signature_versions WHERE uuid = 's'`;
		expect(signature.member).toBe("m");
		const [license] = await sql`SELECT type FROM license_keys WHERE uuid = 'l'`;
		expect(license.type).toBe("store");
		await sql`INSERT INTO project_members(uuid, project_id, role, created, updated) VALUES('e', 'p', 'employee', 1, 1)`;
		await sql`INSERT INTO license_keys(uuid, code, type, duration_days, status, created, updated) VALUES('w', 'RPAY-2', 'workforce', 30, 'available', 1, 1)`;
		const invalidRole = async () => await sql`INSERT INTO project_members(uuid, project_id, role, created, updated) VALUES('x', 'p', 'boss', 1, 1)`;
		await expect(invalidRole()).rejects.toThrow();
		const indexes = await sql`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'project_members' AND sql IS NOT NULL`;
		expect(indexes.map((row: { name: string }) => row.name).sort()).toEqual([
			"idx_project_members_account",
			"idx_project_members_project",
			"idx_project_members_status",
			"idx_project_members_token",
		]);
		expect(await sql`PRAGMA foreign_key_check`).toHaveLength(0);
		await sql.close();
	});

	test("customers can lose their email without their invoices and tickets losing the customer", async () => {
		const sql = memory();
		await sql`PRAGMA foreign_keys = ON`;
		const optional = MIGRATIONS.findIndex((migration) => migration.name === "customers without an email address");
		await migrate(sql, "sqlite", MIGRATIONS.slice(0, optional));
		await sql`INSERT INTO accounts(username, email, password, created, updated, accessed) VALUES('ana', 'ana@example.com', 'x', 1, 1, 1)`;
		await sql`INSERT INTO projects(uuid, name, apikey, apikey2, currency, created, updated, created_by) VALUES('p', 'shop', 'k1', 'k2', 'EUR', 1, 1, 'ana')`;
		await sql`INSERT INTO customers(uuid, project, name, email, registration_number, created, updated) VALUES('c', 'p', 'Acme', 'acme@example.com', '1234567000', 1, 1)`;
		await sql`
			INSERT INTO invoices(uuid, project, customer, reference, status, currency, subtotal, discount_amount, tax_amount, total_amount, paid_amount,
				refunded_amount, due_date, created, updated)
			VALUES('i', 'p', 'c', 'R-1', 'draft', 'EUR', 100, 0, 0, 100, 0, 0, 1, 1, 1)
		`;
		await sql`INSERT INTO ticket_portal_access(customer, project, kinds, updated) VALUES('c', 'p', 'support', 1)`;
		const missingEmail = async () => await sql`INSERT INTO customers(uuid, project, name, created, updated) VALUES('x', 'p', 'Nobody', 1, 1)`;
		await expect(missingEmail()).rejects.toThrow();

		expect(await migrate(sql, "sqlite")).toContain(MIGRATIONS[optional].version);

		const [invoice] = await sql`SELECT customer FROM invoices WHERE uuid = 'i'`;
		expect(invoice.customer).toBe("c");
		expect(await sql`SELECT customer FROM ticket_portal_access`).toHaveLength(1);
		const [kept] = await sql`SELECT name, email, registration_number FROM customers WHERE uuid = 'c'`;
		expect(kept).toMatchObject({ name: "Acme", email: "acme@example.com", registration_number: "1234567000" });

		await sql`INSERT INTO customers(uuid, project, name, created, updated) VALUES('n1', 'p', 'No email', 1, 1)`;
		await sql`INSERT INTO customers(uuid, project, name, created, updated) VALUES('n2', 'p', 'No email either', 1, 1)`;
		const duplicate = async () =>
			await sql`INSERT INTO customers(uuid, project, name, email, created, updated) VALUES('d', 'p', 'Copy', 'acme@example.com', 1, 1)`;
		await expect(duplicate()).rejects.toThrow();

		const indexes = await sql`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'customers' AND sql IS NOT NULL`;
		expect(indexes.map((row: { name: string }) => row.name)).toEqual(expect.arrayContaining(["idx_customers_project", "idx_customers_email"]));
		const [enforced] = await sql`PRAGMA foreign_keys`;
		expect(Number(enforced.foreign_keys)).toBe(1);
		expect(await sql`PRAGMA foreign_key_check`).toHaveLength(0);
		await sql`DELETE FROM customers WHERE uuid = 'c'`;
		expect((await sql`SELECT customer FROM invoices WHERE uuid = 'i'`)[0].customer).toBeNull();
		await sql.close();
	});

	test("store domains saved before verification stay active", async () => {
		const sql = memory();
		const domains = MIGRATIONS.findIndex((migration) => migration.name === "store domains");
		await migrate(sql, "sqlite", MIGRATIONS.slice(0, domains));
		await sql`INSERT INTO accounts(username, email, password, created, updated, accessed) VALUES('ana', 'ana@example.com', 'x', 1, 1, 1)`;
		for (const [uuid, name] of [
			["p", "shop"],
			["q", "other"],
		]) {
			await sql`INSERT INTO projects(uuid, name, apikey, apikey2, currency, created, updated, created_by) VALUES(${uuid}, ${name}, ${`${uuid}1`}, ${`${uuid}2`}, 'EUR', 1, 1, 'ana')`;
		}
		await sql`INSERT INTO store_settings(project, slug, domain, enabled, config, created, updated) VALUES('p', 'shop', 'shop.example.com', 1, '{}', 1, 7)`;
		await sql`INSERT INTO store_settings(project, slug, domain, enabled, config, created, updated) VALUES('q', 'other', NULL, 1, '{}', 1, 1)`;

		await migrate(sql, "sqlite");

		const rows = (await sql`SELECT project, hostname, provider, status, activated FROM store_domains`) as Record<string, unknown>[];
		expect([...rows]).toEqual([{ project: "p", hostname: "shop.example.com", provider: "manual", status: "active", activated: 7 }]);
		await sql.close();
	});

	test("versions must be consecutive", () => {
		expect(() => validateMigrations([{ version: 2, name: "skipped", up: async () => {} }])).toThrow();
		expect(() => validateMigrations(MIGRATIONS)).not.toThrow();
	});
});
