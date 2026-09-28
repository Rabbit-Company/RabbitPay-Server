export const MAX_SIGNATURE_BYTES = 100 * 1024;

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export async function readSignature(base64: unknown): Promise<string | null> {
	if (typeof base64 !== "string" || base64.length === 0 || base64.length > Math.ceil(MAX_SIGNATURE_BYTES / 3) * 4 + 4) return null;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;

	const bytes = Buffer.from(base64, "base64");
	if (bytes.length < 24 || bytes.length > MAX_SIGNATURE_BYTES || !PNG_HEADER.every((byte, index) => bytes[index] === byte)) return null;

	try {
		const metadata = await new Bun.Image(bytes).metadata();
		if (!metadata.width || !metadata.height || metadata.width > 1600 || metadata.height > 600) return null;
	} catch {
		return null;
	}

	return bytes.toString("base64");
}
