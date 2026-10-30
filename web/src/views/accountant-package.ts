import { Api, type AccountantPackageSummary, type PackageSection, type PackageSettings, type PackageStatus, type Project } from "../api";
import { el, field, input, saveFile, select } from "../dom";
import { dayStartFromDateInput, formatDate, formatMoney, toDateInput } from "../money";
import { formatDateTime, type DateFormat, type TimeFormat } from "../../../server/formats";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { t, tn, type UiKey } from "../i18n";
import { presetRange } from "./invoice-export";
import type { PackageCheck } from "../../../server/accountant-package-types";

type Preset = "previous_month" | "this_month" | "previous_quarter" | "this_year" | "previous_year";

const PRESETS: Preset[] = ["previous_month", "this_month", "previous_quarter", "this_year", "previous_year"];
const CUSTOM = "custom";

const SECTIONS: {
	key: keyof Pick<AccountantPackageSummary, "issued" | "credit_notes" | "received_domestic" | "received_foreign" | "received_on_spot">;
	label: UiKey;
}[] = [
	{ key: "issued", label: "package.issued" },
	{ key: "credit_notes", label: "package.credit_notes" },
	{ key: "received_domestic", label: "package.received_domestic" },
	{ key: "received_foreign", label: "package.received_foreign" },
	{ key: "received_on_spot", label: "package.received_on_spot" },
];

const CHECKS: Record<string, UiKey> = {
	missing_original: "package.check_missing_original",
	missing_rate: "package.check_missing_rate",
	unpaid_received: "package.check_unpaid_received",
	document_unavailable: "package.check_document_unavailable",
	bank_unmatched: "package.check_bank_unmatched",
	bank_missing: "package.check_bank_missing",
};

function checkText(check: PackageCheck): string {
	const key = CHECKS[check.code];
	if (key) return t(key, { reference: check.reference ?? "", detail: check.detail ?? "" }).trim();
	return [check.reference, check.detail].filter(Boolean).join(" | ");
}

function amount(value: number, currency: string): string {
	return formatMoney(value, currency)
		.replace(/\s+(?=\S+$)/, "\u00a0")
		.replace(/^(\S+)\s+/, "$1\u00a0");
}

function statCard(value: string, label: string, detail: string): HTMLElement {
	return el(
		"div",
		{ class: "card stat" },
		el("span", { class: "stat-value mono" }, value),
		el("span", { class: "stat-label" }, label),
		el("span", { class: "muted" }, detail)
	);
}

function sectionCard(label: string, section: PackageSection, currency: string): HTMLElement {
	return el(
		"div",
		{ class: "card stat" },
		el("span", { class: "stat-value mono" }, amount(section.total, currency)),
		el("span", { class: "stat-label" }, label),
		el("span", { class: "muted" }, `${tn("count.documents", section.count)} | ${t("package.vat_amount", { amount: formatMoney(section.vat, currency) })}`)
	);
}

function changeList(title: string, labels: string[]): HTMLElement | null {
	if (labels.length === 0) return null;
	return el(
		"div",
		{},
		el("strong", {}, `${title} (${labels.length})`),
		el(
			"ul",
			{ class: "recent" },
			...labels.slice(0, 10).map((label) => el("li", {}, label)),
			labels.length > 10 ? el("li", { class: "muted" }, t("package.checks_more", { count: labels.length - 10 })) : null
		)
	);
}

function settingsDialog(uuid: string, current: PackageSettings, onSaved: (settings: PackageSettings) => void) {
	const recipients = input("text", { value: current.recipients.join(", "), placeholder: "racunovodstvo@example.com", maxlength: "1300" });
	const day = select(
		[
			{ value: "", label: t("package.send_manual") },
			...Array.from({ length: 28 }, (_, index) => ({ value: String(index + 1), label: t("package.send_day_option", { day: index + 1 }) })),
		],
		current.send_day === null ? "" : String(current.send_day)
	);
	const save = el("button", { class: "button primary", type: "submit" }, t("ui.save"));
	const form = el(
		"form",
		{ class: "stack" },
		field(t("package.recipients"), recipients, t("package.recipients_hint")),
		field(t("package.send_day"), day, t("package.send_day_hint")),
		el("div", { class: "dialog-actions" }, save)
	);
	const dialog = modal(t("package.settings_title"), form);
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		save.disabled = true;
		try {
			const saved = await Api.saveAccountantPackageSettings(uuid, {
				recipients: recipients.value
					.split(/[,;\s]+/)
					.map((entry) => entry.trim())
					.filter(Boolean),
				send_day: day.value ? Number(day.value) : null,
			});
			toast(t("package.settings_saved"), "success");
			dialog.close();
			onSaved(saved);
		} catch (error) {
			reportError(error);
		} finally {
			save.disabled = false;
		}
	});
}

export function accountantPackageSection(uuid: string, project: Project): HTMLElement {
	const dateFormat = project.date_format as DateFormat;
	const when = (timestamp: number) => formatDateTime(timestamp, dateFormat, project.time_format as TimeFormat, project.timezone);
	let settings: PackageSettings | null = null;
	const settingsLine = el("p", { class: "field-hint" });
	const statusBody = el("div", { class: "stack" });
	const send = el("button", { class: "button primary", type: "button", disabled: true }, t("package.send"));
	const settingsButton = el("button", { class: "button ghost", type: "button" }, t("package.settings"));
	const showSettings = () => {
		if (!settings || settings.recipients.length === 0) {
			settingsLine.textContent = t("package.no_recipients");
			return;
		}
		const recipients = settings.recipients.join(", ");
		settingsLine.textContent = settings.next_run
			? t("package.settings_auto", {
					recipients,
					date: formatDate(dayStartFromDateInput(settings.next_run, project.timezone), dateFormat, project.timezone),
				})
			: t("package.settings_manual", { recipients });
	};
	settingsButton.addEventListener("click", () =>
		settingsDialog(uuid, settings ?? { recipients: [], send_day: null, next_run: null, updated: null }, (saved) => {
			settings = saved;
			showSettings();
			syncButtons();
		})
	);
	void Api.accountantPackageSettings(uuid)
		.then((loaded) => {
			settings = loaded;
			showSettings();
			syncButtons();
		})
		.catch(reportError);
	const today = toDateInput(Date.now(), project.timezone);
	const initial = presetRange("previous_month", today);
	const preset = select(
		[...PRESETS.map((value) => ({ value, label: t(`export.preset_${value}` as UiKey) })), { value: CUSTOM, label: t("export.preset_custom") }],
		"previous_month"
	);
	const from = input("date", { value: initial.from, required: true });
	const to = input("date", { value: initial.to, required: true });
	const body = el("div", { class: "stack" });
	const overview = el("button", { class: "button ghost", type: "button", disabled: true }, t("package.download_overview"));
	const download = el("button", { class: "button ghost", type: "button", disabled: true }, t("package.download"));
	let summary: AccountantPackageSummary | null = null;
	let round = 0;
	let debounce: ReturnType<typeof setTimeout>;

	const endOf = (date: string) => dayStartFromDateInput(date, project.timezone);
	const period = () => (from.value && to.value && from.value <= to.value ? { from: from.value, to: to.value } : null);

	const syncButtons = (busy = false) => {
		const total = summary ? SECTIONS.reduce((sum, section) => sum + summary![section.key].count, 0) : 0;
		overview.disabled = busy || summary === null;
		download.disabled = busy || summary === null || total === 0 || total > summary.limit;
		send.disabled = busy || summary === null || total > (summary?.limit ?? 0) || !settings || settings.recipients.length === 0;
	};

	const showStatus = (status: PackageStatus, chosen: { from: string; to: string }) => {
		send.textContent = t(status.sends.length > 0 ? "package.send_again" : "package.send");
		send.className = "button primary";
		if (status.sends.length === 0) {
			statusBody.replaceChildren();
			return;
		}
		const history = el(
			"ul",
			{ class: "recent" },
			...status.sends
				.slice(0, 5)
				.map((entry) =>
					el(
						"li",
						{},
						el("strong", {}, t(entry.kind === "changes" ? "package.sent_changes" : "package.sent_full")),
						" ",
						el(
							"span",
							{ class: "muted" },
							[when(entry.created), entry.recipients.join(", "), entry.automatic ? t("package.sent_automatic") : null].filter(Boolean).join(" | ")
						)
					)
				)
		);
		const changes = status.changes;
		send.className = changes ? "button ghost" : "button primary";
		const sendChanges = el("button", { class: "button primary", type: "button" }, t("package.send_changes"));
		sendChanges.addEventListener("click", async () => {
			sendChanges.disabled = true;
			try {
				await Api.sendAccountantPackage(uuid, { ...chosen, kind: "changes" });
				toast(t("package.sent_toast", { recipients: settings?.recipients.join(", ") ?? "" }), "success");
				await loadStatus(chosen);
			} catch (error) {
				reportError(error);
				sendChanges.disabled = false;
			}
		});
		statusBody.replaceChildren(
			el("div", { class: "card" }, el("h3", {}, t("package.sent_title")), history),
			...(changes
				? [
						el(
							"div",
							{ class: "card notice stack" },
							el("h3", {}, t("package.changed_since", { date: when(changes.since) })),
							el("p", { class: "muted" }, t("package.changed_hint")),
							changeList(t("package.changes_added"), changes.added),
							changeList(t("package.changes_changed"), changes.changed),
							changeList(t("package.changes_removed"), changes.removed),
							settings && settings.recipients.length > 0 ? el("div", { class: "line-actions" }, sendChanges) : null
						),
					]
				: [])
		);
	};

	const loadStatus = async (chosen: { from: string; to: string }) => {
		try {
			showStatus(await Api.accountantPackageStatus(uuid, chosen), chosen);
		} catch (error) {
			reportError(error);
		}
	};

	send.addEventListener("click", async () => {
		const chosen = period();
		if (!chosen || !settings) return;
		const again = send.textContent === t("package.send_again");
		const confirmed = await confirmDialog({
			title: t(again ? "package.send_again" : "package.send"),
			body: t("package.send_confirm", { recipients: settings.recipients.join(", ") }),
			confirmLabel: t(again ? "package.send_again" : "package.send"),
		});
		if (!confirmed) return;
		syncButtons(true);
		try {
			await Api.sendAccountantPackage(uuid, { ...chosen, kind: "full" });
			toast(t("package.sent_toast", { recipients: settings.recipients.join(", ") }), "success");
			await loadStatus(chosen);
		} catch (error) {
			reportError(error);
		} finally {
			syncButtons();
		}
	});

	const show = (found: AccountantPackageSummary) => {
		const currency = found.currency;
		const total = SECTIONS.reduce((sum, section) => sum + found[section.key].count, 0);
		const vat = found.vat_return;
		const liability = vat ? vat.fields["51"] > 0 || vat.fields["52"] === 0 : true;
		body.replaceChildren(
			el(
				"div",
				{ class: "stats-totals" },
				...SECTIONS.map((section) => sectionCard(t(section.label), found[section.key], currency)),
				vat
					? el(
							"div",
							{ class: "card stat" },
							el("span", { class: "stat-value mono" }, amount(vat.fields[liability ? "51" : "52"], currency)),
							el("span", { class: "stat-label" }, t(liability ? "package.vat_liability" : "package.vat_surplus")),
							el("span", { class: "muted" }, t("package.vat_from_evidence"))
						)
					: null
			),
			el(
				"div",
				{ class: "stats-totals" },
				statCard(
					amount(found.open_items.receivable, currency),
					t("package.open_receivable", { date: formatDate(endOf(found.period.to), project.date_format as DateFormat, project.timezone) }),
					tn("count.documents", found.open_items.receivable_count)
				),
				statCard(
					amount(found.open_items.payable, currency),
					t("package.open_payable", { date: formatDate(endOf(found.period.to), project.date_format as DateFormat, project.timezone) }),
					tn("count.documents", found.open_items.payable_count)
				),
				statCard(
					found.bank.lines > 0 ? String(found.bank.lines) : "-",
					t("package.bank"),
					found.bank.lines > 0
						? t("package.bank_unmatched", { count: found.bank.unmatched })
						: t(found.bank.used ? "package.bank_none_period" : "package.bank_not_used")
				)
			),
			...(total > found.limit ? [el("p", { class: "warn-text" }, t("error.1372"))] : []),
			found.checks.length
				? el(
						"div",
						{ class: "card notice" },
						el("h3", {}, t("package.checks", { count: found.checks.length })),
						el(
							"ul",
							{ class: "recent" },
							...found.checks.slice(0, 20).map((check) => el("li", {}, checkText(check))),
							found.checks.length > 20 ? el("li", { class: "muted" }, t("package.checks_more", { count: found.checks.length - 20 })) : null
						)
					)
				: total > 0
					? el("div", {}, el("span", { class: "pill pill-paid" }, t("package.ready")))
					: el("p", { class: "muted" }, t("package.empty"))
		);
		syncButtons();
	};

	const refresh = async () => {
		const current = ++round;
		const chosen = period();
		summary = null;
		syncButtons();
		statusBody.replaceChildren();
		if (!chosen) {
			body.replaceChildren();
			return;
		}
		body.replaceChildren(el("p", { class: "muted" }, t("package.loading")));
		try {
			const found = await Api.accountantPackage(uuid, chosen);
			if (current !== round) return;
			summary = found;
			show(found);
			void loadStatus(chosen);
		} catch (error) {
			if (current !== round) return;
			body.replaceChildren();
			reportError(error);
		}
	};

	const schedule = () => {
		clearTimeout(debounce);
		debounce = setTimeout(() => void refresh(), 250);
	};

	preset.addEventListener("change", () => {
		if (preset.value === CUSTOM) return;
		const range = presetRange(preset.value as Preset, today);
		from.value = range.from;
		to.value = range.to;
		void refresh();
	});
	for (const control of [from, to])
		control.addEventListener("input", () => {
			preset.value = CUSTOM;
			schedule();
		});

	const fetchFile = async (button: HTMLButtonElement, label: UiKey, load: (range: { from: string; to: string }) => Promise<{ blob: Blob; name: string }>) => {
		const chosen = period();
		if (!chosen) return;
		syncButtons(true);
		button.textContent = t("package.preparing");
		try {
			const file = await load(chosen);
			saveFile(file.blob, file.name);
		} catch (error) {
			reportError(error);
		} finally {
			button.textContent = t(label);
			syncButtons();
		}
	};
	overview.addEventListener("click", () => fetchFile(overview, "package.download_overview", (range) => Api.accountantPackageOverview(uuid, range)));
	download.addEventListener("click", () => fetchFile(download, "package.download", (range) => Api.accountantPackageZip(uuid, range)));

	void refresh();
	return el(
		"div",
		{ class: "stack package-section" },
		el("div", { class: "toolbar" }, el("h2", { class: "toolbar-title" }, t("package.title")), settingsButton),
		el("p", { class: "muted" }, t("package.intro")),
		el("div", { class: "grid" }, field(t("export.period"), preset), field(t("expenses.from"), from), field(t("expenses.to"), to)),
		body,
		statusBody,
		el("div", { class: "line-actions" }, overview, download, send),
		settingsLine
	);
}
