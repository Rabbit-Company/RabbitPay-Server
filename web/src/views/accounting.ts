import { Api, type AccountingClient, type LedgerAccount, type LedgerIssue, type Project } from "../api";
import { el, emptyState, field, input, saveFile, select, table, type TableHeader } from "../dom";
import { dayStartFromDateInput, formatDate, formatMoney, fromDateInput, toDateInput, toMajorUnits, toMinorUnits } from "../money";
import { can, Permission } from "../access";
import { remoteTable } from "../pagination";
import { t, type UiKey } from "../i18n";
import { modal, reportError, toast } from "../ui";
import { invalidateProject, loadProject, projectLayout } from "./project";
import { currentPath, navigate } from "../router";
import { expenseCategoryLabel } from "../expense-categories";
import type { DateFormat } from "../../../server/formats";

export type Tab = "journal" | "trial" | "accounts" | "recorded" | "bank" | "years" | "statements" | "assets" | "kpo" | "ajpes";

const TABS: { id: Tab; label: UiKey; suffix: string; hidden?: NonNullable<Project["bookkeeping"]>[] }[] = [
	{ id: "journal", label: "accounting.tab_journal", suffix: "" },
	{ id: "recorded", label: "accounting.tab_recorded", suffix: "/recorded-invoices" },
	{ id: "bank", label: "accounting.tab_bank", suffix: "/bank" },
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

export function period(project: Project, onChange: () => void, singleYear = false): Period {
	const year = currentYear(project);
	const from = input("date", { value: `${year}-01-01`, required: true });
	const to = input("date", { value: `${year}-12-31`, required: true });
	const keepWithinYear = (changed: HTMLInputElement) => {
		if (!singleYear || from.value.slice(0, 4) === to.value.slice(0, 4)) return;
		if (changed === from) to.value = `${from.value.slice(0, 4)}-12-31`;
		else from.value = `${to.value.slice(0, 4)}-01-01`;
	};
	for (const control of [from, to])
		control.addEventListener("change", () => {
			if (!from.value || !to.value) return;
			keepWithinYear(control);
			onChange();
		});
	return {
		element: el("div", { class: "ledger-controls" }, field(t("accounting.from"), from), field(t("accounting.to"), to)),
		range: () => ({ from: dayStartFromDateInput(from.value, project.timezone), to: fromDateInput(to.value, project.timezone) }),
	};
}

function redeemForm(project: Project): HTMLElement | null {
	if (!can(project, Permission.LEDGER_EDIT)) return null;
	const code = input("text", { placeholder: "RPAY-", autocomplete: "off", required: true });
	const submit = el("button", { class: "button primary", type: "submit" }, t("accounting.redeem"));
	return el(
		"form",
		{
			class: "toolbar",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					await Api.redeemAccountingLicense(project.uuid, code.value.trim());
					invalidateProject(project.uuid);
					toast(t("accounting.redeemed"));
					navigate(currentPath(), true);
				} catch (error) {
					reportError(error);
				} finally {
					submit.disabled = false;
				}
			},
		},
		code,
		submit
	);
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

function entryDialog(project: Project, accounts: LedgerAccount[], onPosted: () => void) {
	const currency = baseCurrency(project);
	const options = accounts.filter((account) => account.active).map((account) => ({ value: account.uuid, label: accountLabel(account) }));
	const date = input("date", { value: toDateInput(Date.now(), project.timezone), required: true });
	const description = input("text", { maxlength: "500", required: true });
	const rows = el("div", { class: "stack" });
	const totals = el("p", { class: "muted mono" });
	const lines: { account: HTMLSelectElement; debit: HTMLInputElement; credit: HTMLInputElement; partner: HTMLInputElement; row: HTMLElement }[] = [];

	const sum = (key: "debit" | "credit") => lines.reduce((total, line) => total + toMinorUnits(Number(line[key].value || 0), currency), 0);
	const refresh = () => {
		const debit = sum("debit");
		const credit = sum("credit");
		totals.textContent = t("accounting.entry_totals", { debit: formatMoney(debit, currency), credit: formatMoney(credit, currency) });
		totals.className = debit === credit && debit > 0 ? "muted mono" : "warn mono";
	};
	const addLine = () => {
		const difference = sum("debit") - sum("credit");
		const account = select(options);
		const debit = input("number", { min: "0", step: "0.01", placeholder: t("accounting.debit") });
		const credit = input("number", { min: "0", step: "0.01", placeholder: t("accounting.credit") });
		const partner = input("text", { maxlength: "200", placeholder: t("accounting.partner") });
		const remove = el("button", { class: "button ghost small", type: "button" }, t("ui.delete"));
		const row = el("div", { class: "journal-line" }, account, debit, credit, partner, remove);
		const line = { account, debit, credit, partner, row };
		remove.addEventListener("click", () => {
			if (lines.length <= 2) return;
			lines.splice(lines.indexOf(line), 1);
			row.remove();
			refresh();
		});
		for (const control of [debit, credit]) control.addEventListener("input", refresh);
		lines.push(line);
		rows.append(row);
		if (difference !== 0) (difference > 0 ? credit : debit).value = String(toMajorUnits(Math.abs(difference), currency));
		refresh();
	};
	addLine();
	addLine();

	const submit = el("button", { class: "button primary", type: "submit" }, t("accounting.post"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
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
		el("div", { class: "line-actions" }, el("button", { class: "button ghost small", type: "button", onClick: addLine }, t("accounting.add_line")), totals),
		el("p", { class: "muted" }, t("accounting.entry_hint")),
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(t("accounting.new_entry"), form);
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
					const page = await Api.journal(uuid, { ...range.range(), offset, limit });
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
									index === 0 && reversible
										? el("div", {}, el("button", { class: "button ghost small", type: "button", onClick: () => reverse(entry.uuid) }, t("accounting.reverse")))
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
				exportButton(project, () => Api.exportJournal(uuid, range.range())),
				editable(project)
					? el(
							"button",
							{
								class: "button primary",
								type: "button",
								dataset: { shortcutAction: "new-accounting-entry" },
								onClick: () => entryDialog(project, accounts, () => void render()),
							},
							t("accounting.new_entry")
						)
					: null,
			],
		},
		notice,
		range.element,
		body
	);
}

export async function trialBalanceView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const currency = baseCurrency(project);
	const notice = el("div", { class: "stack" });
	const body = el("div", {});
	const range = period(project, () => void render(), true);

	const render = async () => {
		try {
			const result = await Api.trialBalance(uuid, range.range());
			showNotices(notice, project, result.issues);
			const total = (key: "debit" | "credit") => result.accounts.reduce((sum, row) => sum + row[key], 0);
			body.replaceChildren(
				result.accounts.length === 0
					? emptyState(t("accounting.journal_empty"))
					: table(
							[
								t("accounting.account"),
								numeric(t("accounting.opening")),
								numeric(t("accounting.debit")),
								numeric(t("accounting.credit")),
								numeric(t("accounting.closing")),
							],
							[
								...result.accounts.map((row) =>
									el(
										"tr",
										{},
										el("td", {}, el("a", { href: `/projects/${uuid}/accounting/ledger/${row.account}` }, accountLabel(row))),
										moneyCell(row.opening, currency, { zero: true }),
										moneyCell(row.debit, currency, { zero: true }),
										moneyCell(row.credit, currency, { zero: true }),
										moneyCell(row.closing, currency, { zero: true })
									)
								),
								el(
									"tr",
									{ class: "total-row" },
									el("td", {}, el("strong", {}, t("accounting.total"))),
									el("td", {}),
									moneyCell(total("debit"), currency, { strong: true, zero: true }),
									moneyCell(total("credit"), currency, { strong: true, zero: true }),
									el("td", {})
								),
							]
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

	const render = async () => {
		try {
			const ledger = await Api.accountLedger(uuid, account, range.range());
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
		{ title, back: el("a", { class: "back-link", href: `/projects/${uuid}/accounting/trial-balance` }, t("accounting.back_to_trial_balance")) },
		range.element,
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
						t("accounting.client_attention"),
					],
					clients.map(clientRow)
				)
	);
}
