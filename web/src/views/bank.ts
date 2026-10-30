import {
	Api,
	type BankCandidate,
	type BankStatement,
	type BankSuggestion,
	type PaidInvoiceSuggestion,
	type BankTransaction,
	type LedgerAccount,
	type Project,
	type StatementPreview,
} from "../api";
import { el, emptyState, field, input, select, table } from "../dom";
import { formatDate, formatMoney, toMajorUnits, toMinorUnits } from "../money";
import { pagedList, remoteTable } from "../pagination";
import { toBase64 } from "../image";
import { t, type UiKey } from "../i18n";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { loadProject } from "./project";
import { legalNameParts } from "../../../server/legal-name";
import { newExpenseFrom } from "./expenses";
import { can, Permission } from "../access";
import { floatingMenu, type MenuLink } from "../menu";
import { accountPicker, editable, ledgerPage, licenseNotice, moneyCell, numeric, section, sectionHead } from "./accounting";
import { formatDateTime, type DateFormat, type TimeFormat } from "../../../server/formats";

const STATEMENTS_PAGE = 10;

function importDialog(project: Project, onImported: () => void) {
	const file = input("file", { required: true });
	file.accept = ".xml,application/xml,text/xml";
	const summary = el("div", { class: "stack" });
	const submit = el("button", { class: "button primary", type: "submit", disabled: true }, t("bank.import_submit"));
	let data = "";
	let name = "";

	const show = (preview: StatementPreview) => {
		submit.disabled = preview.new_lines === 0 && preview.refreshable_lines === 0;
		summary.replaceChildren(
			table(
				[t("bank.account"), t("bank.statement"), t("bank.period"), t("bank.opening"), t("bank.closing"), t("bank.lines")],
				preview.statements.map((statement) =>
					el(
						"tr",
						{},
						el("td", { class: "mono" }, statement.iban),
						el("td", {}, statement.statement_id),
						el(
							"td",
							{},
							[statement.period_from, statement.period_to]
								.map((value) => (value === null ? "" : formatDate(value, project.date_format as DateFormat, project.timezone)))
								.join(" - ")
						),
						el("td", { class: "mono" }, statement.opening_balance === null ? "" : formatMoney(statement.opening_balance, statement.currency)),
						el("td", { class: "mono" }, statement.closing_balance === null ? "" : formatMoney(statement.closing_balance, statement.currency)),
						el("td", { class: "mono" }, String(statement.transactions))
					)
				)
			),
			el("p", {}, t("bank.import_counts", { new: preview.new_lines, known: preview.known_lines })),
			...(preview.refreshable_lines > 0 ? [el("p", { class: "muted" }, t("bank.import_refreshable", { count: preview.refreshable_lines }))] : [])
		);
	};

	file.addEventListener("change", async () => {
		const selected = file.files?.[0];
		submit.disabled = true;
		summary.replaceChildren();
		if (!selected) return;
		try {
			name = selected.name;
			data = await toBase64(selected);
			show(await Api.previewBankStatement(project.uuid, name, data));
		} catch (error) {
			reportError(error);
		}
	});

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					const result = await Api.importBankStatement(project.uuid, name, data);
					dialog.close();
					toast(
						result.refreshed > 0
							? t("bank.imported_refreshed", { count: result.imported, refreshed: result.refreshed })
							: t("bank.imported", { count: result.imported })
					);
					onImported();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, t("bank.import_hint")),
		field(t("bank.file"), file),
		summary,
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(t("bank.import"), form);
}

function bookDialog(project: Project, line: BankTransaction, accounts: LedgerAccount[], onBooked: () => void) {
	const account = accountPicker(accounts, "", (entry) => entry.system_key !== "bank");
	const submit = el("button", { class: "button primary", type: "submit" }, t("bank.book_submit"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					if (!account.value) {
						account.input.focus();
						submit.disabled = false;
						return;
					}
					await Api.bookBankTransaction(project.uuid, line.uuid, account.value);
					dialog.close();
					onBooked();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("p", {}, `${line.counterparty_name ?? ""} ${formatMoney(line.amount, line.currency)}`),
		el("p", { class: "muted" }, t(line.amount > 0 ? "bank.book_hint_in" : "bank.book_hint_out")),
		field(t("bank.book_account"), account.element),
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(t("bank.book"), form, undefined, "dialog-medium");
	account.input.focus();
}

async function matchDialog(project: Project, line: BankTransaction, onMatched: () => void) {
	const { candidates } = await Api.bankCandidates(project.uuid, line.uuid);
	const dateFormat = project.date_format as DateFormat;
	const search = input("search", { placeholder: t("bank.match_search") });
	const totals = el("p", { class: "mono" });
	const foreignNote = el("p", { class: "muted" });
	const submit = el("button", { class: "button primary", type: "submit", disabled: true }, t("bank.match_submit"));
	const rows: { candidate: BankCandidate; pick: HTMLInputElement; amount: HTMLInputElement; row: HTMLElement }[] = [];

	const refresh = () => {
		const picked = rows.filter((entry) => entry.pick.checked);
		const foreign = picked.find((entry) => entry.candidate.currency !== line.currency);
		const selected = picked.reduce((sum, entry) => sum + entry.candidate.direction * toMinorUnits(Number(entry.amount.value || 0), line.currency), 0);
		const difference = line.amount - selected;
		foreignNote.textContent = foreign ? t("bank.match_foreign", { currency: foreign.candidate.currency }) : "";
		totals.textContent = foreign
			? ""
			: t("bank.match_totals", {
					selected: formatMoney(selected, line.currency),
					line: formatMoney(line.amount, line.currency),
					difference: formatMoney(difference, line.currency),
				});
		totals.className = difference === 0 || foreign ? "mono" : "mono warn";
		submit.disabled = showPaid.checked ? paidChoice === null : picked.length === 0 || (foreign ? picked.length !== 1 : difference !== 0);
	};

	for (const candidate of candidates) {
		const pick = input("checkbox");
		const sameCurrency = candidate.currency === line.currency;
		const amount = input("number", { min: "0", step: "0.01", value: sameCurrency ? String(toMajorUnits(candidate.amount, candidate.currency)) : "" });
		amount.disabled = !candidate.partial || !sameCurrency;
		pick.addEventListener("change", refresh);
		amount.addEventListener("input", refresh);
		const row = el(
			"tr",
			{},
			el("td", {}, pick),
			el("td", {}, t(`bank.match_${candidate.type}` as UiKey), candidate.reference ? el("div", { class: "muted mono" }, candidate.reference) : null),
			el("td", {}, candidate.name ?? ""),
			el("td", { class: "date" }, formatDate(candidate.date, dateFormat, project.timezone)),
			moneyCell(candidate.direction * candidate.amount, candidate.currency, { zero: true, warn: candidate.direction < 0 }),
			el("td", { class: "num" }, sameCurrency ? amount : "")
		);
		rows.push({ candidate, pick, amount, row });
	}
	const showPaid = input("checkbox");
	const paidBody = el("div", { class: "stack" });
	const regular = el("div", { class: "stack" });
	let paidChoice: PaidInvoiceSuggestion | null = null;
	let paidRound = 0;
	let paidTimer: ReturnType<typeof setTimeout>;
	const loadPaid = async () => {
		const round = ++paidRound;
		paidChoice = null;
		refresh();
		try {
			const { payments } = await Api.bankPaidPayments(project.uuid, line.uuid, search.value.trim());
			if (round !== paidRound) return;
			if (payments.length === 0) {
				paidBody.replaceChildren(emptyState(t("bank.paid_none")));
				return;
			}
			paidBody.replaceChildren(
				table(
					["", t("bank.match_document"), t("bank.counterparty"), t("bank.paid_on"), numeric(t("bank.match_amount"))],
					payments.map((payment) => {
						const pick = input("radio");
						pick.name = "paid-payment";
						pick.disabled = payment.amount !== line.amount;
						pick.addEventListener("change", () => {
							paidChoice = payment;
							refresh();
						});
						return el(
							"tr",
							{ class: pick.disabled ? "muted" : "" },
							el("td", {}, pick),
							el("td", {}, `${t("bank.match_invoice")} ${payment.reference}`),
							el("td", {}, payment.name ?? ""),
							el("td", { class: "date" }, payment.paid_at ? formatDate(payment.paid_at, dateFormat, project.timezone) : ""),
							moneyCell(payment.amount, payment.currency, { zero: true })
						);
					})
				),
				el("p", { class: "field-hint" }, t("bank.paid_hint"))
			);
		} catch (error) {
			reportError(error);
		}
	};
	showPaid.addEventListener("change", () => {
		regular.hidden = showPaid.checked;
		paidBody.hidden = !showPaid.checked;
		totals.hidden = showPaid.checked;
		foreignNote.hidden = showPaid.checked;
		search.value = "";
		for (const entry of rows) entry.row.hidden = false;
		if (showPaid.checked) void loadPaid();
		else {
			paidChoice = null;
			refresh();
		}
	});
	paidBody.hidden = true;

	search.addEventListener("input", () => {
		if (showPaid.checked) {
			clearTimeout(paidTimer);
			paidTimer = setTimeout(() => void loadPaid(), 250);
			return;
		}
		const wanted = search.value.trim().toLowerCase();
		for (const entry of rows) {
			const text = [entry.candidate.reference, entry.candidate.name, String(toMajorUnits(entry.candidate.amount, entry.candidate.currency))]
				.join(" ")
				.toLowerCase();
			entry.row.hidden = wanted !== "" && !text.includes(wanted) && !entry.pick.checked;
		}
	});
	refresh();

	regular.append(
		candidates.length === 0
			? emptyState(t("bank.match_none"))
			: table(
					["", t("bank.match_document"), t("bank.counterparty"), t("bank.date"), numeric(t("bank.match_open")), numeric(t("bank.match_amount"))],
					rows.map((entry) => entry.row)
				)
	);

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					if (showPaid.checked) {
						if (!paidChoice) return;
						await Api.linkBankPayment(project.uuid, line.uuid, paidChoice.payment);
						dialog.close();
						onMatched();
						return;
					}
					await Api.matchBankTransactionTo(
						project.uuid,
						line.uuid,
						rows
							.filter((entry) => entry.pick.checked)
							.map((entry) => ({
								type: entry.candidate.type,
								id: entry.candidate.id,
								amount:
									entry.candidate.partial && entry.candidate.currency === line.currency ? toMinorUnits(Number(entry.amount.value || 0), line.currency) : null,
							}))
					);
					dialog.close();
					onMatched();
				} catch (error) {
					reportError(error);
					refresh();
				}
			},
		},
		el("p", {}, `${line.counterparty_name ?? ""} ${formatMoney(line.amount, line.currency)}`),
		el("p", { class: "muted" }, t("bank.match_several_hint")),
		line.amount > 0 ? el("label", { class: "switch" }, showPaid, el("span", {}, t("bank.show_paid"))) : null,
		search,
		regular,
		paidBody,
		foreignNote,
		el("div", { class: "line-actions" }, totals, submit)
	);
	const dialog = modal(t("bank.match_several_title"), form, undefined, "dialog-large");
	search.focus();
}

function cardPayment(line: BankTransaction): boolean {
	return /\*{4} \d{4}/.test(line.remittance ?? "");
}

function expenseFromLine(project: Project, line: BankTransaction, onCreated: () => Promise<void>) {
	const card = cardPayment(line);
	const purchased = line.value_date ?? line.booking_date;
	const merchant = line.counterparty_name ?? "";
	const description = (card ? t("bank.card_purchase", { merchant }) : (line.remittance ?? merchant)).slice(0, 240);
	void newExpenseFrom(
		project,
		{
			prefill: {
				description,
				supplier: line.counterparty_name,
				total_amount: -line.amount,
				currency: line.currency,
				expense_date: purchased,
				issue_date: purchased,
				receipt_date: purchased,
				paid_at: line.booking_date,
				payment_method: card ? "card" : "transfer",
			},
			create: (data) => Api.createExpenseFromBankLine(project.uuid, line.uuid, data),
			notice: el(
				"p",
				{ class: "muted" },
				t("bank.expense_notice", {
					date: formatDate(line.booking_date, project.date_format as DateFormat, project.timezone),
					amount: formatMoney(-line.amount, line.currency),
				})
			),
		},
		onCreated
	).catch(reportError);
}

function moreButton(sections: MenuLink[][]): HTMLElement | null {
	if (sections.every((section) => section.length === 0)) return null;
	const trigger = el(
		"button",
		{ class: "button ghost small menu-button", type: "button" },
		el("span", {}, t("invoices.menu_more")),
		el("span", { class: "menu-chevron" })
	);
	trigger.setAttribute("aria-haspopup", "menu");
	trigger.addEventListener("click", () => {
		const box = trigger.getBoundingClientRect();
		floatingMenu({ x: box.right - 240, y: box.bottom + 4 }, sections, trigger);
	});
	return trigger;
}

function comparable(name: string | null | undefined): string {
	return (name ?? "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function shortName(name: string | null): string | null {
	return name ? legalNameParts(name).name : null;
}

function documentPath(project: string, suggestion: Pick<BankSuggestion, "type" | "id">): string {
	if (suggestion.type === "invoice") return `/projects/${project}/invoices/${suggestion.id}`;
	if (suggestion.type === "expense") return `/projects/${project}/expenses?open=${suggestion.id}`;
	return `/projects/${project}/accounting/recorded-invoices?open=${suggestion.id}`;
}

function suggestionLabel(suggestion: BankSuggestion): string {
	const kind = t(`bank.match_${suggestion.type}` as UiKey);
	return [`${kind} ${suggestion.reference ?? ""}`.trim(), shortName(suggestion.name), formatMoney(suggestion.amount, suggestion.currency)]
		.filter(Boolean)
		.join(" | ");
}

function suggestionButtonLabel(suggestion: BankSuggestion, line: BankTransaction): string {
	const kind = t(`bank.match_${suggestion.type}` as UiKey);
	const name = shortName(suggestion.name);
	const lineName = comparable(line.counterparty_name);
	const samePartner = !name || !lineName || lineName.includes(comparable(name).split(" ")[0]) || comparable(suggestion.name).includes(lineName.split(" ")[0]);
	return [
		`${kind} ${suggestion.reference ?? ""}`.trim(),
		samePartner ? null : name,
		Math.abs(line.amount) === suggestion.amount ? null : formatMoney(suggestion.amount, suggestion.currency),
	]
		.filter(Boolean)
		.join(" | ");
}

function statementsTable(project: Project, statements: BankStatement[]): HTMLElement {
	if (statements.length === 0) return emptyState(t("bank.statements_empty"));
	const headers = [
		t("bank.account"),
		t("bank.statement"),
		t("bank.period"),
		numeric(t("bank.closing")),
		numeric(t("bank.ledger_balance")),
		numeric(t("bank.open_lines")),
	];
	const rows = statements.map((statement) => {
		const difference = statement.closing_balance !== null && statement.ledger_balance !== null && statement.closing_balance !== statement.ledger_balance;
		return el(
			"tr",
			{},
			el("td", { class: "mono" }, statement.iban),
			el("td", {}, statement.statement_id),
			el("td", { class: "date" }, statement.period_to === null ? "" : formatDate(statement.period_to, project.date_format as DateFormat, project.timezone)),
			moneyCell(statement.closing_balance, statement.currency, { zero: true }),
			moneyCell(statement.ledger_balance, statement.currency, { zero: true, warn: difference }),
			el("td", { class: "num" }, String(statement.lines.open ?? 0))
		);
	});
	return pagedList(rows, (page) => table(headers, page), STATEMENTS_PAGE);
}

export async function bankView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const dateFormat = project.date_format as DateFormat;
	const accounts = (await Api.ledgerAccounts(uuid)).accounts;
	const soleTrader = (project.bookkeeping ?? "company").startsWith("sole_");
	const householdAccount = soleTrader ? (accounts.find((account) => account.system_key === "household_flows" && account.active) ?? null) : null;
	const status = select(
		["open", "matched", "booked", "ignored", "all"].map((value) => ({ value, label: t(`bank.status_${value}` as UiKey) })),
		"open"
	);
	const lines = el("div", { class: "bank-lines" });
	const statements = el("div", {});
	const canEdit = editable(project);

	const act = async (work: () => Promise<unknown>) => {
		try {
			await work();
			await render();
		} catch (error) {
			reportError(error);
		}
	};

	const actions = (line: BankTransaction): HTMLElement => {
		if (!canEdit) return el("td", { class: "actions" }, t(`bank.status_${line.status}` as UiKey));
		if (line.status !== "open") {
			return el(
				"td",
				{ class: "actions" },
				el(
					"div",
					{ class: "bank-actions" },
					line.matches.length > 0
						? el(
								"div",
								{ class: "bank-matched" },
								...line.matches.map((entry) =>
									el(
										"a",
										{ href: documentPath(uuid, { type: entry.match_type, id: entry.match_id }), target: "_blank", rel: "noopener" },
										`${t(`bank.match_${entry.match_type}` as UiKey)} ${entry.reference ?? ""}`.trim()
									)
								)
							)
						: el("span", { class: "muted" }, t(`bank.status_${line.status}` as UiKey)),
					line.matched_at
						? el(
								"span",
								{ class: "field-hint" },
								[line.matched_by_name, formatDateTime(line.matched_at, dateFormat, project.time_format as TimeFormat, project.timezone)]
									.filter(Boolean)
									.join(" | ")
							)
						: null,
					el(
						"button",
						{
							class: "button ghost small",
							type: "button",
							onClick: async () => {
								const invoicePayment = line.match_type === "invoice" || line.matches.some((match) => match.match_type === "invoice");
								if (
									invoicePayment &&
									!(await confirmDialog({
										title: t("bank.reopen_invoice_title"),
										body: t("bank.reopen_invoice_body"),
										confirmLabel: t("bank.reopen"),
										destructive: true,
									}))
								)
									return;
								act(() => Api.reopenBankTransaction(uuid, line.uuid));
							},
						},
						t("bank.reopen")
					)
				)
			);
		}
		const match = (suggestion: BankSuggestion) => () => act(() => Api.matchBankTransaction(uuid, line.uuid, suggestion.type, suggestion.id));
		const createExpense = line.amount < 0 && can(project, Permission.EXPENSE_CREATE) ? () => expenseFromLine(project, line, render) : null;
		const paid = line.paid_suggestions[0] ?? null;
		const trusted = !paid ? line.suggestions.find((suggestion) => suggestion.referenced || suggestion.named) : undefined;
		const others = line.suggestions.filter((suggestion) => suggestion !== trusted);
		const link = (suggestion: PaidInvoiceSuggestion) => () => act(() => Api.linkBankPayment(uuid, line.uuid, suggestion.payment));
		const paidLabel = (suggestion: PaidInvoiceSuggestion) => t("bank.link_payment", { document: `${t("bank.match_invoice")} ${suggestion.reference}` });
		const main = paid
			? el("button", { class: "button primary small", type: "button", title: t("bank.link_payment_hint"), onClick: link(paid) }, paidLabel(paid))
			: trusted
				? el(
						"button",
						{ class: `button ${trusted.exact ? "primary" : "ghost"} small`, type: "button", title: suggestionLabel(trusted), onClick: match(trusted) },
						suggestionButtonLabel(trusted, line)
					)
				: createExpense && cardPayment(line)
					? el("button", { class: "button primary small", type: "button", onClick: createExpense }, t("bank.create_expense"))
					: null;
		const more = moreButton([
			[
				...line.paid_suggestions.map((suggestion) => ({
					label: t("bank.open_document", { document: `${t("bank.match_invoice")} ${suggestion.reference}` }),
					href: documentPath(uuid, { type: "invoice", id: suggestion.invoice }),
					newTab: true,
				})),
				...line.suggestions.map((suggestion) => ({
					label: t("bank.open_document", { document: `${t(`bank.match_${suggestion.type}` as UiKey)} ${suggestion.reference ?? ""}`.trim() }),
					href: documentPath(uuid, suggestion),
					newTab: true,
				})),
			],
			[
				...line.paid_suggestions.slice(1).map((suggestion) => ({ label: paidLabel(suggestion), onSelect: link(suggestion) })),
				...others.map((suggestion) => ({ label: suggestionLabel(suggestion), onSelect: match(suggestion) })),
			],
			[
				...(createExpense && (trusted || paid || !cardPayment(line)) ? [{ label: t("bank.create_expense"), onSelect: createExpense }] : []),
				...(householdAccount ? [{ label: t("bank.private"), onSelect: () => act(() => Api.bookBankTransaction(uuid, line.uuid, householdAccount.uuid)) }] : []),
				{ label: t("bank.match_several"), onSelect: () => void matchDialog(project, line, () => void render()).catch(reportError) },
				{ label: t("bank.book"), onSelect: () => bookDialog(project, line, accounts, () => void render()) },
			],
			[{ label: t("bank.ignore"), onSelect: () => act(() => Api.ignoreBankTransaction(uuid, line.uuid)) }],
		]);
		return el("td", { class: "actions" }, el("div", { class: "bank-line-actions" }, main, more));
	};

	const render = async () => {
		try {
			statements.replaceChildren(statementsTable(project, (await Api.bankStatements(uuid)).statements));
		} catch (error) {
			reportError(error);
		}
		lines.replaceChildren(
			remoteTable(
				[t("bank.date"), t("bank.counterparty"), t("bank.details"), numeric(t("bank.amount")), ""],
				async (offset, limit) => {
					const page = await Api.bankTransactions(uuid, { status: status.value, offset, limit });
					const rows = page.transactions.map((line) =>
						el(
							"tr",
							{},
							el("td", { class: "date" }, formatDate(line.booking_date, dateFormat, project.timezone)),
							el("td", {}, line.counterparty_name ?? "", line.counterparty_iban ? el("div", { class: "muted mono" }, line.counterparty_iban) : null),
							el("td", {}, line.remittance ?? "", line.reference ? el("div", { class: "muted mono" }, line.reference) : null),
							moneyCell(line.amount, line.currency, { zero: true, warn: line.amount < 0 }),
							actions(line)
						)
					);
					return { rows, total: page.total };
				},
				t("bank.lines_empty")
			)
		);
	};
	status.addEventListener("change", () => void render());
	await render();

	return ledgerPage(
		project,
		"bank",
		{
			title: t("bank.title"),
			intro: t("bank.intro"),
			actions: canEdit
				? [
						el(
							"button",
							{
								class: "button ghost",
								type: "button",
								onClick: () =>
									act(async () => {
										const result = await Api.matchExactBankTransactions(uuid);
										toast(t("bank.matched_exact", { count: result.matched }));
									}),
							},
							t("bank.match_exact")
						),
						el(
							"button",
							{
								class: "button primary",
								type: "button",
								dataset: { shortcutAction: "new-accounting-entry" },
								onClick: () => importDialog(project, () => void render()),
							},
							t("bank.import")
						),
					]
				: [],
		},
		licenseNotice(project),
		section(t("bank.statements"), statements),
		section(sectionHead(t("bank.lines_title"), field(t("bank.status"), status)), lines)
	);
}
