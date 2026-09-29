import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { prepareTest } from "./environment";

await prepareTest();

const FIXTURE = `${import.meta.dir}/.store-coupon-fixture`;
mkdirSync(FIXTURE, { recursive: true });
writeFileSync(
	`${FIXTURE}/index.html`,
	'<!doctype html><html lang="en"><head><meta name="robots" content="noindex, nofollow" /><title>RabbitPay</title></head><body></body></html>'
);

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { Settings } = await import("../server/settings");
const { setTransport } = await import("../server/email/mailer");
const { default: Auth } = await import("../server/auth");
const { generateLicenseCode } = await import("../server/licensing");

Settings.web = { enabled: true, path: FIXTURE, landing_page: true, license_store_url: "" };

interface Result {
	status: number;
	error: number;
	info: string;
	data: any;
}

async function call(method: string, path: string, token?: string, body?: unknown): Promise<Result> {
	const headers: Record<string, string> = {};
	if (token) headers.Authorization = `Bearer ${token}`;
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const response = await Server.app.handle(
		new Request(`http://127.0.0.1/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
	);
	return { status: response.status, ...((await response.json()) as Omit<Result, "status">) };
}

const messages: { to: string; text: string; subject: string; from?: unknown }[] = [];
let ownerToken = "";
let project = "";
let gpu = "";
let giftCard = "";
let customerToken = "";
const slug = "pixel-parts";

const base = () => `/projects/${project}`;

async function redeemStore(projectId: string, days = 30) {
	const code = generateLicenseCode();
	const now = Date.now();
	await Database`
		INSERT INTO license_keys(uuid, code, type, duration_days, status, created, updated)
		VALUES(${crypto.randomUUID()}, ${code}, 'store', ${days}, 'available', ${now}, ${now})
	`;
	return await call("POST", `/projects/${projectId}/license/redeem`, ownerToken, { code });
}

async function customerLogin(email: string): Promise<string> {
	const request = await call("POST", "/customer/auth/request", undefined, { email, store: slug, return: `/shop/${slug}/checkout` });
	expect(request.error).toBe(0);
	const token = messages.at(-1)!.text.match(/#token=([A-Za-z0-9]{128})/)![1];
	const verified = await call("POST", "/customer/auth/verify", undefined, { token });
	expect(verified.error).toBe(0);
	return verified.data.token;
}

const address = {
	name: "Ana Novak",
	phone: "+386 40 123 456",
	address_line1: "Slovenska cesta 1",
	address_line2: null,
	postal_code: "1000",
	city: "Ljubljana",
	state: null,
	country: "SI",
};

function checkout(overrides: Record<string, unknown> = {}) {
	return {
		lines: [{ product: gpu, quantity: 1 }],
		shipping: null,
		customer: { ...address, customer_type: "individual", company: null, vat_number: null, tax_number: null },
		delivery: null,
		note: "Please ring twice",
		accept_terms: true,
		save_profile: true,
		...overrides,
	};
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await Server.configure();
	Settings.email.enabled = true;
	setTransport({
		sendMail: async (message: (typeof messages)[number]) => {
			messages.push(message);
			return { messageId: "store-test" };
		},
	} as never);

	const now = Date.now();
	await Database`INSERT INTO accounts(username, email, password, created, updated, accessed) VALUES('store-owner', 'owner@pixel.test', 'unused', ${now}, ${now}, ${now})`;
	ownerToken = (await Auth.createSession("store-owner", ""))!;
	project = (await call("POST", "/projects", ownerToken, { name: "pixel-parts", currency: "EUR" })).data.uuid;
	await call("PATCH", `/projects/${project}`, ownerToken, { display_name: "Pixel Parts" });

	gpu = (
		await call("POST", `${base()}/items`, ownerToken, {
			name: "Asus Dual Radeon RX 9060 XT",
			sku: "RX9060XT",
			unit_price: 30000,
			currency: "EUR",
			tax_rate: 22,
			supply_type: "goods",
		})
	).data.uuid;
	giftCard = (await call("POST", `${base()}/items`, ownerToken, { name: "Gift card", unit_price: 5000, currency: "EUR", tax_rate: 0, supply_type: "services" }))
		.data.uuid;

	await redeemStore(project);
	const state = await call("GET", `${base()}/store`, ownerToken);
	const config = {
		...state.data.config,
		shipping: [{ id: "post", name: "Pošta", price: 499, free_from: 10000, min_days: 1, max_days: 2, pickup: false }],
	};
	expect((await call("PUT", `${base()}/store`, ownerToken, { slug, domain: null, enabled: true, config })).error).toBe(0);
	const product = {
		featured: false,
		category: null,
		summary: null,
		description: null,
		compare_price: null,
		allow_backorder: false,
		delivery_min_days: null,
		delivery_max_days: null,
		restock_at: null,
		sort_order: 0,
		attributes: [],
		published: true,
	};
	expect((await call("PUT", `${base()}/store/products/${gpu}`, ownerToken, { ...product, slug: "asus-dual-rx-9060-xt", stock: 1 })).error).toBe(0);
	expect((await call("PUT", `${base()}/store/products/${giftCard}`, ownerToken, { ...product, slug: "gift-card", stock: null })).error).toBe(0);
	const bank = await call("PUT", `${base()}/processors/bank_transfer`, ownerToken, {
		enabled: true,
		config: { iban: "SI56 1910 0000 0123 438", account_holder: "Pixel Parts d.o.o." },
	});
	expect(bank.error).toBe(0);
	customerToken = await customerLogin("ana@example.com");
});

afterAll(async () => {
	await Database.close();
	rmSync(FIXTURE, { recursive: true, force: true });
});

describe("store coupons", () => {
	test("gives coupon discounts on the invoice and counts every use", async () => {
		const coupons = `${base()}/store/coupons`;
		expect((await call("POST", coupons, ownerToken, { code: "a", kind: "percent", amount: 10 })).error).toBe(1227);
		expect((await call("POST", coupons, ownerToken, { code: "HALF", kind: "percent", amount: 101 })).error).toBe(1227);
		const created = await call("POST", coupons, ownerToken, { code: "save10", kind: "percent", amount: 10, once_per_customer: true, max_uses: 5 });
		expect(created.status).toBe(201);
		expect(created.data.code).toBe("SAVE10");
		expect((await call("POST", coupons, ownerToken, { code: "SAVE10", kind: "amount", amount: 500 })).error).toBe(1229);
		await call("POST", coupons, ownerToken, { code: "BIG", kind: "amount", amount: 5000, minimum: 50000 });
		await call("POST", coupons, ownerToken, { code: "SHIPFREE", kind: "free_shipping" });
		const off = await call("POST", coupons, ownerToken, { code: "OFF", kind: "amount", amount: 1000, enabled: false });

		const quote = (coupon: string, product = gpu) => call("POST", `/store/${slug}/quote`, undefined, { lines: [{ product, quantity: 1 }], coupon });
		const discounted = await quote("save10");
		expect(discounted.data.coupon).toEqual({ code: "SAVE10", kind: "percent", amount: 10 });
		expect(discounted.data.discount_amount).toBe(3660);
		expect(discounted.data.total).toBe(32940);
		expect(discounted.data.invoice_discount).toBeUndefined();
		expect((await quote("NOPE")).data).toMatchObject({ coupon: null, coupon_issue: "unknown", total: 36600 });
		expect((await quote("BIG")).data).toMatchObject({ coupon_issue: "minimum", total: 36600 });
		expect((await quote("SHIPFREE", giftCard)).data.coupon_issue).toBe("not_applicable");
		expect((await quote("OFF")).data.coupon_issue).toBe("disabled");

		expect((await call("POST", `/store/${slug}/checkout`, customerToken, checkout({ coupon: "OFF" }))).error).toBe(1225);
		const placed = await call("POST", `/store/${slug}/checkout`, customerToken, checkout({ coupon: "save10" }));
		expect(placed.status).toBe(201);
		expect(placed.data.total_amount).toBe(32940);
		const [invoice] = await Database`SELECT discount_amount, total_amount, metadata FROM invoices WHERE uuid = ${placed.data.invoice}`;
		expect(Number(invoice.discount_amount)).toBeGreaterThan(0);
		expect(Number(invoice.total_amount)).toBe(32940);
		expect(JSON.parse(invoice.metadata).coupon).toBe("SAVE10");

		const order = await call("GET", `${base()}/store/orders/${placed.data.invoice}`, ownerToken);
		expect(order.data.coupon).toEqual({ code: "SAVE10", discount: 3660 });
		expect(order.data.items[0].total - order.data.coupon.discount).toBe(order.data.total_amount);
		const used = (await call("GET", coupons, ownerToken)).data.find((coupon: { code: string }) => coupon.code === "SAVE10");
		expect(used).toMatchObject({ uses: 1, discount_total: 3660 });

		await Database`UPDATE store_products SET stock = 5 WHERE item = ${gpu}`;
		expect((await call("POST", `/store/${slug}/checkout`, customerToken, checkout({ coupon: "SAVE10" }))).error).toBe(1226);

		await call("POST", `${base()}/store/orders/${placed.data.invoice}/cancel`, ownerToken, {});
		const released = (await call("GET", coupons, ownerToken)).data.find((coupon: { code: string }) => coupon.code === "SAVE10");
		expect(released).toMatchObject({ uses: 0, discount_total: 0 });

		expect((await call("DELETE", `${coupons}/${off.data.uuid}`, ownerToken)).error).toBe(0);
		await Database`UPDATE store_products SET stock = 1 WHERE item = ${gpu}`;
	});
});
