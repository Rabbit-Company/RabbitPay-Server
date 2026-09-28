import { createHash } from "node:crypto";
import Database from "../database/database";
import { documentStorage } from "../document-storage";
import type { StoreImageKind, StoreImageRow } from "../database/models";

export const MAX_STORE_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PRODUCT_IMAGES = 12;
export const STORE_IMAGE_BODY_LIMIT = Math.ceil(MAX_STORE_IMAGE_BYTES / 3) * 4 + 16 * 1024;

const SIGNATURES: { type: string; matches: (bytes: Uint8Array) => boolean }[] = [
	{ type: "image/png", matches: (bytes) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte) },
	{ type: "image/jpeg", matches: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
	{
		type: "image/webp",
		matches: (bytes) => new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP",
	},
];

export function readStoreImage(base64: unknown): { type: string; bytes: Buffer } | null {
	if (typeof base64 !== "string" || base64.length === 0 || base64.length > Math.ceil(MAX_STORE_IMAGE_BYTES / 3) * 4 + 4) return null;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;

	const bytes = Buffer.from(base64, "base64");
	if (bytes.length < 12 || bytes.length > MAX_STORE_IMAGE_BYTES) return null;

	const signature = SIGNATURES.find((candidate) => candidate.matches(bytes));
	return signature ? { type: signature.type, bytes } : null;
}

export async function storeImage(
	projectId: string,
	kind: StoreImageKind,
	item: string | null,
	image: { type: string; bytes: Buffer },
	alt: string | null,
	sortOrder: number
): Promise<StoreImageRow> {
	const uuid = crypto.randomUUID();
	const key = `store/${projectId}/${kind}/${uuid}`;
	await documentStorage().put(key, image.bytes, image.type);
	const sha256 = createHash("sha256").update(image.bytes).digest("hex");
	const created = Date.now();
	try {
		await Database`
			INSERT INTO store_images(uuid, project, item, kind, storage_key, content_type, byte_size, sha256, alt, sort_order, created)
			VALUES(${uuid}, ${projectId}, ${item}, ${kind}, ${key}, ${image.type}, ${image.bytes.length}, ${sha256}, ${alt}, ${sortOrder}, ${created})
		`;
	} catch (err) {
		await documentStorage().remove(key);
		throw err;
	}
	return {
		uuid,
		project: projectId,
		item,
		kind,
		storage_key: key,
		content_type: image.type,
		byte_size: image.bytes.length,
		sha256,
		alt,
		sort_order: sortOrder,
		created,
	};
}

export async function removeStoreImages(rows: Pick<StoreImageRow, "uuid" | "storage_key">[]) {
	if (rows.length === 0) return;
	await Database`DELETE FROM store_images WHERE uuid IN ${Database(rows.map((row) => row.uuid))}`;
	for (const row of rows) await documentStorage().remove(row.storage_key);
}

export async function imagesOf(itemIds: string[]): Promise<Map<string, StoreImageRow[]>> {
	const grouped = new Map<string, StoreImageRow[]>();
	if (itemIds.length === 0) return grouped;
	const rows = (await Database`
		SELECT * FROM store_images WHERE kind = 'product' AND item IN ${Database(itemIds)} ORDER BY sort_order ASC, created ASC
	`) as StoreImageRow[];
	for (const row of rows) {
		const list = grouped.get(row.item!) ?? [];
		list.push(row);
		grouped.set(row.item!, list);
	}
	return grouped;
}
