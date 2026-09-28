import { en } from "./en";
import { sl } from "./sl";

export type UiLanguage = "en" | "sl";
export type UiKey = keyof typeof en;
export type UiDictionary = Record<UiKey, string>;
type PluralBaseOf<Key> = Key extends `${infer Base}.other` ? Base : never;
export type PluralBase = PluralBaseOf<UiKey>;

export const UI_LANGUAGES: { value: UiLanguage; label: string }[] = [
	{ value: "en", label: "English" },
	{ value: "sl", label: "Slovenščina" },
];

export const DEFAULT_UI_LANGUAGE: UiLanguage = "en";

const DICTIONARIES: Record<UiLanguage, UiDictionary> = { en, sl };

export function isUiLanguage(value: unknown): value is UiLanguage {
	return typeof value === "string" && UI_LANGUAGES.some((entry) => entry.value === value);
}

export function preferredLanguage(tags: readonly string[]): UiLanguage {
	for (const tag of tags) {
		const code = String(tag ?? "")
			.slice(0, 2)
			.toLowerCase();
		if (isUiLanguage(code)) return code;
	}

	return DEFAULT_UI_LANGUAGE;
}

export function fill(template: string, params?: Record<string, string | number>): string {
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

function dictionaryFor(target: UiLanguage): UiDictionary {
	return DICTIONARIES[target] ?? en;
}

export function translate(target: UiLanguage, key: UiKey, params?: Record<string, string | number>): string {
	const template = dictionaryFor(target)[key] ?? en[key] ?? key;
	return fill(template, params);
}

export function hasKey(key: string): key is UiKey {
	return key in en;
}

const plurals = new Map<UiLanguage, Intl.PluralRules>();

function categoryFor(target: UiLanguage, count: number): string {
	let rules = plurals.get(target);
	if (!rules) {
		rules = new Intl.PluralRules(isUiLanguage(target) ? target : DEFAULT_UI_LANGUAGE);
		plurals.set(target, rules);
	}

	return rules.select(count);
}

export function translateCount(target: UiLanguage, base: PluralBase, count: number, params?: Record<string, string | number>): string {
	const dictionary = dictionaryFor(target);
	const chosen = `${base}.${categoryFor(target, count)}` as UiKey;
	const template = dictionary[chosen] ?? dictionary[`${base}.other` as UiKey] ?? base;

	return fill(template, { count, ...params });
}
