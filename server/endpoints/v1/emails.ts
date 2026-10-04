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
import { loadInvoice } from "../../invoice-service";
import { canEmail, projectEmailServer } from "../../email/mailer";
import { emailUsageFor } from "../../licensing";
import { customerEmailRefusal, emailCount, findEmail, presentEmail, queueInvitationEmail, queueInvoiceEmail, type EmailSummaryRow } from "../../email/messages";
import { eslogFailure } from "../../eslog-archive";
import { isProformaDraft } from "../../payments/recorded";
import { deliverSoon } from "../../email/outbox";
import { countsTowardAllowance, EMAIL_KINDS, EMAIL_STATUSES } from "../../email/kinds";
import { archivedInvoiceAttachment } from "../../invoice-archive";
import { archivedCreditNoteAttachment } from "../../credit-note-archive";
import { invoicePdf } from "../../invoice-pdf";
import type { CreditNoteRow, CustomerRow, EmailKind, EmailMessageRow, EmailStatus, ProjectMemberRow, ProjectRow } from "../../database/models";

interface InvoiceEmailBody {
	to?: string | null;
	message?: string | null;
	reminder?: boolean;
	attach_invoice?: boolean;
	attach_eslog?: boolean;
	pay_link?: boolean;
}

const MAX_EMAILS_PER_INVOICE = 20;

Server.app.post("/api/v1/projects/:uuid/invoices/:invoice/email", Auth.required(), Permissions.require(Permission.INVOICE_SEND), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	const refusal = await customerEmailRefusal(project);
	if (refusal !== null) return Utils.fail(ctx, refusal);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
	const proforma = await isProformaDraft(invoice);
	if (invoice.status === "draft" && !proforma) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_STATUS);
	if (invoice.status === "canceled") return Utils.fail(ctx, ErrorCode.INVOICE_ALREADY_CANCELED);

	let data: InvoiceEmailBody;
	try {
		data = (await ctx.body<InvoiceEmailBody>()) ?? {};
	} catch {
		data = {};
	}

	if (!Validate.optionalText(data.message, 2000)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (data.reminder !== undefined && typeof data.reminder !== "boolean") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (data.attach_invoice !== undefined && typeof data.attach_invoice !== "boolean") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (data.pay_link !== undefined && typeof data.pay_link !== "boolean") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (data.attach_eslog !== undefined && typeof data.attach_eslog !== "boolean") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	let recipient = typeof data.to === "string" ? data.to.trim() : "";
	if (!recipient && invoice.customer) {
		const [customer] = (await Database`SELECT email FROM customers WHERE uuid = ${invoice.customer}`) as Pick<CustomerRow, "email">[];
		recipient = customer?.email ?? "";
	}
	if (!recipient) return Utils.fail(ctx, ErrorCode.EMAIL_RECIPIENT_MISSING);
	if (!Validate.email(recipient)) return Utils.fail(ctx, ErrorCode.INVALID_EMAIL);

	const reminder = data.reminder === true;
	if (reminder && (proforma || !["open", "overdue", "partially_paid"].includes(invoice.status))) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_PAYABLE);
	if ((await emailCount(invoice.uuid, ["invoice", "proforma", "reminder_before", "reminder_after"])) >= MAX_EMAILS_PER_INVOICE) {
		return Utils.fail(ctx, ErrorCode.EMAIL_LIMIT_REACHED);
	}

	const kind = proforma ? "proforma" : !reminder ? "invoice" : invoice.due_date > Date.now() ? "reminder_before" : "reminder_after";
	let uuid: string;
	try {
		uuid = await queueInvoiceEmail(project, invoice, {
			to: recipient,
			kind,
			message: data.message?.trim() || null,
			sentBy: account.username,
			attachInvoice: proforma ? (data.attach_invoice ?? true) : data.attach_invoice,
			attachEslog: proforma ? false : data.attach_eslog,
			payLink: data.pay_link,
		});
	} catch (error) {
		const failure = eslogFailure(ctx, error);
		if (failure) return failure;
		throw error;
	}
	const email = await findEmail(uuid);

	await Audit.record(ctx, {
		project: project.uuid,
		action: "invoice.emailed",
		entityType: "invoice",
		entityId: invoice.uuid,
		newValue: { reference: invoice.reference, recipient, kind, attachment: email.attachment },
	});
	Logger.audit(`[EMAIL] ${account.username} emailed ${invoice.reference} to ${recipient}`);

	return Utils.ok(ctx, email, 201);
});

Server.app.get("/api/v1/projects/:uuid/invoices/:invoice/emails", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);

	const rows = (await Database`
		SELECT * FROM email_messages WHERE project = ${project.uuid} AND invoice = ${invoiceId} ORDER BY created DESC, uuid ASC
	`) as EmailMessageRow[];

	return Utils.ok(ctx, rows.map(presentEmail));
});

Server.app.post("/api/v1/projects/:uuid/members/:member/invitation-email", Auth.required(), Permissions.require(Permission.PROJECT_MEMBERS), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	if (!canEmail(project)) return Utils.fail(ctx, ErrorCode.EMAIL_NOT_CONFIGURED);

	const memberId = ctx.params["member"];
	if (!Validate.uuid(memberId)) return Utils.fail(ctx, ErrorCode.INVALID_MEMBER_ID);

	const [member] = (await Database`
			SELECT * FROM project_members WHERE uuid = ${memberId} AND project_id = ${project.uuid} AND status = 'pending'
		`) as ProjectMemberRow[];
	if (!member) return Utils.fail(ctx, ErrorCode.INVITATION_NOT_FOUND);

	const [sent] = (await Database`
			SELECT COUNT(*) AS count FROM email_messages WHERE member = ${memberId} AND kind = 'invitation'
		`) as { count: number }[];
	if (Number(sent.count) >= 5) return Utils.fail(ctx, ErrorCode.EMAIL_LIMIT_REACHED);

	const uuid = await queueInvitationEmail(project, member, account.username);
	if (!uuid) return Utils.fail(ctx, ErrorCode.EMAIL_RECIPIENT_MISSING);

	await Audit.record(ctx, {
		project: project.uuid,
		action: "project.member.invitation_emailed",
		entityType: "project_member",
		entityId: memberId,
		newValue: { recipient: member.invitation_email },
	});

	return Utils.ok(ctx, await findEmail(uuid), 201);
});

interface ListedEmail extends EmailSummaryRow {
	invoice_reference: string | null;
	recurring: string | null;
	credit_note_reference: string | null;
	ticket_number: number | null;
}

function presentListed(row: ListedEmail) {
	return {
		...presentEmail(row),
		invoice_reference: row.invoice_reference,
		recurring: row.recurring,
		credit_note_reference: row.credit_note_reference,
		ticket_number: row.ticket_number === null ? null : Number(row.ticket_number),
	};
}

function timestampFilter(value: string | null): number | null | undefined {
	if (value === null) return null;
	const timestamp = Number(value);
	return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : undefined;
}

Server.app.get("/api/v1/projects/:uuid/emails", Auth.required(), Permissions.require(Permission.EMAIL_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();

	const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);
	const status = query.get("status");
	const kind = query.get("kind");
	const invoice = query.get("invoice");
	const recurring = query.get("recurring");
	const search = query.get("search")?.trim() || null;
	const from = timestampFilter(query.get("from"));
	const to = timestampFilter(query.get("to"));

	if (status !== null && !EMAIL_STATUSES.includes(status as EmailStatus)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (kind !== null && !EMAIL_KINDS.includes(kind as EmailKind)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (invoice !== null && !Validate.uuid(invoice)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);
	if (recurring !== null && !Validate.uuid(recurring)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (search !== null && !Validate.shortText(search, 64)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (from === undefined || to === undefined) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	const pattern = `%${(search ?? "").toLowerCase()}%`;
	const statusFilter = status === null ? Database`` : Database`AND m.status = ${status}`;
	const kindFilter = kind === null ? Database`` : Database`AND m.kind = ${kind}`;
	const invoiceFilter = invoice === null ? Database`` : Database`AND m.invoice = ${invoice}`;
	const recurringFilter = recurring === null ? Database`` : Database`AND i.recurring = ${recurring}`;
	const fromFilter = from === null ? Database`` : Database`AND m.created >= ${from}`;
	const toFilter = to === null ? Database`` : Database`AND m.created <= ${to}`;
	const searchFilter =
		search === null ? Database`` : Database`AND (LOWER(m.recipient) LIKE ${pattern} OR LOWER(m.subject) LIKE ${pattern} OR LOWER(i.reference) LIKE ${pattern})`;

	const emails = (await Database`
		SELECT m.uuid, m.project, m.invoice, m.credit_note, m.ticket, m.member, m.kind, m.recipient, m.subject, m.attachment_name, m.eslog_document,
			m.status, m.attempts, m.last_error, m.sent_by, m.sent_at, m.sent_via, m.has_body, m.created,
			i.reference AS invoice_reference, i.recurring AS recurring, n.reference AS credit_note_reference, t.number AS ticket_number
		FROM email_messages m
		LEFT JOIN invoices i ON i.uuid = m.invoice
		LEFT JOIN credit_notes n ON n.uuid = m.credit_note
		LEFT JOIN tickets t ON t.uuid = m.ticket
		WHERE m.project = ${project.uuid} ${statusFilter} ${kindFilter} ${invoiceFilter} ${recurringFilter} ${fromFilter} ${toFilter} ${searchFilter}
		ORDER BY m.created DESC, m.uuid ASC LIMIT ${limit} OFFSET ${offset}
	`) as ListedEmail[];

	const grouped = (await Database`
		SELECT m.kind AS kind, m.status AS status, COUNT(*) AS count
		FROM email_messages m LEFT JOIN invoices i ON i.uuid = m.invoice
		WHERE m.project = ${project.uuid} ${statusFilter} ${kindFilter} ${invoiceFilter} ${recurringFilter} ${fromFilter} ${toFilter} ${searchFilter}
		GROUP BY m.kind, m.status
	`) as { kind: EmailKind; status: EmailStatus; count: number }[];

	const counts: Record<EmailStatus, number> = { pending: 0, sent: 0, failed: 0 };
	const byKind = new Map<EmailKind, Record<EmailStatus, number>>();
	for (const row of grouped) {
		const count = Number(row.count);
		counts[row.status] += count;
		const kindCounts = byKind.get(row.kind) ?? { pending: 0, sent: 0, failed: 0 };
		kindCounts[row.status] += count;
		byKind.set(row.kind, kindCounts);
	}

	return Utils.ok(ctx, {
		emails: emails.map(presentListed),
		total: counts.pending + counts.sent + counts.failed,
		counts,
		kinds: EMAIL_KINDS.filter((value) => byKind.has(value)).map((value) => ({ kind: value, ...byKind.get(value)! })),
		remaining: projectEmailServer(project) === null ? (await emailUsageFor(project.uuid)).emails_remaining : null,
		limit,
		offset,
	});
});

async function emailFor(projectId: string, emailId: string | undefined): Promise<EmailMessageRow | null> {
	if (!Validate.uuid(emailId)) return null;
	const [row] = (await Database`SELECT * FROM email_messages WHERE uuid = ${emailId} AND project = ${projectId}`) as EmailMessageRow[];
	return row ?? null;
}

Server.app.get("/api/v1/projects/:uuid/emails/:email", Auth.required(), Permissions.require(Permission.EMAIL_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);

	const email = await emailFor(project.uuid, ctx.params["email"]);
	if (!email) return Utils.fail(ctx, ErrorCode.EMAIL_NOT_FOUND);

	return Utils.ok(ctx, {
		...presentEmail(email),
		sender_name: email.sender_name,
		reply_to: email.reply_to,
		body_text: email.has_body ? email.body_text : null,
		body_html: email.has_body ? email.body_html : null,
	});
});

type RestoredAttachment = { data: string | null; storageKey: string | null };

async function restoredAttachment(project: ProjectRow, email: EmailMessageRow): Promise<RestoredAttachment | null> {
	if (!email.attachment_name) return { data: null, storageKey: null };

	if (email.kind === "credit_note") {
		if (!email.credit_note) return null;
		const [note] = (await Database`SELECT * FROM credit_notes WHERE uuid = ${email.credit_note} AND project = ${project.uuid}`) as CreditNoteRow[];
		return note ? { data: null, storageKey: (await archivedCreditNoteAttachment(project, note)).storageKey } : null;
	}

	const invoice = email.invoice ? await loadInvoice(project.uuid, email.invoice) : null;
	if (!invoice) return null;
	if (invoice.status !== "draft") return { data: null, storageKey: (await archivedInvoiceAttachment(project, invoice)).storageKey };

	const draft = await invoicePdf(project, invoice, { payLink: Boolean(project.email_pay_link) });
	return { data: Buffer.from(draft.data).toString("base64"), storageKey: null };
}

Server.app.post("/api/v1/projects/:uuid/emails/:email/resend", Auth.required(), Permissions.require(Permission.INVOICE_SEND), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	if (!canEmail(project)) return Utils.fail(ctx, ErrorCode.EMAIL_NOT_CONFIGURED);

	const email = await emailFor(project.uuid, ctx.params["email"]);
	if (!email) return Utils.fail(ctx, ErrorCode.EMAIL_NOT_FOUND);
	if (email.status !== "failed") return Utils.fail(ctx, ErrorCode.EMAIL_NOT_FAILED);
	if (!email.has_body) return Utils.fail(ctx, ErrorCode.EMAIL_CONTENT_REMOVED);
	const refusal = countsTowardAllowance(email.kind) ? await customerEmailRefusal(project) : null;
	if (refusal !== null) return Utils.fail(ctx, refusal);

	const attachment = await restoredAttachment(project, email);
	if (!attachment) return Utils.fail(ctx, ErrorCode.EMAIL_CONTENT_REMOVED);

	const timestamp = Date.now();
	const queued = await Database`
		UPDATE email_messages SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = ${timestamp},
			attachment_data = ${attachment.data}, attachment_storage_key = ${attachment.storageKey}, sent_by = ${account.username}, updated = ${timestamp}
		WHERE uuid = ${email.uuid} AND status = 'failed'
	`;
	if (queued.count === 0) return Utils.fail(ctx, ErrorCode.EMAIL_NOT_FAILED);
	deliverSoon();

	await Audit.record(ctx, {
		project: project.uuid,
		action: "email.resent",
		entityType: "email",
		entityId: email.uuid,
		newValue: { recipient: email.recipient, kind: email.kind, subject: email.subject },
	});
	Logger.audit(`[EMAIL] ${account.username} sent the failed ${email.kind} email to ${email.recipient} again`);

	return Utils.ok(ctx, await findEmail(email.uuid));
});
