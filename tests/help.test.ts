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
Settings.web = { enabled: true, path: FIXTURE, landing_page: true, license_store_url: "", status_page_url: "" };

const { Server } = await import("../server/server");
await Server.configure();

const { default: Utils } = await import("../server/utils");
const { HELP_LANGUAGES, helpDocument, helpIndex, helpPaths, helpSearch } = await import("../server/help");
const { HELP_CDN, helpShotKeys, renderHelp } = await import("../server/help-render");
const { MAX_MARKDOWN_LENGTH, headingAnchor } = await import("../server/markdown");

async function get(path: string) {
	return await Server.app.handle(new Request(`http://127.0.0.1${path}`));
}

async function pathsOnDisk(language: string): Promise<string[]> {
	return (await readdir(`${HELP}/${language}`, { recursive: true }))
		.filter((file) => file.endsWith(".md"))
		.map((file) => file.slice(0, -".md".length).replace(/\/index$/, ""))
		.sort();
}

function document(language: (typeof HELP_LANGUAGES)[number], path: string) {
	const [module, page = null] = path.split("/");
	return helpDocument(language, module, page)!;
}

function anchors(content: string): string[] {
	return [...content.matchAll(/^###? (.+)$/gm)].map((match) => headingAnchor(match[1].trim()));
}

afterAll(() => {
	rmSync(FIXTURE, { recursive: true, force: true });
});

describe("help pages on disk", () => {
	test("exist in every language and are all registered", async () => {
		expect((await readdir(HELP)).sort()).toEqual([...HELP_LANGUAGES].sort());
		for (const language of HELP_LANGUAGES) {
			expect(await pathsOnDisk(language)).toEqual(helpPaths().sort());
		}
	});

	test("carry a title, an introduction and the same sections in every language", () => {
		for (const path of helpPaths()) {
			const english = document("en", path);
			for (const language of HELP_LANGUAGES) {
				const page = document(language, path);
				expect(page.title).not.toBe(page.slug);
				expect(page.description.length).toBeGreaterThan(20);
				expect(page.description.endsWith("...")).toBe(false);
				expect(page.content.length).toBeLessThan(MAX_MARKDOWN_LENGTH);
				expect(page.content).not.toMatch(/^# /m);
				expect(page.sections.length).toBe(english.sections.length);
				expect(page.sections.length).toBeGreaterThan(0);
			}
		}
	});

	test("link only to pages and sections that exist", () => {
		for (const path of helpPaths()) {
			for (const language of HELP_LANGUAGES) {
				const { content } = document(language, path);
				const own = anchors(content);
				expect(new Set(own).size).toBe(own.length);
				for (const [, target, anchor] of content.matchAll(/\]\(([a-z0-9/-]*)(?:#([^)]+))?\)/g)) {
					if (target !== "") expect(helpPaths()).toContain(target);
					if (anchor !== undefined) expect(target === "" ? own : anchors(document(language, target).content)).toContain(anchor);
				}
			}
		}
	});

	test("show only screenshots of their own language that have been captured", () => {
		const captured = new Set(helpShotKeys());
		for (const path of helpPaths()) {
			for (const language of HELP_LANGUAGES) {
				const { content } = document(language, path);
				for (const [, url] of content.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
					expect(url.startsWith(`${HELP_CDN}/${language}/dark/`)).toBe(true);
					expect(captured.has(`${language}/${url.slice(`${HELP_CDN}/${language}/dark/`.length, -".webp".length)}`)).toBe(true);
				}
			}
		}
	});

	test("use keyboard characters only", () => {
		for (const path of helpPaths()) {
			for (const language of HELP_LANGUAGES) {
				expect(document(language, path).content).not.toMatch(/[–—‘’“”…]/);
			}
		}
	});

	test("are listed by module with a localized index", () => {
		expect(helpIndex("en").title).toBe("Help");
		expect(helpIndex("sl").title).toBe("Pomoč");
		expect(helpIndex("sl").modules.find((module) => module.slug === "invoices")?.title).toBe("Računi");
		expect(helpIndex("en").modules[0].slug).toBe("getting-started");
		expect(helpIndex("en").modules[0].pages[0].slug).toBe("create-account");
		expect(helpIndex("sl").modules[0].pages[0].title).toBe("Ustvarite svoj račun");
	});
});

describe("help rendering", () => {
	test("turns a screenshot into a figure with both themes and a caption", () => {
		const html = renderHelp(`![The form](${HELP_CDN}/en/dark/getting-started/create-account/register.webp)`, "en");
		expect(html).toStartWith('<figure class="help-shot">');
		expect(html).toContain(`class="help-shot-dark" src="${HELP_CDN}/en/dark/getting-started/create-account/register.webp?v=`);
		expect(html).toContain(`class="help-shot-light" src="${HELP_CDN}/en/light/getting-started/create-account/register.webp?v=`);
		expect(html).toMatch(/width="\d+" height="\d+"/);
		expect(html).toContain("<figcaption>The form</figcaption>");
	});

	test("points links at the page of the same language and gives headings an anchor", () => {
		const html = renderHelp("## Pošlji račun\n\n[Računi](invoices) in [koda](getting-started/secure-your-account#prijava) in [zgoraj](#poslji-racun)", "sl");
		expect(html).toContain('<h2 id="poslji-racun">Pošlji račun</h2>');
		expect(html).toContain('<a href="/help/sl/invoices">Računi</a>');
		expect(html).toContain('<a href="/help/sl/getting-started/secure-your-account#prijava">koda</a>');
		expect(html).toContain('<a href="#poslji-racun">zgoraj</a>');
	});

	test("leaves other links and images alone", () => {
		const html = renderHelp("[site](https://rabbitpay.net/login) ![logo](https://example.com/logo.png)", "en");
		expect(html).toContain('href="https://rabbitpay.net/login"');
		expect(html).toContain('<img src="https://example.com/logo.png"');
	});
});

describe("help search", () => {
	test("finds text inside a page and links to its section", () => {
		const results = helpSearch("en", "recovery codes");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].path).toBe("getting-started/secure-your-account#save-your-recovery-codes");
		expect(results[0].context).toBe("Getting started / Protect your account");
	});

	test("ignores accents and case", () => {
		expect(helpSearch("sl", "RACUN").length).toBeGreaterThan(0);
		expect(helpSearch("sl", "obnovitvene kode")[0].path).toContain("getting-started/secure-your-account");
	});

	test("returns nothing for an empty or unknown query", () => {
		expect(helpSearch("en", "   ")).toEqual([]);
		expect(helpSearch("en", "xyzzyplugh")).toEqual([]);
	});
});

describe("help endpoints", () => {
	test("list the modules of a language without signing in", async () => {
		const response = await get("/api/v1/help/sl");
		expect(response.status).toBe(200);
		const { data } = (await response.json()) as { data: { title: string; modules: { slug: string; content?: string; pages: { slug: string }[] }[] } };
		expect(data.title).toBe("Pomoč");
		expect(data.modules.map((module) => module.slug)).toContain("invoices");
		expect(data.modules[0].pages.map((page) => page.slug)).toContain("first-invoice");
		expect(data.modules[0].content).toBeUndefined();
	});

	test("return a module and one of its pages", async () => {
		const module = (await (await get("/api/v1/help/en/invoices")).json()) as { data: { title: string; content: string; page: string | null } };
		expect(module.data.title).toBe("Invoices");
		expect(module.data.page).toBeNull();
		expect(module.data.content).toContain("## Everyday work");

		const page = (await (await get("/api/v1/help/en/getting-started/create-account")).json()) as { data: { title: string; module: string; page: string } };
		expect(page.data.title).toBe("Create your account");
		expect(page.data.module).toBe("getting-started");
		expect(page.data.page).toBe("create-account");
	});

	test("search the pages", async () => {
		const response = await get("/api/v1/help/en/search?q=security%20key");
		expect(response.status).toBe(200);
		const { data } = (await response.json()) as { data: { path: string; title: string; snippet: string }[] };
		expect(data[0].path).toBe("getting-started/secure-your-account#add-a-security-key");
	});

	test("let the browser keep a page for a few minutes", async () => {
		for (const path of ["/api/v1/help/en", "/api/v1/help/en/invoices", "/api/v1/help/en/getting-started/first-invoice", "/api/v1/help/en/search?q=vat"]) {
			expect((await get(path)).headers.get("Cache-Control")).toBe("public, max-age=300");
		}
	});

	test("answer 404 for an unknown language, module or page", async () => {
		expect((await get("/api/v1/help/de")).status).toBe(404);
		expect((await get("/api/v1/help/de/invoices")).status).toBe(404);
		expect((await get("/api/v1/help/en/nothing-here")).status).toBe(404);
		expect((await get("/api/v1/help/en/getting-started/nothing-here")).status).toBe(404);
		expect((await get("/api/v1/help/de/search?q=vat")).status).toBe(404);
	});
});

describe("help pages", () => {
	test("describe a page to search engines in its own language", async () => {
		const html = await (await get("/help/sl/invoices")).text();
		expect(html).toContain('<html lang="sl">');
		expect(html).toContain("<title>Računi | Pomoč | RabbitPay</title>");
		expect(html).toContain('<meta name="robots" content="index, follow" />');
		expect(html).toContain(`<link rel="canonical" href="${Utils.publicUrl()}/help/sl/invoices" />`);
		expect(html).toContain('hreflang="en"');
		expect(html).toContain('hreflang="x-default"');

		const nested = await (await get("/help/sl/getting-started/first-invoice")).text();
		expect(nested).toContain("<title>Vaš prvi račun | Pomoč | RabbitPay</title>");
		expect(nested).toContain(`<link rel="canonical" href="${Utils.publicUrl()}/help/sl/getting-started/first-invoice" />`);
		expect(nested).toContain(`hreflang="en" href="${Utils.publicUrl()}/help/en/getting-started/first-invoice"`);
	});

	test("carry the page itself, so it reads without waiting for the interface", async () => {
		const html = await (await get("/help/sl/getting-started/first-invoice")).text();
		expect(html).toContain('<div id="app"><div class="help-page">');
		expect(html).toContain("<h1>Vaš prvi račun</h1>");
		expect(html).toContain('<h2 id="izdajte-racun">Izdajte račun</h2>');
		expect(html).toContain('<a class="help-nav-link help-nav-page" href="/help/sl/getting-started/first-invoice" aria-current="page">Vaš prvi račun</a>');
		expect(html).toContain('<p class="help-trail"><a href="/help/sl">Pomoč</a> / <a href="/help/sl/getting-started">Prvi koraki</a></p>');
		expect(html).toContain('<figure class="help-shot">');

		const seed = JSON.parse(html.match(/<script type="application\/json" id="rabbitpay-help">(.*?)<\/script>/s)![1]) as {
			language: string;
			index: { modules: unknown[] };
			document: { module: string; page: string; content: string };
		};
		expect(seed.language).toBe("sl");
		expect(seed.index.modules.length).toBe(helpIndex("sl").modules.length);
		expect(seed.document.page).toBe("first-invoice");
		expect(seed.document.content).toBe(helpDocument("sl", "getting-started", "first-invoice")!.content);
	});

	test("list the pages of a module on the module page", async () => {
		const html = await (await get("/help/en/getting-started")).text();
		expect(html).toContain('<a class="card help-card" href="/help/en/getting-started/create-account"><h2>Create your account</h2>');
	});

	test("carry the list of modules on the index", async () => {
		const html = await (await get("/help/en")).text();
		expect(html).toContain('<a class="card help-card" href="/help/en/payments"><h2>Payments</h2>');
		expect(html).toContain('"document":null');
	});

	test("leave other pages empty for the interface to fill", async () => {
		for (const path of ["/", "/login", "/help", "/help/en/nothing-here", "/help/en/getting-started/nothing-here"]) {
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
			expect(sitemap).toContain(`/help/${language}/getting-started/create-account</loc>`);
		}
	});
});

describe("home page", () => {
	test("is described in English at the root", async () => {
		const html = await (await get("/")).text();
		expect(html).toContain('<html lang="en">');
		expect(html).toContain("<title>RabbitPay | Invoices, payments, stock and accounting</title>");
		expect(html).toContain(`<link rel="canonical" href="${Utils.publicUrl()}/" />`);
		expect(html).toContain(`<link rel="alternate" hreflang="sl" href="${Utils.publicUrl()}/sl" />`);
		expect(html).toContain(`<link rel="alternate" hreflang="x-default" href="${Utils.publicUrl()}/" />`);
	});

	test("is described in Slovenian at its own address", async () => {
		for (const path of ["/sl", "/sl/"]) {
			const html = await (await get(path)).text();
			expect(html).toContain('<html lang="sl">');
			expect(html).toContain("<title>RabbitPay | Računi, plačila, zaloge in knjigovodstvo</title>");
			expect(html).toContain('<meta name="robots" content="index, follow" />');
			expect(html).toContain('<meta name="description" content="Poslovni program za slovenska podjetja');
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
