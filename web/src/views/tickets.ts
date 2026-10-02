import {
	Api,
	customerLabel,
	type Customer,
	type Member,
	type Project,
	type Ticket,
	type TicketDetails,
	type TicketInput,
	type TicketKind,
	type TicketPriority,
	type TicketStatus,
	type WorkforceState,
} from "../api";
import { el, emptyState, field, input, select, table } from "../dom";
import { formatDateTime, formatMoney, toMajorUnits, toMinorUnits } from "../money";
import { can, Permission } from "../access";
import { t } from "../i18n";
import { navigate } from "../router";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { pagination, PAGE_SIZE } from "../pagination";
import { markdownEditor, markdownView } from "../markdown-editor";
import {
	formatDay,
	formatHours,
	hoursInput,
	minutesFrom,
	TICKET_KINDS,
	TICKET_PRIORITIES,
	TICKET_STATUSES,
	ticketKindLabel,
	ticketPill,
	ticketPriorityLabel,
	workforceGate,
} from "./workforce-shared";
import type { DateFormat, TimeFormat } from "../../../server/formats";

function when(project: Project, timestamp: number): string {
	return formatDateTime(timestamp, project.date_format as DateFormat, project.time_format as TimeFormat, project.timezone);
}

function statusOptions(): { value: string; label: string }[] {
	return TICKET_STATUSES.map((status) => ({ value: status, label: t(`ticket.status_${status}`) }));
}

async function ticketChoices(project: Project): Promise<{ members: Member[]; customers: Customer[] }> {
	const [members, customers] = await Promise.all([
		Api.members(project.uuid),
		can(project, Permission.CUSTOMER_VIEW) ? Api.customers(project.uuid, { limit: 200 }).then((result) => result.customers) : Promise.resolve([] as Customer[]),
	]);
	return { members: members.filter((member) => member.status === "active"), customers };
}

async function ticketDialog(project: Project, ticket: Ticket | null, onSaved: (ticket: Ticket) => void) {
	const { members, customers } = await ticketChoices(project);
	const title = input("text", { required: true, maxlength: "200", value: ticket?.title ?? "" });
	const descriptionEditor = markdownEditor({ value: ticket?.description ?? "", rows: 12, maxlength: 20000 });
	const description = descriptionEditor.textarea;
	const kind = select(
		TICKET_KINDS.map((value) => ({ value, label: ticketKindLabel(value) })),
		ticket?.kind ?? "task"
	);
	const priority = select(
		TICKET_PRIORITIES.map((value) => ({ value, label: ticketPriorityLabel(value) })),
		ticket?.priority ?? "normal"
	);
	const status = select(statusOptions(), ticket?.status ?? "open");
	const customerOptions = [
		{ value: "", label: t("ticket.no_customer") },
		...customers.map((customer) => ({ value: customer.uuid, label: customerLabel(customer) })),
	];
	if (ticket?.customer && !customers.some((customer) => customer.uuid === ticket.customer)) {
		customerOptions.push({ value: ticket.customer, label: ticket.customer_name ?? ticket.customer });
	}
	const customer = select(customerOptions, ticket?.customer ?? "");
	const visible = input("checkbox");
	visible.checked = ticket?.customer_visible ?? true;
	const rate = input("number", {
		min: "0",
		step: "0.01",
		value: ticket?.hourly_rate == null ? "" : String(toMajorUnits(ticket.hourly_rate, project.currency)),
	});
	const estimate = hoursInput(ticket?.estimate_minutes ?? null);
	const due = input("date", { value: ticket?.due_on ?? "" });
	const assigned = new Set(ticket?.assignees.map((assignee) => assignee.member) ?? []);
	const checks = members.map((member) => {
		const box = input("checkbox", { value: member.uuid });
		box.checked = assigned.has(member.uuid);
		return {
			box,
			element: el("label", { class: "switch" }, box, el("span", {}, member.full_name || member.account_username || member.invitation_email || "")),
		};
	});
	const submit = el("button", { class: "button primary", type: "submit" }, t("ui.save"));

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				const body: TicketInput = {
					title: title.value.trim(),
					description: description.value.trim() || null,
					kind: kind.value as TicketKind,
					priority: priority.value as TicketPriority,
					status: status.value as TicketStatus,
					customer: customer.value || null,
					customer_visible: visible.checked,
					hourly_rate: rate.value === "" ? null : toMinorUnits(Number(rate.value), project.currency),
					estimate_minutes: minutesFrom(estimate),
					due_on: due.value || null,
					assignees: checks.filter((check) => check.box.checked).map((check) => check.box.value),
				};
				try {
					const saved = ticket ? await Api.updateTicket(project.uuid, ticket.uuid, body) : await Api.createTicket(project.uuid, body);
					toast(t("ticket.saved"), "success");
					dialog.close();
					onSaved(saved);
				} catch (error) {
					reportError(error);
				} finally {
					submit.disabled = false;
				}
			},
		},
		field(t("ticket.title"), title),
		el("div", { class: "field" }, el("span", { class: "field-label" }, t("ticket.description")), descriptionEditor.element),
		el("div", { class: "form-grid three" }, field(t("ticket.kind"), kind), field(t("ticket.priority"), priority), field(t("ticket.status"), status)),
		el("div", { class: "form-grid" }, field(t("ticket.customer"), customer), field(t("ticket.due"), due)),
		el("label", { class: "switch" }, visible, el("span", {}, t("ticket.customer_visible"))),
		el(
			"div",
			{ class: "form-grid" },
			field(t("ticket.rate", { currency: project.currency }), rate, t("ticket.rate_hint")),
			field(t("ticket.estimate"), estimate)
		),
		members.length ? el("fieldset", { class: "stack-tight" }, el("legend", {}, t("ticket.assignees")), ...checks.map((check) => check.element)) : null,
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(ticket ? t("ticket.edit") : t("ticket.new"), form);
}

function assigneeNames(ticket: Ticket): string {
	return ticket.assignees.map((assignee) => assignee.name).join(", ");
}

export async function ticketsView(uuid: string): Promise<HTMLElement> {
	return workforceGate(uuid, (project, state) => {
		const status = select(
			[{ value: "active", label: t("ticket.filter_active") }, { value: "all", label: t("ticket.filter_all") }, ...statusOptions()],
			"active"
		);
		const assignee = select(
			[
				{ value: "", label: t("ticket.anyone") },
				{ value: "me", label: t("ticket.assigned_to_me") },
			],
			state.me.own && !can(project, Permission.TICKET_MANAGE) ? "me" : ""
		);
		const search = input("search", { placeholder: t("ticket.search") });
		const body = el("div", {});
		const controls = pagination(() => load());
		let debounce: ReturnType<typeof setTimeout>;

		const load = async (): Promise<void> => {
			const round = controls.state.begin();
			try {
				const result = await Api.tickets(uuid, {
					status: status.value,
					assignee: assignee.value || undefined,
					search: search.value.trim() || undefined,
					limit: PAGE_SIZE,
					offset: controls.state.offset,
				});
				if (!controls.state.current(round)) return;
				if (controls.update(result.total)) return await load();
				body.replaceChildren(
					result.tickets.length === 0
						? emptyState(t("ticket.empty"))
						: table(
								[
									t("ticket.number"),
									t("ticket.title"),
									t("ticket.status"),
									t("ticket.priority"),
									t("ticket.customer"),
									t("ticket.assignees"),
									t("ticket.logged"),
									t("ticket.updated"),
								],
								result.tickets.map((ticket) =>
									el(
										"tr",
										{},
										el("td", { class: "mono" }, `#${ticket.number}`),
										el(
											"td",
											{},
											el("a", { href: `/projects/${uuid}/tickets/${ticket.uuid}` }, ticket.title),
											el("div", { class: "muted" }, ticketKindLabel(ticket.kind), ticket.reported_by ? ` | ${t("ticket.from_customer")}` : "")
										),
										el("td", {}, ticketPill(ticket.status)),
										el("td", {}, ticketPriorityLabel(ticket.priority)),
										el("td", {}, ticket.customer_name ?? ""),
										el("td", {}, assigneeNames(ticket)),
										el("td", { class: "numeric mono" }, ticket.logged_minutes ? formatHours(ticket.logged_minutes) : ""),
										el("td", {}, when(project, ticket.updated))
									)
								)
							)
				);
			} catch (error) {
				if (controls.state.current(round)) {
					controls.fail();
					reportError(error);
				}
			}
		};
		const reload = () => {
			controls.reset();
			void load();
		};
		status.addEventListener("change", reload);
		assignee.addEventListener("change", reload);
		search.addEventListener("input", () => {
			clearTimeout(debounce);
			debounce = setTimeout(reload, 250);
		});
		void load();

		const creates = state.license.active && can(project, Permission.TICKET_MANAGE);
		return el(
			"div",
			{ class: "stack" },
			el(
				"div",
				{ class: "toolbar" },
				status,
				assignee,
				search,
				creates
					? el(
							"button",
							{
								class: "button primary",
								type: "button",
								onClick: () => void ticketDialog(project, null, (ticket) => navigate(`/projects/${uuid}/tickets/${ticket.uuid}`)),
							},
							t("ticket.new")
						)
					: null
			),
			el("div", { class: "card" }, body),
			controls.element
		);
	});
}

function commentForm(project: Project, ticket: TicketDetails, onSaved: () => void): HTMLElement {
	const editor = markdownEditor({ rows: 10, maxlength: 10000, required: true, placeholder: t("ticket.comment_placeholder") });
	const body = editor.textarea;
	const internal = input("checkbox");
	internal.checked = ticket.customer === null || !ticket.customer_visible;
	const submit = el("button", { class: "button primary", type: "submit" }, t("ticket.comment_send"));
	return el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					await Api.commentTicket(project.uuid, ticket.uuid, body.value.trim(), internal.checked);
					onSaved();
				} catch (error) {
					reportError(error);
				} finally {
					submit.disabled = false;
				}
			},
		},
		editor.element,
		el(
			"div",
			{ class: "form-actions" },
			ticket.customer && ticket.customer_visible ? el("label", { class: "switch" }, internal, el("span", {}, t("ticket.internal"))) : null,
			submit
		)
	);
}

function ticketDetail(project: Project, state: WorkforceState, initial: TicketDetails): HTMLElement {
	const container = el("div", { class: "stack" });
	const uuid = project.uuid;
	const active = state.license.active;
	const manages = active && can(project, Permission.TICKET_MANAGE);
	const works = active && can(project, Permission.TICKET_WORK);

	const reload = async () => {
		try {
			render(await Api.ticket(uuid, initial.uuid));
		} catch (error) {
			reportError(error);
		}
	};

	const render = (ticket: TicketDetails) => {
		const status = select(statusOptions(), ticket.status);
		status.disabled = !works;
		status.addEventListener("change", async () => {
			try {
				await Api.updateTicket(uuid, ticket.uuid, { status: status.value as TicketStatus });
				toast(t("ticket.saved"), "success");
				void reload();
			} catch (error) {
				reportError(error);
			}
		});

		const facts: [string, HTMLElement | string][] = [
			[t("ticket.status"), status],
			[t("ticket.kind"), ticketKindLabel(ticket.kind)],
			[t("ticket.priority"), ticketPriorityLabel(ticket.priority)],
			[
				t("ticket.customer"),
				ticket.customer
					? el(
							"span",
							{},
							el("a", { href: `/projects/${uuid}/customers/${ticket.customer}` }, ticket.customer_name ?? ""),
							ticket.customer_visible ? "" : ` (${t("ticket.hidden")})`
						)
					: "-",
			],
			[t("ticket.assignees"), assigneeNames(ticket) || "-"],
			[t("ticket.due"), ticket.due_on ? formatDay(ticket.due_on, project) : "-"],
			[t("ticket.estimate"), ticket.estimate_minutes ? formatHours(ticket.estimate_minutes) : "-"],
			[t("ticket.logged"), formatHours(ticket.logged_minutes)],
			[t("ticket.uninvoiced"), formatHours(ticket.uninvoiced_minutes)],
			[t("ticket.rate_short"), ticket.hourly_rate === null ? "-" : formatMoney(ticket.hourly_rate, project.currency)],
			[t("ticket.opened"), `${when(project, ticket.created)} | ${ticket.reported_by ?? ticket.created_by ?? ""}`],
		];

		const actions = el(
			"div",
			{ class: "line-actions" },
			manages
				? el("button", { class: "button ghost", type: "button", onClick: () => void ticketDialog(project, ticket, () => void reload()) }, t("ui.edit"))
				: null,
			manages && can(project, Permission.INVOICE_CREATE) && ticket.uninvoiced_minutes > 0
				? el(
						"button",
						{
							class: "button primary",
							type: "button",
							onClick: async () => {
								const confirmed = await confirmDialog({
									title: t("ticket.invoice_title"),
									body: t("ticket.invoice_body", { hours: formatHours(ticket.uninvoiced_minutes) }),
									confirmLabel: t("ticket.invoice_create"),
								});
								if (!confirmed) return;
								try {
									const result = await Api.invoiceTicket(uuid, ticket.uuid);
									toast(t("ticket.invoiced", { reference: result.reference }), "success");
									navigate(`/projects/${uuid}/invoices/${result.invoice}`);
								} catch (error) {
									reportError(error);
								}
							},
						},
						t("ticket.invoice_create")
					)
				: null,
			manages
				? el(
						"button",
						{
							class: "button danger",
							type: "button",
							onClick: async () => {
								const confirmed = await confirmDialog({
									title: t("ticket.delete_title"),
									body: t("ticket.delete_body"),
									confirmLabel: t("ui.delete"),
									destructive: true,
								});
								if (!confirmed) return;
								try {
									await Api.deleteTicket(uuid, ticket.uuid);
									navigate(`/projects/${uuid}/tickets`);
								} catch (error) {
									reportError(error);
								}
							},
						},
						t("ui.delete")
					)
				: null
		);

		const comments = ticket.comments.map((comment) =>
			el(
				"article",
				{ class: `ticket-comment${comment.internal ? " internal" : ""}${comment.from_customer ? " customer" : ""}` },
				el(
					"header",
					{},
					el("strong", {}, comment.author_name),
					el("span", { class: "muted" }, ` | ${when(project, comment.created)}`),
					comment.internal ? el("span", { class: "pill pill-draft" }, t("ticket.internal_short")) : null,
					comment.from_customer ? el("span", { class: "pill pill-open" }, t("ticket.from_customer")) : null
				),
				markdownView(comment.body, "markdown-compact")
			)
		);

		container.replaceChildren(
			el(
				"div",
				{ class: "page-head" },
				el("div", {}, el("a", { class: "back-link", href: `/projects/${uuid}/tickets` }, t("ticket.back")), el("h2", {}, `#${ticket.number} ${ticket.title}`)),
				ticketPill(ticket.status)
			),
			el(
				"div",
				{ class: "order-layout" },
				el(
					"div",
					{ class: "stack" },
					el("div", { class: "card" }, ticket.description ? markdownView(ticket.description) : el("p", { class: "muted" }, t("ticket.no_description"))),
					el(
						"div",
						{ class: "card stack" },
						el("h2", {}, t("ticket.comments")),
						...(comments.length ? comments : [el("p", { class: "muted" }, t("ticket.no_comments"))]),
						works ? commentForm(project, ticket, () => void reload()) : null
					)
				),
				el(
					"div",
					{ class: "stack" },
					el("div", { class: "card" }, el("dl", { class: "facts" }, ...facts.flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, value)])), actions),
					ticket.time_by_person.length
						? el(
								"div",
								{ class: "card" },
								el("h2", {}, t("ticket.time_by_person")),
								table(
									[t("workforce.person"), t("ticket.logged")],
									ticket.time_by_person.map((row) => el("tr", {}, el("td", {}, row.person), el("td", { class: "mono" }, formatHours(row.minutes))))
								)
							)
						: null
				)
			)
		);
	};

	render(initial);
	return container;
}

export async function ticketView(uuid: string, ticket: string): Promise<HTMLElement> {
	return workforceGate(uuid, async (project, state) => ticketDetail(project, state, await Api.ticket(uuid, ticket)));
}

export async function ticketAccessCard(project: Project, customer: string): Promise<HTMLElement | null> {
	if (!project.workforce || !can(project, Permission.TICKET_VIEW)) return null;
	const access = await Api.ticketAccess(project.uuid, customer);
	const editable = can(project, Permission.TICKET_MANAGE);
	const kinds = ["support", "bug", "feature"] as const;
	const enabled = input("checkbox");
	enabled.checked = access.enabled;
	enabled.disabled = !editable;
	const boxes = kinds.map((kind) => {
		const box = input("checkbox", { value: kind });
		box.checked = access.kinds.includes(kind);
		return box;
	});
	const kindList = el(
		"div",
		{ class: "stack-tight" },
		el("span", { class: "muted" }, t("ticket.portal_kinds_hint")),
		...kinds.map((kind, index) => el("label", { class: "switch" }, boxes[index], el("span", {}, t(`ticket.portal_${kind}`))))
	);
	const sync = () => {
		kindList.hidden = !enabled.checked;
		for (const box of boxes) box.disabled = !editable || !enabled.checked;
	};
	enabled.addEventListener("change", sync);
	sync();

	return el(
		"div",
		{ class: "card stack" },
		el("h2", {}, t("ticket.portal_title")),
		el("p", { class: "muted" }, t("ticket.portal_hint")),
		el("label", { class: "switch" }, enabled, el("span", {}, t("ticket.portal_enabled"))),
		kindList,
		editable
			? el(
					"div",
					{ class: "form-actions" },
					el(
						"button",
						{
							class: "button ghost",
							type: "button",
							onClick: async () => {
								try {
									const saved = await Api.saveTicketAccess(
										project.uuid,
										customer,
										enabled.checked,
										boxes.filter((box) => box.checked).map((box) => box.value as TicketKind)
									);
									for (const [index, kind] of kinds.entries()) boxes[index].checked = saved.kinds.includes(kind);
									toast(t("ticket.portal_saved"), "success");
								} catch (error) {
									reportError(error);
								}
							},
						},
						t("ui.save")
					)
				)
			: null,
		el("a", { class: "link-button", href: `/projects/${project.uuid}/tickets` }, t("ticket.portal_open"))
	);
}
