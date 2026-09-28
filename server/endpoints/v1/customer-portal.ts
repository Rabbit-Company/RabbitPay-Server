import { rateLimit } from "@rabbit-company/web-middleware/rate-limit";
import { Server } from "../../server";
import Database from "../../database/database";
import CustomerAuth, { CUSTOMER_LINK_TTL } from "../../customer-auth";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Settings } from "../../settings";
import { isEnabled, sendEmail } from "../../email/mailer";
import { customerLoginEmail } from "../../email/templates";
import { invoiceDocument } from "../../invoice-document";
import { creditNoteDocument } from "../../credit-note-document";
import { creditNotePdf, invoicePdf, pdfResponse } from "../../invoice-pdf";
import { customerEslogResponse } from "../../eslog-archive";
import { outstandingOf } from "../../invoicing";
import { displayNameOf } from "../../company";
import { isUiLanguage } from "../../../web/src/i18n/dictionary";
import { isSlug } from "../../store/config";
import { portalAccess } from "../../workforce/tickets";
import { storeBySlug } from "../../store/store";
import { paymentStatusOf } from "../../store/orders";
import { readAddress, writeProfile, type ProfileFields } from "../../store/checkout";
import { isCustomerType } from "../../tax";
import type { CreditNoteRow, CustomerProfileRow, InvoiceRow, ProjectRow, StoreOrderRow } from "../../database/models";

function isReturnPath(value: unknown): value is string {
	return typeof value === "string" && value.length <= 300 && /^\/(?![/\\])[^\s\\]*$/.test(value);
}

const loginLimit = rateLimit({
	windowMs: (Settings.security?.credential_rate_window || 900) * 1000,
	max: Settings.security?.credential_rate_limit || 10,
	message: "Too many attempts. Please try again later.",
});
const documentLimit = rateLimit({ windowMs: 60 * 1000, max: 20, message: "Too many requests. Please slow down." });

Server.app.post("/api/v1/customer/auth/request", loginLimit, async (ctx) => {
	ctx.header("Cache-Control", "no-store");
	let data: { email?: string; language?: string; store?: string; return?: string };
	try {
		data = await ctx.body();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}
	const email = typeof data?.email === "string" ? data.email.trim().toLowerCase() : "";
	if (!Validate.email(email)) return Utils.fail(ctx, ErrorCode.INVALID_EMAIL);
	if (!isEnabled()) return Utils.fail(ctx, ErrorCode.EMAIL_NOT_CONFIGURED);
	const now = Date.now();
	const token = Utils.generateRandomText(128);
	const hash = await Utils.generateHash(token, "sha256");
	const accepted = await Database.begin(async (tx) => {
		await tx`DELETE FROM customer_login_links WHERE expires_at <= ${now}`;
		const [recent] = await tx`SELECT COUNT(*) AS count FROM customer_login_links WHERE email = ${email} AND created > ${now - CUSTOMER_LINK_TTL}`;
		if (Number(recent.count) >= 3) return false;
		await tx`INSERT INTO customer_login_links(token_hash, email, created, expires_at) VALUES(${hash}, ${email}, ${now}, ${now + CUSTOMER_LINK_TTL})`;
		return true;
	});
	if (!accepted) return Utils.fail(ctx, ErrorCode.RATE_LIMITED);
	const store = isSlug(data.store, 100) ? await storeBySlug(data.store) : null;
	const language = store ? store.config.language : isUiLanguage(data.language) ? data.language : "en";
	const origin = store?.settings.domain ? `https://${store.settings.domain}` : Utils.publicUrl();
	const returnTo = isReturnPath(data.return) ? `&return=${encodeURIComponent(data.return)}` : "";
	const url = `${origin}/customer/login#token=${token}${returnTo}`;
	const sender = store ? store.config.name : "RabbitPay";
	try {
		await sendEmail({
			to: email,
			senderName: sender,
			replyTo: null,
			...customerLoginEmail(language, url, store ? { name: store.config.name, accent: store.config.theme.accent } : null),
		});
	} catch {
		await Database`DELETE FROM customer_login_links WHERE token_hash = ${hash}`;
		return Utils.fail(ctx, ErrorCode.EMAIL_SERVER_FAILED);
	}
	return Utils.ok(ctx);
});

Server.app.post("/api/v1/customer/auth/verify", loginLimit, async (ctx) => {
	ctx.header("Cache-Control", "no-store");
	let data: { token?: string };
	try {
		data = await ctx.body();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}
	if (!Validate.token(data?.token)) return Utils.fail(ctx, ErrorCode.INVALID_TOKEN);
	const email = await CustomerAuth.consumeLink(data.token!);
	if (!email) return Utils.fail(ctx, ErrorCode.TOKEN_EXPIRED);
	const token = await CustomerAuth.createSession(email, Utils.clientIp(ctx));
	if (!token) return Utils.fail(ctx, ErrorCode.REDIS_CONNECTION_ERROR);
	return Utils.ok(ctx, { token, email, expires_in: CustomerAuth.ttlSeconds() });
});

Server.app.get("/api/v1/customer/auth/me", CustomerAuth.required(), async (ctx) => {
	const email = CustomerAuth.email(ctx);
	return Utils.ok(ctx, { email, tickets: (await portalAccess(email)).length > 0 });
});

Server.app.post("/api/v1/customer/auth/logout", CustomerAuth.required(), async (ctx) => {
	await CustomerAuth.destroySession(ctx.get("customerSessionToken")!);
	return Utils.ok(ctx);
});

async function ownedInvoice(email: string, uuid: string) {
	const [invoice] = (await Database`
		SELECT i.* FROM invoices i JOIN projects p ON p.uuid = i.project
		WHERE i.uuid = ${uuid} AND i.buyer_email = ${email} AND i.status != 'draft' AND i.issued_at IS NOT NULL AND p.status != 'deleted'
	`) as InvoiceRow[];
	if (!invoice) return null;
	const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${invoice.project} AND status != 'deleted'`) as ProjectRow[];
	return project ? { invoice, project } : null;
}

Server.app.get("/api/v1/customer/invoices", CustomerAuth.required(), async (ctx) => {
	const email = CustomerAuth.email(ctx);
	const query = ctx.query();
	const status = query.get("status");
	if (status !== null && !["unpaid", "overdue", "paid"].includes(status)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_STATUS);
	const pageNumber = (value: string | null, fallback: number) => {
		const number = Number(value);
		return value !== null && Number.isSafeInteger(number) && number >= 0 ? number : fallback;
	};
	const limit = Math.min(Math.max(pageNumber(query.get("limit"), 50), 1), 200);
	const offset = pageNumber(query.get("offset"), 0);
	const unpaid = Database`AND i.status IN ('open', 'overdue', 'partially_paid')
		AND i.total_amount - i.credited_amount - i.paid_amount + i.refunded_amount > 0`;
	const filter =
		status === "paid"
			? Database`AND i.status = 'paid'`
			: status === "overdue"
				? Database`${unpaid} AND i.due_date < ${Date.now()}`
				: status === "unpaid"
					? unpaid
					: Database``;
	const rows = (await Database`
		SELECT i.*, p.name AS project_name, p.display_name AS merchant, p.language, p.date_format, p.timezone
		FROM invoices i JOIN projects p ON p.uuid = i.project
		WHERE i.buyer_email = ${email} AND i.status != 'draft' AND i.issued_at IS NOT NULL AND p.status != 'deleted' ${filter}
		ORDER BY i.created DESC, i.uuid ASC LIMIT ${limit} OFFSET ${offset}
	`) as (InvoiceRow & { merchant: string | null; project_name: string; language: string; date_format: string; timezone: string })[];
	const [total] = await Database`
		SELECT COUNT(*) AS count FROM invoices i JOIN projects p ON p.uuid = i.project
		WHERE i.buyer_email = ${email} AND i.status != 'draft' AND i.issued_at IS NOT NULL AND p.status != 'deleted' ${filter}
	`;
	return Utils.ok(ctx, {
		invoices: rows.map((row) => ({
			uuid: row.uuid,
			reference: row.reference,
			merchant: displayNameOf({ name: row.project_name, display_name: row.merchant }),
			status: row.status,
			currency: row.currency,
			total_amount: row.total_amount,
			outstanding: outstandingOf(row),
			issued: row.issued_at ?? row.created,
			due_date: row.due_date,
			language: row.language,
			date_format: row.date_format,
			timezone: row.timezone,
		})),
		total: Number(total.count),
		limit,
		offset,
	});
});

Server.app.get("/api/v1/customer/proformas", CustomerAuth.required(), async (ctx) => {
	const email = CustomerAuth.email(ctx);
	const rows = (await Database`
		SELECT i.*, pf.issued_at AS proforma_issued, p.name AS project_name, p.display_name AS merchant, p.date_format, p.timezone
		FROM proformas pf
		JOIN invoices i ON i.uuid = pf.invoice
		JOIN customers c ON c.uuid = i.customer
		JOIN projects p ON p.uuid = i.project
		WHERE LOWER(c.email) = ${email} AND i.status = 'draft' AND p.status != 'deleted'
		ORDER BY pf.issued_at DESC, i.uuid ASC LIMIT 100
	`) as (InvoiceRow & { proforma_issued: number; merchant: string | null; project_name: string; date_format: string; timezone: string })[];
	return Utils.ok(ctx, {
		proformas: rows
			.filter((row) => outstandingOf(row) > 0)
			.map((row) => ({
				uuid: row.uuid,
				reference: row.reference,
				merchant: displayNameOf({ name: row.project_name, display_name: row.merchant }),
				currency: row.currency,
				total_amount: row.total_amount,
				outstanding: outstandingOf(row),
				issued: Number(row.proforma_issued),
				valid_until: row.due_date,
				date_format: row.date_format,
				timezone: row.timezone,
			})),
	});
});

Server.app.get("/api/v1/customer/invoices/:invoice", CustomerAuth.required(), async (ctx) => {
	const uuid = ctx.params["invoice"];
	if (!Validate.uuid(uuid)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);
	const found = await ownedInvoice(CustomerAuth.email(ctx), uuid);
	if (!found) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
	const notes =
		(await Database`SELECT * FROM credit_notes WHERE invoice = ${uuid} AND project = ${found.project.uuid} ORDER BY issued_at DESC, uuid ASC`) as CreditNoteRow[];
	return Utils.ok(ctx, {
		document: await invoiceDocument(found.project, found.invoice),
		credit_notes: notes.map((note) => ({
			uuid: note.uuid,
			reference: note.reference,
			currency: note.currency,
			total_amount: note.total_amount,
			issued: note.issued_at,
			reason: note.reason,
		})),
	});
});

Server.app.get("/api/v1/customer/invoices/:invoice/pdf", CustomerAuth.required(), documentLimit, async (ctx) => {
	const uuid = ctx.params["invoice"];
	if (!Validate.uuid(uuid)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);
	const found = await ownedInvoice(CustomerAuth.email(ctx), uuid);
	if (!found) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
	return pdfResponse(await invoicePdf(found.project, found.invoice, { payLink: true }));
});

Server.app.get("/api/v1/customer/invoices/:invoice/eslog", CustomerAuth.required(), documentLimit, async (ctx) => {
	const uuid = ctx.params["invoice"];
	if (!Validate.uuid(uuid)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);
	const found = await ownedInvoice(CustomerAuth.email(ctx), uuid);
	if (!found) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
	return await customerEslogResponse(ctx, { kind: "invoice", project: found.project, invoice: found.invoice });
});

async function ownedNote(email: string, uuid: string) {
	const [note] = (await Database`SELECT * FROM credit_notes WHERE uuid = ${uuid}`) as CreditNoteRow[];
	if (!note) return null;
	const found = await ownedInvoice(email, note.invoice);
	return found && note.project === found.project.uuid ? { ...found, note } : null;
}

Server.app.get("/api/v1/customer/credit-notes/:note", CustomerAuth.required(), async (ctx) => {
	const uuid = ctx.params["note"];
	if (!Validate.uuid(uuid)) return Utils.fail(ctx, ErrorCode.INVALID_CREDIT_NOTE_ID);
	const found = await ownedNote(CustomerAuth.email(ctx), uuid);
	if (!found) return Utils.fail(ctx, ErrorCode.CREDIT_NOTE_NOT_FOUND);
	return Utils.ok(ctx, await creditNoteDocument(found.project, found.note));
});

Server.app.get("/api/v1/customer/credit-notes/:note/pdf", CustomerAuth.required(), documentLimit, async (ctx) => {
	const uuid = ctx.params["note"];
	if (!Validate.uuid(uuid)) return Utils.fail(ctx, ErrorCode.INVALID_CREDIT_NOTE_ID);
	const found = await ownedNote(CustomerAuth.email(ctx), uuid);
	if (!found) return Utils.fail(ctx, ErrorCode.CREDIT_NOTE_NOT_FOUND);
	return pdfResponse(await creditNotePdf(found.project, found.note));
});

Server.app.get("/api/v1/customer/credit-notes/:note/eslog", CustomerAuth.required(), documentLimit, async (ctx) => {
	const uuid = ctx.params["note"];
	if (!Validate.uuid(uuid)) return Utils.fail(ctx, ErrorCode.INVALID_CREDIT_NOTE_ID);
	const found = await ownedNote(CustomerAuth.email(ctx), uuid);
	if (!found) return Utils.fail(ctx, ErrorCode.CREDIT_NOTE_NOT_FOUND);
	return await customerEslogResponse(ctx, { kind: "credit_note", project: found.project, note: found.note });
});

function presentProfile(email: string, row: CustomerProfileRow | undefined) {
	return {
		email,
		customer_type: row?.customer_type ?? "individual",
		name: row?.name ?? null,
		company: row?.company ?? null,
		phone: row?.phone ?? null,
		vat_number: row?.vat_number ?? null,
		tax_number: row?.tax_number ?? null,
		address_line1: row?.address_line1 ?? null,
		address_line2: row?.address_line2 ?? null,
		postal_code: row?.postal_code ?? null,
		city: row?.city ?? null,
		state: row?.state ?? null,
		country: row?.country ?? null,
		shipping_same: row ? Boolean(row.shipping_same) : true,
		shipping:
			row && !row.shipping_same
				? {
						name: row.shipping_name,
						phone: row.shipping_phone,
						address_line1: row.shipping_address_line1,
						address_line2: row.shipping_address_line2,
						postal_code: row.shipping_postal_code,
						city: row.shipping_city,
						state: row.shipping_state,
						country: row.shipping_country,
					}
				: null,
		saved: Boolean(row),
		updated: row?.updated ?? null,
	};
}

async function profileOf(email: string) {
	const [row] = (await Database`SELECT * FROM customer_profiles WHERE email = ${email}`) as CustomerProfileRow[];
	return presentProfile(email, row);
}

function optional(value: unknown, max: number): string | null | undefined {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || value.length > max) return undefined;
	return value.trim() === "" ? null : value.trim();
}

function readProfile(data: Record<string, unknown>): ProfileFields | null {
	const type = data.customer_type ?? "individual";
	if (typeof type !== "string" || !isCustomerType(type)) return null;
	const fields = {
		name: optional(data.name, 150),
		company: optional(data.company, 200),
		phone: optional(data.phone, 40),
		vat_number: optional(data.vat_number, 40),
		tax_number: optional(data.tax_number, 40),
		address_line1: optional(data.address_line1, 200),
		address_line2: optional(data.address_line2, 200),
		postal_code: optional(data.postal_code, 20),
		city: optional(data.city, 100),
		state: optional(data.state, 100),
	};
	if (Object.values(fields).some((value) => value === undefined)) return null;
	const country = data.country === null || data.country === undefined || data.country === "" ? null : data.country;
	if (country !== null && (typeof country !== "string" || !Validate.country(country.toUpperCase()))) return null;
	if (typeof data.shipping_same !== "boolean") return null;
	const shipping = data.shipping_same ? null : readAddress(data.shipping);
	if (!data.shipping_same && !shipping) return null;
	return {
		customer_type: type,
		name: fields.name!,
		company: type === "business" ? fields.company! : null,
		phone: fields.phone!,
		vat_number: type === "business" ? fields.vat_number! : null,
		tax_number: type === "business" ? fields.tax_number! : null,
		address_line1: fields.address_line1!,
		address_line2: fields.address_line2!,
		postal_code: fields.postal_code!,
		city: fields.city!,
		state: fields.state!,
		country: country === null ? null : (country as string).toUpperCase(),
		shipping_same: data.shipping_same ? 1 : 0,
		shipping_name: shipping?.name ?? null,
		shipping_phone: shipping?.phone ?? null,
		shipping_address_line1: shipping?.address_line1 ?? null,
		shipping_address_line2: shipping?.address_line2 ?? null,
		shipping_postal_code: shipping?.postal_code ?? null,
		shipping_city: shipping?.city ?? null,
		shipping_state: shipping?.state ?? null,
		shipping_country: shipping?.country ?? null,
	};
}

Server.app.get("/api/v1/customer/profile", CustomerAuth.required(), async (ctx) => {
	return Utils.ok(ctx, await profileOf(CustomerAuth.email(ctx)));
});

Server.app.put("/api/v1/customer/profile", CustomerAuth.required(), async (ctx) => {
	const email = CustomerAuth.email(ctx);
	let data: Record<string, unknown>;
	try {
		data = await ctx.body();
	} catch {
		return Utils.fail(ctx, ErrorCode.INVALID_CUSTOMER_PROFILE);
	}
	const profile = data && typeof data === "object" ? readProfile(data) : null;
	if (!profile) return Utils.fail(ctx, ErrorCode.INVALID_CUSTOMER_PROFILE);
	await writeProfile(email, profile);
	return Utils.ok(ctx, await profileOf(email));
});

Server.app.delete("/api/v1/customer/profile", CustomerAuth.required(), async (ctx) => {
	await Database`DELETE FROM customer_profiles WHERE email = ${CustomerAuth.email(ctx)}`;
	return Utils.ok(ctx, await profileOf(CustomerAuth.email(ctx)));
});

type CustomerOrderRow = StoreOrderRow &
	Pick<InvoiceRow, "reference" | "status" | "currency" | "total_amount" | "paid_amount" | "refunded_amount" | "credited_amount"> & {
		slug: string | null;
		domain: string | null;
		store_config: string | null;
		merchant: string | null;
		project_name: string;
	};

function storeName(row: CustomerOrderRow): string {
	try {
		const name = row.store_config ? JSON.parse(row.store_config).name : null;
		if (typeof name === "string" && name) return name;
	} catch {
		void 0;
	}
	return displayNameOf({ name: row.project_name, display_name: row.merchant });
}

async function customerOrders(email: string, limit: number, offset: number) {
	return (await Database`
		SELECT o.*, i.reference, i.status, i.currency, i.total_amount, i.paid_amount, i.refunded_amount, i.credited_amount,
			s.slug, s.domain, s.config AS store_config, p.display_name AS merchant, p.name AS project_name
		FROM store_orders o
		JOIN invoices i ON i.uuid = o.invoice
		JOIN projects p ON p.uuid = o.project
		LEFT JOIN store_settings s ON s.project = o.project
		WHERE o.email = ${email} AND p.status != 'deleted'
		ORDER BY o.created DESC, o.invoice ASC LIMIT ${limit} OFFSET ${offset}
	`) as CustomerOrderRow[];
}

Server.app.get("/api/v1/customer/orders", CustomerAuth.required(), async (ctx) => {
	const email = CustomerAuth.email(ctx);
	const query = ctx.query();
	const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);
	const rows = await customerOrders(email, limit, offset);
	const [total] = await Database`SELECT COUNT(*) AS count FROM store_orders WHERE email = ${email}`;
	return Utils.ok(ctx, {
		orders: rows.map((row) => ({
			invoice: row.invoice,
			reference: row.reference,
			number: row.number ?? row.reference,
			store: storeName(row),
			store_url: row.slug ? (row.domain ? `https://${row.domain}` : `/shop/${row.slug}`) : null,
			fulfillment: row.fulfillment,
			payment_status: paymentStatusOf(row.status),
			currency: row.currency,
			total_amount: row.total_amount,
			outstanding: outstandingOf(row),
			tracking_url: row.tracking_url,
			created: row.created,
		})),
		total: Number(total.count),
		limit,
		offset,
	});
});

Server.app.get("/api/v1/customer/export", CustomerAuth.required(), documentLimit, async (ctx) => {
	const email = CustomerAuth.email(ctx);
	const [account] = await Database`SELECT created, accessed FROM customer_accounts WHERE email = ${email}`;
	const orders = await customerOrders(email, 10_000, 0);
	const invoices = (await Database`
		SELECT i.reference, i.status, i.currency, i.total_amount, i.issued_at, i.due_date, i.buyer_details, p.name AS project_name, p.display_name AS merchant
		FROM invoices i JOIN projects p ON p.uuid = i.project
		WHERE i.buyer_email = ${email} AND i.status != 'draft' AND i.issued_at IS NOT NULL AND p.status != 'deleted'
		ORDER BY i.created DESC
	`) as (Pick<InvoiceRow, "reference" | "status" | "currency" | "total_amount" | "issued_at" | "due_date" | "buyer_details"> & {
		project_name: string;
		merchant: string | null;
	})[];

	const exported = {
		exported_at: new Date().toISOString(),
		account: {
			email,
			created: account ? new Date(Number(account.created)).toISOString() : null,
			last_sign_in: account ? new Date(Number(account.accessed)).toISOString() : null,
		},
		profile: await profileOf(email),
		orders: orders.map((row) => ({
			reference: row.reference,
			store: storeName(row),
			fulfillment: row.fulfillment,
			payment_status: row.status,
			currency: row.currency,
			total_amount: row.total_amount,
			shipping_method: row.shipping_method,
			shipping_address: row.shipping_address ? JSON.parse(row.shipping_address) : null,
			note: row.note,
			created: new Date(row.created).toISOString(),
		})),
		invoices: invoices.map((row) => ({
			reference: row.reference,
			merchant: displayNameOf({ name: row.project_name, display_name: row.merchant }),
			status: row.status,
			currency: row.currency,
			total_amount: row.total_amount,
			issued: row.issued_at ? new Date(row.issued_at).toISOString() : null,
			buyer: row.buyer_details ? JSON.parse(row.buyer_details) : null,
		})),
	};

	return new Response(JSON.stringify(exported, null, 2), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Disposition": 'attachment; filename="my-data.json"',
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
});

Server.app.delete("/api/v1/customer/account", CustomerAuth.required(), async (ctx) => {
	const email = CustomerAuth.email(ctx);
	await Database.begin(async (tx) => {
		await tx`DELETE FROM customer_profiles WHERE email = ${email}`;
		await tx`DELETE FROM customer_login_links WHERE email = ${email}`;
		await tx`DELETE FROM customer_accounts WHERE email = ${email}`;
	});
	await CustomerAuth.destroySession(ctx.get("customerSessionToken")!);
	return Utils.ok(ctx);
});
