import { en } from "../i18n/en";
import { translate, type UiKey, type UiLanguage } from "../i18n/dictionary";

export const PLURAL_BASES = ["count.products", "count.days", "count.employees"] as const;

export type StringGroupId = "store" | "customer" | "labels" | "errors" | "general";

interface GroupRule {
	id: StringGroupId;
	prefixes: string[];
	keys: string[];
}

const RULES: GroupRule[] = [
	{ id: "store", prefixes: ["shop."], keys: [] },
	{
		id: "customer",
		prefixes: ["forms.", "profile."],
		keys: [
			"login.email",
			"portal.orders",
			"portal.status",
			"portal.store",
			"portal.total",
			"invoices.column_reference",
			"store.fulfillment",
			"store.order_date",
		],
	},
	{ id: "labels", prefixes: ["status.", "processor."], keys: [] },
	{ id: "errors", prefixes: ["error."], keys: [] },
	{
		id: "general",
		prefixes: [],
		keys: [
			"app.language",
			"app.sign_out",
			"ui.cancel",
			"ui.close",
			"ui.copied",
			"ui.copy",
			"ui.copy_failed",
			"ui.error_generic",
			"ui.load_failed",
			"ui.no_matches",
			"ui.save",
		],
	},
];

export interface StringEntry {
	key: string;
	group: StringGroupId;
	english: string;
}

function pluralCategories(code: string): string[] {
	try {
		return new Intl.PluralRules(code).resolvedOptions().pluralCategories;
	} catch {
		return ["one", "other"];
	}
}

function isPluralKey(key: string): boolean {
	return PLURAL_BASES.some((base) => key.startsWith(`${base}.`));
}

function englishOf(key: string): string {
	const dictionary: Record<string, string> = en;
	if (key in dictionary) return dictionary[key]!;
	const base = PLURAL_BASES.find((entry) => key.startsWith(`${entry}.`));
	return base ? (dictionary[`${base}.other`] ?? key) : key;
}

export function storefrontStrings(code: string): StringEntry[] {
	const keys = Object.keys(en).filter((key) => !isPluralKey(key));
	const entries: StringEntry[] = [];
	for (const rule of RULES) {
		for (const key of keys) {
			if (rule.keys.includes(key) || rule.prefixes.some((prefix) => key.startsWith(prefix))) entries.push({ key, group: rule.id, english: englishOf(key) });
		}
		if (rule.id === "labels") {
			for (const base of PLURAL_BASES) {
				for (const category of pluralCategories(code)) {
					const key = `${base}.${category}`;
					entries.push({ key, group: rule.id, english: englishOf(key) });
				}
			}
		}
	}
	return entries;
}

export function builtinText(language: UiLanguage, key: string): string {
	const base = PLURAL_BASES.find((entry) => key.startsWith(`${entry}.`));
	if (base) {
		const dictionaryKey = (key in en ? key : `${base}.other`) as UiKey;
		return translate(language, dictionaryKey);
	}
	return translate(language, key as UiKey);
}

export function placeholdersOf(text: string): string[] {
	return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!))].sort();
}
