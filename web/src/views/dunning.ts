import {
	Api,
	DunningApi,
	type Debtor,
	type DunningCandidates,
	type DunningDocumentCandidate,
	type DunningInput,
	type DunningLetter,
	type DunningLetterDetail,
	type EmailMessage,
	type Project,
} from "../api";
import { can, Permission } from "../access";
import { el, emptyState, field, input, replaceContent, saveFile, select, table } from "../dom";
import { formatDate, formatDateTime, formatMoney, toMinorUnits } from "../money";
import { navigate } from "../router";
import { combobox } from "../combobox";
import { accountName, confirmDialog, modal, pdfPreviewButton, reportError, toast } from "../ui";
import { actionMenu, type MenuLink } from "../menu";
import { icon } from "../storefront/icons";
import { statusLabel, t, tn, type UiKey } from "../i18n";
import { loadProject, projectLayout } from "./project";
import { customerOption } from "./invoice-editor";
import { emailKindLabel } from "./invoices";
import { LANGUAGES } from "../../../server/i18n";
import { DEFAULT_DEADLINE_DAYS, dunningTotals, lineFigures, MAX_DEADLINE_DAYS, possiblyTimeBarred, type DunningLevel } from "../../../server/dunning-rules";
import type { DateFormat } from "../../../server/formats";

const LEVEL_TITLES: Record<DunningLevel, UiKey> = { 1: "dunning.level_1", 2: "dunning.level_2", 3: "dunning.level_3" };
const LEVEL_HINTS: Record<DunningLevel, UiKey> = { 1: "dunning.level_1_hint", 2: "dunning.level_2_hint", 3: "dunning.level_3_hint" };

function dunningPath(uuid: string, suffix = ""): string {
	return `/projects/${uuid}/dunning${suffix}`;
}

function localStamp(date: string): number {
	return Date.parse(`${date}T12:00:00Z`);
}

function dateText(project: Project, date: string | null): string {
	return date ? formatDate(localStamp(date), project.date_format as DateFormat, "UTC") : "-";
}

function levelPill(level: DunningLevel): HTMLElement {
	return el("span", { class: `pill dunning-level dunning-level-${level}` }, t(LEVEL_TITLES[level]));
}

function daysLate(today: string, due: string): number {
	return Math.max(0, Math.round((localStamp(today) - localStamp(due)) / 86400000));
}

function pageHead(title: string | HTMLElement, intro: string | null, actions: (HTMLElement | null)[] = []): HTMLElement {
	return el(
		"div",
		{ class: "page-head" },
		el("div", {}, typeof title === "string" ? el("h2", {}, title) : title, intro ? el("p", { class: "muted" }, intro) : null),
		el("div", { class: "line-actions" }, ...actions)
	);
}

function statCard(label: string, value: string, tone = ""): HTMLElement {
	return el("div", { class: `card stat ${tone}` }, el("span", { class: "stat-value mono" }, value), el("span", { class: "stat-label" }, label));
}

function pickCustomerDialog(uuid: string) {
	const combo = combobox({
		class: "combo-customer",
		placeholder: t("dunning.pick_customer_placeholder"),
		emptyText: t("editor.no_customer_match"),
		search: async (query) => (await Api.customers(uuid, { search: query || undefined, limit: 20 })).customers.map(customerOption),
	});
	combo.onChange(() => {
		if (!combo.value) return;
		dialog.close();
		navigate(dunningPath(uuid, `/new?customer=${combo.value}`));
	});
	const dialog = modal(
		t("dunning.new"),
		el(
			"div",
			{ class: "stack" },
			el("p", { class: "muted" }, t("dunning.pick_customer_hint")),
			field(t("customers.column_customer"), combo.element),
			el(
				"p",
				{ class: "muted small-print" },
				t("dunning.pick_customer_missing"),
				" ",
				el("a", { href: `/projects/${uuid}/customers` }, t("dunning.pick_customer_link"))
			)
		),
		undefined,
		"dialog-medium"
	);
	combo.input.focus();
}

function debtorRow(uuid: string, project: Project, debtor: Debtor, today: string, creates: boolean): HTMLElement {
	const oldest = new Date(debtor.oldest_due).toISOString().slice(0, 10);
	const next = debtor.last_letter ? Math.min(debtor.last_letter.level + 1, 3) : 1;
	return el(
		"tr",
		{},
		el(
			"td",
			{},
			el("a", { href: `/projects/${uuid}/customers/${debtor.customer}` }, el("strong", {}, debtor.name || debtor.email || t("customers.unnamed"))),
			debtor.name && debtor.email ? el("div", { class: "muted" }, debtor.email) : null
		),
		el("td", { class: "numeric" }, String(debtor.invoices)),
		el("td", { class: "mono numeric" }, formatMoney(debtor.overdue_amount, debtor.currency)),
		el(
			"td",
			{},
			formatDate(debtor.oldest_due, project.date_format as DateFormat, project.timezone),
			el("div", { class: "warn-text" }, t("dunning.days_late", { days: daysLate(today, oldest) }))
		),
		el(
			"td",
			{},
			debtor.last_letter
				? el(
						"a",
						{ class: "dunning-last", href: dunningPath(uuid, `/${debtor.last_letter.uuid}`) },
						levelPill(debtor.last_letter.level),
						el("span", { class: "muted" }, dateText(project, debtor.last_letter.issue_date))
					)
				: el("span", { class: "muted" }, t("dunning.none_yet"))
		),
		el(
			"td",
			{ class: "actions" },
			creates
				? el(
						"a",
						{
							class: `button small ${next === 3 ? "danger" : "ghost"}`,
							href: dunningPath(uuid, `/new?customer=${debtor.customer}&currency=${debtor.currency}`),
						},
						t(next === 1 ? "dunning.send_first" : next === 2 ? "dunning.send_second" : "dunning.send_final")
					)
				: null
		)
	);
}

function letterRow(uuid: string, project: Project, letter: DunningLetter): HTMLElement {
	return el(
		"tr",
		{},
		el("td", {}, el("a", { class: "mono", href: dunningPath(uuid, `/${letter.uuid}`) }, letter.number)),
		el(
			"td",
			{},
			letter.customer ? el("a", { href: `/projects/${uuid}/customers/${letter.customer}` }, letter.customer_name || "-") : letter.customer_name || "-"
		),
		el("td", {}, levelPill(letter.level)),
		el("td", {}, dateText(project, letter.issue_date)),
		el("td", {}, dateText(project, letter.deadline_date)),
		el("td", { class: "mono numeric" }, formatMoney(letter.total_amount, letter.currency)),
		el(
			"td",
			{},
			letter.emails > 0 ? el("span", { class: "dunning-sent" }, icon("mail", 14, "inline-icon"), String(letter.emails)) : el("span", { class: "muted" }, "-")
		)
	);
}

export async function dunningView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const creates = can(project, Permission.INVOICE_CREATE);
	const [overview, letters] = await Promise.all([DunningApi.debtors(uuid), DunningApi.letters(uuid, { limit: 50 })]);

	const totals = new Map<string, number>();
	for (const debtor of overview.debtors) totals.set(debtor.currency, (totals.get(debtor.currency) ?? 0) + debtor.overdue_amount);
	const year = overview.today.slice(0, 4);
	const thisYear = letters.letters.filter((letter) => letter.issue_date.startsWith(year)).length;
	const customers = new Set(overview.debtors.map((debtor) => debtor.customer)).size;

	const newButton = creates ? el("button", { class: "button primary", type: "button", onClick: () => pickCustomerDialog(uuid) }, t("dunning.new")) : null;

	const debtorsCard = el(
		"div",
		{ class: "card" },
		el("div", { class: "card-head" }, el("h3", {}, t("dunning.debtors_title")), el("span", { class: "muted" }, t("dunning.debtors_hint"))),
		overview.debtors.length === 0
			? el("div", { class: "dunning-clear" }, icon("check", 22, "dunning-clear-icon"), el("p", {}, t("dunning.no_debtors")))
			: table(
					[
						t("customers.column_customer"),
						{ label: t("dunning.column_invoices"), class: "numeric" },
						{ label: t("dunning.column_overdue"), class: "numeric" },
						t("dunning.column_oldest"),
						t("dunning.column_last_letter"),
						"",
					],
					overview.debtors.map((debtor) => debtorRow(uuid, project, debtor, overview.today, creates))
				)
	);

	const lettersCard = el(
		"div",
		{ class: "card" },
		el(
			"div",
			{ class: "card-head" },
			el("h3", {}, t("dunning.letters_title")),
			letters.total > 0 ? el("span", { class: "muted" }, tn("count.dunning_letters", letters.total)) : null
		),
		letters.letters.length === 0
			? el("p", { class: "muted" }, t("dunning.no_letters"))
			: table(
					[
						t("dunning.column_number"),
						t("customers.column_customer"),
						t("dunning.column_level"),
						t("dunning.column_date"),
						t("dunning.column_pay_by"),
						{ label: t("dunning.column_total"), class: "numeric" },
						t("dunning.column_emailed"),
					],
					letters.letters.map((letter) => letterRow(uuid, project, letter))
				)
	);

	return projectLayout(
		project,
		el(
			"div",
			{ class: "stack dunning" },
			pageHead(t("dunning.title"), t("dunning.intro"), [newButton]),
			el(
				"div",
				{ class: "grid stats" },
				statCard(
					t("dunning.stat_overdue"),
					totals.size === 0 ? formatMoney(0, project.currency) : [...totals].map(([currency, amount]) => formatMoney(amount, currency)).join(" | "),
					totals.size > 0 ? "dunning-stat-danger" : ""
				),
				statCard(t("dunning.stat_customers"), String(customers)),
				statCard(t("dunning.stat_letters", { year }), String(thisYear))
			),
			debtorsCard,
			lettersCard
		)
	);
}

interface ManualLine {
	reference: string;
	issue_date: string | null;
	due_date: string;
	amount: number;
	open: number;
}

function manualLineDialog(currency: string, today: string, onAdd: (line: ManualLine) => void) {
	const reference = input("text", { maxlength: "64", required: true, placeholder: "2024-117" });
	const issued = input("date", { max: today });
	const due = input("date", { max: today, required: true });
	const amount = input("number", { min: "0", step: "0.01", placeholder: "0.00" });
	const open = input("number", { min: "0.01", step: "0.01", required: true, placeholder: "0.00" });
	const submit = el("button", { class: "button primary", type: "submit" }, t("dunning.manual_add"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: (event) => {
				event.preventDefault();
				const openMinor = toMinorUnits(Number(open.value), currency);
				const amountMinor = amount.value ? toMinorUnits(Number(amount.value), currency) : openMinor;
				if (!due.value || due.value >= today) {
					toast(t("dunning.manual_due_past"), "error");
					return;
				}
				if (openMinor <= 0 || amountMinor < openMinor) {
					toast(t("dunning.manual_amounts"), "error");
					return;
				}
				onAdd({ reference: reference.value.trim(), issue_date: issued.value || null, due_date: due.value, amount: amountMinor, open: openMinor });
				dialog.close();
			},
		},
		el("p", { class: "muted" }, t("dunning.manual_hint")),
		field(t("dunning.manual_reference"), reference),
		el("div", { class: "form-grid" }, field(t("dunning.manual_issued"), issued), field(t("dunning.manual_due"), due)),
		el(
			"div",
			{ class: "form-grid" },
			field(t("dunning.manual_amount", { currency }), amount, t("dunning.manual_amount_hint")),
			field(t("dunning.manual_open", { currency }), open)
		),
		el("div", { class: "dialog-actions" }, submit)
	);
	const dialog = modal(t("dunning.manual_title"), form, undefined, "dialog-medium");
	reference.focus();
}

interface EditorRow {
	key: string;
	kind: "invoice" | "recorded" | "manual";
	id: string | null;
	reference: string;
	issue_date: string | null;
	due_on: string;
	amount: number;
	open: number;
	currency: string;
	time_barred: boolean;
	selected: boolean;
	manual?: ManualLine;
}

function documentsTable(headers: Parameters<typeof table>[0], rows: HTMLElement[]): HTMLElement {
	const wrap = table(headers, rows);
	wrap.classList.add("dunning-documents");
	return wrap;
}

function candidateRow(kind: "invoice" | "recorded", candidate: DunningDocumentCandidate): EditorRow {
	return {
		key: `${kind}:${candidate.uuid}`,
		kind,
		id: candidate.uuid,
		reference: candidate.reference,
		issue_date: candidate.issue_date,
		due_on: candidate.due_on,
		amount: candidate.amount,
		open: candidate.open,
		currency: candidate.currency,
		time_barred: candidate.time_barred,
		selected: true,
	};
}

function letterEditor(uuid: string, project: Project, candidates: DunningCandidates, params: URLSearchParams): HTMLElement {
	const today = candidates.today;
	const rows: EditorRow[] = [
		...candidates.invoices.map((entry) => candidateRow("invoice", entry)),
		...candidates.recorded.map((entry) => candidateRow("recorded", entry)),
	];
	const currencies = () => [...new Set([...rows.map((row) => row.currency), project.currency])];
	const requestedCurrency = params.get("currency");
	const busiest = [...rows].sort((left, right) => right.open - left.open)[0]?.currency;
	let currency = requestedCurrency && currencies().includes(requestedCurrency) ? requestedCurrency : (busiest ?? project.currency);

	const requestedLevel = Number(params.get("level"));
	let level: DunningLevel = requestedLevel === 1 || requestedLevel === 2 || requestedLevel === 3 ? requestedLevel : candidates.suggested_level;

	const currencySelect = select(
		currencies().map((value) => ({ value, label: value })),
		currency
	);
	const deadline = input("number", { min: "1", max: String(MAX_DEADLINE_DAYS), value: String(DEFAULT_DEADLINE_DAYS), required: true });
	const language = select(
		LANGUAGES.map((entry) => ({ value: entry.value, label: entry.label })),
		project.language
	);
	const interest = input("checkbox");
	interest.checked = candidates.interest_available && level > 1;
	const compensation = input("checkbox");
	const compensationPossible = candidates.compensation_available && candidates.customer.business;
	const note = el("textarea", { rows: "3", maxlength: "2000", placeholder: t("dunning.note_placeholder") }) as HTMLTextAreaElement;

	const levelButtons = ([1, 2, 3] as DunningLevel[]).map((value) =>
		el(
			"button",
			{
				type: "button",
				class: "dunning-level-option",
				onClick: () => {
					level = value;
					refresh();
				},
			},
			el("span", { class: "dunning-level-step" }, String(value)),
			el("span", { class: "dunning-level-text" }, el("strong", {}, t(LEVEL_TITLES[value])), el("span", { class: "muted" }, t(LEVEL_HINTS[value])))
		)
	);

	const levelGroup = el("div", { class: "dunning-levels" }, ...levelButtons);
	levelGroup.setAttribute("role", "group");
	levelGroup.setAttribute("aria-label", t("dunning.column_level"));
	const documentsBody = el("div", {});
	const summaryBody = el("div", { class: "dunning-summary-rows" });
	const issueButton = el("button", { class: "button primary", type: "button" }, t("dunning.issue"));
	const deadlineText = el("p", { class: "muted dunning-deadline" });

	const payload = (): DunningInput => {
		const chosen = rows.filter((row) => row.selected && row.currency === currency);
		return {
			customer: candidates.customer.uuid,
			level,
			currency,
			language: language.value,
			deadline_days: Number(deadline.value) || DEFAULT_DEADLINE_DAYS,
			interest: candidates.interest_available && interest.checked,
			compensation: compensationPossible && currency === "EUR" && compensation.checked,
			note: note.value.trim() || null,
			invoices: chosen.filter((row) => row.kind === "invoice").map((row) => row.id!),
			recorded_invoices: chosen.filter((row) => row.kind === "recorded").map((row) => row.id!),
			manual: chosen.filter((row) => row.kind === "manual").map((row) => row.manual!),
		};
	};

	const figuresOf = (row: EditorRow) =>
		lineFigures(
			{ open: row.open, due: row.due_on },
			{ until: today, interest: payload().interest, compensation: payload().compensation, business: candidates.customer.business, currency }
		);

	const addManual = (line: ManualLine) => {
		rows.push({
			key: `manual:${crypto.randomUUID()}`,
			kind: "manual",
			id: null,
			reference: line.reference,
			issue_date: line.issue_date,
			due_on: line.due_date,
			amount: line.amount,
			open: line.open,
			currency,
			time_barred: possiblyTimeBarred(line.due_date, today),
			selected: true,
			manual: line,
		});
		refresh();
	};

	const documentRow = (row: EditorRow): HTMLElement => {
		const check = input("checkbox");
		check.checked = row.selected;
		check.setAttribute("aria-label", row.reference);
		check.addEventListener("change", () => {
			row.selected = check.checked;
			refresh();
		});
		const figures = figuresOf(row);
		const withInterest = payload().interest;
		return el(
			"tr",
			{ class: row.selected ? "" : "muted-row" },
			el("td", { class: "dunning-check" }, check),
			el(
				"td",
				{ class: "dunning-document" },
				row.kind === "invoice"
					? el("a", { class: "mono", href: `/projects/${uuid}/invoices/${row.id}` }, row.reference)
					: el("span", { class: "mono" }, row.reference),
				row.kind !== "invoice" ? el("div", { class: "muted" }, t(row.kind === "recorded" ? "dunning.kind_recorded" : "dunning.kind_manual")) : null,
				row.open !== row.amount ? el("div", { class: "muted" }, t("dunning.of_total", { amount: formatMoney(row.amount, row.currency) })) : null,
				row.time_barred ? el("div", { class: "warn-text" }, t("dunning.time_barred")) : null
			),
			el("td", { class: "dunning-date dunning-issued" }, dateText(project, row.issue_date)),
			el(
				"td",
				{ class: "dunning-date dunning-due" },
				el("span", { class: "dunning-phone-label" }, `${t("dunning.column_due")} `),
				dateText(project, row.due_on)
			),
			el(
				"td",
				{ class: "numeric dunning-late" },
				el("span", { class: `dunning-days ${figures.days > 90 ? "dunning-days-long" : ""}` }, String(figures.days)),
				el("span", { class: "dunning-phone-label" }, ` ${t("dunning.phone_days")}`)
			),
			el("td", { class: "mono numeric dunning-open" }, formatMoney(row.open, row.currency)),
			withInterest
				? el(
						"td",
						{ class: "mono numeric muted dunning-interest" },
						el("span", { class: "dunning-phone-label" }, `${t("dunning.column_interest")} `),
						formatMoney(figures.interest, row.currency)
					)
				: null,
			el(
				"td",
				{ class: "actions dunning-remove" },
				row.kind === "manual"
					? el(
							"button",
							{
								class: "icon-button",
								type: "button",
								title: t("dunning.remove_line"),
								onClick: () => {
									rows.splice(rows.indexOf(row), 1);
									refresh();
								},
							},
							icon("trash", 16)
						)
					: null
			)
		);
	};

	const renderDocuments = () => {
		const visible = rows.filter((row) => row.currency === currency).sort((left, right) => left.due_on.localeCompare(right.due_on));
		const hidden = rows.filter((row) => row.currency !== currency).length;
		const withInterest = payload().interest;
		const selectAll = input("checkbox");
		selectAll.checked = visible.length > 0 && visible.every((row) => row.selected);
		selectAll.setAttribute("aria-label", t("dunning.select_all"));
		selectAll.addEventListener("change", () => {
			for (const row of visible) row.selected = selectAll.checked;
			refresh();
		});
		const addButton = el(
			"button",
			{ class: "button ghost small", type: "button", onClick: () => manualLineDialog(currency, today, addManual) },
			icon("plus", 14),
			t("dunning.manual_open_dialog")
		);
		const previous = candidates.previous_manual.filter(
			(line) => !rows.some((row) => row.kind === "manual" && row.reference === line.reference && row.due_on === line.due_on)
		);

		replaceContent(
			documentsBody,
			visible.length === 0
				? el("div", { class: "dunning-empty" }, el("p", {}, t("dunning.no_documents")), el("p", { class: "muted" }, t("dunning.no_documents_hint")))
				: documentsTable(
						[
							{ label: "", class: "dunning-check" },
							t("dunning.column_document"),
							t("dunning.column_issued"),
							t("dunning.column_due"),
							{ label: t("dunning.column_days"), class: "numeric" },
							{ label: t("dunning.column_open"), class: "numeric" },
							...(withInterest ? [{ label: t("dunning.column_interest"), class: "numeric" }] : []),
							"",
						],
						visible.map(documentRow)
					),
			visible.length > 0 ? el("label", { class: "switch dunning-select-all" }, selectAll, el("span", {}, t("dunning.select_all"))) : null,
			el(
				"div",
				{ class: "dunning-documents-foot" },
				addButton,
				previous.length > 0 && currency === (candidates.invoices[0]?.currency ?? currency)
					? el(
							"button",
							{
								class: "button ghost small",
								type: "button",
								onClick: () => {
									for (const line of previous)
										addManual({ reference: line.reference, issue_date: line.issue_date, due_date: line.due_on, amount: line.amount, open: line.open });
								},
							},
							icon("repeat", 14),
							t("dunning.previous_manual", { count: previous.length })
						)
					: null
			),
			candidates.not_due > 0 ? el("p", { class: "muted small-print" }, tn("dunning.not_due", candidates.not_due)) : null,
			hidden > 0 ? el("p", { class: "muted small-print" }, tn("dunning.other_currency", hidden)) : null
		);
	};

	const renderSummary = () => {
		const chosen = rows.filter((row) => row.selected && row.currency === currency);
		const totals = dunningTotals(chosen.map((row) => ({ open: row.open, due: row.due_on, ...figuresOf(row) })));
		const data = payload();
		const deadlineDate = new Date(localStamp(today) + data.deadline_days * 86400000).toISOString().slice(0, 10);
		deadlineText.textContent = t("dunning.deadline_on", { date: dateText(project, deadlineDate) });
		replaceContent(
			summaryBody,
			el(
				"div",
				{ class: "totals-row" },
				el("span", {}, tn("dunning.documents_count", chosen.length)),
				el("span", { class: "mono" }, formatMoney(totals.principal, currency))
			),
			data.interest
				? el(
						"div",
						{ class: "totals-row" },
						el("span", {}, t("dunning.summary_interest")),
						el("span", { class: "mono" }, formatMoney(totals.interest, currency))
					)
				: null,
			data.compensation
				? el(
						"div",
						{ class: "totals-row" },
						el("span", {}, t("dunning.summary_compensation")),
						el("span", { class: "mono" }, formatMoney(totals.compensation, currency))
					)
				: null,
			el("div", { class: "totals-row grand" }, el("span", {}, t("dunning.summary_total")), el("span", { class: "mono" }, formatMoney(totals.total, currency)))
		);
		issueButton.disabled = chosen.length === 0;
	};

	const refresh = () => {
		levelButtons.forEach((button, index) => {
			const active = index + 1 === level;
			button.classList.toggle("active", active);
			button.setAttribute("aria-pressed", String(active));
		});
		renderDocuments();
		renderSummary();
	};

	currencySelect.addEventListener("change", () => {
		currency = currencySelect.value;
		refresh();
	});
	for (const control of [deadline, interest, compensation]) control.addEventListener("input", refresh);
	for (const control of [interest, compensation]) control.addEventListener("change", refresh);

	issueButton.addEventListener("click", async () => {
		const data = payload();
		const confirmed = await confirmDialog({
			title: t("dunning.issue_title", { title: t(LEVEL_TITLES[level]) }),
			body: t("dunning.issue_body", { customer: candidates.customer.name || candidates.customer.email || "" }),
			confirmLabel: t("dunning.issue"),
		});
		if (!confirmed) return;
		issueButton.disabled = true;
		try {
			const letter = await DunningApi.create(uuid, data);
			toast(t("dunning.issued", { number: letter.number }), "success");
			navigate(dunningPath(uuid, `/${letter.uuid}?issued=1`));
		} catch (error) {
			reportError(error);
			issueButton.disabled = false;
		}
	});

	const lastLetter = candidates.last_letter;
	const currentRate = candidates.rates.filter((rate) => rate.from <= today).at(-1);
	const ratesOutdated = today > candidates.rates_known_until;

	const customerCard = el(
		"div",
		{ class: "card dunning-customer" },
		el(
			"div",
			{ class: "dunning-customer-main" },
			el("span", { class: "dunning-avatar" }, icon(candidates.customer.business ? "box" : "user", 20)),
			el(
				"div",
				{},
				el(
					"a",
					{ href: `/projects/${uuid}/customers/${candidates.customer.uuid}` },
					el("strong", {}, candidates.customer.name || candidates.customer.email || t("customers.unnamed"))
				),
				el(
					"div",
					{ class: "muted" },
					[candidates.customer.email, t(candidates.customer.business ? "dunning.business" : "dunning.individual")].filter(Boolean).join(" | ")
				)
			)
		),
		lastLetter
			? el(
					"a",
					{ class: "dunning-last", href: dunningPath(uuid, `/${lastLetter.uuid}`) },
					el("span", { class: "muted" }, t("dunning.last_letter")),
					levelPill(lastLetter.level),
					el("span", { class: "mono" }, lastLetter.number),
					el("span", { class: "muted" }, dateText(project, lastLetter.issue_date))
				)
			: el("span", { class: "muted" }, t("dunning.first_letter"))
	);

	const documentsCard = el(
		"div",
		{ class: "card" },
		el(
			"div",
			{ class: "card-head" },
			el("h3", {}, t("dunning.documents_title")),
			currencies().length > 1 ? el("label", { class: "dunning-inline-field" }, el("span", { class: "muted" }, t("dunning.currency")), currencySelect) : null
		),
		documentsBody
	);

	const optionsCard = el(
		"div",
		{ class: "card stack" },
		el("h3", {}, t("dunning.letter_title")),
		levelGroup,
		el("div", { class: "form-grid" }, field(t("dunning.deadline"), deadline, t("dunning.deadline_hint")), field(t("dunning.language"), language)),
		candidates.interest_available
			? el(
					"div",
					{ class: "dunning-option" },
					el("label", { class: "switch" }, interest, el("span", {}, t("dunning.interest_switch"))),
					el(
						"p",
						{ class: "field-hint" },
						currentRate ? t("dunning.interest_hint", { rate: `${currentRate.rate.toLocaleString()} %` }) : null,
						ratesOutdated
							? el("span", { class: "warn-text" }, ` ${t("dunning.rates_outdated", { date: dateText(project, candidates.rates_known_until) })}`)
							: null
					)
				)
			: null,
		candidates.compensation_available
			? el(
					"div",
					{ class: "dunning-option" },
					el("label", { class: "switch" }, compensation, el("span", {}, t("dunning.compensation_switch"))),
					el("p", { class: "field-hint" }, t(compensationPossible ? "dunning.compensation_hint" : "dunning.compensation_individual"))
				)
			: null,
		field(t("dunning.note"), note, t("dunning.note_hint"))
	);
	compensation.disabled = !compensationPossible;

	const preview = pdfPreviewButton(t("dunning.preview"), () => DunningApi.preview(uuid, payload()));

	const summaryCard = el(
		"aside",
		{ class: "card dunning-summary" },
		el("h3", {}, t("dunning.summary_title")),
		summaryBody,
		deadlineText,
		el("div", { class: "dunning-summary-actions" }, issueButton, preview)
	);

	refresh();

	return el("div", { class: "dunning-editor" }, el("div", { class: "stack" }, customerCard, documentsCard, optionsCard), summaryCard);
}

export async function newDunningView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const params = new URLSearchParams(window.location.search);
	const customer = params.get("customer");
	const back = el("a", { class: "back-link", href: dunningPath(uuid) }, t("dunning.title"));
	if (!customer) {
		queueMicrotask(() => pickCustomerDialog(uuid));
		return projectLayout(
			project,
			el("div", { class: "stack dunning" }, back, pageHead(t("dunning.new"), t("dunning.new_intro")), emptyState(t("dunning.pick_customer_hint")))
		);
	}
	const candidates = await DunningApi.candidates(uuid, customer);
	return projectLayout(
		project,
		el("div", { class: "stack dunning" }, back, pageHead(t("dunning.new"), t("dunning.new_intro")), letterEditor(uuid, project, candidates, params))
	);
}

function emailLetterDialog(uuid: string, letter: DunningLetterDetail, onSent: () => void) {
	const to = input("email", { value: letter.buyer.email ?? "", required: true, placeholder: "customer@example.com" });
	const message = el("textarea", { rows: "4", maxlength: "2000", placeholder: t("invoices.email_message_placeholder") }) as HTMLTextAreaElement;
	const submit = el("button", { class: "button primary", type: "submit" }, icon("mail", 16), t("dunning.email_send"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					const sent = await DunningApi.email(uuid, letter.uuid, { to: to.value.trim(), message: message.value.trim() || null });
					dialog.close();
					toast(sent.status === "sent" ? t("invoices.email_sent", { to: sent.recipient }) : t("invoices.email_sending", { to: sent.recipient }), "success");
					onSent();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, t("dunning.email_hint", { amount: formatMoney(letter.total_amount, letter.currency) })),
		field(t("invoices.email_to"), to),
		field(t("invoices.email_message"), message),
		el("div", { class: "dialog-actions" }, submit)
	);
	const dialog = modal(t("dunning.email_title", { number: letter.number }), form);
	to.focus();
}

function paymentState(letter: DunningLetterDetail): { label: string; tone: string } | null {
	const tracked = letter.lines.filter((line) => line.open_now !== null);
	if (tracked.length === 0) return null;
	const openNow = tracked.reduce((sum, line) => sum + (line.open_now ?? 0), 0);
	const openThen = tracked.reduce((sum, line) => sum + line.open, 0);
	if (openNow === 0 && tracked.length === letter.lines.length) return { label: t("dunning.state_paid"), tone: "paid" };
	if (openNow < openThen) return { label: t("dunning.state_partly"), tone: "partially_paid" };
	if (letter.deadline_passed) return { label: t("dunning.state_deadline_passed"), tone: "overdue" };
	return { label: t("dunning.state_waiting"), tone: "open" };
}

function emailsCard(project: Project, emails: EmailMessage[]): HTMLElement | null {
	if (emails.length === 0) return null;
	return el(
		"div",
		{ class: "card" },
		el("h3", {}, t("invoices.emails")),
		table(
			[t("invoices.email_column_sent"), t("invoices.email_column_what"), t("invoices.email_to"), t("payments.status"), t("invoices.email_column_by")],
			emails.map((email) =>
				el(
					"tr",
					{},
					el("td", {}, formatDateTime(email.sent_at ?? email.created, project.date_format as DateFormat, undefined, project.timezone)),
					el("td", {}, emailKindLabel(email.kind), email.attachment ? el("div", { class: "muted" }, t("invoices.email_with_pdf")) : null),
					el("td", {}, email.recipient),
					el(
						"td",
						{},
						el(
							"span",
							{ class: `pill pill-${email.status === "sent" ? "paid" : email.status === "failed" ? "overdue" : "pending"}`, title: email.last_error ?? "" },
							statusLabel(email.status)
						),
						email.status !== "sent" && email.last_error ? el("div", { class: "muted" }, email.last_error) : null
					),
					el("td", {}, accountName(email.sent_by_name, email.sent_by) ?? t("ui.automatic"))
				)
			)
		)
	);
}

export async function dunningLetterView(uuid: string, letterId: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const container = el("div", { class: "stack dunning" });
	const justIssued = new URLSearchParams(window.location.search).get("issued") === "1";
	let offered = false;

	const render = async () => {
		const letter = await DunningApi.letter(uuid, letterId);
		const state = paymentState(letter);
		const download = async () => {
			try {
				const file = await DunningApi.pdf(uuid, letter.uuid);
				saveFile(file.blob, file.name);
			} catch (error) {
				reportError(error);
			}
		};
		const sends = can(project, Permission.INVOICE_SEND);
		const emailButton = sends
			? el(
					"button",
					{ class: "button primary", type: "button", onClick: () => emailLetterDialog(uuid, letter, () => void render()) },
					icon("mail", 16),
					t("dunning.email_open")
				)
			: null;
		const documentLinks: MenuLink[] = [
			{ label: t("dunning.open_pdf"), onSelect: () => void openPdf(uuid, letter.uuid) },
			{ label: t("invoices.download_pdf"), onSelect: () => void download() },
		];
		const workflowLinks: MenuLink[] = [];
		if (letter.customer && can(project, Permission.INVOICE_CREATE)) {
			const next = Math.min(letter.level + 1, 3);
			workflowLinks.push({
				label: t(next === 2 ? "dunning.send_second" : "dunning.send_final"),
				href: dunningPath(uuid, `/new?customer=${letter.customer}&currency=${letter.currency}&level=${next}`),
			});
		}
		const dangerLinks: MenuLink[] = can(project, Permission.INVOICE_DELETE)
			? [
					{
						label: t("dunning.delete"),
						danger: true,
						onSelect: async () => {
							const confirmed = await confirmDialog({
								title: t("dunning.delete"),
								body: t("dunning.delete_body", { number: letter.number }),
								confirmLabel: t("ui.delete"),
								destructive: true,
							});
							if (!confirmed) return;
							try {
								await DunningApi.remove(uuid, letter.uuid);
								toast(t("dunning.deleted"), "success");
								navigate(dunningPath(uuid));
							} catch (error) {
								reportError(error);
							}
						},
					},
				]
			: [];
		const actions = [
			emailButton,
			actionMenu(t("invoices.menu_documents"), [documentLinks]),
			actionMenu(t("invoices.menu_more"), [workflowLinks, dangerLinks]),
		].filter((action): action is HTMLElement => action !== null);

		const lineRows = letter.lines.map((line) =>
			el(
				"tr",
				{},
				el(
					"td",
					{},
					line.invoice
						? el("a", { class: "mono", href: `/projects/${uuid}/invoices/${line.invoice}` }, line.reference)
						: el("span", { class: "mono" }, line.reference),
					line.invoice === null ? el("div", { class: "muted" }, t(line.recorded_invoice ? "dunning.kind_recorded" : "dunning.kind_manual")) : null
				),
				el("td", { class: "dunning-date" }, dateText(project, line.due_on)),
				el("td", { class: "numeric" }, String(line.days)),
				el("td", { class: "mono numeric" }, formatMoney(line.open, letter.currency)),
				letter.interest_included ? el("td", { class: "mono numeric" }, formatMoney(line.interest, letter.currency)) : null,
				el(
					"td",
					{ class: "numeric" },
					line.open_now === null
						? el("span", { class: "muted" }, t("dunning.not_tracked"))
						: line.open_now === 0
							? el("span", { class: "pill pill-paid" }, t("dunning.line_paid"))
							: el("span", { class: "mono" }, formatMoney(line.open_now, letter.currency))
				)
			)
		);

		const buyer = letter.buyer;
		const address = [buyer.address_line1, buyer.address_line2, [buyer.postal_code, buyer.city].filter(Boolean).join(" "), buyer.vat_number].filter(Boolean);

		replaceContent(
			container,
			el("a", { class: "back-link", href: dunningPath(uuid) }, t("dunning.title")),
			el(
				"div",
				{ class: "page-head" },
				el(
					"div",
					{},
					el("h2", {}, `${t(LEVEL_TITLES[letter.level])} `, el("span", { class: "mono" }, letter.number)),
					el(
						"p",
						{ class: "muted" },
						t("dunning.head_dates", { issued: dateText(project, letter.issue_date), deadline: dateText(project, letter.deadline_date) })
					)
				),
				el("div", { class: "line-actions" }, state ? el("span", { class: `pill pill-${state.tone}` }, state.label) : null)
			),
			actions.length > 0 ? el("div", { class: "toolbar invoice-actions" }, ...actions) : null,
			el(
				"div",
				{ class: "dunning-detail-grid" },
				el(
					"div",
					{ class: "card" },
					el("h3", {}, t("dunning.sent_to")),
					el(
						"p",
						{},
						letter.customer
							? el("a", { href: `/projects/${uuid}/customers/${letter.customer}` }, el("strong", {}, buyer.name || "-"))
							: el("strong", {}, buyer.name || "-")
					),
					...address.map((line) => el("div", { class: "muted" }, line)),
					buyer.email ? el("div", { class: "muted" }, buyer.email) : null
				),
				el(
					"div",
					{ class: "card dunning-amount-card" },
					el("span", { class: "stat-label" }, t("dunning.summary_total")),
					el("span", { class: "stat-value mono" }, formatMoney(letter.total_amount, letter.currency)),
					el(
						"div",
						{ class: "muted" },
						[
							t("dunning.breakdown_principal", { amount: formatMoney(letter.principal, letter.currency) }),
							letter.interest_included ? t("dunning.breakdown_interest", { amount: formatMoney(letter.interest, letter.currency) }) : null,
							letter.compensation_included ? t("dunning.breakdown_compensation", { amount: formatMoney(letter.compensation, letter.currency) }) : null,
						]
							.filter(Boolean)
							.join(" | ")
					)
				)
			),
			el(
				"div",
				{ class: "card" },
				el("h3", {}, t("dunning.letter_documents")),
				table(
					[
						t("dunning.column_document"),
						t("dunning.column_due"),
						{ label: t("dunning.column_days"), class: "numeric" },
						{ label: t("dunning.column_open_then"), class: "numeric" },
						...(letter.interest_included ? [{ label: t("dunning.column_interest"), class: "numeric" }] : []),
						{ label: t("dunning.column_open_now"), class: "numeric" },
					],
					lineRows
				),
				letter.note ? el("p", { class: "muted" }, `${t("dunning.note")}: ${letter.note}`) : null,
				el("p", { class: "muted small-print" }, t("dunning.created_by", { name: accountName(letter.created_by_name, letter.created_by) ?? "-" }))
			),
			emailsCard(project, letter.email_history)
		);

		if (justIssued && !offered && sends && letter.emails === 0 && letter.buyer.email) {
			offered = true;
			emailLetterDialog(uuid, letter, () => void render());
		}
	};

	await render();
	return projectLayout(project, container);
}

async function openPdf(uuid: string, letter: string) {
	const opened = window.open("", "_blank");
	try {
		const file = await DunningApi.pdf(uuid, letter);
		const url = URL.createObjectURL(file.blob);
		if (opened) opened.location.href = url;
		else window.location.href = url;
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	} catch (error) {
		opened?.close();
		reportError(error);
	}
}
