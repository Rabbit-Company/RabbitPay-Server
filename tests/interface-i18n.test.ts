import { describe, expect, test } from "bun:test";

import { en } from "../web/src/i18n/en";
import { sl } from "../web/src/i18n/sl";
import Errors from "../server/errors";
import {
	DEFAULT_UI_LANGUAGE,
	UI_LANGUAGES,
	isUiLanguage,
	preferredLanguage,
	translate,
	translateCount,
	type UiKey,
	type UiLanguage,
} from "../web/src/i18n/dictionary";

const KEYS = Object.keys(en) as UiKey[];
const DICTIONARIES: Record<UiLanguage, Record<string, string>> = { en, sl };
const slovenian: Record<string, string> = sl;
const PLURAL_CATEGORIES = ["one", "two", "few", "other"];

function pluralBases(): string[] {
	return KEYS.filter((key) => key.endsWith(".other")).map((key) => key.slice(0, -".other".length));
}

describe("the interface dictionaries", () => {
	test("carry the same keys in both languages, with nothing left blank", () => {
		expect(KEYS.length).toBeGreaterThan(500);
		expect(Object.keys(sl).sort()).toEqual([...KEYS].sort());

		for (const language of UI_LANGUAGES) {
			for (const key of KEYS) {
				const translated = translate(language.value, key);
				expect(typeof translated).toBe("string");
				expect(translated.trim().length).toBeGreaterThan(0);
			}
		}
	});

	test("leaves no Slovenian entry as a copy of the key itself", () => {
		for (const key of KEYS) expect(sl[key]).not.toBe(key);
	});

	test("keeps the placeholders of each English string in the Slovenian one", () => {
		const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

		for (const key of KEYS) {
			expect(placeholders(sl[key]), `placeholders of ${key}`).toEqual(placeholders(en[key]));
		}
	});

	test("spells out every Slovenian plural form for a counted string", () => {
		const bases = pluralBases();
		expect(bases.length).toBeGreaterThan(5);

		for (const base of bases) {
			for (const category of PLURAL_CATEGORIES) {
				const key = `${base}.${category}`;
				expect(KEYS, `${key} in English`).toContain(key as UiKey);
				expect(slovenian[key], `${key} in Slovenian`).toBeString();
			}
		}
	});

	test("picks the Slovenian plural form that matches the count", () => {
		expect(translateCount("sl", "count.days", 1)).toBe("1 dan");
		expect(translateCount("sl", "count.days", 2)).toBe("2 dneva");
		expect(translateCount("sl", "count.days", 3)).toBe("3 dni");
		expect(translateCount("sl", "count.days", 7)).toBe("7 dni");
		expect(translateCount("sl", "count.invoices", 101)).toBe("101 račun");

		expect(translateCount("en", "count.days", 1)).toBe("1 day");
		expect(translateCount("en", "count.days", 4)).toBe("4 days");
	});

	test("actually differs from English where it matters", () => {
		expect(sl["nav.invoices"]).toBe("Računi");
		expect(sl["nav.customers"]).toBe("Kupci");
		expect(sl["editor.total"]).toBe("Skupaj");
		expect(sl["customers.vat_number"]).toBe("ID za DDV");

		const shared = KEYS.filter((key) => sl[key] === en[key]);
		expect(shared.length / KEYS.length).toBeLessThan(0.1);
	});

	test("leaves brand and format names alone", () => {
		expect(sl["processor.bitcoin"]).toBe("Bitcoin");
		expect(sl["field.bank_transfer.iban"]).toBe("IBAN");
		expect(sl["field.bank_transfer.qr_format.upn"]).toContain("UPN QR");
	});

	test("fills in the values a sentence needs", () => {
		expect(translate("sl", "invite.heading", { project: "Bloggy" })).toBe("Pridružite se projektu Bloggy");
		expect(translate("en", "invite.heading", { project: "Bloggy" })).toBe("Join Bloggy");
		expect(translate("en", "invite.heading", {})).toBe("Join {project}");
	});

	test("falls back to English for a language it does not know", () => {
		expect(translate("de" as UiLanguage, "nav.invoices")).toBe("Invoices");
		expect(DEFAULT_UI_LANGUAGE).toBe("en");
	});

	test("recognises the two languages it offers", () => {
		expect(UI_LANGUAGES.map((entry) => entry.value)).toEqual(["en", "sl"]);
		expect(isUiLanguage("sl")).toBe(true);
		expect(isUiLanguage("de")).toBe(false);
		expect(isUiLanguage(7)).toBe(false);
	});

	test("reads the first language the browser offers that this server has", () => {
		expect(preferredLanguage(["sl-SI", "en-GB"])).toBe("sl");
		expect(preferredLanguage(["de-DE", "sl"])).toBe("sl");
		expect(preferredLanguage(["de-DE", "fr"])).toBe("en");
		expect(preferredLanguage([])).toBe("en");
	});

	test("holds one dictionary per offered language", () => {
		for (const language of UI_LANGUAGES) expect(Object.keys(DICTIONARIES[language.value]).length).toBe(KEYS.length);
	});

	test("translates only error codes the server can return", () => {
		const codes = KEYS.filter((key) => key.startsWith("error.")).map((key) => Number(key.slice("error.".length)));
		expect(codes.length).toBeGreaterThan(10);
		for (const code of codes) expect(Errors.get(code), `error.${code}`).toBeDefined();
	});
});
