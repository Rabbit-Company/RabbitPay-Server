import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPkcs12 } from "../../server/furs/pkcs12";
import { startFursMock, type FursMock } from "../../tests/furs-mock";

export const FURS_DIRECTORY = join(tmpdir(), "rabbitpay-help-shots-cache", "furs");
export const CERTIFICATE_PASSWORD = "Pod-Lipo-Furs-2026";

function openssl(...args: string[]) {
	const result = Bun.spawnSync(["openssl", ...args], { cwd: FURS_DIRECTORY, stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr.toString()}`);
}

function issue(name: string, subject: string, extensions: string) {
	writeFileSync(join(FURS_DIRECTORY, `${name}.ext`), extensions);
	openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-utf8", "-keyout", `${name}.key`, "-subj", subject, "-out", `${name}.csr`);
	openssl(
		"x509",
		"-req",
		"-in",
		`${name}.csr`,
		"-CA",
		"ca.pem",
		"-CAkey",
		"ca.key",
		"-set_serial",
		String(Date.now()),
		"-days",
		"3650",
		"-extfile",
		`${name}.ext`,
		"-out",
		`${name}.pem`
	);
}

function prepareAuthority() {
	mkdirSync(FURS_DIRECTORY, { recursive: true });
	if (existsSync(join(FURS_DIRECTORY, "signer.pem"))) return;
	openssl(
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		"ca.key",
		"-out",
		"ca.pem",
		"-days",
		"3650",
		"-subj",
		"/C=SI/O=state-institutions/CN=Tax CA Test",
		"-addext",
		"basicConstraints=critical,CA:TRUE",
		"-addext",
		"keyUsage=critical,keyCertSign,cRLSign"
	);
	issue("server", "/CN=localhost", "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
	issue("signer", "/C=SI/O=state authorities/OU=systems/CN=DavPotRacTEST", "keyUsage=digitalSignature\n");
}

export function taxpayerFile(taxNumber: string): string {
	return join(FURS_DIRECTORY, `taxpayer-${taxNumber}.p12`);
}

export function issueTaxpayer(taxNumber: string, holder: string): string {
	prepareAuthority();
	const file = taxpayerFile(taxNumber);
	if (existsSync(file)) return file;
	const name = `taxpayer-${taxNumber}`;
	issue(
		name,
		`/C=SI/O=state-institutions/OU=DavPotRacTEST/OU=${taxNumber}/serialNumber=1/CN=${holder}`,
		"extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature\n"
	);
	openssl(
		"pkcs12",
		"-export",
		"-inkey",
		`${name}.key`,
		"-in",
		`${name}.pem`,
		"-certfile",
		"ca.pem",
		"-name",
		holder,
		"-passout",
		`pass:${CERTIFICATE_PASSWORD}`,
		"-out",
		`${name}.p12`
	);
	return file;
}

export interface HelpFurs {
	mock: FursMock;
	environment: Record<string, string>;
	trust(file: string): void;
}

function readTaxpayer(file: string) {
	return readPkcs12(new Uint8Array(readFileSync(file)), CERTIFICATE_PASSWORD);
}

function rememberPremises(mock: FursMock, database: string) {
	if (!existsSync(database)) return;
	const db = new Database(database, { readonly: true });
	try {
		const rows = db.query("SELECT premise_id FROM fiscal_premises WHERE environment = 'test' AND closed_at IS NULL").all() as { premise_id: string }[];
		for (const row of rows) mock.premises.set(row.premise_id, { BusinessPremiseID: row.premise_id });
	} catch {
		void 0;
	} finally {
		db.close();
	}
}

export async function startHelpFurs(port: number, database: string): Promise<HelpFurs> {
	prepareAuthority();
	const taxpayers = readdirSync(FURS_DIRECTORY)
		.filter((name) => /^taxpayer-\d{8}\.p12$/.test(name))
		.map((name) => readTaxpayer(join(FURS_DIRECTORY, name)));
	const mock = await startFursMock({ directory: FURS_DIRECTORY, taxpayers, port });
	rememberPremises(mock, database);
	return {
		mock,
		environment: { RABBITPAY_FURS_TEST_URL: mock.endpoint.url, RABBITPAY_FURS_TEST_CA: join(FURS_DIRECTORY, "ca.pem") },
		trust: (file) => mock.trust(readTaxpayer(file)),
	};
}
