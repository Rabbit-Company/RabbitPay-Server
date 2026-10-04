import type { SQL } from "bun";
import Database from "../database/database";
import { Logger } from "../logger";
import { Settings } from "../settings";
import { isEnabled, projectEmailServer, sendEmail, type EmailAttachment } from "./mailer";
import { storedEslog } from "../eslog-archive";
import { ESLOG_CONTENT_TYPE } from "../eslog";
import { billEmail, emailsMetered, hasEmailCapacity, licensingEnforced } from "../licensing";
import { countsTowardAllowance } from "./kinds";
import { documentStorage } from "../document-storage";
import { deliveredCreditNotePdf, deliveredInvoicePdf } from "../invoice-pdf";
import type { CreditNoteRow, EmailKind, EmailMessageRow, EmailRoute, InvoiceRow, ProjectRow } from "../database/models";

export const RETRY_BASE_SECONDS = 30;
export const RETRY_CAP_SECONDS = 3600;
const BATCH_SIZE = 20;

export interface QueuedEmail {
	project: string;
	invoice?: string | null;
	creditNote?: string | null;
	ticket?: string | null;
	member?: string | null;
	kind: EmailKind;
	to: string;
	senderName: string;
	replyTo: string | null;
	subject: string;
	text: string;
	html: string;
	attachment?: { name: string; data?: Uint8Array; storageKey?: string } | null;
	eslogDocument?: string | null;
	sentBy: string | null;
}

export const PDF_CONTENT_TYPE = "application/pdf";
export const EMAIL_ALLOWANCE_USED = "This project has no emails left this month";

export function retryDelay(attempts: number): number {
	return Math.min(RETRY_BASE_SECONDS * Math.pow(2, Math.max(attempts - 1, 0)), RETRY_CAP_SECONDS) * 1000;
}

export async function storedAttachment(message: EmailMessageRow): Promise<Buffer | null> {
	if (message.attachment_data) return Buffer.from(message.attachment_data, "base64");
	if (!message.attachment_storage_key) return null;
	const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${message.project}`) as ProjectRow[];
	if (message.kind === "credit_note" && project) {
		const noteId = message.credit_note ?? message.attachment_storage_key.split("/")[2];
		const [note] = (await Database`SELECT * FROM credit_notes WHERE uuid = ${noteId} AND project = ${message.project}`) as CreditNoteRow[];
		if (note) return Buffer.from((await deliveredCreditNotePdf(project, note)).data);
	}
	if (message.invoice && project) {
		const [invoice] = (await Database`SELECT * FROM invoices WHERE uuid = ${message.invoice} AND project = ${message.project}`) as InvoiceRow[];
		if (invoice) return Buffer.from((await deliveredInvoicePdf(project, invoice)).data);
	}
	return Buffer.from(await documentStorage().get(message.attachment_storage_key));
}

export async function queueEmail(sql: SQL, email: QueuedEmail): Promise<string> {
	const uuid = crypto.randomUUID();
	const timestamp = Date.now();
	const attachmentName = email.attachment?.name ?? null;
	const attachmentData = email.attachment?.data ? Buffer.from(email.attachment.data).toString("base64") : null;
	const attachmentStorageKey = email.attachment?.storageKey ?? null;

	await sql`
		INSERT INTO email_messages(uuid, project, invoice, credit_note, ticket, member, kind, recipient, reply_to, sender_name, subject, body_text,
			body_html, attachment_name, attachment_data, attachment_storage_key, eslog_document, status, attempts, next_attempt_at, sent_by, created, updated)
		VALUES(${uuid}, ${email.project}, ${email.invoice ?? null}, ${email.creditNote ?? null}, ${email.ticket ?? null}, ${email.member ?? null},
			${email.kind}, ${email.to}, ${email.replyTo}, ${email.senderName}, ${email.subject}, ${email.text}, ${email.html}, ${attachmentName},
			${attachmentData}, ${attachmentStorageKey}, ${email.eslogDocument ?? null}, 'pending', 0, ${timestamp}, ${email.sentBy}, ${timestamp}, ${timestamp})
	`;

	return uuid;
}

let delivering: Promise<{ attempted: number; sent: number }> | null = null;
let requestedAgain = false;

async function deliverBatch(now: number): Promise<{ attempted: number; sent: number }> {
	const defaultServer = isEnabled() ? 1 : 0;
	const enforced = licensingEnforced() ? 1 : 0;
	const due = (await Database`
		SELECT m.*, p.email_server AS project_email_server, p.white_label_until AS project_white_label_until
		FROM email_messages m
		JOIN projects p ON p.uuid = m.project
		WHERE m.status = 'pending' AND m.next_attempt_at <= ${now}
			AND (${defaultServer} = 1 OR (p.email_server IS NOT NULL AND (${enforced} = 0 OR p.white_label_until > ${now})))
		ORDER BY m.created ASC LIMIT ${BATCH_SIZE}
	`) as (EmailMessageRow & { project_email_server: string | null; project_white_label_until: number | null })[];

	const maxAttempts = Math.max(Settings.email?.max_attempts || 5, 1);
	let sent = 0;

	for (const message of due) {
		const attempts = message.attempts + 1;
		const project: Pick<ProjectRow, "uuid" | "email_server" | "white_label_until"> = {
			uuid: message.project,
			email_server: message.project_email_server,
			white_label_until: message.project_white_label_until,
		};
		const server = projectEmailServer(project);
		if (!server && !isEnabled()) {
			await Database`
				UPDATE email_messages SET status = 'failed', attempts = ${attempts}, last_error = 'The project email server could not be read',
					next_attempt_at = NULL, updated = ${Date.now()}
				WHERE uuid = ${message.uuid}
			`;
			continue;
		}
		const metered = !server && emailsMetered() && countsTowardAllowance(message.kind);
		if (metered && !(await hasEmailCapacity(message.project))) {
			await Database`
				UPDATE email_messages SET status = 'failed', last_error = ${EMAIL_ALLOWANCE_USED}, attachment_data = NULL, attachment_storage_key = NULL,
					next_attempt_at = NULL, updated = ${Date.now()}
				WHERE uuid = ${message.uuid}
			`;
			continue;
		}
		try {
			const attachmentContent = await storedAttachment(message);
			const attachments: EmailAttachment[] = [];
			if (message.attachment_name && attachmentContent) {
				attachments.push({ filename: message.attachment_name, contentType: PDF_CONTENT_TYPE, content: attachmentContent });
			}
			if (message.eslog_document) {
				const eslog = await storedEslog(message.eslog_document);
				attachments.push({ filename: eslog.name, contentType: ESLOG_CONTENT_TYPE, content: Buffer.from(eslog.data) });
			}
			await sendEmail(
				{
					to: message.recipient,
					senderName: message.sender_name,
					replyTo: message.reply_to,
					subject: message.subject,
					text: message.body_text,
					html: message.body_html,
					attachments,
				},
				server ? { projectId: message.project, server } : null
			);
			const timestamp = Date.now();
			const sentVia: EmailRoute = server ? "project" : "server";
			await Database`
				UPDATE email_messages SET status = 'sent', attempts = ${attempts}, last_error = NULL, next_attempt_at = NULL,
					attachment_data = NULL, attachment_storage_key = NULL, sent_at = ${timestamp}, sent_via = ${sentVia}, updated = ${timestamp}
				WHERE uuid = ${message.uuid}
			`;
			if (metered) {
				await billEmail(message.project, message.uuid, timestamp).catch((err) =>
					Logger.error(`[EMAIL] Could not count the ${message.kind} email ${message.uuid} toward the allowance: ${err}`)
				);
			}
			sent++;
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			const gaveUp = attempts >= maxAttempts;
			const timestamp = Date.now();
			await Database`
				UPDATE email_messages SET status = ${gaveUp ? "failed" : "pending"}, attempts = ${attempts}, last_error = ${reason.slice(0, 500)},
					attachment_data = CASE WHEN ${gaveUp ? 1 : 0} = 1 THEN NULL ELSE attachment_data END,
					attachment_storage_key = CASE WHEN ${gaveUp ? 1 : 0} = 1 THEN NULL ELSE attachment_storage_key END,
					next_attempt_at = ${gaveUp ? null : timestamp + retryDelay(attempts)}, updated = ${timestamp}
				WHERE uuid = ${message.uuid}
			`;
			Logger.warn(`[EMAIL] ${message.kind} to ${message.recipient} failed on attempt ${attempts}: ${reason}`);
		}
	}

	return { attempted: due.length, sent };
}

export async function deliverPendingEmails(now?: number): Promise<{ attempted: number; sent: number }> {
	if (delivering) {
		requestedAgain = true;
		return await delivering;
	}

	delivering = (async () => {
		const total = { attempted: 0, sent: 0 };
		do {
			requestedAgain = false;
			const round = await deliverBatch(now ?? Date.now());
			total.attempted += round.attempted;
			total.sent += round.sent;
		} while (requestedAgain);
		return total;
	})();

	try {
		return await delivering;
	} finally {
		delivering = null;
	}
}

export async function removeExpiredBodies(now = Date.now()): Promise<number> {
	const days = Settings.email?.body_retention_days ?? 0;
	if (days <= 0) return 0;
	const cutoff = now - days * 24 * 60 * 60 * 1000;
	const result = await Database`
		UPDATE email_messages SET body_text = '', body_html = '', has_body = 0
		WHERE has_body = 1 AND created < ${cutoff} AND status <> 'pending'
	`;
	return result.count;
}

export function deliverSoon() {
	void deliverPendingEmails().catch((err) => Logger.error(`[EMAIL] Delivery failed: ${err}`));
}
