import type { SQL } from "bun";
import Database from "./database/database";
import { documentStorage } from "./document-storage";
import { taxDetailsFor } from "./document-parts";
import type { PreparedIssuePresentation } from "./invoice-snapshot";
import type { InvoiceDesign } from "./invoice-design";
import type { CreditNoteIssueSnapshotRow, CreditNoteRow, InvoiceRow, ProjectRow } from "./database/models";

const SNAPSHOT_VERSION = 1;
const RENDERER_VERSION = 1;

export interface StoredCreditNoteSettings {
	renderer_version: number;
	tax: ReturnType<typeof taxDetailsFor>;
	formats: { date: string; time: string; timezone?: string };
	language: string;
	branding: { white_label: boolean; logo_storage_key: string | null; logo_content_type: string | null };
	design?: InvoiceDesign;
}

export interface StoredCreditNoteSnapshot {
	seller: PreparedIssuePresentation["seller"];
	settings: StoredCreditNoteSettings;
}

export async function saveCreditNotePresentation(
	sql: SQL,
	note: CreditNoteRow,
	invoice: InvoiceRow,
	treatments: (string | null)[],
	prepared: PreparedIssuePresentation
) {
	const project: Pick<ProjectRow, "vat_status" | "tax_country" | "vat_exemption_note" | "language"> = {
		vat_status: prepared.vat_status,
		tax_country: prepared.tax_country,
		vat_exemption_note: prepared.vat_exemption_note,
		language: prepared.language,
	};
	const settings: StoredCreditNoteSettings = {
		renderer_version: RENDERER_VERSION,
		tax: taxDetailsFor(project, invoice, treatments, note.tax_amount),
		formats: prepared.formats,
		language: prepared.language,
		branding: prepared.branding,
		design: prepared.design,
	};
	const storageKey = `credit-notes/${note.project}/${note.uuid}/${crypto.randomUUID()}.pdf`;

	await sql`
		INSERT INTO credit_note_issue_snapshots(credit_note, schema_version, seller_details, document_settings, created)
		VALUES(${note.uuid}, ${SNAPSHOT_VERSION}, ${JSON.stringify(prepared.seller)}, ${JSON.stringify(settings)}, ${note.created})
	`;
	await sql`
		INSERT INTO credit_note_documents(credit_note, storage_key, content_type, byte_size, sha256, status, attempts, last_error, next_attempt_at, created, updated)
		VALUES(${note.uuid}, ${storageKey}, ${"application/pdf"}, ${null}, ${null}, ${"pending"}, 0, ${null}, ${note.created}, ${note.created}, ${note.created})
	`;
}

export async function creditNoteSnapshotFor(noteId: string): Promise<StoredCreditNoteSnapshot | null> {
	const [row] = (await Database`SELECT * FROM credit_note_issue_snapshots WHERE credit_note = ${noteId}`) as CreditNoteIssueSnapshotRow[];
	if (!row || row.schema_version !== SNAPSHOT_VERSION) return null;
	return {
		seller: JSON.parse(row.seller_details) as StoredCreditNoteSnapshot["seller"],
		settings: JSON.parse(row.document_settings) as StoredCreditNoteSettings,
	};
}

export async function creditNoteSnapshotLogo(noteId: string): Promise<{ type: string; bytes: Buffer } | null> {
	const snapshot = await creditNoteSnapshotFor(noteId);
	const key = snapshot?.settings.branding.logo_storage_key;
	const type = snapshot?.settings.branding.logo_content_type;
	if (!key || !type) return null;
	return { type, bytes: Buffer.from(await documentStorage().get(key)) };
}
