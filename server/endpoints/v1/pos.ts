import type { Context } from "@rabbit-company/web";
import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { Permission } from "../../roles";
import { calculateTotals, isCancelable, outstandingOf } from "../../invoicing";
import { createInvoice, loadItems, present } from "../../invoice-service";
import { cancelInvoice } from "../../invoice-cancel";
import { invoiceDocument } from "../../invoice-document";
import { invoicePdf, pdfResponse } from "../../invoice-pdf";
import { customerEmailRefusal, emailCount, findEmail, queueReceiptEmail } from "../../email/messages";
import { PAYABLE_STATUSES, recordPayment } from "../../payments/recorded";
import { fiscalBlocked } from "../../fiscal/config";
import { submitNow } from "../../fiscal/documents";
import { REFUND_TYPES, SETTLED_PAYMENT_STATUSES, SETTLED_REFUND_STATUSES } from "../../payments/ledger";
import { currencyRates } from "../../rates/forex";
import { enqueueLater } from "../../webhooks/events";
import { t } from "../../i18n";
import { hasCapacity, hasStorageCapacity } from "../../licensing";
import { cashNote, endOfDay, isSaleLines, priceSale, startOfDay, summarizeSales, type CashMovement, type SaleLineInput } from "../../pos-sale";
import { OutOfStock, stockShortage } from "../../item-keys";
import { groupKeys, heldKeysOf } from "../../key-delivery";
import type { AppState, CatalogItemRow, InvoiceRow, ProjectMemberRow } from "../../database/models";
import { accountingPeriodLocked } from "../../accounting-periods";
import { InvoiceDataIncomplete, invoiceDataErrorResponse } from "../../invoice-validation";

interface CreateSaleBody {
	currency?: string;
	lines?: SaleLineInput[];
}

interface CashBody {
	amount?: number;
	tendered?: number | null;
}

interface CancelBody {
	reason?: string | null;
}

interface ReceiptEmailBody {
	to?: string;
	attach_invoice?: boolean;
}

const MAX_RECEIPT_EMAILS = 5;

function seesEverySale(member: ProjectMemberRow): boolean {
	return Permissions.has(member, Permission.INVOICE_VIEW);
}

async function findSale(ctx: Context<AppState>): Promise<InvoiceRow | ErrorCode> {
	const project = Permissions.project(ctx);
	const member = Permissions.member(ctx);
	const account = Auth.account(ctx);

	const saleId = ctx.params["sale"];
	if (!Validate.uuid(saleId)) return ErrorCode.INVALID_INVOICE_ID;

	const [sale] = (await Database`
		SELECT * FROM invoices WHERE uuid = ${saleId} AND project = ${project.uuid} AND source = 'pos'
	`) as InvoiceRow[];

	if (!sale) return ErrorCode.SALE_NOT_FOUND;
	if (sale.created_by !== account.username && !seesEverySale(member)) return ErrorCode.SALE_NOT_FOUND;
	return sale;
}

async function presentSale(sale: InvoiceRow) {
	const [fresh] = (await Database`SELECT * FROM invoices WHERE uuid = ${sale.uuid}`) as InvoiceRow[];
	return present(fresh, await loadItems(sale.uuid));
}

async function readBody<T extends object>(ctx: Context<AppState>, fallback: T | null): Promise<T | null> {
	try {
		const body = await ctx.body<T>();
		return typeof body === "object" && body !== null ? body : fallback;
	} catch {
		return fallback;
	}
}

Server.app.get("/api/v1/projects/:uuid/pos/sales", Auth.required(), Permissions.require(Permission.POS_SELL), async (ctx) => {
	const project = Permissions.project(ctx);
	const member = Permissions.member(ctx);
	const account = Auth.account(ctx);
	const query = ctx.query();

	const now = Date.now();
	const from = query.get("from") === null ? startOfDay(now) : Number(query.get("from"));
	const to = query.get("to") === null ? endOfDay(now) : Number(query.get("to"));
	if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) return Utils.fail(ctx, ErrorCode.INVALID_REPORT_PERIOD);

	const limit = Math.min(Math.max(Number(query.get("limit")) || 200, 1), 200);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);
	const everyone = query.get("scope") === "all" && seesEverySale(member);
	const sellerFilter = everyone ? Database`` : Database`AND created_by = ${account.username}`;

	const sales = (await Database`
		SELECT * FROM invoices
		WHERE project = ${project.uuid} AND source = 'pos' AND created >= ${from} AND created <= ${to} ${sellerFilter}
		ORDER BY created DESC, uuid ASC LIMIT ${limit} OFFSET ${offset}
	`) as InvoiceRow[];

	const facts = (await Database`SELECT status, currency, total_amount, credited_amount, paid_amount, refunded_amount
		FROM invoices WHERE project = ${project.uuid} AND source = 'pos' AND created >= ${from} AND created <= ${to} ${sellerFilter}`) as InvoiceRow[];
	const cash = (await Database`SELECT currency, type, amount FROM transactions
		WHERE invoice IN (SELECT uuid FROM invoices WHERE project = ${project.uuid} AND source = 'pos'
			AND created >= ${from} AND created <= ${to} ${sellerFilter}) AND processor = 'cash' AND (
			(type = 'payment' AND status IN ${Database(SETTLED_PAYMENT_STATUSES)})
			OR (type IN ${Database(REFUND_TYPES)} AND status IN ${Database(SETTLED_REFUND_STATUSES)})
		)`) as CashMovement[];

	return Utils.ok(ctx, {
		sales: sales.map((sale) => ({ ...sale, metadata: sale.metadata === null ? null : JSON.parse(sale.metadata) })),
		summary: summarizeSales(facts, cash),
		total: facts.length,
		limit,
		offset,
		scope: everyone ? "all" : "mine",
		from,
		to,
	});
});

Server.app.post("/api/v1/projects/:uuid/pos/sales", Auth.required(), Permissions.require(Permission.POS_SELL), async (ctx) => {
	const project = Permissions.project(ctx);
	const member = Permissions.member(ctx);
	const account = Auth.account(ctx);

	const data = await readBody<CreateSaleBody>(ctx, null);
	if (data === null) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	const currency = data.currency ?? project.currency;
	if (!Validate.currency(currency)) return Utils.fail(ctx, ErrorCode.INVALID_CURRENCY);
	if (!isSaleLines(data.lines)) return Utils.fail(ctx, ErrorCode.INVALID_SALE);

	const itemIds = [...new Set(data.lines.map((line) => line.item).filter((item): item is string => typeof item === "string"))];
	const catalogRows =
		itemIds.length === 0
			? []
			: ((await Database`SELECT * FROM catalog_items WHERE project = ${project.uuid} AND uuid IN ${Database(itemIds)}`) as CatalogItemRow[]);
	const catalog = new Map(catalogRows.map((item) => [item.uuid, item]));

	const needsRates = catalogRows.some((item) => item.currency !== currency);
	const known = needsRates ? await currencyRates() : null;

	const priced = priceSale(project, data.lines, {
		currency,
		catalog,
		rates: known?.live ? known.rates : null,
		allowCustomAmounts: Boolean(project.pos_custom_amounts) || Permissions.has(member, Permission.INVOICE_CREATE),
	});
	if (!Array.isArray(priced)) return Utils.fail(ctx, priced);
	if (calculateTotals(priced, 0).total_amount <= 0) return Utils.fail(ctx, ErrorCode.INVALID_SALE);
	if (!(await hasCapacity(project.uuid))) return Utils.fail(ctx, ErrorCode.TRANSACTION_LIMIT_REACHED);
	if (!(await hasStorageCapacity(project.uuid))) return Utils.fail(ctx, ErrorCode.STORAGE_LIMIT_REACHED);
	if (await accountingPeriodLocked(project.uuid, Date.now())) return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);

	const short = await stockShortage(project.uuid, priced);
	if (short !== null) return Utils.fail(ctx, short);

	const now = Date.now();

	let sale: InvoiceRow;
	try {
		sale = await createInvoice(project.uuid, {
			customer: null,
			currency,
			items: priced,
			due_date: endOfDay(now),
			supply_date: now,
			notes: null,
			status: "open",
			source: "pos",
			created_by: account.username,
		});
	} catch (err) {
		if (err instanceof OutOfStock) return Utils.fail(ctx, ErrorCode.OUT_OF_STOCK);
		if (err instanceof InvoiceDataIncomplete) return invoiceDataErrorResponse(ctx, err);
		throw err;
	}

	await Audit.record(ctx, {
		project: project.uuid,
		action: "pos.sale_created",
		entityType: "invoice",
		entityId: sale.uuid,
		newValue: {
			reference: sale.reference,
			total_amount: sale.total_amount,
			currency: sale.currency,
			custom_lines: priced.filter((line) => line.item === null).length,
		},
	});
	Logger.audit(`[POS] ${account.username} sold ${sale.reference} on ${project.uuid}`);

	enqueueLater(project.uuid, "invoice.issued", {
		invoice: sale.uuid,
		reference: sale.reference,
		status: sale.status,
		currency: sale.currency,
		total_amount: sale.total_amount,
		due_date: sale.due_date,
	});

	return Utils.ok(ctx, await presentSale(sale), 201);
});

Server.app.get("/api/v1/projects/:uuid/pos/sales/:sale", Auth.required(), Permissions.require(Permission.POS_SELL), async (ctx) => {
	const sale = await findSale(ctx);
	if (typeof sale === "number") return Utils.fail(ctx, sale);
	return Utils.ok(ctx, await presentSale(sale));
});

Server.app.get("/api/v1/projects/:uuid/pos/sales/:sale/document", Auth.required(), Permissions.require(Permission.POS_SELL), async (ctx) => {
	const sale = await findSale(ctx);
	if (typeof sale === "number") return Utils.fail(ctx, sale);
	return Utils.ok(ctx, await invoiceDocument(Permissions.project(ctx), sale));
});

Server.app.get("/api/v1/projects/:uuid/pos/sales/:sale/pdf", Auth.required(), Permissions.require(Permission.POS_SELL), async (ctx) => {
	const sale = await findSale(ctx);
	if (typeof sale === "number") return Utils.fail(ctx, sale);
	return pdfResponse(await invoicePdf(Permissions.project(ctx), sale, { payLink: false }));
});

Server.app.post("/api/v1/projects/:uuid/pos/sales/:sale/email", Auth.required(), Permissions.require(Permission.POS_SELL), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	const refusal = await customerEmailRefusal(project);
	if (refusal !== null) return Utils.fail(ctx, refusal);

	const sale = await findSale(ctx);
	if (typeof sale === "number") return Utils.fail(ctx, sale);
	if (sale.status === "canceled") return Utils.fail(ctx, ErrorCode.INVOICE_ALREADY_CANCELED);

	const data = (await readBody<ReceiptEmailBody>(ctx, {}))!;
	const recipient = typeof data.to === "string" ? data.to.trim() : "";
	if (!recipient) return Utils.fail(ctx, ErrorCode.EMAIL_RECIPIENT_MISSING);
	if (!Validate.email(recipient)) return Utils.fail(ctx, ErrorCode.INVALID_EMAIL);
	if (data.attach_invoice !== undefined && typeof data.attach_invoice !== "boolean") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if ((await emailCount(sale.uuid, ["receipt"])) >= MAX_RECEIPT_EMAILS) return Utils.fail(ctx, ErrorCode.EMAIL_LIMIT_REACHED);

	const keys = await heldKeysOf(sale.uuid, "delivered");
	const uuid = await queueReceiptEmail(project, sale, recipient, account.username, groupKeys(keys), { attachDocument: data.attach_invoice });

	if (keys.length > 0) {
		await Database`UPDATE item_keys SET recipient = ${recipient} WHERE invoice = ${sale.uuid} AND status = 'delivered' AND recipient IS NULL`;
	}

	await Audit.record(ctx, {
		project: project.uuid,
		action: "pos.receipt_emailed",
		entityType: "invoice",
		entityId: sale.uuid,
		newValue: { reference: sale.reference, recipient },
	});
	Logger.audit(`[POS] ${account.username} emailed the receipt for ${sale.reference}`);

	return Utils.ok(ctx, await findEmail(uuid), 201);
});

Server.app.post("/api/v1/projects/:uuid/pos/sales/:sale/cash", Auth.required(), Permissions.require(Permission.POS_SELL), async (ctx) => {
	const project = Permissions.project(ctx);
	const member = Permissions.member(ctx);
	const account = Auth.account(ctx);

	const sale = await findSale(ctx);
	if (typeof sale === "number") return Utils.fail(ctx, sale);
	if (sale.created_by !== account.username && !Permissions.has(member, Permission.PAYMENT_CREATE)) return Utils.fail(ctx, ErrorCode.SALE_LOCKED);
	if (!PAYABLE_STATUSES.includes(sale.status)) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_PAYABLE);

	const data = (await readBody<CashBody>(ctx, {}))!;

	const outstanding = outstandingOf(sale);
	const amount = data.amount ?? outstanding;
	if (!Validate.minorUnitAmount(amount) || amount === 0 || amount > outstanding) return Utils.fail(ctx, ErrorCode.INVALID_TRANSACTION_AMOUNT);

	const tendered = data.tendered ?? null;
	if (tendered !== null && (!Validate.minorUnitAmount(tendered) || tendered < amount)) return Utils.fail(ctx, ErrorCode.INVALID_TRANSACTION_AMOUNT);
	if (await fiscalBlocked(Database, project.uuid)) return Utils.fail(ctx, ErrorCode.FISCAL_NOT_CONFIGURED);

	const { uuid } = await recordPayment({
		invoice: sale,
		processor: "cash",
		amount,
		fee: 0,
		processorTxId: null,
		paymentMethod: "terminal",
		status: "completed",
		notes: cashNote(amount, tendered, sale.currency),
		recordedBy: account.username,
	});

	await Audit.record(ctx, {
		project: project.uuid,
		action: "pos.cash_recorded",
		entityType: "transaction",
		entityId: uuid,
		newValue: { sale: sale.reference, amount, tendered, currency: sale.currency },
	});
	Logger.audit(`[POS] ${account.username} took ${amount} ${sale.currency} in cash on ${sale.reference}`);
	await submitNow({ invoice: sale.uuid });

	return Utils.ok(ctx, await presentSale(sale));
});

Server.app.post("/api/v1/projects/:uuid/pos/sales/:sale/cancel", Auth.required(), Permissions.require(Permission.POS_SELL), async (ctx) => {
	const project = Permissions.project(ctx);
	const member = Permissions.member(ctx);
	const account = Auth.account(ctx);

	const sale = await findSale(ctx);
	if (typeof sale === "number") return Utils.fail(ctx, sale);
	if (sale.status === "canceled") return Utils.fail(ctx, ErrorCode.INVOICE_ALREADY_CANCELED);
	if (!isCancelable(sale.status)) return Utils.fail(ctx, ErrorCode.INVOICE_ALREADY_PAID);

	if (!Permissions.has(member, Permission.INVOICE_EDIT)) {
		const own = sale.created_by === account.username;
		const today = startOfDay(sale.created) === startOfDay(Date.now());
		const untouched = sale.paid_amount === 0;
		if (!own || !today || !untouched) return Utils.fail(ctx, ErrorCode.SALE_LOCKED);
	}

	const data = (await readBody<CancelBody>(ctx, {}))!;
	if (!Validate.optionalText(data.reason, 500)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (await accountingPeriodLocked(project.uuid, Date.now())) return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);

	if (sale.issued_at !== null && !(await hasStorageCapacity(project.uuid))) return Utils.fail(ctx, ErrorCode.STORAGE_LIMIT_REACHED);
	const creditNote = await cancelInvoice(project, sale, data.reason?.trim() || t(project.language, "credit.reason_cancel"), account.username);

	await Audit.record(ctx, {
		project: project.uuid,
		action: "pos.sale_canceled",
		entityType: "invoice",
		entityId: sale.uuid,
		oldValue: { status: sale.status },
		newValue: { status: "canceled", credit_note: creditNote?.reference ?? null },
	});
	Logger.audit(`[POS] ${account.username} canceled ${sale.reference} on ${project.uuid}`);

	return Utils.ok(ctx, await presentSale(sale));
});
