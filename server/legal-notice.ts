import Database from "./database/database";
import { isEnabled, sendEmail } from "./email/mailer";
import { escapeHtml } from "./markdown";
import { Logger } from "./logger";
import { Settings } from "./settings";
import Utils from "./utils";
import { effectiveOf, formatLegalDate } from "./legal";
import type { LegalDocumentRow } from "./database/models";

interface NoticeText {
	subject: string;
	paragraphs: string[];
}

function noticeText(document: LegalDocumentRow): { sl: NoticeText; en: NoticeText } {
	const url = Utils.publicUrl();
	const link = `${url}/${document.kind}?upcoming=1`;
	const operator = Settings.legal.operator_name || "RabbitPay";
	const version = Number(document.version);
	const effective = effectiveOf(document);
	const terms = document.kind === "terms";

	return {
		sl: {
			subject: terms ? "Spremembe Splošnih pogojev uporabe" : "Spremembe Politike zasebnosti",
			paragraphs: [
				"Pozdravljeni,",
				terms
					? `${operator} bo ${formatLegalDate("sl", effective)} začel uporabljati različico ${version} Splošnih pogojev uporabe storitve ${url}.`
					: `${operator} bo ${formatLegalDate("sl", effective)} začel uporabljati različico ${version} Politike zasebnosti storitve ${url}.`,
				`Novo različico si lahko preberete na ${link}`,
				terms
					? "Ob naslednji prijavi po tem datumu jo boste morali sprejeti. Če se s spremembami ne strinjate, lahko storitev prenehate uporabljati in zahtevate vračilo kupnine za neunovčene licenčne ključe."
					: "Za nadaljnjo uporabo storitve vam ni treba storiti ničesar.",
			],
		},
		en: {
			subject: terms ? "Changes to the Terms of Service" : "Changes to the Privacy Policy",
			paragraphs: [
				"Hello,",
				terms
					? `${operator} will apply version ${version} of the Terms of Service for ${url} from ${formatLegalDate("en", effective)}.`
					: `${operator} will apply version ${version} of the Privacy Policy for ${url} from ${formatLegalDate("en", effective)}.`,
				`You can read the new version at ${link}`,
				terms
					? "You will need to accept it the next time you sign in after that date. If you do not agree, you may stop using the service and request a refund of unredeemed license keys."
					: "You do not need to do anything to keep using the service.",
			],
		},
	};
}

function render(document: LegalDocumentRow): { subject: string; text: string; html: string } {
	const { sl, en } = noticeText(document);
	const text = [...sl.paragraphs, "", "---", "", ...en.paragraphs].join("\n\n");
	const html = [...sl.paragraphs, null, ...en.paragraphs].map((paragraph) => (paragraph === null ? "<hr>" : `<p>${escapeHtml(paragraph)}</p>`)).join("\n");
	return { subject: `${sl.subject} | ${en.subject}`, text, html };
}

export async function notifyAccounts(document: LegalDocumentRow): Promise<number | null> {
	if (!isEnabled()) return null;

	const recipients = (await Database`SELECT email FROM accounts WHERE status = 'active' ORDER BY created ASC`) as { email: string }[];
	const message = render(document);
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
