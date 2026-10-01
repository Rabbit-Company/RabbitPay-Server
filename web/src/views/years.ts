import { Api, ApiError, type AccountingYear, type Project, type RevaluationPreview, type YearCloseRefusal } from "../api";
import { el, emptyState, field, input, table } from "../dom";
import { formatDate, formatMoney } from "../money";
import { t, type UiKey } from "../i18n";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { loadProject } from "./project";
import { baseCurrency, currentYear, editable, ledgerPage, licenseNotice, moneyCell, numeric } from "./accounting";
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

async function revaluationDialog(project: Project, year: AccountingYear, onDone: () => void) {
	const initial = await Api.revaluation(project.uuid, year.year);
	const rates = new Map(initial.currencies.map((currency) => [currency, input("number", { min: "0", step: "0.000001", required: true })]));
	const preview = el("div", { class: "stack" });
	const submit = el("button", { class: "button primary", type: "submit", disabled: true }, t("years.revalue_submit"));
	const values = () => {
		const result: Record<string, number> = {};
		for (const [currency, field] of rates) if (Number(field.value) > 0) result[currency] = Number(field.value);
		return result;
	};
	const show = (result: RevaluationPreview) => {
		preview.replaceChildren(
			table(
				[
					t("years.revalue_document"),
					t("years.revalue_partner"),
					numeric(t("years.revalue_open")),
					numeric(t("years.revalue_booked")),
					numeric(t("years.revalue_revalued")),
					numeric(t("years.revalue_difference")),
				],
				result.items.map((item) =>
					el(
						"tr",
						{},
						el("td", {}, item.reference ?? "", el("div", { class: "muted mono" }, item.account)),
						el("td", {}, item.partner ?? ""),
						moneyCell(item.open, item.currency, { zero: true }),
						moneyCell(item.booked, result.currency, { zero: true }),
						moneyCell(item.revalued, result.currency, { zero: true }),
						moneyCell(item.difference, result.currency, { warn: (item.difference ?? 0) < 0 })
					)
				)
			),
			el("p", { class: "mono" }, t("years.revalue_total", { amount: formatMoney(result.difference, result.currency) }))
		);
		submit.disabled = result.posted !== null || result.currencies.some((currency) => !(values()[currency] > 0));
	};
	for (const field of rates.values())
		field.addEventListener("change", async () => {
			try {
				show(await Api.previewRevaluation(project.uuid, year.year, values()));
			} catch (error) {
				reportError(error);
			}
		});
	show(initial);

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					await Api.postRevaluation(project.uuid, year.year, values());
					dialog.close();
					toast(t("years.revalued", { year: year.year }));
					onDone();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, t("years.revalue_hint")),
		initial.posted !== null ? el("p", { class: "warn" }, t("years.revalue_posted", { year: year.year })) : null,
		initial.items.length === 0
			? emptyState(t("years.revalue_none", { year: year.year }))
			: el(
					"div",
					{ class: "stack" },
					el(
						"div",
						{ class: "grid" },
						...[...rates].map(([currency, rate]) => field(t("years.revalue_rate", { currency }), rate, t("years.revalue_rate_hint")))
					),
					preview,
					el("div", { class: "form-actions" }, submit)
				)
	);
	const dialog = modal(t("years.revalue_title", { year: year.year }), form);
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
										canEdit && !year.closed && year.entries > 0 && year.year < currentYear(project)
											? el("button", { class: "button ghost small", type: "button", onClick: () => close(year) }, t("years.close"))
											: null,
										canEdit && !year.closed && year.entries > 0 && year.year < currentYear(project)
											? el(
													"button",
													{
														class: "button ghost small",
														type: "button",
														onClick: () => void revaluationDialog(project, year, () => void render()).catch(reportError),
													},
													t("years.revalue")
												)
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
