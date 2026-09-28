export type Dialect = "sqlite" | "mysql" | "postgres" | "yugabyte";

export function databaseDialect(url: string, engine?: string): Dialect {
	let dialect: Dialect;
	if (url.startsWith("mysql://") || url.startsWith("mysql2://")) dialect = "mysql";
	else if (url.startsWith("postgres://") || url.startsWith("postgresql://")) dialect = "postgres";
	else if (url.startsWith("sqlite:") || url.startsWith("file://") || url.endsWith(".sqlite") || url.endsWith(".db") || url === ":memory:") dialect = "sqlite";
	else throw new Error("Unsupported database connection string");
	if (!engine) return dialect;
	if (engine === dialect || (engine === "yugabyte" && dialect === "postgres")) return engine as Dialect;
	throw new Error("RABBITPAY_DB_ENGINE does not match the database connection string");
}

export function identifier(name: string, dialect: Dialect): string {
	if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("Invalid database identifier");
	return dialect === "mysql" ? `\`${name}\`` : `"${name}"`;
}
