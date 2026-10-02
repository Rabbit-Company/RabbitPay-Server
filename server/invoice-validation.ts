import type { Context } from "@rabbit-company/web";
import Database from "./database/database";
import { ErrorCode } from "./errors";
import { prepareIssuePresentation, type PreparedIssuePresentation } from "./invoice-snapshot";
import { issueSnapshot, taxPointDate, vatPeriodCode, type IssueSnapshot, type LateVatReport } from "./tax-reporting";
import { DOMESTIC_VAT_RATES, isTaxTreatment, isZeroRated, splitVatNumber } from "./tax";
import Utils from "./utils";
import { accountingPeriodLock, accountingPeriodLocked } from "./accounting-periods";
import { localDate, shiftLocalDate, startOfLocalDate } from "./timezone";
import type { CustomerRow, InvoiceItemRow, InvoiceRow, ProjectRow } from "./database/models";

export interface InvoiceDataIssue {
	code: string;
	field: string;
	message: string;
}

export class InvoiceDataIncomplete extends Error {
	readonly issues: InvoiceDataIssue[];

	constructor(issues: InvoiceDataIssue[]) {
		super(`The invoice cannot be issued. ${issues.map((issue) => issue.message).join(" ")}`);
		this.issues = issues;
	}
}

type InvoiceSubject = Pick<InvoiceRow, "currency" | "customer" | "due_date" | "supply_date" | "tax_amount"> &
	Partial<Pick<InvoiceRow, "tax_exchange_rate" | "tax_rate_source">> & { late_vat_report?: boolean };
type InvoiceLine = Pick<InvoiceItemRow, "description" | "quantity" | "tax_rate" | "tax_treatment">;

function present(value: string | null | undefined): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function compactTaxNumber(value: string | null | undefined): string {
	return typeof value === "string" ? value.toUpperCase().replace(/[\s.\-/]/g, "") : "";
}

function validateSlovenianInvoice(
	project: ProjectRow,
	invoice: InvoiceSubject,
	items: InvoiceLine[],
	customer: CustomerRow | undefined,
	presentation: PreparedIssuePresentation
): InvoiceDataIssue[] {
	const issues: InvoiceDataIssue[] = [];
	const used = new Set<string>();
	const add = (code: string, field: string, message: string) => {
		if (used.has(code)) return;
		used.add(code);
		issues.push({ code, field, message });
	};
	const seller = presentation.seller;

	if (!present(seller.legal_name)) add("seller_legal_name", "company.legal_name", "Add the seller's legal name under Company details.");
	if (!present(seller.address_line1)) add("seller_address", "company.address_line1", "Add the seller's street address under Company details.");
	if (!present(seller.postal_code)) add("seller_postal_code", "company.postal_code", "Add the seller's postal code under Company details.");
	if (!present(seller.city)) add("seller_city", "company.city", "Add the seller's city under Company details.");
	if (seller.country !== "SI") add("seller_country", "company.country", "Set the seller's country to Slovenia under Company details.");

	if (project.vat_status !== "registered" && project.vat_status !== "small_business" && project.vat_status !== "not_registered") {
		add("vat_status", "project.vat_status", "Select the seller's VAT status under Tax settings.");
	}
	if (project.vat_status === "registered") {
		const vat = compactTaxNumber(seller.vat_number);
		if (!/^SI\d{8}$/.test(vat)) add("seller_vat_number", "company.vat_number", "Add the seller's Slovenian VAT ID under Company details.");
	}
	if (invoice.supply_date === null) add("supply_date", "invoice.supply_date", "Enter the supply date before issuing the invoice.");

	if (customer && customer.customer_type !== "business" && customer.customer_type !== "individual") {
		add("buyer_type", "customer.customer_type", "Select whether the customer is a business or an individual.");
	}
	const businessBuyer = customer?.customer_type === "business" || present(customer?.vat_number);
	if (businessBuyer) {
		if (!present(customer?.name)) add("buyer_name", "customer.name", "Add the business customer's legal name.");
		if (!present(customer?.address_line1)) add("buyer_address", "customer.address_line1", "Add the business customer's street address.");
		if (!present(customer?.postal_code)) add("buyer_postal_code", "customer.postal_code", "Add the business customer's postal code.");
		if (!present(customer?.city)) add("buyer_city", "customer.city", "Add the business customer's city.");
		if (!present(customer?.country)) add("buyer_country", "customer.country", "Add the business customer's country.");
	}

	const requiresBuyerVat = items.some((item) => item.tax_treatment === "reverse_charge" || item.tax_treatment === "intra_eu_goods");
	if (requiresBuyerVat) {
		const vat = splitVatNumber(customer?.vat_number, customer?.country);
		if (!customer || !vat) add("buyer_vat_number", "customer.vat_number", "Add a valid customer VAT ID for reverse-charge or intra-EU supplies.");
	}
	if (requiresBuyerVat && customer?.country === "SI") {
		add(
			"reverse_charge_domestic_buyer",
			"invoice.items.tax_treatment",
			"A Slovenian customer cannot be invoiced as an EU sale. Use the domestic reverse charge instead."
		);
	}
	if (items.some((item) => item.tax_treatment === "domestic_reverse_charge")) {
		const vat = splitVatNumber(customer?.vat_number, customer?.country);
		if (project.vat_status !== "registered") {
			add("domestic_reverse_seller", "project.vat_status", "Only a VAT registered seller can invoice with the domestic reverse charge.");
		}
		if (!customer || customer.country !== "SI" || vat?.prefix !== "SI") {
			add("domestic_reverse_buyer", "customer.vat_number", "The domestic reverse charge needs a Slovenian customer with a Slovenian VAT ID.");
		}
	}
	if (items.some((item) => item.tax_treatment === "oss") && !present(customer?.country)) {
		add("oss_buyer_country", "customer.country", "Add the customer's country for an OSS supply.");
	}

	if (items.some((item) => item.tax_treatment === "domestic_reverse_charge") && items.some((item) => item.tax_rate !== 0)) {
		add(
			"domestic_reverse_mixed",
			"invoice.items.tax_treatment",
			"Supplies under the domestic reverse charge cannot share an invoice with supplies that carry VAT. Issue them on separate invoices."
		);
	}

	if (project.vat_status === "registered") {
		if (items.some((item) => item.tax_rate === 0 && (!isTaxTreatment(item.tax_treatment) || !isZeroRated(item.tax_treatment)))) {
			add("zero_vat_basis", "invoice.items.tax_treatment", "Choose the legal tax treatment for every line with a zero VAT rate.");
		}
		const allowed = DOMESTIC_VAT_RATES.SI;
		const unknown = items.find(
			(item) => item.tax_rate !== 0 && (item.tax_treatment === null || item.tax_treatment === "domestic") && !allowed.includes(item.tax_rate)
		);
		if (unknown) {
			add(
				"domestic_vat_rate",
				"invoice.items.tax_rate",
				`${unknown.tax_rate}% is not a Slovenian VAT rate. Domestic supplies are taxed at ${allowed.join("%, ")}%.`
			);
		}
	} else if (project.vat_status === "small_business" || project.vat_status === "not_registered") {
		if (invoice.tax_amount !== 0 || items.some((item) => item.tax_rate !== 0)) {
			add("vat_not_allowed", "invoice.items.tax_rate", "A seller that is not VAT registered cannot charge VAT on the invoice.");
		}
	}

	return issues;
}

async function lateVatReport(project: ProjectRow, taxPoint: number): Promise<LateVatReport> {
	const lock = await accountingPeriodLock(project.uuid, taxPoint);
	if (lock) return { period: vatPeriodCode(Number(lock.period_from), Number(lock.period_to), project.timezone) };

	const month = localDate(taxPoint, project.timezone).slice(0, 7);
	const from = startOfLocalDate(`${month}-01`, project.timezone);
	const following = startOfLocalDate(shiftLocalDate(`${month}-28`, 4).slice(0, 7) + "-01", project.timezone);
	return { period: vatPeriodCode(from, following - 1, project.timezone) };
}

export async function prepareInvoiceIssue(
	project: ProjectRow,
	invoice: InvoiceSubject,
	items: InvoiceLine[],
	issuedAt: number
): Promise<{ snapshot: IssueSnapshot; presentation: PreparedIssuePresentation }> {
	const taxPoint = taxPointDate(project.timezone, invoice.supply_date, issuedAt, items);
	const late = (await accountingPeriodLocked(project.uuid, taxPoint)) ? await lateVatReport(project, taxPoint) : null;
	if (late && invoice.late_vat_report !== true) {
		throw new InvoiceDataIncomplete([
			{
				code: "tax_period_locked",
				field: "invoice.supply_date",
				message: `The supply date ${localDate(taxPoint, project.timezone)} falls in a VAT period that was already submitted. The invoice can be issued as a late report, which puts it in the current VAT period as a correction of the earlier one under Article 88.b of ZDDV-1, with interest on its VAT.`,
			},
		]);
	}
	const snapshot = await issueSnapshot(project, invoice, issuedAt, items, late ? { ...late, taxed: invoice.tax_amount !== 0 } : null);
	const presentation = await prepareIssuePresentation(project);
	const unrated: InvoiceDataIssue[] =
		snapshot.tax_exchange_rate === null && invoice.tax_amount !== 0
			? [
					{
						code: "tax_exchange_rate",
						field: "invoice.tax_exchange_rate",
						message: `No exchange rate from ${invoice.currency} to ${snapshot.tax_currency} is available for the supply date. Enter the VAT exchange rate on the invoice.`,
					},
				]
			: [];
	if (project.tax_country !== "SI") {
		if (unrated.length > 0) throw new InvoiceDataIncomplete(unrated);
		return { snapshot, presentation };
	}

	const [customer] = invoice.customer
		? ((await Database`SELECT * FROM customers WHERE uuid = ${invoice.customer} AND project = ${project.uuid}`) as CustomerRow[])
		: [];
	const issues = [...validateSlovenianInvoice(project, invoice, items, customer, presentation), ...unrated];
	if (issues.length > 0) throw new InvoiceDataIncomplete(issues);
	return { snapshot, presentation };
}

export function invoiceDataErrorResponse(ctx: Context<any, any>, error: InvoiceDataIncomplete) {
	return Utils.failWithReason(ctx, ErrorCode.INVOICE_DATA_INCOMPLETE, error.message, { issues: error.issues });
}
