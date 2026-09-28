import type { SQL } from "bun";
import type { Dialect } from "./dialect";
import { schemaTypes } from "./schema-types";
import { createSchema, run } from "./schema";
import { addStoreOrderNumbers, createLicenseProductSchema, createStoreCouponSchema, createStoreSchema } from "./store-schema";
import {
	addEmployeeSeats,
	addEmployeeWorkforceSettings,
	addPriorService,
	allowBreakEntries,
	createPayrollSchema,
	createWorkforceSchema,
} from "./workforce-schema";
import { DEFAULT_EMAIL_DESIGN } from "../email-design";

export interface Migration {
	version: number;
	name: string;
	up(sql: SQL, dialect: Dialect): Promise<void>;
}

export const MIGRATIONS: Migration[] = [
	{ version: 1, name: "baseline", up: createSchema },
	{
		version: 2,
		name: "fiscal alerts",
		up: async (sql, dialect) => {
			await sql.unsafe(`ALTER TABLE fiscal_documents ADD COLUMN alerted ${schemaTypes(dialect).text("alerted")}`);
		},
	},
	{
		version: 3,
		name: "archived verified copies",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await sql.unsafe(`ALTER TABLE fiscal_documents ADD COLUMN archive_key ${types.text("archive_key")}`);
			await sql.unsafe(`ALTER TABLE fiscal_documents ADD COLUMN archive_size ${types.int64}`);
			await sql.unsafe(`ALTER TABLE fiscal_documents ADD COLUMN archive_sha256 ${types.text("archive_sha256")}`);
		},
	},
	{ version: 4, name: "online store", up: createStoreSchema },
	{
		version: 5,
		name: "order email kinds",
		up: async (sql) => {
			await sql`UPDATE email_messages SET kind = 'order_shipped' WHERE kind = 'order_update' AND (subject LIKE '%on its way%' OR subject LIKE '%je na poti%')`;
			await sql`UPDATE email_messages SET kind = 'order_delivered' WHERE kind = 'order_update' AND (subject LIKE '%was delivered%' OR subject LIKE '%je dostavljeno%')`;
			await sql`UPDATE email_messages SET kind = 'order_processing' WHERE kind = 'order_update' AND (subject LIKE '%is preparing%' OR subject LIKE '%pripravlja%')`;
		},
	},
	{
		version: 6,
		name: "invoice design",
		up: async (sql, dialect) => {
			await sql.unsafe(`ALTER TABLE projects ADD COLUMN invoice_design ${schemaTypes(dialect).text("invoice_design")}`);
			await sql.unsafe("DROP TABLE IF EXISTS invoice_templates");
		},
	},
	{
		version: 7,
		name: "email design",
		up: async (sql, dialect) => {
			await sql.unsafe(`ALTER TABLE projects ADD COLUMN email_design ${schemaTypes(dialect).text("email_design")}`);
			const rows = (await sql`SELECT uuid, invoice_design FROM projects WHERE invoice_design IS NOT NULL`) as { uuid: string; invoice_design: string }[];
			for (const row of rows) {
				let stored: { email?: { invoice_subject?: unknown; invoice_intro?: unknown } };
				try {
					stored = JSON.parse(row.invoice_design);
				} catch {
					continue;
				}
				const subject = typeof stored.email?.invoice_subject === "string" ? stored.email.invoice_subject : null;
				const intro = typeof stored.email?.invoice_intro === "string" ? stored.email.invoice_intro : null;
				if (subject === null && intro === null) continue;
				const design = {
					...DEFAULT_EMAIL_DESIGN,
					templates: { ...DEFAULT_EMAIL_DESIGN.templates, invoice: { subject, heading: null, intro, button: null, closing: null } },
				};
				await sql`UPDATE projects SET email_design = ${JSON.stringify(design)} WHERE uuid = ${row.uuid}`;
			}
		},
	},
	{
		version: 8,
		name: "e-invoice routing",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await sql.unsafe(`ALTER TABLE customers ADD COLUMN registration_number ${types.text("registration_number")}`);
			await sql.unsafe(`ALTER TABLE customers ADD COLUMN iban ${types.text("iban")}`);
			await sql.unsafe(`ALTER TABLE customers ADD COLUMN bic ${types.text("bic")}`);
			await sql.unsafe(`ALTER TABLE invoices ADD COLUMN reference_document_type ${types.text("reference_document_type")}`);
			await sql.unsafe(`ALTER TABLE invoices ADD COLUMN reference_document_number ${types.text("reference_document_number")}`);
			await sql.unsafe(`ALTER TABLE invoices ADD COLUMN reference_document_date ${types.int64}`);
		},
	},
	{
		version: 9,
		name: "e-invoice signing",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await sql.unsafe(`CREATE TABLE IF NOT EXISTS einvoice_signing(
				project ${types.text("project")} PRIMARY KEY,
				certificate ${types.text("certificate")} NOT NULL,
				certificate_holder ${types.text("certificate_holder")},
				certificate_issuer ${types.text("certificate_issuer")},
				certificate_serial ${types.text("certificate_serial")},
				certificate_valid_to ${types.int64} NOT NULL,
				created ${types.int64} NOT NULL,
				updated ${types.int64} NOT NULL,
				FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE
			)`);
		},
	},
	{
		version: 10,
		name: "archived e-invoices",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await sql.unsafe(`CREATE TABLE IF NOT EXISTS eslog_documents(
				uuid ${types.text("uuid")} PRIMARY KEY,
				project ${types.text("project")} NOT NULL,
				invoice ${types.text("invoice")},
				credit_note ${types.text("credit_note")},
				version INTEGER NOT NULL,
				file_name ${types.text("file_name")} NOT NULL,
				storage_key ${types.text("storage_key")} NOT NULL,
				byte_size ${types.int64} NOT NULL,
				sha256 ${types.text("sha256")} NOT NULL,
				signed ${types.flag} NOT NULL CHECK (signed IN (0, 1)),
				reference_document_type ${types.text("reference_document_type")},
				reference_document_number ${types.text("reference_document_number")},
				reference_document_date ${types.int64},
				created ${types.int64} NOT NULL,
				FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
				FOREIGN KEY (invoice) REFERENCES invoices(uuid) ON DELETE CASCADE,
				FOREIGN KEY (credit_note) REFERENCES credit_notes(uuid) ON DELETE CASCADE,
				CHECK ((invoice IS NULL) <> (credit_note IS NULL)),
				UNIQUE(invoice, version),
				UNIQUE(credit_note, version)
			)`);
			await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_eslog_documents_project ON eslog_documents(project)`);
		},
	},
	{
		version: 11,
		name: "units of measure",
		up: async (sql, dialect) => {
			const unit = schemaTypes(dialect).text("unit");
			await sql.unsafe(`ALTER TABLE catalog_items ADD COLUMN unit ${unit}`);
			await sql.unsafe(`ALTER TABLE invoice_items ADD COLUMN unit ${unit}`);
			await sql.unsafe(`ALTER TABLE recurring_invoice_items ADD COLUMN unit ${unit}`);
		},
	},
	{
		version: 12,
		name: "e-invoice delivery",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await sql.unsafe(`ALTER TABLE projects ADD COLUMN email_attach_eslog ${types.flag} NOT NULL DEFAULT 0 CHECK (email_attach_eslog IN (0, 1))`);
			await sql.unsafe(`ALTER TABLE email_messages ADD COLUMN eslog_document ${types.text("eslog_document")}`);
		},
	},
	{
		version: 13,
		name: "registration invites",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await run(sql, dialect, [
				`CREATE TABLE IF NOT EXISTS registration_invites(
					uuid ${types.text("uuid")} PRIMARY KEY,
					code ${types.text("code")} NOT NULL UNIQUE,
					max_uses ${types.int64},
					uses ${types.int64} NOT NULL DEFAULT 0,
					expires_at ${types.int64},
					note ${types.text("note")},
					status ${types.text("status")} NOT NULL DEFAULT 'active',
					created_by ${types.text("created_by")},
					revoked_at ${types.int64},
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (created_by) REFERENCES accounts(username) ON DELETE SET NULL,
					CHECK (status IN ('active', 'revoked'))
				)`,
			]);
		},
	},
	{ version: 14, name: "workforce", up: createWorkforceSchema },
	{ version: 15, name: "payroll", up: createPayrollSchema },
	{ version: 16, name: "time entry breaks", up: allowBreakEntries },
	{ version: 17, name: "employee prior service", up: addPriorService },
	{ version: 18, name: "employee workforce settings", up: addEmployeeWorkforceSettings },
	{ version: 19, name: "store coupons", up: createStoreCouponSchema },
	{
		version: 20,
		name: "access log archives",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await run(sql, dialect, [
				`CREATE TABLE IF NOT EXISTS access_log_archives(
					storage_key ${types.text("storage_key")} PRIMARY KEY,
					starts_at ${types.int64} NOT NULL,
					ends_at ${types.int64} NOT NULL,
					entries ${types.int64} NOT NULL,
					byte_size ${types.int64} NOT NULL,
					sha256 ${types.text("sha256")} NOT NULL,
					created ${types.int64} NOT NULL
				)`,
				`CREATE INDEX IF NOT EXISTS idx_access_log_archives_ends ON access_log_archives(ends_at)`,
			]);
		},
	},
	{
		version: 21,
		name: "security keys",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await run(sql, dialect, [
				`CREATE TABLE IF NOT EXISTS account_security_keys(
					uuid ${types.text("uuid")} PRIMARY KEY,
					account_username ${types.text("account_username")} NOT NULL,
					credential_hash ${types.text("credential_hash")} NOT NULL UNIQUE,
					credential_id ${types.text("credential_id")} NOT NULL,
					public_key ${types.text("public_key")} NOT NULL,
					algorithm INTEGER NOT NULL,
					sign_count ${types.int64} NOT NULL DEFAULT 0,
					transports ${types.text("transports")},
					name ${types.text("name")} NOT NULL,
					created ${types.int64} NOT NULL,
					last_used ${types.int64},
					FOREIGN KEY (account_username) REFERENCES accounts(username) ON DELETE CASCADE
				)`,
				`CREATE INDEX IF NOT EXISTS idx_account_security_keys_account ON account_security_keys(account_username)`,
			]);
		},
	},
	{
		version: 22,
		name: "legal documents",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await run(sql, dialect, [
				`CREATE TABLE IF NOT EXISTS legal_documents(
					uuid ${types.text("uuid")} PRIMARY KEY,
					kind ${types.text("kind")} NOT NULL,
					version INTEGER NOT NULL,
					content_en ${types.text("content_en")},
					content_sl ${types.text("content_sl")},
					published ${types.int64} NOT NULL,
					published_by ${types.text("published_by")},
					UNIQUE(kind, version),
					FOREIGN KEY (published_by) REFERENCES accounts(username) ON DELETE SET NULL,
					CHECK (kind IN ('terms', 'privacy'))
				)`,
				`CREATE TABLE IF NOT EXISTS legal_acceptances(
					uuid ${types.text("uuid")} PRIMARY KEY,
					account_username ${types.text("account_username")} NOT NULL,
					kind ${types.text("kind")} NOT NULL,
					version INTEGER NOT NULL,
					accepted ${types.int64} NOT NULL,
					ip_address ${types.text("ip_address")},
					user_agent ${types.text("user_agent")},
					FOREIGN KEY (account_username) REFERENCES accounts(username) ON DELETE CASCADE
				)`,
				`CREATE INDEX IF NOT EXISTS idx_legal_acceptances_account ON legal_acceptances(account_username, kind)`,
			]);
		},
	},
	{
		version: 23,
		name: "legal effective dates",
		up: async (sql, dialect) => {
			await sql.unsafe(`ALTER TABLE legal_documents ADD COLUMN effective ${schemaTypes(dialect).int64}`);
			await sql`UPDATE legal_documents SET effective = published WHERE effective IS NULL`;
		},
	},
	{
		version: 24,
		name: "signed licenses",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await run(sql, dialect, [
				`CREATE TABLE IF NOT EXISTS server_identity(
					slot INTEGER PRIMARY KEY CHECK (slot = 1),
					id ${types.text("server_id")} NOT NULL UNIQUE,
					created ${types.int64} NOT NULL
				)`,
			]);
			await sql.unsafe(`ALTER TABLE license_keys ADD COLUMN server_id ${types.text("server_id")}`);
			await sql.unsafe(`ALTER TABLE license_keys ADD COLUMN signed_key ${types.text("signed_key")}`);
		},
	},
	{ version: 25, name: "employee seats", up: addEmployeeSeats },
	{ version: 26, name: "license products", up: createLicenseProductSchema },
	{ version: 27, name: "store order numbers", up: addStoreOrderNumbers },
];

export class SchemaTooNew extends Error {
	constructor(applied: number, known: number) {
		super(`The database is at schema version ${applied} but this server only knows up to ${known}. Upgrade the server instead of running an older one.`);
	}
}

async function ensureTable(sql: SQL, dialect: Dialect) {
	const types = schemaTypes(dialect);
	await sql.unsafe(`
		CREATE TABLE IF NOT EXISTS schema_migrations(
			version ${types.int64} PRIMARY KEY,
			name ${types.text("name")} NOT NULL,
			applied ${types.int64} NOT NULL
		)
	`);
}

export async function appliedVersions(sql: SQL): Promise<number[]> {
	const rows = (await sql`SELECT version FROM schema_migrations ORDER BY version ASC`) as { version: number | bigint }[];
	return rows.map((row) => Number(row.version));
}

export function validateMigrations(migrations: Migration[]) {
	migrations.forEach((migration, index) => {
		if (migration.version !== index + 1) throw new Error(`Migration ${migration.name} must have version ${index + 1}, found ${migration.version}`);
	});
}

export async function migrate(sql: SQL, dialect: Dialect, migrations: Migration[] = MIGRATIONS): Promise<number[]> {
	validateMigrations(migrations);
	await ensureTable(sql, dialect);

	const applied = new Set(await appliedVersions(sql));
	const newest = Math.max(0, ...applied);
	if (newest > migrations.length) throw new SchemaTooNew(newest, migrations.length);

	const ran: number[] = [];
	for (const migration of migrations) {
		if (applied.has(migration.version)) continue;
		await sql.begin(async (tx) => {
			await migration.up(tx as unknown as SQL, dialect);
			await tx`INSERT INTO schema_migrations(version, name, applied) VALUES(${migration.version}, ${migration.name}, ${Date.now()})`;
		});
		ran.push(migration.version);
	}
	return ran;
}
