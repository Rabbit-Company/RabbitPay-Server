import type { SQL } from "bun";
import Database from "../database/database";
import Utils from "../utils";
import { Logger } from "../logger";
import { addressLines, companyFor, displayNameOf } from "../company";
import { loadItems } from "../invoice-service";
import { invoiceBank } from "../invoice-document";
import { archivedInvoiceAttachment } from "../invoice-archive";
import { invoicePdf } from "../invoice-pdf";
import { archivedCreditNoteAttachment } from "../credit-note-archive";
import { archivedEslog, isEslogFailure, type EslogSubject } from "../eslog-archive";
import { creditNoteItems } from "../credit-notes";
import { availableFor } from "../payments/methods";
import { outstandingOf } from "../invoicing";
import { deliverSoon, queueEmail } from "./outbox";
import { canEmail } from "./mailer";
import { whiteLabelActive } from "../licensing";
import { emailDesignOf, logoPath } from "../branding";
import { DEFAULT_EMAIL_DESIGN, type EmailDesign } from "../email-design";
import {
	creditNoteEmail,
	invitationEmail,
	invoiceEmail,
	keysEmail,
	receiptEmail,
	type EmailBrand,
	type EmailLine,
	type InvoiceEmailKind,
	type KeyGroup,
} from "./templates";
import { DAY, MAX_DAYS_BEFORE, reminderDue } from "./reminders";
import type { DateFormat } from "../formats";
import type { CreditNoteRow, EmailKind, EmailMessageRow, InvoiceItemRow, InvoiceRow, ProjectMemberRow, ProjectRow } from "../database/models";

const REMINDER_BATCH = 500;

export function presentEmail(row: EmailMessageRow) {
	return {
		uuid: row.uuid,
		kind: row.kind,
		recipient: row.recipient,
		subject: row.subject,
		attachment: row.attachment_name,
		eslog_document: row.eslog_document,
		status: row.status,
		attempts: row.attempts,
		last_error: row.last_error,
		sent_by: row.sent_by,
		sent_at: row.sent_at,
		created: row.created,
	};
}

export async function findEmail(uuid: string) {
	const [row] = (await Database`SELECT * FROM email_messages WHERE uuid = ${uuid}`) as EmailMessageRow[];
	return presentEmail(row);
}

export async function emailCount(invoiceId: string, kinds: EmailKind[]): Promise<number> {
	const [row] = (await Database`
		SELECT COUNT(*) AS count FROM email_messages WHERE invoice = ${invoiceId} AND kind IN ${Database(kinds)}
	`) as { count: number }[];
	return Number(row.count);
}

export function logoUrlFor(project: Pick<ProjectRow, "uuid" | "logo_updated" | "white_label_until">): string | null {
	const path = logoPath(project);
	return path !== null && whiteLabelActive(project) ? `${Utils.publicUrl()}${path}` : null;
}

export async function brandFor(project: ProjectRow, audience: "customer" | "team" = "customer", override?: EmailDesign): Promise<EmailBrand> {
	const company = await companyFor(project.uuid);
	const design = audience === "team" ? DEFAULT_EMAIL_DESIGN : (override ?? emailDesignOf(project));
	return {
		whiteLabel: whiteLabelActive(project),
		logoUrl: design.show_logo ? logoUrlFor(project) : null,
		merchant: displayNameOf(project),
		language: project.language,
		accent: design.accent ?? project.accent_color,
		dateFormat: project.date_format as DateFormat,
		timezone: project.timezone,
		replyTo: company.email || null,
		address: design.show_address ? [company.legal_name, ...addressLines(company, project.language)].filter((line): line is string => Boolean(line)) : [],
		signature: design.signature,
		footerText: design.footer_text,
	};
}

export function emailLines(items: InvoiceItemRow[]): EmailLine[] {
	return items.map((item) => ({
		description: item.description,
		quantity: item.quantity,
		unit: item.unit,
		gross: item.total_price - item.discount_amount + item.tax_amount,
	}));
}

function payUrl(invoice: InvoiceRow): string {
	return `${Utils.publicUrl()}/pay/${invoice.uuid}`;
}

function portalUrl(project: ProjectRow): string | null {
	return project.email_portal_link ? `${Utils.publicUrl()}/customer` : null;
}

export interface InvoiceEmailOptions {
	to: string;
	kind: InvoiceEmailKind;
	message: string | null;
	sentBy: string | null;
	attachInvoice?: boolean;
	attachEslog?: boolean;
	payLink?: boolean;
}

async function eslogAttachment(subject: EslogSubject, requested: boolean | undefined, byDefault: boolean): Promise<string | null> {
	if (requested === false || (requested === undefined && !byDefault)) return null;
	try {
		return (await archivedEslog(subject)).id;
	} catch (err) {
		if (requested === true || !isEslogFailure(err)) throw err;
		const reference = subject.kind === "invoice" ? subject.invoice.reference : subject.note.reference;
		Logger.warn(`[EMAIL] Sending ${reference} without the e-SLOG file: ${err instanceof Error ? err.message : err}`);
		return null;
	}
}

export async function queueInvoiceEmail(project: ProjectRow, invoice: InvoiceRow, options: InvoiceEmailOptions): Promise<string> {
	const attachInvoice = options.attachInvoice ?? Boolean(project.email_attach_invoice);
	const payLink = options.payLink ?? Boolean(project.email_pay_link);

	const brand = await brandFor(project);
	const bank = payLink ? null : await invoiceBank(project, invoice, await companyFor(project.uuid), await availableFor(project.uuid));
	const eslogDocument = await eslogAttachment(
		{ kind: "invoice", project, invoice },
		options.attachEslog,
		options.kind === "invoice" && Boolean(project.email_attach_eslog)
	);
	const attachment = !attachInvoice
		? null
		: invoice.status === "draft"
			? await invoicePdf(project, invoice, { payLink })
			: await archivedInvoiceAttachment(project, invoice);
	const content = invoiceEmail(
		brand,
		options.kind,
		{
			reference: invoice.reference,
			currency: invoice.currency,
			total: invoice.total_amount,
			tax: invoice.tax_amount,
			outstanding: outstandingOf(invoice),
			dueDate: invoice.due_date,
			paid: invoice.status === "paid",
		},
		emailLines(await loadItems(invoice.uuid)),
		payLink ? payUrl(invoice) : null,
		options.message,
		{
			bank,
			attached: attachment !== null,
			eslogAttached: eslogDocument !== null,
			portalUrl: portalUrl(project),
			custom: emailDesignOf(project).templates[options.kind],
		}
	);

	const uuid = await queueEmail(Database, {
		project: project.uuid,
		invoice: invoice.uuid,
		kind: options.kind,
		to: options.to,
		senderName: brand.merchant,
		replyTo: brand.replyTo,
		...content,
		attachment,
		eslogDocument,
		sentBy: options.sentBy,
	});
	deliverSoon();
	return uuid;
}

export interface PreparedEmail {
	senderName: string;
	replyTo: string | null;
	subject: string;
	text: string;
	html: string;
}

export async function prepareKeysEmail(project: ProjectRow, invoice: InvoiceRow, groups: KeyGroup[]): Promise<PreparedEmail> {
	const brand = await brandFor(project);
	const content = keysEmail(brand, { reference: invoice.reference }, groups, payUrl(invoice), emailDesignOf(project).templates.keys);

	return { senderName: brand.merchant, replyTo: brand.replyTo, ...content };
}

export async function queueKeysEmail(
	sql: SQL,
	project: ProjectRow,
	invoice: InvoiceRow,
	email: { prepared: PreparedEmail; to: string; sentBy: string | null }
): Promise<string> {
	return await queueEmail(sql, {
		project: project.uuid,
		invoice: invoice.uuid,
		kind: "keys",
		to: email.to,
		...email.prepared,
		sentBy: email.sentBy,
	});
}

export async function queueReceiptEmail(
	project: ProjectRow,
	sale: InvoiceRow,
	to: string,
	sentBy: string,
	keys: KeyGroup[] = [],
	options: { attachDocument?: boolean } = {}
): Promise<string> {
	const attachDocument = options.attachDocument ?? Boolean(project.email_attach_invoice);
	const brand = await brandFor(project);
	const attachment = attachDocument ? await archivedInvoiceAttachment(project, sale) : null;
	const content = receiptEmail(
		brand,
		{
			reference: sale.reference,
			currency: sale.currency,
			total: sale.total_amount,
			tax: sale.tax_amount,
			paidAt: sale.paid_date ?? sale.issued_at ?? sale.created,
		},
		emailLines(await loadItems(sale.uuid)),
		payUrl(sale),
		keys,
		{ attached: attachment !== null, custom: emailDesignOf(project).templates.receipt }
	);

	const uuid = await queueEmail(Database, {
		project: project.uuid,
		invoice: sale.uuid,
		kind: "receipt",
		to,
		senderName: brand.merchant,
		replyTo: brand.replyTo,
		...content,
		attachment,
		sentBy,
	});
	deliverSoon();
	return uuid;
}

export async function queueCreditNoteEmail(
	project: ProjectRow,
	note: CreditNoteRow,
	options: { to: string; message: string | null; sentBy: string; attachDocument?: boolean; attachEslog?: boolean }
): Promise<string> {
	const attachDocument = options.attachDocument ?? Boolean(project.email_attach_invoice);
	const brand = await brandFor(project);
	const [invoice] = (await Database`SELECT reference FROM invoices WHERE uuid = ${note.invoice}`) as Pick<InvoiceRow, "reference">[];
	const eslogDocument = await eslogAttachment({ kind: "credit_note", project, note }, options.attachEslog, Boolean(project.email_attach_eslog));
	const attachment = attachDocument ? await archivedCreditNoteAttachment(project, note) : null;
	const content = creditNoteEmail(
		brand,
		{
			reference: note.reference,
			invoiceReference: invoice?.reference ?? "",
			currency: note.currency,
			total: note.total_amount,
			tax: note.tax_amount,
			issuedAt: note.issued_at,
		},
		(await creditNoteItems(note.uuid)).map((item) => ({ description: item.description, quantity: null, gross: item.net_amount + item.tax_amount })),
		options.message,
		{
			attached: attachment !== null,
			eslogAttached: eslogDocument !== null,
			portalUrl: portalUrl(project),
			custom: emailDesignOf(project).templates.credit_note,
		}
	);

	const uuid = await queueEmail(Database, {
		project: project.uuid,
		invoice: note.invoice,
		kind: "credit_note",
		to: options.to,
		senderName: brand.merchant,
		replyTo: brand.replyTo,
		...content,
		attachment,
		eslogDocument,
		sentBy: options.sentBy,
	});
	deliverSoon();
	return uuid;
}

export async function queueInvitationEmail(project: ProjectRow, member: ProjectMemberRow, inviter: string): Promise<string | null> {
	if (!member.invitation_token || !member.invitation_email) return null;

	const brand = await brandFor(project, "team");
	const content = invitationEmail(brand, {
		inviter,
		role: member.role,
		url: `${Utils.publicUrl()}/invite/${member.invitation_token}`,
	});

	const uuid = await queueEmail(Database, {
		project: project.uuid,
		member: member.uuid,
		kind: "invitation",
		to: member.invitation_email,
		senderName: brand.merchant,
		replyTo: brand.replyTo,
		...content,
		sentBy: inviter,
	});
	deliverSoon();
	return uuid;
}

export async function emailsSent(invoiceIds: string[], kinds: EmailKind[]): Promise<Map<string, Map<EmailKind, number>>> {
	const counts = new Map<string, Map<EmailKind, number>>();
	if (invoiceIds.length === 0) return counts;

	const rows = (await Database`
		SELECT invoice, kind, COUNT(*) AS count FROM email_messages
		WHERE invoice IN ${Database(invoiceIds)} AND kind IN ${Database(kinds)}
		GROUP BY invoice, kind
	`) as { invoice: string; kind: EmailKind; count: number }[];

	for (const row of rows) {
		const byKind = counts.get(row.invoice) ?? new Map<EmailKind, number>();
		byKind.set(row.kind, Number(row.count));
		counts.set(row.invoice, byKind);
	}
	return counts;
}

export async function sendDueReminders(now = Date.now()): Promise<number> {
	const candidates = (await Database`
		SELECT i.*, c.email AS customer_email FROM invoices i
		JOIN projects p ON p.uuid = i.project
		JOIN customers c ON c.uuid = i.customer
		WHERE p.email_reminders = 1 AND p.status != 'deleted' AND i.source = 'invoice' AND i.issued_at IS NOT NULL AND c.email IS NOT NULL
			AND i.status IN ('open', 'overdue', 'partially_paid') AND i.due_date <= ${now + MAX_DAYS_BEFORE * DAY}
		ORDER BY i.due_date ASC LIMIT ${REMINDER_BATCH}
	`) as (InvoiceRow & { customer_email: string })[];

	if (candidates.length === 0) return 0;

	const projectIds = [...new Set(candidates.map((invoice) => invoice.project))];
	const projects = new Map(
		((await Database`SELECT * FROM projects WHERE uuid IN ${Database(projectIds)}`) as ProjectRow[]).map((project) => [project.uuid, project])
	);
	const sent = await emailsSent(
		candidates.map((invoice) => invoice.uuid),
		["reminder_before", "reminder_after"]
	);

	let queued = 0;
	for (const invoice of candidates) {
		const project = projects.get(invoice.project)!;
		if (!canEmail(project)) continue;
		const counts = sent.get(invoice.uuid);
		const kind = reminderDue(
			{ dueDate: invoice.due_date, issuedAt: invoice.issued_at!, outstanding: outstandingOf(invoice) },
			{ daysBefore: project.reminder_days_before, daysAfter: project.reminder_days_after },
			{ before: counts?.get("reminder_before") ?? 0, after: counts?.get("reminder_after") ?? 0 },
			now
		);
		if (!kind) continue;

		try {
			await queueInvoiceEmail(project, invoice, { to: invoice.customer_email, kind, message: null, sentBy: null });
			queued++;
		} catch (err) {
			Logger.error(`[EMAIL] Could not queue ${kind} for ${invoice.reference}: ${err}`);
		}
	}

	return queued;
}
