import type { SQL } from "bun";
import Database, { dialect } from "./database/database";
import { Settings } from "./settings";
import { DEFAULT_SETTINGS } from "./settings-schema";
import { ErrorCode } from "./errors";
import { isLicenseIssuer, looksSigned, readSignedLicense, signLicense } from "./license-signing";
import { serverId } from "./server-identity";
import { countedMembers, pendingTimeTrackers } from "./workforce/people";
import { MAX_LICENSE_DAYS, MAX_LICENSE_EMAILS, MAX_LICENSE_EMPLOYEES, MAX_LICENSE_STORAGE_GB, MAX_LICENSE_TRANSACTIONS } from "./license-pricing";

export { MAX_LICENSE_DAYS, MAX_LICENSE_EMAILS, MAX_LICENSE_EMPLOYEES, MAX_LICENSE_STORAGE_GB, MAX_LICENSE_TRANSACTIONS };
import type { LicenseBilling, LicenseKeyRow, LicenseType, ProjectRow, ProjectUsageRow } from "./database/models";

export const DAY = 24 * 60 * 60 * 1000;
export const LICENSE_TYPES: LicenseType[] = ["transactions", "white_label", "storage", "store", "workforce", "employees", "accounting", "emails"];
export const TIMED_LICENSE_TYPES: LicenseType[] = ["white_label", "store", "workforce", "employees", "accounting", "storage"];
export const SCHEDULED_LICENSE_TYPES: LicenseType[] = ["employees", "storage"];
export const ADD_ON_LICENSE_TYPES: LicenseType[] = ["white_label", "store", "workforce", "accounting"];
export const MAX_LICENSE_BATCH = 100;
export const STORAGE_GB_BYTES = 1_000_000_000;

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_GROUPS = 4;
const CODE_GROUP_LENGTH = 5;
const METER_BATCH = 500;

export function isLicenseType(value: unknown): value is LicenseType {
	return typeof value === "string" && LICENSE_TYPES.includes(value as LicenseType);
}

export function generateLicenseCode(): string {
	const bytes = new Uint8Array(CODE_GROUPS * CODE_GROUP_LENGTH);
	crypto.getRandomValues(bytes);

	const characters = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
	const groups: string[] = [];
	for (let index = 0; index < characters.length; index += CODE_GROUP_LENGTH) {
		groups.push(characters.slice(index, index + CODE_GROUP_LENGTH).join(""));
	}
	return `RPAY-${groups.join("-")}`;
}

export function normalizeLicenseCode(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const compact = value.toUpperCase().replace(/[\s-]/g, "");
	if (!compact.startsWith("RPAY")) return null;

	const body = compact.slice(4).replace(/[IL]/g, "1").replace(/O/g, "0");
	if (body.length !== CODE_GROUPS * CODE_GROUP_LENGTH || [...body].some((character) => !CODE_ALPHABET.includes(character))) return null;

	const groups: string[] = [];
	for (let index = 0; index < body.length; index += CODE_GROUP_LENGTH) groups.push(body.slice(index, index + CODE_GROUP_LENGTH));
	return `RPAY-${groups.join("-")}`;
}

export function maskLicenseCode(code: string): string {
	return `RPAY-*****-*****-*****-${code.slice(-CODE_GROUP_LENGTH)}`;
}

export function periodOf(timestamp: number): string {
	const date = new Date(timestamp);
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function periodEnd(timestamp: number): number {
	const date = new Date(timestamp);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

export function licensingEnforced(): boolean {
	return !isLicenseIssuer() || Settings.licensing.enabled;
}

export function includedPayments(): number {
	return isLicenseIssuer() ? Settings.licensing.free_transactions : DEFAULT_SETTINGS.licensing.free_transactions;
}

export function includedStorageGb(): number {
	return isLicenseIssuer() ? Settings.licensing.free_storage_gb : DEFAULT_SETTINGS.licensing.free_storage_gb;
}

export function includedEmployees(): number {
	return isLicenseIssuer() ? Settings.licensing.free_employees : DEFAULT_SETTINGS.licensing.free_employees;
}

export function freeAllowance(project: Pick<ProjectRow, "free_transactions">): number {
	return isLicenseIssuer() ? (project.free_transactions ?? Settings.licensing.free_transactions) : includedPayments();
}

export function emailsMetered(): boolean {
	return isLicenseIssuer() && Settings.licensing.enabled;
}

export function emailAllowance(project: Pick<ProjectRow, "free_emails">): number {
	return project.free_emails ?? Settings.licensing.free_emails;
}

export function whiteLabelActive(project: Pick<ProjectRow, "white_label_until">, now = Date.now()): boolean {
	if (!licensingEnforced()) return true;
	return project.white_label_until !== null && project.white_label_until > now;
}

export function storeActive(project: Pick<ProjectRow, "store_until">, now = Date.now()): boolean {
	if (!licensingEnforced()) return true;
	return project.store_until !== null && project.store_until > now;
}

export function workforceActive(project: Pick<ProjectRow, "workforce_until">, now = Date.now()): boolean {
	if (!licensingEnforced()) return true;
	return project.workforce_until !== null && project.workforce_until > now;
}

export function accountingActive(project: Pick<ProjectRow, "accounting_until">, now = Date.now()): boolean {
	if (!licensingEnforced()) return true;
	return project.accounting_until !== null && project.accounting_until > now;
}

export function extendWhiteLabel(current: number | null, days: number, now = Date.now()): number {
	return Math.max(current ?? 0, now) + days * DAY;
}

async function usageRow(sql: SQL, projectId: string, period: string): Promise<ProjectUsageRow> {
	if (dialect === "mysql")
		await sql`INSERT INTO project_usage(project, period, free_used, paid_used) VALUES(${projectId}, ${period}, 0, 0) ON DUPLICATE KEY UPDATE project = ${projectId}`;
	else
		await sql`INSERT INTO project_usage(project, period, free_used, paid_used) VALUES(${projectId}, ${period}, 0, 0) ON CONFLICT(project, period) DO NOTHING`;
	const [row] = (await sql`SELECT * FROM project_usage WHERE project = ${projectId} AND period = ${period}`) as ProjectUsageRow[];
	return row;
}

export interface EmailUsage {
	emails_metered: boolean;
	emails_free_allowance: number;
	emails_free_used: number;
	emails_paid_used: number;
	emails_paid_balance: number;
	emails_remaining: number | null;
}

export async function emailUsageFor(projectId: string, now = Date.now()): Promise<EmailUsage> {
	const [row] = (await Database`
		SELECT p.free_emails, p.paid_emails, COALESCE(u.emails_free_used, 0) AS free_used, COALESCE(u.emails_paid_used, 0) AS paid_used
		FROM projects p
		LEFT JOIN project_usage u ON u.project = p.uuid AND u.period = ${periodOf(now)}
		WHERE p.uuid = ${projectId}
	`) as { free_emails: number | null; paid_emails: number; free_used: number; paid_used: number }[];
	const metered = emailsMetered();
	const allowance = row ? emailAllowance(row) : 0;
	const freeUsed = Number(row?.free_used ?? 0);
	const balance = Number(row?.paid_emails ?? 0);
	return {
		emails_metered: metered,
		emails_free_allowance: allowance,
		emails_free_used: freeUsed,
		emails_paid_used: Number(row?.paid_used ?? 0),
		emails_paid_balance: balance,
		emails_remaining: metered ? Math.max(allowance - freeUsed, 0) + Math.max(balance, 0) : null,
	};
}

export async function hasEmailCapacity(projectId: string, now = Date.now()): Promise<boolean> {
	if (!emailsMetered()) return true;
	return ((await emailUsageFor(projectId, now)).emails_remaining ?? 0) > 0;
}

export async function billEmail(projectId: string, emailId: string, sentAt: number) {
	await Database.begin(async (tx) => {
		const [project] = (await tx`SELECT free_emails FROM projects WHERE uuid = ${projectId}`) as Pick<ProjectRow, "free_emails">[];
		if (!project) return;
		const period = periodOf(sentAt);
		const usage = await usageRow(tx, projectId, period);
		const billing: LicenseBilling = usage.emails_free_used < emailAllowance(project) ? "free" : "paid";

		const claimed = await tx`UPDATE email_messages SET license_billing = ${billing} WHERE uuid = ${emailId} AND license_billing IS NULL`;
		if (claimed.count === 0) return;

		if (billing === "free") {
			await tx`UPDATE project_usage SET emails_free_used = emails_free_used + 1 WHERE project = ${projectId} AND period = ${period}`;
		} else {
			await tx`UPDATE project_usage SET emails_paid_used = emails_paid_used + 1 WHERE project = ${projectId} AND period = ${period}`;
			await tx`UPDATE projects SET paid_emails = paid_emails - 1 WHERE uuid = ${projectId}`;
		}
	});
}

async function billPayment(sql: SQL, project: Pick<ProjectRow, "uuid" | "free_transactions">, payment: { uuid: string; settled_at: number }) {
	const enforced = licensingEnforced();
	const period = periodOf(payment.settled_at);
	const usage = enforced ? await usageRow(sql, project.uuid, period) : null;
	const billing: LicenseBilling = usage === null ? "unmetered" : usage.free_used < freeAllowance(project) ? "free" : "paid";

	const claimed = await sql`UPDATE transactions SET license_billing = ${billing} WHERE uuid = ${payment.uuid} AND license_billing IS NULL`;
	if (claimed.count === 0) return;

	if (billing === "free") {
		await sql`UPDATE project_usage SET free_used = free_used + 1 WHERE project = ${project.uuid} AND period = ${period}`;
	} else if (billing === "paid") {
		await sql`UPDATE project_usage SET paid_used = paid_used + 1 WHERE project = ${project.uuid} AND period = ${period}`;
		await sql`UPDATE projects SET paid_transactions = paid_transactions - 1 WHERE uuid = ${project.uuid}`;
	}
}

export async function meterProject(projectId: string): Promise<number> {
	let billed = 0;

	for (;;) {
		const pending = (await Database`
			SELECT uuid, COALESCE(completed_at, confirmed_at) AS settled_at FROM transactions
			WHERE project = ${projectId} AND type = 'payment' AND (completed_at IS NOT NULL OR confirmed_at IS NOT NULL) AND license_billing IS NULL
			ORDER BY settled_at ASC LIMIT ${METER_BATCH}
		`) as { uuid: string; settled_at: number }[];
		if (pending.length === 0) return billed;

		await Database.begin(async (tx) => {
			const [project] = (await tx`SELECT uuid, free_transactions FROM projects WHERE uuid = ${projectId}`) as Pick<ProjectRow, "uuid" | "free_transactions">[];
			if (!project) return;
			for (const payment of pending) await billPayment(tx, project, payment);
		});

		billed += pending.length;
		if (pending.length < METER_BATCH) return billed;
	}
}

export async function meterAll(): Promise<number> {
	const projects = (await Database`
		SELECT DISTINCT project FROM transactions
		WHERE type = 'payment' AND (completed_at IS NOT NULL OR confirmed_at IS NOT NULL) AND license_billing IS NULL
		LIMIT 1000
	`) as { project: string }[];

	let billed = 0;
	for (const { project } of projects) billed += await meterProject(project);
	return billed;
}

export interface ProjectUsage {
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
	employee_seats: EmployeeSeatGrant[];
	storage_included: number;
	storage_licensed: number;
	storage_used: number;
	storage_limit: number | null;
	storage_remaining: number | null;
	storage_grants: StorageGrant[];
	scheduled: ScheduledAddOn[];
	emails_metered: boolean;
	emails_free_allowance: number;
	emails_free_used: number;
	emails_paid_used: number;
	emails_paid_balance: number;
	emails_remaining: number | null;
}

export interface EmployeeSeatGrant {
	employees: number;
	from: number;
	until: number;
}

export interface EmployeeSeatUsage {
	employees_included: number;
	employees_licensed: number;
	employees_used: number;
	employees_limit: number | null;
	employee_seats: EmployeeSeatGrant[];
}

export function licensePeriod(key: Pick<LicenseKeyRow, "duration_days" | "redeemed_at" | "starts_at">): { from: number; until: number } {
	const from = Number(key.starts_at ?? key.redeemed_at ?? 0);
	return { from, until: from + Number(key.duration_days ?? 0) * DAY };
}

async function scheduledKeys(projectId: string, type: LicenseType, now: number) {
	const keys = (await Database`
		SELECT employees, storage_gb, duration_days, redeemed_at, starts_at FROM license_keys
		WHERE redeemed_project = ${projectId} AND type = ${type} AND status = 'redeemed'
	`) as Pick<LicenseKeyRow, "employees" | "storage_gb" | "duration_days" | "redeemed_at" | "starts_at">[];
	return keys
		.map((key) => ({ employees: Number(key.employees ?? 0), storage_gb: Number(key.storage_gb ?? 0), ...licensePeriod(key) }))
		.filter((grant) => grant.until > now)
		.sort((first, second) => first.from - second.from || first.until - second.until);
}

export async function employeeSeatGrants(projectId: string, now = Date.now()): Promise<EmployeeSeatGrant[]> {
	return (await scheduledKeys(projectId, "employees", now)).map(({ employees, from, until }) => ({ employees, from, until }));
}

export async function employeeSeatsFor(projectId: string, now = Date.now()): Promise<EmployeeSeatUsage> {
	const grants = await employeeSeatGrants(projectId, now);
	const included = includedEmployees();
	const licensed = grants.filter((grant) => grant.from <= now).reduce((total, grant) => total + grant.employees, 0);
	return {
		employees_included: included,
		employees_licensed: licensed,
		employees_used: (await countedMembers(projectId)).size,
		employees_limit: licensingEnforced() ? included + licensed : null,
		employee_seats: grants,
	};
}

export async function employeeSeatsExceeded(projectId: string): Promise<boolean> {
	if (!licensingEnforced()) return false;
	const seats = await employeeSeatsFor(projectId);
	return seats.employees_used > (seats.employees_limit ?? 0);
}

export async function hasEmployeeSeatFor(projectId: string, member: string | null): Promise<boolean> {
	if (!licensingEnforced()) return true;
	if (member !== null && (await countedMembers(projectId)).has(member)) return true;
	const seats = await employeeSeatsFor(projectId);
	return seats.employees_used + (await pendingTimeTrackers(projectId, member)) < (seats.employees_limit ?? 0);
}

export interface StorageGrant {
	storage_gb: number;
	from: number;
	until: number;
}

export interface ProjectStorageUsage {
	storage_included: number;
	storage_licensed: number;
	storage_used: number;
	storage_limit: number | null;
	storage_remaining: number | null;
	storage_grants: StorageGrant[];
}

export async function storageGrants(projectId: string, now = Date.now()): Promise<StorageGrant[]> {
	return (await scheduledKeys(projectId, "storage", now)).map(({ storage_gb, from, until }) => ({ storage_gb, from, until }));
}

export async function storageFor(projectId: string, now = Date.now()): Promise<ProjectStorageUsage> {
	const grants = await storageGrants(projectId, now);
	const [totals] = (await Database`
		SELECT
			(SELECT COALESCE(SUM(d.byte_size), 0) FROM invoice_documents d JOIN invoices i ON i.uuid = d.invoice
				WHERE i.project = ${projectId} AND d.status = 'ready') AS invoices,
			(SELECT COALESCE(SUM(d.byte_size), 0) FROM credit_note_documents d JOIN credit_notes n ON n.uuid = d.credit_note
				WHERE n.project = ${projectId} AND d.status = 'ready') AS credit_notes,
			(SELECT COALESCE(SUM(a.byte_size), 0) FROM expense_attachments a JOIN expenses e ON e.uuid = a.expense
				WHERE e.project = ${projectId}) AS expenses,
			(SELECT COALESCE(SUM(a.byte_size), 0) FROM recorded_invoice_attachments a JOIN recorded_invoices r ON r.uuid = a.recorded_invoice
				WHERE r.project = ${projectId}) AS recorded,
			(SELECT COALESCE(SUM(byte_size), 0) FROM ddv_exports WHERE project = ${projectId}) AS exports,
			(SELECT COALESCE(SUM(archive_size), 0) FROM fiscal_documents WHERE project = ${projectId} AND archive_key IS NOT NULL) AS verified,
			(SELECT COALESCE(SUM(byte_size), 0) FROM store_images WHERE project = ${projectId}) AS store_images,
			(SELECT COALESCE(SUM(byte_size), 0) FROM eslog_documents WHERE project = ${projectId}) AS einvoices
	`) as {
		invoices: number;
		credit_notes: number;
		expenses: number;
		recorded: number;
		exports: number;
		verified: number;
		store_images: number;
		einvoices: number;
	}[];
	const included = includedStorageGb() * STORAGE_GB_BYTES;
	const licensed = grants.filter((grant) => grant.from <= now).reduce((total, grant) => total + grant.storage_gb, 0) * STORAGE_GB_BYTES;
	const used =
		safeStorageBytes(totals.invoices) +
		safeStorageBytes(totals.credit_notes) +
		safeStorageBytes(totals.expenses) +
		safeStorageBytes(totals.recorded) +
		safeStorageBytes(totals.exports) +
		safeStorageBytes(totals.verified) +
		safeStorageBytes(totals.store_images) +
		safeStorageBytes(totals.einvoices);
	const limit = included + licensed;
	return {
		storage_included: included,
		storage_licensed: licensed,
		storage_used: used,
		storage_limit: licensingEnforced() ? limit : null,
		storage_remaining: licensingEnforced() ? limit - used : null,
		storage_grants: grants,
	};
}

function safeStorageBytes(value: number): number {
	const bytes = Number(value);
	if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid stored document size");
	return bytes;
}

export async function usageFor(projectId: string, now = Date.now()): Promise<ProjectUsage> {
	await meterProject(projectId);
	await activateScheduledLicenses(projectId, now);

	const period = periodOf(now);
	const [project] = (await Database`
		SELECT free_transactions, paid_transactions, white_label_until, store_until, workforce_until, accounting_until FROM projects WHERE uuid = ${projectId}
	`) as Pick<ProjectRow, "free_transactions" | "paid_transactions" | "white_label_until" | "store_until" | "workforce_until" | "accounting_until">[];
	const [usage] = (await Database`SELECT * FROM project_usage WHERE project = ${projectId} AND period = ${period}`) as ProjectUsageRow[];

	const enforced = licensingEnforced();
	const allowance = freeAllowance(project);
	const freeUsed = usage?.free_used ?? 0;
	const storage = await storageFor(projectId, now);

	return {
		enforced,
		period,
		resets_at: periodEnd(now),
		free_allowance: allowance,
		free_used: freeUsed,
		paid_used: usage?.paid_used ?? 0,
		paid_balance: project.paid_transactions,
		remaining: enforced ? Math.max(allowance - freeUsed, 0) + project.paid_transactions : null,
		white_label: whiteLabelActive(project, now),
		white_label_until: project.white_label_until,
		store: storeActive(project, now),
		store_until: project.store_until,
		workforce: workforceActive(project, now),
		workforce_until: project.workforce_until,
		accounting: accountingActive(project, now),
		accounting_until: project.accounting_until,
		...(await employeeSeatsFor(projectId, now)),
		...storage,
		scheduled: await scheduledAddOns(projectId, project, now),
		...(await emailUsageFor(projectId, now)),
	};
}

export async function hasStorageCapacity(projectId: string, bytes = 1, replacingBytes = 0): Promise<boolean> {
	if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(replacingBytes) || replacingBytes < 0) return false;
	if (!licensingEnforced()) return true;
	const usage = await storageFor(projectId);
	return bytes <= (usage.storage_remaining ?? 0) + replacingBytes;
}

export class StorageLimitReached extends Error {
	constructor() {
		super("This project has no document storage left. Redeem a storage license to continue.");
	}
}

export async function assertStorageCapacity(projectId: string, bytes = 1, replacingBytes = 0) {
	if (!(await hasStorageCapacity(projectId, bytes, replacingBytes))) throw new StorageLimitReached();
}

export async function hasCapacity(projectId: string): Promise<boolean> {
	if (!licensingEnforced()) return true;
	const period = periodOf(Date.now());
	const [usage] = (await Database`
		SELECT p.free_transactions, p.paid_transactions, COALESCE(u.free_used, 0) AS free_used
		FROM projects p
		LEFT JOIN project_usage u ON u.project = p.uuid AND u.period = ${period}
		WHERE p.uuid = ${projectId}
	`) as { free_transactions: number | null; paid_transactions: number; free_used: number }[];
	if (!usage) return false;
	return Math.max(freeAllowance(usage) - usage.free_used, 0) + usage.paid_transactions > 0;
}

export class TransactionLimitReached extends Error {
	constructor() {
		super("This project has no payments left this month. Redeem a transaction license to continue.");
	}
}

export async function assertCapacity(projectId: string) {
	if (!(await hasCapacity(projectId))) throw new TransactionLimitReached();
}

export interface NewLicense {
	type: LicenseType;
	transactions: number | null;
	duration_days: number | null;
	storage_gb: number | null;
	employees: number | null;
	emails: number | null;
	price: number | null;
	currency: string | null;
	buyer_name: string | null;
	buyer_email: string | null;
	note: string | null;
}

function signedCode(uuid: string): string {
	return `RPAY2-${uuid}`;
}

export interface IssuedLicense {
	uuid: string;
	code: string;
	signed_key: string | null;
}

export async function issueLicenses(
	sql: SQL,
	license: NewLicense,
	quantity: number,
	createdBy: string | null,
	server: string | null,
	timestamp = Date.now()
): Promise<IssuedLicense[]> {
	const issued: IssuedLicense[] = [];
	for (let index = 0; index < quantity; index++) {
		const uuid = crypto.randomUUID();
		const signed =
			server === null
				? null
				: signLicense({
						v: 1,
						id: uuid,
						server,
						type: license.type,
						transactions: license.transactions,
						duration_days: license.duration_days,
						storage_gb: license.storage_gb,
						employees: license.employees,
						issued: timestamp,
					});
		const code = signed ? signedCode(uuid) : generateLicenseCode();
		await sql`
			INSERT INTO license_keys(uuid, code, type, transactions, duration_days, storage_gb, employees, emails, status, price, currency, buyer_name,
				buyer_email, note, created_by, server_id, signed_key, created, updated)
			VALUES(${uuid}, ${code}, ${license.type}, ${license.transactions}, ${license.duration_days}, ${license.storage_gb}, ${license.employees},
				${license.emails}, 'available', ${license.price}, ${license.currency}, ${license.buyer_name}, ${license.buyer_email}, ${license.note}, ${createdBy}, ${server},
				${signed}, ${timestamp}, ${timestamp})
		`;
		issued.push({ uuid, code, signed_key: signed });
	}
	return issued;
}

export async function createLicenses(license: NewLicense, quantity: number, createdBy: string, server: string | null = null): Promise<LicenseKeyRow[]> {
	const issued = await Database.begin((tx) => issueLicenses(tx, license, quantity, createdBy, server));
	return (await Database`SELECT * FROM license_keys WHERE uuid IN ${Database(issued.map((key) => key.uuid))} ORDER BY code`) as LicenseKeyRow[];
}

async function findRedeemable(input: string): Promise<LicenseKeyRow | ErrorCode> {
	if (!looksSigned(input)) {
		if (!isLicenseIssuer()) return ErrorCode.SIGNED_LICENSE_REQUIRED;
		const code = normalizeLicenseCode(input);
		if (code === null) return ErrorCode.LICENSE_NOT_FOUND;
		const [license] = (await Database`SELECT * FROM license_keys WHERE code = ${code} AND signed_key IS NULL`) as LicenseKeyRow[];
		return license ?? ErrorCode.LICENSE_NOT_FOUND;
	}

	const signed = readSignedLicense(input);
	if (signed === null) return ErrorCode.LICENSE_NOT_FOUND;
	if (signed.server !== (await serverId())) return ErrorCode.LICENSE_OTHER_SERVER;

	const [existing] = (await Database`SELECT * FROM license_keys WHERE uuid = ${signed.id}`) as LicenseKeyRow[];
	if (existing) return existing;

	const timestamp = Date.now();
	try {
		await Database`
			INSERT INTO license_keys(uuid, code, type, transactions, duration_days, storage_gb, employees, status, server_id, signed_key, created, updated)
			VALUES(${signed.id}, ${signedCode(signed.id)}, ${signed.type}, ${signed.transactions}, ${signed.duration_days}, ${signed.storage_gb},
				${signed.employees}, 'available', ${signed.server}, ${input.trim()}, ${signed.issued}, ${timestamp})
		`;
	} catch {
		void 0;
	}
	const [stored] = (await Database`SELECT * FROM license_keys WHERE uuid = ${signed.id}`) as LicenseKeyRow[];
	return stored ?? ErrorCode.LICENSE_NOT_FOUND;
}

async function redeemable(input: string, allowed: LicenseType[]): Promise<LicenseKeyRow | ErrorCode> {
	const license = await findRedeemable(input);
	if (typeof license === "number") return license;
	if (license.status !== "available") return ErrorCode.LICENSE_ALREADY_REDEEMED;
	if (!allowed.includes(license.type)) return ErrorCode.LICENSE_TYPE_NOT_ALLOWED;
	return license;
}

export function isLicenseStart(value: unknown, now = Date.now()): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= now + MAX_LICENSE_DAYS * DAY;
}

export function readLicenseStart(value: unknown): number | null | undefined {
	if (value === undefined || value === null) return null;
	return isLicenseStart(value) ? value : undefined;
}

type AddOnDates = Pick<ProjectRow, "white_label_until" | "store_until" | "workforce_until" | "accounting_until">;

function addOnUntil(project: AddOnDates, type: LicenseType): number | null {
	if (type === "white_label") return project.white_label_until;
	if (type === "store") return project.store_until;
	if (type === "workforce") return project.workforce_until;
	if (type === "accounting") return project.accounting_until;
	return null;
}

async function addOnDates(sql: SQL, projectId: string): Promise<AddOnDates | null> {
	const [project] = (await sql`
		SELECT white_label_until, store_until, workforce_until, accounting_until FROM projects WHERE uuid = ${projectId}
	`) as AddOnDates[];
	return project ?? null;
}

async function extendAddOn(sql: SQL, projectId: string, type: LicenseType, days: number, from: number) {
	const project = await addOnDates(sql, projectId);
	if (!project) return;
	const until = extendWhiteLabel(addOnUntil(project, type), days, from);
	const timestamp = Date.now();
	if (type === "white_label") await sql`UPDATE projects SET white_label_until = ${until}, updated = ${timestamp} WHERE uuid = ${projectId}`;
	else if (type === "store") await sql`UPDATE projects SET store_until = ${until}, updated = ${timestamp} WHERE uuid = ${projectId}`;
	else if (type === "workforce") await sql`UPDATE projects SET workforce_until = ${until}, updated = ${timestamp} WHERE uuid = ${projectId}`;
	else if (type === "accounting") await sql`UPDATE projects SET accounting_until = ${until}, updated = ${timestamp} WHERE uuid = ${projectId}`;
}

async function runningUntil(projectId: string, type: LicenseType, now: number): Promise<number | null> {
	if (SCHEDULED_LICENSE_TYPES.includes(type)) {
		const grants = await scheduledKeys(projectId, type, now);
		return grants.length ? Math.max(...grants.map((grant) => grant.until)) : null;
	}
	const project = await addOnDates(Database, projectId);
	const until = project ? addOnUntil(project, type) : null;
	return until !== null && until > now ? until : null;
}

async function plannedStart(projectId: string, type: LicenseType, requested: number | null, now: number): Promise<number | null> {
	if (requested === null || requested <= now || !TIMED_LICENSE_TYPES.includes(type)) return null;
	const running = await runningUntil(projectId, type, now);
	if (running === null || requested > running + DAY) return requested;
	if (SCHEDULED_LICENSE_TYPES.includes(type)) return Math.min(requested, running);
	return null;
}

export interface ScheduledAddOn {
	type: LicenseType;
	from: number;
	until: number;
}

export async function scheduledAddOns(projectId: string, project: AddOnDates, now = Date.now()): Promise<ScheduledAddOn[]> {
	const pending = (await Database`
		SELECT type, duration_days, starts_at FROM license_keys
		WHERE redeemed_project = ${projectId} AND status = 'redeemed' AND starts_at IS NOT NULL AND activated_at IS NULL
			AND type IN ${Database(ADD_ON_LICENSE_TYPES)}
		ORDER BY starts_at ASC
	`) as Pick<LicenseKeyRow, "type" | "duration_days" | "starts_at">[];

	const cursors = new Map<LicenseType, number>();
	return pending.map((key) => {
		const from = Math.max(Number(key.starts_at), cursors.get(key.type) ?? addOnUntil(project, key.type) ?? 0, now);
		const until = from + Number(key.duration_days ?? 0) * DAY;
		cursors.set(key.type, until);
		return { type: key.type, from, until };
	});
}

export async function activateScheduledLicenses(projectId: string | null = null, now = Date.now()): Promise<number> {
	const projectFilter = projectId === null ? Database`` : Database`AND redeemed_project = ${projectId}`;
	const due = (await Database`
		SELECT uuid, type, duration_days, starts_at, redeemed_project FROM license_keys
		WHERE status = 'redeemed' AND starts_at IS NOT NULL AND starts_at <= ${now} AND activated_at IS NULL AND redeemed_project IS NOT NULL
			AND type IN ${Database(ADD_ON_LICENSE_TYPES)} ${projectFilter}
		ORDER BY starts_at ASC
	`) as Pick<LicenseKeyRow, "uuid" | "type" | "duration_days" | "starts_at" | "redeemed_project">[];

	let activated = 0;
	for (const key of due) {
		await Database.begin(async (tx) => {
			const claimed = await tx`UPDATE license_keys SET activated_at = ${now}, updated = ${now} WHERE uuid = ${key.uuid} AND activated_at IS NULL`;
			if (claimed.count === 0) return;
			await extendAddOn(tx, key.redeemed_project!, key.type, Number(key.duration_days ?? 0), Number(key.starts_at));
			activated++;
		});
	}
	return activated;
}

export interface LicensePreview {
	type: LicenseType;
	transactions: number | null;
	duration_days: number | null;
	storage_gb: number | null;
	employees: number | null;
	emails: number | null;
	timed: boolean;
	adds_up: boolean;
	running_until: number | null;
}

export async function previewLicense(
	projectId: string,
	input: string,
	allowed: LicenseType[] = LICENSE_TYPES,
	now = Date.now()
): Promise<LicensePreview | ErrorCode> {
	const license = await redeemable(input, allowed);
	if (typeof license === "number") return license;

	const timed = TIMED_LICENSE_TYPES.includes(license.type);
	return {
		type: license.type,
		transactions: license.transactions,
		duration_days: license.duration_days,
		storage_gb: license.storage_gb,
		employees: license.employees,
		emails: license.emails,
		timed,
		adds_up: SCHEDULED_LICENSE_TYPES.includes(license.type),
		running_until: timed ? await runningUntil(projectId, license.type, now) : null,
	};
}

export async function redeemLicense(
	projectId: string,
	input: string,
	username: string,
	allowed: LicenseType[] = LICENSE_TYPES,
	startsAt: number | null = null
): Promise<LicenseKeyRow | ErrorCode> {
	await meterProject(projectId);
	await activateScheduledLicenses(projectId);

	const license = await redeemable(input, allowed);
	if (typeof license === "number") return license;
	const starts = await plannedStart(projectId, license.type, startsAt, Date.now());

	const redeemed = await Database.begin(async (tx) => {
		const timestamp = Date.now();
		const claimed = await tx`
			UPDATE license_keys SET status = 'redeemed', redeemed_project = ${projectId}, redeemed_by = ${username},
				redeemed_at = ${timestamp}, starts_at = ${starts}, updated = ${timestamp}
			WHERE uuid = ${license.uuid} AND status = 'available'
		`;
		if (claimed.count === 0) return false;

		if (license.type === "transactions") {
			await tx`UPDATE projects SET paid_transactions = paid_transactions + ${license.transactions ?? 0}, updated = ${timestamp} WHERE uuid = ${projectId}`;
		} else if (license.type === "emails") {
			await tx`UPDATE projects SET paid_emails = paid_emails + ${license.emails ?? 0}, updated = ${timestamp} WHERE uuid = ${projectId}`;
		} else if (ADD_ON_LICENSE_TYPES.includes(license.type) && starts === null) {
			await extendAddOn(tx, projectId, license.type, license.duration_days ?? 0, timestamp);
		}
		return true;
	});
	if (!redeemed) return ErrorCode.LICENSE_ALREADY_REDEEMED;

	const [updated] = (await Database`SELECT * FROM license_keys WHERE uuid = ${license.uuid}`) as LicenseKeyRow[];
	return updated;
}

export function presentLicense(license: LicenseKeyRow, revealCode: boolean) {
	return {
		uuid: license.uuid,
		code: revealCode || license.signed_key !== null ? license.code : maskLicenseCode(license.code),
		type: license.type,
		transactions: license.transactions,
		duration_days: license.duration_days,
		storage_gb: license.storage_gb,
		employees: license.employees,
		emails: license.emails,
		status: license.status,
		price: license.price,
		currency: license.currency,
		buyer_name: license.buyer_name,
		buyer_email: license.buyer_email,
		note: license.note,
		created_by: license.created_by,
		redeemed_project: license.redeemed_project,
		redeemed_by: license.redeemed_by,
		redeemed_at: license.redeemed_at,
		starts_at: license.starts_at,
		ends_at: SCHEDULED_LICENSE_TYPES.includes(license.type) && license.redeemed_at !== null ? licensePeriod(license).until : null,
		revoked_at: license.revoked_at,
		server_id: license.server_id,
		signed_key: revealCode ? license.signed_key : null,
		created: license.created,
		updated: license.updated,
	};
}
