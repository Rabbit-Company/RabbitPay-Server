import Database from "../database/database";
import { LANGUAGES } from "../i18n";
import { MAX_MARKDOWN_LENGTH } from "../markdown";
import { STORE_LANGUAGES, type StoreConfig } from "./config";

import { isLanguageCode } from "./config";

export { isLanguageCode };
import type { StoreLanguageRow } from "../database/models";

export const MAX_STORE_LANGUAGES = 10;
export const MAX_LANGUAGE_NAME = 60;
export const MAX_STRING_LENGTH = 1000;
export const MAX_STRINGS = 2000;

export type StoreStrings = Record<string, string>;
export type StoreContent = Record<string, string>;

const CONTENT_LIMITS: Record<string, number> = {
	tagline: 200,
	description: 500,
	announcement: 200,
	footer_text: 1000,
	"hero.title": 120,
	"hero.subtitle": 300,
	"hero.cta_label": 40,
	"location.name": 120,
	"location.note": 300,
};
const MAX_CONTENT_SIZE = 1_000_000;

export interface StoreLanguage {
	code: string;
	name: string;
	builtin: boolean;
	enabled: boolean;
	strings: StoreStrings;
	content: StoreContent;
	updated: number | null;
}

const KEY = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+){1,4}$/;

export function isBuiltinLanguage(code: string): boolean {
	return (STORE_LANGUAGES as readonly string[]).includes(code);
}

export function builtinName(code: string): string {
	return LANGUAGES.find((entry) => entry.value === code)?.label ?? code;
}

export function readLanguageName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const name = value.trim();
	return name.length >= 1 && name.length <= MAX_LANGUAGE_NAME ? name : null;
}

export function readStrings(value: unknown): StoreStrings | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > MAX_STRINGS) return null;
	const strings: StoreStrings = {};
	for (const [key, text] of entries) {
		if (key.length > 100 || !KEY.test(key) || typeof text !== "string" || text.length > MAX_STRING_LENGTH) return null;
		const trimmed = text.trim();
		if (trimmed !== "") strings[key] = trimmed;
	}
	return strings;
}

function contentLimit(key: string): number | null {
	if (key in CONTENT_LIMITS) return CONTENT_LIMITS[key]!;
	if (/^shipping\.[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) && key.length <= 60) return 120;
	const page = key.match(/^page\.([a-z0-9]+(?:-[a-z0-9]+)*)\.(title|content)$/);
	if (page && page[1]!.length <= 60) return page[2] === "title" ? 120 : MAX_MARKDOWN_LENGTH;
	return null;
}

export function readContent(value: unknown): StoreContent | null {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const content: StoreContent = {};
	let size = 0;
	for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
		const limit = contentLimit(key);
		if (limit === null || typeof text !== "string" || text.length > limit) return null;
		size += text.length;
		const trimmed = text.trim();
		if (trimmed !== "") content[key] = trimmed;
	}
	return size <= MAX_CONTENT_SIZE ? content : null;
}

export function localizeConfig(config: StoreConfig, content: StoreContent): StoreConfig {
	const pick = <T extends string | null>(key: string, value: T): string | T => content[key] ?? value;
	return {
		...config,
		tagline: pick("tagline", config.tagline),
		description: pick("description", config.description),
		announcement: pick("announcement", config.announcement),
		footer_text: pick("footer_text", config.footer_text),
		hero: {
			...config.hero,
			title: pick("hero.title", config.hero.title),
			subtitle: pick("hero.subtitle", config.hero.subtitle),
			cta_label: pick("hero.cta_label", config.hero.cta_label),
		},
		location: { ...config.location, name: pick("location.name", config.location.name), note: pick("location.note", config.location.note) },
		shipping: config.shipping.map((option) => ({ ...option, name: pick(`shipping.${option.id}`, option.name) })),
		pages: config.pages.map((page) => ({
			...page,
			title: pick(`page.${page.slug}.title`, page.title),
			content: pick(`page.${page.slug}.content`, page.content),
		})),
	};
}

function parseStrings(raw: string): StoreStrings {
	try {
		return readStrings(JSON.parse(raw)) ?? {};
	} catch {
		return {};
	}
}

function parseContent(raw: string): StoreContent {
	try {
		return readContent(JSON.parse(raw)) ?? {};
	} catch {
		return {};
	}
}

function present(row: StoreLanguageRow): StoreLanguage {
	const builtin = isBuiltinLanguage(row.language);
	return {
		code: row.language,
		name: builtin ? builtinName(row.language) : row.name,
		builtin,
		enabled: Boolean(row.enabled),
		strings: parseStrings(row.strings),
		content: parseContent(row.content),
		updated: row.updated,
	};
}

export async function storeLanguages(projectId: string): Promise<StoreLanguage[]> {
	const rows = (await Database`SELECT * FROM store_languages WHERE project = ${projectId} ORDER BY created ASC`) as StoreLanguageRow[];
	const stored = rows.map(present);
	const builtins = STORE_LANGUAGES.map(
		(code): StoreLanguage =>
			stored.find((entry) => entry.code === code) ?? { code, name: builtinName(code), builtin: true, enabled: false, strings: {}, content: {}, updated: null }
	);
	return [...builtins, ...stored.filter((entry) => !entry.builtin)];
}

export function offeredLanguages(languages: StoreLanguage[], fallback: string): StoreLanguage[] {
	const main = languages.find((entry) => entry.code === fallback);
	const others = languages.filter((entry) => entry.enabled && entry.code !== fallback);
	return main ? [main, ...others] : others;
}

export interface LanguageInput {
	name: string;
	enabled: boolean;
	strings: StoreStrings;
	content: StoreContent;
}

export async function saveStoreLanguage(projectId: string, code: string, input: LanguageInput, now = Date.now()) {
	const { name, enabled, strings } = input;
	const [existing] = (await Database`SELECT language FROM store_languages WHERE project = ${projectId} AND language = ${code}`) as Pick<
		StoreLanguageRow,
		"language"
	>[];
	const stored = JSON.stringify(strings);
	const content = JSON.stringify(input.content);
	if (existing) {
		await Database`
			UPDATE store_languages SET name = ${name}, enabled = ${enabled ? 1 : 0}, strings = ${stored}, content = ${content}, updated = ${now}
			WHERE project = ${projectId} AND language = ${code}
		`;
		return;
	}
	await Database`
		INSERT INTO store_languages(project, language, name, enabled, strings, content, created, updated)
		VALUES(${projectId}, ${code}, ${name}, ${enabled ? 1 : 0}, ${stored}, ${content}, ${now}, ${now})
	`;
}

export async function removeStoreLanguage(projectId: string, code: string) {
	await Database.begin(async (tx) => {
		await tx`DELETE FROM store_product_translations WHERE project = ${projectId} AND language = ${code}`;
		await tx`DELETE FROM store_category_translations WHERE project = ${projectId} AND language = ${code}`;
		await tx`DELETE FROM store_languages WHERE project = ${projectId} AND language = ${code}`;
	});
}

export async function contentLanguage(projectId: string, fallback: string, requested: string | null): Promise<StoreLanguage | null> {
	if (!requested || requested === fallback || !isLanguageCode(requested)) return null;
	const language = (await storeLanguages(projectId)).find((entry) => entry.code === requested);
	return language?.enabled ? language : null;
}
