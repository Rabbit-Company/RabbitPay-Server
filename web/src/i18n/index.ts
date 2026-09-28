import {
	DEFAULT_UI_LANGUAGE,
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

export function language(): UiLanguage {
	if (forced !== null) return forced;
	if (current === null) current = saved() ?? fromBrowser();
	return current;
}

export function forceLanguage(next: UiLanguage | null) {
	forced = next;
	if (typeof document !== "undefined") document.documentElement.lang = language();
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
	return translate(language(), key, params);
}

export function tn(base: PluralBase, count: number, params?: Record<string, string | number>): string {
	return translateCount(language(), base, count, params);
}

export function has(key: string): key is UiKey {
	return hasKey(key);
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
