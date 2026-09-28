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
import { canEmail } from "../../email/mailer";
import { emailCount, findEmail, presentEmail, queueInvitationEmail, queueInvoiceEmail } from "../../email/messages";
import { eslogFailure } from "../../eslog-archive";
import { isProformaDraft } from "../../payments/recorded";
import type { CustomerRow, EmailMessageRow, ProjectMemberRow } from "../../database/models";

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

	if (!canEmail(project)) return Utils.fail(ctx, ErrorCode.EMAIL_NOT_CONFIGURED);

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
