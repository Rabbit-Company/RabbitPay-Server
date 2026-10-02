import type { ExpenseRow, RecurringExpenseRow } from "../../server/database/models";
import type { ExpenseInput, ExpenseScheduleInput, ExpenseVatLineInput } from "../../server/expense-types";
import type { FinancialReport } from "../../server/expense-types";
import type { DdvEvidenceResult, DdvExportOptions } from "../../server/ddv-evidence";
import type { GeneratedReport, ReportState } from "../../server/report-types";
import type { StoreConfig, StorePage } from "../../server/store/config";
import type { InvoiceDesign } from "../../server/invoice-design";
import type { ReferenceDocument, ReferenceDocumentColumns, ReferenceDocumentInput } from "../../server/reference-document";
import type { LicenseProduct } from "../../server/license-pricing";
import type { SigningCertificateSummary } from "../../server/einvoice-signing";
import type { SecurityKeyCreationOptions, SecurityKeyRequestOptions } from "./webauthn";

export interface EslogVersion extends ReferenceDocumentColumns {
	version: number;
	signed: boolean;
	byte_size: number;
	sha256: string;
	created: number;
}
import type { CustomerEmailKind, EmailDesign, EmailTexts } from "../../server/email-design";
export type { InvoiceDesign };
import type { StoreFulfillment } from "../../server/database/models";
export type { StoreConfig, StoreFulfillment };

export interface StoreState {
	license: { enforced: boolean; active: boolean; until: number | null };
	exists: boolean;
	enabled: boolean;
	slug: string;
	domain: string | null;
	url: string;
	domain_url: string | null;
	config: StoreConfig;
	templates: StorePage[];
	languages: { code: string; name: string; builtin: boolean }[];
	images: { logo: string | null; hero: string | null };
	stats: { products: number; published: number; orders: number; to_ship: number };
}

export interface StoreDomainState {
	available: boolean;
	target: string;
	domain: {
		hostname: string;
		status: "pending" | "provisioning" | "active" | "error";
		records: { type: "TXT" | "CNAME"; name: string; value: string }[];
		created: number;
		activated: number | null;
	} | null;
}

export interface StoreLanguage {
	code: string;
	name: string;
	builtin: boolean;
	enabled: boolean;
	strings: Record<string, string>;
	content: Record<string, string>;
	updated: number | null;
}

export interface ProductText {
	name: string | null;
	summary: string | null;
	description: string | null;
}

export interface CategoryText {
	name: string | null;
	description: string | null;
}

export interface StoreLanguages {
	default: string;
	languages: StoreLanguage[];
}

export interface StoreCategory {
	uuid: string;
	name: string;
	slug: string;
	description: string | null;
	parent: string | null;
	sort_order: number;
	products: number;
	translations: Record<string, CategoryText>;
}

export type StoreCouponKind = "percent" | "amount" | "free_shipping";

export interface StoreCoupon {
	uuid: string;
	code: string;
	kind: StoreCouponKind;
	amount: number;
	minimum: number | null;
	starts_at: number | null;
	ends_at: number | null;
	max_uses: number | null;
	once_per_customer: boolean;
	enabled: boolean;
	uses: number;
	discount_total: number;
	note: string | null;
	created: number;
	updated: number;
}

export type StoreCouponInput = Omit<StoreCoupon, "uuid" | "uses" | "discount_total" | "created" | "updated">;

export interface StoreCategoryInput {
	name?: string;
	slug?: string;
	description?: string | null;
	parent?: string | null;
	sort_order?: number;
	translations?: Record<string, CategoryText>;
}

export interface StoreListedProduct {
	uuid: string;
	name: string;
	sku: string | null;
	unit_price: number;
	currency: string;
	tax_rate: number;
	supply_type: string;
	delivers_keys: boolean;
	license: boolean;
	store_name: string | null;
	listed: boolean;
	slug: string | null;
	published: boolean;
	featured: boolean;
	category: string | null;
	summary: string | null;
	stock: number | null;
	image: string | null;
}

export interface StoreImage {
	uuid: string;
	url: string;
	alt: string | null;
	byte_size: number;
}

export interface StoreAttribute {
	name: string;
	value: string;
}

export interface StoreProductDetails {
	item: {
		uuid: string;
		name: string;
		sku: string | null;
		unit_price: number;
		currency: string;
		tax_rate: number;
		tax_category: string;
		supply_type: string;
		delivers_keys: boolean;
		license: boolean;
		archived: boolean;
		keys_available: number | null;
	};
	listed: boolean;
	name: string | null;
	slug: string;
	published: boolean;
	featured: boolean;
	category: string | null;
	summary: string | null;
	description: string | null;
	compare_price: number | null;
	stock: number | null;
	allow_backorder: boolean;
	delivery_min_days: number | null;
	delivery_max_days: number | null;
	restock_at: number | null;
	sort_order: number;
	attributes: StoreAttribute[];
	images: StoreImage[];
	translations: Record<string, ProductText>;
}

export type StoreProductInput = Omit<StoreProductDetails, "item" | "listed" | "images">;

export interface StoreAddress {
	name: string | null;
	phone: string | null;
	address_line1: string | null;
	address_line2: string | null;
	postal_code: string | null;
	city: string | null;
	state: string | null;
	country: string | null;
}

export interface StoreOrder {
	invoice: string;
	reference: string;
	number: string;
	invoice_reference: string | null;
	email: string;
	customer_name: string | null;
	fulfillment: StoreFulfillment;
	payment_status: string;
	currency: string;
	total_amount: number;
	outstanding: number;
	due_date: number;
	shipping_method: string | null;
	shipping_address: StoreAddress | null;
	note: string | null;
	tracking_url: string | null;
	coupon: { code: string; discount: number } | null;
	created: number;
	updated: number;
	items: { description: string; quantity: number; item: string | null; total: number }[] | null;
}
export type { GeneratedReport, ReportState };
export interface ExpenseImportPreview {
	expense: ExpenseInput;
	invoice: { format: "eslog" | "ubl"; number: string; currency: string; gross_total: number };
	warnings: { code: string; message: string }[];
	duplicate: string | null;
}

export type Expense = ExpenseRow & {
	vat_lines: (ExpenseVatLineInput & { uuid: string; expense: string; sort_order: number })[];
	attachment: { file_name: string; content_type: string; byte_size: number; sha256: string; created: number } | null;
};
export type ExpenseSchedule = Omit<RecurringExpenseRow, "auto_paid"> & { auto_paid: boolean };
export type { ExpenseInput, ExpenseScheduleInput, FinancialReport };
export type { DdvEvidenceResult, DdvExportOptions };

export interface DdvExport {
	uuid: string;
	period_from: number;
	period_to: number;
	revision: number;
	file_name: string;
	byte_size: number;
	sha256: string;
	created_by: string | null;
	created: number;
}

export interface AccountingPeriodLock {
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
	active: boolean;
}
import Blake2b from "@rabbit-company/blake2b";
import type { CustomerStats } from "../../server/customer-stats";
import type { SaleLineInput, SalesSummary } from "../../server/pos-sale";

export type { CustomerStats, SaleLineInput, SalesSummary };

const TOKEN_KEY = "rabbitpay.token";
const USERNAME_KEY = "rabbitpay.username";
const ADMIN_KEY = "rabbitpay.admin";

export interface ApiResult<T = unknown> {
	ok: boolean;
	status: number;
	error: number;
	info: string;
	data: T;
}

export class ApiError extends Error {
	readonly code: number;
	readonly status: number;

	constructor(
		code: number,
		status: number,
		info: string,
		public readonly data?: unknown
	) {
		super(info);
		this.code = code;
		this.status = status;
	}
}

let onUnauthorized: () => void = () => {};

export function setUnauthorizedHandler(handler: () => void) {
	onUnauthorized = handler;
}

export function hashPassword(password: string): string {
	return Blake2b.hash(password);
}

export function getToken(): string | null {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
}

export function getUsername(): string | null {
	try {
		return localStorage.getItem(USERNAME_KEY);
	} catch {
		return null;
	}
}

export function isAdmin(): boolean {
	try {
		return localStorage.getItem(ADMIN_KEY) === "1";
	} catch {
		return false;
	}
}

export function storeSession(token: string, username: string, admin: boolean) {
	try {
		localStorage.setItem(TOKEN_KEY, token);
		localStorage.setItem(USERNAME_KEY, username);
		localStorage.setItem(ADMIN_KEY, admin ? "1" : "0");
	} catch {
		void 0;
	}
}

export function clearSession() {
	try {
		localStorage.removeItem(TOKEN_KEY);
		localStorage.removeItem(USERNAME_KEY);
		localStorage.removeItem(ADMIN_KEY);
	} catch {
		void 0;
	}
}

const SESSION_ERRORS = new Set([1000, 1016, 1017, 1026]);

export function newRequestKey(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function outcomeUnknown(error: unknown): boolean {
	return error instanceof ApiError && error.code < 0;
}

async function send(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
	const headers: Record<string, string> = { ...extraHeaders };
	const token = getToken();
	if (token) headers["Authorization"] = `Bearer ${token}`;
	if (body !== undefined) headers["Content-Type"] = "application/json";

	try {
		return await fetch(`/api/v1${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch {
		throw new ApiError(-1, 0, "Could not reach the server.");
	}
}

async function payloadOf<T>(response: Response): Promise<T> {
	let payload: { error: number; info: string; data?: unknown };
	try {
		payload = await response.json();
	} catch {
		throw new ApiError(-1, response.status, "The server returned an unreadable response.");
	}

	if (payload.error !== 0) {
		if (SESSION_ERRORS.has(payload.error)) {
			clearSession();
			onUnauthorized();
		}
		throw new ApiError(payload.error, response.status, payload.info, payload.data);
	}

	return payload.data as T;
}

async function request<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
	return await payloadOf<T>(await send(method, path, body, headers));
}

function filenameOf(disposition: string | null, fallback: string): string {
	const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i);
	if (encoded) {
		try {
			return decodeURIComponent(encoded[1]);
		} catch {
			void 0;
		}
	}
	return disposition?.match(/filename="([^"]+)"/i)?.[1] ?? fallback;
}

async function requestFile(path: string, fallbackName: string): Promise<{ blob: Blob; name: string }> {
	const response = await send("GET", path);
	if (!response.ok || response.headers.get("Content-Type")?.includes("application/json")) {
		await payloadOf<never>(response);
		throw new ApiError(-1, response.status, "The server returned an unreadable response.");
	}
	return { blob: await response.blob(), name: filenameOf(response.headers.get("Content-Disposition"), fallbackName) };
}

async function requestDownload(path: string, fallbackName: string): Promise<{ blob: Blob; name: string }> {
	const response = await send("GET", path);
	const disposition = response.headers.get("Content-Disposition");
	if (!response.ok || !disposition) {
		await payloadOf<never>(response);
		throw new ApiError(-1, response.status, "The server returned an unreadable response.");
	}
	return { blob: await response.blob(), name: filenameOf(disposition, fallbackName) };
}

export interface Account {
	username: string;
	email: string;
	status: string;
	admin: boolean;
	two_factor_enabled: boolean;
	authenticator_enabled: boolean;
	security_keys: SecurityKey[];
	pending_terms: number | null;
	upcoming_terms: { version: number; effective: number } | null;
	projects: number;
	created: number;
	accessed: number;
}

export type LegalKind = "terms" | "privacy";

export interface LegalOperator {
	name: string;
	address: string | null;
	register: string | null;
	registration_number: string | null;
	tax_number: string | null;
	vat_status: "not_registered" | "registered";
	vat_number: string | null;
	email: string | null;
	phone: string | null;
}

export interface LegalDocument {
	kind: LegalKind;
	version: number;
	content_en: string | null;
	content_sl: string | null;
	published: number;
	effective: number;
}

export type LegalVersions = Record<LegalKind, number[]>;

export interface LegalInfo {
	operator: LegalOperator | null;
	business_only: boolean;
	terms: LegalDocument | null;
	privacy: LegalDocument | null;
	upcoming_terms: LegalDocument | null;
	upcoming_privacy: LegalDocument | null;
	required_versions: LegalVersions;
}

export interface LegalAcceptance {
	accept_terms: true;
	legal_versions: LegalVersions;
}

export interface DeletionPlan {
	shared: { uuid: string; name: string }[];
	closing: { uuid: string; name: string }[];
}

export interface AdminLegal {
	operator: LegalOperator | null;
	business_only: boolean;
	accounts: number;
	email_enabled: boolean;
	documents: Record<
		LegalKind,
		{
			latest: LegalDocument | null;
			versions: { version: number; published: number; effective: number; upcoming: boolean; published_by: string | null; accepted: number }[];
		}
	>;
}

export interface SecurityKey {
	uuid: string;
	name: string;
	created: number;
	last_used: number | null;
}

export type SecondFactor = { code: string } | { credential: unknown };

export interface SecondFactorChallenge {
	authenticator: boolean;
	webauthn: SecurityKeyRequestOptions | null;
}

export interface TwoFactorSetup {
	secret: string;
	uri: string;
	qr_svg: string;
	expires_in: number;
}

export interface RecoveryCodes {
	recovery_codes: string[];
}

import type { WorkforceConfig, WorkforceOverrides } from "../../server/workforce/config";
import type {
	AbsenceKind,
	AbsenceStatus,
	EmploymentType,
	PayType,
	TicketKind,
	TicketPriority,
	TicketStatus,
	TimeEntryKind,
} from "../../server/database/models";
export type {
	AbsenceKind,
	AbsenceStatus,
	EmploymentType,
	PayType,
	TicketKind,
	TicketPriority,
	TicketStatus,
	TimeEntryKind,
	WorkforceConfig,
	WorkforceOverrides,
};

export interface WorkforcePerson {
	member: string;
	name: string;
	username: string | null;
	role: string;
	status: string;
	daily_minutes: number;
	edit_days: number;
	paid_break_minutes: number;
	employee: {
		employee_number: string | null;
		job_title: string | null;
		employment_type: EmploymentType;
		started_on: string | null;
		ended_on: string | null;
	} | null;
}

export interface WorkforceState {
	license: {
		enforced: boolean;
		active: boolean;
		until: number | null;
		seats_exceeded: boolean;
		employees_used: number;
		employees_limit: number | null;
	};
	config: WorkforceConfig;
	today: string;
	me: {
		member: string;
		name: string;
		daily_minutes: number;
		edit_days: number;
		paid_break_minutes: number;
		own: boolean;
		view: boolean;
		edit: boolean;
	};
	people: WorkforcePerson[];
}

export interface WorkforceHoliday {
	date: string;
	name: { en: string; sl: string };
	work_free: boolean;
	uuid: string | null;
	source: "national" | "project";
}

export interface TimeEntry {
	uuid: string;
	member: string | null;
	person: string;
	work_date: string;
	start: string;
	end: string;
	overnight: boolean;
	break_minutes: number;
	worked_minutes: number;
	kind: TimeEntryKind;
	remote: boolean;
	ticket: string | null;
	note: string | null;
	invoice: string | null;
	created_by: string | null;
	updated_by: string | null;
	created: number;
	updated: number;
}

export interface TimesheetDayEntry {
	uuid?: string;
	start: string;
	end: string;
	kind: TimeEntryKind;
	remote: boolean;
	ticket: string | null;
	note: string | null;
}

export interface TimesheetDay {
	work_date: string;
	member: string;
	entries: TimeEntry[];
}

export interface TicketReference {
	uuid: string;
	number: number;
	title: string;
	status: TicketStatus;
}

export interface Timesheet {
	from: string;
	to: string;
	member: string | null;
	today: string;
	edit_days: number;
	entries: TimeEntry[];
	tickets: TicketReference[];
}

export interface Absence {
	uuid: string;
	member: string | null;
	person: string;
	kind: AbsenceKind;
	starts_on: string;
	ends_on: string;
	minutes_per_day: number | null;
	working_days: number | null;
	status: AbsenceStatus;
	note: string | null;
	decided_by: string | null;
	decided_at: number | null;
	decision_note: string | null;
	created_by: string | null;
	created: number;
	updated: number;
}

export interface AbsenceInput {
	member?: string;
	kind?: AbsenceKind;
	starts_on?: string;
	ends_on?: string;
	minutes_per_day?: number | null;
	note?: string | null;
}

export interface VacationBalance {
	member: string;
	year: number;
	entitled_days: number;
	carried_days: number;
	approved_days: number;
	taken_days: number;
	pending_days: number;
	remaining_days: number;
}

export interface WorkforceRevision {
	uuid: string;
	member: string | null;
	record_type: "time_entry" | "absence";
	record: string;
	operation: string;
	old_value: Record<string, unknown> | null;
	new_value: Record<string, unknown> | null;
	changed_by: string | null;
	reason: string | null;
	created: number;
}

export interface ReportDay {
	date: string;
	weekday: number;
	holiday: { name: { en: string; sl: string }; work_free: boolean } | null;
	working_day: boolean;
	employed: boolean;
	worked_minutes: number;
	overtime_minutes: number;
	night_minutes: number;
	break_minutes: number;
	entries: number;
	shifts: string[];
	absences: { uuid: string; kind: AbsenceKind; status: AbsenceStatus; minutes: number; case_day: number }[];
}

export interface MonthTotals {
	fund_minutes: number;
	worked_minutes: number;
	overtime_minutes: number;
	night_minutes: number;
	sunday_minutes: number;
	holiday_work_minutes: number;
	holiday_minutes: number;
	absence_minutes: Record<AbsenceKind, number>;
	days_worked: number;
	meal_days: number;
	balance_minutes: number;
}

export interface MonthReport {
	month: string;
	from: string;
	to: string;
	people: { member: string; person: string; daily_minutes: number; days: ReportDay[]; totals: MonthTotals }[];
}

export interface TicketAssignee {
	member: string;
	name: string;
	full_name: string | null;
}

export interface Ticket {
	uuid: string;
	number: number;
	title: string;
	description: string | null;
	kind: TicketKind;
	status: TicketStatus;
	priority: TicketPriority;
	customer: string | null;
	customer_name: string | null;
	customer_visible: boolean;
	estimate_minutes: number | null;
	hourly_rate: number | null;
	due_on: string | null;
	assignees: TicketAssignee[];
	logged_minutes: number;
	uninvoiced_minutes: number;
	created_by: string | null;
	reported_by: string | null;
	closed_at: number | null;
	created: number;
	updated: number;
}

export interface TicketComment {
	uuid: string;
	author: string | null;
	author_email: string | null;
	author_name: string;
	from_customer: boolean;
	body: string;
	internal: boolean;
	created: number;
	updated: number;
}

export interface TicketDetails extends Ticket {
	comments: TicketComment[];
	time_by_person: { person: string; minutes: number }[];
}

export interface TicketInput {
	title?: string;
	description?: string | null;
	kind?: TicketKind;
	status?: TicketStatus;
	priority?: TicketPriority;
	customer?: string | null;
	customer_visible?: boolean;
	estimate_minutes?: number | null;
	hourly_rate?: number | null;
	due_on?: string | null;
	assignees?: string[];
}

export interface EmployeePrivate {
	salary: number | null;
	commute_per_day: number | null;
	personal_id: string | null;
	tax_number: string | null;
	birth_date: string | null;
	address: string | null;
	iban: string | null;
	phone: string | null;
	private_email: string | null;
	emergency_contact: string | null;
	notes: string | null;
	dependents: number;
	claims_general_relief: boolean;
	commute_km: number | null;
	secondary_employer: boolean;
}

export interface EmployeeRecord {
	member: string;
	employee_number: string | null;
	job_title: string | null;
	employment_type: EmploymentType;
	started_on: string | null;
	ended_on: string | null;
	prior_service_months: number;
	weekly_minutes: number;
	vacation_days: number;
	pay_type: PayType;
	workforce_settings: WorkforceOverrides;
	private: EmployeePrivate;
	created: number;
	updated: number;
}

export interface EmployeeListing extends WorkforcePerson {
	record: EmployeeRecord | null;
}

export interface EmployeeInput {
	employee_number?: string | null;
	job_title?: string | null;
	employment_type?: EmploymentType;
	started_on?: string | null;
	ended_on?: string | null;
	prior_service_months?: number;
	weekly_minutes?: number;
	vacation_days?: number;
	pay_type?: PayType;
	workforce_settings?: WorkforceOverrides;
	private?: Partial<EmployeePrivate>;
}

export interface PayrollLine {
	member: string;
	person: string;
	employment_type: EmploymentType;
	pay_type: PayType;
	salary: number | null;
	hourly_rate: number | null;
	minutes: Record<
		"worked" | "overtime" | "holiday" | "vacation" | "paid_leave" | "sick_employer" | "sick_insurance" | "unpaid" | "night" | "sunday" | "holiday_work",
		number
	>;
	amounts: Record<
		| "regular"
		| "overtime"
		| "holidays"
		| "leave"
		| "sick"
		| "overtime_supplement"
		| "night_supplement"
		| "sunday_supplement"
		| "holiday_supplement"
		| "seniority"
		| "gross"
		| "meal"
		| "commute"
		| "reimbursements",
		number
	>;
}

import type { PayrollRates } from "../../server/workforce/net-pay";
import type { PayrollCalculation, PayrollItem } from "../../server/workforce/payroll-runs";
import type { AccountLedgerRow, JournalEntryView, LedgerIssue, TrialBalanceRow } from "../../server/accounting/types";
import type { LedgerAccountRow, RecordedInvoiceLineRow, RecordedInvoiceRow } from "../../server/database/models";
import type { RecordedInvoiceInput } from "../../server/accounting/types";

export type RecordedInvoice = RecordedInvoiceRow & {
	lines: RecordedInvoiceLineRow[];
	attachment?: { file_name: string; content_type: string; byte_size: number; created: number } | null;
};
export type { RecordedInvoiceInput };
import type { ImportResult } from "../../server/accounting/recorded-import";
import type { ExpenseImportResult } from "../../server/expense-import";
export type { ExpenseImportResult };
export type { ImportColumn, ImportError, ImportResult } from "../../server/accounting/recorded-import";
import type {
	BankCandidate,
	BankMatchInput,
	BankSuggestion,
	OpenItem,
	OpenItemsKind,
	OpenItemsReport,
	PartnerOpenItems,
	RevaluationPreview,
} from "../../server/accounting/types";
export type { OpenItem, OpenItemsKind, OpenItemsReport, PartnerOpenItems };
import type { CompanyLookup } from "../../server/registry/lookup";
export type { CompanyLookup };
import type { BankStatementRow, BankTransactionMatchRow, BankTransactionRow } from "../../server/database/models";

export type BankTransaction = BankTransactionRow & { suggestions: BankSuggestion[]; matches: BankTransactionMatchRow[] };
export type { BankCandidate, BankMatchInput, RevaluationPreview };
export type BankStatement = BankStatementRow & { ledger_balance: number | null; lines: Partial<Record<BankTransactionRow["status"], number>> };
export type { BankSuggestion };
export type { AccountingYear, YearCloseRefusal } from "../../server/accounting/types";
import type { AccountingYear, AjpesReport, FinancialStatements, KpoBook } from "../../server/accounting/types";
export type { AjpesReport };
export type { KpoBook, KpoColumn } from "../../server/accounting/types";
import type { AssetCategory, FixedAssetRow } from "../../server/database/models";

export type FixedAsset = FixedAssetRow & { accumulated: number; book_value: number };
export type { AssetCategory };

export interface AssetCandidate {
	expense: string;
	name: string;
	supplier: string | null;
	acquired_at: number;
	value: number | null;
	categories: AssetCategory[];
}

export interface FixedAssetInput {
	name?: string;
	asset_category: AssetCategory;
	expense?: string | null;
	acquired_at?: number;
	acquisition_value?: number;
	accumulated_before?: number;
	depreciation_from?: number;
	annual_rate?: number;
	notes?: string | null;
}
export type { FinancialStatements, StatementLine } from "../../server/accounting/types";

export interface StatementPreview {
	statements: (Omit<BankStatementRow, "uuid" | "project" | "file_name" | "created_by" | "created"> & { transactions: number })[];
	new_lines: number;
	known_lines: number;
}

export type { AccountLedgerRow, JournalEntryView, LedgerIssue, TrialBalanceRow };

export type LedgerAccount = Omit<LedgerAccountRow, "active"> & { active: boolean };

export interface JournalPage {
	entries: JournalEntryView[];
	total: number;
	limit: number;
	offset: number;
	issues: LedgerIssue[];
}

export interface AccountingClient {
	uuid: string;
	name: string;
	display_name: string | null;
	role: string;
	accounting: boolean;
	accounting_until: number | null;
	entries_this_year: number;
	last_posted: number | null;
	unpaid_expenses: number;
	unattached_expenses: number;
	issues: number | null;
	open_bank_lines: number;
	unclosed_years: number[];
	ddv_submitted_until: number | null;
}

export type JournalQuery = {
	from: number;
	to: number;
	account?: string;
	source?: string;
	text?: string;
	amount?: number | null;
};

export interface ManualEntryInput {
	date: number;
	description: string;
	lines: { account: string; debit: number; credit: number; partner: string | null }[];
}

export type { PayrollCalculation, PayrollItem, PayrollRates };

export interface PayrollRatesTable {
	period: string;
	rates: PayrollRates;
	verified: boolean;
	verified_by: string | null;
	verified_at: number | null;
	updated: number;
}

export interface PayrollTotals {
	gross: number;
	extra_pay: number;
	employee_contributions: number;
	income_tax: number;
	health_flat: number;
	net: number;
	reimbursements: number;
	deductions: number;
	payout: number;
	employer_contributions: number;
	employer_cost: number;
}

export interface PayrollRunSummary {
	uuid: string;
	period: string;
	status: "draft" | "final";
	pay_date: string | null;
	rates_period: string | null;
	finalized_by: string | null;
	finalized_at: number | null;
	created: number;
	updated: number;
	people: number;
	totals: PayrollTotals;
}

export interface PayrollRunDetails extends Omit<PayrollRunSummary, "people"> {
	rates: { period: string; verified: boolean } | null;
	lines: { uuid: string; member: string | null; person: string; calculation: PayrollCalculation; updated: number }[];
}

export interface Project {
	uuid: string;
	name: string;
	display_name: string | null;
	public_name: string;
	role: string;
	webhook_url: string | null;
	currency: string;
	date_format: string;
	time_format: string;
	timezone: string;
	language: string;
	accent_color: string | null;
	tax_country: string | null;
	vat_status: string | null;
	oss_registered: boolean;
	tax_currency: string | null;
	vat_exemption_note: string | null;
	pos_custom_amounts: boolean;
	email_enabled: boolean;
	white_label: boolean;
	white_label_until: number | null;
	store: boolean;
	store_until: number | null;
	workforce: boolean;
	workforce_until: number | null;
	accounting: boolean;
	accounting_until: number | null;
	bookkeeping?: "company" | "sole_double" | "sole_simplified" | "sole_flat_rate";
	has_logo: boolean;
	custom_email_server: boolean;
	email_reminders: boolean;
	email_attach_invoice: boolean;
	email_attach_eslog: boolean;
	email_pay_link: boolean;
	email_portal_link: boolean;
	reminder_days_before: number;
	reminder_days_after: number;
	invoice_format: string;
	order_format: string;
	proforma_format: string;
	proforma_settlement: ProformaSettlement;
	invoice_issuer_details: boolean;
	permissions?: string[];
	status: string;
	created: number;
	updated: number;
	created_by: string;
	apikey?: string;
	apikey2?: string;
	stats?: { members: number; invoices: number; transactions: number; customers: number };
}

export interface Company {
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
}

export interface InvoiceNumbering {
	series: NumberSeries;
	bank_reference: boolean;
	format: string;
	period: "day" | "month" | "year" | "never";
	digits: number;
	capacity: number;
	next_number: number;
	next_reference: string | null;
	description: string;
}

export interface Branding {
	white_label: boolean;
	logo: string | null;
}

export type LicenseType = "transactions" | "white_label" | "storage" | "store" | "workforce" | "employees" | "accounting";

export interface License {
	uuid: string;
	code: string;
	type: LicenseType;
	transactions: number | null;
	duration_days: number | null;
	storage_gb: number | null;
	employees: number | null;
	status: "available" | "redeemed" | "revoked";
	price: number | null;
	currency: string | null;
	buyer_name: string | null;
	buyer_email: string | null;
	note: string | null;
	created_by: string | null;
	redeemed_project: string | null;
	redeemed_by: string | null;
	redeemed_at: number | null;
	starts_at: number | null;
	ends_at: number | null;
	revoked_at: number | null;
	server_id: string | null;
	signed_key: string | null;
	created: number;
	updated: number;
	project_name?: string | null;
}

export interface LicensePreview {
	type: LicenseType;
	transactions: number | null;
	duration_days: number | null;
	storage_gb: number | null;
	employees: number | null;
	timed: boolean;
	adds_up: boolean;
	running_until: number | null;
}

export interface LicenseInput {
	type?: LicenseType;
	transactions?: number;
	duration_days?: number;
	storage_gb?: number;
	employees?: number;
	quantity?: number;
	price?: number | null;
	currency?: string | null;
	buyer_name?: string | null;
	buyer_email?: string | null;
	note?: string | null;
	server_id?: string | null;
}

export interface LicenseIdentity {
	license_issuer: boolean;
	server_id: string;
}

export interface ProjectLicense extends LicenseIdentity {
	enforced: boolean;
	period: string;
	resets_at: number;
	free_allowance: number;
	free_used: number;
	paid_used: number;
	paid_balance: number;
	remaining: number | null;
	white_label: boolean;
	white_label_until: number | null;
	store: boolean;
	store_until: number | null;
	workforce: boolean;
	workforce_until: number | null;
	accounting: boolean;
	accounting_until: number | null;
	employees_included: number;
	employees_licensed: number;
	employees_used: number;
	employees_limit: number | null;
	employee_seats: { employees: number; from: number; until: number }[];
	storage_included: number;
	storage_licensed: number;
	storage_used: number;
	storage_limit: number | null;
	storage_remaining: number | null;
	storage_grants: { storage_gb: number; from: number; until: number }[];
	scheduled: { type: LicenseType; from: number; until: number }[];
	logo: string | null;
	licenses: License[];
}

export interface EmailServer {
	host: string;
	port: number;
	secure: boolean;
	username: string;
	from_address: string;
	password_set: boolean;
}

export interface EmailServerInput {
	host: string;
	port: number;
	secure: boolean;
	username: string;
	password?: string;
	from_address: string;
}

export type SettingValue = string | number | boolean;

export interface AdminSettings extends LicenseIdentity {
	values: Record<string, SettingValue>;
	secrets: Record<string, boolean>;
	defaults: Record<string, SettingValue>;
	master_key_configured: boolean;
	changed?: string[];
	restart_required?: string[];
}

export interface ConnectionStatus {
	network: string | null;
	height: number | null;
	warnings: string[];
}

export interface AdminBackups {
	supported: boolean;
	enabled: boolean;
	running: boolean;
	destinations: { target: string; backups: { name: string; created: number }[]; error?: string }[];
	problem: string | null;
}

export interface BackupResult {
	name: string;
	size: number;
	stored: string[];
	failed: { target: string; error: string }[];
}

export interface AdminOverview extends LicenseIdentity {
	period: string;
	accounts: number;
	projects: number;
	licenses_available: number;
	licenses_redeemed: number;
	payments_this_month: number;
	white_labeled: number;
	stores: number;
	revenue: { currency: string; amount: number; count: number }[];
}

export interface AdminProject {
	uuid: string;
	name: string;
	display_name: string | null;
	status: string;
	created: number;
	created_by: string;
	free_transactions: number | null;
	free_allowance: number;
	free_used: number;
	paid_used: number;
	paid_balance: number;
	remaining: number | null;
	white_label: boolean;
	white_label_until: number | null;
	store: boolean;
	store_until: number | null;
	workforce: boolean;
	workforce_until: number | null;
	accounting: boolean;
	accounting_until: number | null;
	storage_included: number;
	storage_licensed: number;
	storage_used: number;
	storage_limit: number | null;
	storage_remaining: number | null;
	storage_grants: { storage_gb: number; from: number; until: number }[];
}

export type RegistrationMode = "open" | "invite" | "closed";

export interface RegistrationInvite {
	uuid: string;
	code: string;
	max_uses: number | null;
	uses: number;
	expires_at: number | null;
	note: string | null;
	state: "active" | "used_up" | "expired" | "revoked";
	created_by: string | null;
	revoked_at: number | null;
	created: number;
	updated: number;
}

export interface AdminAccount {
	username: string;
	email: string;
	status: string;
	admin: boolean;
	two_factor_enabled: boolean;
	projects: number;
	created: number;
	accessed: number;
}

export interface BankInstruction {
	account: { iban: string; bic: string | null; holder: string; bank_name: string | null };
	reference: string;
	amount: number;
	currency: string;
	qr: { format: "epc" | "upn"; payload: string; encoding: "utf8" | "latin2" } | null;
	qr_unavailable: string | null;
}

export interface InvoiceDocument {
	kind: DocumentKind;
	proforma: { reference: string; settlement: ProformaSettlement; issued_at: number } | null;
	source_proforma: string | null;
	seller: Company & { name: string };
	buyer: {
		name: string | null;
		email: string;
		phone: string | null;
		address_line1: string | null;
		address_line2: string | null;
		postal_code: string | null;
		city: string | null;
		state: string | null;
		country: string | null;
		vat_number: string | null;
		tax_number?: string | null;
	} | null;
	invoice: {
		reference: string;
		status: string;
		currency: string;
		subtotal: number;
		discount_amount: number;
		tax_amount: number;
		total_amount: number;
		paid_amount: number;
		refunded_amount: number;
		advanced_amount: number;
		outstanding: number;
		notes: string | null;
		issued: number;
		due_date: number | null;
		supply_date: number | null;
		paid_date: number | null;
		reference_document: ReferenceDocument | null;
	};
	items: {
		description: string;
		quantity: number;
		unit: string | null;
		unit_price: number;
		tax_rate: number;
		tax_amount: number;
		total_price: number;
		tax_treatment: string | null;
		discount_amount: number;
	}[];
	tax: {
		vat_status: string | null;
		country: string | null;
		exemption_note: string | null;
		notes: string[];
		reporting: { currency: string; rate: number; date: number | null; tax_amount: number } | null;
	};
	formats: { date: string; time: string; timezone: string };
	language: string;
	branding: Branding;
	design: InvoiceDesign;
	closing_note: string | null;
	issuer: { name: string; signature: string | null } | null;
	bank: BankInstruction | null;
	online: { card: boolean; crypto: boolean };
	pay_url: string;
	pay_qr: { format: string; payload: string; encoding: "utf8" | "latin2" } | null;
	fiscal: FiscalMarks | null;
}

export interface CurrencyRates {
	base: string;
	currencies: string[];
	rates: Record<string, number>;
	live: boolean;
}

export interface Customer {
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
	registration_number: string | null;
	iban: string | null;
	bic: string | null;
	metadata: Record<string, unknown> | null;
	customer_type: string | null;
	vat_valid: boolean | null;
	vat_checked_at: number | null;
	vat_checked_name: string | null;
	vat_checked_address: string | null;
	vat_check_reference: string | null;
	created: number;
	updated: number;
	stats?: CustomerStats;
}

export interface InvoiceItem {
	uuid: string;
	description: string;
	quantity: number;
	unit_price: number;
	tax_rate: number;
	tax_amount: number;
	total_price: number;
	item: string | null;
	tax_treatment: string | null;
	unit: string | null;
}

export interface Invoice extends ReferenceDocumentColumns {
	uuid: string;
	fiscal_status?: "pending" | "verified" | "rejected" | null;
	project: string;
	customer: string | null;
	reference: string;
	status: string;
	currency: string;
	subtotal: number;
	discount_amount: number;
	tax_amount: number;
	total_amount: number;
	paid_amount: number;
	refunded_amount: number;
	credited_amount: number;
	notes: string | null;
	due_date: number;
	supply_date: number | null;
	paid_date: number | null;
	canceled_date: number | null;
	issued_at: number | null;
	tax_currency: string | null;
	tax_exchange_rate: number | null;
	tax_rate_source: string | null;
	tax_rate_date: number | null;
	buyer_country: string | null;
	buyer_vat_number: string | null;
	created: number;
	updated: number;
	items?: InvoiceItem[];
	customer_name?: string | null;
	customer_email?: string | null;
	source?: "invoice" | "pos";
	created_by?: string | null;
	recurring?: string | null;
	document_type?: "invoice" | "advance";
	advanced_amount?: number;
	document?: DocumentKind;
	proforma?: { reference: string; settlement: ProformaSettlement; issued_at: number } | null;
	order_number?: string | null;
	advances?: { uuid: string; reference: string; total_amount: number; credited_amount: number; issued_at: number | null }[];
	source_proforma?: { uuid: string; reference: string } | null;
}

export type DocumentKind = "invoice" | "advance" | "proforma" | "order";
export type ProformaSettlement = "invoice" | "advance";
export type NumberSeries = "invoice" | "proforma" | "order";

export type RecurringStatus = "active" | "paused" | "completed" | "canceled";
export type IntervalUnit = "week" | "month" | "year";

export interface RecurringSummary {
	uuid: string;
	customer: string;
	customer_name: string | null;
	customer_email: string;
	title: string | null;
	first_line: string | null;
	currency: string;
	interval_unit: IntervalUnit;
	interval_count: number;
	next_run_at: number | null;
	occurrences: number;
	max_occurrences: number | null;
	end_date: number | null;
	auto_issue: boolean;
	auto_send: boolean;
	status: RecurringStatus;
	last_error: string | null;
	last_run_at: number | null;
	total_amount: number;
}

export interface RecurringLine {
	description: string;
	quantity: number;
	unit: string | null;
	unit_price: number;
	tax_rate: number;
	item: string | null;
	tax_treatment: string | null;
}

export interface RecurringDetail extends Omit<RecurringSummary, "customer_name" | "customer_email" | "first_line"> {
	discount_amount: number;
	notes: string | null;
	start_date: number;
	days_until_due: number;
	failures: number;
	last_invoice: string | null;
	created_by: string | null;
	items: RecurringLine[];
	subtotal: number;
	tax_amount: number;
	upcoming: number[];
	customer_detail: { uuid: string; name: string | null; email: string } | null;
	invoices: Pick<
		Invoice,
		"uuid" | "reference" | "status" | "currency" | "total_amount" | "paid_amount" | "refunded_amount" | "credited_amount" | "due_date" | "issued_at" | "created"
	>[];
	created_invoice?: string;
}

export interface RecurringInput {
	title?: string | null;
	customer?: string;
	currency?: string;
	items?: ItemInput[];
	discount_amount?: number;
	notes?: string | null;
	interval_unit?: IntervalUnit;
	interval_count?: number;
	start_date?: number;
	next_date?: number;
	days_until_due?: number;
	max_occurrences?: number | null;
	end_date?: number | null;
	auto_issue?: boolean;
	auto_send?: boolean;
}

export interface SalesDay {
	total: number;
	limit: number;
	offset: number;
	sales: Invoice[];
	summary: SalesSummary[];
	scope: "mine" | "all";
	from: number;
	to: number;
}

export interface CreditNote {
	uuid: string;
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
	items: { uuid: string; invoice_item: string | null; description: string; tax_rate: number; net_amount: number; tax_amount: number }[];
}

export interface InvoiceCredits {
	credit_notes: CreditNote[];
	creditable: { line: string; description: string; tax_rate: number; tax_treatment: string | null; net: number; tax: number }[];
	creditable_total: number;
}

export interface CreditNoteDocument {
	seller: InvoiceDocument["seller"];
	buyer: InvoiceDocument["buyer"];
	credit_note: {
		uuid: string;
		reference: string;
		reason: string | null;
		currency: string;
		subtotal: number;
		tax_amount: number;
		total_amount: number;
		issued: number;
	};
	corrects: { uuid: string; reference: string; issued: number };
	items: { description: string; tax_rate: number; tax_treatment: string | null; net_amount: number; tax_amount: number }[];
	tax: InvoiceDocument["tax"];
	fiscal: FiscalMarks | null;
	formats: { date: string; time: string; timezone: string };
	language: string;
	branding: Branding;
	design: InvoiceDesign;
	closing_note: string | null;
}

export interface FiscalPremise {
	uuid: string;
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
}

export interface FiscalSettings {
	required: boolean;
	active: boolean;
	environment: "test" | "production";
	enabled: boolean;
	certificate: { holder: string | null; tax_number: number | null; serial: string | null; valid_to: number | null } | null;
	online_premise: string | null;
	online_device: string | null;
	pos_premise: string | null;
	pos_device: string | null;
	operator_tax_number: number | null;
	premises: FiscalPremise[];
	pending: number;
	rejected: number;
	late: number;
	due_soon: number;
	operators: { username: string; name: string; role: string; tax_number: number | null }[];
}

export interface FiscalChanges {
	enabled?: boolean;
	online_premise?: string | null;
	online_device?: string | null;
	pos_premise?: string | null;
	pos_device?: string | null;
	operator_tax_number?: number | null;
}

export interface FiscalPremiseInput {
	premise_id: string;
	kind: "real_estate" | "movable";
	premise_type?: "A" | "B" | "C";
	cadastral_number?: number;
	building_number?: number;
	building_section_number?: number;
	street?: string;
	house_number?: string;
	house_number_additional?: string;
	community?: string;
	city?: string;
	postal_code?: string;
}

export interface FiscalDocument {
	uuid: string;
	invoice: string | null;
	credit_note: string | null;
	reference: string;
	environment: "test" | "production";
	issued_at: number;
	amount: number;
	zoi: string;
	eor: string | null;
	status: "pending" | "verified" | "rejected";
	attempts: number;
	subsequent: boolean;
	next_attempt_at: number | null;
	deadline: number;
	error_code: string | null;
	last_error: string | null;
	verified_at: number | null;
}

export interface FiscalMarks {
	operator: string | null;
	zoi: string;
	eor: string | null;
	status: "pending" | "verified" | "rejected";
	environment: "test" | "production";
	issued: string;
	code: string;
}

export interface VatReport {
	from: number;
	to: number;
	currency: string;
	invoices: number;
	credit_notes: number;
	domestic: { rate: number; net: number; vat: number }[];
	oss: { country: string; rate: number; net: number; vat: number }[];
	zero_rated: { treatment: string; net: number }[];
	ec_sales_list: { vat_number: string; country: string; goods: number; services: number }[];
	domestic_reverse_list: { vat_number: string; net: number }[];
	totals: { net: number; domestic_vat: number; oss_vat: number };
	missing_rates: { invoice: string; reference: string; currency: string; issued_at: number | null }[];
	missing_details: { invoice: string; reference: string; reason: string }[];
}

export interface CurrencyTotal {
	currency: string;
	count: number;
	total_amount: number;
	paid_amount: number;
	outstanding_amount: number;
}

export interface TicketAccess {
	customer: string;
	enabled: boolean;
	kinds: TicketKind[];
}

export interface Transaction {
	uuid: string;
	project: string;
	invoice: string | null;
	processor: string;
	processor_tx_id: string | null;
	parent_transaction: string | null;
	status: string;
	type: string;
	currency: string;
	amount: number;
	fee_amount: number;
	net_amount: number | null;
	payment_method: string | null;
	payment_details: Record<string, unknown> | null;
	created: number;
	invoice_reference?: string | null;
	customer_name?: string | null;
	customer_email?: string | null;
	refunds?: Transaction[];
	refundable?: number;
}

export interface TransactionTotal {
	currency: string;
	received: number;
	refunded: number;
	fees: number;
}

export interface WebhookDelivery {
	uuid: string;
	event_type: string;
	target_url: string;
	status: string;
	attempts: number;
	response_status: number | null;
	last_error: string | null;
	next_attempt_at: number | null;
	created: number;
	delivered_at: number | null;
}

export interface ProcessorField {
	key: string;
	label: string;
	secret: boolean;
	hint?: string;
	choices?: { value: string; label: string }[];
	optional?: boolean;
	value: string | null;
	set: boolean;
}

export interface ProcessorState {
	processor: string;
	label: string;
	kind: string;
	enabled: boolean;
	configured: boolean;
	server_available: boolean;
	problem: string | null;
	preview: string | null;
	fields: ProcessorField[];
}

export interface PublicInvoice {
	reference: string;
	document: DocumentKind;
	payable: boolean;
	merchant: string;
	status: string;
	currency: string;
	subtotal: number;
	discount_amount: number;
	tax_amount: number;
	total_amount: number;
	paid_amount: number;
	outstanding: number;
	due_date: number;
	notes: string | null;
	date_format: string;
	time_format: string;
	timezone: string;
	language: string;
	accent_color: string | null;
	branding: Branding;
	items: { description: string; quantity: number; unit: string | null; unit_price: number; tax_rate: number; total_price: number }[];
	methods: { processor: string; label: string; kind: string }[];
	keys: { name: string; codes: string[] }[];
	keys_pending: boolean;
}

export interface PaymentInstruction {
	processor: string;
	kind: string;
	address?: string;
	amount?: string | number;
	unit?: string;
	uri?: string;
	reference?: string;
	currency?: string;
	account?: { iban: string; bic: string | null; holder: string; bank_name: string | null };
	qr?: { format: "epc" | "upn"; payload: string; encoding: "utf8" | "latin2" } | null;
	qr_unavailable?: string | null;
	checkout_url?: string;
	confirmations_required?: number;
	exchange_rate?: number;
	expires_at?: number | null;
}

export interface Member {
	uuid: string;
	account_username: string | null;
	full_name: string | null;
	has_signature: boolean;
	role: string;
	status: string;
	invitation_email: string | null;
	invited_by: string | null;
	invitation_token?: string | null;
	email_queued?: boolean;
	expires_at: number | null;
	accepted_at: number | null;
	created: number;
}

export interface EmailMessage {
	uuid: string;
	kind:
		| "invoice"
		| "reminder_before"
		| "reminder_after"
		| "receipt"
		| "invitation"
		| "keys"
		| "credit_note"
		| "fiscal_alert"
		| "order_update"
		| "order_processing"
		| "order_shipped"
		| "order_delivered";
	recipient: string;
	subject: string;
	attachment: string | null;
	eslog_document: string | null;
	status: "pending" | "sent" | "failed";
	attempts: number;
	last_error: string | null;
	sent_by: string | null;
	sent_at: number | null;
	created: number;
}

export interface Invitation {
	project: string;
	project_name: string;
	role: string;
	role_name: string;
	role_description: string;
	invitation_email: string | null;
	invited_by: string | null;
	expired: boolean;
	created: number;
}

export interface ItemInput {
	description: string;
	quantity: number;
	unit_price: number;
	tax_rate: number;
	item?: string | null;
	tax_treatment?: string | null;
	unit?: string | null;
}

export interface KeyStock {
	available: number;
	reserved: number;
	delivered: number;
	total: number;
}

export interface CatalogItem {
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
	delivers_keys: boolean;
	license: LicenseProduct | null;
	unit: string | null;
	keys: KeyStock | null;
	archived: boolean;
	created: number;
	updated: number;
}

export interface CatalogItemInput {
	name?: string;
	description?: string | null;
	sku?: string | null;
	unit_price?: number;
	currency?: string;
	tax_rate?: number;
	supply_type?: string;
	tax_category?: string;
	delivers_keys?: boolean;
	license?: LicenseProduct | null;
	unit?: string | null;
	archived?: boolean;
}

export interface ItemKey {
	uuid: string;
	item: string;
	secret: string;
	status: "available" | "reserved" | "delivered";
	invoice: string | null;
	invoice_reference?: string | null;
	item_name?: string;
	recipient: string | null;
	reserved_at: number | null;
	delivered_at: number | null;
	created: number;
}

export interface InvoiceKeys {
	reserved: ItemKey[];
	delivered: ItemKey[];
}

export interface ItemSales {
	item: string;
	name: string;
	sku: string | null;
	archived: boolean;
	currency: string;
	sold_quantity: number;
	sold_amount: number;
	sold_invoices: number;
	pending_quantity: number;
	pending_amount: number;
}

export interface ItemSalesReport {
	from: number;
	to: number;
	items: ItemSales[];
	totals: { currency: string; sold_amount: number; pending_amount: number }[];
}

export async function publicRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(`/api/v1/public${path}`, {
		method,
		headers: body === undefined ? {} : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	const payload = (await response.json()) as { error: number; info: string; data?: unknown };
	if (payload.error !== 0) throw new ApiError(payload.error, response.status, payload.info);

	return payload.data as T;
}

export const PublicApi = {
	invoicePdfUrl(invoice: string) {
		return `/api/v1/public/invoices/${invoice}/pdf`;
	},

	invoice(uuid: string) {
		return publicRequest<PublicInvoice>("GET", `/invoices/${uuid}`);
	},

	start(uuid: string, processor: string) {
		return publicRequest<PaymentInstruction>("POST", `/invoices/${uuid}/pay/${processor}`);
	},
};

export const Api = {
	recordedInvoices(uuid: string, options: { from?: number; to?: number; offset?: number; limit?: number }) {
		return request<{ recorded_invoices: RecordedInvoice[]; total: number; limit: number; offset: number }>(
			"GET",
			`/projects/${uuid}/recorded-invoices${listQuery(options)}`
		);
	},

	recordedBuyers(uuid: string) {
		return request<{ buyers: { name: string; vat_number: string | null; country: string | null }[] }>("GET", `/projects/${uuid}/recorded-invoices/buyers`);
	},

	createRecordedInvoice(uuid: string, data: RecordedInvoiceInput) {
		return request<RecordedInvoice>("POST", `/projects/${uuid}/recorded-invoices`, data);
	},

	updateRecordedInvoice(uuid: string, record: string, data: RecordedInvoiceInput) {
		return request<RecordedInvoice>("PATCH", `/projects/${uuid}/recorded-invoices/${record}`, data);
	},

	recordedInvoice(uuid: string, record: string) {
		return request<RecordedInvoice>("GET", `/projects/${uuid}/recorded-invoices/${record}`);
	},

	previewRecordedImport(uuid: string, content: string) {
		return request<ImportResult>("POST", `/projects/${uuid}/recorded-invoices/import/preview`, { content });
	},

	importRecordedInvoices(uuid: string, content: string) {
		return request<{ imported: number }>("POST", `/projects/${uuid}/recorded-invoices/import`, { content });
	},

	uploadRecordedAttachment(uuid: string, record: string, data: { name: string; type: string; data: string }) {
		return request<RecordedInvoice["attachment"]>("PUT", `/projects/${uuid}/recorded-invoices/${record}/attachment`, data);
	},

	recordedAttachment(uuid: string, record: string) {
		return requestFile(`/projects/${uuid}/recorded-invoices/${record}/attachment`, "invoice");
	},

	deleteRecordedInvoice(uuid: string, record: string) {
		return request<void>("DELETE", `/projects/${uuid}/recorded-invoices/${record}`);
	},

	previewBankStatement(uuid: string, name: string, data: string) {
		return request<StatementPreview>("POST", `/projects/${uuid}/accounting/bank-statements/preview`, { name, data });
	},

	importBankStatement(uuid: string, name: string, data: string) {
		return request<{ statements: number; imported: number; skipped: number }>("POST", `/projects/${uuid}/accounting/bank-statements`, { name, data });
	},

	bankStatements(uuid: string) {
		return request<{ statements: BankStatement[] }>("GET", `/projects/${uuid}/accounting/bank-statements`);
	},

	bankTransactions(uuid: string, options: { status: string; offset?: number; limit?: number }) {
		return request<{ transactions: BankTransaction[]; total: number }>("GET", `/projects/${uuid}/accounting/bank-transactions${listQuery(options)}`);
	},

	matchExactBankTransactions(uuid: string) {
		return request<{ matched: number }>("POST", `/projects/${uuid}/accounting/bank-transactions/match-exact`);
	},

	matchBankTransaction(uuid: string, line: string, type: BankSuggestion["type"], id: string) {
		return request<BankTransactionRow>("POST", `/projects/${uuid}/accounting/bank-transactions/${line}/match`, { type, id });
	},

	matchBankTransactionTo(uuid: string, line: string, matches: BankMatchInput[]) {
		return request<BankTransactionRow>("POST", `/projects/${uuid}/accounting/bank-transactions/${line}/match`, { matches });
	},

	bankCandidates(uuid: string, line: string) {
		return request<{ candidates: BankCandidate[] }>("GET", `/projects/${uuid}/accounting/bank-transactions/${line}/candidates`);
	},

	bookBankTransaction(uuid: string, line: string, account: string) {
		return request<BankTransactionRow>("POST", `/projects/${uuid}/accounting/bank-transactions/${line}/book`, { account });
	},

	ignoreBankTransaction(uuid: string, line: string) {
		return request<BankTransactionRow>("POST", `/projects/${uuid}/accounting/bank-transactions/${line}/ignore`);
	},

	reopenBankTransaction(uuid: string, line: string) {
		return request<BankTransactionRow>("POST", `/projects/${uuid}/accounting/bank-transactions/${line}/reopen`);
	},

	financialStatements(uuid: string, year: number) {
		return request<FinancialStatements & { issues: LedgerIssue[] }>("GET", `/projects/${uuid}/accounting/statements?year=${year}`);
	},

	updateBookkeeping(uuid: string, bookkeeping: NonNullable<Project["bookkeeping"]>) {
		return request<{ bookkeeping: string }>("PUT", `/projects/${uuid}/accounting/settings`, { bookkeeping });
	},

	ajpesReport(uuid: string, year: number) {
		return request<AjpesReport & { issues: LedgerIssue[] }>("GET", `/projects/${uuid}/accounting/ajpes?year=${year}`);
	},

	ajpesXml(uuid: string, year: number) {
		return requestFile(`/projects/${uuid}/accounting/ajpes/export?year=${year}`, `ajpes-${year}.xml`);
	},

	kpoBook(uuid: string, year: number) {
		return request<KpoBook & { issues: LedgerIssue[] }>("GET", `/projects/${uuid}/accounting/kpo?year=${year}`);
	},

	fixedAssets(uuid: string) {
		return request<{ assets: FixedAsset[]; candidates: AssetCandidate[]; default_rates: Record<AssetCategory, number> }>(
			"GET",
			`/projects/${uuid}/accounting/assets`
		);
	},

	createFixedAsset(uuid: string, data: FixedAssetInput) {
		return request<FixedAsset>("POST", `/projects/${uuid}/accounting/assets`, data);
	},

	updateFixedAsset(uuid: string, asset: string, data: { name?: string; annual_rate?: number; disposed_at?: number | null; notes?: string | null }) {
		return request<FixedAsset>("PATCH", `/projects/${uuid}/accounting/assets/${asset}`, data);
	},

	deleteFixedAsset(uuid: string, asset: string) {
		return request<void>("DELETE", `/projects/${uuid}/accounting/assets/${asset}`);
	},

	accountingYears(uuid: string) {
		return request<{ years: AccountingYear[] }>("GET", `/projects/${uuid}/accounting/years`);
	},

	setDeductibleShare(uuid: string, year: number, finalShare: number | null) {
		return request<AccountingYear>("PUT", `/projects/${uuid}/accounting/years/${year}/deductible-share`, { final_share: finalShare });
	},

	closeAccountingYear(uuid: string, year: number) {
		return request<AccountingYear>("POST", `/projects/${uuid}/accounting/years/${year}/close`);
	},

	reopenAccountingYear(uuid: string, year: number, reason: string) {
		return request<AccountingYear>("POST", `/projects/${uuid}/accounting/years/${year}/reopen`, { reason });
	},

	revaluation(uuid: string, year: number) {
		return request<RevaluationPreview>("GET", `/projects/${uuid}/accounting/years/${year}/revaluation`);
	},

	previewRevaluation(uuid: string, year: number, rates: Record<string, number>) {
		return request<RevaluationPreview>("POST", `/projects/${uuid}/accounting/years/${year}/revaluation`, { rates, preview: true });
	},

	postRevaluation(uuid: string, year: number, rates: Record<string, number>) {
		return request<RevaluationPreview>("POST", `/projects/${uuid}/accounting/years/${year}/revaluation`, { rates });
	},

	accountingClients() {
		return request<{ clients: AccountingClient[] }>("GET", "/accounting/clients");
	},

	previewAccountingLicense(uuid: string, code: string) {
		return request<LicensePreview>("POST", `/projects/${uuid}/accounting/license/preview`, { code });
	},

	redeemAccountingLicense(uuid: string, code: string, startsAt: number | null = null) {
		return request<{ accounting: boolean; accounting_until: number | null; starts_at: number | null }>("POST", `/projects/${uuid}/accounting/license/redeem`, {
			code,
			starts_at: startsAt,
		});
	},

	ledgerAccounts(uuid: string) {
		return request<{ accounts: LedgerAccount[]; licensed: boolean }>("GET", `/projects/${uuid}/accounting/accounts`);
	},

	createLedgerAccount(uuid: string, data: { code: string; name: string }) {
		return request<LedgerAccount>("POST", `/projects/${uuid}/accounting/accounts`, data);
	},

	updateLedgerAccount(uuid: string, account: string, data: { name?: string; active?: boolean }) {
		return request<LedgerAccount>("PATCH", `/projects/${uuid}/accounting/accounts/${account}`, data);
	},

	ledgerCategories(uuid: string) {
		return request<{ categories: { category: string; account: string }[] }>("GET", `/projects/${uuid}/accounting/category-accounts`);
	},

	mapLedgerCategory(uuid: string, category: string, account: string) {
		return request<{ category: string; account: string }>("PUT", `/projects/${uuid}/accounting/category-accounts`, { category, account });
	},

	journal(uuid: string, options: JournalQuery & { offset?: number; limit?: number }) {
		return request<JournalPage>("GET", `/projects/${uuid}/accounting/journal${listQuery(options)}`);
	},

	postJournalEntry(uuid: string, data: ManualEntryInput) {
		return request<JournalEntryView>("POST", `/projects/${uuid}/accounting/journal`, data);
	},

	reverseJournalEntry(uuid: string, entry: string) {
		return request<JournalEntryView>("POST", `/projects/${uuid}/accounting/journal/${entry}/reverse`);
	},

	exportJournal(uuid: string, options: JournalQuery) {
		return requestFile(`/projects/${uuid}/accounting/journal/export${listQuery(options)}`, "dnevnik.csv");
	},

	exportTrialBalance(uuid: string, options: { from: number; to: number }) {
		return requestFile(`/projects/${uuid}/accounting/trial-balance/export${listQuery(options)}`, "bruto-bilanca.csv");
	},

	openItems(uuid: string, options: { date: number; kind: OpenItemsKind }) {
		return request<OpenItemsReport & { issues: LedgerIssue[] }>("GET", `/projects/${uuid}/accounting/open-items${listQuery(options)}`);
	},

	exportOpenItems(uuid: string, options: { date: number; kind: OpenItemsKind }) {
		return requestFile(`/projects/${uuid}/accounting/open-items/export${listQuery(options)}`, "odprte-postavke.csv");
	},

	registrySearch(query: string) {
		return request<{ results: CompanyLookup[] }>("GET", `/registry/companies${listQuery({ q: query })}`);
	},

	registryVat(number: string) {
		return request<{ result: CompanyLookup | null }>("GET", `/registry/vat/${encodeURIComponent(number)}`);
	},

	accountingPartners(uuid: string) {
		return request<{ partners: { key: string; name: string; tax_number: string | null }[] }>("GET", `/projects/${uuid}/accounting/partners`);
	},

	trialBalance(uuid: string, options: { from: number; to: number }) {
		return request<{ from: number; to: number; accounts: TrialBalanceRow[]; issues: LedgerIssue[] }>(
			"GET",
			`/projects/${uuid}/accounting/trial-balance${listQuery(options)}`
		);
	},

	exportAccountLedger(uuid: string, account: string, options: { from: number; to: number; partner?: string }) {
		return requestFile(`/projects/${uuid}/accounting/ledger/${account}/export${listQuery(options)}`, "kartica.csv");
	},

	accountLedger(uuid: string, account: string, options: { from: number; to: number; partner?: string }) {
		return request<{ from: number; to: number; account: LedgerAccount; opening: number; closing: number; lines: AccountLedgerRow[] }>(
			"GET",
			`/projects/${uuid}/accounting/ledger/${account}${listQuery(options)}`
		);
	},

	expense(uuid: string, expense: string) {
		return request<Expense>("GET", `/projects/${uuid}/expenses/${expense}`);
	},

	expenses(uuid: string, options: { limit?: number; offset?: number; from?: number; to?: number; status?: string } = {}) {
		return request<{ expenses: Expense[]; total: number; limit: number; offset: number }>("GET", `/projects/${uuid}/expenses${listQuery(options)}`);
	},
	createExpense(uuid: string, data: ExpenseInput) {
		return request<Expense>("POST", `/projects/${uuid}/expenses`, data);
	},
	updateExpense(uuid: string, expense: string, data: Partial<ExpenseInput>) {
		return request<Expense>("PATCH", `/projects/${uuid}/expenses/${expense}`, data);
	},
	deleteExpense(uuid: string, expense: string) {
		return request<void>("DELETE", `/projects/${uuid}/expenses/${expense}`);
	},
	previewExpenseImport(uuid: string, file: { name: string; data: string }) {
		return request<ExpenseImportPreview>("POST", `/projects/${uuid}/expenses/import/preview`, file);
	},
	previewExpenseCsv(uuid: string, content: string) {
		return request<ExpenseImportResult>("POST", `/projects/${uuid}/expenses/import-csv/preview`, { content });
	},
	importExpenseCsv(uuid: string, content: string) {
		return request<{ imported: number }>("POST", `/projects/${uuid}/expenses/import-csv`, { content });
	},
	uploadExpenseAttachment(uuid: string, expense: string, data: { name: string; type: string; data: string }) {
		return request<Expense["attachment"]>("PUT", `/projects/${uuid}/expenses/${expense}/attachment`, data);
	},
	expenseAttachment(uuid: string, expense: string) {
		return requestFile(`/projects/${uuid}/expenses/${expense}/attachment`, "expense-attachment");
	},
	deleteExpenseAttachment(uuid: string, expense: string) {
		return request<void>("DELETE", `/projects/${uuid}/expenses/${expense}/attachment`);
	},
	expenseSchedules(uuid: string) {
		return request<ExpenseSchedule[]>("GET", `/projects/${uuid}/expense-schedules`);
	},
	createExpenseSchedule(uuid: string, data: ExpenseScheduleInput) {
		return request<ExpenseSchedule>("POST", `/projects/${uuid}/expense-schedules`, data);
	},
	updateExpenseSchedule(uuid: string, schedule: string, data: Partial<ExpenseScheduleInput> & { status?: string }) {
		return request<ExpenseSchedule>("PATCH", `/projects/${uuid}/expense-schedules/${schedule}`, data);
	},
	financialReport(uuid: string) {
		return request<ReportState<FinancialReport>>("GET", `/projects/${uuid}/reports/financial`);
	},
	generateFinancialReport(uuid: string, options: { from: number; to: number; group: string }) {
		return request<GeneratedReport<FinancialReport>>("POST", `/projects/${uuid}/reports/financial${listQuery(options)}`);
	},
	financialReportExport(uuid: string, options: { from: number; to: number; group: string }) {
		return requestFile(`/projects/${uuid}/reports/financial/export${listQuery(options)}`, "financial-report.csv");
	},
	registration() {
		return request<{ mode: RegistrationMode }>("GET", "/auth/registration");
	},

	legal() {
		return request<LegalInfo>("GET", "/legal");
	},

	acceptTerms(versions: LegalVersions) {
		return request<{ pending_terms: null; upcoming_terms: null }>("POST", "/auth/legal/accept", { legal_versions: versions });
	},

	exportData() {
		return requestDownload("/auth/export", "rabbitpay-data.json");
	},

	register(username: string, email: string, password: string, access: { invite?: string; invitation?: string } & Partial<LegalAcceptance> = {}) {
		return request<{ username: string }>("POST", "/auth/register", { username, email, password: hashPassword(password), ...access });
	},

	login(username: string, password: string, factor?: SecondFactor) {
		return request<{ token: string; username: string; email: string; admin: boolean; expires_in: number }>("POST", "/auth/login", {
			username,
			password: hashPassword(password),
			...factor,
		});
	},

	logout() {
		return request<null>("POST", "/auth/logout");
	},

	me() {
		return request<Account>("GET", "/auth/me");
	},

	setupTwoFactor() {
		return request<TwoFactorSetup>("POST", "/auth/two-factor/setup");
	},

	enableTwoFactor(password: string, code: string) {
		return request<{ recovery_codes: string[] | null }>("POST", "/auth/two-factor/enable", { password: hashPassword(password), code });
	},

	regenerateRecoveryCodes(factor: SecondFactor) {
		return request<RecoveryCodes>("POST", "/auth/two-factor/recovery-codes", factor);
	},

	disableTwoFactor(password: string, factor: SecondFactor) {
		return request<void>("DELETE", "/auth/two-factor", { password: hashPassword(password), ...factor });
	},

	removeAuthenticator(password: string, factor: SecondFactor) {
		return request<{ two_factor_enabled: boolean }>("DELETE", "/auth/two-factor/authenticator", { password: hashPassword(password), ...factor });
	},

	securityKeyOptions() {
		return request<SecurityKeyCreationOptions>("POST", "/auth/two-factor/security-keys/options");
	},

	addSecurityKey(password: string, name: string, credential: unknown) {
		return request<{ key: SecurityKey; recovery_codes: string[] | null }>("POST", "/auth/two-factor/security-keys", {
			password: hashPassword(password),
			name,
			credential,
		});
	},

	securityKeyChallenge() {
		return request<SecurityKeyRequestOptions>("POST", "/auth/two-factor/security-keys/challenge");
	},

	removeSecurityKey(uuid: string, password: string, factor: SecondFactor) {
		return request<{ two_factor_enabled: boolean }>("DELETE", `/auth/two-factor/security-keys/${encodeURIComponent(uuid)}`, {
			password: hashPassword(password),
			...factor,
		});
	},

	projects() {
		return request<Project[]>("GET", "/projects");
	},

	createProject(name: string, currency?: string) {
		return request<Project>("POST", "/projects", currency === undefined ? { name } : { name, currency });
	},

	currencies() {
		return request<CurrencyRates>("GET", "/currencies");
	},

	company(uuid: string) {
		return request<Company>("GET", `/projects/${uuid}/company`);
	},

	fiscal(uuid: string) {
		return request<FiscalSettings>("GET", `/projects/${uuid}/fiscal`);
	},

	uploadFiscalCertificate(uuid: string, file: string, password: string) {
		return request<FiscalSettings>("PUT", `/projects/${uuid}/fiscal/certificate`, { file, password });
	},

	removeFiscalCertificate(uuid: string) {
		return request<FiscalSettings>("DELETE", `/projects/${uuid}/fiscal/certificate`);
	},

	signingCertificate(uuid: string) {
		return request<{ certificate: SigningCertificateSummary | null }>("GET", `/projects/${uuid}/einvoice/signing-certificate`);
	},

	uploadSigningCertificate(uuid: string, file: string, password: string) {
		return request<{ certificate: SigningCertificateSummary | null }>("PUT", `/projects/${uuid}/einvoice/signing-certificate`, { file, password });
	},

	removeSigningCertificate(uuid: string) {
		return request<{ certificate: SigningCertificateSummary | null }>("DELETE", `/projects/${uuid}/einvoice/signing-certificate`);
	},

	updateFiscal(uuid: string, changes: FiscalChanges) {
		return request<FiscalSettings>("PATCH", `/projects/${uuid}/fiscal`, changes);
	},

	setFiscalOperator(uuid: string, username: string, taxNumber: number | null) {
		return request<FiscalSettings>("PUT", `/projects/${uuid}/fiscal/operators/${encodeURIComponent(username)}`, { tax_number: taxNumber });
	},

	fiscalEcho(uuid: string) {
		return request<{ environment: string }>("POST", `/projects/${uuid}/fiscal/echo`);
	},

	registerFiscalPremise(uuid: string, premise: FiscalPremiseInput) {
		return request<FiscalSettings>("POST", `/projects/${uuid}/fiscal/premises`, premise);
	},

	closeFiscalPremise(uuid: string, premise: string) {
		return request<FiscalSettings>("POST", `/projects/${uuid}/fiscal/premises/${encodeURIComponent(premise)}/close`);
	},

	fiscalDocuments(uuid: string, status?: FiscalDocument["status"]) {
		return request<{ documents: FiscalDocument[]; total: number }>("GET", `/projects/${uuid}/fiscal/documents?limit=20${status ? `&status=${status}` : ""}`);
	},

	retryFiscalDocument(uuid: string, document: string) {
		return request<FiscalDocument>("POST", `/projects/${uuid}/fiscal/documents/${document}/retry`);
	},

	saveCompany(uuid: string, details: Partial<Company>) {
		return request<Company>("PUT", `/projects/${uuid}/company`, details);
	},

	invoiceDocument(uuid: string, invoice: string) {
		return request<InvoiceDocument>("GET", `/projects/${uuid}/invoices/${invoice}/document`);
	},

	invoicePdf(uuid: string, invoice: string) {
		return requestFile(`/projects/${uuid}/invoices/${invoice}/pdf`, "invoice.pdf");
	},

	invoiceEslog(uuid: string, invoice: string, version?: number) {
		return requestFile(`/projects/${uuid}/invoices/${invoice}/eslog${version ? `?version=${version}` : ""}`, "invoice.xml");
	},

	invoiceEslogVersions(uuid: string, invoice: string) {
		return request<{ versions: EslogVersion[] }>("GET", `/projects/${uuid}/invoices/${invoice}/eslog/versions`);
	},

	saleDocument(uuid: string, sale: string) {
		return request<InvoiceDocument>("GET", `/projects/${uuid}/pos/sales/${sale}/document`);
	},

	salePdf(uuid: string, sale: string) {
		return requestFile(`/projects/${uuid}/pos/sales/${sale}/pdf`, "receipt.pdf");
	},

	sales(uuid: string, options: { scope?: "mine" | "all"; from?: number; to?: number; limit?: number; offset?: number } = {}) {
		const query = new URLSearchParams();
		if (options.scope) query.set("scope", options.scope);
		if (options.from !== undefined) query.set("from", String(options.from));
		if (options.to !== undefined) query.set("to", String(options.to));
		if (options.limit !== undefined) query.set("limit", String(options.limit));
		if (options.offset !== undefined) query.set("offset", String(options.offset));
		const suffix = query.toString() ? `?${query}` : "";
		return request<SalesDay>("GET", `/projects/${uuid}/pos/sales${suffix}`);
	},

	sale(uuid: string, sale: string) {
		return request<Invoice>("GET", `/projects/${uuid}/pos/sales/${sale}`);
	},

	createSale(uuid: string, sale: { currency: string; lines: SaleLineInput[] }) {
		return request<Invoice>("POST", `/projects/${uuid}/pos/sales`, sale);
	},

	saleCash(uuid: string, sale: string, payment: { amount: number; tendered: number | null }) {
		return request<Invoice>("POST", `/projects/${uuid}/pos/sales/${sale}/cash`, payment);
	},

	cancelSale(uuid: string, sale: string, reason?: string) {
		return request<Invoice>("POST", `/projects/${uuid}/pos/sales/${sale}/cancel`, reason ? { reason } : {});
	},

	project(uuid: string) {
		return request<Project>("GET", `/projects/${uuid}`);
	},

	updateProject(
		uuid: string,
		changes: {
			proforma_settlement?: ProformaSettlement;
			name?: string;
			display_name?: string | null;
			webhook_url?: string | null;
			currency?: string;
			date_format?: string;
			time_format?: string;
			timezone?: string;
			language?: string;
			accent_color?: string | null;
			tax_country?: string | null;
			vat_status?: string | null;
			oss_registered?: boolean;
			tax_currency?: string | null;
			vat_exemption_note?: string | null;
			pos_custom_amounts?: boolean;
			email_reminders?: boolean;
			email_attach_invoice?: boolean;
			email_attach_eslog?: boolean;
			email_pay_link?: boolean;
			email_portal_link?: boolean;
			invoice_issuer_details?: boolean;
			reminder_days_before?: number;
			reminder_days_after?: number;
		}
	) {
		return request<Project>("PATCH", `/projects/${uuid}`, changes);
	},

	deleteProject(uuid: string) {
		return request<null>("DELETE", `/projects/${uuid}`);
	},

	keys(uuid: string) {
		return request<{ primary: string; secondary: string; webhook_secret: string | null; updated: number }>("GET", `/projects/${uuid}/keys`);
	},

	setWebhookUrl(uuid: string, url: string | null) {
		return request<{ webhook_url: string | null }>("PUT", `/projects/${uuid}/webhook-url`, { url });
	},

	rotateWebhookSecret(uuid: string) {
		return request<{ webhook_secret: string }>("POST", `/projects/${uuid}/keys/webhook-secret`, {});
	},

	webhookDeliveries(uuid: string, options: { limit?: number; offset?: number } = {}) {
		return request<{ deliveries: WebhookDelivery[]; counts: { pending: number; delivered: number; failed: number }; total: number }>(
			"GET",
			`/projects/${uuid}/webhooks${listQuery(options)}`
		);
	},

	processors(uuid: string) {
		return request<ProcessorState[]>("GET", `/projects/${uuid}/processors`);
	},

	saveProcessor(uuid: string, processor: string, enabled: boolean, config: Record<string, string>) {
		return request<ProcessorState>("PUT", `/projects/${uuid}/processors/${processor}`, { enabled, config });
	},

	rotateKey(uuid: string, slot: "primary" | "secondary") {
		return request<{ slot: string; key: string }>("POST", `/projects/${uuid}/keys/rotate`, { slot });
	},

	members(uuid: string) {
		return request<Member[]>("GET", `/projects/${uuid}/members`);
	},

	memberProfile(uuid: string) {
		return request<{ full_name: string | null; signature: string | null }>("GET", `/projects/${uuid}/member-profile`);
	},

	updateMemberProfile(uuid: string, profile: { full_name: string; signature?: string | null }) {
		return request<{ full_name: string; signature?: string | null }>("PUT", `/projects/${uuid}/member-profile`, profile);
	},

	emailInvoice(
		uuid: string,
		invoice: string,
		email: { to?: string | null; message?: string | null; reminder?: boolean; attach_invoice?: boolean; attach_eslog?: boolean; pay_link?: boolean }
	) {
		return request<EmailMessage>("POST", `/projects/${uuid}/invoices/${invoice}/email`, email);
	},

	invoiceEmails(uuid: string, invoice: string) {
		return request<EmailMessage[]>("GET", `/projects/${uuid}/invoices/${invoice}/emails`);
	},

	emailReceipt(uuid: string, sale: string, to: string) {
		return request<EmailMessage>("POST", `/projects/${uuid}/pos/sales/${sale}/email`, { to });
	},

	emailInvitation(uuid: string, member: string) {
		return request<EmailMessage>("POST", `/projects/${uuid}/members/${member}/invitation-email`, {});
	},

	invitation(token: string) {
		return request<Invitation>("GET", `/invitations/${encodeURIComponent(token)}`);
	},

	acceptInvitation(token: string) {
		return request<Invitation>("POST", `/invitations/${encodeURIComponent(token)}/accept`, {});
	},

	declineInvitation(token: string) {
		return request<null>("POST", `/invitations/${encodeURIComponent(token)}/decline`, {});
	},

	inviteMember(uuid: string, email: string, role: string) {
		return request<Member>("POST", `/projects/${uuid}/members`, { email, role });
	},

	updateMember(uuid: string, member: string, changes: { role?: string }) {
		return request<Member>("PATCH", `/projects/${uuid}/members/${member}`, changes);
	},

	removeMember(uuid: string, member: string) {
		return request<null>("DELETE", `/projects/${uuid}/members/${member}`);
	},

	customers(uuid: string, options: { search?: string; limit?: number; offset?: number } = {}) {
		const query = new URLSearchParams();
		if (options.search) query.set("search", options.search);
		if (options.limit) query.set("limit", String(options.limit));
		if (options.offset) query.set("offset", String(options.offset));
		const suffix = query.toString() ? `?${query}` : "";
		return request<{ customers: Customer[]; total: number }>("GET", `/projects/${uuid}/customers${suffix}`);
	},

	customer(uuid: string, customer: string) {
		return request<Customer>("GET", `/projects/${uuid}/customers/${customer}`);
	},

	createCustomer(uuid: string, customer: Partial<Customer>) {
		return request<Customer>("POST", `/projects/${uuid}/customers`, customer);
	},

	updateCustomer(uuid: string, customer: string, changes: Partial<Customer>) {
		return request<Customer>("PATCH", `/projects/${uuid}/customers/${customer}`, changes);
	},

	setTaxRate(uuid: string, invoice: string, rate: number) {
		return request<Invoice>("PUT", `/projects/${uuid}/invoices/${invoice}/tax-rate`, { rate });
	},

	vatReport(uuid: string) {
		return request<ReportState<VatReport>>("GET", `/projects/${uuid}/reports/vat`);
	},
	generateVatReport(uuid: string, period: { from?: number; to?: number } = {}) {
		const query = new URLSearchParams();
		if (period.from !== undefined) query.set("from", String(period.from));
		if (period.to !== undefined) query.set("to", String(period.to));
		const suffix = query.toString() ? `?${query}` : "";
		return request<GeneratedReport<VatReport>>("POST", `/projects/${uuid}/reports/vat${suffix}`);
	},
	ddvEvidence(uuid: string, options: DdvExportOptions) {
		return request<DdvEvidenceResult>("GET", `/projects/${uuid}/reports/ddv-evidence${listQuery({ ...options })}`);
	},
	createDdvExport(uuid: string, options: DdvExportOptions) {
		return request<{ export: DdvExport; lock: AccountingPeriodLock; validation: DdvEvidenceResult }>(
			"POST",
			`/projects/${uuid}/reports/ddv-evidence/exports`,
			options
		);
	},
	ddvExports(uuid: string) {
		return request<DdvExport[]>("GET", `/projects/${uuid}/reports/ddv-evidence/exports`);
	},
	ddvExportFile(uuid: string, id: string) {
		return requestFile(`/projects/${uuid}/reports/ddv-evidence/exports/${id}`, "DDV_KIR_KPR.zip");
	},

	ddvLocks(uuid: string) {
		return request<AccountingPeriodLock[]>("GET", `/projects/${uuid}/reports/ddv-evidence/locks`);
	},

	unlockDdvPeriod(uuid: string, lock: string, reason: string) {
		return request<AccountingPeriodLock>("POST", `/projects/${uuid}/reports/ddv-evidence/locks/${lock}/unlock`, { reason });
	},

	checkCustomerVat(uuid: string, customer: string) {
		return request<Customer>("POST", `/projects/${uuid}/customers/${customer}/vat-check`);
	},

	deleteCustomer(uuid: string, customer: string) {
		return request<null>("DELETE", `/projects/${uuid}/customers/${customer}`);
	},

	items(uuid: string, options: { search?: string; archived?: boolean; limit?: number; offset?: number } = {}) {
		const query = new URLSearchParams();
		if (options.search) query.set("search", options.search);
		if (options.archived) query.set("archived", "1");
		if (options.limit) query.set("limit", String(options.limit));
		if (options.offset) query.set("offset", String(options.offset));
		const suffix = query.toString() ? `?${query}` : "";
		return request<{ items: CatalogItem[]; total: number }>("GET", `/projects/${uuid}/items${suffix}`);
	},

	async allItems(uuid: string): Promise<CatalogItem[]> {
		const items: CatalogItem[] = [];
		for (let offset = 0; ; offset += 500) {
			const page = await Api.items(uuid, { limit: 500, offset });
			items.push(...page.items);
			if (page.items.length === 0 || offset + page.items.length >= page.total) return items;
		}
	},

	createItem(uuid: string, item: CatalogItemInput) {
		return request<CatalogItem>("POST", `/projects/${uuid}/items`, item);
	},

	updateItem(uuid: string, item: string, changes: CatalogItemInput) {
		return request<CatalogItem>("PATCH", `/projects/${uuid}/items/${item}`, changes);
	},

	deleteItem(uuid: string, item: string) {
		return request<null>("DELETE", `/projects/${uuid}/items/${item}`);
	},

	itemKeys(uuid: string, item: string, options: { status?: string; limit?: number; offset?: number } = {}) {
		const query = new URLSearchParams();
		if (options.status) query.set("status", options.status);
		if (options.limit) query.set("limit", String(options.limit));
		if (options.offset) query.set("offset", String(options.offset));
		const suffix = query.toString() ? `?${query}` : "";
		return request<{ keys: ItemKey[]; stock: KeyStock; total: number }>("GET", `/projects/${uuid}/items/${item}/keys${suffix}`);
	},

	addItemKeys(uuid: string, item: string, keys: string) {
		return request<{ added: number; duplicates: number; stock: KeyStock }>("POST", `/projects/${uuid}/items/${item}/keys`, { keys });
	},

	deleteItemKey(uuid: string, item: string, key: string) {
		return request<{ stock: KeyStock }>("DELETE", `/projects/${uuid}/items/${item}/keys/${key}`);
	},

	invoiceKeys(uuid: string, invoice: string) {
		return request<InvoiceKeys>("GET", `/projects/${uuid}/invoices/${invoice}/keys`);
	},

	emailInvoiceKeys(uuid: string, invoice: string, to?: string) {
		return request<EmailMessage>("POST", `/projects/${uuid}/invoices/${invoice}/keys/email`, to === undefined ? {} : { to });
	},

	itemSales(uuid: string) {
		return request<ReportState<ItemSalesReport>>("GET", `/projects/${uuid}/items/stats`);
	},
	generateItemSales(uuid: string, period: { from?: number; to?: number } = {}) {
		const query = new URLSearchParams();
		if (period.from !== undefined) query.set("from", String(period.from));
		if (period.to !== undefined) query.set("to", String(period.to));
		const suffix = query.toString() ? `?${query}` : "";
		return request<GeneratedReport<ItemSalesReport>>("POST", `/projects/${uuid}/items/stats${suffix}`);
	},

	invoices(uuid: string, options: { status?: string; document?: DocumentKind; customer?: string; reference?: string; limit?: number; offset?: number } = {}) {
		const query = new URLSearchParams();
		if (options.status) query.set("status", options.status);
		if (options.document) query.set("document", options.document);
		if (options.customer) query.set("customer", options.customer);
		if (options.reference) query.set("reference", options.reference);
		if (options.limit) query.set("limit", String(options.limit));
		if (options.offset) query.set("offset", String(options.offset));
		const suffix = query.toString() ? `?${query}` : "";
		return request<{ invoices: Invoice[]; total: number; totals: CurrencyTotal[] }>("GET", `/projects/${uuid}/invoices${suffix}`);
	},

	invoice(uuid: string, invoice: string) {
		return request<Invoice>("GET", `/projects/${uuid}/invoices/${invoice}`);
	},

	recurringList(uuid: string, options: { status?: RecurringStatus; customer?: string; search?: string } = {}) {
		return request<RecurringSummary[]>("GET", `/projects/${uuid}/recurring${listQuery(options)}`);
	},

	recurringInvoices(uuid: string, recurring: string, options: { limit?: number; offset?: number } = {}) {
		return request<{ invoices: Invoice[]; total: number }>("GET", `/projects/${uuid}/recurring/${recurring}/invoices${listQuery(options)}`);
	},

	recurring(uuid: string, recurring: string) {
		return request<RecurringDetail>("GET", `/projects/${uuid}/recurring/${recurring}`);
	},

	createRecurring(uuid: string, recurring: RecurringInput) {
		return request<RecurringDetail>("POST", `/projects/${uuid}/recurring`, recurring);
	},

	updateRecurring(uuid: string, recurring: string, changes: RecurringInput) {
		return request<RecurringDetail>("PATCH", `/projects/${uuid}/recurring/${recurring}`, changes);
	},

	recurringAction(uuid: string, recurring: string, action: "pause" | "resume" | "cancel" | "run") {
		return request<RecurringDetail>("POST", `/projects/${uuid}/recurring/${recurring}/${action}`, {});
	},

	deleteRecurring(uuid: string, recurring: string) {
		return request<null>("DELETE", `/projects/${uuid}/recurring/${recurring}`);
	},

	createInvoice(
		uuid: string,
		invoice: ReferenceDocumentInput & {
			customer: string | null;
			currency: string;
			due_date: number;
			supply_date?: number | null;
			items: ItemInput[];
			discount_amount: number;
			notes: string | null;
			tax_exchange_rate?: number | null;
			status?: "draft" | "open";
		},
		requestKey?: string
	) {
		return request<Invoice>("POST", `/projects/${uuid}/invoices`, invoice, requestKey ? { "Idempotency-Key": requestKey } : undefined);
	},

	setReferenceDocument(uuid: string, invoice: string, reference: ReferenceDocumentInput) {
		return request<Invoice>("PUT", `/projects/${uuid}/invoices/${invoice}/reference-document`, reference);
	},

	updateInvoice(uuid: string, invoice: string, changes: Record<string, unknown>) {
		return request<Invoice>("PATCH", `/projects/${uuid}/invoices/${invoice}`, changes);
	},

	openInvoice(uuid: string, invoice: string) {
		return request<Invoice>("POST", `/projects/${uuid}/invoices/${invoice}/open`);
	},

	createProforma(uuid: string, invoice: string, settlement?: ProformaSettlement) {
		return request<Invoice>("POST", `/projects/${uuid}/invoices/${invoice}/proforma`, settlement ? { settlement } : {});
	},

	updateProforma(uuid: string, invoice: string, settlement: ProformaSettlement) {
		return request<Invoice>("PATCH", `/projects/${uuid}/invoices/${invoice}/proforma`, { settlement });
	},

	cancelInvoice(uuid: string, invoice: string, reason?: string) {
		return request<Invoice>("POST", `/projects/${uuid}/invoices/${invoice}/cancel`, reason ? { reason } : {});
	},

	invoiceCredits(uuid: string, invoice: string) {
		return request<InvoiceCredits>("GET", `/projects/${uuid}/invoices/${invoice}/credit-notes`);
	},

	createCreditNote(uuid: string, invoice: string, body: { reason?: string | null; amount?: number; lines?: { line: string; amount: number }[] }) {
		return request<CreditNote>("POST", `/projects/${uuid}/invoices/${invoice}/credit-notes`, body);
	},

	creditNoteDocument(uuid: string, note: string) {
		return request<CreditNoteDocument>("GET", `/projects/${uuid}/credit-notes/${note}/document`);
	},

	creditNotePdf(uuid: string, note: string) {
		return requestFile(`/projects/${uuid}/credit-notes/${note}/pdf`, "credit-note.pdf");
	},

	creditNoteEslog(uuid: string, note: string) {
		return requestFile(`/projects/${uuid}/credit-notes/${note}/eslog`, "credit-note.xml");
	},

	emailCreditNote(uuid: string, note: string, email: { to?: string | null; message?: string | null; attach_invoice?: boolean; attach_eslog?: boolean }) {
		return request<EmailMessage>("POST", `/projects/${uuid}/credit-notes/${note}/email`, email);
	},

	deleteInvoice(uuid: string, invoice: string) {
		return request<null>("DELETE", `/projects/${uuid}/invoices/${invoice}`);
	},

	transactions(
		uuid: string,
		options: { invoice?: string; status?: string; type?: string; processor?: string; customer?: string; search?: string; limit?: number; offset?: number } = {}
	) {
		return request<{ transactions: Transaction[]; total: number; totals: TransactionTotal[] }>("GET", `/projects/${uuid}/transactions${listQuery(options)}`);
	},

	transaction(uuid: string, transaction: string) {
		return request<Transaction>("GET", `/projects/${uuid}/transactions/${transaction}`);
	},

	recordPayment(
		uuid: string,
		payment: { invoice: string; processor: string; amount: number; fee_amount: number; processor_tx_id: string | null; status: string; notes: string | null }
	) {
		return request<Transaction & { invoice_balance: { status: string } }>("POST", `/projects/${uuid}/transactions`, payment);
	},

	refund(uuid: string, transaction: string, body: { amount?: number; reason?: string | null; credit_note?: boolean }) {
		return request<Transaction>("POST", `/projects/${uuid}/transactions/${transaction}/refund`, body);
	},

	invoiceNumbering(uuid: string, format?: string, series: NumberSeries = "invoice") {
		const query = new URLSearchParams({ series });
		if (format !== undefined) query.set("format", format);
		return request<InvoiceNumbering>("GET", `/projects/${uuid}/invoice-numbering?${query}`);
	},

	saveInvoiceNumbering(uuid: string, body: { series?: NumberSeries; format: string; next_number?: number }) {
		return request<InvoiceNumbering>("PUT", `/projects/${uuid}/invoice-numbering`, body);
	},

	license(uuid: string) {
		return request<ProjectLicense>("GET", `/projects/${uuid}/license`);
	},

	previewLicense(uuid: string, code: string) {
		return request<LicensePreview>("POST", `/projects/${uuid}/license/preview`, { code });
	},

	redeemLicense(uuid: string, code: string, startsAt: number | null = null) {
		return request<ProjectLicense>("POST", `/projects/${uuid}/license/redeem`, { code, starts_at: startsAt });
	},

	uploadLogo(uuid: string, data: string) {
		return request<{ logo: string }>("PUT", `/projects/${uuid}/branding/logo`, { data });
	},

	removeLogo(uuid: string) {
		return request<null>("DELETE", `/projects/${uuid}/branding/logo`);
	},

	emailServer(uuid: string) {
		return request<EmailServer | null>("GET", `/projects/${uuid}/email-server`);
	},

	saveEmailServer(uuid: string, server: EmailServerInput) {
		return request<EmailServer>("PUT", `/projects/${uuid}/email-server`, server);
	},

	removeEmailServer(uuid: string) {
		return request<null>("DELETE", `/projects/${uuid}/email-server`);
	},

	testEmailServer(uuid: string, to: string) {
		return request<{ to: string }>("POST", `/projects/${uuid}/email-server/test`, to ? { to } : {});
	},

	emailDesign(uuid: string) {
		return request<{ design: EmailDesign; white_label: boolean; applied: EmailDesign; defaults: Record<CustomerEmailKind, EmailTexts> }>(
			"GET",
			`/projects/${uuid}/email-design`
		);
	},

	saveEmailDesign(uuid: string, design: EmailDesign) {
		return request<{ design: EmailDesign }>("PUT", `/projects/${uuid}/email-design`, design);
	},

	previewEmailDesign(uuid: string, design: EmailDesign, kind: CustomerEmailKind) {
		return request<{ subject: string; html: string }>("POST", `/projects/${uuid}/email-design/preview`, { design, kind });
	},

	invoiceDesign(uuid: string) {
		return request<{ design: InvoiceDesign; white_label: boolean; applied: InvoiceDesign }>("GET", `/projects/${uuid}/invoice-design`);
	},

	saveInvoiceDesign(uuid: string, design: InvoiceDesign) {
		return request<{ design: InvoiceDesign; white_label: boolean; applied: InvoiceDesign }>("PUT", `/projects/${uuid}/invoice-design`, design);
	},

	previewInvoiceDocument(uuid: string, design: InvoiceDesign, kind: "invoice" | "receipt" | "credit_note") {
		return request<{ kind: "credit_note"; document: CreditNoteDocument } | { kind: "invoice" | "receipt"; document: InvoiceDocument }>(
			"POST",
			`/projects/${uuid}/invoice-design/preview`,
			{ design, kind, format: "document" }
		);
	},

	async previewInvoiceDesign(uuid: string, design: InvoiceDesign, kind: "invoice" | "receipt" | "credit_note"): Promise<Blob> {
		const response = await send("POST", `/projects/${uuid}/invoice-design/preview`, { design, kind });
		if (!response.ok || response.headers.get("Content-Type")?.includes("application/json")) {
			await payloadOf<never>(response);
			throw new ApiError(-1, response.status, "The server returned an unreadable response.");
		}
		return await response.blob();
	},

	store(uuid: string) {
		return request<StoreState>("GET", `/projects/${uuid}/store`);
	},

	storeLanguages(uuid: string) {
		return request<StoreLanguages>("GET", `/projects/${uuid}/store/languages`);
	},

	saveStoreLanguage(
		uuid: string,
		code: string,
		body: { name: string | null; enabled: boolean; strings: Record<string, string>; content?: Record<string, string> }
	) {
		return request<StoreLanguages>("PUT", `/projects/${uuid}/store/languages/${encodeURIComponent(code)}`, body);
	},

	removeStoreLanguage(uuid: string, code: string) {
		return request<StoreLanguages>("DELETE", `/projects/${uuid}/store/languages/${encodeURIComponent(code)}`);
	},

	saveStore(uuid: string, body: { slug: string; enabled: boolean; config: StoreConfig }) {
		return request<StoreState>("PUT", `/projects/${uuid}/store`, body);
	},

	storeDomain(uuid: string) {
		return request<StoreDomainState>("GET", `/projects/${uuid}/store/domain`);
	},

	connectStoreDomain(uuid: string, hostname: string) {
		return request<StoreDomainState>("POST", `/projects/${uuid}/store/domain`, { hostname });
	},

	checkStoreDomain(uuid: string) {
		return request<StoreDomainState>("POST", `/projects/${uuid}/store/domain/check`, {});
	},

	removeStoreDomain(uuid: string) {
		return request<StoreDomainState>("DELETE", `/projects/${uuid}/store/domain`);
	},

	uploadStoreImage(uuid: string, kind: "logo" | "hero", data: string) {
		return request<{ url: string }>("PUT", `/projects/${uuid}/store/images/${kind}`, { data });
	},

	removeStoreImage(uuid: string, kind: "logo" | "hero") {
		return request<null>("DELETE", `/projects/${uuid}/store/images/${kind}`);
	},

	storeCategories(uuid: string) {
		return request<StoreCategory[]>("GET", `/projects/${uuid}/store/categories`);
	},

	createStoreCategory(uuid: string, body: StoreCategoryInput) {
		return request<StoreCategory>("POST", `/projects/${uuid}/store/categories`, body);
	},

	updateStoreCategory(uuid: string, category: string, body: StoreCategoryInput) {
		return request<StoreCategory>("PATCH", `/projects/${uuid}/store/categories/${category}`, body);
	},

	deleteStoreCategory(uuid: string, category: string) {
		return request<null>("DELETE", `/projects/${uuid}/store/categories/${category}`);
	},

	storeCoupons(uuid: string) {
		return request<StoreCoupon[]>("GET", `/projects/${uuid}/store/coupons`);
	},

	createStoreCoupon(uuid: string, body: StoreCouponInput) {
		return request<StoreCoupon>("POST", `/projects/${uuid}/store/coupons`, body);
	},

	updateStoreCoupon(uuid: string, coupon: string, body: Partial<StoreCouponInput>) {
		return request<StoreCoupon>("PATCH", `/projects/${uuid}/store/coupons/${coupon}`, body);
	},

	deleteStoreCoupon(uuid: string, coupon: string) {
		return request<null>("DELETE", `/projects/${uuid}/store/coupons/${coupon}`);
	},

	storeProducts(uuid: string, options: { search?: string; status?: string; category?: string; limit?: number; offset?: number } = {}) {
		return request<{ products: StoreListedProduct[]; total: number }>("GET", `/projects/${uuid}/store/products${listQuery(options)}`);
	},

	storeProduct(uuid: string, item: string) {
		return request<StoreProductDetails>("GET", `/projects/${uuid}/store/products/${item}`);
	},

	saveStoreProduct(uuid: string, item: string, body: StoreProductInput) {
		return request<StoreProductDetails>("PUT", `/projects/${uuid}/store/products/${item}`, body);
	},

	unlistStoreProduct(uuid: string, item: string) {
		return request<null>("DELETE", `/projects/${uuid}/store/products/${item}`);
	},

	addStoreProductImage(uuid: string, item: string, data: string, alt: string | null) {
		return request<StoreImage>("POST", `/projects/${uuid}/store/products/${item}/images`, { data, alt });
	},

	arrangeStoreProductImages(uuid: string, item: string, images: { uuid: string; alt: string | null }[]) {
		return request<StoreProductDetails>("PUT", `/projects/${uuid}/store/products/${item}/images`, { images });
	},

	removeStoreProductImage(uuid: string, item: string, image: string) {
		return request<null>("DELETE", `/projects/${uuid}/store/products/${item}/images/${image}`);
	},

	storeAttributes(uuid: string) {
		return request<{ name: string; values: string[] }[]>("GET", `/projects/${uuid}/store/attributes`);
	},

	storeOrders(uuid: string, options: { fulfillment?: string; payment?: string; search?: string; limit?: number; offset?: number } = {}) {
		return request<{ orders: StoreOrder[]; total: number }>("GET", `/projects/${uuid}/store/orders${listQuery(options)}`);
	},

	storeOrder(uuid: string, invoice: string) {
		return request<StoreOrder>("GET", `/projects/${uuid}/store/orders/${invoice}`);
	},

	updateStoreOrder(uuid: string, invoice: string, body: { fulfillment?: StoreFulfillment; tracking_url?: string | null; notify?: boolean }) {
		return request<StoreOrder>("PATCH", `/projects/${uuid}/store/orders/${invoice}`, body);
	},

	cancelStoreOrder(uuid: string, invoice: string, reason: string | null) {
		return request<StoreOrder>("POST", `/projects/${uuid}/store/orders/${invoice}/cancel`, { reason });
	},
	workforce(uuid: string) {
		return request<WorkforceState>("GET", `/projects/${uuid}/workforce`);
	},

	saveWorkforceSettings(uuid: string, config: WorkforceConfig) {
		return request<WorkforceConfig>("PUT", `/projects/${uuid}/workforce/settings`, config);
	},

	workforceHolidays(uuid: string, year: number) {
		return request<{ year: number; country: string | null; holidays: WorkforceHoliday[] }>("GET", `/projects/${uuid}/workforce/holidays?year=${year}`);
	},

	addWorkforceHoliday(uuid: string, date: string, name: string) {
		return request<{ uuid: string }>("POST", `/projects/${uuid}/workforce/holidays`, { date, name });
	},

	removeWorkforceHoliday(uuid: string, holiday: string) {
		return request<null>("DELETE", `/projects/${uuid}/workforce/holidays/${holiday}`);
	},

	timesheet(uuid: string, options: { from: string; to: string; member?: string }) {
		return request<Timesheet>("GET", `/projects/${uuid}/timesheets${listQuery(options)}`);
	},

	fillTimesheet(uuid: string, fill: { member: string; from: string; to: string; start: string; break_start: string | null; reason: string | null }) {
		return request<{ filled: number; days: string[]; skipped: { absent: number; logged: number; not_employed: number } }>(
			"POST",
			`/projects/${uuid}/timesheets/fill`,
			fill
		);
	},

	saveTimesheetDay(uuid: string, day: { member: string; work_date: string; entries: TimesheetDayEntry[]; reason: string | null }) {
		return request<TimesheetDay>("PUT", `/projects/${uuid}/timesheets/day`, day);
	},

	workforceRevisions(uuid: string, options: { member?: string; record?: string; limit?: number; offset?: number }) {
		return request<{ revisions: WorkforceRevision[]; total: number }>("GET", `/projects/${uuid}/workforce/revisions${listQuery(options)}`);
	},

	absences(uuid: string, options: { from: string; to: string; member?: string; status?: AbsenceStatus }) {
		return request<Absence[]>("GET", `/projects/${uuid}/absences${listQuery(options)}`);
	},

	createAbsence(uuid: string, absence: AbsenceInput) {
		return request<Absence>("POST", `/projects/${uuid}/absences`, absence);
	},

	updateAbsence(uuid: string, absence: string, changes: AbsenceInput) {
		return request<Absence>("PATCH", `/projects/${uuid}/absences/${absence}`, changes);
	},

	decideAbsence(uuid: string, absence: string, status: "approved" | "rejected", note: string | null) {
		return request<Absence>("POST", `/projects/${uuid}/absences/${absence}/decision`, { status, note });
	},

	cancelAbsence(uuid: string, absence: string) {
		return request<null>("POST", `/projects/${uuid}/absences/${absence}/cancel`, {});
	},

	vacationBalance(uuid: string, options: { member?: string; year?: number }) {
		return request<VacationBalance>("GET", `/projects/${uuid}/workforce/balance${listQuery(options)}`);
	},

	saveVacationBalance(uuid: string, balance: { member: string; year: number; entitled_days: number | null; carried_days: number }) {
		return request<VacationBalance>("PUT", `/projects/${uuid}/workforce/balance`, balance);
	},

	timesheetReport(uuid: string, month: string, member?: string) {
		return request<MonthReport>("GET", `/projects/${uuid}/timesheets/report${listQuery({ month, member })}`);
	},

	timesheetReportCsv(uuid: string, month: string, member?: string) {
		return requestFile(`/projects/${uuid}/timesheets/report${listQuery({ month, member, format: "csv" })}`, `timesheet-${month}.csv`);
	},

	timesheetReportPdf(uuid: string, month: string, member?: string) {
		return requestFile(`/projects/${uuid}/timesheets/report${listQuery({ month, member, format: "pdf" })}`, `timesheet-${month}.pdf`);
	},

	tickets(uuid: string, options: { status?: string; customer?: string; assignee?: string; search?: string; limit?: number; offset?: number } = {}) {
		return request<{ tickets: Ticket[]; total: number }>("GET", `/projects/${uuid}/tickets${listQuery(options)}`);
	},

	ticket(uuid: string, ticket: string) {
		return request<TicketDetails>("GET", `/projects/${uuid}/tickets/${ticket}`);
	},

	createTicket(uuid: string, ticket: TicketInput) {
		return request<Ticket>("POST", `/projects/${uuid}/tickets`, ticket);
	},

	updateTicket(uuid: string, ticket: string, changes: TicketInput) {
		return request<Ticket>("PATCH", `/projects/${uuid}/tickets/${ticket}`, changes);
	},

	deleteTicket(uuid: string, ticket: string) {
		return request<null>("DELETE", `/projects/${uuid}/tickets/${ticket}`);
	},

	commentTicket(uuid: string, ticket: string, body: string, internal: boolean) {
		return request<TicketComment>("POST", `/projects/${uuid}/tickets/${ticket}/comments`, { body, internal });
	},

	deleteTicketComment(uuid: string, ticket: string, comment: string) {
		return request<null>("DELETE", `/projects/${uuid}/tickets/${ticket}/comments/${comment}`);
	},

	invoiceTicket(uuid: string, ticket: string) {
		return request<{ invoice: string; reference: string; minutes: number; quantity: number; rate: number | null }>(
			"POST",
			`/projects/${uuid}/tickets/${ticket}/invoice`,
			{}
		);
	},

	ticketAccess(uuid: string, customer: string) {
		return request<TicketAccess>("GET", `/projects/${uuid}/customers/${customer}/ticket-access`);
	},

	saveTicketAccess(uuid: string, customer: string, enabled: boolean, kinds: TicketKind[]) {
		return request<TicketAccess>("PUT", `/projects/${uuid}/customers/${customer}/ticket-access`, { enabled, kinds });
	},

	employees(uuid: string) {
		return request<EmployeeListing[]>("GET", `/projects/${uuid}/employees`);
	},

	saveEmployee(uuid: string, member: string, employee: EmployeeInput) {
		return request<EmployeeRecord>("PUT", `/projects/${uuid}/employees/${member}`, employee);
	},

	deleteEmployee(uuid: string, member: string) {
		return request<null>("DELETE", `/projects/${uuid}/employees/${member}`);
	},

	payroll(uuid: string, month: string) {
		return request<{ month: string; currency: string; lines: PayrollLine[] }>("GET", `/projects/${uuid}/payroll?month=${month}`);
	},
	payrollRates(uuid: string) {
		return request<{ tables: PayrollRatesTable[]; presets: { period: string; label: string; rates: PayrollRates }[] }>(
			"GET",
			`/projects/${uuid}/payroll/rates`
		);
	},

	savePayrollRates(uuid: string, period: string, rates: PayrollRates, verified: boolean) {
		return request<PayrollRatesTable>("PUT", `/projects/${uuid}/payroll/rates/${period}`, { rates, verified });
	},

	deletePayrollRates(uuid: string, period: string) {
		return request<null>("DELETE", `/projects/${uuid}/payroll/rates/${period}`);
	},

	payrollRuns(uuid: string) {
		return request<PayrollRunSummary[]>("GET", `/projects/${uuid}/payroll/runs`);
	},

	payrollRun(uuid: string, run: string) {
		return request<PayrollRunDetails>("GET", `/projects/${uuid}/payroll/runs/${run}`);
	},

	createPayrollRun(uuid: string, period: string, payDate: string | null) {
		return request<PayrollRunDetails>("POST", `/projects/${uuid}/payroll/runs`, { period, pay_date: payDate });
	},

	updatePayrollRun(uuid: string, run: string, payDate: string | null) {
		return request<PayrollRunDetails>("PATCH", `/projects/${uuid}/payroll/runs/${run}`, { pay_date: payDate });
	},

	payrollRunAction(uuid: string, run: string, action: "recalculate" | "finalize" | "reopen") {
		return request<PayrollRunDetails>("POST", `/projects/${uuid}/payroll/runs/${run}/${action}`, {});
	},

	deletePayrollRun(uuid: string, run: string) {
		return request<null>("DELETE", `/projects/${uuid}/payroll/runs/${run}`);
	},

	savePayrollItems(uuid: string, run: string, line: string, items: PayrollItem[]) {
		return request<PayrollRunDetails>("PUT", `/projects/${uuid}/payroll/runs/${run}/lines/${line}/items`, { items });
	},

	payrollCsv(uuid: string, run: string, period: string) {
		return requestFile(`/projects/${uuid}/payroll/runs/${run}/export`, `payroll-${period}.csv`);
	},

	rekO(
		uuid: string,
		run: string,
		period: string,
		options: { kind: "salary" | "regres" | "performance"; responsible: string; contact: string; taxpayer_type: "PO" | "SP"; collective_agreement: string }
	) {
		return requestFile(`/projects/${uuid}/payroll/runs/${run}/rek-o${listQuery(options)}`, `REK-O-${options.kind}-${period}.xml`);
	},

	salaryTransfers(uuid: string, run: string, period: string, overrides: { iban?: string; bic?: string; name?: string }) {
		return requestFile(`/projects/${uuid}/payroll/runs/${run}/sepa${listQuery(overrides)}`, `salaries-${period}.xml`);
	},

	payslips(uuid: string, run: string, period: string, line?: string) {
		return requestFile(`/projects/${uuid}/payroll/runs/${run}/payslips${listQuery({ line })}`, `payslips-${period}.pdf`);
	},
};

function listQuery(options: Record<string, string | number | boolean | null | undefined>): string {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
	}
	return query.toString() ? `?${query}` : "";
}

export const AdminApi = {
	overview() {
		return request<AdminOverview>("GET", "/admin/overview");
	},

	settings() {
		return request<AdminSettings>("GET", "/admin/settings");
	},

	updateSettings(values: Record<string, SettingValue | null>) {
		return request<AdminSettings>("PATCH", "/admin/settings", { values });
	},

	testSettings(group: string, values: Record<string, SettingValue | null>) {
		return request<ConnectionStatus>("POST", `/admin/settings/${group}/test`, { values });
	},

	backups() {
		return request<AdminBackups>("GET", "/admin/backups");
	},

	runBackup() {
		return request<BackupResult>("POST", "/admin/backups");
	},

	licenses(options: { status?: string; type?: string; search?: string; limit?: number; offset?: number } = {}) {
		return request<{ licenses: License[]; total: number; limit: number; offset: number }>("GET", `/admin/licenses${listQuery(options)}`);
	},

	createLicenses(license: LicenseInput) {
		return request<License[]>("POST", "/admin/licenses", license);
	},

	updateLicense(uuid: string, changes: LicenseInput) {
		return request<License>("PATCH", `/admin/licenses/${uuid}`, changes);
	},

	revokeLicense(uuid: string) {
		return request<License>("POST", `/admin/licenses/${uuid}/revoke`, {});
	},

	projects(options: { search?: string; limit?: number; offset?: number } = {}) {
		return request<{ projects: AdminProject[]; total: number; period: string }>("GET", `/admin/projects${listQuery(options)}`);
	},

	updateProject(uuid: string, changes: { free_transactions: number | null }) {
		return request<AdminProject>("PATCH", `/admin/projects/${uuid}`, changes);
	},

	previewLicense(uuid: string, code: string) {
		return request<LicensePreview>("POST", `/admin/projects/${uuid}/licenses/preview`, { code });
	},

	applyLicense(uuid: string, code: string, startsAt: number | null = null) {
		return request<AdminProject>("POST", `/admin/projects/${uuid}/licenses`, { code, starts_at: startsAt });
	},

	accounts(options: { search?: string; limit?: number; offset?: number } = {}) {
		return request<{ accounts: AdminAccount[]; total: number }>("GET", `/admin/accounts${listQuery(options)}`);
	},

	updateAccount(username: string, changes: { admin?: boolean; status?: string }) {
		return request<AdminAccount>("PATCH", `/admin/accounts/${encodeURIComponent(username)}`, changes);
	},

	legal() {
		return request<AdminLegal>("GET", "/admin/legal");
	},

	legalTemplate(kind: LegalKind, language: "en" | "sl") {
		return request<{ content: string }>("GET", `/admin/legal/${kind}/template?language=${language}`);
	},

	publishLegal(kind: LegalKind, content: { content_en: string | null; content_sl: string | null; effective: number | null; notify: boolean }) {
		return request<LegalDocument & { notified: number | null }>("POST", `/admin/legal/${kind}`, content);
	},

	exportAccount(username: string) {
		return requestDownload(`/admin/accounts/${encodeURIComponent(username)}/export`, `rabbitpay-${username}-data.json`);
	},

	deletionPlan(username: string) {
		return request<DeletionPlan>("GET", `/admin/accounts/${encodeURIComponent(username)}/deletion`);
	},

	deleteAccount(username: string) {
		return request<{ deleted: string; closed_projects: DeletionPlan["closing"] }>("DELETE", `/admin/accounts/${encodeURIComponent(username)}`, {
			confirm: username,
		});
	},

	resetTwoFactor(username: string) {
		return request<AdminAccount>("DELETE", `/admin/accounts/${encodeURIComponent(username)}/two-factor`);
	},

	invites(options: { search?: string; limit?: number; offset?: number } = {}) {
		return request<{ invites: RegistrationInvite[]; total: number }>("GET", `/admin/invites${listQuery(options)}`);
	},

	createInvite(invite: { max_uses: number | null; expires_at: number | null; note: string | null }) {
		return request<RegistrationInvite>("POST", "/admin/invites", invite);
	},

	revokeInvite(uuid: string) {
		return request<RegistrationInvite>("POST", `/admin/invites/${uuid}/revoke`, {});
	},
};
