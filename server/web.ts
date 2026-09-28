import { join, normalize, resolve, sep } from "node:path";
import { Settings } from "./settings";
import { Logger } from "./logger";
import Utils from "./utils";
import Database from "./database/database";
import { escapeHtml, markdownText } from "./markdown";
import { normalizeHost, slugForHost } from "./store/store";
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

interface StoreMeta {
	slug: string;
	name: string;
	description: string | null;
	language: string;
	indexable: boolean;
}

const STOREFRONT_PATH = /^\/shop\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/|$)/;
const PRIVATE_PATH = /^\/(?:customer|pay|login|invite|projects|admin|account|converter)(?:\/|$)/;

async function storeMeta(slug: string): Promise<StoreMeta | null> {
	const [row] = (await Database`SELECT slug, enabled, config FROM store_settings WHERE slug = ${slug}`) as { slug: string; enabled: number; config: string }[];
	if (!row || !row.enabled) return null;
	try {
		const config = JSON.parse(row.config) as { name?: unknown; tagline?: unknown; description?: unknown; language?: unknown; indexable?: unknown };
		const description = typeof config.description === "string" ? config.description : typeof config.tagline === "string" ? config.tagline : null;
		return {
			slug: row.slug,
			name: typeof config.name === "string" ? config.name : row.slug,
			description: description ? markdownText(description, 300) : null,
			language: config.language === "sl" ? "sl" : "en",
			indexable: config.indexable !== false,
		};
	} catch {
		return null;
	}
}

async function storeFor(pathname: string, host: string | null): Promise<{ meta: StoreMeta; domain: boolean } | null> {
	try {
		const own = normalizeHost(new URL(Utils.publicUrl()).host);
		const requested = normalizeHost(host);
		const domainSlug = requested !== null && requested !== own ? await slugForHost(requested) : null;
		const slug = domainSlug ?? pathname.match(STOREFRONT_PATH)?.[1] ?? null;
		if (slug === null) return null;
		const meta = await storeMeta(slug);
		return meta ? { meta, domain: domainSlug !== null } : null;
	} catch {
		return null;
	}
}

function storefrontHtml(html: string, pathname: string, store: { meta: StoreMeta; domain: boolean }): string {
	const { meta } = store;
	const indexable = meta.indexable && !PRIVATE_PATH.test(pathname);
	const tags = [
		`<meta name="rabbitpay-store" content="${escapeHtml(meta.slug)}" data-domain="${store.domain ? "1" : "0"}" />`,
		meta.description ? `<meta name="description" content="${escapeHtml(meta.description)}" />` : "",
		`<meta property="og:title" content="${escapeHtml(meta.name)}" />`,
		meta.description ? `<meta property="og:description" content="${escapeHtml(meta.description)}" />` : "",
		`<meta property="og:type" content="website" />`,
	].join("");
	return html
		.replace(/<html lang="[^"]*">/, `<html lang="${meta.language}">`)
		.replace(/<meta name="robots"[^>]*>/, `<meta name="robots" content="${indexable ? "index, follow" : "noindex, nofollow"}" />`)
		.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(meta.name)}</title>`)
		.replace("</head>", `${tags}</head>`);
}

const HOME_DESCRIPTION =
	"Invoicing and payments for small businesses. Accept cards, PayPal, bank transfers, Bitcoin, Ethereum and Monero, and keep expenses and reports in one place.";

function applicationHtml(html: string, pathname: string): string {
	if (Settings.web?.landing_page === false) return html;
	const licensing = licensingEnforced();
	const flag = `<meta name="rabbitpay-landing" content="1" data-free-payments="${licensing ? includedPayments() : ""}" data-free-storage="${licensing ? includedStorageGb() : ""}" />`;
	if (pathname !== "/" && pathname !== "/index.html") return html.replace("</head>", `${flag}</head>`);

	const tags = [
		flag,
		`<meta name="description" content="${escapeHtml(HOME_DESCRIPTION)}" />`,
		`<meta property="og:title" content="RabbitPay" />`,
		`<meta property="og:description" content="${escapeHtml(HOME_DESCRIPTION)}" />`,
		`<meta property="og:type" content="website" />`,
		`<meta property="og:url" content="${escapeHtml(Utils.publicUrl())}/" />`,
	].join("");
	return html
		.replace(/<meta name="robots"[^>]*>/, `<meta name="robots" content="index, follow" />`)
		.replace(/<title>[^<]*<\/title>/, "<title>RabbitPay | Invoicing and payments</title>")
		.replace("</head>", `${tags}</head>`);
}

async function indexResponse(pathname: string, host: string | null): Promise<Response | null> {
	const index = Bun.file(join(root(), "index.html"));

	if (!(await index.exists())) {
		if (!indexMissingLogged) {
			indexMissingLogged = true;
			Logger.warn(`[WEB] No built interface at ${root()}. Run "bun run build:web" to create it.`);
		}
		return null;
	}

	const store = await storeFor(pathname, host);
	const body = store ? storefrontHtml(await index.text(), pathname, store) : applicationHtml(await index.text(), pathname);

	return new Response(body, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-cache",
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options": "DENY",
			"Referrer-Policy": "same-origin",
		},
	});
}

export async function serve(pathname: string, method: string, host: string | null = null): Promise<Response | null> {
	if (!isEnabled()) return null;
	if (method !== "GET" && method !== "HEAD") return null;

	if (pathname === "/" || pathname === "/index.html") return await indexResponse(pathname, host);

	const target = resolveWithinRoot(pathname);
	if (target === null) return null;

	const asset = await fileResponse(target, IMMUTABLE_ASSET.test(pathname) ? "public, max-age=31536000, immutable" : "public, max-age=300");
	if (asset !== null) return asset;

	if (pathname.includes(".")) return null;

	return await indexResponse(pathname, host);
}
