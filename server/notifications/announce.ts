import Database from "../database/database";
import Utils from "../utils";
import Permissions from "../permissions";
import { Logger } from "../logger";
import { Realtime } from "../realtime";
import { translator } from "../i18n";
import { canEmail } from "../email/mailer";
import { brandFor } from "../email/messages";
import { deliverSoon, queueEmail } from "../email/outbox";
import { noticeEmail, type EmailBrand, type NoticeContent } from "../email/templates";
import { workforceConfig } from "../workforce/config";
import type { Permission } from "../roles";
import type { EmailKind, ProjectMemberRow, ProjectRow } from "../database/models";
import { accountsWanting } from "./preferences";
import { pushTo } from "./push";
import { notificationSpec, WORKFORCE_GROUPS, type NotificationKind } from "./kinds";

export const NOTIFICATION_EVENT = "notification";

export interface NotificationMail {
	brand: EmailBrand;
	t: ReturnType<typeof translator>;
	url: string;
}

export interface Announcement {
	kind: NotificationKind;
	project: ProjectRow | string;
	accounts: Iterable<string | null>;
	variant?: string;
	params?: Record<string, string | number>;
	path: string;
	ttl?: number;
	email?: (mail: NotificationMail) => NoticeContent;
	ticket?: string | null;
	sentBy?: string | null;
}

async function projectOf(project: ProjectRow | string): Promise<ProjectRow | null> {
	if (typeof project !== "string") return project;
	const [row] = (await Database`SELECT * FROM projects WHERE uuid = ${project} AND status != 'deleted'`) as ProjectRow[];
	return row ?? null;
}

async function emailAllowed(project: ProjectRow, kind: NotificationKind): Promise<boolean> {
	if (!canEmail(project)) return false;
	if (!WORKFORCE_GROUPS.includes(notificationSpec(kind).group)) return true;
	return (await workforceConfig(project.uuid)).email_notifications;
}

async function sendEmails(project: ProjectRow, announcement: Announcement, usernames: string[], url: string) {
	if (!announcement.email || usernames.length === 0 || !(await emailAllowed(project, announcement.kind))) return;
	const wanting = await accountsWanting(announcement.kind, "email", usernames);
	if (wanting.length === 0) return;
	const recipients = (await Database`
		SELECT a.email, pm.uuid AS member FROM accounts a
		JOIN project_members pm ON pm.account_username = a.username AND pm.project_id = ${project.uuid}
		WHERE a.username IN ${Database(wanting)} AND a.status = 'active' AND pm.status = 'active'
	`) as { email: string; member: string }[];
	if (recipients.length === 0) return;

	const brand = await brandFor(project, "team");
	const email = noticeEmail(brand, announcement.email({ brand, t: translator(brand.language), url }));
	for (const recipient of new Map(recipients.map((recipient) => [recipient.email.toLowerCase(), recipient])).values()) {
		await queueEmail(Database, {
			project: project.uuid,
			ticket: announcement.ticket ?? null,
			member: recipient.member,
			kind: announcement.kind as EmailKind,
			to: recipient.email,
			senderName: brand.merchant,
			replyTo: brand.replyTo,
			...email,
			sentBy: announcement.sentBy ?? null,
		});
	}
	deliverSoon();
}

export async function announce(announcement: Announcement) {
	try {
		const project = await projectOf(announcement.project);
		if (!project) return;
		const usernames = [...new Set([...announcement.accounts].filter((username): username is string => typeof username === "string" && username !== ""))];
		if (usernames.length === 0) return;

		const inBrowser = await accountsWanting(announcement.kind, "browser", usernames);
		if (inBrowser.length > 0) {
			const notice = {
				id: crypto.randomUUID(),
				kind: announcement.kind,
				variant: announcement.variant ?? null,
				project: project.uuid,
				project_name: project.name,
				params: announcement.params ?? {},
				path: announcement.path,
			};
			Realtime.send(inBrowser, { type: NOTIFICATION_EVENT, ...notice });
			void pushTo(inBrowser, { ...notice, ttl: announcement.ttl });
		}
		await sendEmails(project, announcement, usernames, `${Utils.publicUrl()}${announcement.path}`);
	} catch (error) {
		Logger.error(`[NOTIFICATIONS] Could not send the ${announcement.kind} notification: ${error}`);
	}
}

export async function activeMembers(projectId: string): Promise<ProjectMemberRow[]> {
	const members = (await Database`SELECT * FROM project_members WHERE project_id = ${projectId} AND status = 'active'`) as ProjectMemberRow[];
	return members.filter(Permissions.isActive);
}

export async function accountsWith(projectId: string, permission: Permission, except: string | null = null): Promise<string[]> {
	return (await activeMembers(projectId))
		.filter((member) => Permissions.has(member, permission) && member.account_username !== null && member.account_username !== except)
		.map((member) => member.account_username!);
}

export async function ownerAccounts(projectId: string): Promise<string[]> {
	return (await activeMembers(projectId))
		.filter((member) => member.role === "owner" && member.account_username !== null)
		.map((member) => member.account_username!);
}
