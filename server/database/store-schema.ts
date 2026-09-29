import type { SQL } from "bun";

import type { Dialect } from "./dialect";
import { run } from "./schema";
import { schemaTypes } from "./schema-types";

async function allowStoreLicenses(sql: SQL, dialect: Dialect) {
	const types = schemaTypes(dialect);
	await run(sql, dialect, [
		`CREATE TABLE license_keys_next(
					uuid ${types.text("uuid")} PRIMARY KEY,
					code ${types.text("code")} NOT NULL UNIQUE,
					type ${types.text("type")} NOT NULL,
					transactions INTEGER,
					duration_days INTEGER,
					storage_gb INTEGER,
					status ${types.text("status")} NOT NULL DEFAULT 'available',
					price ${types.int64},
					currency ${types.text("currency")},
					buyer_name ${types.text("buyer_name")},
					buyer_email ${types.text("buyer_email")},
					note ${types.text("note")},
					created_by ${types.text("created_by")},
					redeemed_project ${types.text("redeemed_project")},
					redeemed_by ${types.text("redeemed_by")},
					redeemed_at ${types.int64},
					revoked_at ${types.int64},
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (redeemed_project) REFERENCES projects(uuid) ON DELETE SET NULL,
					CHECK (type IN ('transactions', 'white_label', 'storage', 'store')),
					CHECK (status IN ('available', 'redeemed', 'revoked'))
				)`,
		`INSERT INTO license_keys_next(uuid, code, type, transactions, duration_days, storage_gb, status, price, currency, buyer_name, buyer_email, note,
					created_by, redeemed_project, redeemed_by, redeemed_at, revoked_at, created, updated)
				SELECT uuid, code, type, transactions, duration_days, storage_gb, status, price, currency, buyer_name, buyer_email, note,
					created_by, redeemed_project, redeemed_by, redeemed_at, revoked_at, created, updated FROM license_keys`,
		`DROP TABLE license_keys`,
		`ALTER TABLE license_keys_next RENAME TO license_keys`,
		`CREATE INDEX IF NOT EXISTS idx_license_keys_status ON license_keys(status, created)`,
		`CREATE INDEX IF NOT EXISTS idx_license_keys_project ON license_keys(redeemed_project)`,
	]);
}

export async function createStoreSchema(sql: SQL, dialect: Dialect) {
	const types = schemaTypes(dialect);
	await allowStoreLicenses(sql, dialect);
	await sql.unsafe(`ALTER TABLE projects ADD COLUMN store_until ${types.int64}`);
	await run(sql, dialect, [
		`CREATE TABLE IF NOT EXISTS store_settings(
					project ${types.text("project")} PRIMARY KEY,
					slug ${types.text("slug")} NOT NULL UNIQUE,
					domain ${types.text("domain")} UNIQUE,
					enabled ${types.flag} NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
					config ${types.text("config")} NOT NULL,
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE
				)`,
		`CREATE TABLE IF NOT EXISTS store_categories(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					parent_category ${types.text("parent_category")},
					slug ${types.text("slug")} NOT NULL,
					name ${types.text("name")} NOT NULL,
					description ${types.text("description")},
					sort_order INTEGER NOT NULL DEFAULT 0,
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (parent_category) REFERENCES store_categories(uuid) ON DELETE SET NULL,
					UNIQUE(project, slug)
				)`,
		`CREATE INDEX IF NOT EXISTS idx_store_categories_project ON store_categories(project, sort_order)`,
		`CREATE TABLE IF NOT EXISTS store_products(
					item ${types.text("item")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					store_category ${types.text("store_category")},
					slug ${types.text("slug")} NOT NULL,
					published ${types.flag} NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
					featured ${types.flag} NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
					summary ${types.text("summary")},
					description ${types.text("description")},
					compare_price ${types.int64},
					stock ${types.int64},
					allow_backorder ${types.flag} NOT NULL DEFAULT 0 CHECK (allow_backorder IN (0, 1)),
					delivery_min_days INTEGER,
					delivery_max_days INTEGER,
					restock_at ${types.int64},
					sort_order INTEGER NOT NULL DEFAULT 0,
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (item) REFERENCES catalog_items(uuid) ON DELETE CASCADE,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (store_category) REFERENCES store_categories(uuid) ON DELETE SET NULL,
					UNIQUE(project, slug),
					CHECK (stock IS NULL OR stock >= 0),
					CHECK (delivery_min_days IS NULL OR delivery_max_days IS NULL OR delivery_min_days <= delivery_max_days)
				)`,
		`CREATE INDEX IF NOT EXISTS idx_store_products_listing ON store_products(project, published, store_category)`,
		`CREATE TABLE IF NOT EXISTS store_attributes(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					item ${types.text("item")} NOT NULL,
					attribute ${types.text("attribute")} NOT NULL,
					attribute_value ${types.text("attribute_value")} NOT NULL,
					sort_order INTEGER NOT NULL DEFAULT 0,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (item) REFERENCES catalog_items(uuid) ON DELETE CASCADE
				)`,
		`CREATE INDEX IF NOT EXISTS idx_store_attributes_item ON store_attributes(item, sort_order)`,
		`CREATE INDEX IF NOT EXISTS idx_store_attributes_filter ON store_attributes(project, attribute, attribute_value)`,
		`CREATE TABLE IF NOT EXISTS store_images(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					item ${types.text("item")},
					kind ${types.text("kind")} NOT NULL,
					storage_key ${types.text("storage_key")} NOT NULL UNIQUE,
					content_type ${types.text("content_type")} NOT NULL,
					byte_size ${types.int64} NOT NULL,
					sha256 ${types.text("sha256")} NOT NULL,
					alt ${types.text("alt")},
					sort_order INTEGER NOT NULL DEFAULT 0,
					created ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					FOREIGN KEY (item) REFERENCES catalog_items(uuid) ON DELETE CASCADE,
					CHECK (kind IN ('product', 'logo', 'hero')),
					CHECK ((kind = 'product') = (item IS NOT NULL))
				)`,
		`CREATE INDEX IF NOT EXISTS idx_store_images_item ON store_images(item, sort_order)`,
		`CREATE INDEX IF NOT EXISTS idx_store_images_project ON store_images(project, kind)`,
		`CREATE TABLE IF NOT EXISTS store_orders(
					invoice ${types.text("invoice")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					email ${types.text("email")} NOT NULL,
					fulfillment ${types.text("fulfillment")} NOT NULL DEFAULT 'pending',
					shipping_method ${types.text("shipping_method")},
					shipping_address ${types.text("shipping_address")},
					note ${types.text("note")},
					tracking_url ${types.text("tracking_url")},
					stock_returned ${types.flag} NOT NULL DEFAULT 0 CHECK (stock_returned IN (0, 1)),
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (invoice) REFERENCES invoices(uuid) ON DELETE CASCADE,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					CHECK (fulfillment IN ('pending', 'processing', 'shipped', 'delivered', 'canceled'))
				)`,
		`CREATE INDEX IF NOT EXISTS idx_store_orders_project ON store_orders(project, created)`,
		`CREATE INDEX IF NOT EXISTS idx_store_orders_email ON store_orders(email, created)`,
		`CREATE TABLE IF NOT EXISTS customer_profiles(
					email ${types.text("email")} PRIMARY KEY,
					customer_type ${types.text("customer_type")},
					name ${types.text("name")},
					company ${types.text("company")},
					phone ${types.text("phone")},
					vat_number ${types.text("vat_number")},
					tax_number ${types.text("tax_number")},
					address_line1 ${types.text("address_line1")},
					address_line2 ${types.text("address_line2")},
					postal_code ${types.text("postal_code")},
					city ${types.text("city")},
					state ${types.text("state")},
					country ${types.text("country")},
					shipping_same ${types.flag} NOT NULL DEFAULT 1 CHECK (shipping_same IN (0, 1)),
					shipping_name ${types.text("shipping_name")},
					shipping_phone ${types.text("shipping_phone")},
					shipping_address_line1 ${types.text("shipping_address_line1")},
					shipping_address_line2 ${types.text("shipping_address_line2")},
					shipping_postal_code ${types.text("shipping_postal_code")},
					shipping_city ${types.text("shipping_city")},
					shipping_state ${types.text("shipping_state")},
					shipping_country ${types.text("shipping_country")},
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (email) REFERENCES customer_accounts(email) ON DELETE CASCADE
				)`,
	]);
}

export async function createStoreCouponSchema(sql: SQL, dialect: Dialect) {
	const types = schemaTypes(dialect);
	await run(sql, dialect, [
		`CREATE TABLE IF NOT EXISTS store_coupons(
					uuid ${types.text("uuid")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					code ${types.text("code")} NOT NULL,
					kind ${types.text("kind")} NOT NULL,
					amount ${types.int64} NOT NULL DEFAULT 0,
					minimum ${types.int64},
					starts_at ${types.int64},
					ends_at ${types.int64},
					max_uses INTEGER,
					once_per_customer ${types.flag} NOT NULL DEFAULT 0 CHECK (once_per_customer IN (0, 1)),
					enabled ${types.flag} NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
					uses INTEGER NOT NULL DEFAULT 0,
					note ${types.text("note")},
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					UNIQUE(project, code),
					CHECK (kind IN ('percent', 'amount', 'free_shipping')),
					CHECK (uses >= 0)
				)`,
		`CREATE TABLE IF NOT EXISTS store_coupon_redemptions(
					invoice ${types.text("invoice")} PRIMARY KEY,
					coupon ${types.text("coupon")} NOT NULL,
					project ${types.text("project")} NOT NULL,
					email ${types.text("email")} NOT NULL,
					discount ${types.int64} NOT NULL,
					created ${types.int64} NOT NULL,
					FOREIGN KEY (invoice) REFERENCES invoices(uuid) ON DELETE CASCADE,
					FOREIGN KEY (coupon) REFERENCES store_coupons(uuid) ON DELETE CASCADE,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE
				)`,
		`CREATE INDEX IF NOT EXISTS idx_store_coupon_redemptions_coupon ON store_coupon_redemptions(coupon, email)`,
	]);
}

export async function createLicenseProductSchema(sql: SQL, dialect: Dialect) {
	const types = schemaTypes(dialect);
	await sql.unsafe(`ALTER TABLE catalog_items ADD COLUMN license ${types.text("license")}`);
	await run(sql, dialect, [
		`CREATE TABLE IF NOT EXISTS license_orders(
					invoice ${types.text("invoice")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					server_id ${types.text("server_id")},
					grants ${types.text("grants")} NOT NULL,
					minted_at ${types.int64},
					created ${types.int64} NOT NULL,
					FOREIGN KEY (invoice) REFERENCES invoices(uuid) ON DELETE CASCADE,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE
				)`,
		`CREATE INDEX IF NOT EXISTS idx_license_orders_pending ON license_orders(minted_at, created)`,
	]);
}

export async function addStoreOrderNumbers(sql: SQL, dialect: Dialect) {
	await sql.unsafe(`ALTER TABLE store_orders ADD COLUMN number ${schemaTypes(dialect).text("number")}`);
	await sql`UPDATE store_orders SET number = (SELECT reference FROM invoices WHERE invoices.uuid = store_orders.invoice)`;
}

export async function createProformaSchema(sql: SQL, dialect: Dialect) {
	const types = schemaTypes(dialect);
	await sql.unsafe(`ALTER TABLE projects ADD COLUMN order_format ${types.text("order_format")}`);
	await sql.unsafe(`ALTER TABLE projects ADD COLUMN proforma_format ${types.text("proforma_format")}`);
	await sql.unsafe(`ALTER TABLE projects ADD COLUMN proforma_settlement ${types.text("proforma_settlement")} NOT NULL DEFAULT 'invoice'`);
	await sql.unsafe(`ALTER TABLE invoices ADD COLUMN document_type ${types.text("document_type")} NOT NULL DEFAULT 'invoice'`);
	await sql.unsafe(`ALTER TABLE invoices ADD COLUMN proforma ${types.text("proforma")}`);
	await sql.unsafe(`ALTER TABLE invoices ADD COLUMN advanced_amount ${types.int64} NOT NULL DEFAULT 0`);
	await run(sql, dialect, [
		`CREATE TABLE IF NOT EXISTS proformas(
					invoice ${types.text("invoice")} PRIMARY KEY,
					project ${types.text("project")} NOT NULL,
					reference ${types.text("reference")} NOT NULL,
					settlement ${types.text("settlement")} NOT NULL,
					issued_at ${types.int64} NOT NULL,
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					FOREIGN KEY (invoice) REFERENCES invoices(uuid) ON DELETE CASCADE,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
					UNIQUE(project, reference),
					CHECK (settlement IN ('invoice', 'advance'))
				)`,
		`CREATE INDEX IF NOT EXISTS idx_invoices_proforma ON invoices(proforma)`,
		`CREATE INDEX IF NOT EXISTS idx_store_orders_number ON store_orders(project, number)`,
	]);
}

export async function createStoreLanguageSchema(sql: SQL, dialect: Dialect) {
	const types = schemaTypes(dialect);
	await run(sql, dialect, [
		`CREATE TABLE IF NOT EXISTS store_languages(
					project ${types.text("project")} NOT NULL,
					language ${types.text("language")} NOT NULL,
					name ${types.text("name")} NOT NULL,
					enabled ${types.flag} NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
					strings ${types.text("strings")} NOT NULL,
					content ${types.text("content")} NOT NULL,
					created ${types.int64} NOT NULL,
					updated ${types.int64} NOT NULL,
					PRIMARY KEY (project, language),
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE
				)`,
		`CREATE TABLE IF NOT EXISTS store_product_translations(
					item ${types.text("item")} NOT NULL,
					language ${types.text("language")} NOT NULL,
					project ${types.text("project")} NOT NULL,
					name ${types.text("name")},
					summary ${types.text("summary")},
					description ${types.text("description")},
					updated ${types.int64} NOT NULL,
					PRIMARY KEY (item, language),
					FOREIGN KEY (item) REFERENCES catalog_items(uuid) ON DELETE CASCADE,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE
				)`,
		`CREATE INDEX IF NOT EXISTS idx_store_product_translations_language ON store_product_translations(project, language)`,
		`CREATE TABLE IF NOT EXISTS store_category_translations(
					store_category ${types.text("store_category")} NOT NULL,
					language ${types.text("language")} NOT NULL,
					project ${types.text("project")} NOT NULL,
					name ${types.text("name")},
					description ${types.text("description")},
					updated ${types.int64} NOT NULL,
					PRIMARY KEY (store_category, language),
					FOREIGN KEY (store_category) REFERENCES store_categories(uuid) ON DELETE CASCADE,
					FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE
				)`,
		`CREATE INDEX IF NOT EXISTS idx_store_category_translations_language ON store_category_translations(project, language)`,
	]);
}

export async function addStoreProductNames(sql: SQL, dialect: Dialect) {
	await sql.unsafe(`ALTER TABLE store_products ADD COLUMN name ${schemaTypes(dialect).text("store_name")}`);
}
