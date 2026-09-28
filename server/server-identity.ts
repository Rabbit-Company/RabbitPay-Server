import Database from "./database/database";
import { normalizeServerId } from "./license-pricing";

export { normalizeServerId };

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let cached: string | null = null;

function generateServerId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(20));
	const characters = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join("");
	return `RPS-${characters.match(/.{5}/g)!.join("-")}`;
}

async function storedServerId(): Promise<string | null> {
	const [row] = (await Database`SELECT id FROM server_identity WHERE slot = 1`) as { id: string }[];
	return row?.id ?? null;
}

export async function serverId(): Promise<string> {
	if (cached) return cached;

	const existing = await storedServerId();
	if (existing) return (cached = existing);

	try {
		await Database`INSERT INTO server_identity(slot, id, created) VALUES(1, ${generateServerId()}, ${Date.now()})`;
	} catch {
		void 0;
	}
	const stored = await storedServerId();
	if (!stored) throw new Error("Could not create the Server ID");
	return (cached = stored);
}

export function forgetServerId() {
	cached = null;
}
