import { Api, type InvoiceExportSelection, type InvoiceExportSummary, type Project } from "../api";
import { combobox } from "../combobox";
import { el, field, input, saveFile, select } from "../dom";
import { formatDate, toDateInput } from "../money";
import { modal, reportError } from "../ui";
import { t, tn, type UiKey } from "../i18n";
import type { ComboOption } from "../../../server/option-search";
import type { DateFormat } from "../../../server/formats";

type Mode = InvoiceExportSelection["kind"];
type Preset = "previous_month" | "this_month" | "previous_quarter" | "this_year" | "previous_year";

const PRESETS: Preset[] = ["previous_month", "this_month", "previous_quarter", "this_year", "previous_year"];
const CUSTOM = "custom";

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function monthRange(year: number, firstMonth: number, months: number): { from: string; to: string } {
	const start = new Date(Date.UTC(year, firstMonth - 1, 1));
	const end = new Date(Date.UTC(year, firstMonth - 1 + months, 0));
	return {
		from: `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-01`,
		to: `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}`,
	};
}

export function presetRange(preset: Preset, today: string): { from: string; to: string } {
	const [year, month] = today.split("-").map(Number);
	if (preset === "this_month") return monthRange(year, month, 1);
	if (preset === "previous_month") return monthRange(year, month - 1, 1);
	if (preset === "previous_quarter") return monthRange(year, Math.floor((month - 1) / 3) * 3 - 2, 3);
	if (preset === "this_year") return monthRange(year, 1, 12);
	return monthRange(year - 1, 1, 12);
}

function issuedInvoiceSearch(uuid: string, dateFormat: DateFormat, timezone: string) {
	return async (query: string): Promise<ComboOption[]> => {
		const found = await Api.invoices(uuid, { reference: query.trim() || undefined, limit: 30 });
		return found.invoices
			.filter((invoice) => invoice.status !== "draft" && invoice.issued_at !== null)
			.map((invoice) => ({
				value: invoice.reference,
				label: invoice.reference,
				hint: [formatDate(invoice.issued_at!, dateFormat, timezone), invoice.customer_name || invoice.customer_email].filter(Boolean).join("\n"),
			}));
	};
}

export function invoiceExportDialog(uuid: string, project: Project) {
	const dateFormat = project.date_format as DateFormat;
	const timezone = project.timezone;
	const today = toDateInput(Date.now(), timezone);
	const initial = presetRange("previous_month", today);
	let mode: Mode = "period";
	let summary: InvoiceExportSummary | null = null;
	let round = 0;
	let downloading = false;
	let debounce: ReturnType<typeof setTimeout>;

	const preset = select(
		[...PRESETS.map((value) => ({ value, label: t(`export.preset_${value}` as UiKey) })), { value: CUSTOM, label: t("export.preset_custom") }],
		"previous_month"
	);
	const from = input("date", { value: initial.from, required: true });
	const to = input("date", { value: initial.to, required: true });
	const periodFields = el(
		"div",
		{ class: "stack-tight" },
		field(t("export.period"), preset),
		el("div", { class: "form-grid" }, field(t("export.from_date"), from), field(t("export.to_date"), to))
	);

	const search = issuedInvoiceSearch(uuid, dateFormat, timezone);
	const first = combobox({ search, placeholder: t("export.number_placeholder"), emptyText: t("export.no_number_match") });
	const last = combobox({ search, placeholder: t("export.number_placeholder"), emptyText: t("export.no_number_match") });
	const numberFields = el(
		"div",
		{ class: "stack-tight" },
		el("div", { class: "form-grid" }, field(t("export.first_number"), first.element), field(t("export.last_number"), last.element)),
		el("p", { class: "field-hint" }, t("export.numbers_hint"))
	);

	const toggle = el("div", { class: "segmented" });
	toggle.setAttribute("role", "radiogroup");
	const modes = (["period", "numbers"] as const).map((value) => {
		const button = el("button", { type: "button", class: "segment" }, t(`export.mode_${value}` as UiKey));
		button.setAttribute("role", "radio");
		button.addEventListener("click", () => {
			mode = value;
			syncMode();
			void refresh();
		});
		toggle.append(button);
		return { value, button };
	});

	const status = el("p", { class: "export-summary muted" });
	status.setAttribute("role", "status");
	status.setAttribute("aria-live", "polite");
	const download = el("button", { class: "button primary", type: "submit", disabled: true }, t("export.download"));

	const selection = (): InvoiceExportSelection | null => {
		if (mode === "period") return from.value && to.value && from.value <= to.value ? { kind: "period", from: from.value, to: to.value } : null;
		return first.value && last.value ? { kind: "numbers", first: first.value, last: last.value } : null;
	};

	const syncMode = () => {
		periodFields.hidden = mode !== "period";
		numberFields.hidden = mode !== "numbers";
		for (const entry of modes) {
			entry.button.classList.toggle("active", entry.value === mode);
			entry.button.setAttribute("aria-checked", String(entry.value === mode));
		}
	};

	const syncDownload = () => {
		const ready = summary !== null && summary.count > 0 && summary.count <= summary.limit;
		download.disabled = downloading || !ready;
		download.textContent = downloading
			? t("export.preparing")
			: ready
				? t("export.download_count", { count: tn("count.invoices", summary!.count) })
				: t("export.download");
	};

	const show = (text: string, warn = false) => {
		status.textContent = text;
		status.classList.toggle("warn", warn);
		status.classList.toggle("muted", !warn);
	};

	const describe = (found: InvoiceExportSummary) => {
		if (found.count === 0 || !found.first || !found.last) return show(t("export.none"));
		const range = t("export.summary", {
			count: tn("count.invoices", found.count),
			first: found.first.reference,
			first_date: formatDate(found.first.issued_at, dateFormat, timezone),
			last: found.last.reference,
			last_date: formatDate(found.last.issued_at, dateFormat, timezone),
		});
		if (found.count > found.limit) return show(`${range} ${t("export.too_many", { limit: found.limit })}`, true);
		show(range);
	};

	const refresh = async () => {
		const current = ++round;
		const chosen = selection();
		summary = null;
		syncDownload();
		if (!chosen) return show(mode === "period" ? t("export.choose_period") : t("export.choose_numbers"));
		show(t("ui.loading"));
		try {
			const found = await Api.invoiceExportSummary(uuid, chosen);
			if (current !== round) return;
			summary = found;
			describe(found);
		} catch (error) {
			if (current !== round) return;
			show(t("ui.load_failed"), true);
			reportError(error);
		}
		syncDownload();
	};

	const refreshSoon = () => {
		clearTimeout(debounce);
		debounce = setTimeout(() => void refresh(), 250);
	};

	preset.addEventListener("change", () => {
		if (preset.value === CUSTOM) return from.focus();
		const range = presetRange(preset.value as Preset, today);
		from.value = range.from;
		to.value = range.to;
		void refresh();
	});
	for (const date of [from, to]) {
		date.addEventListener("input", () => {
			preset.value = PRESETS.find((value) => presetRange(value, today).from === from.value && presetRange(value, today).to === to.value) ?? CUSTOM;
			refreshSoon();
		});
	}
	first.onChange(() => void refresh());
	last.onChange(() => void refresh());

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event: Event) => {
				event.preventDefault();
				const chosen = selection();
				if (!chosen || download.disabled) return;
				downloading = true;
				syncDownload();
				try {
					const file = await Api.invoiceExportZip(uuid, chosen);
					saveFile(file.blob, file.name);
					dialog.close();
				} catch (error) {
					reportError(error);
				} finally {
					downloading = false;
					syncDownload();
				}
			},
		},
		el("p", { class: "muted" }, t("export.intro")),
		toggle,
		periodFields,
		numberFields,
		status,
		el("div", { class: "dialog-actions" }, download)
	);

	const dialog = modal(t("export.title"), form, () => {
		clearTimeout(debounce);
		round++;
	});
	syncMode();
	void refresh();
}
