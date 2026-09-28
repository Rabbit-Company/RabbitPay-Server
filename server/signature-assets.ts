import type { SQL } from "bun";

import type { Dialect } from "./database/dialect";

export function signatureHash(data: string): string {
	return new Bun.CryptoHasher("sha256").update(Buffer.from(data, "base64")).digest("hex");
}

export function stableSignatureVersionId(seed: string): string {
	const hash = new Bun.CryptoHasher("sha256").update(seed).digest("hex").slice(0, 32);
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
}

export async function ensureSignatureAsset(sql: SQL, dialect: Dialect, data: string, created = Date.now()): Promise<string> {
	const hash = signatureHash(data);
	if (dialect === "mysql") {
		await sql`
			INSERT INTO signature_assets(signature_hash, data, created) VALUES(${hash}, ${data}, ${created})
			ON DUPLICATE KEY UPDATE created = LEAST(signature_assets.created, VALUES(created))
		`;
	} else {
		await sql`
			INSERT INTO signature_assets(signature_hash, data, created) VALUES(${hash}, ${data}, ${created})
			ON CONFLICT(signature_hash) DO UPDATE SET created = CASE
				WHEN excluded.created < signature_assets.created THEN excluded.created ELSE signature_assets.created
			END
		`;
	}
	return hash;
}
