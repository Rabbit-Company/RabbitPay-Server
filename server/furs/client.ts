import { X509Certificate } from "node:crypto";
import { SI_TRUST_ROOT, SIGOV_CA } from "./authorities";
import type { FursCredentials } from "./credentials";
import { FursSignatureError, signedToken, verifiedPayload } from "./jws";
import { fursTime } from "./zoi";

export type FursEnvironment = "test" | "production";

export interface FursEndpoint {
	url: string;
	ca: string[];
	anchors: X509Certificate[];
}

export const FURS_URLS: Record<FursEnvironment, string> = {
	test: "https://blagajne-test.fu.gov.si:9002/v1/cash_registers",
	production: "https://blagajne.fu.gov.si:9003/v1/cash_registers",
};

const REQUEST_TIMEOUT_MS = 10_000;

let overrides: Partial<Record<FursEnvironment, FursEndpoint>> = {};

export function setFursEndpoint(environment: FursEnvironment, endpoint: FursEndpoint | null) {
	if (endpoint) overrides = { ...overrides, [environment]: endpoint };
	else {
		const { [environment]: _removed, ...rest } = overrides;
		overrides = rest;
	}
}

export function fursEndpoint(environment: FursEnvironment): FursEndpoint {
	return overrides[environment] ?? { url: FURS_URLS[environment], ca: [SIGOV_CA, SI_TRUST_ROOT], anchors: [new X509Certificate(SIGOV_CA)] };
}

export class FursUnavailable extends Error {}

export class FursRejected extends Error {
	constructor(
		readonly code: string,
		message: string
	) {
		super(message);
	}
}

export interface MessageHeader {
	MessageID: string;
	DateTime: string;
}

function header(now = Date.now()): MessageHeader {
	return { MessageID: crypto.randomUUID(), DateTime: fursTime(now).iso };
}

async function post(endpoint: FursEndpoint, path: string, body: unknown, credentials: FursCredentials, timeoutMs: number): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(`${endpoint.url}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json; charset=UTF-8" },
			body: JSON.stringify(body),
			tls: { cert: credentials.certPem, key: credentials.keyPem, ca: endpoint.ca },
			signal: AbortSignal.timeout(timeoutMs),
		} as RequestInit);
	} catch (err) {
		throw new FursUnavailable(err instanceof Error && err.name === "TimeoutError" ? "FURS did not answer in time." : "FURS could not be reached.");
	}

	const raw = await response.text();
	try {
		return JSON.parse(raw);
	} catch {
		throw new FursUnavailable(`FURS answered with HTTP ${response.status} and no readable body.`);
	}
}

function readSigned(endpoint: FursEndpoint, body: unknown, key: "InvoiceResponse" | "BusinessPremiseResponse"): Record<string, unknown> {
	const token = (body as { token?: unknown } | null)?.token;
	if (typeof token !== "string") throw new FursUnavailable("FURS answered without a signed response.");
	let payload: Record<string, unknown>;
	try {
		payload = verifiedPayload(token, endpoint.anchors);
	} catch (err) {
		if (err instanceof FursSignatureError) throw new FursUnavailable(err.message);
		throw err;
	}
	const response = payload[key] as { Error?: { ErrorCode?: unknown; ErrorMessage?: unknown } } & Record<string, unknown>;
	if (!response || typeof response !== "object") throw new FursUnavailable("FURS answered with an unexpected response.");
	if (response.Error) {
		const code = String(response.Error.ErrorCode ?? "").toUpperCase();
		const message = String(response.Error.ErrorMessage ?? "FURS rejected the message.");
		if (code === "S100") throw new FursUnavailable(`FURS could not process the message (${code}): ${message}`);
		throw new FursRejected(code, message);
	}
	return response;
}

export async function echo(endpoint: FursEndpoint, credentials: FursCredentials, timeoutMs = REQUEST_TIMEOUT_MS): Promise<void> {
	const body = (await post(endpoint, "/echo", { EchoRequest: "furs" }, credentials, timeoutMs)) as { EchoResponse?: unknown };
	if (body?.EchoResponse !== "furs") throw new FursUnavailable("FURS did not echo the test message.");
}

export interface PremiseAddress {
	Street: string;
	HouseNumber: string;
	HouseNumberAdditional?: string;
	Community: string;
	City: string;
	PostalCode: string;
}

export type PremiseIdentifier =
	| { RealEstateBP: { PropertyID: { CadastralNumber: number; BuildingNumber: number; BuildingSectionNumber: number }; Address: PremiseAddress } }
	| { PremiseType: "A" | "B" | "C" };

export interface BusinessPremise {
	TaxNumber: number;
	BusinessPremiseID: string;
	BPIdentifier: PremiseIdentifier;
	ValidityDate: string;
	ClosingTag?: "Z";
	SoftwareSupplier: ({ TaxNumber: number } | { NameForeign: string })[];
	SpecialNotes?: string;
}

export async function registerPremise(
	endpoint: FursEndpoint,
	credentials: FursCredentials,
	premise: BusinessPremise,
	timeoutMs = REQUEST_TIMEOUT_MS
): Promise<MessageHeader> {
	const message = { BusinessPremiseRequest: { Header: header(), BusinessPremise: premise } };
	const body = await post(endpoint, "/invoices/register", { token: signedToken(message, credentials) }, credentials, timeoutMs);
	readSigned(endpoint, body, "BusinessPremiseResponse");
	return message.BusinessPremiseRequest.Header;
}

export interface TaxesPerSeller {
	VAT?: { TaxRate: number; TaxableAmount: number; TaxAmount: number }[];
	OtherTaxesAmount?: number;
	ExemptVATTaxableAmount?: number;
	ReverseVATTaxableAmount?: number;
	NontaxableAmount?: number;
	SpecialTaxRulesAmount?: number;
}

export interface FiscalInvoice {
	TaxNumber: number;
	IssueDateTime: string;
	NumberingStructure: "B" | "C";
	InvoiceIdentifier: { BusinessPremiseID: string; ElectronicDeviceID: string; InvoiceNumber: string };
	CustomerVATNumber?: string;
	InvoiceAmount: number;
	ReturnsAmount?: number;
	PaymentAmount: number;
	TaxesPerSeller: TaxesPerSeller[];
	OperatorTaxNumber?: number;
	ProtectedID: string;
	SubsequentSubmit?: boolean;
	ReferenceInvoice?: {
		ReferenceInvoiceIdentifier: { BusinessPremiseID: string; ElectronicDeviceID: string; InvoiceNumber: string };
		ReferenceInvoiceIssueDateTime: string;
	}[];
	SpecialNotes?: string;
}

export interface InvoiceReceipt {
	eor: string;
	header: MessageHeader;
}

export async function submitInvoice(
	endpoint: FursEndpoint,
	credentials: FursCredentials,
	invoice: FiscalInvoice,
	timeoutMs = REQUEST_TIMEOUT_MS
): Promise<InvoiceReceipt> {
	const message = { InvoiceRequest: { Header: header(), Invoice: invoice } };
	const body = await post(endpoint, "/invoices", { token: signedToken(message, credentials) }, credentials, timeoutMs);
	const response = readSigned(endpoint, body, "InvoiceResponse");
	const eor = response.UniqueInvoiceID;
	if (typeof eor !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eor)) {
		throw new FursUnavailable("FURS answered without a unique invoice identifier.");
	}
	return { eor: eor.toLowerCase(), header: message.InvoiceRequest.Header };
}
