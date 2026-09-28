export interface ComboOption {
	value: string;
	label: string;
	hint?: string;
	keywords?: string;
}

function fold(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

function rank(option: ComboOption, words: string[]): number {
	if (words.length === 0) return 1;

	const label = fold(option.label);
	const haystack = `${label} ${fold(option.hint ?? "")} ${fold(option.keywords ?? "")} ${fold(option.value)}`;
	if (!words.every((word) => haystack.includes(word))) return 0;

	if (label.startsWith(words[0])) return 3;
	if (label.includes(words[0])) return 2;
	return 1;
}

export function filterOptions(options: ComboOption[], query: string, limit = 50): ComboOption[] {
	const words = fold(query).split(/\s+/).filter(Boolean);

	return options
		.map((option, index) => ({ option, index, score: rank(option, words) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, limit)
		.map((entry) => entry.option);
}
