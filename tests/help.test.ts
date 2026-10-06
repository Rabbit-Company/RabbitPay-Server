import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";

const FIXTURE = `${import.meta.dir}/.help-fixture`;
const HELP = `${import.meta.dir}/../docs/help`;

import { prepareTest } from "./environment";
await prepareTest();

mkdirSync(FIXTURE, { recursive: true });
writeFileSync(
	`${FIXTURE}/index.html`,
	'<!doctype html><html lang="en"><head><meta name="robots" content="noindex, nofollow" /><title>RabbitPay</title></head><body><div id="app"></div></body></html>'
);

const { Settings } = await import("../server/settings");
Settings.web = { enabled: true, path: FIXTURE, landing_page: true, license_store_url: "" };

const { Server } = await import("../server/server");
await Server.configure();

const { default: Utils } = await import("../server/utils");
const { HELP_LANGUAGES, helpArticle, helpIndex, helpSlugs } = await import("../server/help");
const { MAX_MARKDOWN_LENGTH, headingAnchor, renderMarkdown } = await import("../server/markdown");

async function get(path: string) {
	return await Server.app.handle(new Request(`http://127.0.0.1${path}`));
}

async function slugsOnDisk(language: string): Promise<string[]> {
	return (await readdir(`${HELP}/${language}`))
		.filter((file) => file.endsWith(".md"))
		.map((file) => file.slice(0, -".md".length))
		.sort();
}

function sections(content: string): string[] {
	return [...content.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim());
}

afterAll(() => {
	rmSync(FIXTURE, { recursive: true, force: true });
});

describe("help articles", () => {
	test("exist in every language and are all registered", async () => {
		expect((await readdir(HELP)).sort()).toEqual([...HELP_LANGUAGES].sort());
		for (const language of HELP_LANGUAGES) {
			expect(await slugsOnDisk(language)).toEqual(helpSlugs().sort());
		}
	});

	test("carry a title, an introduction and the same sections in every language", () => {
		for (const slug of helpSlugs()) {
			const english = helpArticle("en", slug)!;
			for (const language of HELP_LANGUAGES) {
				const article = helpArticle(language, slug)!;
				expect(article.title).not.toBe(slug);
				expect(article.description.length).toBeGreaterThan(20);
				expect(article.description.endsWith("...")).toBe(false);
				expect(article.content.length).toBeLessThan(MAX_MARKDOWN_LENGTH);
				expect(article.content).not.toMatch(/^# /m);
				expect(sections(article.content).length).toBe(sections(english.content).length);
				expect(renderMarkdown(article.content)).toContain("<h2>");
			}
		}
	});

	test("link only to sections and articles that exist", () => {
		for (const slug of helpSlugs()) {
			for (const language of HELP_LANGUAGES) {
				const { content } = helpArticle(language, slug)!;
				const anchors = sections(content).map(headingAnchor);
				expect(new Set(anchors).size).toBe(anchors.length);
				for (const [, anchor] of content.matchAll(/\]\(#([^)]+)\)/g)) expect(anchors).toContain(anchor);
				for (const [, target] of content.matchAll(/\]\(([^)#]+)\)/g)) expect(helpSlugs()).toContain(target);
			}
		}
	});

	test("use keyboard characters only", () => {
		for (const slug of helpSlugs()) {
			for (const language of HELP_LANGUAGES) {
				expect(helpArticle(language, slug)!.content).not.toMatch(/[–—‘’“”…]/);
			}
		}
	});

	test("are listed with a localized index", () => {
		expect(helpIndex("en").title).toBe("Help");
		expect(helpIndex("sl").title).toBe("Pomoč");
		expect(helpIndex("sl").articles.map((article) => article.slug)).toEqual(helpSlugs());
		expect(helpIndex("sl").articles.find((article) => article.slug === "invoices")?.title).toBe("Računi");
		expect(helpSlugs()[0]).toBe("getting-started");
	});
});

describe("help endpoints", () => {
	test("list the articles of a language without signing in", async () => {
		const response = await get("/api/v1/help/sl");
		expect(response.status).toBe(200);
		const { data } = (await response.json()) as { data: { title: string; articles: { slug: string; content?: string }[] } };
		expect(data.title).toBe("Pomoč");
		expect(data.articles.map((article) => article.slug)).toContain("invoices");
		expect(data.articles[0].content).toBeUndefined();
	});

	test("return one article", async () => {
		const response = await get("/api/v1/help/en/invoices");
		expect(response.status).toBe(200);
		const { data } = (await response.json()) as { data: { title: string; content: string } };
		expect(data.title).toBe("Invoices");
		expect(data.content).toContain("## Create an invoice");
	});

	test("let the browser keep an article for a few minutes", async () => {
		expect((await get("/api/v1/help/en")).headers.get("Cache-Control")).toBe("public, max-age=300");
		expect((await get("/api/v1/help/en/invoices")).headers.get("Cache-Control")).toBe("public, max-age=300");
	});

	test("answer 404 for an unknown language or article", async () => {
		expect((await get("/api/v1/help/de")).status).toBe(404);
		expect((await get("/api/v1/help/de/invoices")).status).toBe(404);
		expect((await get("/api/v1/help/en/nothing-here")).status).toBe(404);
	});
});

describe("help pages", () => {
	test("describe an article to search engines in its own language", async () => {
		const html = await (await get("/help/sl/invoices")).text();
		expect(html).toContain('<html lang="sl">');
		expect(html).toContain("<title>Računi | Pomoč | RabbitPay</title>");
		expect(html).toContain('<meta name="robots" content="index, follow" />');
		expect(html).toContain(`<link rel="canonical" href="${Utils.publicUrl()}/help/sl/invoices" />`);
		expect(html).toContain('hreflang="en"');
		expect(html).toContain('hreflang="x-default"');
	});

	test("carry the article itself, so it reads without waiting for the interface", async () => {
		const html = await (await get("/help/sl/invoices")).text();
		expect(html).toContain('<div id="app"><div class="help-page">');
		expect(html).toContain("<h1>Računi</h1>");
		expect(html).toContain("<h2>Ustvarite račun</h2>");
		expect(html).toContain('<a class="help-nav-link" href="/help/sl/invoices" aria-current="page">Računi</a>');

		const seed = JSON.parse(html.match(/<script type="application\/json" id="rabbitpay-help">(.*?)<\/script>/s)![1]) as {
			language: string;
			index: { articles: unknown[] };
			article: { slug: string; content: string };
		};
		expect(seed.language).toBe("sl");
		expect(seed.index.articles.length).toBe(helpSlugs().length);
		expect(seed.article.slug).toBe("invoices");
		expect(seed.article.content).toBe(helpArticle("sl", "invoices")!.content);
	});

	test("carry the list of articles on the index", async () => {
		const html = await (await get("/help/en")).text();
		expect(html).toContain('<a class="card help-card" href="/help/en/payments"><h2>Payments</h2>');
		expect(html).toContain('"article":null');
	});

	test("leave other pages empty for the interface to fill", async () => {
		for (const path of ["/", "/login", "/help", "/help/en/nothing-here"]) {
			expect(await (await get(path)).text()).toContain('<div id="app"></div>');
		}
	});

	test("describe the index", async () => {
		const html = await (await get("/help/en")).text();
		expect(html).toContain("<title>Help | RabbitPay</title>");
		expect(html).toContain('<meta name="robots" content="index, follow" />');
	});

	test("keep unknown help pages and the language redirect out of search", async () => {
		for (const path of ["/help", "/help/de", "/help/en/nothing-here"]) {
			const html = await (await get(path)).text();
			expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
		}
	});

	test("stay out of search when the landing page is off", async () => {
		Settings.web.landing_page = false;
		try {
			const html = await (await get("/help/en/invoices")).text();
			expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
		} finally {
			Settings.web.landing_page = true;
		}
	});

	test("are in the sitemap", async () => {
		const sitemap = await (await get("/sitemap-home.xml")).text();
		for (const language of HELP_LANGUAGES) {
			expect(sitemap).toContain(`/help/${language}</loc>`);
			expect(sitemap).toContain(`/help/${language}/invoices</loc>`);
		}
	});
});

describe("home page", () => {
	test("is described in English at the root", async () => {
		const html = await (await get("/")).text();
		expect(html).toContain('<html lang="en">');
		expect(html).toContain("<title>RabbitPay | Invoicing and payments</title>");
		expect(html).toContain(`<link rel="canonical" href="${Utils.publicUrl()}/" />`);
		expect(html).toContain(`<link rel="alternate" hreflang="sl" href="${Utils.publicUrl()}/sl" />`);
		expect(html).toContain(`<link rel="alternate" hreflang="x-default" href="${Utils.publicUrl()}/" />`);
	});

	test("is described in Slovenian at its own address", async () => {
		for (const path of ["/sl", "/sl/"]) {
			const html = await (await get(path)).text();
			expect(html).toContain('<html lang="sl">');
			expect(html).toContain("<title>RabbitPay | Računi in plačila</title>");
			expect(html).toContain('<meta name="robots" content="index, follow" />');
			expect(html).toContain('<meta name="description" content="Izdajanje računov in plačila za slovenska podjetja');
			expect(html).toContain(`<link rel="canonical" href="${Utils.publicUrl()}/sl" />`);
			expect(html).toContain(`<link rel="alternate" hreflang="en" href="${Utils.publicUrl()}/" />`);
		}
	});

	test("is in the sitemap in both languages", async () => {
		const sitemap = await (await get("/sitemap-home.xml")).text();
		expect(sitemap).toContain(`<loc>${Utils.publicUrl()}/</loc>`);
		expect(sitemap).toContain(`<loc>${Utils.publicUrl()}/sl</loc>`);
	});

	test("stays out of search in Slovenian too when the landing page is off", async () => {
		Settings.web.landing_page = false;
		try {
			expect(await (await get("/sl")).text()).toContain('<meta name="robots" content="noindex, nofollow" />');
		} finally {
			Settings.web.landing_page = true;
		}
	});
});
