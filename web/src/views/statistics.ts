import { pagedTable } from "../pagination";
import { financialSection } from "./financial";
import {
	Api,
	type AccountingPeriodLock,
	type DdvEvidenceResult,
	type DdvExportOptions,
	type ItemSales,
	type ItemSalesReport,
	type GeneratedReport,
	type Project,
	type VatReport,
} from "../api";
import { el, emptyState, field, input, saveFile, select, table } from "../dom";
import { formatMoney, toDateInput } from "../money";
import { reportControls } from "../report-controls";
import { loadProject, projectLayout } from "./project";
import { countryName } from "../countries";
import { vatPeriod, vatReportCsv } from "../../../server/vat-report";
import { canSubmitSlovenianDdvEvidence, isTaxTreatment } from "../../../server/tax";
import { can, Permission } from "../access";
import { taxTreatmentName } from "../options";
import { t } from "../i18n";
import { formatDate as formatDay, type DateFormat } from "../../../server/formats";
import { endOfLocalDate, localDate, previousLocalMonth, startOfLocalDate } from "../../../server/timezone";
import { modal, reportError, toast } from "../ui";

function ddvSection(uuid: string, project: Project): HTMLElement {
	if (!canSubmitSlovenianDdvEvidence(project.tax_country, project.vat_status)) {
		const exempt = project.tax_country === "SI" && (project.vat_status === "small_business" || project.vat_status === "not_registered");
		return el(
			"div",
			{ class: "stack" },
			el("div", { class: "toolbar" }, el("h2", { class: "toolbar-title" }, t("ddv.title"))),
			el(
				"div",
				{ class: "card" },
				el("h3", {}, t(exempt ? "ddv.not_required" : "ddv.unavailable")),
				el("p", { class: "muted" }, t(exempt ? "ddv.not_required_hint" : "ddv.unavailable_hint"))
			)
		);
	}
	const initial = previousLocalMonth(Date.now(), project.timezone);
	const from = input("date", { value: localDate(initial.from, project.timezone), required: true });
	const to = input("date", { value: localDate(initial.to, project.timezone), required: true });
	const refund = input("checkbox");
	const deductibleShare = input("checkbox");
	const insolvency = input("checkbox");
	const taxOrder = input("checkbox");
	const lateSubmission = select(
		[
			{ value: "", label: t("ddv.on_time") },
			{ value: "1", label: t("ddv.late_self_report") },
			{ value: "2", label: t("ddv.late_request") },
			{ value: "3", label: t("ddv.late_no_relief") },
		],
		""
	);
	const note = el("textarea", { maxlength: "250" });
	const resultBody = el("div", { class: "stack" });
	const historyBody = el("div", { class: "stack" });
	const locksBody = el("div", { class: "stack" });
	const options = (): DdvExportOptions => ({
		from: startOfLocalDate(from.value, project.timezone),
		to: endOfLocalDate(to.value, project.timezone),
		refund: refund.checked,
		deductible_share: deductibleShare.checked,
		late_submission: (lateSubmission.value || null) as DdvExportOptions["late_submission"],
		insolvency: insolvency.checked,
		tax_authority_order: taxOrder.checked,
		note: note.value.trim() || null,
	});
	const show = (result: DdvEvidenceResult) => {
		const money = (value: number) => formatMoney(value, "EUR");
		const issues = [...result.errors, ...result.warnings];
		resultBody.replaceChildren(
			el(
				"div",
				{ class: "stats-totals" },
				statCard(
					t("ddv.kir"),
					String(result.reconciliation.kir.records),
					`${money(result.reconciliation.kir.evidence_base)} | ${money(result.reconciliation.kir.evidence_vat)}`
				),
				statCard(
					t("ddv.kpr"),
					String(result.reconciliation.kpr.records),
					`${money(result.reconciliation.kpr.evidence_base)} | ${money(result.reconciliation.kpr.evidence_deductible_vat)}`
				),
				statCard(t("ddv.reconciliation"), result.reconciliation.balanced ? t("ddv.balanced") : t("ddv.not_balanced"), t("ddv.reconciliation_hint"))
			),
			issues.length
				? el(
						"div",
						{ class: `card ${result.errors.length ? "notice" : ""}` },
						el("h3", {}, t(result.errors.length ? "ddv.errors" : "ddv.warnings")),
						el(
							"ul",
							{ class: "recent" },
							...issues.map((entry) => el("li", {}, el("strong", {}, entry.reference ?? t("ddv.header")), el("span", { class: "muted" }, entry.message)))
						)
					)
				: el("p", { class: "pill pill-paid" }, t("ddv.valid"))
		);
	};
	const unlockDialog = (lock: AccountingPeriodLock) => {
		const reason = el("textarea", { maxlength: "500", required: true, rows: "4" }) as HTMLTextAreaElement;
		reason.minLength = 3;
		const submit = el("button", { class: "button danger", type: "submit" }, t("ddv.unlock"));
		const form = el(
			"form",
			{
				onSubmit: async (event) => {
					event.preventDefault();
					submit.disabled = true;
					try {
						await Api.unlockDdvPeriod(uuid, lock.uuid, reason.value.trim());
						dialog.close();
						toast(t("ddv.unlocked"), "success");
						await loadHistory();
					} catch (error) {
						reportError(error);
						submit.disabled = false;
					}
				},
			},
			el("p", { class: "muted" }, t("ddv.unlock_hint")),
			field(t("ddv.unlock_reason"), reason),
			el("div", { class: "dialog-actions" }, submit)
		);
		const dialog = modal(t("ddv.unlock_title"), form);
	};
	const loadHistory = async () => {
		try {
			const [exports, locks] = await Promise.all([Api.ddvExports(uuid), Api.ddvLocks(uuid)]);
			historyBody.replaceChildren(
				exports.length
					? table(
							[t("ddv.period"), t("ddv.revision"), t("ddv.created"), ""],
							exports.map((row) =>
								el(
									"tr",
									{},
									el("td", {}, `${localDate(row.period_from, project.timezone)} - ${localDate(row.period_to, project.timezone)}`),
									el("td", { class: "mono" }, String(row.revision)),
									el("td", {}, new Date(row.created).toLocaleString()),
									el(
										"td",
										{},
										el(
											"button",
											{
												class: "button ghost small",
												type: "button",
												onClick: async () => {
													try {
														const file = await Api.ddvExportFile(uuid, row.uuid);
														saveFile(file.blob, file.name);
													} catch (error) {
														reportError(error);
													}
												},
											},
											t("ddv.download")
										)
									)
								)
							)
						)
					: emptyState(t("ddv.no_exports"))
			);
			locksBody.replaceChildren(
				locks.length
					? table(
							[t("ddv.period"), t("payments.status"), t("ddv.created"), ""],
							locks.map((lock) =>
								el(
									"tr",
									{},
									el("td", {}, `${localDate(lock.period_from, lock.timezone)} - ${localDate(lock.period_to, lock.timezone)}`),
									el("td", {}, t(lock.active ? "ddv.locked" : "ddv.unlocked_status")),
									el("td", {}, new Date(lock.locked_at).toLocaleString()),
									el(
										"td",
										{},
										lock.active && can(project, Permission.REPORT_EXPORT)
											? el("button", { class: "button danger small", type: "button", onClick: () => unlockDialog(lock) }, t("ddv.unlock"))
											: (lock.unlock_reason ?? "")
									)
								)
							)
						)
					: emptyState(t("ddv.no_locks"))
			);
		} catch (error) {
			reportError(error);
		}
	};
	const preview = el("button", { class: "button ghost", type: "button" }, t("ddv.validate"));
	preview.addEventListener("click", async () => {
		preview.disabled = true;
		try {
			show(await Api.ddvEvidence(uuid, options()));
		} catch (error) {
			reportError(error);
		} finally {
			preview.disabled = false;
		}
	});
	const create = el("button", { class: "button primary", type: "button" }, t("ddv.export"));
	create.addEventListener("click", async () => {
		create.disabled = true;
		try {
			const created = await Api.createDdvExport(uuid, options());
			show(created.validation);
			const file = await Api.ddvExportFile(uuid, created.export.uuid);
			saveFile(file.blob, file.name);
			await loadHistory();
		} catch (error) {
			reportError(error);
		} finally {
			create.disabled = false;
		}
	});
	void loadHistory();
	return el(
		"div",
		{ class: "stack" },
		el("div", { class: "toolbar" }, el("h2", { class: "toolbar-title" }, t("ddv.title"))),
		el("p", { class: "muted" }, t("ddv.intro")),
		el("div", { class: "grid" }, field(t("expenses.from"), from), field(t("expenses.to"), to), field(t("ddv.late_submission"), lateSubmission)),
		el(
			"div",
			{ class: "grid" },
			el("label", { class: "switch" }, refund, el("span", {}, t("ddv.refund"))),
			el("label", { class: "switch" }, deductibleShare, el("span", {}, t("ddv.deductible_share"))),
			el("label", { class: "switch" }, insolvency, el("span", {}, t("ddv.insolvency"))),
			el("label", { class: "switch" }, taxOrder, el("span", {}, t("ddv.tax_order")))
		),
		field(t("expenses.notes"), note),
		el("div", { class: "line-actions" }, preview, can(project, Permission.REPORT_EXPORT) ? create : null),
		resultBody,
		el("h3", {}, t("ddv.history")),
		historyBody,
		el("h3", {}, t("ddv.period_locks")),
		el("p", { class: "muted" }, t("ddv.period_locks_hint")),
		locksBody
	);
}

function vatPeriodOptions() {
	return [
		{ value: "this-month", label: t("stats.period_this_month") },
		{ value: "last-month", label: t("stats.period_last_month") },
		{ value: "this-quarter", label: t("stats.period_this_quarter") },
		{ value: "last-quarter", label: t("stats.period_last_quarter") },
		{ value: "this-year", label: t("stats.period_this_year") },
		{ value: "last-year", label: t("stats.period_last_year") },
		{ value: "all", label: t("stats.period_all") },
	];
}

function vatSection(uuid: string, project: Project): HTMLElement {
	const period = select(vatPeriodOptions(), "last-month");
	const body = el("div", { class: "stack" });
	const exportButton = el("button", { class: "button ghost", type: "button", disabled: true }, t("stats.download_csv"));
	let current: VatReport | null = null;
	const dateFormat = project.date_format as DateFormat;

	exportButton.addEventListener("click", () => {
		if (!current) return;
		const range = current.from > 0 ? `${toDateInput(current.from)}_${toDateInput(current.to)}` : "all";
		saveFile(new Blob([vatReportCsv(current)], { type: "text/csv;charset=utf-8" }), `vat-${project.name}-${range}.csv`);
	});

	const show = (report: GeneratedReport<VatReport>) => {
		current = report;
		const money = (amount: number) => formatMoney(amount, report.currency);
		const blocks: (HTMLElement | null)[] = [];

		if (!project.vat_status) {
			blocks.push(el("p", { class: "warn" }, t("stats.no_tax_setup")));
		}

		blocks.push(
			el(
				"div",
				{ class: "stats-totals" },
				statCard(
					t("stats.net_sales"),
					money(report.totals.net),
					report.credit_notes > 0
						? t("stats.issued_with_credits", { invoices: report.invoices, credits: report.credit_notes })
						: t("stats.issued_invoices", { invoices: report.invoices })
				),
				statCard(t("stats.vat_domestic"), money(report.totals.domestic_vat), t("stats.vat_domestic_hint")),
				report.oss.length > 0 ? statCard(t("stats.vat_oss"), money(report.totals.oss_vat), t("stats.vat_oss_hint")) : null
			)
		);

		if (report.missing_rates.length > 0) {
			blocks.push(
				el(
					"div",
					{ class: "card notice" },
					el("h3", {}, t("stats.missing_rates_title")),
					el("p", { class: "muted" }, t("stats.missing_rates_body", { currency: report.currency })),
					el(
						"ul",
						{ class: "recent" },
						...report.missing_rates.map((row) =>
							el(
								"li",
								{},
								el("a", { href: `/projects/${uuid}/invoices/${row.invoice}` }, row.reference),
								el("span", { class: "muted" }, `${row.currency}, ${formatDay(row.issued_at, dateFormat)}`)
							)
						)
					)
				)
			);
		}

		if (report.missing_details.length > 0) {
			blocks.push(
				el(
					"div",
					{ class: "card notice" },
					el("h3", {}, t("stats.needs_checking")),
					el(
						"ul",
						{ class: "recent" },
						...report.missing_details.map((row) =>
							el("li", {}, el("a", { href: `/projects/${uuid}/invoices/${row.invoice}` }, row.reference), el("span", { class: "muted" }, row.reason))
						)
					)
				)
			);
		}

		if (report.invoices === 0 && report.credit_notes === 0) {
			blocks.push(emptyState(t("stats.no_invoices_period")));
		}

		if (report.domestic.length > 0) {
			blocks.push(
				el("h3", { class: "toolbar-title" }, t("stats.domestic_title")),
				pagedTable(
					[t("stats.column_rate"), t("stats.column_net"), t("customers.column_vat")],
					report.domestic.map((row) =>
						el("tr", {}, el("td", {}, `${row.rate}%`), el("td", { class: "mono" }, money(row.net)), el("td", { class: "mono" }, money(row.vat)))
					)
				)
			);
		}

		if (report.oss.length > 0) {
			blocks.push(
				el("h3", { class: "toolbar-title" }, t("stats.oss_title")),
				pagedTable(
					[t("customers.country"), t("stats.column_rate"), t("stats.column_net"), t("customers.column_vat")],
					report.oss.map((row) =>
						el(
							"tr",
							{},
							el("td", {}, row.country ? countryName(row.country) : t("members.unknown")),
							el("td", {}, `${row.rate}%`),
							el("td", { class: "mono" }, money(row.net)),
							el("td", { class: "mono" }, money(row.vat))
						)
					)
				)
			);
		}

		if (report.zero_rated.length > 0) {
			blocks.push(
				el("h3", { class: "toolbar-title" }, t("stats.zero_rated_title")),
				pagedTable(
					[t("stats.column_treatment"), t("stats.column_net")],
					report.zero_rated.map((row) =>
						el(
							"tr",
							{},
							el("td", {}, isTaxTreatment(row.treatment) ? taxTreatmentName(row.treatment) : row.treatment),
							el("td", { class: "mono" }, money(row.net))
						)
					)
				)
			);
		}

		if (report.ec_sales_list.length > 0) {
			blocks.push(
				el("h3", { class: "toolbar-title" }, t("stats.ec_title")),
				el("p", { class: "muted intro" }, t("stats.ec_intro")),
				pagedTable(
					[t("stats.column_customer_vat"), t("customers.country"), t("stats.column_goods"), t("stats.column_services")],
					report.ec_sales_list.map((row) =>
						el(
							"tr",
							{},
							el("td", { class: "mono" }, row.vat_number),
							el("td", {}, countryName(row.country)),
							el("td", { class: "mono" }, money(row.goods)),
							el("td", { class: "mono" }, money(row.services))
						)
					)
				)
			);
		}

		blocks.push(el("p", { class: "muted" }, t("stats.vat_note", { currency: report.currency })));

		body.replaceChildren(...blocks.filter((block): block is HTMLElement => block !== null));
		exportButton.disabled = report.invoices === 0 && report.credit_notes === 0;
	};
	const controls = reportControls({
		project,
		read: () => Api.vatReport(uuid),
		generate: () => Api.generateVatReport(uuid, vatPeriod(period.value)),
		show,
	});

	return el(
		"div",
		{ class: "stack" },
		el(
			"div",
			{ class: "toolbar" },
			el("h2", { class: "toolbar-title" }, t("stats.vat_report")),
			el("div", { class: "line-actions" }, can(project, Permission.REPORT_EXPORT) ? exportButton : null, period)
		),
		controls,
		body
	);
}

const DAY = 24 * 60 * 60 * 1000;

function periodOptions() {
	return [
		{ value: "30", label: t("stats.last_30") },
		{ value: "90", label: t("stats.last_90") },
		{ value: "365", label: t("stats.last_12_months") },
		{ value: "year", label: t("stats.period_this_year") },
		{ value: "all", label: t("stats.period_all") },
	];
}

function periodStart(choice: string): number | undefined {
	if (choice === "all") return undefined;
	if (choice === "year") return new Date(new Date().getFullYear(), 0, 1).getTime();
	return Date.now() - Number(choice) * DAY;
}

function quantity(value: number): string {
	return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function statCard(label: string, value: string, detail?: string): HTMLElement {
	return el(
		"div",
		{ class: "card stat" },
		el("span", { class: "stat-value mono" }, value),
		el("span", { class: "stat-label" }, label),
		detail ? el("span", { class: "muted" }, detail) : null
	);
}

function shareBar(row: ItemSales, best: number): HTMLElement {
	const bar = el("span", {});
	bar.style.width = `${best > 0 ? Math.max((row.sold_amount / best) * 100, row.sold_amount > 0 ? 2 : 0) : 0}%`;
	return el("div", { class: "sales-bar", title: best > 0 ? t("stats.share_title", { share: Math.round((row.sold_amount / best) * 100) }) : "" }, bar);
}

export async function statisticsView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const period = select(periodOptions(), "30");
	const body = el("div", { class: "stack" });

	const show = (report: GeneratedReport<ItemSalesReport>) => {
		if (report.items.length === 0) {
			body.replaceChildren(
				emptyState(
					t("stats.no_items_period"),
					can(project, Permission.ITEM_EDIT) ? el("a", { class: "button ghost", href: `/projects/${uuid}/items` }, t("stats.manage_items")) : undefined
				)
			);
			return;
		}

		const bestByCurrency = new Map<string, number>();
		for (const row of report.items) bestByCurrency.set(row.currency, Math.max(bestByCurrency.get(row.currency) ?? 0, row.sold_amount));

		const totals = el(
			"div",
			{ class: "stats-totals" },
			...report.totals.map((total) =>
				statCard(
					t("stats.sold_in", { currency: total.currency }),
					formatMoney(total.sold_amount, total.currency),
					total.pending_amount > 0 ? t("stats.awaiting", { amount: formatMoney(total.pending_amount, total.currency) }) : undefined
				)
			),
			statCard(t("stats.different_items"), String(new Set(report.items.filter((row) => row.sold_quantity > 0).map((row) => row.item)).size))
		);

		const rows = report.items.map((row) =>
			el(
				"tr",
				{},
				el(
					"td",
					{},
					el("strong", {}, row.name),
					row.archived ? " " : null,
					row.archived ? el("span", { class: "pill" }, t("stats.archived")) : null,
					row.sku ? el("div", { class: "muted mono" }, row.sku) : null
				),
				el("td", { class: "mono" }, quantity(row.sold_quantity)),
				el("td", { class: "mono" }, formatMoney(row.sold_amount, row.currency)),
				el("td", {}, shareBar(row, bestByCurrency.get(row.currency) ?? 0)),
				el("td", { class: "mono" }, String(row.sold_invoices)),
				el("td", { class: "mono" }, row.pending_quantity > 0 ? `${quantity(row.pending_quantity)} (${formatMoney(row.pending_amount, row.currency)})` : "-")
			)
		);

		body.replaceChildren(
			totals,
			pagedTable(
				[t("items.column_item"), t("stats.column_sold"), t("stats.column_revenue"), t("stats.column_share"), t("nav.invoices"), t("stats.column_awaiting")],
				rows
			),
			el("p", { class: "muted" }, t("stats.items_note"))
		);
	};
	const controls = reportControls({
		project,
		read: () => Api.itemSales(uuid),
		generate: () => Api.generateItemSales(uuid, { from: periodStart(period.value), to: Date.now() }),
		show,
	});

	const content = el(
		"div",
		{ class: "stack" },
		financialSection(uuid, project),
		el("hr", { class: "divider" }),
		vatSection(uuid, project),
		el("hr", { class: "divider" }),
		ddvSection(uuid, project),
		el("hr", { class: "divider" }),
		el("div", { class: "toolbar" }, el("h2", { class: "toolbar-title" }, t("stats.item_sales")), period),
		controls,
		body
	);

	return projectLayout(project, content);
}
