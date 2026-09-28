import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { numericClient } from "../server/database/client";
import { databaseDialect, identifier } from "../server/database/dialect";
import { addIntegers, normalizeIntegers, safeInteger } from "../server/database/numbers";
import { createSchema } from "../server/database/schema";

async function fixture(sql: SQL) {
	const timestamp = 1_800_000_000_123;
	const amount = 4_500_000_000;
	const user = "compatibility-user";
	const project = crypto.randomUUID();
	const expense = crypto.randomUUID();
	await sql`INSERT INTO accounts(username, email, password, created, updated, accessed, admin)
		VALUES(${user}, 'compatibility@example.com', 'test', ${timestamp}, ${timestamp}, ${timestamp}, 0)`;
	await sql`INSERT INTO projects(uuid, name, apikey, apikey2, created, updated, created_by)
		VALUES(${project}, 'Compatibility', 'first-key', 'second-key', ${timestamp}, ${timestamp}, ${user})`;
	await sql`INSERT INTO expenses(uuid, project, description, category, currency, total_amount, tax_amount, deductible_tax_amount,
		expense_date, paid_at, created, updated)
		VALUES(${expense}, ${project}, 'Large expense', 'other', 'EUR', ${amount}, ${amount - 1}, ${amount - 1}, ${timestamp}, NULL, ${timestamp}, ${timestamp})`;
	const [row] = await sql`SELECT total_amount, deductible_tax_amount, expense_date, paid_at FROM expenses WHERE uuid = ${expense}`;
	expect(row).toEqual({ total_amount: amount, deductible_tax_amount: amount - 1, expense_date: timestamp, paid_at: null });
	expect(() => JSON.stringify(row)).not.toThrow();
	await expect(sql`UPDATE accounts SET admin = 2 WHERE username = ${user}`.then((rows) => rows)).rejects.toThrow();
	await sql`UPDATE accounts SET admin = 1 WHERE username = ${user}`;
	const [account] = await sql`SELECT admin, created FROM accounts WHERE username = ${user}`;
	expect(account).toEqual({ admin: 1, created: timestamp });
	const [total] = await sql`SELECT SUM(total_amount) AS amount FROM expenses WHERE project = ${project}`;
	expect(safeInteger(total.amount)).toBe(amount);
	const item = crypto.randomUUID();
	const rate = 19.123456789;
	await sql`INSERT INTO catalog_items(uuid, project, name, unit_price, currency, tax_rate, created, updated)
		VALUES(${item}, ${project}, 'Precision', ${amount}, 'EUR', ${rate}, ${timestamp}, ${timestamp})`;
	const [precision] = await sql`SELECT tax_rate FROM catalog_items WHERE uuid = ${item}`;
	expect(precision.tax_rate).toBeCloseTo(rate, 9);
	return { user, project, timestamp, amount };
}

describe("database integer handling", () => {
	test("detects engines and requires an explicit YugabyteDB selection", () => {
		expect(databaseDialect("sqlite://:memory:")).toBe("sqlite");
		expect(databaseDialect("mysql://localhost/test")).toBe("mysql");
		expect(databaseDialect("mysql2://localhost/test")).toBe("mysql");
		expect(databaseDialect("postgresql://localhost/test")).toBe("postgres");
		expect(databaseDialect("postgres://localhost/test", "yugabyte")).toBe("yugabyte");
		expect(() => databaseDialect("sqlite://:memory:", "postgres")).toThrow();
		expect(() => identifier("table; DROP TABLE accounts", "mysql")).toThrow();
	});

	test("accepts exact integers and rejects unsafe or fractional values", () => {
		for (const value of [Number.MAX_SAFE_INTEGER, BigInt(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER), `${Number.MAX_SAFE_INTEGER}.000`]) {
			expect(safeInteger(value)).toBe(Number.MAX_SAFE_INTEGER);
		}
		expect(safeInteger(String(Number.MIN_SAFE_INTEGER))).toBe(Number.MIN_SAFE_INTEGER);
		for (const value of ["9007199254740992", "9007199254740993", "-9007199254740992", 1.5, "1.5", null, "", "1e3", Infinity]) {
			expect(() => safeInteger(value)).toThrow();
		}
		expect(addIntegers(Number.MAX_SAFE_INTEGER, 1, -1)).toBe(Number.MAX_SAFE_INTEGER);
		expect(() => addIntegers(Number.MAX_SAFE_INTEGER, 1)).toThrow();
	});

	test("normalizes integers without converting numeric text or binary data", () => {
		const rows: Record<string, unknown>[] = [{ created: 1_800_000_000_123n, phone: "123456789", value: "42", nullable: null, binary: new Uint8Array([1]) }];
		expect(normalizeIntegers(rows)[0]).toEqual({ created: 1_800_000_000_123, phone: "123456789", value: "42", nullable: null, binary: new Uint8Array([1]) });
		expect(() => normalizeIntegers([{ amount: 9_007_199_254_740_993n }])).toThrow();
		const changed = Object.assign([], { count: 0, affectedRows: 1 });
		expect(normalizeIntegers(changed).count).toBe(1);
		expect(normalizeIntegers({ affectedRows: 1n }) as Record<string, unknown>).toEqual({ affectedRows: 1n, count: 1 });
	});
});

describe("SQLite compatibility", () => {
	test("a fresh schema preserves large timestamps, money and precision", async () => {
		const sql = numericClient(new SQL("sqlite://:memory:", { safeIntegers: true }));
		try {
			await sql`PRAGMA foreign_keys = ON`;
			await createSchema(sql, "sqlite");
			await fixture(sql);
			const rows = await sql`PRAGMA foreign_key_check`;
			expect(rows).toHaveLength(0);
		} finally {
			await sql.close();
		}
	});

	test("normalizes transactions, fragments, unsafe queries and array results", async () => {
		const sql = numericClient(new SQL("sqlite://:memory:", { safeIntegers: true }));
		try {
			const clause = sql`WHERE 1 = 1`;
			expect((await sql`SELECT 1800000000123 AS created ${clause}`)[0].created).toBe(1_800_000_000_123);
			expect(await sql.unsafe("SELECT 1800000000123").values()).toEqual([[1_800_000_000_123]]);
			expect((await sql.begin(async (tx) => await tx`SELECT 1800000000123 AS created`))[0].created).toBe(1_800_000_000_123);
			await expect(sql`SELECT 9007199254740993 AS amount`.then((rows) => rows)).rejects.toThrow("safe integer range");
		} finally {
			await sql.close();
		}
	});
});

for (const engine of ["mysql", "postgres", "yugabyte"] as const) {
	const url = Bun.env[`RABBITPAY_TEST_${engine.toUpperCase()}_DB`];
	test.skipIf(!url)(
		`${engine} schema and integer compatibility`,
		async () => {
			const pool = new SQL(url!, { bigint: true });
			const reserved = await pool.reserve();
			const sql = numericClient(reserved);
			const name = `rabbitpay_test_${crypto.randomUUID().replaceAll("-", "")}`;
			let created = false;
			try {
				if (engine === "mysql") {
					await sql.unsafe(`CREATE DATABASE ${identifier(name, engine)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
					created = true;
					await sql.unsafe(`USE ${identifier(name, engine)}`);
				} else {
					await sql.unsafe(`CREATE SCHEMA ${identifier(name, engine)}`);
					created = true;
					await sql.unsafe(`SET search_path TO ${identifier(name, engine)}`);
				}
				await createSchema(sql, engine);
				await fixture(sql);
			} finally {
				if (created) await sql.unsafe(engine === "mysql" ? `DROP DATABASE ${identifier(name, engine)}` : `DROP SCHEMA ${identifier(name, engine)} CASCADE`);
				reserved.release();
				await pool.close();
			}
		},
		120_000
	);
}
