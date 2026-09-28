import { pagination, PAGE_SIZE } from "../pagination";
import { Api, type Invoice, type Transaction } from "../api";
import { el, emptyState, field, input, select, table } from "../dom";
import { formatDateTime, formatMoney, minorUnitDigits, toMajorUnits } from "../money";
import { modal, reportError, toast } from "../ui";
import { loadProject, projectLayout } from "./project";
import { processorLabel, statusLabel, t, tn, transactionTypeLabel } from "../i18n";
import { customerFilter, rememberFilters, searchFilter } from "./list-filters";

const PROCESSOR_VALUES = ["bank_transfer", "cash", "bitcoin", "ethereum", "monero", "stripe", "paypal", "credit"];
const TRANSACTION_STATUSES = ["pending", "processing", "confirmed", "completed", "failed", "expired", "refunded", "partially_refunded"];

function processorOptions() {
	return PROCESSOR_VALUES.map((value) => ({ value, label: processorLabel(value) }));
}

function paymentStatusOptions() {
	return [
		{ value: "completed", label: t("payments.status_completed") },
		{ value: "confirmed", label: t("payments.status_confirmed") },
		{ value: "pending", label: t("payments.status_pending") },
	];
}

export function recordPaymentDialog(projectUuid: string, invoice: Invoice, onRecorded: () => void) {
	const digits = minorUnitDigits(invoice.currency);
	const outstanding = Math.max(invoice.total_amount - (invoice.paid_amount - invoice.refunded_amount), 0);

	const amount = input("number", { value: String(toMajorUnits(outstanding, invoice.currency)), min: "0", step: "0.01", required: true });
	const fee = input("number", { value: "0", min: "0", step: "0.01" });
	const processor = select(processorOptions(), "bank_transfer");
	const status = select(paymentStatusOptions(), "completed");
	const reference = input("text", { placeholder: t("payments.reference_placeholder") });
	const notes = el("textarea", { rows: "2", placeholder: t("payments.notes_placeholder") });

	const submit = el("button", { class: "button primary", type: "submit" }, t("payments.record"));

	const form = el(
		"form",
		{
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;

				try {
					const result = await Api.recordPayment(projectUuid, {
						invoice: invoice.uuid,
						processor: processor.value,
						amount: Math.round((Number(amount.value) || 0) * Math.pow(10, digits)),
						fee_amount: Math.round((Number(fee.value) || 0) * Math.pow(10, digits)),
						processor_tx_id: reference.value.trim() || null,
						status: status.value,
						notes: (notes as HTMLTextAreaElement).value.trim() || null,
					});

					dialog.close();
					toast(t("payments.recorded", { status: statusLabel(result.invoice_balance.status) }), "success");
					onRecorded();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el(
			"p",
			{ class: "muted" },
			t("payments.invoice_summary", {
				reference: invoice.reference,
				total: formatMoney(invoice.total_amount, invoice.currency),
				outstanding: formatMoney(outstanding, invoice.currency),
			})
		),
		el("div", { class: "form-grid" }, field(t("converter.amount"), amount, invoice.currency), field(t("payments.fee"), fee, t("payments.fee_hint"))),
		el("div", { class: "form-grid" }, field(t("payments.processor"), processor), field(t("payments.status"), status)),
		field(t("payments.reference"), reference),
		field(t("payments.notes"), notes),
		el("div", { class: "dialog-actions" }, submit)
	);

	const dialog = modal(t("payments.record_title"), form);
	amount.focus();
}

export function refundDialog(
	projectUuid: string,
	payment: Transaction,
	refundable: number,
	onRefunded: () => void,
	offerCreditNote = false,
	creditNoteRequired = false
) {
	const digits = minorUnitDigits(payment.currency);
	const amount = input("number", { value: String(toMajorUnits(refundable, payment.currency)), min: "0", step: "0.01", required: true });
	const reason = input("text", { placeholder: t("payments.refund_reason_placeholder") });
	const creditNote = input("checkbox");
	creditNote.checked = offerCreditNote || creditNoteRequired;
	creditNote.disabled = creditNoteRequired;

	const submit = el("button", { class: "button danger", type: "submit" }, t("payments.refund"));

	const form = el(
		"form",
		{
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;

				try {
					await Api.refund(projectUuid, payment.uuid, {
						amount: Math.round((Number(amount.value) || 0) * Math.pow(10, digits)),
						reason: reason.value.trim() || null,
						credit_note: creditNoteRequired || (offerCreditNote && creditNote.checked),
					});

					dialog.close();
					toast(t("payments.refund_recorded"), "success");
					onRefunded();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, t("payments.refundable", { amount: formatMoney(refundable, payment.currency) })),
		field(t("converter.amount"), amount, payment.currency),
		field(t("payments.reason"), reason),
		offerCreditNote || creditNoteRequired
			? el(
					"div",
					{ class: "field" },
					el("label", { class: "switch" }, creditNote, el("span", {}, t("payments.credit_note_switch"))),
					el("span", { class: "field-hint" }, t(creditNoteRequired ? "payments.credit_note_required" : "payments.credit_note_hint"))
				)
			: null,
		el("div", { class: "dialog-actions" }, submit)
	);

	const dialog = modal(t("payments.refund_title"), form);
	amount.focus();
}

function customerLabel(transaction: Transaction): string {
	return transaction.customer_name || transaction.customer_email || "-";
}

export async function transactionsView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const params = new URLSearchParams(window.location.search);
	const body = el("div", {});

	const search = searchFilter(params.get("search") ?? "", t("payments.search"), () => reload());
	const typeFilter = select(
		[
			{ value: "", label: t("payments.all_types") },
			{ value: "payment", label: t("payments.type_payments") },
			{ value: "refund", label: t("payments.type_refunds") },
		],
		params.get("type") ?? ""
	);
	const statusFilter = select(
		[{ value: "", label: t("invoices.all_statuses") }, ...TRANSACTION_STATUSES.map((value) => ({ value, label: statusLabel(value) }))],
		params.get("status") ?? ""
	);
	const processorFilter = select([{ value: "", label: t("payments.all_processors") }, ...processorOptions()], params.get("processor") ?? "");
	const customers = await customerFilter(uuid, params.get("customer"));

	const controls = pagination(() => load());
	const load = async (): Promise<void> => {
		const filter = {
			search: search.value.trim(),
			type: typeFilter.value,
			status: statusFilter.value,
			processor: processorFilter.value,
			customer: customers.value,
		};
		rememberFilters(`/projects/${uuid}/transactions`, filter);
		const withCustomer = !filter.customer;
		const round = controls.state.begin();
		try {
			const result = await Api.transactions(uuid, { ...filter, limit: PAGE_SIZE, offset: controls.state.offset });

			if (!controls.state.current(round)) return;
			if (controls.update(result.total)) return await load();

			if (result.transactions.length === 0) {
				const filtered = Object.values(filter).some(Boolean);
				body.replaceChildren(emptyState(filtered ? t("payments.none_match") : t("payments.empty")));
				return;
			}

			const rows = result.transactions.map((transaction) => {
				const isRefund = transaction.type !== "payment";

				return el(
					"tr",
					{},
					el("td", {}, el("span", { class: `pill pill-${isRefund ? "canceled" : transaction.status}` }, transactionTypeLabel(transaction.type))),
					el("td", { class: "mono" }, `${isRefund ? "-" : ""}${formatMoney(transaction.amount, transaction.currency)}`),
					el(
						"td",
						{},
						processorLabel(transaction.processor),
						transaction.processor_tx_id ? el("div", { class: "muted mono" }, transaction.processor_tx_id) : null
					),
					el("td", {}, el("span", { class: `pill pill-${transaction.status}` }, statusLabel(transaction.status))),
					el(
						"td",
						{},
						transaction.invoice
							? el("a", { href: `/projects/${uuid}/invoices/${transaction.invoice}` }, transaction.invoice_reference || t("payments.invoice"))
							: el("span", { class: "muted" }, "-")
					),
					withCustomer ? el("td", {}, customerLabel(transaction)) : null,
					el("td", {}, formatDateTime(transaction.created))
				);
			});

			const summary = el(
				"div",
				{ class: "summary" },
				el("span", {}, tn("count.transactions", result.total)),
				...result.totals.map((total) =>
					el(
						"span",
						{ class: "mono" },
						t("payments.totals", {
							received: formatMoney(total.received, total.currency),
							refunded: formatMoney(total.refunded, total.currency),
							fees: formatMoney(total.fees, total.currency),
						})
					)
				)
			);

			body.replaceChildren(
				el(
					"div",
					{ class: "stack" },
					summary,
					table(
						[
							t("payments.column_type"),
							t("converter.amount"),
							t("payments.processor"),
							t("payments.status"),
							t("payments.invoice"),
							...(withCustomer ? [t("customers.column_customer")] : []),
							t("payments.column_when"),
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

	for (const filter of [typeFilter, statusFilter, processorFilter]) {
		filter.classList.add("compact");
		filter.addEventListener("change", reload);
	}
	customers.onChange(reload);
	void load();

	return projectLayout(
		project,
		el(
			"div",
			{ class: "stack" },
			el("div", { class: "toolbar" }, search, typeFilter, statusFilter, processorFilter, customers.combo.element, customers.clear),
			body,
			controls.element
		)
	);
}
