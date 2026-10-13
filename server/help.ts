import { HELP_SOURCES } from "./help-sources";
import { renderHelp } from "./help-render";
import { escapeHtml, headingAnchor, markdownText } from "./markdown";

export const HELP_LANGUAGES = ["en", "sl"] as const;
export const HELP_SEED_ID = "rabbitpay-help";
export type HelpLanguage = (typeof HELP_LANGUAGES)[number];

export interface HelpSummary {
	slug: string;
	title: string;
	description: string;
	sections: string[];
}

export interface HelpModuleSummary extends HelpSummary {
	pages: HelpSummary[];
}

export interface HelpDocument extends HelpSummary {
	module: string;
	page: string | null;
	content: string;
}

export interface HelpSearchResult {
	path: string;
	title: string;
	context: string;
	snippet: string;
}

export interface HelpIndex {
	title: string;
	description: string;
	modules: HelpModuleSummary[];
}

const INDEX: Record<HelpLanguage, { title: string; description: string; pages: string }> = {
	en: {
		title: "Help",
		description: "Step by step guides to invoicing, payments and everything else you do in RabbitPay.",
		pages: "In this guide",
	},
	sl: {
		title: "Pomoč",
		description: "Vodniki po korakih za izdajanje računov, plačila in vse drugo, kar počnete v RabbitPayu.",
		pages: "V tem vodniku",
	},
};

const TITLE = /^#\s+(.+?)\s*$/m;
const SECTION = /^## (.+?)\s*$/gm;
const DESCRIPTION_LENGTH = 200;

export function isHelpLanguage(value: unknown): value is HelpLanguage {
	return HELP_LANGUAGES.includes(value as HelpLanguage);
}

export function parseHelpDocument(module: string, page: string | null, source: string): HelpDocument {
	const slug = page ?? module;
	const text = source.replace(/\r\n?/g, "\n").trim();
	const heading = text.match(TITLE);
	const content = heading ? text.slice((heading.index ?? 0) + heading[0].length).trim() : text;
	return {
		module,
		page,
		slug,
		title: heading?.[1] ?? slug,
		description: markdownText(content.split(/\n\s*\n/)[0], DESCRIPTION_LENGTH),
		sections: [...content.matchAll(SECTION)].map((match) => markdownText(match[1])),
		content,
	};
}

function documentKey(module: string, page: string | null): string {
	return page === null ? module : `${module}/${page}`;
}

const DOCUMENTS = new Map<HelpLanguage, Map<string, HelpDocument>>(
	HELP_LANGUAGES.map((language) => [
		language,
		new Map(
			HELP_SOURCES.flatMap((module) => [
				[documentKey(module.slug, null), parseHelpDocument(module.slug, null, module[language])] as const,
				...module.pages.map((page) => [documentKey(module.slug, page.slug), parseHelpDocument(module.slug, page.slug, page[language])] as const),
			])
		),
	])
);

function summary({ slug, title, description, sections }: HelpDocument): HelpSummary {
	return { slug, title, description, sections };
}

export function helpPaths(): string[] {
	return HELP_SOURCES.flatMap((module) => [module.slug, ...module.pages.map((page) => documentKey(module.slug, page.slug))]);
}

export function helpDocument(language: HelpLanguage, module: string, page: string | null): HelpDocument | null {
	return DOCUMENTS.get(language)?.get(documentKey(module, page)) ?? null;
}

export function helpIndex(language: HelpLanguage): HelpIndex {
	const { title, description } = INDEX[language];
	return {
		title,
		description,
		modules: HELP_SOURCES.map((module) => ({
			...summary(helpDocument(language, module.slug, null)!),
			pages: module.pages.map((page) => summary(helpDocument(language, module.slug, page.slug)!)),
		})),
	};
}

interface SearchChunk extends HelpSearchResult {
	heading: string;
	text: string;
	body: string;
	rank: number;
}

const SEARCH_RESULTS = 12;
const SNIPPET_LENGTH = 150;
const CHUNK_LENGTH = 20_000;

export function helpSearchText(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

function searchChunks(language: HelpLanguage): SearchChunk[] {
	const index = helpIndex(language);
	return index.modules.flatMap((module) =>
		[null, ...module.pages.map((page) => page.slug)].flatMap((page) => {
			const document = helpDocument(language, module.slug, page)!;
			const path = documentKey(module.slug, page);
			const context = page === null ? index.title : module.title;
			const [intro, ...sections] = document.content.split(/^## /m);
			const chunk = (target: string, title: string, trail: string, source: string, rank: number): SearchChunk => {
				const body = markdownText(source, CHUNK_LENGTH);
				return { path: target, title, context: trail, snippet: "", heading: helpSearchText(title), text: helpSearchText(body), body, rank };
			};
			return [
				chunk(path, document.title, context, intro, page === null ? 1 : 0),
				...sections.map((section) => {
					const [heading, ...rest] = section.split("\n");
					const title = markdownText(heading);
					return chunk(`${path}#${headingAnchor(title)}`, title, `${context} / ${document.title}`, rest.join("\n"), 2);
				}),
			];
		})
	);
}

const SEARCH = new Map<HelpLanguage, SearchChunk[]>(HELP_LANGUAGES.map((language) => [language, searchChunks(language)]));

function snippetOf(chunk: SearchChunk, term: string): string {
	const position = Math.max(0, chunk.text.indexOf(term));
	const start = Math.max(0, chunk.body.lastIndexOf(" ", Math.max(0, position - SNIPPET_LENGTH / 3)) + 1);
	const end = start + SNIPPET_LENGTH;
	return `${start > 0 ? "..." : ""}${chunk.body.slice(start, end).trimEnd()}${end < chunk.body.length ? "..." : ""}`;
}

export function helpSearch(language: HelpLanguage, query: string): HelpSearchResult[] {
	const terms = helpSearchText(query).split(/\s+/).filter(Boolean).slice(0, 8);
	if (terms.length === 0) return [];
	return (SEARCH.get(language) ?? [])
		.filter((chunk) => terms.every((term) => chunk.heading.includes(term) || chunk.text.includes(term)))
		.map((chunk) => {
			const inHeading = terms.every((term) => chunk.heading.includes(term));
			return { chunk, score: (inHeading ? 0 : 10) + chunk.rank + (chunk.heading.startsWith(terms[0]) ? -0.5 : 0) };
		})
		.sort((left, right) => left.score - right.score)
		.slice(0, SEARCH_RESULTS)
		.map(({ chunk }) => ({ path: chunk.path, title: chunk.title, context: chunk.context, snippet: snippetOf(chunk, terms[0]) }));
}

export function helpMarkup(language: HelpLanguage, module: string | null, page: string | null): string {
	const index = helpIndex(language);
	const document = module === null ? null : helpDocument(language, module, page);
	const current = document === null ? null : documentKey(document.module, document.page);
	const link = (path: string, className: string, content: string) =>
		`<a class="${className}" href="/help/${language}/${path}"${path === current ? ' aria-current="page"' : ""}>${content}</a>`;
	const card = (path: string, entry: HelpSummary) =>
		link(path, "card help-card", `<h2>${escapeHtml(entry.title)}</h2><p class="muted">${escapeHtml(entry.description)}</p>`);
	const bar = `<header class="help-bar"><a class="landing-brand" href="/">RabbitPay</a><a class="help-bar-title" href="/help/${language}">${escapeHtml(index.title)}</a></header>`;

	if (document === null) {
		return `<div class="help-page">${bar}<div class="help-body"><main class="help-main help-index"><h1>${escapeHtml(index.title)}</h1><p class="help-lead">${escapeHtml(
			index.description
		)}</p><div class="help-cards">${index.modules.map((entry) => card(entry.slug, entry)).join("")}</div></main></div></div>`;
	}

	const owner = index.modules.find((entry) => entry.slug === document.module)!;
	const nav = index.modules
		.map((entry) => {
			const pages =
				entry.slug === owner.slug
					? entry.pages.map((child) => link(`${entry.slug}/${child.slug}`, "help-nav-link help-nav-page", escapeHtml(child.title)))
					: [];
			return `<div class="help-nav-module">${link(entry.slug, "help-nav-link", escapeHtml(entry.title))}${pages.join("")}</div>`;
		})
		.join("");
	const trail = [
		`<a href="/help/${language}">${escapeHtml(index.title)}</a>`,
		...(document.page === null ? [] : [`<a href="/help/${language}/${owner.slug}">${escapeHtml(owner.title)}</a>`]),
	].join(" / ");
	const children =
		document.page === null && owner.pages.length > 0
			? `<h2 class="help-children-title">${escapeHtml(INDEX[language].pages)}</h2><div class="help-cards">${owner.pages
					.map((child) => card(`${owner.slug}/${child.slug}`, child))
					.join("")}</div>`
			: "";

	return `<div class="help-page">${bar}<div class="help-body"><nav class="help-nav">${nav}</nav><main class="help-main"><p class="help-trail">${trail}</p><h1>${escapeHtml(
		document.title
	)}</h1><div class="sf-prose markdown-body legal-body help-article">${renderHelp(document.content, language)}</div>${children}</main></div></div>`;
}
