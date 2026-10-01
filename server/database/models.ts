import type { ProjectRole } from "../roles";

export interface AccountRow {
	username: string;
	email: string;
	password: string;
	two_factor_secret: string | null;
	status: "active" | "suspended" | "deleted";
	admin: number;
	created: number;
	updated: number;
	accessed: number;
}

export interface SecurityKeyRow {
	uuid: string;
	account_username: string;
	credential_hash: string;
	credential_id: string;
	public_key: string;
	algorithm: number;
	sign_count: number;
	transports: string | null;
	name: string;
	created: number;
	last_used: number | null;
}

export type LegalKind = "terms" | "privacy";

export interface LegalDocumentRow {
	uuid: string;
	kind: LegalKind;
	version: number;
	content_en: string | null;
	content_sl: string | null;
	published: number;
	published_by: string | null;
	effective: number | null;
}

export interface RegistrationInviteRow {
	uuid: string;
	code: string;
	max_uses: number | null;
	uses: number;
	expires_at: number | null;
	note: string | null;
	status: "active" | "revoked";
	created_by: string | null;
	revoked_at: number | null;
	created: number;
	updated: number;
}

export interface ProjectRow {
	uuid: string;
	name: string;
	apikey: string;
	apikey2: string;
	webhook_url: string | null;
	webhook_secret: string | null;
	currency: string;
	display_name: string | null;
	date_format: string;
	time_format: string;
	timezone: string;
	language: string;
	accent_color: string | null;
	tax_country: string | null;
	vat_status: string | null;
	oss_registered: number;
	tax_currency: string | null;
	vat_exemption_note: string | null;
	pos_custom_amounts: number;
	email_reminders: number;
	reminder_days_before: number;
	reminder_days_after: number;
	email_attach_invoice: number;
	email_attach_eslog: number;
	email_pay_link: number;
	email_portal_link: number;
	free_transactions: number | null;
	paid_transactions: number;
	paid_storage_bytes: number;
	white_label_until: number | null;
	store_until: number | null;
	workforce_until: number | null;
	accounting_until: number | null;
	bookkeeping: Bookkeeping;
	logo_updated: number | null;
	email_server: string | null;
	invoice_format: string;
	order_format: string | null;
	proforma_format: string | null;
	proforma_settlement: ProformaSettlement;
	invoice_issuer_details: number;
	invoice_design: string | null;
	email_design: string | null;
	status: "active" | "suspended" | "deleted";
	created: number;
	updated: number;
	created_by: string;
}

export interface FiscalSettingsRow {
	project: string;
	environment: "test" | "production";
	certificate: string | null;
	certificate_holder: string | null;
	certificate_tax_number: number | null;
	certificate_serial: string | null;
	certificate_valid_to: number | null;
	enabled: number;
	online_premise: string | null;
	online_device: string | null;
	pos_premise: string | null;
	pos_device: string | null;
	operator_tax_number: number | null;
	created: number;
	updated: number;
}

export interface FiscalPremiseRow {
	uuid: string;
	project: string;
	environment: "test" | "production";
	premise_id: string;
	kind: "real_estate" | "movable";
	premise_type: "A" | "B" | "C" | null;
	cadastral_number: number | null;
	building_number: number | null;
	building_section_number: number | null;
	street: string | null;
	house_number: string | null;
	house_number_additional: string | null;
	community: string | null;
	city: string | null;
	postal_code: string | null;
	validity_date: string;
	registered_at: number;
	closed_at: number | null;
	created: number;
	updated: number;
}

export interface FiscalDocumentRow {
	uuid: string;
	project: string;
	invoice: string | null;
	credit_note: string | null;
	environment: "test" | "production";
	premise_id: string;
	device_id: string;
	invoice_number: string;
	issued_at: number;
	tax_number: number;
	amount: number;
	zoi: string;
	eor: string | null;
	status: "pending" | "verified" | "rejected";
	payload: string;
	attempts: number;
	subsequent: number;
	next_attempt_at: number | null;
	deadline: number;
	error_code: string | null;
	last_error: string | null;
	message_id: string | null;
	operator_name: string | null;
	operator_tax_number: number | null;
	verified_at: number | null;
	alerted: FiscalAlert | null;
	archive_key: string | null;
	archive_size: number | null;
	archive_sha256: string | null;
	created: number;
	updated: number;
}

export type FiscalAlert = "rejected" | "deadline";

export interface ProjectCompanyRow {
	project: string;
	legal_name: string | null;
	address_line1: string | null;
	address_line2: string | null;
	postal_code: string | null;
	city: string | null;
	state: string | null;
	country: string | null;
	vat_number: string | null;
	tax_number: string | null;
	registration_number: string | null;
	email: string | null;
	phone: string | null;
	website: string | null;
	footer_note: string | null;
	created: number;
	updated: number;
}

export interface ProjectMemberRow {
	uuid: string;
	project_id: string;
	account_username: string | null;
	role: ProjectRole;
	invited_by: string | null;
	invitation_token: string | null;
	invitation_email: string | null;
	status: "active" | "pending" | "suspended" | "removed";
	full_name: string | null;
	additional_permissions: string | null;
	restricted_permissions: string | null;
	notes: string | null;
	accepted_at: number | null;
	expires_at: number | null;
	created: number;
	updated: number;
}

export interface CustomerRow {
	uuid: string;
	project: string;
	name: string | null;
	email: string;
	phone: string | null;
	address_line1: string | null;
	address_line2: string | null;
	city: string | null;
	state: string | null;
	postal_code: string | null;
	country: string | null;
	vat_number: string | null;
	tax_number: string | null;
	metadata: string | null;
	customer_type: string | null;
	vat_valid: number | null;
	vat_checked_at: number | null;
	vat_checked_name: string | null;
	vat_checked_address: string | null;
	vat_check_reference: string | null;
	registration_number: string | null;
	iban: string | null;
	bic: string | null;
	created: number;
	updated: number;
}

export type InvoiceStatus = "draft" | "open" | "paid" | "partially_paid" | "canceled" | "overdue" | "refunded";

export interface InvoiceRow {
	uuid: string;
	project: string;
	customer: string | null;
	reference: string;
	status: InvoiceStatus;
	document_type: InvoiceDocumentType;
	proforma: string | null;
	advanced_amount: number;
	currency: string;
	subtotal: number;
	discount_amount: number;
	tax_amount: number;
	total_amount: number;
	paid_amount: number;
	refunded_amount: number;
	credited_amount: number;
	notes: string | null;
	metadata: string | null;
	due_date: number;
	supply_date: number | null;
	issued_at: number | null;
	tax_currency: string | null;
	tax_exchange_rate: number | null;
	tax_rate_source: string | null;
	tax_rate_date: number | null;
	buyer_country: string | null;
	buyer_vat_number: string | null;
	buyer_email: string | null;
	buyer_details: string | null;
	paid_date: number | null;
	canceled_date: number | null;
	source: "invoice" | "pos";
	created_by: string | null;
	issuer_name: string | null;
	recurring: string | null;
	reference_document_type: string | null;
	reference_document_number: string | null;
	reference_document_date: number | null;
	created: number;
	updated: number;
}

export interface InvoiceItemRow {
	uuid: string;
	invoice: string;
	description: string;
	quantity: number;
	unit_price: number;
	tax_rate: number;
	tax_amount: number;
	total_price: number;
	metadata: string | null;
	sort_order: number;
	item: string | null;
	tax_treatment: string | null;
	discount_amount: number;
	unit: string | null;
}

export interface InvoiceIssueSnapshotRow {
	invoice: string;
	schema_version: number;
	seller_details: string;
	document_settings: string;
	created: number;
}

export interface InvoiceDocumentRow {
	invoice: string;
	storage_key: string;
	content_type: string;
	byte_size: number | null;
	sha256: string | null;
	status: "pending" | "ready" | "failed";
	attempts: number;
	last_error: string | null;
	next_attempt_at: number | null;
	created: number;
	updated: number;
}

export interface CreditNoteRow {
	uuid: string;
	project: string;
	invoice: string;
	reference: string;
	reason: string | null;
	currency: string;
	subtotal: number;
	tax_amount: number;
	total_amount: number;
	transaction_id: string | null;
	issued_at: number;
	created_by: string | null;
	created: number;
}

export interface CreditNoteItemRow {
	uuid: string;
	credit_note: string;
	invoice_item: string | null;
	description: string;
	tax_rate: number;
	tax_treatment: string | null;
	net_amount: number;
	tax_amount: number;
	sort_order: number;
}

export interface CreditNoteIssueSnapshotRow {
	credit_note: string;
	schema_version: number;
	seller_details: string;
	document_settings: string;
	created: number;
}

export interface CreditNoteDocumentRow {
	credit_note: string;
	storage_key: string;
	content_type: string;
	byte_size: number | null;
	sha256: string | null;
	status: "pending" | "ready" | "failed";
	attempts: number;
	last_error: string | null;
	next_attempt_at: number | null;
	created: number;
	updated: number;
}

export interface CatalogItemRow {
	uuid: string;
	project: string;
	name: string;
	description: string | null;
	sku: string | null;
	unit_price: number;
	currency: string;
	tax_rate: number;
	supply_type: string;
	tax_category: string;
	delivers_keys: number;
	license: string | null;
	unit: string | null;
	archived: number;
	created: number;
	updated: number;
}

export interface LicenseOrderRow {
	invoice: string;
	project: string;
	server_id: string | null;
	grants: string;
	minted_at: number | null;
	created: number;
}

export type ProformaSettlement = "invoice" | "advance";

export type InvoiceDocumentType = "invoice" | "advance";

export interface ProformaRow {
	invoice: string;
	project: string;
	reference: string;
	settlement: ProformaSettlement;
	issued_at: number;
	created: number;
	updated: number;
}

export type ItemKeyStatus = "available" | "reserved" | "delivered";

export interface ItemKeyRow {
	uuid: string;
	project: string;
	item: string;
	secret: string;
	sequence: number;
	status: ItemKeyStatus;
	invoice: string | null;
	invoice_item: string | null;
	recipient: string | null;
	reserved_at: number | null;
	delivered_at: number | null;
	created: number;
	created_by: string | null;
}

export type RecurringStatus = "active" | "paused" | "completed" | "canceled";

export interface RecurringInvoiceRow {
	uuid: string;
	project: string;
	customer: string;
	title: string | null;
	currency: string;
	discount_amount: number;
	notes: string | null;
	interval_unit: string;
	interval_count: number;
	start_date: number;
	anchor_date: number;
	anchor_occurrence: number;
	next_run_at: number | null;
	occurrences: number;
	max_occurrences: number | null;
	end_date: number | null;
	days_until_due: number;
	auto_issue: number;
	auto_send: number;
	status: RecurringStatus;
	failures: number;
	last_invoice: string | null;
	last_run_at: number | null;
	last_error: string | null;
	created_by: string | null;
	created: number;
	updated: number;
}

export interface RecurringInvoiceItemRow {
	uuid: string;
	recurring: string;
	description: string;
	quantity: number;
	unit_price: number;
	tax_rate: number;
	item: string | null;
	tax_treatment: string | null;
	unit: string | null;
	sort_order: number;
}

export type EmailKind =
	| "invoice"
	| "reminder_before"
	| "reminder_after"
	| "receipt"
	| "invitation"
	| "keys"
	| "credit_note"
	| "fiscal_alert"
	| "order_update"
	| "order_placed"
	| "proforma"
	| "order_processing"
	| "order_shipped"
	| "order_delivered"
	| "ticket_reply"
	| "ticket_status"
	| "ticket_customer"
	| "ticket_assigned"
	| "absence_requested"
	| "absence_decided";
export type EmailStatus = "pending" | "sent" | "failed";

export interface EmailMessageRow {
	uuid: string;
	project: string;
	invoice: string | null;
	member: string | null;
	kind: EmailKind;
	recipient: string;
	reply_to: string | null;
	sender_name: string;
	subject: string;
	body_text: string;
	body_html: string;
	attachment_name: string | null;
	attachment_data: string | null;
	attachment_storage_key: string | null;
	eslog_document: string | null;
	status: EmailStatus;
	attempts: number;
	last_error: string | null;
	next_attempt_at: number | null;
	sent_by: string | null;
	sent_at: number | null;
	created: number;
	updated: number;
}

export type TransactionType = "payment" | "refund" | "partial_refund";

export type TransactionStatus = "pending" | "processing" | "confirmed" | "completed" | "failed" | "expired" | "refunded" | "partially_refunded";

export interface TransactionRow {
	uuid: string;
	project: string;
	invoice: string | null;
	customer: string | null;
	processor: string;
	processor_tx_id: string | null;
	parent_transaction: string | null;
	status: TransactionStatus;
	type: TransactionType;
	currency: string;
	amount: number;
	fee_amount: number;
	net_amount: number | null;
	exchange_rate: number | null;
	payment_method: string | null;
	payment_details: string | null;
	error_code: string | null;
	error_message: string | null;
	confirmations: number | null;
	confirmed_at: number | null;
	completed_at: number | null;
	failed_at: number | null;
	expires_at: number | null;
	license_billing: LicenseBilling | null;
	base_amount: number | null;
	created: number;
	updated: number;
}

export type LicenseBilling = "free" | "paid" | "unmetered";

export type LicenseType = "transactions" | "white_label" | "storage" | "store" | "workforce" | "employees" | "accounting";

export type LicenseStatus = "available" | "redeemed" | "revoked";

export interface LicenseKeyRow {
	uuid: string;
	code: string;
	type: LicenseType;
	transactions: number | null;
	duration_days: number | null;
	storage_gb: number | null;
	employees: number | null;
	status: LicenseStatus;
	price: number | null;
	currency: string | null;
	buyer_name: string | null;
	buyer_email: string | null;
	note: string | null;
	created_by: string | null;
	redeemed_project: string | null;
	redeemed_by: string | null;
	redeemed_at: number | null;
	revoked_at: number | null;
	server_id: string | null;
	signed_key: string | null;
	created: number;
	updated: number;
}

export interface ProjectUsageRow {
	project: string;
	period: string;
	free_used: number;
	paid_used: number;
}

export interface CryptoAddressRow {
	address: string;
	project: string;
	currency: string;
	derivation_index: number;
	wallet_key: string | null;
	wallet_account: number | null;
	invoice: string | null;
	transaction_id: string | null;
	label: string | null;
	monitored: number;
	balance: number;
	total_received: number;
	expected_amount: number | null;
	exchange_rate: number | null;
	invoice_currency: string | null;
	last_checked: number | null;
	created: number;
	expires_at: number | null;
}

export interface Session {
	username: string;
	ip: string;
	created: number;
}

export interface AppState extends Record<string, unknown> {
	customerSession?: { email: string; ip: string; created: number };
	customerSessionToken?: string;
	account?: AccountRow;
	session?: Session;
	sessionToken?: string;
	project?: ProjectRow;
	member?: ProjectMemberRow;
	apiKeySlot?: "primary" | "secondary";
}

export interface ExpenseRow {
	uuid: string;
	project: string;
	description: string;
	supplier: string | null;
	supplier_tax_number: string | null;
	supplier_country: string | null;
	invoice_number: string | null;
	category: string;
	currency: string;
	total_amount: number;
	tax_amount: number;
	deductible_tax_amount: number;
	expense_date: number;
	issue_date: number | null;
	receipt_date: number | null;
	supply_date: number | null;
	due_date: number | null;
	vat_treatment: string;
	asset_type: string;
	vat_handling: string;
	provisional_share: number;
	self_assessment_period: string | null;
	self_assessment_tax: number | null;
	tax_exchange_rate: number | null;
	tax_rate_date: number | null;
	paid_at: number | null;
	notes: string | null;
	recurring: string | null;
	occurrence: number | null;
	created_by: string | null;
	created: number;
	updated: number;
}

export interface ExpenseVatLineRow {
	uuid: string;
	expense: string;
	rate: number;
	tax_base: number;
	tax_amount: number;
	deductible_tax_amount: number;
	sort_order: number;
}

export interface ExpenseAttachmentRow {
	expense: string;
	storage_key: string;
	file_name: string;
	content_type: string;
	byte_size: number;
	sha256: string;
	created: number;
}

export interface DdvExportRow {
	uuid: string;
	project: string;
	period_from: number;
	period_to: number;
	revision: number;
	file_name: string;
	storage_key: string;
	byte_size: number;
	sha256: string;
	created_by: string | null;
	created: number;
}

export interface AccountingPeriodLockRow {
	uuid: string;
	project: string;
	period_from: number;
	period_to: number;
	timezone: string;
	source: "ddv_export";
	source_id: string;
	locked_by: string | null;
	locked_at: number;
	unlocked_by: string | null;
	unlocked_at: number | null;
	unlock_reason: string | null;
}

export interface RecurringExpenseRow extends Omit<
	ExpenseRow,
	| "expense_date"
	| "paid_at"
	| "recurring"
	| "occurrence"
	| "invoice_number"
	| "issue_date"
	| "receipt_date"
	| "supply_date"
	| "due_date"
	| "vat_handling"
	| "self_assessment_period"
	| "self_assessment_tax"
	| "tax_exchange_rate"
	| "tax_rate_date"
> {
	interval_unit: string;
	interval_count: number;
	anchor_date: number;
	anchor_occurrence: number;
	occurrences: number;
	next_run_at: number | null;
	end_date: number | null;
	max_occurrences: number | null;
	auto_paid: number;
	status: "active" | "paused" | "completed" | "canceled";
}

export interface StoreLanguageRow {
	project: string;
	language: string;
	name: string;
	enabled: number;
	strings: string;
	content: string;
	created: number;
	updated: number;
}

export interface StoreProductTranslationRow {
	item: string;
	language: string;
	project: string;
	name: string | null;
	summary: string | null;
	description: string | null;
	updated: number;
}

export interface StoreCategoryTranslationRow {
	store_category: string;
	language: string;
	project: string;
	name: string | null;
	description: string | null;
	updated: number;
}

export interface StoreSettingsRow {
	project: string;
	slug: string;
	domain: string | null;
	enabled: number;
	config: string;
	created: number;
	updated: number;
}

export type StoreDomainProvider = "manual" | "burrowgate" | "cloudflare";
export type StoreDomainStatus = "pending" | "provisioning" | "active" | "error";

export interface StoreDomainRow {
	project: string;
	hostname: string;
	provider: StoreDomainProvider;
	status: StoreDomainStatus;
	provider_hostname_id: string | null;
	gateway_site_id: string | null;
	verification_records: string;
	last_error: string | null;
	created: number;
	updated: number;
	activated: number | null;
}

export interface StoreCategoryRow {
	uuid: string;
	project: string;
	parent_category: string | null;
	slug: string;
	name: string;
	description: string | null;
	sort_order: number;
	created: number;
	updated: number;
}

export interface StoreProductRow {
	item: string;
	project: string;
	store_category: string | null;
	slug: string;
	name: string | null;
	published: number;
	featured: number;
	summary: string | null;
	description: string | null;
	compare_price: number | null;
	stock: number | null;
	allow_backorder: number;
	delivery_min_days: number | null;
	delivery_max_days: number | null;
	restock_at: number | null;
	sort_order: number;
	created: number;
	updated: number;
}

export interface StoreAttributeRow {
	uuid: string;
	project: string;
	item: string;
	attribute: string;
	attribute_value: string;
	sort_order: number;
}

export type StoreImageKind = "product" | "logo" | "hero";

export interface StoreImageRow {
	uuid: string;
	project: string;
	item: string | null;
	kind: StoreImageKind;
	storage_key: string;
	content_type: string;
	byte_size: number;
	sha256: string;
	alt: string | null;
	sort_order: number;
	created: number;
}

export type StoreFulfillment = "pending" | "processing" | "shipped" | "delivered" | "canceled";

export interface StoreOrderRow {
	invoice: string;
	project: string;
	email: string;
	fulfillment: StoreFulfillment;
	shipping_method: string | null;
	shipping_address: string | null;
	note: string | null;
	tracking_url: string | null;
	stock_returned: number;
	number: string | null;
	created: number;
	updated: number;
}

export type StoreCouponKind = "percent" | "amount" | "free_shipping";

export interface StoreCouponRow {
	uuid: string;
	project: string;
	code: string;
	kind: StoreCouponKind;
	amount: number;
	minimum: number | null;
	starts_at: number | null;
	ends_at: number | null;
	max_uses: number | null;
	once_per_customer: number;
	enabled: number;
	uses: number;
	note: string | null;
	created: number;
	updated: number;
}

export interface StoreCouponRedemptionRow {
	invoice: string;
	coupon: string;
	project: string;
	email: string;
	discount: number;
	created: number;
}

export interface CustomerProfileRow {
	email: string;
	customer_type: string | null;
	name: string | null;
	company: string | null;
	phone: string | null;
	vat_number: string | null;
	tax_number: string | null;
	address_line1: string | null;
	address_line2: string | null;
	postal_code: string | null;
	city: string | null;
	state: string | null;
	country: string | null;
	shipping_same: number;
	shipping_name: string | null;
	shipping_phone: string | null;
	shipping_address_line1: string | null;
	shipping_address_line2: string | null;
	shipping_postal_code: string | null;
	shipping_city: string | null;
	shipping_state: string | null;
	shipping_country: string | null;
	updated: number;
}

export interface WorkforceSettingsRow {
	project: string;
	config: string;
	updated: number;
}

export interface WorkforceHolidayRow {
	uuid: string;
	project: string;
	holiday_date: string;
	name: string;
	created: number;
}

export type EmploymentType = "full_time" | "part_time" | "student" | "contractor";

export type PayType = "monthly" | "hourly";

export interface EmployeeRow {
	member: string;
	project: string;
	employee_number: string | null;
	job_title: string | null;
	employment_type: EmploymentType;
	started_on: string | null;
	ended_on: string | null;
	prior_service_months: number;
	weekly_minutes: number;
	vacation_days: number;
	pay_type: PayType;
	private_data: string | null;
	workforce_settings: string | null;
	created: number;
	updated: number;
}

export interface LeaveBalanceRow {
	member: string;
	year: number;
	entitled_days: number | null;
	carried_days: number;
	updated: number;
}

export type TimeEntryKind = "regular" | "overtime" | "break";

export interface TimeEntryRow {
	uuid: string;
	project: string;
	member: string | null;
	person: string;
	work_date: string;
	start_minute: number;
	end_minute: number;
	break_minutes: number;
	kind: TimeEntryKind;
	remote: number;
	ticket: string | null;
	note: string | null;
	invoice: string | null;
	created_by: string | null;
	updated_by: string | null;
	created: number;
	updated: number;
}

export type AbsenceKind = "vacation" | "sick" | "injury" | "paid_leave" | "unpaid" | "parental" | "other";

export type AbsenceStatus = "pending" | "approved" | "rejected" | "canceled";

export interface AbsenceRow {
	uuid: string;
	project: string;
	member: string | null;
	person: string;
	kind: AbsenceKind;
	starts_on: string;
	ends_on: string;
	minutes_per_day: number | null;
	status: AbsenceStatus;
	note: string | null;
	decided_by: string | null;
	decided_at: number | null;
	decision_note: string | null;
	created_by: string | null;
	created: number;
	updated: number;
}

export type TicketKind = "task" | "bug" | "feature" | "support";

export type TicketStatus = "open" | "in_progress" | "waiting" | "resolved" | "closed";

export type TicketPriority = "low" | "normal" | "high" | "urgent";

export interface TicketRow {
	uuid: string;
	project: string;
	number: number;
	title: string;
	description: string | null;
	kind: TicketKind;
	status: TicketStatus;
	priority: TicketPriority;
	customer: string | null;
	customer_visible: number;
	estimate_minutes: number | null;
	hourly_rate: number | null;
	due_on: string | null;
	created_by: string | null;
	reported_by: string | null;
	closed_at: number | null;
	created: number;
	updated: number;
}

export interface TicketCommentRow {
	uuid: string;
	ticket: string;
	author: string | null;
	author_email: string | null;
	author_name: string;
	body: string;
	internal: number;
	created: number;
	updated: number;
}

export interface TicketPortalAccessRow {
	customer: string;
	project: string;
	kinds: string;
	updated: number;
}

export interface WorkforceRevisionRow {
	uuid: string;
	project: string;
	member: string | null;
	record_type: "time_entry" | "absence";
	record: string;
	operation: "created" | "updated" | "deleted" | "approved" | "rejected" | "canceled";
	old_value: string | null;
	new_value: string | null;
	changed_by: string | null;
	reason: string | null;
	created: number;
}

export interface PayrollRatesRow {
	uuid: string;
	project: string;
	period: string;
	config: string;
	verified_by: string | null;
	verified_at: number | null;
	created: number;
	updated: number;
}

export interface PayrollRunRow {
	uuid: string;
	project: string;
	period: string;
	status: "draft" | "final";
	pay_date: string | null;
	rates_period: string | null;
	created_by: string | null;
	finalized_by: string | null;
	finalized_at: number | null;
	created: number;
	updated: number;
}

export interface PayrollLineRow {
	uuid: string;
	run: string;
	member: string | null;
	person: string;
	items: string;
	calculation: string;
	created: number;
	updated: number;
}

export type AccountKind = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface LedgerAccountRow {
	uuid: string;
	project: string;
	code: string;
	name: string;
	account_kind: AccountKind;
	system_key: string | null;
	iban: string | null;
	active: number;
	created: number;
	updated: number;
}

export interface LedgerCategoryAccountRow {
	project: string;
	expense_category: string;
	ledger_account: string;
	updated: number;
}

export type JournalSourceType =
	| "invoice"
	| "credit_note"
	| "payment"
	| "refund"
	| "expense"
	| "expense_payment"
	| "recorded_invoice"
	| "recorded_payment"
	| "bank_transaction"
	| "depreciation"
	| "asset_disposal"
	| "payroll"
	| "deductible_share"
	| "year_result"
	| "year_closing"
	| "year_opening"
	| "manual";

export interface JournalEntryRow {
	uuid: string;
	project: string;
	year: number;
	number: number;
	entry_date: number;
	description: string;
	source_type: JournalSourceType;
	source_id: string;
	reverses: string | null;
	fingerprint: string;
	posted_by: string | null;
	created: number;
}

export interface JournalLineRow {
	uuid: string;
	entry: string;
	project: string;
	ledger_account: string;
	debit: number;
	credit: number;
	partner: string | null;
	sort_order: number;
}

export interface RecordedInvoiceRow {
	uuid: string;
	project: string;
	document_type: "invoice" | "credit_note";
	reference: string;
	buyer_name: string;
	buyer_vat_number: string | null;
	buyer_country: string | null;
	currency: string;
	tax_currency: string;
	tax_exchange_rate: number | null;
	tax_rate_date: number | null;
	issued_at: number;
	supply_date: number | null;
	due_date: number | null;
	paid_at: number | null;
	payment_account: "bank" | "cash";
	subtotal: number;
	tax_amount: number;
	total_amount: number;
	notes: string | null;
	created_by: string | null;
	created: number;
	updated: number;
}

export interface RecordedInvoiceLineRow {
	uuid: string;
	recorded_invoice: string;
	tax_rate: number;
	tax_treatment: string;
	net_amount: number;
	tax_amount: number;
	sort_order: number;
}

export interface BankStatementRow {
	uuid: string;
	project: string;
	iban: string;
	statement_id: string;
	currency: string;
	period_from: number | null;
	period_to: number | null;
	opening_balance: number | null;
	closing_balance: number | null;
	file_name: string | null;
	created_by: string | null;
	created: number;
}

export type BankTransactionStatus = "open" | "matched" | "booked" | "ignored";
export type BankMatchType = "invoice" | "recorded_invoice" | "expense";

export interface BankTransactionRow {
	uuid: string;
	project: string;
	statement: string;
	booking_date: number;
	value_date: number | null;
	amount: number;
	currency: string;
	counterparty_name: string | null;
	counterparty_iban: string | null;
	reference: string | null;
	remittance: string | null;
	bank_reference: string | null;
	fingerprint: string;
	status: BankTransactionStatus;
	match_type: BankMatchType | null;
	match_id: string | null;
	ledger_account: string | null;
	payment_transaction: string | null;
	matched_by: string | null;
	matched_at: number | null;
	created: number;
}

export interface BankTransactionMatchRow {
	uuid: string;
	project: string;
	bank_transaction: string;
	match_type: BankMatchType;
	match_id: string;
	amount: number;
	payment_transaction: string | null;
	created: number;
}

export interface RecordedInvoiceAttachmentRow {
	recorded_invoice: string;
	storage_key: string;
	file_name: string;
	content_type: string;
	byte_size: number;
	sha256: string;
	created: number;
}

export interface AccountingYearRow {
	uuid: string;
	project: string;
	year: number;
	closed_by: string | null;
	closed_at: number;
	reopened_by: string | null;
	reopened_at: number | null;
	reopen_reason: string | null;
}

export type AssetCategory = "intangible" | "building" | "equipment" | "computer" | "small_inventory";

export interface FixedAssetRow {
	uuid: string;
	project: string;
	name: string;
	asset_category: AssetCategory;
	expense: string | null;
	acquired_at: number;
	depreciation_from: number;
	acquisition_value: number;
	accumulated_before: number;
	annual_rate: number;
	disposed_at: number | null;
	notes: string | null;
	created_by: string | null;
	created: number;
	updated: number;
}

export type Bookkeeping = "company" | "sole_double" | "sole_simplified" | "sole_flat_rate";
