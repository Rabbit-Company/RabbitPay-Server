import { Api, type KpoBook, type KpoColumn } from "../api";
import { el, emptyState, field, saveFile, table } from "../dom";
import { formatDate, formatMoney } from "../money";
import { t, type UiKey } from "../i18n";
import { reportError } from "../ui";
import { loadProject } from "./project";
import { baseCurrency, ledgerPage, moneyCell, notices, numeric, summaryCards, yearSelect } from "./accounting";
import type { DateFormat } from "../../../server/formats";

const COLUMNS: KpoColumn[] = [
	"revenue_sales",
	"revenue_other",
	"material",
	"services",
	"labor",
	"depreciation",
	"interest",
	"taxes_contributions",
	"other_costs",
];

function csv(book: KpoBook): string {
	const cell = (value: string | number) => (/[",;\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));
	const major = (value: number | undefined) => ((value ?? 0) / 100).toFixed(2);
	const header = ["sequence", "entry", "date", "description", ...COLUMNS];
	const rows = book.rows.map((row) => [
		row.sequence ?? "",
		row.number,
		new Date(row.date).toISOString().slice(0, 10),
		row.description,
		...COLUMNS.map((column) => major(row.amounts[column])),
	]);
	rows.push(["", "", "", "total", ...COLUMNS.map((column) => major(book.totals[column]))]);
	return [header, ...rows].map((row) => row.map(cell).join(",")).join("\n") + "\n";
}

export async function kpoView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const currency = baseCurrency(project);
	const year = yearSelect(new Date().getFullYear());
	const body = el("div", { class: "stack" });
	let loaded: KpoBook | null = null;
	const download = el("button", { class: "button ghost", type: "button", disabled: true }, t("stats.download_csv"));
	download.addEventListener("click", () => {
		if (loaded) saveFile(new Blob([csv(loaded)], { type: "text/csv;charset=utf-8" }), `kpo-${loaded.year}.csv`);
	});

	const render = async () => {
		try {
			const book = await Api.kpoBook(uuid, Number(year.value));
			loaded = book;
			download.disabled = book.rows.length === 0;
			const used = COLUMNS.filter((column) => book.totals[column] !== 0);
			const summary = summaryCards([
				[t("kpo.revenue"), formatMoney(book.revenue, currency)],
				[t("kpo.expenses"), formatMoney(book.expenses, currency)],
				[t("kpo.result"), formatMoney(book.result, currency)],
			]);
			body.replaceChildren(
				notices(project, book.issues),
				summary,
				book.rows.length === 0
					? emptyState(t("accounting.journal_empty"))
					: el(
							"div",
							{ class: "ledger-wide" },
							table(
								[t("kpo.sequence"), t("accounting.date"), t("accounting.description"), ...used.map((column) => numeric(t(`kpo.column_${column}` as UiKey)))],
								[
									...book.rows.map((row) =>
										el(
											"tr",
											{},
											el("td", { class: "code" }, String(row.sequence ?? "")),
											el("td", { class: "date" }, formatDate(row.date, project.date_format as DateFormat, project.timezone)),
											el("td", {}, row.description, el("div", { class: "muted mono" }, row.number)),
											...used.map((column) => moneyCell(row.amounts[column], currency))
										)
									),
									el(
										"tr",
										{ class: "total-row" },
										el("td", {}),
										el("td", {}),
										el("td", {}, el("strong", {}, t("accounting.total"))),
										...used.map((column) => moneyCell(book.totals[column], currency, { strong: true }))
									),
								]
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
		"kpo",
		{ title: t("kpo.title"), intro: t("kpo.intro"), actions: [download] },
		el("div", { class: "ledger-controls" }, field(t("statements.year"), year)),
		body
	);
}
