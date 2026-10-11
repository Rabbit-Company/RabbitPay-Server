import { ApiError, PurchasingApi, type PayableExpense, type Project } from "../api";
import { el, emptyState, field, input, saveFile, table } from "../dom";
import { formatMoney } from "../money";
import { t } from "../i18n";
import { modal, reportError, toast } from "../ui";
import { shortDate } from "./inventory";

function payable(expense: PayableExpense): boolean {
	return expense.currency === "EUR" && expense.iban !== null;
}

export async function paymentFileDialog(project: Project, onDone: () => void) {
	const data = await PurchasingApi.payable(project.uuid);
	const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
	const execution = input("date", { value: data.today, min: data.today, required: true });
	const iban = input("text", { maxlength: "42", value: data.debtor_iban ?? "", required: true });
	const total = el("p", { class: "stock-total" });
	const submit = el("button", { class: "button primary", type: "submit" }, t("payments_file.download"));
	const boxes = new Map<string, HTMLInputElement>();
	const chosen = () => data.expenses.filter((expense) => boxes.get(expense.uuid)?.checked);
	const refresh = () => {
		const picked = chosen();
		total.textContent = t("payments_file.total", {
			count: picked.length,
			amount: formatMoney(
				picked.reduce((sum, expense) => sum + expense.amount, 0),
				"EUR"
			),
		});
		submit.disabled = picked.length === 0;
	};
	const rows = data.expenses.map((expense) => {
		const box = input("checkbox");
		box.disabled = !payable(expense);
		box.checked = payable(expense) && expense.payment_ordered_at === null && (expense.due_date ?? expense.expense_date) <= soon;
		box.addEventListener("change", refresh);
		box.setAttribute("aria-label", expense.supplier ?? expense.description);
		boxes.set(expense.uuid, box);
		return el(
			"tr",
			{ class: payable(expense) ? "" : "muted" },
			el("td", {}, box),
			el("td", {}, expense.supplier ?? expense.description, el("div", { class: "muted" }, expense.invoice_number ?? expense.description)),
			el("td", { class: "date" }, expense.due_date ? shortDate(expense.due_date, project) : ""),
			el("td", { class: "num" }, formatMoney(expense.amount, expense.currency)),
			el(
				"td",
				{},
				expense.currency !== "EUR"
					? el("span", { class: "warn" }, t("payments_file.not_eur"))
					: expense.iban
						? el("span", { class: "mono" }, expense.iban)
						: el("span", { class: "warn" }, t("payments_file.no_iban")),
				expense.payment_ordered_at ? el("div", { class: "muted" }, t("payments_file.ordered_before")) : null
			)
		);
	});
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					const file = await PurchasingApi.paymentFile(project.uuid, {
						expenses: chosen().map((expense) => expense.uuid),
						execution_date: execution.value,
						iban: iban.value.trim(),
					});
					saveFile(file.blob, file.name);
					dialog.close();
					toast(t("payments_file.saved"), "success");
					onDone();
				} catch (error) {
					const problems = error instanceof ApiError ? (error.data as { problems?: { field: string }[] } | undefined)?.problems : undefined;
					if (problems?.some((problem) => problem.field === "debtor_iban")) toast(t("payments_file.bad_payer_iban"), "error");
					else if (problems?.some((problem) => problem.field === "payee_iban")) toast(t("payments_file.bad_payee_iban"), "error");
					else reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, t("payments_file.hint")),
		rows.length
			? table(["", t("stock.supplier"), t("expenses.due_date"), { label: t("payments_file.amount"), class: "num" }, t("purchase.iban")], rows)
			: emptyState(t("payments_file.empty")),
		el("div", { class: "grid" }, field(t("payments_file.execution_date"), execution), field(t("payments_file.payer_iban"), iban)),
		el("div", { class: "stock-lines-foot" }, total, submit)
	);
	const dialog = modal(t("payments_file.title"), form);
	refresh();
}
