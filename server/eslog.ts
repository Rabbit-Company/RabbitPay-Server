import { t, type TranslationKey } from "./i18n";
import { localDate } from "./timezone";
import { minorUnitDigits } from "./invoicing";
import { normalizeVatNumber, splitVatNumber } from "./tax";
import type { CompanyDetails } from "./company";
import type { InvoiceRecipient } from "./invoice-recipient";
import type { BankInstruction } from "./payments/bank";
import type { FiscalMarks } from "./fiscal/documents";
import { invoiceDocument } from "./invoice-document";
import { creditNoteDocument } from "./credit-note-document";
import { creditNoteFilename, invoiceFilename } from "./invoice-pdf";
import { node, serialize, withAttributes, withNamespaces, type XmlNode } from "./xml";
import { signedCopy } from "./xades";
import type { FursCredentials } from "./furs/credentials";
import { DEFAULT_UNIT_CODE } from "./measure-units";
import Database from "./database/database";
import { referenceDocumentOf, type ReferenceDocument, type ReferenceDocumentType } from "./reference-document";
import type { CreditNoteRow, CustomerRow, InvoiceRow, ProjectRow } from "./database/models";

type InvoiceDocument = Awaited<ReturnType<typeof invoiceDocument>>;
type CreditNoteDocument = Awaited<ReturnType<typeof creditNoteDocument>>;

export const ESLOG_CONTENT_TYPE = "application/xml";
export const ESLOG_NAMESPACE = "urn:eslog:2.00";
const XSI_NAMESPACE = "http://www.w3.org/2001/XMLSchema-instance";
export const EN16931_SPECIFICATION = "urn:cen.eu:en16931:2017";
const MAX_VAT_BREAKDOWNS = 10;
const TEXT_LIMIT = 512;
const TEXT_LINES = 5;

export type VatCategory = "S" | "Z" | "E" | "AE" | "K" | "G" | "O";

const EXEMPTION_CODES: Partial<Record<VatCategory, string>> = {
	AE: "VATEX-EU-AE",
	K: "VATEX-EU-IC",
	G: "VATEX-EU-G",
	O: "VATEX-EU-O",
};

const REFERENCE_QUALIFIERS: Record<ReferenceDocumentType, string> = {
	order: "ON",
	contract: "CT",
};

const EXEMPTION_NOTES: Partial<Record<string, TranslationKey>> = {
	reverse_charge: "tax.note.reverse_charge",
	domestic_reverse_charge: "tax.note.domestic_reverse_charge.SI",
	intra_eu_goods: "tax.note.intra_eu_goods",
	export: "tax.note.export",
	outside_scope: "tax.note.outside_scope",
	exempt: "tax.note.exempt",
};

export interface EslogLine {
	description: string;
	quantity: number;
	unit: string | null;
	price: number;
	amount: number;
	allowance: number;
	tax_rate: number;
	tax_amount: number;
	treatment: string | null;
}

export interface EslogSource {
	kind: "invoice" | "credit_note";
	advance?: boolean;
	reference: string;
	issued: number;
	supply_date: number | null;
	due_date: number | null;
	timezone: string;
	language: string;
	currency: string;
	notes: string[];
	seller: CompanyDetails & { name: string };
	buyer: InvoiceRecipient | null;
	vat_status: string | null;
	exemption_note: string | null;
	reporting: { currency: string; tax_amount: number } | null;
	lines: EslogLine[];
	prepaid: number;
	bank: BankInstruction | null;
	card: boolean;
	fiscal: FiscalMarks | null;
	corrects: { reference: string; issued: number } | null;
	reference_document: ReferenceDocument | null;
}

export interface EslogIssue {
	code: string;
	field: string;
	message: string;
}

export class EslogDataIncomplete extends Error {
	readonly issues: EslogIssue[];

	constructor(issues: EslogIssue[]) {
		super(`The e-SLOG invoice cannot be created. ${issues.map((issue) => issue.message).join(" ")}`);
		this.issues = issues;
	}
}

function unitPrice(item: { quantity: number; unit_price: number; total_price: number }): number {
	if (item.quantity <= 0) return item.total_price;
	if (Math.round(item.quantity * item.unit_price) === item.total_price) return item.unit_price;
	return item.total_price / item.quantity;
}

export function invoiceSource(document: InvoiceDocument): EslogSource {
	const invoice = document.invoice;
	const settled = Math.max(invoice.paid_amount - invoice.refunded_amount, 0);

	return {
		kind: "invoice",
		advance: document.kind === "advance",
		reference: invoice.reference,
		issued: invoice.issued,
		supply_date: invoice.supply_date,
		due_date: invoice.due_date,
		timezone: document.formats.timezone,
		language: document.language,
		currency: invoice.currency,
		notes: invoice.notes?.trim() ? [invoice.notes.trim()] : [],
		seller: document.seller,
		buyer: document.buyer,
		vat_status: document.tax.vat_status,
		exemption_note: document.tax.exemption_note,
		reporting: document.tax.reporting,
		lines: document.items.map((item) => ({
			description: item.description,
			quantity: item.quantity,
			unit: item.unit,
			price: unitPrice(item),
			amount: item.total_price,
			allowance: item.discount_amount,
			tax_rate: item.tax_rate,
			tax_amount: item.tax_amount,
			treatment: item.tax_treatment,
		})),
		prepaid: Math.min(settled, invoice.total_amount),
		bank: document.bank,
		card: document.online.card,
		fiscal: document.fiscal,
		corrects: null,
		reference_document: invoice.reference_document,
	};
}

export function creditNoteSource(document: CreditNoteDocument, referenceDocument: ReferenceDocument | null): EslogSource {
	const note = document.credit_note;

	return {
		kind: "credit_note",
		advance: false,
		reference: note.reference,
		issued: note.issued,
		supply_date: null,
		due_date: null,
		timezone: document.formats.timezone,
		language: document.language,
		currency: note.currency,
		notes: note.reason?.trim() ? [note.reason.trim()] : [],
		seller: document.seller,
		buyer: document.buyer,
		vat_status: document.tax.vat_status,
		exemption_note: document.tax.exemption_note,
		reporting: document.tax.reporting,
		lines: document.items.map((item) => ({
			description: item.description,
			quantity: 1,
			unit: null,
			price: item.net_amount,
			amount: item.net_amount,
			allowance: 0,
			tax_rate: item.tax_rate,
			tax_amount: item.tax_amount,
			treatment: item.tax_treatment,
		})),
		prepaid: 0,
		bank: null,
		card: false,
		fiscal: document.fiscal,
		corrects: { reference: document.corrects.reference, issued: document.corrects.issued },
		reference_document: referenceDocument,
	};
}

export function vatCategory(treatment: string | null, rate: number, vatStatus: string | null): VatCategory {
	if ((vatStatus === "small_business" || vatStatus === "not_registered") && rate === 0) return "O";

	switch (treatment) {
		case "small_business":
		case "outside_scope":
			return "O";
		case "reverse_charge":
		case "domestic_reverse_charge":
			return "AE";
		case "intra_eu_goods":
			return "K";
		case "export":
			return "G";
		case "exempt":
			return "E";
	}

	return rate > 0 ? "S" : "Z";
}

function present(value: string | null | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

interface PartyReference {
	qualifier: string;
	value: string;
}

function localTaxNumber(party: { vat_number?: string | null; tax_number?: string | null; country?: string | null }): string | null {
	if (present(party.tax_number)) return party.tax_number.trim();
	if (!present(party.vat_number)) return null;
	return splitVatNumber(party.vat_number, party.country)?.number ?? party.vat_number.trim();
}

function sellerReferences(seller: EslogSource["seller"], vatStatus: string | null, outsideScope: boolean): PartyReference[] {
	const references: PartyReference[] = [];
	if (present(seller.registration_number)) references.push({ qualifier: "0199", value: seller.registration_number.trim() });

	const vat = vatStatus === "registered" ? normalizeVatNumber(seller.vat_number, seller.country) : null;
	if (vat && !outsideScope) references.push({ qualifier: "VA", value: vat });

	const taxNumber = vat ?? localTaxNumber(seller);
	if (taxNumber) references.push({ qualifier: "AHP", value: taxNumber });
	return references;
}

function buyerReferences(buyer: InvoiceRecipient, outsideScope: boolean): PartyReference[] {
	const references: PartyReference[] = [];
	if (present(buyer.registration_number)) references.push({ qualifier: "0199", value: buyer.registration_number.trim() });
	const vat = normalizeVatNumber(buyer.vat_number, buyer.country);
	if (vat && !outsideScope) references.push({ qualifier: "VA", value: vat });

	const taxNumber = vat ?? (present(buyer.tax_number) ? buyer.tax_number.trim() : null);
	if (taxNumber) references.push({ qualifier: "AHP", value: taxNumber });
	return references;
}

interface VatBreakdown {
	category: VatCategory;
	rate: number;
	taxable: number;
	tax: number;
}

function categorizedLines(source: EslogSource) {
	return source.lines.map((line) => ({ ...line, category: vatCategory(line.treatment, line.tax_rate, source.vat_status) }));
}

function breakdownOf(lines: ReturnType<typeof categorizedLines>): VatBreakdown[] {
	const groups = new Map<string, VatBreakdown>();
	for (const line of lines) {
		const rate = line.category === "O" ? 0 : line.tax_rate;
		const key = `${line.category}:${rate}`;
		const group = groups.get(key) ?? { category: line.category, rate, taxable: 0, tax: 0 };
		group.taxable += line.amount - line.allowance;
		group.tax += line.tax_amount;
		groups.set(key, group);
	}
	return [...groups.values()];
}

export function eslogIssues(source: EslogSource): EslogIssue[] {
	const issues: EslogIssue[] = [];
	const add = (code: string, field: string, message: string) => issues.push({ code, field, message });
	const seller = source.seller;
	const buyer = source.buyer;

	if (!present(seller.country)) add("seller_country", "company.country", "Add the seller's country under Company details.");
	if (!present(seller.vat_number) && !present(seller.tax_number)) {
		add("seller_tax_number", "company.tax_number", "Add the seller's VAT ID or tax number under Company details.");
	}

	if (!buyer) {
		add("buyer", "invoice.customer", "Add a customer to the invoice. An e-SLOG invoice needs the buyer's details.");
	} else {
		if (!present(buyer.name)) add("buyer_name", "customer.name", "Add the customer's name.");
		if (!present(buyer.country)) add("buyer_country", "customer.country", "Add the customer's country.");
		if (!present(buyer.vat_number) && !present(buyer.tax_number)) {
			add("buyer_tax_number", "customer.tax_number", "Add the customer's VAT ID or tax number.");
		}
	}

	if (source.lines.length === 0) add("lines", "invoice.items", "Add at least one line.");
	if (breakdownOf(categorizedLines(source)).length > MAX_VAT_BREAKDOWNS) {
		add("vat_breakdowns", "invoice.items.tax_rate", `An e-SLOG invoice can list at most ${MAX_VAT_BREAKDOWNS} different VAT rates and treatments.`);
	}

	return issues;
}

function field(name: string, value: string | null | undefined): XmlNode | null {
	return present(value) ? node(name, value) : null;
}

function clip(value: string, limit: number): string {
	const characters = Array.from(value.trim());
	return characters.length > limit ? characters.slice(0, limit).join("") : value.trim();
}

function chunks(value: string, limit: number): string[] {
	const characters = Array.from(value);
	const parts: string[] = [];
	for (let start = 0; start < characters.length; start += limit) parts.push(characters.slice(start, start + limit).join(""));
	return parts;
}

function wrapped(lines: (string | null | undefined)[], limit: number, count: number): string[] {
	const result: string[] = [];
	for (const line of lines) {
		if (!present(line)) continue;
		let current = "";
		for (const word of line.trim().split(/\s+/)) {
			for (const piece of chunks(word, limit)) {
				const candidate = current ? `${current} ${piece}` : piece;
				if (Array.from(candidate).length <= limit) {
					current = candidate;
				} else {
					result.push(current);
					current = piece;
				}
			}
		}
		if (current) result.push(current);
	}
	return result.slice(0, count);
}

function amount(minor: number, currency: string): string {
	const digits = minorUnitDigits(currency);
	const sign = minor < 0 ? "-" : "";
	const whole = Math.abs(Math.round(minor))
		.toString()
		.padStart(digits + 1, "0");
	return digits === 0 ? `${sign}${whole}` : `${sign}${whole.slice(0, -digits)}.${whole.slice(-digits)}`;
}

function price(minor: number, currency: string): string {
	return (minor / Math.pow(10, minorUnitDigits(currency))).toFixed(4);
}

function decimal(value: number): string {
	const fixed = value.toFixed(6);
	return fixed.replace(/\.?0+$/, "");
}

function date(timestamp: number, timezone: string): string {
	return localDate(timestamp, timezone);
}

function dtm(qualifier: string, value: string | null): XmlNode {
	return node("S_DTM", node("C_C507", node("D_2005", qualifier), field("D_2380", value)));
}

function moa(qualifier: string, value: string): XmlNode {
	return node("S_MOA", node("C_C516", node("D_5025", qualifier), node("D_5004", value)));
}

function textLines(lines: string[]): XmlNode {
	const names = ["D_4440", "D_4440_2", "D_4440_3", "D_4440_4", "D_4440_5"];
	return node("C_C108", ...lines.slice(0, TEXT_LINES).map((line, index) => node(names[index], line)));
}

function freeText(qualifier: string, lines: string[], code?: string | null): XmlNode {
	return node("S_FTX", node("D_4451", qualifier), code ? node("C_C107", node("D_4441", code)) : null, textLines(lines));
}

function noteTexts(notes: string[]): XmlNode[] {
	const pieces = notes.flatMap((note) => chunks(note, TEXT_LIMIT));
	const texts: XmlNode[] = [];
	for (let start = 0; start < pieces.length; start += TEXT_LINES) texts.push(freeText("GEN", pieces.slice(start, start + TEXT_LINES)));
	return texts;
}

function reference(qualifier: string, value: string): XmlNode {
	return node("S_RFF", node("C_C506", node("D_1153", qualifier), node("D_1154", clip(value, 70))));
}

function tax(category: VatCategory, rate: number): XmlNode {
	return node(
		"S_TAX",
		node("D_5283", "7"),
		node("C_C241", node("D_5153", "VAT")),
		category === "O" ? null : node("C_C243", node("D_5278", decimal(rate))),
		node("D_5305", category)
	);
}

function address(party: {
	address_line1: string | null;
	address_line2: string | null;
	city: string | null;
	state: string | null;
	postal_code: string | null;
	country: string | null;
}) {
	const [first, second, third] = wrapped([party.address_line1, party.address_line2], 35, 3);
	return [
		first ? node("C_C059", node("D_3042", first), field("D_3042_2", second), field("D_3042_3", third)) : null,
		present(party.city) ? node("D_3164", clip(party.city, 35)) : null,
		present(party.state) ? node("C_C819", node("D_3228", clip(party.state, 70))) : null,
		present(party.postal_code) ? node("D_3251", clip(party.postal_code, 17)) : null,
		present(party.country) ? node("D_3207", party.country.trim().toUpperCase()) : null,
	];
}

function contact(role: string, channels: { value: string | null | undefined; kind: "EM" | "TE" }[]): XmlNode | null {
	const available = channels.filter((channel) => present(channel.value));
	if (available.length === 0) return null;
	return node(
		"G_SG5",
		node("S_CTA", node("D_3139", role)),
		...available.map((channel) => node("S_COM", node("C_C076", node("D_3148", clip(channel.value!, 512)), node("D_3155", channel.kind))))
	);
}

function sellerParty(source: EslogSource, outsideScope: boolean): XmlNode {
	const seller = source.seller;
	const legalName = present(seller.legal_name) ? seller.legal_name.trim() : seller.name;
	const tradingName = present(seller.name) && seller.name.trim() !== legalName ? seller.name.trim() : null;
	const bank = source.bank;

	return node(
		"G_SG2",
		node(
			"S_NAD",
			node("D_3035", "SE"),
			node("C_C080", node("D_3036", clip(legalName, 70)), tradingName ? node("D_3036_2", clip(tradingName, 70)) : null),
			...address(seller)
		),
		bank
			? node(
					"S_FII",
					node("D_3035", "RB"),
					node("C_C078", node("D_3194", bank.account.iban), node("D_3192", clip(bank.account.holder, 35))),
					bank.account.bic ? node("C_C088", node("D_3433", bank.account.bic)) : null
				)
			: null,
		...sellerReferences(seller, source.vat_status, outsideScope).map((entry) => node("G_SG3", reference(entry.qualifier, entry.value))),
		contact("IC", [{ value: seller.email, kind: "EM" }]),
		contact("SU", [{ value: seller.phone, kind: "TE" }])
	);
}

function buyerParty(buyer: InvoiceRecipient, outsideScope: boolean): XmlNode {
	return node(
		"G_SG2",
		node("S_NAD", node("D_3035", "BY"), node("C_C080", node("D_3036", clip(buyer.name ?? "", 70))), ...address(buyer)),
		present(buyer.iban)
			? node(
					"S_FII",
					node("D_3035", "BB"),
					node("C_C078", node("D_3194", buyer.iban.trim()), present(buyer.name) ? node("D_3192", clip(buyer.name, 35)) : null),
					present(buyer.bic) ? node("C_C088", node("D_3433", buyer.bic.trim())) : null
				)
			: null,
		...buyerReferences(buyer, outsideScope).map((entry) => node("G_SG3", reference(entry.qualifier, entry.value))),
		contact("IC", [{ value: buyer.email, kind: "EM" }])
	);
}

function exemption(source: EslogSource, lines: ReturnType<typeof categorizedLines>): XmlNode | null {
	const exempted = lines.filter((line) => line.category !== "S" && line.category !== "Z");
	if (exempted.length === 0) return null;

	const texts = new Set<string>();
	for (const line of exempted) {
		const noteKey = line.treatment ? EXEMPTION_NOTES[line.treatment] : undefined;
		if (line.category === "O" && present(source.exemption_note) && !noteKey) texts.add(source.exemption_note.trim());
		else if (noteKey) texts.add(t(source.language, noteKey));
	}
	const categories = new Set(exempted.map((line) => line.category));
	const code = categories.size === 1 ? (EXEMPTION_CODES[[...categories][0]] ?? null) : null;
	const reasons = [...texts].flatMap((text) => chunks(text, TEXT_LIMIT));
	if (reasons.length === 0 && !code) return null;

	return node("S_FTX", node("D_4451", "AGM"), code ? node("C_C107", node("D_4441", code)) : null, reasons.length > 0 ? textLines(reasons) : null);
}

function fiscalText(fiscal: FiscalMarks | null): XmlNode | null {
	if (!fiscal) return null;
	return node(
		"S_FTX",
		node("D_4451", "TXD"),
		node(
			"C_C108",
			node("D_4440", fiscal.issued_iso),
			field("D_4440_2", fiscal.operator ? clip(fiscal.operator, TEXT_LIMIT) : null),
			field("D_4440_3", fiscal.eor),
			node("D_4440_4", fiscal.zoi),
			node("D_4440_5", fiscal.code)
		)
	);
}

function paymentMeans(source: EslogSource): string {
	if (source.bank) return "30";
	if (source.card) return "48";
	return "ZZZ";
}

function lineGroup(line: ReturnType<typeof categorizedLines>[number], index: number, currency: string): XmlNode {
	const net = line.amount - line.allowance;
	const [name, ...rest] = chunks(line.description.trim() || "-", 256);

	return node(
		"G_SG26",
		node("S_LIN", node("D_1082", String(index + 1))),
		node("S_IMD", node("D_7077", "F"), node("C_C273", node("D_7008", name))),
		rest.length > 0 ? node("S_IMD", node("D_7077", "A"), node("C_C273", node("D_7008", rest[0]))) : null,
		node("S_QTY", node("C_C186", node("D_6063", "47"), node("D_6060", decimal(line.quantity)), node("D_6411", line.unit ?? DEFAULT_UNIT_CODE))),
		node("G_SG27", moa("203", amount(net, currency))),
		node("G_SG27", moa("38", amount(net + line.tax_amount, currency))),
		node("G_SG29", node("S_PRI", node("C_C509", node("D_5125", "AAA"), node("D_5118", price(line.price, currency))))),
		node("G_SG34", tax(line.category, line.tax_rate), moa("125", amount(net, currency)), moa("124", amount(line.tax_amount, currency))),
		line.allowance > 0
			? node(
					"G_SG39",
					node("S_ALC", node("D_5463", "A"), node("C_C552", node("D_5189", "95"))),
					node("G_SG42", moa("204", amount(line.allowance, currency))),
					node("G_SG42", moa("25", amount(line.amount, currency)))
				)
			: null
	);
}

export function eslogDocument(source: EslogSource): { root: XmlNode; message: XmlNode } {
	const issues = eslogIssues(source);
	if (issues.length > 0) throw new EslogDataIncomplete(issues);

	const currency = source.currency;
	const lines = categorizedLines(source);
	const breakdown = breakdownOf(lines);
	const outsideScope = lines.some((line) => line.category === "O");
	const net = lines.reduce((sum, line) => sum + line.amount - line.allowance, 0);
	const taxTotal = lines.reduce((sum, line) => sum + line.tax_amount, 0);
	const total = net + taxTotal;
	const invoice = source.kind === "invoice";
	const prepaid = invoice ? Math.min(source.prepaid, total) : 0;
	const due = total - prepaid;
	const remittance = source.bank?.reference ?? source.reference;

	const document = node(
		"M_INVOIC",
		node(
			"S_UNH",
			node("D_0062", clip(source.reference, 14)),
			node("C_S009", node("D_0065", "INVOIC"), node("D_0052", "D"), node("D_0054", "01B"), node("D_0051", "UN"))
		),
		node(
			"S_BGM",
			node("C_C002", node("D_1001", invoice ? (source.advance ? "386" : "380") : "381")),
			node("C_C106", node("D_1004", clip(source.reference, 70)))
		),
		dtm("137", date(source.issued, source.timezone)),
		source.supply_date !== null ? dtm("35", date(source.supply_date, source.timezone)) : null,
		...noteTexts(source.notes),
		freeText("DOC", [EN16931_SPECIFICATION]),
		exemption(source, lines),
		invoice ? freeText("PMD", [clip(t(source.language, "bank.purpose", { reference: source.reference }), TEXT_LIMIT)]) : null,
		fiscalText(source.fiscal),
		invoice ? freeText("PAI", [due > 0 ? "0" : "2"]) : null,
		invoice ? freeText("ALQ", ["OTHR"]) : null,
		invoice && due > 0 ? node("G_SG1", reference("PQ", remittance)) : null,
		source.reference_document
			? node(
					"G_SG1",
					reference(REFERENCE_QUALIFIERS[source.reference_document.type], source.reference_document.number),
					source.reference_document.date !== null ? dtm("171", date(source.reference_document.date, source.timezone)) : null
				)
			: null,
		source.corrects ? node("G_SG1", reference("OI", source.corrects.reference), dtm("384", date(source.corrects.issued, source.timezone))) : null,
		sellerParty(source, outsideScope),
		source.buyer ? buyerParty(source.buyer, outsideScope) : null,
		node("G_SG7", node("S_CUX", node("C_C504", node("D_6347", "2"), node("D_6345", currency)))),
		source.reporting ? node("G_SG7", node("S_CUX", node("C_C504", node("D_6347", "6"), node("D_6345", source.reporting.currency)))) : null,
		invoice && due > 0
			? node(
					"G_SG8",
					node("S_PAT", node("D_4279", "1")),
					source.due_date !== null ? dtm("13", date(source.due_date, source.timezone)) : null,
					node("S_PAI", node("C_C534", node("D_4461", paymentMeans(source))))
				)
			: null,
		...lines.map((line, index) => lineGroup(line, index, currency)),
		node("S_UNS", node("D_0081", "D")),
		node("G_SG50", moa("79", amount(net, currency))),
		node("G_SG50", moa("389", amount(net, currency))),
		node("G_SG50", moa("176", amount(taxTotal, currency))),
		node("G_SG50", moa("388", amount(total, currency))),
		prepaid > 0 ? node("G_SG50", moa("113", amount(prepaid, currency))) : null,
		node("G_SG50", moa("9", amount(due, currency))),
		source.reporting ? node("G_SG50", moa("2", amount(source.reporting.tax_amount, source.reporting.currency))) : null,
		...breakdown.map((group) =>
			node("G_SG52", tax(group.category, group.rate), moa("125", amount(group.taxable, currency)), moa("124", amount(group.tax, currency)))
		)
	);

	const message = withAttributes(document, { Id: "data" });
	const root = withNamespaces(node("Invoice", message), { "": ESLOG_NAMESPACE, xsi: XSI_NAMESPACE });
	return { root, message };
}

export interface EslogSigner {
	credentials: FursCredentials;
	signedAt: number;
}

export function eslogXml(source: EslogSource, signer: EslogSigner | null = null): string {
	const { root, message } = eslogDocument(source);
	return serialize(signer ? signedCopy(root, message, signer.credentials, signer.signedAt) : root);
}

const ROUTING_FIELDS = ["registration_number", "iban", "bic"] as const;

async function withRoutingDetails(buyer: InvoiceRecipient | null, projectId: string, customerId: string | null): Promise<InvoiceRecipient | null> {
	if (!buyer || !customerId || ROUTING_FIELDS.every((field) => buyer[field] !== undefined)) return buyer;

	const [customer] = (await Database`SELECT * FROM customers WHERE uuid = ${customerId} AND project = ${projectId}`) as CustomerRow[];
	if (!customer) return buyer;
	return Object.fromEntries(
		Object.entries(buyer).concat(ROUTING_FIELDS.filter((field) => buyer[field] === undefined).map((field) => [field, customer[field] ?? null]))
	) as InvoiceRecipient;
}

export async function invoiceEslog(project: ProjectRow, invoice: InvoiceRow, signer: EslogSigner | null): Promise<{ name: string; data: Uint8Array }> {
	const document = await invoiceDocument(project, invoice, { archival: true });
	const source = invoiceSource(document);
	const xml = eslogXml({ ...source, buyer: await withRoutingDetails(source.buyer, project.uuid, invoice.customer) }, signer);
	return { name: invoiceFilename(invoice.reference, document.language, "xml"), data: new TextEncoder().encode(xml) };
}

export async function creditNoteEslog(
	project: ProjectRow,
	note: CreditNoteRow,
	invoice: InvoiceRow | undefined,
	signer: EslogSigner | null
): Promise<{ name: string; data: Uint8Array }> {
	const document = await creditNoteDocument(project, note);
	const source = creditNoteSource(document, invoice ? referenceDocumentOf(invoice) : null);
	const buyer = await withRoutingDetails(source.buyer, project.uuid, invoice?.customer ?? null);
	const xml = eslogXml({ ...source, buyer }, signer);
	return { name: creditNoteFilename(note.reference, document.language, "xml"), data: new TextEncoder().encode(xml) };
}
