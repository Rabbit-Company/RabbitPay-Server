import Database from "./database/database";
import { documentStorage } from "./document-storage";
import { Settings } from "./settings";
import { DEFAULT_MAX_FILE_BYTES, FILE_MB_BYTES, MAX_FILE_NAME_LENGTH, partCount, partLength, UPLOAD_EXPIRY_MS } from "./file-limits";
import type { ProjectFileRow, ProjectRow } from "./database/models";

export const FALLBACK_CONTENT_TYPE = "application/octet-stream";

const CONTENT_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface FileRequest {
	name: string;
	type: string;
	size: number;
}

export function fileNameOf(value: unknown): string | null {
	if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) return null;
	const name = value.split(/[\\/]/).pop()!.trim();
	return name && name.length <= MAX_FILE_NAME_LENGTH ? name : null;
}

function contentTypeOf(value: unknown): string {
	const type = typeof value === "string" ? value.trim().toLowerCase() : "";
	return type.length <= 100 && CONTENT_TYPE.test(type) ? type : FALLBACK_CONTENT_TYPE;
}

export function readFileRequest(data: Record<string, unknown> | null): FileRequest | null {
	const name = fileNameOf(data?.name);
	const size = data?.size;
	if (name === null || typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) return null;
	return { name, type: contentTypeOf(data?.type), size };
}

export function fileSizeCeiling(): number {
	return Settings.licensing.max_file_mb * FILE_MB_BYTES;
}

export function maxFileBytes(project: Pick<ProjectRow, "max_file_bytes">): number {
	return Math.min(Number(project.max_file_bytes ?? DEFAULT_MAX_FILE_BYTES), fileSizeCeiling());
}

function partKey(file: Pick<ProjectFileRow, "storage_key">, index: number): string {
	return `${file.storage_key}/${index}`;
}

export async function findFile(projectId: string, uuid: string): Promise<ProjectFileRow | null> {
	const [file] = (await Database`SELECT * FROM project_files WHERE uuid = ${uuid} AND project = ${projectId}`) as ProjectFileRow[];
	return file ?? null;
}

export interface FilePlace {
	explorer: boolean;
	folder: string | null;
}

export async function beginUpload(
	projectId: string,
	request: FileRequest,
	username: string,
	place: FilePlace = { explorer: false, folder: null }
): Promise<ProjectFileRow> {
	const uuid = crypto.randomUUID();
	await Database`
		INSERT INTO project_files(uuid, project, storage_key, file_name, content_type, byte_size, parts, parts_received, status, explorer, folder,
			created_by, created)
		VALUES(${uuid}, ${projectId}, ${`files/${projectId}/${uuid}`}, ${request.name}, ${request.type}, ${request.size}, ${partCount(request.size)}, 0,
			'uploading', ${place.explorer ? 1 : 0}, ${place.folder}, ${username}, ${Date.now()})
	`;
	return (await findFile(projectId, uuid))!;
}

export function acceptsPart(file: ProjectFileRow, index: number, length: number): boolean {
	if (file.status !== "uploading" || file.removed_at !== null) return false;
	const received = Number(file.parts_received);
	if (index !== received && index !== received - 1) return false;
	return index >= 0 && index < Number(file.parts) && length === partLength(Number(file.byte_size), index);
}

export async function storePart(file: ProjectFileRow, index: number, bytes: Uint8Array): Promise<ProjectFileRow> {
	await documentStorage().put(partKey(file, index), bytes, FALLBACK_CONTENT_TYPE);
	const status = index + 1 === Number(file.parts) ? "ready" : "uploading";
	await Database`
		UPDATE project_files SET parts_received = ${index + 1}, status = ${status}
		WHERE uuid = ${file.uuid} AND status = 'uploading' AND parts_received IN (${index}, ${index + 1})
	`;
	return (await findFile(file.project, file.uuid))!;
}

export function fileStream(file: ProjectFileRow): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (index >= Number(file.parts)) return controller.close();
			controller.enqueue(await documentStorage().get(partKey(file, index++)));
		},
	});
}

export function fileResponse(file: ProjectFileRow): Response {
	const fallback = file.file_name.replace(/[^A-Za-z0-9._-]/g, "_") || "file";
	return new Response(fileStream(file), {
		headers: {
			"Content-Type": file.content_type,
			"Content-Length": String(file.byte_size),
			"Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.file_name)}`,
			"Content-Security-Policy": "sandbox; default-src 'none'",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

async function removeParts(file: ProjectFileRow) {
	for (let index = 0; index < Number(file.parts); index++) await documentStorage().remove(partKey(file, index));
}

export async function removeFile(file: ProjectFileRow, username: string): Promise<ProjectFileRow | null> {
	const now = Date.now();
	const claimed = await Database`
		UPDATE project_files SET removed_at = ${now}, removed_by = ${username}, explorer = 0, folder = NULL, access = 'private' WHERE uuid = ${file.uuid} AND removed_at IS NULL
	`;
	if (claimed.count === 0) return null;
	await removeParts(file);
	return { ...file, removed_at: now, removed_by: username };
}

export async function filesOfTicket(ticketId: string): Promise<ProjectFileRow[]> {
	return (await Database`
		SELECT f.* FROM project_files f JOIN ticket_files tf ON tf.file = f.uuid
		WHERE tf.ticket = ${ticketId} AND f.status = 'ready' ORDER BY tf.created ASC, f.uuid ASC
	`) as ProjectFileRow[];
}

export async function filesOnlyOnTicket(ticketId: string): Promise<ProjectFileRow[]> {
	return (await Database`
		SELECT f.* FROM project_files f JOIN ticket_files tf ON tf.file = f.uuid
		WHERE tf.ticket = ${ticketId} AND NOT EXISTS (SELECT 1 FROM ticket_files other WHERE other.file = f.uuid AND other.ticket != ${ticketId})
	`) as ProjectFileRow[];
}

export async function discardFiles(files: ProjectFileRow[]) {
	if (files.length === 0) return;
	await Database`DELETE FROM project_files WHERE uuid IN ${Database(files.map((file) => file.uuid))}`;
	for (const file of files) {
		if (file.removed_at === null) await removeParts(file);
	}
}

export async function discardAbandonedUploads(now = Date.now()): Promise<number> {
	const abandoned = (await Database`
		SELECT * FROM project_files WHERE status = 'uploading' AND created < ${now - UPLOAD_EXPIRY_MS} LIMIT 500
	`) as ProjectFileRow[];
	await discardFiles(abandoned);
	return abandoned.length;
}

export function presentFile(row: ProjectFileRow) {
	return {
		uuid: row.uuid,
		file_name: row.file_name,
		content_type: row.content_type,
		byte_size: Number(row.byte_size),
		ready: row.status === "ready",
		created_by: row.created_by,
		created: Number(row.created),
		removed: row.removed_at !== null,
		removed_by: row.removed_by,
		removed_at: row.removed_at === null ? null : Number(row.removed_at),
	};
}
