import { describe, expect, test } from "bun:test";

const { disclosureGaps, legalFormOf } = await import("../server/company-disclosure");
const { legalNameParts } = await import("../server/legal-name");
const { t } = await import("../server/i18n");

describe("reading the legal form from a company name", () => {
	test("recognises companies with share capital", () => {
		for (const name of [
			"Rabbit Company d.o.o.",
			"RABBIT COMPANY D.O.O.",
			"Zidar, gradbeništvo, d. o. o.",
			"Luka Koper d.d.",
			"Holding k.d.d.",
			"Zidar družba z omejeno odgovornostjo",
		]) {
			expect(legalFormOf(name)).toBe("capital_company");
		}
	});

	test("recognises partnerships and sole traders", () => {
		expect(legalFormOf("Novak in Kranjc d.n.o.")).toBe("partnership");
		expect(legalFormOf("Novak k.d.")).toBe("partnership");
		expect(legalFormOf("Mizarstvo Janez Novak s.p.")).toBe("sole_trader");
		expect(legalFormOf("Janez Novak, samostojni podjetnik")).toBe("sole_trader");
	});

	test("does not guess from a name without a legal form", () => {
		for (const name of ["Rabbit Company", "", null, "Add.on studio", "Splash", "Odd.do"]) expect(legalFormOf(name)).toBeNull();
	});
});

describe("what a Slovenian seller still has to disclose", () => {
	const company = { country: "SI", legal_name: "Zidar d.o.o.", registration_number: "1234567000", footer_note: null };

	test("asks a d.o.o. for the register entry and the share capital", () => {
		expect(disclosureGaps(company)).toEqual({ form: "capital_company", registrationNumber: false, registerEntry: true, shareCapital: true, unfinished: false });
	});

	test("is satisfied once the footer names the court and the capital", () => {
		const footer = "Družba je vpisana v sodni register pri Okrožnem sodišču v Ljubljani. Osnovni kapital: 7.500,00 EUR, v celoti vplačan.";
		expect(disclosureGaps({ ...company, footer_note: footer })).toMatchObject({ registerEntry: false, shareCapital: false, unfinished: false });
	});

	test("keeps reminding while the suggested text still has blanks", () => {
		const footer = `${t("sl", "company.disclosure.register")} ${t("sl", "company.disclosure.capital")}`;
		expect(disclosureGaps({ ...company, footer_note: footer })).toMatchObject({ registerEntry: false, shareCapital: false, unfinished: true });
		expect(disclosureGaps({ ...company, footer_note: `${t("en", "company.disclosure.register")} ${t("en", "company.disclosure.capital")}` })).toMatchObject({
			registerEntry: false,
			shareCapital: false,
			unfinished: true,
		});
	});

	test("asks a partnership only for the register and a sole trader only for the registration number", () => {
		expect(disclosureGaps({ ...company, legal_name: "Novak k.d." })).toMatchObject({ registerEntry: true, shareCapital: false });
		expect(disclosureGaps({ ...company, legal_name: "Janez Novak s.p.", registration_number: " " })).toEqual({
			form: "sole_trader",
			registrationNumber: true,
			registerEntry: false,
			shareCapital: false,
			unfinished: false,
		});
	});

	test("says nothing for a foreign seller or an unknown legal form", () => {
		expect(disclosureGaps({ ...company, country: "DE", legal_name: "Bau GmbH" }).form).toBeNull();
		expect(disclosureGaps({ ...company, legal_name: "Zidar" })).toMatchObject({ form: null, registerEntry: false, registrationNumber: false });
	});
});

describe("splitting a sole trader name from its activity", () => {
	test("keeps the name up to s.p. and moves the activity out", () => {
		expect(legalNameParts("JAGER SIMONCA ZAJC S.P. RAČUNOVODSKE, KNJIGOVODSKE STORITVE")).toEqual({
			name: "JAGER SIMONCA ZAJC S.P.",
			activity: "RAČUNOVODSKE, KNJIGOVODSKE STORITVE",
		});
		expect(legalNameParts("Janez Novak s.p., mizarstvo")).toEqual({ name: "Janez Novak s.p.", activity: "mizarstvo" });
	});

	test("leaves other names whole", () => {
		expect(legalNameParts("Mizarstvo Janez Novak s.p.")).toEqual({ name: "Mizarstvo Janez Novak s.p.", activity: null });
		expect(legalNameParts("Rabbit Company d.o.o.")).toEqual({ name: "Rabbit Company d.o.o.", activity: null });
		expect(legalNameParts("Wasp Planet")).toEqual({ name: "Wasp Planet", activity: null });
		expect(legalNameParts(null)).toEqual({ name: "", activity: null });
	});
});
