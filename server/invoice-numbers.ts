import type { SQL } from "bun";
import { DEFAULT_INVOICE_FORMAT, parseInvoiceFormat, periodKey, renderInvoiceNumber, type InvoiceFormat } from "./invoice-format";
import { activeFiscalFor, placeFor, type FiscalChannel, type FiscalPlace } from "./fiscal/config";

const DRAFT_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const SEQUENCE_DIGITS = 6;
export const MAX_PER_DAY = 10 ** SEQUENCE_DIGITS - 1;

export function dayKey(timestamp: number, timezone?: string): string {
	const date = new Date(timestamp);
	const parts = timezone
		? new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
				.formatToParts(timestamp)
				.reduce<Record<string, string>>((result, part) => ({ ...result, [part.type]: part.value }), {})
		: null;
	const year = parts?.year ? parts.year.slice(-2) : String(date.getFullYear() % 100).padStart(2, "0");
	const month = parts?.month ?? String(date.getMonth() + 1).padStart(2, "0");
	const day = parts?.day ?? String(date.getDate()).padStart(2, "0");

	return `${year}${month}${day}`;
}

export function invoiceNumber(day: string, sequence: number): string {
	return `${day}${String(sequence).padStart(SEQUENCE_DIGITS, "0")}`;
}

export function isInvoiceNumber(value: string): boolean {
	return /^[0-9]{12}$/.test(value);
}

export function draftReference(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);

	let suffix = "";
	for (const byte of bytes) suffix += DRAFT_ALPHABET[byte % DRAFT_ALPHABET.length];

	return `DRAFT-${suffix}`;
}

export function orderReference(): string {
	const digits = [...crypto.getRandomValues(new Uint8Array(9))].map((byte) => String(byte % 10)).join("");
	return `ORDER-${digits}`;
}

export function isDraftReference(value: string): boolean {
	return value.startsWith("DRAFT-");
}

export function sequenceOf(reference: string): number | null {
	if (!isInvoiceNumber(reference)) return null;
	return Number(reference.slice(6));
}

export const CREDIT_NOTE_PREFIX = "CN";

export class NumberingExhausted extends Error {}

export interface FiscalNumberPlace extends FiscalPlace {
	environment: string;
}

const FISCAL_REFERENCE = /^([0-9A-Za-z]{1,20})-([0-9A-Za-z]{1,20})-([0-9]{1,20})$/;

export function fiscalParts(reference: string): { premise: string; device: string; number: string } | null {
	const match = FISCAL_REFERENCE.exec(reference);
	return match ? { premise: match[1]!, device: match[2]!, number: match[3]! } : null;
}

export async function nextCreditNoteNumber(sql: SQL, projectId: string, issuedAt: number, fiscal: FiscalNumberPlace | null = null): Promise<string> {
	if (fiscal) return await nextFiscalNumber(sql, projectId, fiscal);
	return await nextNumber(sql, projectId, issuedAt, CREDIT_NOTE_PREFIX);
}

export async function nextInvoiceNumber(sql: SQL, projectId: string, issuedAt: number, channel: FiscalChannel = "invoice"): Promise<string> {
	const fiscal = await activeFiscalFor(sql, projectId);
	const place = fiscal ? placeFor(fiscal.settings, channel) : null;
	if (fiscal && place) return await nextFiscalNumber(sql, projectId, { ...place, environment: fiscal.settings.environment });
	return await nextNumber(sql, projectId, issuedAt, "");
}

async function fiscalReferenceTaken(sql: SQL, projectId: string, reference: string): Promise<boolean> {
	const invoices = (await sql`SELECT 1 FROM invoices WHERE project = ${projectId} AND reference = ${reference}`) as unknown[];
	if (invoices.length > 0) return true;
	const notes = (await sql`SELECT 1 FROM credit_notes WHERE project = ${projectId} AND reference = ${reference}`) as unknown[];
	return notes.length > 0;
}

async function nextFiscalNumber(sql: SQL, projectId: string, place: FiscalNumberPlace): Promise<string> {
	const key = `FURS/${place.environment}/${place.premise}/${place.device}`;
	let sequence = await storedNextNumber(sql, projectId, key);
	for (;;) {
		const reference = `${place.premise}-${place.device}-${sequence}`;
		if (!(await fiscalReferenceTaken(sql, projectId, reference))) {
			await setNextNumber(sql, projectId, key, sequence + 1);
			return reference;
		}
		sequence++;
	}
}

export async function projectInvoiceFormat(sql: SQL, projectId: string): Promise<InvoiceFormat> {
	const [row] = (await sql`SELECT invoice_format FROM projects WHERE uuid = ${projectId}`) as { invoice_format: string | null }[];
	const parsed = parseInvoiceFormat(row?.invoice_format ?? DEFAULT_INVOICE_FORMAT);
	if (parsed.ok) return parsed.format;
	return (parseInvoiceFormat(DEFAULT_INVOICE_FORMAT) as { ok: true; format: InvoiceFormat }).format;
}

export async function storedNextNumber(sql: SQL, projectId: string, key: string): Promise<number> {
	const [row] = (await sql`SELECT next_number FROM invoice_sequences WHERE project = ${projectId} AND day = ${key}`) as { next_number: number }[];
	return row ? Number(row.next_number) : 1;
}

export async function setNextNumber(sql: SQL, projectId: string, key: string, next: number) {
	if (sql.options.adapter === "mysql")
		await sql`
		INSERT INTO invoice_sequences(project, day, next_number) VALUES(${projectId}, ${key}, ${next})
		ON DUPLICATE KEY UPDATE next_number = ${next}
	`;
	else
		await sql`
		INSERT INTO invoice_sequences(project, day, next_number) VALUES(${projectId}, ${key}, ${next})
		ON CONFLICT(project, day) DO UPDATE SET next_number = ${next}
	`;
}

async function referenceTaken(sql: SQL, projectId: string, reference: string, series: string): Promise<boolean> {
	const rows =
		series === CREDIT_NOTE_PREFIX
			? await sql`SELECT 1 FROM credit_notes WHERE project = ${projectId} AND reference = ${reference}`
			: await sql`SELECT 1 FROM invoices WHERE project = ${projectId} AND reference = ${reference}`;
	return (rows as unknown[]).length > 0;
}

async function nextNumber(sql: SQL, projectId: string, issuedAt: number, series: string): Promise<string> {
	const format = await projectInvoiceFormat(sql, projectId);
	const [project] = (await sql`SELECT timezone FROM projects WHERE uuid = ${projectId}`) as { timezone: string }[];
	const timezone = project.timezone;
	const key = `${series}${periodKey(format, issuedAt, timezone)}`;

	let sequence = await storedNextNumber(sql, projectId, key);
	for (;;) {
		if (sequence > format.capacity) {
			throw new NumberingExhausted(`Invoice numbers are exhausted for this period. The format ${format.source} holds ${format.capacity}, use more X for more.`);
		}
		const reference = `${series}${renderInvoiceNumber(format, issuedAt, sequence, timezone)}`;
		if (!(await referenceTaken(sql, projectId, reference, series))) {
			await setNextNumber(sql, projectId, key, sequence + 1);
			return reference;
		}
		sequence++;
	}
}
