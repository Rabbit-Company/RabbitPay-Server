import { Api, ApiError, type AccountingYear, type Project, type YearCloseRefusal } from "../api";
import { el, emptyState, field, input, table } from "../dom";
import { formatDate, formatMoney } from "../money";
import { t, type UiKey } from "../i18n";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { loadProject } from "./project";
import { baseCurrency, editable, ledgerPage, licenseNotice, numeric } from "./accounting";
import type { DateFormat } from "../../../server/formats";

function refusal(error: unknown): string | null {
	if (!(error instanceof ApiError) || typeof error.data !== "object" || error.data === null) return null;
	const reason = (error.data as { reason?: YearCloseRefusal }).reason;
	return reason ? t(`years.refused_${reason}` as UiKey) : null;
}

function reopenDialog(project: Project, year: AccountingYear, onDone: () => void) {
	const reason = input("text", { maxlength: "500", required: true });
	const submit = el("button", { class: "button primary", type: "submit" }, t("years.reopen"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					await Api.reopenAccountingYear(project.uuid, year.year, reason.value.trim());
					dialog.close();
					toast(t("years.reopened", { year: year.year }));
					onDone();
				} catch (error) {
					const message = refusal(error);
					if (message) toast(message);
					else reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, t("years.reopen_hint")),
		field(t("years.reason"), reason),
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(t("years.reopen_title", { year: year.year }), form, undefined, "dialog-medium");
}

function shareDialog(project: Project, year: AccountingYear, onDone: () => void) {
	const share = input("number", { min: "0", max: "100", step: "0.01", value: year.final_share === null ? "" : String(year.final_share) });
	const submit = el("button", { class: "button primary", type: "submit" }, t("ui.save"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					await Api.setDeductibleShare(project.uuid, year.year, share.value === "" ? null : Number(share.value));
					dialog.close();
					toast(t("years.share_saved"));
					onDone();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, t("years.share_hint", { count: year.provisional_expenses })),
		field(t("years.final_share"), share, t("years.final_share_hint")),
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(t("years.share_title", { year: year.year }), form, undefined, "dialog-medium");
	share.focus();
}

export async function yearsView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const currency = baseCurrency(project);
	const body = el("div", {});
	const canEdit = editable(project);

	const close = async (year: AccountingYear) => {
		const confirmed = await confirmDialog({
			title: t("years.close_title", { year: year.year }),
			body: t("years.close_body", { year: year.year, next: year.year + 1 }),
			confirmLabel: t("years.close"),
		});
		if (!confirmed) return;
		try {
			await Api.closeAccountingYear(uuid, year.year);
			toast(t("years.closed_toast", { year: year.year }));
			await render();
		} catch (error) {
			const message = refusal(error);
			if (message) toast(message);
			else reportError(error);
		}
	};

	const render = async () => {
		try {
			const { years } = await Api.accountingYears(uuid);
			body.replaceChildren(
				years.length === 0
					? emptyState(t("accounting.journal_empty"))
					: table(
							[t("years.year"), numeric(t("years.entries")), numeric(t("years.result")), numeric(t("years.final_share")), t("years.status"), ""],
							years.map((year) =>
								el(
									"tr",
									{},
									el("td", {}, el("strong", {}, String(year.year))),
									el("td", { class: "num" }, String(year.entries)),
									el(
										"td",
										{ class: year.result !== null && year.result < 0 ? "num warn" : "num" },
										year.result === null ? "" : formatMoney(year.result, currency),
										year.result === null ? null : el("div", { class: "muted" }, t(year.result >= 0 ? "years.profit" : "years.loss"))
									),
									el(
										"td",
										{ class: "num" },
										year.final_share === null ? "" : `${year.final_share} %${year.share_adjustment ? ` | ${formatMoney(year.share_adjustment, currency)}` : ""}`
									),
									el(
										"td",
										{},
										year.closed
											? el(
													"span",
													{ class: "pill pill-active" },
													year.closed_at
														? t("years.closed_on", { date: formatDate(year.closed_at, project.date_format as DateFormat, project.timezone) })
														: t("years.closed")
												)
											: el("span", { class: "pill pill-draft" }, t("years.open"))
									),
									el(
										"td",
										{ class: "actions" },
										canEdit && !year.closed && year.entries > 0 && year.year < new Date().getFullYear()
											? el("button", { class: "button ghost small", type: "button", onClick: () => close(year) }, t("years.close"))
											: null,
										canEdit && !year.closed && (year.provisional_expenses > 0 || year.final_share !== null)
											? el(
													"button",
													{ class: "button ghost small", type: "button", onClick: () => shareDialog(project, year, () => void render()) },
													t("years.set_share")
												)
											: null,
										canEdit && year.closed
											? el(
													"button",
													{ class: "button ghost small", type: "button", onClick: () => reopenDialog(project, year, () => void render()) },
													t("years.reopen")
												)
											: null
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

	return ledgerPage(project, "years", { title: t("years.title"), intro: t("years.intro") }, licenseNotice(project), body);
}
