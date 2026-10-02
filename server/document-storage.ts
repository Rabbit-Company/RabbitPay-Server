import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { S3Client } from "bun";
import { documentContext, isSealed, seal, unseal } from "./crypto/sealed-file";

export class DocumentArchiveDamaged extends Error {}

export interface DocumentStorage {
	put(key: string, data: Uint8Array, contentType: string): Promise<void>;
	get(key: string): Promise<Uint8Array>;
	exists(key: string): Promise<boolean>;
	remove(key: string): Promise<void>;
}

function sqliteDocumentPath(): string {
	const connection = Bun.env.RABBITPAY_DB || "sqlite://./data/rabbitpay.sqlite";
	if (!connection.startsWith("sqlite://") || connection === "sqlite://:memory:") return "./data/invoices";
	return join(dirname(connection.slice("sqlite://".length)), "invoices");
}

function safeKey(key: string): string {
	if (!/^[a-z0-9][a-z0-9/_.-]*$/i.test(key) || key.includes("..") || key.startsWith("/")) throw new Error("Invalid document storage key");
	return key;
}

export class LocalDocumentStorage implements DocumentStorage {
	readonly root: string;

	constructor(path = Bun.env.DOCUMENT_LOCAL_PATH || sqliteDocumentPath()) {
		this.root = resolve(path);
	}

	private path(key: string): string {
		return join(this.root, safeKey(key));
	}

	async put(key: string, data: Uint8Array, _contentType: string): Promise<void> {
		const target = this.path(key);
		await mkdir(dirname(target), { recursive: true });
		const temporary = `${target}.${crypto.randomUUID()}.tmp`;
		try {
			await Bun.write(temporary, data);
			await rename(temporary, target);
		} catch (err) {
			await unlink(temporary).catch(() => undefined);
			throw err;
		}
	}

	async get(key: string): Promise<Uint8Array> {
		const file = Bun.file(this.path(key));
		if (!(await file.exists())) throw new Error("Stored document is missing");
		return new Uint8Array(await file.arrayBuffer());
	}

	async exists(key: string): Promise<boolean> {
		return await Bun.file(this.path(key)).exists();
	}

	async remove(key: string): Promise<void> {
		await unlink(this.path(key)).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}

export class S3DocumentStorage implements DocumentStorage {
	private readonly client: S3Client;

	constructor() {
		const bucket = Bun.env.DOCUMENT_S3_BUCKET;
		if (!bucket) throw new Error("DOCUMENT_S3_BUCKET is required when DOCUMENT_STORAGE is s3");
		this.client = new S3Client({
			bucket,
			region: Bun.env.DOCUMENT_S3_REGION || undefined,
			endpoint: Bun.env.DOCUMENT_S3_ENDPOINT || undefined,
			accessKeyId: Bun.env.DOCUMENT_S3_ACCESS_KEY_ID || undefined,
			secretAccessKey: Bun.env.DOCUMENT_S3_SECRET_ACCESS_KEY || undefined,
			sessionToken: Bun.env.DOCUMENT_S3_SESSION_TOKEN || undefined,
		});
	}

	async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
		await this.client.write(safeKey(key), data, { type: contentType, acl: "private" });
	}

	async get(key: string): Promise<Uint8Array> {
		const file = this.client.file(safeKey(key));
		if (!(await file.exists())) throw new Error("Stored document is missing");
		return new Uint8Array(await file.arrayBuffer());
	}

	async exists(key: string): Promise<boolean> {
		return await this.client.exists(safeKey(key));
	}

	async remove(key: string): Promise<void> {
		await this.client.delete(safeKey(key));
	}

	async *keys(): AsyncIterable<string> {
		let continuationToken: string | undefined;
		do {
			const page = await this.client.list({ continuationToken });
			for (const entry of page.contents ?? []) yield entry.key;
			continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
		} while (continuationToken);
	}
}

export class EncryptedDocumentStorage implements DocumentStorage {
	constructor(readonly inner: DocumentStorage) {}

	async put(key: string, data: Uint8Array, _contentType: string): Promise<void> {
		await this.inner.put(key, seal(data, documentContext(safeKey(key))), "application/octet-stream");
	}

	async get(key: string): Promise<Uint8Array> {
		return unseal(await this.inner.get(key), documentContext(safeKey(key)));
	}

	async exists(key: string): Promise<boolean> {
		return await this.inner.exists(key);
	}

	async remove(key: string): Promise<void> {
		await this.inner.remove(key);
	}
}

export interface ListableDocumentStorage extends DocumentStorage {
	keys(): AsyncIterable<string>;
}

export async function encryptStoredDocuments(storage: ListableDocumentStorage): Promise<{ encrypted: number; skipped: number }> {
	let encrypted = 0;
	let skipped = 0;
	for await (const key of storage.keys()) {
		const data = await storage.get(key);
		if (isSealed(data)) {
			skipped++;
			continue;
		}
		await storage.put(key, seal(data, documentContext(safeKey(key))), "application/octet-stream");
		encrypted++;
	}
	return { encrypted, skipped };
}

let configured: DocumentStorage | null = null;

export function documentStorage(): DocumentStorage {
	if (configured) return configured;
	const adapter = Bun.env.DOCUMENT_STORAGE || "local";
	if (adapter !== "local" && adapter !== "s3") throw new Error("DOCUMENT_STORAGE must be local or s3");
	configured = adapter === "s3" ? new EncryptedDocumentStorage(new S3DocumentStorage()) : new LocalDocumentStorage();
	return configured;
}

export function setDocumentStorage(storage: DocumentStorage | null) {
	configured = storage;
}
