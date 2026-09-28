import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDocumentStorage } from "../server/document-storage";

const root = await mkdtemp(join(tmpdir(), "rabbitpay-documents-"));
const storage = new LocalDocumentStorage(root);

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("local document storage", () => {
	test("writes and reads nested immutable document keys", async () => {
		const key = "invoices/project/invoice/document.pdf";
		const data = new TextEncoder().encode("invoice-pdf");
		expect(await storage.exists(key)).toBe(false);
		await storage.put(key, data, "application/pdf");
		expect(await storage.exists(key)).toBe(true);
		expect(new TextDecoder().decode(await storage.get(key))).toBe("invoice-pdf");
		expect((await readdir(join(root, "invoices/project/invoice"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("refuses paths outside its configured root", async () => {
		await expect(storage.put("../invoice.pdf", new Uint8Array(), "application/pdf")).rejects.toThrow("Invalid document storage key");
	});

	test("removes stored documents", async () => {
		const key = "expenses/project/expense/original.pdf";
		await storage.put(key, new TextEncoder().encode("expense"), "application/pdf");
		expect(await storage.exists(key)).toBe(true);
		await storage.remove(key);
		expect(await storage.exists(key)).toBe(false);
		await storage.remove(key);
	});
});
