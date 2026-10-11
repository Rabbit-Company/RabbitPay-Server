import type { SQL } from "bun";
import type { Dialect } from "./dialect";
import { schemaTypes } from "./schema-types";
import { createSchema, run } from "./schema";
import {
	addStoreOrderNumbers,
	addStoreProductNames,
	createLicenseProductSchema,
	createProformaSchema,
	createStoreCouponSchema,
	createStoreDomainSchema,
	createStoreLanguageSchema,
	createStoreSchema,
} from "./store-schema";
import {
	addEmployeeSeats,
	addEmployeeWorkforceSettings,
	addPriorService,
	allowBreakEntries,
	createPayrollSchema,
	createWorkforceSchema,
	rebuildSqliteTable,
	replaceCheck,
} from "./workforce-schema";
import { addExpenseDueDate, createAccountingSchema, createBankMatchSchema, LICENSE_TYPES_WITH_ACCOUNTING } from "./accounting-schema";
import { createRegistrySchema } from "./registry-schema";
import { createChatSchema } from "./chat-schema";
import { createCalendarSchema } from "./calendar-schema";
import { DEFAULT_EMAIL_DESIGN } from "../email-design";

async function dropIndex(sql: SQL, dialect: Dialect, table: string, name: string) {
	if (dialect !== "mysql") {
		await sql.unsafe(`DROP INDEX IF EXISTS ${name}`);
		return;
	}
	const rows =
		await sql`SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND INDEX_NAME = ${name}`;
	if (rows.length) await sql.unsafe(`DROP INDEX ${name} ON ${table}`);
}

const LICENSE_TYPES_WITH_EMAILS = "CHECK (type IN ('transactions', 'white_label', 'storage', 'store', 'workforce', 'employees', 'accounting', 'emails'))";
const LICENSE_TYPES_WITH_FILES =
	"CHECK (type IN ('transactions', 'white_label', 'storage', 'store', 'workforce', 'employees', 'accounting', 'emails', 'files'))";

export interface Migration {
	version: number;
	name: string;
	rebuildsSqliteTables?: boolean;
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
	{ version: 28, name: "pro forma and advance invoices", up: createProformaSchema },
	{ version: 29, name: "store languages", up: createStoreLanguageSchema },
	{ version: 30, name: "store product names", up: addStoreProductNames },
	{ version: 31, name: "store domains", up: createStoreDomainSchema },
	{ version: 32, name: "accounting", up: createAccountingSchema },
	{ version: 33, name: "bank line matches", up: createBankMatchSchema },
	{ version: 34, name: "expense due dates", up: addExpenseDueDate },
	{ version: 35, name: "company registry", up: createRegistrySchema },
	{
		version: 36,
		name: "license start dates",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await sql.unsafe(`ALTER TABLE license_keys ADD COLUMN starts_at ${types.int64}`);
			await sql.unsafe(`ALTER TABLE license_keys ADD COLUMN activated_at ${types.int64}`);
		},
	},
	{
		version: 37,
		name: "query indexes",
		up: async (sql, dialect) => {
			const long = (column: string, length: number) => (dialect === "mysql" ? `${column}(${length})` : column);
			await run(sql, dialect, [
				`CREATE INDEX IF NOT EXISTS idx_item_keys_reserved ON item_keys(status, reserved_at)`,
				`CREATE INDEX IF NOT EXISTS idx_invoices_status_due ON invoices(status, due_date)`,
				`CREATE INDEX IF NOT EXISTS idx_invoices_created ON invoices(project, created)`,
				`CREATE INDEX IF NOT EXISTS idx_tx_unbilled ON transactions(${long("license_billing", 16)}, project)`,
				`CREATE INDEX IF NOT EXISTS idx_tx_processor_id ON transactions(processor, ${long("processor_tx_id", 191)})`,
				`CREATE INDEX IF NOT EXISTS idx_tx_project_created ON transactions(project, created)`,
				`CREATE INDEX IF NOT EXISTS idx_session_external ON payment_sessions(processor, ${long("processor_session_id", 191)})`,
				`CREATE INDEX IF NOT EXISTS idx_session_invoice ON payment_sessions(invoice)`,
				`CREATE INDEX IF NOT EXISTS idx_customers_created ON customers(project, created)`,
				`CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created ON webhook_deliveries(project, created)`,
				`CREATE INDEX IF NOT EXISTS idx_tickets_updated ON tickets(project, updated)`,
			]);
			await dropIndex(sql, dialect, "invoices", "idx_invoices_status");
			await dropIndex(sql, dialect, "transactions", "idx_tx_license_billing");
			await dropIndex(sql, dialect, "transactions", "idx_tx_processor");
		},
	},
	{
		version: 38,
		name: "ECB reference rates",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await run(sql, dialect, [
				`CREATE TABLE IF NOT EXISTS ecb_rates(
					day ${types.text("day")} NOT NULL,
					currency ${types.text("currency")} NOT NULL,
					rate ${types.float} NOT NULL,
					fetched ${types.int64} NOT NULL,
					PRIMARY KEY (day, currency)
				)`,
			]);
		},
	},
	{
		version: 39,
		name: "euro reporting for Slovenian sellers",
		up: async (sql) => {
			await sql`UPDATE projects SET tax_currency = 'EUR' WHERE tax_country = 'SI' AND (tax_currency IS NULL OR tax_currency <> 'EUR')`;
		},
	},
	{
		version: 40,
		name: "idempotency keys",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await run(sql, dialect, [
				`CREATE TABLE IF NOT EXISTS idempotency_keys(
					project ${types.text("project")} NOT NULL,
					request_key ${types.text("key")} NOT NULL,
					request_hash ${types.text("sha256")} NOT NULL,
					resource ${types.text("uuid")} NOT NULL,
					created ${types.int64} NOT NULL,
					PRIMARY KEY (project, request_key),
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE
				)`,
				`CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created ON idempotency_keys(created)`,
			]);
		},
	},
	{
		version: 41,
		name: "customers without an email address",
		rebuildsSqliteTables: true,
		up: async (sql, dialect) => {
			const column = `email ${schemaTypes(dialect).text("email")}`;
			if (dialect === "sqlite") return rebuildSqliteTable(sql, "customers", `${column} NOT NULL`, column);
			if (dialect === "mysql") await sql.unsafe(`ALTER TABLE customers MODIFY ${column} NULL`);
			else await sql.unsafe("ALTER TABLE customers ALTER COLUMN email DROP NOT NULL");
		},
	},
	{
		version: 42,
		name: "VAT tax point dates",
		up: async (sql, dialect) => {
			await sql.unsafe(`ALTER TABLE invoices ADD COLUMN tax_point_date ${schemaTypes(dialect).int64}`);
			await sql`UPDATE invoices SET tax_point_date = COALESCE(supply_date, issued_at) WHERE issued_at IS NOT NULL`;
			await run(sql, dialect, [`CREATE INDEX IF NOT EXISTS idx_invoices_tax_point ON invoices(project, tax_point_date)`]);
		},
	},
	{
		version: 43,
		name: "VAT reporting periods and late corrections",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await sql.unsafe(`ALTER TABLE invoices ADD COLUMN vat_period_date ${types.int64}`);
			await sql.unsafe(`ALTER TABLE invoices ADD COLUMN vat_handling ${types.text("status")} NOT NULL DEFAULT '1'`);
			await sql.unsafe(`ALTER TABLE invoices ADD COLUMN vat_correction_period ${types.text("status")}`);
			await sql`UPDATE invoices SET vat_period_date = tax_point_date WHERE tax_point_date IS NOT NULL`;
			await sql.unsafe(`ALTER TABLE recorded_invoices ADD COLUMN tax_point_date ${types.int64}`);
			await sql`UPDATE recorded_invoices SET tax_point_date = CASE WHEN document_type = 'invoice' THEN COALESCE(supply_date, issued_at) ELSE issued_at END`;
			await run(sql, dialect, [
				`CREATE INDEX IF NOT EXISTS idx_invoices_vat_period ON invoices(project, vat_period_date)`,
				`CREATE INDEX IF NOT EXISTS idx_recorded_invoices_tax_point ON recorded_invoices(project, tax_point_date)`,
			]);
		},
	},
	{
		version: 44,
		name: "recurring invoices for the previous period",
		up: async (sql, dialect) => {
			const flag = schemaTypes(dialect).flag;
			await sql.unsafe(`ALTER TABLE recurring_invoices ADD COLUMN bill_previous_period ${flag} NOT NULL DEFAULT 0 CHECK (bill_previous_period IN (0, 1))`);
		},
	},
	{
		version: 45,
		name: "email history",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await sql.unsafe(`ALTER TABLE email_messages ADD COLUMN credit_note ${types.text("credit_note")}`);
			await sql.unsafe(`ALTER TABLE email_messages ADD COLUMN ticket ${types.text("ticket")}`);
			await sql.unsafe(`ALTER TABLE email_messages ADD COLUMN sent_via ${types.text("source")}`);
			await sql.unsafe(`ALTER TABLE email_messages ADD COLUMN has_body ${types.flag} NOT NULL DEFAULT 1 CHECK (has_body IN (0, 1))`);
			await run(sql, dialect, [
				`CREATE INDEX IF NOT EXISTS idx_email_messages_project ON email_messages(project, created)`,
				`CREATE INDEX IF NOT EXISTS idx_email_messages_body ON email_messages(has_body, created)`,
			]);
		},
	},
	{
		version: 46,
		name: "email licenses",
		rebuildsSqliteTables: true,
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await replaceCheck(sql, dialect, "license_keys", "white_label", "license_keys_type_check", LICENSE_TYPES_WITH_ACCOUNTING, LICENSE_TYPES_WITH_EMAILS);
			await sql.unsafe(`ALTER TABLE license_keys ADD COLUMN emails INTEGER`);
			await sql.unsafe(`ALTER TABLE projects ADD COLUMN free_emails ${types.int64}`);
			await sql.unsafe(`ALTER TABLE projects ADD COLUMN paid_emails ${types.int64} NOT NULL DEFAULT 0`);
			await sql.unsafe(`ALTER TABLE project_usage ADD COLUMN emails_free_used ${types.int64} NOT NULL DEFAULT 0`);
			await sql.unsafe(`ALTER TABLE project_usage ADD COLUMN emails_paid_used ${types.int64} NOT NULL DEFAULT 0`);
			await sql.unsafe(`ALTER TABLE email_messages ADD COLUMN license_billing ${types.text("status")}`);
		},
	},
	{
		version: 47,
		name: "fixed-price tickets",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await sql.unsafe(`ALTER TABLE tickets ADD COLUMN fixed_price ${types.int64}`);
			await run(sql, dialect, [
				`CREATE TABLE IF NOT EXISTS ticket_fixed_price_invoices(
					ticket ${types.text("ticket")} PRIMARY KEY,
					invoice ${types.text("invoice")} NOT NULL,
					created ${types.int64} NOT NULL,
					FOREIGN KEY (ticket) REFERENCES tickets(uuid) ON DELETE CASCADE,
					FOREIGN KEY (invoice) REFERENCES invoices(uuid) ON DELETE CASCADE
				)`,
				`CREATE INDEX IF NOT EXISTS idx_ticket_fixed_price_invoice ON ticket_fixed_price_invoices(invoice)`,
			]);
		},
	},
	{
		version: 48,
		name: "time entry activities",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await sql.unsafe(`ALTER TABLE time_entries ADD COLUMN activity ${types.text("activity")}`);
			await sql`
				UPDATE time_entries
				SET activity = CASE
					WHEN kind = 'break' THEN NULL
					WHEN ticket IS NOT NULL THEN 'ticket'
					ELSE 'internal'
				END
			`;
		},
	},
	{
		version: 49,
		name: "custom ticket ordering",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await sql.unsafe(`ALTER TABLE tickets ADD COLUMN sort_order ${types.int64} NOT NULL DEFAULT 0`);
			await sql`UPDATE tickets SET sort_order = number`;
		},
	},
	{
		version: 50,
		name: "timesheet approvals",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await run(sql, dialect, [
				`CREATE TABLE IF NOT EXISTS timesheet_periods(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					member ${types.text("member")} NOT NULL,
					period ${types.text("period")} NOT NULL,
					status ${types.text("status")} NOT NULL CHECK (status IN ('draft', 'submitted', 'approved', 'returned')),
					note ${types.text("note")},
					submitted_by ${types.text("submitted_by")},
					submitted_at ${types.int64},
					decided_by ${types.text("decided_by")},
					decided_at ${types.int64},
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (member) REFERENCES project_members(uuid) ON DELETE CASCADE,
					FOREIGN KEY (submitted_by) REFERENCES accounts(username) ON DELETE SET NULL,
					FOREIGN KEY (decided_by) REFERENCES accounts(username) ON DELETE SET NULL,
					UNIQUE(project, member, period)
				)`,
				`CREATE INDEX IF NOT EXISTS idx_timesheet_periods_project ON timesheet_periods(project, period, status)`,
			]);
		},
	},
	{
		version: 51,
		name: "file storage",
		rebuildsSqliteTables: true,
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await replaceCheck(sql, dialect, "license_keys", "white_label", "license_keys_type_check", LICENSE_TYPES_WITH_EMAILS, LICENSE_TYPES_WITH_FILES);
			await sql.unsafe(`ALTER TABLE projects ADD COLUMN max_file_bytes ${types.int64}`);
			await sql.unsafe(`ALTER TABLE projects ADD COLUMN max_member_file_bytes ${types.int64}`);
			await run(sql, dialect, [
				`CREATE TABLE IF NOT EXISTS file_folders(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					parent ${types.text("parent")},
					name ${types.text("file_name")} NOT NULL,
					access ${types.text("status")} CHECK (access IN ('private', 'everyone', 'members')),
					created_by ${types.text("created_by")},
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (parent) REFERENCES file_folders(uuid) ON DELETE CASCADE,
					FOREIGN KEY (created_by) REFERENCES accounts(username) ON DELETE SET NULL
				)`,
				`CREATE INDEX IF NOT EXISTS idx_file_folders_parent ON file_folders(project, parent)`,
				`CREATE TABLE IF NOT EXISTS file_folder_members(
					folder ${types.text("folder")} NOT NULL,
					account ${types.text("account")} NOT NULL,
					PRIMARY KEY (folder, account),
					FOREIGN KEY (folder) REFERENCES file_folders(uuid) ON DELETE CASCADE,
					FOREIGN KEY (account) REFERENCES accounts(username) ON DELETE CASCADE
				)`,
				`CREATE TABLE IF NOT EXISTS file_member_limits(
					project ${types.text("project")} NOT NULL,
					account ${types.text("account")} NOT NULL,
					max_bytes ${types.int64} NOT NULL,
					PRIMARY KEY (project, account),
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (account) REFERENCES accounts(username) ON DELETE CASCADE
				)`,
				`CREATE TABLE IF NOT EXISTS project_files(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					storage_key ${types.text("storage_key")} NOT NULL UNIQUE,
					file_name ${types.text("file_name")} NOT NULL,
					content_type ${types.text("content_type")} NOT NULL,
					byte_size ${types.int64} NOT NULL,
					parts INTEGER NOT NULL,
					parts_received INTEGER NOT NULL DEFAULT 0,
					status ${types.text("status")} NOT NULL CHECK (status IN ('uploading', 'ready')),
					explorer ${types.flag} NOT NULL DEFAULT 0 CHECK (explorer IN (0, 1)),
					folder ${types.text("folder")},
					created_by ${types.text("created_by")},
					created ${types.int64} NOT NULL,
					removed_by ${types.text("removed_by")},
					removed_at ${types.int64},
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (created_by) REFERENCES accounts(username) ON DELETE SET NULL,
					FOREIGN KEY (removed_by) REFERENCES accounts(username) ON DELETE SET NULL,
					FOREIGN KEY (folder) REFERENCES file_folders(uuid) ON DELETE SET NULL
				)`,
				`CREATE INDEX IF NOT EXISTS idx_project_files_folder ON project_files(project, explorer, folder)`,
				`CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project, removed_at, byte_size)`,
				`CREATE INDEX IF NOT EXISTS idx_project_files_status ON project_files(status, created)`,
				`CREATE TABLE IF NOT EXISTS ticket_files(
					ticket ${types.text("ticket")} NOT NULL,
					file ${types.text("file")} NOT NULL,
					created ${types.int64} NOT NULL,
					PRIMARY KEY (ticket, file),
					FOREIGN KEY (ticket) REFERENCES tickets(uuid) ON DELETE CASCADE,
					FOREIGN KEY (file) REFERENCES project_files(uuid) ON DELETE CASCADE
				)`,
				`CREATE INDEX IF NOT EXISTS idx_ticket_files_file ON ticket_files(file)`,
			]);
		},
	},
	{
		version: 52,
		name: "sharing of single files and nested folders",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await sql.unsafe(`ALTER TABLE project_files ADD COLUMN access ${types.text("status")} NOT NULL DEFAULT 'private'`);
			await sql`UPDATE file_folders SET access = 'private' WHERE access IS NULL`;
			await run(sql, dialect, [
				`CREATE TABLE IF NOT EXISTS file_members(
					file ${types.text("file")} NOT NULL,
					account ${types.text("account")} NOT NULL,
					PRIMARY KEY (file, account),
					FOREIGN KEY (file) REFERENCES project_files(uuid) ON DELETE CASCADE,
					FOREIGN KEY (account) REFERENCES accounts(username) ON DELETE CASCADE
				)`,
			]);
		},
	},
	{ version: 53, name: "chat", up: createChatSchema },
	{
		version: 54,
		name: "chosen chat status",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await sql.unsafe(`ALTER TABLE accounts ADD COLUMN chat_status ${types.text("status")}`);
		},
	},
	{ version: 55, name: "calendar", up: createCalendarSchema },
	{
		version: 56,
		name: "notification preferences",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await run(sql, dialect, [
				`CREATE TABLE IF NOT EXISTS notification_preferences(
					account ${types.text("account")} NOT NULL,
					kind ${types.text("kind")} NOT NULL,
					channel ${types.text("status")} NOT NULL CHECK (channel IN ('browser', 'email')),
					enabled ${types.flag} NOT NULL CHECK (enabled IN (0, 1)),
					updated ${types.int64} NOT NULL,
					PRIMARY KEY (account, kind, channel),
					FOREIGN KEY (account) REFERENCES accounts(username) ON DELETE CASCADE
				)`,
				`CREATE INDEX IF NOT EXISTS idx_notification_preferences_kind ON notification_preferences(kind, channel)`,
			]);
		},
	},
	{
		version: 57,
		name: "push notifications",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await run(sql, dialect, [
				`CREATE TABLE IF NOT EXISTS push_keys(
					slot INTEGER PRIMARY KEY CHECK (slot = 1),
					public_key ${types.text("public_key")} NOT NULL,
					private_key ${types.text("private_key")} NOT NULL,
					created ${types.int64} NOT NULL
				)`,
				`CREATE TABLE IF NOT EXISTS push_subscriptions(
					uuid ${types.text("uuid")} PRIMARY KEY,
					account ${types.text("account")} NOT NULL,
					endpoint_hash ${types.text("token_hash")} NOT NULL UNIQUE,
					endpoint ${types.text("endpoint")} NOT NULL,
					p256dh ${types.text("public_key")} NOT NULL,
					auth ${types.text("auth")} NOT NULL,
					language ${types.text("language")} NOT NULL,
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (account) REFERENCES accounts(username) ON DELETE CASCADE
				)`,
				`CREATE INDEX IF NOT EXISTS idx_push_subscriptions_account ON push_subscriptions(account)`,
			]);
		},
	},
	{
		version: 58,
		name: "push device names",
		up: async (sql, dialect) => {
			const types = schemaTypes(dialect);
			await sql.unsafe(`ALTER TABLE push_subscriptions ADD COLUMN user_agent ${types.text("user_agent")}`);
		},
	},
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
		const withoutForeignKeys = dialect === "sqlite" && migration.rebuildsSqliteTables === true;
		if (withoutForeignKeys) await sql`PRAGMA foreign_keys = OFF`;
		try {
			await sql.begin(async (tx) => {
				await migration.up(tx as unknown as SQL, dialect);
				if (withoutForeignKeys) {
					const broken = await tx.unsafe("PRAGMA foreign_key_check");
					if (broken.length > 0) throw new Error(`Migration ${migration.name} left ${broken.length} rows pointing at missing records`);
				}
				await tx`INSERT INTO schema_migrations(version, name, applied) VALUES(${migration.version}, ${migration.name}, ${Date.now()})`;
			});
		} finally {
			if (withoutForeignKeys) await sql`PRAGMA foreign_keys = ON`;
		}
		ran.push(migration.version);
	}
	return ran;
}
