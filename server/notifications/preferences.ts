import Database from "../database/database";
import Permissions from "../permissions";
import { canEmail, isEnabled as emailEnabled } from "../email/mailer";
import type { ProjectMemberRow, ProjectRow } from "../database/models";
import {
	channelDefault,
	channelEnabled,
	channelLocked,
	NOTIFICATION_CHANNELS,
	NOTIFICATION_KIND_NAMES,
	notificationSpec,
	offersChannel,
	type NotificationChannel,
	type NotificationGroup,
	type NotificationKind,
} from "./kinds";

interface PreferenceRow {
	account: string;
	kind: string;
	channel: string;
	enabled: number;
}

export interface ChannelPreference {
	enabled: boolean;
	default: boolean;
	locked: boolean;
}

export interface NotificationPreference {
	kind: NotificationKind;
	group: NotificationGroup;
	relevant: boolean;
	browser: ChannelPreference;
	email: ChannelPreference | null;
}

export async function accountsWanting(kind: NotificationKind, channel: NotificationChannel, usernames: Iterable<string>): Promise<string[]> {
	const wanted = [...new Set(usernames)];
	if (wanted.length === 0 || !offersChannel(kind, channel)) return [];
	if (channelLocked(kind, channel)) return wanted;
	const rows = (await Database`
		SELECT account, enabled FROM notification_preferences WHERE kind = ${kind} AND channel = ${channel} AND account IN ${Database(wanted)}
	`) as Pick<PreferenceRow, "account" | "enabled">[];
	const chosen = new Map(rows.map((row) => [row.account, Number(row.enabled) === 1]));
	return wanted.filter((username) => channelEnabled(kind, channel, chosen.get(username)));
}

async function activeMemberships(username: string): Promise<ProjectMemberRow[]> {
	const rows = (await Database`
		SELECT pm.* FROM project_members pm JOIN projects p ON p.uuid = pm.project_id
		WHERE pm.account_username = ${username} AND pm.status = 'active' AND p.status != 'deleted'
	`) as ProjectMemberRow[];
	return rows.filter(Permissions.isActive);
}

function reaches(kind: NotificationKind, memberships: ProjectMemberRow[]): boolean {
	const audience = notificationSpec(kind).audience;
	if (audience === "owner") return memberships.some((member) => member.role === "owner");
	return memberships.some((member) => audience.some((permission) => Permissions.has(member, permission)));
}

export async function preferencesOf(username: string): Promise<NotificationPreference[]> {
	const rows = (await Database`SELECT kind, channel, enabled FROM notification_preferences WHERE account = ${username}`) as PreferenceRow[];
	const chosen = new Map(rows.map((row) => [`${row.kind}:${row.channel}`, Number(row.enabled) === 1]));
	const memberships = await activeMemberships(username);
	const present = (kind: NotificationKind, channel: NotificationChannel): ChannelPreference | null =>
		offersChannel(kind, channel)
			? {
					enabled: channelEnabled(kind, channel, chosen.get(`${kind}:${channel}`)),
					default: channelDefault(kind, channel),
					locked: channelLocked(kind, channel),
				}
			: null;
	return NOTIFICATION_KIND_NAMES.map((kind) => ({
		kind,
		group: notificationSpec(kind).group,
		relevant: reaches(kind, memberships),
		browser: present(kind, "browser")!,
		email: present(kind, "email"),
	}));
}

export interface PreferenceChange {
	kind: NotificationKind;
	channel: NotificationChannel;
	enabled: boolean;
}

export async function savePreferences(username: string, changes: PreferenceChange[]) {
	const now = Date.now();
	await Database.begin(async (tx) => {
		for (const change of changes) {
			await tx`DELETE FROM notification_preferences WHERE account = ${username} AND kind = ${change.kind} AND channel = ${change.channel}`;
			if (change.enabled === channelDefault(change.kind, change.channel)) continue;
			await tx`
				INSERT INTO notification_preferences(account, kind, channel, enabled, updated)
				VALUES(${username}, ${change.kind}, ${change.channel}, ${change.enabled ? 1 : 0}, ${now})
			`;
		}
	});
}

export async function resetPreferences(username: string) {
	await Database`DELETE FROM notification_preferences WHERE account = ${username}`;
}

export function changeable(kind: NotificationKind, channel: NotificationChannel): boolean {
	return NOTIFICATION_CHANNELS.includes(channel) && offersChannel(kind, channel) && !channelLocked(kind, channel);
}

export async function canReceiveEmail(username: string): Promise<boolean> {
	if (emailEnabled()) return true;
	const projects = (await Database`
		SELECT p.* FROM projects p JOIN project_members pm ON pm.project_id = p.uuid
		WHERE pm.account_username = ${username} AND pm.status = 'active' AND p.status != 'deleted'
	`) as ProjectRow[];
	return projects.some(canEmail);
}
