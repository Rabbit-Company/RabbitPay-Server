const RECORD_SIZE = 4096;
const PUBLIC_KEY_BYTES = 65;
const AUTH_BYTES = 16;
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60;
const encoder = new TextEncoder();

export interface VapidKeys {
	publicKey: string;
	privateKey: string;
}

export interface PushTarget {
	endpoint: string;
	p256dh: string;
	auth: string;
}

export function toBase64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
	return new Uint8Array(Buffer.from(value, "base64url"));
}

export function isPushKey(value: unknown, bytes: number): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) && fromBase64Url(value).length === bytes;
}

export function isPushTarget(p256dh: unknown, auth: unknown): boolean {
	return isPushKey(p256dh, PUBLIC_KEY_BYTES) && isPushKey(auth, AUTH_BYTES);
}

function join(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}
	return joined;
}

async function expand(
	secret: Uint8Array<ArrayBuffer>,
	salt: Uint8Array<ArrayBuffer>,
	info: Uint8Array<ArrayBuffer>,
	bytes: number
): Promise<Uint8Array<ArrayBuffer>> {
	const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

export async function generateVapidKeys(): Promise<VapidKeys> {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	return {
		publicKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
		privateKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
	};
}

export async function vapidHeader(keys: VapidKeys, endpoint: string, subject: string, now = Date.now()): Promise<string> {
	const segment = (value: unknown) => toBase64Url(encoder.encode(JSON.stringify(value)));
	const unsigned = `${segment({ typ: "JWT", alg: "ES256" })}.${segment({
		aud: new URL(endpoint).origin,
		exp: Math.floor(now / 1000) + VAPID_LIFETIME_SECONDS,
		sub: subject,
	})}`;
	const key = await crypto.subtle.importKey("pkcs8", fromBase64Url(keys.privateKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(unsigned)));
	return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${keys.publicKey}`;
}

export async function encryptPush(target: Pick<PushTarget, "p256dh" | "auth">, payload: string): Promise<Uint8Array<ArrayBuffer>> {
	const receiverPublic = fromBase64Url(target.p256dh);
	const receiverKey = await crypto.subtle.importKey("raw", receiverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const sender = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const senderPublic = new Uint8Array(await crypto.subtle.exportKey("raw", sender.publicKey));
	const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: receiverKey }, sender.privateKey, 256));

	const material = await expand(shared, fromBase64Url(target.auth), join(encoder.encode("WebPush: info\0"), receiverPublic, senderPublic), 32);
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const contentKey = await expand(material, salt, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await expand(material, salt, encoder.encode("Content-Encoding: nonce\0"), 12);

	const key = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
	const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, join(encoder.encode(payload), new Uint8Array([2]))));

	const header = new Uint8Array(21);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, RECORD_SIZE);
	header[20] = senderPublic.length;
	return join(header, senderPublic, sealed);
}
