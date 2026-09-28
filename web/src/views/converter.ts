import { el, field, input } from "../dom";
import { minorUnitDigits } from "../money";
import { convertAmount, currencyOptions, currencyRates } from "../currencies";
import { staticCombobox } from "../combobox";
import { t } from "../i18n";

function formatAmount(value: number, currency: string): string {
	try {
		return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
	} catch {
		return `${value.toFixed(minorUnitDigits(currency))} ${currency}`;
	}
}

function formatRate(value: number): string {
	const digits = value >= 1 ? 4 : 8;
	return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export async function converterView(): Promise<HTMLElement> {
	const known = await currencyRates();

	const amount = input("number", { value: "100", min: "0", step: "any" });
	const from = staticCombobox(currencyOptions(known.currencies, "EUR"), "EUR", { required: true, emptyText: t("currency.no_match") });
	const to = staticCombobox(currencyOptions(known.currencies, "USD"), "USD", { required: true, emptyText: t("currency.no_match") });

	const result = el("div", { class: "convert-result" });

	const recalculate = () => {
		if (!known.live) {
			result.replaceChildren(el("p", { class: "warn" }, t("converter.no_live_rates")));
			return;
		}

		const typed = amount.value.trim();
		const value = Number(typed);

		if (typed === "" || !Number.isFinite(value)) {
			result.replaceChildren(el("p", { class: "muted" }, t("converter.enter_amount")));
			return;
		}

		const converted = convertAmount(value, from.value, to.value, known.rates);
		const unit = convertAmount(1, from.value, to.value, known.rates);

		if (converted === null || unit === null) {
			result.replaceChildren(el("p", { class: "warn" }, t("converter.no_pair")));
			return;
		}

		result.replaceChildren(
			el("p", { class: "convert-value mono" }, formatAmount(converted, to.value)),
			el("p", { class: "muted" }, `1 ${from.value} = ${formatRate(unit)} ${to.value}`),
			el("p", { class: "muted" }, `1 ${to.value} = ${formatRate(1 / unit)} ${from.value}`)
		);
	};

	const swap = el(
		"button",
		{
			class: "button ghost",
			type: "button",
			onClick: () => {
				const previous = from.selected;
				from.select(to.selected);
				to.select(previous);
				recalculate();
			},
		},
		t("converter.swap")
	);

	amount.addEventListener("input", recalculate);
	from.onChange(recalculate);
	to.onChange(recalculate);

	recalculate();

	return el(
		"div",
		{ class: "page" },
		el("div", { class: "page-head" }, el("div", {}, el("a", { class: "back-link", href: "/" }, t("project.all_projects")), el("h1", {}, t("converter.title")))),
		el(
			"div",
			{ class: "card" },
			el("div", { class: "form-grid" }, field(t("converter.from"), from.element), field(t("converter.to"), to.element), field(t("converter.amount"), amount)),
			el("div", { class: "form-actions" }, swap),
			result,
			el("p", { class: "muted" }, known.live ? t("converter.rates_note", { base: known.base }) : t("converter.rates_source"))
		)
	);
}
