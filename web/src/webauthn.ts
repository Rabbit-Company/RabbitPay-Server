interface CredentialDescriptorJSON {
	type: "public-key";
	id: string;
	transports?: AuthenticatorTransport[];
}

export interface SecurityKeyCreationOptions {
	challenge: string;
	rp: { id: string; name: string };
	user: { id: string; name: string; displayName: string };
	pubKeyCredParams: { type: "public-key"; alg: number }[];
	timeout: number;
	attestation: AttestationConveyancePreference;
	authenticatorSelection: AuthenticatorSelectionCriteria;
	excludeCredentials: CredentialDescriptorJSON[];
}

export interface SecurityKeyRequestOptions {
	challenge: string;
	rpId: string;
	timeout: number;
	userVerification: UserVerificationRequirement;
	allowCredentials: CredentialDescriptorJSON[];
}

function toBytes(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBase64url(buffer: ArrayBuffer): string {
	return btoa(String.fromCharCode(...new Uint8Array(buffer)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function descriptors(credentials: CredentialDescriptorJSON[]): PublicKeyCredentialDescriptor[] {
	return credentials.map((credential) => ({ ...credential, id: toBytes(credential.id) }));
}

export function securityKeysSupported(): boolean {
	return window.isSecureContext && typeof window.PublicKeyCredential === "function" && navigator.credentials !== undefined;
}

export function securityKeyCancelled(error: unknown): boolean {
	return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError");
}

export async function createSecurityKey(options: SecurityKeyCreationOptions): Promise<unknown> {
	const credential = (await navigator.credentials.create({
		publicKey: {
			...options,
			challenge: toBytes(options.challenge),
			user: { ...options.user, id: toBytes(options.user.id) },
			excludeCredentials: descriptors(options.excludeCredentials),
		},
	})) as PublicKeyCredential | null;
	if (credential === null) throw new DOMException("No security key was created.", "NotAllowedError");

	const response = credential.response as AuthenticatorAttestationResponse;
	return {
		id: credential.id,
		rawId: toBase64url(credential.rawId),
		type: credential.type,
		response: {
			clientDataJSON: toBase64url(response.clientDataJSON),
			attestationObject: toBase64url(response.attestationObject),
			transports: typeof response.getTransports === "function" ? response.getTransports() : [],
		},
	};
}

export async function getSecurityKey(options: SecurityKeyRequestOptions): Promise<unknown> {
	const credential = (await navigator.credentials.get({
		publicKey: { ...options, challenge: toBytes(options.challenge), allowCredentials: descriptors(options.allowCredentials) },
	})) as PublicKeyCredential | null;
	if (credential === null) throw new DOMException("No security key was used.", "NotAllowedError");

	const response = credential.response as AuthenticatorAssertionResponse;
	return {
		id: credential.id,
		rawId: toBase64url(credential.rawId),
		type: credential.type,
		response: {
			clientDataJSON: toBase64url(response.clientDataJSON),
			authenticatorData: toBase64url(response.authenticatorData),
			signature: toBase64url(response.signature),
			userHandle: response.userHandle ? toBase64url(response.userHandle) : null,
		},
	};
}
