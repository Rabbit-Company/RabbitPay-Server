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
import { creditableLines, creditNoteItems, creditNotesFor, issueCreditNote, planCredit, type CreditRequest } from "../../credit-notes";
import { creditNoteDocument } from "../../credit-note-document";
import { creditNotePdf, pdfResponse } from "../../invoice-pdf";
import { eslogFailure, eslogResponse, eslogVersions, presentVersions } from "../../eslog-archive";
import { canEmail } from "../../email/mailer";
import { emailCount, findEmail, queueCreditNoteEmail } from "../../email/messages";
import type { CustomerRow } from "../../database/models";
import type { CreditNoteItemRow, CreditNoteRow } from "../../database/models";
import { accountingPeriodLocked } from "../../accounting-periods";
import { prepareIssuePresentation } from "../../invoice-snapshot";
import { archiveIssuedCreditNote } from "../../credit-note-archive";
import { hasStorageCapacity } from "../../licensing";

interface CreditNoteEmailBody {
	to?: string | null;
	message?: string | null;
	attach_invoice?: boolean;
	attach_eslog?: boolean;
}

const MAX_CREDIT_NOTE_EMAILS = 20;

function present(note: CreditNoteRow, items: CreditNoteItemRow[]) {
	return { ...note, items };
}

async function findCreditNote(projectId: string, noteId: string): Promise<CreditNoteRow | undefined> {
	const [note] = (await Database`SELECT * FROM credit_notes WHERE uuid = ${noteId} AND project = ${projectId}`) as CreditNoteRow[];
	return note;
}

Server.app.get("/api/v1/projects/:uuid/credit-notes", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();

	const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);

	const notes = (await Database`
		SELECT cn.*, i.reference AS invoice_reference FROM credit_notes cn JOIN invoices i ON i.uuid = cn.invoice
		WHERE cn.project = ${project.uuid}
		ORDER BY cn.issued_at DESC, cn.reference DESC LIMIT ${limit} OFFSET ${offset}
	`) as (CreditNoteRow & { invoice_reference: string })[];

	const [counted] = (await Database`SELECT COUNT(*) AS count FROM credit_notes WHERE project = ${project.uuid}`) as { count: number }[];

	return Utils.ok(ctx, { credit_notes: notes, total: Number(counted.count), limit, offset });
});

Server.app.get("/api/v1/projects/:uuid/invoices/:invoice/credit-notes", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);

	const notes = await creditNotesFor(invoiceId);
	const lines = invoice.issued_at === null ? [] : await creditableLines(Database, invoiceId);

	return Utils.ok(ctx, {
		credit_notes: await Promise.all(notes.map(async (note) => present(note, await creditNoteItems(note.uuid)))),
		creditable: lines.map((entry) => ({
			line: entry.line.uuid,
			description: entry.line.description,
			tax_rate: entry.line.tax_rate,
			tax_treatment: entry.line.tax_treatment,
			net: Math.max(entry.net, 0),
			tax: Math.max(entry.tax, 0),
		})),
		creditable_total: lines.reduce((sum, entry) => sum + Math.max(entry.net, 0) + Math.max(entry.tax, 0), 0),
	});
});

Server.app.post("/api/v1/projects/:uuid/invoices/:invoice/credit-notes", Auth.required(), Permissions.require(Permission.INVOICE_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
	if (invoice.status === "draft" || invoice.issued_at === null) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_STATUS);

	let data: CreditRequest;
	try {
		data = await ctx.body<CreditRequest>();
	} catch {
		data = {};
	}
	if (typeof data !== "object" || data === null) return Utils.fail(ctx, ErrorCode.INVALID_CREDIT_NOTE);
	if (!Validate.optionalText(data.reason, 500)) return Utils.fail(ctx, ErrorCode.INVALID_CREDIT_NOTE);
	if (await accountingPeriodLocked(project.uuid, Date.now())) return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);
	if (!(await hasStorageCapacity(project.uuid))) return Utils.fail(ctx, ErrorCode.STORAGE_LIMIT_REACHED);
	const presentation = await prepareIssuePresentation(project);

	const outcome = await Database.begin(async (tx) => {
		const planned = planCredit(await creditableLines(tx as typeof Database, invoiceId), data);
		if (!Array.isArray(planned)) return planned;
		return await issueCreditNote(tx as typeof Database, invoice, planned, {
			reason: data.reason?.trim() || null,
			createdBy: account.username,
			presentation,
		});
	});

	if (typeof outcome === "number") return Utils.fail(ctx, outcome);
	await archiveIssuedCreditNote(project.uuid, outcome.uuid);

	await Audit.record(ctx, {
		project: project.uuid,
		action: "invoice.credited",
		entityType: "invoice",
		entityId: invoiceId,
		newValue: { credit_note: outcome.reference, total_amount: outcome.total_amount, tax_amount: outcome.tax_amount, reason: outcome.reason },
	});
	Logger.audit(`[INVOICES] Issued credit note ${outcome.reference} for ${invoice.reference} on ${project.uuid}`);

	return Utils.ok(ctx, present(outcome, await creditNoteItems(outcome.uuid)), 201);
});

Server.app.get("/api/v1/projects/:uuid/credit-notes/:note", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);

	const noteId = ctx.params["note"];
	if (!Validate.uuid(noteId)) return Utils.fail(ctx, ErrorCode.INVALID_CREDIT_NOTE_ID);

	const note = await findCreditNote(project.uuid, noteId);
	if (!note) return Utils.fail(ctx, ErrorCode.CREDIT_NOTE_NOT_FOUND);

	return Utils.ok(ctx, present(note, await creditNoteItems(noteId)));
});

Server.app.get("/api/v1/projects/:uuid/credit-notes/:note/document", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);

	const noteId = ctx.params["note"];
	if (!Validate.uuid(noteId)) return Utils.fail(ctx, ErrorCode.INVALID_CREDIT_NOTE_ID);

	const note = await findCreditNote(project.uuid, noteId);
	if (!note) return Utils.fail(ctx, ErrorCode.CREDIT_NOTE_NOT_FOUND);

	return Utils.ok(ctx, await creditNoteDocument(project, note));
});

Server.app.get("/api/v1/projects/:uuid/credit-notes/:note/pdf", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);

	const noteId = ctx.params["note"];
	if (!Validate.uuid(noteId)) return Utils.fail(ctx, ErrorCode.INVALID_CREDIT_NOTE_ID);

	const note = await findCreditNote(project.uuid, noteId);
	if (!note) return Utils.fail(ctx, ErrorCode.CREDIT_NOTE_NOT_FOUND);

	return pdfResponse(await creditNotePdf(project, note));
});

Server.app.get("/api/v1/projects/:uuid/credit-notes/:note/eslog", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);

	const noteId = ctx.params["note"];
	if (!Validate.uuid(noteId)) return Utils.fail(ctx, ErrorCode.INVALID_CREDIT_NOTE_ID);

	const note = await findCreditNote(project.uuid, noteId);
	if (!note) return Utils.fail(ctx, ErrorCode.CREDIT_NOTE_NOT_FOUND);

	return await eslogResponse(ctx, { kind: "credit_note", project, note });
});

Server.app.get("/api/v1/projects/:uuid/credit-notes/:note/eslog/versions", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);

	const noteId = ctx.params["note"];
	if (!Validate.uuid(noteId)) return Utils.fail(ctx, ErrorCode.INVALID_CREDIT_NOTE_ID);

	const note = await findCreditNote(project.uuid, noteId);
	if (!note) return Utils.fail(ctx, ErrorCode.CREDIT_NOTE_NOT_FOUND);

	return Utils.ok(ctx, { versions: presentVersions(await eslogVersions({ kind: "credit_note", project, note })) });
});

Server.app.post("/api/v1/projects/:uuid/credit-notes/:note/email", Auth.required(), Permissions.require(Permission.INVOICE_SEND), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	if (!canEmail(project)) return Utils.fail(ctx, ErrorCode.EMAIL_NOT_CONFIGURED);

	const noteId = ctx.params["note"];
	if (!Validate.uuid(noteId)) return Utils.fail(ctx, ErrorCode.INVALID_CREDIT_NOTE_ID);

	const note = await findCreditNote(project.uuid, noteId);
	if (!note) return Utils.fail(ctx, ErrorCode.CREDIT_NOTE_NOT_FOUND);

	let data: CreditNoteEmailBody;
	try {
		data = (await ctx.body<CreditNoteEmailBody>()) ?? {};
	} catch {
		data = {};
	}

	if (!Validate.optionalText(data.message, 2000)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (data.attach_invoice !== undefined && typeof data.attach_invoice !== "boolean") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	if (data.attach_eslog !== undefined && typeof data.attach_eslog !== "boolean") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	let recipient = typeof data.to === "string" ? data.to.trim() : "";
	if (!recipient) {
		const invoice = await loadInvoice(project.uuid, note.invoice);
		if (invoice?.customer) {
			const [customer] = (await Database`SELECT email FROM customers WHERE uuid = ${invoice.customer}`) as Pick<CustomerRow, "email">[];
			recipient = customer?.email ?? "";
		}
	}
	if (!recipient) return Utils.fail(ctx, ErrorCode.EMAIL_RECIPIENT_MISSING);
	if (!Validate.email(recipient)) return Utils.fail(ctx, ErrorCode.INVALID_EMAIL);
	if ((await emailCount(note.invoice, ["credit_note"])) >= MAX_CREDIT_NOTE_EMAILS) return Utils.fail(ctx, ErrorCode.EMAIL_LIMIT_REACHED);

	let uuid: string;
	try {
		uuid = await queueCreditNoteEmail(project, note, {
			to: recipient,
			message: data.message?.trim() || null,
			sentBy: account.username,
			attachDocument: data.attach_invoice,
			attachEslog: data.attach_eslog,
		});
	} catch (error) {
		const failure = eslogFailure(ctx, error);
		if (failure) return failure;
		throw error;
	}
	const email = await findEmail(uuid);

	await Audit.record(ctx, {
		project: project.uuid,
		action: "credit_note.emailed",
		entityType: "credit_note",
		entityId: note.uuid,
		newValue: { reference: note.reference, recipient, attachment: email.attachment },
	});
	Logger.audit(`[EMAIL] ${account.username} emailed credit note ${note.reference} to ${recipient}`);

	return Utils.ok(ctx, email, 201);
});
