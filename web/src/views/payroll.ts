import { Api, ApiError, type PayrollCalculation, type PayrollItem, type PayrollRates, type PayrollRunDetails, type Project, type WorkforceState } from "../api";
import { el, emptyState, field, input, saveFile, select, table } from "../dom";
import { formatDateTime, formatMoney, toMajorUnits, toMinorUnits } from "../money";
import { can, Permission } from "../access";
import { navigate } from "../router";
import { language, t, type UiKey } from "../i18n";
import { accountName, confirmDialog, modal, reportError, toast } from "../ui";
import { workforceGate } from "./workforce-shared";
import type { DateFormat, TimeFormat } from "../../../server/formats";
import { icon } from "../storefront/icons";

const EMPLOYEE_KEYS = ["pension", "health", "unemployment", "parental", "long_term_care"] as const;
const EMPLOYER_KEYS = ["pension", "health", "injury", "unemployment", "parental", "long_term_care"] as const;

function monthLabel(period: string): string {
	const [year, month] = period.split("-").map(Number);
	return new Intl.DateTimeFormat(language() === "sl" ? "sl-SI" : "en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
		Date.UTC(year, month - 1, 1)
	);
}

function payrollTabs(project: Project, active: "runs" | "rates"): HTMLElement {
	const base = `/projects/${project.uuid}/payroll`;
	return el(
		"div",
		{ class: "store-bar" },
		el(
			"nav",
			{ class: "subtabs" },
			el("a", { class: `subtab${active === "runs" ? " active" : ""}`, href: base }, t("payroll.tab_runs")),
			el("a", { class: `subtab${active === "rates" ? " active" : ""}`, href: `${base}/rates` }, t("payroll.tab_rates"))
		)
	);
}

async function payrollSection(
	uuid: string,
	active: "runs" | "rates",
	render: (project: Project, state: WorkforceState) => Promise<HTMLElement>
): Promise<HTMLElement> {
	return workforceGate(uuid, async (project, state) => el("div", { class: "stack" }, payrollTabs(project, active), await render(project, state)));
}

function statusPill(status: "draft" | "final"): HTMLElement {
	return el("span", { class: `pill pill-${status === "final" ? "paid" : "draft"}` }, t(`payroll.status_${status}` as UiKey));
}

function newRunDialog(project: Project, today: string) {
	const period = input("month", { required: true, value: today.slice(0, 7) });
	const payDate = input("date", {});
	const submit = el("button", { class: "button primary", type: "submit" }, t("payroll.create_run"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					const run = await Api.createPayrollRun(project.uuid, period.value, payDate.value || null);
					dialog.close();
					navigate(`/projects/${project.uuid}/payroll/${run.uuid}`);
				} catch (error) {
					reportError(error);
				} finally {
					submit.disabled = false;
				}
			},
		},
		el("div", { class: "form-grid" }, field(t("payroll.period"), period), field(t("payroll.pay_date"), payDate)),
		el("p", { class: "muted" }, t("payroll.create_hint")),
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(t("payroll.new_run"), form);
}

export async function payrollRunsView(uuid: string): Promise<HTMLElement> {
	return payrollSection(uuid, "runs", async (project, state) => {
		const runs = await Api.payrollRuns(uuid);
		const money = (amount: number) => formatMoney(amount, project.currency);
		const editable = state.license.active && can(project, Permission.EMPLOYEE_EDIT);
		return el(
			"div",
			{ class: "stack" },
			el(
				"div",
				{ class: "toolbar" },
				el("h2", { class: "toolbar-title" }, t("payroll.runs_title")),
				editable ? el("button", { class: "button primary", type: "button", onClick: () => newRunDialog(project, state.today) }, t("payroll.new_run")) : null
			),
			el("p", { class: "muted" }, t("payroll.runs_hint")),
			el(
				"div",
				{ class: "card" },
				runs.length === 0
					? emptyState(t("payroll.runs_empty"))
					: table(
							[
								t("payroll.period"),
								t("payroll.status"),
								t("payroll.people"),
								t("payroll.gross"),
								t("payroll.net"),
								t("payroll.payout"),
								t("payroll.employer_cost"),
							],
							runs.map((run) =>
								el(
									"tr",
									{},
									el("td", {}, el("a", { href: `/projects/${uuid}/payroll/${run.uuid}` }, monthLabel(run.period))),
									el("td", {}, statusPill(run.status)),
									el("td", { class: "numeric" }, String(run.people)),
									el("td", { class: "numeric mono" }, money(run.totals.gross)),
									el("td", { class: "numeric mono" }, money(run.totals.net)),
									el("td", { class: "numeric mono" }, money(run.totals.payout)),
									el("td", { class: "numeric mono" }, money(run.totals.employer_cost))
								)
							)
						)
			)
		);
	});
}

function itemsDialog(project: Project, run: PayrollRunDetails, line: PayrollRunDetails["lines"][number], onSaved: (run: PayrollRunDetails) => void) {
	const tbody = el("tbody", {});
	const rows: { node: HTMLTableRowElement; read: () => PayrollItem }[] = [];
	const emptyCell = el("td", { class: "muted" }, t("payroll.items_empty"));
	emptyCell.colSpan = 4;
	const emptyRow = el("tr", {}, emptyCell);
	const refresh = () => {
		if (rows.length === 0) tbody.append(emptyRow);
		else emptyRow.remove();
	};
	const addRow = (item: PayrollItem | null) => {
		const type = select(
			(["gross", "benefit", "regres", "winter_regres", "business_performance", "reimbursement", "deduction"] as const).map((value) => ({
				value,
				label: t(`payroll.item_${value}` as UiKey),
			})),
			item?.type ?? "gross"
		);
		const description = input("text", {
			maxlength: "200",
			required: true,
			value: item?.description ?? "",
			placeholder: t("payroll.item_description_placeholder"),
		});
		const amount = input("number", {
			min: "0.01",
			step: "0.01",
			required: true,
			placeholder: "0.00",
			title: t("payroll.item_amount", { currency: project.currency }),
			value: item ? String(toMajorUnits(item.amount, project.currency)) : "",
		});
		const row = {
			node: el(
				"tr",
				{},
				el("td", {}, type),
				el("td", {}, description),
				el("td", {}, amount),
				el(
					"td",
					{ class: "actions" },
					el(
						"button",
						{
							class: "icon-button danger-text",
							type: "button",
							title: t("payroll.item_remove"),
							onClick: () => {
								rows.splice(rows.indexOf(row), 1);
								row.node.remove();
								refresh();
							},
						},
						icon("close", 16)
					)
				)
			),
			read: (): PayrollItem => ({
				type: type.value as PayrollItem["type"],
				description: description.value.trim(),
				amount: toMinorUnits(Number(amount.value), project.currency),
			}),
		};
		rows.push(row);
		tbody.append(row.node);
		refresh();
		return type;
	};
	for (const item of line.calculation.items) addRow(item);
	refresh();
	const submit = el("button", { class: "button primary", type: "submit" }, t("ui.save"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				const items = rows.map((row) => row.read());
				try {
					onSaved(await Api.savePayrollItems(project.uuid, run.uuid, line.uuid, items));
					dialog.close();
				} catch (error) {
					reportError(error);
				}
			},
		},
		el("p", { class: "muted" }, t("payroll.items_hint")),
		el(
			"div",
			{ class: "table-wrap" },
			el(
				"table",
				{ class: "items-table" },
				el(
					"thead",
					{},
					el(
						"tr",
						{},
						el("th", {}, t("payroll.item_type")),
						el("th", {}, t("payroll.item_description")),
						el("th", {}, t("payroll.item_amount", { currency: project.currency })),
						el("th", {})
					)
				),
				tbody
			)
		),
		el("div", {}, el("button", { class: "button ghost small", type: "button", onClick: () => addRow(null).focus() }, t("payroll.item_add"))),
		el("div", { class: "form-actions" }, el("button", { class: "button ghost", type: "button", onClick: () => dialog.close() }, t("ui.cancel")), submit)
	);
	const dialog = modal(t("payroll.items_title", { name: line.person }), form, undefined, "dialog-medium");
}

function separateRows(project: Project, label: string, pay: PayrollCalculation["regres"]): [string, string][] {
	if (!pay) return [];
	const money = (amount: number) => formatMoney(amount, project.currency);
	return [[label, t("payroll.separate_summary", { amount: money(pay.amount), exempt: money(pay.exempt), tax: money(pay.income_tax), net: money(pay.net) })]];
}

function lineDetails(project: Project, calculation: PayrollCalculation): HTMLElement {
	const money = (amount: number) => formatMoney(amount, project.currency);
	const net = calculation.net;
	const rows: [string, string][] = [
		[t("payroll.gross_from_hours"), money(calculation.hours.amounts.gross)],
		...calculation.items.map((item): [string, string] => [`${t(`payroll.item_${item.type}` as UiKey)}: ${item.description}`, money(item.amount)]),
		...(calculation.taxable_reimbursements && calculation.taxable_reimbursements.meal + calculation.taxable_reimbursements.commute > 0
			? ([[t("payroll.taxable_reimbursements"), money(calculation.taxable_reimbursements.meal + calculation.taxable_reimbursements.commute)]] as [
					string,
					string,
				][])
			: []),
		[t("payroll.gross"), money(calculation.gross)],
		...(net && net.base_difference ? ([[t("payroll.minimum_base_difference"), money(net.base_difference)]] as [string, string][]) : []),
		...separateRows(project, t("payroll.item_regres"), calculation.regres ?? null),
		...separateRows(project, t("payroll.performance_short"), calculation.performance ?? null),
		...(net
			? ([
					...EMPLOYEE_KEYS.filter((key) => net.employee_contributions[key] > 0).map((key): [string, string] => [
						t(`payroll.contribution_${key}` as UiKey),
						`-${money(net.employee_contributions[key])}`,
					]),
					[t("payroll.general_relief"), money(net.general_relief)],
					[t("payroll.dependent_relief"), money(net.dependent_relief)],
					[t("payroll.tax_base"), money(net.tax_base)],
					[t("payroll.income_tax"), `-${money(net.income_tax)}`],
					[t("payroll.health_flat"), `-${money(net.health_flat)}`],
					[t("payroll.net"), money(net.net)],
					[t("payroll.reimbursements"), money(calculation.reimbursements)],
					[t("payroll.deductions"), `-${money(calculation.deductions)}`],
					[t("payroll.payout"), money(calculation.payout ?? 0)],
					[t("payroll.employer_contributions"), money(net.employer_contributions_total)],
				] as [string, string][])
			: [[t("payroll.net"), t("payroll.no_net")] as [string, string]]),
		[t("payroll.employer_cost"), money(calculation.employer_cost)],
	];
	return el(
		"div",
		{},
		el("dl", { class: "facts" }, ...rows.flatMap(([label, value]) => [el("dt", {}, label), el("dd", { class: "mono" }, value)])),
		...(calculation.warnings ?? []).map((warning) => el("p", { class: "warn-text" }, t(`payroll.warning_${warning}` as UiKey)))
	);
}

const REK_SETTINGS = "rabbitpay.rek-o";

function problemList(error: unknown): HTMLElement | null {
	if (!(error instanceof ApiError) || typeof error.data !== "object" || error.data === null) return null;
	const problems = (error.data as { problems?: { field: string; person?: string }[] }).problems;
	if (!problems?.length) return null;
	return el(
		"ul",
		{ class: "warn-text" },
		...problems.map((problem) => el("li", {}, t(`payroll.problem_${problem.field}` as UiKey, { person: problem.person ?? "" })))
	);
}

function exportDialog(title: string, hint: string, fields: HTMLElement[], work: () => Promise<{ blob: Blob; name: string }>, remember?: () => void) {
	const problems = el("div", {});
	const submit = el("button", { class: "button primary", type: "submit" }, t("payroll.download"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				problems.replaceChildren();
				remember?.();
				try {
					const file = await work();
					saveFile(file.blob, file.name);
					dialog.close();
				} catch (error) {
					const list = problemList(error);
					if (list) problems.replaceChildren(el("p", {}, t("payroll.export_missing")), list);
					else reportError(error);
				} finally {
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, hint),
		...fields,
		problems,
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(title, form);
}

function rekDialog(project: Project, run: PayrollRunDetails) {
	let saved: { responsible?: string; contact?: string; taxpayer_type?: string; collective_agreement?: string } = {};
	try {
		saved = JSON.parse(localStorage.getItem(REK_SETTINGS) ?? "{}");
	} catch {
		saved = {};
	}
	const responsible = input("text", { required: true, maxlength: "100", value: saved.responsible ?? "" });
	const contact = input("text", { required: true, maxlength: "200", value: saved.contact ?? "", placeholder: t("payroll.rek_contact_placeholder") });
	const taxpayer = select(
		[
			{ value: "PO", label: t("payroll.rek_taxpayer_po") },
			{ value: "SP", label: t("payroll.rek_taxpayer_sp") },
		],
		saved.taxpayer_type ?? "PO"
	);
	const kinds = (["salary", "regres", "performance"] as const).filter(
		(kind) => kind === "salary" || run.lines.some((line) => (kind === "regres" ? line.calculation.regres : line.calculation.performance))
	);
	const kind = select(
		kinds.map((value) => ({ value, label: t(`payroll.rek_kind_${value}` as UiKey) })),
		"salary"
	);
	const agreement = input("text", { required: true, maxlength: "3", value: saved.collective_agreement ?? "", placeholder: "001" });
	agreement.pattern = "[0-9]{3}";
	exportDialog(
		t("payroll.rek_title"),
		t("payroll.rek_hint"),
		[
			field(t("payroll.rek_kind"), kind, t("payroll.rek_kind_hint")),
			el("div", { class: "form-grid" }, field(t("payroll.rek_responsible"), responsible), field(t("payroll.rek_contact"), contact)),
			el(
				"div",
				{ class: "form-grid" },
				field(t("payroll.rek_taxpayer"), taxpayer),
				field(t("payroll.rek_agreement"), agreement, t("payroll.rek_agreement_hint"))
			),
			el("p", { class: "warn-text" }, t("payroll.rek_limits")),
		],
		() =>
			Api.rekO(project.uuid, run.uuid, run.period, {
				kind: kind.value as "salary" | "regres" | "performance",
				responsible: responsible.value.trim(),
				contact: contact.value.trim(),
				taxpayer_type: taxpayer.value as "PO" | "SP",
				collective_agreement: agreement.value.trim(),
			}),
		() => {
			try {
				localStorage.setItem(
					REK_SETTINGS,
					JSON.stringify({
						responsible: responsible.value.trim(),
						contact: contact.value.trim(),
						taxpayer_type: taxpayer.value,
						collective_agreement: agreement.value.trim(),
					})
				);
			} catch {
				void 0;
			}
		}
	);
}

function sepaDialog(project: Project, run: PayrollRunDetails) {
	const iban = input("text", { maxlength: "42", placeholder: t("payroll.sepa_iban_placeholder") });
	const bic = input("text", { maxlength: "11" });
	const name = input("text", { maxlength: "70" });
	exportDialog(
		t("payroll.sepa_title"),
		t("payroll.sepa_hint"),
		[el("div", { class: "form-grid three" }, field(t("payroll.sepa_iban"), iban), field(t("payroll.sepa_bic"), bic), field(t("payroll.sepa_name"), name))],
		() =>
			Api.salaryTransfers(project.uuid, run.uuid, run.period, {
				iban: iban.value.trim() || undefined,
				bic: bic.value.trim() || undefined,
				name: name.value.trim() || undefined,
			})
	);
}

export async function payrollRunView(uuid: string, runId: string): Promise<HTMLElement> {
	return payrollSection(uuid, "runs", async (project, state) => {
		const container = el("div", { class: "stack" });
		const money = (amount: number) => formatMoney(amount, project.currency);
		const editable = state.license.active && can(project, Permission.EMPLOYEE_EDIT);

		const download = async (work: () => Promise<{ blob: Blob; name: string }>) => {
			try {
				const file = await work();
				saveFile(file.blob, file.name);
			} catch (error) {
				reportError(error);
			}
		};

		const render = (run: PayrollRunDetails) => {
			const draft = run.status === "draft";
			const act = async (action: "recalculate" | "finalize" | "reopen") => {
				if (action === "finalize") {
					const confirmed = await confirmDialog({ title: t("payroll.finalize_title"), body: t("payroll.finalize_body"), confirmLabel: t("payroll.finalize") });
					if (!confirmed) return;
				}
				try {
					render(await Api.payrollRunAction(uuid, run.uuid, action));
					toast(t(`payroll.done_${action}` as UiKey), "success");
				} catch (error) {
					reportError(error);
				}
			};
			const payDate = input("date", { value: run.pay_date ?? "" });
			payDate.disabled = !draft || !editable;
			payDate.addEventListener("change", async () => {
				try {
					render(await Api.updatePayrollRun(uuid, run.uuid, payDate.value || null));
				} catch (error) {
					reportError(error);
				}
			});
			const ratesNotice = !run.rates
				? el(
						"div",
						{ class: "card notice" },
						el("p", {}, t("payroll.rates_missing")),
						el("a", { class: "button ghost", href: `/projects/${uuid}/payroll/rates` }, t("payroll.tab_rates"))
					)
				: !run.rates.verified
					? el(
							"div",
							{ class: "card notice" },
							el("p", {}, t("payroll.rates_unverified", { period: run.rates.period })),
							el("a", { class: "button ghost", href: `/projects/${uuid}/payroll/rates` }, t("payroll.tab_rates"))
						)
					: null;

			container.replaceChildren(
				el(
					"div",
					{ class: "page-head" },
					el(
						"div",
						{},
						el("a", { class: "back-link", href: `/projects/${uuid}/payroll` }, t("payroll.runs_title")),
						el("h2", {}, t("payroll.run_title", { period: monthLabel(run.period) }))
					),
					statusPill(run.status)
				),
				...(ratesNotice ? [ratesNotice] : []),
				el(
					"div",
					{ class: "toolbar" },
					field(t("payroll.pay_date"), payDate),
					draft && editable
						? el("button", { class: "button ghost", type: "button", onClick: () => void act("recalculate") }, t("payroll.recalculate"))
						: el("span"),
					draft && editable
						? el("button", { class: "button primary", type: "button", onClick: () => void act("finalize") }, t("payroll.finalize"))
						: el("span"),
					!draft && editable ? el("button", { class: "button ghost", type: "button", onClick: () => void act("reopen") }, t("payroll.reopen")) : el("span"),
					el(
						"button",
						{ class: "button ghost", type: "button", onClick: () => void download(() => Api.payrollCsv(uuid, run.uuid, run.period)) },
						t("payroll.export_csv")
					),
					el(
						"button",
						{ class: "button ghost", type: "button", onClick: () => void download(() => Api.payslips(uuid, run.uuid, run.period)) },
						t("payroll.all_payslips")
					),
					!draft ? el("button", { class: "button ghost", type: "button", onClick: () => rekDialog(project, run) }, t("payroll.rek_button")) : el("span"),
					!draft ? el("button", { class: "button ghost", type: "button", onClick: () => sepaDialog(project, run) }, t("payroll.sepa_button")) : el("span"),
					draft && editable
						? el(
								"button",
								{
									class: "button danger",
									type: "button",
									onClick: async () => {
										const confirmed = await confirmDialog({
											title: t("payroll.delete_title"),
											body: t("payroll.delete_body"),
											confirmLabel: t("ui.delete"),
											destructive: true,
										});
										if (!confirmed) return;
										try {
											await Api.deletePayrollRun(uuid, run.uuid);
											navigate(`/projects/${uuid}/payroll`);
										} catch (error) {
											reportError(error);
										}
									},
								},
								t("ui.delete")
							)
						: el("span")
				),
				run.finalized_at
					? el(
							"p",
							{ class: "muted" },
							t("payroll.finalized_by", {
								name: accountName(run.finalized_by_name, run.finalized_by) ?? "",
								date: formatDateTime(run.finalized_at, project.date_format as DateFormat, project.time_format as TimeFormat, project.timezone),
							})
						)
					: el("p", { class: "muted" }, t("payroll.draft_hint")),
				el(
					"div",
					{ class: "card" },
					run.lines.length === 0
						? emptyState(t("payroll.no_people"))
						: table(
								[
									t("workforce.person"),
									t("payroll.gross"),
									t("payroll.contributions"),
									t("payroll.income_tax"),
									t("payroll.net"),
									t("payroll.payout"),
									t("payroll.employer_cost"),
									"",
								],
								run.lines.map((line) => {
									const calculation = line.calculation;
									return el(
										"tr",
										{},
										el(
											"td",
											{},
											el("strong", {}, line.person),
											calculation.items.length ? el("div", { class: "muted" }, t("payroll.items_count", { count: calculation.items.length })) : null,
											calculation.warnings?.includes("no_hours") ? el("div", { class: "warn-text" }, t("payroll.warning_no_hours")) : null,
											el("details", {}, el("summary", {}, t("payroll.details")), lineDetails(project, calculation))
										),
										el("td", { class: "numeric mono" }, money(calculation.gross)),
										el("td", { class: "numeric mono" }, calculation.net ? money(calculation.net.employee_contributions_total) : "-"),
										el("td", { class: "numeric mono" }, calculation.net ? money(calculation.net.income_tax) : "-"),
										el("td", { class: "numeric mono" }, calculation.net ? money(calculation.net.net) : "-"),
										el("td", { class: "numeric mono" }, calculation.payout === null ? "-" : el("strong", {}, money(calculation.payout))),
										el("td", { class: "numeric mono" }, money(calculation.employer_cost)),
										el(
											"td",
											{ class: "actions" },
											draft && editable
												? el(
														"button",
														{ class: "button ghost small", type: "button", onClick: () => itemsDialog(project, run, line, render) },
														t("payroll.items")
													)
												: null,
											el(
												"button",
												{
													class: "button ghost small",
													type: "button",
													onClick: () => void download(() => Api.payslips(uuid, run.uuid, run.period, line.uuid)),
												},
												t("payroll.payslip")
											)
										)
									);
								})
							)
				),
				el(
					"div",
					{ class: "card" },
					el("h2", {}, t("payroll.totals")),
					el(
						"dl",
						{ class: "facts" },
						...(
							[
								["payroll.gross", run.totals.gross],
								["payroll.contributions", run.totals.employee_contributions],
								["payroll.income_tax", run.totals.income_tax],
								["payroll.health_flat", run.totals.health_flat],
								["payroll.net", run.totals.net],
								["payroll.reimbursements", run.totals.reimbursements],
								["payroll.deductions", run.totals.deductions],
								["payroll.payout", run.totals.payout],
								["payroll.employer_contributions", run.totals.employer_contributions],
								["payroll.employer_cost", run.totals.employer_cost],
							] as [UiKey, number][]
						).flatMap(([key, amount]) => [el("dt", {}, t(key)), el("dd", { class: "mono" }, money(amount))])
					)
				),
				el("p", { class: "muted" }, t("payroll.limits"))
			);
		};

		render(await Api.payrollRun(uuid, runId));
		return container;
	});
}

function ratesForm(project: Project, period: string, rates: PayrollRates, verified: boolean, onSaved: () => void): HTMLElement {
	const currency = project.currency;
	const percent = (value: number) => input("number", { min: "0", max: "100", step: "0.01", required: true, value: String(value) });
	const money = (minor: number | null) => input("number", { min: "0", step: "0.01", value: minor === null ? "" : String(toMajorUnits(minor, currency)) });
	const minor = (element: HTMLInputElement) => toMinorUnits(Number(element.value || 0), currency);
	const month = input("month", { required: true, value: period });
	const employee = Object.fromEntries(EMPLOYEE_KEYS.map((key) => [key, percent(rates.employee[key])])) as Record<
		(typeof EMPLOYEE_KEYS)[number],
		HTMLInputElement
	>;
	const employer = Object.fromEntries(EMPLOYER_KEYS.map((key) => [key, percent(rates.employer[key])])) as Record<
		(typeof EMPLOYER_KEYS)[number],
		HTMLInputElement
	>;
	const healthFlat = money(rates.health_flat);
	const brackets = rates.brackets.map((bracket) => ({ upTo: money(bracket.up_to), rate: percent(bracket.rate) }));
	brackets.at(-1)!.upTo.disabled = true;
	const general = money(rates.general_relief);
	const limit = money(rates.additional_relief.income_limit);
	const additionalBase = money(rates.additional_relief.base);
	const factor = input("number", { min: "0", max: "10", step: "0.00001", required: true, value: String(rates.additional_relief.factor) });
	const dependents = input("text", { value: rates.dependent_relief.map((amount) => toMajorUnits(amount, currency)).join("; ") });
	const step = money(rates.dependent_relief_step);
	const secondary = percent(rates.secondary_employer_rate ?? 25);
	const minimumBase = money(rates.minimum_contribution_base ?? null);
	const minimumWage = money(rates.minimum_wage ?? null);
	const averageWage = money(rates.average_wage ?? null);
	const mealDaily = money(rates.meal_exempt_daily ?? null);
	const commuteKm = money(rates.commute_exempt_per_km ?? null);
	const optional = (element: HTMLInputElement) => (element.value === "" ? null : minor(element));
	const note = el("textarea", { rows: "2", maxlength: "2000" });
	note.value = rates.note ?? "";
	const checked = input("checkbox");
	checked.checked = verified;

	return el(
		"form",
		{
			class: "card stack",
			onSubmit: async (event) => {
				event.preventDefault();
				const values: PayrollRates = {
					employee: Object.fromEntries(EMPLOYEE_KEYS.map((key) => [key, Number(employee[key].value)])) as unknown as PayrollRates["employee"],
					employer: Object.fromEntries(EMPLOYER_KEYS.map((key) => [key, Number(employer[key].value)])) as unknown as PayrollRates["employer"],
					health_flat: minor(healthFlat),
					brackets: brackets.map((bracket, index) => ({ up_to: index === brackets.length - 1 ? null : minor(bracket.upTo), rate: Number(bracket.rate.value) })),
					general_relief: minor(general),
					additional_relief: { income_limit: minor(limit), base: minor(additionalBase), factor: Number(factor.value) },
					dependent_relief: dependents.value
						.split(/[;\n]/)
						.map((value) => value.trim().replace(",", "."))
						.filter(Boolean)
						.map((value) => toMinorUnits(Number(value), currency)),
					dependent_relief_step: minor(step),
					secondary_employer_rate: Number(secondary.value),
					minimum_contribution_base: optional(minimumBase),
					minimum_wage: optional(minimumWage),
					average_wage: optional(averageWage),
					meal_exempt_daily: optional(mealDaily),
					commute_exempt_per_km: optional(commuteKm),
					note: note.value.trim() || null,
				};
				try {
					await Api.savePayrollRates(project.uuid, month.value, values, checked.checked);
					toast(t("payroll.rates_saved"), "success");
					onSaved();
				} catch (error) {
					reportError(error);
				}
			},
		},
		field(t("payroll.rates_from"), month, t("payroll.rates_from_hint")),
		el("h3", {}, t("payroll.employee_rates")),
		el("div", { class: "form-grid three" }, ...EMPLOYEE_KEYS.map((key) => field(t(`payroll.contribution_${key}` as UiKey), employee[key]))),
		el("h3", {}, t("payroll.employer_rates")),
		el("div", { class: "form-grid three" }, ...EMPLOYER_KEYS.map((key) => field(t(`payroll.contribution_${key}` as UiKey), employer[key]))),
		field(t("payroll.health_flat_amount", { currency }), healthFlat, t("payroll.health_flat_hint")),
		el("h3", {}, t("payroll.brackets")),
		el("p", { class: "muted" }, t("payroll.brackets_hint")),
		...brackets.map((bracket, index) =>
			el(
				"div",
				{ class: "form-grid" },
				field(index === brackets.length - 1 ? t("payroll.bracket_rest") : t("payroll.bracket_up_to", { currency }), bracket.upTo),
				field(t("payroll.bracket_rate"), bracket.rate)
			)
		),
		el("h3", {}, t("payroll.reliefs")),
		el("div", { class: "form-grid" }, field(t("payroll.general_relief_amount", { currency }), general), field(t("payroll.relief_limit", { currency }), limit)),
		el("div", { class: "form-grid" }, field(t("payroll.relief_base", { currency }), additionalBase), field(t("payroll.relief_factor"), factor)),
		el("p", { class: "muted" }, t("payroll.relief_hint")),
		el(
			"div",
			{ class: "form-grid" },
			field(t("payroll.dependent_amounts", { currency }), dependents, t("payroll.dependent_amounts_hint")),
			field(t("payroll.dependent_step", { currency }), step)
		),
		field(t("payroll.secondary_rate"), secondary, t("payroll.secondary_rate_hint")),
		el("h3", {}, t("payroll.limits_title")),
		el(
			"div",
			{ class: "form-grid three" },
			field(t("payroll.minimum_base", { currency }), minimumBase, t("payroll.minimum_base_hint")),
			field(t("payroll.minimum_wage", { currency }), minimumWage, t("payroll.minimum_wage_hint")),
			field(t("payroll.average_wage", { currency }), averageWage, t("payroll.average_wage_hint"))
		),
		el("div", { class: "form-grid" }, field(t("payroll.meal_limit", { currency }), mealDaily), field(t("payroll.commute_limit", { currency }), commuteKm)),
		field(t("payroll.rates_note"), note),
		el("label", { class: "switch" }, checked, el("span", {}, t("payroll.rates_checked"))),
		el("p", { class: "warn-text" }, t("payroll.rates_checked_hint")),
		el("div", { class: "form-actions" }, el("button", { class: "button primary", type: "submit" }, t("ui.save")))
	);
}

export async function payrollRatesView(uuid: string): Promise<HTMLElement> {
	return payrollSection(uuid, "rates", async (project, state) => {
		const container = el("div", { class: "stack" });
		const editable = state.license.active && can(project, Permission.EMPLOYEE_EDIT);

		const load = async () => {
			const { tables, presets } = await Api.payrollRates(uuid);
			const editor = el("div", {});
			const open = (period: string, rates: PayrollRates, verified: boolean) => {
				editor.replaceChildren(ratesForm(project, period, rates, verified, () => void load()));
				editor.scrollIntoView({ behavior: "smooth" });
			};
			const newPeriod = `${state.today.slice(0, 4)}-01`;
			container.replaceChildren(
				el("div", { class: "card notice" }, el("p", {}, t("payroll.rates_intro"))),
				el(
					"div",
					{ class: "card" },
					tables.length === 0
						? emptyState(t("payroll.rates_empty"))
						: table(
								[t("payroll.rates_from"), t("payroll.status"), t("payroll.rates_checked_by"), ""],
								tables.map((row) =>
									el(
										"tr",
										{},
										el("td", {}, monthLabel(row.period)),
										el(
											"td",
											{},
											el(
												"span",
												{ class: `pill pill-${row.verified ? "paid" : "pending"}` },
												t(row.verified ? "payroll.rates_status_checked" : "payroll.rates_status_unchecked")
											)
										),
										el(
											"td",
											{},
											row.verified_at
												? `${accountName(row.verified_by_name, row.verified_by) ?? ""} | ${formatDateTime(row.verified_at, project.date_format as DateFormat, project.time_format as TimeFormat, project.timezone)}`
												: ""
										),
										el(
											"td",
											{ class: "actions" },
											editable
												? el("button", { class: "button ghost small", type: "button", onClick: () => open(row.period, row.rates, row.verified) }, t("ui.edit"))
												: null,
											editable
												? el(
														"button",
														{ class: "button ghost small", type: "button", onClick: () => open(newPeriod, row.rates, false) },
														t("payroll.rates_copy")
													)
												: null,
											editable
												? el(
														"button",
														{
															class: "button ghost small",
															type: "button",
															onClick: async () => {
																const confirmed = await confirmDialog({
																	title: t("payroll.rates_delete_title"),
																	body: t("payroll.rates_delete_body"),
																	confirmLabel: t("ui.delete"),
																	destructive: true,
																});
																if (!confirmed) return;
																try {
																	await Api.deletePayrollRates(uuid, row.period);
																	void load();
																} catch (error) {
																	reportError(error);
																}
															},
														},
														t("ui.delete")
													)
												: null
										)
									)
								)
							),
					editable
						? el(
								"div",
								{ class: "line-actions" },
								...presets.map((preset) =>
									el(
										"button",
										{ class: "button ghost", type: "button", onClick: () => open(preset.period, preset.rates, false) },
										t("payroll.rates_preset_for", { label: preset.label })
									)
								)
							)
						: null
				),
				editor
			);
		};
		await load();
		return container;
	});
}
