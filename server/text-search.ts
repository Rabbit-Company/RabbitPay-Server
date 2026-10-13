import type { SQL } from "bun";
import { dialect } from "./database/database";

export type SearchFragment = SQL.Query<unknown>;

const LIKE_SPECIAL = /[!%_]/g;
const EXACT_CASINGS = 5;

function hasCase(character: string): boolean {
	return character.toLowerCase() !== character.toUpperCase();
}

function isAscii(character: string): boolean {
	return character.charCodeAt(0) < 128;
}

function casings(lowered: string[]): string[] {
	const cased = lowered.flatMap((character, index) => (hasCase(character) && !isAscii(character) ? [index] : []));
	if (cased.length === 0) return [lowered.join("")];

	if (cased.length <= EXACT_CASINGS) {
		return Array.from({ length: 1 << cased.length }, (_, mask) => {
			const characters = [...lowered];
			cased.forEach((index, bit) => {
				if (mask & (1 << bit)) characters[index] = characters[index].toUpperCase();
			});
			return characters.join("");
		});
	}

	const upper = lowered.map((character, index) => (cased.includes(index) ? character.toUpperCase() : character));
	const titled = lowered.map((character, index) =>
		cased.includes(index) && (index === 0 || /\s/.test(lowered[index - 1])) ? character.toUpperCase() : character
	);
	return [...new Set([lowered.join(""), upper.join(""), titled.join("")])];
}

export function searchPatterns(query: string, foldsEveryLetter = dialect !== "sqlite"): string[] {
	const lowered = query.toLowerCase().replace(LIKE_SPECIAL, (character) => `!${character}`);
	const variants = foldsEveryLetter ? [lowered] : casings([...lowered]);
	return variants.map((variant) => `%${variant}%`);
}

export function textLike(sql: SQL, expression: SearchFragment, patterns: string[]): SearchFragment {
	const conditions = patterns.map((pattern) => sql`LOWER(COALESCE(${expression}, '')) LIKE ${pattern} ESCAPE '!'`);
	return sql`(${conditions.reduce((all, condition) => sql`${all} OR ${condition}`)})`;
}

export function textSearch(sql: SQL, query: string, expressions: SearchFragment[]): SearchFragment {
	const patterns = searchPatterns(query);
	const conditions = expressions.map((expression) => textLike(sql, expression, patterns));
	return sql`(${conditions.reduce((all, condition) => sql`${all} OR ${condition}`)})`;
}
