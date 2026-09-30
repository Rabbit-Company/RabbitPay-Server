import { Api, type BankStatement, type BankSuggestion, type BankTransaction, type LedgerAccount, type Project, type StatementPreview } from "../api";
import { el, emptyState, field, input, select, table } from "../dom";
import { formatDate, formatMoney } from "../money";
import { remoteTable } from "../pagination";
import { toBase64 } from "../image";
import { t, type UiKey } from "../i18n";
import { modal, reportError, toast } from "../ui";
import { loadProject } from "./project";
import { accountLabelOf, editable, ledgerPage, licenseNotice, moneyCell, numeric, section, sectionHead } from "./accounting";
import type { DateFormat } from "../../../server/formats";

function importDialog(project: Project, onImported: () => void) {
	const file = input("file", { required: true });
	file.accept = ".xml,application/xml,text/xml";
	const summary = el("div", { class: "stack" });
	const submit = el("button", { class: "button primary", type: "submit", disabled: true }, t("bank.import_submit"));
	let data = "";
	let name = "";

	const show = (preview: StatementPreview) => {
		submit.disabled = preview.new_lines === 0;
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
			el("p", {}, t("bank.import_counts", { new: preview.new_lines, known: preview.known_lines }))
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
					toast(t("bank.imported", { count: result.imported }));
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
	const account = select(
		accounts.filter((entry) => entry.active && entry.system_key !== "bank").map((entry) => ({ value: entry.uuid, label: accountLabelOf(entry) }))
	);
	account.classList.add("account-select");
	const submit = el("button", { class: "button primary", type: "submit" }, t("bank.book_submit"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
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
		field(t("bank.book_account"), account),
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(t("bank.book"), form, undefined, "dialog-medium");
}

function suggestionLabel(suggestion: BankSuggestion): string {
	const kind = t(`bank.match_${suggestion.type}` as UiKey);
	return [kind, suggestion.reference, suggestion.name, formatMoney(suggestion.amount, suggestion.currency)].filter(Boolean).join(" | ");
}

function statementsTable(project: Project, statements: BankStatement[]): HTMLElement {
	if (statements.length === 0) return emptyState(t("bank.statements_empty"));
	return table(
		[t("bank.account"), t("bank.statement"), t("bank.period"), numeric(t("bank.closing")), numeric(t("bank.ledger_balance")), numeric(t("bank.open_lines"))],
		statements.map((statement) => {
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
		})
	);
}

export async function bankView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const dateFormat = project.date_format as DateFormat;
	const accounts = (await Api.ledgerAccounts(uuid)).accounts;
	const status = select(
		["open", "matched", "booked", "ignored", "all"].map((value) => ({ value, label: t(`bank.status_${value}` as UiKey) })),
		"open"
	);
	const lines = el("div", {});
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
					el("span", { class: "muted" }, line.match_type ? t(`bank.match_${line.match_type}` as UiKey) : t(`bank.status_${line.status}` as UiKey)),
					line.match_type === "invoice"
						? null
						: el(
								"button",
								{ class: "button ghost small", type: "button", onClick: () => act(() => Api.reopenBankTransaction(uuid, line.uuid)) },
								t("bank.reopen")
							)
				)
			);
		}
		return el(
			"td",
			{ class: "actions" },
			el(
				"div",
				{ class: "bank-actions" },
				...line.suggestions.map((suggestion) =>
					el(
						"button",
						{
							class: `button ${suggestion.exact ? "primary" : "ghost"} small`,
							type: "button",
							onClick: () => act(() => Api.matchBankTransaction(uuid, line.uuid, suggestion.type, suggestion.id)),
						},
						suggestionLabel(suggestion)
					)
				),
				el(
					"div",
					{ class: "line-actions" },
					el(
						"button",
						{ class: "button ghost small", type: "button", onClick: () => bookDialog(project, line, accounts, () => void render()) },
						t("bank.book")
					),
					el("button", { class: "button ghost small", type: "button", onClick: () => act(() => Api.ignoreBankTransaction(uuid, line.uuid)) }, t("bank.ignore"))
				)
			)
		);
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
