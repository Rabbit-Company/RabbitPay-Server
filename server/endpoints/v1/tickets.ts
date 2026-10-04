import type { Context } from "@rabbit-company/web";
import { Server } from "../../server";
import Database, { dialect } from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { Logger } from "../../logger";
import { createInvoice } from "../../invoice-service";
import { memberConfigs } from "../../workforce/config";
import { isIsoDate } from "../../workforce/calendar";
import { findMember, personName } from "../../workforce/people";
import { requireWorkforce } from "../../workforce/access";
import { workedMinutes } from "../../workforce/timesheets";
import { notifyAssigned, notifyCustomerReply, notifyCustomerStatus } from "../../workforce/notifications";
import {
	assigneesOf,
	fixedPriceInvoicesOf,
	insertTicket,
	isClosedStatus,
	parsePortalKinds,
	presentComment,
	presentTicket,
	readComment,
	readPortalKinds,
	readTicket,
	replaceAssignees,
	timeOf,
	TICKET_STATUSES,
	type TicketInput,
} from "../../workforce/tickets";
import type { AppState, CustomerRow, TicketCommentRow, TicketPortalAccessRow, TicketRow, TicketStatus, TimeEntryRow } from "../../database/models";

const base = "/api/v1/projects/:uuid";
const DAY = 24 * 60 * 60 * 1000;

async function body(ctx: Context<AppState>): Promise<Record<string, unknown> | null> {
	try {
		const value = await ctx.body<Record<string, unknown>>();
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

async function audit(ctx: Context<AppState>, action: string, entityId: string, value?: unknown, previous?: unknown) {
	await Audit.record(ctx, { project: Permissions.project(ctx).uuid, action, entityType: "ticket", entityId, newValue: value, oldValue: previous });
}

async function findTicket(ctx: Context<AppState>): Promise<TicketRow | null> {
	if (!Validate.uuid(ctx.params.ticket)) return null;
	const [ticket] = (await Database`SELECT * FROM tickets WHERE uuid = ${ctx.params.ticket} AND project = ${Permissions.project(ctx).uuid}`) as TicketRow[];
	return ticket ?? null;
}

async function validReferences(projectId: string, input: TicketInput): Promise<ErrorCode | null> {
	if (input.customer !== null) {
		if (!Validate.uuid(input.customer)) return ErrorCode.CUSTOMER_NOT_FOUND;
		const [customer] = await Database`SELECT uuid FROM customers WHERE uuid = ${input.customer} AND project = ${projectId}`;
		if (!customer) return ErrorCode.CUSTOMER_NOT_FOUND;
	}
	for (const member of input.assignees ?? []) {
		const found = await findMember(projectId, member);
		if (!found || found.status !== "active") return ErrorCode.EMPLOYEE_NOT_FOUND;
	}
	return null;
}

async function detailed(ticket: TicketRow, showPricing = true) {
	const [assignees, time, fixedInvoices] = await Promise.all([
		assigneesOf([ticket.uuid]),
		timeOf(ticket.project, [ticket.uuid]),
		fixedPriceInvoicesOf([ticket.uuid]),
	]);
	const [customer] = ticket.customer
		? ((await Database`SELECT name, email FROM customers WHERE uuid = ${ticket.customer}`) as Pick<CustomerRow, "name" | "email">[])
		: [];
	return presentTicket(
		ticket,
		assignees.get(ticket.uuid) ?? [],
		time.get(ticket.uuid),
		customer ? (customer.name ?? customer.email) : null,
		fixedInvoices.has(ticket.uuid),
		showPricing
	);
}

Server.app.get(`${base}/tickets`, Auth.required(), Permissions.require(Permission.TICKET_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();
	const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);
	const status = query.get("status") ?? "active";
	const customer = query.get("customer");
	const assignee = query.get("assignee");
	const search = query.get("search")?.trim();
	if (status !== "active" && status !== "all" && !TICKET_STATUSES.includes(status as TicketStatus)) return Utils.fail(ctx, ErrorCode.INVALID_TICKET);
	if (customer !== null && !Validate.uuid(customer)) return Utils.fail(ctx, ErrorCode.INVALID_TICKET);

	const assigned = assignee === "me" ? Permissions.member(ctx).uuid : assignee;
	if (assigned !== null && !Validate.uuid(assigned)) return Utils.fail(ctx, ErrorCode.INVALID_TICKET);
	const statusFilter =
		status === "all" ? Database`` : status === "active" ? Database`AND t.status IN ('open', 'in_progress', 'waiting')` : Database`AND t.status = ${status}`;
	const customerFilter = customer ? Database`AND t.customer = ${customer}` : Database``;
	const assigneeFilter = assigned ? Database`AND t.uuid IN (SELECT ticket FROM ticket_assignees WHERE member = ${assigned})` : Database``;
	const pattern = `%${(search ?? "").toLowerCase().replace(/[!%_]/g, (character) => `!${character}`)}%`;
	const numberText = search?.startsWith("#") ? search.slice(1) : search;
	const parsedNumber = numberText && /^\d+$/.test(numberText) ? Number(numberText) : null;
	const ticketNumber = parsedNumber !== null && Number.isSafeInteger(parsedNumber) && parsedNumber > 0 ? parsedNumber : null;
	const searchFilter = search
		? ticketNumber === null
			? Database`AND LOWER(t.title) LIKE ${pattern} ESCAPE '!'`
			: Database`AND (LOWER(t.title) LIKE ${pattern} ESCAPE '!' OR t.number = ${ticketNumber})`
		: Database``;

	const rows = (await Database`
		SELECT t.*, c.name AS customer_name, c.email AS customer_email FROM tickets t LEFT JOIN customers c ON c.uuid = t.customer
		WHERE t.project = ${project.uuid} ${statusFilter} ${customerFilter} ${assigneeFilter} ${searchFilter}
		ORDER BY t.updated DESC, t.number DESC LIMIT ${limit} OFFSET ${offset}
	`) as (TicketRow & { customer_name: string | null; customer_email: string | null })[];
	const [total] = (await Database`
		SELECT COUNT(*) AS count FROM tickets t WHERE t.project = ${project.uuid} ${statusFilter} ${customerFilter} ${assigneeFilter} ${searchFilter}
	`) as { count: number }[];
	const ids = rows.map((row) => row.uuid);
	const showPricing = Permissions.has(Permissions.member(ctx), Permission.TICKET_MANAGE);
	const [assignees, time, fixedInvoices] = await Promise.all([assigneesOf(ids), timeOf(project.uuid, ids), fixedPriceInvoicesOf(ids)]);
	return Utils.ok(ctx, {
		tickets: rows.map((row) =>
			presentTicket(row, assignees.get(row.uuid) ?? [], time.get(row.uuid), row.customer_name ?? row.customer_email, fixedInvoices.has(row.uuid), showPricing)
		),
		total: Number(total.count),
		limit,
		offset,
	});
});

Server.app.post(`${base}/tickets`, Auth.required(), Permissions.require(Permission.TICKET_MANAGE), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	const data = await body(ctx);
	const input = data ? readTicket(data) : null;
	if (!input) return Utils.fail(ctx, ErrorCode.INVALID_TICKET);
	const problem = await validReferences(project.uuid, input);
	if (problem !== null) return Utils.fail(ctx, problem);

	const uuid = await insertTicket(project.uuid, input, { username: account.username, email: null });
	const [row] = (await Database`SELECT * FROM tickets WHERE uuid = ${uuid}`) as TicketRow[];
	const ticket = await detailed(row);
	await audit(ctx, "ticket.created", uuid, ticket);
	await notifyAssigned(row, input.assignees ?? [], Permissions.member(ctx));
	return Utils.ok(ctx, ticket, 201);
});

Server.app.get(`${base}/tickets/report`, Auth.required(), Permissions.require(Permission.TICKET_MANAGE), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();
	const from = query.get("from");
	const to = query.get("to");
	if (!isIsoDate(from) || !isIsoDate(to) || to < from) return Utils.fail(ctx, ErrorCode.INVALID_TICKET);
	const entries = (await Database`
		SELECT e.*, t.number, t.title, t.customer, t.hourly_rate FROM time_entries e JOIN tickets t ON t.uuid = e.ticket
		WHERE e.project = ${project.uuid} AND e.work_date >= ${from} AND e.work_date <= ${to}
	`) as (TimeEntryRow & Pick<TicketRow, "number" | "title" | "customer" | "hourly_rate">)[];
	const configOf = await memberConfigs(
		project.uuid,
		entries.map((entry) => entry.member)
	);

	const tickets = new Map<
		string,
		{ ticket: string; number: number; title: string; minutes: number; uninvoiced_minutes: number; people: Map<string, number> }
	>();
	for (const entry of entries) {
		const summary = tickets.get(entry.ticket!) ?? {
			ticket: entry.ticket!,
			number: entry.number,
			title: entry.title,
			minutes: 0,
			uninvoiced_minutes: 0,
			people: new Map<string, number>(),
		};
		const minutes = workedMinutes(entry, configOf(entry.member));
		summary.minutes += minutes;
		if (entry.invoice === null) summary.uninvoiced_minutes += minutes;
		summary.people.set(entry.person, (summary.people.get(entry.person) ?? 0) + minutes);
		tickets.set(entry.ticket!, summary);
	}
	return Utils.ok(ctx, {
		from,
		to,
		tickets: [...tickets.values()]
			.sort((first, second) => second.minutes - first.minutes)
			.map((summary) => ({ ...summary, people: [...summary.people].map(([person, minutes]) => ({ person, minutes })) })),
	});
});

Server.app.get(`${base}/tickets/:ticket`, Auth.required(), Permissions.require(Permission.TICKET_VIEW), async (ctx) => {
	const ticket = await findTicket(ctx);
	if (!ticket) return Utils.fail(ctx, ErrorCode.TICKET_NOT_FOUND);
	const showPricing = Permissions.has(Permissions.member(ctx), Permission.TICKET_MANAGE);
	const comments = (await Database`SELECT * FROM ticket_comments WHERE ticket = ${ticket.uuid} ORDER BY created ASC, uuid ASC`) as TicketCommentRow[];
	const entries = (await Database`SELECT * FROM time_entries WHERE ticket = ${ticket.uuid} ORDER BY work_date DESC, start_minute DESC`) as TimeEntryRow[];
	const configOf = await memberConfigs(
		ticket.project,
		entries.map((entry) => entry.member)
	);
	const people = new Map<string, number>();
	for (const entry of entries) people.set(entry.person, (people.get(entry.person) ?? 0) + workedMinutes(entry, configOf(entry.member)));
	return Utils.ok(ctx, {
		...(await detailed(ticket, showPricing)),
		comments: comments.map(presentComment),
		time_by_person: [...people].map(([person, minutes]) => ({ person, minutes })),
	});
});

Server.app.patch(`${base}/tickets/:ticket`, Auth.required(), Permissions.require(Permission.TICKET_WORK), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const ticket = await findTicket(ctx);
	if (!ticket) return Utils.fail(ctx, ErrorCode.TICKET_NOT_FOUND);
	const data = await body(ctx);
	if (!data) return Utils.fail(ctx, ErrorCode.INVALID_TICKET);
	const manages = Permissions.has(Permissions.member(ctx), Permission.TICKET_MANAGE);
	if (!manages && Object.keys(data).some((key) => key !== "status")) return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);
	const input = readTicket(data, ticket);
	if (!input) return Utils.fail(ctx, ErrorCode.INVALID_TICKET);
	const problem = await validReferences(project.uuid, input);
	if (problem !== null) return Utils.fail(ctx, problem);

	const before = await detailed(ticket, manages);
	const now = Date.now();
	const closedAt = isClosedStatus(input.status) ? (ticket.closed_at ?? now) : null;
	await Database.begin(async (tx) => {
		await tx`
			UPDATE tickets SET title = ${input.title}, description = ${input.description}, kind = ${input.kind}, status = ${input.status},
				priority = ${input.priority}, customer = ${input.customer}, customer_visible = ${input.customer_visible ? 1 : 0},
				estimate_minutes = ${input.estimate_minutes}, hourly_rate = ${input.hourly_rate}, fixed_price = ${input.fixed_price}, due_on = ${input.due_on}, closed_at = ${closedAt},
				updated = ${now}
			WHERE uuid = ${ticket.uuid}
		`;
		if (input.assignees !== null) await replaceAssignees(tx, ticket.uuid, input.assignees);
	});
	const [row] = (await Database`SELECT * FROM tickets WHERE uuid = ${ticket.uuid}`) as TicketRow[];
	const updated = await detailed(row, manages);
	await audit(ctx, "ticket.updated", ticket.uuid, updated, before);
	const previous = new Set(before.assignees.map((assignee) => assignee.member));
	await notifyAssigned(
		row,
		(input.assignees ?? []).filter((member) => !previous.has(member)),
		Permissions.member(ctx)
	);
	if (row.status !== ticket.status) await notifyCustomerStatus(row, Auth.account(ctx).username);
	return Utils.ok(ctx, updated);
});

Server.app.delete(`${base}/tickets/:ticket`, Auth.required(), Permissions.require(Permission.TICKET_MANAGE), requireWorkforce(), async (ctx) => {
	const ticket = await findTicket(ctx);
	if (!ticket) return Utils.fail(ctx, ErrorCode.TICKET_NOT_FOUND);
	await Database`DELETE FROM tickets WHERE uuid = ${ticket.uuid}`;
	await audit(ctx, "ticket.deleted", ticket.uuid, undefined, ticket);
	return Utils.ok(ctx);
});

Server.app.post(`${base}/tickets/:ticket/comments`, Auth.required(), Permissions.require(Permission.TICKET_WORK), requireWorkforce(), async (ctx) => {
	const ticket = await findTicket(ctx);
	if (!ticket) return Utils.fail(ctx, ErrorCode.TICKET_NOT_FOUND);
	const data = await body(ctx);
	const comment = data ? readComment(data) : null;
	if (!comment) return Utils.fail(ctx, ErrorCode.INVALID_TICKET_COMMENT);
	const account = Auth.account(ctx);
	const uuid = crypto.randomUUID();
	const now = Date.now();
	await Database.begin(async (tx) => {
		await tx`
			INSERT INTO ticket_comments(uuid, ticket, author, author_email, author_name, body, internal, created, updated)
			VALUES(${uuid}, ${ticket.uuid}, ${account.username}, NULL, ${personName(Permissions.member(ctx))}, ${comment.body}, ${comment.internal ? 1 : 0}, ${now}, ${now})
		`;
		await tx`UPDATE tickets SET updated = ${now} WHERE uuid = ${ticket.uuid}`;
	});
	const [row] = (await Database`SELECT * FROM ticket_comments WHERE uuid = ${uuid}`) as TicketCommentRow[];
	await audit(ctx, "ticket.commented", ticket.uuid, { comment: uuid, internal: comment.internal });
	if (!comment.internal) await notifyCustomerReply(ticket, personName(Permissions.member(ctx)), comment.body, account.username);
	return Utils.ok(ctx, presentComment(row), 201);
});

Server.app.delete(
	`${base}/tickets/:ticket/comments/:comment`,
	Auth.required(),
	Permissions.require(Permission.TICKET_WORK),
	requireWorkforce(),
	async (ctx) => {
		const ticket = await findTicket(ctx);
		if (!ticket) return Utils.fail(ctx, ErrorCode.TICKET_NOT_FOUND);
		const [comment] = (await Database`
		SELECT * FROM ticket_comments WHERE uuid = ${ctx.params.comment} AND ticket = ${ticket.uuid}
	`) as TicketCommentRow[];
		if (!comment) return Utils.fail(ctx, ErrorCode.TICKET_COMMENT_NOT_FOUND);
		const manages = Permissions.has(Permissions.member(ctx), Permission.TICKET_MANAGE);
		if (!manages && comment.author !== Auth.account(ctx).username) return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);
		await Database`DELETE FROM ticket_comments WHERE uuid = ${comment.uuid}`;
		await audit(ctx, "ticket.comment_deleted", ticket.uuid, undefined, comment);
		return Utils.ok(ctx);
	}
);

async function createTicketInvoice(ctx: Context<AppState>, tickets: TicketRow[], data: Record<string, unknown>) {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	const dueDate = data.due_date ?? Date.now() + 14 * DAY;
	if ((data.tax_rate !== undefined && !Validate.taxRate(data.tax_rate)) || typeof dueDate !== "number" || !Number.isSafeInteger(dueDate) || dueDate <= 0) {
		return Utils.fail(ctx, ErrorCode.INVALID_TICKET);
	}
	if (tickets.some((ticket) => ticket.customer !== tickets[0].customer)) return Utils.fail(ctx, ErrorCode.TICKET_CUSTOMER_MISMATCH);

	const ticketIds = tickets.map((ticket) => ticket.uuid);
	const [entries, fixedInvoices] = await Promise.all([
		Database`SELECT * FROM time_entries WHERE ticket IN ${Database(ticketIds)} AND invoice IS NULL` as Promise<TimeEntryRow[]>,
		fixedPriceInvoicesOf(ticketIds),
	]);
	const configOf = await memberConfigs(
		project.uuid,
		entries.map((entry) => entry.member)
	);
	const fixedTickets = tickets.filter((ticket) => ticket.fixed_price !== null && !fixedInvoices.has(ticket.uuid));
	if (entries.length === 0 && fixedTickets.length === 0) {
		if (tickets.length === 1 && tickets[0].fixed_price === null && (tickets[0].hourly_rate ?? configOf(null).ticket_hourly_rate) === null) {
			return Utils.fail(ctx, ErrorCode.TICKET_RATE_MISSING);
		}
		return Utils.fail(ctx, ErrorCode.NOTHING_TO_INVOICE);
	}
	const ticketById = new Map(tickets.map((ticket) => [ticket.uuid, ticket]));
	const groups = new Map<string, { ticket: TicketRow; rate: number; tax_rate: number; minutes: number; people: Set<string> }>();
	for (const entry of entries) {
		const ticket = entry.ticket ? ticketById.get(entry.ticket) : undefined;
		if (!ticket || ticket.fixed_price !== null) continue;
		const settings = configOf(entry.member);
		const rate = ticket.hourly_rate ?? settings.ticket_hourly_rate;
		if (rate === null) return Utils.fail(ctx, ErrorCode.TICKET_RATE_MISSING);
		const taxRate = (data.tax_rate as number | undefined) ?? settings.ticket_tax_rate;
		const key = `${ticket.uuid}:${rate}:${taxRate}`;
		const group = groups.get(key) ?? { ticket, rate, tax_rate: taxRate, minutes: 0, people: new Set<string>() };
		group.minutes += workedMinutes(entry, settings);
		group.people.add(entry.person);
		groups.set(key, group);
	}
	const hourlyLines = tickets
		.flatMap((ticket) => [...groups.values()].filter((group) => group.ticket.uuid === ticket.uuid))
		.map((group) => ({ ...group, quantity: Math.round((group.minutes / 60) * 100) / 100, fixed: false }))
		.filter((group) => group.quantity > 0);
	const fixedLines = fixedTickets.map((ticket) => ({
		ticket,
		rate: ticket.fixed_price!,
		tax_rate: (data.tax_rate as number | undefined) ?? configOf(null).ticket_tax_rate,
		minutes: entries.filter((entry) => entry.ticket === ticket.uuid).reduce((sum, entry) => sum + workedMinutes(entry, configOf(entry.member)), 0),
		people: new Set<string>(),
		quantity: 1,
		fixed: true,
	}));
	const lines = tickets.flatMap((ticket) => [...fixedLines, ...hourlyLines].filter((line) => line.ticket.uuid === ticket.uuid));
	const minutes = lines.reduce((sum, line) => sum + line.minutes, 0);
	const quantity = Math.round(lines.reduce((sum, line) => sum + line.quantity, 0) * 100) / 100;
	if (quantity <= 0) return Utils.fail(ctx, ErrorCode.NOTHING_TO_INVOICE);
	const rate = lines.length === 1 ? lines[0].rate : null;
	const groupsPerTicket = new Map<string, number>();
	for (const line of hourlyLines) groupsPerTicket.set(line.ticket.uuid, (groupsPerTicket.get(line.ticket.uuid) ?? 0) + 1);

	const invoice = await createInvoice(project.uuid, {
		customer: tickets[0].customer,
		items: lines.map((line) => ({
			description:
				line.fixed || groupsPerTicket.get(line.ticket.uuid) === 1
					? `#${line.ticket.number} ${line.ticket.title}`
					: `#${line.ticket.number} ${line.ticket.title} (${[...line.people].join(", ")})`,
			quantity: line.quantity,
			unit_price: line.rate,
			tax_rate: line.tax_rate,
			unit: line.fixed ? "C62" : "HUR",
			metadata: { ticket: line.ticket.uuid },
		})),
		due_date: dueDate,
		status: "draft",
		source: "invoice",
		created_by: account.username,
		recurring: null,
		metadata: tickets.length === 1 ? { ticket: tickets[0].uuid } : { tickets: ticketIds },
	});
	const billedTickets = new Set(lines.map((line) => line.ticket.uuid));
	const claimed = entries.filter((entry) => entry.ticket !== null && billedTickets.has(entry.ticket)).map((entry) => entry.uuid);
	if (claimed.length) await Database`UPDATE time_entries SET invoice = ${invoice.uuid} WHERE uuid IN ${Database(claimed)} AND invoice IS NULL`;
	for (const line of fixedLines) {
		await Database`INSERT INTO ticket_fixed_price_invoices(ticket, invoice, created) VALUES(${line.ticket.uuid}, ${invoice.uuid}, ${Date.now()})`;
	}
	for (const ticket of tickets) {
		const ticketLines = lines.filter((line) => line.ticket.uuid === ticket.uuid);
		await audit(ctx, "ticket.invoiced", ticket.uuid, {
			invoice: invoice.uuid,
			minutes: ticketLines.reduce((sum, line) => sum + line.minutes, 0),
			quantity: Math.round(ticketLines.reduce((sum, line) => sum + line.quantity, 0) * 100) / 100,
			rate: ticketLines.length === 1 ? ticketLines[0].rate : null,
		});
	}
	Logger.audit(`[TICKETS] ${account.username} created an invoice from tickets ${tickets.map((ticket) => `#${ticket.number}`).join(", ")} on ${project.uuid}`);
	return Utils.ok(ctx, { invoice: invoice.uuid, reference: invoice.reference, minutes, quantity, rate }, 201);
}

Server.app.post(`${base}/tickets/invoice`, Auth.required(), Permissions.require(Permission.TICKET_MANAGE), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	if (!Permissions.has(Permissions.member(ctx), Permission.INVOICE_CREATE)) return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);
	const data = (await body(ctx)) ?? {};
	const ticketIds = data.tickets;
	if (
		!Array.isArray(ticketIds) ||
		ticketIds.length === 0 ||
		ticketIds.length > 100 ||
		!ticketIds.every((ticket) => typeof ticket === "string" && Validate.uuid(ticket))
	) {
		return Utils.fail(ctx, ErrorCode.INVALID_TICKET);
	}
	const uniqueIds = [...new Set(ticketIds as string[])];
	const rows = (await Database`SELECT * FROM tickets WHERE project = ${project.uuid} AND uuid IN ${Database(uniqueIds)}`) as TicketRow[];
	if (rows.length !== uniqueIds.length) return Utils.fail(ctx, ErrorCode.TICKET_NOT_FOUND);
	const byId = new Map(rows.map((ticket) => [ticket.uuid, ticket]));
	return createTicketInvoice(
		ctx,
		uniqueIds.map((ticket) => byId.get(ticket)!),
		data
	);
});

Server.app.post(`${base}/tickets/:ticket/invoice`, Auth.required(), Permissions.require(Permission.TICKET_MANAGE), requireWorkforce(), async (ctx) => {
	if (!Permissions.has(Permissions.member(ctx), Permission.INVOICE_CREATE)) return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);
	const ticket = await findTicket(ctx);
	if (!ticket) return Utils.fail(ctx, ErrorCode.TICKET_NOT_FOUND);
	return createTicketInvoice(ctx, [ticket], (await body(ctx)) ?? {});
});

Server.app.get(`${base}/customers/:customer/ticket-access`, Auth.required(), Permissions.require(Permission.TICKET_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const [access] = (await Database`
		SELECT * FROM ticket_portal_access WHERE customer = ${ctx.params.customer} AND project = ${project.uuid}
	`) as TicketPortalAccessRow[];
	return Utils.ok(ctx, { customer: ctx.params.customer, enabled: access !== undefined, kinds: parsePortalKinds(access?.kinds) });
});

Server.app.put(`${base}/customers/:customer/ticket-access`, Auth.required(), Permissions.require(Permission.TICKET_MANAGE), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const customerId = ctx.params.customer;
	if (!Validate.uuid(customerId)) return Utils.fail(ctx, ErrorCode.CUSTOMER_NOT_FOUND);
	const [customer] = await Database`SELECT uuid FROM customers WHERE uuid = ${customerId} AND project = ${project.uuid}`;
	if (!customer) return Utils.fail(ctx, ErrorCode.CUSTOMER_NOT_FOUND);
	const data = await body(ctx);
	const kinds = readPortalKinds(data?.kinds ?? []);
	if (!kinds) return Utils.fail(ctx, ErrorCode.INVALID_TICKET);
	if (data?.enabled !== undefined && typeof data.enabled !== "boolean") return Utils.fail(ctx, ErrorCode.INVALID_TICKET);
	const enabled = typeof data?.enabled === "boolean" ? data.enabled : kinds.length > 0;
	const granted = enabled ? kinds : [];

	const [previous] = (await Database`SELECT * FROM ticket_portal_access WHERE customer = ${customerId}`) as TicketPortalAccessRow[];
	const now = Date.now();
	if (!enabled) {
		await Database`DELETE FROM ticket_portal_access WHERE customer = ${customerId}`;
	} else if (dialect === "mysql") {
		await Database`INSERT INTO ticket_portal_access(customer, project, kinds, updated) VALUES(${customerId}, ${project.uuid}, ${granted.join(",")}, ${now})
			ON DUPLICATE KEY UPDATE kinds = ${granted.join(",")}, updated = ${now}`;
	} else {
		await Database`INSERT INTO ticket_portal_access(customer, project, kinds, updated) VALUES(${customerId}, ${project.uuid}, ${granted.join(",")}, ${now})
			ON CONFLICT(customer) DO UPDATE SET kinds = ${granted.join(",")}, updated = ${now}`;
	}
	await Audit.record(ctx, {
		project: project.uuid,
		action: "customer.ticket_access_updated",
		entityType: "customer",
		entityId: customerId,
		oldValue: { enabled: previous !== undefined, kinds: parsePortalKinds(previous?.kinds) },
		newValue: { enabled, kinds: granted },
	});
	return Utils.ok(ctx, { customer: customerId, enabled, kinds: granted });
});
