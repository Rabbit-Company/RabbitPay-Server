import type { CustomerRow } from "./database/models";

export function invoiceRecipient(customer: CustomerRow | undefined, vatNumber?: string | null) {
	if (!customer) return null;
	return {
		name: customer.name,
		email: customer.email,
		phone: customer.phone,
		address_line1: customer.address_line1,
		address_line2: customer.address_line2,
		postal_code: customer.postal_code,
		city: customer.city,
		state: customer.state,
		country: customer.country,
		vat_number: vatNumber ?? customer.vat_number,
		tax_number: customer.tax_number,
		registration_number: customer.registration_number ?? null,
		iban: customer.iban ?? null,
		bic: customer.bic ?? null,
		customer_type: customer.customer_type,
	};
}

export type InvoiceRecipient = NonNullable<ReturnType<typeof invoiceRecipient>>;
