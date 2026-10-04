import { EMAIL_KINDS, EMAIL_STATUSES } from "../../../server/email/kinds";
import { pagination, PAGE_SIZE } from "../pagination";
import { Api, type EmailCounts, type ListedEmail, type Project } from "../api";
import { el, emptyState, input, select, table } from "../dom";
import { dayStartFromDateInput, formatDateTime, fromDateInput } from "../money";
import { accountName, modal, reportError, toast } from "../ui";
import { can, Permission } from "../access";
import { loadProject, projectLayout } from "./project";
import { statusLabel, t, tn } from "../i18n";
import { rememberFilters, searchFilter } from "./list-filters";
import { EMAIL_STATUS_PILLS, emailKindLabel } from "./invoices";
import type { DateFormat } from "../../../server/formats";

function documentLink(uuid: string, email: ListedEmail): HTMLElement {
	if (email.credit_note && email.invoice) {
		return el("a", { class: "mono", href: `/projects/${uuid}/invoices/${email.invoice}` }, email.credit_note_reference ?? email.invoice_reference ?? "-");
	}
	if (email.invoice) return el("a", { class: "mono", href: `/projects/${uuid}/invoices/${email.invoice}` }, email.invoice_reference ?? "-");
	if (email.ticket) return el("a", { class: "mono", href: `/projects/${uuid}/tickets/${email.ticket}` }, `#${email.ticket_number ?? ""}`);
	return el("span", { class: "muted" }, "-");
}

function statusCell(email: ListedEmail): HTMLElement {
	return el(
		"td",
		{},
		el("span", { class: `pill pill-${EMAIL_STATUS_PILLS[email.status]}` }, statusLabel(email.status)),
		email.status !== "sent" && email.last_error ? el("div", { class: "muted" }, email.last_error) : null
	);
}

function allowanceNote(project: Project, remaining: number | null): HTMLElement | null {
	if (remaining === null) return null;
	if (remaining > 0) return el("span", {}, t("outbox.left", { count: remaining.toLocaleString() }));
	return el(
		"span",
		{ class: "warn" },
		`${t("outbox.none_left")} `,
		can(project, Permission.PROJECT_EDIT) ? el("a", { href: `/projects/${project.uuid}/license` }, t("nav.license")) : null
	);
}

function countsSummary(total: number, counts: EmailCounts): HTMLElement[] {
	return [
		el("span", {}, tn("count.emails", total)),
		el("span", {}, t("outbox.count_sent", { count: counts.sent })),
		el("span", { class: counts.failed > 0 ? "warn" : "" }, t("outbox.count_failed", { count: counts.failed })),
		el("span", {}, t("outbox.count_pending", { count: counts.pending })),
	];
}

async function emailDialog(project: Project, listed: ListedEmail, onResent: () => void) {
	const uuid = project.uuid;
	const email = await Api.email(uuid, listed.uuid);
	const dateFormat = project.date_format as DateFormat;
	const when = (timestamp: number) => formatDateTime(timestamp, dateFormat, undefined, project.timezone);

	const frame = el("iframe", { class: "email-preview-frame", title: t("design.preview") }) as HTMLIFrameElement;
	frame.setAttribute("sandbox", "allow-same-origin");
	frame.addEventListener("load", () => {
		const height = frame.contentDocument?.documentElement.scrollHeight;
		if (height) frame.style.height = `${height}px`;
	});
	if (email.body_html) frame.srcdoc = email.body_html;

	const resend = el("button", { class: "button primary", type: "button" }, t("outbox.resend"));
	resend.addEventListener("click", async () => {
		resend.disabled = true;
		try {
			await Api.resendEmail(uuid, email.uuid);
			dialog.close();
			toast(t("outbox.resent", { to: email.recipient }), "success");
			onResent();
		} catch (error) {
			reportError(error);
			resend.disabled = false;
		}
	});
	const offersResend = email.status === "failed" && email.has_body && project.email_enabled && can(project, Permission.INVOICE_SEND);

	const content = el(
		"div",
		{ class: "stack" },
		el(
			"dl",
			{ class: "facts" },
			el("dt", {}, t("invoices.email_column_what")),
			el("dd", {}, emailKindLabel(email.kind)),
			el("dt", {}, t("invoices.email_to")),
			el("dd", {}, email.recipient),
			el("dt", {}, t("outbox.from")),
			el("dd", {}, email.reply_to ? `${email.sender_name} (${email.reply_to})` : email.sender_name),
			el("dt", {}, t("outbox.document")),
			el("dd", {}, documentLink(uuid, listed)),
			el("dt", {}, t("payments.status")),
			el("dd", {}, el("span", { class: `pill pill-${EMAIL_STATUS_PILLS[email.status]}` }, statusLabel(email.status))),
			el("dt", {}, t("outbox.queued")),
			el("dd", {}, when(email.created)),
			email.sent_at ? el("dt", {}, t("invoices.email_column_sent")) : null,
			email.sent_at ? el("dd", {}, when(email.sent_at)) : null,
			email.sent_via ? el("dt", {}, t("outbox.sent_through")) : null,
			email.sent_via ? el("dd", {}, t(email.sent_via === "project" ? "outbox.through_project" : "outbox.through_server")) : null,
			el("dt", {}, t("outbox.attempts")),
			el("dd", {}, String(email.attempts)),
			el("dt", {}, t("invoices.email_column_by")),
			el("dd", {}, accountName(email.sent_by_name, email.sent_by) ?? t("ui.automatic")),
			email.attachment ? el("dt", {}, t("outbox.attachment")) : null,
			email.attachment ? el("dd", {}, email.attachment) : null
		),
		email.status !== "sent" && email.last_error ? el("p", { class: "warn" }, email.last_error) : null,
		offersResend ? el("div", { class: "line-actions" }, resend) : null,
		el("p", { class: "email-preview-subject" }, el("span", { class: "muted" }, `${t("emails.subject")}: `), email.subject),
		email.body_html ? el("div", { class: "email-preview" }, frame) : el("p", { class: "muted" }, t("outbox.content_removed"))
	);

	const dialog = modal(emailKindLabel(email.kind), content);
}

export async function emailsView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const params = new URLSearchParams(window.location.search);
	const dateFormat = project.date_format as DateFormat;
	const body = el("div", {});
	let invoice = params.get("invoice") ?? "";
	let recurring = params.get("recurring") ?? "";

	const search = searchFilter(params.get("search") ?? "", t("outbox.search"), () => reload());
	const statusFilter = select(
		[{ value: "", label: t("invoices.all_statuses") }, ...EMAIL_STATUSES.map((value) => ({ value, label: statusLabel(value) }))],
		params.get("status") ?? ""
	);
	const kindFilter = select(
		[{ value: "", label: t("outbox.all_kinds") }, ...EMAIL_KINDS.map((value) => ({ value, label: emailKindLabel(value) }))],
		params.get("kind") ?? ""
	);
	const from = input("date", { value: params.get("from") ?? "", title: t("expenses.from") });
	const to = input("date", { value: params.get("to") ?? "", title: t("expenses.to") });
	from.setAttribute("aria-label", t("expenses.from"));
	to.setAttribute("aria-label", t("expenses.to"));

	const scopeNote = el("div", { class: "toolbar" });
	const showScope = () => {
		scopeNote.hidden = !invoice && !recurring;
		scopeNote.replaceChildren(
			el("span", { class: "muted" }, t(recurring ? "outbox.scope_recurring" : "outbox.scope_invoice")),
			el(
				"button",
				{
					class: "button ghost small",
					type: "button",
					onClick: () => {
						invoice = "";
						recurring = "";
						showScope();
						reload();
					},
				},
				t("outbox.show_all")
			)
		);
	};
	showScope();

	const controls = pagination(() => load());
	const load = async (): Promise<void> => {
		const filter = { search: search.value.trim(), status: statusFilter.value, kind: kindFilter.value, from: from.value, to: to.value, invoice, recurring };
		rememberFilters(`/projects/${uuid}/emails`, filter);
		const round = controls.state.begin();
		try {
			const result = await Api.emails(uuid, {
				...filter,
				from: filter.from ? dayStartFromDateInput(filter.from, project.timezone) : undefined,
				to: filter.to ? fromDateInput(filter.to, project.timezone) : undefined,
				limit: PAGE_SIZE,
				offset: controls.state.offset,
			});

			if (!controls.state.current(round)) return;
			if (controls.update(result.total)) return await load();

			if (result.emails.length === 0) {
				const filtered = Object.values(filter).some(Boolean);
				body.replaceChildren(emptyState(filtered ? t("outbox.none_match") : t("outbox.empty")));
				return;
			}

			const rows = result.emails.map((email) =>
				el(
					"tr",
					{},
					el("td", {}, formatDateTime(email.sent_at ?? email.created, dateFormat, undefined, project.timezone)),
					el(
						"td",
						{},
						emailKindLabel(email.kind),
						email.attachment ? el("div", { class: "muted" }, t("invoices.email_with_pdf")) : null,
						email.eslog_document ? el("div", { class: "muted" }, t("invoices.email_with_eslog")) : null
					),
					el("td", {}, documentLink(uuid, email)),
					el("td", {}, email.recipient),
					statusCell(email),
					el("td", {}, accountName(email.sent_by_name, email.sent_by) ?? t("ui.automatic")),
					el(
						"td",
						{},
						el(
							"button",
							{
								class: "button ghost small",
								type: "button",
								onClick: () => void emailDialog(project, email, () => void load()).catch(reportError),
							},
							t("outbox.open")
						)
					)
				)
			);

			body.replaceChildren(
				el(
					"div",
					{ class: "stack" },
					el("div", { class: "summary" }, ...countsSummary(result.total, result.counts), allowanceNote(project, result.remaining)),
					el(
						"div",
						{ class: "summary" },
						...result.kinds.map((entry) => el("span", {}, `${emailKindLabel(entry.kind)}: ${entry.pending + entry.sent + entry.failed}`))
					),
					table(
						[
							t("outbox.column_when"),
							t("invoices.email_column_what"),
							t("outbox.document"),
							t("invoices.email_to"),
							t("payments.status"),
							t("invoices.email_column_by"),
							"",
						],
						rows
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

	for (const filter of [statusFilter, kindFilter, from, to]) filter.addEventListener("change", reload);
	void load();

	return projectLayout(
		project,
		el("div", { class: "stack" }, el("div", { class: "toolbar filter-bar" }, search, statusFilter, kindFilter, from, to), scopeNote, body, controls.element)
	);
}
