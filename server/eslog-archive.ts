import type { Context } from "@rabbit-company/web";
import Database from "./database/database";
import Utils from "./utils";
import { ErrorCode } from "./errors";
import { Logger } from "./logger";
import { documentStorage } from "./document-storage";
import { assertStorageCapacity, StorageLimitReached } from "./licensing";
import { downloadResponse } from "./invoice-pdf";
import { loadInvoice } from "./invoice-service";
import { signingCertificate, SigningCertificateExpired, signingCredentials } from "./einvoice-signing";
import { creditNoteEslog, ESLOG_CONTENT_TYPE, EslogDataIncomplete, invoiceEslog, type EslogSigner } from "./eslog";
import { NO_REFERENCE_DOCUMENT, type ReferenceDocumentColumns } from "./reference-document";
import type { CreditNoteRow, InvoiceRow, ProjectRow } from "./database/models";

export interface EslogDocumentRow extends ReferenceDocumentColumns {
	uuid: string;
	project: string;
	invoice: string | null;
	credit_note: string | null;
	version: number;
	file_name: string;
	storage_key: string;
	byte_size: number;
	sha256: string;
	signed: number;
	created: number;
}

export type EslogSubject = { kind: "invoice"; project: ProjectRow; invoice: InvoiceRow } | { kind: "credit_note"; project: ProjectRow; note: CreditNoteRow };

export interface ArchivedEslog {
	id: string;
	name: string;
	data: Uint8Array;
	version: number;
}

export class EslogArchiveDamaged extends Error {}

export class EslogVersionNotFound extends Error {}

const active = new Map<string, Promise<ArchivedEslog>>();

function hash(data: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function subjectId(subject: EslogSubject): string {
	return subject.kind === "invoice" ? subject.invoice.uuid : subject.note.uuid;
}

export async function eslogVersions(subject: EslogSubject): Promise<EslogDocumentRow[]> {
	const id = subjectId(subject);
	return (await (subject.kind === "invoice"
		? Database`SELECT * FROM eslog_documents WHERE invoice = ${id} ORDER BY version ASC`
		: Database`SELECT * FROM eslog_documents WHERE credit_note = ${id} ORDER BY version ASC`)) as EslogDocumentRow[];
}

async function referenceInvoice(subject: EslogSubject): Promise<InvoiceRow | undefined> {
	return subject.kind === "invoice" ? subject.invoice : await loadInvoice(subject.project.uuid, subject.note.invoice);
}

function referenceColumns(invoice: InvoiceRow | undefined): ReferenceDocumentColumns {
	if (!invoice) return NO_REFERENCE_DOCUMENT;
	return {
		reference_document_type: invoice.reference_document_type,
		reference_document_number: invoice.reference_document_number,
		reference_document_date: invoice.reference_document_date,
	};
}

function sameReference(row: ReferenceDocumentColumns, current: ReferenceDocumentColumns): boolean {
	return (
		(row.reference_document_type ?? null) === (current.reference_document_type ?? null) &&
		(row.reference_document_number ?? null) === (current.reference_document_number ?? null) &&
		(row.reference_document_date === null ? null : Number(row.reference_document_date)) ===
			(current.reference_document_date === null ? null : Number(current.reference_document_date))
	);
}

async function readStored(row: EslogDocumentRow): Promise<ArchivedEslog> {
	let data: Uint8Array;
	try {
		data = await documentStorage().get(row.storage_key);
	} catch (err) {
		throw new EslogArchiveDamaged(`Version ${row.version} could not be read from the document storage: ${err}`);
	}
	if (data.byteLength !== Number(row.byte_size) || hash(data) !== row.sha256) {
		throw new EslogArchiveDamaged(`Version ${row.version} does not match the checksum recorded when it was stored.`);
	}
	return { id: row.uuid, name: row.file_name, data, version: Number(row.version) };
}

export async function storedEslog(id: string): Promise<ArchivedEslog> {
	const [row] = (await Database`SELECT * FROM eslog_documents WHERE uuid = ${id}`) as EslogDocumentRow[];
	if (!row) throw new EslogVersionNotFound();
	return await readStored(row);
}

async function hasUsableCertificate(projectId: string): Promise<boolean> {
	const certificate = await signingCertificate(projectId);
	return certificate !== null && certificate.valid_to >= Date.now();
}

async function storeVersion(subject: EslogSubject, version: number, invoice: InvoiceRow | undefined): Promise<ArchivedEslog> {
	const project = subject.project;
	const credentials = await signingCredentials(project.uuid);
	const signer: EslogSigner | null = credentials ? { credentials, signedAt: Date.now() } : null;
	const file =
		subject.kind === "invoice" ? await invoiceEslog(project, subject.invoice, signer) : await creditNoteEslog(project, subject.note, invoice, signer);

	await assertStorageCapacity(project.uuid, file.data.byteLength);
	const id = subjectId(subject);
	const uuid = crypto.randomUUID();
	const storageKey = `eslog/${project.uuid}/${id}/${uuid}.xml`;
	const reference = referenceColumns(invoice);
	const created = Date.now();
	await documentStorage().put(storageKey, file.data, ESLOG_CONTENT_TYPE);

	await Database`
		INSERT INTO eslog_documents(uuid, project, invoice, credit_note, version, file_name, storage_key, byte_size, sha256, signed,
			reference_document_type, reference_document_number, reference_document_date, created)
		VALUES(${uuid}, ${project.uuid}, ${subject.kind === "invoice" ? id : null}, ${subject.kind === "credit_note" ? id : null}, ${version},
			${file.name}, ${storageKey}, ${file.data.byteLength}, ${hash(file.data)}, ${signer ? 1 : 0}, ${reference.reference_document_type},
			${reference.reference_document_number}, ${reference.reference_document_date}, ${created})
	`;
	const documentNumber = subject.kind === "invoice" ? subject.invoice.reference : subject.note.reference;
	Logger.audit(`[ESLOG] Stored version ${version} of ${documentNumber} on ${project.uuid}${signer ? ", signed" : ""}`);

	return { id: uuid, name: file.name, data: file.data, version };
}

async function latestOrNew(subject: EslogSubject): Promise<ArchivedEslog> {
	const versions = await eslogVersions(subject);
	const latest = versions.at(-1);
	const invoice = await referenceInvoice(subject);

	if (latest && sameReference(latest, referenceColumns(invoice))) {
		if (latest.signed || !(await hasUsableCertificate(subject.project.uuid))) return await readStored(latest);
	}
	return await storeVersion(subject, latest ? Number(latest.version) + 1 : 1, invoice);
}

export async function archivedEslog(subject: EslogSubject, version: number | null = null): Promise<ArchivedEslog> {
	if (version !== null) {
		const row = (await eslogVersions(subject)).find((entry) => Number(entry.version) === version);
		if (!row) throw new EslogVersionNotFound();
		return await readStored(row);
	}

	const id = subjectId(subject);
	const running = active.get(id);
	if (running) return await running;
	const pending = latestOrNew(subject);
	active.set(id, pending);
	try {
		return await pending;
	} finally {
		active.delete(id);
	}
}

export function presentVersions(rows: EslogDocumentRow[]) {
	return rows.map((row) => ({
		version: Number(row.version),
		signed: Boolean(row.signed),
		byte_size: Number(row.byte_size),
		sha256: row.sha256,
		reference_document_type: row.reference_document_type,
		reference_document_number: row.reference_document_number,
		reference_document_date: row.reference_document_date === null ? null : Number(row.reference_document_date),
		created: Number(row.created),
	}));
}

export function requestedVersion(value: string | null): number | null | "invalid" {
	if (value === null || value === "") return null;
	const version = Number(value);
	return Number.isSafeInteger(version) && version > 0 ? version : "invalid";
}

export async function eslogResponse(ctx: Context<any, any>, subject: EslogSubject): Promise<Response> {
	const version = requestedVersion(ctx.query().get("version"));
	if (version === "invalid") return Utils.fail(ctx, ErrorCode.ESLOG_VERSION_NOT_FOUND);

	try {
		const file = await archivedEslog(subject, version);
		const response = downloadResponse(file, ESLOG_CONTENT_TYPE);
		response.headers.set("X-Document-Version", String(file.version));
		return response;
	} catch (error) {
		const failure = eslogFailure(ctx, error);
		if (failure) return failure;
		throw error;
	}
}

export async function customerEslogResponse(ctx: Context<any, any>, subject: EslogSubject): Promise<Response> {
	try {
		return downloadResponse(await archivedEslog(subject), ESLOG_CONTENT_TYPE);
	} catch (error) {
		if (!isEslogFailure(error)) throw error;
		const reference = subject.kind === "invoice" ? subject.invoice.reference : subject.note.reference;
		Logger.warn(`[ESLOG] A customer could not download ${reference} on ${subject.project.uuid}: ${error instanceof Error ? error.message : error}`);
		return Utils.fail(ctx, ErrorCode.ESLOG_UNAVAILABLE);
	}
}

export function eslogFailure(ctx: Context<any, any>, error: unknown): Response | null {
	if (error instanceof EslogVersionNotFound) return Utils.fail(ctx, ErrorCode.ESLOG_VERSION_NOT_FOUND);
	if (error instanceof StorageLimitReached) return Utils.fail(ctx, ErrorCode.STORAGE_LIMIT_REACHED);
	if (error instanceof SigningCertificateExpired) return Utils.failWithReason(ctx, ErrorCode.SIGNING_CERTIFICATE_REJECTED, error.message);
	if (error instanceof EslogDataIncomplete) return Utils.failWithReason(ctx, ErrorCode.ESLOG_DATA_INCOMPLETE, error.message, { issues: error.issues });
	if (error instanceof EslogArchiveDamaged) {
		Logger.error(`[ESLOG] ${error.message}`);
		return Utils.fail(ctx, ErrorCode.ESLOG_ARCHIVE_DAMAGED);
	}
	return null;
}

export function isEslogFailure(error: unknown): boolean {
	return (
		error instanceof EslogVersionNotFound ||
		error instanceof StorageLimitReached ||
		error instanceof SigningCertificateExpired ||
		error instanceof EslogDataIncomplete ||
		error instanceof EslogArchiveDamaged
	);
}
