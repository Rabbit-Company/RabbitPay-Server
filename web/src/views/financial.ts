import { pagedTable } from "../pagination";
import { Api, type FinancialReport, type GeneratedReport, type Project } from "../api";
import { expenseCategoryLabel } from "../expense-categories";
import { can, Permission } from "../access";
import { el, emptyState, field, input, saveFile, select } from "../dom";
import { formatMoney } from "../money";
import { reportControls } from "../report-controls";
import { financialReportCsv } from "../../../server/financial-report-csv";
import { t } from "../i18n";

export function financialSection(uuid: string, project: Project): HTMLElement {
	const year = new Date().getUTCFullYear();
	const from = input("date", { value: `${year}-01-01`, required: true });
	const to = input("date", { value: `${year}-12-31`, required: true });
	const group = select(
		[
			{ value: "month", label: t("financial.monthly") },
			{ value: "year", label: t("financial.yearly") },
		],
		"month"
	);
	const body = el("div", { class: "stack" });
	const exportButton = el("button", { class: "button ghost", type: "button", disabled: true }, t("stats.download_csv"));
	let current: FinancialReport | null = null;
	exportButton.addEventListener("click", () => {
		if (!current) return;
		saveFile(new Blob([financialReportCsv(current)], { type: "text/csv;charset=utf-8" }), "financial-report.csv");
	});
	const show = (report: GeneratedReport<FinancialReport>) => {
		current = report;
		from.value = new Date(report.from).toISOString().slice(0, 10);
		to.value = new Date(report.to).toISOString().slice(0, 10);
		group.value = report.group;
		exportButton.disabled = report.periods.length === 0;
		if (report.totals.length === 0) {
			body.replaceChildren(emptyState(t("financial.empty")));
			return;
		}
		const cards = report.totals.map((row) => {
			const money = (amount: number) => formatMoney(amount, row.currency);
			return el(
				"div",
				{ class: "stack" },
				el("h3", {}, row.currency),
				el(
					"div",
					{ class: "stats-totals" },
					...[
						{ label: "financial.revenue", amount: row.revenue },
						{ label: "financial.expenses", amount: row.expenses },
						{ label: "financial.fees", amount: row.fees },
						{ label: "financial.profit", amount: row.profit },
						{ label: "financial.cash", amount: row.cash_flow },
					].map((stat) =>
						el(
							"div",
							{ class: "card stat" },
							el("span", { class: "stat-value mono" }, money(stat.amount)),
							el("span", { class: "stat-label" }, t(stat.label as "financial.revenue"))
						)
					)
				)
			);
		});
		body.replaceChildren(
			...cards,
			pagedTable(
				[
					t("financial.period"),
					t("expenses.currency"),
					t("financial.revenue"),
					t("financial.expenses"),
					t("financial.fees"),
					t("financial.profit"),
					t("financial.received"),
					t("financial.refunds"),
					t("financial.paid"),
					t("financial.cash"),
				],
				report.periods.map((row) =>
					el(
						"tr",
						{},
						el("td", {}, row.period),
						el("td", {}, row.currency),
						...[row.revenue, row.expenses, row.fees, row.profit, row.received, row.refunds, row.paid_expenses, row.cash_flow].map((amount) =>
							el("td", { class: "mono" }, formatMoney(amount, row.currency))
						)
					)
				)
			),
			el("h3", {}, t("financial.categories")),
			pagedTable(
				[t("expenses.category"), t("expenses.currency"), t("financial.expenses")],
				report.categories.map((row) =>
					el(
						"tr",
						{},
						el("td", {}, expenseCategoryLabel(row.category)),
						el("td", {}, row.currency),
						el("td", { class: "mono" }, formatMoney(row.amount, row.currency))
					)
				)
			)
		);
	};
	const controls = reportControls({
		project,
		utcDates: true,
		read: () => Api.financialReport(uuid),
		generate: () =>
			Api.generateFinancialReport(uuid, {
				from: Date.parse(`${from.value}T00:00:00Z`),
				to: Date.parse(`${to.value}T23:59:59.999Z`),
				group: group.value,
			}),
		show,
	});
	return el(
		"div",
		{ class: "stack" },
		el("div", { class: "toolbar" }, el("h2", { class: "toolbar-title" }, t("financial.title")), can(project, Permission.REPORT_EXPORT) ? exportButton : null),
		el("div", { class: "grid" }, field(t("expenses.from"), from), field(t("expenses.to"), to), field(t("financial.period"), group)),
		controls,
		body,
		el("p", { class: "muted" }, t("financial.note")),
		can(project, Permission.REPORT_EXPORT) ? el("p", { class: "muted" }, t("financial.export_note")) : null
	);
}
