export const DEFAULT_INVOICE_FORMAT = "YYMMDDXXXXXX";
export const MAX_FORMAT_LENGTH = 30;
export const MAX_SEQUENCE_DIGITS = 9;

export type NumberingPeriod = "day" | "month" | "year" | "never";

type Token = { kind: "literal"; text: string } | { kind: "year"; digits: 2 | 4 } | { kind: "month" } | { kind: "day" } | { kind: "sequence"; digits: number };

export interface InvoiceFormat {
	source: string;
	tokens: Token[];
	digits: number;
	period: NumberingPeriod;
	capacity: number;
}

export type ParsedInvoiceFormat = { ok: true; format: InvoiceFormat } | { ok: false; error: string };

const LITERAL = /^[A-Z0-9/\-._#]$/;
const CODES = new Set(["Y", "M", "D", "X"]);

function fail(error: string): ParsedInvoiceFormat {
	return { ok: false, error };
}

export function parseInvoiceFormat(input: unknown): ParsedInvoiceFormat {
	if (typeof input !== "string") return fail("Enter a format.");
	const source = input.trim().toUpperCase();
	if (source === "") return fail("Enter a format.");
	if (source.length > MAX_FORMAT_LENGTH) return fail(`A format can be at most ${MAX_FORMAT_LENGTH} characters long.`);
	if (source.startsWith("DRAFT")) return fail("A format cannot start with DRAFT, drafts use that.");

	const tokens: Token[] = [];
	const seen = new Set<string>();

	for (let index = 0; index < source.length; ) {
		const character = source[index];
		let end = index;
		while (end < source.length && source[end] === character) end++;
		const run = end - index;

		if (!CODES.has(character)) {
			if (!LITERAL.test(character)) return fail(`"${character}" cannot be used. Around the codes, use letters, digits and / - . _ #`);
			const previous = tokens[tokens.length - 1];
			const text = character.repeat(run);
			if (previous?.kind === "literal") previous.text += text;
			else tokens.push({ kind: "literal", text });
			index = end;
			continue;
		}

		if (seen.has(character)) return fail(`${character} can only appear once, as one group.`);
		seen.add(character);

		if (character === "Y") {
			if (run !== 2 && run !== 4) return fail("Write the year as YY or YYYY.");
			tokens.push({ kind: "year", digits: run as 2 | 4 });
		} else if (character === "M") {
			if (run !== 2) return fail("Write the month as MM.");
			tokens.push({ kind: "month" });
		} else if (character === "D") {
			if (run !== 2) return fail("Write the day as DD.");
			tokens.push({ kind: "day" });
		} else {
			if (run > MAX_SEQUENCE_DIGITS) return fail(`Use at most ${MAX_SEQUENCE_DIGITS} X for the number.`);
			tokens.push({ kind: "sequence", digits: run });
		}
		index = end;
	}

	const sequence = tokens.find((token) => token.kind === "sequence");
	if (!sequence) return fail("Add X where the invoice number goes, one X per digit.");
	if (seen.has("D") && !seen.has("M")) return fail("A format with the day (DD) also needs the month (MM), or numbers would repeat.");
	if (seen.has("M") && !seen.has("Y")) return fail("A format with the month (MM) also needs the year (YY or YYYY), or numbers would repeat.");

	const period: NumberingPeriod = seen.has("D") ? "day" : seen.has("M") ? "month" : seen.has("Y") ? "year" : "never";
	const digits = sequence.digits;

	return { ok: true, format: { source, tokens, digits, period, capacity: 10 ** digits - 1 } };
}

function pad(value: number, length: number): string {
	return String(value).padStart(length, "0");
}

export function renderInvoiceNumber(format: InvoiceFormat, timestamp: number, sequence: number, timezone?: string): string {
	const date = new Date(timestamp);
	const local = timezone ? zonedParts(timestamp, timezone) : null;
	const year = local?.year ?? date.getFullYear();
	const month = local?.month ?? date.getMonth() + 1;
	const day = local?.day ?? date.getDate();
	return format.tokens
		.map((token) => {
			switch (token.kind) {
				case "literal":
					return token.text;
				case "year":
					return token.digits === 4 ? pad(year, 4) : pad(year % 100, 2);
				case "month":
					return pad(month, 2);
				case "day":
					return pad(day, 2);
				case "sequence":
					return pad(sequence, token.digits);
			}
		})
		.join("");
}

export function periodKey(format: InvoiceFormat, timestamp: number, timezone?: string): string {
	const date = new Date(timestamp);
	const local = timezone ? zonedParts(timestamp, timezone) : null;
	const year = pad(local?.year ?? date.getFullYear(), 4);
	const month = pad(local?.month ?? date.getMonth() + 1, 2);
	const day = pad(local?.day ?? date.getDate(), 2);

	switch (format.period) {
		case "day":
			return `${year.slice(2)}${month}${day}`;
		case "month":
			return `M${year}${month}`;
		case "year":
			return `Y${year}`;
		case "never":
			return "ALL";
	}
}

const PERIOD_WORDS: Record<NumberingPeriod, { every: string; restart: string }> = {
	day: { every: "a day", restart: "Numbering starts again at 1 every day." },
	month: { every: "a month", restart: "Numbering starts again at 1 on the first of every month." },
	year: { every: "a year", restart: "Numbering starts again at 1 on 1 January." },
	never: { every: "in total", restart: "Numbering never starts again, it keeps counting up." },
};

export function describeInvoiceFormat(format: InvoiceFormat): string {
	const words = PERIOD_WORDS[format.period];
	return `Up to ${format.capacity.toLocaleString("en")} invoices ${words.every}. ${words.restart}`;
}
import { zonedParts } from "./timezone";
