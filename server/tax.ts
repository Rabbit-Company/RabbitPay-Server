export type VatStatus = "registered" | "small_business" | "not_registered";
export type CustomerType = "business" | "individual";

export const VAT_STATUSES: { value: VatStatus; label: string; hint: string }[] = [
	{ value: "registered", label: "VAT registered", hint: "You charge VAT and file VAT returns" },
	{ value: "small_business", label: "Small business, exempt from VAT", hint: "Below the national threshold, no VAT is charged" },
	{ value: "not_registered", label: "Not registered for VAT", hint: "For example outside the EU or not a taxable business" },
];

export const CUSTOMER_TYPES: { value: CustomerType; label: string }[] = [
	{ value: "business", label: "Business" },
	{ value: "individual", label: "Individual" },
];

export const EU_COUNTRIES: readonly string[] = "AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK".split(" ");

const EU = new Set(EU_COUNTRIES);

const NATIONAL_CURRENCIES: Record<string, string> = { CZ: "CZK", DK: "DKK", HU: "HUF", PL: "PLN", RO: "RON", SE: "SEK" };

const VIES_PREFIX_TO_COUNTRY: Record<string, string> = { EL: "GR", XI: "GB" };

export function isVatStatus(value: unknown): value is VatStatus {
	return typeof value === "string" && VAT_STATUSES.some((status) => status.value === value);
}

export function canSubmitSlovenianDdvEvidence(country: string | null | undefined, status: string | null | undefined): boolean {
	return country === "SI" && status === "registered";
}

export function isCustomerType(value: unknown): value is CustomerType {
	return typeof value === "string" && CUSTOMER_TYPES.some((type) => type.value === value);
}

export function isEuCountry(country: string | null | undefined): boolean {
	return typeof country === "string" && EU.has(country);
}

export function viesPrefixFor(country: string): string | null {
	if (country === "GR") return "EL";
	return EU.has(country) ? country : null;
}

export const DOMESTIC_VAT_RATES_REVIEWED = "2026-10-02";

export const DOMESTIC_VAT_RATES: Record<string, number[]> = {
	SI: [22, 9.5, 5],
};

export function requiredTaxCurrency(country: string | null | undefined): string | null {
	return country === "SI" ? "EUR" : null;
}

export function defaultTaxCurrency(country: string | null | undefined): string | null {
	if (!isEuCountry(country)) return null;
	return NATIONAL_CURRENCIES[country!] ?? "EUR";
}

export function defaultExemptionNote(country: string | null | undefined, language: string | null | undefined): string {
	if (country === "SI") {
		return language === "sl"
			? "DDV ni obračunan na podlagi 1. odstavka 94. člena ZDDV-1."
			: "VAT is not charged under Article 94(1) of the Slovenian VAT Act (ZDDV-1).";
	}

	return language === "sl" ? "DDV ni obračunan, ker je izdajatelj mali davčni zavezanec." : "VAT is not charged under the small business exemption.";
}

export interface VatNumberParts {
	prefix: string;
	country: string;
	number: string;
}

export interface PartyTaxId {
	key: "invoice.vat_number" | "invoice.tax_number";
	value: string;
}

function compactId(value: string): string {
	return value.toUpperCase().replace(/[\s.\-/]/g, "");
}

export function normalizeVatNumber(value: string | null | undefined, country: string | null | undefined): string | null {
	const typed = value?.trim();
	if (!typed) return null;
	const parts = splitVatNumber(typed, country);
	return parts ? `${parts.prefix}${parts.number}` : typed;
}

export function partyTaxIds(
	party: { vat_number?: string | null; tax_number?: string | null; country?: string | null },
	vatStatus: string | null | undefined
): PartyTaxId[] {
	const vat = party.vat_number?.trim() || null;
	const tax = party.tax_number?.trim() || null;
	const vatParts = vat ? splitVatNumber(vat, party.country) : null;
	const sameNumber = vat !== null && tax !== null && (vatParts?.number === compactId(tax) || compactId(vat) === compactId(tax));

	if (vatStatus === "small_business" || vatStatus === "not_registered") {
		if (tax) return [{ key: "invoice.tax_number", value: tax }];
		return vat ? [{ key: "invoice.tax_number", value: vatParts?.number ?? vat }] : [];
	}

	const ids: PartyTaxId[] = [];
	if (vat) ids.push({ key: "invoice.vat_number", value: vatParts ? `${vatParts.prefix}${vatParts.number}` : vat });
	if (tax && !sameNumber) ids.push({ key: "invoice.tax_number", value: tax });
	return ids;
}

export function splitVatNumber(raw: string | null | undefined, fallbackCountry: string | null | undefined): VatNumberParts | null {
	if (typeof raw !== "string") return null;

	const compact = raw.toUpperCase().replace(/[\s.\-/]/g, "");
	if (compact.length < 3) return null;

	const lead = compact.slice(0, 2);
	if (/^[A-Z]{2}$/.test(lead)) {
		const country = VIES_PREFIX_TO_COUNTRY[lead] ?? lead;
		if (lead !== "XI" && viesPrefixFor(country) !== lead) return null;
		const number = compact.slice(2);
		return /^[A-Z0-9]{2,12}$/.test(number) ? { prefix: lead, country, number } : null;
	}

	if (!fallbackCountry) return null;
	const prefix = viesPrefixFor(fallbackCountry);
	if (!prefix) return null;

	return /^[A-Z0-9]{2,12}$/.test(compact) ? { prefix, country: fallbackCountry, number: compact } : null;
}

export type SupplyType = "goods" | "services" | "digital";
export type TaxCategory = "standard" | "reduced" | "exempt" | "domestic_reverse";
export type TaxTreatment =
	| "domestic"
	| "small_business"
	| "reverse_charge"
	| "domestic_reverse_charge"
	| "intra_eu_goods"
	| "export"
	| "outside_scope"
	| "oss"
	| "exempt";

export const SUPPLY_TYPES: { value: SupplyType; label: string; hint: string }[] = [
	{ value: "services", label: "Service", hint: "Work, consulting, support" },
	{ value: "digital", label: "Digital service", hint: "Software, SaaS, downloads, streaming" },
	{ value: "goods", label: "Goods", hint: "Physical products that are shipped" },
];

export const TAX_CATEGORIES: { value: TaxCategory; label: string }[] = [
	{ value: "standard", label: "Standard rate" },
	{ value: "reduced", label: "Reduced rate" },
	{ value: "exempt", label: "Exempt from VAT" },
	{ value: "domestic_reverse", label: "Domestic reverse charge" },
];

export const TAX_TREATMENTS: { value: TaxTreatment; label: string; zeroRated: boolean }[] = [
	{ value: "domestic", label: "Your VAT", zeroRated: false },
	{ value: "oss", label: "Customer country VAT (OSS)", zeroRated: false },
	{ value: "reverse_charge", label: "Reverse charge", zeroRated: true },
	{ value: "domestic_reverse_charge", label: "Domestic reverse charge", zeroRated: true },
	{ value: "intra_eu_goods", label: "Intra-EU supply of goods", zeroRated: true },
	{ value: "export", label: "Export", zeroRated: true },
	{ value: "outside_scope", label: "Outside the scope of EU VAT", zeroRated: true },
	{ value: "exempt", label: "Exempt", zeroRated: true },
	{ value: "small_business", label: "Small business, no VAT", zeroRated: true },
];

export const STANDARD_RATES_REVIEWED = "2026-09-01";

export const STANDARD_RATES: Record<string, number> = {
	AT: 20,
	BE: 21,
	BG: 20,
	CY: 19,
	CZ: 21,
	DE: 19,
	DK: 25,
	EE: 24,
	ES: 21,
	FI: 25.5,
	FR: 20,
	GR: 24,
	HR: 25,
	HU: 27,
	IE: 23,
	IT: 22,
	LT: 21,
	LU: 17,
	LV: 21,
	MT: 18,
	NL: 21,
	PL: 23,
	PT: 23,
	RO: 21,
	SE: 25,
	SI: 22,
	SK: 23,
};

export const REDUCED_RATES_REVIEWED = "2026-09-19";

export const DEFAULT_REDUCED_RATES: Record<string, number> = {
	AT: 10,
	BE: 6,
	BG: 9,
	CY: 5,
	CZ: 12,
	DE: 7,
	DK: 0,
	EE: 9,
	ES: 10,
	FI: 13.5,
	FR: 5.5,
	GR: 13,
	HR: 13,
	HU: 18,
	IE: 13.5,
	IT: 10,
	LT: 12,
	LU: 8,
	LV: 12,
	MT: 5,
	NL: 9,
	PL: 8,
	PT: 6,
	RO: 11,
	SE: 12,
	SI: 9.5,
	SK: 19,
};

export const OSS_THRESHOLD_EUR = 10000;

export function isSupplyType(value: unknown): value is SupplyType {
	return typeof value === "string" && SUPPLY_TYPES.some((entry) => entry.value === value);
}

export function isTaxCategory(value: unknown): value is TaxCategory {
	return typeof value === "string" && TAX_CATEGORIES.some((entry) => entry.value === value);
}

export function isTaxTreatment(value: unknown): value is TaxTreatment {
	return typeof value === "string" && TAX_TREATMENTS.some((entry) => entry.value === value);
}

export function isZeroRated(treatment: TaxTreatment): boolean {
	return TAX_TREATMENTS.find((entry) => entry.value === treatment)?.zeroRated ?? false;
}

export function treatmentLabel(treatment: TaxTreatment): string {
	return TAX_TREATMENTS.find((entry) => entry.value === treatment)?.label ?? treatment;
}

export interface SellerTax {
	country: string | null;
	vatStatus: string | null;
	ossRegistered: boolean;
}

export interface BuyerTax {
	country: string | null;
	type: string | null;
	vatNumber: string | null;
	vatValid: boolean | null;
}

export interface LineTax {
	supplyType: SupplyType;
	category: TaxCategory;
	rate: number;
}

export type TaxWarning =
	| "no_setup"
	| "exempt_basis"
	| "customer_country"
	| "vies_invalid"
	| "vies_check"
	| "oss_threshold"
	| "reduced_rate"
	| "export_proof"
	| "business_proof"
	| "digital_consumer"
	| "domestic_reverse_buyer";

export interface TaxSuggestion {
	treatment: TaxTreatment | null;
	rate: number;
	warnings: TaxWarning[];
}

export function suggestTax(seller: SellerTax, buyer: BuyerTax | null, line: LineTax): TaxSuggestion {
	const warnings: TaxWarning[] = [];

	if (seller.vatStatus === "small_business") return { treatment: "small_business", rate: 0, warnings };
	if (seller.vatStatus !== "registered" || !isEuCountry(seller.country)) {
		if (seller.vatStatus === null) warnings.push("no_setup");
		return { treatment: null, rate: line.rate, warnings };
	}

	if (line.category === "exempt") {
		warnings.push("exempt_basis");
		return { treatment: "exempt", rate: 0, warnings };
	}

	const domestic = (): TaxSuggestion => ({ treatment: "domestic", rate: line.rate, warnings });
	const country = buyer?.country ?? null;
	const reversible = line.category === "domestic_reverse";

	if (!buyer) {
		if (reversible) warnings.push("domestic_reverse_buyer");
		return domestic();
	}
	if (!country) {
		if (buyer.type === "business" || buyer.vatNumber) warnings.push("customer_country");
		else if (reversible) warnings.push("domestic_reverse_buyer");
		return domestic();
	}

	const business = buyer.type === "business" || (buyer.type === null && Boolean(buyer.vatNumber));

	if (country === seller.country) {
		if (!reversible) return domestic();
		if (!business || !buyer.vatNumber) warnings.push("domestic_reverse_buyer");
		else if (buyer.vatValid === true) return { treatment: "domestic_reverse_charge", rate: 0, warnings };
		else warnings.push(buyer.vatValid === false ? "vies_invalid" : "vies_check");
		return domestic();
	}

	if (isEuCountry(country)) {
		if (business && buyer.vatValid === true) {
			return { treatment: line.supplyType === "goods" ? "intra_eu_goods" : "reverse_charge", rate: 0, warnings };
		}

		if (business) {
			warnings.push(buyer.vatValid === false ? "vies_invalid" : "vies_check");
		}

		if (line.supplyType === "services") return domestic();

		if (!seller.ossRegistered) {
			warnings.push("oss_threshold");
			return domestic();
		}

		if (line.category === "reduced") warnings.push("reduced_rate");
		return { treatment: "oss", rate: STANDARD_RATES[country] ?? line.rate, warnings };
	}

	if (line.supplyType === "goods") {
		warnings.push("export_proof");
		return { treatment: "export", rate: 0, warnings };
	}

	if (business) {
		if (!buyer.vatNumber) warnings.push("business_proof");
		return { treatment: "outside_scope", rate: 0, warnings };
	}

	if (line.supplyType === "digital") {
		warnings.push("digital_consumer");
		return { treatment: "outside_scope", rate: 0, warnings };
	}

	return domestic();
}
