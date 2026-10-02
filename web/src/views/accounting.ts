import {
	Api,
	type AccountingClient,
	type JournalEntryView,
	type JournalQuery,
	type LedgerAccount,
	type LedgerIssue,
	type Project,
	type TrialBalanceRow,
} from "../api";
import { el, emptyState, field, input, saveFile, select, table, type TableHeader } from "../dom";
import { dayStartFromDateInput, formatDate, formatMoney, fromDateInput, toDateInput, toMajorUnits, toMinorUnits } from "../money";
import { can, Permission } from "../access";
import { remoteTable } from "../pagination";
import { combobox, staticCombobox, type Combobox, type ComboOption } from "../combobox";
import { t, type UiKey } from "../i18n";
import { modal, reportError, toast } from "../ui";
import { invalidateProject, loadProject, projectLayout } from "./project";
import { redeemFlow } from "./license";
import { currentPath, navigate } from "../router";
import { expenseCategoryLabel } from "../expense-categories";
import type { DateFormat } from "../../../server/formats";

export type Tab = "journal" | "trial" | "open" | "accounts" | "recorded" | "bank" | "years" | "statements" | "assets" | "kpo" | "ajpes";

const TABS: { id: Tab; label: UiKey; suffix: string; hidden?: NonNullable<Project["bookkeeping"]>[] }[] = [
	{ id: "journal", label: "accounting.tab_journal", suffix: "" },
	{ id: "recorded", label: "accounting.tab_recorded", suffix: "/recorded-invoices" },
	{ id: "bank", label: "accounting.tab_bank", suffix: "/bank" },
	{ id: "open", label: "accounting.tab_open_items", suffix: "/open-items", hidden: ["sole_flat_rate"] },
	{ id: "assets", label: "accounting.tab_assets", suffix: "/assets" },
	{ id: "trial", label: "accounting.tab_trial_balance", suffix: "/trial-balance", hidden: ["sole_flat_rate"] },
	{ id: "statements", label: "accounting.tab_statements", suffix: "/statements", hidden: ["sole_flat_rate"] },
	{ id: "ajpes", label: "accounting.tab_ajpes", suffix: "/ajpes", hidden: ["sole_flat_rate"] },
	{ id: "kpo", label: "accounting.tab_kpo", suffix: "/kpo", hidden: ["company", "sole_double", "sole_flat_rate"] },
	{ id: "years", label: "accounting.tab_years", suffix: "/years", hidden: ["sole_flat_rate"] },
	{ id: "accounts", label: "accounting.tab_accounts", suffix: "/accounts" },
];

interface Period {
	element: HTMLElement;
	range(): { from: number; to: number };
}

export function baseCurrency(project: Project): string {
	return project.tax_currency ?? project.currency;
}

type Child = Parameters<typeof el>[2];

interface PageHead {
	title: string | HTMLElement;
	actions?: (HTMLElement | null)[];
	intro?: string;
	back?: HTMLElement;
}

export function ledgerPage(project: Project, active: Tab, head: PageHead, ...content: Child[]): HTMLElement {
	const actions = (head.actions ?? []).filter((action): action is HTMLElement => action !== null);
	return projectLayout(
		project,
		el(
			"div",
			{ class: "stack ledger-page" },
			tabs(project, active),
			el(
				"div",
				{ class: "ledger-head" },
				head.back ?? null,
				el(
					"div",
					{ class: "ledger-head-row" },
					typeof head.title === "string" ? el("h2", {}, head.title) : head.title,
					actions.length ? el("div", { class: "line-actions" }, ...actions) : null
				),
				head.intro ? el("p", { class: "muted" }, head.intro) : null
			),
			...content
		)
	);
}

export function section(title: string | HTMLElement, ...content: Child[]): HTMLElement {
	return el("section", { class: "ledger-section" }, typeof title === "string" ? el("h3", {}, title) : title, ...content);
}

export function sectionHead(title: string, ...controls: Child[]): HTMLElement {
	return el("div", { class: "ledger-section-head" }, el("h3", {}, title), ...controls);
}

export function numeric(label: string): TableHeader {
	return { label, class: "num" };
}

export function moneyCell(
	value: number | null | undefined,
	currency: string,
	options: { strong?: boolean; muted?: boolean; warn?: boolean; zero?: boolean } = {}
): HTMLElement {
	const text = value === null || value === undefined || (value === 0 && !options.zero) ? "" : formatMoney(value, currency);
	const classes = ["num", options.muted || value === 0 ? "muted" : "", options.warn ? "warn" : ""].filter(Boolean).join(" ");
	return el("td", { class: classes }, options.strong && text ? el("strong", {}, text) : text);
}

export function currentYear(project: Pick<Project, "timezone">): number {
	return Number(toDateInput(Date.now(), project.timezone).slice(0, 4));
}

export function yearSelect(selected: number): HTMLSelectElement {
	const current = Math.max(selected, new Date().getFullYear());
	return select(
		Array.from({ length: 8 }, (_, index) => current - index).map((value) => ({ value: String(value), label: String(value) })),
		String(selected)
	);
}

export function summaryCards(items: [string, string][]): HTMLElement {
	return el(
		"div",
		{ class: "stats-totals" },
		...items.map(([label, value]) =>
			el("div", { class: "card stat" }, el("span", { class: "stat-value num" }, value), el("span", { class: "stat-label" }, label))
		)
	);
}

export function tabs(project: Project, active: Tab): HTMLElement {
	const base = `/projects/${project.uuid}/accounting`;
	return el(
		"div",
		{ class: "store-bar" },
		el(
			"nav",
			{ class: "subtabs" },
			...TABS.filter((tab) => tab.id === active || !tab.hidden?.includes(project.bookkeeping ?? "company")).map((tab) =>
				el("a", { class: `subtab${tab.id === active ? " active" : ""}`, href: `${base}${tab.suffix}` }, t(tab.label))
			)
		),
		el("a", { class: "button ghost small", href: "/accounting" }, t("accounting.all_clients"))
	);
}

const PRESETS = ["this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year", "custom"] as const;
type Preset = (typeof PRESETS)[number];

function isoDay(year: number, month: number, day: number): string {
	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function presetRange(preset: Exclude<Preset, "custom">, today: string): [string, string] {
	const year = Number(today.slice(0, 4));
	const month = Number(today.slice(5, 7));
	const monthRange = (y: number, first: number, last: number): [string, string] => [
		isoDay(y, first, 1),
		isoDay(y, last, new Date(Date.UTC(y, last, 0)).getUTCDate()),
	];
	const quarter = Math.floor((month - 1) / 3);
	if (preset === "this_month") return monthRange(year, month, month);
	if (preset === "last_month") return month === 1 ? monthRange(year - 1, 12, 12) : monthRange(year, month - 1, month - 1);
	if (preset === "this_quarter") return monthRange(year, quarter * 3 + 1, quarter * 3 + 3);
	if (preset === "last_quarter") return quarter === 0 ? monthRange(year - 1, 10, 12) : monthRange(year, quarter * 3 - 2, quarter * 3);
	if (preset === "last_year") return monthRange(year - 1, 1, 12);
	return monthRange(year, 1, 12);
}

export function period(project: Project, onChange: () => void, singleYear = false): Period {
	const today = toDateInput(Date.now(), project.timezone);
	const [start, end] = presetRange("this_year", today);
	const from = input("date", { value: start, required: true });
	const to = input("date", { value: end, required: true });
	const preset = select(
		PRESETS.map((value) => ({ value, label: t(`accounting.period_${value}` as UiKey) })),
		"this_year"
	);
	const keepWithinYear = (changed: HTMLInputElement) => {
		if (!singleYear || from.value.slice(0, 4) === to.value.slice(0, 4)) return;
		if (changed === from) to.value = `${from.value.slice(0, 4)}-12-31`;
		else from.value = `${to.value.slice(0, 4)}-01-01`;
	};
	for (const control of [from, to])
		control.addEventListener("change", () => {
			if (!from.value || !to.value) return;
			preset.value = "custom";
			keepWithinYear(control);
			onChange();
		});
	preset.addEventListener("change", () => {
		if (preset.value === "custom") return;
		[from.value, to.value] = presetRange(preset.value as Exclude<Preset, "custom">, today);
		onChange();
	});
	return {
		element: el("div", { class: "ledger-controls" }, field(t("accounting.period"), preset), field(t("accounting.from"), from), field(t("accounting.to"), to)),
		range: () => ({ from: dayStartFromDateInput(from.value, project.timezone), to: fromDateInput(to.value, project.timezone) }),
	};
}

function sourceLink(uuid: string, entry: JournalEntryView): string | null {
	const base = `/projects/${uuid}`;
	switch (entry.source_type) {
		case "invoice":
		case "credit_note":
		case "payment":
		case "refund":
			return entry.invoice ? `${base}/invoices/${entry.invoice}` : null;
		case "expense":
		case "expense_payment":
			return `${base}/expenses?open=${entry.source_id}`;
		case "recorded_invoice":
		case "recorded_payment":
			return `${base}/accounting/recorded-invoices?open=${entry.source_id}`;
		case "bank_transaction":
			return `${base}/accounting/bank`;
		case "depreciation":
		case "asset_disposal":
			return `${base}/accounting/assets`;
		case "payroll":
			return `${base}/payroll/${entry.source_id}`;
		case "deductible_share":
		case "year_result":
		case "year_closing":
		case "year_opening":
			return `${base}/accounting/years`;
		default:
			return null;
	}
}

const SOURCES: JournalEntryView["source_type"][] = [
	"invoice",
	"credit_note",
	"payment",
	"refund",
	"expense",
	"expense_payment",
	"recorded_invoice",
	"recorded_payment",
	"bank_transaction",
	"depreciation",
	"asset_disposal",
	"payroll",
	"deductible_share",
	"year_result",
	"year_closing",
	"year_opening",
	"manual",
];

interface JournalFilterControls {
	element: HTMLElement;
	values(): Omit<JournalQuery, "from" | "to">;
}

function journalFilterControls(accounts: LedgerAccount[], currency: string, onChange: () => void): JournalFilterControls {
	const account = staticCombobox(
		accounts.map((entry) => ({ value: entry.uuid, label: accountLabel(entry), keywords: entry.code })),
		"",
		{ placeholder: t("accounting.all_accounts"), class: "account-select" }
	);
	const source = select(
		[{ value: "", label: t("accounting.all_sources") }, ...SOURCES.map((value) => ({ value, label: t(`accounting.source_${value}` as UiKey) }))],
		""
	);
	const text = input("search", { placeholder: t("accounting.filter_text_placeholder"), maxlength: "200" });
	const amount = input("number", { min: "0", step: "0.01" });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const later = () => {
		clearTimeout(timer);
		timer = setTimeout(onChange, 300);
	};
	account.onChange(onChange);
	source.addEventListener("change", onChange);
	text.addEventListener("input", later);
	amount.addEventListener("input", later);
	return {
		element: el(
			"div",
			{ class: "ledger-controls" },
			field(t("accounting.filter_account"), account.element),
			field(t("accounting.filter_source"), source),
			field(t("accounting.filter_text"), text),
			field(t("accounting.filter_amount"), amount)
		),
		values: () => ({
			account: account.value || undefined,
			source: source.value || undefined,
			text: text.value.trim() || undefined,
			amount: amount.value ? toMinorUnits(Number(amount.value), currency) : undefined,
		}),
	};
}

function redeemForm(project: Project): HTMLElement | null {
	if (!can(project, Permission.LEDGER_EDIT)) return null;
	const code = input("text", { placeholder: "RPAY-", autocomplete: "off", required: true });
	const check = el("button", { class: "button primary", type: "submit" }, t("license.check"));
	const { panel, onSubmit } = redeemFlow(
		code,
		check,
		(value) => Api.previewAccountingLicense(project.uuid, value),
		async (value, startsAt) => {
			const redeemed = await Api.redeemAccountingLicense(project.uuid, value, startsAt);
			invalidateProject(project.uuid);
			toast(redeemed.starts_at === null ? t("accounting.redeemed") : t("accounting.redeemed_later", { date: formatDate(redeemed.starts_at) }));
			navigate(currentPath(), true);
		}
	);
	return el("form", { class: "stack", onSubmit }, el("div", { class: "toolbar" }, code, check), panel);
}

export function accountLabelOf(account: Pick<LedgerAccount, "code" | "name">): string {
	return accountLabel(account);
}

export function licenseNotice(project: Project): HTMLElement | null {
	if (project.accounting) return null;
	return el("div", { class: "ledger-notice" }, el("p", { class: "warn" }, t("accounting.read_only")), redeemForm(project));
}

export function notices(project: Project, issues: LedgerIssue[]): HTMLElement {
	return showNotices(el("div", { class: "stack" }), project, issues);
}

export function showNotices(target: HTMLElement, project: Project, issues: LedgerIssue[]): HTMLElement {
	const groups = (["missing_exchange_rate", "closed_year", "payroll_overlap"] as const).map((code) => {
		const matching = issues.filter((issue) => issue.code === code);
		if (matching.length === 0) return null;
		return el(
			"div",
			{ class: "ledger-notice" },
			el("p", { class: "warn" }, t(`accounting.issues_${code}`, { count: matching.length })),
			el("ul", {}, ...matching.slice(0, 20).map((issue) => el("li", {}, `${t(`accounting.source_${issue.source_type}` as UiKey)} ${issue.reference ?? ""}`)))
		);
	});
	const items = [licenseNotice(project), ...groups];
	target.replaceChildren(...items.filter((item): item is HTMLElement => item !== null));
	return target;
}

export function editable(project: Project): boolean {
	return project.accounting && can(project, Permission.LEDGER_EDIT);
}

function accountLabel(account: Pick<LedgerAccount, "code" | "name">): string {
	return `${account.code} ${account.name}`;
}

export function accountPicker(accounts: LedgerAccount[], selected = "", include: (account: LedgerAccount) => boolean = () => true): Combobox {
	const options: ComboOption[] = accounts
		.filter((account) => account.active && include(account))
		.map((account) => ({
			value: account.uuid,
			label: accountLabel(account),
			keywords: account.code,
			hint: t(`accounting.kind_${account.account_kind}` as UiKey),
		}));
	return staticCombobox(options, selected, { required: true, class: "account-select", placeholder: t("accounting.account_search") });
}

function plainEnter(event: KeyboardEvent): boolean {
	return event.key === "Enter" && !event.defaultPrevented && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

async function entryDialog(project: Project, accounts: LedgerAccount[], onPosted: () => void) {
	const currency = baseCurrency(project);
	const partners: ComboOption[] = (await Api.accountingPartners(project.uuid).catch(() => ({ partners: [] }))).partners.map((partner) => ({
		value: partner.name,
		label: partner.name,
		hint: partner.tax_number ?? undefined,
		keywords: partner.tax_number ?? undefined,
	}));
	const date = input("date", { value: toDateInput(Date.now(), project.timezone), required: true });
	const description = input("text", { maxlength: "500", required: true });
	const rows = el("div", { class: "stack" });
	const totals = el("p", { class: "muted mono" });
	interface Line {
		account: Combobox;
		debit: HTMLInputElement;
		credit: HTMLInputElement;
		partner: Combobox;
		row: HTMLElement;
	}
	const lines: Line[] = [];
	const submit = el("button", { class: "button primary", type: "submit" }, t("accounting.post"));

	const sum = (key: "debit" | "credit") => lines.reduce((total, line) => total + toMinorUnits(Number(line[key].value || 0), currency), 0);
	const balancedEntry = () => sum("debit") === sum("credit") && sum("debit") > 0;
	const refresh = () => {
		const debit = sum("debit");
		const credit = sum("credit");
		totals.textContent = t("accounting.entry_totals", { debit: formatMoney(debit, currency), credit: formatMoney(credit, currency) });
		totals.className = balancedEntry() ? "muted mono" : "warn mono";
	};
	const fieldsOf = (line: Line) => [line.account.input, line.debit, line.credit, line.partner.input];

	const advance = (line: Line, from: HTMLInputElement) => {
		const fields = fieldsOf(line);
		const next = fields[fields.indexOf(from) + 1];
		if (from === line.debit && line.debit.value) {
			line.partner.input.focus();
			return;
		}
		if (next) {
			next.focus();
			return;
		}
		const following = lines[lines.indexOf(line) + 1];
		if (following) following.account.input.focus();
		else if (balancedEntry()) submit.focus();
		else addLine().account.input.focus();
	};

	function addLine(): Line {
		const difference = sum("debit") - sum("credit");
		const account = accountPicker(accounts);
		const debit = input("number", { min: "0", step: "0.01", placeholder: t("accounting.debit") });
		const credit = input("number", { min: "0", step: "0.01", placeholder: t("accounting.credit") });
		const partner = combobox({ options: partners, freeText: true, placeholder: t("accounting.partner") });
		partner.input.maxLength = 200;
		const remove = el("button", { class: "button ghost small", type: "button", title: t("ui.delete") }, t("ui.delete"));
		const row = el("div", { class: "journal-line" }, account.element, debit, credit, partner.element, remove);
		const line: Line = { account, debit, credit, partner, row };
		remove.addEventListener("click", () => {
			if (lines.length <= 2) return;
			lines.splice(lines.indexOf(line), 1);
			row.remove();
			refresh();
		});
		debit.addEventListener("input", () => {
			if (debit.value) credit.value = "";
			refresh();
		});
		credit.addEventListener("input", () => {
			if (credit.value) debit.value = "";
			refresh();
		});
		account.onChange((option) => {
			if (option) (credit.value ? credit : debit).focus();
		});
		for (const control of fieldsOf(line))
			control.addEventListener("keydown", (event) => {
				if (!plainEnter(event)) return;
				event.preventDefault();
				advance(line, control);
			});
		lines.push(line);
		rows.append(row);
		if (difference !== 0) (difference > 0 ? credit : debit).value = String(toMajorUnits(Math.abs(difference), currency));
		refresh();
		return line;
	}
	addLine();
	addLine();
	description.addEventListener("keydown", (event) => {
		if (!plainEnter(event)) return;
		event.preventDefault();
		lines[0].account.input.focus();
	});

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				const missing = lines.find((line) => !line.account.value);
				if (missing) {
					missing.account.input.focus();
					return;
				}
				submit.disabled = true;
				try {
					await Api.postJournalEntry(project.uuid, {
						date: dayStartFromDateInput(date.value, project.timezone),
						description: description.value.trim(),
						lines: lines.map((line) => ({
							account: line.account.value,
							debit: toMinorUnits(Number(line.debit.value || 0), currency),
							credit: toMinorUnits(Number(line.credit.value || 0), currency),
							partner: line.partner.value.trim() || null,
						})),
					});
					dialog.close();
					toast(t("accounting.posted"));
					onPosted();
				} catch (error) {
					reportError(error);
				} finally {
					submit.disabled = false;
				}
			},
		},
		el("div", { class: "grid" }, field(t("accounting.date"), date), field(t("accounting.description"), description)),
		rows,
		el(
			"div",
			{ class: "line-actions" },
			el("button", { class: "button ghost small", type: "button", onClick: () => addLine().account.input.focus() }, t("accounting.add_line")),
			totals
		),
		el("p", { class: "muted" }, t("accounting.entry_hint")),
		el("p", { class: "muted" }, t("accounting.entry_keys")),
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(t("accounting.new_entry"), form, undefined, "dialog-large");
	description.focus();
}

function exportButton(project: Project, download: () => Promise<{ blob: Blob; name: string }>): HTMLElement | null {
	if (!can(project, Permission.REPORT_EXPORT)) return null;
	return el(
		"button",
		{
			class: "button ghost",
			type: "button",
			onClick: async () => {
				try {
					const file = await download();
					saveFile(file.blob, file.name);
				} catch (error) {
					reportError(error);
				}
			},
		},
		t("accounting.export_csv")
	);
}

export async function accountingJournalView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const currency = baseCurrency(project);
	const dateFormat = project.date_format as DateFormat;
	const accounts = (await Api.ledgerAccounts(uuid)).accounts;
	const notice = el("div", { class: "stack" });
	const body = el("div", {});
	const range = period(project, () => void render());
	const filters = journalFilterControls(accounts, currency, () => void render());

	const reverse = async (entry: string) => {
		try {
			await Api.reverseJournalEntry(uuid, entry);
			toast(t("accounting.reversed"));
			await render();
		} catch (error) {
			reportError(error);
		}
	};

	const render = async () => {
		body.replaceChildren(
			remoteTable(
				[
					t("accounting.number"),
					t("accounting.date"),
					t("accounting.description"),
					t("accounting.account"),
					numeric(t("accounting.debit")),
					numeric(t("accounting.credit")),
				],
				async (offset, limit) => {
					const page = await Api.journal(uuid, { ...range.range(), ...filters.values(), offset, limit });
					showNotices(notice, project, page.issues);
					const rows = page.entries.flatMap((entry) => {
						const reversible = editable(project) && entry.source_type === "manual" && entry.reverses === null && entry.reversed_by === null;
						return entry.lines.map((line, index) =>
							el(
								"tr",
								{ class: index < entry.lines.length - 1 ? "entry-continues" : "" },
								el("td", { class: "code" }, index === 0 ? `${entry.year}/${entry.number}` : ""),
								el("td", { class: "date" }, index === 0 ? formatDate(entry.entry_date, dateFormat, project.timezone) : ""),
								el(
									"td",
									{},
									index === 0 ? entry.description : "",
									index === 0 && (reversible || sourceLink(uuid, entry))
										? el(
												"div",
												{ class: "line-actions" },
												sourceLink(uuid, entry) ? el("a", { class: "button ghost small", href: sourceLink(uuid, entry)! }, t("accounting.open_source")) : null,
												reversible
													? el("button", { class: "button ghost small", type: "button", onClick: () => reverse(entry.uuid) }, t("accounting.reverse"))
													: null
											)
										: null
								),
								el("td", {}, el("a", { href: `/projects/${uuid}/accounting/ledger/${line.account}` }, `${line.code} ${line.name}`)),
								moneyCell(line.debit, currency),
								moneyCell(line.credit, currency)
							)
						);
					});
					return { rows, total: page.total };
				},
				t("accounting.journal_empty")
			)
		);
	};
	await render();

	return ledgerPage(
		project,
		"journal",
		{
			title: t("accounting.journal"),
			intro: t("accounting.journal_hint"),
			actions: [
				exportButton(project, () => Api.exportJournal(uuid, { ...range.range(), ...filters.values() })),
				editable(project)
					? el(
							"button",
							{
								class: "button primary",
								type: "button",
								dataset: { shortcutAction: "new-accounting-entry" },
								onClick: () => void entryDialog(project, accounts, () => void render()).catch(reportError),
							},
							t("accounting.new_entry")
						)
					: null,
			],
		},
		notice,
		range.element,
		filters.element,
		body
	);
}

const CLASSES = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

type Totals = Pick<TrialBalanceRow, "opening_debit" | "opening_credit" | "debit" | "credit" | "closing_debit" | "closing_credit">;

function totalsOf(rows: Totals[]): Totals {
	const sum = (key: keyof Totals) => rows.reduce((total, row) => total + row[key], 0);
	return {
		opening_debit: sum("opening_debit"),
		opening_credit: sum("opening_credit"),
		debit: sum("debit"),
		credit: sum("credit"),
		closing_debit: sum("closing_debit"),
		closing_credit: sum("closing_credit"),
	};
}

function balanceRow(label: HTMLElement | string, totals: Totals, currency: string, className = ""): HTMLElement {
	const strong = className !== "";
	return el(
		"tr",
		{ class: className },
		el("td", {}, typeof label === "string" && strong ? el("strong", {}, label) : label),
		...(["opening_debit", "opening_credit", "debit", "credit", "closing_debit", "closing_credit"] as const).map((key) =>
			moneyCell(totals[key], currency, { strong })
		)
	);
}

export async function trialBalanceView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const currency = baseCurrency(project);
	const notice = el("div", { class: "stack" });
	const body = el("div", {});
	const range = period(project, () => void render(), true);
	const level = select(
		["accounts", "groups", "classes"].map((value) => ({ value, label: t(`accounting.level_${value}` as UiKey) })),
		"accounts"
	);
	level.addEventListener("change", () => void render());

	const render = async () => {
		try {
			const result = await Api.trialBalance(uuid, range.range());
			showNotices(notice, project, result.issues);
			const rows: HTMLElement[] = [];
			for (const accountClass of CLASSES) {
				const members = result.accounts.filter((row) => row.code.startsWith(accountClass));
				if (members.length === 0) continue;
				if (level.value === "accounts") {
					for (const row of members)
						rows.push(balanceRow(el("a", { href: `/projects/${uuid}/accounting/ledger/${row.account}` }, accountLabel(row)), row, currency));
				}
				if (level.value === "groups") {
					for (const group of [...new Set(members.map((row) => row.code.slice(0, 2)))])
						rows.push(balanceRow(t("accounting.group_label", { code: group }), totalsOf(members.filter((row) => row.code.startsWith(group))), currency));
				}
				const label = t("accounting.class_total", { code: accountClass, name: t(`accounting.class_${accountClass}` as UiKey) });
				rows.push(balanceRow(label, totalsOf(members), currency, level.value === "classes" ? "class-row plain" : "class-row"));
			}
			rows.push(balanceRow(t("accounting.total"), totalsOf(result.accounts), currency, "total-row"));
			body.replaceChildren(
				result.accounts.length === 0
					? emptyState(t("accounting.journal_empty"))
					: table(
							[
								t("accounting.account"),
								numeric(t("accounting.opening_debit")),
								numeric(t("accounting.opening_credit")),
								numeric(t("accounting.debit")),
								numeric(t("accounting.credit")),
								numeric(t("accounting.closing_debit")),
								numeric(t("accounting.closing_credit")),
							],
							rows
						)
			);
		} catch (error) {
			reportError(error);
		}
	};
	await render();

	return ledgerPage(
		project,
		"trial",
		{
			title: t("accounting.trial_balance"),
			intro: t("accounting.trial_balance_hint"),
			actions: [exportButton(project, () => Api.exportTrialBalance(uuid, range.range()))],
		},
		notice,
		range.element,
		el("div", { class: "ledger-controls" }, field(t("accounting.level"), level)),
		body
	);
}

export async function accountLedgerView(uuid: string, account: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const currency = baseCurrency(project);
	const dateFormat = project.date_format as DateFormat;
	const title = el("h2", {});
	const body = el("div", { class: "stack" });
	const range = period(project, () => void render(), true);
	const partner = input("search", { placeholder: t("accounting.ledger_partner_placeholder"), maxlength: "200" });
	let timer: ReturnType<typeof setTimeout> | undefined;
	partner.addEventListener("input", () => {
		clearTimeout(timer);
		timer = setTimeout(() => void render(), 300);
	});
	const query = () => ({ ...range.range(), partner: partner.value.trim() || undefined });

	const render = async () => {
		try {
			const ledger = await Api.accountLedger(uuid, account, query());
			title.textContent = accountLabel(ledger.account);
			body.replaceChildren(
				summaryCards([
					[t("accounting.opening"), formatMoney(ledger.opening, currency)],
					[t("accounting.closing"), formatMoney(ledger.closing, currency)],
				]),
				ledger.lines.length === 0
					? emptyState(t("accounting.ledger_empty"))
					: table(
							[
								t("accounting.number"),
								t("accounting.date"),
								t("accounting.description"),
								t("accounting.partner"),
								numeric(t("accounting.debit")),
								numeric(t("accounting.credit")),
								numeric(t("accounting.balance")),
							],
							ledger.lines.map((line) =>
								el(
									"tr",
									{},
									el("td", { class: "code" }, `${line.year}/${line.number}`),
									el("td", { class: "date" }, formatDate(line.entry_date, dateFormat, project.timezone)),
									el("td", {}, line.description),
									el("td", {}, line.partner ?? ""),
									moneyCell(line.debit, currency),
									moneyCell(line.credit, currency),
									moneyCell(line.balance, currency, { zero: true })
								)
							)
						)
			);
		} catch (error) {
			reportError(error);
		}
	};
	await render();

	return ledgerPage(
		project,
		"trial",
		{
			title,
			back: el("a", { class: "back-link", href: `/projects/${uuid}/accounting/trial-balance` }, t("accounting.back_to_trial_balance")),
			actions: [exportButton(project, () => Api.exportAccountLedger(uuid, account, query()))],
		},
		range.element,
		el("div", { class: "ledger-controls" }, field(t("accounting.ledger_partner"), partner)),
		body
	);
}

function accountDialog(project: Project, existing: LedgerAccount | null, onSaved: () => void) {
	const code = input("text", { maxlength: "8", required: true, value: existing?.code ?? "" });
	code.pattern = "\\d{2,8}";
	code.inputMode = "numeric";
	code.disabled = existing !== null;
	const name = input("text", { maxlength: "200", required: true, value: existing?.name ?? "" });
	const submit = el("button", { class: "button primary", type: "submit" }, t("ui.save"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					if (existing) await Api.updateLedgerAccount(project.uuid, existing.uuid, { name: name.value.trim() });
					else await Api.createLedgerAccount(project.uuid, { code: code.value.trim(), name: name.value.trim() });
					dialog.close();
					onSaved();
				} catch (error) {
					reportError(error);
				} finally {
					submit.disabled = false;
				}
			},
		},
		el("div", { class: "grid" }, field(t("accounting.code"), code, t("accounting.code_hint")), field(t("accounting.name"), name)),
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(t(existing ? "accounting.edit_account" : "accounting.new_account"), form, undefined, "dialog-medium");
}

const BOOKKEEPING: NonNullable<Project["bookkeeping"]>[] = ["company", "sole_double", "sole_simplified", "sole_flat_rate"];

function bookkeepingSection(project: Project): HTMLElement {
	const mode = select(
		BOOKKEEPING.map((value) => ({ value, label: t(`accounting.bookkeeping_${value}` as UiKey) })),
		project.bookkeeping ?? "company"
	);
	mode.disabled = !editable(project);
	mode.addEventListener("change", async () => {
		try {
			await Api.updateBookkeeping(project.uuid, mode.value as NonNullable<Project["bookkeeping"]>);
			invalidateProject(project.uuid);
			toast(t("accounting.bookkeeping_saved"));
			navigate(currentPath(), true);
		} catch (error) {
			mode.value = project.bookkeeping ?? "company";
			reportError(error);
		}
	});
	return el("div", { class: "ledger-controls wide" }, field(t("accounting.bookkeeping"), mode, t("accounting.bookkeeping_hint")));
}

export async function ledgerAccountsView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const body = el("div", { class: "stack" });

	const render = async () => {
		try {
			const [{ accounts }, { categories }] = await Promise.all([Api.ledgerAccounts(uuid), Api.ledgerCategories(uuid)]);
			const expenseAccounts = accounts.filter((account) => account.active && (account.account_kind === "expense" || account.account_kind === "asset"));
			const mapping = (category: string, selected: string) => {
				if (!editable(project)) return el("span", {}, accountLabel(accounts.find((account) => account.uuid === selected) ?? { code: "", name: "" }));
				const picker = select(
					expenseAccounts.map((account) => ({ value: account.uuid, label: accountLabel(account) })),
					selected
				);
				picker.classList.add("account-select");
				picker.addEventListener("change", async () => {
					try {
						await Api.mapLedgerCategory(uuid, category, picker.value);
						toast(t("accounting.category_saved"));
					} catch (error) {
						picker.value = selected;
						reportError(error);
					}
				});
				return picker;
			};
			const rename = (account: LedgerAccount) =>
				el("button", { class: "button ghost small", type: "button", onClick: () => accountDialog(project, account, () => void render()) }, t("ui.edit"));
			const toggle = (account: LedgerAccount) =>
				account.system_key !== null
					? null
					: el(
							"button",
							{
								class: "button ghost small",
								type: "button",
								onClick: async () => {
									try {
										await Api.updateLedgerAccount(uuid, account.uuid, { active: !account.active });
										await render();
									} catch (error) {
										reportError(error);
									}
								},
							},
							t(account.active ? "accounting.deactivate" : "accounting.activate")
						);
			body.replaceChildren(
				section(
					t("accounting.category_mapping"),
					el("p", { class: "muted" }, t("accounting.category_mapping_hint")),
					table(
						[t("accounting.category"), t("accounting.account")],
						categories.map((row) => el("tr", {}, el("td", {}, expenseCategoryLabel(row.category)), el("td", {}, mapping(row.category, row.account))))
					)
				),
				section(
					t("accounting.chart"),
					el("p", { class: "muted" }, t("accounting.chart_hint")),
					table(
						[t("accounting.code"), t("accounting.name"), t("accounting.kind"), ""],
						accounts.map((account) =>
							el(
								"tr",
								{ class: account.active ? "" : "muted" },
								el("td", { class: "code" }, account.code),
								el("td", {}, account.name),
								el("td", {}, t(`accounting.kind_${account.account_kind}` as UiKey)),
								el("td", { class: "actions" }, editable(project) ? toggle(account) : null, editable(project) ? rename(account) : null)
							)
						)
					)
				)
			);
		} catch (error) {
			reportError(error);
		}
	};
	await render();

	return ledgerPage(
		project,
		"accounts",
		{
			title: t("accounting.tab_accounts"),
			actions: [
				editable(project)
					? el(
							"button",
							{ class: "button primary", type: "button", onClick: () => accountDialog(project, null, () => void render()) },
							t("accounting.new_account")
						)
					: null,
			],
		},
		licenseNotice(project),
		bookkeepingSection(project),
		body
	);
}

function clientDialog() {
	const name = input("text", { placeholder: "podjetje-doo", required: true });
	const submit = el("button", { class: "button primary", type: "submit" }, t("accounting.add_client"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					const project = await Api.createProject(name.value.trim());
					dialog.close();
					navigate(`/projects/${project.uuid}/settings`);
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		field(t("projects.name"), name, t("login.username_hint")),
		el("p", { class: "muted" }, t("accounting.add_client_hint")),
		el("div", { class: "dialog-actions" }, submit)
	);
	const dialog = modal(t("accounting.add_client"), form, undefined, "dialog-medium");
	name.focus();
}

function clientRow(client: AccountingClient): HTMLElement {
	const license = client.accounting
		? el(
				"span",
				{ class: "pill pill-active" },
				client.accounting_until ? t("license.until", { date: formatDate(client.accounting_until) }) : t("status.active")
			)
		: el("span", { class: "pill pill-canceled" }, t("accounting.client_unlicensed"));
	const attention = [
		client.issues ? t("accounting.client_issues", { count: client.issues }) : null,
		client.unclosed_years.length ? t("accounting.client_unclosed", { years: client.unclosed_years.join(", ") }) : null,
		client.open_bank_lines ? t("accounting.client_bank_lines", { count: client.open_bank_lines }) : null,
		client.unattached_expenses ? t("accounting.client_unattached", { count: client.unattached_expenses }) : null,
		client.unpaid_expenses ? t("accounting.client_unpaid", { count: client.unpaid_expenses }) : null,
	].filter((note): note is string => note !== null);
	return el(
		"tr",
		{},
		el(
			"td",
			{},
			el("a", { href: `/projects/${client.uuid}/accounting` }, client.display_name ?? client.name),
			client.display_name ? el("div", { class: "muted" }, client.name) : null
		),
		el("td", {}, license),
		el("td", { class: "mono" }, String(client.entries_this_year)),
		el("td", {}, client.last_posted ? formatDate(client.last_posted) : ""),
		el("td", {}, client.ddv_submitted_until ? formatDate(client.ddv_submitted_until) : ""),
		el("td", {}, attention.length ? el("span", { class: "warn" }, attention.join(" | ")) : el("span", { class: "muted" }, t("accounting.client_ok")))
	);
}

export async function accountingClientsView(): Promise<HTMLElement> {
	const { clients } = await Api.accountingClients();
	return el(
		"div",
		{ class: "page" },
		el(
			"div",
			{ class: "page-head" },
			el("div", {}, el("h1", {}, t("accounting.clients")), el("p", { class: "muted" }, t("accounting.clients_intro"))),
			el("button", { class: "button primary", type: "button", onClick: clientDialog }, t("accounting.add_client"))
		),
		clients.length === 0
			? emptyState(t("accounting.clients_empty"))
			: table(
					[
						t("accounting.client"),
						t("accounting.client_license"),
						t("accounting.client_entries"),
						t("accounting.client_last_posted"),
						t("accounting.client_ddv"),
						t("accounting.client_attention"),
					],
					clients.map(clientRow)
				)
	);
}
