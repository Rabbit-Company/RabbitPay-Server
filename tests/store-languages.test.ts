import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { isLanguageCode, localizeConfig, offeredLanguages, readContent, readStrings, type StoreLanguage } from "../server/store/languages";
import { readProductTranslations } from "../server/store/translations";
import { defaultStoreConfig, type StoreSeller } from "../server/store/config";
import { builtinText, placeholdersOf, storefrontStrings } from "../web/src/storefront/strings";

const WEB = `${import.meta.dir}/../web/src`;
const STOREFRONT_SOURCES = [
	...readdirSync(`${WEB}/storefront`)
		.filter((file) => file.endsWith(".ts"))
		.map((file) => `${WEB}/storefront/${file}`),
	`${WEB}/customer-forms.ts`,
	`${WEB}/views/customer-profile.ts`,
	`${WEB}/lightbox.ts`,
];

function language(code: string, enabled: boolean): StoreLanguage {
	return { code, name: code, builtin: code === "en" || code === "sl", enabled, strings: {}, content: {}, updated: null };
}

describe("store languages", () => {
	test("accepts only canonical language codes", () => {
		for (const code of ["it", "de", "pt-BR", "sr-Latn", "es-419"]) expect(isLanguageCode(code)).toBe(true);
		for (const code of ["IT", "pt-br", "italian", "", "x", "en_US", "../en", 7]) expect(isLanguageCode(code)).toBe(false);
	});

	test("keeps texts with valid keys and drops empty ones", () => {
		expect(readStrings({ "shop.cart": " Carrello ", "shop.search": "  " })).toEqual({ "shop.cart": "Carrello" });
		expect(readStrings({ "Shop.cart": "x" })).toBeNull();
		expect(readStrings({ "shop.cart": "x".repeat(1001) })).toBeNull();
		expect(readStrings({ "shop.cart": 5 })).toBeNull();
		expect(readStrings(["shop.cart"])).toBeNull();
	});

	test("offers the default language first and only the languages that are shown", () => {
		const languages = [language("en", true), language("sl", false), language("it", true), language("de", false)];
		expect(offeredLanguages(languages, "sl").map((entry) => entry.code)).toEqual(["sl", "en", "it"]);
		expect(offeredLanguages(languages, "de").map((entry) => entry.code)).toEqual(["de", "en", "it"]);
	});
});

const seller: StoreSeller = {
	name: "Pixel Parts",
	language: "sl",
	accent: null,
	legal_name: null,
	address: [],
	email: "hello@pixel.test",
	phone: null,
	vat_number: null,
	registration_number: null,
	country: "SI",
};

describe("translated store content", () => {
	test("accepts only known fields within their limits", () => {
		expect(readContent({ tagline: " Ciao ", "shipping.standard": "Spedizione", "page.privacy.content": "Testo", announcement: "" })).toEqual({
			tagline: "Ciao",
			"shipping.standard": "Spedizione",
			"page.privacy.content": "Testo",
		});
		expect(readContent({ "hero.cta_label": "x".repeat(41) })).toBeNull();
		expect(readContent({ "page.Privacy.title": "x" })).toBeNull();
		expect(readContent({ name: "Negozio" })).toBeNull();
		expect(readContent(undefined)).toEqual({});
	});

	test("shows the translated texts and keeps the rest in the default language", () => {
		const config = defaultStoreConfig(seller);
		const localized = localizeConfig(config, {
			"hero.subtitle": "Scopri la nostra offerta.",
			"shipping.standard": "Spedizione standard",
			"page.terms.title": "Condizioni",
		});
		expect(localized.hero.subtitle).toBe("Scopri la nostra offerta.");
		expect(localized.hero.title).toBe(config.hero.title);
		expect(localized.shipping[0].name).toBe("Spedizione standard");
		expect(localized.pages.find((page) => page.slug === "terms")!.title).toBe("Condizioni");
		expect(localized.pages.find((page) => page.slug === "terms")!.content).toBe(config.pages.find((page) => page.slug === "terms")!.content);
	});

	test("reads product translations only for the store's languages", () => {
		expect(readProductTranslations({ it: { name: " Scheda ", summary: "", description: null } }, ["en", "sl", "it"])).toEqual({
			it: { name: "Scheda", summary: null, description: null },
		});
		expect(readProductTranslations({ it: { name: "", summary: null } }, ["it"])).toEqual({});
		expect(readProductTranslations({ de: { name: "Karte" } }, ["it"])).toBeNull();
		expect(readProductTranslations({ it: { name: "x".repeat(201) } }, ["it"])).toBeNull();
		expect(readProductTranslations(undefined, ["it"])).toBeUndefined();
	});
});

describe("the storefront text catalog", () => {
	test("lists every text the storefront code shows", () => {
		const keys = new Set(storefrontStrings("en").map((entry) => entry.key));
		for (const file of STOREFRONT_SOURCES) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(/\bt\("([a-z_]+\.[a-z0-9_.]+)"/g)) expect(keys.has(match[1]!), `${match[1]} in ${file}`).toBe(true);
			for (const match of source.matchAll(/\btn\("([a-z_.]+)"/g)) expect(keys.has(`${match[1]}.other`), `${match[1]} in ${file}`).toBe(true);
		}
	});

	test("asks for the plural forms of the chosen language", () => {
		const forms = (code: string) =>
			storefrontStrings(code)
				.filter((entry) => entry.key.startsWith("count.products."))
				.map((entry) => entry.key.slice("count.products.".length));
		expect(forms("it")).toEqual(new Intl.PluralRules("it").resolvedOptions().pluralCategories);
		expect(forms("it")).toContain("one");
		expect(forms("sl")).toEqual(expect.arrayContaining(["one", "two", "few", "other"]));
		expect(forms("ja")).toEqual(["other"]);
	});

	test("shows the built-in text as the default for plural forms a dictionary lacks", () => {
		expect(builtinText("en", "count.products.many")).toBe("{count} products");
		expect(builtinText("sl", "shop.cart")).toBe("Košarica");
		expect(placeholdersOf("{count} of {total}, {count}")).toEqual(["count", "total"]);
	});
});
