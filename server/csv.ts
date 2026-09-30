const DELIMITERS = [";", ",", "\t"];

function detectDelimiter(text: string): string {
	const firstLine = text.slice(0, text.search(/\r?\n|$/));
	let best = ",";
	let bestCount = 0;
	for (const delimiter of DELIMITERS) {
		let count = 0;
		let quoted = false;
		for (const character of firstLine) {
			if (character === '"') quoted = !quoted;
			else if (!quoted && character === delimiter) count++;
		}
		if (count > bestCount) {
			best = delimiter;
			bestCount = count;
		}
	}
	return best;
}

export class CsvUnreadable extends Error {}

export function parseCsv(input: string): string[][] {
	const text = input.replace(/^﻿/, "");
	const delimiter = detectDelimiter(text);
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (quoted) {
			if (character === '"' && text[index + 1] === '"') {
				cell += '"';
				index++;
			} else if (character === '"') quoted = false;
			else cell += character;
			continue;
		}
		if (character === '"' && cell === "") quoted = true;
		else if (character === delimiter) {
			row.push(cell);
			cell = "";
		} else if (character === "\n" || character === "\r") {
			if (character === "\r" && text[index + 1] === "\n") index++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else cell += character;
	}
	if (quoted) throw new CsvUnreadable("A quoted value is not closed.");
	if (cell !== "" || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}
	return rows.filter((cells) => cells.some((value) => value.trim() !== ""));
}

export function csvHeader(value: string): string {
	return value
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_|_$/g, "");
}
