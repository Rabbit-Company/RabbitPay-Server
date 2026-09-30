import { Api, type ImportColumn, type ImportResult, type Project, type RecordedInvoice, type RecordedInvoiceInput } from "../api";
import { csvImportDialog } from "../csv-import";
import { combobox } from "../combobox";
import { el, field, input, saveFile, select } from "../dom";
import { dayStartFromDateInput, formatDate, formatMoney, toDateInput, toMajorUnits, toMinorUnits } from "../money";
import { remoteTable } from "../pagination";
import { countryOptions } from "../countries";
import { taxTreatmentName, taxTreatmentOptions } from "../options";
import { t, type UiKey } from "../i18n";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { toBase64 } from "../image";
import { loadProject } from "./project";
import { baseCurrency, editable, ledgerPage, licenseNotice, moneyCell, numeric, period } from "./accounting";
import type { DateFormat } from "../../../server/formats";

interface LineControls {
	rate: HTMLInputElement;
	treatment: HTMLSelectElement;
	net: HTMLInputElement;
	tax: HTMLInputElement;
	row: HTMLElement;
	taxEdited: boolean;
}

function dateInput(value: number | null, timezone: string, required = false): HTMLInputElement {
	const control = input("date", { required, value: value === null ? "" : toDateInput(value, timezone) });
	return control;
}

function optionalDate(control: HTMLInputElement, timezone: string): number | null {
	return control.value ? dayStartFromDateInput(control.value, timezone) : null;
}

async function recordDialog(project: Project, existing: RecordedInvoice | null, onSaved: () => void, prefill?: RecordedInvoiceInput) {
	const buyers = (await Api.recordedBuyers(project.uuid).catch(() => ({ buyers: [] }))).buyers;
	const base = baseCurrency(project);
	const timezone = project.timezone;
	const documentType = select(
		[
			{ value: "invoice", label: t("recorded.type_invoice") },
			{ value: "credit_note", label: t("recorded.type_credit_note") },
		],
		existing?.document_type ?? "invoice"
	);
	const reference = input("text", { maxlength: "64", required: true, value: existing?.reference ?? "" });
	const buyerOptions = buyers.map((buyer, index) => ({
		value: String(index),
		label: buyer.name,
		hint: [buyer.vat_number, buyer.country].filter(Boolean).join(" | ") || undefined,
		keywords: buyer.vat_number ?? undefined,
	}));
	const buyerName = combobox({
		options: buyerOptions,
		selected: existing ? { value: existing.buyer_name, label: existing.buyer_name } : null,
		class: "combo-customer",
		freeText: true,
		limit: 50,
	});
	buyerName.input.maxLength = 250;
	buyerName.input.required = true;
	const buyerVat = input("text", { maxlength: "80", placeholder: "SI12345678", value: existing?.buyer_vat_number ?? "" });
	const buyerCountry = select([{ value: "", label: t("ui.none") }, ...countryOptions()], existing?.buyer_country ?? project.tax_country ?? "");
	buyerName.onChange((option) => {
		const known = option ? buyers[Number(option.value)] : undefined;
		if (!known || known.name !== option?.label) return;
		buyerVat.value = known.vat_number ?? "";
		buyerCountry.value = known.country ?? "";
	});
	const issued = dateInput(existing?.issued_at ?? Date.now(), timezone, true);
	const supply = dateInput(existing?.supply_date ?? null, timezone);
	const due = dateInput(existing?.due_date ?? null, timezone);
	const currency = input("text", { maxlength: "3", required: true, value: existing?.currency ?? base });
	const rate = input("number", { min: "0", step: "any", value: existing?.tax_exchange_rate?.toString() ?? "" });
	const rateDate = dateInput(existing?.tax_rate_date ?? null, timezone);
	const paid = dateInput(existing?.paid_at ?? null, timezone);
	const paymentAccount = select(
		[
			{ value: "bank", label: t("recorded.account_bank") },
			{ value: "cash", label: t("recorded.account_cash") },
		],
		existing?.payment_account ?? "bank"
	);
	const notes = el("textarea", { rows: "2", maxlength: "5000" }, existing?.notes ?? "") as HTMLTextAreaElement;
	const rateFields = el(
		"div",
		{ class: "grid" },
		field(t("recorded.exchange_rate"), rate, t("recorded.exchange_rate_hint", { currency: base })),
		field(t("recorded.exchange_rate_date"), rateDate)
	);
	const syncCurrency = () => {
		currency.value = currency.value.toUpperCase();
		rateFields.hidden = currency.value === base;
	};
	currency.addEventListener("input", syncCurrency);
	syncCurrency();

	const lines: LineControls[] = [];
	const rows = el("div", { class: "stack" });
	const totals = el("p", { class: "muted mono" });
	const money = () => currency.value || base;
	const refresh = () => {
		const net = lines.reduce((sum, line) => sum + toMinorUnits(Number(line.net.value || 0), money()), 0);
		const tax = lines.reduce((sum, line) => sum + toMinorUnits(Number(line.tax.value || 0), money()), 0);
		totals.textContent = t("recorded.totals", {
			net: formatMoney(net, money()),
			tax: formatMoney(tax, money()),
			total: formatMoney(net + tax, money()),
		});
	};
	const addLine = (initial?: RecordedInvoice["lines"][number]) => {
		const lineRate = input("number", { min: "0", max: "100", step: "0.1", required: true, value: String(initial?.tax_rate ?? 22) });
		const treatment = select(taxTreatmentOptions(), initial?.tax_treatment ?? "domestic");
		const net = input("number", { step: "0.01", required: true, value: initial ? String(toMajorUnits(initial.net_amount, money())) : "" });
		const tax = input("number", { min: "0", step: "0.01", required: true, value: initial ? String(toMajorUnits(initial.tax_amount, money())) : "" });
		const remove = el("button", { class: "button ghost small", type: "button" }, t("ui.delete"));
		const row = el(
			"div",
			{ class: "vat-line" },
			field(t("recorded.rate"), lineRate),
			field(t("recorded.treatment"), treatment),
			field(t("recorded.net"), net),
			field(t("recorded.tax"), tax),
			remove
		);
		const line: LineControls = { rate: lineRate, treatment, net, tax, row, taxEdited: initial !== undefined };
		const recalculate = () => {
			if (!line.taxEdited) {
				const netMinor = toMinorUnits(Number(net.value || 0), money());
				tax.value = String(toMajorUnits(Math.round((netMinor * Number(lineRate.value || 0)) / 100), money()));
			}
			refresh();
		};
		net.addEventListener("input", recalculate);
		lineRate.addEventListener("input", recalculate);
		tax.addEventListener("input", () => {
			line.taxEdited = true;
			refresh();
		});
		remove.addEventListener("click", () => {
			if (lines.length <= 1) return;
			lines.splice(lines.indexOf(line), 1);
			row.remove();
			refresh();
		});
		lines.push(line);
		rows.append(row);
		refresh();
	};
	if (existing) existing.lines.forEach((line) => addLine(line));
	else addLine();

	const submit = el("button", { class: "button primary", type: "submit" }, t("ui.save"));
	const again = existing ? null : el("button", { class: "button ghost", type: "submit", dataset: { again: "1" } }, t("recorded.save_and_new"));
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				const repeat = (event.submitter as HTMLElement | null)?.dataset.again === "1";
				submit.disabled = true;
				const foreign = currency.value !== base;
				const data: RecordedInvoiceInput = {
					document_type: documentType.value as RecordedInvoiceInput["document_type"],
					reference: reference.value.trim(),
					buyer_name: (buyerName.selected?.label ?? buyerName.value).trim(),
					buyer_vat_number: buyerVat.value.trim() || null,
					buyer_country: buyerCountry.value || null,
					currency: currency.value,
					tax_exchange_rate: foreign && rate.value ? Number(rate.value) : null,
					tax_rate_date: foreign ? optionalDate(rateDate, timezone) : null,
					issued_at: dayStartFromDateInput(issued.value, timezone),
					supply_date: optionalDate(supply, timezone),
					due_date: optionalDate(due, timezone),
					paid_at: optionalDate(paid, timezone),
					payment_account: paymentAccount.value as RecordedInvoiceInput["payment_account"],
					notes: notes.value.trim() || null,
					lines: lines.map((line) => ({
						tax_rate: Number(line.rate.value),
						tax_treatment: line.treatment.value,
						net_amount: toMinorUnits(Number(line.net.value), money()),
						tax_amount: toMinorUnits(Number(line.tax.value), money()),
					})),
				};
				try {
					if (existing) await Api.updateRecordedInvoice(project.uuid, existing.uuid, data);
					else await Api.createRecordedInvoice(project.uuid, data);
					dialog.close();
					toast(t("recorded.saved"));
					onSaved();
					if (repeat) recordDialog(project, null, onSaved, data);
				} catch (error) {
					reportError(error);
				} finally {
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, t("recorded.form_hint")),
		el("div", { class: "grid" }, field(t("recorded.type"), documentType), field(t("recorded.reference"), reference, t("recorded.reference_hint"))),
		el(
			"div",
			{ class: "grid" },
			field(t("recorded.buyer"), buyerName.element),
			field(t("recorded.buyer_vat"), buyerVat),
			field(t("recorded.buyer_country"), buyerCountry)
		),
		el("div", { class: "grid" }, field(t("recorded.issued"), issued), field(t("recorded.supply"), supply), field(t("recorded.due"), due)),
		el("div", { class: "grid" }, field(t("recorded.currency"), currency)),
		rateFields,
		el("h3", {}, t("recorded.lines")),
		rows,
		el(
			"div",
			{ class: "line-actions" },
			el("button", { class: "button ghost small", type: "button", onClick: () => addLine() }, t("recorded.add_line")),
			totals
		),
		el("div", { class: "grid" }, field(t("recorded.paid"), paid, t("recorded.paid_hint")), field(t("recorded.payment_account"), paymentAccount)),
		field(t("recorded.notes"), notes),
		el("div", { class: "form-actions" }, again, submit)
	);
	const dialog = modal(t(existing ? "recorded.edit" : "recorded.new"), form);
	if (prefill) {
		documentType.value = prefill.document_type;
		buyerName.select({ value: prefill.buyer_name, label: prefill.buyer_name });
		buyerVat.value = prefill.buyer_vat_number ?? "";
		buyerCountry.value = prefill.buyer_country ?? "";
		issued.value = toDateInput(prefill.issued_at, timezone);
		supply.value = prefill.supply_date === null ? "" : toDateInput(prefill.supply_date, timezone);
		due.value = prefill.due_date === null ? "" : toDateInput(prefill.due_date, timezone);
		paid.value = prefill.paid_at === null ? "" : toDateInput(prefill.paid_at, timezone);
		paymentAccount.value = prefill.payment_account;
		currency.value = prefill.currency;
		syncCurrency();
		lines[0].rate.value = String(prefill.lines[0]?.tax_rate ?? 22);
		lines[0].treatment.value = prefill.lines[0]?.tax_treatment ?? "domestic";
	}
	(existing ? lines[0].net : reference).focus();
}

const TEMPLATE_COLUMNS: ImportColumn[] = [
	"number",
	"document_type",
	"issue_date",
	"buyer_name",
	"buyer_vat_number",
	"buyer_country",
	"supply_date",
	"due_date",
	"currency",
	"exchange_rate",
	"vat_rate",
	"vat_treatment",
	"net_amount",
	"vat_amount",
	"paid_date",
	"paid_to",
	"notes",
];

function columnLabel(column: ImportColumn): string {
	return t(`recorded.column_${column}` as UiKey);
}

function importDialog(project: Project, onImported: () => void) {
	csvImportDialog<ImportResult["documents"][number]>({
		title: t("recorded.import"),
		hint: t("recorded.import_hint"),
		fileName: "recorded-invoices.csv",
		columns: TEMPLATE_COLUMNS,
		columnLabel: (column) => columnLabel(column as ImportColumn),
		example: {
			sl: [
				"2026-00017",
				"račun",
				"5.1.2026",
				"Stranka d.o.o.",
				"SI12345678",
				"SI",
				"5.1.2026",
				"20.1.2026",
				"EUR",
				"",
				"22",
				"domestic",
				"200,00",
				"44,00",
				"20.1.2026",
				"banka",
				"",
			],
			en: [
				"2026-00017",
				"invoice",
				"2026-01-05",
				"Customer Ltd",
				"SI12345678",
				"SI",
				"2026-01-05",
				"2026-01-20",
				"EUR",
				"",
				"22",
				"domestic",
				"200.00",
				"44.00",
				"2026-01-20",
				"bank",
				"",
			],
		},
		headers: [t("recorded.reference"), t("recorded.issued"), t("recorded.buyer"), t("recorded.total")],
		row: (document) => [
			document.input.reference,
			formatDate(document.input.issued_at, project.date_format as DateFormat, project.timezone),
			document.input.buyer_name,
			formatMoney((document.input.document_type === "credit_note" ? -1 : 1) * document.total_amount, document.input.currency),
		],
		preview: (content) => Api.previewRecordedImport(project.uuid, content),
		commit: (content) => Api.importRecordedInvoices(project.uuid, content),
		onImported,
	});
}

export async function recordedInvoicesView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const dateFormat = project.date_format as DateFormat;
	const body = el("div", {});
	const range = period(project, () => void render());

	const remove = async (record: RecordedInvoice) => {
		const confirmed = await confirmDialog({
			title: t("recorded.delete_title"),
			body: t("recorded.delete_body", { reference: record.reference }),
			confirmLabel: t("ui.delete"),
			destructive: true,
		});
		if (!confirmed) return;
		try {
			await Api.deleteRecordedInvoice(uuid, record.uuid);
			await render();
		} catch (error) {
			reportError(error);
		}
	};

	const attach = (record: RecordedInvoice) => {
		const picker = input("file");
		picker.accept = ".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff,.xml";
		picker.addEventListener("change", async () => {
			const selected = picker.files?.[0];
			if (!selected) return;
			try {
				await Api.uploadRecordedAttachment(uuid, record.uuid, {
					name: selected.name,
					type: selected.type || (selected.name.toLowerCase().endsWith(".xml") ? "application/xml" : "application/pdf"),
					data: await toBase64(selected),
				});
				toast(t("recorded.attached"));
				await render();
			} catch (error) {
				reportError(error);
			}
		});
		picker.click();
	};

	const download = async (record: RecordedInvoice) => {
		try {
			const file = await Api.recordedAttachment(uuid, record.uuid);
			saveFile(file.blob, record.attachment?.file_name ?? file.name);
		} catch (error) {
			reportError(error);
		}
	};

	const render = async () => {
		body.replaceChildren(
			remoteTable(
				[t("recorded.reference"), t("recorded.issued"), t("recorded.buyer"), t("recorded.treatment"), numeric(t("recorded.total")), t("recorded.paid"), ""],
				async (offset, limit) => {
					const page = await Api.recordedInvoices(uuid, { ...range.range(), offset, limit });
					const rows = page.recorded_invoices.map((record) => {
						const sign = record.document_type === "credit_note" ? -1 : 1;
						const treatments = [...new Set(record.lines.map((line) => taxTreatmentName(line.tax_treatment)))].join(", ");
						return el(
							"tr",
							{},
							el(
								"td",
								{},
								el("span", { class: "mono" }, record.reference),
								record.document_type === "credit_note" ? el("div", { class: "muted" }, t("recorded.type_credit_note")) : null
							),
							el("td", { class: "date" }, formatDate(record.issued_at, dateFormat, project.timezone)),
							el("td", {}, record.buyer_name, record.buyer_vat_number ? el("div", { class: "muted mono" }, record.buyer_vat_number) : null),
							el("td", {}, treatments),
							moneyCell(sign * record.total_amount, record.currency, { zero: true, warn: sign < 0 }),
							el(
								"td",
								{ class: "date" },
								record.paid_at ? formatDate(record.paid_at, dateFormat, project.timezone) : el("span", { class: "muted" }, t("recorded.unpaid"))
							),
							el(
								"td",
								{ class: "actions" },
								record.attachment
									? el("button", { class: "button ghost small", type: "button", onClick: () => download(record) }, t("recorded.original"))
									: null,
								editable(project)
									? el(
											"button",
											{ class: "button ghost small", type: "button", onClick: () => attach(record) },
											t(record.attachment ? "recorded.replace_original" : "recorded.attach")
										)
									: null,
								editable(project)
									? el(
											"button",
											{ class: "button ghost small", type: "button", onClick: () => recordDialog(project, record, () => void render()) },
											t("ui.edit")
										)
									: null,
								editable(project) ? el("button", { class: "button ghost small", type: "button", onClick: () => remove(record) }, t("ui.delete")) : null
							)
						);
					});
					return { rows, total: page.total };
				},
				t("recorded.empty")
			)
		);
	};
	await render();

	return ledgerPage(
		project,
		"recorded",
		{
			title: t("recorded.title"),
			intro: t("recorded.intro"),
			actions: editable(project)
				? [
						el("button", { class: "button ghost", type: "button", onClick: () => importDialog(project, () => void render()) }, t("recorded.import")),
						el(
							"button",
							{
								class: "button primary",
								type: "button",
								dataset: { shortcutAction: "new-accounting-entry" },
								onClick: () => recordDialog(project, null, () => void render()),
							},
							t("recorded.new")
						),
					]
				: [],
		},
		licenseNotice(project),
		range.element,
		body
	);
}
