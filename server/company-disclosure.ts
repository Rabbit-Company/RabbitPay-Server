export type LegalForm = "capital_company" | "partnership" | "sole_trader";

export interface DisclosedCompany {
	country: string | null;
	legal_name: string | null;
	registration_number: string | null;
	footer_note: string | null;
}

export interface DisclosureGaps {
	form: LegalForm | null;
	registrationNumber: boolean;
	registerEntry: boolean;
	shareCapital: boolean;
	unfinished: boolean;
}

export const DISCLOSURE_BLANK = "___";

const CAPITAL_COMPANY = /(^|[\s,])(d\.\s*o\.\s*o\.?|d\.\s*d\.?|k\.\s*d\.\s*d\.?)(?=$|[\s,])|družba z omejeno odgovornostjo|delniška družba/i;
const PARTNERSHIP = /(^|[\s,])(d\.\s*n\.\s*o\.?|k\.\s*d\.?)(?=$|[\s,])|družba z neomejeno odgovornostjo|komanditna družba/i;
const SOLE_TRADER = /(^|[\s,])s\.\s*p\.?(?=$|[\s,])|samostojni podjetnik/i;
const REGISTER_ENTRY = /sodišč|sodni\s+register|court|register/i;
const SHARE_CAPITAL = /kapital|capital/i;

export function legalFormOf(legalName: string | null | undefined): LegalForm | null {
	const name = (legalName ?? "").trim();
	if (!name) return null;
	if (CAPITAL_COMPANY.test(name)) return "capital_company";
	if (PARTNERSHIP.test(name)) return "partnership";
	if (SOLE_TRADER.test(name)) return "sole_trader";
	return null;
}

export function disclosureGaps(company: DisclosedCompany): DisclosureGaps {
	const none: DisclosureGaps = { form: null, registrationNumber: false, registerEntry: false, shareCapital: false, unfinished: false };
	if (company.country !== "SI") return none;

	const form = legalFormOf(company.legal_name);
	if (form === null) return none;

	const footer = company.footer_note ?? "";
	const isCompany = form !== "sole_trader";
	return {
		form,
		registrationNumber: !(company.registration_number ?? "").trim(),
		registerEntry: isCompany && !REGISTER_ENTRY.test(footer),
		shareCapital: form === "capital_company" && !SHARE_CAPITAL.test(footer),
		unfinished: footer.includes(DISCLOSURE_BLANK),
	};
}
