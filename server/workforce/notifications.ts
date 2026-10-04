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
import type { AbsenceRow, EmailKind, ProjectMemberRow, ProjectRow, TicketRow } from "../database/models";

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

async function memberEmails(members: ProjectMemberRow[], exclude: string | null): Promise<Recipient[]> {
	const usernames = members.map((member) => member.account_username).filter((name): name is string => name !== null && name !== exclude);
	if (usernames.length === 0) return [];
	const accounts = (await Database`
		SELECT username, email FROM accounts WHERE username IN ${Database(usernames)} AND status = 'active'
	`) as { username: string; email: string }[];
	return accounts.map((account) => ({ email: account.email, member: members.find((member) => member.account_username === account.username)?.uuid ?? null }));
}

async function activeMembers(projectId: string): Promise<ProjectMemberRow[]> {
	const members = (await Database`SELECT * FROM project_members WHERE project_id = ${projectId} AND status = 'active'`) as ProjectMemberRow[];
	return members.filter(Permissions.isActive);
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

function ticketUrl(project: ProjectRow, ticket: TicketRow): string {
	return `${Utils.publicUrl()}/projects/${project.uuid}/tickets/${ticket.uuid}`;
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

async function ticketTeam(ticket: TicketRow): Promise<ProjectMemberRow[]> {
	const members = await activeMembers(ticket.project);
	const assigned = (await Database`SELECT member FROM ticket_assignees WHERE ticket = ${ticket.uuid}`) as { member: string }[];
	const assignees = members.filter((member) => assigned.some((row) => row.member === member.uuid));
	return assignees.length ? assignees : members.filter((member) => Permissions.has(member, Permission.TICKET_MANAGE));
}

export function notifyTeamOfCustomer(ticket: TicketRow, activity: "created" | "comment", body: string | null) {
	return safely("customer ticket activity", async () => {
		const project = await enabledProject(ticket.project);
		if (!project) return;
		const [customer] = ticket.customer
			? ((await Database`SELECT email, name FROM customers WHERE uuid = ${ticket.customer}`) as { email: string; name: string | null }[])
			: [];
		const brand = await brandFor(project, "team");
		const t = translator(brand.language);
		const params = {
			number: ticket.number,
			title: ticket.title,
			customer: customer?.name?.trim() || customer?.email || "",
			kind: t(`email.ticket.kind_${ticket.kind}` as TranslationKey),
		};
		const created = activity === "created";
		await deliver(
			project,
			brand,
			"ticket_customer",
			await memberEmails(await ticketTeam(ticket), null),
			{
				subject: t(created ? "email.ticket.created_subject" : "email.ticket.customer_subject", params),
				heading: t(created ? "email.ticket.created_heading" : "email.ticket.customer_heading", params),
				paragraphs: [t(created ? "email.ticket.created_intro" : "email.ticket.customer_intro", params)],
				note: body ? { title: t(created ? "email.ticket.description" : "email.ticket.message"), body } : null,
				button: { label: t("email.ticket.open_team"), url: ticketUrl(project, ticket) },
			},
			null,
			ticket.uuid
		);
	});
}

export function notifyAssigned(ticket: TicketRow, members: string[], actor: ProjectMemberRow) {
	return safely("ticket assignment", async () => {
		if (members.length === 0) return;
		const project = await enabledProject(ticket.project);
		if (!project) return;
		const assigned = (await activeMembers(ticket.project)).filter((member) => members.includes(member.uuid));
		const brand = await brandFor(project, "team");
		const t = translator(brand.language);
		const params = { number: ticket.number, title: ticket.title, merchant: brand.merchant, actor: personName(actor) };
		await deliver(
			project,
			brand,
			"ticket_assigned",
			await memberEmails(assigned, actor.account_username),
			{
				subject: t("email.ticket.assigned_subject", params),
				heading: t("email.ticket.assigned_heading"),
				paragraphs: [t("email.ticket.assigned_intro", params)],
				note: ticket.description ? { title: t("email.ticket.description"), body: ticket.description } : null,
				button: { label: t("email.ticket.open_team"), url: ticketUrl(project, ticket) },
			},
			actor.account_username,
			ticket.uuid
		);
	});
}

function absenceDates(absence: AbsenceRow, brand: EmailBrand) {
	const format = (date: string) => {
		const [year, month, day] = date.split("-").map(Number);
		return emailDate(Date.UTC(year, month - 1, day), { ...brand, timezone: "UTC" });
	};
	return { from: format(absence.starts_on), to: format(absence.ends_on) };
}

export function notifyAbsenceRequested(absence: AbsenceRow, workingDays: number | null) {
	return safely("absence request", async () => {
		const project = await enabledProject(absence.project);
		if (!project) return;
		const approvers = (await activeMembers(absence.project)).filter(
			(member) => Permissions.has(member, Permission.TIMESHEET_EDIT) && member.uuid !== absence.member
		);
		const brand = await brandFor(project, "team");
		const t = translator(brand.language);
		const params = {
			person: absence.person,
			kind: t(`email.absence.kind_${absence.kind}` as TranslationKey),
			days: workingDays ?? "",
			...absenceDates(absence, brand),
		};
		await deliver(
			project,
			brand,
			"absence_requested",
			await memberEmails(approvers, null),
			{
				subject: t("email.absence.requested_subject", params),
				heading: t("email.absence.requested_heading"),
				paragraphs: [t("email.absence.requested_intro", params)],
				note: absence.note ? { title: t("email.absence.note"), body: absence.note } : null,
				button: { label: t("email.absence.requested_button"), url: `${Utils.publicUrl()}/projects/${project.uuid}/timesheet/absences` },
			},
			absence.created_by
		);
	});
}

export function notifyAbsenceDecided(absence: AbsenceRow, actor: ProjectMemberRow) {
	return safely("absence decision", async () => {
		if (!absence.member || absence.member === actor.uuid || (absence.status !== "approved" && absence.status !== "rejected")) return;
		const project = await enabledProject(absence.project);
		if (!project) return;
		const [employee] = (await Database`SELECT * FROM project_members WHERE uuid = ${absence.member} AND status = 'active'`) as ProjectMemberRow[];
		if (!employee) return;
		const brand = await brandFor(project, "team");
		const t = translator(brand.language);
		const decision = absence.status;
		const params = { actor: personName(actor), kind: t(`email.absence.kind_${absence.kind}` as TranslationKey), ...absenceDates(absence, brand) };
		await deliver(
			project,
			brand,
			"absence_decided",
			await memberEmails([employee], null),
			{
				subject: t(`email.absence.${decision}_subject`, params),
				heading: t(`email.absence.${decision}_heading`),
				paragraphs: [t(`email.absence.${decision}_intro`, params)],
				note: absence.decision_note ? { title: t("email.absence.note"), body: absence.decision_note } : null,
				button: { label: t("email.absence.open"), url: `${Utils.publicUrl()}/projects/${project.uuid}/timesheet/absences` },
			},
			actor.account_username
		);
	});
}
