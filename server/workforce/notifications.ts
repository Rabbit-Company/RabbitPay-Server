import Database from "../database/database";
import Utils from "../utils";
import Permissions from "../permissions";
import { Logger } from "../logger";
import { Permission } from "../roles";
import { translator, type TranslationKey } from "../i18n";
import { canEmail } from "../email/mailer";
import { brandFor } from "../email/messages";
import { deliverSoon, queueEmail } from "../email/outbox";
import { emailDate, noticeEmail, type EmailBrand, type NoticeContent } from "../email/templates";
import { workforceConfig } from "./config";
import { personName } from "./people";
import { recipientsOf, type PresentedMessage } from "./chat";
import { markdownText } from "../markdown";
import { accountsWanting } from "../notifications/preferences";
import { pushTo } from "../notifications/push";
import { formatDateTime, localeFor, type DateFormat, type TimeFormat } from "../formats";
import { accountsWith, activeMembers, announce } from "../notifications/announce";
import type {
	AbsenceRow,
	ChatConversationRow,
	EmailKind,
	ProjectMemberRow,
	ProjectRow,
	TicketCommentRow,
	TicketRow,
	TimesheetPeriodRow,
} from "../database/models";

interface Recipient {
	email: string;
	member: string | null;
}

async function loadProject(projectId: string): Promise<ProjectRow | null> {
	const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${projectId} AND status != 'deleted'`) as ProjectRow[];
	return project ?? null;
}

async function enabledProject(projectId: string): Promise<ProjectRow | null> {
	const project = await loadProject(projectId);
	if (!project || !canEmail(project)) return null;
	return (await workforceConfig(projectId)).email_notifications ? project : null;
}

async function deliver(
	project: ProjectRow,
	brand: EmailBrand,
	kind: EmailKind,
	recipients: Recipient[],
	content: NoticeContent,
	sentBy: string | null,
	ticket: string | null = null
) {
	const unique = [...new Map(recipients.map((recipient) => [recipient.email.toLowerCase(), recipient])).values()];
	if (unique.length === 0) return;
	const email = noticeEmail(brand, content);
	for (const recipient of unique) {
		await queueEmail(Database, {
			project: project.uuid,
			ticket,
			member: recipient.member,
			kind,
			to: recipient.email,
			senderName: brand.merchant,
			replyTo: brand.replyTo,
			...email,
			sentBy,
		});
	}
	deliverSoon();
}

async function safely(label: string, work: () => Promise<void>) {
	try {
		await work();
	} catch (error) {
		Logger.error(`[WORKFORCE] Could not send the ${label} notification: ${error}`);
	}
}

function portalUrl(ticket: TicketRow): string {
	return `${Utils.publicUrl()}/customer/tickets/${ticket.uuid}`;
}

async function customerOf(ticket: TicketRow): Promise<{ email: string; name: string } | null> {
	if (!ticket.customer || !ticket.customer_visible) return null;
	const [customer] = (await Database`
		SELECT c.email, c.name FROM customers c JOIN ticket_portal_access a ON a.customer = c.uuid WHERE c.uuid = ${ticket.customer}
	`) as { email: string | null; name: string | null }[];
	return customer?.email ? { email: customer.email, name: customer.name?.trim() || customer.email } : null;
}

export function notifyCustomerReply(ticket: TicketRow, author: string, body: string, actor: string) {
	return safely("ticket reply", async () => {
		const project = await enabledProject(ticket.project);
		const customer = await customerOf(ticket);
		if (!project || !customer) return;
		const brand = await brandFor(project, "customer");
		const t = translator(brand.language);
		const params = { number: ticket.number, title: ticket.title, merchant: brand.merchant, author };
		await deliver(
			project,
			brand,
			"ticket_reply",
			[{ email: customer.email, member: null }],
			{
				subject: t("email.ticket.reply_subject", params),
				heading: t("email.ticket.reply_heading", params),
				paragraphs: [t("email.ticket.reply_intro", params)],
				note: { title: t("email.ticket.message"), body },
				button: { label: t("email.ticket.open_portal"), url: portalUrl(ticket) },
				closing: [t("email.ticket.portal_closing")],
			},
			actor,
			ticket.uuid
		);
	});
}

export function notifyCustomerStatus(ticket: TicketRow, actor: string) {
	return safely("ticket status", async () => {
		const project = await enabledProject(ticket.project);
		const customer = await customerOf(ticket);
		if (!project || !customer) return;
		const brand = await brandFor(project, "customer");
		const t = translator(brand.language);
		const params = {
			number: ticket.number,
			title: ticket.title,
			merchant: brand.merchant,
			status: t(`email.ticket.status_${ticket.status}` as TranslationKey),
		};
		await deliver(
			project,
			brand,
			"ticket_status",
			[{ email: customer.email, member: null }],
			{
				subject: t("email.ticket.status_subject", params),
				heading: t("email.ticket.status_heading"),
				paragraphs: [t("email.ticket.status_intro", params)],
				button: { label: t("email.ticket.open_portal"), url: portalUrl(ticket) },
				closing: [t("email.ticket.portal_closing")],
			},
			actor,
			ticket.uuid
		);
	});
}

function ticketPath(ticket: TicketRow): string {
	return `/projects/${ticket.project}/tickets/${ticket.uuid}`;
}

async function ticketTeam(ticket: TicketRow): Promise<ProjectMemberRow[]> {
	const members = await activeMembers(ticket.project);
	const assigned = (await Database`SELECT member FROM ticket_assignees WHERE ticket = ${ticket.uuid}`) as { member: string }[];
	const assignees = members.filter((member) => assigned.some((row) => row.member === member.uuid));
	return assignees.length ? assignees : members.filter((member) => Permissions.has(member, Permission.TICKET_MANAGE));
}

function accountsOf(members: ProjectMemberRow[], except: string | null = null): string[] {
	return members.map((member) => member.account_username).filter((username): username is string => username !== null && username !== except);
}

export async function notifyTeamOfCustomer(ticket: TicketRow, activity: "created" | "comment", body: string | null) {
	const [customer] = ticket.customer
		? ((await Database`SELECT email, name FROM customers WHERE uuid = ${ticket.customer}`) as { email: string; name: string | null }[])
		: [];
	const created = activity === "created";
	const name = customer?.name?.trim() || customer?.email || "";
	await announce({
		kind: "ticket_customer",
		variant: activity,
		project: ticket.project,
		accounts: accountsOf(await ticketTeam(ticket)),
		params: { number: ticket.number, title: ticket.title, customer: name },
		path: ticketPath(ticket),
		ticket: ticket.uuid,
		email: ({ t, url }) => {
			const params = { number: ticket.number, title: ticket.title, customer: name, kind: t(`email.ticket.kind_${ticket.kind}` as TranslationKey) };
			return {
				subject: t(created ? "email.ticket.created_subject" : "email.ticket.customer_subject", params),
				heading: t(created ? "email.ticket.created_heading" : "email.ticket.customer_heading", params),
				paragraphs: [t(created ? "email.ticket.created_intro" : "email.ticket.customer_intro", params)],
				note: body ? { title: t(created ? "email.ticket.description" : "email.ticket.message"), body } : null,
				button: { label: t("email.ticket.open_team"), url },
			};
		},
	});
}

export async function notifyAssigned(ticket: TicketRow, members: string[], actor: ProjectMemberRow) {
	if (members.length === 0) return;
	const assigned = (await activeMembers(ticket.project)).filter((member) => members.includes(member.uuid));
	await announce({
		kind: "ticket_assigned",
		project: ticket.project,
		accounts: accountsOf(assigned, actor.account_username),
		params: { number: ticket.number, title: ticket.title, actor: personName(actor) },
		path: ticketPath(ticket),
		ticket: ticket.uuid,
		sentBy: actor.account_username,
		email: ({ brand, t, url }) => {
			const params = { number: ticket.number, title: ticket.title, merchant: brand.merchant, actor: personName(actor) };
			return {
				subject: t("email.ticket.assigned_subject", params),
				heading: t("email.ticket.assigned_heading"),
				paragraphs: [t("email.ticket.assigned_intro", params)],
				note: ticket.description ? { title: t("email.ticket.description"), body: ticket.description } : null,
				button: { label: t("email.ticket.open_team"), url },
			};
		},
	});
}

export async function notifyTicketComment(ticket: TicketRow, comment: Pick<TicketCommentRow, "body">, actor: ProjectMemberRow) {
	const author = personName(actor);
	await announce({
		kind: "ticket_comment",
		project: ticket.project,
		accounts: accountsOf(await ticketTeam(ticket), actor.account_username),
		params: { number: ticket.number, title: ticket.title, author },
		path: ticketPath(ticket),
		ticket: ticket.uuid,
		sentBy: actor.account_username,
		email: ({ t, url }) => {
			const params = { number: ticket.number, title: ticket.title, author };
			return {
				subject: t("email.notify.ticket_comment_subject", params),
				heading: t("email.notify.ticket_comment_heading"),
				paragraphs: [t("email.notify.ticket_comment_intro", params)],
				note: { title: t("email.ticket.message"), body: comment.body },
				button: { label: t("email.ticket.open_team"), url },
			};
		},
	});
}

function absenceDates(absence: AbsenceRow, brand: EmailBrand) {
	const format = (date: string) => {
		const [year, month, day] = date.split("-").map(Number);
		return emailDate(Date.UTC(year, month - 1, day), { ...brand, timezone: "UTC" });
	};
	return { from: format(absence.starts_on), to: format(absence.ends_on) };
}

export async function notifyAbsenceRequested(absence: AbsenceRow, workingDays: number | null) {
	const approvers = (await activeMembers(absence.project)).filter(
		(member) => Permissions.has(member, Permission.TIMESHEET_EDIT) && member.uuid !== absence.member
	);
	await announce({
		kind: "absence_requested",
		project: absence.project,
		accounts: accountsOf(approvers),
		params: { person: absence.person, starts_on: absence.starts_on, ends_on: absence.ends_on },
		path: `/projects/${absence.project}/timesheet/absences`,
		sentBy: absence.created_by,
		email: ({ brand, t, url }) => {
			const params = {
				person: absence.person,
				kind: t(`email.absence.kind_${absence.kind}` as TranslationKey),
				days: workingDays ?? "",
				...absenceDates(absence, brand),
			};
			return {
				subject: t("email.absence.requested_subject", params),
				heading: t("email.absence.requested_heading"),
				paragraphs: [t("email.absence.requested_intro", params)],
				note: absence.note ? { title: t("email.absence.note"), body: absence.note } : null,
				button: { label: t("email.absence.requested_button"), url },
			};
		},
	});
}

export async function notifyAbsenceDecided(absence: AbsenceRow, actor: ProjectMemberRow) {
	if (!absence.member || absence.member === actor.uuid || (absence.status !== "approved" && absence.status !== "rejected")) return;
	const decision = absence.status;
	const employee = (await activeMembers(absence.project)).filter((member) => member.uuid === absence.member);
	await announce({
		kind: "absence_decided",
		variant: decision,
		project: absence.project,
		accounts: accountsOf(employee),
		params: { actor: personName(actor), starts_on: absence.starts_on, ends_on: absence.ends_on },
		path: `/projects/${absence.project}/timesheet/absences`,
		sentBy: actor.account_username,
		email: ({ brand, t, url }) => {
			const params = { actor: personName(actor), kind: t(`email.absence.kind_${absence.kind}` as TranslationKey), ...absenceDates(absence, brand) };
			return {
				subject: t(`email.absence.${decision}_subject`, params),
				heading: t(`email.absence.${decision}_heading`),
				paragraphs: [t(`email.absence.${decision}_intro`, params)],
				note: absence.decision_note ? { title: t("email.absence.note"), body: absence.decision_note } : null,
				button: { label: t("email.absence.open"), url },
			};
		},
	});
}

function monthName(period: string, language: string): string {
	const [year, month] = period.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(localeFor(language), { month: "long", year: "numeric", timeZone: "UTC" });
}

function timesheetPath(project: string): string {
	return `/projects/${project}/timesheet`;
}

export async function notifyTimesheetSubmitted(period: Pick<TimesheetPeriodRow, "project" | "period">, employee: ProjectMemberRow) {
	const person = personName(employee);
	await announce({
		kind: "timesheet_submitted",
		project: period.project,
		accounts: await accountsWith(period.project, Permission.TIMESHEET_EDIT, employee.account_username),
		params: { person, period: period.period },
		path: timesheetPath(period.project),
		sentBy: employee.account_username,
		email: ({ brand, t, url }) => {
			const params = { person, period: monthName(period.period, brand.language) };
			return {
				subject: t("email.notify.timesheet_submitted_subject", params),
				heading: t("email.notify.timesheet_submitted_heading"),
				paragraphs: [t("email.notify.timesheet_submitted_intro", params)],
				button: { label: t("email.notify.review_timesheet"), url },
			};
		},
	});
}

export async function notifyTimesheetDecided(
	period: Pick<TimesheetPeriodRow, "project" | "period">,
	employee: ProjectMemberRow,
	decision: "approved" | "returned",
	note: string | null,
	actor: ProjectMemberRow
) {
	if (employee.uuid === actor.uuid) return;
	await announce({
		kind: "timesheet_decided",
		variant: decision,
		project: period.project,
		accounts: accountsOf(Permissions.isActive(employee) ? [employee] : []),
		params: { actor: personName(actor), period: period.period },
		path: timesheetPath(period.project),
		sentBy: actor.account_username,
		email: ({ brand, t, url }) => {
			const params = { actor: personName(actor), period: monthName(period.period, brand.language) };
			return {
				subject: t(`email.notify.timesheet_${decision}_subject`, params),
				heading: t(`email.notify.timesheet_${decision}_heading`),
				paragraphs: [t(`email.notify.timesheet_${decision}_intro`, params)],
				note: note ? { title: t("email.absence.note"), body: note } : null,
				button: { label: t("email.absence.open"), url },
			};
		},
	});
}

function meetingTime(startsAt: number, project: ProjectRow): string {
	return formatDateTime(startsAt, project.date_format as DateFormat, project.time_format as TimeFormat, project.timezone);
}

export async function notifyMeeting(
	conversation: Pick<ChatConversationRow, "uuid" | "project" | "name">,
	change: "scheduled" | "moved" | "cancelled",
	startsAt: number,
	actor: ProjectMemberRow
) {
	const project = await loadProject(conversation.project);
	if (!project) return;
	const title = conversation.name ?? "";
	const accounts = (await recipientsOf(conversation)).filter((username) => username !== actor.account_username);
	await announce({
		kind: "meeting_scheduled",
		variant: change,
		project,
		accounts,
		params: { title, actor: personName(actor), starts_at: startsAt },
		path: change === "cancelled" ? `/projects/${project.uuid}/calendar` : `/projects/${project.uuid}/chat/${conversation.uuid}`,
		sentBy: actor.account_username,
		email: ({ t, url }) => {
			const params = { title, actor: personName(actor), time: meetingTime(startsAt, project) };
			return {
				subject: t(`email.notify.meeting_${change}_subject`, params),
				heading: t(`email.notify.meeting_${change}_heading`),
				paragraphs: [t(`email.notify.meeting_${change}_intro`, params)],
				button: { label: t(change === "cancelled" ? "email.notify.open_calendar" : "email.notify.open_meeting"), url },
			};
		},
	});
}

const REMINDER_PUSH_SECONDS = 10 * 60;
const CHAT_PREVIEW_LENGTH = 120;

export async function pushChatMessage(conversation: Pick<ChatConversationRow, "uuid" | "project">, message: PresentedMessage, recipients: string[]) {
	if (message.deleted || message.body === null || (message.call !== null && message.call.outcome !== "missed")) return;
	const project = await loadProject(conversation.project);
	if (!project) return;
	const kind = message.call ? "call_missed" : "chat_message";
	const preview = message.call ? "" : markdownText(message.body, CHAT_PREVIEW_LENGTH);
	const wanting = await accountsWanting(
		kind,
		"browser",
		recipients.filter((username) => username !== message.author)
	);
	await pushTo(wanting, {
		id: message.uuid,
		kind,
		variant: kind === "chat_message" && preview === "" ? "attachment" : null,
		project: project.uuid,
		project_name: project.name,
		params: { author: message.author_name, preview },
		path: `/projects/${project.uuid}/chat/${conversation.uuid}`,
	});
}

export interface StartingSoon {
	project: string;
	accounts: string[];
	kind: "meeting" | "event";
	title: string;
	starts_at: number;
	conversation: string | null;
}

export async function notifyStartingSoon(reminder: StartingSoon) {
	const project = await loadProject(reminder.project);
	if (!project) return;
	const { title } = reminder;
	const kind = reminder.kind === "meeting" ? "meeting_reminder" : "event_reminder";
	await announce({
		kind,
		project,
		accounts: reminder.accounts,
		params: { title, starts_at: reminder.starts_at },
		ttl: REMINDER_PUSH_SECONDS,
		path: reminder.conversation ? `/projects/${project.uuid}/chat/${reminder.conversation}` : `/projects/${project.uuid}/calendar`,
		email: ({ t, url }) => {
			const params = { title, time: meetingTime(reminder.starts_at, project) };
			return {
				subject: t(`email.notify.${kind}_subject`, params),
				heading: t(`email.notify.${kind}_heading`),
				paragraphs: [t(`email.notify.${kind}_intro`, params)],
				button: { label: t(reminder.conversation ? "email.notify.open_meeting" : "email.notify.open_calendar"), url },
			};
		},
	});
}
