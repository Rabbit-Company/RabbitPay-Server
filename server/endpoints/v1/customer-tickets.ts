import { rateLimit } from "@rabbit-company/web-middleware/rate-limit";
import { Server } from "../../server";
import Database from "../../database/database";
import CustomerAuth from "../../customer-auth";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { workforceActive } from "../../licensing";
import { notifyTeamOfCustomer } from "../../workforce/notifications";
import {
	assigneesOf,
	insertTicket,
	MAX_DESCRIPTION_LENGTH,
	parsePortalKinds,
	portalAccess,
	presentComment,
	readComment,
	type Assignee,
} from "../../workforce/tickets";
import type { TicketCommentRow, TicketKind, TicketRow } from "../../database/models";

const writeLimit = rateLimit({ windowMs: 60 * 1000, max: 20, message: "Too many requests. Please slow down." });

type PortalTicketRow = TicketRow & {
	merchant: string | null;
	project_name: string;
	workforce_until: number | null;
	customer_name: string | null;
};

function merchantOf(row: Pick<PortalTicketRow, "merchant" | "project_name">): string {
	return row.merchant?.trim() || row.project_name;
}

async function portalTicket(email: string, uuid: string): Promise<PortalTicketRow | null> {
	if (!Validate.uuid(uuid)) return null;
	const [ticket] = (await Database`
		SELECT t.*, p.display_name AS merchant, p.name AS project_name, p.workforce_until, c.name AS customer_name
		FROM tickets t JOIN customers c ON c.uuid = t.customer JOIN projects p ON p.uuid = t.project
		JOIN ticket_portal_access a ON a.customer = t.customer
		WHERE t.uuid = ${uuid} AND LOWER(c.email) = ${email} AND t.customer_visible = 1 AND p.status != 'deleted'
	`) as PortalTicketRow[];
	return ticket ?? null;
}

function presentPortalTicket(row: PortalTicketRow, assignees: Assignee[], email: string) {
	return {
		uuid: row.uuid,
		number: row.number,
		title: row.title,
		description: row.description,
		kind: row.kind,
		status: row.status,
		priority: row.priority,
		merchant: merchantOf(row),
		assignees: assignees.map((assignee) => assignee.full_name),
		due_on: row.due_on,
		reported_by_me: row.reported_by?.toLowerCase() === email,
		closed_at: row.closed_at,
		created: row.created,
		updated: row.updated,
	};
}

Server.app.get("/api/v1/customer/tickets", CustomerAuth.required(), async (ctx) => {
	const email = CustomerAuth.email(ctx);
	const status = ctx.query().get("status");
	const filter =
		status === "closed"
			? Database`AND t.status IN ('resolved', 'closed')`
			: status === "active"
				? Database`AND t.status IN ('open', 'in_progress', 'waiting')`
				: Database``;
	const rows = (await Database`
		SELECT t.*, p.display_name AS merchant, p.name AS project_name, p.workforce_until, c.name AS customer_name
		FROM tickets t JOIN customers c ON c.uuid = t.customer JOIN projects p ON p.uuid = t.project
		JOIN ticket_portal_access a ON a.customer = t.customer
		WHERE LOWER(c.email) = ${email} AND t.customer_visible = 1 AND p.status != 'deleted' ${filter}
		ORDER BY t.updated DESC, t.uuid ASC LIMIT 200
	`) as PortalTicketRow[];
	const assignees = await assigneesOf(rows.map((row) => row.uuid));
	return Utils.ok(
		ctx,
		rows.map((row) => presentPortalTicket(row, assignees.get(row.uuid) ?? [], email))
	);
});

Server.app.get("/api/v1/customer/tickets/:ticket", CustomerAuth.required(), async (ctx) => {
	const email = CustomerAuth.email(ctx);
	const ticket = await portalTicket(email, ctx.params.ticket);
	if (!ticket) return Utils.fail(ctx, ErrorCode.TICKET_NOT_FOUND);
	const comments = (await Database`
		SELECT * FROM ticket_comments WHERE ticket = ${ticket.uuid} AND internal = 0 ORDER BY created ASC, uuid ASC
	`) as TicketCommentRow[];
	const assignees = await assigneesOf([ticket.uuid]);
	return Utils.ok(ctx, {
		...presentPortalTicket(ticket, assignees.get(ticket.uuid) ?? [], email),
		can_comment: workforceActive(ticket),
		comments: comments.map((comment) => {
			const { author, author_email, ...visible } = presentComment(comment);
			return { ...visible, mine: author_email !== null && author_email.toLowerCase() === email };
		}),
	});
});

Server.app.post("/api/v1/customer/tickets/:ticket/comments", CustomerAuth.required(), writeLimit, async (ctx) => {
	const email = CustomerAuth.email(ctx);
	const ticket = await portalTicket(email, ctx.params.ticket);
	if (!ticket) return Utils.fail(ctx, ErrorCode.TICKET_NOT_FOUND);
	if (!workforceActive(ticket)) return Utils.fail(ctx, ErrorCode.WORKFORCE_LICENSE_REQUIRED);
	let data: Record<string, unknown>;
	try {
		data = (await ctx.body<Record<string, unknown>>()) ?? {};
	} catch {
		return Utils.fail(ctx, ErrorCode.INVALID_TICKET_COMMENT);
	}
	const comment = readComment({ body: data.body });
	if (!comment) return Utils.fail(ctx, ErrorCode.INVALID_TICKET_COMMENT);

	const uuid = crypto.randomUUID();
	const now = Date.now();
	await Database.begin(async (tx) => {
		await tx`
			INSERT INTO ticket_comments(uuid, ticket, author, author_email, author_name, body, internal, created, updated)
			VALUES(${uuid}, ${ticket.uuid}, NULL, ${email}, ${ticket.customer_name?.trim() || email}, ${comment.body}, 0, ${now}, ${now})
		`;
		const reopened = ticket.status === "waiting" ? "open" : ticket.status;
		await tx`UPDATE tickets SET status = ${reopened}, updated = ${now} WHERE uuid = ${ticket.uuid}`;
	});
	const [row] = (await Database`SELECT * FROM ticket_comments WHERE uuid = ${uuid}`) as TicketCommentRow[];
	await notifyTeamOfCustomer(ticket, "comment", comment.body);
	const { author, author_email, ...visible } = presentComment(row);
	return Utils.ok(ctx, { ...visible, mine: true }, 201);
});

Server.app.get("/api/v1/customer/ticket-access", CustomerAuth.required(), async (ctx) => {
	const rows = await portalAccess(CustomerAuth.email(ctx));
	return Utils.ok(
		ctx,
		rows
			.filter((row) => workforceActive(row))
			.map((row) => ({ project: row.project_id, merchant: merchantOf(row), kinds: parsePortalKinds(row.kinds) }))
			.filter((row) => row.kinds.length > 0)
	);
});

Server.app.post("/api/v1/customer/tickets", CustomerAuth.required(), writeLimit, async (ctx) => {
	const email = CustomerAuth.email(ctx);
	let data: Record<string, unknown>;
	try {
		data = (await ctx.body<Record<string, unknown>>()) ?? {};
	} catch {
		return Utils.fail(ctx, ErrorCode.INVALID_TICKET);
	}
	const access = (await portalAccess(email)).find((row) => row.project_id === data.project);
	const kinds = parsePortalKinds(access?.kinds);
	if (!access || !workforceActive(access) || !kinds.includes(data.kind as TicketKind)) return Utils.fail(ctx, ErrorCode.TICKET_ACCESS_DENIED);
	const title = data.title;
	const description = data.description ?? null;
	if (typeof title !== "string" || !title.trim() || title.length > 200) return Utils.fail(ctx, ErrorCode.INVALID_TICKET);
	if (description !== null && (typeof description !== "string" || description.length > MAX_DESCRIPTION_LENGTH))
		return Utils.fail(ctx, ErrorCode.INVALID_TICKET);

	const uuid = await insertTicket(
		access.project_id,
		{
			title: title.trim(),
			description: typeof description === "string" && description.trim() ? description.trim() : null,
			kind: data.kind as TicketKind,
			status: "open",
			priority: "normal",
			customer: access.customer_id,
			customer_visible: true,
			estimate_minutes: null,
			hourly_rate: null,
			due_on: null,
			assignees: [],
		},
		{ username: null, email }
	);
	const ticket = await portalTicket(email, uuid);
	await notifyTeamOfCustomer(ticket!, "created", ticket!.description);
	return Utils.ok(ctx, presentPortalTicket(ticket!, [], email), 201);
});
