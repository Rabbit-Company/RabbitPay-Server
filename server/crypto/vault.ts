import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from "node:crypto";
import { Logger } from "../logger";

export default class Vault {
	private static readonly FORMAT = "v1";
	private static readonly SALT = Buffer.from("rabbitpay.seed.v1");
	private static key: Buffer | null = null;
	private static storageKey: Buffer | null = null;

	static isConfigured(): boolean {
		const configured = Bun.env.RABBITPAY_MASTER_KEY;
		return typeof configured === "string" && configured.length >= 32;
	}

	private static derivedKey(): Buffer {
		if (Vault.key) return Vault.key;
		if (!Vault.isConfigured()) throw new Error("master_key is not configured");

		Vault.key = scryptSync(Bun.env.RABBITPAY_MASTER_KEY!, Vault.SALT, 32);
		return Vault.key;
	}

	static encrypt(plaintext: string): string {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", Vault.derivedKey(), iv);
		const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
		const tag = cipher.getAuthTag();
		return `${Vault.FORMAT}.${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
	}

	static decrypt(payload: string): string {
		const parts = payload.split(".");
		if (parts.length !== 4 || parts[0] !== Vault.FORMAT) throw new Error("Unrecognized ciphertext format");

		const [, iv, tag, ciphertext] = parts;
		const decipher = createDecipheriv("aes-256-gcm", Vault.derivedKey(), Buffer.from(iv, "base64"));
		decipher.setAuthTag(Buffer.from(tag, "base64"));
		return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
	}

	static fileKey(): Buffer {
		if (Vault.storageKey) return Vault.storageKey;
		Vault.storageKey = Buffer.from(hkdfSync("sha256", Vault.derivedKey(), Buffer.alloc(0), "rabbitpay.files.v1", 32));
		return Vault.storageKey;
	}

	static requireConfigured() {
		if (Vault.isConfigured()) return;
		Logger.error("[VAULT] RABBITPAY_MASTER_KEY is missing or shorter than 32 characters, so RabbitPay will not start.");
		Logger.error("[VAULT] Generate one with: openssl rand -base64 48, and add it to the .env file next to the server.");
		process.exit(1);
	}
}
