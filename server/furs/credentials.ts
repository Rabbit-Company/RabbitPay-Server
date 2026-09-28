import { createPrivateKey, X509Certificate, type KeyObject } from "node:crypto";
import Vault from "../crypto/vault";
import { child, oid, parseDer, text, toHex, type DerNode } from "./der";
import { readPkcs12 } from "./pkcs12";

const KEYWORDS: Record<string, string> = {
	"2.5.4.3": "CN",
	"2.5.4.6": "C",
	"2.5.4.7": "L",
	"2.5.4.8": "ST",
	"2.5.4.9": "STREET",
	"2.5.4.10": "O",
	"2.5.4.11": "OU",
	"0.9.2342.19200300.100.1.25": "DC",
	"0.9.2342.19200300.100.1.1": "UID",
};

export interface FursCredentials {
	privateKey: KeyObject;
	certificate: X509Certificate;
	keyPem: string;
	certPem: string;
	chainPem: string[];
}

export interface CertificateInfo {
	holder: string;
	subjectName: string;
	issuerName: string;
	serial: string;
	taxNumber: number | null;
	validFrom: number;
	validTo: number;
	test: boolean;
}

function escapeValue(value: string): string {
	let escaped = value.replace(/([,+"\\<>;])/g, "\\$1");
	if (escaped.startsWith("#") || escaped.startsWith(" ")) escaped = `\\${escaped}`;
	if (escaped.endsWith(" ") && escaped.length > 1) escaped = `${escaped.slice(0, -1)}\\ `;
	return escaped;
}

function attribute(node: DerNode): { type: string; value: string } {
	const type = oid(child(node, 0));
	const valueNode = child(node, 1);
	const keyword = KEYWORDS[type];
	return keyword ? { type: keyword, value: escapeValue(text(valueNode)) } : { type, value: `#${toHex(valueNode.bytes)}` };
}

function rdns(name: DerNode): { type: string; value: string }[][] {
	return name.children.map((rdn) => rdn.children.map(attribute));
}

export function rfc2253(name: DerNode): string {
	return rdns(name)
		.reverse()
		.map((rdn) => rdn.map((entry) => `${entry.type}=${entry.value}`).join("+"))
		.join(",");
}

function names(certificate: X509Certificate): { issuer: DerNode; subject: DerNode } {
	const tbs = child(parseDer(new Uint8Array(certificate.raw)), 0);
	const offset = tbs.children[0]?.tag === 0xa0 ? 1 : 0;
	return { issuer: child(tbs, offset + 2), subject: child(tbs, offset + 4) };
}

export function certificateInfo(certificate: X509Certificate): CertificateInfo {
	const { issuer, subject } = names(certificate);
	const flat = rdns(subject).flat();
	const holder = flat.find((entry) => entry.type === "CN")?.value.replace(/\\(.)/g, "$1") ?? "";
	const taxNumber = flat.find((entry) => entry.type === "OU" && /^\d{8}$/.test(entry.value))?.value;
	const issuerName = rfc2253(issuer);
	return {
		holder,
		subjectName: rfc2253(subject),
		issuerName,
		serial: BigInt(`0x${certificate.serialNumber}`).toString(),
		taxNumber: taxNumber ? Number(taxNumber) : null,
		validFrom: Date.parse(certificate.validFrom),
		validTo: Date.parse(certificate.validTo),
		test: /test/i.test(issuerName) || flat.some((entry) => entry.type === "OU" && /TEST$/i.test(entry.value)),
	};
}

function toPem(certificate: X509Certificate): string {
	return certificate.toString();
}

export function credentialsFromPkcs12(file: Uint8Array, password: string): FursCredentials {
	const contents = readPkcs12(file, password);
	return {
		privateKey: contents.privateKey,
		certificate: contents.certificate,
		keyPem: contents.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
		certPem: toPem(contents.certificate),
		chainPem: contents.chain.map(toPem),
	};
}

export function sealCredentials(credentials: FursCredentials): string {
	return Vault.encrypt(JSON.stringify({ key: credentials.keyPem, cert: credentials.certPem, chain: credentials.chainPem }));
}

export function openCredentials(sealed: string): FursCredentials {
	const stored = JSON.parse(Vault.decrypt(sealed)) as { key: string; cert: string; chain: string[] };
	return {
		privateKey: createPrivateKey(stored.key),
		certificate: new X509Certificate(stored.cert),
		keyPem: stored.key,
		certPem: stored.cert,
		chainPem: stored.chain,
	};
}
