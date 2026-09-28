import Database from "./database/database";
import { companyFor, displayNameOf, type CompanyDetails } from "./company";
import { convertMinor } from "./invoicing";
import { defaultExemptionNote, isTaxTreatment, TAX_TREATMENTS } from "./tax";
import { t, type TranslationKey } from "./i18n";
import type { CustomerRow, InvoiceRow, ProjectRow } from "./database/models";
import { invoiceRecipient, type InvoiceRecipient } from "./invoice-recipient";

export async function partiesFor(project: ProjectRow, invoice: InvoiceRow, savedSeller?: CompanyDetails & { name: string }) {
	const company = savedSeller ?? (await companyFor(project.uuid));

	const [customer] =
		invoice.status === "draft" && invoice.customer
			? ((await Database`SELECT * FROM customers WHERE uuid = ${invoice.customer} AND project = ${project.uuid}`) as CustomerRow[])
			: [];

	return {
		company,
		seller: savedSeller ?? { ...company, name: displayNameOf(project) },
		buyer: invoice.buyer_details ? (JSON.parse(invoice.buyer_details) as InvoiceRecipient) : invoiceRecipient(customer, invoice.buyer_vat_number),
	};
}

export function taxDetailsFor(
	project: Pick<ProjectRow, "vat_status" | "tax_country" | "vat_exemption_note" | "language">,
	invoice: InvoiceRow,
	treatments: (string | null)[],
	taxAmount: number
) {
	return {
		vat_status: project.vat_status,
		country: project.tax_country,
		exemption_note:
			project.vat_status === "small_business" ? (project.vat_exemption_note ?? defaultExemptionNote(project.tax_country, project.language)) : null,
		reporting:
			invoice.tax_currency && invoice.tax_currency !== invoice.currency && invoice.tax_exchange_rate !== null && taxAmount > 0
				? {
						currency: invoice.tax_currency,
						rate: invoice.tax_exchange_rate,
						date: invoice.tax_rate_date,
						tax_amount: convertMinor(taxAmount, invoice.currency, invoice.tax_exchange_rate, invoice.tax_currency),
					}
				: null,
		notes: TAX_TREATMENTS.filter(
			(entry) =>
				entry.value !== "domestic" && entry.value !== "small_business" && treatments.some((treatment) => isTaxTreatment(treatment) && treatment === entry.value)
		).map((entry) => t(project.language, `tax.note.${entry.value}` as TranslationKey)),
	};
}
