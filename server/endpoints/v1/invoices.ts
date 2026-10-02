import { Server } from "../../server";
import Database from "../../database/database";
import { integerFields } from "../../database/numbers";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { Permission } from "../../roles";
import { calculateTotals, isCancelable, isEditable, type InvoiceItemInput } from "../../invoicing";
import { createInvoice, loadInvoice, loadItems, present, replaceItems, validateCatalogLinks, validateInvoiceInput, validateItems } from "../../invoice-service";
import { MANUAL_RATE_SOURCE, reportingCurrency, validTaxExchangeRate } from "../../tax-reporting";
import { InvoiceDataIncomplete, invoiceDataErrorResponse } from "../../invoice-validation";
import { OutOfStock, stockShortage } from "../../item-keys";
import { cancelInvoice } from "../../invoice-cancel";
import { t } from "../../i18n";
import { hasCapacity, hasStorageCapacity } from "../../licensing";
import type { CustomerRow, InvoiceRow } from "../../database/models";
import { accountingPeriodLocked } from "../../accounting-periods";
import { fiscalDocumentFor } from "../../fiscal/documents";
import { resolveReferenceDocument, type ReferenceDocumentInput } from "../../reference-document";
import { awaitsStorePayment, isProformaDraft } from "../../payments/recorded";
import { documentDetails, issueDraft } from "../../proformas";
import { applyBalance } from "../../payments/ledger";
import { enqueueLater } from "../../webhooks/events";

interface CreateInvoiceBody extends ReferenceDocumentInput {
	customer?: string | null;
	currency?: string;
	items?: InvoiceItemInput[];
	discount_amount?: number;
	due_date?: number;
	notes?: string | null;
	metadata?: Record<string, unknown> | null;
	status?: "draft" | "open";
	supply_date?: number | null;
	tax_exchange_rate?: number | null;
}

interface UpdateInvoiceBody extends ReferenceDocumentInput {
	customer?: string | null;
	currency?: string;
	items?: InvoiceItemInput[];
	discount_amount?: number;
	due_date?: number;
	supply_date?: number | null;
	tax_exchange_rate?: number | null;
	notes?: string | null;
	metadata?: Record<string, unknown> | null;
}

Server.app.get("/api/v1/projects/:uuid/invoices", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();

	const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);
	const status = query.get("status");
	const customer = query.get("customer");
	const reference = query.get("reference")?.trim() || null;
	const document = query.get("document");

	if (status !== null && !Validate.shortText(status, 32)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_STATUS);
	if (customer !== null && !Validate.uuid(customer)) return Utils.fail(ctx, ErrorCode.INVALID_CUSTOMER_ID);
	if (reference !== null && !Validate.shortText(reference, 64)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	const statusFilter = status === null ? Database`` : Database`AND i.status = ${status}`;
	const customerFilter = customer === null ? Database`` : Database`AND i.customer = ${customer}`;
	const referenceFilter = reference === null ? Database`` : Database`AND LOWER(i.reference) LIKE ${`%${reference.toLowerCase()}%`}`;
	const documentFilter =
		document === "proforma"
			? Database`AND i.status = 'draft' AND EXISTS (SELECT 1 FROM proformas p WHERE p.invoice = i.uuid)`
			: document === "order"
				? Database`AND i.status = 'draft' AND EXISTS (SELECT 1 FROM store_orders o WHERE o.invoice = i.uuid)`
				: document === "advance"
					? Database`AND i.document_type = 'advance'`
					: Database``;

	const invoices = (await Database`
		SELECT i.*, c.name AS customer_name, c.email AS customer_email,
			CASE
				WHEN i.status = 'draft' AND EXISTS (SELECT 1 FROM proformas p WHERE p.invoice = i.uuid) THEN 'proforma'
				WHEN i.status = 'draft' AND EXISTS (SELECT 1 FROM store_orders o WHERE o.invoice = i.uuid) THEN 'order'
				ELSE i.document_type
			END AS document
		FROM invoices i LEFT JOIN customers c ON c.uuid = i.customer
		WHERE i.project = ${project.uuid} ${statusFilter} ${customerFilter} ${referenceFilter} ${documentFilter}
		ORDER BY i.created DESC, i.uuid ASC LIMIT ${limit} OFFSET ${offset}
	`) as (InvoiceRow & { customer_name: string | null; customer_email: string | null })[];

	const [counted] = (await Database`
		SELECT COUNT(*) AS count FROM invoices i WHERE i.project = ${project.uuid} ${statusFilter} ${customerFilter} ${referenceFilter} ${documentFilter}
	`) as { count: number }[];

	const totals = (await Database`
		SELECT i.currency, COUNT(*) AS count, COALESCE(SUM(i.total_amount), 0) AS total_amount, COALESCE(SUM(i.paid_amount), 0) AS paid_amount,
			COALESCE(SUM(
				CASE WHEN i.status IN ('open', 'overdue', 'partially_paid') AND i.total_amount - i.credited_amount - i.paid_amount + i.refunded_amount > 0
				THEN i.total_amount - i.credited_amount - i.paid_amount + i.refunded_amount ELSE 0 END
			), 0) AS outstanding_amount
		FROM invoices i WHERE i.project = ${project.uuid} ${statusFilter} ${customerFilter} ${referenceFilter} ${documentFilter}
		GROUP BY i.currency ORDER BY i.currency
	`) as { currency: string; count: number; total_amount: number; paid_amount: number; outstanding_amount: number }[];

	return Utils.ok(ctx, {
		invoices: invoices.map((invoice) => ({ ...invoice, metadata: invoice.metadata === null ? null : JSON.parse(invoice.metadata) })),
		total: counted.count,
		totals: integerFields(totals, "total_amount", "paid_amount", "outstanding_amount"),
		limit,
		offset,
	});
});

Server.app.post("/api/v1/projects/:uuid/invoices", Auth.required(), Permissions.require(Permission.INVOICE_CREATE), async (ctx) => {
	const project = Permissions.project(ctx);

	let data: CreateInvoiceBody;
	try {
		data = await ctx.body<CreateInvoiceBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (data.status === "open" && !Permissions.has(Permissions.member(ctx), Permission.INVOICE_SEND)) {
		return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);
	}

	const invalid = await validateInvoiceInput(project.uuid, data);
	if (invalid !== null) return Utils.fail(ctx, invalid);
	if (data.status === "open" && !(await hasCapacity(project.uuid))) return Utils.fail(ctx, ErrorCode.TRANSACTION_LIMIT_REACHED);
	if (data.status === "open" && !(await hasStorageCapacity(project.uuid))) return Utils.fail(ctx, ErrorCode.STORAGE_LIMIT_REACHED);
	if (data.status === "open" && (await accountingPeriodLocked(project.uuid, Date.now()))) return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);

	let invoice: InvoiceRow;
	try {
		invoice = await createInvoice(project.uuid, { ...data, source: "invoice", created_by: Auth.account(ctx).username, recurring: null });
	} catch (err) {
		if (err instanceof OutOfStock) return Utils.fail(ctx, ErrorCode.OUT_OF_STOCK);
		if (err instanceof InvoiceDataIncomplete) return invoiceDataErrorResponse(ctx, err);
		throw err;
	}

	const issued = invoice.status === "open";
	if (issued) {
		await Database.begin(async (tx) => await applyBalance(tx, invoice.uuid));
		invoice = (await loadInvoice(project.uuid, invoice.uuid))!;
	}

	await Audit.record(ctx, {
		project: project.uuid,
		action: "invoice.created",
		entityType: "invoice",
		entityId: invoice.uuid,
		newValue: { reference: invoice.reference, status: invoice.status, total_amount: invoice.total_amount, currency: invoice.currency },
	});
	Logger.audit(`[INVOICES] Created ${invoice.reference} on ${project.uuid}`);

	if (issued) {
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

Server.app.get("/api/v1/projects/:uuid/invoices/:invoice", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);

	const fiscal = await fiscalDocumentFor({ invoice: invoiceId });
	return Utils.ok(ctx, { ...present(invoice, await loadItems(invoiceId)), ...(await documentDetails(invoice)), fiscal_status: fiscal?.status ?? null });
});

Server.app.patch("/api/v1/projects/:uuid/invoices/:invoice", Auth.required(), Permissions.require(Permission.INVOICE_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
	if (!isEditable(invoice.status) || (await awaitsStorePayment(invoice)) || invoice.document_type === "advance") {
		return Utils.fail(ctx, ErrorCode.INVOICE_NOT_EDITABLE);
	}
	if (invoice.paid_amount > 0 || invoice.advanced_amount > 0) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_EDITABLE);

	let data: UpdateInvoiceBody;
	try {
		data = await ctx.body<UpdateInvoiceBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (data.currency !== undefined && !Validate.currency(data.currency)) return Utils.fail(ctx, ErrorCode.INVALID_CURRENCY);
	if (data.items !== undefined && !validateItems(data.items)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ITEMS);
	if (data.items !== undefined) {
		const unlinked = await validateCatalogLinks(project.uuid, data.items);
		if (unlinked !== null) return Utils.fail(ctx, unlinked);
	}
	if (data.discount_amount !== undefined && !Validate.minorUnitAmount(data.discount_amount)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_AMOUNT);
	if (data.due_date !== undefined && (!Number.isSafeInteger(data.due_date) || data.due_date <= 0)) return Utils.fail(ctx, ErrorCode.INVALID_DUE_DATE);
	if (data.supply_date !== undefined && data.supply_date !== null && (!Number.isSafeInteger(data.supply_date) || data.supply_date <= 0)) {
		return Utils.fail(ctx, ErrorCode.INVALID_SUPPLY_DATE);
	}
	if (data.tax_exchange_rate !== undefined && data.tax_exchange_rate !== null && !validTaxExchangeRate(data.tax_exchange_rate)) {
		return Utils.fail(ctx, ErrorCode.INVALID_TAX_EXCHANGE_RATE);
	}
	if (!Validate.optionalText(data.notes, 5000)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	const referenceDocument = resolveReferenceDocument(data, invoice);
	if (referenceDocument === null) return Utils.fail(ctx, ErrorCode.INVALID_REFERENCE_DOCUMENT);

	if (data.customer !== undefined && data.customer !== null) {
		if (!Validate.uuid(data.customer)) return Utils.fail(ctx, ErrorCode.INVALID_CUSTOMER_ID);
		const [customer] = (await Database`
			SELECT uuid FROM customers WHERE uuid = ${data.customer} AND project = ${project.uuid}
		`) as CustomerRow[];
		if (!customer) return Utils.fail(ctx, ErrorCode.CUSTOMER_NOT_FOUND);
	}

	const existingItems = await loadItems(invoiceId);
	const items: InvoiceItemInput[] =
		data.items ??
		existingItems.map((item) => ({
			description: item.description,
			quantity: item.quantity,
			unit_price: item.unit_price,
			tax_rate: item.tax_rate,
			metadata: item.metadata === null ? null : JSON.parse(item.metadata),
			item: item.item,
			tax_treatment: item.tax_treatment,
			unit: item.unit,
		}));

	const totals = calculateTotals(items, data.discount_amount ?? invoice.discount_amount);

	const merged = {
		customer: data.customer === undefined ? invoice.customer : data.customer,
		currency: data.currency ?? invoice.currency,
		supply_date: data.supply_date === undefined ? invoice.supply_date : data.supply_date,
		due_date: data.due_date ?? invoice.due_date,
		notes: data.notes === undefined ? invoice.notes : data.notes,
		metadata: data.metadata === undefined ? invoice.metadata : data.metadata === null ? null : JSON.stringify(data.metadata),
	};
	const keptRate = invoice.tax_rate_source === MANUAL_RATE_SOURCE && merged.currency === invoice.currency ? invoice.tax_exchange_rate : null;
	const manualRate = data.tax_exchange_rate === undefined ? keptRate : data.tax_exchange_rate;

	await Database.begin(async (tx) => {
		await tx`
			UPDATE invoices SET
				customer = ${merged.customer}, currency = ${merged.currency}, supply_date = ${merged.supply_date}, subtotal = ${totals.subtotal},
				discount_amount = ${totals.discount_amount}, tax_amount = ${totals.tax_amount}, total_amount = ${totals.total_amount},
				notes = ${merged.notes}, metadata = ${merged.metadata}, due_date = ${merged.due_date},
				reference_document_type = ${referenceDocument.reference_document_type},
				reference_document_number = ${referenceDocument.reference_document_number},
				reference_document_date = ${referenceDocument.reference_document_date},
				tax_exchange_rate = ${manualRate}, tax_rate_source = ${manualRate === null ? null : MANUAL_RATE_SOURCE}, updated = ${Date.now()}
			WHERE uuid = ${invoiceId}
		`;

		await replaceItems(tx as typeof Database, invoiceId, totals.items);
	});

	await Audit.record(ctx, {
		project: project.uuid,
		action: "invoice.updated",
		entityType: "invoice",
		entityId: invoiceId,
		oldValue: { total_amount: invoice.total_amount, currency: invoice.currency },
		newValue: { total_amount: totals.total_amount, currency: merged.currency },
	});

	const updated = await loadInvoice(project.uuid, invoiceId);
	return Utils.ok(ctx, present(updated!, await loadItems(invoiceId)));
});

Server.app.put("/api/v1/projects/:uuid/invoices/:invoice/reference-document", Auth.required(), Permissions.require(Permission.INVOICE_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);

	let data: ReferenceDocumentInput;
	try {
		data = await ctx.body<ReferenceDocumentInput>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}
	if (typeof data !== "object" || data === null) return Utils.fail(ctx, ErrorCode.INVALID_REFERENCE_DOCUMENT);

	const referenceDocument = resolveReferenceDocument({
		reference_document_type: data.reference_document_type ?? null,
		reference_document_number: data.reference_document_number ?? null,
		reference_document_date: data.reference_document_date ?? null,
	});
	if (referenceDocument === null) return Utils.fail(ctx, ErrorCode.INVALID_REFERENCE_DOCUMENT);

	await Database`
		UPDATE invoices SET
			reference_document_type = ${referenceDocument.reference_document_type},
			reference_document_number = ${referenceDocument.reference_document_number},
			reference_document_date = ${referenceDocument.reference_document_date}, updated = ${Date.now()}
		WHERE uuid = ${invoiceId}
	`;

	await Audit.record(ctx, {
		project: project.uuid,
		action: "invoice.reference_document_set",
		entityType: "invoice",
		entityId: invoiceId,
		oldValue: {
			type: invoice.reference_document_type,
			number: invoice.reference_document_number,
			date: invoice.reference_document_date,
		},
		newValue: {
			type: referenceDocument.reference_document_type,
			number: referenceDocument.reference_document_number,
			date: referenceDocument.reference_document_date,
		},
	});

	const updated = await loadInvoice(project.uuid, invoiceId);
	return Utils.ok(ctx, present(updated!, await loadItems(invoiceId)));
});

Server.app.post("/api/v1/projects/:uuid/invoices/:invoice/open", Auth.required(), Permissions.require(Permission.INVOICE_SEND), async (ctx) => {
	const project = Permissions.project(ctx);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
	if (invoice.status === "canceled") return Utils.fail(ctx, ErrorCode.INVOICE_ALREADY_CANCELED);
	if (invoice.status === "paid") return Utils.fail(ctx, ErrorCode.INVOICE_ALREADY_PAID);
	if (invoice.status !== "draft") return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_STATUS);
	if (!(await hasCapacity(project.uuid))) return Utils.fail(ctx, ErrorCode.TRANSACTION_LIMIT_REACHED);
	if (!(await hasStorageCapacity(project.uuid))) return Utils.fail(ctx, ErrorCode.STORAGE_LIMIT_REACHED);
	if (await accountingPeriodLocked(project.uuid, Date.now())) return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);

	const items = await loadItems(invoiceId);
	const short = await stockShortage(project.uuid, items);
	if (short !== null) return Utils.fail(ctx, short);

	let reference: string | null;
	try {
		reference = await issueDraft(project, invoice, { issuedBy: Auth.account(ctx).username });
	} catch (err) {
		if (err instanceof InvoiceDataIncomplete) return invoiceDataErrorResponse(ctx, err);
		if (err instanceof OutOfStock) return Utils.fail(ctx, ErrorCode.OUT_OF_STOCK);
		throw err;
	}
	if (reference === null) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_STATUS);
	const issued = (await loadInvoice(project.uuid, invoiceId))!;

	await Audit.record(ctx, {
		project: project.uuid,
		action: "invoice.opened",
		entityType: "invoice",
		entityId: invoiceId,
		oldValue: { status: invoice.status, reference: invoice.reference },
		newValue: { status: issued.status, reference },
	});
	Logger.audit(`[INVOICES] Issued ${reference} on ${project.uuid}`);

	return Utils.ok(ctx, { ...present(issued, await loadItems(invoiceId)), ...(await documentDetails(issued)) });
});

Server.app.put("/api/v1/projects/:uuid/invoices/:invoice/tax-rate", Auth.required(), Permissions.require(Permission.INVOICE_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
	if (invoice.status === "draft") return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_STATUS);

	let data: { rate?: number; date?: number };
	try {
		data = await ctx.body<{ rate?: number; date?: number }>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const taxCurrency = invoice.tax_currency ?? reportingCurrency(project);
	const rateValid = validTaxExchangeRate(data.rate);
	const dateValid = data.date === undefined || (typeof data.date === "number" && Number.isSafeInteger(data.date) && data.date > 0);
	if (!rateValid || !dateValid || taxCurrency === invoice.currency) return Utils.fail(ctx, ErrorCode.INVALID_TAX_EXCHANGE_RATE);
	if (invoice.issued_at !== null && (await accountingPeriodLocked(project.uuid, invoice.issued_at))) return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);

	const rateDate = data.date ?? invoice.supply_date ?? invoice.issued_at ?? Date.now();

	await Database`
		UPDATE invoices SET tax_currency = ${taxCurrency}, tax_exchange_rate = ${data.rate!}, tax_rate_source = 'manual',
			tax_rate_date = ${rateDate}, updated = ${Date.now()}
		WHERE uuid = ${invoiceId}
	`;

	await Audit.record(ctx, {
		project: project.uuid,
		action: "invoice.tax_rate_set",
		entityType: "invoice",
		entityId: invoiceId,
		oldValue: { tax_currency: invoice.tax_currency, rate: invoice.tax_exchange_rate, source: invoice.tax_rate_source },
		newValue: { tax_currency: taxCurrency, rate: data.rate, source: "manual" },
	});

	const updated = await loadInvoice(project.uuid, invoiceId);
	return Utils.ok(ctx, present(updated!, await loadItems(invoiceId)));
});

Server.app.post("/api/v1/projects/:uuid/invoices/:invoice/cancel", Auth.required(), Permissions.require(Permission.INVOICE_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
	if (invoice.status === "canceled") return Utils.fail(ctx, ErrorCode.INVOICE_ALREADY_CANCELED);
	if (!isCancelable(invoice.status)) return Utils.fail(ctx, ErrorCode.INVOICE_ALREADY_PAID);
	if (invoice.status === "draft" && invoice.advanced_amount > 0) return Utils.fail(ctx, ErrorCode.PROFORMA_HAS_ADVANCES);

	let data: { reason?: string | null } = {};
	try {
		data = await ctx.body<{ reason?: string | null }>();
	} catch {
		data = {};
	}
	if (!Validate.optionalText(data?.reason, 500)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (await accountingPeriodLocked(project.uuid, Date.now())) return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);

	const account = Auth.account(ctx);
	if (invoice.issued_at !== null && !(await hasStorageCapacity(project.uuid))) return Utils.fail(ctx, ErrorCode.STORAGE_LIMIT_REACHED);
	const creditNote = await cancelInvoice(project, invoice, data?.reason?.trim() || t(project.language, "credit.reason_cancel"), account.username);

	await Audit.record(ctx, {
		project: project.uuid,
		action: "invoice.canceled",
		entityType: "invoice",
		entityId: invoiceId,
		oldValue: { status: invoice.status },
		newValue: { status: "canceled", credit_note: creditNote?.reference ?? null },
	});
	Logger.audit(`[INVOICES] Canceled ${invoice.reference} on ${project.uuid}`);

	const updated = await loadInvoice(project.uuid, invoiceId);
	return Utils.ok(ctx, present(updated!, await loadItems(invoiceId)));
});

Server.app.delete("/api/v1/projects/:uuid/invoices/:invoice", Auth.required(), Permissions.require(Permission.INVOICE_DELETE), async (ctx) => {
	const project = Permissions.project(ctx);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
	if (!isEditable(invoice.status) || (await awaitsStorePayment(invoice)) || (await isProformaDraft(invoice)) || invoice.paid_amount > 0) {
		return Utils.fail(ctx, ErrorCode.INVOICE_NOT_EDITABLE);
	}

	await Database`DELETE FROM invoices WHERE uuid = ${invoiceId}`;

	await Audit.record(ctx, {
		project: project.uuid,
		action: "invoice.deleted",
		entityType: "invoice",
		entityId: invoiceId,
		oldValue: { reference: invoice.reference, status: invoice.status },
	});

	return Utils.ok(ctx);
});
