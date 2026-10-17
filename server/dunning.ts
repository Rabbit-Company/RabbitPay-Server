import Database from "./database/database";
import { ErrorCode } from "./errors";
import { companyFor, displayNameOf } from "./company";
import { brandingOf, invoiceDesignOf, loadLogo } from "./branding";
import { draftInvoiceIssuer } from "./invoice-issuer";
import { bankInstruction } from "./payments/bank";
import { availableFor, configFor } from "./payments/methods";
import { outstandingOf } from "./invoicing";
import { invoiceRecipient } from "./invoice-recipient";
import { isLanguage, translator, type Language } from "./i18n";
import { isLocalDate, localDate, shiftLocalDate } from "./timezone";
import Validate from "./validate";
import RenderPool from "./render-pool";
import { nextSeriesNumber } from "./invoice-numbers";
import {
	compensationAvailable,
	DEFAULT_DEADLINE_DAYS,
	dunningTotals,
	interestAvailable,
	isDunningLevel,
	lineFigures,
	MAX_DEADLINE_DAYS,
	MAX_DUNNING_LINES,
	nextLevel,
	statutoryInterest,
	type DunningLevel,
	type InterestPeriod,
} from "./dunning-rules";
import { DUNNING_TITLES, type DunningDocument, type DunningDocumentLine } from "./dunning-render";
import type { SQL } from "bun";
import type { CustomerRow, DunningLetterLineRow, DunningLetterRow, InvoiceRow, ProjectRow, RecordedInvoiceRow } from "./database/models";

const UNSAFE_FILENAME = /[\\/:*?"<>|\p{Cc}]+/gu;
const MAX_MINOR_AMOUNT = 10 ** 13;

export interface ManualLineInput {
	reference?: unknown;
	issue_date?: unknown;
	due_date?: unknown;
	amount?: unknown;
	open?: unknown;
}

export interface DunningRequest {
	customer?: unknown;
	level?: unknown;
	currency?: unknown;
	language?: unknown;
	deadline_days?: unknown;
	interest?: unknown;
	compensation?: unknown;
	note?: unknown;
	invoices?: unknown;
	recorded_invoices?: unknown;
	manual?: unknown;
}

export interface PlannedLine extends DunningDocumentLine {
	invoice: string | null;
	recorded_invoice: string | null;
}

export interface PlannedLetter {
	customer: CustomerRow;
	level: DunningLevel;
	currency: string;
	language: Language;
	issue_date: string;
	deadline_date: string;
	interest: boolean;
	compensation: boolean;
	note: string | null;
	lines: PlannedLine[];
}

export function isBusinessCustomer(customer: Pick<CustomerRow, "customer_type" | "vat_number" | "tax_number">): boolean {
	if (customer.customer_type === "business") return true;
	if (customer.customer_type === "individual") return false;
	return Boolean(customer.vat_number?.trim() || customer.tax_number?.trim());
}

function normalizedTaxNumber(value: string | null | undefined): string {
	return (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizedName(value: string | null | undefined): string {
	return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function todayFor(project: Pick<ProjectRow, "timezone">, now = Date.now()): string {
	return localDate(now, project.timezone);
}

export async function findCustomer(project: string, customer: string): Promise<CustomerRow | undefined> {
	const [row] = (await Database`SELECT * FROM customers WHERE uuid = ${customer} AND project = ${project}`) as CustomerRow[];
	return row;
}

export async function unpaidInvoices(project: ProjectRow, customer: string): Promise<InvoiceRow[]> {
	const rows = (await Database`
		SELECT * FROM invoices
		WHERE project = ${project.uuid} AND customer = ${customer} AND issued_at IS NOT NULL AND source = 'invoice'
			AND status IN ('open', 'overdue', 'partially_paid')
		ORDER BY due_date ASC, reference ASC
	`) as InvoiceRow[];
	return rows.filter((invoice) => outstandingOf(invoice) > 0);
}

export async function unpaidRecordedInvoices(project: ProjectRow, customer: CustomerRow): Promise<RecordedInvoiceRow[]> {
	const rows = (await Database`
		SELECT * FROM recorded_invoices WHERE project = ${project.uuid} AND document_type = 'invoice' AND paid_at IS NULL AND due_date IS NOT NULL
		ORDER BY due_date ASC, reference ASC
	`) as RecordedInvoiceRow[];
	const taxNumbers = new Set([normalizedTaxNumber(customer.vat_number), normalizedTaxNumber(customer.tax_number)].filter(Boolean));
	const strip = (value: string) => value.replace(/^[A-Z]{2}(?=[0-9])/, "");
	const stripped = new Set([...taxNumbers].map(strip));
	const name = normalizedName(customer.name);
	return rows.filter((row) => {
		const number = normalizedTaxNumber(row.buyer_vat_number);
		if (number) return taxNumbers.has(number) || stripped.has(strip(number));
		return name !== "" && normalizedName(row.buyer_name) === name;
	});
}

export async function lastLetterFor(project: string, customer: string): Promise<DunningLetterRow | undefined> {
	const [row] = (await Database`
		SELECT * FROM dunning_letters WHERE project = ${project} AND customer = ${customer}
		ORDER BY issue_date DESC, created DESC LIMIT 1
	`) as DunningLetterRow[];
	return row;
}

export async function letterLines(letter: string): Promise<DunningLetterLineRow[]> {
	return (await Database`SELECT * FROM dunning_letter_lines WHERE dunning_letter = ${letter} ORDER BY sort_order ASC`) as DunningLetterLineRow[];
}

function uuidList(value: unknown): string[] | null {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) return null;
	const ids = value.filter((entry): entry is string => typeof entry === "string" && /^[0-9a-f-]{36}$/i.test(entry));
	if (ids.length !== value.length || new Set(ids).size !== ids.length) return null;
	return ids;
}

function minorAmount(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_MINOR_AMOUNT ? value : null;
}

function manualLines(value: unknown, today: string): Omit<PlannedLine, "days" | "interest" | "compensation">[] | null {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) return null;
	const lines: Omit<PlannedLine, "days" | "interest" | "compensation">[] = [];
	for (const entry of value as ManualLineInput[]) {
		if (typeof entry !== "object" || entry === null) return null;
		const reference = typeof entry.reference === "string" ? entry.reference.trim() : "";
		if (!reference || reference.length > 64) return null;
		if (!isLocalDate(entry.due_date) || entry.due_date >= today) return null;
		if (entry.issue_date !== undefined && entry.issue_date !== null && (!isLocalDate(entry.issue_date) || entry.issue_date > entry.due_date)) return null;
		const open = minorAmount(entry.open);
		if (open === null) return null;
		const amount = entry.amount === undefined || entry.amount === null ? open : minorAmount(entry.amount);
		if (amount === null || amount < open) return null;
		lines.push({
			invoice: null,
			recorded_invoice: null,
			reference,
			issue_date: (entry.issue_date as string | undefined) ?? null,
			due_on: entry.due_date,
			amount,
			open,
		});
	}
	return lines;
}

export async function planLetter(project: ProjectRow, data: DunningRequest, now = Date.now()): Promise<PlannedLetter | ErrorCode> {
	if (typeof data !== "object" || data === null) return ErrorCode.INVALID_DUNNING_LETTER;
	if (typeof data.customer !== "string") return ErrorCode.INVALID_DUNNING_LETTER;
	const customer = await findCustomer(project.uuid, data.customer);
	if (!customer) return ErrorCode.CUSTOMER_NOT_FOUND;

	const today = todayFor(project, now);
	const level = data.level === undefined ? nextLevel(await previousLevel(project.uuid, customer.uuid)) : data.level;
	if (!isDunningLevel(level)) return ErrorCode.INVALID_DUNNING_LETTER;
	const currency = data.currency === undefined ? project.currency : data.currency;
	if (typeof currency !== "string" || !Validate.currency(currency)) return ErrorCode.INVALID_DUNNING_LETTER;
	const language = data.language === undefined ? project.language : data.language;
	if (!isLanguage(language)) return ErrorCode.INVALID_DUNNING_LETTER;
	const deadlineDays = data.deadline_days === undefined ? DEFAULT_DEADLINE_DAYS : data.deadline_days;
	if (typeof deadlineDays !== "number" || !Number.isInteger(deadlineDays) || deadlineDays < 1 || deadlineDays > MAX_DEADLINE_DAYS) {
		return ErrorCode.INVALID_DUNNING_LETTER;
	}
	if (data.interest !== undefined && typeof data.interest !== "boolean") return ErrorCode.INVALID_DUNNING_LETTER;
	if (data.compensation !== undefined && typeof data.compensation !== "boolean") return ErrorCode.INVALID_DUNNING_LETTER;
	const interest = data.interest === true;
	const compensation = data.compensation === true;
	if (interest && !interestAvailable(project.tax_country)) return ErrorCode.DUNNING_OPTION_UNAVAILABLE;
	if (compensation && (!compensationAvailable(project.tax_country) || currency !== "EUR" || !isBusinessCustomer(customer))) {
		return ErrorCode.DUNNING_OPTION_UNAVAILABLE;
	}
	if (data.note !== undefined && data.note !== null && (typeof data.note !== "string" || data.note.length > 2000)) return ErrorCode.INVALID_DUNNING_LETTER;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : null;

	const invoiceIds = uuidList(data.invoices);
	const recordedIds = uuidList(data.recorded_invoices);
	const manual = manualLines(data.manual, today);
	if (invoiceIds === null || recordedIds === null || manual === null) return ErrorCode.INVALID_DUNNING_LETTER;
	if (invoiceIds.length + recordedIds.length + manual.length === 0) return ErrorCode.NOTHING_TO_DUN;
	if (invoiceIds.length + recordedIds.length + manual.length > MAX_DUNNING_LINES) return ErrorCode.INVALID_DUNNING_LETTER;

	const base: Omit<PlannedLine, "days" | "interest" | "compensation">[] = [];
	if (invoiceIds.length > 0) {
		const invoices = new Map((await unpaidInvoices(project, customer.uuid)).map((invoice) => [invoice.uuid, invoice]));
		for (const id of invoiceIds) {
			const invoice = invoices.get(id);
			if (!invoice || invoice.currency !== currency) return ErrorCode.NOTHING_TO_DUN;
			const due = localDate(invoice.due_date, project.timezone);
			if (due >= today) return ErrorCode.NOTHING_TO_DUN;
			base.push({
				invoice: invoice.uuid,
				recorded_invoice: null,
				reference: invoice.reference,
				issue_date: localDate(invoice.issued_at!, project.timezone),
				due_on: due,
				amount: invoice.total_amount,
				open: outstandingOf(invoice),
			});
		}
	}
	if (recordedIds.length > 0) {
		const recorded = new Map((await unpaidRecordedInvoices(project, customer)).map((row) => [row.uuid, row]));
		for (const id of recordedIds) {
			const row = recorded.get(id);
			if (!row || row.currency !== currency || row.due_date === null) return ErrorCode.NOTHING_TO_DUN;
			const due = localDate(row.due_date, project.timezone);
			if (due >= today) return ErrorCode.NOTHING_TO_DUN;
			base.push({
				invoice: null,
				recorded_invoice: row.uuid,
				reference: row.reference,
				issue_date: localDate(row.issued_at, project.timezone),
				due_on: due,
				amount: row.total_amount,
				open: row.total_amount,
			});
		}
	}
	base.push(...manual);
	base.sort((left, right) => left.due_on.localeCompare(right.due_on) || left.reference.localeCompare(right.reference));

	const options = { until: today, interest, compensation, business: isBusinessCustomer(customer), currency };
	return {
		customer,
		level,
		currency,
		language,
		issue_date: today,
		deadline_date: shiftLocalDate(today, deadlineDays),
		interest,
		compensation,
		note,
		lines: base.map((line) => ({ ...line, ...lineFigures({ open: line.open, due: line.due_on }, options) })),
	};
}

async function previousLevel(project: string, customer: string): Promise<DunningLevel | null> {
	const last = await lastLetterFor(project, customer);
	return last && isDunningLevel(last.level) ? last.level : null;
}

function usedRates(plan: PlannedLetter): Pick<InterestPeriod, "from" | "to" | "rate">[] {
	if (!plan.interest) return [];
	const periods = new Map<string, Pick<InterestPeriod, "from" | "to" | "rate">>();
	for (const line of plan.lines) {
		for (const period of statutoryInterest(line.open, line.due_on, plan.issue_date).periods) {
			const known = [...periods.values()].find((entry) => entry.rate === period.rate && entry.to >= shiftLocalDate(period.from, -1) && entry.from <= period.to);
			if (known) {
				if (period.from < known.from) known.from = period.from;
				if (period.to > known.to) known.to = period.to;
			} else {
				periods.set(`${period.from}:${period.rate}`, { from: period.from, to: period.to, rate: period.rate });
			}
		}
	}
	return [...periods.values()].sort((left, right) => left.from.localeCompare(right.from));
}

export interface LetterContext {
	company: Awaited<ReturnType<typeof companyFor>>;
	bankConfig: Record<string, string> | null;
	issuer: Awaited<ReturnType<typeof draftInvoiceIssuer>>;
}

export async function letterContext(project: ProjectRow, createdBy: string | null): Promise<LetterContext> {
	const methods = await availableFor(project.uuid);
	return {
		company: await companyFor(project.uuid),
		bankConfig: methods.some((method) => method.processor === "bank_transfer") ? await configFor(project.uuid, "bank_transfer") : null,
		issuer: project.invoice_issuer_details ? await draftInvoiceIssuer(project.uuid, createdBy) : null,
	};
}

export function letterDocument(project: ProjectRow, plan: PlannedLetter, number: string, context: LetterContext): DunningDocument {
	const { company, bankConfig, issuer } = context;
	const seller = { ...company, name: displayNameOf(project) };
	const totals = dunningTotals(plan.lines.map((line) => ({ ...line, due: line.due_on })));
	const single = plan.lines.length === 1 && plan.lines[0]!.invoice !== null && totals.total === plan.lines[0]!.open;
	const bank = bankConfig
		? bankInstruction({
				config: bankConfig,
				company,
				merchant: seller.name,
				reference: single ? plan.lines[0]!.reference : number,
				totalMinorUnits: totals.total,
				currency: plan.currency,
				language: plan.language,
				purpose: translator(plan.language)("dunning.purpose", { reference: number }),
			})
		: null;

	return {
		number,
		level: plan.level,
		language: plan.language,
		currency: plan.currency,
		issue_date: plan.issue_date,
		deadline_date: plan.deadline_date,
		seller,
		buyer: invoiceRecipient(plan.customer)!,
		vat_status: project.vat_status,
		tax_country: project.tax_country,
		design: invoiceDesignOf(project),
		branding: brandingOf(project),
		date_format: project.date_format,
		lines: plan.lines.map(({ invoice: _invoice, recorded_invoice: _recorded, ...line }) => line),
		totals,
		interest_included: plan.interest,
		compensation_included: plan.compensation,
		rates: usedRates(plan),
		note: plan.note,
		issuer: issuer ? { name: issuer.name, signature: issuer.signature ? `data:image/png;base64,${issuer.signature}` : null } : null,
		bank,
	};
}

export async function upcomingLetterNumber(project: ProjectRow, timestamp = Date.now()): Promise<string> {
	return await nextSeriesNumber(Database, project.uuid, "dunning", timestamp, { reserve: false });
}

export async function issueLetter(project: ProjectRow, plan: PlannedLetter, createdBy: string | null): Promise<DunningLetterRow> {
	const uuid = crypto.randomUUID();
	const year = Number(plan.issue_date.slice(0, 4));
	const timestamp = Date.now();
	const context = await letterContext(project, createdBy);

	await Database.begin(async (tx) => {
		const sql = tx as unknown as SQL;
		const [last] = (await sql`SELECT MAX(sequence_number) AS last FROM dunning_letters WHERE project = ${project.uuid} AND year = ${year}`) as {
			last: number | null;
		}[];
		const sequence = Number(last?.last ?? 0) + 1;
		const number = await nextSeriesNumber(sql, project.uuid, "dunning", timestamp);
		const document = letterDocument(project, plan, number, context);

		await sql`
			INSERT INTO dunning_letters(uuid, project, customer, level, year, sequence_number, number, language, currency, issue_date, deadline_date,
				principal, interest, compensation, total_amount, interest_included, compensation_included, note, buyer_details, document, created_by, created, updated)
			VALUES(${uuid}, ${project.uuid}, ${plan.customer.uuid}, ${plan.level}, ${year}, ${sequence}, ${number}, ${plan.language}, ${plan.currency},
				${plan.issue_date}, ${plan.deadline_date}, ${document.totals.principal}, ${document.totals.interest}, ${document.totals.compensation},
				${document.totals.total}, ${plan.interest ? 1 : 0}, ${plan.compensation ? 1 : 0}, ${plan.note}, ${JSON.stringify(document.buyer)},
				${JSON.stringify(document)}, ${createdBy}, ${timestamp}, ${timestamp})
		`;
		for (let index = 0; index < plan.lines.length; index++) {
			const line = plan.lines[index]!;
			await sql`
				INSERT INTO dunning_letter_lines(uuid, dunning_letter, invoice, recorded_invoice, reference, issue_date, due_on, amount, open_amount, days_overdue,
					interest, compensation, sort_order)
				VALUES(${crypto.randomUUID()}, ${uuid}, ${line.invoice}, ${line.recorded_invoice}, ${line.reference}, ${line.issue_date}, ${line.due_on},
					${line.amount}, ${line.open}, ${line.days}, ${line.interest}, ${line.compensation}, ${index})
			`;
		}
	});

	return (await findLetter(project.uuid, uuid))!;
}

export async function findLetter(project: string, letter: string): Promise<DunningLetterRow | undefined> {
	const [row] = (await Database`SELECT * FROM dunning_letters WHERE uuid = ${letter} AND project = ${project}`) as DunningLetterRow[];
	return row;
}

export function letterTitle(level: DunningLevel, language: string): string {
	return translator(language)(DUNNING_TITLES[level]);
}

export function letterFilename(document: Pick<DunningDocument, "level" | "language" | "number">): string {
	return `${`${letterTitle(document.level, document.language)} ${document.number}`.replace(UNSAFE_FILENAME, "-").trim()}.pdf`;
}

export async function renderLetter(project: ProjectRow, document: DunningDocument): Promise<{ name: string; data: Uint8Array }> {
	const logo = document.branding.logo ? await loadLogo(project.uuid) : null;
	const data = await RenderPool.render({ kind: "dunning_letter", document, logo });
	return { name: letterFilename(document), data };
}

export function storedDocument(letter: DunningLetterRow): DunningDocument {
	return JSON.parse(letter.document) as DunningDocument;
}

export interface DebtorRow {
	customer: string;
	name: string | null;
	email: string | null;
	currency: string;
	invoices: number;
	overdue_amount: number;
	oldest_due: number;
	last_letter: { uuid: string; number: string; level: number; issue_date: string } | null;
}

export async function debtors(project: ProjectRow, now = Date.now()): Promise<DebtorRow[]> {
	const rows = (await Database`
		SELECT i.customer, c.name, c.email, i.currency, i.due_date, i.total_amount, i.paid_amount, i.refunded_amount, i.credited_amount, i.advanced_amount
		FROM invoices i JOIN customers c ON c.uuid = i.customer
		WHERE i.project = ${project.uuid} AND i.issued_at IS NOT NULL AND i.source = 'invoice'
			AND i.status IN ('open', 'overdue', 'partially_paid') AND i.due_date < ${now}
	`) as (Pick<InvoiceRow, "customer" | "currency" | "due_date" | "total_amount" | "paid_amount" | "refunded_amount" | "credited_amount" | "advanced_amount"> &
		Pick<CustomerRow, "name" | "email">)[];

	const today = todayFor(project, now);
	const grouped = new Map<string, DebtorRow>();
	for (const row of rows) {
		if (localDate(row.due_date, project.timezone) >= today) continue;
		const open = outstandingOf(row);
		if (open <= 0) continue;
		const key = `${row.customer}|${row.currency}`;
		const current = grouped.get(key) ?? {
			customer: row.customer!,
			name: row.name,
			email: row.email,
			currency: row.currency,
			invoices: 0,
			overdue_amount: 0,
			oldest_due: row.due_date,
			last_letter: null,
		};
		current.invoices++;
		current.overdue_amount += open;
		current.oldest_due = Math.min(current.oldest_due, row.due_date);
		grouped.set(key, current);
	}

	const customers = [...new Set([...grouped.values()].map((row) => row.customer))];
	if (customers.length > 0) {
		const letters = (await Database`
			SELECT uuid, customer, number, level, issue_date, created FROM dunning_letters
			WHERE project = ${project.uuid} AND customer IN ${Database(customers)}
			ORDER BY issue_date ASC, created ASC
		`) as Pick<DunningLetterRow, "uuid" | "customer" | "number" | "level" | "issue_date">[];
		const latest = new Map(letters.map((letter) => [letter.customer, letter]));
		for (const row of grouped.values()) {
			const letter = latest.get(row.customer);
			if (letter) row.last_letter = { uuid: letter.uuid, number: letter.number, level: Number(letter.level), issue_date: letter.issue_date };
		}
	}

	return [...grouped.values()].sort((left, right) => left.oldest_due - right.oldest_due);
}

export interface LetterLineState extends DunningLetterLineRow {
	open_now: number | null;
}

export async function linesWithState(letter: DunningLetterRow): Promise<LetterLineState[]> {
	const lines = await letterLines(letter.uuid);
	const invoiceIds = lines.map((line) => line.invoice).filter((id): id is string => id !== null);
	const recordedIds = lines.map((line) => line.recorded_invoice).filter((id): id is string => id !== null);
	const invoices = new Map(
		invoiceIds.length === 0
			? []
			: ((await Database`SELECT * FROM invoices WHERE uuid IN ${Database(invoiceIds)}`) as InvoiceRow[]).map((invoice) => [
					invoice.uuid,
					["open", "overdue", "partially_paid"].includes(invoice.status) ? Math.max(outstandingOf(invoice), 0) : 0,
				])
	);
	const recorded = new Map(
		recordedIds.length === 0
			? []
			: (
					(await Database`SELECT uuid, total_amount, paid_at FROM recorded_invoices WHERE uuid IN ${Database(recordedIds)}`) as Pick<
						RecordedInvoiceRow,
						"uuid" | "total_amount" | "paid_at"
					>[]
				).map((row) => [row.uuid, row.paid_at === null ? Number(row.total_amount) : 0])
	);
	return lines.map((line) => ({
		...line,
		open_now:
			line.invoice !== null ? (invoices.get(line.invoice) ?? null) : line.recorded_invoice !== null ? (recorded.get(line.recorded_invoice) ?? null) : null,
	}));
}

export function presentLetter(letter: DunningLetterRow, extras: { customer_name?: string | null; emails?: number } = {}) {
	return {
		uuid: letter.uuid,
		customer: letter.customer,
		customer_name: extras.customer_name ?? (JSON.parse(letter.buyer_details) as { name: string | null }).name,
		level: Number(letter.level),
		number: letter.number,
		language: letter.language,
		currency: letter.currency,
		issue_date: letter.issue_date,
		deadline_date: letter.deadline_date,
		principal: Number(letter.principal),
		interest: Number(letter.interest),
		compensation: Number(letter.compensation),
		total_amount: Number(letter.total_amount),
		interest_included: Boolean(letter.interest_included),
		compensation_included: Boolean(letter.compensation_included),
		note: letter.note,
		created_by: letter.created_by,
		created: Number(letter.created),
		emails: extras.emails ?? 0,
	};
}
