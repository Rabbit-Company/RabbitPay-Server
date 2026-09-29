import { join, normalize, resolve, sep } from "node:path";
import { Settings } from "./settings";
import { isWebUrl } from "./settings-schema";
import { Logger } from "./logger";
import Utils from "./utils";
import { escapeHtml } from "./markdown";
import { normalizeHost, slugForHost, storeBySlug, storeUrl } from "./store/store";
import { sitemapStores, storePageMeta, storeSitemap, STORE_PRIVATE_PATHS, type StorePageMeta } from "./store/seo";
import { includedPayments, includedStorageGb, licensingEnforced } from "./licensing";

const IMMUTABLE_ASSET = /-[a-z0-9]{8,}\.(js|css|woff2?|ttf|png|svg|jpg|jpeg|webp|ico)$/i;

let rootPath: string | null = null;
let indexMissingLogged = false;

function root(): string {
	if (rootPath === null) rootPath = resolve(Settings.web?.path || "./web/dist");
	return rootPath;
}

export function isEnabled(): boolean {
	return Settings.web?.enabled !== false;
}

function resolveWithinRoot(pathname: string): string | null {
	const decoded = decodeURIComponent(pathname);
	if (decoded.includes("\0")) return null;

	const candidate = resolve(join(root(), normalize(decoded)));
	if (candidate !== root() && !candidate.startsWith(root() + sep)) return null;

	return candidate;
}

async function fileResponse(path: string, cacheControl: string): Promise<Response | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;

	return new Response(file, {
		headers: {
			"Content-Type": file.type || "application/octet-stream",
			"Cache-Control": cacheControl,
			"X-Content-Type-Options": "nosniff",
		},
	});
}

const STOREFRONT_PATH = /^\/shop\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/|$)/;
const STORE_SITEMAP_PATH = /^\/shop\/([a-z0-9]+(?:-[a-z0-9]+)*)\/sitemap\.xml$/;
const APPLICATION_PRIVATE_PATHS = ["/projects", "/admin", "/account", "/customer", "/pay/", "/login", "/invite", "/converter"];
const DOMAIN_PRIVATE_PATHS = ["/customer", "/pay/", "/login"];

interface StoreRequest {
	slug: string;
	domain: boolean;
	path: string;
}

async function domainSlugFor(host: string | null): Promise<string | null> {
	const own = normalizeHost(new URL(Utils.publicUrl()).host);
	const requested = normalizeHost(host);
	return requested !== null && requested !== own ? await slugForHost(requested) : null;
}

async function storeRequestFor(pathname: string, host: string | null): Promise<StoreRequest | null> {
	const domainSlug = await domainSlugFor(host);
	if (domainSlug !== null) return { slug: domainSlug, domain: true, path: pathname };
	const slug = pathname.match(STOREFRONT_PATH)?.[1];
	if (!slug) return null;
	return { slug, domain: false, path: pathname.slice(`/shop/${slug}`.length) || "/" };
}

function robotsTag(indexable: boolean): string {
	return `<meta name="robots" content="${indexable ? "index, follow" : "noindex, nofollow"}" />`;
}

function jsonLd(value: Record<string, unknown>): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

function pageTags(meta: StorePageMeta): string[] {
	return [
		meta.description ? `<meta name="description" content="${escapeHtml(meta.description)}" />` : "",
		meta.url ? `<link rel="canonical" href="${escapeHtml(meta.url)}" />` : "",
		...meta.alternates.map((alternate) => `<link rel="alternate" hreflang="${escapeHtml(alternate.language)}" href="${escapeHtml(alternate.url)}" />`),
		`<meta property="og:site_name" content="${escapeHtml(meta.site)}" />`,
		`<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
		meta.description ? `<meta property="og:description" content="${escapeHtml(meta.description)}" />` : "",
		`<meta property="og:type" content="${meta.type}" />`,
		meta.url ? `<meta property="og:url" content="${escapeHtml(meta.url)}" />` : "",
		meta.image ? `<meta property="og:image" content="${escapeHtml(meta.image)}" />` : "",
		meta.price ? `<meta property="product:price:amount" content="${meta.price.amount}" />` : "",
		meta.price ? `<meta property="product:price:currency" content="${escapeHtml(meta.price.currency)}" />` : "",
		`<meta name="twitter:card" content="${meta.image ? "summary_large_image" : "summary"}" />`,
		meta.structured ? `<script type="application/ld+json">${jsonLd(meta.structured)}</script>` : "",
	];
}

function storefrontHtml(html: string, request: StoreRequest, meta: StorePageMeta | null): string {
	const tags = [
		`<meta name="rabbitpay-store" content="${escapeHtml(request.slug)}" data-domain="${request.domain ? "1" : "0"}" />`,
		...(meta ? pageTags(meta) : []),
	];
	const page = html.replace(/<meta name="robots"[^>]*>/, robotsTag(meta?.indexable ?? false));
	const described = meta
		? page
				.replace(/<html lang="[^"]*">/, `<html lang="${escapeHtml(meta.language)}">`)
				.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(meta.title)}</title>`)
		: page;
	return described.replace("</head>", `${tags.join("")}</head>`);
}

const HOME_DESCRIPTION =
	"Invoicing and payments for small businesses. Accept cards, PayPal, bank transfers, Bitcoin, Ethereum and Monero, and keep expenses and reports in one place.";

function applicationHtml(html: string, pathname: string): string {
	if (Settings.web?.landing_page === false) return html;
	const licensing = licensingEnforced();
	const store = licensing && isWebUrl(Settings.web?.license_store_url ?? "") ? Settings.web.license_store_url : "";
	const flag = `<meta name="rabbitpay-landing" content="1" data-free-payments="${licensing ? includedPayments() : ""}" data-free-storage="${licensing ? includedStorageGb() : ""}" data-license-store="${escapeHtml(store)}" />`;
	if (pathname !== "/" && pathname !== "/index.html") return html.replace("</head>", `${flag}</head>`);

	const tags = [
		flag,
		`<meta name="description" content="${escapeHtml(HOME_DESCRIPTION)}" />`,
		`<meta property="og:title" content="RabbitPay" />`,
		`<meta property="og:description" content="${escapeHtml(HOME_DESCRIPTION)}" />`,
		`<meta property="og:type" content="website" />`,
		`<meta property="og:url" content="${escapeHtml(Utils.publicUrl())}/" />`,
		`<link rel="canonical" href="${escapeHtml(Utils.publicUrl())}/" />`,
	].join("");
	return html
		.replace(/<meta name="robots"[^>]*>/, `<meta name="robots" content="index, follow" />`)
		.replace(/<title>[^<]*<\/title>/, "<title>RabbitPay | Invoicing and payments</title>")
		.replace("</head>", `${tags}</head>`);
}

interface Shell {
	body: string;
	status: number;
}

async function storefrontShell(html: string, url: URL, host: string | null): Promise<Shell | null> {
	try {
		const request = await storeRequestFor(url.pathname, host);
		if (request === null) return null;
		const store = await storeBySlug(request.slug);
		if (store === null && !request.domain) return { body: applicationHtml(html, url.pathname), status: 404 };
		const meta = store ? await storePageMeta(store, request.path, url.searchParams.get("lang")) : null;
		return { body: storefrontHtml(html, request, meta), status: meta?.status ?? 200 };
	} catch (error) {
		Logger.warn(`[WEB] Could not describe the storefront page ${url.pathname}: ${error}`);
		return null;
	}
}

async function indexResponse(url: URL, host: string | null): Promise<Response | null> {
	const index = Bun.file(join(root(), "index.html"));

	if (!(await index.exists())) {
		if (!indexMissingLogged) {
			indexMissingLogged = true;
			Logger.warn(`[WEB] No built interface at ${root()}. Run "bun run build:web" to create it.`);
		}
		return null;
	}

	const html = await index.text();
	const shell = (await storefrontShell(html, url, host)) ?? { body: applicationHtml(html, url.pathname), status: 200 };

	return new Response(shell.body, {
		status: shell.status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-cache",
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options": "DENY",
			"Referrer-Policy": "same-origin",
		},
	});
}

function textResponse(body: string, type: string): Response {
	return new Response(body, {
		headers: {
			"Content-Type": `${type}; charset=utf-8`,
			"Cache-Control": "public, max-age=3600",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

function robotsText(disallowed: string[], sitemap: string | null): string {
	return ["User-agent: *", ...disallowed.map((path) => `Disallow: ${path}`), ...(sitemap ? ["", `Sitemap: ${sitemap}`] : []), ""].join("\n");
}

function xmlDocument(root: string, entries: string[]): string {
	return ['<?xml version="1.0" encoding="UTF-8"?>', `<${root} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`, ...entries, `</${root}>`].join("\n");
}

async function sitemapIndex(): Promise<string> {
	const base = Utils.publicUrl();
	const sitemaps = [
		...(Settings.web?.landing_page === false ? [] : [`${base}/sitemap-home.xml`]),
		...(await sitemapStores()).map((slug) => `${base}/shop/${slug}/sitemap.xml`),
	];
	return xmlDocument(
		"sitemapindex",
		sitemaps.slice(0, 50000).map((loc) => `<sitemap><loc>${escapeHtml(loc)}</loc></sitemap>`)
	);
}

async function searchFile(pathname: string, host: string | null): Promise<Response | null> {
	const domainSlug = await domainSlugFor(host);
	if (domainSlug !== null) {
		const store = await storeBySlug(domainSlug);
		if (pathname === "/robots.txt") {
			const sitemap = store?.config.indexable ? `${storeUrl(store.settings)}/sitemap.xml` : null;
			return textResponse(robotsText([...STORE_PRIVATE_PATHS, ...DOMAIN_PRIVATE_PATHS], sitemap), "text/plain");
		}
		const sitemap = pathname === "/sitemap.xml" && store ? await storeSitemap(store) : null;
		return sitemap === null ? null : textResponse(sitemap, "application/xml");
	}

	if (pathname === "/robots.txt") {
		const disallowed = [...APPLICATION_PRIVATE_PATHS, ...STORE_PRIVATE_PATHS.map((path) => `/shop/*${path}`)];
		return textResponse(robotsText(disallowed, `${Utils.publicUrl()}/sitemap.xml`), "text/plain");
	}
	if (pathname === "/sitemap.xml") return textResponse(await sitemapIndex(), "application/xml");
	if (pathname === "/sitemap-home.xml") {
		if (Settings.web?.landing_page === false) return null;
		return textResponse(xmlDocument("urlset", [`<url><loc>${escapeHtml(Utils.publicUrl())}/</loc></url>`]), "application/xml");
	}

	const slug = pathname.match(STORE_SITEMAP_PATH)?.[1];
	if (!slug) return null;
	const store = await storeBySlug(slug);
	const sitemap = store && store.settings.domain === null ? await storeSitemap(store) : null;
	return sitemap === null ? null : textResponse(sitemap, "application/xml");
}

const SEARCH_FILE = /^\/(?:robots\.txt|sitemap(?:-home)?\.xml|shop\/[^/]+\/sitemap\.xml)$/;

export async function serve(url: URL, method: string, host: string | null = null): Promise<Response | null> {
	if (!isEnabled()) return null;
	if (method !== "GET" && method !== "HEAD") return null;

	const pathname = url.pathname;
	if (pathname === "/" || pathname === "/index.html") return await indexResponse(url, host);
	if (SEARCH_FILE.test(pathname)) return await searchFile(pathname, host);

	const target = resolveWithinRoot(pathname);
	if (target === null) return null;

	const asset = await fileResponse(target, IMMUTABLE_ASSET.test(pathname) ? "public, max-age=31536000, immutable" : "public, max-age=300");
	if (asset !== null) return asset;

	if (pathname.includes(".")) return null;

	return await indexResponse(url, host);
}
