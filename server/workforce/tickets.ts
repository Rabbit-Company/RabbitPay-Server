import type { SQL } from "bun";
import Database from "../database/database";
import { isIsoDate } from "./calendar";
import { personName } from "./people";
import { workedMinutes } from "./timesheets";
import { memberConfigs } from "./config";
import type {
	ProjectMemberRow,
	TicketCommentRow,
	TicketKind,
	TicketPortalAccessRow,
	TicketPriority,
	TicketRow,
	TicketStatus,
	TimeEntryRow,
} from "../database/models";

export const TICKET_KINDS: TicketKind[] = ["task", "bug", "feature", "support"];
export const TICKET_STATUSES: TicketStatus[] = ["open", "in_progress", "waiting", "resolved", "closed"];
export const TICKET_PRIORITIES: TicketPriority[] = ["low", "normal", "high", "urgent"];
export const CUSTOMER_TICKET_KINDS: TicketKind[] = ["support", "bug", "feature"];
export const MAX_COMMENT_LENGTH = 10_000;
export const MAX_DESCRIPTION_LENGTH = 20_000;

export interface TicketInput {
	title: string;
	description: string | null;
	kind: TicketKind;
	status: TicketStatus;
	priority: TicketPriority;
	customer: string | null;
	customer_visible: boolean;
	estimate_minutes: number | null;
	hourly_rate: number | null;
	fixed_price: number | null;
	due_on: string | null;
	assignees: string[] | null;
}

export function isClosedStatus(status: TicketStatus): boolean {
	return status === "resolved" || status === "closed";
}

export function readTicket(data: Record<string, unknown>, previous?: TicketRow): TicketInput | null {
	const title = data.title ?? previous?.title;
	const description = data.description === undefined ? (previous?.description ?? null) : data.description;
	const kind = data.kind ?? previous?.kind ?? "task";
	const status = data.status ?? previous?.status ?? "open";
	const priority = data.priority ?? previous?.priority ?? "normal";
	const customer = data.customer === undefined ? (previous?.customer ?? null) : data.customer;
	const visible = data.customer_visible ?? (previous ? Boolean(previous.customer_visible) : true);
	const estimate = data.estimate_minutes === undefined ? (previous?.estimate_minutes ?? null) : data.estimate_minutes;
	const rate = data.hourly_rate === undefined ? (previous?.hourly_rate ?? null) : data.hourly_rate;
	const fixedPrice = data.fixed_price === undefined ? (previous?.fixed_price ?? null) : data.fixed_price;
	const dueOn = data.due_on === undefined ? (previous?.due_on ?? null) : data.due_on;
	const assignees = data.assignees === undefined ? null : data.assignees;

	if (typeof title !== "string" || !title.trim() || title.length > 200) return null;
	if (description !== null && (typeof description !== "string" || description.length > MAX_DESCRIPTION_LENGTH)) return null;
	if (!TICKET_KINDS.includes(kind as TicketKind) || !TICKET_STATUSES.includes(status as TicketStatus)) return null;
	if (!TICKET_PRIORITIES.includes(priority as TicketPriority)) return null;
	if (customer !== null && typeof customer !== "string") return null;
	if (typeof visible !== "boolean") return null;
	if (estimate !== null && (typeof estimate !== "number" || !Number.isSafeInteger(estimate) || estimate < 0 || estimate > 1_000_000)) return null;
	if (rate !== null && (typeof rate !== "number" || !Number.isSafeInteger(rate) || rate < 0 || rate > 100_000_000)) return null;
	if (fixedPrice !== null && (typeof fixedPrice !== "number" || !Number.isSafeInteger(fixedPrice) || fixedPrice <= 0 || fixedPrice > 100_000_000_000))
		return null;
	if (dueOn !== null && !isIsoDate(dueOn)) return null;
	if (assignees !== null && (!Array.isArray(assignees) || assignees.length > 50 || !assignees.every((entry) => typeof entry === "string"))) return null;

	return {
		title: title.trim(),
		description: typeof description === "string" && description.trim() ? description.trim() : null,
		kind: kind as TicketKind,
		status: status as TicketStatus,
		priority: priority as TicketPriority,
		customer,
		customer_visible: visible,
		estimate_minutes: estimate,
		hourly_rate: fixedPrice === null ? rate : null,
		fixed_price: fixedPrice,
		due_on: dueOn as string | null,
		assignees: assignees === null ? null : [...new Set(assignees as string[])],
	};
}

export async function nextTicketNumber(sql: SQL, projectId: string): Promise<number> {
	const [row] = (await sql`SELECT COALESCE(MAX(number), 0) AS last FROM tickets WHERE project = ${projectId}`) as { last: number }[];
	return Number(row.last) + 1;
}

export async function replaceAssignees(sql: SQL, ticketId: string, members: string[]) {
	await sql`DELETE FROM ticket_assignees WHERE ticket = ${ticketId}`;
	const now = Date.now();
	for (const member of members) await sql`INSERT INTO ticket_assignees(ticket, member, created) VALUES(${ticketId}, ${member}, ${now})`;
}

export async function insertTicket(projectId: string, input: TicketInput, author: { username: string | null; email: string | null }): Promise<string> {
	const uuid = crypto.randomUUID();
	const now = Date.now();
	for (let attempt = 0; ; attempt++) {
		try {
			await Database.begin(async (tx) => {
				const number = await nextTicketNumber(tx, projectId);
				await tx`
					INSERT INTO tickets(uuid, project, number, title, description, kind, status, priority, sort_order, customer, customer_visible, estimate_minutes,
						hourly_rate, fixed_price, due_on, created_by, reported_by, closed_at, created, updated)
					VALUES(${uuid}, ${projectId}, ${number}, ${input.title}, ${input.description}, ${input.kind}, ${input.status}, ${input.priority}, ${number},
						${input.customer}, ${input.customer_visible ? 1 : 0}, ${input.estimate_minutes}, ${input.hourly_rate}, ${input.fixed_price}, ${input.due_on},
						${author.username}, ${author.email}, ${isClosedStatus(input.status) ? now : null}, ${now}, ${now})
				`;
				await replaceAssignees(tx, uuid, input.assignees ?? []);
			});
			return uuid;
		} catch (error) {
			if (attempt >= 2) throw error;
		}
	}
}

export interface Assignee {
	member: string;
	name: string;
	full_name: string | null;
}

export async function assigneesOf(ticketIds: string[]): Promise<Map<string, Assignee[]>> {
	const result = new Map<string, Assignee[]>();
	if (ticketIds.length === 0) return result;
	const rows = (await Database`
		SELECT a.ticket, m.uuid, m.full_name, account.email AS account_email, m.invitation_email
		FROM ticket_assignees a JOIN project_members m ON m.uuid = a.member
		LEFT JOIN accounts account ON account.username = m.account_username
		WHERE a.ticket IN ${Database(ticketIds)}
		ORDER BY a.created ASC
	`) as (Pick<ProjectMemberRow, "uuid" | "full_name" | "account_email" | "invitation_email"> & { ticket: string })[];
	for (const row of rows) {
		const list = result.get(row.ticket) ?? [];
		list.push({ member: row.uuid, name: personName(row), full_name: row.full_name?.trim() || null });
		result.set(row.ticket, list);
	}
	return result;
}

export interface TicketTime {
	minutes: number;
	uninvoiced_minutes: number;
}

export async function timeOf(projectId: string, ticketIds: string[]): Promise<Map<string, TicketTime>> {
	const result = new Map<string, TicketTime>();
	if (ticketIds.length === 0) return result;
	const rows = (await Database`
		SELECT ticket, member, start_minute, end_minute, break_minutes, invoice FROM time_entries WHERE ticket IN ${Database(ticketIds)}
	`) as Pick<TimeEntryRow, "ticket" | "member" | "start_minute" | "end_minute" | "break_minutes" | "invoice">[];
	const configOf = await memberConfigs(
		projectId,
		rows.map((row) => row.member)
	);
	for (const row of rows) {
		const time = result.get(row.ticket!) ?? { minutes: 0, uninvoiced_minutes: 0 };
		const minutes = workedMinutes(row, configOf(row.member));
		time.minutes += minutes;
		if (row.invoice === null) time.uninvoiced_minutes += minutes;
		result.set(row.ticket!, time);
	}
	return result;
}

export async function fixedPriceInvoicesOf(ticketIds: string[]): Promise<Set<string>> {
	if (ticketIds.length === 0) return new Set();
	const rows = (await Database`SELECT ticket FROM ticket_fixed_price_invoices WHERE ticket IN ${Database(ticketIds)}`) as { ticket: string }[];
	return new Set(rows.map((row) => row.ticket));
}

export function presentTicket(
	row: TicketRow,
	assignees: Assignee[],
	time: TicketTime | undefined,
	customerName?: string | null,
	fixedPriceInvoiced = false,
	showPricing = true
) {
	return {
		uuid: row.uuid,
		number: row.number,
		title: row.title,
		description: row.description,
		kind: row.kind,
		status: row.status,
		priority: row.priority,
		sort_order: row.sort_order,
		customer: row.customer,
		customer_name: customerName ?? null,
		customer_visible: Boolean(row.customer_visible),
		estimate_minutes: row.estimate_minutes,
		hourly_rate: showPricing ? row.hourly_rate : null,
		fixed_price: showPricing ? row.fixed_price : null,
		fixed_price_invoiced: showPricing && fixedPriceInvoiced,
		due_on: row.due_on,
		assignees,
		logged_minutes: time?.minutes ?? 0,
		uninvoiced_minutes: time?.uninvoiced_minutes ?? 0,
		created_by: row.created_by,
		reported_by: row.reported_by,
		closed_at: row.closed_at,
		created: row.created,
		updated: row.updated,
	};
}

export function presentComment(row: TicketCommentRow) {
	return {
		uuid: row.uuid,
		author: row.author,
		author_email: row.author_email,
		author_name: row.author_name,
		from_customer: row.author_email !== null,
		body: row.body,
		internal: Boolean(row.internal),
		created: row.created,
		updated: row.updated,
	};
}

export function readComment(data: Record<string, unknown>): { body: string; internal: boolean } | null {
	const body = data.body;
	const internal = data.internal ?? false;
	if (typeof body !== "string" || !body.trim() || body.length > MAX_COMMENT_LENGTH || typeof internal !== "boolean") return null;
	return { body: body.trim(), internal };
}

export function readPortalKinds(value: unknown): TicketKind[] | null {
	if (!Array.isArray(value) || value.length > CUSTOMER_TICKET_KINDS.length) return null;
	if (!value.every((kind) => CUSTOMER_TICKET_KINDS.includes(kind as TicketKind))) return null;
	return CUSTOMER_TICKET_KINDS.filter((kind) => value.includes(kind));
}

export function parsePortalKinds(stored: string | null | undefined): TicketKind[] {
	if (!stored) return [];
	return CUSTOMER_TICKET_KINDS.filter((kind) => stored.split(",").includes(kind));
}

export async function portalAccess(email: string) {
	return (await Database`
		SELECT a.*, c.uuid AS customer_id, p.uuid AS project_id, p.display_name AS merchant, p.name AS project_name, p.workforce_until
		FROM ticket_portal_access a JOIN customers c ON c.uuid = a.customer JOIN projects p ON p.uuid = a.project
		WHERE c.email = ${email} AND p.status != 'deleted'
	`) as (TicketPortalAccessRow & {
		customer_id: string;
		project_id: string;
		merchant: string | null;
		project_name: string;
		workforce_until: number | null;
	})[];
}
