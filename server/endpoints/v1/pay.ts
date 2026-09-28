import { Server } from "../../server";
import Database from "../../database/database";
import ApiKey from "../../apikey";
import Audit from "../../audit";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { createInvoice, loadInvoice, loadItems, present, validateInvoiceInput, type InvoiceInput } from "../../invoice-service";
import { assignAddress, isEnabled as bitcoinEnabled, paymentUri, requiredConfirmations } from "../../payments/bitcoin";
import {
	assignAddress as assignEthereumAddress,
	chainId,
	isEnabled as ethereumEnabled,
	paymentUri as ethereumUri,
	requiredConfirmations as ethereumConfirmations,
	WEI_PER_GWEI,
} from "../../payments/ethereum";
import {
	assignAddress as assignMoneroAddress,
	isEnabled as moneroEnabled,
	paymentUri as moneroUri,
	requiredConfirmations as moneroConfirmations,
} from "../../payments/monero";
import { createPaypalOrder, createStripeCheckout, paypalEnabled, stripeEnabled } from "../../payments/checkout";
import { paypalClient, stripeClient } from "../../crypto/chains";
import { configFor, isEnabledFor } from "../../payments/methods";
import { rateFor } from "../../rates/forex";
import { enqueueLater } from "../../webhooks/events";
import { outstandingOf } from "../../invoicing";
import { hasCapacity, hasStorageCapacity } from "../../licensing";
import { OutOfStock } from "../../item-keys";
import type { CustomerRow, InvoiceRow } from "../../database/models";
import { accountingPeriodLocked } from "../../accounting-periods";
import { InvoiceDataIncomplete, invoiceDataErrorResponse } from "../../invoice-validation";
import { isCustomerType, normalizeVatNumber } from "../../tax";

const PAYABLE_STATUSES = ["open", "overdue", "partially_paid"];

async function resolveRate(supplied: number | undefined, currency: string, processor: string): Promise<number | null> {
	if (supplied !== undefined) {
		return typeof supplied === "number" && Number.isFinite(supplied) && supplied > 0 ? supplied : null;
	}

	return await rateFor(currency, processor);
}

interface CustomerBody {
	email?: string;
	name?: string | null;
	phone?: string | null;
	address_line1?: string | null;
	address_line2?: string | null;
	city?: string | null;
	state?: string | null;
	postal_code?: string | null;
	country?: string | null;
	vat_number?: string | null;
	tax_number?: string | null;
	customer_type?: string | null;
	metadata?: Record<string, unknown> | null;
}

function presentCustomer(customer: CustomerRow) {
	return {
		uuid: customer.uuid,
		email: customer.email,
		name: customer.name,
		phone: customer.phone,
		address_line1: customer.address_line1,
		address_line2: customer.address_line2,
		city: customer.city,
		state: customer.state,
		postal_code: customer.postal_code,
		country: customer.country,
		vat_number: customer.vat_number,
		tax_number: customer.tax_number,
		customer_type: customer.customer_type,
		metadata: customer.metadata === null ? null : JSON.parse(customer.metadata),
		created: customer.created,
	};
}

Server.app.get("/api/v1/pay/me", ApiKey.required(), async (ctx) => {
	const project = ApiKey.project(ctx);

	return Utils.ok(ctx, {
		project: project.uuid,
		name: project.name,
		key_slot: ctx.get("apiKeySlot"),
	});
});

Server.app.post("/api/v1/pay/customers", ApiKey.required(), async (ctx) => {
	const project = ApiKey.project(ctx);

	let data: CustomerBody;
	try {
		data = await ctx.body<CustomerBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (!Validate.email(data.email)) return Utils.fail(ctx, ErrorCode.INVALID_EMAIL);
	for (const value of [
		data.name,
		data.phone,
		data.address_line1,
		data.address_line2,
		data.city,
		data.state,
		data.postal_code,
		data.vat_number,
		data.tax_number,
	]) {
		if (!Validate.optionalText(value)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}
	if (data.country !== undefined && data.country !== null && !Validate.country(data.country)) return Utils.fail(ctx, ErrorCode.INVALID_COUNTRY_CODE);
	if (data.customer_type !== undefined && data.customer_type !== null && !isCustomerType(data.customer_type)) {
		return Utils.fail(ctx, ErrorCode.INVALID_CUSTOMER_TYPE);
	}

	const email = data.email!;

	const [existing] = (await Database`SELECT * FROM customers WHERE project = ${project.uuid} AND email = ${email}`) as CustomerRow[];
	if (existing) return Utils.ok(ctx, presentCustomer(existing));

	const uuid = crypto.randomUUID();
	const timestamp = Date.now();

	await Database`
		INSERT INTO customers(uuid, project, name, email, phone, address_line1, address_line2, city, state, postal_code, country, vat_number,
			tax_number, metadata, customer_type, created, updated)
		VALUES(${uuid}, ${project.uuid}, ${data.name ?? null}, ${email}, ${data.phone ?? null}, ${data.address_line1 ?? null},
			${data.address_line2 ?? null}, ${data.city ?? null}, ${data.state ?? null}, ${data.postal_code ?? null}, ${data.country ?? null},
			${normalizeVatNumber(data.vat_number, data.country)}, ${data.tax_number?.trim() || null}, ${data.metadata ? JSON.stringify(data.metadata) : null}, ${data.customer_type ?? null}, ${timestamp}, ${timestamp})
	`;

	await Audit.record(ctx, {
		project: project.uuid,
		action: "customer.created",
		entityType: "customer",
		entityId: uuid,
		newValue: { email, via: "api_key" },
	});

	const [created] = (await Database`SELECT * FROM customers WHERE uuid = ${uuid}`) as CustomerRow[];
	return Utils.ok(ctx, presentCustomer(created), 201);
});

Server.app.post("/api/v1/pay/invoices", ApiKey.required(), async (ctx) => {
	const project = ApiKey.project(ctx);

	let data: InvoiceInput;
	try {
		data = await ctx.body<InvoiceInput>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const status = data.status === "draft" ? "draft" : "open";

	const invalid = await validateInvoiceInput(project.uuid, { ...data, status });
	if (invalid !== null) return Utils.fail(ctx, invalid);
	if (status === "open" && !(await hasCapacity(project.uuid))) return Utils.fail(ctx, ErrorCode.TRANSACTION_LIMIT_REACHED);
	if (status === "open" && !(await hasStorageCapacity(project.uuid))) return Utils.fail(ctx, ErrorCode.STORAGE_LIMIT_REACHED);
	if (status === "open" && (await accountingPeriodLocked(project.uuid, Date.now()))) return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);

	let invoice: InvoiceRow;
	try {
		invoice = await createInvoice(project.uuid, { ...data, status, source: "invoice", created_by: null, recurring: null });
	} catch (err) {
		if (err instanceof OutOfStock) return Utils.fail(ctx, ErrorCode.OUT_OF_STOCK);
		if (err instanceof InvoiceDataIncomplete) return invoiceDataErrorResponse(ctx, err);
		throw err;
	}

	await Audit.record(ctx, {
		project: project.uuid,
		action: "invoice.created",
		entityType: "invoice",
		entityId: invoice.uuid,
		newValue: { reference: invoice.reference, status: invoice.status, total_amount: invoice.total_amount, via: "api_key" },
	});
	Logger.audit(`[PAY] Invoice ${invoice.reference} created through an API key on ${project.uuid}`);

	if (invoice.status === "open") {
		enqueueLater(project.uuid, "invoice.issued", {
			invoice: invoice.uuid,
			reference: invoice.reference,
			status: invoice.status,
			currency: invoice.currency,
			total_amount: invoice.total_amount,
			due_date: invoice.due_date,
		});
	}

	return Utils.ok(ctx, present(invoice, await loadItems(invoice.uuid)), 201);
});

Server.app.get("/api/v1/pay/invoices", ApiKey.required(), async (ctx) => {
	const project = ApiKey.project(ctx);
	const query = ctx.query();

	const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);
	const status = query.get("status");

	const invoices = (
		status !== null
			? await Database`
					SELECT * FROM invoices WHERE project = ${project.uuid} AND status = ${status}
					ORDER BY created DESC LIMIT ${limit} OFFSET ${offset}
				`
			: await Database`
					SELECT * FROM invoices WHERE project = ${project.uuid}
					ORDER BY created DESC LIMIT ${limit} OFFSET ${offset}
				`
	) as InvoiceRow[];

	return Utils.ok(ctx, {
		invoices: invoices.map((invoice) => ({ ...invoice, metadata: invoice.metadata === null ? null : JSON.parse(invoice.metadata) })),
		limit,
		offset,
	});
});

Server.app.post("/api/v1/pay/invoices/:invoice/bitcoin", ApiKey.required(), async (ctx) => {
	const project = ApiKey.project(ctx);

	if (!bitcoinEnabled() || !(await isEnabledFor(project.uuid, "bitcoin"))) return Utils.fail(ctx, ErrorCode.PROCESSOR_DISABLED);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
	if (!PAYABLE_STATUSES.includes(invoice.status)) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_PAYABLE);

	let data: { exchange_rate?: number };
	try {
		data = await ctx.body<{ exchange_rate?: number }>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const rate = await resolveRate(data.exchange_rate, invoice.currency, "bitcoin");
	if (rate === null) return Utils.fail(ctx, ErrorCode.INVALID_EXCHANGE_RATE);

	let assigned;
	try {
		assigned = await assignAddress(project, invoice, rate);
	} catch (err) {
		Logger.error(`[PAY] Could not assign a Bitcoin address for ${invoice.reference}: ${err}`);
		return Utils.fail(ctx, ErrorCode.UNKNOWN_ERROR);
	}

	return Utils.ok(
		ctx,
		{
			address: assigned.address,
			currency: "bitcoin",
			amount_satoshis: assigned.expected_amount,
			exchange_rate: assigned.exchange_rate,
			invoice_currency: assigned.invoice_currency,
			uri: paymentUri(assigned.address, assigned.expected_amount ?? 0, invoice.reference),
			confirmations_required: requiredConfirmations(),
			expires_at: assigned.expires_at,
		},
		201
	);
});

Server.app.post("/api/v1/pay/invoices/:invoice/ethereum", ApiKey.required(), async (ctx) => {
	const project = ApiKey.project(ctx);

	if (!ethereumEnabled() || !(await isEnabledFor(project.uuid, "ethereum"))) return Utils.fail(ctx, ErrorCode.PROCESSOR_DISABLED);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
	if (!PAYABLE_STATUSES.includes(invoice.status)) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_PAYABLE);

	let data: { exchange_rate?: number };
	try {
		data = await ctx.body<{ exchange_rate?: number }>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const rate = await resolveRate(data.exchange_rate, invoice.currency, "ethereum");
	if (rate === null) return Utils.fail(ctx, ErrorCode.INVALID_EXCHANGE_RATE);

	let assigned;
	try {
		assigned = await assignEthereumAddress(project, invoice, rate);
	} catch (err) {
		Logger.error(`[PAY] Could not assign an Ethereum address for ${invoice.reference}: ${err}`);
		return Utils.fail(ctx, ErrorCode.UNKNOWN_ERROR);
	}

	const wei = BigInt(assigned.expected_amount ?? 0) * WEI_PER_GWEI;

	return Utils.ok(
		ctx,
		{
			address: assigned.address,
			currency: "ethereum",
			chain_id: chainId(),
			amount_wei: wei.toString(),
			amount_gwei: assigned.expected_amount,
			exchange_rate: assigned.exchange_rate,
			invoice_currency: assigned.invoice_currency,
			uri: ethereumUri(assigned.address, wei),
			confirmations_required: ethereumConfirmations(),
			expires_at: assigned.expires_at,
		},
		201
	);
});

Server.app.post("/api/v1/pay/invoices/:invoice/monero", ApiKey.required(), async (ctx) => {
	const project = ApiKey.project(ctx);

	if (!moneroEnabled() || !(await isEnabledFor(project.uuid, "monero"))) return Utils.fail(ctx, ErrorCode.PROCESSOR_DISABLED);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
	if (!PAYABLE_STATUSES.includes(invoice.status)) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_PAYABLE);

	let data: { exchange_rate?: number };
	try {
		data = await ctx.body<{ exchange_rate?: number }>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const rate = await resolveRate(data.exchange_rate, invoice.currency, "monero");
	if (rate === null) return Utils.fail(ctx, ErrorCode.INVALID_EXCHANGE_RATE);

	let assigned;
	try {
		assigned = await assignMoneroAddress(project, invoice, rate);
	} catch (err) {
		Logger.error(`[PAY] Could not assign a Monero address for ${invoice.reference}: ${err}`);
		return Utils.fail(ctx, ErrorCode.UNKNOWN_ERROR);
	}

	const piconero = BigInt(assigned.expected_amount ?? 0);

	return Utils.ok(
		ctx,
		{
			address: assigned.address,
			currency: "monero",
			amount_piconero: piconero.toString(),
			exchange_rate: assigned.exchange_rate,
			invoice_currency: assigned.invoice_currency,
			uri: moneroUri(assigned.address, piconero, invoice.reference),
			confirmations_required: moneroConfirmations(),
			expires_at: assigned.expires_at,
		},
		201
	);
});

for (const processor of ["stripe", "paypal"] as const) {
	Server.app.post(`/api/v1/pay/invoices/:invoice/${processor}`, ApiKey.required(), async (ctx) => {
		const project = ApiKey.project(ctx);

		const serverEnabled = processor === "stripe" ? stripeEnabled() : paypalEnabled();
		if (!serverEnabled || !(await isEnabledFor(project.uuid, processor))) return Utils.fail(ctx, ErrorCode.PROCESSOR_DISABLED);

		const invoiceId = ctx.params["invoice"];
		if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

		const invoice = await loadInvoice(project.uuid, invoiceId);
		if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
		if (!PAYABLE_STATUSES.includes(invoice.status)) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_PAYABLE);

		let hosted;
		try {
			const credentials = await configFor(project.uuid, processor);
			hosted =
				processor === "stripe"
					? await createStripeCheckout(stripeClient(credentials), project, invoice)
					: await createPaypalOrder(paypalClient(credentials), project, invoice);
		} catch (err) {
			Logger.error(`[PAY] Could not open a ${processor} checkout for ${invoice.reference}: ${err}`);
			return Utils.fail(ctx, ErrorCode.PROCESSOR_UNAVAILABLE);
		}

		return Utils.ok(
			ctx,
			{
				processor,
				checkout_id: hosted.session.processor_session_id,
				checkout_url: hosted.checkoutUrl,
				amount: hosted.session.amount,
				currency: hosted.session.currency,
				expires_at: hosted.session.expires_at,
			},
			201
		);
	});
}

Server.app.get("/api/v1/pay/invoices/:invoice", ApiKey.required(), async (ctx) => {
	const project = ApiKey.project(ctx);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);

	const outstanding = outstandingOf(invoice);

	return Utils.ok(ctx, { ...present(invoice, await loadItems(invoiceId)), outstanding });
});
