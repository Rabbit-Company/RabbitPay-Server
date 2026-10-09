import hljs from "highlight.js/lib/common";

const MAX_HIGHLIGHT_LENGTH = 100_000;

function escaped(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function highlightCode(code: string, language: string): string {
	if (language === "" || code.length > MAX_HIGHLIGHT_LENGTH || hljs.getLanguage(language) === undefined) return escaped(code);
	try {
		return hljs.highlight(code, { language, ignoreIllegals: true }).value;
	} catch {
		return escaped(code);
	}
}
