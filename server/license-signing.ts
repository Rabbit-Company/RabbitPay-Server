import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { Logger } from "./logger";
import type { LicenseType } from "./database/models";

export const ISSUER_PUBLIC_KEY = "MCowBQYDK2VwAyEATQexSJApVWsQU+EimKUyHecWPi1H9HJzRifWmVVfVio=";

export const SIGNED_LICENSE_PREFIX = "RPAY2";
const SIGNED_LICENSE = /^RPAY2\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const SIGNED_TYPES: LicenseType[] = ["transactions", "white_label", "storage", "store", "workforce", "employees", "accounting"];

export interface SignedLicense {
	v: 1;
	id: string;
	server: string;
	type: LicenseType;
	transactions: number | null;
	duration_days: number | null;
	storage_gb: number | null;
	employees: number | null;
	issued: number;
}

let cachedSigning: { raw: string; key: KeyObject | null } | null = null;
let cachedPublic: { raw: string; key: KeyObject | null } | null = null;
let publicKeyOverride: string | null = null;

function base64url(bytes: Uint8Array | string): string {
	return Buffer.from(bytes).toString("base64url");
}

function signingKey(): KeyObject | null {
	const raw = Bun.env.RABBITPAY_LICENSE_SIGNING_KEY?.trim() ?? "";
	if (cachedSigning?.raw === raw) return cachedSigning.key;

	let key: KeyObject | null = null;
	if (raw) {
		try {
			key = createPrivateKey({ key: Buffer.from(raw, "base64"), format: "der", type: "pkcs8" });
			if (key.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
		} catch (error) {
			Logger.error(`[LICENSE] RABBITPAY_LICENSE_SIGNING_KEY is not a valid Ed25519 private key: ${error}`);
			key = null;
		}
	}
	cachedSigning = { raw, key };
	return key;
}

function verifyingKey(): KeyObject | null {
	const raw = publicKeyOverride ?? ISSUER_PUBLIC_KEY;
	if (!raw) return null;
	if (cachedPublic?.raw === raw) return cachedPublic.key;

	let key: KeyObject | null = null;
	try {
		key = createPublicKey({ key: Buffer.from(raw, "base64"), format: "der", type: "spki" });
	} catch (error) {
		Logger.error(`[LICENSE] The built-in license public key is invalid: ${error}`);
	}
	cachedPublic = { raw, key };
	return key;
}

export function useIssuerPublicKey(value: string | null) {
	publicKeyOverride = value;
}

function spki(key: KeyObject): string {
	return key.export({ format: "der", type: "spki" }).toString("base64");
}

export function isLicenseIssuer(): boolean {
	const signing = signingKey();
	const verifying = verifyingKey();
	return signing !== null && verifying !== null && spki(createPublicKey(signing)) === spki(verifying);
}

export function signLicense(license: SignedLicense): string {
	const key = signingKey();
	if (!key || !isLicenseIssuer()) throw new Error("This server is not the license issuer");
	const body = base64url(JSON.stringify(license));
	const signature = sign(null, Buffer.from(`${SIGNED_LICENSE_PREFIX}.${body}`), key);
	return `${SIGNED_LICENSE_PREFIX}.${body}.${base64url(signature)}`;
}

function positiveOrNull(value: unknown): value is number | null {
	return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

export function looksSigned(value: string): boolean {
	return value.startsWith(`${SIGNED_LICENSE_PREFIX}.`);
}

export function readSignedLicense(value: string): SignedLicense | null {
	const match = value.trim().match(SIGNED_LICENSE);
	const key = verifyingKey();
	if (!match || !key) return null;

	try {
		if (!verify(null, Buffer.from(`${SIGNED_LICENSE_PREFIX}.${match[1]}`), key, Buffer.from(match[2], "base64url"))) return null;
		const license = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as Partial<SignedLicense>;
		if (license.v !== 1 || typeof license.id !== "string" || !/^[0-9a-f-]{36}$/.test(license.id)) return null;
		if (typeof license.server !== "string" || !SIGNED_TYPES.includes(license.type as LicenseType)) return null;
		const employees = license.employees ?? null;
		if (!positiveOrNull(license.transactions) || !positiveOrNull(license.duration_days) || !positiveOrNull(license.storage_gb)) return null;
		if (!positiveOrNull(employees)) return null;
		if (typeof license.issued !== "number") return null;
		return { ...license, employees } as SignedLicense;
	} catch {
		return null;
	}
}

export function generateIssuerKeys(): { privateKey: string; publicKey: string } {
	const pair = generateKeyPairSync("ed25519");
	return {
		privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
		publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
	};
}

export function issuerKeyMismatch(): boolean {
	return signingKey() !== null && !isLicenseIssuer();
}
