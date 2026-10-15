import { join } from "node:path";
import type { Company } from "./demo";

export interface SupplierInvoice {
	reference: string;
	supplier: { name: string; address: string; postalCode: string; city: string; country: string; vatNumber: string; email: string };
	buyer: Company;
	language: string;
	lines: { description: string; quantity: number; unit: string; price: number; rate: number }[];
	dueInDays: number;
	iban: string;
}

export function iban(country: string, bban: string): string {
	const digits = `${bban}${country}00`.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
	const remainder = [...digits].reduce((total, digit) => (total * 10 + Number(digit)) % 97, 0);
	return `${country}${String(98 - remainder).padStart(2, "0")}${bban}`;
}

export async function writeSupplierInvoice(folder: string, invoice: SupplierInvoice): Promise<string> {
	Bun.env.RABBITPAY_DB = "sqlite://:memory:";
	const { eslogXml } = await import("../../server/eslog");
	const now = Date.now();
	const lines = invoice.lines.map((line) => {
		const amount = line.price * line.quantity;
		return {
			description: line.description,
			quantity: line.quantity,
			unit: line.unit,
			price: line.price,
			amount,
			allowance: 0,
			tax_rate: line.rate,
			tax_amount: Math.round((amount * line.rate) / 100),
			treatment: "domestic",
		};
	});
	const total = lines.reduce((sum, line) => sum + line.amount + line.tax_amount, 0);
	const { supplier, buyer } = invoice;
	const xml = eslogXml({
		kind: "invoice",
		reference: invoice.reference,
		issued: now - 2 * 86400000,
		supply_date: now - 3 * 86400000,
		due_date: now + invoice.dueInDays * 86400000,
		timezone: "Europe/Ljubljana",
		language: invoice.language,
		currency: "EUR",
		notes: [],
		seller: {
			name: supplier.name,
			legal_name: supplier.name,
			address_line1: supplier.address,
			address_line2: null,
			postal_code: supplier.postalCode,
			city: supplier.city,
			state: null,
			country: supplier.country,
			vat_number: supplier.vatNumber,
			tax_number: null,
			registration_number: null,
			email: supplier.email,
			phone: null,
			website: null,
			footer_note: null,
		},
		buyer: {
			name: buyer.legalName,
			email: buyer.email,
			phone: null,
			address_line1: buyer.address,
			address_line2: null,
			postal_code: buyer.postalCode,
			city: buyer.city,
			state: null,
			country: buyer.country,
			vat_number: buyer.vatNumber,
			tax_number: null,
			registration_number: null,
			iban: null,
			bic: null,
			customer_type: "business",
		},
		vat_status: "registered",
		exemption_note: null,
		reporting: null,
		lines,
		prepaid: 0,
		bank: {
			account: { iban: invoice.iban, bic: null, holder: supplier.name, bank_name: null },
			reference: `SI00 ${invoice.reference.replace(/\D/g, "")}`,
			amount: total,
			currency: "EUR",
			qr: null,
			qr_unavailable: null,
		},
		card: false,
		fiscal: null,
		corrects: null,
		reference_document: null,
	} as never);
	const path = join(folder, `${invoice.reference}.xml`);
	await Bun.write(path, xml);
	return path;
}
