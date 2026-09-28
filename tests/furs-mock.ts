import { createHash, createPrivateKey, createSign, createVerify, X509Certificate } from "node:crypto";
import { readPkcs12 } from "../server/furs/pkcs12";
import type { FursEndpoint } from "../server/furs/client";

const FIXTURES = `${import.meta.dir}/fixtures/furs`;

export const TAXPAYER_PASSWORD = "futest";
export const TAXPAYER_TAX_NUMBER = 10148019;

export async function fixture(name: string): Promise<Uint8Array> {
	return new Uint8Array(await Bun.file(`${FIXTURES}/${name}`).arrayBuffer());
}

export interface ReceivedInvoice {
	invoice: Record<string, any>;
	eor: string;
	zoiMatches: boolean;
}

export interface FursMock {
	endpoint: FursEndpoint;
	premises: Map<string, Record<string, any>>;
	invoices: ReceivedInvoice[];
	echoes: number;
	outage: boolean;
	reject: { code: string; message: string } | null;
	stop(): void;
}

function base64url(value: string | Uint8Array): string {
	return Buffer.from(value).toString("base64url");
}

function printedTime(iso: string): string {
	const [date, time] = iso.split("T") as [string, string];
	const [year, month, day] = date.split("-");
	return `${day}.${month}.${year} ${time}`;
}

function taxNumberOf(certificate: X509Certificate): number | null {
	const match = /OU=(\d{8})/.exec(certificate.subject.replace(/\n/g, ","));
	return match ? Number(match[1]) : null;
}

export async function startFursMock(): Promise<FursMock> {
	const read = (name: string) => Bun.file(`${FIXTURES}/${name}`).text();
	const ca = await read("ca.pem");
	const signerKey = createPrivateKey(await read("signer.key"));
	const signer = new X509Certificate(await read("signer.pem"));
	const taxpayer = readPkcs12(await fixture("taxpayer.p12"), TAXPAYER_PASSWORD);
	const known = new Map([[BigInt(`0x${taxpayer.certificate.serialNumber}`).toString(), taxpayer.certificate]]);

	const signedHeader = `{"alg":"RS256","subject_name":"CN=DavPotRacTEST,OU=systems,O=state authorities,C=SI","issuer_name":"CN=Tax CA Test,O=state-institutions,C=SI","serial":1002,"x5c":[${JSON.stringify(Buffer.from(signer.raw).toString("base64"))}]}`;
	const respond = (payload: unknown) => {
		const input = `${base64url(signedHeader)}.${base64url(JSON.stringify(payload))}`;
		const signature = createSign("RSA-SHA256").update(input).sign(signerKey);
		return Response.json({ token: `${input}.${base64url(signature)}` });
	};
	const header = () => ({ MessageID: crypto.randomUUID().toUpperCase(), DateTime: new Date().toISOString().slice(0, 19) });
	const error = (key: string, code: string, message: string) => respond({ [key]: { Header: header(), Error: { ErrorCode: code, ErrorMessage: message } } });

	const mock: FursMock = {
		endpoint: { url: "", ca: [ca], anchors: [new X509Certificate(ca)] },
		premises: new Map(),
		invoices: [],
		echoes: 0,
		outage: false,
		reject: null,
		stop: () => server.stop(true),
	};

	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		tls: { key: await read("server.key"), cert: await read("server.pem"), ca, requestCert: true, rejectUnauthorized: true },
		async fetch(request) {
			if (mock.outage) return new Response("Service unavailable", { status: 503 });
			const path = new URL(request.url).pathname;
			const body = (await request.json()) as Record<string, any>;

			if (path === "/v1/cash_registers/echo") {
				mock.echoes++;
				return Response.json({ EchoResponse: body.EchoRequest });
			}

			const key = path === "/v1/cash_registers/invoices/register" ? "BusinessPremiseResponse" : "InvoiceResponse";
			const [headerPart, payloadPart, signaturePart] = String(body.token ?? "").split(".") as [string, string, string];
			const rawHeader = Buffer.from(headerPart ?? "", "base64url").toString("utf8");
			const serial = /"serial":(\d+)/.exec(rawHeader)?.[1];
			const certificate = serial ? known.get(serial) : undefined;
			if (!certificate) return error(key, "S004", "Identifikator digitalnega potrdila ni ustrezen");
			const valid = createVerify("RSA-SHA256")
				.update(`${headerPart}.${payloadPart}`)
				.verify(certificate.publicKey, Buffer.from(signaturePart ?? "", "base64url"));
			if (!valid || JSON.parse(rawHeader).alg !== "RS256") return error(key, "S003", "Digitalni podpis ni ustrezen");
			const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));

			if (key === "BusinessPremiseResponse") {
				const premise = payload.BusinessPremiseRequest.BusinessPremise;
				if (premise.TaxNumber !== taxNumberOf(certificate))
					return error(key, "S005", "Davčna številka v sporočilu ni enaka davčni številki iz digitalnega potrdila");
				mock.premises.set(premise.BusinessPremiseID, premise);
				return respond({ BusinessPremiseResponse: { Header: header() } });
			}

			const invoice = payload.InvoiceRequest.Invoice;
			if (invoice.TaxNumber !== taxNumberOf(certificate))
				return error(key, "S005", "Davčna številka v sporočilu ni enaka davčni številki iz digitalnega potrdila");
			const premise = mock.premises.get(invoice.InvoiceIdentifier.BusinessPremiseID);
			if (!premise || premise.ClosingTag === "Z") return error(key, "S006", "Podatki o poslovnem prostoru niso posredovani");
			if (mock.reject) {
				const { code, message } = mock.reject;
				mock.reject = null;
				return error(key, code, message);
			}

			const identifier = invoice.InvoiceIdentifier;
			const zoiInput = `${invoice.TaxNumber}${printedTime(invoice.IssueDateTime)}${identifier.InvoiceNumber}${identifier.BusinessPremiseID}${identifier.ElectronicDeviceID}${Number(invoice.InvoiceAmount).toFixed(2)}`;
			const zoi = createHash("md5").update(createSign("RSA-SHA256").update(zoiInput, "utf8").sign(taxpayer.privateKey)).digest("hex");
			const eor = crypto.randomUUID();
			mock.invoices.push({ invoice, eor, zoiMatches: zoi === invoice.ProtectedID });
			return respond({ InvoiceResponse: { Header: header(), UniqueInvoiceID: eor } });
		},
	});

	mock.endpoint.url = `https://127.0.0.1:${server.port}/v1/cash_registers`;
	return mock;
}

type Call = (method: string, path: string, options: { token?: string; body?: unknown }) => Promise<{ error: number; info: string }>;

export async function enableFiscalVerification(call: Call, token: string, base: string) {
	const steps = [
		await call("PUT", `${base}/fiscal/certificate`, {
			token,
			body: { file: Buffer.from(await fixture("taxpayer.p12")).toString("base64"), password: TAXPAYER_PASSWORD },
		}),
		await call("POST", `${base}/fiscal/premises`, { token, body: { premise_id: "TRGOVINA1", kind: "movable", premise_type: "B" } }),
		await call("PATCH", `${base}/fiscal`, {
			token,
			body: { enabled: true, online_premise: "TRGOVINA1", online_device: "SPLET", pos_premise: "TRGOVINA1", pos_device: "BLAG1" },
		}),
	];
	const failed = steps.find((step) => step.error !== 0);
	if (failed) throw new Error(`Fiscal verification could not be set up: ${failed.info}`);
}
