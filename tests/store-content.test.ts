import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { markdownText, renderMarkdown, safeUrl } from "../server/markdown";
import { defaultStoreConfig, isDomain, localizeDefaults, readStoreConfig, slugify, type StoreSeller } from "../server/store/config";
import { numericClient } from "../server/database/client";
import { MIGRATIONS, migrate } from "../server/database/migrations";

const seller: StoreSeller = {
	name: "Pixel Parts",
	language: "sl",
	accent: "#0d9488",
	legal_name: "Pixel Parts d.o.o.",
	address: ["Slovenska cesta 1", "1000 Ljubljana"],
	email: "hello@pixel.test",
	phone: null,
	vat_number: "SI12345678",
	registration_number: "1234567000",
	country: "SI",
};

describe("product descriptions in Markdown", () => {
	test("renders headings, emphasis, lists, tables and links", () => {
		const html = renderMarkdown(
			"## Specs\nThe **fastest** card, see [AMD](https://amd.com).\n\n- FSR 4\n- Ray tracing\n\n| Part | Value |\n|:--|--:|\n| VRAM | 16 GB |"
		);
		expect(html).toContain("<h2>Specs</h2>");
		expect(html).toContain("<strong>fastest</strong>");
		expect(html).toContain('<a href="https://amd.com" target="_blank" rel="noopener noreferrer nofollow">AMD</a>');
		expect(html).toContain("<ul><li>FSR 4</li><li>Ray tracing</li></ul>");
		expect(html).toContain('<td style="text-align:right">16 GB</td>');
	});

	test("never lets raw HTML or script links through", () => {
		const html = renderMarkdown('<img src=x onerror=alert(1)> [click](javascript:alert(1)) ![x](data:image/png;base64,AAA) <script>alert("x")</script>');
		expect(html).not.toContain("<img src=x");
		expect(html).not.toContain("<script");
		expect(html).not.toContain('href="javascript');
		expect(html).not.toContain('src="data:');
		expect(html).toContain("&lt;script&gt;");
	});

	test("allows only safe link targets", () => {
		expect(safeUrl("https://example.com")).toBe("https://example.com");
		expect(safeUrl("/shop/pixel/c/gpu")).toBe("/shop/pixel/c/gpu");
		expect(safeUrl("mailto:hi@example.com")).toBe("mailto:hi@example.com");
		expect(safeUrl("//evil.example")).toBeNull();
		expect(safeUrl("JavaScript:alert(1)")).toBeNull();
		expect(safeUrl("vbscript:x")).toBeNull();
		expect(safeUrl("mailto:hi@example.com", true)).toBeNull();
	});

	test("turns Markdown into a plain summary for search engines", () => {
		expect(markdownText("# Title\n**Bold** and [a link](https://x.test)", 100)).toBe("Title Bold and a link");
		expect(markdownText("a".repeat(50), 10)).toHaveLength(10);
	});
});

describe("store settings", () => {
	test("starts from valid defaults with legal pages in the store language", () => {
		const config = defaultStoreConfig(seller);
		expect(readStoreConfig(config)).toEqual(config);
		expect(config.language).toBe("sl");
		expect(config.theme.accent).toBe("#0d9488");
		expect(config.pages.map((page) => page.slug)).toEqual(["privacy", "terms", "withdrawal"]);
		expect(config.pages[0].content).toContain("Pixel Parts d.o.o.");
		expect(config.pages[0].content).toContain("GDPR");
	});

	test("covers what Slovenian law requires in the legal templates", () => {
		const [privacy, terms, withdrawal] = defaultStoreConfig(seller).pages.map((page) => page.content);
		for (const required of [
			"Upravljavec",
			"Pravna podlaga",
			"Kdo prejme",
			"Evropskega gospodarskega prostora",
			"10 let",
			"ZEKom-2",
			"člen 17",
			"Informacijski pooblaščenec",
			"15 let",
		])
			expect(privacy).toContain(required);
		for (const required of [
			"Matična številka: 1234567000",
			"ID za DDV: SI12345678",
			"Naročilo z obveznostjo plačila",
			"30 dneh",
			"14 dneh",
			"licenčne ključe",
			"ZVPot-1",
			"dveh mesecih",
			"izvensodnega reševanja",
		])
			expect(terms).toContain(required);
		expect(withdrawal).toContain("Obveščam/obveščamo (\\*), da odstopam/odstopamo (\\*) od pogodbe");
		expect(renderMarkdown(withdrawal)).toContain("<li>Naslovnik: Pixel Parts d.o.o., Slovenska cesta 1, 1000 Ljubljana, hello@pixel.test</li>");
		expect(renderMarkdown(terms)).toContain('<a href="withdrawal">obrazec za odstop od pogodbe</a>');
		for (const text of [privacy, terms, withdrawal]) expect(text).not.toMatch(/—/);
	});

	test("adds a Slovenian version when a Slovenian seller runs an English store", () => {
		const english = defaultStoreConfig({ ...seller, language: "en" }).pages;
		expect(english[1].title).toBe("Terms of sale");
		expect(english[1].content).toContain("Order with obligation to pay");
		expect(english[1].content).toContain("# Slovenska različica");
		expect(english[2].content).toContain("I/We (\\*) hereby give notice");
		const foreign = defaultStoreConfig({ ...seller, language: "en", country: "AT" }).pages;
		expect(foreign[0].content).not.toContain("Slovenska različica");
	});

	test("translates untouched default texts into the store language", () => {
		const english = defaultStoreConfig({ ...seller, language: "en" });
		const localized = localizeDefaults({ ...english, language: "sl" }, seller, new Date(Date.UTC(2027, 0, 5)));
		expect(localized.hero.subtitle).toBe("Odkrijte našo ponudbo.");
		expect(localized.hero.cta_label).toBe("Nakupuj");
		expect(localized.shipping[0].name).toBe("Standardna dostava");
		expect(localized.pages.map((page) => page.title)).toEqual(["Politika zasebnosti", "Splošni pogoji poslovanja", "Odstop od pogodbe"]);
		expect(localized.pages[1].content).toContain("Naročilo z obveznostjo plačila");
		expect(localized.pages[1].content).not.toContain("Order with obligation to pay");
		expect(localized.pages[0].content).toContain("Velja od 5. januar 2027.");
	});

	test("keeps texts the merchant wrote when translating defaults", () => {
		const english = defaultStoreConfig({ ...seller, language: "en" });
		const custom = {
			...english,
			language: "sl" as const,
			hero: { ...english.hero, subtitle: "Graphics cards at fair prices", cta_label: null },
			shipping: [{ ...english.shipping[0], name: "Pošta Slovenije" }],
			pages: english.pages.map((page, index) => (index === 0 ? { ...page, title: "Zasebnost", content: `${page.content}\n\nExtra clause.` } : page)),
		};
		const localized = localizeDefaults(custom, seller);
		expect(localized.hero.subtitle).toBe("Graphics cards at fair prices");
		expect(localized.hero.cta_label).toBeNull();
		expect(localized.shipping[0].name).toBe("Pošta Slovenije");
		expect(localized.pages[0].title).toBe("Zasebnost");
		expect(localized.pages[0].content).toContain("Extra clause.");
		expect(localized.pages[1].title).toBe("Splošni pogoji poslovanja");
		expect(localizeDefaults(defaultStoreConfig(seller), seller)).toEqual(defaultStoreConfig(seller));
	});

	test("rejects unsafe or inconsistent settings", () => {
		const config = defaultStoreConfig(seller);
		expect(readStoreConfig({ ...config, theme: { ...config.theme, accent: "red" } })).toBeNull();
		expect(readStoreConfig({ ...config, hero: { ...config.hero, cta_link: "javascript:alert(1)" } })).toBeNull();
		expect(readStoreConfig({ ...config, hero: { ...config.hero, cta_link: "//evil.example" } })).toBeNull();
		expect(readStoreConfig({ ...config, socials: [{ network: "myspace", url: "https://myspace.com" }] })).toBeNull();
		expect(readStoreConfig({ ...config, delivery: { ...config.delivery, min_days: 5, max_days: 2 } })).toBeNull();
		const hours = [...config.location.hours];
		hours[0] = { closed: false, open: "18:00", close: "09:00" };
		expect(readStoreConfig({ ...config, location: { ...config.location, hours } })).toBeNull();
		expect(readStoreConfig({ ...config, shipping: [config.shipping[0], config.shipping[0]] })).toBeNull();
		expect(readStoreConfig({ ...config, theme: { ...config.theme, custom_css: "x".repeat(20_001) } })).toBeNull();
	});

	test("makes web addresses from names and checks custom domains", () => {
		expect(slugify("Grafične kartice & RX 9060 XT")).toBe("graficne-kartice-rx-9060-xt");
		expect(slugify("!!!")).toBe("item");
		expect(isDomain("shop.example.com")).toBe(true);
		expect(isDomain("localhost")).toBe(false);
		expect(isDomain("Shop.Example.com")).toBe(false);
		expect(isDomain("shop..example.com")).toBe(false);
	});
});

describe("the online store migration", () => {
	test("keeps existing license keys and accepts online store keys", async () => {
		const sql = numericClient(new SQL("sqlite://:memory:", { safeIntegers: true }));
		await migrate(sql, "sqlite", MIGRATIONS.slice(0, 3));
		await sql`INSERT INTO license_keys(uuid, code, type, duration_days, status, created, updated) VALUES('a', 'RPAY-1', 'white_label', 30, 'available', 1, 1)`;
		await migrate(sql, "sqlite");

		expect([...(await sql`SELECT uuid, type FROM license_keys`)]).toEqual([{ uuid: "a", type: "white_label" }]);
		await sql`INSERT INTO license_keys(uuid, code, type, duration_days, status, created, updated) VALUES('b', 'RPAY-2', 'store', 30, 'available', 1, 1)`;
		const bogus = async () => await sql`INSERT INTO license_keys(uuid, code, type, status, created, updated) VALUES('c', 'RPAY-3', 'bogus', 'available', 1, 1)`;
		await expect(bogus()).rejects.toThrow();
		const columns = (await sql.unsafe("PRAGMA table_info(projects)")) as { name: string }[];
		expect(columns.map((column) => column.name)).toContain("store_until");
		await sql.close();
	});

	test("labels order emails sent before each step had its own kind", async () => {
		const sql = numericClient(new SQL("sqlite://:memory:", { safeIntegers: true }));
		await migrate(sql, "sqlite", MIGRATIONS.slice(0, 4));
		const now = Date.now();
		await sql`INSERT INTO projects(uuid, name, apikey, apikey2, created, updated, created_by) VALUES('p', 'shop', 'k1', 'k2', ${now}, ${now}, 'owner')`;
		const subjects = ["Your order 1 from Shop is on its way", "Vaše naročilo 2 pri Shop je dostavljeno", "Shop is preparing your order 3", "Something else"];
		for (const [index, subject] of subjects.entries()) {
			await sql`INSERT INTO email_messages(uuid, project, kind, recipient, sender_name, subject, body_text, body_html, created, updated)
				VALUES(${String(index)}, 'p', 'order_update', 'a@example.com', 'Shop', ${subject}, '', '', ${now}, ${now})`;
		}
		await migrate(sql, "sqlite");
		const kinds = (await sql`SELECT kind FROM email_messages ORDER BY uuid`) as { kind: string }[];
		expect(kinds.map((row) => row.kind)).toEqual(["order_shipped", "order_delivered", "order_processing", "order_update"]);
		await sql.close();
	});
});
