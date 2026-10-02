import { ApiError, type StoreConfig, type StoreOrder } from "../api";
import { clearCustomerSession, customerFetch, customerToken, type CustomerProfile } from "../customer-api";
import type { Availability, StoreShippingOption } from "../../../server/store/config";
import type { LicenseChoice, LicenseProduct } from "../../../server/license-pricing";

export type { Availability, LicenseChoice, LicenseProduct };

export interface CartLine {
	product: string;
	quantity: number;
	license: LicenseChoice | null;
}

export interface StoreCategoryNode {
	uuid: string;
	slug: string;
	name: string;
	description: string | null;
	parent: string | null;
	count: number;
}

export interface Storefront {
	slug: string;
	domain: string | null;
	currency: string;
	timezone: string;
	config: StoreConfig;
	languages: { code: string; name: string }[];
	language: { code: string; strings: Record<string, string> };
	logo: string | null;
	hero: string | null;
	branding: { white_label: boolean; logo: string | null };
	seller: {
		name: string;
		legal_name: string | null;
		address: string[];
		email: string | null;
		phone: string | null;
		vat_number: string | null;
		registration_number: string | null;
	};
	payment_methods: { processor: string; label: string; kind: string }[];
	categories: StoreCategoryNode[];
	product_count: number;
}

export interface ProductImage {
	url: string;
	alt: string | null;
}

export interface ProductCard {
	uuid: string;
	slug: string;
	name: string;
	summary: string | null;
	sku: string | null;
	currency: string;
	price: number;
	compare_price: number | null;
	tax_rate: number;
	featured: boolean;
	digital: boolean;
	license: LicenseProduct | null;
	category: { uuid: string; slug: string; name: string } | null;
	image: ProductImage | null;
	hover_image: ProductImage | null;
	availability: Availability;
	stock: number | null;
	restock_at: number | null;
	delivery: { min_days: number; max_days: number };
	created: number;
}

export interface ProductDetails extends ProductCard {
	description: string | null;
	images: (ProductImage & { uuid: string })[];
	attributes: { name: string; value: string }[];
	trail: { slug: string; name: string }[];
	related: ProductCard[];
}

export interface Facet {
	name: string;
	values: { value: string; count: number }[];
}

export interface ProductPage {
	products: ProductCard[];
	total: number;
	limit: number;
	offset: number;
	facets: Facet[] | null;
	category: {
		uuid: string;
		slug: string;
		name: string;
		description: string | null;
		trail: { slug: string; name: string }[];
		children: { slug: string; name: string }[];
	} | null;
}

export interface ProductQuery {
	category?: string;
	q?: string;
	sort?: string;
	stock?: boolean;
	featured?: boolean;
	facets?: boolean;
	filters?: [string, string][];
	limit?: number;
	offset?: number;
}

export interface QuoteLine {
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
	requested: LicenseChoice | null;
	issue: "unavailable" | "insufficient" | "configuration" | null;
}

export type CouponIssue = "unknown" | "disabled" | "not_started" | "expired" | "used_up" | "minimum" | "not_applicable";

export type ShippingChoice = StoreShippingOption & { cost: number };

export interface Quote {
	currency: string;
	lines: QuoteLine[];
	unknown: string[];
	requires_shipping: boolean;
	withdrawal_waiver: boolean;
	license_scope: boolean;
	shipping_options: ShippingChoice[];
	shipping: ShippingChoice | null;
	items_total: number;
	shipping_amount: number;
	coupon: { code: string; kind: "percent" | "amount" | "free_shipping"; amount: number } | null;
	coupon_issue: CouponIssue | null;
	discount_amount: number;
	tax_amount: number;
	total: number;
	delivery: { min_days: number; max_days: number; backorder: boolean; restock_at: number | null };
	ready: boolean;
}

export interface CheckoutAddress {
	name: string;
	phone: string | null;
	address_line1: string;
	address_line2: string | null;
	postal_code: string;
	city: string;
	state: string | null;
	country: string;
}

export interface CheckoutRequest {
	lines: CartLine[];
	shipping: string | null;
	customer: CheckoutAddress & { customer_type: "individual" | "business"; company: string | null; vat_number: string | null; tax_number: string | null };
	delivery: CheckoutAddress | null;
	note: string | null;
	accept_terms: boolean;
	waive_withdrawal: boolean;
	accept_license_scope: boolean;
	save_profile: boolean;
	coupon: string | null;
}

const CUSTOMER_SESSION_ERRORS = new Set([1000, 1016, 1017]);

async function read<T>(response: Response): Promise<T> {
	let result: { error: number; info: string; data: T };
	try {
		result = await response.json();
	} catch {
		throw new ApiError(-1, response.status, "The server returned an unreadable response.");
	}
	if (result.error !== 0) {
		if (CUSTOMER_SESSION_ERRORS.has(result.error)) clearCustomerSession();
		throw new ApiError(result.error, response.status, result.info, result.data);
	}
	return result.data;
}

let shopperLanguage: string | null = null;

export function useShopperLanguage(code: string | null) {
	shopperLanguage = code;
}

function path(slug: string, rest = ""): string {
	return `/store/${encodeURIComponent(slug)}${rest}`;
}

function translated(slug: string, rest: string): string {
	if (shopperLanguage === null) return path(slug, rest);
	return path(slug, `${rest}${rest.includes("?") ? "&" : "?"}lang=${encodeURIComponent(shopperLanguage)}`);
}

function productQuery(query: ProductQuery): string {
	const params = new URLSearchParams();
	if (query.category) params.set("category", query.category);
	if (query.q) params.set("q", query.q);
	if (query.sort) params.set("sort", query.sort);
	if (query.stock) params.set("stock", "1");
	if (query.featured) params.set("featured", "1");
	if (query.facets) params.set("facets", "1");
	if (query.limit) params.set("limit", String(query.limit));
	if (query.offset) params.set("offset", String(query.offset));
	for (const [name, value] of query.filters ?? []) params.append("f", `${name}=${value}`);
	const text = params.toString();
	return text ? `?${text}` : "";
}

export const StoreApi = {
	async store(slug: string, language: string | null = null) {
		return await read<Storefront>(await customerFetch(path(slug, language ? `?lang=${encodeURIComponent(language)}` : "")));
	},
	async products(slug: string, query: ProductQuery) {
		return await read<ProductPage>(await customerFetch(translated(slug, `/products${productQuery(query)}`)));
	},
	async product(slug: string, product: string) {
		return await read<ProductDetails>(await customerFetch(translated(slug, `/products/${encodeURIComponent(product)}`)));
	},
	async quote(
		slug: string,
		body: {
			lines: CartLine[];
			shipping?: string | null;
			buyer?: { country: string | null; customer_type: string; vat_number: string | null } | null;
			coupon?: string | null;
		}
	) {
		return await read<Quote>(await customerFetch(translated(slug, "/quote"), body));
	},
	async checkout(slug: string, body: CheckoutRequest) {
		return await read<{ invoice: string; reference: string; total_amount: number; currency: string }>(await customerFetch(path(slug, "/checkout"), body));
	},
	async order(slug: string, invoice: string) {
		return await read<StoreOrder>(await customerFetch(path(slug, `/orders/${encodeURIComponent(invoice)}`)));
	},
	async profile() {
		return await read<CustomerProfile>(await customerFetch("/customer/profile"));
	},
	signedIn(): boolean {
		return customerToken() !== null;
	},
};
