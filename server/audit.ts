import type { Context } from "@rabbit-company/web";
import Database from "./database/database";
import Utils from "./utils";
import { Logger } from "./logger";
import type { AppState } from "./database/models";

export interface AuditEntry {
	project?: string | null;
	action: string;
	entityType?: string;
	entityId?: string;
	oldValue?: unknown;
	newValue?: unknown;
}

export default class Audit {
	static async record(ctx: Context<AppState>, entry: AuditEntry) {
		try {
			const account = ctx.get("account");

			await Database`
				INSERT INTO audit_log(uuid, project, account, action, entity_type, entity_id, old_value, new_value, ip_address, user_agent, created)
				VALUES(
					${crypto.randomUUID()},
					${entry.project ?? null},
					${account?.username ?? null},
					${entry.action},
					${entry.entityType ?? null},
					${entry.entityId ?? null},
					${entry.oldValue === undefined ? null : JSON.stringify(entry.oldValue)},
					${entry.newValue === undefined ? null : JSON.stringify(entry.newValue)},
					${Utils.clientIp(ctx)},
					${Utils.userAgent(ctx)},
					${Date.now()}
				)
			`;
		} catch (err) {
			Logger.error(`[AUDIT] Failed to record "${entry.action}": ${err}`);
		}
	}
}
