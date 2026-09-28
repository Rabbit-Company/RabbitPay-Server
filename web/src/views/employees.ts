import {
	Api,
	type EmployeeInput,
	type EmployeeListing,
	type EmploymentType,
	type PayType,
	type PayrollLine,
	type Project,
	type WorkforceConfig,
	type WorkforceOverrides,
	type WorkforceState,
} from "../api";
import { el, emptyState, field, input, select, table } from "../dom";
import { formatMoney, toMajorUnits, toMinorUnits } from "../money";
import { can, Permission } from "../access";
import { roleLabel, t, type UiKey } from "../i18n";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { formatDay, formatHours, hoursInput, minutesFrom, workforceGate } from "./workforce-shared";

const EMPLOYMENT_TYPES: EmploymentType[] = ["full_time", "part_time", "student", "contractor"];
const PAY_TYPES: PayType[] = ["monthly", "hourly"];

function text(value: string): string | null {
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function clockText(minutes: number): string {
	return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function clockValue(value: string): number | null {
	const match = value.match(/^(\d{2}):(\d{2})$/);
	return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function rulesSection(project: Project, config: WorkforceConfig, settings: WorkforceOverrides) {
	const currency = project.currency;
	const number = (value: number | undefined, fallback: number, min: string, max: string, step = "1") =>
		input("number", { min, max, step, value: value === undefined ? "" : String(value), placeholder: String(fallback) });
	const amount = (value: number | undefined, fallback: number | null) =>
		input("number", {
			min: "0",
			step: "0.01",
			value: value === undefined ? "" : String(toMajorUnits(value, currency)),
			placeholder: fallback === null ? "" : String(toMajorUnits(fallback, currency)),
		});
	const hours = (value: number | undefined, fallback: number, max: string) => {
		const element = hoursInput(value ?? null, { max });
		element.placeholder = String(fallback / 60);
		return element;
	};
	const clock = (value: number | undefined) => input("time", { value: value === undefined ? "" : clockText(value) });

	const editDays = number(settings.edit_days, config.edit_days, "0", "60");
	const paidBreak = number(settings.paid_break_minutes, config.paid_break_minutes, "0", "120");
	const nightFrom = clock(settings.night_from);
	const nightTo = clock(settings.night_to);
	const rates = {
		overtime: number(settings.rates?.overtime, config.rates.overtime, "0", "500", "0.01"),
		night: number(settings.rates?.night, config.rates.night, "0", "500", "0.01"),
		sunday: number(settings.rates?.sunday, config.rates.sunday, "0", "500", "0.01"),
		holiday: number(settings.rates?.holiday, config.rates.holiday, "0", "500", "0.01"),
		sick: number(settings.rates?.sick, config.rates.sick, "0", "500", "0.01"),
		injury: number(settings.rates?.injury, config.rates.injury, "0", "500", "0.01"),
	};
	const sickDays = number(settings.sick_employer_days, config.sick_employer_days, "0", "366");
	const seniority = number(settings.seniority_rate, config.seniority_rate, "0", "5", "0.01");
	const meal = amount(settings.meal_allowance, config.meal_allowance);
	const mealMinimum = hours(settings.meal_min_minutes, config.meal_min_minutes, "24");
	const ticketRate = amount(settings.ticket_hourly_rate, config.ticket_hourly_rate);
	const ticketTax = number(settings.ticket_tax_rate, config.ticket_tax_rate, "0", "100", "0.01");
	const defaultTime = t("employee.rules_default_time", { from: clockText(config.night_from), to: clockText(config.night_to) });

	const optional = (element: HTMLInputElement) => (element.value === "" ? undefined : Number(element.value));
	const optionalMinor = (element: HTMLInputElement) => (element.value === "" ? undefined : toMinorUnits(Number(element.value), currency));

	const read = (): WorkforceOverrides => {
		const from = clockValue(nightFrom.value);
		const to = clockValue(nightTo.value);
		const night = from === null && to === null ? {} : { night_from: from ?? config.night_from, night_to: to ?? config.night_to };
		const rateValues = Object.fromEntries(
			Object.entries(rates)
				.map(([key, element]) => [key, optional(element)] as const)
				.filter(([, value]) => value !== undefined)
		);
		const result: WorkforceOverrides = {
			edit_days: optional(editDays),
			paid_break_minutes: optional(paidBreak),
			...night,
			sick_employer_days: optional(sickDays),
			seniority_rate: optional(seniority),
			meal_allowance: optionalMinor(meal),
			meal_min_minutes: minutesFrom(mealMinimum) ?? undefined,
			ticket_hourly_rate: optionalMinor(ticketRate),
			ticket_tax_rate: optional(ticketTax),
			rates: Object.keys(rateValues).length > 0 ? rateValues : undefined,
		};
		return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined)) as WorkforceOverrides;
	};

	const nodes = [
		el("h3", {}, t("employee.section_rules")),
		el("p", { class: "muted" }, t("employee.rules_hint")),
		el("div", { class: "form-grid" }, field(t("workforce.edit_days"), editDays, t("workforce.edit_days_hint")), field(t("workforce.paid_break"), paidBreak)),
		el("div", { class: "form-grid" }, field(t("workforce.night_from"), nightFrom, defaultTime), field(t("workforce.night_to"), nightTo)),
		el("h3", {}, t("workforce.rates_title")),
		el(
			"div",
			{ class: "form-grid three" },
			field(t("workforce.rate_overtime"), rates.overtime),
			field(t("workforce.rate_night"), rates.night),
			field(t("workforce.rate_sunday"), rates.sunday),
			field(t("workforce.rate_holiday"), rates.holiday),
			field(t("workforce.rate_sick"), rates.sick),
			field(t("workforce.rate_injury"), rates.injury)
		),
		el(
			"div",
			{ class: "form-grid" },
			field(t("workforce.sick_days"), sickDays),
			field(t("workforce.seniority_rate"), seniority),
			field(t("workforce.meal_allowance", { currency }), meal),
			field(t("workforce.meal_minimum"), mealMinimum)
		),
		el("h3", {}, t("workforce.ticket_billing")),
		el(
			"div",
			{ class: "form-grid" },
			field(t("workforce.ticket_rate", { currency }), ticketRate, t("employee.rules_ticket_rate_hint")),
			field(t("workforce.ticket_tax"), ticketTax)
		),
	];
	return { nodes, read };
}

function employeeDialog(project: Project, config: WorkforceConfig, person: EmployeeListing, onSaved: () => void) {
	const record = person.record;
	const currency = project.currency;
	const money = (minor: number | null | undefined) =>
		input("number", { min: "0", step: "0.01", value: minor == null ? "" : String(toMajorUnits(minor, currency)) });
	const toMinor = (element: HTMLInputElement) => (element.value === "" ? null : toMinorUnits(Number(element.value), currency));
	const number = input("text", { maxlength: "64", value: record?.employee_number ?? "" });
	const title = input("text", { maxlength: "150", value: record?.job_title ?? "" });
	const employment = select(
		EMPLOYMENT_TYPES.map((value) => ({ value, label: t(`employee.type_${value}` as UiKey) })),
		record?.employment_type ?? "full_time"
	);
	const started = input("date", { value: record?.started_on ?? "" });
	const ended = input("date", { value: record?.ended_on ?? "" });
	const weekly = hoursInput(record?.weekly_minutes ?? 2400, { min: "1", max: "80" });
	const priorYears = input("number", { min: "0", max: "60", step: "1", value: String(Math.floor((record?.prior_service_months ?? 0) / 12)) });
	const priorMonths = input("number", { min: "0", max: "11", step: "1", value: String((record?.prior_service_months ?? 0) % 12) });
	const vacation = input("number", { min: "0", max: "366", step: "0.5", value: String(record?.vacation_days ?? 20) });
	const payType = select(
		PAY_TYPES.map((value) => ({ value, label: t(`employee.pay_${value}` as UiKey) })),
		record?.pay_type ?? "monthly"
	);
	const details = record?.private;
	const salary = money(details?.salary);
	const commute = money(details?.commute_per_day);
	const personalId = input("text", { maxlength: "13", value: details?.personal_id ?? "", placeholder: "0101990500123" });
	const taxNumber = input("text", { maxlength: "20", value: details?.tax_number ?? "" });
	const birthDate = input("date", { value: details?.birth_date ?? "" });
	const iban = input("text", { maxlength: "42", value: details?.iban ?? "" });
	const phone = input("tel", { maxlength: "40", value: details?.phone ?? "" });
	const email = input("email", { maxlength: "254", value: details?.private_email ?? "" });
	const address = el("textarea", { rows: "2", maxlength: "500" });
	address.value = details?.address ?? "";
	const emergency = input("text", { maxlength: "300", value: details?.emergency_contact ?? "" });
	const notes = el("textarea", { rows: "3", maxlength: "5000" });
	notes.value = details?.notes ?? "";
	const dependents = input("number", { min: "0", max: "20", step: "1", value: String(details?.dependents ?? 0) });
	const relief = input("checkbox");
	relief.checked = details?.claims_general_relief ?? true;
	const commuteKm = input("number", { min: "0", max: "1000", step: "1", value: details?.commute_km == null ? "" : String(details.commute_km) });
	const secondary = input("checkbox");
	secondary.checked = details?.secondary_employer ?? false;
	const salaryLabel = () => (payType.value === "hourly" ? t("employee.hourly_rate", { currency }) : t("employee.monthly_salary", { currency }));
	const salaryField = field(salaryLabel(), salary, t("employee.salary_hint"));
	payType.addEventListener("change", () => {
		salaryField.querySelector(".field-label")!.textContent = salaryLabel();
	});
	const rules = rulesSection(project, config, record?.workforce_settings ?? {});
	const submit = el("button", { class: "button primary", type: "submit" }, t("ui.save"));

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				const body: EmployeeInput = {
					employee_number: text(number.value),
					job_title: text(title.value),
					employment_type: employment.value as EmploymentType,
					started_on: started.value || null,
					ended_on: ended.value || null,
					prior_service_months: Number(priorYears.value || 0) * 12 + Number(priorMonths.value || 0),
					weekly_minutes: minutesFrom(weekly) ?? 2400,
					vacation_days: Number(vacation.value || 0),
					pay_type: payType.value as PayType,
					workforce_settings: rules.read(),
					private: {
						salary: toMinor(salary),
						commute_per_day: toMinor(commute),
						personal_id: text(personalId.value),
						tax_number: text(taxNumber.value),
						birth_date: birthDate.value || null,
						iban: text(iban.value),
						phone: text(phone.value),
						private_email: text(email.value),
						address: text(address.value),
						emergency_contact: text(emergency.value),
						notes: text(notes.value),
						dependents: Number(dependents.value || 0),
						claims_general_relief: relief.checked,
						commute_km: commuteKm.value === "" ? null : Number(commuteKm.value),
						secondary_employer: secondary.checked,
					},
				};
				try {
					await Api.saveEmployee(project.uuid, person.member, body);
					toast(t("employee.saved"), "success");
					dialog.close();
					onSaved();
				} catch (error) {
					reportError(error);
				} finally {
					submit.disabled = false;
				}
			},
		},
		el("h3", {}, t("employee.section_job")),
		el(
			"div",
			{ class: "form-grid three" },
			field(t("employee.number"), number),
			field(t("employee.job_title"), title),
			field(t("employee.employment_type"), employment)
		),
		el(
			"div",
			{ class: "form-grid three" },
			field(t("employee.started"), started),
			field(t("employee.ended"), ended),
			field(t("employee.weekly_hours"), weekly, t("employee.weekly_hours_hint"))
		),
		el(
			"div",
			{ class: "form-grid" },
			field(t("employee.prior_years"), priorYears, t("employee.prior_service_hint")),
			field(t("employee.prior_months"), priorMonths)
		),
		el(
			"div",
			{ class: "form-grid three" },
			field(t("employee.vacation_days"), vacation, t("employee.vacation_days_hint")),
			field(t("employee.pay_type"), payType),
			salaryField
		),
		el(
			"div",
			{ class: "form-grid" },
			field(t("employee.commute", { currency }), commute, t("employee.commute_hint")),
			field(t("employee.commute_km"), commuteKm, t("employee.commute_km_hint"))
		),
		el(
			"div",
			{ class: "field" },
			el("label", { class: "switch" }, secondary, el("span", {}, t("employee.secondary_employer"))),
			el("span", { class: "field-hint" }, t("employee.secondary_employer_hint"))
		),
		...rules.nodes,
		el("h3", {}, t("employee.section_private")),
		el("p", { class: "muted" }, t("employee.private_hint")),
		el(
			"div",
			{ class: "form-grid three" },
			field(t("employee.personal_id"), personalId),
			field(t("employee.tax_number"), taxNumber),
			field(t("employee.birth_date"), birthDate)
		),
		el("div", { class: "form-grid three" }, field(t("employee.iban"), iban), field(t("employee.phone"), phone), field(t("employee.private_email"), email)),
		el(
			"div",
			{ class: "form-grid" },
			field(t("employee.dependents"), dependents, t("employee.dependents_hint")),
			el(
				"div",
				{ class: "field" },
				el("label", { class: "switch" }, relief, el("span", {}, t("employee.claims_relief"))),
				el("span", { class: "field-hint" }, t("employee.claims_relief_hint"))
			)
		),
		field(t("employee.address"), address),
		field(t("employee.emergency"), emergency),
		field(t("employee.notes"), notes),
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(t("employee.edit_title", { name: person.name }), form, undefined, "dialog-medium");
}

function payrollTable(project: Project, lines: PayrollLine[]): HTMLElement {
	const money = (amount: number) => formatMoney(amount, project.currency);
	if (lines.length === 0) return emptyState(t("payroll.empty"));
	return table(
		[
			t("workforce.person"),
			t("payroll.hours"),
			t("payroll.base"),
			t("payroll.supplements"),
			t("payroll.sick"),
			t("payroll.gross"),
			t("payroll.reimbursements"),
		],
		lines.map((line) => {
			const amounts = line.amounts;
			const supplements = amounts.overtime_supplement + amounts.night_supplement + amounts.sunday_supplement + amounts.holiday_supplement + amounts.seniority;
			return el(
				"tr",
				{},
				el(
					"td",
					{},
					line.person,
					line.salary === null
						? el("div", { class: "warn-text" }, t("payroll.no_salary"))
						: el("div", { class: "muted" }, t("payroll.rate", { rate: money(line.hourly_rate ?? 0) }))
				),
				el(
					"td",
					{ class: "mono" },
					el("div", {}, t("payroll.hours_worked", { hours: formatHours(line.minutes.worked + line.minutes.overtime) })),
					el(
						"div",
						{ class: "muted" },
						t("payroll.hours_paid_leave", { hours: formatHours(line.minutes.holiday + line.minutes.vacation + line.minutes.paid_leave) })
					),
					line.minutes.sick_employer + line.minutes.sick_insurance
						? el(
								"div",
								{ class: "muted" },
								t("payroll.hours_sick", { employer: formatHours(line.minutes.sick_employer), insurance: formatHours(line.minutes.sick_insurance) })
							)
						: null
				),
				el("td", { class: "numeric mono" }, money(amounts.regular + amounts.overtime + amounts.holidays + amounts.leave)),
				el(
					"td",
					{ class: "numeric mono" },
					money(supplements),
					supplements
						? el(
								"div",
								{ class: "muted" },
								[
									amounts.overtime_supplement ? `${t("payroll.overtime")} ${money(amounts.overtime_supplement)}` : null,
									amounts.night_supplement ? `${t("report.night")} ${money(amounts.night_supplement)}` : null,
									amounts.sunday_supplement ? `${t("report.sunday")} ${money(amounts.sunday_supplement)}` : null,
									amounts.holiday_supplement ? `${t("report.holiday_work")} ${money(amounts.holiday_supplement)}` : null,
									amounts.seniority ? `${t("payroll.seniority")} ${money(amounts.seniority)}` : null,
								]
									.filter(Boolean)
									.join(", ")
							)
						: null
				),
				el("td", { class: "numeric mono" }, money(amounts.sick)),
				el("td", { class: "numeric mono" }, el("strong", {}, money(amounts.gross))),
				el(
					"td",
					{ class: "numeric mono" },
					money(amounts.reimbursements),
					amounts.reimbursements
						? el("div", { class: "muted" }, `${t("payroll.meal")} ${money(amounts.meal)} | ${t("payroll.commute")} ${money(amounts.commute)}`)
						: null
				)
			);
		})
	);
}

export async function employeesView(uuid: string): Promise<HTMLElement> {
	return workforceGate(uuid, async (project, state: WorkforceState) => {
		const editable = state.license.active && can(project, Permission.EMPLOYEE_EDIT);
		const list = el("div", {});
		const payroll = el("div", {});
		const month = input("month", { value: state.today.slice(0, 7) });

		const loadPayroll = async () => {
			if (!month.value) return;
			try {
				const result = await Api.payroll(uuid, month.value);
				payroll.replaceChildren(payrollTable(project, result.lines));
			} catch (error) {
				reportError(error);
			}
		};

		const load = async () => {
			try {
				const people = await Api.employees(uuid);
				list.replaceChildren(
					people.length === 0
						? emptyState(t("employee.empty"))
						: table(
								[
									t("workforce.person"),
									t("employee.number"),
									t("employee.job_title"),
									t("employee.employment_type"),
									t("employee.weekly_hours"),
									t("employee.started"),
									t("employee.salary"),
									"",
								],
								people.map((person) => {
									const record = person.record;
									return el(
										"tr",
										{},
										el("td", {}, person.name, el("div", { class: "muted" }, roleLabel(person.role))),
										el("td", { class: "mono" }, record?.employee_number ?? ""),
										el("td", {}, record?.job_title ?? ""),
										el("td", {}, record ? t(`employee.type_${record.employment_type}` as UiKey) : el("span", { class: "muted" }, t("employee.no_record"))),
										el("td", { class: "numeric mono" }, record ? formatHours(record.weekly_minutes) : ""),
										el("td", {}, record?.started_on ? formatDay(record.started_on, project) : ""),
										el(
											"td",
											{ class: "numeric mono" },
											record?.private.salary != null
												? `${formatMoney(record.private.salary, project.currency)}${record.pay_type === "hourly" ? ` / ${t("employee.per_hour")}` : ""}`
												: ""
										),
										el(
											"td",
											{ class: "actions" },
											editable
												? el(
														"button",
														{
															class: "button ghost small",
															type: "button",
															onClick: () => employeeDialog(project, state.config, person, () => void Promise.all([load(), loadPayroll()])),
														},
														record ? t("ui.edit") : t("employee.add_record")
													)
												: null,
											editable && record
												? el(
														"button",
														{
															class: "button ghost small",
															type: "button",
															onClick: async () => {
																const confirmed = await confirmDialog({
																	title: t("employee.delete_title"),
																	body: t("employee.delete_body", { name: person.name }),
																	confirmLabel: t("ui.delete"),
																	destructive: true,
																});
																if (!confirmed) return;
																try {
																	await Api.deleteEmployee(uuid, person.member);
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
									);
								})
							)
				);
			} catch (error) {
				reportError(error);
			}
		};
		month.addEventListener("change", () => void loadPayroll());
		await Promise.all([load(), loadPayroll()]);

		return el(
			"div",
			{ class: "stack" },
			el("div", { class: "card stack" }, el("h2", {}, t("employee.title")), el("p", { class: "muted" }, t("employee.hint")), list),
			el(
				"div",
				{ class: "card stack" },
				el("div", { class: "toolbar" }, el("h2", { class: "toolbar-title" }, t("payroll.title")), month),
				el("p", { class: "muted" }, t("payroll.hint")),
				payroll,
				el("a", { class: "button ghost", href: `/projects/${uuid}/payroll` }, t("payroll.open_runs"))
			)
		);
	});
}
