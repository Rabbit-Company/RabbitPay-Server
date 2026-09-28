import Database from "./database/database";
import { creditNoteDocument } from "./credit-note-document";
import { creditNoteSnapshotFor, creditNoteSnapshotLogo } from "./credit-note-snapshot";
import { documentStorage } from "./document-storage";
import { creditNoteFilename, renderCreditNotePdf } from "./invoice-pdf";
import { Logger } from "./logger";
import type { CreditNoteDocumentRow, CreditNoteRow, ProjectRow } from "./database/models";

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

async function rowFor(noteId: string): Promise<CreditNoteDocumentRow> {
	const [row] = (await Database`SELECT * FROM credit_note_documents WHERE credit_note = ${noteId}`) as CreditNoteDocumentRow[];
	if (!row) throw new Error("Credit note document record is missing");
	return row;
}

async function generate(project: ProjectRow, note: CreditNoteRow, row: CreditNoteDocumentRow): Promise<{ name: string; data: Uint8Array }> {
	const snapshot = await creditNoteSnapshotFor(note.uuid);
	if (!snapshot) throw new Error("Credit note issue snapshot is missing");
	const document = await creditNoteDocument(project, note);
	const logo = await creditNoteSnapshotLogo(note.uuid);
	const data = await renderCreditNotePdf(document, logo);
	const checksum = hash(data);
	await documentStorage().put(row.storage_key, data, row.content_type);
	const timestamp = Date.now();
	await Database`
		UPDATE credit_note_documents SET status = 'ready', byte_size = ${data.byteLength}, sha256 = ${checksum}, attempts = ${row.attempts + 1},
			last_error = NULL, next_attempt_at = NULL, updated = ${timestamp} WHERE credit_note = ${note.uuid}
	`;
	return { name: creditNoteFilename(note.reference, snapshot.settings.language), data };
}

async function loadOrGenerate(project: ProjectRow, note: CreditNoteRow): Promise<{ name: string; data: Uint8Array }> {
	let row = await rowFor(note.uuid);
	const snapshot = await creditNoteSnapshotFor(note.uuid);
	if (!snapshot) throw new Error("Credit note issue snapshot is missing");

	if (row.status === "ready" && row.sha256) {
		try {
			const data = await documentStorage().get(row.storage_key);
			if (data.byteLength !== row.byte_size || hash(data) !== row.sha256) throw new Error("Stored credit note failed its integrity check");
			return { name: creditNoteFilename(note.reference, snapshot.settings.language), data };
		} catch (err) {
			const timestamp = Date.now();
			const storageKey = `credit-notes/${note.project}/${note.uuid}/${crypto.randomUUID()}.pdf`;
			await Database`
				UPDATE credit_note_documents SET storage_key = ${storageKey}, status = 'pending', byte_size = NULL, sha256 = NULL,
					last_error = ${err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500)}, next_attempt_at = ${timestamp}, updated = ${timestamp}
				WHERE credit_note = ${note.uuid}
			`;
			row = await rowFor(note.uuid);
		}
	}

	try {
		return await generate(project, note, row);
	} catch (err) {
		const attempts = row.attempts + 1;
		const timestamp = Date.now();
		const reason = err instanceof Error ? err.message : String(err);
		await Database`
			UPDATE credit_note_documents SET status = 'failed', attempts = ${attempts}, last_error = ${reason.slice(0, 500)},
				next_attempt_at = ${timestamp + retryDelay(attempts)}, updated = ${timestamp} WHERE credit_note = ${note.uuid}
		`;
		throw err;
	}
}

export async function archivedCreditNotePdf(project: ProjectRow, note: CreditNoteRow): Promise<{ name: string; data: Uint8Array }> {
	const existing = active.get(note.uuid);
	if (existing) return await existing;
	const pending = loadOrGenerate(project, note);
	active.set(note.uuid, pending);
	try {
		return await pending;
	} finally {
		active.delete(note.uuid);
	}
}

export async function archivedCreditNoteAttachment(project: ProjectRow, note: CreditNoteRow): Promise<{ name: string; storageKey: string }> {
	const file = await archivedCreditNotePdf(project, note);
	const row = await rowFor(note.uuid);
	if (row.status !== "ready") throw new Error("Credit note document is not ready");
	return { name: file.name, storageKey: row.storage_key };
}

export async function archiveIssuedCreditNote(projectId: string, noteId: string): Promise<boolean> {
	const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${projectId}`) as ProjectRow[];
	const [note] = (await Database`SELECT * FROM credit_notes WHERE uuid = ${noteId} AND project = ${projectId}`) as CreditNoteRow[];
	if (!project || !note) return false;
	try {
		await archivedCreditNotePdf(project, note);
		return true;
	} catch (err) {
		Logger.error(`[DOCUMENTS] Could not archive credit note ${note.reference}: ${err}`);
		return false;
	}
}

export async function archivePendingCreditNotes(now = Date.now()): Promise<{ attempted: number; archived: number }> {
	const rows = (await Database`
		SELECT d.credit_note, n.project FROM credit_note_documents d
		JOIN credit_notes n ON n.uuid = d.credit_note
		WHERE d.status != 'ready' AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ${now})
		ORDER BY d.created LIMIT ${BATCH_SIZE}
	`) as { credit_note: string; project: string }[];
	let archived = 0;
	for (const row of rows) if (await archiveIssuedCreditNote(row.project, row.credit_note)) archived++;
	return { attempted: rows.length, archived };
}
