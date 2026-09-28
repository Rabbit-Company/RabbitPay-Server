import { epc, latin2, upn } from "@rabbit-company/qrcode/payload";
import { Logger } from "../logger";
import { addressLines, type CompanyDetails } from "../company";
import { minorUnitDigits } from "../invoicing";
import { t } from "../i18n";
import { creditorReference, isCreditorReference, mod97 } from "./reference";

export type QrFormat = "auto" | "epc" | "upn" | "none";

export interface BankAccount {
	iban: string;
	bic: string | null;
	holder: string;
	bank_name: string | null;
}

export interface BankQr {
	format: "epc" | "upn";
	payload: string;
	encoding: "utf8" | "latin2";
}

export type QrUnavailableReason = "bad_iban" | "not_euro" | "unsupported_characters" | "build_failed";

export interface BankInstruction {
	account: BankAccount;
	reference: string;
	amount: number;
	currency: string;
	qr: BankQr | null;
	qr_unavailable: QrUnavailableReason | null;
}

export function normalizeIban(value: string): string {
	return value.replace(/\s+/g, "").toUpperCase();
}

export function isPlausibleIban(value: string): boolean {
	const iban = normalizeIban(value);
	if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(iban)) return false;

	return mod97(iban.slice(4) + iban.slice(0, 4)) === 1;
}

export function majorUnits(minorUnitAmount: number, currency: string): number {
	return minorUnitAmount / Math.pow(10, minorUnitDigits(currency));
}

export function chooseFormat(preference: QrFormat, iban: string, currency: string): "epc" | "upn" | null {
	if (preference === "none") return null;
	if (currency.toUpperCase() !== "EUR") return null;

	if (preference === "epc" || preference === "upn") return preference;

	return normalizeIban(iban).startsWith("SI") ? "upn" : "epc";
}

function trimmed(value: string | null | undefined, limit: number): string | undefined {
	const text = value?.trim();
	if (!text) return undefined;
	return text.length > limit ? text.slice(0, limit) : text;
}

export function buildQr(options: {
	format: "epc" | "upn";
	account: BankAccount;
	company: CompanyDetails;
	amount: number;
	reference: string;
	purpose: string;
}): { qr: BankQr | null; reason: QrUnavailableReason | null } {
	const { format, account, company, amount, reference, purpose } = options;

	try {
		if (format === "epc") {
			return {
				qr: {
					format,
					encoding: "utf8",
					payload: epc({
						name: account.holder.slice(0, 70),
						iban: normalizeIban(account.iban),
						bic: trimmed(account.bic, 11),
						amount: amount > 0 ? amount.toFixed(2) : undefined,
						remittance: purpose.slice(0, 140),
					}),
				},
				reason: null,
			};
		}

		const [street, town] = [addressLines(company)[0], [company.postal_code, company.city].filter(Boolean).join(" ")];

		const payload = upn({
			recipientIban: normalizeIban(account.iban),
			recipientName: account.holder.slice(0, 33),
			recipientStreet: trimmed(street, 33),
			recipientCity: trimmed(town, 33),
			amount: amount > 0 ? amount.toFixed(2) : undefined,
			purpose: purpose.slice(0, 42),
			...(isCreditorReference(reference) ? { recipientReference: reference } : {}),
		});

		latin2(payload);

		return { qr: { format, encoding: "latin2", payload }, reason: null };
	} catch (err) {
		Logger.warn(`[BANK] Could not build a ${format} QR for ${reference}: ${err}`);

		if (format === "upn" && err instanceof RangeError && err.message.includes("ISO-8859-2")) {
			return { qr: null, reason: "unsupported_characters" };
		}

		return { qr: null, reason: "build_failed" };
	}
}

export function bankInstruction(options: {
	config: Record<string, string>;
	company: CompanyDetails;
	merchant: string;
	reference: string;
	totalMinorUnits: number;
	currency: string;
	language: string;
}): BankInstruction | null {
	const { config, company, merchant, reference, totalMinorUnits, currency, language } = options;

	const iban = normalizeIban(config.iban ?? "");
	if (!iban) return null;

	const account: BankAccount = {
		iban,
		bic: trimmed(config.bic, 11) ?? null,
		holder: config.account_holder?.trim() || company.legal_name?.trim() || merchant,
		bank_name: config.bank_name?.trim() || null,
	};

	const amount = majorUnits(totalMinorUnits, currency);
	const purpose = t(language, "bank.purpose", { reference });
	const paymentReference = creditorReference(reference) ?? reference;
	const preference = (config.qr_format as QrFormat) || "auto";
	const format = chooseFormat(preference, iban, currency);

	let qr: BankQr | null = null;
	let unavailable: QrUnavailableReason | null = null;

	if (!isPlausibleIban(iban)) {
		unavailable = "bad_iban";
	} else if (format === null) {
		unavailable = preference === "none" ? null : "not_euro";
	} else {
		const built = buildQr({ format, account, company, amount, reference: paymentReference, purpose });
		qr = built.qr;
		unavailable = built.reason;
	}

	return { account, reference: paymentReference, amount: totalMinorUnits, currency, qr, qr_unavailable: unavailable };
}
