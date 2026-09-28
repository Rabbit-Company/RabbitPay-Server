import Database from "../database/database";
import Utils from "../utils";
import { Logger } from "../logger";
import { canEmail } from "../email/mailer";
import { deliverSoon, queueEmail } from "../email/outbox";
import { brandFor } from "../email/messages";
import { fiscalAlertEmail, type FiscalAlertLine } from "../email/templates";
import type { FiscalAlert, FiscalDocumentRow, ProjectRow } from "../database/models";

export const DUE_SOON_MS = 24 * 60 * 60 * 1000;

type AlertCandidate = Pick<FiscalDocumentRow, "uuid" | "project" | "status" | "deadline" | "error_code" | "last_error" | "alerted"> & {
	reference: string | null;
	premise_id: string;
	device_id: string;
	invoice_number: string;
};

export function alertFor(document: Pick<FiscalDocumentRow, "status" | "deadline" | "alerted">, now: number): FiscalAlert | null {
	if (document.status === "rejected") return document.alerted === "rejected" ? null : "rejected";
	if (document.status === "pending" && document.deadline - now <= DUE_SOON_MS) return document.alerted === null ? "deadline" : null;
	return null;
}

function lineFor(document: AlertCandidate, now: number): FiscalAlertLine {
	return {
		reference: document.reference ?? `${document.premise_id}-${document.device_id}-${document.invoice_number}`,
		problem: document.status === "rejected" ? "rejected" : document.deadline < now ? "late" : "due",
		code: document.error_code,
		message: document.last_error,
		deadline: document.deadline,
	};
}

async function ownerEmails(projectId: string): Promise<{ member: string; email: string }[]> {
	return (await Database`
		SELECT pm.uuid AS member, a.email FROM project_members pm
		JOIN accounts a ON a.username = pm.account_username
		WHERE pm.project_id = ${projectId} AND pm.role = 'owner' AND pm.status = 'active' AND a.status = 'active'
		ORDER BY pm.created ASC
	`) as { member: string; email: string }[];
}

export async function sendFiscalAlerts(now = Date.now()): Promise<{ projects: number; documents: number }> {
	const candidates = (await Database`
		SELECT d.uuid, d.project, d.status, d.deadline, d.error_code, d.last_error, d.alerted, d.premise_id, d.device_id, d.invoice_number,
			COALESCE(i.reference, c.reference) AS reference
		FROM fiscal_documents d
		JOIN projects p ON p.uuid = d.project
		LEFT JOIN invoices i ON i.uuid = d.invoice
		LEFT JOIN credit_notes c ON c.uuid = d.credit_note
		WHERE d.environment = 'production' AND p.status != 'deleted'
			AND ((d.status = 'rejected' AND (d.alerted IS NULL OR d.alerted != 'rejected'))
				OR (d.status = 'pending' AND d.alerted IS NULL AND d.deadline <= ${now + DUE_SOON_MS}))
		ORDER BY d.project, d.deadline ASC
	`) as AlertCandidate[];

	const byProject = new Map<string, { document: AlertCandidate; alert: FiscalAlert }[]>();
	for (const document of candidates) {
		const alert = alertFor(document, now);
		if (!alert) continue;
		const list = byProject.get(document.project) ?? [];
		list.push({ document, alert });
		byProject.set(document.project, list);
	}

	let projects = 0;
	let documents = 0;
	for (const [projectId, entries] of byProject) {
		const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${projectId}`) as ProjectRow[];
		if (!project || !canEmail(project)) continue;

		const owners = await ownerEmails(projectId);
		if (owners.length === 0) {
			Logger.warn(`[FURS] ${entries.length} invoices on ${projectId} need attention but the project has no owner to tell`);
			continue;
		}

		const brand = await brandFor(project, "team");
		const content = fiscalAlertEmail(
			brand,
			entries.map((entry) => lineFor(entry.document, now)),
			`${Utils.publicUrl()}/projects/${projectId}/settings#fiscal`
		);

		await Database.begin(async (tx) => {
			for (const owner of owners) {
				await queueEmail(tx, {
					project: projectId,
					member: owner.member,
					kind: "fiscal_alert",
					to: owner.email,
					senderName: brand.merchant,
					replyTo: null,
					...content,
					sentBy: null,
				});
			}
			for (const entry of entries) {
				await tx`UPDATE fiscal_documents SET alerted = ${entry.alert} WHERE uuid = ${entry.document.uuid}`;
			}
		});

		Logger.warn(`[FURS] Told ${owners.length} owners of ${projectId} about ${entries.length} invoices that need attention`);
		projects++;
		documents += entries.length;
	}

	if (projects > 0) deliverSoon();
	return { projects, documents };
}
