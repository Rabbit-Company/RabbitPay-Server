import Database from "./database/database";
import { documentStorage } from "./document-storage";
import { invoiceDocument } from "./invoice-document";
import { invoiceFilename, renderInvoicePdf } from "./invoice-pdf";
import { issueSnapshotFor, snapshotLogo } from "./invoice-snapshot";
import { Logger } from "./logger";
import type { InvoiceDocumentRow, InvoiceRow, ProjectRow } from "./database/models";

const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 3_600_000;
const BATCH_SIZE = 20;

const active = new Map<string, Promise<{ name: string; data: Uint8Array }>>();

function hash(data: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function retryDelay(attempts: number): number {
	return Math.min(RETRY_BASE_MS * Math.pow(2, Math.max(0, attempts - 1)), RETRY_CAP_MS);
}

async function rowFor(invoiceId: string): Promise<InvoiceDocumentRow> {
	const [row] = (await Database`SELECT * FROM invoice_documents WHERE invoice = ${invoiceId}`) as InvoiceDocumentRow[];
	if (!row) throw new Error("Invoice document record is missing");
	return row;
}

async function generate(project: ProjectRow, invoice: InvoiceRow, row: InvoiceDocumentRow): Promise<{ name: string; data: Uint8Array }> {
	const snapshot = await issueSnapshotFor(invoice.uuid);
	if (!snapshot) throw new Error("Issued invoice snapshot is missing");
	const document = await invoiceDocument(project, invoice, { archival: true });
	const logo = await snapshotLogo(invoice.uuid);
	const data = await renderInvoicePdf(document, logo, { payLink: snapshot.settings.pdf_pay_link });
	const checksum = hash(data);
	await documentStorage().put(row.storage_key, data, row.content_type);
	const timestamp = Date.now();
	await Database`
		UPDATE invoice_documents SET status = 'ready', byte_size = ${data.byteLength}, sha256 = ${checksum}, attempts = ${row.attempts + 1},
			last_error = NULL, next_attempt_at = NULL, updated = ${timestamp} WHERE invoice = ${invoice.uuid}
	`;
	return { name: invoiceFilename(invoice.reference, snapshot.settings.language, "pdf", invoice.document_type), data };
}

async function loadOrGenerate(project: ProjectRow, invoice: InvoiceRow): Promise<{ name: string; data: Uint8Array }> {
	let row = await rowFor(invoice.uuid);
	const snapshot = await issueSnapshotFor(invoice.uuid);
	if (!snapshot) throw new Error("Issued invoice snapshot is missing");

	if (row.status === "ready" && row.sha256) {
		try {
			const data = await documentStorage().get(row.storage_key);
			if (data.byteLength !== row.byte_size || hash(data) !== row.sha256) throw new Error("Stored invoice failed its integrity check");
			return { name: invoiceFilename(invoice.reference, snapshot.settings.language, "pdf", invoice.document_type), data };
		} catch (err) {
			const timestamp = Date.now();
			const storageKey = `invoices/${invoice.project}/${invoice.uuid}/${crypto.randomUUID()}.pdf`;
			await Database`
				UPDATE invoice_documents SET storage_key = ${storageKey}, status = 'pending', byte_size = NULL, sha256 = NULL,
					last_error = ${err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500)}, next_attempt_at = ${timestamp}, updated = ${timestamp}
				WHERE invoice = ${invoice.uuid}
			`;
			row = await rowFor(invoice.uuid);
		}
	}

	try {
		return await generate(project, invoice, row);
	} catch (err) {
		const attempts = row.attempts + 1;
		const timestamp = Date.now();
		const reason = err instanceof Error ? err.message : String(err);
		await Database`
			UPDATE invoice_documents SET status = 'failed', attempts = ${attempts}, last_error = ${reason.slice(0, 500)},
				next_attempt_at = ${timestamp + retryDelay(attempts)}, updated = ${timestamp} WHERE invoice = ${invoice.uuid}
		`;
		throw err;
	}
}

export async function archivedInvoicePdf(project: ProjectRow, invoice: InvoiceRow): Promise<{ name: string; data: Uint8Array }> {
	const existing = active.get(invoice.uuid);
	if (existing) return await existing;
	const pending = loadOrGenerate(project, invoice);
	active.set(invoice.uuid, pending);
	try {
		return await pending;
	} finally {
		active.delete(invoice.uuid);
	}
}

export async function archivedInvoiceAttachment(project: ProjectRow, invoice: InvoiceRow): Promise<{ name: string; storageKey: string }> {
	const file = await archivedInvoicePdf(project, invoice);
	const row = await rowFor(invoice.uuid);
	if (row.status !== "ready") throw new Error("Invoice document is not ready");
	return { name: file.name, storageKey: row.storage_key };
}

export async function archiveIssuedInvoice(projectId: string, invoiceId: string): Promise<boolean> {
	const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${projectId}`) as ProjectRow[];
	const [invoice] = (await Database`SELECT * FROM invoices WHERE uuid = ${invoiceId} AND project = ${projectId}`) as InvoiceRow[];
	if (!project || !invoice || invoice.status === "draft") return false;
	try {
		await archivedInvoicePdf(project, invoice);
		return true;
	} catch (err) {
		Logger.error(`[DOCUMENTS] Could not archive invoice ${invoice.reference}: ${err}`);
		return false;
	}
}

export async function archivePendingInvoices(now = Date.now()): Promise<{ attempted: number; archived: number }> {
	const rows = (await Database`
		SELECT d.invoice, i.project FROM invoice_documents d
		JOIN invoices i ON i.uuid = d.invoice
		WHERE d.status != 'ready' AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ${now})
		ORDER BY d.created LIMIT ${BATCH_SIZE}
	`) as { invoice: string; project: string }[];
	let archived = 0;
	for (const row of rows) if (await archiveIssuedInvoice(row.project, row.invoice)) archived++;
	return { attempted: rows.length, archived };
}
