import { el, emptyState, field, input, select, table } from "../dom";
import { CustomerApi, type CustomerTicket, type CustomerTicketAccess } from "../customer-api";
import { navigate } from "../router";
import { modal, reportError, toast } from "../ui";
import { language, t } from "../i18n";
import { customerHeader } from "./customer-portal";
import { markdownEditor, markdownView } from "../markdown-editor";
import { ticketKindLabel, ticketPill } from "./workforce-shared";
import type { TicketKind } from "../api";

function when(timestamp: number): string {
	return new Intl.DateTimeFormat(language() === "sl" ? "sl-SI" : "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function assigneeText(ticket: CustomerTicket): string {
	if (ticket.assignees.length === 0) return t("portal_tickets.unassigned");
	return ticket.assignees.map((name) => name ?? t("portal_tickets.team_member")).join(", ");
}

function newTicketDialog(access: CustomerTicketAccess[]) {
	const business = select(
		access.map((entry) => ({ value: entry.project, label: entry.merchant })),
		access[0]?.project
	);
	const kind = select([]);
	const syncKinds = () => {
		const entry = access.find((item) => item.project === business.value);
		kind.replaceChildren(...(entry?.kinds ?? []).map((value) => el("option", { value }, ticketKindLabel(value))));
	};
	business.addEventListener("change", syncKinds);
	syncKinds();
	const title = input("text", { required: true, maxlength: "200" });
	const descriptionEditor = markdownEditor({ rows: 12, maxlength: 20000, placeholder: t("portal_tickets.description_placeholder") });
	const description = descriptionEditor.textarea;
	const submit = el("button", { class: "button primary", type: "submit" }, t("portal_tickets.submit"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					const ticket = await CustomerApi.createTicket({
						project: business.value,
						kind: kind.value as TicketKind,
						title: title.value.trim(),
						description: description.value.trim() || null,
					});
					dialog.close();
					toast(t("portal_tickets.created"), "success");
					navigate(`/customer/tickets/${ticket.uuid}`);
				} catch (error) {
					reportError(error);
				} finally {
					submit.disabled = false;
				}
			},
		},
		access.length > 1 ? field(t("portal.business"), business) : null,
		field(t("portal_tickets.kind"), kind),
		field(t("portal_tickets.title_label"), title),
		el("div", { class: "field" }, el("span", { class: "field-label" }, t("portal_tickets.description")), descriptionEditor.element),
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(t("portal_tickets.new"), form);
}

export async function customerTicketsView(): Promise<HTMLElement> {
	const header = await customerHeader("tickets");
	document.title = `${t("portal_tickets.title")} | RabbitPay`;
	const filter = select(
		[
			{ value: "active", label: t("portal_tickets.active") },
			{ value: "closed", label: t("portal_tickets.closed") },
			{ value: "", label: t("portal.all") },
		],
		"active"
	);
	const body = el("div", {});
	const access = await CustomerApi.ticketAccess();

	const load = async () => {
		try {
			const tickets = await CustomerApi.tickets(filter.value);
			body.replaceChildren(
				tickets.length === 0
					? emptyState(t("portal_tickets.empty"))
					: table(
							[
								t("portal_tickets.number"),
								t("portal_tickets.title_label"),
								t("portal.business"),
								t("portal.status"),
								t("portal_tickets.assignees"),
								t("portal_tickets.updated"),
							],
							tickets.map((ticket) =>
								el(
									"tr",
									{},
									el("td", { class: "mono" }, `#${ticket.number}`),
									el(
										"td",
										{},
										el("a", { href: `/customer/tickets/${ticket.uuid}` }, ticket.title),
										el("div", { class: "muted" }, ticketKindLabel(ticket.kind))
									),
									el("td", {}, ticket.merchant),
									el("td", {}, ticketPill(ticket.status)),
									el("td", {}, assigneeText(ticket)),
									el("td", {}, when(ticket.updated))
								)
							)
						)
			);
		} catch (error) {
			reportError(error);
		}
	};
	filter.addEventListener("change", () => void load());
	await load();

	return el(
		"div",
		{},
		header,
		el(
			"div",
			{ class: "page stack" },
			el("h1", {}, t("portal_tickets.title")),
			el(
				"div",
				{ class: "toolbar" },
				field(t("portal_tickets.filter"), filter),
				access.length ? el("button", { class: "button primary", type: "button", onClick: () => newTicketDialog(access) }, t("portal_tickets.new")) : null
			),
			body
		)
	);
}

export async function customerTicketView(uuid: string): Promise<HTMLElement> {
	const header = await customerHeader("tickets");
	const container = el("div", { class: "page stack" });

	const render = async () => {
		const ticket = await CustomerApi.ticket(uuid);
		document.title = `#${ticket.number} ${ticket.title} | RabbitPay`;
		const replyEditor = markdownEditor({ rows: 10, maxlength: 10000, required: true, placeholder: t("portal_tickets.reply_placeholder") });
		const reply = replyEditor.textarea;
		const submit = el("button", { class: "button primary", type: "submit" }, t("portal_tickets.reply"));
		const form = ticket.can_comment
			? el(
					"form",
					{
						class: "stack",
						onSubmit: async (event) => {
							event.preventDefault();
							submit.disabled = true;
							try {
								await CustomerApi.commentTicket(uuid, reply.value.trim());
								await render();
							} catch (error) {
								reportError(error);
							} finally {
								submit.disabled = false;
							}
						},
					},
					replyEditor.element,
					el("div", { class: "form-actions" }, submit)
				)
			: null;
		container.replaceChildren(
			el("a", { class: "back-link", href: "/customer/tickets" }, t("portal_tickets.back")),
			el("div", { class: "page-head" }, el("h1", {}, `#${ticket.number} ${ticket.title}`), ticketPill(ticket.status)),
			el(
				"dl",
				{ class: "facts" },
				el("dt", {}, t("portal.business")),
				el("dd", {}, ticket.merchant),
				el("dt", {}, t("portal_tickets.kind")),
				el("dd", {}, ticketKindLabel(ticket.kind)),
				el("dt", {}, t("portal_tickets.assignees")),
				el("dd", {}, assigneeText(ticket)),
				el("dt", {}, t("portal_tickets.opened")),
				el("dd", {}, when(ticket.created))
			),
			ticket.description ? el("div", { class: "card" }, markdownView(ticket.description)) : "",
			el(
				"div",
				{ class: "card stack" },
				el("h2", {}, t("portal_tickets.conversation")),
				...(ticket.comments.length
					? ticket.comments.map((comment) =>
							el(
								"article",
								{ class: `ticket-comment${comment.mine ? " customer" : ""}` },
								el("header", {}, el("strong", {}, comment.author_name), el("span", { class: "muted" }, ` | ${when(comment.created)}`)),
								markdownView(comment.body, "markdown-compact")
							)
						)
					: [el("p", { class: "muted" }, t("portal_tickets.no_comments"))]),
				form
			)
		);
	};
	await render();
	return el("div", {}, header, container);
}
