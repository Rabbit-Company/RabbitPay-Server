import { Api, type AjpesReport } from "../api";
import { el, replaceContent, field, input, saveFile, table } from "../dom";
import { t } from "../i18n";
import { can, Permission } from "../access";
import { reportError } from "../ui";
import { loadProject } from "./project";
import { currentYear, ledgerPage, moneyCell, notices, numeric, section, yearSelect } from "./accounting";

export async function ajpesView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const year = yearSelect(currentYear(project) - 1);
	const showAll = input("checkbox");
	const body = el("div", { class: "stack" });
	const form = el("span", { class: "muted" });
	const download = el("button", { class: "button primary", type: "button" }, t("ajpes.download"));
	download.hidden = !can(project, Permission.REPORT_EXPORT);
	download.addEventListener("click", async () => {
		try {
			const file = await Api.ajpesXml(uuid, Number(year.value));
			saveFile(file.blob, file.name);
		} catch (error) {
			reportError(error);
		}
	});

	const aopSection = (report: AjpesReport, title: string, lines: AjpesReport["balance_sheet"]) => {
		const visible = showAll.checked ? lines : lines.filter((line) => line.current !== 0 || line.previous !== 0);
		return section(
			title,
			table(
				[t("ajpes.aop"), t("statements.item"), numeric(String(report.year)), numeric(String(report.year - 1))],
				visible.map((line) =>
					el(
						"tr",
						{},
						el("td", { class: "code" }, line.aop),
						el("td", {}, line.total ? el("strong", {}, line.label) : line.label),
						moneyCell(line.current, report.currency, { strong: line.total }),
						moneyCell(line.previous, report.currency, { muted: true })
					)
				)
			)
		);
	};

	const render = async () => {
		try {
			const report = await Api.ajpesReport(uuid, Number(year.value));
			form.textContent = t(report.form === "company" ? "ajpes.form_company" : "ajpes.form_sole_trader");
			replaceContent(
				body,
				notices(project, report.issues),
				report.balanced ? null : el("div", { class: "ledger-notice" }, el("p", { class: "warn" }, t("ajpes.unbalanced"))),
				aopSection(report, t("ajpes.balance_sheet"), report.balance_sheet),
				aopSection(report, t("ajpes.income_statement"), report.income_statement)
			);
		} catch (error) {
			reportError(error);
		}
	};
	year.addEventListener("change", () => void render());
	showAll.addEventListener("change", () => void render());
	await render();

	return ledgerPage(
		project,
		"ajpes",
		{ title: t("ajpes.title"), intro: t("ajpes.intro"), actions: [download] },
		el(
			"div",
			{ class: "ledger-controls" },
			field(t("statements.year"), year),
			el("label", { class: "switch" }, showAll, el("span", {}, t("ajpes.show_all"))),
			form
		),
		body
	);
}
