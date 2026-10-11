import Database from "./database/database";
import { releaseProjectDomain } from "./store/domains";
import TwoFactor from "./two-factor";
import type { AccountRow } from "./database/models";

export interface ProjectReference {
	uuid: string;
	name: string;
}

export interface DeletionPlan {
	shared: ProjectReference[];
	closing: ProjectReference[];
}

interface OwnedProject {
	uuid: string;
	name: string;
	owners: number;
	members: number;
}

const iso = (timestamp: number | string | null) => (timestamp === null ? null : new Date(Number(timestamp)).toISOString());

export async function deletionPlan(username: string): Promise<DeletionPlan> {
	const owned = (await Database`
		SELECT p.uuid, p.name,
			(SELECT COUNT(*) FROM project_members o WHERE o.project_id = p.uuid AND o.status = 'active' AND o.role = 'owner'
				AND o.account_username IS NOT NULL AND o.account_username != ${username}) AS owners,
			(SELECT COUNT(*) FROM project_members o WHERE o.project_id = p.uuid AND o.status = 'active'
				AND o.account_username IS NOT NULL AND o.account_username != ${username}) AS members
		FROM project_members pm JOIN projects p ON p.uuid = pm.project_id
		WHERE pm.account_username = ${username} AND pm.status = 'active' AND pm.role = 'owner' AND p.status != 'deleted'
		ORDER BY p.name ASC
	`) as OwnedProject[];

	const reference = (project: OwnedProject) => ({ uuid: project.uuid, name: project.name });
	return {
		shared: owned.filter((project) => Number(project.owners) === 0 && Number(project.members) > 0).map(reference),
		closing: owned.filter((project) => Number(project.members) === 0).map(reference),
	};
}

export async function deleteAccount(username: string, plan: DeletionPlan): Promise<void> {
	const timestamp = Date.now();
	await Database.begin(async (tx) => {
		for (const project of plan.closing) {
			await tx`UPDATE projects SET status = 'deleted', updated = ${timestamp} WHERE uuid = ${project.uuid}`;
		}
		await tx`
			UPDATE project_members SET account_username = NULL, status = 'removed', invitation_token = NULL, updated = ${timestamp}
			WHERE account_username = ${username}
		`;
		await tx`UPDATE audit_log SET ip_address = NULL, user_agent = NULL WHERE account = ${username}`;
		await tx`DELETE FROM accounts WHERE username = ${username}`;
	});
	for (const project of plan.closing) await releaseProjectDomain(project.uuid);
}

export async function exportAccount(account: AccountRow) {
	const username = account.username;
	const [keys, acceptances, memberships, accessLogs, auditEntries, notificationChoices, pushDevices] = await Promise.all([
		TwoFactor.securityKeys(username),
		Database`SELECT kind, version, accepted, ip_address, user_agent FROM legal_acceptances WHERE account_username = ${username} ORDER BY accepted ASC`,
		Database`
			SELECT p.uuid, p.name, pm.role, pm.status, pm.full_name, pm.accepted_at, pm.created
			FROM project_members pm JOIN projects p ON p.uuid = pm.project_id
			WHERE pm.account_username = ${username} ORDER BY pm.created ASC
		`,
		Database`
			SELECT created, action, project_id, resource_type, resource_id, granted, ip_address, user_agent
			FROM access_logs WHERE account_username = ${username} ORDER BY created ASC
		`,
		Database`
			SELECT created, action, project, entity_type, entity_id, ip_address, user_agent
			FROM audit_log WHERE account = ${username} ORDER BY created ASC
		`,
		Database`SELECT kind, channel, enabled, updated FROM notification_preferences WHERE account = ${username} ORDER BY kind ASC, channel ASC`,
		Database`SELECT endpoint, language, user_agent, created, updated FROM push_subscriptions WHERE account = ${username} ORDER BY created ASC`,
	]);

	return {
		exported_at: new Date().toISOString(),
		notice:
			"Personal data we hold about this account. Business records in projects, such as invoices and customers, belong to the project and can be exported from the project itself.",
		account: {
			username,
			email: account.email,
			status: account.status,
			administrator: Number(account.admin) === 1,
			created: iso(account.created),
			updated: iso(account.updated),
			last_seen: iso(account.accessed),
			two_factor: {
				enabled: account.two_factor_secret !== null,
				authenticator_app: TwoFactor.hasAuthenticator(account.two_factor_secret),
				security_keys: keys.map((key) => ({ name: key.name, created: iso(key.created), last_used: iso(key.last_used) })),
			},
		},
		legal_acceptances: (acceptances as { kind: string; version: number; accepted: number; ip_address: string | null; user_agent: string | null }[]).map(
			(row) => ({ document: row.kind, version: Number(row.version), accepted: iso(row.accepted), ip_address: row.ip_address, user_agent: row.user_agent })
		),
		notification_choices: (notificationChoices as { kind: string; channel: string; enabled: number; updated: number }[]).map((row) => ({
			notification: row.kind,
			channel: row.channel,
			enabled: Number(row.enabled) === 1,
			changed: iso(row.updated),
		})),
		push_devices: (pushDevices as { endpoint: string; language: string; user_agent: string | null; created: number; updated: number }[]).map((row) => ({
			push_service: new URL(row.endpoint).host,
			user_agent: row.user_agent,
			language: row.language,
			registered: iso(row.created),
			last_registered: iso(row.updated),
		})),
		project_memberships: (
			memberships as { uuid: string; name: string; role: string; status: string; full_name: string | null; accepted_at: number | null; created: number }[]
		).map((row) => ({
			project: row.uuid,
			project_name: row.name,
			role: row.role,
			status: row.status,
			full_name: row.full_name,
			joined: iso(row.accepted_at ?? row.created),
		})),
		access_log: (
			accessLogs as {
				created: number;
				action: string;
				project_id: string | null;
				resource_type: string | null;
				resource_id: string | null;
				granted: number | null;
				ip_address: string | null;
				user_agent: string | null;
			}[]
		).map((row) => ({
			time: iso(row.created),
			action: row.action,
			project: row.project_id,
			resource: row.resource_type ? `${row.resource_type}${row.resource_id ? `:${row.resource_id}` : ""}` : null,
			granted: row.granted === null ? null : Number(row.granted) === 1,
			ip_address: row.ip_address,
			user_agent: row.user_agent,
		})),
		changes_made: (
			auditEntries as {
				created: number;
				action: string;
				project: string | null;
				entity_type: string | null;
				entity_id: string | null;
				ip_address: string | null;
				user_agent: string | null;
			}[]
		).map((row) => ({
			time: iso(row.created),
			action: row.action,
			project: row.project,
			record: row.entity_type ? `${row.entity_type}${row.entity_id ? `:${row.entity_id}` : ""}` : null,
			ip_address: row.ip_address,
			user_agent: row.user_agent,
		})),
	};
}

export function exportResponse(data: unknown, email: string): Response {
	return new Response(JSON.stringify(data, null, 2), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Disposition": `attachment; filename="rabbitpay-${email.replace(/[^a-zA-Z0-9.@_-]/g, "_")}-data.json"`,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
