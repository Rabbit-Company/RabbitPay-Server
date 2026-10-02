import Database from "../database/database";
import { DocumentArchiveDamaged, documentStorage } from "../document-storage";
import { renderFiscalCreditNotePdf, renderFiscalInvoicePdf } from "../invoice-pdf";
import { Logger } from "../logger";
import type { CreditNoteRow, FiscalDocumentRow, InvoiceRow, ProjectRow } from "../database/models";

const BATCH_SIZE = 20;
const CONTENT_TYPE = "application/pdf";

function hash(data: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

async function render(document: FiscalDocumentRow): Promise<{ key: string; data: Uint8Array } | null> {
	const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${document.project}`) as ProjectRow[];
	if (!project) return null;

	if (document.invoice) {
		const [invoice] = (await Database`SELECT * FROM invoices WHERE uuid = ${document.invoice}`) as InvoiceRow[];
		if (!invoice) return null;
		const { data } = await renderFiscalInvoicePdf(project, invoice);
		return { key: `invoices/${project.uuid}/${invoice.uuid}/verified-${crypto.randomUUID()}.pdf`, data };
	}

	const [note] = (await Database`SELECT * FROM credit_notes WHERE uuid = ${document.credit_note!}`) as CreditNoteRow[];
	if (!note) return null;
	const { data } = await renderFiscalCreditNotePdf(project, note);
	return { key: `credit-notes/${project.uuid}/${note.uuid}/verified-${crypto.randomUUID()}.pdf`, data };
}

export async function archiveVerifiedCopy(document: FiscalDocumentRow): Promise<boolean> {
	if (document.status !== "verified" || document.archive_key) return false;

	const rendered = await render(document);
	if (!rendered) return false;

	await documentStorage().put(rendered.key, rendered.data, CONTENT_TYPE);
	const stored = await Database`
		UPDATE fiscal_documents SET archive_key = ${rendered.key}, archive_size = ${rendered.data.byteLength}, archive_sha256 = ${hash(rendered.data)}
		WHERE uuid = ${document.uuid} AND archive_key IS NULL
	`;
	if (stored.count === 0) {
		await documentStorage().remove(rendered.key);
		return false;
	}
	return true;
}

export async function verifiedCopy(document: FiscalDocumentRow): Promise<Uint8Array | null> {
	if (!document.archive_key) return null;
	const label = `${document.premise_id}-${document.device_id}-${document.invoice_number}`;
	let data: Uint8Array;
	try {
		data = await documentStorage().get(document.archive_key);
	} catch (err) {
		throw new DocumentArchiveDamaged(
			`The verified copy of ${label} could not be read from the document storage: ${err instanceof Error ? err.message : String(err)}`
		);
	}
	if (data.byteLength !== Number(document.archive_size) || hash(data) !== document.archive_sha256) {
		throw new DocumentArchiveDamaged(`The verified copy of ${label} does not match the checksum recorded when it was archived`);
	}
	return data;
}

export async function archivePendingVerifiedCopies(): Promise<{ attempted: number; archived: number }> {
	const documents = (await Database`
		SELECT * FROM fiscal_documents WHERE status = 'verified' AND archive_key IS NULL ORDER BY verified_at ASC LIMIT ${BATCH_SIZE}
	`) as FiscalDocumentRow[];

	let archived = 0;
	for (const document of documents) {
		try {
			if (await archiveVerifiedCopy(document)) archived++;
		} catch (err) {
			Logger.error(`[DOCUMENTS] Could not archive the verified copy of ${document.premise_id}-${document.device_id}-${document.invoice_number}: ${err}`);
		}
	}
	return { attempted: documents.length, archived };
}
