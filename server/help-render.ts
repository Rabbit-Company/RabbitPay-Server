import { HELP_SHOTS } from "./help-shots";
import { escapeHtml, headingAnchor, renderMarkdown } from "./markdown";

export const HELP_CDN = "https://cdn.rabbitpay.net/help";

const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const HELP_LINK = new RegExp(`href="(${SLUG}(?:/${SLUG})?(?:#[^"]*)?)"`, "g");
const SHOT_IMAGE = new RegExp(`<img src="${HELP_CDN}/([a-z]{2}/)dark/([a-z0-9/-]+)\\.webp" alt="([^"]*)"[^>]*>`, "g");
const SHOT_PARAGRAPH = /<p>(<figure class="help-shot">(?:(?!<\/figure>).)*<\/figure>)<\/p>/g;
const HEADING = /<h([23])>(.*?)<\/h\1>/g;

export function helpShotKeys(): string[] {
	return Object.keys(HELP_SHOTS);
}

export function helpShotUrl(key: string, theme: "dark" | "light"): string {
	const [language, ...path] = key.split("/");
	const version = HELP_SHOTS[key]?.[2];
	return `${HELP_CDN}/${language}/${theme}/${path.join("/")}.webp${version ? `?v=${version}` : ""}`;
}

function shotFigure(key: string, alt: string): string {
	const shot = HELP_SHOTS[key];
	const size = shot ? ` width="${shot[0]}" height="${shot[1]}"` : "";
	const image = (theme: "dark" | "light") =>
		`<img class="help-shot-${theme}" src="${escapeHtml(helpShotUrl(key, theme))}" alt="${alt}"${size} loading="lazy" referrerpolicy="no-referrer">`;
	const caption = alt ? `<figcaption>${alt}</figcaption>` : "";
	return `<figure class="help-shot"><span class="help-shot-pair">${image("dark")}${image("light")}</span>${caption}</figure>`;
}

function plainText(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

export function renderHelp(content: string, language: string): string {
	const used = new Set<string>();
	return renderMarkdown(content)
		.replace(HELP_LINK, (_, target: string) => `href="/help/${language}/${target}"`)
		.replace(SHOT_IMAGE, (_, shotLanguage: string, path: string, alt: string) => shotFigure(`${shotLanguage}${path}`, alt))
		.replace(SHOT_PARAGRAPH, "$1")
		.replace(HEADING, (_, level: string, inner: string) => {
			const base = headingAnchor(plainText(inner)) || "section";
			let anchor = base;
			for (let copy = 2; used.has(anchor); copy++) anchor = `${base}-${copy}`;
			used.add(anchor);
			return `<h${level} id="${anchor}">${inner}</h${level}>`;
		});
}
