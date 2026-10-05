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
import { ProcessorType } from "../../payments/types";
import { acceptsPayment, recordPayment } from "../../payments/recorded";
import { issuePaidDraft } from "../../paid-drafts";
import { FISCAL_PROCESSORS, fiscalBlocked } from "../../fiscal/config";
import { fiscalDocumentFor } from "../../fiscal/documents";
import { applyBalance, balanceFor, refundableAmount, REFUND_TYPES, SETTLED_PAYMENT_STATUSES, SETTLED_REFUND_STATUSES } from "../../payments/ledger";
import { creditRemaining } from "../../credit-notes";
import { t } from "../../i18n";
import { enqueueLater } from "../../webhooks/events";
import type { InvoiceRow, TransactionRow } from "../../database/models";
import { accountingPeriodLocked, closedYear } from "../../accounting-periods";
import { prepareIssuePresentation } from "../../invoice-snapshot";
import { archiveIssuedCreditNote } from "../../credit-note-archive";
import { hasStorageCapacity } from "../../licensing";

interface RecordPaymentBody {
	invoice?: string;
	processor?: string;
	currency?: string;
	amount?: number;
	fee_amount?: number;
	processor_tx_id?: string | null;
	payment_method?: string | null;
	status?: "pending" | "confirmed" | "completed";
	notes?: string | null;
	paid_at?: number | null;
}

interface RefundBody {
	amount?: number;
	reason?: string | null;
	credit_note?: boolean;
}

const PROCESSORS = new Set<string>(Object.values(ProcessorType));
const TYPE_FILTERS = new Set(["payment", "refund"]);

type ListedTransaction = TransactionRow & { invoice_reference: string | null; customer_name: string | null; customer_email: string | null };

function present<Row extends TransactionRow>(transaction: Row) {
	return { ...transaction, payment_details: transaction.payment_details === null ? null : JSON.parse(transaction.payment_details) };
}

async function loadTransaction(projectId: string, transactionId: string): Promise<TransactionRow | undefined> {
	const [transaction] = (await Database`
		SELECT * FROM transactions WHERE uuid = ${transactionId} AND project = ${projectId}
	`) as TransactionRow[];
	return transaction;
}

Server.app.get("/api/v1/projects/:uuid/transactions", Auth.required(), Permissions.require(Permission.PAYMENT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();

	const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);
	const invoice = query.get("invoice");
	const status = query.get("status");
	const type = query.get("type");
	const processor = query.get("processor");
	const customer = query.get("customer");
	const search = query.get("search")?.trim() || null;

	if (invoice !== null && !Validate.uuid(invoice)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);
	if (customer !== null && !Validate.uuid(customer)) return Utils.fail(ctx, ErrorCode.INVALID_CUSTOMER_ID);
	if (type !== null && !TYPE_FILTERS.has(type)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (search !== null && !Validate.shortText(search, 64)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	const pattern = `%${(search ?? "").toLowerCase()}%`;
	const invoiceFilter = invoice === null ? Database`` : Database`AND t.invoice = ${invoice}`;
	const statusFilter = status === null ? Database`` : Database`AND t.status = ${status}`;
	const typeFilter = type === null ? Database`` : type === "payment" ? Database`AND t.type = 'payment'` : Database`AND t.type IN ${Database(REFUND_TYPES)}`;
	const processorFilter = processor === null ? Database`` : Database`AND t.processor = ${processor}`;
	const customerFilter = customer === null ? Database`` : Database`AND COALESCE(t.customer, i.customer) = ${customer}`;
	const searchFilter = search === null ? Database`` : Database`AND (LOWER(i.reference) LIKE ${pattern} OR LOWER(t.processor_tx_id) LIKE ${pattern})`;

	const transactions = (await Database`
		SELECT t.*, i.reference AS invoice_reference, c.name AS customer_name, c.email AS customer_email
		FROM transactions t
		LEFT JOIN invoices i ON i.uuid = t.invoice
		LEFT JOIN customers c ON c.uuid = COALESCE(t.customer, i.customer)
		WHERE t.project = ${project.uuid} ${invoiceFilter} ${statusFilter} ${typeFilter} ${processorFilter} ${customerFilter} ${searchFilter}
		ORDER BY t.created DESC, t.uuid ASC LIMIT ${limit} OFFSET ${offset}
	`) as ListedTransaction[];

	const [counted] = (await Database`
		SELECT COUNT(*) AS count FROM transactions t LEFT JOIN invoices i ON i.uuid = t.invoice
		WHERE t.project = ${project.uuid} ${invoiceFilter} ${statusFilter} ${typeFilter} ${processorFilter} ${customerFilter} ${searchFilter}
	`) as { count: number }[];

	const totals = (await Database`
		SELECT t.currency AS currency,
			COALESCE(SUM(CASE WHEN t.type = 'payment' AND t.status IN ${Database(SETTLED_PAYMENT_STATUSES)} THEN t.amount ELSE 0 END), 0) AS received,
			COALESCE(SUM(CASE WHEN t.type IN ${Database(REFUND_TYPES)} AND t.status IN ${Database(SETTLED_REFUND_STATUSES)} THEN t.amount ELSE 0 END), 0) AS refunded,
			COALESCE(SUM(CASE WHEN t.type = 'payment' AND t.status IN ${Database(SETTLED_PAYMENT_STATUSES)} THEN t.fee_amount ELSE 0 END), 0) AS fees
		FROM transactions t LEFT JOIN invoices i ON i.uuid = t.invoice
		WHERE t.project = ${project.uuid} ${invoiceFilter} ${statusFilter} ${typeFilter} ${processorFilter} ${customerFilter} ${searchFilter}
		GROUP BY t.currency ORDER BY t.currency
	`) as { currency: string; received: number; refunded: number; fees: number }[];

	return Utils.ok(ctx, {
		transactions: transactions.map(present),
		total: counted.count,
		totals: integerFields(totals, "received", "refunded", "fees"),
		limit,
		offset,
	});
});

Server.app.get("/api/v1/projects/:uuid/transactions/:transaction", Auth.required(), Permissions.require(Permission.PAYMENT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);

	const transactionId = ctx.params["transaction"];
	if (!Validate.uuid(transactionId)) return Utils.fail(ctx, ErrorCode.INVALID_TRANSACTION_ID);

	const transaction = await loadTransaction(project.uuid, transactionId);
	if (!transaction) return Utils.fail(ctx, ErrorCode.TRANSACTION_NOT_FOUND);

	const refunds = (await Database`
		SELECT * FROM transactions WHERE parent_transaction = ${transactionId} ORDER BY created ASC
	`) as TransactionRow[];

	return Utils.ok(ctx, {
		...present(transaction),
		refunds: refunds.map(present),
		refundable: transaction.type === "payment" ? await refundableAmount(Database, transactionId) : 0,
	});
});

Server.app.post("/api/v1/projects/:uuid/transactions", Auth.required(), Permissions.require(Permission.PAYMENT_CREATE), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	let data: RecordPaymentBody;
	try {
		data = await ctx.body<RecordPaymentBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (!Validate.uuid(data.invoice)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);
	if (typeof data.processor !== "string" || !PROCESSORS.has(data.processor)) return Utils.fail(ctx, ErrorCode.INVALID_PROCESSOR);
	if (!Validate.minorUnitAmount(data.amount) || data.amount === 0) return Utils.fail(ctx, ErrorCode.INVALID_TRANSACTION_AMOUNT);
	if (data.fee_amount !== undefined && !Validate.minorUnitAmount(data.fee_amount)) return Utils.fail(ctx, ErrorCode.INVALID_TRANSACTION_AMOUNT);
	if (!Validate.optionalText(data.processor_tx_id, 255)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (!Validate.optionalText(data.notes, 2000)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	const paidAt = data.paid_at ?? null;
	if (paidAt !== null && (!Number.isSafeInteger(paidAt) || paidAt <= 0 || paidAt > Date.now())) return Utils.fail(ctx, ErrorCode.INVALID_PAYMENT_DATE);

	const [invoice] = (await Database`
		SELECT * FROM invoices WHERE uuid = ${data.invoice!} AND project = ${project.uuid}
	`) as InvoiceRow[];
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
	if (!(await acceptsPayment(invoice))) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_PAYABLE);
	if (data.currency !== undefined && data.currency !== invoice.currency) return Utils.fail(ctx, ErrorCode.CURRENCY_MISMATCH);

	const status = data.status ?? "completed";
	if (!["pending", "confirmed", "completed"].includes(status)) return Utils.fail(ctx, ErrorCode.INVALID_TRANSACTION_STATUS);
	if (FISCAL_PROCESSORS.has(data.processor!) && (await fiscalBlocked(Database, project.uuid))) return Utils.fail(ctx, ErrorCode.FISCAL_NOT_CONFIGURED);

	const backdated = paidAt !== null && status !== "pending";
	if (backdated && (await closedYear(project.uuid, paidAt))) return Utils.fail(ctx, ErrorCode.YEAR_CLOSED);

	const { uuid, balance } = await recordPayment({
		invoice,
		processor: data.processor!,
		amount: data.amount!,
		fee: data.fee_amount ?? 0,
		processorTxId: data.processor_tx_id ?? null,
		paymentMethod: data.payment_method ?? null,
		status,
		notes: data.notes ?? null,
		recordedBy: account.username,
		...(backdated ? { settledAt: paidAt } : {}),
	});

	await Audit.record(ctx, {
		project: project.uuid,
		action: "payment.recorded",
		entityType: "transaction",
		entityId: uuid,
		newValue: {
			invoice: invoice.reference,
			amount: data.amount,
			currency: invoice.currency,
			processor: data.processor,
			status,
			...(backdated ? { paid_at: paidAt } : {}),
		},
	});
	Logger.audit(`[PAYMENTS] ${account.username} recorded ${data.amount} ${invoice.currency} on ${invoice.reference}`);
	if (invoice.status === "draft" && status !== "pending") {
		try {
			await issuePaidDraft(invoice.uuid);
		} catch (err) {
			Logger.error(`[PAYMENTS] ${invoice.reference} was paid but could not be issued yet, it is retried: ${err instanceof Error ? err.message : err}`);
		}
	}

	const transaction = await loadTransaction(project.uuid, uuid);
	return Utils.ok(ctx, { ...present(transaction!), invoice_balance: balance }, 201);
});

Server.app.post("/api/v1/projects/:uuid/transactions/:transaction/refund", Auth.required(), Permissions.require(Permission.PAYMENT_REFUND), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	const transactionId = ctx.params["transaction"];
	if (!Validate.uuid(transactionId)) return Utils.fail(ctx, ErrorCode.INVALID_TRANSACTION_ID);

	const payment = await loadTransaction(project.uuid, transactionId);
	if (!payment) return Utils.fail(ctx, ErrorCode.TRANSACTION_NOT_FOUND);
	const refundable = payment.type === "payment" && (payment.status === "completed" || payment.status === "partially_refunded");
	if (!refundable) return Utils.fail(ctx, ErrorCode.TRANSACTION_NOT_REFUNDABLE);

	let data: RefundBody;
	try {
		data = await ctx.body<RefundBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (!Validate.optionalText(data.reason, 500)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (data.credit_note !== undefined && typeof data.credit_note !== "boolean") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	const verified = payment.invoice ? (await fiscalDocumentFor({ invoice: payment.invoice })) !== null : false;
	const withCreditNote = Boolean(payment.invoice) && (verified || data.credit_note === true);
	if (withCreditNote && (await accountingPeriodLocked(project.uuid, Date.now()))) return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);
	if (withCreditNote && !(await hasStorageCapacity(project.uuid))) return Utils.fail(ctx, ErrorCode.STORAGE_LIMIT_REACHED);

	const available = await refundableAmount(Database, transactionId);
	const amount = data.amount ?? available;

	if (!Validate.minorUnitAmount(amount) || amount === 0) return Utils.fail(ctx, ErrorCode.INVALID_TRANSACTION_AMOUNT);
	if (amount > available) return Utils.fail(ctx, ErrorCode.REFUND_EXCEEDS_PAID);
	const presentation = withCreditNote ? await prepareIssuePresentation(project) : null;

	const uuid = crypto.randomUUID();
	const refundId = crypto.randomUUID();
	const timestamp = Date.now();
	const type = amount === payment.amount ? "refund" : "partial_refund";

	const outcome = await Database.begin(async (tx) => {
		await tx`
				INSERT INTO transactions(uuid, project, invoice, customer, processor, parent_transaction, status, type, currency, amount,
					fee_amount, net_amount, payment_details, completed_at, created, updated)
				VALUES(${uuid}, ${project.uuid}, ${payment.invoice}, ${payment.customer}, ${payment.processor}, ${payment.uuid}, 'completed', ${type},
					${payment.currency}, ${amount}, 0, ${amount}, ${JSON.stringify({ reason: data.reason ?? null, refunded_by: account.username })},
					${timestamp}, ${timestamp}, ${timestamp})
			`;

		await tx`
				INSERT INTO refunds(uuid, transaction_id, amount, currency, reason, status, initiated_by, created, completed_at)
				VALUES(${refundId}, ${payment.uuid}, ${amount}, ${payment.currency}, ${data.reason ?? null}, 'completed', ${account.username}, ${timestamp}, ${timestamp})
			`;

		const refundedSoFar = payment.amount - (await refundableAmount(tx, transactionId));
		await tx`
				UPDATE transactions SET status = ${refundedSoFar >= payment.amount ? "refunded" : "partially_refunded"}, updated = ${timestamp}
				WHERE uuid = ${payment.uuid}
			`;

		if (!payment.invoice) return { balance: null, creditNote: null };

		const balance = await applyBalance(tx, payment.invoice);
		if (!withCreditNote) return { balance, creditNote: null };

		const [invoice] = (await tx`SELECT * FROM invoices WHERE uuid = ${payment.invoice}`) as InvoiceRow[];
		if (invoice.issued_at === null) return { balance, creditNote: null };

		const creditNote = await creditRemaining(tx as typeof Database, invoice, {
			amount,
			reason: data.reason ?? t(project.language, "credit.reason_refund"),
			transactionId: uuid,
			createdBy: account.username,
			presentation: presentation!,
		});
		const [after] = (await tx`SELECT * FROM invoices WHERE uuid = ${payment.invoice}`) as InvoiceRow[];
		return { balance: creditNote ? await balanceFor(tx, after) : balance, creditNote };
	});
	if (outcome.creditNote) await archiveIssuedCreditNote(project.uuid, outcome.creditNote.uuid);

	await Audit.record(ctx, {
		project: project.uuid,
		action: "payment.refunded",
		entityType: "transaction",
		entityId: uuid,
		oldValue: { payment: payment.uuid, amount: payment.amount },
		newValue: { amount, currency: payment.currency, reason: data.reason ?? null },
	});
	Logger.audit(`[PAYMENTS] ${account.username} refunded ${amount} ${payment.currency} from ${payment.uuid}`);

	enqueueLater(project.uuid, "payment.refunded", {
		transaction: uuid,
		refunded_payment: payment.uuid,
		invoice: payment.invoice,
		amount,
		currency: payment.currency,
		reason: data.reason ?? null,
	});

	const refund = await loadTransaction(project.uuid, uuid);
	return Utils.ok(ctx, { ...present(refund!), invoice_balance: outcome.balance, credit_note: outcome.creditNote }, 201);
});
