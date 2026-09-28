import Validate from "./validate";
import type { InvoiceRow } from "./database/models";

export type ReferenceDocumentType = "order" | "contract";

export const REFERENCE_DOCUMENT_TYPES: readonly ReferenceDocumentType[] = ["order", "contract"];

export const REFERENCE_NUMBER_LIMIT = 70;

export interface ReferenceDocumentInput {
	reference_document_type?: string | null;
	reference_document_number?: string | null;
	reference_document_date?: number | null;
}

export type ReferenceDocumentColumns = Pick<InvoiceRow, "reference_document_type" | "reference_document_number" | "reference_document_date">;

export interface ReferenceDocument {
	type: ReferenceDocumentType;
	number: string;
	date: number | null;
}

export const NO_REFERENCE_DOCUMENT: ReferenceDocumentColumns = {
	reference_document_type: null,
	reference_document_number: null,
	reference_document_date: null,
};

export function isReferenceDocumentType(value: unknown): value is ReferenceDocumentType {
	return typeof value === "string" && REFERENCE_DOCUMENT_TYPES.includes(value as ReferenceDocumentType);
}

export function resolveReferenceDocument(input: ReferenceDocumentInput, current = NO_REFERENCE_DOCUMENT): ReferenceDocumentColumns | null {
	const number = input.reference_document_number === undefined ? current.reference_document_number : input.reference_document_number;
	const type = input.reference_document_type === undefined ? current.reference_document_type : input.reference_document_type;
	const date = input.reference_document_date === undefined ? current.reference_document_date : input.reference_document_date;

	if (number !== null && typeof number !== "string") return null;
	const trimmed = number?.trim() ?? "";
	if (trimmed === "") return NO_REFERENCE_DOCUMENT;

	if (!Validate.shortText(trimmed, REFERENCE_NUMBER_LIMIT)) return null;
	if (!isReferenceDocumentType(type)) return null;
	if (date !== null && (typeof date !== "number" || !Number.isSafeInteger(date) || date <= 0)) return null;

	return { reference_document_type: type, reference_document_number: trimmed, reference_document_date: date };
}

export function referenceDocumentRow(
	reference: ReferenceDocument | null | undefined,
	t: (key: "invoice.reference_order" | "invoice.reference_contract") => string,
	dateOf: (value: number) => string
): [string, string] | null {
	if (!reference) return null;
	const label = t(reference.type === "order" ? "invoice.reference_order" : "invoice.reference_contract");
	return [label, reference.date === null ? reference.number : `${reference.number} (${dateOf(reference.date)})`];
}

export function referenceDocumentOf(invoice: ReferenceDocumentColumns): ReferenceDocument | null {
	if (!invoice.reference_document_number || !isReferenceDocumentType(invoice.reference_document_type)) return null;
	return { type: invoice.reference_document_type, number: invoice.reference_document_number, date: invoice.reference_document_date };
}
