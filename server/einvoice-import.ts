import Database from "./database/database";
import { companyFor } from "./company";
import { minorUnitDigits } from "./invoicing";
import { isEuCountry, splitVatNumber } from "./tax";
import { t } from "./i18n";
import { isLocalDate, localDate, startOfLocalDate } from "./timezone";
import { isCountryCode } from "./countries";
import { child, children, decodeXmlBytes, parseXml, textOf, XmlSyntaxError, type XmlElement } from "./xml-reader";
import type { ExpenseInput, ExpenseVatLineInput, ExpenseVatTreatment } from "./expense-types";
import type { ProjectRow } from "./database/models";

export const MAX_EINVOICE_BYTES = 5 * 1024 * 1024;
export const EINVOICE_CONTENT_TYPE = "application/xml";
const DEFAULT_CATEGORY = "Other";

export class EinvoiceUnreadable extends Error {}

export interface IncomingParty {
	name: string | null;
	vat_number: string | null;
	tax_number: string | null;
	country: string | null;
}

export interface IncomingVatGroup {
	category: string;
	rate: number;
	taxable: number;
	tax: number;
}

export interface IncomingInvoice {
	format: "eslog" | "ubl";
	document_type: "invoice" | "credit_note";
	number: string;
	issue_date: string;
	supply_date: string | null;
	due_date: string | null;
	currency: string;
	seller: IncomingParty;
	buyer: IncomingParty;
	lines: { description: string; quantity: number | null; amount: number }[];
	vat: IncomingVatGroup[];
	net_total: number;
	tax_total: number;
	gross_total: number;
	amount_due: number;
	iban: string | null;
	payment_reference: string | null;
}

export interface ImportWarning {
	code: string;
	message: string;
}

export interface ImportSuggestion {
	expense: ExpenseInput;
	invoice: IncomingInvoice;
	warnings: ImportWarning[];
	duplicate: string | null;
}

function minor(value: string | null, currency: string): number {
	if (value === null) return 0;
	const parsed = Number(value.replace(",", "."));
	if (!Number.isFinite(parsed)) throw new EinvoiceUnreadable(`The amount ${value} is not a number.`);
	return Math.round(parsed * Math.pow(10, minorUnitDigits(currency)));
}

function rate(value: string | null): number {
	const parsed = Number((value ?? "0").replace(",", "."));
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : 0;
}

function day(value: string | null): string | null {
	const date = value?.slice(0, 10) ?? null;
	return date && isLocalDate(date) ? date : null;
}

function country(value: string | null): string | null {
	const code = value?.trim().toUpperCase() ?? null;
	return code && isCountryCode(code) ? code : null;
}

function required<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined || value === "") throw new EinvoiceUnreadable(`The e-invoice has no ${what}.`);
	return value;
}

function moa(entries: XmlElement[], qualifier: string): string | null {
	for (const entry of entries) {
		const amount = child(entry, "C_C516") ?? child(entry, "S_MOA", "C_C516");
		if (textOf(amount, "D_5025") === qualifier) return textOf(amount, "D_5004");
	}
	return null;
}

function eslogParty(group: XmlElement | undefined): IncomingParty {
	const nad = child(group, "S_NAD");
	const references = children(group, "G_SG3").map((entry) => ({
		qualifier: textOf(entry, "S_RFF", "C_C506", "D_1153"),
		value: textOf(entry, "S_RFF", "C_C506", "D_1154"),
	}));
	const valueOf = (qualifier: string) => references.find((entry) => entry.qualifier === qualifier)?.value ?? null;
	return {
		name: textOf(nad, "C_C080", "D_3036"),
		vat_number: valueOf("VA"),
		tax_number: valueOf("AHP"),
		country: country(textOf(nad, "D_3207")),
	};
}

function parseEslog(root: XmlElement): IncomingInvoice {
	const message = required(child(root, "M_INVOIC"), "message");
	const dates = children(message, "S_DTM").map((entry) => ({ qualifier: textOf(entry, "C_C507", "D_2005"), value: textOf(entry, "C_C507", "D_2380") }));
	const dateOf = (qualifier: string) => day(dates.find((entry) => entry.qualifier === qualifier)?.value ?? null);
	const currencyGroup = children(message, "G_SG7").find((entry) => textOf(entry, "S_CUX", "C_C504", "D_6347") === "2");
	const currency = required(textOf(currencyGroup, "S_CUX", "C_C504", "D_6345"), "currency").toUpperCase();
	const parties = children(message, "G_SG2");
	const partyOf = (role: string) => eslogParty(parties.find((entry) => textOf(entry, "S_NAD", "D_3035") === role));
	const sellerGroup = parties.find((entry) => textOf(entry, "S_NAD", "D_3035") === "SE");
	const totals = children(message, "G_SG50");
	const totalOf = (qualifier: string) => moa(totals, qualifier);
	const references = children(message, "G_SG1").map((entry) => ({
		qualifier: textOf(entry, "S_RFF", "C_C506", "D_1153"),
		value: textOf(entry, "S_RFF", "C_C506", "D_1154"),
	}));
	const payment = children(message, "G_SG8")[0];
	const bankAccount = children(sellerGroup, "S_FII").find((entry) => textOf(entry, "D_3035") === "RB");
	const type = textOf(message, "S_BGM", "C_C002", "D_1001");
	const gross = totalOf("388");

	return {
		format: "eslog",
		document_type: type === "381" ? "credit_note" : "invoice",
		number: required(textOf(message, "S_BGM", "C_C106", "D_1004"), "invoice number"),
		issue_date: required(dateOf("137"), "issue date"),
		supply_date: dateOf("35"),
		due_date: day(textOf(payment, "S_DTM", "C_C507", "D_2380")),
		currency,
		seller: partyOf("SE"),
		buyer: partyOf("BY"),
		lines: children(message, "G_SG26").map((line) => ({
			description: textOf(line, "S_IMD", "C_C273", "D_7008") ?? "",
			quantity: textOf(line, "S_QTY", "C_C186", "D_6060") === null ? null : Number(textOf(line, "S_QTY", "C_C186", "D_6060")),
			amount: minor(moa(children(line, "G_SG27"), "203"), currency),
		})),
		vat: children(message, "G_SG52")
			.filter((group) => (textOf(group, "S_TAX", "C_C241", "D_5153") ?? "VAT") === "VAT")
			.map((group) => ({
				category: textOf(group, "S_TAX", "D_5305") ?? "S",
				rate: rate(textOf(group, "S_TAX", "C_C243", "D_5278")),
				taxable: minor(moa(children(group, "S_MOA"), "125"), currency),
				tax: minor(moa(children(group, "S_MOA"), "124"), currency),
			})),
		net_total: minor(totalOf("389") ?? totalOf("79"), currency),
		tax_total: minor(totalOf("176"), currency),
		gross_total: minor(required(gross, "total amount"), currency),
		amount_due: minor(totalOf("9") ?? gross, currency),
		iban: textOf(bankAccount, "C_C078", "D_3194"),
		payment_reference: references.find((entry) => entry.qualifier === "PQ")?.value ?? null,
	};
}

function ublParty(party: XmlElement | undefined): IncomingParty {
	const schemes = children(party, "PartyTaxScheme").map((scheme) => ({ id: textOf(scheme, "CompanyID"), scheme: textOf(scheme, "TaxScheme", "ID") }));
	const vat = schemes.find((scheme) => (scheme.scheme ?? "VAT").toUpperCase() === "VAT")?.id ?? null;
	const other = schemes.find((scheme) => scheme.scheme && scheme.scheme.toUpperCase() !== "VAT")?.id ?? null;
	return {
		name: textOf(party, "PartyLegalEntity", "RegistrationName") ?? textOf(party, "PartyName", "Name"),
		vat_number: vat,
		tax_number: other,
		country: country(textOf(party, "PostalAddress", "Country", "IdentificationCode")),
	};
}

function parseUbl(root: XmlElement): IncomingInvoice {
	const credit = root.name === "CreditNote";
	const currency = required(textOf(root, "DocumentCurrencyCode"), "currency").toUpperCase();
	const taxTotal = children(root, "TaxTotal").find((total) => (child(total, "TaxAmount")?.attributes["currencyID"] ?? currency).toUpperCase() === currency);
	const monetary = child(root, "LegalMonetaryTotal");
	const payment = child(root, "PaymentMeans");
	const gross = textOf(monetary, "TaxInclusiveAmount");

	return {
		format: "ubl",
		document_type: credit || textOf(root, "InvoiceTypeCode") === "381" ? "credit_note" : "invoice",
		number: required(textOf(root, "ID"), "invoice number"),
		issue_date: required(day(textOf(root, "IssueDate")), "issue date"),
		supply_date: day(textOf(root, "Delivery", "ActualDeliveryDate")),
		due_date: day(textOf(root, "DueDate") ?? textOf(payment, "PaymentDueDate")),
		currency,
		seller: ublParty(child(root, "AccountingSupplierParty", "Party")),
		buyer: ublParty(child(root, "AccountingCustomerParty", "Party")),
		lines: children(root, credit ? "CreditNoteLine" : "InvoiceLine").map((line) => {
			const quantity = textOf(line, credit ? "CreditedQuantity" : "InvoicedQuantity");
			return {
				description: textOf(line, "Item", "Name") ?? textOf(line, "Item", "Description") ?? "",
				quantity: quantity === null ? null : Number(quantity),
				amount: minor(textOf(line, "LineExtensionAmount"), currency),
			};
		}),
		vat: children(taxTotal, "TaxSubtotal").map((subtotal) => ({
			category: textOf(subtotal, "TaxCategory", "ID") ?? "S",
			rate: rate(textOf(subtotal, "TaxCategory", "Percent")),
			taxable: minor(textOf(subtotal, "TaxableAmount"), currency),
			tax: minor(textOf(subtotal, "TaxAmount"), currency),
		})),
		net_total: minor(textOf(monetary, "TaxExclusiveAmount") ?? textOf(monetary, "LineExtensionAmount"), currency),
		tax_total: minor(textOf(taxTotal, "TaxAmount"), currency),
		gross_total: minor(required(gross, "total amount"), currency),
		amount_due: minor(textOf(monetary, "PayableAmount") ?? gross, currency),
		iban: textOf(payment, "PayeeFinancialAccount", "ID"),
		payment_reference: textOf(payment, "PaymentID"),
	};
}

export function readIncomingInvoice(bytes: Uint8Array): IncomingInvoice {
	if (bytes.length === 0 || bytes.length > MAX_EINVOICE_BYTES) throw new EinvoiceUnreadable("The file is empty or larger than 5 MB.");
	let root: XmlElement;
	try {
		root = parseXml(decodeXmlBytes(bytes));
	} catch (err) {
		if (err instanceof XmlSyntaxError) throw new EinvoiceUnreadable(`The file is not valid XML. ${err.message}`);
		throw err;
	}
	const namespace = root.attributes["xmlns"] ?? "";
	if (root.name === "Invoice" && namespace === "urn:eslog:2.00") return parseEslog(root);
	if ((root.name === "Invoice" || root.name === "CreditNote") && namespace.startsWith("urn:oasis:names:specification:ubl:schema:xsd:")) return parseUbl(root);
	if (root.name === "Invoice" && child(root, "M_INVOIC")) return parseEslog(root);
	throw new EinvoiceUnreadable("The file is not an e-SLOG 2.0 or UBL 2.1 invoice.");
}

function compactId(value: string | null | undefined, fallbackCountry: string | null): string | null {
	if (!value?.trim()) return null;
	return splitVatNumber(value, fallbackCountry)?.number ?? value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function vatTreatment(invoice: IncomingInvoice, project: Pick<ProjectRow, "vat_status" | "tax_country">): ExpenseVatTreatment {
	if (project.vat_status !== "registered" || !project.tax_country) return "not_reported";
	const categories = new Set(invoice.vat.map((group) => group.category));
	const sellerCountry = invoice.seller.country ?? splitVatNumber(invoice.seller.vat_number, null)?.country ?? null;
	if (categories.size === 0 || [...categories].every((category) => category === "O")) return "not_reported";

	if (sellerCountry === null || sellerCountry === project.tax_country) {
		if (categories.has("AE")) return "domestic_reverse_charge";
		if ([...categories].every((category) => category === "E")) return "exempt";
		return "domestic";
	}
	if (isEuCountry(sellerCountry)) {
		if (categories.has("K")) return "eu_goods";
		if (categories.has("AE")) return "eu_services";
	}
	return "not_reported";
}

async function duplicateOf(projectId: string, invoice: IncomingInvoice): Promise<string | null> {
	const taxNumber = invoice.seller.vat_number ?? invoice.seller.tax_number;
	const [row] = (await Database`
		SELECT uuid FROM expenses WHERE project = ${projectId} AND invoice_number = ${invoice.number}
			AND (supplier_tax_number = ${taxNumber} OR supplier = ${invoice.seller.name})
		LIMIT 1
	`) as { uuid: string }[];
	return row?.uuid ?? null;
}

export async function suggestExpense(project: ProjectRow, invoice: IncomingInvoice, now = Date.now()): Promise<ImportSuggestion> {
	if (invoice.document_type === "credit_note" || invoice.gross_total <= 0) {
		throw new EinvoiceUnreadable("Supplier credit notes cannot be imported as expenses. Record them against the original expense instead.");
	}

	const language = project.language;
	const timezone = project.timezone;
	const warnings: ImportWarning[] = [];
	const warn = (code: string, message: string) => warnings.push({ code, message });
	const registered = project.vat_status === "registered";
	const treatment = vatTreatment(invoice, project);
	const reportable = treatment !== "not_reported";
	const supplier = invoice.seller.name ?? invoice.seller.vat_number ?? invoice.seller.tax_number;

	const groups = invoice.vat.length > 0 ? invoice.vat : [{ category: "S", rate: 0, taxable: invoice.net_total, tax: invoice.tax_total }];
	const vatLines: ExpenseVatLineInput[] = reportable
		? groups.map((group) => ({ rate: group.rate, tax_base: group.taxable, tax_amount: group.tax, deductible_tax_amount: registered ? group.tax : 0 }))
		: [];
	const taxAmount = reportable ? vatLines.reduce((sum, line) => sum + line.tax_amount, 0) : invoice.tax_total;
	const deductible = reportable ? vatLines.reduce((sum, line) => sum + line.deductible_tax_amount, 0) : 0;

	const company = await companyFor(project.uuid);
	const ours = [company.vat_number, company.tax_number].map((value) => compactId(value, company.country)).filter(Boolean);
	const theirs = [invoice.buyer.vat_number, invoice.buyer.tax_number].map((value) => compactId(value, invoice.buyer.country)).filter(Boolean);
	if (ours.length > 0 && theirs.length > 0 && !theirs.some((value) => ours.includes(value))) {
		warn("buyer_mismatch", `The invoice is addressed to ${invoice.buyer.name ?? theirs[0]}, not to your company.`);
	}
	const lineTotal = groups.reduce((sum, group) => sum + group.taxable + group.tax, 0);
	if (invoice.vat.length > 0 && Math.abs(lineTotal - invoice.gross_total) > groups.length) {
		warn("totals_mismatch", "The VAT breakdown does not add up to the invoice total. Check the amounts before saving.");
	}
	if (treatment === "domestic_reverse_charge" || treatment === "eu_services" || treatment === "eu_goods") {
		warn("reverse_charge", "VAT is charged under the reverse charge. Record the VAT you owe on it before saving.");
	}
	if (reportable && invoice.currency !== "EUR") {
		warn("exchange_rate", `The invoice is in ${invoice.currency}. Enter the exchange rate before saving.`);
	}
	if (!registered) warn("not_registered", "Your project is not VAT registered, so the VAT is recorded as part of the cost.");

	const receipt = startOfLocalDate(localDate(now, timezone), timezone);
	const issued = startOfLocalDate(invoice.issue_date, timezone);
	const notes = [
		invoice.iban ? `IBAN ${invoice.iban}` : null,
		invoice.payment_reference ? t(language, "expense.import_reference", { reference: invoice.payment_reference }) : null,
		invoice.due_date ? t(language, "expense.import_due", { date: invoice.due_date }) : null,
	].filter((line): line is string => line !== null);
	const [onlyLine] = invoice.lines;
	const description =
		invoice.lines.length === 1 && onlyLine.description
			? onlyLine.description
			: t(language, "expense.import_description", { number: invoice.number, supplier: supplier ?? "" });

	return {
		invoice,
		warnings,
		duplicate: await duplicateOf(project.uuid, invoice),
		expense: {
			description: Array.from(description).slice(0, 240).join(""),
			supplier: supplier ? Array.from(supplier).slice(0, 240).join("") : null,
			supplier_tax_number: invoice.seller.vat_number ?? invoice.seller.tax_number,
			supplier_country: invoice.seller.country,
			invoice_number: invoice.number.slice(0, 250),
			category: DEFAULT_CATEGORY,
			currency: invoice.currency,
			total_amount: invoice.gross_total,
			tax_amount: taxAmount,
			deductible_tax_amount: deductible,
			expense_date: issued,
			issue_date: issued,
			receipt_date: receipt,
			supply_date: invoice.supply_date ? startOfLocalDate(invoice.supply_date, timezone) : null,
			due_date: invoice.due_date ? startOfLocalDate(invoice.due_date, timezone) : null,
			vat_treatment: treatment,
			asset_type: "expense",
			vat_handling: "1",
			self_assessment_period: null,
			self_assessment_tax: null,
			tax_exchange_rate: null,
			tax_rate_date: null,
			paid_at: invoice.amount_due <= 0 ? issued : null,
			notes: notes.length > 0 ? notes.join("\n") : null,
			vat_lines: vatLines,
		},
	};
}
