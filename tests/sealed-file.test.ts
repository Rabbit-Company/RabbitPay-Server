import "./environment";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUP_CONTEXT, SEAL_OVERHEAD, documentContext, isSealed, seal, sealFile, unseal, unsealFile } from "../server/crypto/sealed-file";
import { EncryptedDocumentStorage, LocalDocumentStorage, encryptStoredDocuments, type ListableDocumentStorage } from "../server/document-storage";
import { backupTime } from "../server/backups";

const root = await mkdtemp(join(tmpdir(), "rabbitpay-sealed-"));
const invoice = new TextEncoder().encode("%PDF-1.7 Invoice total: 100 EUR");

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

class ListableLocalStorage extends LocalDocumentStorage implements ListableDocumentStorage {
	async *keys(): AsyncIterable<string> {
		for (const entry of await readdir(this.root, { recursive: true, withFileTypes: true })) {
			if (entry.isFile()) yield join(entry.parentPath, entry.name).slice(this.root.length + 1);
		}
	}
}

describe("sealed bytes", () => {
	test("round trip adds a fixed overhead and hides the content", () => {
		const sealed = seal(invoice, documentContext("invoices/a.pdf"));
		expect(sealed.length).toBe(invoice.length + SEAL_OVERHEAD);
		expect(SEAL_OVERHEAD).toBe(32);
		expect(isSealed(sealed)).toBe(true);
		expect(Buffer.from(sealed).includes("Invoice")).toBe(false);
		expect(new TextDecoder().decode(unseal(sealed, documentContext("invoices/a.pdf")))).toBe("%PDF-1.7 Invoice total: 100 EUR");
	});

	test("the same content never encrypts to the same bytes", () => {
		expect(Buffer.from(seal(invoice, "x")).equals(Buffer.from(seal(invoice, "x")))).toBe(false);
	});

	test("a single flipped bit is rejected", () => {
		const sealed = Buffer.from(seal(invoice, "x"));
		sealed[20] ^= 0x01;
		expect(() => unseal(sealed, "x")).toThrow("modified");
	});

	test("a file moved to another key is rejected", () => {
		const sealed = seal(invoice, documentContext("invoices/a.pdf"));
		expect(() => unseal(sealed, documentContext("invoices/b.pdf"))).toThrow("modified");
	});

	test("plain files are refused", () => {
		expect(isSealed(invoice)).toBe(false);
		expect(() => unseal(invoice, "x")).toThrow("not encrypted");
	});

	test("empty content still round trips", () => {
		expect(unseal(seal(new Uint8Array(), "x"), "x").length).toBe(0);
	});
});

describe("sealed files", () => {
	test("streams a large file through and back", async () => {
		const source = join(root, "backup.sqlite.gz");
		const sealed = join(root, "backup.sqlite.gz.enc");
		const restored = join(root, "restored.sqlite.gz");
		const data = crypto.getRandomValues(new Uint8Array(3 * 1024 * 1024 + 7));
		await writeFile(source, data);
		await sealFile(source, sealed, BACKUP_CONTEXT);
		expect((await readFile(sealed)).length).toBe(data.length + SEAL_OVERHEAD);
		await unsealFile(sealed, restored, BACKUP_CONTEXT);
		expect(Buffer.from(await readFile(restored)).equals(Buffer.from(data))).toBe(true);
	});

	test("a tampered backup leaves no partial output behind", async () => {
		const source = join(root, "small.gz");
		const sealed = join(root, "small.gz.enc");
		const restored = join(root, "small-restored.gz");
		await writeFile(source, invoice);
		await sealFile(source, sealed, BACKUP_CONTEXT);
		const bytes = await readFile(sealed);
		bytes[bytes.length - 20] ^= 0x01;
		await writeFile(sealed, bytes);
		await expect(unsealFile(sealed, restored, BACKUP_CONTEXT)).rejects.toThrow("modified");
		expect(existsSync(restored)).toBe(false);
	});

	test("encrypted backup names still count as backups", () => {
		expect(backupTime("rabbitpay-20260923T184254Z.sqlite.gz.enc")).toBe(Date.UTC(2026, 8, 23, 18, 42, 54));
		expect(backupTime("rabbitpay-20260923T184254Z.sqlite.gz.enc.tmp")).toBeNull();
	});
});

describe("encrypted document storage", () => {
	test("stores ciphertext and returns the original bytes", async () => {
		const inner = new LocalDocumentStorage(join(root, "documents"));
		const storage = new EncryptedDocumentStorage(inner);
		await storage.put("invoices/p/i/document.pdf", invoice, "application/pdf");
		const stored = await inner.get("invoices/p/i/document.pdf");
		expect(isSealed(stored)).toBe(true);
		expect(Buffer.from(await storage.get("invoices/p/i/document.pdf")).equals(Buffer.from(invoice))).toBe(true);
		expect(await storage.exists("invoices/p/i/document.pdf")).toBe(true);
		await storage.remove("invoices/p/i/document.pdf");
		expect(await storage.exists("invoices/p/i/document.pdf")).toBe(false);
	});

	test("swapping two stored documents is detected", async () => {
		const inner = new LocalDocumentStorage(join(root, "swap"));
		const storage = new EncryptedDocumentStorage(inner);
		await storage.put("invoices/one.pdf", invoice, "application/pdf");
		await storage.put("invoices/two.pdf", new TextEncoder().encode("other"), "application/pdf");
		await inner.put("invoices/two.pdf", await inner.get("invoices/one.pdf"), "application/octet-stream");
		await expect(storage.get("invoices/two.pdf")).rejects.toThrow("modified");
	});

	test("existing plain documents are encrypted once and stay readable", async () => {
		const inner = new ListableLocalStorage(join(root, "legacy"));
		await inner.put("invoices/old.pdf", invoice, "application/pdf");
		await new EncryptedDocumentStorage(inner).put("invoices/new.pdf", invoice, "application/pdf");

		const storage = new EncryptedDocumentStorage(inner);
		await expect(storage.get("invoices/old.pdf")).rejects.toThrow("not encrypted");
		expect(await encryptStoredDocuments(inner)).toEqual({ encrypted: 1, skipped: 1 });
		expect(await encryptStoredDocuments(inner)).toEqual({ encrypted: 0, skipped: 2 });
		expect(Buffer.from(await storage.get("invoices/old.pdf")).equals(Buffer.from(invoice))).toBe(true);
	});
});
