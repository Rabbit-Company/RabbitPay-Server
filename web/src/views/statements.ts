import { Api, type FinancialStatements, type StatementLine } from "../api";
import { el, replaceContent, field, saveFile, table } from "../dom";
import { formatMoney } from "../money";
import { t } from "../i18n";
import { reportError } from "../ui";
import { loadProject } from "./project";
import { currentYear, ledgerPage, moneyCell, notices, numeric, section, yearSelect } from "./accounting";

function statementTable(lines: StatementLine[], currency: string, year: number, footer: HTMLElement | null): HTMLElement {
	const rows = lines
		.filter((line) => line.amount !== 0 || (line.previous ?? 0) !== 0)
		.map((line) => {
			const strong = line.level === 0;
			const label = el("td", {}, strong ? el("strong", {}, `${line.id}. ${line.label}`) : `${line.id.split(".").pop()}. ${line.label}`);
			label.style.paddingLeft = `${0.9 + line.level * 1.25}rem`;
			return el("tr", {}, label, moneyCell(line.amount, currency, { strong }), moneyCell(line.previous, currency, { muted: true }));
		});
	return table([t("statements.item"), numeric(String(year)), numeric(String(year - 1))], footer ? [...rows, footer] : rows);
}

function totalRow(label: string, current: number, previous: number, currency: string, warn = false): HTMLElement {
	return el(
		"tr",
		{ class: "total-row" },
		el("td", {}, el("strong", {}, label)),
		moneyCell(current, currency, { strong: true, zero: true, warn }),
		moneyCell(previous, currency, { muted: true, zero: true })
	);
}

function csv(statements: FinancialStatements): string {
	const cell = (value: string | number) => (/[",;\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));
	const major = (value: number | undefined) => ((value ?? 0) / 100).toFixed(2);
	const rows: (string | number)[][] = [["statement", "item", "label", String(statements.year), String(statements.year - 1)]];
	for (const [name, lines] of [
		["balance_sheet_assets", statements.balance_sheet.assets],
		["balance_sheet_sources", statements.balance_sheet.sources],
		["income_statement", statements.income_statement.lines],
	] as const) {
		for (const line of lines) rows.push([name, line.id, line.label, major(line.amount), major(line.previous)]);
	}
	rows.push([
		"income_statement",
		"19",
		"Čisti poslovni izid obračunskega obdobja",
		major(statements.income_statement.result),
		major(statements.income_statement.previous_result),
	]);
	return rows.map((row) => row.map(cell).join(",")).join("\n") + "\n";
}

export async function statementsView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const year = yearSelect(currentYear(project) - 1);
	const body = el("div", { class: "stack" });
	let loaded: FinancialStatements | null = null;
	const download = el("button", { class: "button ghost", type: "button", disabled: true }, t("stats.download_csv"));
	download.addEventListener("click", () => {
		if (loaded) saveFile(new Blob([csv(loaded)], { type: "text/csv;charset=utf-8" }), `izkazi-${loaded.year}.csv`);
	});

	const render = async () => {
		try {
			const statements = await Api.financialStatements(uuid, Number(year.value));
			loaded = statements;
			download.disabled = false;
			const currency = statements.currency;
			const sheet = statements.balance_sheet;
			const income = statements.income_statement;
			const unmapped = [...sheet.unmapped, ...income.unmapped];
			replaceContent(
				body,
				notices(project, statements.issues),
				sheet.balanced ? null : el("div", { class: "ledger-notice" }, el("p", { class: "warn" }, t("statements.unbalanced"))),
				income.reconciled ? null : el("div", { class: "ledger-notice" }, el("p", { class: "warn" }, t("statements.unreconciled"))),
				unmapped.length
					? el(
							"div",
							{ class: "ledger-notice" },
							el("p", { class: "warn" }, t("statements.unmapped")),
							el("ul", {}, ...unmapped.map((row) => el("li", {}, `${row.code} ${row.name}: ${formatMoney(row.amount, currency)}`)))
						)
					: null,
				section(
					t("statements.balance_sheet_assets"),
					statementTable(
						sheet.assets,
						currency,
						statements.year,
						totalRow(t("statements.total_assets"), sheet.total_assets, sheet.previous_total_assets, currency)
					)
				),
				section(
					t("statements.balance_sheet_sources"),
					statementTable(
						sheet.sources,
						currency,
						statements.year,
						totalRow(t("statements.total_sources"), sheet.total_sources, sheet.previous_total_sources, currency, !sheet.balanced)
					)
				),
				section(
					t("statements.income_statement"),
					statementTable(
						income.lines,
						currency,
						statements.year,
						totalRow(`19. ${t("statements.result")}`, income.result, income.previous_result, currency, income.result < 0)
					)
				)
			);
		} catch (error) {
			reportError(error);
		}
	};
	year.addEventListener("change", () => void render());
	await render();

	return ledgerPage(
		project,
		"statements",
		{ title: t("statements.title"), intro: t("statements.intro"), actions: [download] },
		el("div", { class: "ledger-controls" }, field(t("statements.year"), year)),
		body
	);
}
