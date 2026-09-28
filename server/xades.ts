import { createHash, sign } from "node:crypto";
import { certificateInfo, type FursCredentials } from "./furs/credentials";
import { compact, exclusiveCanonical, node, withAttributes, withChild, withNamespaces, type XmlNode } from "./xml";

export const XMLDSIG_NAMESPACE = "http://www.w3.org/2000/09/xmldsig#";
export const XADES_NAMESPACE = "http://uri.etsi.org/01903/v1.3.2#";
const EXCLUSIVE_CANONICALIZATION = "http://www.w3.org/2001/10/xml-exc-c14n#";
const SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";
const SIGNED_PROPERTIES_TYPE = "http://uri.etsi.org/01903#SignedProperties";

const SIGNATURE_METHODS: Record<string, string> = {
	rsa: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
	ec: "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256",
};

export class SigningKeyUnsupported extends Error {}

export function supportsSigningKey(credentials: FursCredentials): boolean {
	return (credentials.privateKey.asymmetricKeyType ?? "") in SIGNATURE_METHODS;
}

function digest(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("base64");
}

function algorithm(name: string, uri: string): XmlNode {
	return withAttributes(node(name), { Algorithm: uri });
}

function reference(uri: string, digestValue: string, type?: string): XmlNode {
	return withAttributes(
		node(
			"ds:Reference",
			node("ds:Transforms", algorithm("ds:Transform", EXCLUSIVE_CANONICALIZATION)),
			algorithm("ds:DigestMethod", SHA256),
			node("ds:DigestValue", digestValue)
		),
		type ? { Type: type, URI: uri } : { URI: uri }
	);
}

function signedProperties(id: string, credentials: FursCredentials, signedAt: number): XmlNode {
	const info = certificateInfo(credentials.certificate);
	return withAttributes(
		node(
			"xds:SignedProperties",
			node(
				"xds:SignedSignatureProperties",
				node("xds:SigningTime", new Date(signedAt).toISOString().replace(/\.\d{3}Z$/, "Z")),
				node(
					"xds:SigningCertificate",
					node(
						"xds:Cert",
						node("xds:CertDigest", algorithm("ds:DigestMethod", SHA256), node("ds:DigestValue", digest(new Uint8Array(credentials.certificate.raw)))),
						node("xds:IssuerSerial", node("ds:X509IssuerName", info.issuerName), node("ds:X509SerialNumber", info.serial))
					)
				)
			)
		),
		{ Id: id }
	);
}

function signature(id: string, signedInfo: XmlNode, signatureValue: string, credentials: FursCredentials, properties: XmlNode): XmlNode {
	const certificates = [credentials.certPem, ...credentials.chainPem].map((pem) => pem.replace(/-----[^-]+-----|\s+/g, ""));
	return compact(
		withNamespaces(
			withAttributes(
				node(
					"ds:Signature",
					signedInfo,
					node("ds:SignatureValue", signatureValue),
					node("ds:KeyInfo", node("ds:X509Data", ...certificates.map((certificate) => node("ds:X509Certificate", certificate)))),
					node("ds:Object", withNamespaces(withAttributes(node("xds:QualifyingProperties", properties), { Target: `#${id}` }), { xds: XADES_NAMESPACE }))
				),
				{ Id: id }
			),
			{ ds: XMLDSIG_NAMESPACE }
		)
	);
}

export function signedCopy(root: XmlNode, target: XmlNode, credentials: FursCredentials, signedAt: number): XmlNode {
	const method = SIGNATURE_METHODS[credentials.privateKey.asymmetricKeyType ?? ""];
	if (!method) throw new SigningKeyUnsupported("Only RSA and EC keys can sign e-invoices.");
	const targetId = target.attributes["Id"];
	if (!targetId) throw new Error(`${target.name} needs an Id to be signed`);

	const id = crypto.randomUUID();
	const signatureId = `Signature-${id}`;
	const propertiesId = `SignedProperties-${id}`;
	const properties = signedProperties(propertiesId, credentials, signedAt);
	const placeholder = node("ds:SignedInfo");

	const draft = withChild(root, signature(signatureId, placeholder, "", credentials, properties));
	const signedInfo = node(
		"ds:SignedInfo",
		algorithm("ds:CanonicalizationMethod", EXCLUSIVE_CANONICALIZATION),
		algorithm("ds:SignatureMethod", method),
		reference(`#${targetId}`, digest(exclusiveCanonical(root, target))),
		reference(`#${propertiesId}`, digest(exclusiveCanonical(draft, properties)), SIGNED_PROPERTIES_TYPE)
	);

	const unsigned = withChild(root, signature(signatureId, signedInfo, "", credentials, properties));
	const value = sign("sha256", Buffer.from(exclusiveCanonical(unsigned, signedInfo)), { key: credentials.privateKey, dsaEncoding: "ieee-p1363" });
	return withChild(root, signature(signatureId, signedInfo, value.toString("base64"), credentials, properties));
}
