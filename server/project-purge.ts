import Database from "./database/database";
import { documentStorage } from "./document-storage";
import { Logger } from "./logger";
import type { ProjectRow } from "./database/models";

export interface PurgeResult {
	stored_files: number;
	stored_bytes: number;
	missed_files: number;
}

interface StoredObject {
	key: string;
	bytes: number;
}

async function storedObjects(projectId: string): Promise<StoredObject[]> {
	const single = (await Database`
		SELECT d.storage_key AS storage_key, d.byte_size AS byte_size FROM invoice_documents d JOIN invoices i ON i.uuid = d.invoice WHERE i.project = ${projectId}
		UNION ALL
		SELECT d.storage_key, d.byte_size FROM credit_note_documents d JOIN credit_notes n ON n.uuid = d.credit_note WHERE n.project = ${projectId}
		UNION ALL
		SELECT a.storage_key, a.byte_size FROM expense_attachments a JOIN expenses e ON e.uuid = a.expense WHERE e.project = ${projectId}
		UNION ALL
		SELECT a.storage_key, a.byte_size FROM recorded_invoice_attachments a JOIN recorded_invoices r ON r.uuid = a.recorded_invoice
			WHERE r.project = ${projectId}
		UNION ALL
		SELECT storage_key, byte_size FROM ddv_exports WHERE project = ${projectId}
		UNION ALL
		SELECT archive_key, archive_size FROM fiscal_documents WHERE project = ${projectId} AND archive_key IS NOT NULL
		UNION ALL
		SELECT storage_key, byte_size FROM store_images WHERE project = ${projectId}
		UNION ALL
		SELECT storage_key, byte_size FROM eslog_documents WHERE project = ${projectId}
	`) as { storage_key: string; byte_size: number | null }[];
	const files = (await Database`
		SELECT storage_key, byte_size, parts FROM project_files WHERE project = ${projectId} AND removed_at IS NULL
	`) as { storage_key: string; byte_size: number; parts: number }[];

	return [
		...single.map((row) => ({ key: row.storage_key, bytes: Number(row.byte_size ?? 0) })),
		...files.flatMap((file) =>
			Array.from({ length: Number(file.parts) }, (_, index) => ({ key: `${file.storage_key}/${index}`, bytes: index === 0 ? Number(file.byte_size) : 0 }))
		),
	];
}

export async function purgeProject(project: Pick<ProjectRow, "uuid">): Promise<PurgeResult> {
	const objects = await storedObjects(project.uuid);
	await Database.begin(async (tx) => {
		await tx`DELETE FROM audit_log WHERE project = ${project.uuid}`;
		await tx`DELETE FROM projects WHERE uuid = ${project.uuid}`;
	});

	let missed = 0;
	for (const object of new Set(objects.map((entry) => entry.key))) {
		try {
			await documentStorage().remove(object);
		} catch (error) {
			missed++;
			Logger.error(`[PURGE] Could not remove stored file ${object} of project ${project.uuid}: ${error}`);
		}
	}
	return { stored_files: objects.length, stored_bytes: objects.reduce((total, object) => total + object.bytes, 0), missed_files: missed };
}
