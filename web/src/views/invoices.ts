import { pagedTable, remoteTable, PAGE_SIZE as HISTORY_PAGE_SIZE } from "../pagination";
import {
	Api,
	ApiError,
	customerLabel,
	newRequestKey,
	outcomeUnknown,
	type CurrencyTotal,
	type CreditNote,
	type Customer,
	type EmailMessage,
	type EslogVersion,
	type Invoice,
	type InvoiceCredits,
	type InvoiceKeys,
	type ProformaSettlement,
	type Project,
	type Transaction,
} from "../api";
import { can, Permission } from "../access";
import { el, emptyState, field, input, saveFile, select, statusPill, table } from "../dom";
import { dayStartFromDateInput, formatDate, formatDateTime, formatMoney, fromDateInput, minorUnitDigits, toDateInput } from "../money";
import { navigate } from "../router";
import { convertMinor, outstandingOf } from "../../../server/invoicing";
import { confirmDialog, modal, pdfPreviewButton, reportError, toast } from "../ui";
import { actionMenu, type MenuLink } from "../menu";
import { loadProject, projectLayout } from "./project";
import type { DateFormat } from "../../../server/formats";
import { convertAmount, currencyRates } from "../currencies";
import { invoiceEditor } from "./invoice-editor";
import { customerFilter, rememberFilters, searchFilter } from "./list-filters";
import { invoiceExportDialog } from "./invoice-export";
import { isTaxTreatment } from "../../../server/tax";
import { referenceDocumentOf, type ReferenceDocumentColumns, type ReferenceDocumentInput } from "../../../server/reference-document";
import { taxTreatmentName, unitLabel } from "../options";
import { processorLabel, statusLabel, t, tn, transactionTypeLabel, type UiKey } from "../i18n";
import { recordPaymentDialog, refundDialog } from "./transactions";

const STATUS_VALUES = ["draft", "open", "overdue", "partially_paid", "paid", "canceled", "refunded"];

function statusFilterOptions() {
	return [{ value: "", label: t("invoices.all_statuses") }, ...STATUS_VALUES.map((value) => ({ value, label: statusLabel(value) }))];
}

const PAGE_SIZE = 50;
const UNPAID_STATUSES = ["open", "overdue", "partially_paid"];

const DOCUMENT_VALUES: { value: NonNullable<Invoice["document"]>; label: UiKey }[] = [
	{ value: "proforma", label: "invoices.filter_proforma" },
	{ value: "order", label: "invoices.filter_order" },
	{ value: "advance", label: "invoices.filter_advance" },
];

function documentFilterOptions() {
	return [{ value: "", label: t("invoices.all_documents") }, ...DOCUMENT_VALUES.map((entry) => ({ value: entry.value, label: t(entry.label) }))];
}

export interface InvoiceFilter {
	document?: NonNullable<Invoice["document"]>;
	status?: string;
	customer?: string;
	reference?: string;
}

function documentTag(invoice: Invoice): HTMLElement | null {
	const entry = DOCUMENT_VALUES.find((option) => option.value === invoice.document);
	return entry ? el("div", { class: "muted" }, t(`invoices.kind_${entry.value}` as UiKey)) : null;
}

function customerCell(uuid: string, invoice: Invoice): HTMLElement {
	if (!invoice.customer) return el("td", { class: "muted" }, "-");
	const label = invoice.customer_name || invoice.customer_email || t("customers.unnamed");
	return el("td", {}, el("a", { href: `/projects/${uuid}/customers/${invoice.customer}` }, label));
}

function invoiceRow(uuid: string, invoice: Invoice, dateFormat: DateFormat, timezone: string, withCustomer: boolean): HTMLElement {
	const outstanding = UNPAID_STATUSES.includes(invoice.status) || awaitingPayment(invoice) ? outstandingOf(invoice) : 0;
	const pastDue = outstanding > 0 && invoice.due_date < Date.now();

	return el(
		"tr",
		{},
		el("td", {}, el("a", { class: "mono", href: `/projects/${uuid}/invoices/${invoice.uuid}` }, invoice.reference), documentTag(invoice)),
		withCustomer ? customerCell(uuid, invoice) : null,
		el("td", {}, statusOf(invoice)),
		el("td", { class: "mono" }, formatMoney(invoice.total_amount, invoice.currency)),
		el("td", { class: "mono" }, formatMoney(invoice.paid_amount - invoice.refunded_amount, invoice.currency)),
		el("td", { class: "mono" }, outstanding > 0 ? formatMoney(outstanding, invoice.currency) : "-"),
		el("td", { class: pastDue ? "warn" : "" }, formatDate(invoice.due_date, dateFormat, timezone)),
		el("td", {}, formatDate(invoice.issued_at ?? invoice.created, dateFormat, timezone))
	);
}

function invoiceSummary(total: number, totals: CurrencyTotal[]): HTMLElement {
	return el(
		"div",
		{ class: "summary" },
		el("span", {}, tn("count.invoices", total)),
		...totals.map((sum) =>
			el(
				"span",
				{ class: "mono" },
				t("invoices.summary_totals", {
					billed: formatMoney(sum.total_amount, sum.currency),
					paid: formatMoney(sum.paid_amount, sum.currency),
					outstanding: formatMoney(sum.outstanding_amount, sum.currency),
				})
			)
		)
	);
}

export async function invoiceBrowser(uuid: string, dateFormat: DateFormat, timezone: string, filter: InvoiceFilter, empty: HTMLElement): Promise<HTMLElement> {
	const first = await Api.invoices(uuid, { ...filter, limit: PAGE_SIZE });
	if (first.invoices.length === 0) return empty;

	const withCustomer = !filter.customer;
	const headers = [
		t("invoices.column_reference"),
		...(withCustomer ? [t("customers.column_customer")] : []),
		t("payments.status"),
		t("editor.total"),
		t("status.paid"),
		t("customer.column_outstanding"),
		t("invoices.column_due"),
		t("invoices.column_issued"),
	];
	const listing = table(
		headers,
		first.invoices.map((invoice) => invoiceRow(uuid, invoice, dateFormat, timezone, withCustomer))
	);
	const rows = listing.querySelector("tbody")!;
	let loaded = first.invoices.length;

	const more = el("button", { class: "button ghost", type: "button" });
	const footer = el("div", { class: "line-actions" }, more);

	const sync = () => {
		footer.hidden = loaded >= first.total;
		more.textContent = t("invoices.load_more", { count: first.total - loaded });
	};

	more.addEventListener("click", async () => {
		more.disabled = true;
		try {
			const next = await Api.invoices(uuid, { ...filter, limit: PAGE_SIZE, offset: loaded });
			for (const invoice of next.invoices) rows.appendChild(invoiceRow(uuid, invoice, dateFormat, timezone, withCustomer));
			loaded = next.invoices.length === 0 ? first.total : loaded + next.invoices.length;
		} catch (error) {
			reportError(error);
		}
		more.disabled = false;
		sync();
	});

	sync();
	return el("div", { class: "stack" }, invoiceSummary(first.total, first.totals), listing, footer);
}

export async function invoicesView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const dateFormat = project.date_format as DateFormat;
	const params = new URLSearchParams(window.location.search);
	const body = el("div", {});
	const referenceSearch = searchFilter(params.get("reference") ?? "", t("invoices.search_reference"), () => void load());
	const statusFilter = select(statusFilterOptions(), params.get("status") ?? "");
	const documentFilter = select(documentFilterOptions(), params.get("document") ?? "");
	const customers = await customerFilter(uuid, params.get("customer"));

	const customerLink = el("a", { class: "button ghost" }, t("invoices.customer_overview"));
	const creates = can(project, Permission.INVOICE_CREATE);
	const newInvoice = el("a", { class: "button primary" }, t("invoices.new"));
	newInvoice.hidden = !creates;
	const exportInvoices = el("button", { class: "button ghost", type: "button", onClick: () => invoiceExportDialog(uuid, project) }, t("export.open"));
	let round = 0;

	const syncControls = () => {
		rememberFilters(`/projects/${uuid}/invoices`, {
			reference: referenceSearch.value.trim(),
			status: statusFilter.value,
			document: documentFilter.value,
			customer: customers.value,
		});
		customerLink.hidden = !customers.value;
		customerLink.setAttribute("href", `/projects/${uuid}/customers/${customers.value}`);
		newInvoice.setAttribute("href", `/projects/${uuid}/invoices/new${customers.value ? `?customer=${customers.value}` : ""}`);
	};

	const load = async () => {
		syncControls();
		const current = ++round;
		const filter: InvoiceFilter = {
			document: (documentFilter.value || undefined) as InvoiceFilter["document"],
			status: statusFilter.value || undefined,
			customer: customers.value || undefined,
			reference: referenceSearch.value.trim() || undefined,
		};
		const filtered = Boolean(filter.status || filter.document || filter.customer || filter.reference);
		const empty = emptyState(
			filtered ? t("invoices.none_match") : t("invoices.empty"),
			filtered || !creates ? undefined : el("a", { class: "button primary", href: `/projects/${uuid}/invoices/new` }, t("invoices.create_first"))
		);

		try {
			const view = await invoiceBrowser(uuid, dateFormat, project.timezone, filter, empty);
			if (current === round) body.replaceChildren(view);
		} catch (error) {
			reportError(error);
		}
	};

	statusFilter.addEventListener("change", () => void load());
	documentFilter.addEventListener("change", () => void load());
	customers.onChange(() => void load());
	void load();

	const content = el(
		"div",
		{ class: "stack" },
		el("div", { class: "toolbar filter-bar" }, referenceSearch, documentFilter, statusFilter, customers.combo.element, customers.clear),
		el("div", { class: "toolbar" }, el("div", { class: "line-actions" }, exportInvoices, customerLink), newInvoice),
		body
	);

	return projectLayout(project, content);
}

export async function newInvoiceView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const requestedCustomer = new URLSearchParams(window.location.search).get("customer");
	const preselected = requestedCustomer ? await Api.customer(uuid, requestedCustomer).catch(() => null) : null;
	return await invoiceFormView(uuid, project, null, preselected);
}

export async function editInvoiceView(uuid: string, invoiceId: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const invoice = await Api.invoice(uuid, invoiceId);
	if (invoice.status !== "draft" || invoice.paid_amount > 0 || (invoice.advanced_amount ?? 0) > 0 || invoice.document === "order") {
		navigate(`/projects/${uuid}/invoices/${invoiceId}`, true);
		return el("div");
	}
	const customer = invoice.customer ? await Api.customer(uuid, invoice.customer).catch(() => null) : null;
	return await invoiceFormView(uuid, project, invoice, customer);
}

async function invoiceFormView(uuid: string, project: Project, existing: Invoice | null, customer: Customer | null): Promise<HTMLElement> {
	const proforma = existing?.document === "proforma";
	const editor = await invoiceEditor(uuid, project, {
		initial:
			existing || customer
				? {
						customer,
						currency: existing?.currency ?? project.currency,
						discount: existing?.discount_amount ?? 0,
						notes: existing?.notes ?? null,
						items: (existing?.items ?? []).map((item) => ({
							description: item.description,
							quantity: item.quantity,
							unit_price: item.unit_price,
							tax_rate: item.tax_rate,
							item: item.item ?? null,
							tax_treatment: item.tax_treatment ?? null,
							unit: item.unit ?? null,
						})),
					}
				: undefined,
	});

	const dueDate = input("date", {
		value: toDateInput(existing?.due_date ?? Date.now() + 14 * 24 * 60 * 60 * 1000, project.timezone),
		required: true,
	});
	const supplyDate = input("date", { value: existing?.supply_date ? toDateInput(existing.supply_date, project.timezone) : "" });
	const reference = referenceDocumentFields(existing, project.timezone);
	const reporting = project.tax_currency ?? project.currency;
	const taxRate = input("number", {
		min: "0",
		step: "any",
		value: existing?.tax_rate_source === "manual" && existing.tax_exchange_rate ? String(existing.tax_exchange_rate) : "",
	});
	const taxRateBox = el("div", {});
	const refreshTaxRate = () => {
		const currency = editor.currency();
		taxRateBox.hidden = currency === reporting;
		taxRateBox.replaceChildren(
			field(
				t("invoices.rate_field", { reporting, currency }),
				taxRate,
				t(reporting === "EUR" ? "invoices.rate_draft_hint_ecb" : "invoices.rate_draft_hint_market")
			)
		);
	};
	editor.onCurrencyChange(() => {
		taxRate.value = "";
		refreshTaxRate();
	});
	refreshTaxRate();
	const settlement = select(
		[
			{ value: "invoice", label: t("settings.settlement_invoice") },
			{ value: "advance", label: t("settings.settlement_advance") },
		],
		project.proforma_settlement
	);
	const submit = el("button", { class: "button primary", type: "submit" }, existing ? t("ui.save") : t("invoices.create_draft"));
	const back = existing ? `/projects/${uuid}/invoices/${existing.uuid}` : `/projects/${uuid}/invoices`;

	const proformaButton = el("button", { class: "button secondary", type: "button", onClick: () => void save("proforma") }, t("invoices.create_proforma"));
	const issueButton = el("button", { class: "button secondary", type: "button", onClick: () => void save("issue") }, t("invoices.create_and_issue"));
	const actions = [submit, proformaButton, issueButton];
	const setSaving = (saving: boolean) => {
		for (const button of actions) button.disabled = saving;
	};

	let requestKey = newRequestKey();

	const formBody = () => {
		const values = editor.values();
		if (!values) return null;
		return {
			...values,
			...reference.values(),
			due_date: fromDateInput(dueDate.value, project.timezone),
			supply_date: supplyDate.value ? dayStartFromDateInput(supplyDate.value, project.timezone) : null,
			tax_exchange_rate: values.currency !== reporting && Number(taxRate.value) > 0 ? Number(taxRate.value) : null,
		};
	};

	const previewInvoice = pdfPreviewButton(t("invoices.preview"), async () => {
		const body = formBody();
		if (!body || !dueDate.value) return null;
		return await Api.previewInvoice(uuid, existing ? { ...body, invoice: existing.uuid } : body);
	});

	const save = async (action: "draft" | "issue" | "proforma") => {
		if (submit.disabled) return;
		const body = formBody();
		if (!body) return;

		setSaving(true);

		try {
			if (existing) {
				await Api.updateInvoice(uuid, existing.uuid, body);
				toast(t("invoices.draft_saved"), "success");
				navigate(back);
				return;
			}
			const invoice = await issuingLate((late) =>
				Api.createInvoice(uuid, action === "issue" ? { ...body, status: "open", ...(late ? { late_vat_report: true } : {}) } : body, requestKey)
			);
			if (invoice === null) {
				setSaving(false);
				return;
			}
			if (action === "proforma") {
				try {
					await Api.createProforma(uuid, invoice.uuid, settlement.value as ProformaSettlement);
				} catch (error) {
					reportError(error);
					toast(t("invoices.proforma_kept_as_draft"), "info");
					navigate(`/projects/${uuid}/invoices/${invoice.uuid}`);
					return;
				}
			}
			toast(action === "issue" ? t("invoices.issued") : action === "proforma" ? t("invoices.proforma_created") : t("invoices.draft_created"), "success");
			navigate(`/projects/${uuid}/invoices/${invoice.uuid}`);
		} catch (error) {
			if (!outcomeUnknown(error)) requestKey = newRequestKey();
			reportError(error);
			setSaving(false);
		}
	};

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: (event) => {
				event.preventDefault();
				void save("draft");
			},
		},
		el(
			"div",
			{ class: "card" },
			el("h2", {}, existing ? t("invoices.edit_title", { reference: existing.reference }) : t("customer.details")),
			el("div", { class: "form-grid" }, editor.customerField, editor.currencyField),
			el(
				"div",
				{ class: "form-grid" },
				field(proforma ? t("invoices.valid_until") : t("invoices.due_date"), dueDate, proforma ? t("invoices.valid_until_hint") : undefined),
				field(t("invoices.supply_date"), supplyDate, t("invoices.supply_date_hint")),
				editor.discountField
			),
			taxRateBox,
			el(
				"details",
				{ class: "form-more" },
				el("summary", {}, t("invoices.reference_document")),
				el("p", { class: "muted" }, t("invoices.reference_hint")),
				reference.element
			),
			existing
				? null
				: el(
						"details",
						{ class: "form-more" },
						el("summary", {}, t("invoices.proforma_options")),
						el("p", { class: "muted" }, t("invoices.proforma_options_hint")),
						field(t("settings.proforma_settlement"), settlement)
					),
			editor.notesField
		),
		editor.itemsCard,
		el(
			"div",
			{ class: "form-actions" },
			el("a", { class: "button ghost", href: back }, t("ui.cancel")),
			previewInvoice,
			submit,
			existing ? null : proformaButton,
			existing ? null : issueButton
		)
	);
	form.dataset.pageAutofocus = "";

	const backLink = el("a", { class: "back-link", href: back }, existing ? existing.reference : t("nav.invoices"));
	return projectLayout(project, el("div", { class: "stack" }, backLink, form));
}

function emailKindLabel(kind: EmailMessage["kind"]): string {
	const labels: Record<EmailMessage["kind"], UiKey> = {
		invoice: "email_kind.invoice",
		reminder_before: "email_kind.reminder_before",
		reminder_after: "email_kind.reminder_after",
		receipt: "email_kind.receipt",
		invitation: "email_kind.invitation",
		keys: "email_kind.keys",
		credit_note: "email_kind.credit_note",
		fiscal_alert: "email_kind.fiscal_alert",
		order_update: "email_kind.order_update",
		order_processing: "email_kind.order_processing",
		order_shipped: "email_kind.order_shipped",
		order_delivered: "email_kind.order_delivered",
	};

	return t(labels[kind]);
}

const EMAIL_STATUS_PILLS: Record<EmailMessage["status"], string> = {
	pending: "open",
	sent: "paid",
	failed: "canceled",
};

function emailDialog(uuid: string, project: Project, invoice: Invoice, customer: Customer | null, reminder: boolean, onSent: () => void) {
	const to = input("email", { value: customer?.email ?? "", required: true, placeholder: "customer@example.com" });
	const message = el("textarea", { rows: "4", maxlength: "2000", placeholder: t("invoices.email_message_placeholder") });
	const proforma = invoice.status === "draft" && invoice.document === "proforma";
	const attach = input("checkbox");
	attach.checked = proforma || project.email_attach_invoice;
	const attachEslog = input("checkbox");
	attachEslog.checked = !reminder && !proforma && project.email_attach_eslog;
	const payLink = input("checkbox");
	payLink.checked = proforma || project.email_pay_link;
	const submit = el(
		"button",
		{ class: "button primary", type: "submit" },
		reminder ? t("invoices.send_reminder") : proforma ? t("invoices.send_proforma") : t("invoices.send_invoice")
	);

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					const sent = await Api.emailInvoice(uuid, invoice.uuid, {
						to: to.value.trim(),
						message: (message as HTMLTextAreaElement).value.trim() || null,
						reminder,
						attach_invoice: attach.checked,
						attach_eslog: attachEslog.checked,
						pay_link: payLink.checked,
					});
					dialog.close();
					toast(sent.status === "sent" ? t("invoices.email_sent", { to: sent.recipient }) : t("invoices.email_sending", { to: sent.recipient }), "success");
					onSent();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el(
			"p",
			{ class: "muted" },
			reminder ? t("invoices.reminder_hint", { amount: formatMoney(outstandingOf(invoice), invoice.currency) }) : t("invoices.email_hint")
		),
		field(t("invoices.email_to"), to),
		field(t("invoices.email_message"), message),
		el("label", { class: "switch" }, attach, el("span", {}, t("invoices.email_attach_pdf"))),
		proforma ? null : el("label", { class: "switch" }, attachEslog, el("span", {}, t("invoices.email_attach_eslog"))),
		el("label", { class: "switch" }, payLink, el("span", {}, t("invoices.email_include_link"))),
		el("div", { class: "dialog-actions" }, submit)
	);

	const dialog = modal(
		reminder ? t("invoices.remind_title", { reference: invoice.reference }) : t("invoices.email_title", { reference: invoice.reference }),
		form
	);
	to.focus();
}

function emailsCard(emails: EmailMessage[] | null, dateFormat: DateFormat, timezone: string): HTMLElement | null {
	if (!emails || emails.length === 0) return null;

	return el(
		"div",
		{ class: "card" },
		el("h3", {}, t("invoices.emails")),
		pagedTable(
			[t("invoices.email_column_sent"), t("invoices.email_column_what"), t("invoices.email_to"), t("payments.status"), t("invoices.email_column_by")],
			emails.map((email) =>
				el(
					"tr",
					{},
					el("td", {}, formatDateTime(email.sent_at ?? email.created, dateFormat, undefined, timezone)),
					el(
						"td",
						{},
						emailKindLabel(email.kind),
						email.attachment ? el("div", { class: "muted" }, t("invoices.email_with_pdf")) : null,
						email.eslog_document ? el("div", { class: "muted" }, t("invoices.email_with_eslog")) : null
					),
					el("td", {}, email.recipient),
					el(
						"td",
						{},
						el("span", { class: `pill pill-${EMAIL_STATUS_PILLS[email.status]}`, title: email.last_error ?? "" }, statusLabel(email.status)),
						email.status !== "sent" && email.last_error ? el("div", { class: "muted" }, email.last_error) : null
					),
					el("td", {}, email.sent_by ?? t("ui.automatic"))
				)
			)
		)
	);
}

function keysCard(uuid: string, invoice: Invoice, keys: InvoiceKeys | null, project: Project, onSent: () => void): HTMLElement | null {
	if (!keys || (keys.reserved.length === 0 && keys.delivered.length === 0)) return null;

	const held = keys.reserved.length > 0;
	const rows = [...keys.delivered, ...keys.reserved].map((key) =>
		el(
			"tr",
			{},
			el("td", {}, key.item_name ?? "-"),
			el("td", { class: "mono" }, key.secret ?? "-"),
			el(
				"td",
				{},
				key.status === "delivered" ? el("span", {}, key.recipient ?? t("invoices.keys_in_person")) : el("span", { class: "muted" }, t("invoices.keys_held"))
			)
		)
	);

	const resend = async () => {
		try {
			await Api.emailInvoiceKeys(uuid, invoice.uuid);
			toast(t("invoices.keys_resent"), "success");
			onSent();
		} catch (error) {
			reportError(error);
		}
	};

	const offerResend = keys.delivered.length > 0 && project.email_enabled && can(project, Permission.INVOICE_SEND);

	return el(
		"div",
		{ class: "card" },
		el("h3", {}, t("invoices.keys_title")),
		el("p", { class: "muted" }, held ? t("invoices.keys_held_note") : t("invoices.keys_delivered_note")),
		pagedTable([t("items.column_item"), t("items.column_key"), t("invoices.keys_column_sent_to")], rows),
		offerResend
			? el(
					"div",
					{ class: "line-actions keys-actions" },
					el("button", { class: "button ghost", type: "button", onClick: () => void resend() }, t("invoices.keys_email_again"))
				)
			: null
	);
}

function canEmail(project: Project, invoice: Invoice): boolean {
	if (!project.email_enabled || !can(project, Permission.INVOICE_SEND) || invoice.status === "canceled") return false;
	return invoice.status !== "draft" || invoice.document === "proforma";
}

function awaitingPayment(invoice: Invoice): boolean {
	return invoice.status === "draft" && (invoice.document === "proforma" || invoice.document === "order");
}

function documentPill(invoice: Invoice): HTMLElement | null {
	const labels: Partial<Record<NonNullable<Invoice["document"]>, UiKey>> = {
		proforma: "invoices.kind_proforma",
		order: "invoices.kind_order",
		advance: "invoices.kind_advance",
	};
	const label = invoice.document ? labels[invoice.document] : undefined;
	return label ? el("span", { class: "pill pill-pending" }, t(label)) : null;
}

function statusOf(invoice: Invoice): HTMLElement {
	return awaitingPayment(invoice) ? el("span", { class: "pill pill-open" }, t("invoices.awaiting_payment")) : statusPill(invoice.status);
}

function proformaDialog(uuid: string, project: Project, invoice: Invoice, onCreated: () => void) {
	const settlement = select(
		[
			{ value: "invoice", label: t("settings.settlement_invoice") },
			{ value: "advance", label: t("settings.settlement_advance") },
		],
		invoice.proforma?.settlement ?? project.proforma_settlement
	);
	const creating = !invoice.proforma;
	const submit = el("button", { class: "button primary", type: "submit" }, creating ? t("invoices.create_proforma") : t("ui.save"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					if (creating) await Api.createProforma(uuid, invoice.uuid, settlement.value as ProformaSettlement);
					else await Api.updateProforma(uuid, invoice.uuid, settlement.value as ProformaSettlement);
					dialog.close();
					toast(creating ? t("invoices.proforma_created") : t("invoices.settlement_changed"), "success");
					onCreated();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, creating ? t("invoices.proforma_dialog_hint") : t("invoices.settlement_dialog_hint")),
		field(t("settings.proforma_settlement"), settlement, t("invoices.settlement_explained")),
		el("div", { class: "dialog-actions" }, submit)
	);
	const dialog = modal(creating ? t("invoices.create_proforma") : t("invoices.change_settlement"), form);
}

function advancesCard(uuid: string, invoice: Invoice, project: Project): HTMLElement | null {
	const advances = invoice.advances ?? [];
	if (advances.length === 0) return null;
	return el(
		"div",
		{ class: "card" },
		el("h3", {}, t("invoices.advances_title")),
		el("p", { class: "muted" }, t(invoice.status === "draft" ? "invoices.advances_hint" : "invoices.advances_deducted")),
		table(
			[t("invoices.column_reference"), t("invoices.column_issued"), t("editor.total")],
			advances.map((advance) =>
				el(
					"tr",
					{},
					el("td", {}, el("a", { class: "mono", href: `/projects/${uuid}/invoices/${advance.uuid}` }, advance.reference)),
					el("td", {}, advance.issued_at ? formatDate(advance.issued_at, project.date_format as DateFormat, project.timezone) : "-"),
					el(
						"td",
						{ class: "mono" },
						formatMoney(advance.total_amount - advance.credited_amount, invoice.currency),
						advance.credited_amount > 0 ? el("div", { class: "muted" }, t("invoices.advance_credited")) : null
					)
				)
			)
		)
	);
}

function originText(uuid: string, invoice: Invoice): HTMLElement | null {
	if (invoice.document === "advance" && invoice.source_proforma) {
		return el(
			"p",
			{ class: "muted" },
			`${t("invoices.advance_for")} `,
			el("a", { class: "mono", href: `/projects/${uuid}/invoices/${invoice.source_proforma.uuid}` }, invoice.source_proforma.reference),
			"."
		);
	}
	if (invoice.proforma && invoice.status !== "draft") {
		return el("p", { class: "muted" }, t("invoices.from_proforma", { reference: invoice.proforma.reference }));
	}
	if (invoice.proforma) {
		return el(
			"p",
			{ class: "muted" },
			t(invoice.proforma.settlement === "advance" ? "invoices.proforma_settles_advance" : "invoices.proforma_settles_invoice")
		);
	}
	if (invoice.order_number) {
		return el(
			"p",
			{ class: "muted" },
			`${t("invoices.from_order")} `,
			el("a", { class: "mono", href: `/projects/${uuid}/store/orders/${invoice.uuid}` }, invoice.order_number),
			"."
		);
	}
	return null;
}

function taxRateDialog(uuid: string, invoice: Invoice, reporting: string, onSaved: () => void) {
	const rate = input("number", { min: "0", step: "any", required: true, value: invoice.tax_exchange_rate ? String(invoice.tax_exchange_rate) : "" });
	const suggestion = el("p", { class: "muted" });
	const save = el("button", { class: "button primary", type: "submit" }, t("invoices.save_rate"));

	void currencyRates().then((known) => {
		if (reporting === "EUR") {
			suggestion.textContent = t("invoices.rate_ecb_hint");
			return;
		}
		const market = known.live ? convertAmount(1, invoice.currency, reporting, known.rates) : null;
		if (market === null) {
			suggestion.textContent = t("invoices.rate_manual_hint");
			return;
		}
		suggestion.replaceChildren(
			`${t("invoices.rate_today", { rate: market.toLocaleString(undefined, { maximumFractionDigits: 6 }) })} `,
			el(
				"button",
				{
					class: "link-button",
					type: "button",
					onClick: () => {
						rate.value = String(Number(market.toFixed(6)));
					},
				},
				t("invoices.rate_use_it")
			),
			t("invoices.rate_vat_note")
		);
	});

	const form = el(
		"form",
		{
			onSubmit: async (event) => {
				event.preventDefault();
				save.disabled = true;
				try {
					await Api.setTaxRate(uuid, invoice.uuid, Number(rate.value));
					dialog.close();
					toast(t("invoices.rate_saved"), "success");
					onSaved();
				} catch (error) {
					reportError(error);
					save.disabled = false;
				}
			},
		},
		field(t("invoices.rate_field", { reporting, currency: invoice.currency }), rate),
		suggestion,
		el("div", { class: "dialog-actions" }, save)
	);

	const dialog = modal(t("invoices.rate_title"), form);
	rate.focus();
}

function awaitsLateVatReport(error: unknown): boolean {
	if (!(error instanceof ApiError) || error.code !== 1132) return false;
	const issues = (error.data as { issues?: { code: string }[] } | undefined)?.issues ?? [];
	return issues.length === 1 && issues[0].code === "tax_period_locked";
}

async function issuingLate<T>(issue: (late: boolean) => Promise<T>): Promise<T | null> {
	try {
		return await issue(false);
	} catch (error) {
		if (!awaitsLateVatReport(error)) throw error;
		const confirmed = await confirmDialog({
			title: t("invoices.late_report_title"),
			body: t("invoices.late_report_body"),
			confirmLabel: t("invoices.late_report_confirm"),
		});
		return confirmed ? await issue(true) : null;
	}
}

function lateReportCard(invoice: Invoice): HTMLElement | null {
	const period = invoice.vat_correction_period;
	if (invoice.vat_handling !== "2" || !period || period.length !== 8) return null;
	const months = period.slice(0, 2) === period.slice(2, 4) ? period.slice(0, 2) : `${period.slice(0, 2)}-${period.slice(2, 4)}`;
	return el(
		"div",
		{ class: "card notice" },
		el("h3", {}, t("invoices.late_report_title")),
		el("p", {}, t("invoices.late_report_note", { period: `${months}/${period.slice(4)}` }))
	);
}

function vatReportingCard(
	uuid: string,
	invoice: Invoice,
	reporting: string,
	dateFormat: DateFormat,
	timezone: string,
	editable: boolean,
	onChanged: () => void
): HTMLElement | null {
	if (invoice.status === "draft" || invoice.currency === reporting) return null;

	const recorded = invoice.tax_currency === reporting && invoice.tax_exchange_rate !== null ? invoice.tax_exchange_rate : null;
	const printed = recorded !== null && invoice.tax_amount !== 0;
	const change = printed
		? el("p", { class: "muted" }, t("invoices.rate_locked"))
		: editable
			? el(
					"button",
					{ class: "button ghost small", type: "button", onClick: () => taxRateDialog(uuid, invoice, reporting, onChanged) },
					recorded === null ? t("invoices.set_rate") : t("invoices.change_rate")
				)
			: null;

	if (recorded === null) {
		return el(
			"div",
			{ class: "card notice" },
			el("h3", {}, t("invoices.vat_reporting")),
			el("p", { class: "warn" }, t("invoices.vat_no_rate", { currency: invoice.currency, reporting })),
			change
		);
	}

	const source = invoice.tax_rate_source === "manual" ? t("invoices.rate_manual") : t("invoices.rate_from", { source: invoice.tax_rate_source ?? "" });

	return el(
		"div",
		{ class: "card" },
		el("h3", {}, t("invoices.vat_reporting")),
		el(
			"p",
			{},
			`${t("invoices.vat_in", { reporting })} `,
			el("strong", { class: "mono" }, formatMoney(convertMinor(invoice.tax_amount, invoice.currency, recorded, reporting), reporting))
		),
		el(
			"p",
			{ class: "muted" },
			t("invoices.vat_rate_line", {
				currency: invoice.currency,
				rate: recorded.toLocaleString(undefined, { maximumFractionDigits: 6 }),
				reporting,
				source,
				on: invoice.tax_rate_date ? t("invoices.vat_rate_on", { date: formatDate(invoice.tax_rate_date, dateFormat, timezone) }) : "",
			})
		),
		change
	);
}

function creditNoteDialog(uuid: string, invoice: Invoice, credits: InvoiceCredits, onIssued: () => void) {
	const currency = invoice.currency;
	const digits = minorUnitDigits(currency);
	const toMinor = (value: string) => Math.round((Number(value) || 0) * Math.pow(10, digits));
	const open = credits.creditable.filter((line) => line.net > 0 || line.tax > 0);

	const mode = select([
		{ value: "all", label: t("credits.mode_all", { amount: formatMoney(credits.creditable_total, currency) }) },
		{ value: "amount", label: t("credits.mode_amount") },
		{ value: "lines", label: t("credits.mode_lines") },
	]);
	const amount = input("number", { min: "0", step: "0.01", placeholder: "0.00" });
	const reason = input("text", { placeholder: t("credits.reason_placeholder"), maxlength: "500" });
	const lineInputs = open.map((line) => ({ line, amount: input("number", { min: "0", step: "0.01", placeholder: "0.00" }) }));

	const amountBox = field(t("credits.amount_label"), amount, t("credits.amount_hint", { amount: formatMoney(credits.creditable_total, currency) }));
	const linesBox = el(
		"div",
		{ class: "field" },
		el("span", { class: "field-label" }, t("credits.lines_label")),
		table(
			[t("credits.column_line"), t("credits.column_left"), t("customers.column_vat"), t("credits.column_credit")],
			lineInputs.map(({ line, amount: control }) =>
				el(
					"tr",
					{},
					el("td", {}, line.description),
					el("td", { class: "mono" }, formatMoney(line.net, currency)),
					el("td", {}, `${line.tax_rate}%`),
					el("td", {}, control)
				)
			)
		)
	);

	const sync = () => {
		amountBox.hidden = mode.value !== "amount";
		linesBox.hidden = mode.value !== "lines";
		amount.required = mode.value === "amount";
	};
	mode.addEventListener("change", sync);
	sync();

	const submit = el("button", { class: "button danger", type: "submit" }, t("credits.issue"));

	const form = el(
		"form",
		{
			onSubmit: async (event) => {
				event.preventDefault();

				const body: { reason: string | null; amount?: number; lines?: { line: string; amount: number }[] } = { reason: reason.value.trim() || null };
				if (mode.value === "amount") body.amount = toMinor(amount.value);
				if (mode.value === "lines") {
					body.lines = lineInputs
						.filter((entry) => toMinor(entry.amount.value) > 0)
						.map((entry) => ({ line: entry.line.line, amount: toMinor(entry.amount.value) }));
					if (body.lines.length === 0) {
						toast(t("credits.need_line_amount"), "error");
						return;
					}
				}

				submit.disabled = true;
				try {
					const note = await Api.createCreditNote(uuid, invoice.uuid, body);
					dialog.close();
					toast(t("credits.issued", { reference: note.reference }), "success");
					onIssued();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, t("credits.intro")),
		field(t("credits.what"), mode),
		amountBox,
		linesBox,
		field(t("payments.reason"), reason, t("credits.reason_hint")),
		el("div", { class: "dialog-actions" }, submit)
	);

	const dialog = modal(t("credits.title", { reference: invoice.reference }), form);
}

function creditNoteEmailDialog(uuid: string, project: Project, note: CreditNote, customer: Customer | null, onSent: () => void) {
	const to = input("email", { value: customer?.email ?? "", required: true, placeholder: "customer@example.com" });
	const message = el("textarea", { rows: "4", maxlength: "2000", placeholder: t("invoices.email_message_placeholder") });
	const attach = input("checkbox");
	attach.checked = project.email_attach_invoice;
	const attachEslog = input("checkbox");
	attachEslog.checked = project.email_attach_eslog;
	const submit = el("button", { class: "button primary", type: "submit" }, t("credits.send"));

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					const sent = await Api.emailCreditNote(uuid, note.uuid, {
						to: to.value.trim(),
						message: (message as HTMLTextAreaElement).value.trim() || null,
						attach_invoice: attach.checked,
						attach_eslog: attachEslog.checked,
					});
					dialog.close();
					toast(sent.status === "sent" ? t("invoices.email_sent", { to: sent.recipient }) : t("invoices.email_sending", { to: sent.recipient }), "success");
					onSent();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, t("credits.email_hint")),
		field(t("invoices.email_to"), to),
		field(t("invoices.email_message"), message),
		el("label", { class: "switch" }, attach, el("span", {}, t("credits.email_attach_pdf"))),
		el("label", { class: "switch" }, attachEslog, el("span", {}, t("invoices.email_attach_eslog"))),
		el("div", { class: "dialog-actions" }, submit)
	);

	const dialog = modal(t("credits.email_title", { reference: note.reference }), form);
	to.focus();
}

function referenceDocumentFields(initial: ReferenceDocumentColumns | null, timezone: string) {
	const type = select(
		[
			{ value: "order", label: t("invoices.reference_order") },
			{ value: "contract", label: t("invoices.reference_contract") },
		],
		initial?.reference_document_type ?? "order"
	);
	const number = input("text", { value: initial?.reference_document_number ?? "", maxlength: "70", placeholder: "N-2026-10" });
	const date = input("date", { value: initial?.reference_document_date ? toDateInput(initial.reference_document_date, timezone) : "" });

	return {
		element: el(
			"div",
			{ class: "form-grid three" },
			field(t("invoices.reference_type"), type),
			field(t("invoices.reference_number"), number),
			field(t("invoices.reference_date"), date)
		),
		values: (): ReferenceDocumentInput =>
			number.value.trim()
				? {
						reference_document_type: type.value,
						reference_document_number: number.value.trim(),
						reference_document_date: date.value ? dayStartFromDateInput(date.value, timezone) : null,
					}
				: { reference_document_type: null, reference_document_number: null, reference_document_date: null },
	};
}

function referenceDocumentText(invoice: Invoice, project: Project): string | null {
	const reference = referenceDocumentOf(invoice);
	if (!reference) return null;
	const label = reference.type === "order" ? t("invoices.reference_order") : t("invoices.reference_contract");
	const date = reference.date === null ? "" : ` (${formatDate(reference.date, project.date_format as DateFormat, project.timezone)})`;
	return `${label} ${reference.number}${date}`;
}

function referenceDocumentDialog(uuid: string, project: Project, invoice: Invoice, onSaved: () => void) {
	const fields = referenceDocumentFields(invoice, project.timezone);
	const submit = el("button", { class: "button primary", type: "submit" }, t("ui.save"));
	const form = el(
		"form",
		{
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					await Api.setReferenceDocument(uuid, invoice.uuid, fields.values());
					dialog.close();
					toast(t("invoices.reference_saved"), "success");
					onSaved();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, t("invoices.reference_hint")),
		invoice.issued_at !== null ? el("p", { class: "muted" }, t("invoices.reference_archive_note")) : null,
		fields.element,
		el("div", { class: "dialog-actions" }, submit)
	);

	const dialog = modal(t("invoices.reference_document"), form);
}

function downloadButton(label: string, className: string, load: () => Promise<{ blob: Blob; name: string }>): HTMLButtonElement {
	const button: HTMLButtonElement = el(
		"button",
		{
			class: className,
			type: "button",
			onClick: async () => {
				button.disabled = true;
				try {
					const file = await load();
					saveFile(file.blob, file.name);
				} catch (error) {
					reportError(error);
				} finally {
					button.disabled = false;
				}
			},
		},
		label
	);
	return button;
}

async function downloadFile(load: () => Promise<{ blob: Blob; name: string }>) {
	try {
		const file = await load();
		saveFile(file.blob, file.name);
	} catch (error) {
		reportError(error);
	}
}

function eslogVersionsCard(uuid: string, project: Project, invoice: Invoice, versions: EslogVersion[] | null): HTMLElement | null {
	if (!versions || versions.length === 0) return null;
	const dateFormat = project.date_format as DateFormat;

	return el(
		"div",
		{ class: "card" },
		el("h3", {}, t("invoices.eslog_versions")),
		el("p", { class: "muted" }, t("invoices.eslog_versions_hint")),
		table(
			[t("invoices.eslog_version"), t("invoices.eslog_stored"), t("invoices.reference_document"), t("invoices.eslog_signature"), ""],
			[...versions].reverse().map((version) =>
				el(
					"tr",
					{},
					el("td", { class: "mono" }, String(version.version)),
					el("td", {}, formatDateTime(version.created, dateFormat, undefined, project.timezone)),
					el("td", {}, version.reference_document_number ?? "-"),
					el("td", {}, version.signed ? t("invoices.eslog_signed") : t("invoices.eslog_unsigned")),
					el(
						"td",
						{ class: "actions" },
						downloadButton(t("invoices.download_eslog"), "button ghost small", () => Api.invoiceEslog(uuid, invoice.uuid, version.version))
					)
				)
			)
		)
	);
}

function creditNotesCard(
	uuid: string,
	project: Project,
	invoice: Invoice,
	customer: Customer | null,
	credits: InvoiceCredits | null,
	onChanged: () => void
): HTMLElement | null {
	const dateFormat = project.date_format as DateFormat;
	const emailable = project.email_enabled && can(project, Permission.INVOICE_SEND);
	if (!credits || invoice.issued_at === null) return null;
	if (credits.credit_notes.length === 0 && credits.creditable_total <= 0) return null;

	const issue =
		credits.creditable_total > 0 && can(project, Permission.INVOICE_EDIT)
			? el("button", { class: "button ghost", type: "button", onClick: () => creditNoteDialog(uuid, invoice, credits, onChanged) }, t("credits.issue"))
			: null;

	return el(
		"div",
		{ class: "card" },
		el("h3", {}, t("credits.card_title")),
		credits.credit_notes.length === 0
			? el("p", { class: "muted" }, t("credits.none"))
			: pagedTable(
					[t("credits.column_number"), t("invoices.column_issued"), t("payments.reason"), t("converter.amount"), ""],
					credits.credit_notes.map((note) =>
						el(
							"tr",
							{},
							el("td", { class: "mono" }, note.reference),
							el("td", {}, formatDate(note.issued_at, dateFormat, project.timezone)),
							el("td", {}, note.reason ?? "-"),
							el("td", { class: "mono" }, `-${formatMoney(note.total_amount, note.currency)}`),
							el(
								"td",
								{ class: "actions" },
								el("a", { class: "button ghost small", href: `/projects/${uuid}/credit-notes/${note.uuid}/print` }, t("invoices.print")),
								downloadButton(t("invoices.download_pdf"), "button ghost small", () => Api.creditNotePdf(uuid, note.uuid)),
								downloadButton(t("invoices.download_eslog"), "button ghost small", () => Api.creditNoteEslog(uuid, note.uuid)),
								emailable
									? el(
											"button",
											{ class: "button ghost small", type: "button", onClick: () => creditNoteEmailDialog(uuid, project, note, customer, onChanged) },
											t("credits.email")
										)
									: null
							)
						)
					)
				),
		issue ? el("div", { class: "line-actions" }, issue) : null
	);
}

export async function invoiceView(uuid: string, invoiceId: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const container = el("div", { class: "stack" });

	const render = async () => {
		const invoice = await Api.invoice(uuid, invoiceId);
		const customer = invoice.customer ? await Api.customer(uuid, invoice.customer).catch(() => null) : null;
		const payments = await Api.transactions(uuid, { invoice: invoiceId, limit: HISTORY_PAGE_SIZE }).catch(() => null);
		const unissued = awaitingPayment(invoice);
		const proforma = invoice.status === "draft" && invoice.document === "proforma";
		const plainDraft = invoice.status === "draft" && !unissued && invoice.document_type !== "advance";
		const emails = invoice.status === "draft" && !proforma ? null : await Api.invoiceEmails(uuid, invoiceId).catch(() => null);
		const credits = invoice.status === "draft" ? null : await Api.invoiceCredits(uuid, invoiceId).catch(() => null);
		const keys = invoice.status === "draft" ? null : await Api.invoiceKeys(uuid, invoiceId).catch(() => null);
		const eslogVersions =
			invoice.status === "draft"
				? null
				: await Api.invoiceEslogVersions(uuid, invoiceId)
						.then((result) => result.versions)
						.catch(() => null);

		const paymentRow = (transaction: Transaction) =>
			el(
				"tr",
				{},
				el("td", {}, transactionTypeLabel(transaction.type)),
				el("td", { class: "mono" }, `${transaction.type === "payment" ? "" : "-"}${formatMoney(transaction.amount, transaction.currency)}`),
				el("td", {}, processorLabel(transaction.processor)),
				el("td", {}, el("span", { class: `pill pill-${transaction.status}` }, statusLabel(transaction.status))),
				el("td", {}, formatDate(transaction.created, project.date_format as DateFormat, project.timezone)),
				el(
					"td",
					{ class: "actions" },
					transaction.type === "payment" && ["completed", "partially_refunded"].includes(transaction.status) && can(project, Permission.PAYMENT_REFUND)
						? el(
								"button",
								{
									class: "button danger small",
									type: "button",
									onClick: async () => {
										try {
											const detail = await Api.transaction(uuid, transaction.uuid);
											if (!detail.refundable) {
												toast(t("invoices.nothing_to_refund"), "error");
												return;
											}
											refundDialog(uuid, detail, detail.refundable, () => void render(), invoice.issued_at !== null, Boolean(invoice.fiscal_status));
										} catch (error) {
											reportError(error);
										}
									},
								},
								t("payments.refund")
							)
						: el("span", { class: "muted" }, "-")
				)
			);

		const itemRows = (invoice.items ?? []).map((item) =>
			el(
				"tr",
				{},
				el("td", {}, item.description),
				el("td", { class: "mono" }, [String(item.quantity), unitLabel(item.unit)].filter(Boolean).join(" ")),
				el("td", { class: "mono" }, formatMoney(item.unit_price, invoice.currency)),
				el(
					"td",
					{},
					el("span", { class: "mono" }, `${item.tax_rate}%`),
					isTaxTreatment(item.tax_treatment) && item.tax_treatment !== "domestic" ? el("div", { class: "muted" }, taxTreatmentName(item.tax_treatment)) : null
				),
				el("td", { class: "mono" }, formatMoney(item.total_price + item.tax_amount, invoice.currency))
			)
		);

		const payable = ["open", "overdue", "partially_paid"].includes(invoice.status) || (unissued && outstandingOf(invoice) > 0);
		const payLink = `${window.location.origin}/pay/${invoice.uuid}`;

		const sendLinks: MenuLink[] = [];
		if (canEmail(project, invoice)) {
			sendLinks.push({
				label: proforma ? t("invoices.email_proforma") : t("invoices.email_invoice"),
				onSelect: () => emailDialog(uuid, project, invoice, customer, false, () => void render()),
			});
			if (payable && !unissued) {
				sendLinks.push({ label: t("invoices.send_reminder"), onSelect: () => emailDialog(uuid, project, invoice, customer, true, () => void render()) });
			}
		}
		const payLinks: MenuLink[] = payable
			? [
					{
						label: t("invoices.copy_pay_link"),
						onSelect: async () => {
							try {
								await navigator.clipboard.writeText(payLink);
								toast(t("invoices.pay_link_copied"), "success");
							} catch {
								toast(t("invoices.pay_link_failed"), "error");
							}
						},
					},
					{ label: t("invoices.open_pay_page"), href: payLink, newTab: true },
				]
			: [];

		const documentLinks: MenuLink[] = [
			{ label: t("invoices.print"), href: `/projects/${uuid}/invoices/${invoice.uuid}/print` },
			{ label: t("invoices.download_pdf"), onSelect: () => void downloadFile(() => Api.invoicePdf(uuid, invoice.uuid)) },
		];
		if (invoice.status !== "draft") {
			documentLinks.push({ label: t("invoices.download_eslog"), onSelect: () => void downloadFile(() => Api.invoiceEslog(uuid, invoice.uuid)) });
		}

		const workflowLinks: MenuLink[] = [];
		const editable = (plainDraft || proforma) && invoice.paid_amount === 0 && (invoice.advanced_amount ?? 0) === 0;
		if (editable && can(project, Permission.INVOICE_EDIT)) {
			workflowLinks.push({ label: t("ui.edit"), href: `/projects/${uuid}/invoices/${invoice.uuid}/edit` });
		}
		if (plainDraft && can(project, Permission.INVOICE_SEND)) {
			workflowLinks.push({ label: t("invoices.create_proforma"), onSelect: () => proformaDialog(uuid, project, invoice, () => void render()) });
		}
		if (proforma && editable && can(project, Permission.INVOICE_EDIT)) {
			workflowLinks.push({ label: t("invoices.change_settlement"), onSelect: () => proformaDialog(uuid, project, invoice, () => void render()) });
		}
		if (proforma && can(project, Permission.INVOICE_SEND)) {
			const final = (invoice.advanced_amount ?? 0) > 0;
			workflowLinks.push({
				label: final ? t("invoices.issue_final") : t("invoices.issue_now"),
				onSelect: async () => {
					const confirmed = await confirmDialog({
						title: final ? t("invoices.issue_final") : t("invoices.issue_now"),
						body: final ? t("invoices.issue_final_body") : t("invoices.issue_now_body", { reference: invoice.reference }),
						confirmLabel: t("invoices.issue"),
					});
					if (!confirmed) return;
					try {
						if ((await issuingLate((late) => Api.openInvoice(uuid, invoiceId, late))) === null) return;
						toast(t("invoices.issued"), "success");
						void render();
					} catch (error) {
						reportError(error);
					}
				},
			});
		}
		if (invoice.document === "order" && invoice.status === "draft") {
			workflowLinks.push({ label: t("invoices.manage_order"), href: `/projects/${uuid}/store/orders/${invoice.uuid}` });
		}

		const dangerLinks: MenuLink[] = [];
		if (plainDraft && can(project, Permission.INVOICE_DELETE)) {
			dangerLinks.push({
				label: t("invoices.delete_draft"),
				danger: true,
				onSelect: async () => {
					const confirmed = await confirmDialog({
						title: t("invoices.delete_draft"),
						body: t("invoices.delete_draft_body", { reference: invoice.reference }),
						confirmLabel: t("ui.delete"),
						destructive: true,
					});
					if (!confirmed) return;

					try {
						await Api.deleteInvoice(uuid, invoiceId);
						toast(t("invoices.draft_deleted"), "success");
						navigate(`/projects/${uuid}/invoices`);
					} catch (error) {
						reportError(error);
					}
				},
			});
		}
		const cancelable = (payable && !unissued) || (proforma && (invoice.advanced_amount ?? 0) === 0);
		if (cancelable && can(project, Permission.INVOICE_EDIT)) {
			dangerLinks.push({
				label: t("invoices.cancel_title"),
				danger: true,
				onSelect: async () => {
					const confirmed = await confirmDialog({
						title: t("invoices.cancel_title"),
						body: t("invoices.cancel_body", { reference: invoice.reference }),
						confirmLabel: t("invoices.cancel_title"),
						destructive: true,
					});
					if (!confirmed) return;

					try {
						await Api.cancelInvoice(uuid, invoiceId);
						toast(t("invoices.canceled"), "success");
						void render();
					} catch (error) {
						reportError(error);
					}
				},
			});
		}

		let primaryAction: HTMLElement | null = null;
		if (proforma && outstandingOf(invoice) <= 0 && can(project, Permission.INVOICE_SEND)) {
			primaryAction = el(
				"button",
				{
					class: "button primary",
					type: "button",
					onClick: async () => {
						try {
							if ((await issuingLate((late) => Api.openInvoice(uuid, invoiceId, late))) === null) return;
							toast(t("invoices.issued"), "success");
							void render();
						} catch (error) {
							reportError(error);
						}
					},
				},
				t("invoices.issue_final")
			);
		} else if (plainDraft && can(project, Permission.INVOICE_SEND)) {
			primaryAction = el(
				"button",
				{
					class: "button primary",
					type: "button",
					onClick: async () => {
						try {
							if ((await issuingLate((late) => Api.openInvoice(uuid, invoiceId, late))) === null) return;
							toast(t("invoices.issued"), "success");
							void render();
						} catch (error) {
							reportError(error);
						}
					},
				},
				t("invoices.issue")
			);
		} else if (payable && can(project, Permission.PAYMENT_CREATE)) {
			primaryAction = el(
				"button",
				{ class: "button primary", type: "button", onClick: () => recordPaymentDialog(uuid, invoice, () => void render()) },
				t("payments.record")
			);
		}

		const actions = [
			primaryAction,
			actionMenu(t("invoices.menu_send"), [sendLinks, payLinks]),
			actionMenu(t("invoices.menu_documents"), [documentLinks]),
			actionMenu(t("invoices.menu_more"), [workflowLinks, dangerLinks]),
		].filter((action): action is HTMLElement => action !== null);

		const children: (HTMLElement | null)[] = [
			el("a", { class: "back-link", href: `/projects/${uuid}/invoices` }, t("nav.invoices")),
			el(
				"div",
				{ class: "page-head" },
				el(
					"div",
					{},
					el("h2", { class: "mono" }, invoice.reference),
					el(
						"p",
						{ class: "muted" },
						proforma && invoice.proforma
							? t("invoices.head_proforma", {
									issued: formatDate(invoice.proforma.issued_at, project.date_format as DateFormat, project.timezone),
									valid: formatDate(invoice.due_date, project.date_format as DateFormat, project.timezone),
								})
							: t("invoices.head_dates", {
									issued: invoice.issued_at
										? t("invoices.head_issued", { date: formatDate(invoice.issued_at, project.date_format as DateFormat, project.timezone) })
										: t("invoices.head_created", { date: formatDate(invoice.created, project.date_format as DateFormat, project.timezone) }),
									due: formatDate(invoice.due_date, project.date_format as DateFormat, project.timezone),
								})
					)
				),
				el("div", { class: "line-actions" }, documentPill(invoice), statusOf(invoice))
			),
			actions.length > 0 ? el("div", { class: "toolbar invoice-actions" }, ...actions) : null,
			el(
				"div",
				{ class: "card" },
				el("h3", {}, t("invoices.billed_to")),
				customer
					? el(
							"p",
							{},
							el("a", { href: `/projects/${uuid}/customers/${customer.uuid}` }, el("strong", {}, customerLabel(customer))),
							el("br", {}),
							customer.email
						)
					: el("p", { class: "muted" }, t("invoices.no_customer")),
				referenceDocumentText(invoice, project) || can(project, Permission.INVOICE_EDIT)
					? el(
							"p",
							{},
							`${t("invoices.reference_document")}: `,
							referenceDocumentText(invoice, project) ?? el("span", { class: "muted" }, t("invoices.reference_none")),
							can(project, Permission.INVOICE_EDIT)
								? el(
										"button",
										{
											class: "button ghost small",
											type: "button",
											onClick: () => referenceDocumentDialog(uuid, project, invoice, () => void render()),
										},
										t("ui.edit")
									)
								: null
						)
					: null,
				originText(uuid, invoice),
				invoice.recurring
					? el(
							"p",
							{ class: "muted" },
							`${t("invoices.from_recurring_before")} `,
							el("a", { href: `/projects/${uuid}/recurring/${invoice.recurring}` }, t("invoices.from_recurring_link")),
							"."
						)
					: null
			),
			el(
				"div",
				{ class: "card" },
				el("h3", {}, t("nav.items")),
				table([t("editor.description"), t("editor.quantity"), t("items.unit_price"), t("editor.tax"), t("invoices.line_total")], itemRows),
				el(
					"div",
					{ class: "totals" },
					el(
						"div",
						{ class: "totals-row" },
						el("span", {}, t("editor.subtotal")),
						el("span", { class: "mono" }, formatMoney(invoice.subtotal, invoice.currency))
					),
					el(
						"div",
						{ class: "totals-row" },
						el("span", {}, t("editor.discount")),
						el("span", { class: "mono" }, `-${formatMoney(invoice.discount_amount, invoice.currency)}`)
					),
					el("div", { class: "totals-row" }, el("span", {}, t("editor.tax")), el("span", { class: "mono" }, formatMoney(invoice.tax_amount, invoice.currency))),
					el(
						"div",
						{ class: "totals-row grand" },
						el("span", {}, t("editor.total")),
						el("span", { class: "mono" }, formatMoney(invoice.total_amount, invoice.currency))
					),
					el(
						"div",
						{ class: "totals-row" },
						el("span", {}, t("invoices.paid_label")),
						el("span", { class: "mono" }, formatMoney(invoice.paid_amount, invoice.currency))
					),
					invoice.refunded_amount > 0
						? el(
								"div",
								{ class: "totals-row" },
								el("span", {}, t("invoices.refunded_label")),
								el("span", { class: "mono" }, `-${formatMoney(invoice.refunded_amount, invoice.currency)}`)
							)
						: null,
					invoice.credited_amount > 0
						? el(
								"div",
								{ class: "totals-row" },
								el("span", {}, t("invoices.credited_label")),
								el("span", { class: "mono" }, `-${formatMoney(invoice.credited_amount, invoice.currency)}`)
							)
						: null,
					(invoice.advanced_amount ?? 0) > 0
						? el(
								"div",
								{ class: "totals-row" },
								el("span", {}, t("invoices.advanced_label")),
								el("span", { class: "mono" }, `-${formatMoney(invoice.advanced_amount ?? 0, invoice.currency)}`)
							)
						: null,
					invoice.refunded_amount > 0 || invoice.credited_amount > 0 || (invoice.advanced_amount ?? 0) > 0
						? el(
								"div",
								{ class: "totals-row" },
								el("span", {}, t("customer.column_outstanding")),
								el("span", { class: "mono" }, formatMoney(outstandingOf(invoice), invoice.currency))
							)
						: null
				)
			),
			payments && payments.transactions.length > 0
				? el(
						"div",
						{ class: "card" },
						el("h3", {}, t("nav.payments")),
						remoteTable(
							[t("payments.column_type"), t("converter.amount"), t("payments.processor"), t("payments.status"), t("payments.column_when"), ""],
							async (offset, limit) => {
								const result = await Api.transactions(uuid, { invoice: invoiceId, offset, limit });
								return { total: result.total, rows: result.transactions.map(paymentRow) };
							},
							t("payments.empty"),
							{ total: payments.total, rows: payments.transactions.map(paymentRow) }
						)
					)
				: null,
			advancesCard(uuid, invoice, project),
			keysCard(uuid, invoice, keys, project, () => void render()),
			creditNotesCard(uuid, project, invoice, customer, credits, () => void render()),
			eslogVersionsCard(uuid, project, invoice, eslogVersions),
			lateReportCard(invoice),
			vatReportingCard(
				uuid,
				invoice,
				project.tax_currency ?? project.currency,
				project.date_format as DateFormat,
				project.timezone,
				can(project, Permission.INVOICE_EDIT),
				() => void render()
			),
			emailsCard(emails, project.date_format as DateFormat, project.timezone),
			invoice.notes ? el("div", { class: "card" }, el("h3", {}, t("payments.notes")), el("p", {}, invoice.notes)) : null,
		];

		container.replaceChildren(...children.filter((child): child is HTMLElement => child !== null));
	};

	await render();
	return projectLayout(project, container);
}
