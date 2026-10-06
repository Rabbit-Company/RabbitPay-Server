import invoicesEn from "../docs/help/en/invoices.md" with { type: "text" };
import invoicesSl from "../docs/help/sl/invoices.md" with { type: "text" };
import paymentsEn from "../docs/help/en/payments.md" with { type: "text" };
import paymentsSl from "../docs/help/sl/payments.md" with { type: "text" };
import expensesEn from "../docs/help/en/expenses-and-reports.md" with { type: "text" };
import expensesSl from "../docs/help/sl/expenses-and-reports.md" with { type: "text" };
import storeEn from "../docs/help/en/online-store.md" with { type: "text" };
import storeSl from "../docs/help/sl/online-store.md" with { type: "text" };
import portalEn from "../docs/help/en/customer-portal.md" with { type: "text" };
import portalSl from "../docs/help/sl/customer-portal.md" with { type: "text" };
import workforceEn from "../docs/help/en/workforce.md" with { type: "text" };
import workforceSl from "../docs/help/sl/workforce.md" with { type: "text" };
import sloveniaEn from "../docs/help/en/slovenia.md" with { type: "text" };
import sloveniaSl from "../docs/help/sl/slovenia.md" with { type: "text" };
import { markdownText } from "./markdown";

export const HELP_LANGUAGES = ["en", "sl"] as const;
export type HelpLanguage = (typeof HELP_LANGUAGES)[number];

export interface HelpSummary {
	slug: string;
	title: string;
	description: string;
}

export interface HelpArticle extends HelpSummary {
	content: string;
}

export interface HelpIndex {
	title: string;
	description: string;
	articles: HelpSummary[];
}

const SOURCES: Record<string, Record<HelpLanguage, string>> = {
	invoices: { en: invoicesEn, sl: invoicesSl },
	payments: { en: paymentsEn, sl: paymentsSl },
	"expenses-and-reports": { en: expensesEn, sl: expensesSl },
	"online-store": { en: storeEn, sl: storeSl },
	"customer-portal": { en: portalEn, sl: portalSl },
	workforce: { en: workforceEn, sl: workforceSl },
	slovenia: { en: sloveniaEn, sl: sloveniaSl },
};

const INDEX: Record<HelpLanguage, { title: string; description: string }> = {
	en: { title: "Help", description: "Step by step guides to invoicing, payments and everything else you do in RabbitPay." },
	sl: { title: "Pomoč", description: "Vodniki po korakih za izdajanje računov, plačila in vse drugo, kar počnete v RabbitPayu." },
};

const TITLE = /^#\s+(.+?)\s*$/m;
const DESCRIPTION_LENGTH = 200;

export function isHelpLanguage(value: unknown): value is HelpLanguage {
	return HELP_LANGUAGES.includes(value as HelpLanguage);
}

export function parseHelpArticle(slug: string, source: string): HelpArticle {
	const text = source.replace(/\r\n?/g, "\n").trim();
	const heading = text.match(TITLE);
	const content = heading ? text.slice((heading.index ?? 0) + heading[0].length).trim() : text;
	return { slug, title: heading?.[1] ?? slug, description: markdownText(content.split(/\n\s*\n/)[0], DESCRIPTION_LENGTH), content };
}

const ARTICLES = new Map<HelpLanguage, Map<string, HelpArticle>>(
	HELP_LANGUAGES.map((language) => [language, new Map(Object.entries(SOURCES).map(([slug, sources]) => [slug, parseHelpArticle(slug, sources[language])]))])
);

export function helpSlugs(): string[] {
	return Object.keys(SOURCES);
}

export function helpArticle(language: HelpLanguage, slug: string): HelpArticle | null {
	return ARTICLES.get(language)?.get(slug) ?? null;
}

export function helpIndex(language: HelpLanguage): HelpIndex {
	const articles = [...(ARTICLES.get(language)?.values() ?? [])].map(({ slug, title, description }) => ({ slug, title, description }));
	return { ...INDEX[language], articles };
}
