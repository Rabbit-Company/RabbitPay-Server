import Database from "./database/database";
import { deliveredInvoicePdf, invoiceArchiveFilename } from "./invoice-pdf";
import { endOfLocalDate, isLocalDate, startOfLocalDate } from "./timezone";
import { zipArchive, type ZipEntry } from "./zip";
import type { InvoiceRow, ProjectRow } from "./database/models";

export const INVOICE_EXPORT_LIMIT = 1000;
const PDF_CONCURRENCY = 6;

export type InvoiceExportSelection = { kind: "period"; from: string; to: string } | { kind: "numbers"; first: string; last: string };

interface IssuePoint {
	reference: string;
	issued_at: number;
}

export interface InvoiceExportSummary {
	count: number;
	limit: number;
	first: IssuePoint | null;
	last: IssuePoint | null;
}

export class InvoiceNumberUnknown extends Error {
	constructor(public readonly reference: string) {
		super(`Invoice ${reference} is not an issued invoice of this project`);
	}
}

export function invoiceExportSelection(query: URLSearchParams): InvoiceExportSelection | null {
	const from = query.get("from");
	const to = query.get("to");
	const first = query.get("first")?.trim();
	const last = query.get("last")?.trim();
	if (first || last) {
		if (!first || !last || first.length > 64 || last.length > 64 || from !== null || to !== null) return null;
		return { kind: "numbers", first, last };
	}
	if (!isLocalDate(from) || !isLocalDate(to) || from > to) return null;
	return { kind: "period", from, to };
}

async function issuePoint(projectId: string, reference: string): Promise<IssuePoint> {
	const [row] = (await Database`
		SELECT reference, issued_at FROM invoices
		WHERE project = ${projectId} AND reference = ${reference} AND status != 'draft' AND issued_at IS NOT NULL
	`) as IssuePoint[];
	if (!row) throw new InvoiceNumberUnknown(reference);
	return { reference: row.reference, issued_at: Number(row.issued_at) };
}

function issuedAfter(left: IssuePoint, right: IssuePoint): boolean {
	return left.issued_at > right.issued_at || (left.issued_at === right.issued_at && left.reference > right.reference);
}

type IssueBounds = { kind: "period"; from: number; to: number } | { kind: "numbers"; first: IssuePoint; last: IssuePoint };

async function issueBounds(project: ProjectRow, selection: InvoiceExportSelection): Promise<IssueBounds> {
	if (selection.kind === "period") {
		return { kind: "period", from: startOfLocalDate(selection.from, project.timezone), to: endOfLocalDate(selection.to, project.timezone) };
	}
	const first = await issuePoint(project.uuid, selection.first);
	const last = await issuePoint(project.uuid, selection.last);
	return issuedAfter(first, last) ? { kind: "numbers", first: last, last: first } : { kind: "numbers", first, last };
}

function issuedWithin(project: ProjectRow, bounds: IssueBounds) {
	const range =
		bounds.kind === "period"
			? Database`i.issued_at >= ${bounds.from} AND i.issued_at <= ${bounds.to}`
			: Database`
				(i.issued_at > ${bounds.first.issued_at} OR (i.issued_at = ${bounds.first.issued_at} AND i.reference >= ${bounds.first.reference}))
				AND (i.issued_at < ${bounds.last.issued_at} OR (i.issued_at = ${bounds.last.issued_at} AND i.reference <= ${bounds.last.reference}))
			`;
	return Database`i.project = ${project.uuid} AND i.status != 'draft' AND i.issued_at IS NOT NULL AND ${range}`;
}

export async function invoiceExportSummary(project: ProjectRow, selection: InvoiceExportSelection): Promise<InvoiceExportSummary> {
	const bounds = await issueBounds(project, selection);
	const [counted] = (await Database`SELECT COUNT(*) AS count FROM invoices i WHERE ${issuedWithin(project, bounds)}`) as { count: number }[];
	const [first] = (await Database`
		SELECT i.reference, i.issued_at FROM invoices i WHERE ${issuedWithin(project, bounds)} ORDER BY i.issued_at ASC, i.reference ASC LIMIT 1
	`) as IssuePoint[];
	const [last] = (await Database`
		SELECT i.reference, i.issued_at FROM invoices i WHERE ${issuedWithin(project, bounds)} ORDER BY i.issued_at DESC, i.reference DESC LIMIT 1
	`) as IssuePoint[];
	const point = (row: IssuePoint | undefined) => (row ? { reference: row.reference, issued_at: Number(row.issued_at) } : null);
	return { count: Number(counted.count), limit: INVOICE_EXPORT_LIMIT, first: point(first), last: point(last) };
}

export async function invoicesForExport(project: ProjectRow, selection: InvoiceExportSelection): Promise<InvoiceRow[]> {
	const bounds = await issueBounds(project, selection);
	return (await Database`
		SELECT i.* FROM invoices i WHERE ${issuedWithin(project, bounds)} ORDER BY i.issued_at ASC, i.reference ASC LIMIT ${INVOICE_EXPORT_LIMIT + 1}
	`) as InvoiceRow[];
}

function uniqueName(name: string, taken: Set<string>): string {
	const dot = name.lastIndexOf(".");
	let candidate = name;
	for (let copy = 2; taken.has(candidate.toLowerCase()); copy++) candidate = `${name.slice(0, dot)} (${copy})${name.slice(dot)}`;
	taken.add(candidate.toLowerCase());
	return candidate;
}

export async function invoiceArchive(project: ProjectRow, invoices: InvoiceRow[]): Promise<{ name: string; data: Uint8Array }> {
	const files: ZipEntry[] = [];
	for (let start = 0; start < invoices.length; start += PDF_CONCURRENCY) {
		files.push(...(await Promise.all(invoices.slice(start, start + PDF_CONCURRENCY).map((invoice) => deliveredInvoicePdf(project, invoice)))));
	}
	const taken = new Set<string>();
	const entries = files.map((file) => ({ name: uniqueName(file.name, taken), data: file.data }));
	return {
		name: invoiceArchiveFilename(invoices[0].reference, invoices[invoices.length - 1].reference, project.language),
		data: zipArchive(entries),
	};
}
