import { createSign, createVerify, X509Certificate } from "node:crypto";
import { certificateInfo, type FursCredentials } from "./credentials";

export class FursSignatureError extends Error {}

function base64url(data: string | Uint8Array): string {
	return Buffer.from(data).toString("base64url");
}

export function signedToken(payload: unknown, credentials: FursCredentials): string {
	const info = certificateInfo(credentials.certificate);
	const header = `{"alg":"RS256","subject_name":${JSON.stringify(info.subjectName)},"issuer_name":${JSON.stringify(info.issuerName)},"serial":${info.serial}}`;
	const input = `${base64url(header)}.${base64url(JSON.stringify(payload))}`;
	const signature = createSign("RSA-SHA256").update(input).sign(credentials.privateKey);
	return `${input}.${base64url(signature)}`;
}

function trustedBy(leaf: X509Certificate, anchors: X509Certificate[], now: number): boolean {
	if (Date.parse(leaf.validFrom) > now || Date.parse(leaf.validTo) < now) return false;
	return anchors.some((anchor) => leaf.checkIssued(anchor) && leaf.verify(anchor.publicKey));
}

export function verifiedPayload(token: string, anchors: X509Certificate[], now = Date.now()): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length !== 3) throw new FursSignatureError("FURS sent a response that is not a signed token.");
	const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

	let header: { alg?: unknown; x5c?: unknown };
	let payload: Record<string, unknown>;
	try {
		header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
		payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
	} catch {
		throw new FursSignatureError("FURS sent a response that cannot be read.");
	}
	if (header.alg !== "RS256" || !Array.isArray(header.x5c) || typeof header.x5c[0] !== "string") {
		throw new FursSignatureError("FURS sent a response without its signing certificate.");
	}

	const signer = new X509Certificate(Buffer.from(header.x5c[0], "base64"));
	if (!trustedBy(signer, anchors, now)) throw new FursSignatureError("The response was not signed by the Financial Administration.");
	const valid = createVerify("RSA-SHA256").update(`${headerPart}.${payloadPart}`).verify(signer.publicKey, Buffer.from(signaturePart, "base64url"));
	if (!valid) throw new FursSignatureError("The signature on the FURS response is not valid.");
	return payload;
}
