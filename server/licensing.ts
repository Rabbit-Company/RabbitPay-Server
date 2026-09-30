import type { SQL } from "bun";
import Database, { dialect } from "./database/database";
import { Settings } from "./settings";
import { DEFAULT_SETTINGS } from "./settings-schema";
import { ErrorCode } from "./errors";
import { isLicenseIssuer, looksSigned, readSignedLicense, signLicense } from "./license-signing";
import { serverId } from "./server-identity";
import { countedMembers, pendingTimeTrackers } from "./workforce/people";
import { MAX_LICENSE_DAYS, MAX_LICENSE_EMPLOYEES, MAX_LICENSE_STORAGE_GB, MAX_LICENSE_TRANSACTIONS } from "./license-pricing";

export { MAX_LICENSE_DAYS, MAX_LICENSE_EMPLOYEES, MAX_LICENSE_STORAGE_GB, MAX_LICENSE_TRANSACTIONS };
import type { LicenseBilling, LicenseKeyRow, LicenseType, ProjectRow, ProjectUsageRow } from "./database/models";

export const DAY = 24 * 60 * 60 * 1000;
export const LICENSE_TYPES: LicenseType[] = ["transactions", "white_label", "storage", "store", "workforce", "employees", "accounting"];
export const TIMED_LICENSE_TYPES: LicenseType[] = ["white_label", "store", "workforce", "employees", "accounting"];
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

async function billPayment(sql: SQL, project: Pick<ProjectRow, "uuid" | "free_transactions">, payment: { uuid: string; completed_at: number }) {
	const enforced = licensingEnforced();
	const period = periodOf(payment.completed_at);
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
			SELECT uuid, completed_at FROM transactions
			WHERE project = ${projectId} AND type = 'payment' AND completed_at IS NOT NULL AND license_billing IS NULL
			ORDER BY completed_at ASC LIMIT ${METER_BATCH}
		`) as { uuid: string; completed_at: number }[];
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
		WHERE type = 'payment' AND completed_at IS NOT NULL AND license_billing IS NULL
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
}

export interface EmployeeSeatGrant {
	employees: number;
	until: number;
}

export interface EmployeeSeatUsage {
	employees_included: number;
	employees_licensed: number;
	employees_used: number;
	employees_limit: number | null;
	employee_seats: EmployeeSeatGrant[];
}

export async function employeeSeatGrants(projectId: string, now = Date.now()): Promise<EmployeeSeatGrant[]> {
	const keys = (await Database`
		SELECT employees, duration_days, redeemed_at FROM license_keys
		WHERE redeemed_project = ${projectId} AND type = 'employees' AND status = 'redeemed'
	`) as Pick<LicenseKeyRow, "employees" | "duration_days" | "redeemed_at">[];
	return keys
		.map((key) => ({ employees: Number(key.employees ?? 0), until: Number(key.redeemed_at ?? 0) + Number(key.duration_days ?? 0) * DAY }))
		.filter((grant) => grant.until > now)
		.sort((first, second) => first.until - second.until);
}

export async function employeeSeatsFor(projectId: string, now = Date.now()): Promise<EmployeeSeatUsage> {
	const grants = await employeeSeatGrants(projectId, now);
	const included = includedEmployees();
	const licensed = grants.reduce((total, grant) => total + grant.employees, 0);
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

export interface ProjectStorageUsage {
	storage_included: number;
	storage_licensed: number;
	storage_used: number;
	storage_limit: number | null;
	storage_remaining: number | null;
}

export async function storageFor(projectId: string): Promise<ProjectStorageUsage> {
	const [project] = (await Database`SELECT paid_storage_bytes FROM projects WHERE uuid = ${projectId}`) as Pick<ProjectRow, "paid_storage_bytes">[];
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
	const licensed = project.paid_storage_bytes;
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
	};
}

function safeStorageBytes(value: number): number {
	const bytes = Number(value);
	if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid stored document size");
	return bytes;
}

export async function usageFor(projectId: string, now = Date.now()): Promise<ProjectUsage> {
	await meterProject(projectId);

	const period = periodOf(now);
	const [project] = (await Database`
		SELECT free_transactions, paid_transactions, white_label_until, store_until, workforce_until, accounting_until FROM projects WHERE uuid = ${projectId}
	`) as Pick<ProjectRow, "free_transactions" | "paid_transactions" | "white_label_until" | "store_until" | "workforce_until" | "accounting_until">[];
	const [usage] = (await Database`SELECT * FROM project_usage WHERE project = ${projectId} AND period = ${period}`) as ProjectUsageRow[];

	const enforced = licensingEnforced();
	const allowance = freeAllowance(project);
	const freeUsed = usage?.free_used ?? 0;
	const storage = await storageFor(projectId);

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
			INSERT INTO license_keys(uuid, code, type, transactions, duration_days, storage_gb, employees, status, price, currency, buyer_name, buyer_email,
				note, created_by, server_id, signed_key, created, updated)
			VALUES(${uuid}, ${code}, ${license.type}, ${license.transactions}, ${license.duration_days}, ${license.storage_gb}, ${license.employees},
				'available', ${license.price}, ${license.currency}, ${license.buyer_name}, ${license.buyer_email}, ${license.note}, ${createdBy}, ${server},
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

export async function redeemLicense(
	projectId: string,
	input: string,
	username: string,
	allowed: LicenseType[] = LICENSE_TYPES
): Promise<LicenseKeyRow | ErrorCode> {
	await meterProject(projectId);

	const license = await findRedeemable(input);
	if (typeof license === "number") return license;
	if (license.status !== "available") return ErrorCode.LICENSE_ALREADY_REDEEMED;
	if (!allowed.includes(license.type)) return ErrorCode.LICENSE_TYPE_NOT_ALLOWED;

	const redeemed = await Database.begin(async (tx) => {
		const timestamp = Date.now();
		const claimed = await tx`
			UPDATE license_keys SET status = 'redeemed', redeemed_project = ${projectId}, redeemed_by = ${username},
				redeemed_at = ${timestamp}, updated = ${timestamp}
			WHERE uuid = ${license.uuid} AND status = 'available'
		`;
		if (claimed.count === 0) return false;

		if (license.type === "transactions") {
			await tx`UPDATE projects SET paid_transactions = paid_transactions + ${license.transactions ?? 0}, updated = ${timestamp} WHERE uuid = ${projectId}`;
		} else if (license.type === "white_label") {
			const [project] = (await tx`SELECT white_label_until FROM projects WHERE uuid = ${projectId}`) as Pick<ProjectRow, "white_label_until">[];
			const until = extendWhiteLabel(project.white_label_until, license.duration_days ?? 0, timestamp);
			await tx`UPDATE projects SET white_label_until = ${until}, updated = ${timestamp} WHERE uuid = ${projectId}`;
		} else if (license.type === "store") {
			const [project] = (await tx`SELECT store_until FROM projects WHERE uuid = ${projectId}`) as Pick<ProjectRow, "store_until">[];
			const until = extendWhiteLabel(project.store_until, license.duration_days ?? 0, timestamp);
			await tx`UPDATE projects SET store_until = ${until}, updated = ${timestamp} WHERE uuid = ${projectId}`;
		} else if (license.type === "workforce") {
			const [project] = (await tx`SELECT workforce_until FROM projects WHERE uuid = ${projectId}`) as Pick<ProjectRow, "workforce_until">[];
			const until = extendWhiteLabel(project.workforce_until, license.duration_days ?? 0, timestamp);
			await tx`UPDATE projects SET workforce_until = ${until}, updated = ${timestamp} WHERE uuid = ${projectId}`;
		} else if (license.type === "accounting") {
			const [project] = (await tx`SELECT accounting_until FROM projects WHERE uuid = ${projectId}`) as Pick<ProjectRow, "accounting_until">[];
			const until = extendWhiteLabel(project.accounting_until, license.duration_days ?? 0, timestamp);
			await tx`UPDATE projects SET accounting_until = ${until}, updated = ${timestamp} WHERE uuid = ${projectId}`;
		} else if (license.type === "storage") {
			const bytes = (license.storage_gb ?? 0) * STORAGE_GB_BYTES;
			await tx`UPDATE projects SET paid_storage_bytes = paid_storage_bytes + ${bytes}, updated = ${timestamp} WHERE uuid = ${projectId}`;
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
		revoked_at: license.revoked_at,
		server_id: license.server_id,
		signed_key: revealCode ? license.signed_key : null,
		created: license.created,
		updated: license.updated,
	};
}
