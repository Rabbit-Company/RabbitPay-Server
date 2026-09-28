import { isAccentColor } from "./colors";

export const CUSTOMER_EMAIL_KINDS = [
	"invoice",
	"reminder_before",
	"reminder_after",
	"receipt",
	"credit_note",
	"keys",
	"order_placed",
	"order_processing",
	"order_shipped",
	"order_delivered",
] as const;
export type CustomerEmailKind = (typeof CUSTOMER_EMAIL_KINDS)[number];

export const EMAIL_TEXT_FIELDS = ["subject", "heading", "intro", "button", "closing"] as const;
export type EmailTextField = (typeof EMAIL_TEXT_FIELDS)[number];

export type EmailTexts = Record<EmailTextField, string | null>;

export interface EmailDesign {
	accent: string | null;
	show_logo: boolean;
	show_address: boolean;
	signature: string | null;
	footer_text: string | null;
	templates: Record<CustomerEmailKind, EmailTexts>;
}

export const EMAIL_PLACEHOLDERS: Record<CustomerEmailKind, readonly string[]> = {
	invoice: ["merchant", "reference", "amount", "date"],
	reminder_before: ["merchant", "reference", "amount", "date"],
	reminder_after: ["merchant", "reference", "amount", "date"],
	receipt: ["merchant", "reference", "amount", "date"],
	credit_note: ["merchant", "reference", "invoice", "amount", "date"],
	keys: ["merchant", "reference"],
	order_placed: ["merchant", "reference", "amount", "date"],
	order_processing: ["merchant", "reference"],
	order_shipped: ["merchant", "reference"],
	order_delivered: ["merchant", "reference"],
};

export const EMAIL_FIELDS: Record<CustomerEmailKind, readonly EmailTextField[]> = {
	invoice: ["subject", "heading", "intro", "button", "closing"],
	reminder_before: ["subject", "heading", "intro", "button", "closing"],
	reminder_after: ["subject", "heading", "intro", "button", "closing"],
	receipt: ["subject", "heading", "intro", "button", "closing"],
	credit_note: ["subject", "heading", "intro", "closing"],
	keys: ["subject", "heading", "intro", "button", "closing"],
	order_placed: ["subject", "heading", "intro", "button", "closing"],
	order_processing: ["subject", "heading", "intro", "button", "closing"],
	order_shipped: ["subject", "heading", "intro", "button", "closing"],
	order_delivered: ["subject", "heading", "intro", "button", "closing"],
};

export const EMAIL_TEXT_LIMITS: Record<EmailTextField | "signature" | "footer_text", number> = {
	subject: 200,
	heading: 200,
	intro: 2000,
	button: 60,
	closing: 1000,
	signature: 1000,
	footer_text: 500,
};

const EMPTY_TEXTS: EmailTexts = { subject: null, heading: null, intro: null, button: null, closing: null };

export const DEFAULT_EMAIL_DESIGN: EmailDesign = {
	accent: null,
	show_logo: true,
	show_address: true,
	signature: null,
	footer_text: null,
	templates: Object.fromEntries(CUSTOMER_EMAIL_KINDS.map((kind) => [kind, EMPTY_TEXTS])) as Record<CustomerEmailKind, EmailTexts>,
};

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

function usesOnly(value: string | null, allowed: readonly string[]): boolean {
	if (value === null) return true;
	return [...value.matchAll(/\{(\w+)\}/g)].every((match) => allowed.includes(match[1]));
}

function readTexts(value: unknown, kind: CustomerEmailKind): EmailTexts | null {
	if (value === undefined || value === null) return EMPTY_TEXTS;
	if (!isObject(value)) return null;
	const texts = { ...EMPTY_TEXTS };
	for (const field of EMAIL_TEXT_FIELDS) {
		const cleaned = text(value[field], EMAIL_TEXT_LIMITS[field]);
		if (cleaned === undefined || !usesOnly(cleaned, EMAIL_PLACEHOLDERS[kind])) return null;
		if (cleaned !== null && !EMAIL_FIELDS[kind].includes(field)) return null;
		if (cleaned !== null && (field === "subject" || field === "button") && /[\r\n]/.test(cleaned)) return null;
		texts[field] = cleaned;
	}
	return texts;
}

export function readEmailDesign(value: unknown): EmailDesign | null {
	if (!isObject(value) || !isObject(value.templates)) return null;
	const accent = value.accent === null || value.accent === undefined ? null : isAccentColor(value.accent) ? value.accent : undefined;
	const signature = text(value.signature, EMAIL_TEXT_LIMITS.signature);
	const footer = text(value.footer_text, EMAIL_TEXT_LIMITS.footer_text);
	if (accent === undefined || signature === undefined || footer === undefined) return null;
	if (typeof value.show_logo !== "boolean" || typeof value.show_address !== "boolean") return null;
	if (Object.keys(value.templates).some((kind) => !(CUSTOMER_EMAIL_KINDS as readonly string[]).includes(kind))) return null;

	const templates = {} as Record<CustomerEmailKind, EmailTexts>;
	for (const kind of CUSTOMER_EMAIL_KINDS) {
		const texts = readTexts(value.templates[kind], kind);
		if (!texts) return null;
		templates[kind] = texts;
	}
	return { accent, show_logo: value.show_logo, show_address: value.show_address, signature, footer_text: footer, templates };
}

export function parseEmailDesign(raw: string | null | undefined): EmailDesign {
	if (!raw) return DEFAULT_EMAIL_DESIGN;
	try {
		return readEmailDesign(JSON.parse(raw)) ?? DEFAULT_EMAIL_DESIGN;
	} catch {
		return DEFAULT_EMAIL_DESIGN;
	}
}

export function customText(custom: EmailTexts | undefined, field: EmailTextField, fallback: string, params: Record<string, string>): string {
	const template = custom?.[field];
	if (!template) return fallback;
	return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? params[name] : match));
}
