import Database from "./database/database";
import { isEnabled, sendEmail } from "./email/mailer";
import { legalNoticeEmail, type EmailBrand, type EmailContent } from "./email/templates";
import { Logger } from "./logger";
import { Settings } from "./settings";
import Utils from "./utils";
import { effectiveOf, formatLegalDate } from "./legal";
import type { LegalDocumentRow } from "./database/models";

export function noticeMessage(document: LegalDocumentRow): EmailContent {
	const url = Utils.publicUrl();
	const operator = Settings.legal.operator_name || "RabbitPay";
	const effective = effectiveOf(document);
	const brand: EmailBrand = {
		merchant: operator,
		language: "sl",
		accent: null,
		dateFormat: "auto",
		replyTo: Settings.legal.contact_email || null,
		address: Settings.legal.address
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
		whiteLabel: true,
		logoUrl: null,
	};
	return legalNoticeEmail(brand, {
		kind: document.kind,
		version: Number(document.version),
		operator,
		service: new URL(url).host,
		url: `${url}/${document.kind}?upcoming=1`,
		effective: { sl: formatLegalDate("sl", effective), en: formatLegalDate("en", effective) },
	});
}

export async function notifyAccounts(document: LegalDocumentRow): Promise<number | null> {
	if (!isEnabled()) return null;

	const recipients = (await Database`SELECT email FROM accounts WHERE status = 'active' ORDER BY created ASC`) as { email: string }[];
	const message = noticeMessage(document);
	const senderName = Settings.legal.operator_name || "RabbitPay";
	const replyTo = Settings.legal.contact_email || null;

	void (async () => {
		let sent = 0;
		for (const { email } of recipients) {
			try {
				await sendEmail({ to: email, senderName, replyTo, ...message });
				sent++;
			} catch (error) {
				Logger.warn(`[LEGAL] Notice about ${document.kind} version ${document.version} to ${email} failed: ${error}`);
			}
		}
		Logger.audit(`[LEGAL] Notice about ${document.kind} version ${document.version} sent to ${sent} of ${recipients.length} accounts`);
	})();

	return recipients.length;
}
