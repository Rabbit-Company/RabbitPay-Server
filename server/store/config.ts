import { isAccentColor } from "../colors";
import { MAX_MARKDOWN_LENGTH } from "../markdown";
import { legalPages } from "./legal";

export const SOCIAL_NETWORKS = [
	"discord",
	"instagram",
	"facebook",
	"x",
	"youtube",
	"tiktok",
	"linkedin",
	"github",
	"telegram",
	"whatsapp",
	"reddit",
	"twitch",
	"mastodon",
	"pinterest",
	"email",
	"website",
] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

export const STORE_FONTS = ["system", "geometric", "humanist", "serif", "rounded", "mono"] as const;
export const STORE_RADII = ["sharp", "soft", "round"] as const;
export const STORE_MODES = ["auto", "light", "dark"] as const;
export const STORE_HERO_STYLES = ["gradient", "image", "split", "minimal"] as const;
export const STORE_CARD_STYLES = ["elevated", "outlined", "flat"] as const;
export const STORE_LANGUAGES = ["en", "sl"] as const;

const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/;

export function isLanguageCode(value: unknown): value is string {
	if (typeof value !== "string" || !LANGUAGE_CODE.test(value)) return false;
	try {
		return Intl.getCanonicalLocales(value)[0] === value;
	} catch {
		return false;
	}
}
export const STORE_COLUMNS = [2, 3, 4] as const;

export const MAX_SOCIALS = 16;
export const MAX_SHIPPING_OPTIONS = 10;
export const MAX_PAGES = 12;
export const MAX_CUSTOM_CSS = 20_000;
export const MAX_DELIVERY_DAYS = 365;
export const MAX_PAYMENT_DAYS = 60;
export const RESERVED_PAGE_SLUGS = ["privacy", "terms"] as const;

export type Availability = "in_stock" | "low_stock" | "backorder" | "out_of_stock";

export interface StoreSocial {
	network: SocialNetwork;
	url: string;
}

export interface StoreDayHours {
	closed: boolean;
	open: string;
	close: string;
}

export interface StoreShippingOption {
	id: string;
	name: string;
	price: number;
	free_from: number | null;
	min_days: number;
	max_days: number;
	pickup: boolean;
}

export interface StorePage {
	slug: string;
	title: string;
	content: string;
	footer: boolean;
}

export interface StoreTheme {
	accent: string;
	mode: (typeof STORE_MODES)[number];
	font: (typeof STORE_FONTS)[number];
	radius: (typeof STORE_RADII)[number];
	hero_style: (typeof STORE_HERO_STYLES)[number];
	card_style: (typeof STORE_CARD_STYLES)[number];
	columns: (typeof STORE_COLUMNS)[number];
	custom_css: string;
}

export interface StoreConfig {
	name: string;
	tagline: string | null;
	description: string | null;
	language: string;
	announcement: string | null;
	hero: { title: string | null; subtitle: string | null; cta_label: string | null; cta_link: string | null };
	theme: StoreTheme;
	contact: { email: string | null; phone: string | null };
	location: { enabled: boolean; name: string | null; address: string | null; map_url: string | null; note: string | null; hours: StoreDayHours[] };
	socials: StoreSocial[];
	shipping: StoreShippingOption[];
	delivery: { min_days: number; max_days: number; business_days: boolean; cutoff_hour: number };
	checkout: { payment_days: number; business_customers: boolean; order_notes: boolean };
	pages: StorePage[];
	footer_text: string | null;
	indexable: boolean;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null | undefined {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || value.length > max) return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function required(value: unknown, max: number): string | undefined {
	const cleaned = text(value, max);
	return cleaned ?? undefined;
}

function oneOf<T extends string | number>(value: unknown, options: readonly T[]): T | undefined {
	return options.includes(value as T) ? (value as T) : undefined;
}

function wholeNumber(value: unknown, min: number, max: number): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

export function isWebUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".");
	} catch {
		return false;
	}
}

function isStoreLink(value: string): boolean {
	return (value.startsWith("/") && !value.startsWith("//")) || isWebUrl(value);
}

function isTime(value: unknown): value is string {
	return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function isSlug(value: unknown, max = 80): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= max && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

export function slugify(value: string, max = 80): string {
	const slug = value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/g, "");
	return slug || "item";
}

export function isDomain(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 253 &&
		/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value) &&
		!value.endsWith(".localhost")
	);
}

function readSocial(value: unknown): StoreSocial | undefined {
	if (!isObject(value)) return undefined;
	const network = oneOf(value.network, SOCIAL_NETWORKS);
	const url = required(value.url, 500);
	if (!network || !url) return undefined;
	if (network === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url) ? { network, url } : undefined;
	return isWebUrl(url) ? { network, url } : undefined;
}

function readHours(value: unknown): StoreDayHours[] | undefined {
	if (!Array.isArray(value) || value.length !== 7) return undefined;
	const days: StoreDayHours[] = [];
	for (const day of value) {
		if (!isObject(day) || typeof day.closed !== "boolean" || !isTime(day.open) || !isTime(day.close)) return undefined;
		if (!day.closed && day.open >= day.close) return undefined;
		days.push({ closed: day.closed, open: day.open, close: day.close });
	}
	return days;
}

function readShipping(value: unknown): StoreShippingOption | undefined {
	if (!isObject(value)) return undefined;
	const id = isSlug(value.id, 40) ? value.id : undefined;
	const name = required(value.name, 120);
	const price = wholeNumber(value.price, 0, 100_000_000_00);
	const freeFrom = value.free_from === null || value.free_from === undefined ? null : wholeNumber(value.free_from, 0, 100_000_000_00);
	const minDays = wholeNumber(value.min_days, 0, MAX_DELIVERY_DAYS);
	const maxDays = wholeNumber(value.max_days, 0, MAX_DELIVERY_DAYS);
	if (!id || !name || price === undefined || freeFrom === undefined || minDays === undefined || maxDays === undefined || minDays > maxDays) return undefined;
	if (value.pickup !== undefined && typeof value.pickup !== "boolean") return undefined;
	return { id, name, price, free_from: freeFrom, min_days: minDays, max_days: maxDays, pickup: value.pickup === true };
}

function readPage(value: unknown): StorePage | undefined {
	if (!isObject(value)) return undefined;
	const slug = isSlug(value.slug, 60) ? value.slug : undefined;
	const title = required(value.title, 120);
	const content = text(value.content, MAX_MARKDOWN_LENGTH);
	if (!slug || !title || content === undefined || typeof value.footer !== "boolean") return undefined;
	return { slug, title, content: content ?? "", footer: value.footer };
}

function readList<T>(value: unknown, max: number, read: (entry: unknown) => T | undefined): T[] | undefined {
	if (!Array.isArray(value) || value.length > max) return undefined;
	const entries: T[] = [];
	for (const entry of value) {
		const parsed = read(entry);
		if (parsed === undefined) return undefined;
		entries.push(parsed);
	}
	return entries;
}

function unique<T>(entries: T[], key: (entry: T) => string): boolean {
	return new Set(entries.map(key)).size === entries.length;
}

export function readStoreConfig(value: unknown): StoreConfig | null {
	if (!isObject(value) || !isObject(value.hero) || !isObject(value.theme) || !isObject(value.contact)) return null;
	if (!isObject(value.location) || !isObject(value.delivery) || !isObject(value.checkout)) return null;

	const name = required(value.name, 120);
	const tagline = text(value.tagline, 200);
	const description = text(value.description, 500);
	const language = isLanguageCode(value.language) ? value.language : undefined;
	const announcement = text(value.announcement, 200);
	const footerText = text(value.footer_text, 1000);
	if (!name || tagline === undefined || description === undefined || !language || announcement === undefined || footerText === undefined) return null;
	if (typeof value.indexable !== "boolean") return null;

	const hero = value.hero;
	const heroTitle = text(hero.title, 120);
	const heroSubtitle = text(hero.subtitle, 300);
	const ctaLabel = text(hero.cta_label, 40);
	const ctaLink = text(hero.cta_link, 500);
	if (heroTitle === undefined || heroSubtitle === undefined || ctaLabel === undefined || ctaLink === undefined) return null;
	if (ctaLink !== null && !isStoreLink(ctaLink)) return null;

	const theme = value.theme;
	const accent = typeof theme.accent === "string" && isAccentColor(theme.accent) ? theme.accent : undefined;
	const mode = oneOf(theme.mode, STORE_MODES);
	const font = oneOf(theme.font, STORE_FONTS);
	const radius = oneOf(theme.radius, STORE_RADII);
	const heroStyle = oneOf(theme.hero_style, STORE_HERO_STYLES);
	const cardStyle = oneOf(theme.card_style, STORE_CARD_STYLES);
	const columns = oneOf(theme.columns, STORE_COLUMNS);
	const customCss = theme.custom_css === undefined || theme.custom_css === null ? "" : theme.custom_css;
	if (!accent || !mode || !font || !radius || !heroStyle || !cardStyle || !columns) return null;
	if (typeof customCss !== "string" || customCss.length > MAX_CUSTOM_CSS) return null;

	const contact = value.contact;
	const email = text(contact.email, 254);
	const phone = text(contact.phone, 40);
	if (email === undefined || phone === undefined) return null;
	if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;

	const location = value.location;
	const locationName = text(location.name, 120);
	const address = text(location.address, 500);
	const mapUrl = text(location.map_url, 1000);
	const note = text(location.note, 300);
	const hours = readHours(location.hours);
	if (typeof location.enabled !== "boolean" || locationName === undefined || address === undefined || mapUrl === undefined || note === undefined || !hours)
		return null;
	if (mapUrl !== null && !isWebUrl(mapUrl)) return null;

	const socials = readList(value.socials, MAX_SOCIALS, readSocial);
	const shipping = readList(value.shipping, MAX_SHIPPING_OPTIONS, readShipping);
	const pages = readList(value.pages, MAX_PAGES, readPage);
	if (!socials || !shipping || !pages) return null;
	if (!unique(shipping, (option) => option.id) || !unique(pages, (page) => page.slug)) return null;
	if (!RESERVED_PAGE_SLUGS.every((slug) => pages.some((page) => page.slug === slug && page.content.trim() !== ""))) return null;

	const delivery = value.delivery;
	const minDays = wholeNumber(delivery.min_days, 0, MAX_DELIVERY_DAYS);
	const maxDays = wholeNumber(delivery.max_days, 0, MAX_DELIVERY_DAYS);
	const cutoff = wholeNumber(delivery.cutoff_hour, 0, 24);
	if (minDays === undefined || maxDays === undefined || minDays > maxDays || cutoff === undefined || typeof delivery.business_days !== "boolean") return null;

	const checkout = value.checkout;
	const paymentDays = wholeNumber(checkout.payment_days, 1, MAX_PAYMENT_DAYS);
	if (paymentDays === undefined || typeof checkout.business_customers !== "boolean" || typeof checkout.order_notes !== "boolean") return null;

	return {
		name,
		tagline,
		description,
		language,
		announcement,
		hero: { title: heroTitle, subtitle: heroSubtitle, cta_label: ctaLabel, cta_link: ctaLink },
		theme: { accent, mode, font, radius, hero_style: heroStyle, card_style: cardStyle, columns, custom_css: customCss },
		contact: { email, phone },
		location: { enabled: location.enabled, name: locationName, address, map_url: mapUrl, note, hours },
		socials,
		shipping,
		delivery: { min_days: minDays, max_days: maxDays, business_days: delivery.business_days, cutoff_hour: cutoff },
		checkout: { payment_days: paymentDays, business_customers: checkout.business_customers, order_notes: checkout.order_notes },
		pages,
		footer_text: footerText,
		indexable: value.indexable,
	};
}

export interface StoreSeller {
	name: string;
	language: string;
	accent: string | null;
	legal_name: string | null;
	address: string[];
	email: string | null;
	phone: string | null;
	vat_number: string | null;
	registration_number: string | null;
	country: string | null;
}

type StoreLanguage = (typeof STORE_LANGUAGES)[number];

interface DefaultTexts {
	subtitle: string;
	cta: string;
	shipping: string;
}

const DEFAULT_TEXTS: Record<StoreLanguage, DefaultTexts> = {
	en: { subtitle: "Discover what we have in store.", cta: "Shop now", shipping: "Standard delivery" },
	sl: { subtitle: "Odkrijte našo ponudbo.", cta: "Nakupuj", shipping: "Standardna dostava" },
};

export function defaultStoreConfig(seller: StoreSeller): StoreConfig {
	const language = seller.language === "sl" ? "sl" : "en";
	const texts = DEFAULT_TEXTS[language];
	const weekday: StoreDayHours = { closed: false, open: "09:00", close: "17:00" };
	const weekend: StoreDayHours = { closed: true, open: "09:00", close: "13:00" };
	return {
		name: seller.name,
		tagline: null,
		description: null,
		language,
		announcement: null,
		hero: {
			title: seller.name,
			subtitle: texts.subtitle,
			cta_label: texts.cta,
			cta_link: null,
		},
		theme: {
			accent: seller.accent && isAccentColor(seller.accent) ? seller.accent : "#4f46e5",
			mode: "auto",
			font: "geometric",
			radius: "soft",
			hero_style: "gradient",
			card_style: "elevated",
			columns: 4,
			custom_css: "",
		},
		contact: { email: seller.email, phone: seller.phone },
		location: {
			enabled: false,
			name: null,
			address: seller.address.join("\n") || null,
			map_url: null,
			note: null,
			hours: [weekday, weekday, weekday, weekday, weekday, weekend, weekend],
		},
		socials: [],
		shipping: [{ id: "standard", name: texts.shipping, price: 0, free_from: null, min_days: 2, max_days: 4, pickup: false }],
		delivery: { min_days: 1, max_days: 3, business_days: true, cutoff_hour: 14 },
		checkout: { payment_days: 3, business_customers: true, order_notes: true },
		pages: legalPages(seller, seller.name, language),
		footer_text: null,
		indexable: true,
	};
}

function undated(content: string): string {
	return content.replace(/^(?:Valid from|Velja od) .*$/gm, "").trim();
}

function isStoreLanguage(value: string): value is StoreLanguage {
	return (STORE_LANGUAGES as readonly string[]).includes(value);
}

export function legalLanguage(language: string): StoreLanguage {
	return language === "sl" ? "sl" : "en";
}

export function localizeDefaults(config: StoreConfig, seller: StoreSeller, now = new Date()): StoreConfig {
	if (!isStoreLanguage(config.language)) return config;
	const current = config.language;
	const others = STORE_LANGUAGES.filter((language) => language !== current);
	const target = DEFAULT_TEXTS[current];
	const swap = (value: string | null, pick: (texts: DefaultTexts) => string) =>
		value !== null && others.some((language) => pick(DEFAULT_TEXTS[language]) === value) ? pick(target) : value;

	const templates = legalPages(seller, config.name, current, now);
	const foreign = others.flatMap((language) => legalPages(seller, config.name, language, now));

	return {
		...config,
		hero: { ...config.hero, subtitle: swap(config.hero.subtitle, (texts) => texts.subtitle), cta_label: swap(config.hero.cta_label, (texts) => texts.cta) },
		shipping: config.shipping.map((option) => ({ ...option, name: swap(option.name, (texts) => texts.shipping) ?? option.name })),
		pages: config.pages.map((page) => {
			const template = templates.find((entry) => entry.slug === page.slug);
			const matches = foreign.filter((entry) => entry.slug === page.slug);
			if (!template || matches.length === 0) return page;
			return {
				...page,
				title: matches.some((entry) => entry.title === page.title) ? template.title : page.title,
				content: matches.some((entry) => undated(entry.content) === undated(page.content)) ? template.content : page.content,
			};
		}),
	};
}

export function parseStoredConfig(raw: string, seller: StoreSeller): StoreConfig {
	try {
		return readStoreConfig(JSON.parse(raw)) ?? defaultStoreConfig(seller);
	} catch {
		return defaultStoreConfig(seller);
	}
}
