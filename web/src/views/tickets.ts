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
		value: ticket?.hourly_rate == null || ticket.fixed_price !== null ? "" : String(toMajorUnits(ticket.hourly_rate, project.currency)),
	});
	const fixedPrice = input("number", {
		min: "0.01",
		step: "0.01",
		value: ticket?.fixed_price == null ? "" : String(toMajorUnits(ticket.fixed_price, project.currency)),
	});
	rate.addEventListener("input", () => {
		if (rate.value !== "") fixedPrice.value = "";
	});
	fixedPrice.addEventListener("input", () => {
		if (fixedPrice.value !== "") rate.value = "";
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
					fixed_price: fixedPrice.value === "" ? null : toMinorUnits(Number(fixedPrice.value), project.currency),
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
			{ class: "form-grid three" },
			field(t("ticket.rate", { currency: project.currency }), rate, t("ticket.rate_hint")),
			field(t("ticket.fixed_price", { currency: project.currency }), fixedPrice, t("ticket.fixed_price_hint")),
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

function ticketCanBeInvoiced(ticket: Ticket): boolean {
	return ticket.fixed_price !== null ? !ticket.fixed_price_invoiced : ticket.uninvoiced_minutes > 0;
}

type TicketViewMode = "list" | "board";

const TICKET_VIEW_KEY = "rabbitpay.tickets.view";

function savedTicketView(): TicketViewMode {
	try {
		return localStorage.getItem(TICKET_VIEW_KEY) === "board" ? "board" : "list";
	} catch {
		return "list";
	}
}

function saveTicketView(view: TicketViewMode) {
	try {
		localStorage.setItem(TICKET_VIEW_KEY, view);
	} catch {
		void 0;
	}
}

function ticketBoardCard(project: Project, ticket: Ticket, movable: boolean, showPricing: boolean, onMove: (status: TicketStatus) => void): HTMLElement {
	const card = el(
		"article",
		{ class: `ticket-board-card priority-${ticket.priority}` },
		el(
			"div",
			{ class: "ticket-board-card-head" },
			el("a", { href: `/projects/${project.uuid}/tickets/${ticket.uuid}` }, ticket.title),
			el("span", { class: "mono muted" }, `#${ticket.number}`)
		),
		el(
			"div",
			{ class: "ticket-board-tags" },
			el("span", { class: "ticket-board-kind" }, ticketKindLabel(ticket.kind)),
			el("span", { class: `ticket-board-priority priority-${ticket.priority}` }, ticketPriorityLabel(ticket.priority)),
			ticket.reported_by ? el("span", { class: "muted" }, t("ticket.from_customer")) : null
		),
		ticket.customer_name ? el("div", { class: "ticket-board-detail muted" }, ticket.customer_name) : null,
		el("div", { class: "ticket-board-detail" }, assigneeNames(ticket) || t("ticket.unassigned")),
		ticket.due_on || ticket.logged_minutes || (showPricing && ticket.fixed_price !== null)
			? el(
					"div",
					{ class: "ticket-board-card-foot muted" },
					ticket.due_on ? el("span", {}, `${t("ticket.due")}: ${formatDay(ticket.due_on, project)}`) : null,
					showPricing && ticket.fixed_price !== null
						? el("span", {}, `${t("ticket.fixed_price_short")}: ${formatMoney(ticket.fixed_price, project.currency)}`)
						: ticket.logged_minutes
							? el("span", { class: "mono" }, `${t("ticket.logged")}: ${formatHours(ticket.logged_minutes)}`)
							: null
				)
			: null
	);

	if (movable) {
		card.draggable = true;
		card.addEventListener("dragstart", (event) => {
			card.classList.add("dragging");
			event.dataTransfer?.setData("text/plain", ticket.uuid);
			if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
		});
		card.addEventListener("dragend", () => card.classList.remove("dragging"));

		const move = select(statusOptions(), ticket.status);
		move.className = "ticket-board-move";
		move.setAttribute("aria-label", t("ticket.move_to"));
		move.addEventListener("change", () => onMove(move.value as TicketStatus));
		move.addEventListener("dragstart", (event) => event.stopPropagation());
		card.append(move);
	}

	return card;
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
		const surface = el("div", { class: "card" }, body);
		const controls = pagination(() => load());
		const canMove = state.license.active && can(project, Permission.TICKET_WORK);
		const showPricing = can(project, Permission.TICKET_MANAGE);
		let view = savedTicketView();
		let debounce: ReturnType<typeof setTimeout>;
		let boardTickets: Record<TicketStatus, Ticket[]> = { open: [], in_progress: [], waiting: [], resolved: [], closed: [] };
		let boardTotals: Record<TicketStatus, number> = { open: 0, in_progress: 0, waiting: 0, resolved: 0, closed: 0 };
		const moving = new Set<string>();
		const loadingColumns = new Set<TicketStatus>();
		let boardVersion = 0;

		const findBoardTicket = (ticket: string): Ticket | undefined => {
			for (const ticketStatus of TICKET_STATUSES) {
				const found = boardTickets[ticketStatus].find((entry) => entry.uuid === ticket);
				if (found) return found;
			}
			return undefined;
		};

		const renderBoard = () => {
			const loadMore = async (ticketStatus: TicketStatus) => {
				if (loadingColumns.has(ticketStatus) || boardTickets[ticketStatus].length >= boardTotals[ticketStatus]) return;
				const version = boardVersion;
				loadingColumns.add(ticketStatus);
				renderBoard();
				try {
					const result = await Api.tickets(uuid, {
						status: ticketStatus,
						assignee: assignee.value || undefined,
						search: search.value.trim() || undefined,
						limit: 200,
						offset: boardTickets[ticketStatus].length,
					});
					if (version !== boardVersion) return;
					const known = new Set(boardTickets[ticketStatus].map((ticket) => ticket.uuid));
					boardTickets[ticketStatus].push(...result.tickets.filter((ticket) => !known.has(ticket.uuid)));
					boardTotals[ticketStatus] = result.total;
				} catch (error) {
					if (version === boardVersion) reportError(error);
				} finally {
					loadingColumns.delete(ticketStatus);
					if (version === boardVersion) renderBoard();
				}
			};

			const moveTicket = async (ticket: Ticket, nextStatus: TicketStatus) => {
				const previousStatus = ticket.status;
				if (previousStatus === nextStatus || moving.has(ticket.uuid)) return;
				const previousIndex = boardTickets[previousStatus].findIndex((entry) => entry.uuid === ticket.uuid);
				boardTickets[previousStatus].splice(previousIndex, 1);
				boardTickets[nextStatus].unshift(ticket);
				boardTotals[previousStatus] = Math.max(0, boardTotals[previousStatus] - 1);
				boardTotals[nextStatus] += 1;
				ticket.status = nextStatus;
				moving.add(ticket.uuid);
				renderBoard();
				try {
					Object.assign(ticket, await Api.updateTicket(uuid, ticket.uuid, { status: nextStatus }));
				} catch (error) {
					boardTickets[nextStatus] = boardTickets[nextStatus].filter((entry) => entry.uuid !== ticket.uuid);
					boardTickets[previousStatus].splice(Math.max(0, previousIndex), 0, ticket);
					boardTotals[nextStatus] = Math.max(0, boardTotals[nextStatus] - 1);
					boardTotals[previousStatus] += 1;
					ticket.status = previousStatus;
					reportError(error);
				} finally {
					moving.delete(ticket.uuid);
					renderBoard();
				}
			};

			const columns = TICKET_STATUSES.map((ticketStatus) => {
				const headingId = `ticket-board-${ticketStatus}`;
				const column = el(
					"section",
					{ class: "ticket-board-column" },
					el(
						"header",
						{ class: "ticket-board-column-head" },
						el("h3", { id: headingId }, ticketPill(ticketStatus)),
						el("span", { class: "ticket-board-count" }, boardTotals[ticketStatus].toLocaleString())
					),
					el(
						"div",
						{ class: "ticket-board-cards" },
						...boardTickets[ticketStatus].map((ticket) =>
							ticketBoardCard(project, ticket, canMove && !moving.has(ticket.uuid), showPricing, (nextStatus) => void moveTicket(ticket, nextStatus))
						),
						boardTickets[ticketStatus].length === 0 ? el("p", { class: "ticket-board-empty muted" }, t("ticket.column_empty")) : null,
						boardTickets[ticketStatus].length < boardTotals[ticketStatus]
							? el(
									"button",
									{
										class: "button ghost small ticket-board-more",
										type: "button",
										disabled: loadingColumns.has(ticketStatus),
										onClick: () => void loadMore(ticketStatus),
									},
									loadingColumns.has(ticketStatus)
										? t("ui.loading")
										: t("ticket.load_more", { count: boardTotals[ticketStatus] - boardTickets[ticketStatus].length })
								)
							: null
					)
				);
				column.setAttribute("aria-labelledby", headingId);
				if (canMove) {
					column.addEventListener("dragover", (event) => {
						event.preventDefault();
						if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
						column.classList.add("drag-over");
					});
					column.addEventListener("dragleave", (event) => {
						if (!column.contains(event.relatedTarget as Node | null)) column.classList.remove("drag-over");
					});
					column.addEventListener("drop", (event) => {
						event.preventDefault();
						column.classList.remove("drag-over");
						const ticket = findBoardTicket(event.dataTransfer?.getData("text/plain") ?? "");
						if (ticket) void moveTicket(ticket, ticketStatus);
					});
				}
				return column;
			});
			body.replaceChildren(el("div", { class: "ticket-board" }, ...columns));
		};

		const load = async (): Promise<void> => {
			const round = controls.state.begin();
			const currentBoardVersion = ++boardVersion;
			try {
				if (view === "board") {
					const results = await Promise.all(
						TICKET_STATUSES.map((ticketStatus) =>
							Api.tickets(uuid, {
								status: ticketStatus,
								assignee: assignee.value || undefined,
								search: search.value.trim() || undefined,
								limit: 200,
							})
						)
					);
					if (!controls.state.current(round) || currentBoardVersion !== boardVersion) return;
					for (const [index, ticketStatus] of TICKET_STATUSES.entries()) {
						boardTickets[ticketStatus] = results[index].tickets;
						boardTotals[ticketStatus] = results[index].total;
					}
					renderBoard();
					return;
				}
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
					controls.element.hidden = view === "board";
					reportError(error);
				}
			}
		};
		const reload = () => {
			controls.reset();
			controls.element.hidden = view === "board";
			void load();
		};
		const viewToggle = el("div", { class: "segmented ticket-view-toggle" });
		viewToggle.setAttribute("role", "radiogroup");
		viewToggle.setAttribute("aria-label", t("ticket.view"));
		const viewChoices = (["list", "board"] as TicketViewMode[]).map((value) => {
			const button = el("button", { class: "segment", type: "button" }, t(`ticket.view_${value}`));
			button.setAttribute("role", "radio");
			button.addEventListener("click", () => {
				if (view === value) return;
				view = value;
				saveTicketView(view);
				syncView();
				reload();
			});
			viewToggle.append(button);
			return { value, button };
		});
		const syncView = () => {
			status.hidden = view === "board";
			controls.element.hidden = view === "board";
			surface.className = view === "board" ? "ticket-board-surface" : "card";
			for (const choice of viewChoices) {
				choice.button.classList.toggle("active", choice.value === view);
				choice.button.setAttribute("aria-checked", String(choice.value === view));
			}
		};
		status.addEventListener("change", reload);
		assignee.addEventListener("change", reload);
		search.addEventListener("input", () => {
			clearTimeout(debounce);
			debounce = setTimeout(reload, 250);
		});
		syncView();
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
				viewToggle,
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
			surface,
			controls.element
		);
	});
}

async function ticketInvoiceDialog(project: Project, initial: Ticket): Promise<void> {
	try {
		const candidates: Ticket[] = [];
		let offset = 0;
		let total = 0;
		do {
			const result = await Api.tickets(project.uuid, {
				status: "all",
				customer: initial.customer ?? undefined,
				limit: 200,
				offset,
			});
			total = result.total;
			candidates.push(...result.tickets.filter((ticket) => ticket.customer === initial.customer && ticketCanBeInvoiced(ticket)));
			offset += result.tickets.length;
		} while (offset < total);

		if (!candidates.some((ticket) => ticket.uuid === initial.uuid) && ticketCanBeInvoiced(initial)) candidates.unshift(initial);
		const unique = [...new Map(candidates.map((ticket) => [ticket.uuid, ticket])).values()];
		const choices = unique.map((ticket) => {
			const checkbox = input("checkbox", { value: ticket.uuid });
			checkbox.checked = ticket.uuid === initial.uuid;
			const element = el(
				"label",
				{ class: "ticket-invoice-choice" },
				checkbox,
				el(
					"span",
					{ class: "ticket-invoice-choice-main" },
					el("strong", {}, `#${ticket.number} ${ticket.title}`),
					el(
						"span",
						{ class: "ticket-invoice-choice-meta" },
						ticketPill(ticket.status),
						el(
							"span",
							{ class: "muted mono" },
							ticket.fixed_price !== null
								? formatMoney(ticket.fixed_price, project.currency)
								: t("ticket.invoice_hours", { hours: formatHours(ticket.uninvoiced_minutes) })
						)
					)
				)
			);
			return { ticket, checkbox, element };
		});
		const search = input("search", { placeholder: t("ticket.invoice_search") });
		const initialStatus = initial.status === "resolved" || initial.status === "closed" ? "done" : initial.status;
		const status = select(
			[{ value: "done", label: t("ticket.filter_done") }, { value: "all", label: t("ticket.filter_all") }, ...statusOptions()],
			initialStatus
		);
		const noMatches = el("p", { class: "ticket-board-empty muted" }, t("ticket.invoice_no_matches"));
		let syncSelection = () => {};
		const syncFilter = () => {
			const query = search.value.trim().toLowerCase();
			const numberQuery = query.startsWith("#") ? query.slice(1) : query;
			let shown = 0;
			let selectionChanged = false;
			for (const choice of choices) {
				const matchesSearch =
					!query || choice.ticket.title.toLowerCase().includes(query) || (numberQuery !== "" && String(choice.ticket.number).includes(numberQuery));
				const matchesStatus =
					status.value === "all" ||
					(status.value === "done" ? choice.ticket.status === "resolved" || choice.ticket.status === "closed" : choice.ticket.status === status.value);
				if (!matchesStatus && choice.checkbox.checked) {
					choice.checkbox.checked = false;
					selectionChanged = true;
				}
				choice.element.hidden = !matchesSearch || !matchesStatus;
				if (!choice.element.hidden) shown++;
			}
			noMatches.hidden = shown > 0;
			if (selectionChanged) syncSelection();
		};
		search.addEventListener("input", syncFilter);
		status.addEventListener("change", syncFilter);
		const summary = el("p", { class: "ticket-invoice-summary muted" });
		const submit = el("button", { class: "button primary", type: "submit" }, t("ticket.invoice_create_draft"));
		const sync = () => {
			const selected = choices.filter((choice) => choice.checkbox.checked);
			const minutes = selected.reduce((sum, choice) => sum + choice.ticket.uninvoiced_minutes, 0);
			summary.textContent = t("ticket.invoice_selection", { count: selected.length, hours: formatHours(minutes) });
			submit.disabled = selected.length === 0;
		};
		syncSelection = sync;
		for (const choice of choices) choice.checkbox.addEventListener("change", sync);

		const form = el(
			"form",
			{
				class: "stack",
				onSubmit: async (event) => {
					event.preventDefault();
					const selected = choices.filter((choice) => choice.checkbox.checked).map((choice) => choice.ticket.uuid);
					if (selected.length === 0) return;
					submit.disabled = true;
					try {
						const result = await Api.invoiceTickets(project.uuid, selected);
						dialog.close();
						toast(t("ticket.invoiced", { reference: result.reference }), "success");
						navigate(`/projects/${project.uuid}/invoices/${result.invoice}`);
					} catch (error) {
						reportError(error);
						submit.disabled = false;
					}
				},
			},
			el("p", {}, t("ticket.invoice_customer", { customer: initial.customer_name ?? t("ticket.no_customer") })),
			el("p", { class: "muted" }, t("ticket.invoice_multi_hint")),
			el("div", { class: "form-grid" }, field(t("ticket.invoice_search_label"), search), field(t("ticket.status"), status)),
			el("div", { class: "ticket-invoice-choices" }, ...choices.map((choice) => choice.element), noMatches),
			summary,
			el("div", { class: "form-actions" }, submit)
		);
		const dialog = modal(t("ticket.invoice_title"), form);
		sync();
		syncFilter();
	} catch (error) {
		reportError(error);
	}
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
			[t("ticket.opened"), `${when(project, ticket.created)} | ${ticket.reported_by ?? ticket.created_by ?? ""}`],
		];
		if (manages) {
			facts.splice(
				facts.length - 1,
				0,
				[t("ticket.rate_short"), ticket.fixed_price !== null || ticket.hourly_rate === null ? "-" : formatMoney(ticket.hourly_rate, project.currency)],
				[t("ticket.fixed_price_short"), ticket.fixed_price === null ? "-" : formatMoney(ticket.fixed_price, project.currency)]
			);
		}

		const actions = el(
			"div",
			{ class: "line-actions" },
			manages
				? el("button", { class: "button ghost", type: "button", onClick: () => void ticketDialog(project, ticket, () => void reload()) }, t("ui.edit"))
				: null,
			manages && can(project, Permission.INVOICE_CREATE) && ticketCanBeInvoiced(ticket)
				? el(
						"button",
						{
							class: "button primary",
							type: "button",
							onClick: () => void ticketInvoiceDialog(project, ticket),
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
