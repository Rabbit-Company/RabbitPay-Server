import { createHash, createPublicKey, verify, type KeyObject, type webcrypto } from "node:crypto";
import Cache from "./cache";
import Utils from "./utils";

export const WEBAUTHN_TIMEOUT = 5 * 60;

const ES256 = -7;
const EDDSA = -8;
const RS256 = -257;
const SUPPORTED_ALGORITHMS = [ES256, EDDSA, RS256];
const FLAG_USER_PRESENT = 0x01;
const FLAG_ATTESTED_DATA = 0x40;
const MAX_CBOR_DEPTH = 16;
const TRANSPORTS = new Set(["usb", "nfc", "ble", "internal", "hybrid", "smart-card"]);

export type ChallengePurpose = "register" | "login" | "confirm";

type CborValue = number | string | boolean | null | undefined | Uint8Array | CborValue[] | Map<CborValue, CborValue>;

interface AuthenticatorData {
	rpIdHash: Uint8Array;
	flags: number;
	signCount: number;
	credentialId?: Uint8Array;
	publicKey?: Uint8Array;
}

interface CredentialResponse {
	id?: unknown;
	type?: unknown;
	response?: {
		clientDataJSON?: unknown;
		attestationObject?: unknown;
		authenticatorData?: unknown;
		signature?: unknown;
		userHandle?: unknown;
		transports?: unknown;
	};
}

export interface CredentialDescriptor {
	credential_id: string;
	transports: string | null;
}

export interface StoredCredential extends CredentialDescriptor {
	uuid: string;
	public_key: string;
	sign_count: number | string;
}

export interface VerifiedRegistration {
	credentialId: string;
	publicKey: string;
	algorithm: number;
	signCount: number;
	transports: string[];
}

export interface VerifiedAssertion<T extends StoredCredential> {
	credential: T;
	signCount: number;
}

class WebAuthnError extends Error {}

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function fromBase64url(value: unknown): Uint8Array {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new WebAuthnError("Invalid base64url value");
	return new Uint8Array(Buffer.from(value, "base64url"));
}

function sha256(bytes: Uint8Array | string): Uint8Array {
	return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function decodeCbor(bytes: Uint8Array, start = 0): { value: CborValue; end: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = start;

	const need = (count: number) => {
		if (count > bytes.length - offset) throw new WebAuthnError("Truncated CBOR");
	};

	const argument = (info: number): number => {
		if (info < 24) return info;
		if (info === 24) {
			need(1);
			return bytes[offset++];
		}
		if (info === 25) {
			need(2);
			offset += 2;
			return view.getUint16(offset - 2);
		}
		if (info === 26) {
			need(4);
			offset += 4;
			return view.getUint32(offset - 4);
		}
		if (info === 27) {
			need(8);
			offset += 8;
			const value = view.getBigUint64(offset - 8);
			if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new WebAuthnError("CBOR integer too large");
			return Number(value);
		}
		throw new WebAuthnError("Unsupported CBOR length");
	};

	const item = (depth: number): CborValue => {
		if (depth > MAX_CBOR_DEPTH) throw new WebAuthnError("CBOR nested too deeply");
		need(1);
		const initial = bytes[offset++];
		const major = initial >> 5;
		const info = initial & 31;

		switch (major) {
			case 0:
				return argument(info);
			case 1:
				return -1 - argument(info);
			case 2:
			case 3: {
				const size = argument(info);
				need(size);
				const value = bytes.slice(offset, offset + size);
				offset += size;
				return major === 2 ? value : new TextDecoder("utf-8", { fatal: true }).decode(value);
			}
			case 4: {
				const size = argument(info);
				need(size);
				return Array.from({ length: size }, () => item(depth + 1));
			}
			case 5: {
				const size = argument(info);
				need(size * 2);
				const map = new Map<CborValue, CborValue>();
				for (let index = 0; index < size; index++) {
					const key = item(depth + 1);
					map.set(key, item(depth + 1));
				}
				return map;
			}
			case 7:
				if (info === 20) return false;
				if (info === 21) return true;
				if (info === 22) return null;
				if (info === 23) return undefined;
				throw new WebAuthnError("Unsupported CBOR simple value");
			default:
				throw new WebAuthnError("Unsupported CBOR type");
		}
	};

	const value = item(0);
	return { value, end: offset };
}

function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
	if (bytes.length < 37) throw new WebAuthnError("Authenticator data too short");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const parsed: AuthenticatorData = { rpIdHash: bytes.slice(0, 32), flags: bytes[32], signCount: view.getUint32(33) };
	if ((parsed.flags & FLAG_ATTESTED_DATA) === 0) return parsed;

	if (bytes.length < 55) throw new WebAuthnError("Attested credential data too short");
	const idEnd = 55 + view.getUint16(53);
	if (idEnd > bytes.length) throw new WebAuthnError("Credential ID truncated");
	const { end } = decodeCbor(bytes, idEnd);
	return { ...parsed, credentialId: bytes.slice(55, idEnd), publicKey: bytes.slice(idEnd, end) };
}

function publicKeyOf(cose: Uint8Array): { key: KeyObject; algorithm: number } {
	const map = decodeCbor(cose).value;
	if (!(map instanceof Map)) throw new WebAuthnError("Public key is not a COSE map");

	const component = (label: number): string => {
		const value = map.get(label);
		if (!(value instanceof Uint8Array)) throw new WebAuthnError("Public key component missing");
		return base64url(value);
	};

	const keyType = map.get(1);
	const algorithm = map.get(3);
	let jwk: webcrypto.JsonWebKey;
	if (algorithm === ES256 && keyType === 2 && map.get(-1) === 1) jwk = { kty: "EC", crv: "P-256", x: component(-2), y: component(-3) };
	else if (algorithm === EDDSA && keyType === 1 && map.get(-1) === 6) jwk = { kty: "OKP", crv: "Ed25519", x: component(-2) };
	else if (algorithm === RS256 && keyType === 3) jwk = { kty: "RSA", n: component(-1), e: component(-2) };
	else throw new WebAuthnError("Unsupported public key algorithm");

	try {
		return { key: createPublicKey({ key: jwk, format: "jwk" }), algorithm };
	} catch {
		throw new WebAuthnError("Invalid public key");
	}
}

function validSignature(cose: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean {
	const { key, algorithm } = publicKeyOf(cose);
	try {
		return verify(algorithm === EDDSA ? null : "sha256", data, key, signature);
	} catch {
		return false;
	}
}

function relyingParty(): { id: string; origin: string; name: string } {
	const url = new URL(Utils.publicUrl());
	return { id: url.hostname, origin: url.origin, name: "RabbitPay" };
}

function userHandle(username: string): string {
	return base64url(sha256(`rabbitpay-account:${username}`));
}

function challengeKey(challenge: string): string {
	return `webauthn_challenge_${challenge}`;
}

async function issueChallenge(purpose: ChallengePurpose, username: string): Promise<string | null> {
	const challenge = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const stored = await Cache.setString(challengeKey(challenge), JSON.stringify({ purpose, username }), WEBAUTHN_TIMEOUT, WEBAUTHN_TIMEOUT);
	return stored ? challenge : null;
}

async function consumeChallenge(challenge: unknown, purpose: ChallengePurpose, username: string): Promise<boolean> {
	if (typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return false;
	const stored = await Cache.getString(challengeKey(challenge));
	if (stored === null) return false;
	await Cache.deleteString(challengeKey(challenge));
	const claim = JSON.parse(stored) as { purpose?: unknown; username?: unknown };
	return claim.purpose === purpose && claim.username === username;
}

function descriptor(credential: CredentialDescriptor) {
	const transports = credential.transports ? credential.transports.split(",") : [];
	return { type: "public-key", id: credential.credential_id, ...(transports.length ? { transports } : {}) };
}

function credentialResponse(value: unknown): CredentialResponse {
	if (value === null || typeof value !== "object") throw new WebAuthnError("Credential missing");
	const credential = value as CredentialResponse;
	if (credential.type !== "public-key" || credential.response === null || typeof credential.response !== "object") {
		throw new WebAuthnError("Unexpected credential type");
	}
	return credential;
}

async function verifyClientData(encoded: unknown, type: string, purpose: ChallengePurpose, username: string): Promise<Uint8Array> {
	const bytes = fromBase64url(encoded);
	const clientData = JSON.parse(new TextDecoder().decode(bytes)) as { type?: unknown; challenge?: unknown; origin?: unknown };
	if (!(await consumeChallenge(clientData.challenge, purpose, username))) throw new WebAuthnError("Unknown or expired challenge");
	if (clientData.type !== type) throw new WebAuthnError("Unexpected client data type");
	if (clientData.origin !== relyingParty().origin) throw new WebAuthnError("Unexpected origin");
	return bytes;
}

function verifyAuthenticatorData(data: AuthenticatorData) {
	if (!sameBytes(data.rpIdHash, sha256(relyingParty().id))) throw new WebAuthnError("Relying party mismatch");
	if ((data.flags & FLAG_USER_PRESENT) === 0) throw new WebAuthnError("User was not present");
}

export default class WebAuthn {
	static async registrationOptions(account: { username: string; email: string }, existing: CredentialDescriptor[]) {
		const challenge = await issueChallenge("register", account.username);
		if (challenge === null) return null;
		const rp = relyingParty();
		return {
			challenge,
			rp: { id: rp.id, name: rp.name },
			user: { id: userHandle(account.username), name: account.email, displayName: account.email },
			pubKeyCredParams: SUPPORTED_ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
			timeout: WEBAUTHN_TIMEOUT * 1000,
			attestation: "none",
			authenticatorSelection: { residentKey: "discouraged", userVerification: "discouraged" },
			excludeCredentials: existing.map(descriptor),
		};
	}

	static async assertionOptions(purpose: "login" | "confirm", username: string, credentials: CredentialDescriptor[]) {
		const challenge = await issueChallenge(purpose, username);
		if (challenge === null) return null;
		return {
			challenge,
			rpId: relyingParty().id,
			timeout: WEBAUTHN_TIMEOUT * 1000,
			userVerification: "discouraged",
			allowCredentials: credentials.map(descriptor),
		};
	}

	static async verifyRegistration(value: unknown, username: string): Promise<VerifiedRegistration | null> {
		try {
			const credential = credentialResponse(value);
			await verifyClientData(credential.response!.clientDataJSON, "webauthn.create", "register", username);

			const attestation = decodeCbor(fromBase64url(credential.response!.attestationObject)).value;
			const authData = attestation instanceof Map ? attestation.get("authData") : undefined;
			if (!(authData instanceof Uint8Array)) throw new WebAuthnError("Attestation object has no authenticator data");

			const data = parseAuthenticatorData(authData);
			verifyAuthenticatorData(data);
			if (!data.credentialId || !data.publicKey) throw new WebAuthnError("No credential was created");

			const transports = Array.isArray(credential.response!.transports) ? credential.response!.transports : [];
			return {
				credentialId: base64url(data.credentialId),
				publicKey: base64url(data.publicKey),
				algorithm: publicKeyOf(data.publicKey).algorithm,
				signCount: data.signCount,
				transports: transports.filter((transport): transport is string => typeof transport === "string" && TRANSPORTS.has(transport)),
			};
		} catch {
			return null;
		}
	}

	static async verifyAssertion<T extends StoredCredential>(
		value: unknown,
		purpose: "login" | "confirm",
		username: string,
		credentials: T[]
	): Promise<VerifiedAssertion<T> | null> {
		try {
			const credential = credentialResponse(value);
			const stored = credentials.find((candidate) => candidate.credential_id === credential.id);
			if (!stored) return null;

			const clientData = await verifyClientData(credential.response!.clientDataJSON, "webauthn.get", purpose, username);
			const authData = fromBase64url(credential.response!.authenticatorData);
			const data = parseAuthenticatorData(authData);
			verifyAuthenticatorData(data);

			const handle = credential.response!.userHandle;
			if (typeof handle === "string" && handle !== "" && handle !== userHandle(username)) return null;

			const signed = new Uint8Array([...authData, ...sha256(clientData)]);
			if (!validSignature(fromBase64url(stored.public_key), signed, fromBase64url(credential.response!.signature))) return null;

			const previous = Number(stored.sign_count);
			if ((data.signCount !== 0 || previous !== 0) && data.signCount <= previous) return null;

			return { credential: stored, signCount: data.signCount };
		} catch {
			return null;
		}
	}
}
