import { PageState } from "../../../server/page-state";
import { pagedTable, remoteTable, PAGE_SIZE } from "../pagination";
import { Api, customerLabel, type IntervalUnit, type RecurringDetail, type RecurringInput, type RecurringStatus, type RecurringSummary } from "../api";
import { el, emptyState, field, input, select, statusPill, table } from "../dom";
import { dayStartFromDateInput, formatDate, formatMoney, fromDateInput, toDateInput } from "../money";
import { navigate } from "../router";
import { confirmDialog, reportError, toast } from "../ui";
import { loadProject, projectLayout } from "./project";
import { invoiceEditor } from "./invoice-editor";
import { customerFilter, rememberFilters, searchFilter } from "./list-filters";
import { unitLabel } from "../options";
import { can, Permission } from "../access";
import { t, tn, type UiKey } from "../i18n";
import { MAX_DAYS_UNTIL_DUE, MAX_INTERVAL_COUNT, MAX_OCCURRENCES, startOfDay, upcomingRuns } from "../../../server/recurring-schedule";
import type { DateFormat } from "../../../server/formats";

function statusFilterOptions() {
	return [
		{ value: "", label: t("invoices.all_statuses") },
		{ value: "active", label: t("recurring.status_active") },
		{ value: "paused", label: t("recurring.status_paused") },
		{ value: "completed", label: t("recurring.status_completed") },
		{ value: "canceled", label: t("recurring.status_canceled") },
	];
}

const STATUS_PILLS: Record<RecurringStatus, string> = {
	active: "paid",
	paused: "open",
	completed: "draft",
	canceled: "canceled",
};

const STATUS_KEYS: Record<RecurringStatus, UiKey> = {
	active: "status.active",
	paused: "status.paused",
	completed: "recurring.finished",
	canceled: "status.canceled",
};

function unitOptions(): { value: IntervalUnit; label: string }[] {
	return [
		{ value: "week", label: t("recurring.unit_weeks") },
		{ value: "month", label: t("recurring.unit_months") },
		{ value: "year", label: t("recurring.unit_years") },
	];
}

type Delivery = "email" | "issue" | "draft";

export function everyLabel(unit: IntervalUnit, count: number): string {
	if (unit === "month" && count === 3) return t("recurring.every_quarter");
	return tn(`every.${unit}`, count);
}

function recurringPill(status: RecurringStatus): HTMLElement {
	return el("span", { class: `pill pill-${STATUS_PILLS[status]}` }, t(STATUS_KEYS[status]));
}

function nameOf(recurring: { title: string | null; first_line?: string | null; items?: { description: string }[] }): string {
	return recurring.title || recurring.first_line || recurring.items?.[0]?.description || t("recurring.untitled");
}

function endsLabel(recurring: Pick<RecurringDetail, "max_occurrences" | "end_date" | "occurrences">, dateFormat: DateFormat, timezone: string): string {
	if (recurring.max_occurrences !== null) {
		return t("recurring.ends_after", { total: recurring.max_occurrences, left: Math.max(recurring.max_occurrences - recurring.occurrences, 0) });
	}
	if (recurring.end_date !== null) return t("recurring.ends_on", { date: formatDate(recurring.end_date, dateFormat, timezone) });
	return t("recurring.ends_never");
}

function deliveryLabel(recurring: Pick<RecurringDetail, "auto_issue" | "auto_send">): string {
	if (!recurring.auto_issue) return t("recurring.delivery_draft");
	return recurring.auto_send ? t("recurring.delivery_email") : t("recurring.delivery_issue");
}

export function recurringTable(
	uuid: string,
	rows: RecurringSummary[],
	dateFormat: DateFormat,
	timezone: string,
	withCustomer: boolean,
	page = new PageState()
): HTMLElement {
	return pagedTable(
		[
			t("recurring.column_name"),
			...(withCustomer ? [t("customers.column_customer")] : []),
			t("recurring.column_schedule"),
			t("converter.amount"),
			t("recurring.column_next"),
			t("recurring.column_created"),
			t("payments.status"),
		],
		rows.map((row) =>
			el(
				"tr",
				{},
				el("td", {}, el("a", { href: `/projects/${uuid}/recurring/${row.uuid}` }, nameOf(row))),
				withCustomer ? el("td", {}, el("a", { href: `/projects/${uuid}/customers/${row.customer}` }, row.customer_name || row.customer_email)) : null,
				el("td", {}, everyLabel(row.interval_unit, row.interval_count)),
				el("td", { class: "mono" }, formatMoney(row.total_amount, row.currency)),
				el("td", {}, row.next_run_at ? formatDate(row.next_run_at, dateFormat, timezone) : "-"),
				el("td", {}, row.max_occurrences ? t("recurring.occurrences_of", { done: row.occurrences, total: row.max_occurrences }) : String(row.occurrences)),
				el(
					"td",
					{},
					recurringPill(row.status),
					row.last_error ? el("div", { class: "warn-text", title: row.last_error }, t("recurring.last_run_failed")) : null
				)
			)
		),
		PAGE_SIZE,
		page
	);
}

export async function recurringListView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const dateFormat = project.date_format as DateFormat;
	const params = new URLSearchParams(window.location.search);
	const body = el("div", {});
	const page = new PageState();
	const search = searchFilter(params.get("search") ?? "", t("recurring.search"), () => reload());
	const statusFilter = select(statusFilterOptions(), params.get("status") ?? "");
	const customers = await customerFilter(uuid, params.get("customer"));
	const canCreate = can(project, Permission.SUBSCRIPTION_CREATE);
	let round = 0;

	const load = async () => {
		const filter = { search: search.value.trim(), status: statusFilter.value, customer: customers.value };
		rememberFilters(`/projects/${uuid}/recurring`, filter);
		const current = ++round;
		try {
			const rows = await Api.recurringList(uuid, {
				search: filter.search || undefined,
				status: (filter.status || undefined) as RecurringStatus | undefined,
				customer: filter.customer || undefined,
			});
			if (current !== round) return;
			if (rows.length === 0) {
				const filtered = Boolean(filter.search || filter.status || filter.customer);
				body.replaceChildren(
					emptyState(
						filtered ? t("recurring.none_match") : t("recurring.empty"),
						!filtered && canCreate ? el("a", { class: "button primary", href: `/projects/${uuid}/recurring/new` }, t("recurring.set_up")) : undefined
					)
				);
				return;
			}

			const monthly = new Map<string, number>();
			for (const row of rows.filter((entry) => entry.status === "active")) {
				const perMonth =
					row.interval_unit === "week"
						? (row.total_amount * 52) / 12 / row.interval_count
						: row.interval_unit === "year"
							? row.total_amount / 12 / row.interval_count
							: row.total_amount / row.interval_count;
				monthly.set(row.currency, (monthly.get(row.currency) ?? 0) + perMonth);
			}

			const summary = el(
				"div",
				{ class: "summary" },
				el("span", {}, tn("count.recurring", rows.length)),
				...[...monthly].map(([currency, amount]) =>
					el("span", { class: "mono" }, t("recurring.monthly_estimate", { amount: formatMoney(Math.round(amount), currency) }))
				)
			);

			body.replaceChildren(el("div", { class: "stack" }, summary, recurringTable(uuid, rows, dateFormat, project.timezone, !filter.customer, page)));
		} catch (error) {
			reportError(error);
		}
	};

	const reload = () => {
		page.reset();
		void load();
	};

	statusFilter.addEventListener("change", reload);
	customers.onChange(reload);
	void load();

	const content = el(
		"div",
		{ class: "stack" },
		el(
			"div",
			{ class: "toolbar" },
			search,
			statusFilter,
			customers.combo.element,
			customers.clear,
			canCreate ? el("a", { class: "button primary", href: `/projects/${uuid}/recurring/new` }, t("recurring.new")) : el("span", {})
		),
		body
	);

	return projectLayout(project, content);
}

export async function recurringFormView(uuid: string, recurringId: string | null): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const dateFormat = project.date_format as DateFormat;
	const existing = recurringId ? await Api.recurring(uuid, recurringId) : null;
	const requestedCustomer = new URLSearchParams(window.location.search).get("customer");
	const customer = existing?.customer_detail
		? await Api.customer(uuid, existing.customer_detail.uuid).catch(() => null)
		: requestedCustomer
			? await Api.customer(uuid, requestedCustomer).catch(() => null)
			: null;

	const editor = await invoiceEditor(uuid, project, {
		customerRequired: true,
		customerPlaceholder: t("customers.search_placeholder"),
		notesPlaceholder: t("recurring.notes_placeholder"),
		descriptionPlaceholder: t("recurring.description_placeholder"),
		extraItemsHint: el("p", { class: "muted" }, t("recurring.placeholder_hint")),
		initial:
			existing || customer
				? {
						customer,
						currency: existing?.currency ?? project.currency,
						discount: existing?.discount_amount ?? 0,
						notes: existing?.notes ?? null,
						items: existing?.items ?? [],
					}
				: undefined,
	});

	const today = startOfDay(Date.now(), project.timezone);
	const title = input("text", { value: existing?.title ?? "", placeholder: t("recurring.title_placeholder"), maxlength: "120" });
	const count = input("number", { value: String(existing?.interval_count ?? 1), min: "1", max: String(MAX_INTERVAL_COUNT), step: "1", required: true });
	const unit = select(unitOptions(), existing?.interval_unit ?? "month");
	const firstDate = input("date", {
		value: toDateInput(existing ? (existing.next_run_at ?? today) : today, project.timezone),
		min: existing ? undefined : toDateInput(today, project.timezone),
		required: true,
	});
	const originalFirstDate = firstDate.value;
	const scheduleOpen = !existing || existing.status === "active" || existing.status === "paused" || existing.status === "completed";

	const endMode = select(
		[
			{ value: "never", label: t("recurring.end_never") },
			{ value: "count", label: t("recurring.end_count") },
			{ value: "date", label: t("recurring.end_date") },
		],
		existing?.max_occurrences != null ? "count" : existing?.end_date != null ? "date" : "never"
	);
	const endCount = input("number", { value: String(existing?.max_occurrences ?? 12), min: "1", max: String(MAX_OCCURRENCES), step: "1" });
	const endDate = input("date", {
		value: existing?.end_date ? toDateInput(existing.end_date, project.timezone) : "",
		min: toDateInput(today, project.timezone),
	});
	const endCountField = field(t("recurring.invoice_count"), endCount, existing ? t("recurring.created_so_far", { count: existing.occurrences }) : undefined);
	const endDateField = field(t("recurring.last_date"), endDate);

	const terms = input("number", { value: String(existing?.days_until_due ?? 14), min: "0", max: String(MAX_DAYS_UNTIL_DUE), step: "1", required: true });
	const startingDelivery: Delivery = existing
		? !existing.auto_issue
			? "draft"
			: existing.auto_send
				? "email"
				: "issue"
		: project.email_enabled
			? "email"
			: "issue";
	const delivery = select(
		[
			{ value: "email", label: project.email_enabled ? t("recurring.delivery_option_email") : t("recurring.delivery_option_email_off") },
			{ value: "issue", label: t("recurring.delivery_option_issue") },
			{ value: "draft", label: t("recurring.delivery_option_draft") },
		],
		startingDelivery
	);

	const covers = select(
		[
			{ value: "current", label: t("recurring.covers_current") },
			{ value: "previous", label: t("recurring.covers_previous") },
		],
		existing?.bill_previous_period ? "previous" : "current"
	);

	const preview = el("p", { class: "muted" });

	const refreshPreview = () => {
		endCountField.hidden = endMode.value !== "count";
		endDateField.hidden = endMode.value !== "date";
		endCount.required = endMode.value === "count";
		endDate.required = endMode.value === "date";

		const first = firstDate.value ? dayStartFromDateInput(firstDate.value, project.timezone) : null;
		const every = Number(count.value);
		if (first === null || !(every >= 1)) {
			preview.textContent = "";
			return;
		}

		const done = existing?.occurrences ?? 0;
		const dates = upcomingRuns(
			{ interval_unit: unit.value, interval_count: every, anchor_date: first, anchor_occurrence: done },
			{
				max_occurrences: endMode.value === "count" ? Number(endCount.value) || null : null,
				end_date: endMode.value === "date" && endDate.value ? fromDateInput(endDate.value, project.timezone) : null,
			},
			done,
			4,
			project.timezone
		);
		preview.textContent =
			dates.length === 0
				? t("recurring.preview_none")
				: t("recurring.preview_next", {
						dates: dates.map((date) => formatDate(date, dateFormat, project.timezone)).join(", "),
						more: dates.length === 4 ? t("recurring.preview_more") : "",
					});
	};

	for (const control of [count, unit, firstDate, endMode, endCount, endDate]) {
		control.addEventListener("input", refreshPreview);
		control.addEventListener("change", refreshPreview);
	}
	refreshPreview();

	const submit = el("button", { class: "button primary", type: "submit" }, existing ? t("ui.save") : t("recurring.start"));

	const save = async () => {
		const values = editor.values();
		if (!values) return;

		const interval_count = Number(count.value);
		const interval_unit = unit.value as IntervalUnit;
		const first = dayStartFromDateInput(firstDate.value, project.timezone);
		const body: RecurringInput = {
			title: title.value.trim() || null,
			customer: values.customer!,
			currency: values.currency,
			discount_amount: values.discount_amount,
			notes: values.notes,
			items: values.items,
			days_until_due: Number(terms.value),
			max_occurrences: endMode.value === "count" ? Number(endCount.value) : null,
			end_date: endMode.value === "date" ? fromDateInput(endDate.value, project.timezone) : null,
			auto_issue: delivery.value !== "draft",
			auto_send: delivery.value === "email",
			bill_previous_period: covers.value === "previous",
		};

		if (!existing) {
			Object.assign(body, { interval_unit, interval_count, start_date: first });
		} else if (scheduleOpen) {
			if (interval_unit !== existing.interval_unit) body.interval_unit = interval_unit;
			if (interval_count !== existing.interval_count) body.interval_count = interval_count;
			if (firstDate.value !== originalFirstDate) {
				if (first < today) {
					toast(t("recurring.date_in_past"), "error");
					return;
				}
				body.next_date = first;
			}
		}

		submit.disabled = true;
		try {
			const saved = existing ? await Api.updateRecurring(uuid, existing.uuid, body) : await Api.createRecurring(uuid, body);
			toast(existing ? t("recurring.updated") : t("recurring.started"), "success");
			navigate(`/projects/${uuid}/recurring/${saved.uuid}`);
		} catch (error) {
			reportError(error);
			submit.disabled = false;
		}
	};

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: (event) => {
				event.preventDefault();
				void save();
			},
		},
		el(
			"div",
			{ class: "card" },
			el("h2", {}, t("recurring.schedule")),
			el("div", { class: "form-grid" }, field(t("customers.name"), title, t("recurring.name_hint")), editor.customerField),
			scheduleOpen
				? el(
						"div",
						{ class: "form-grid three" },
						field(t("recurring.every"), count),
						field(t("recurring.period"), unit),
						field(existing ? t("recurring.next_on") : t("recurring.first_on"), firstDate, existing ? undefined : t("recurring.first_on_hint"))
					)
				: null,
			el("div", { class: "form-grid" }, field(t("recurring.ends"), endMode), endCountField, endDateField),
			preview,
			el(
				"div",
				{ class: "form-grid three" },
				field(t("recurring.covers"), covers, t("recurring.covers_hint")),
				field(t("recurring.terms"), terms, t("recurring.terms_hint")),
				field(t("recurring.on_create"), delivery, project.email_enabled ? undefined : t("recurring.email_off_hint"))
			)
		),
		el(
			"div",
			{ class: "card" },
			el("h2", {}, t("payments.invoice")),
			el("div", { class: "form-grid" }, editor.currencyField, editor.discountField),
			editor.notesField
		),
		editor.itemsCard,
		el(
			"div",
			{ class: "form-actions" },
			el("a", { class: "button ghost", href: existing ? `/projects/${uuid}/recurring/${existing.uuid}` : `/projects/${uuid}/recurring` }, t("ui.cancel")),
			submit
		)
	);
	if (!existing) form.dataset.pageAutofocus = "";

	const back = existing
		? el("a", { class: "back-link", href: `/projects/${uuid}/recurring/${existing.uuid}` }, nameOf(existing))
		: el("a", { class: "back-link", href: `/projects/${uuid}/recurring` }, t("recurring.title"));

	return projectLayout(project, el("div", { class: "stack" }, back, form));
}

export async function recurringView(uuid: string, recurringId: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const dateFormat = project.date_format as DateFormat;
	const container = el("div", { class: "stack" });

	const act = async (action: "pause" | "resume" | "cancel" | "run", message: string) => {
		try {
			const result = await Api.recurringAction(uuid, recurringId, action);
			toast(message, "success");
			if (action === "run" && result.created_invoice) {
				navigate(`/projects/${uuid}/invoices/${result.created_invoice}`);
				return;
			}
			void render();
		} catch (error) {
			reportError(error);
			void render();
		}
	};

	const render = async () => {
		const recurring = await Api.recurring(uuid, recurringId);
		const open = recurring.status === "active" || recurring.status === "paused";
		const actions: HTMLElement[] = [];

		if (can(project, Permission.SUBSCRIPTION_EDIT) && recurring.status !== "canceled") {
			actions.push(el("a", { class: "button ghost", href: `/projects/${uuid}/recurring/${recurring.uuid}/edit` }, t("ui.edit")));
		}
		if (open && can(project, Permission.SUBSCRIPTION_EDIT) && can(project, Permission.INVOICE_CREATE)) {
			actions.push(
				el(
					"button",
					{
						class: "button secondary",
						type: "button",
						onClick: async () => {
							const confirmed = await confirmDialog({
								title: t("recurring.run_now_title"),
								body: t("recurring.run_now_body", {
									date: recurring.next_run_at ? formatDate(recurring.next_run_at, dateFormat, project.timezone) : t("recurring.next_period"),
								}),
								confirmLabel: t("recurring.run_now_confirm"),
							});
							if (confirmed) void act("run", t("recurring.invoice_created"));
						},
					},
					t("recurring.run_now")
				)
			);
		}
		if (recurring.status === "active" && can(project, Permission.SUBSCRIPTION_EDIT)) {
			actions.push(
				el("button", { class: "button ghost", type: "button", onClick: () => void act("pause", t("recurring.paused_toast")) }, t("recurring.pause"))
			);
		}
		if (recurring.status === "paused" && can(project, Permission.SUBSCRIPTION_EDIT)) {
			actions.push(
				el("button", { class: "button primary", type: "button", onClick: () => void act("resume", t("recurring.resumed_toast")) }, t("recurring.resume"))
			);
		}
		if (recurring.status !== "canceled" && can(project, Permission.SUBSCRIPTION_CANCEL)) {
			actions.push(
				el(
					"button",
					{
						class: "button danger",
						type: "button",
						onClick: async () => {
							const confirmed = await confirmDialog({
								title: t("recurring.cancel_title"),
								body: t("recurring.cancel_body"),
								confirmLabel: t("recurring.cancel_title"),
								destructive: true,
							});
							if (confirmed) void act("cancel", t("recurring.canceled_toast"));
						},
					},
					t("ui.cancel")
				)
			);
		}
		if (recurring.occurrences === 0 && recurring.invoices.length === 0 && can(project, Permission.SUBSCRIPTION_CANCEL)) {
			actions.push(
				el(
					"button",
					{
						class: "button danger",
						type: "button",
						onClick: async () => {
							const confirmed = await confirmDialog({
								title: t("recurring.delete_title"),
								body: t("recurring.delete_body"),
								confirmLabel: t("ui.delete"),
								destructive: true,
							});
							if (!confirmed) return;
							try {
								await Api.deleteRecurring(uuid, recurring.uuid);
								toast(t("recurring.deleted"), "success");
								navigate(`/projects/${uuid}/recurring`);
							} catch (error) {
								reportError(error);
							}
						},
					},
					t("ui.delete")
				)
			);
		}

		const customerName = recurring.customer_detail ? customerLabel(recurring.customer_detail) : t("recurring.unknown_customer");

		const scheduleCard = el(
			"div",
			{ class: "card" },
			el("h3", {}, t("recurring.schedule")),
			el(
				"dl",
				{ class: "facts" },
				el("dt", {}, t("customers.column_customer")),
				el(
					"dd",
					{},
					recurring.customer_detail ? el("a", { href: `/projects/${uuid}/customers/${recurring.customer_detail.uuid}` }, customerName) : customerName
				),
				el("dt", {}, t("recurring.repeats")),
				el("dd", {}, everyLabel(recurring.interval_unit, recurring.interval_count)),
				el("dt", {}, t("recurring.column_next")),
				el("dd", {}, recurring.next_run_at ? formatDate(recurring.next_run_at, dateFormat, project.timezone) : t("recurring.none_planned")),
				el("dt", {}, t("recurring.ends")),
				el("dd", {}, endsLabel(recurring, dateFormat, project.timezone)),
				el("dt", {}, t("recurring.covers")),
				el("dd", {}, recurring.bill_previous_period ? t("recurring.covers_previous") : t("recurring.covers_current")),
				el("dt", {}, t("recurring.payment_terms")),
				el("dd", {}, tn("count.days", recurring.days_until_due)),
				el("dt", {}, t("recurring.each_invoice_is")),
				el("dd", {}, deliveryLabel(recurring)),
				el("dt", {}, t("recurring.created_label")),
				el("dd", {}, String(recurring.occurrences))
			),
			recurring.upcoming.length > 1
				? el(
						"p",
						{ class: "muted" },
						t("recurring.coming_up", { dates: recurring.upcoming.map((date) => formatDate(date, dateFormat, project.timezone)).join(", ") })
					)
				: null,
			recurring.status === "paused" ? el("p", { class: "muted" }, t("recurring.paused_note")) : null
		);

		const errorCard = recurring.last_error
			? el(
					"div",
					{ class: "card notice" },
					el("h3", {}, t("recurring.failed_title")),
					el("p", { class: "warn" }, recurring.last_error),
					el(
						"p",
						{ class: "muted" },
						recurring.status === "paused" ? t("recurring.failed_paused") : t("recurring.failed_retry", { attempts: recurring.failures })
					)
				)
			: null;

		const linesCard = el(
			"div",
			{ class: "card" },
			el("h3", {}, t("recurring.each_invoice")),
			table(
				[t("editor.description"), t("editor.quantity"), t("items.unit_price"), t("editor.tax")],
				recurring.items.map((item) =>
					el(
						"tr",
						{},
						el("td", {}, item.description),
						el("td", { class: "mono" }, [String(item.quantity), unitLabel(item.unit)].filter(Boolean).join(" ")),
						el("td", { class: "mono" }, formatMoney(item.unit_price, recurring.currency)),
						el("td", { class: "mono" }, `${item.tax_rate}%`)
					)
				)
			),
			el(
				"div",
				{ class: "totals" },
				el(
					"div",
					{ class: "totals-row" },
					el("span", {}, t("editor.subtotal")),
					el("span", { class: "mono" }, formatMoney(recurring.subtotal, recurring.currency))
				),
				recurring.discount_amount > 0
					? el(
							"div",
							{ class: "totals-row" },
							el("span", {}, t("editor.discount")),
							el("span", { class: "mono" }, `-${formatMoney(recurring.discount_amount, recurring.currency)}`)
						)
					: null,
				el(
					"div",
					{ class: "totals-row" },
					el("span", {}, t("editor.tax")),
					el("span", { class: "mono" }, formatMoney(recurring.tax_amount, recurring.currency))
				),
				el(
					"div",
					{ class: "totals-row grand" },
					el("span", {}, t("editor.total")),
					el("span", { class: "mono" }, formatMoney(recurring.total_amount, recurring.currency))
				)
			),
			recurring.notes ? el("p", { class: "muted" }, t("recurring.notes_line", { notes: recurring.notes })) : null
		);

		const invoicesCard = el(
			"div",
			{ class: "card" },
			el("h3", {}, t("recurring.invoices_created")),
			remoteTable(
				[t("credits.column_number"), t("payments.status"), t("editor.total"), t("invoices.column_due"), t("recurring.column_created")],
				async (offset, limit) => {
					const result = await Api.recurringInvoices(uuid, recurring.uuid, { offset, limit });
					return {
						total: result.total,
						rows: result.invoices.map((invoice) =>
							el(
								"tr",
								{},
								el("td", {}, el("a", { class: "mono", href: `/projects/${uuid}/invoices/${invoice.uuid}` }, invoice.reference)),
								el("td", {}, statusPill(invoice.status)),
								el("td", { class: "mono" }, formatMoney(invoice.total_amount, invoice.currency)),
								el("td", {}, formatDate(invoice.due_date, dateFormat, project.timezone)),
								el("td", {}, formatDate(invoice.issued_at ?? invoice.created, dateFormat, project.timezone))
							)
						),
					};
				},
				t("recurring.no_invoices_yet")
			)
		);

		const children: (HTMLElement | null)[] = [
			el("a", { class: "back-link", href: `/projects/${uuid}/recurring` }, t("recurring.title")),
			el(
				"div",
				{ class: "page-head" },
				el(
					"div",
					{},
					el("h2", {}, nameOf(recurring)),
					el(
						"p",
						{ class: "muted" },
						t("recurring.head_summary", {
							customer: customerName,
							amount: formatMoney(recurring.total_amount, recurring.currency),
							schedule: everyLabel(recurring.interval_unit, recurring.interval_count).toLowerCase(),
						})
					)
				),
				recurringPill(recurring.status)
			),
			actions.length > 0 ? el("div", { class: "toolbar" }, ...actions) : null,
			errorCard,
			scheduleCard,
			linesCard,
			invoicesCard,
		];

		container.replaceChildren(...children.filter((child): child is HTMLElement => child !== null));
	};

	await render();
	return projectLayout(project, container);
}
