import Database, { dialect } from "../database/database";
import Validate from "../validate";
import { ErrorCode } from "../errors";
import { calculateTotals, taxIncluded, type InvoiceItemInput } from "../invoicing";
import { convertedPrice, customAmountRate, sellerOf } from "../pos-sale";
import { isCustomerType, suggestTax, type BuyerTax } from "../tax";
import { imagesOf } from "./images";
import { availabilityOf, grossOf, needsShipping, pricingFor, productsByItem, storeNameOf, taxRateFor, type Availability, type ProductRow } from "./catalog";
import { imagePath, type LoadedStore } from "./store";
import { couponIssue, grossDiscountOf, type CouponIssue } from "./coupons";
import type { StoreShippingOption } from "./config";
import { t } from "../i18n";
import { grantOf, licensePrice, parseLicenseProduct, readLicenseChoice, type LicenseChoice, type LicenseProduct } from "../license-pricing";
import { licenseSalesOpen, type OrderedLicense } from "../license-orders";
import type { CustomerProfileRow, CustomerRow, StoreCouponKind, StoreCouponRow } from "../database/models";

export const MAX_CART_LINES = 100;
export const MAX_CART_QUANTITY = 999;

export interface LicenseInput {
	amount: number | null;
	days: number | null;
	server_id: string | null;
}

export interface CartLineInput {
	product: string;
	quantity: number;
	license: LicenseInput | null;
}

export interface BuyerInput {
	country: string | null;
	customer_type: "individual" | "business";
	vat_number: string | null;
}

export interface AddressInput {
	name: string;
	phone: string | null;
	address_line1: string;
	address_line2: string | null;
	postal_code: string;
	city: string;
	state: string | null;
	country: string;
}

export interface CustomerInput extends AddressInput {
	customer_type: "individual" | "business";
	company: string | null;
	vat_number: string | null;
	tax_number: string | null;
}

export interface CheckoutInput {
	lines: CartLineInput[];
	shipping: string | null;
	customer: CustomerInput;
	delivery: AddressInput | null;
	note: string | null;
	accept_terms: boolean;
	waive_withdrawal: boolean;
	accept_license_scope: boolean;
	save_profile: boolean;
	coupon: string | null;
}

export type LineIssue = "unavailable" | "insufficient" | "configuration" | null;

export interface QuotedLine {
	product: string;
	slug: string;
	name: string;
	sku: string | null;
	image: string | null;
	quantity: number;
	unit_price: number;
	total: number;
	tax_rate: number;
	availability: Availability;
	available: number | null;
	restock_at: number | null;
	delivery: { min_days: number; max_days: number };
	digital: boolean;
	license: (LicenseChoice & { type: LicenseProduct["type"] }) | null;
	issue: LineIssue;
}

export interface Quote {
	currency: string;
	lines: QuotedLine[];
	unknown: string[];
	requires_shipping: boolean;
	withdrawal_waiver: boolean;
	license_scope: boolean;
	shipping_options: (StoreShippingOption & { cost: number })[];
	shipping: (StoreShippingOption & { cost: number }) | null;
	items_total: number;
	shipping_amount: number;
	coupon: { code: string; kind: StoreCouponKind; amount: number } | null;
	coupon_issue: CouponIssue | null;
	discount_amount: number;
	tax_amount: number;
	total: number;
	delivery: { min_days: number; max_days: number; backorder: boolean; restock_at: number | null };
	ready: boolean;
	invoice_items: InvoiceItemInput[];
	invoice_discount: number;
	licenses: OrderedLicense[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLicenseInput(value: unknown): LicenseInput | null | undefined {
	if (value === undefined || value === null) return null;
	if (!isObject(value)) return undefined;
	const { amount = null, days = null, server_id = null } = value;
	if (amount !== null && typeof amount !== "number") return undefined;
	if (days !== null && typeof days !== "number") return undefined;
	if (server_id !== null && (typeof server_id !== "string" || server_id.length > 64)) return undefined;
	return { amount, days, server_id };
}

export function readCartLines(value: unknown): CartLineInput[] | null {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CART_LINES) return null;
	const merged = new Map<string, CartLineInput>();
	for (const line of value) {
		if (!isObject(line) || !Validate.uuid(line.product as string)) return null;
		const quantity = line.quantity;
		if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_CART_QUANTITY) return null;
		const license = readLicenseInput(line.license);
		if (license === undefined) return null;
		const key = JSON.stringify([line.product, license?.amount, license?.days, license?.server_id]);
		const existing = merged.get(key);
		if (existing) existing.quantity = Math.min(existing.quantity + quantity, MAX_CART_QUANTITY);
		else merged.set(key, { product: line.product as string, quantity, license });
	}
	return [...merged.values()];
}

function describeLicense(language: string, product: LicenseProduct, choice: LicenseChoice): string {
	const parts = [
		product.type === "transactions" ? t(language, "license.line_payments", { count: choice.amount ?? 0 }) : null,
		product.type === "storage" ? t(language, "license.line_storage", { count: choice.amount ?? 0 }) : null,
		product.type === "employees" ? t(language, "license.line_employees", { count: choice.amount ?? 0 }) : null,
		choice.days !== null ? t(language, "license.line_days", { count: choice.days }) : null,
		choice.server_id ? t(language, "license.line_server", { id: choice.server_id }) : t(language, "license.line_hosted"),
	];
	return parts.filter((part) => part !== null).join(", ");
}

function cleanText(value: unknown, max: number): string | null | undefined {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || value.length > max) return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

export function readAddress(value: unknown): AddressInput | null {
	if (!isObject(value)) return null;
	const name = cleanText(value.name, 150);
	const phone = cleanText(value.phone, 40);
	const line1 = cleanText(value.address_line1, 200);
	const line2 = cleanText(value.address_line2, 200);
	const postal = cleanText(value.postal_code, 20);
	const city = cleanText(value.city, 100);
	const state = cleanText(value.state, 100);
	const country = typeof value.country === "string" ? value.country.toUpperCase() : null;
	if (!name || phone === undefined || !line1 || line2 === undefined || !postal || !city || state === undefined) return null;
	if (!country || !Validate.country(country)) return null;
	return { name, phone, address_line1: line1, address_line2: line2, postal_code: postal, city, state, country };
}

export function readCustomer(value: unknown, allowBusiness: boolean): CustomerInput | null {
	if (!isObject(value)) return null;
	const address = readAddress(value);
	const type = value.customer_type;
	if (!address || typeof type !== "string" || !isCustomerType(type)) return null;
	const company = cleanText(value.company, 200);
	const vat = cleanText(value.vat_number, 40);
	const tax = cleanText(value.tax_number, 40);
	if (company === undefined || vat === undefined || tax === undefined) return null;
	if (type === "business" && (!allowBusiness || !company)) return null;
	return {
		...address,
		customer_type: type as "individual" | "business",
		company: type === "business" ? company : null,
		vat_number: type === "business" ? vat : null,
		tax_number: type === "business" ? tax : null,
	};
}

export function buyerOf(input: BuyerInput | null): BuyerTax | null {
	if (!input) return null;
	return { country: input.country, type: input.customer_type, vatNumber: input.vat_number, vatValid: null };
}

function shippingCost(option: StoreShippingOption, itemsTotal: number): number {
	return option.free_from !== null && itemsTotal >= option.free_from ? 0 : option.price;
}

function netDiscountFor(items: InvoiceItemInput[], grossTarget: number): { net: number; gross: number } {
	const base = calculateTotals(items, 0);
	if (grossTarget <= 0 || base.total_amount <= 0) return { net: 0, gross: 0 };
	const estimate = Math.round((grossTarget * base.subtotal) / base.total_amount);
	const reduction = (net: number) => base.total_amount - calculateTotals(items, net).total_amount;
	const exact = [0, -1, 1, -2, 2].map((offset) => estimate + offset).find((net) => net >= 0 && reduction(net) === grossTarget);
	const net = exact ?? Math.min(estimate, base.subtotal);
	return { net, gross: reduction(net) };
}

export async function quoteCart(
	store: LoadedStore,
	lines: CartLineInput[],
	shippingId: string | null,
	buyer: BuyerInput | null,
	coupon: StoreCouponRow | null = null
): Promise<Quote> {
	const products = await productsByItem(
		store.project.uuid,
		lines.map((line) => line.product)
	);
	const found = lines.filter((line) => products.has(line.product));
	const rows = found.map((line) => products.get(line.product)!);
	const [pricing, images] = await Promise.all([pricingFor(store.project.currency, rows), imagesOf(rows.map((row) => row.uuid))]);
	const tax = buyerOf(buyer);

	const quoted: QuotedLine[] = [];
	const invoiceItems: InvoiceItemInput[] = [];
	const licenses: OrderedLicense[] = [];
	const licenseOpen = rows.some((row) => row.license !== null) ? await licenseSalesOpen(store.project.uuid) : false;
	let rateMissing = false;

	for (const line of found) {
		const row = products.get(line.product)!;
		const license = parseLicenseProduct(row.license);
		const choice = license ? readLicenseChoice(license, line.license) : null;
		const basePrice = license && choice ? licensePrice(license, choice) : row.unit_price;
		const net = convertedPrice({ ...row, unit_price: basePrice }, pricing.currency, pricing.rates);
		if (net === null) rateMissing = true;
		const suggestion = taxRateFor(store, row, tax);
		const unitGross = grossOf(net ?? basePrice, suggestion.rate);
		const availability = availabilityOf(row, line.quantity);
		const issue: LineIssue =
			license && !licenseOpen
				? "unavailable"
				: license && !choice
					? "configuration"
					: availability === "out_of_stock"
						? row.available === 0
							? "unavailable"
							: "insufficient"
						: null;
		const firstImage = images.get(row.uuid)?.[0];
		const gross = unitGross * line.quantity;

		quoted.push({
			product: row.uuid,
			slug: row.slug,
			name: storeNameOf(row),
			sku: row.sku,
			image: firstImage ? imagePath(firstImage) : null,
			quantity: line.quantity,
			unit_price: unitGross,
			total: gross,
			tax_rate: suggestion.rate,
			availability,
			available: row.available,
			restock_at: row.restock_at,
			delivery: {
				min_days: row.delivery_min_days ?? store.config.delivery.min_days,
				max_days: row.delivery_max_days ?? store.config.delivery.max_days,
			},
			digital: !needsShipping(row),
			license: license && choice ? { ...choice, type: license.type } : null,
			issue,
		});

		if (license && choice) {
			licenses.push({
				...grantOf(license, choice),
				position: invoiceItems.length,
				quantity: line.quantity,
				unit_price: net ?? basePrice,
				server_id: choice.server_id,
			});
		}

		invoiceItems.push({
			description: license && choice ? `${row.name} (${describeLicense(store.project.language, license, choice)})` : row.name,
			quantity: line.quantity,
			unit_price: Math.round((gross - taxIncluded(gross, suggestion.rate)) / line.quantity),
			tax_rate: suggestion.rate,
			item: row.uuid,
			tax_treatment: suggestion.treatment,
			gross_amount: gross,
			unit: row.unit,
		});
	}

	const itemsTotal = quoted.reduce((sum, line) => sum + line.total, 0);
	const requiresShipping = rows.some(needsShipping);
	const issue = coupon
		? (couponIssue(coupon, itemsTotal, Date.now()) ?? (coupon.kind === "free_shipping" && !requiresShipping ? "not_applicable" : null))
		: null;
	const applied = coupon && issue === null ? coupon : null;
	const options = requiresShipping
		? store.config.shipping
				.filter((option) => !option.pickup || store.config.location.enabled)
				.map((option) => ({ ...option, cost: applied?.kind === "free_shipping" ? 0 : shippingCost(option, itemsTotal) }))
		: [];
	const selected = requiresShipping ? (options.find((option) => option.id === shippingId) ?? options[0] ?? null) : null;

	if (selected && selected.cost > 0) {
		const suggestion = suggestTax(sellerOf(store.project), tax, { supplyType: "goods", category: "standard", rate: customAmountRate(store.project) });
		invoiceItems.push({
			description: selected.name,
			quantity: 1,
			unit_price: selected.cost - taxIncluded(selected.cost, suggestion.rate),
			tax_rate: suggestion.rate,
			item: null,
			tax_treatment: suggestion.treatment,
			gross_amount: selected.cost,
		});
	}

	const discount = applied ? netDiscountFor(invoiceItems, grossDiscountOf(applied, itemsTotal)) : { net: 0, gross: 0 };
	const totals = invoiceItems.length ? calculateTotals(invoiceItems, discount.net) : { tax_amount: 0, total_amount: 0 };
	const physical = quoted.filter((line) => !line.digital);
	const backorder = quoted.some((line) => line.availability === "backorder");
	const restock = quoted.map((line) => (line.availability === "backorder" ? line.restock_at : null)).filter((value): value is number => value !== null);
	const minDays = Math.max(0, ...physical.map((line) => line.delivery.min_days)) + (selected?.min_days ?? 0);
	const maxDays = Math.max(0, ...physical.map((line) => line.delivery.max_days)) + (selected?.max_days ?? 0);

	return {
		currency: pricing.currency,
		lines: quoted,
		unknown: lines.filter((line) => !products.has(line.product)).map((line) => line.product),
		requires_shipping: requiresShipping,
		withdrawal_waiver: rows.some((row) => Boolean(row.delivers_keys)),
		license_scope: rows.some((row) => row.license !== null),
		shipping_options: options,
		shipping: selected,
		items_total: itemsTotal,
		shipping_amount: selected?.cost ?? 0,
		coupon: applied ? { code: applied.code, kind: applied.kind, amount: applied.amount } : null,
		coupon_issue: issue,
		discount_amount: discount.gross,
		tax_amount: totals.tax_amount,
		total: totals.total_amount,
		delivery: {
			min_days: minDays,
			max_days: maxDays,
			backorder,
			restock_at: restock.length ? Math.max(...restock) : null,
		},
		ready:
			quoted.length > 0 && !rateMissing && quoted.every((line) => line.issue === null) && (!requiresShipping || selected !== null) && totals.total_amount > 0,
		invoice_items: invoiceItems,
		invoice_discount: discount.net,
		licenses,
	};
}

export async function takeStock(projectId: string, rows: Map<string, ProductRow>, lines: CartLineInput[]): Promise<boolean> {
	const taken: CartLineInput[] = [];
	for (const line of lines) {
		const row = rows.get(line.product);
		if (!row || row.delivers_keys || row.stock === null) continue;
		const updated = row.allow_backorder
			? await Database`UPDATE store_products SET stock = CASE WHEN stock > ${line.quantity} THEN stock - ${line.quantity} ELSE 0 END WHERE item = ${line.product} AND project = ${projectId}`
			: await Database`UPDATE store_products SET stock = stock - ${line.quantity} WHERE item = ${line.product} AND project = ${projectId} AND stock >= ${line.quantity}`;
		if (updated.count === 0) {
			await returnStock(projectId, taken);
			return false;
		}
		taken.push(line);
	}
	return true;
}

export async function returnStock(projectId: string, lines: Pick<CartLineInput, "product" | "quantity">[]) {
	for (const line of lines) {
		await Database`UPDATE store_products SET stock = stock + ${line.quantity} WHERE item = ${line.product} AND project = ${projectId} AND stock IS NOT NULL`;
	}
}

export async function upsertCustomer(projectId: string, email: string, customer: CustomerInput): Promise<string> {
	const now = Date.now();
	const name = customer.customer_type === "business" ? customer.company! : customer.name;
	const [existing] = (await Database`SELECT uuid FROM customers WHERE project = ${projectId} AND email = ${email}`) as Pick<CustomerRow, "uuid">[];
	if (existing) {
		await Database`
			UPDATE customers SET name = ${name}, phone = ${customer.phone}, address_line1 = ${customer.address_line1}, address_line2 = ${customer.address_line2},
				city = ${customer.city}, state = ${customer.state}, postal_code = ${customer.postal_code}, country = ${customer.country},
				vat_number = ${customer.vat_number}, tax_number = ${customer.tax_number}, customer_type = ${customer.customer_type}, updated = ${now}
			WHERE uuid = ${existing.uuid}
		`;
		return existing.uuid;
	}

	const uuid = crypto.randomUUID();
	const insert = Database`
		INSERT INTO customers(uuid, project, name, email, phone, address_line1, address_line2, city, state, postal_code, country, vat_number, tax_number,
			customer_type, created, updated)
		VALUES(${uuid}, ${projectId}, ${name}, ${email}, ${customer.phone}, ${customer.address_line1}, ${customer.address_line2}, ${customer.city},
			${customer.state}, ${customer.postal_code}, ${customer.country}, ${customer.vat_number}, ${customer.tax_number}, ${customer.customer_type}, ${now}, ${now})
	`;
	try {
		await insert;
	} catch (err) {
		const [raced] = (await Database`SELECT uuid FROM customers WHERE project = ${projectId} AND email = ${email}`) as Pick<CustomerRow, "uuid">[];
		if (!raced) throw err;
		return raced.uuid;
	}
	return uuid;
}

export function checkoutProblem(input: CheckoutInput, quote: Quote): ErrorCode | null {
	if (!input.accept_terms) return ErrorCode.CHECKOUT_TERMS_REQUIRED;
	if (quote.withdrawal_waiver && !input.waive_withdrawal) return ErrorCode.CHECKOUT_WAIVER_REQUIRED;
	if (quote.license_scope && !input.accept_license_scope) return ErrorCode.CHECKOUT_LICENSE_SCOPE_REQUIRED;
	if (quote.unknown.length > 0 || quote.lines.length === 0) return ErrorCode.INVALID_CART;
	if (quote.lines.some((line) => line.issue === "configuration")) return ErrorCode.INVALID_CART;
	if (quote.lines.some((line) => line.issue !== null)) return ErrorCode.STORE_OUT_OF_STOCK;
	if (quote.requires_shipping && quote.shipping === null) return ErrorCode.INVALID_CART;
	if (input.coupon !== null && quote.coupon_issue !== null) return quote.coupon_issue === "used_up" ? ErrorCode.COUPON_USED_UP : ErrorCode.INVALID_COUPON;
	if (!quote.ready) return ErrorCode.STORE_CHECKOUT_UNAVAILABLE;
	return null;
}

export function shippingAddressOf(input: CheckoutInput, quote: Quote): AddressInput | null {
	if (!quote.requires_shipping || quote.shipping?.pickup) return null;
	if (input.delivery) return input.delivery;
	const customer = input.customer;
	return {
		name: customer.customer_type === "business" && customer.company ? `${customer.name}, ${customer.company}` : customer.name,
		phone: customer.phone,
		address_line1: customer.address_line1,
		address_line2: customer.address_line2,
		postal_code: customer.postal_code,
		city: customer.city,
		state: customer.state,
		country: customer.country,
	};
}

export type ProfileFields = Omit<CustomerProfileRow, "email" | "updated">;

export function profileFromCheckout(input: CheckoutInput): ProfileFields {
	const customer = input.customer;
	const delivery = input.delivery;
	return {
		customer_type: customer.customer_type,
		name: customer.name,
		phone: customer.phone,
		company: customer.company,
		vat_number: customer.vat_number,
		tax_number: customer.tax_number,
		address_line1: customer.address_line1,
		address_line2: customer.address_line2,
		postal_code: customer.postal_code,
		city: customer.city,
		state: customer.state,
		country: customer.country,
		shipping_same: delivery ? 0 : 1,
		shipping_name: delivery?.name ?? null,
		shipping_phone: delivery?.phone ?? null,
		shipping_address_line1: delivery?.address_line1 ?? null,
		shipping_address_line2: delivery?.address_line2 ?? null,
		shipping_postal_code: delivery?.postal_code ?? null,
		shipping_city: delivery?.city ?? null,
		shipping_state: delivery?.state ?? null,
		shipping_country: delivery?.country ?? null,
	};
}

export async function writeProfile(email: string, profile: ProfileFields) {
	const now = Date.now();
	const p = profile;
	const insert = Database`
		INSERT INTO customer_profiles(email, customer_type, name, company, phone, vat_number, tax_number, address_line1, address_line2, postal_code, city,
			state, country, shipping_same, shipping_name, shipping_phone, shipping_address_line1, shipping_address_line2, shipping_postal_code, shipping_city,
			shipping_state, shipping_country, updated)
		VALUES(${email}, ${p.customer_type}, ${p.name}, ${p.company}, ${p.phone}, ${p.vat_number}, ${p.tax_number}, ${p.address_line1}, ${p.address_line2},
			${p.postal_code}, ${p.city}, ${p.state}, ${p.country}, ${p.shipping_same}, ${p.shipping_name}, ${p.shipping_phone}, ${p.shipping_address_line1},
			${p.shipping_address_line2}, ${p.shipping_postal_code}, ${p.shipping_city}, ${p.shipping_state}, ${p.shipping_country}, ${now})
	`;
	const update = Database`
		customer_type = ${p.customer_type}, name = ${p.name}, company = ${p.company}, phone = ${p.phone}, vat_number = ${p.vat_number},
		tax_number = ${p.tax_number}, address_line1 = ${p.address_line1}, address_line2 = ${p.address_line2}, postal_code = ${p.postal_code},
		city = ${p.city}, state = ${p.state}, country = ${p.country}, shipping_same = ${p.shipping_same}, shipping_name = ${p.shipping_name},
		shipping_phone = ${p.shipping_phone}, shipping_address_line1 = ${p.shipping_address_line1}, shipping_address_line2 = ${p.shipping_address_line2},
		shipping_postal_code = ${p.shipping_postal_code}, shipping_city = ${p.shipping_city}, shipping_state = ${p.shipping_state},
		shipping_country = ${p.shipping_country}, updated = ${now}
	`;
	if (dialect === "mysql") await Database`${insert} ON DUPLICATE KEY UPDATE ${update}`;
	else await Database`${insert} ON CONFLICT(email) DO UPDATE SET ${update}`;
}
