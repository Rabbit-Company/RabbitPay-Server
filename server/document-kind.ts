import type { TranslationKey } from "./i18n";

export type DocumentKind = "invoice" | "advance" | "proforma" | "order";

export interface KindedDocument {
	kind: DocumentKind;
	proforma: { settlement: "invoice" | "advance" } | null;
	source_proforma: string | null;
	invoice: { issued: number; supply_date: number | null; due_date: number | null; paid_date: number | null };
}

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

export const DOCUMENT_TITLES: Record<DocumentKind, TranslationKey> = {
	invoice: "invoice.title",
	advance: "invoice.title_advance",
	proforma: "invoice.title_proforma",
	order: "invoice.title_order",
};

export function documentDateRows(document: KindedDocument): [TranslationKey, number][] {
	const { invoice } = document;
	const rows: [TranslationKey, number | null][] =
		document.kind === "proforma"
			? [
					["invoice.issued", invoice.issued],
					["invoice.valid_until", invoice.due_date],
				]
			: document.kind === "order"
				? [
						["invoice.issued", invoice.issued],
						["invoice.pay_by", invoice.due_date],
					]
				: [
						["invoice.issued", invoice.issued],
						["invoice.supplied", invoice.supply_date],
						["invoice.due", document.kind === "advance" ? null : invoice.due_date],
						["invoice.paid", invoice.paid_date],
					];
	return rows.filter((row): row is [TranslationKey, number] => row[1] !== null);
}

export function documentNote(document: KindedDocument, t: Translate): string | null {
	if (document.kind === "proforma") return t(document.proforma?.settlement === "advance" ? "invoice.proforma_note_advance" : "invoice.proforma_note");
	if (document.kind === "order") return t("invoice.order_note");
	if (document.kind === "advance" && document.source_proforma) return t("invoice.advance_note", { reference: document.source_proforma });
	return null;
}
