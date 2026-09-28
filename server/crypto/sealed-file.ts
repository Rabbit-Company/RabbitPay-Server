import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import Vault from "./vault";

const MAGIC = Buffer.from([0x52, 0x50, 0x46, 0x01]);
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + IV_LENGTH;

export const SEAL_OVERHEAD = HEADER_LENGTH + TAG_LENGTH;
export const BACKUP_CONTEXT = "backup";

export function documentContext(key: string): string {
	return `document:${key}`;
}

export function isSealed(data: Uint8Array): boolean {
	return data.length >= SEAL_OVERHEAD && Buffer.from(data.subarray(0, MAGIC.length)).equals(MAGIC);
}

function cipher(context: string) {
	const iv = randomBytes(IV_LENGTH);
	const encryptor = createCipheriv("aes-256-gcm", Vault.fileKey(), iv);
	encryptor.setAAD(Buffer.from(context, "utf8"));
	return { header: Buffer.concat([MAGIC, iv]), encryptor };
}

function decipher(header: Uint8Array, tag: Uint8Array, context: string) {
	if (!Buffer.from(header.subarray(0, MAGIC.length)).equals(MAGIC)) throw new Error("The file is not encrypted by RabbitPay");
	const decryptor = createDecipheriv("aes-256-gcm", Vault.fileKey(), header.subarray(MAGIC.length, HEADER_LENGTH));
	decryptor.setAAD(Buffer.from(context, "utf8"));
	decryptor.setAuthTag(tag);
	return decryptor;
}

function authenticationFailure(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes("authenticate")) return new Error("The encrypted file was modified or belongs to a different key");
	return error instanceof Error ? error : new Error(message);
}

export function seal(data: Uint8Array, context: string): Uint8Array {
	const { header, encryptor } = cipher(context);
	return Buffer.concat([header, encryptor.update(data), encryptor.final(), encryptor.getAuthTag()]);
}

export function unseal(data: Uint8Array, context: string): Uint8Array {
	if (!isSealed(data)) throw new Error("The file is not encrypted by RabbitPay");
	const decryptor = decipher(data.subarray(0, HEADER_LENGTH), data.subarray(data.length - TAG_LENGTH), context);
	try {
		return Buffer.concat([decryptor.update(data.subarray(HEADER_LENGTH, data.length - TAG_LENGTH)), decryptor.final()]);
	} catch (error) {
		throw authenticationFailure(error);
	}
}

export async function sealFile(source: string, target: string, context: string): Promise<void> {
	const { header, encryptor } = cipher(context);
	try {
		await pipeline(
			createReadStream(source),
			async function* (chunks: AsyncIterable<Buffer>) {
				yield header;
				for await (const chunk of chunks) yield encryptor.update(chunk);
				yield encryptor.final();
				yield encryptor.getAuthTag();
			},
			createWriteStream(target)
		);
	} catch (error) {
		await unlink(target).catch(() => undefined);
		throw error;
	}
}

export async function unsealFile(source: string, target: string, context: string): Promise<void> {
	const size = (await stat(source)).size;
	if (size < SEAL_OVERHEAD) throw new Error("The file is not encrypted by RabbitPay");

	const header = Buffer.alloc(HEADER_LENGTH);
	const tag = Buffer.alloc(TAG_LENGTH);
	const handle = await open(source, "r");
	try {
		await handle.read(header, 0, HEADER_LENGTH, 0);
		await handle.read(tag, 0, TAG_LENGTH, size - TAG_LENGTH);
	} finally {
		await handle.close();
	}

	const decryptor = decipher(header, tag, context);
	const body = size > SEAL_OVERHEAD ? createReadStream(source, { start: HEADER_LENGTH, end: size - TAG_LENGTH - 1 }) : [];
	try {
		await pipeline(
			body,
			async function* (chunks: AsyncIterable<Buffer>) {
				for await (const chunk of chunks) yield decryptor.update(chunk);
				yield decryptor.final();
			},
			createWriteStream(target)
		);
	} catch (error) {
		await unlink(target).catch(() => undefined);
		throw authenticationFailure(error);
	}
}
