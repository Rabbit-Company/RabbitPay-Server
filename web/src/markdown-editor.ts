import { el } from "./dom";
import { t, type UiKey } from "./i18n";
import { renderMarkdown } from "../../server/markdown";
import { zoomableImages } from "./lightbox";
import { applyStorePreviewTheme } from "./storefront/layout";

interface MarkdownEditorOptions {
	value?: string;
	rows?: number;
	placeholder?: string;
	maxlength?: number;
	required?: boolean;
	hint?: string;
	storeTheme?: Parameters<typeof applyStorePreviewTheme>[1];
}

interface Tool {
	label: string;
	title: UiKey;
	shortcut?: string;
	className?: string;
	apply: (textarea: HTMLTextAreaElement) => void;
}

function replaceSelection(textarea: HTMLTextAreaElement, text: string) {
	textarea.focus();
	if (!document.execCommand("insertText", false, text)) {
		textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, "end");
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	}
}

function wrap(textarea: HTMLTextAreaElement, before: string, after: string, placeholder: string) {
	const start = textarea.selectionStart;
	const selected = textarea.value.slice(start, textarea.selectionEnd) || placeholder;
	replaceSelection(textarea, `${before}${selected}${after}`);
	textarea.setSelectionRange(start + before.length, start + before.length + selected.length);
}

function prefixLines(textarea: HTMLTextAreaElement, prefix: (index: number) => string) {
	const { value } = textarea;
	const start = value.lastIndexOf("\n", textarea.selectionStart - 1) + 1;
	const lineEnd = value.indexOf("\n", textarea.selectionEnd);
	const end = lineEnd === -1 ? value.length : lineEnd;
	textarea.setSelectionRange(start, end);
	const lines = value.slice(start, end).split("\n");
	replaceSelection(textarea, lines.map((line, index) => `${prefix(index)}${line}`).join("\n"));
}

function insertLink(textarea: HTMLTextAreaElement) {
	const start = textarea.selectionStart;
	const selected = textarea.value.slice(start, textarea.selectionEnd) || t("markdown.link_text");
	const url = "https://";
	replaceSelection(textarea, `[${selected}](${url})`);
	const urlStart = start + selected.length + 3;
	textarea.setSelectionRange(urlStart, urlStart + url.length);
}

function insertCode(textarea: HTMLTextAreaElement) {
	const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
	if (selected.includes("\n")) wrap(textarea, "```\n", "\n```", "");
	else wrap(textarea, "`", "`", t("markdown.code_text"));
}

const TOOLS: Tool[] = [
	{ label: "B", title: "markdown.bold", shortcut: "b", className: "md-tool-bold", apply: (area) => wrap(area, "**", "**", t("markdown.bold_text")) },
	{ label: "I", title: "markdown.italic", shortcut: "i", className: "md-tool-italic", apply: (area) => wrap(area, "*", "*", t("markdown.italic_text")) },
	{ label: "S", title: "markdown.strike", className: "md-tool-strike", apply: (area) => wrap(area, "~~", "~~", t("markdown.strike_text")) },
	{ label: "</>", title: "markdown.code", shortcut: "e", apply: insertCode },
	{ label: "Link", title: "markdown.link", shortcut: "k", apply: insertLink },
	{ label: "-", title: "markdown.bullets", apply: (area) => prefixLines(area, () => "- ") },
	{ label: "1.", title: "markdown.numbers", apply: (area) => prefixLines(area, (index) => `${index + 1}. `) },
	{ label: ">", title: "markdown.quote", apply: (area) => prefixLines(area, () => "> ") },
];

export function markdownView(source: string, className = ""): HTMLElement {
	const view = el("div", { class: `sf-prose markdown-body${className ? ` ${className}` : ""}` });
	view.innerHTML = renderMarkdown(source);
	zoomableImages(view);
	return view;
}

export function markdownEditor(options: MarkdownEditorOptions = {}): { element: HTMLElement; textarea: HTMLTextAreaElement } {
	const textarea = el("textarea", {
		rows: String(options.rows ?? 6),
		placeholder: options.placeholder ?? "",
		maxlength: options.maxlength ? String(options.maxlength) : undefined,
		required: options.required,
	});
	textarea.value = options.value ?? "";
	const preview = el("div", { class: "markdown-preview sf-prose markdown-body" });
	if (options.storeTheme) applyStorePreviewTheme(preview, options.storeTheme);
	preview.hidden = true;

	const toolbar = el(
		"div",
		{ class: "md-toolbar" },
		...TOOLS.map((tool) =>
			el(
				"button",
				{
					class: `md-tool${tool.className ? ` ${tool.className}` : ""}`,
					type: "button",
					title: tool.shortcut ? `${t(tool.title)} (Ctrl+${tool.shortcut.toUpperCase()})` : t(tool.title),
					onClick: () => tool.apply(textarea),
				},
				tool.label
			)
		)
	);

	textarea.addEventListener("keydown", (event) => {
		if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
		const tool = TOOLS.find((candidate) => candidate.shortcut === event.key.toLowerCase());
		if (!tool) return;
		event.preventDefault();
		tool.apply(textarea);
	});

	const write = el("button", { class: "segment active", type: "button" }, t("store.write"));
	const show = el("button", { class: "segment", type: "button" }, t("store.preview"));
	const showWrite = (writing: boolean) => {
		if (!writing) {
			preview.style.minHeight = `${textarea.offsetHeight}px`;
			preview.innerHTML = renderMarkdown(textarea.value) || `<p class="muted">${t("store.preview_empty")}</p>`;
			zoomableImages(preview);
		}
		preview.hidden = writing;
		textarea.hidden = !writing;
		toolbar.hidden = !writing;
		write.classList.toggle("active", writing);
		show.classList.toggle("active", !writing);
		if (writing) textarea.focus();
	};
	write.addEventListener("click", () => showWrite(true));
	show.addEventListener("click", () => showWrite(false));

	return {
		textarea,
		element: el(
			"div",
			{ class: "markdown-editor" },
			el("div", { class: "markdown-bar" }, el("div", { class: "segmented" }, write, show), toolbar),
			textarea,
			preview,
			el("span", { class: "field-hint" }, options.hint ?? t("markdown.hint"))
		),
	};
}
