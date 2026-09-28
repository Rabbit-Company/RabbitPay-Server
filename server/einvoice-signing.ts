import Database from "./database/database";
import { certificateInfo, credentialsFromPkcs12, openCredentials, sealCredentials, type FursCredentials } from "./furs/credentials";
import { supportsSigningKey } from "./xades";

export interface SigningCertificateRow {
	project: string;
	certificate: string;
	certificate_holder: string | null;
	certificate_issuer: string | null;
	certificate_serial: string | null;
	certificate_valid_to: number;
	created: number;
	updated: number;
}

export interface SigningCertificateSummary {
	holder: string | null;
	issuer: string | null;
	serial: string | null;
	valid_to: number;
}

export class SigningCertificateRejected extends Error {}

export class SigningCertificateExpired extends Error {
	constructor() {
		super("The e-invoice signing certificate has expired. Upload a new one under Settings or remove it to download unsigned e-invoices.");
	}
}

async function signingRow(projectId: string): Promise<SigningCertificateRow | null> {
	const [row] = (await Database`SELECT * FROM einvoice_signing WHERE project = ${projectId}`) as SigningCertificateRow[];
	return row ?? null;
}

export async function signingCertificate(projectId: string): Promise<SigningCertificateSummary | null> {
	const row = await signingRow(projectId);
	if (!row) return null;
	return { holder: row.certificate_holder, issuer: row.certificate_issuer, serial: row.certificate_serial, valid_to: row.certificate_valid_to };
}

export async function signingCredentials(projectId: string, now = Date.now()): Promise<FursCredentials | null> {
	const row = await signingRow(projectId);
	if (!row) return null;
	if (row.certificate_valid_to < now) throw new SigningCertificateExpired();
	return openCredentials(row.certificate);
}

export function readSigningCertificate(file: Uint8Array, password: string, now = Date.now()): FursCredentials {
	const credentials = credentialsFromPkcs12(file, password);
	if (!supportsSigningKey(credentials)) throw new SigningCertificateRejected("The certificate must use an RSA or EC key.");
	const info = certificateInfo(credentials.certificate);
	if (info.validTo < now) throw new SigningCertificateRejected("The certificate has expired.");
	if (info.validFrom > now) throw new SigningCertificateRejected("The certificate is not valid yet.");
	return credentials;
}

export async function saveSigningCertificate(projectId: string, credentials: FursCredentials): Promise<SigningCertificateSummary> {
	const info = certificateInfo(credentials.certificate);
	const sealed = sealCredentials(credentials);
	const timestamp = Date.now();

	await Database.begin(async (tx) => {
		await tx`DELETE FROM einvoice_signing WHERE project = ${projectId}`;
		await tx`
			INSERT INTO einvoice_signing(project, certificate, certificate_holder, certificate_issuer, certificate_serial, certificate_valid_to, created, updated)
			VALUES(${projectId}, ${sealed}, ${info.holder || null}, ${info.issuerName}, ${info.serial}, ${info.validTo}, ${timestamp}, ${timestamp})
		`;
	});

	return { holder: info.holder || null, issuer: info.issuerName, serial: info.serial, valid_to: info.validTo };
}

export async function removeSigningCertificate(projectId: string): Promise<void> {
	await Database`DELETE FROM einvoice_signing WHERE project = ${projectId}`;
}
