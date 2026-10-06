const INLINE =
	/(`+)([\s\S]*?[^`])\1(?!`)|!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)|\[((?:[^[\]]|\[[^\]]*\])+)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)|<((?:https?:\/\/|mailto:)[^>\s]+)>|\*\*(?=\S)([\s\S]+?)\*\*|__(?=\S)([\s\S]+?)__|~~(?=\S)([\s\S]+?)~~|\*(?=\S)([\s\S]+?)\*|(?<![A-Za-z0-9])_(?=\S)([\s\S]+?)_(?![A-Za-z0-9])|(?: {2,}|\\)\n/;

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const TASK = /^\[([ xX])\]\s+/;

export const MAX_MARKDOWN_LENGTH = 50_000;

export function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function headingAnchor(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function safeUrl(url: string, images = false): string | null {
	const trimmed = url.trim();
	if (trimmed === "" || /[\u0000-\u001f\s]/.test(trimmed)) return null;
	if (trimmed.startsWith("//")) return null;
	if (trimmed.startsWith("/") || trimmed.startsWith("#")) return images && trimmed.startsWith("#") ? null : trimmed;
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	if (images) return null;
	if (/^(mailto|tel):/i.test(trimmed)) return trimmed;
	if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
	return null;
}

function isExternal(url: string): boolean {
	return /^https?:\/\//i.test(url);
}

function link(text: string, url: string, title: string | undefined): string {
	const target = safeUrl(url);
	if (target === null) return text;
	const external = isExternal(target) ? ' target="_blank" rel="noopener noreferrer nofollow"' : "";
	const heading = title ? ` title="${escapeHtml(title)}"` : "";
	return `<a href="${escapeHtml(target)}"${heading}${external}>${text}</a>`;
}

function image(alt: string, url: string, title: string | undefined): string {
	const source = safeUrl(url, true);
	if (source === null) return escapeHtml(alt);
	const heading = title ? ` title="${escapeHtml(title)}"` : "";
	return `<img src="${escapeHtml(source)}" alt="${escapeHtml(alt)}"${heading} loading="lazy" referrerpolicy="no-referrer">`;
}

export function renderInline(text: string): string {
	let output = "";
	let rest = text;

	for (;;) {
		const match = INLINE.exec(rest);
		if (!match) return output + escapeHtml(rest);

		output += escapeHtml(rest.slice(0, match.index));
		rest = rest.slice(match.index + match[0].length);

		if (match[1] !== undefined) output += `<code>${escapeHtml(match[2].trim())}</code>`;
		else if (match[4] !== undefined) output += image(match[3], match[4], match[5]);
		else if (match[7] !== undefined) output += link(renderInline(match[6]), match[7], match[8]);
		else if (match[9] !== undefined) output += link(escapeHtml(match[9]), match[9], undefined);
		else if (match[10] !== undefined || match[11] !== undefined) output += `<strong>${renderInline(match[10] ?? match[11])}</strong>`;
		else if (match[12] !== undefined) output += `<del>${renderInline(match[12])}</del>`;
		else if (match[13] !== undefined || match[14] !== undefined) output += `<em>${renderInline(match[13] ?? match[14])}</em>`;
		else output += "<br>";
	}
}

function splitRow(line: string): string[] {
	let row = line.trim();
	if (row.startsWith("|")) row = row.slice(1);
	if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);

	const cells: string[] = [];
	let current = "";
	for (let index = 0; index < row.length; index++) {
		if (row[index] === "\\" && row[index + 1] === "|") {
			current += "|";
			index++;
		} else if (row[index] === "|") {
			cells.push(current.trim());
			current = "";
		} else {
			current += row[index];
		}
	}
	cells.push(current.trim());
	return cells;
}

function alignments(divider: string): (string | null)[] {
	return splitRow(divider).map((cell) => {
		const left = cell.startsWith(":");
		const right = cell.endsWith(":");
		if (left && right) return "center";
		if (right) return "right";
		if (left) return "left";
		return null;
	});
}

function cell(tag: "th" | "td", content: string, align: string | null | undefined): string {
	return `<${tag}${align ? ` style="text-align:${align}"` : ""}>${renderInline(content)}</${tag}>`;
}

function startsBlock(lines: string[], index: number): boolean {
	const line = lines[index];
	return (
		FENCE.test(line) ||
		HEADING.test(line) ||
		RULE.test(line) ||
		QUOTE.test(line) ||
		LIST_ITEM.test(line) ||
		(line.includes("|") && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1]) && lines[index + 1].includes("-"))
	);
}

function indentOf(line: string): number {
	return line.match(/^\s*/)![0].replace(/\t/g, "    ").length;
}

function renderList(lines: string[], start: number): { html: string; next: number } {
	const first = lines[start].match(LIST_ITEM)!;
	const baseIndent = indentOf(first[1]);
	const ordered = /\d/.test(first[2]);
	const items: string[] = [];
	let index = start;

	while (index < lines.length) {
		const match = lines[index].match(LIST_ITEM);
		if (!match || indentOf(match[1]) !== baseIndent || /\d/.test(match[2]) !== ordered) break;

		const body: string[] = [match[3]];
		index++;
		while (index < lines.length) {
			const line = lines[index];
			if (line.trim() === "") {
				const following = lines[index + 1];
				if (following !== undefined && following.trim() !== "" && indentOf(following) > baseIndent) {
					body.push("");
					index++;
					continue;
				}
				break;
			}
			const sibling = line.match(LIST_ITEM);
			if (sibling && indentOf(sibling[1]) <= baseIndent) break;
			if (!sibling && indentOf(line) <= baseIndent && startsBlock(lines, index)) break;
			body.push(indentOf(line) > baseIndent ? line.replace(/^\s+/, (space) => space.slice(Math.min(space.length, baseIndent + 2))) : line.trim());
			index++;
		}

		let content = body.join("\n");
		let prefix = "";
		const task = content.match(TASK);
		if (task) {
			prefix = `<input type="checkbox" disabled${task[1] === " " ? "" : " checked"}> `;
			content = content.slice(task[0].length);
		}
		const nested = content
			.split("\n")
			.slice(1)
			.some((line) => startsBlock([line], 0));
		items.push(`<li>${prefix}${nested ? renderBlocks(content.split("\n")) : renderInline(content)}</li>`);

		while (index < lines.length && lines[index].trim() === "" && lines[index + 1]?.match(LIST_ITEM)) {
			const upcoming = lines[index + 1].match(LIST_ITEM)!;
			if (indentOf(upcoming[1]) !== baseIndent) break;
			index++;
		}
	}

	const firstNumber = ordered ? Number(first[2].slice(0, -1)) : 1;
	const tag = ordered ? "ol" : "ul";
	const startAttribute = ordered && firstNumber !== 1 ? ` start="${firstNumber}"` : "";
	return { html: `<${tag}${startAttribute}>${items.join("")}</${tag}>`, next: index };
}

function renderBlocks(lines: string[]): string {
	const output: string[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index];

		if (line.trim() === "") {
			index++;
			continue;
		}

		const fence = line.match(FENCE);
		if (fence) {
			const code: string[] = [];
			index++;
			while (
				index < lines.length &&
				!(lines[index].trim().startsWith(fence[1][0].repeat(fence[1].length)) && lines[index].trim().replace(/[`~]/g, "") === "")
			) {
				code.push(lines[index]);
				index++;
			}
			index++;
			const language = fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : "";
			output.push(`<pre><code${language}>${escapeHtml(code.join("\n"))}</code></pre>`);
			continue;
		}

		const heading = line.match(HEADING);
		if (heading) {
			const level = heading[1].length;
			output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
			index++;
			continue;
		}

		if (RULE.test(line)) {
			output.push("<hr>");
			index++;
			continue;
		}

		if (QUOTE.test(line)) {
			const quoted: string[] = [];
			while (index < lines.length && lines[index].trim() !== "") {
				const match = lines[index].match(QUOTE);
				quoted.push(match ? match[1] : lines[index]);
				index++;
			}
			output.push(`<blockquote>${renderBlocks(quoted)}</blockquote>`);
			continue;
		}

		if (line.includes("|") && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1]) && lines[index + 1].includes("-")) {
			const header = splitRow(line);
			const align = alignments(lines[index + 1]);
			index += 2;
			const rows: string[] = [];
			while (index < lines.length && lines[index].trim() !== "" && lines[index].includes("|")) {
				const cells = splitRow(lines[index]);
				rows.push(`<tr>${header.map((_, column) => cell("td", cells[column] ?? "", align[column])).join("")}</tr>`);
				index++;
			}
			output.push(
				`<div class="md-table"><table><thead><tr>${header.map((content, column) => cell("th", content, align[column])).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
			);
			continue;
		}

		if (LIST_ITEM.test(line)) {
			const list = renderList(lines, index);
			output.push(list.html);
			index = list.next;
			continue;
		}

		const paragraph: string[] = [];
		while (index < lines.length && lines[index].trim() !== "" && (paragraph.length === 0 || !startsBlock(lines, index))) {
			paragraph.push(lines[index].replace(/^\s+/, ""));
			index++;
		}
		output.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
	}

	return output.join("\n");
}

export function renderMarkdown(source: string | null | undefined): string {
	if (!source) return "";
	return renderBlocks(source.slice(0, MAX_MARKDOWN_LENGTH).replace(/\r\n?/g, "\n").split("\n"));
}

export function markdownText(source: string | null | undefined, maxLength = 200): string {
	if (!source) return "";
	const plain = source
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
		.replace(/[*_~`|]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return plain.length > maxLength ? `${plain.slice(0, maxLength - 3).trimEnd()}...` : plain;
}
