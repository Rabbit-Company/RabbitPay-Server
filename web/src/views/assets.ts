import { Api, type AssetCandidate, type AssetCategory, type FixedAsset, type Project } from "../api";
import { el, replaceContent, emptyState, field, input, select, table } from "../dom";
import { dayStartFromDateInput, formatDate, toDateInput, toMinorUnits } from "../money";
import { t, type UiKey } from "../i18n";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { loadProject } from "./project";
import { baseCurrency, editable, ledgerPage, licenseNotice, moneyCell, numeric, section } from "./accounting";
import type { DateFormat } from "../../../server/formats";

const CATEGORIES: AssetCategory[] = ["equipment", "computer", "intangible", "building", "small_inventory"];

function categoryLabel(category: AssetCategory): string {
	return t(`assets.category_${category}` as UiKey);
}

function assetDialog(project: Project, rates: Record<AssetCategory, number>, onSaved: () => void) {
	const currency = baseCurrency(project);
	const timezone = project.timezone;
	const name = input("text", { maxlength: "250", required: true });
	const category = select(
		CATEGORIES.map((value) => ({ value, label: categoryLabel(value) })),
		"equipment"
	);
	const acquired = input("date", { required: true, value: toDateInput(Date.now(), timezone) });
	const value = input("number", { min: "0.01", step: "0.01", required: true });
	const accumulated = input("number", { min: "0", step: "0.01", value: "0" });
	const from = input("date", {});
	const rate = input("number", { min: "0.01", max: "100", step: "0.01", required: true, value: String(rates.equipment) });
	category.addEventListener("change", () => (rate.value = String(rates[category.value as AssetCategory])));
	const submit = el("button", { class: "button primary", type: "submit" }, t("ui.save"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					await Api.createFixedAsset(project.uuid, {
						name: name.value.trim(),
						asset_category: category.value as AssetCategory,
						acquired_at: dayStartFromDateInput(acquired.value, timezone),
						acquisition_value: toMinorUnits(Number(value.value), currency),
						accumulated_before: toMinorUnits(Number(accumulated.value || 0), currency),
						depreciation_from: from.value ? dayStartFromDateInput(from.value, timezone) : undefined,
						annual_rate: Number(rate.value),
					});
					dialog.close();
					toast(t("assets.saved"));
					onSaved();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, t("assets.manual_hint")),
		el("div", { class: "grid" }, field(t("assets.name"), name), field(t("assets.category"), category)),
		el("div", { class: "grid" }, field(t("assets.acquired"), acquired), field(t("assets.value"), value), field(t("assets.rate"), rate, t("assets.rate_hint"))),
		el(
			"div",
			{ class: "grid" },
			field(t("assets.accumulated_before"), accumulated, t("assets.accumulated_before_hint")),
			field(t("assets.depreciation_from"), from, t("assets.depreciation_from_hint"))
		),
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(t("assets.new"), form);
	name.focus();
}

function disposeDialog(project: Project, asset: FixedAsset, onSaved: () => void) {
	const date = input("date", { required: true, value: toDateInput(Date.now(), project.timezone) });
	const submit = el("button", { class: "button primary", type: "submit" }, t("assets.dispose"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					await Api.updateFixedAsset(project.uuid, asset.uuid, { disposed_at: dayStartFromDateInput(date.value, project.timezone) });
					dialog.close();
					onSaved();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, t("assets.dispose_hint")),
		field(t("assets.disposed_at"), date),
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(t("assets.dispose_title", { name: asset.name }), form, undefined, "dialog-medium");
}

function candidateRow(project: Project, candidate: AssetCandidate, onSaved: () => void): HTMLElement {
	const currency = baseCurrency(project);
	const category = select(candidate.categories.map((value) => ({ value, label: categoryLabel(value) })));
	return el(
		"tr",
		{},
		el("td", {}, candidate.name, candidate.supplier ? el("div", { class: "muted" }, candidate.supplier) : null),
		el("td", { class: "date" }, formatDate(candidate.acquired_at, project.date_format as DateFormat, project.timezone)),
		moneyCell(candidate.value, currency),
		el("td", {}, category),
		el(
			"td",
			{ class: "actions" },
			el(
				"button",
				{
					class: "button primary small",
					type: "button",
					onClick: async () => {
						try {
							await Api.createFixedAsset(project.uuid, { expense: candidate.expense, asset_category: category.value as AssetCategory });
							toast(t("assets.saved"));
							onSaved();
						} catch (error) {
							reportError(error);
						}
					},
				},
				t("assets.register")
			)
		)
	);
}

export async function assetsView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const currency = baseCurrency(project);
	const dateFormat = project.date_format as DateFormat;
	const canEdit = editable(project);
	const body = el("div", { class: "stack" });
	let rates: Record<AssetCategory, number> | null = null;

	const render = async () => {
		try {
			const data = await Api.fixedAssets(uuid);
			rates = data.default_rates;
			const rows = data.assets.map((asset) =>
				el(
					"tr",
					{ class: asset.disposed_at ? "muted" : "" },
					el("td", {}, asset.name, el("div", { class: "muted" }, categoryLabel(asset.asset_category))),
					el("td", { class: "date" }, formatDate(asset.acquired_at, dateFormat, project.timezone)),
					moneyCell(asset.acquisition_value, currency, { zero: true }),
					el("td", { class: "num" }, `${asset.annual_rate} %`),
					moneyCell(asset.accumulated, currency, { zero: true }),
					moneyCell(asset.book_value, currency, { zero: true }),
					el(
						"td",
						{ class: "actions" },
						asset.disposed_at
							? el("span", {}, t("assets.disposed_on", { date: formatDate(asset.disposed_at, dateFormat, project.timezone) }))
							: canEdit
								? el(
										"button",
										{ class: "button ghost small", type: "button", onClick: () => disposeDialog(project, asset, () => void render()) },
										t("assets.dispose")
									)
								: null,
						canEdit
							? el(
									"button",
									{
										class: "button ghost small",
										type: "button",
										onClick: async () => {
											if (
												!(await confirmDialog({
													title: t("assets.delete_title"),
													body: t("assets.delete_body"),
													confirmLabel: t("ui.delete"),
													destructive: true,
												}))
											)
												return;
											try {
												await Api.deleteFixedAsset(uuid, asset.uuid);
												await render();
											} catch (error) {
												reportError(error);
											}
										},
									},
									t("ui.delete")
								)
							: null
					)
				)
			);
			replaceContent(
				body,
				data.candidates.length && canEdit
					? section(
							t("assets.candidates"),
							el("p", { class: "muted" }, t("assets.candidates_hint")),
							table(
								[t("assets.name"), t("assets.acquired"), numeric(t("assets.value")), t("assets.category"), ""],
								data.candidates.map((candidate) => candidateRow(project, candidate, () => void render()))
							)
						)
					: null,
				section(
					t("assets.register_title"),
					rows.length
						? table(
								[
									t("assets.name"),
									t("assets.acquired"),
									numeric(t("assets.value")),
									numeric(t("assets.rate")),
									numeric(t("assets.accumulated")),
									numeric(t("assets.book_value")),
									"",
								],
								rows
							)
						: emptyState(t("assets.empty"))
				)
			);
		} catch (error) {
			reportError(error);
		}
	};
	await render();

	return ledgerPage(
		project,
		"assets",
		{
			title: t("assets.title"),
			intro: t("assets.intro"),
			actions: [
				canEdit
					? el(
							"button",
							{
								class: "button primary",
								type: "button",
								dataset: { shortcutAction: "new-accounting-entry" },
								onClick: () => rates && assetDialog(project, rates, () => void render()),
							},
							t("assets.new")
						)
					: null,
			],
		},
		licenseNotice(project),
		body
	);
}
