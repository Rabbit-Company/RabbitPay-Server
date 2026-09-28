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

	test("versions must be consecutive", () => {
		expect(() => validateMigrations([{ version: 2, name: "skipped", up: async () => {} }])).toThrow();
		expect(() => validateMigrations(MIGRATIONS)).not.toThrow();
	});
});
