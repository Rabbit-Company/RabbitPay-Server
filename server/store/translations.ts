import type { SQL } from "bun";
import Database from "../database/database";
import { MAX_MARKDOWN_LENGTH } from "../markdown";
import type { StoreCategoryRow, StoreCategoryTranslationRow, StoreProductTranslationRow } from "../database/models";

export interface ProductText {
	name: string | null;
	summary: string | null;
	description: string | null;
}

export interface CategoryText {
	name: string | null;
	description: string | null;
}

const PRODUCT_LIMITS: Record<keyof ProductText, number> = { name: 200, summary: 300, description: MAX_MARKDOWN_LENGTH };
const CATEGORY_LIMITS: Record<keyof CategoryText, number> = { name: 120, description: 2000 };

function readTexts<T extends object>(value: unknown, languages: string[], limits: Record<keyof T & string, number>): Record<string, T> | null | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const result: Record<string, T> = {};
	for (const [language, entry] of Object.entries(value as Record<string, unknown>)) {
		if (!languages.includes(language) || typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
		const text: Record<string, string | null> = {};
		for (const [field, limit] of Object.entries(limits) as [string, number][]) {
			const raw = (entry as Record<string, unknown>)[field];
			if (raw !== undefined && raw !== null && (typeof raw !== "string" || raw.length > limit)) return null;
			text[field] = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
		}
		if (Object.values(text).some((field) => field !== null)) result[language] = text as T;
	}
	return result;
}

export function readProductTranslations(value: unknown, languages: string[]) {
	return readTexts<ProductText>(value, languages, PRODUCT_LIMITS);
}

export function readCategoryTranslations(value: unknown, languages: string[]) {
	return readTexts<CategoryText>(value, languages, CATEGORY_LIMITS);
}

export async function productTranslationsOf(item: string): Promise<Record<string, ProductText>> {
	const rows = (await Database`SELECT * FROM store_product_translations WHERE item = ${item} ORDER BY language ASC`) as StoreProductTranslationRow[];
	return Object.fromEntries(rows.map((row) => [row.language, { name: row.name, summary: row.summary, description: row.description }]));
}

export async function categoryTranslationsOf(projectId: string): Promise<Map<string, Record<string, CategoryText>>> {
	const rows = (await Database`
		SELECT * FROM store_category_translations WHERE project = ${projectId} ORDER BY language ASC
	`) as StoreCategoryTranslationRow[];
	const grouped = new Map<string, Record<string, CategoryText>>();
	for (const row of rows) {
		const texts = grouped.get(row.store_category) ?? {};
		texts[row.language] = { name: row.name, description: row.description };
		grouped.set(row.store_category, texts);
	}
	return grouped;
}

export async function writeProductTranslations(tx: SQL, projectId: string, item: string, translations: Record<string, ProductText>, now: number) {
	await tx`DELETE FROM store_product_translations WHERE item = ${item}`;
	for (const [language, text] of Object.entries(translations)) {
		await tx`
			INSERT INTO store_product_translations(item, language, project, name, summary, description, updated)
			VALUES(${item}, ${language}, ${projectId}, ${text.name}, ${text.summary}, ${text.description}, ${now})
		`;
	}
}

export async function writeCategoryTranslations(tx: SQL, projectId: string, category: string, translations: Record<string, CategoryText>, now: number) {
	await tx`DELETE FROM store_category_translations WHERE store_category = ${category}`;
	for (const [language, text] of Object.entries(translations)) {
		await tx`
			INSERT INTO store_category_translations(store_category, language, project, name, description, updated)
			VALUES(${category}, ${language}, ${projectId}, ${text.name}, ${text.description}, ${now})
		`;
	}
}

export async function productTexts(itemIds: string[], language: string | null): Promise<Map<string, ProductText>> {
	if (language === null || itemIds.length === 0) return new Map();
	const rows = (await Database`
		SELECT * FROM store_product_translations WHERE language = ${language} AND item IN ${Database(itemIds)}
	`) as StoreProductTranslationRow[];
	return new Map(rows.map((row) => [row.item, { name: row.name, summary: row.summary, description: row.description }]));
}

export async function translatedCategories(projectId: string, categories: StoreCategoryRow[], language: string | null): Promise<StoreCategoryRow[]> {
	if (language === null) return categories;
	const rows = (await Database`
		SELECT * FROM store_category_translations WHERE project = ${projectId} AND language = ${language}
	`) as StoreCategoryTranslationRow[];
	const texts = new Map(rows.map((row) => [row.store_category, row]));
	return categories.map((category) => {
		const text = texts.get(category.uuid);
		return text ? { ...category, name: text.name ?? category.name, description: text.description ?? category.description } : category;
	});
}
