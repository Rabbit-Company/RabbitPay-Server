import type { SQL } from "bun";
import Database from "./database/database";
import { Settings } from "./settings";
import { ErrorCode } from "./errors";
import type { RegistrationMode } from "./settings-schema";
import type { RegistrationInviteRow } from "./database/models";

export const MAX_INVITE_USES = 100_000;

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_GROUPS = 3;
const CODE_GROUP_LENGTH = 5;
const CODE_PREFIX = "JOIN";

export type RegistrationGrant =
	| { kind: "first" }
	| { kind: "open" }
	| { kind: "invite"; invite: RegistrationInviteRow }
	| { kind: "project_invitation"; member: string };

export class RegistrationRefused extends Error {
	constructor(readonly code: ErrorCode) {
		super(`Registration refused with ${code}`);
	}
}

export function generateInviteCode(): string {
	const bytes = new Uint8Array(CODE_GROUPS * CODE_GROUP_LENGTH);
	crypto.getRandomValues(bytes);

	const characters = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
	const groups: string[] = [];
	for (let index = 0; index < characters.length; index += CODE_GROUP_LENGTH) {
		groups.push(characters.slice(index, index + CODE_GROUP_LENGTH).join(""));
	}
	return `${CODE_PREFIX}-${groups.join("-")}`;
}

export function normalizeInviteCode(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const compact = value.toUpperCase().replace(/[\s-]/g, "");
	if (!compact.startsWith(CODE_PREFIX)) return null;

	const body = compact.slice(CODE_PREFIX.length).replace(/[IL]/g, "1").replace(/O/g, "0");
	if (body.length !== CODE_GROUPS * CODE_GROUP_LENGTH || [...body].some((character) => !CODE_ALPHABET.includes(character))) return null;

	const groups: string[] = [];
	for (let index = 0; index < body.length; index += CODE_GROUP_LENGTH) groups.push(body.slice(index, index + CODE_GROUP_LENGTH));
	return `${CODE_PREFIX}-${groups.join("-")}`;
}

export type InviteState = "active" | "used_up" | "expired" | "revoked";

export function inviteState(invite: RegistrationInviteRow, now = Date.now()): InviteState {
	if (invite.status === "revoked") return "revoked";
	if (invite.max_uses !== null && Number(invite.uses) >= Number(invite.max_uses)) return "used_up";
	if (invite.expires_at !== null && Number(invite.expires_at) <= now) return "expired";
	return "active";
}

export function presentInvite(invite: RegistrationInviteRow) {
	return {
		uuid: invite.uuid,
		code: invite.code,
		max_uses: invite.max_uses === null ? null : Number(invite.max_uses),
		uses: Number(invite.uses),
		expires_at: invite.expires_at === null ? null : Number(invite.expires_at),
		note: invite.note,
		state: inviteState(invite),
		created_by: invite.created_by,
		revoked_at: invite.revoked_at,
		created: invite.created,
		updated: invite.updated,
	};
}

export async function createInvite(details: { max_uses: number | null; expires_at: number | null; note: string | null }, createdBy: string) {
	const uuid = crypto.randomUUID();
	const timestamp = Date.now();
	await Database`
		INSERT INTO registration_invites(uuid, code, max_uses, uses, expires_at, note, status, created_by, created, updated)
		VALUES(${uuid}, ${generateInviteCode()}, ${details.max_uses}, 0, ${details.expires_at}, ${details.note}, 'active', ${createdBy}, ${timestamp}, ${timestamp})
	`;
	const [created] = (await Database`SELECT * FROM registration_invites WHERE uuid = ${uuid}`) as RegistrationInviteRow[];
	return created;
}

async function accountCount(sql: SQL): Promise<number> {
	const [row] = (await sql`SELECT COUNT(*) AS count FROM accounts`) as { count: number }[];
	return Number(row.count);
}

function limitReached(accounts: number): boolean {
	const limit = Settings.registrations.max_accounts;
	return limit > 0 && accounts >= limit;
}

export async function registrationMode(): Promise<RegistrationMode> {
	const accounts = await accountCount(Database);
	if (accounts === 0) return "open";
	if (limitReached(accounts)) return "closed";
	return Settings.registrations.mode;
}

function isInvitationToken(token: unknown): token is string {
	return typeof token === "string" && /^[A-Za-z0-9]{64}$/.test(token);
}

async function findProjectInvitation(token: unknown, email: string): Promise<string | null> {
	if (!isInvitationToken(token)) return null;
	const [invitation] = (await Database`
		SELECT pm.uuid FROM project_members pm
		JOIN projects p ON p.uuid = pm.project_id
		WHERE pm.invitation_token = ${token} AND pm.status = 'pending' AND p.status != 'deleted'
			AND LOWER(pm.invitation_email) = ${email.toLowerCase()}
			AND (pm.expires_at IS NULL OR pm.expires_at > ${Date.now()})
	`) as { uuid: string }[];
	return invitation?.uuid ?? null;
}

async function findUsableInvite(code: string): Promise<RegistrationInviteRow | null> {
	const [invite] = (await Database`SELECT * FROM registration_invites WHERE code = ${code}`) as RegistrationInviteRow[];
	return invite && inviteState(invite) === "active" ? invite : null;
}

export async function registrationGrant(request: { email: string; invite?: unknown; invitation?: unknown }): Promise<RegistrationGrant | ErrorCode> {
	const accounts = await accountCount(Database);
	if (accounts === 0) return { kind: "first" };
	if (limitReached(accounts)) return ErrorCode.REGISTRATION_LIMIT_REACHED;

	const mode = Settings.registrations.mode;
	if (mode === "open") return { kind: "open" };
	if (mode === "closed") return ErrorCode.REGISTRATIONS_CLOSED;

	const member = await findProjectInvitation(request.invitation, request.email);
	if (member) return { kind: "project_invitation", member };

	if (request.invite === undefined || request.invite === null || request.invite === "") return ErrorCode.INVITE_CODE_REQUIRED;
	const code = normalizeInviteCode(request.invite);
	const invite = code ? await findUsableInvite(code) : null;
	if (!invite) return ErrorCode.INVALID_INVITE_CODE;
	return { kind: "invite", invite };
}

export async function claimRegistration(tx: SQL, grant: RegistrationGrant): Promise<{ admin: boolean }> {
	const accounts = await accountCount(tx);
	if (accounts === 0) return { admin: true };
	if (limitReached(accounts)) throw new RegistrationRefused(ErrorCode.REGISTRATION_LIMIT_REACHED);
	if (grant.kind === "first" && Settings.registrations.mode !== "open") throw new RegistrationRefused(ErrorCode.REGISTRATIONS_CLOSED);

	if (grant.kind === "invite") {
		const timestamp = Date.now();
		const claimed = await tx`
			UPDATE registration_invites SET uses = uses + 1, updated = ${timestamp}
			WHERE uuid = ${grant.invite.uuid} AND status = 'active'
				AND (max_uses IS NULL OR uses < max_uses)
				AND (expires_at IS NULL OR expires_at > ${timestamp})
		`;
		if (claimed.count === 0) throw new RegistrationRefused(ErrorCode.INVALID_INVITE_CODE);
	}

	return { admin: false };
}
