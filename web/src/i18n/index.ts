import {
	DEFAULT_UI_LANGUAGE,
	fill,
	hasKey,
	isUiLanguage,
	preferredLanguage,
	translate,
	translateCount,
	UI_LANGUAGES,
	type PluralBase,
	type UiKey,
	type UiLanguage,
} from "./dictionary";

export {
	DEFAULT_UI_LANGUAGE,
	fill,
	hasKey,
	isUiLanguage,
	preferredLanguage,
	translate,
	translateCount,
	UI_LANGUAGES,
	type PluralBase,
	type UiDictionary,
	type UiKey,
	type UiLanguage,
} from "./dictionary";

const STORAGE_KEY = "rabbitpay.language";

function saved(): UiLanguage | null {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		return isUiLanguage(stored) ? stored : null;
	} catch {
		return null;
	}
}

function fromBrowser(): UiLanguage {
	if (typeof navigator === "undefined") return DEFAULT_UI_LANGUAGE;
	return preferredLanguage(navigator.languages ?? [navigator.language]);
}

let current: UiLanguage | null = null;
let forced: UiLanguage | null = null;

export interface StoreTexts {
	code: string;
	base: UiLanguage;
	strings: Record<string, string>;
}

let storeTexts: StoreTexts | null = null;
const pluralRules = new Map<string, Intl.PluralRules>();

function pluralCategory(code: string, count: number): string {
	let rules = pluralRules.get(code);
	if (!rules) {
		try {
			rules = new Intl.PluralRules(code);
		} catch {
			rules = new Intl.PluralRules(DEFAULT_UI_LANGUAGE);
		}
		pluralRules.set(code, rules);
	}
	return rules.select(count);
}

export function language(): UiLanguage {
	if (forced !== null) return forced;
	if (current === null) current = saved() ?? fromBrowser();
	return current;
}

export function useStoreTexts(next: StoreTexts | null) {
	storeTexts = next;
	forced = next?.base ?? null;
	if (typeof document !== "undefined") document.documentElement.lang = locale();
}

export function locale(): string {
	return storeTexts?.code ?? language();
}

export function setLanguage(next: UiLanguage) {
	current = next;

	try {
		localStorage.setItem(STORAGE_KEY, next);
	} catch {
		void 0;
	}

	if (typeof document !== "undefined") document.documentElement.lang = next;
}

export function t(key: UiKey, params?: Record<string, string | number>): string {
	const custom = storeTexts?.strings[key];
	return custom === undefined ? translate(language(), key, params) : fill(custom, params);
}

export function tn(base: PluralBase, count: number, params?: Record<string, string | number>): string {
	const custom = storeTexts?.strings[`${base}.${pluralCategory(storeTexts.code, count)}`];
	return custom === undefined ? translateCount(language(), base, count, params) : fill(custom, { count, ...params });
}

export function has(key: string): key is UiKey {
	return hasKey(key);
}

export function errorText(code: number, fallback: string): string {
	const key = `error.${code}`;
	return has(key) ? t(key) : fallback;
}

export function statusLabel(status: string): string {
	const key = `status.${status}`;
	return has(key) ? t(key) : status.replace(/_/g, " ");
}

export function processorLabel(processor: string): string {
	const key = `processor.${processor}`;
	return has(key) ? t(key) : processor.replace(/_/g, " ");
}

export function transactionTypeLabel(type: string): string {
	const key = `tx_type.${type}`;
	return has(key) ? t(key) : type.replace(/_/g, " ");
}

export function roleLabel(role: string): string {
	const key = `role.${role}`;
	return has(key) ? t(key) : role;
}

export function roleHint(role: string): string {
	const key = `role.${role}.hint`;
	return has(key) ? t(key) : "";
}
