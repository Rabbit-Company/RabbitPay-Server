import type { SQL } from "bun";
import Database from "../database/database";
import { Logger } from "../logger";
import type { ProjectRow } from "../database/models";

export type WebhookEvent =
	| "invoice.issued"
	| "invoice.paid"
	| "invoice.partially_paid"
	| "invoice.overdue"
	| "invoice.refunded"
	| "invoice.canceled"
	| "invoice.credited"
	| "payment.received"
	| "payment.confirmed"
	| "payment.refunded";

export interface WebhookDeliveryRow {
	uuid: string;
	project: string;
	event_type: string;
	target_url: string;
	payload: string;
	status: "pending" | "delivered" | "failed";
	attempts: number;
	response_status: number | null;
	last_error: string | null;
	next_attempt_at: number | null;
	created: number;
	updated: number;
	delivered_at: number | null;
}

export async function enqueue(sql: SQL, projectId: string, event: WebhookEvent, data: Record<string, unknown>): Promise<string | null> {
	try {
		const [project] = (await sql`SELECT webhook_url FROM projects WHERE uuid = ${projectId}`) as Pick<ProjectRow, "webhook_url">[];
		if (!project?.webhook_url) return null;

		const uuid = crypto.randomUUID();
		const timestamp = Date.now();

		const payload = JSON.stringify({
			id: uuid,
			event,
			project: projectId,
			created: timestamp,
			data,
		});

		await sql`
			INSERT INTO webhook_deliveries(uuid, project, event_type, target_url, payload, status, attempts, next_attempt_at, created, updated)
			VALUES(${uuid}, ${projectId}, ${event}, ${project.webhook_url}, ${payload}, 'pending', 0, ${timestamp}, ${timestamp}, ${timestamp})
		`;

		return uuid;
	} catch (err) {
		Logger.error(`[WEBHOOK] Could not queue ${event} for ${projectId}: ${err}`);
		return null;
	}
}

export function enqueueLater(projectId: string, event: WebhookEvent, data: Record<string, unknown>) {
	void enqueue(Database, projectId, event, data);
}
