import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { prepareTest } from "./environment";

await prepareTest();

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { Settings } = await import("../server/settings");
const { setTransport } = await import("../server/email/mailer");
const { default: Auth } = await import("../server/auth");
const { generateLicenseCode } = await import("../server/licensing");
const { deliverPendingKeys } = await import("../server/key-delivery");
const { issuePaidDraft } = await import("../server/paid-drafts");
const { serverId } = await import("../server/server-identity");
const { belowMinimum, licensePrice, readLicenseChoice, readLicenseProduct, smallestChoice } = await import("../server/license-pricing");

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

const messages: { to: string; text: string; subject: string }[] = [];
const tokens = { admin: "", staff: "", other: "" };
let project = "";
let otherProject = "";
let seats = "";
let payments = "";
let customer = "";
let order = "";
const slug = "rabbitpay-licenses";
const base = () => `/projects/${project}`;

const SEATS = { type: "employees", rate: 150, minimum: 1000, below_minimum: "charge", min_amount: 1, max_amount: 10000, min_days: 30, max_days: 3650 };
const PAYMENTS = { type: "transactions", rate: 2900, minimum: 500, below_minimum: "charge", min_amount: 1000, max_amount: 100000 };
const STORAGE = { type: "storage", rate: 50, minimum: 500, below_minimum: "refuse", min_amount: 1, max_amount: 1000, min_days: 30, max_days: 3650 };

async function account(username: string, admin: boolean): Promise<string> {
	const now = Date.now();
	await Database`
		INSERT INTO accounts(username, email, password, admin, created, updated, accessed)
		VALUES(${username}, ${`${username}@rabbitpay.test`}, 'unused', ${admin ? 1 : 0}, ${now}, ${now}, ${now})
	`;
	return (await Auth.createSession(username, ""))!;
}

async function customerLogin(email: string): Promise<string> {
	await call("POST", "/customer/auth/request", undefined, { email, store: slug, return: `/shop/${slug}/checkout` });
	const token = messages.at(-1)!.text.match(/#token=([A-Za-z0-9]{128})/)![1];
	return (await call("POST", "/customer/auth/verify", undefined, { token })).data.token;
}

function publish(item: string, productSlug: string, name: string | null = null) {
	return call("PUT", `${base()}/store/products/${item}`, tokens.admin, {
		name,
		slug: productSlug,
		published: true,
		featured: false,
		category: null,
		summary: null,
		description: null,
		compare_price: null,
		stock: null,
		allow_backorder: false,
		delivery_min_days: null,
		delivery_max_days: null,
		restock_at: null,
		sort_order: 0,
		attributes: [],
	});
}

function checkout(lines: unknown[], overrides: Record<string, unknown> = {}) {
	return {
		lines,
		shipping: null,
		customer: {
			name: "Self Host",
			phone: null,
			address_line1: "Trg 1",
			address_line2: null,
			postal_code: "1000",
			city: "Ljubljana",
			state: null,
			country: "SI",
			customer_type: "individual",
			company: null,
			vat_number: null,
			tax_number: null,
		},
		delivery: null,
		note: null,
		accept_terms: true,
		waive_withdrawal: true,
		accept_license_scope: true,
		save_profile: false,
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
			return { messageId: "license-store-test" };
		},
	} as never);

	tokens.admin = await account("rp-admin", true);
	tokens.staff = await account("rp-staff", false);
	tokens.other = await account("rp-other", false);
	project = (await call("POST", "/projects", tokens.admin, { name: "rabbitpay-licenses", currency: "EUR" })).data.uuid;
	otherProject = (await call("POST", "/projects", tokens.other, { name: "other-shop", currency: "EUR" })).data.uuid;
	const now = Date.now();
	await Database`
		INSERT INTO project_members(uuid, project_id, account_username, role, status, created, updated)
		VALUES(${crypto.randomUUID()}, ${project}, 'rp-staff', 'admin', 'active', ${now}, ${now})
	`;
});

afterAll(async () => {
	await Database.close();
});

describe("license products", () => {
	test("only server administrators on the issuer can sell RabbitPay licenses", async () => {
		const item = { name: "Employee seats", unit_price: 0, currency: "EUR", tax_rate: 22, supply_type: "services", license: SEATS };
		expect((await call("POST", `${base()}/items`, tokens.staff, item)).error).toBe(9999);
		expect((await call("POST", `/projects/${otherProject}/items`, tokens.other, item)).error).toBe(9999);
		expect((await call("POST", `${base()}/items`, tokens.admin, { ...item, license: { ...SEATS, min_days: null } })).error).toBe(1066);
		expect((await call("POST", `${base()}/items`, tokens.admin, { ...item, license: { ...SEATS, min_amount: 20, max_amount: 10 } })).error).toBe(1066);

		const created = await call("POST", `${base()}/items`, tokens.admin, item);
		expect(created.status).toBe(201);
		expect(created.data).toMatchObject({ delivers_keys: true, license: SEATS, unit_price: 1000, keys: null });
		seats = created.data.uuid;

		payments = (
			await call("POST", `${base()}/items`, tokens.admin, {
				name: "Payments",
				unit_price: 0,
				currency: "EUR",
				tax_rate: 22,
				supply_type: "services",
				license: PAYMENTS,
			})
		).data.uuid;

		const renamed = await call("PATCH", `${base()}/items/${seats}`, tokens.staff, { name: "Employee seats for RabbitPay" });
		expect(renamed.error).toBe(0);
		expect(renamed.data.license).toEqual(SEATS);
		expect((await call("PATCH", `${base()}/items/${seats}`, tokens.staff, { license: null })).error).toBe(9999);
		expect((await call("POST", `${base()}/items/${seats}/keys`, tokens.admin, { keys: "POOLED-KEY" })).error).toBe(1109);
	});

	test("are listed in the store without a stock of keys", async () => {
		const code = generateLicenseCode();
		const now = Date.now();
		await Database`INSERT INTO license_keys(uuid, code, type, duration_days, status, created, updated)
			VALUES(${crypto.randomUUID()}, ${code}, 'store', 30, 'available', ${now}, ${now})`;
		expect((await call("POST", `${base()}/license/redeem`, tokens.admin, { code })).error).toBe(0);
		const state = await call("GET", `${base()}/store`, tokens.admin);
		expect((await call("PUT", `${base()}/store`, tokens.admin, { slug, domain: null, enabled: true, config: state.data.config })).error).toBe(0);
		const listed = await publish(seats, "employee-seats", "Employee seats");
		expect(listed.data).toMatchObject({ name: "Employee seats", item: { name: "Employee seats for RabbitPay" } });
		expect((await publish(payments, "payments")).error).toBe(0);
		const bank = await call("PUT", `${base()}/processors/bank_transfer`, tokens.admin, {
			enabled: true,
			config: { iban: "SI56 1910 0000 0123 438", account_holder: "RabbitPay" },
		});
		expect(bank.error).toBe(0);

		const product = await call("GET", `/store/${slug}/products/employee-seats`);
		expect(product.data).toMatchObject({ name: "Employee seats", availability: "in_stock", stock: null, digital: true, license: SEATS, price: 1220 });
		const found = await call("GET", `/store/${slug}/products?q=employee%20seats`);
		expect(found.data.products.map((entry: { name: string }) => entry.name)).toEqual(["Employee seats"]);
	});

	test("quotes price the chosen amounts and refuse choices outside the limits", async () => {
		const quote = await call("POST", `/store/${slug}/quote`, undefined, {
			lines: [
				{ product: seats, quantity: 1, license: { amount: 20, days: 365 } },
				{ product: seats, quantity: 2, license: { amount: 5, days: 30 } },
			],
		});
		expect(quote.error).toBe(0);
		expect(quote.data.lines).toHaveLength(2);
		expect(licensePrice(SEATS as never, { amount: 20, days: 365 })).toBe(36500);
		expect(quote.data.lines[0]).toMatchObject({
			name: "Employee seats",
			unit_price: 44530,
			issue: null,
			license: { type: "employees", amount: 20, days: 365, server_id: null },
		});
		expect(quote.data.lines[1]).toMatchObject({ unit_price: 1220, quantity: 2, total: 2440 });
		expect(quote.data.withdrawal_waiver).toBe(true);
		expect(quote.data.license_scope).toBe(true);
		expect(quote.data.requires_shipping).toBe(false);
		expect(quote.data.licenses).toBeUndefined();

		for (const license of [undefined, { amount: 0, days: 365 }, { amount: 20, days: 5 }, { amount: 20, days: 365, server_id: "not-a-server" }]) {
			const refused = await call("POST", `/store/${slug}/quote`, undefined, { lines: [{ product: seats, quantity: 1, license }] });
			expect(refused.data.lines[0].issue).toBe("configuration");
			expect(refused.data.lines[0].license).toBeNull();
			expect(refused.data.lines[0].requested).toEqual(license ? { amount: license.amount, days: license.days, server_id: license.server_id ?? null } : null);
			expect(refused.data.ready).toBe(false);
		}
	});

	test("checkout records what was ordered, and paying the invoice creates and emails the keys", async () => {
		const server = await serverId();
		customer = await customerLogin("self-host@example.com");
		const lines = [
			{ product: seats, quantity: 1, license: { amount: 20, days: 365, server_id: server.toLowerCase() } },
			{ product: payments, quantity: 1, license: { amount: 5000 } },
		];
		expect((await call("POST", `/store/${slug}/checkout`, customer, checkout([{ product: seats, quantity: 1 }]))).error).toBe(1161);
		expect((await call("POST", `/store/${slug}/checkout`, customer, checkout(lines, { waive_withdrawal: false }))).error).toBe(1169);
		expect((await call("POST", `/store/${slug}/checkout`, customer, checkout(lines, { accept_license_scope: false }))).error).toBe(1250);
		expect((await call("POST", `/store/${slug}/checkout`, customer, checkout(lines, { accept_license_scope: "yes" }))).error).not.toBe(0);

		const placed = await call("POST", `/store/${slug}/checkout`, customer, checkout(lines));
		expect(placed.status).toBe(201);
		order = placed.data.invoice;
		const [recorded] = await Database`SELECT metadata FROM invoices WHERE uuid = ${order}`;
		expect(JSON.parse(recorded.metadata).license_scope_accepted_at).toBeGreaterThan(0);
		const items = await Database`SELECT description, quantity, unit_price FROM invoice_items WHERE invoice = ${order} ORDER BY sort_order`;
		expect(items[0].description).toBe(`Employee seats for RabbitPay (20 employees, 365 days, server ${server})`);
		expect(items[1].description).toBe("Payments (5000 payments, for rabbitpay.net)");
		expect(Number(items[0].unit_price)).toBe(36500);
		expect(Number(items[1].unit_price)).toBe(14500);

		await deliverPendingKeys();
		const early = await Database`SELECT uuid FROM license_keys WHERE note LIKE ${`Store order ${placed.data.reference}%`}`;
		expect(early).toHaveLength(0);

		const invoice = await call("GET", `${base()}/invoices/${order}`, tokens.admin);
		const paid = await call("POST", `${base()}/transactions`, tokens.admin, {
			invoice: order,
			processor: "bank_transfer",
			amount: invoice.data.total_amount,
		});
		expect(paid.error).toBe(0);
		expect(await issuePaidDraft(order)).toBeNull();
		const [{ reference: issued }] = await Database`SELECT reference FROM invoices WHERE uuid = ${order}`;
		expect(issued).toMatch(/^[0-9]{12}$/);
		await deliverPendingKeys();
		await deliverPendingKeys();

		const keys = await Database`SELECT * FROM license_keys WHERE note = ${`Store order ${placed.data.reference}, invoice ${issued}`} ORDER BY type`;
		expect(keys).toHaveLength(2);
		expect(keys[0]).toMatchObject({
			type: "employees",
			employees: 20,
			duration_days: 365,
			server_id: server,
			currency: "EUR",
			buyer_email: "self-host@example.com",
		});
		expect(Number(keys[0].price)).toBe(36500);
		expect(keys[0].signed_key).toStartWith("RPAY2.");
		expect(keys[1]).toMatchObject({ type: "transactions", transactions: 5000, server_id: null, signed_key: null });

		const delivered = await Database`SELECT secret, status FROM item_keys WHERE invoice = ${order} ORDER BY secret`;
		expect(delivered.map((row: { status: string }) => row.status)).toEqual(["delivered", "delivered"]);
		const [email] = await Database`SELECT recipient, body_text FROM email_messages WHERE invoice = ${order} AND kind = 'keys'`;
		expect(email.recipient).toBe("self-host@example.com");
		expect(email.body_text).toContain(keys[1].code);
		expect(email.body_text).toContain(keys[0].signed_key);

		const target = (await call("POST", "/projects", tokens.admin, { name: "self-hosted-twin", currency: "EUR" })).data.uuid;
		const seatsRedeemed = await call("POST", `/projects/${target}/license/redeem`, tokens.admin, { code: keys[0].signed_key });
		expect(seatsRedeemed.data).toMatchObject({ employees_licensed: 20 });
		const paymentsRedeemed = await call("POST", `/projects/${target}/license/redeem`, tokens.admin, { code: keys[1].code });
		expect(paymentsRedeemed.data.paid_balance).toBe(5000);
	});

	test("a choice below the minimum price is charged the minimum or not allowed, as the item says", async () => {
		const charged = { ...STORAGE, below_minimum: "charge" };
		expect(readLicenseProduct({ ...STORAGE, below_minimum: undefined })).toMatchObject({ below_minimum: "charge" });
		expect(readLicenseProduct({ ...STORAGE, below_minimum: "sometimes" })).toBeNull();
		expect(readLicenseChoice(charged as never, { amount: 1, days: 30 })).toEqual({ amount: 1, days: 30, server_id: null });
		expect(licensePrice(charged as never, { amount: 1, days: 30 })).toBe(500);

		expect(belowMinimum(STORAGE as never, { amount: 1, days: 30 })).toBe(true);
		expect(readLicenseChoice(STORAGE as never, { amount: 1, days: 30 })).toBeNull();
		expect(readLicenseChoice(STORAGE as never, { amount: 9, days: 30 })).toBeNull();
		expect(readLicenseChoice(STORAGE as never, { amount: 10, days: 30 })).toEqual({ amount: 10, days: 30, server_id: null });
		expect(licensePrice(STORAGE as never, { amount: 1, days: 365 })).toBe(608);

		expect(smallestChoice(charged as never)).toEqual({ amount: 1, days: 30, server_id: null });
		expect(smallestChoice(STORAGE as never)).toEqual({ amount: 1, days: 300, server_id: null });
		expect(smallestChoice({ ...SEATS, below_minimum: "refuse" } as never)).toEqual({ amount: 1, days: 210, server_id: null });
		expect(smallestChoice(readLicenseProduct({ ...PAYMENTS, minimum: 5800, below_minimum: "refuse" })!)).toEqual({ amount: 2000, days: null, server_id: null });
		expect(smallestChoice({ ...STORAGE, max_days: 90 } as never)).toEqual({ amount: 4, days: 90, server_id: null });

		const emails = readLicenseProduct({ type: "emails", rate: 200, minimum: 100, below_minimum: "refuse", min_amount: 100, max_amount: 100000 })!;
		expect(emails).toMatchObject({ type: "emails", min_days: null, max_days: null });
		expect(licensePrice(emails, { amount: 2500, days: null })).toBe(500);
		expect(smallestChoice(emails)).toEqual({ amount: 500, days: null, server_id: null });
		expect(readLicenseChoice(emails, { amount: 1000 })).toEqual({ amount: 1000, days: null, server_id: null });
		expect(readLicenseChoice(emails, { amount: 1000, server_id: "RPS-00000-00000-00000-00000" })).toBeNull();

		const item = { name: "Document storage", unit_price: 0, currency: "EUR", tax_rate: 22, supply_type: "services", license: STORAGE };
		const unreachable = { ...STORAGE, max_amount: 1, max_days: 90 };
		expect((await call("POST", `${base()}/items`, tokens.admin, { ...item, license: unreachable })).error).toBe(1066);
		const created = await call("POST", `${base()}/items`, tokens.admin, item);
		expect(created.data).toMatchObject({ license: STORAGE, unit_price: 500 });

		expect((await publish(created.data.uuid, "document-storage")).error).toBe(0);
		const quoted = async (license: Record<string, unknown>) =>
			(await call("POST", `/store/${slug}/quote`, undefined, { lines: [{ product: created.data.uuid, quantity: 1, license }] })).data.lines[0];
		expect(await quoted({ amount: 1, days: 30 })).toMatchObject({ issue: "configuration", unit_price: 61, license: null });
		expect(await quoted({ amount: 6, days: 30 })).toMatchObject({ issue: "configuration", unit_price: 366 });
		expect(await quoted({ amount: 10, days: 30 })).toMatchObject({ issue: null, unit_price: 610 });
		expect(await quoted({ amount: 0, days: 30 })).toMatchObject({ issue: "configuration", unit_price: 610 });
	});

	test("stop selling when no owner of the store project is a server administrator", async () => {
		await Database`UPDATE accounts SET admin = 0 WHERE username = 'rp-admin'`;
		try {
			const quote = await call("POST", `/store/${slug}/quote`, undefined, { lines: [{ product: payments, quantity: 1, license: { amount: 1000 } }] });
			expect(quote.data.lines[0].issue).toBe("unavailable");
			const refused = await call("POST", `/store/${slug}/checkout`, customer, checkout([{ product: payments, quantity: 1, license: { amount: 1000 } }]));
			expect(refused.error).toBe(1162);
		} finally {
			await Database`UPDATE accounts SET admin = 1 WHERE username = 'rp-admin'`;
		}
	});
});
