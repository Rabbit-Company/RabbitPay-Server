import { isAccentColor } from "./colors";

export const INVOICE_LAYOUTS = ["classic", "modern", "compact"] as const;
export const INVOICE_FONTS = ["sans", "serif"] as const;
export const INVOICE_LOGO_SIZES = ["small", "medium", "large"] as const;
export const INVOICE_LOGO_POSITIONS = ["left", "right"] as const;

export type InvoiceLayout = (typeof INVOICE_LAYOUTS)[number];
export type InvoiceFont = (typeof INVOICE_FONTS)[number];
export type InvoiceLogoSize = (typeof INVOICE_LOGO_SIZES)[number];
export type InvoiceLogoPosition = (typeof INVOICE_LOGO_POSITIONS)[number];

export interface InvoiceDesign {
	layout: InvoiceLayout;
	font: InvoiceFont;
	accent: string | null;
	logo_size: InvoiceLogoSize;
	logo_position: InvoiceLogoPosition;
	header_text: string | null;
	footer_text: string | null;
	notes: { invoice: string | null; credit_note: string | null; receipt: string | null };
	show: { email: boolean; phone: boolean; website: boolean };
}

export const DEFAULT_INVOICE_DESIGN: InvoiceDesign = {
	layout: "classic",
	font: "sans",
	accent: null,
	logo_size: "medium",
	logo_position: "left",
	header_text: null,
	footer_text: null,
	notes: { invoice: null, credit_note: null, receipt: null },
	show: { email: true, phone: true, website: true },
};

export const LOGO_BOXES: Record<InvoiceLogoSize, { width: number; height: number }> = {
	small: { width: 110, height: 30 },
	medium: { width: 160, height: 44 },
	large: { width: 220, height: 64 },
};

export const INVOICE_TEXT_LIMITS = {
	header_text: 200,
	footer_text: 500,
	note: 1000,
} as const;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): T | undefined {
	return options.includes(value as T) ? (value as T) : undefined;
}

function text(value: unknown, max: number): string | null | undefined {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || value.length > max) return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

export function readInvoiceDesign(value: unknown): InvoiceDesign | null {
	if (!isObject(value) || !isObject(value.notes) || !isObject(value.show)) return null;

	const layout = oneOf(value.layout, INVOICE_LAYOUTS);
	const font = oneOf(value.font, INVOICE_FONTS);
	const logoSize = oneOf(value.logo_size, INVOICE_LOGO_SIZES);
	const logoPosition = oneOf(value.logo_position, INVOICE_LOGO_POSITIONS);
	const accent = value.accent === null || value.accent === undefined ? null : isAccentColor(value.accent) ? value.accent : undefined;
	const header = text(value.header_text, INVOICE_TEXT_LIMITS.header_text);
	const footer = text(value.footer_text, INVOICE_TEXT_LIMITS.footer_text);
	const invoiceNote = text(value.notes.invoice, INVOICE_TEXT_LIMITS.note);
	const creditNote = text(value.notes.credit_note, INVOICE_TEXT_LIMITS.note);
	const receiptNote = text(value.notes.receipt, INVOICE_TEXT_LIMITS.note);
	const { email, phone, website } = value.show;

	if (!layout || !font || !logoSize || !logoPosition || accent === undefined) return null;
	if (header === undefined || footer === undefined || invoiceNote === undefined || creditNote === undefined || receiptNote === undefined) return null;
	if (typeof email !== "boolean" || typeof phone !== "boolean" || typeof website !== "boolean") return null;

	return {
		layout,
		font,
		accent,
		logo_size: logoSize,
		logo_position: logoPosition,
		header_text: header,
		footer_text: footer,
		notes: { invoice: invoiceNote, credit_note: creditNote, receipt: receiptNote },
		show: { email, phone, website },
	};
}

export function parseInvoiceDesign(raw: string | null | undefined): InvoiceDesign {
	if (!raw) return DEFAULT_INVOICE_DESIGN;
	try {
		return readInvoiceDesign(JSON.parse(raw)) ?? DEFAULT_INVOICE_DESIGN;
	} catch {
		return DEFAULT_INVOICE_DESIGN;
	}
}

export function withDesignDefaults(design: Partial<InvoiceDesign> | null | undefined): InvoiceDesign {
	if (!design) return DEFAULT_INVOICE_DESIGN;
	return readInvoiceDesign({ ...DEFAULT_INVOICE_DESIGN, ...design }) ?? DEFAULT_INVOICE_DESIGN;
}
