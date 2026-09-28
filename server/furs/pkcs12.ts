import { createDecipheriv, createHash, createHmac, createPrivateKey, pbkdf2Sync, timingSafeEqual, X509Certificate, type KeyObject } from "node:crypto";
import { child, DerError, explicit, integer, octets, oid, parseDer, TAG, type DerNode } from "./der";
import { rc2CbcDecrypt } from "./rc2";

const OID = {
	data: "1.2.840.113549.1.7.1",
	encryptedData: "1.2.840.113549.1.7.6",
	keyBag: "1.2.840.113549.1.12.10.1.1",
	shroudedKeyBag: "1.2.840.113549.1.12.10.1.2",
	certBag: "1.2.840.113549.1.12.10.1.3",
	x509Certificate: "1.2.840.113549.1.9.22.1",
	localKeyId: "1.2.840.113549.1.9.21",
	pbes2: "1.2.840.113549.1.5.13",
	pbkdf2: "1.2.840.113549.1.5.12",
	sha1: "1.3.14.3.2.26",
	sha256: "2.16.840.1.101.3.4.2.1",
	sha384: "2.16.840.1.101.3.4.2.2",
	sha512: "2.16.840.1.101.3.4.2.3",
} as const;

const PKCS12_PBE: Record<string, { cipher: string; keyLength: number; ivLength: number }> = {
	"1.2.840.113549.1.12.1.3": { cipher: "des-ede3-cbc", keyLength: 24, ivLength: 8 },
	"1.2.840.113549.1.12.1.4": { cipher: "des-ede-cbc", keyLength: 16, ivLength: 8 },
	"1.2.840.113549.1.12.1.5": { cipher: "rc2-cbc", keyLength: 16, ivLength: 8 },
	"1.2.840.113549.1.12.1.6": { cipher: "rc2-cbc", keyLength: 5, ivLength: 8 },
};

const PBES2_CIPHERS: Record<string, { cipher: string; keyLength: number }> = {
	"2.16.840.1.101.3.4.1.2": { cipher: "aes-128-cbc", keyLength: 16 },
	"2.16.840.1.101.3.4.1.22": { cipher: "aes-192-cbc", keyLength: 24 },
	"2.16.840.1.101.3.4.1.42": { cipher: "aes-256-cbc", keyLength: 32 },
	"1.2.840.113549.3.7": { cipher: "des-ede3-cbc", keyLength: 24 },
};

const HMAC_PRF: Record<string, string> = {
	"1.2.840.113549.2.7": "sha1",
	"1.2.840.113549.2.9": "sha256",
	"1.2.840.113549.2.10": "sha384",
	"1.2.840.113549.2.11": "sha512",
};

const DIGESTS: Record<string, { name: string; size: number; block: number }> = {
	[OID.sha1]: { name: "sha1", size: 20, block: 64 },
	[OID.sha256]: { name: "sha256", size: 32, block: 64 },
	[OID.sha384]: { name: "sha384", size: 48, block: 128 },
	[OID.sha512]: { name: "sha512", size: 64, block: 128 },
};

export class Pkcs12Error extends Error {
	constructor(
		readonly reason: "malformed" | "password" | "unsupported" | "missing",
		message: string
	) {
		super(message);
	}
}

export interface Pkcs12Contents {
	privateKey: KeyObject;
	certificate: X509Certificate;
	chain: X509Certificate[];
}

function bmpPassword(password: string): Uint8Array {
	const bytes = new Uint8Array((password.length + 1) * 2);
	for (let index = 0; index < password.length; index++) {
		const code = password.charCodeAt(index);
		bytes[index * 2] = code >> 8;
		bytes[index * 2 + 1] = code & 0xff;
	}
	return bytes;
}

function repeatTo(source: Uint8Array, block: number): Uint8Array {
	if (source.length === 0) return new Uint8Array(0);
	const length = block * Math.ceil(source.length / block);
	const result = new Uint8Array(length);
	for (let index = 0; index < length; index++) result[index] = source[index % source.length]!;
	return result;
}

export function pkcs12Kdf(
	digest: { name: string; size: number; block: number },
	password: Uint8Array,
	salt: Uint8Array,
	id: number,
	iterations: number,
	size: number
): Uint8Array {
	const v = digest.block;
	const diversifier = new Uint8Array(v).fill(id);
	const input = new Uint8Array([...repeatTo(salt, v), ...repeatTo(password, v)]);
	const output = new Uint8Array(size);
	let written = 0;

	while (written < size) {
		let block = createHash(digest.name).update(diversifier).update(input).digest();
		for (let round = 1; round < iterations; round++) block = createHash(digest.name).update(block).digest();
		output.set(block.subarray(0, Math.min(block.length, size - written)), written);
		written += block.length;
		if (written >= size) break;

		const b = repeatTo(block, v);
		for (let offset = 0; offset < input.length; offset += v) {
			let carry = 1;
			for (let index = v - 1; index >= 0; index--) {
				const sum = input[offset + index]! + b[index]! + carry;
				input[offset + index] = sum & 0xff;
				carry = sum >> 8;
			}
		}
	}
	return output;
}

function decrypt(cipher: string, key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
	try {
		if (cipher === "rc2-cbc") return rc2CbcDecrypt(key, key.length * 8, iv, data);
		const decipher = createDecipheriv(cipher, key, iv);
		return new Uint8Array(Buffer.concat([decipher.update(data), decipher.final()]));
	} catch {
		throw new Pkcs12Error("password", "The certificate password is not correct.");
	}
}

function decryptWith(algorithm: DerNode, data: Uint8Array, password: string): Uint8Array {
	const algorithmId = oid(child(algorithm, 0));
	const parameters = child(algorithm, 1);

	const legacy = PKCS12_PBE[algorithmId];
	if (legacy) {
		const salt = octets(child(parameters, 0));
		const iterations = Number(integer(child(parameters, 1)));
		const secret = bmpPassword(password);
		const sha1 = DIGESTS[OID.sha1]!;
		const key = pkcs12Kdf(sha1, secret, salt, 1, iterations, legacy.keyLength);
		const iv = pkcs12Kdf(sha1, secret, salt, 2, iterations, legacy.ivLength);
		return decrypt(legacy.cipher, key, iv, data);
	}

	if (algorithmId === OID.pbes2) {
		const derivation = child(parameters, 0);
		const scheme = child(parameters, 1);
		if (oid(child(derivation, 0)) !== OID.pbkdf2) throw new Pkcs12Error("unsupported", "This certificate file uses a key derivation RabbitPay cannot read.");
		const kdf = child(derivation, 1);
		const salt = octets(child(kdf, 0));
		const iterations = Number(integer(child(kdf, 1)));
		const prfNode = kdf.children.find((node) => node.tag === TAG.SEQUENCE);
		const prf = prfNode ? HMAC_PRF[oid(child(prfNode, 0))] : "sha1";
		const target = PBES2_CIPHERS[oid(child(scheme, 0))];
		if (!prf || !target) throw new Pkcs12Error("unsupported", "This certificate file uses an encryption RabbitPay cannot read.");
		const iv = octets(child(scheme, 1));
		const key = pbkdf2Sync(Buffer.from(password, "utf8"), salt, iterations, target.keyLength, prf);
		return decrypt(target.cipher, key, iv, data);
	}

	throw new Pkcs12Error("unsupported", "This certificate file uses an encryption RabbitPay cannot read.");
}

function verifyMac(pfx: DerNode, authSafe: Uint8Array, password: string) {
	const macData = pfx.children[2];
	if (!macData) return;
	const digestInfo = child(macData, 0);
	const digest = DIGESTS[oid(child(child(digestInfo, 0), 0))];
	if (!digest) return;
	const expected = octets(child(digestInfo, 1));
	const salt = octets(child(macData, 1));
	const iterations = macData.children[2] ? Number(integer(child(macData, 2))) : 1;
	const key = pkcs12Kdf(digest, bmpPassword(password), salt, 3, iterations, digest.size);
	const actual = createHmac(digest.name, key).update(authSafe).digest();
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
		throw new Pkcs12Error("password", "The certificate password is not correct.");
	}
}

interface Bag {
	type: string;
	value: DerNode;
	localKeyId: string | null;
}

function bagsOf(safeContents: Uint8Array): Bag[] {
	return parseDer(safeContents).children.map((bag) => {
		const attributes = bag.children[2];
		const localKey = attributes?.children.find((attribute) => oid(child(attribute, 0)) === OID.localKeyId);
		return {
			type: oid(child(bag, 0)),
			value: explicit(child(bag, 1), 0),
			localKeyId: localKey ? Buffer.from(octets(child(child(localKey, 1), 0))).toString("hex") : null,
		};
	});
}

export function readPkcs12(file: Uint8Array, password: string): Pkcs12Contents {
	let pfx: DerNode;
	try {
		pfx = parseDer(file);
	} catch {
		throw new Pkcs12Error("malformed", "This is not a .p12 certificate file.");
	}

	try {
		const authSafeInfo = child(pfx, 1);
		if (oid(child(authSafeInfo, 0)) !== OID.data) throw new Pkcs12Error("unsupported", "Signed .p12 files are not supported.");
		const authSafe = octets(explicit(child(authSafeInfo, 1), 0));
		verifyMac(pfx, authSafe, password);

		const bags: Bag[] = [];
		for (const contentInfo of parseDer(authSafe).children) {
			const type = oid(child(contentInfo, 0));
			const content = explicit(child(contentInfo, 1), 0);
			if (type === OID.data) bags.push(...bagsOf(octets(content)));
			else if (type === OID.encryptedData) {
				const encryptedContentInfo = child(content, 1);
				const encrypted = child(encryptedContentInfo, 2);
				const data = encrypted.constructed ? octets({ ...encrypted, tag: TAG.OCTET_STRING }) : encrypted.content;
				bags.push(...bagsOf(decryptWith(child(encryptedContentInfo, 1), data, password)));
			}
		}

		const keys = bags
			.filter((bag) => bag.type === OID.shroudedKeyBag || bag.type === OID.keyBag)
			.map((bag) => {
				const pkcs8 = bag.type === OID.keyBag ? bag.value.bytes : decryptWith(child(bag.value, 0), octets(child(bag.value, 1)), password);
				return { key: createPrivateKey({ key: Buffer.from(pkcs8), format: "der", type: "pkcs8" }), localKeyId: bag.localKeyId };
			});
		const certificates = bags
			.filter((bag) => bag.type === OID.certBag && oid(child(bag.value, 0)) === OID.x509Certificate)
			.map((bag) => ({ certificate: new X509Certificate(Buffer.from(octets(explicit(child(bag.value, 1), 0)))), localKeyId: bag.localKeyId }));

		const [first] = keys;
		if (!first || certificates.length === 0) throw new Pkcs12Error("missing", "The .p12 file must contain both the certificate and its private key.");

		const matching =
			certificates.find((entry) => entry.localKeyId !== null && entry.localKeyId === first.localKeyId) ??
			certificates.find((entry) => entry.certificate.checkPrivateKey(first.key));
		if (!matching || !matching.certificate.checkPrivateKey(first.key)) {
			throw new Pkcs12Error("missing", "The .p12 file has no certificate for its private key.");
		}

		return {
			privateKey: first.key,
			certificate: matching.certificate,
			chain: certificates.filter((entry) => entry !== matching).map((entry) => entry.certificate),
		};
	} catch (err) {
		if (err instanceof Pkcs12Error) throw err;
		if (err instanceof DerError) throw new Pkcs12Error("malformed", "This is not a .p12 certificate file.");
		throw err;
	}
}
