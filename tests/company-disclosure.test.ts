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

	test("moves an activity written between the trade name and the person below them", () => {
		expect(legalNameParts("PRIMER GRADNJE, GRADBENIŠTVO, JANEZ NOVAK S.P.")).toEqual({
			name: "PRIMER GRADNJE, JANEZ NOVAK S.P.",
			activity: "GRADBENIŠTVO",
		});
		expect(legalNameParts("PRIMER MONT, MONTAŽE IN INSTALACIJE, ANA KOVAČ S.P.")).toEqual({
			name: "PRIMER MONT, ANA KOVAČ S.P.",
			activity: "MONTAŽE IN INSTALACIJE",
		});
		expect(legalNameParts("MONT, MONTAŽE, INSTALACIJE, Janez Novak s.p.")).toEqual({ name: "MONT, Janez Novak s.p.", activity: "MONTAŽE, INSTALACIJE" });
	});

	test("moves an activity written before the person below them", () => {
		expect(legalNameParts("ZAKLJUČNA GRADBENA DELA, JANEZ NOVAK S.P.")).toEqual({ name: "JANEZ NOVAK S.P.", activity: "ZAKLJUČNA GRADBENA DELA" });
		expect(legalNameParts("Mizarstvo, Ana Kovač s.p.")).toEqual({ name: "Ana Kovač s.p.", activity: "Mizarstvo" });
		expect(legalNameParts("Janez Novak, s.p.")).toEqual({ name: "Janez Novak, s.p.", activity: null });
	});

	test("moves an activity written between a company name and its legal form below them", () => {
		expect(legalNameParts("PRIMER 10, GRADBENE IN DRUGE STORITVE, D.O.O.")).toEqual({
			name: "PRIMER 10 D.O.O.",
			activity: "GRADBENE IN DRUGE STORITVE",
		});
		expect(legalNameParts("Primer gradnje, fasaderstvo, d.o.o.")).toEqual({ name: "Primer gradnje d.o.o.", activity: "fasaderstvo" });
		expect(legalNameParts("Primer, trgovina, storitve, d.d.")).toEqual({ name: "Primer d.d.", activity: "trgovina, storitve" });
		expect(legalNameParts("PRIMER PODJETJE ZA PRIPRAVO IN IZVEDBO INVESTICIJ, D.O.O.")).toEqual({
			name: "PRIMER PODJETJE ZA PRIPRAVO IN IZVEDBO INVESTICIJ, D.O.O.",
			activity: null,
		});
		expect(legalNameParts("Primer, Novak in Kovač, partnerji")).toEqual({ name: "Primer, Novak in Kovač, partnerji", activity: null });
	});

	test("keeps the seat written after the legal form with the name", () => {
		expect(legalNameParts("PRIMER, TRGOVSKO, PROIZVODNO IN TURISTIČNO PODJETJE, D.O.O., LJUBLJANA")).toEqual({
			name: "PRIMER, D.O.O., LJUBLJANA",
			activity: "TRGOVSKO, PROIZVODNO IN TURISTIČNO PODJETJE",
		});
		expect(legalNameParts("Primer, d.o.o., Ljubljana")).toEqual({ name: "Primer, d.o.o., Ljubljana", activity: null });
	});

	test("leaves other names whole", () => {
		expect(legalNameParts("Mizarstvo Janez Novak s.p.")).toEqual({ name: "Mizarstvo Janez Novak s.p.", activity: null });
		expect(legalNameParts("Rabbit Company d.o.o.")).toEqual({ name: "Rabbit Company d.o.o.", activity: null });
		expect(legalNameParts("Primer Studio")).toEqual({ name: "Primer Studio", activity: null });
		expect(legalNameParts(null)).toEqual({ name: "", activity: null });
	});
});
