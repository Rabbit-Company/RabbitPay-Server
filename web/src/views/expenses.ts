import { PageState } from "../../../server/page-state";
import { pagedTable, pagination, PAGE_SIZE } from "../pagination";
import {
	Api,
	type Customer,
	type Expense,
	type ExpenseImportPreview,
	type ExpenseImportResult,
	type ExpenseInput,
	type ExpenseSchedule,
	type Project,
} from "../api";
import { combobox, staticCombobox, type ComboOption } from "../combobox";
import { currencyOptions, currencyRates } from "../currencies";
import { expenseCategoryLabel, expenseCategoryNote, expenseCategoryOptions, nonDeductibleCategory } from "../expense-categories";
import { csvImportDialog } from "../csv-import";
import { can, Permission } from "../access";
import { el, field, input, select, table, emptyState, saveFile } from "../dom";
import { dayStartFromDateInput, formatDate, formatMoney, fromDateInput, minorUnitDigits, toDateInput, toMajorUnits, toMinorUnits } from "../money";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { statusLabel, t, type UiKey } from "../i18n";
import { loadProject, projectLayout } from "./project";
import type { DateFormat } from "../../../server/formats";
import { includedTaxAtRate } from "../../../server/expense-types";
import { STANDARD_RATES } from "../../../server/tax";
import { countryOptions } from "../countries";
import type { ExpenseVatLineInput } from "../../../server/expense-types";

function fileBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.addEventListener("load", () => resolve(String(reader.result).split(",")[1] ?? ""));
		reader.addEventListener("error", () => reject(reader.error));
		reader.readAsDataURL(file);
	});
}

type SupplierOption = ComboOption & { customer: Customer };

function supplierOption(customer: Customer): SupplierOption {
	const details = [customer.name ? customer.email : null, customer.vat_number].filter(Boolean).join("\n");
	return {
		value: customer.name || customer.email,
		label: customer.name || customer.email,
		hint: details || undefined,
		keywords: customer.vat_number ?? undefined,
		customer,
	};
}

async function allSupplierOptions(uuid: string): Promise<SupplierOption[]> {
	const customers: Customer[] = [];
	const limit = 200;
	let offset = 0;
	let total = 0;

	do {
		const page = await Api.customers(uuid, { limit, offset });
		customers.push(...page.customers);
		total = page.total;
		offset += page.customers.length;
	} while (offset < total && offset > 0);

	return customers.map(supplierOption);
}

interface ImportedEinvoice {
	suggestion: ExpenseImportPreview;
	file: { name: string; type: string; data: string };
}

function importedExpense(imported: ImportedEinvoice): Expense {
	const expense = imported.suggestion.expense;
	return {
		...expense,
		uuid: "",
		attachment: null,
		vat_lines: expense.vat_lines.map((line, index) => ({ ...line, uuid: "", expense: "", sort_order: index })),
	} as unknown as Expense;
}

function importNotice(imported: ImportedEinvoice): HTMLElement {
	const { suggestion } = imported;
	return el(
		"div",
		{ class: "stack" },
		el(
			"p",
			{ class: "muted" },
			t("expenses.import_review", { format: suggestion.invoice.format === "eslog" ? "e-SLOG 2.0" : "UBL", file: imported.file.name })
		),
		suggestion.duplicate ? el("p", { class: "warn" }, t("expenses.import_duplicate")) : null,
		...suggestion.warnings.map((warning) => el("p", { class: "warn" }, warning.message))
	);
}

async function importEinvoice(project: Project, reload: () => Promise<void>) {
	const picker = input("file");
	picker.accept = ".xml,application/xml,text/xml";
	picker.addEventListener("change", async () => {
		const chosen = picker.files?.[0];
		if (!chosen) return;
		try {
			const file = { name: chosen.name, type: "application/xml", data: await fileBase64(chosen) };
			const suggestion = await Api.previewExpenseImport(project.uuid, { name: file.name, data: file.data });
			await editor(project, false, null, reload, { suggestion, file });
		} catch (error) {
			reportError(error);
		}
	});
	picker.click();
}

async function editor(
	project: Project,
	recurring: boolean,
	row: Expense | ExpenseSchedule | null,
	reload: () => Promise<void>,
	imported: ImportedEinvoice | null = null
) {
	const initial: Expense | ExpenseSchedule | null = row ?? (imported ? importedExpense(imported) : null);
	const [known, suppliers] = await Promise.all([currencyRates(), allSupplierOptions(project.uuid)]);
	const startCurrency = initial?.currency ?? project.currency;
	const description = input("text", { value: initial?.description ?? "", required: true, maxlength: "240" });
	const supplier = combobox({
		options: suppliers,
		selected: initial?.supplier
			? (suppliers.find((option) => option.value === initial.supplier) ?? { value: initial.supplier, label: initial.supplier })
			: null,
		class: "combo-customer",
		freeText: true,
		placeholder: t("expenses.supplier_placeholder"),
		limit: suppliers.length,
	});
	supplier.input.maxLength = 240;
	const expense = recurring ? null : (initial as Expense | null);
	const supplierTaxNumber = input("text", { value: initial?.supplier_tax_number ?? "", maxlength: "80", placeholder: "SI12345678" });
	const supplierCountry = select([{ value: "", label: t("ui.none") }, ...countryOptions()], initial?.supplier_country ?? "");
	supplier.onChange((option) => {
		const selectedSupplier = suppliers.find((candidate) => candidate === option)?.customer;
		if (!selectedSupplier) return;
		supplierTaxNumber.value = selectedSupplier.vat_number ?? selectedSupplier.tax_number ?? "";
		supplierCountry.value = selectedSupplier.country ?? "";
	});
	const invoiceNumber = input("text", { value: expense?.invoice_number ?? "", maxlength: "250" });
	const vatTreatment = select(
		[
			{ value: "not_reported", label: t("expenses.vat_not_reported") },
			{ value: "domestic", label: t("expenses.vat_domestic") },
			{ value: "domestic_reverse_charge", label: t("expenses.vat_domestic_reverse") },
			{ value: "eu_goods", label: t("expenses.vat_eu_goods") },
			{ value: "eu_services", label: t("expenses.vat_eu_services") },
			{ value: "import", label: t("expenses.vat_import") },
			{ value: "exempt", label: t("expenses.vat_exempt") },
		],
		initial?.vat_treatment ?? "not_reported"
	);
	const assetType = select(
		[
			{ value: "expense", label: t("expenses.asset_expense") },
			{ value: "real_estate", label: t("expenses.asset_real_estate") },
			{ value: "fixed_asset", label: t("expenses.asset_fixed") },
		],
		initial?.asset_type ?? "expense"
	);
	const category = combobox({
		options: expenseCategoryOptions(),
		selected: initial?.category ? { value: initial.category, label: expenseCategoryLabel(initial.category) } : null,
		freeText: true,
		required: true,
		placeholder: t("expenses.category_search"),
	});
	category.input.maxLength = 80;
	const categoryValue = () => category.selected?.value ?? category.value.trim();
	const categoryWithoutDeduction = () => nonDeductibleCategory(categoryValue());
	const categoryNote = el("p", { class: "muted" });
	const currency = staticCombobox(currencyOptions(known.currencies, startCurrency), startCurrency, {
		required: true,
		placeholder: t("currency.search"),
		emptyText: t("currency.no_match"),
	});
	const amountInput = (value: number) => input("number", { value: String(toMajorUnits(value, currency.value)), min: "0", step: "any", required: true });
	const amount = amountInput(initial?.total_amount ?? 0);
	const tax = amountInput(initial?.tax_amount ?? 0);
	const deductible = amountInput(initial?.deductible_tax_amount ?? 0);
	const standardRate = project.tax_country ? (STANDARD_RATES[project.tax_country] ?? 0) : 0;
	let automaticTax = initial === null && standardRate > 0;
	const initialDeductionMode = initial
		? initial.deductible_tax_amount === 0
			? "none"
			: initial.deductible_tax_amount === initial.tax_amount
				? "all"
				: "custom"
		: project.vat_status === "registered"
			? "all"
			: "none";
	const deductionMode = select(
		[
			{ value: "all", label: t("expenses.deduction_all") },
			{ value: "none", label: t("expenses.deduction_none") },
			{ value: "custom", label: t("expenses.deduction_custom") },
		],
		initialDeductionMode
	);
	let customDeductible = initialDeductionMode === "custom" ? deductible.value : "0";
	const taxSummary = el("div", { class: "expense-tax-summary" });
	const code = () => currency.value || project.currency;
	const minorValue = (control: HTMLInputElement) => {
		const value = Number(control.value);
		return Number.isFinite(value) && value >= 0 ? toMinorUnits(value, code()) : 0;
	};
	const showMinorValue = (control: HTMLInputElement, value: number) => {
		control.value = toMajorUnits(value, code()).toFixed(minorUnitDigits(code()));
	};
	const refreshTaxSummary = () => {
		const total = minorValue(amount);
		const reclaimable = Math.min(minorValue(deductible), minorValue(tax), total);
		const included = !["domestic_reverse_charge", "eu_goods", "eu_services"].includes(vatTreatment.value);
		taxSummary.textContent = t("expenses.net_amount", { amount: formatMoney(total - (included ? reclaimable : 0), code()) });
		taxSummary.hidden = total <= 0;
	};
	const syncDeduction = () => {
		deductible.readOnly = deductionMode.value !== "custom";
		if (deductionMode.value === "all") showMinorValue(deductible, minorValue(tax));
		else if (deductionMode.value === "none") showMinorValue(deductible, 0);
		else deductible.value = customDeductible;
		refreshTaxSummary();
	};
	const estimateTax = () => {
		if (automaticTax) showMinorValue(tax, includedTaxAtRate(minorValue(amount), standardRate));
		syncDeduction();
	};
	amount.addEventListener("input", estimateTax);
	tax.addEventListener("input", () => {
		automaticTax = false;
		syncDeduction();
	});
	deductible.addEventListener("input", () => {
		customDeductible = deductible.value;
		refreshTaxSummary();
	});
	deductionMode.addEventListener("change", () => {
		if (deductible.readOnly === false) customDeductible = deductible.value;
		syncDeduction();
	});
	currency.onChange(() => estimateTax());
	const useStandardRate = el(
		"button",
		{
			class: "button ghost small",
			type: "button",
			onClick: () => {
				automaticTax = true;
				estimateTax();
			},
		},
		t("expenses.tax_use_rate", { rate: standardRate })
	);
	useStandardRate.hidden = standardRate <= 0;
	const taxControl = el("div", { class: "expense-tax-control" }, tax, useStandardRate);
	const deductionControl = el("div", { class: "expense-deduction-control" }, deductionMode, deductible);
	const provisionalShare = input("checkbox");
	provisionalShare.checked = Boolean(expense?.provisional_share);
	estimateTax();
	const schedule = recurring ? (row as ExpenseSchedule | null) : null;
	const date = input("date", {
		value: toDateInput(schedule?.next_run_at ?? schedule?.anchor_date ?? expense?.expense_date ?? Date.now(), project.timezone),
		required: true,
	});
	const issueDate = input("date", { value: expense?.issue_date ? toDateInput(expense.issue_date, project.timezone) : date.value });
	const receiptDate = input("date", { value: expense?.receipt_date ? toDateInput(expense.receipt_date, project.timezone) : date.value });
	const supplyDate = input("date", { value: expense?.supply_date ? toDateInput(expense.supply_date, project.timezone) : "" });
	const dueDate = input("date", { value: expense?.due_date ? toDateInput(expense.due_date, project.timezone) : "" });
	const vatHandling = select(
		[
			{ value: "1", label: t("expenses.vat_handling_regular") },
			{ value: "2", label: t("expenses.vat_handling_assessment") },
			{ value: "3", label: t("expenses.vat_handling_interest") },
		],
		expense?.vat_handling ?? "1"
	);
	const assessmentPeriod = input("text", { value: expense?.self_assessment_period ?? "", maxlength: "8", placeholder: "MMDDYYYY" });
	const assessmentTax = amountInput(expense?.self_assessment_tax ?? 0);
	const exchangeRate = input("number", { value: expense?.tax_exchange_rate ? String(expense.tax_exchange_rate) : "", min: "0", step: "any" });
	const exchangeRateDate = input("date", { value: expense?.tax_rate_date ? toDateInput(expense.tax_rate_date, project.timezone) : issueDate.value });
	const exchangeFields = el(
		"div",
		{ class: "grid" },
		field(t("expenses.exchange_rate"), exchangeRate, t("expenses.exchange_rate_hint", { currency: currency.value || project.currency })),
		field(t("expenses.exchange_rate_date"), exchangeRateDate)
	);
	const attachment = input("file");
	attachment.accept = "application/pdf,image/png,image/jpeg,image/webp,image/tiff,.xml,application/xml,text/xml";
	const attachmentActions = el("div", { class: "line-actions" });
	if (expense?.attachment) {
		attachmentActions.append(
			el("span", { class: "muted" }, expense.attachment.file_name),
			el(
				"button",
				{
					class: "button ghost small",
					type: "button",
					onClick: async () => {
						try {
							const file = await Api.expenseAttachment(project.uuid, expense.uuid);
							saveFile(file.blob, file.name);
						} catch (error) {
							reportError(error);
						}
					},
				},
				t("expenses.attachment_download")
			),
			el(
				"button",
				{
					class: "button ghost small",
					type: "button",
					onClick: async () => {
						try {
							await Api.deleteExpenseAttachment(project.uuid, expense.uuid);
							attachmentActions.replaceChildren();
						} catch (error) {
							reportError(error);
						}
					},
				},
				t("ui.delete")
			)
		);
	}
	const knownRates = new Set([22, 9.5, 5, 8, 0, ...(expense?.vat_lines.map((line) => line.rate) ?? [])]);
	const vatLineControls = [...knownRates]
		.sort((a, b) => b - a)
		.map((rate) => {
			const existing = expense?.vat_lines.find((line) => line.rate === rate);
			const base = amountInput(existing?.tax_base ?? 0);
			const lineTax = amountInput(existing?.tax_amount ?? 0);
			const lineDeductible = amountInput(existing?.deductible_tax_amount ?? 0);
			base.addEventListener("input", () => {
				const baseMinor = minorValue(base);
				const taxMinor = Math.round((baseMinor * rate) / 100);
				showMinorValue(lineTax, taxMinor);
				showMinorValue(lineDeductible, project.vat_status === "registered" && !categoryWithoutDeduction() ? taxMinor : 0);
				refreshVatLines();
			});
			lineTax.addEventListener("input", refreshVatLines);
			lineDeductible.addEventListener("input", refreshVatLines);
			return { rate, base, tax: lineTax, deductible: lineDeductible };
		});
	const vatLinesBody = el(
		"div",
		{ class: "table-wrap" },
		el(
			"table",
			{},
			el(
				"thead",
				{},
				el("tr", {}, ...[t("stats.column_rate"), t("expenses.tax_base"), t("expenses.tax"), t("expenses.deductible")].map((label) => el("th", {}, label)))
			),
			el(
				"tbody",
				{},
				...vatLineControls.map((line) =>
					el("tr", {}, el("td", {}, `${line.rate}%`), el("td", {}, line.base), el("td", {}, line.tax), el("td", {}, line.deductible))
				)
			)
		)
	);
	function refreshVatLines() {
		if (vatTreatment.value === "not_reported") return;
		showMinorValue(
			tax,
			vatLineControls.reduce((sum, line) => sum + minorValue(line.tax), 0)
		);
		showMinorValue(
			deductible,
			vatLineControls.reduce((sum, line) => sum + minorValue(line.deductible), 0)
		);
		refreshTaxSummary();
	}
	const assessmentFields = el(
		"div",
		{ class: "grid" },
		field(t("expenses.assessment_period"), assessmentPeriod),
		field(t("expenses.assessment_tax"), assessmentTax)
	);
	const ddvFields = el(
		"div",
		{ class: "stack" },
		el("div", { class: "grid" }, field(t("expenses.supplier_tax_number"), supplierTaxNumber), field(t("expenses.supplier_country"), supplierCountry)),
		el(
			"div",
			{ class: "grid" },
			field(t("expenses.invoice_number"), invoiceNumber),
			field(t("expenses.issue_date"), issueDate),
			field(t("expenses.receipt_date"), receiptDate),
			field(t("expenses.supply_date"), supplyDate)
		),
		field(t("expenses.asset_type"), assetType),
		vatLinesBody,
		exchangeFields,
		field(t("expenses.vat_handling"), vatHandling),
		assessmentFields,
		el("label", { class: "switch" }, provisionalShare, el("span", {}, t("expenses.provisional_share"))),
		el("p", { class: "muted" }, t("expenses.provisional_share_hint")),
		field(t("expenses.attachment"), attachment, t("expenses.attachment_hint")),
		attachmentActions
	);
	const syncVatTreatment = () => {
		const reporting = !recurring && vatTreatment.value !== "not_reported";
		ddvFields.hidden = !reporting;
		tax.readOnly = reporting;
		deductible.readOnly = reporting || deductionMode.value !== "custom";
		deductionMode.disabled = reporting;
		useStandardRate.hidden = reporting || standardRate <= 0;
		if (reporting) {
			const empty = vatLineControls.every((line) => minorValue(line.base) === 0 && minorValue(line.tax) === 0);
			const standard = vatLineControls.find((line) => line.rate === standardRate);
			if (empty && standard) {
				const currentTax = minorValue(tax);
				showMinorValue(standard.base, Math.max(0, minorValue(amount) - currentTax));
				showMinorValue(standard.tax, currentTax);
				showMinorValue(standard.deductible, project.vat_status === "registered" && !categoryWithoutDeduction() ? currentTax : 0);
			}
			automaticTax = false;
			refreshVatLines();
		}
		exchangeFields.hidden = !reporting || currency.value === "EUR";
	};
	const syncVatHandling = () => {
		assessmentFields.hidden = vatHandling.value === "1";
	};
	const syncCategory = (changed: boolean) => {
		const note = expenseCategoryNote(categoryValue());
		categoryNote.textContent = note ?? "";
		categoryNote.hidden = note === null;
		if (!changed || !categoryWithoutDeduction()) return;
		deductionMode.value = "none";
		for (const line of vatLineControls) showMinorValue(line.deductible, 0);
		syncDeduction();
		refreshVatLines();
	};
	category.onChange(() => syncCategory(true));
	syncCategory(false);
	vatTreatment.addEventListener("change", syncVatTreatment);
	vatHandling.addEventListener("change", syncVatHandling);
	currency.onChange(syncVatTreatment);
	syncVatTreatment();
	syncVatHandling();
	const paid = input("checkbox");
	paid.checked = recurring ? (schedule?.auto_paid ?? false) : expense?.paid_at != null;
	const paidDate = input("date", { value: toDateInput(expense?.paid_at ?? expense?.expense_date ?? Date.now(), project.timezone), required: paid.checked });
	const paymentField = field(t("expenses.paid_date"), paidDate);
	paymentField.hidden = !paid.checked;
	paid.addEventListener("change", () => {
		paymentField.hidden = !paid.checked;
		paidDate.required = paid.checked && !recurring;
	});
	const intervalCount = input("number", { value: String(schedule?.interval_count ?? 1), min: "1", max: "60", required: recurring });
	const intervalUnit = select(
		["week", "month", "year"].map((value) => ({ value, label: t(`expenses.${value}` as "expenses.week") })),
		schedule?.interval_unit ?? "month"
	);
	const end = input("date", { value: schedule?.end_date ? toDateInput(schedule.end_date, project.timezone) : "" });
	const maximum = input("number", { value: String(schedule?.max_occurrences ?? ""), min: "1", max: "1000" });
	const notes = el("textarea", { maxlength: "5000" }, initial?.notes ?? "");
	const save = el("button", { class: "button primary", type: "submit" }, t("ui.save"));
	const form = el(
		"form",
		{ class: "stack" },
		imported ? importNotice(imported) : null,
		field(t("expenses.description"), description),
		el("div", { class: "grid" }, field(t("expenses.supplier"), supplier.element), field(t("expenses.category"), category.element, t("expenses.category_hint"))),
		categoryNote,
		recurring ? null : field(t("expenses.vat_treatment"), vatTreatment),
		el("div", { class: "grid" }, field(t("expenses.amount"), amount), field(t("expenses.currency"), currency.element)),
		el(
			"div",
			{ class: "grid" },
			field(t("expenses.tax"), taxControl, standardRate > 0 ? t("expenses.tax_hint_rate", { rate: standardRate }) : t("expenses.tax_hint")),
			field(t("expenses.deductible"), deductionControl, t("expenses.deductible_hint"))
		),
		taxSummary,
		ddvFields,
		recurring
			? field(t("expenses.start"), date)
			: el("div", { class: "grid" }, field(t("expenses.date"), date), field(t("expenses.due_date"), dueDate, t("expenses.due_date_hint"))),
		el(
			"div",
			{ class: "field" },
			el("label", { class: "switch" }, paid, el("span", {}, t(recurring ? "expenses.auto_paid" : "expenses.paid"))),
			recurring ? el("span", { class: "field-hint" }, t("expenses.auto_paid_hint")) : null
		),
		recurring ? null : paymentField,
		recurring
			? el(
					"div",
					{ class: "grid" },
					field(t("expenses.interval"), intervalCount),
					field(t("expenses.interval"), intervalUnit),
					field(t("expenses.end"), end),
					field(t("expenses.max"), maximum)
				)
			: null,
		field(t("expenses.notes"), notes),
		el("div", { class: "dialog-actions" }, save)
	);
	const dialog = modal(t(recurring ? (row ? "expenses.edit_recurring" : "expenses.add_recurring") : row ? "expenses.edit" : "expenses.add"), form);
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const data: ExpenseInput = {
			description: description.value,
			supplier: supplier.value.trim() || null,
			supplier_tax_number: supplierTaxNumber.value.trim() || null,
			supplier_country: supplierCountry.value || null,
			invoice_number: recurring ? null : invoiceNumber.value.trim() || null,
			category: category.selected?.value ?? category.value.trim(),
			currency: currency.value,
			total_amount: toMinorUnits(Number(amount.value), currency.value),
			tax_amount: toMinorUnits(Number(tax.value), currency.value),
			deductible_tax_amount: toMinorUnits(Number(deductible.value), currency.value),
			provisional_share: !recurring && vatTreatment.value !== "not_reported" && provisionalShare.checked,
			expense_date: dayStartFromDateInput(date.value, project.timezone),
			issue_date: recurring || !issueDate.value ? null : dayStartFromDateInput(issueDate.value, project.timezone),
			receipt_date: recurring || !receiptDate.value ? null : dayStartFromDateInput(receiptDate.value, project.timezone),
			supply_date: recurring || !supplyDate.value ? null : dayStartFromDateInput(supplyDate.value, project.timezone),
			due_date: recurring || !dueDate.value ? null : dayStartFromDateInput(dueDate.value, project.timezone),
			vat_treatment: recurring ? "not_reported" : vatTreatment.value,
			asset_type: recurring ? "expense" : assetType.value,
			vat_handling: recurring ? "1" : vatHandling.value,
			self_assessment_period: recurring || vatHandling.value === "1" ? null : assessmentPeriod.value.trim() || null,
			self_assessment_tax: recurring || vatHandling.value === "1" ? null : toMinorUnits(Number(assessmentTax.value), currency.value),
			tax_exchange_rate: recurring || currency.value === "EUR" || !exchangeRate.value ? null : Number(exchangeRate.value),
			tax_rate_date: recurring || currency.value === "EUR" || !exchangeRateDate.value ? null : dayStartFromDateInput(exchangeRateDate.value, project.timezone),
			vat_lines: recurring
				? []
				: vatLineControls
						.map(
							(line): ExpenseVatLineInput => ({
								rate: line.rate,
								tax_base: minorValue(line.base),
								tax_amount: minorValue(line.tax),
								deductible_tax_amount: minorValue(line.deductible),
							})
						)
						.filter((line) => line.tax_base > 0 || line.tax_amount > 0 || line.deductible_tax_amount > 0),
			paid_at: paid.checked && !recurring ? dayStartFromDateInput(paidDate.value, project.timezone) : null,
			notes: notes.value || null,
		};
		if (
			data.total_amount <= 0 ||
			data.tax_amount > data.total_amount ||
			data.deductible_tax_amount > data.tax_amount ||
			(end.value && dayStartFromDateInput(end.value, project.timezone) < data.expense_date)
		) {
			toast(t("expenses.invalid"), "error");
			return;
		}
		save.disabled = true;
		try {
			if (recurring) {
				const recurringData = {
					...data,
					start_date: data.expense_date,
					interval_unit: intervalUnit.value,
					interval_count: Number(intervalCount.value),
					end_date: end.value ? fromDateInput(end.value, project.timezone) : null,
					max_occurrences: maximum.value ? Number(maximum.value) : null,
					auto_paid: paid.checked,
				};
				if (row) {
					const { start_date, ...changes } = recurringData;
					await Api.updateExpenseSchedule(project.uuid, row.uuid, {
						...changes,
						...(date.value !== toDateInput(schedule?.next_run_at ?? schedule!.anchor_date, project.timezone) ? { start_date } : {}),
					});
				} else await Api.createExpenseSchedule(project.uuid, recurringData);
			} else {
				const saved = row ? await Api.updateExpense(project.uuid, row.uuid, data) : await Api.createExpense(project.uuid, data);
				const file = attachment.files?.[0];
				if (file) await Api.uploadExpenseAttachment(project.uuid, saved.uuid, { name: file.name, type: file.type, data: await fileBase64(file) });
				else if (imported && !row) await Api.uploadExpenseAttachment(project.uuid, saved.uuid, imported.file);
			}
			dialog.close();
			toast(t("expenses.saved"), "success");
			await reload();
		} catch (error) {
			reportError(error);
		} finally {
			save.disabled = false;
		}
	});
}

const CSV_COLUMNS = [
	"supplier",
	"invoice_number",
	"supplier_tax_number",
	"supplier_country",
	"issue_date",
	"receipt_date",
	"category",
	"description",
	"currency",
	"exchange_rate",
	"vat_treatment",
	"vat_rate",
	"net_amount",
	"vat_amount",
	"deductible_vat",
	"paid_date",
	"notes",
];

function importCsv(project: Project, onImported: () => void) {
	csvImportDialog<ExpenseImportResult["documents"][number]>({
		title: t("expenses.import_csv"),
		hint: t("expenses.import_csv_hint"),
		fileName: "expenses.csv",
		columns: CSV_COLUMNS,
		columnLabel: (column) => t(`expenses.csv_column_${column}` as UiKey),
		example: {
			sl: [
				"Petrol d.d.",
				"P-77",
				"SI80267432",
				"SI",
				"4.3.2026",
				"4.3.2026",
				"Travel",
				"Gorivo",
				"EUR",
				"",
				"domestic",
				"22",
				"100,00",
				"22,00",
				"22,00",
				"4.3.2026",
				"",
			],
			en: [
				"Petrol d.d.",
				"P-77",
				"SI80267432",
				"SI",
				"2026-03-04",
				"2026-03-04",
				"Travel",
				"Fuel",
				"EUR",
				"",
				"domestic",
				"22",
				"100.00",
				"22.00",
				"22.00",
				"2026-03-04",
				"",
			],
		},
		headers: [t("expenses.supplier"), t("expenses.date"), t("expenses.category"), t("expenses.amount")],
		row: (document) => [
			`${document.input.supplier ?? ""} ${document.input.invoice_number ?? ""}`,
			formatDate(document.input.expense_date, project.date_format as DateFormat, project.timezone),
			expenseCategoryLabel(document.input.category),
			formatMoney(document.input.total_amount, document.input.currency),
		],
		preview: (content) => Api.previewExpenseCsv(project.uuid, content),
		commit: (content) => Api.importExpenseCsv(project.uuid, content),
		onImported,
	});
}

export async function expensesView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const dateFormat = project.date_format as DateFormat;
	const body = el("div", { class: "stack" });
	const schedulesBody = el("div", { class: "stack" });
	const schedulesPage = new PageState();
	const status = select([
		{ value: "", label: t("expenses.all") },
		{ value: "paid", label: t("expenses.paid") },
		{ value: "unpaid", label: t("expenses.unpaid") },
	]);
	status.dataset.shortcutSearch = "";
	const from = input("date");
	const to = input("date");
	let request = 0;
	const action = (label: string, work: () => Promise<void>) => {
		const button = el("button", { class: "button ghost small", type: "button" }, label);
		button.addEventListener("click", async () => {
			button.disabled = true;
			try {
				await work();
			} catch (error) {
				reportError(error);
			} finally {
				button.disabled = false;
			}
		});
		return button;
	};
	const addExpense = action(t("expenses.add"), async () => editor(project, false, null, reload));
	addExpense.dataset.shortcutAction = "new-expense";
	const paymentStatus = (row: Expense): HTMLElement => {
		const label = t(row.paid_at === null ? "expenses.unpaid" : "expenses.paid");
		if (!can(project, Permission.EXPENSE_EDIT)) return el("span", {}, label);
		const paid = input("checkbox");
		paid.checked = row.paid_at !== null;
		paid.addEventListener("change", async () => {
			paid.disabled = true;
			try {
				await Api.updateExpense(uuid, row.uuid, { paid_at: paid.checked ? Date.now() : null });
				await load();
			} catch (error) {
				paid.checked = row.paid_at !== null;
				reportError(error);
			} finally {
				paid.disabled = false;
			}
		});
		return el("label", { class: "switch" }, paid, el("span", {}, label));
	};
	const controls = pagination(() => load());
	const load = async (): Promise<void> => {
		const current = ++request;
		try {
			const result = await Api.expenses(uuid, {
				offset: controls.state.offset,
				status: status.value,
				from: from.value ? dayStartFromDateInput(from.value, project.timezone) : undefined,
				to: to.value ? fromDateInput(to.value, project.timezone) : undefined,
			});
			if (current !== request) return;
			if (controls.update(result.total)) return await load();
			const rows = result.expenses.map((row) =>
				el(
					"tr",
					{},
					el("td", {}, row.description, row.supplier ? el("div", { class: "muted" }, row.supplier) : null),
					el("td", {}, expenseCategoryLabel(row.category)),
					el("td", {}, formatDate(row.expense_date, dateFormat, project.timezone)),
					el("td", { class: "mono" }, formatMoney(row.total_amount, row.currency)),
					el("td", {}, paymentStatus(row)),
					el(
						"td",
						{ class: "line-actions" },
						can(project, Permission.EXPENSE_EDIT) ? action(t("ui.edit"), async () => editor(project, false, row, reload)) : null,
						can(project, Permission.EXPENSE_DELETE)
							? action(t("ui.delete"), async () => {
									if (
										await confirmDialog({ title: t("expenses.delete_title"), body: t("expenses.delete_body"), confirmLabel: t("ui.delete"), destructive: true })
									) {
										await Api.deleteExpense(uuid, row.uuid);
										await load();
									}
								})
							: null
					)
				)
			);
			body.replaceChildren(
				rows.length
					? table([t("expenses.description"), t("expenses.category"), t("expenses.date"), t("expenses.amount"), t("expenses.status"), ""], rows)
					: emptyState(t("expenses.empty"))
			);
		} catch (error) {
			if (current === request) {
				controls.fail();
				reportError(error);
			}
		}
	};
	const loadSchedules = async () => {
		try {
			const schedules = await Api.expenseSchedules(uuid);
			schedulesBody.replaceChildren(
				pagedTable(
					[t("expenses.description"), t("expenses.category"), t("expenses.amount"), t("expenses.next"), t("expenses.status"), ""],
					schedules.map((row) =>
						el(
							"tr",
							{},
							el("td", {}, row.description),
							el("td", {}, expenseCategoryLabel(row.category)),
							el("td", { class: "mono" }, formatMoney(row.total_amount, row.currency)),
							el("td", {}, row.next_run_at ? formatDate(row.next_run_at, dateFormat, project.timezone) : ""),
							el("td", {}, statusLabel(row.status)),
							el(
								"td",
								{ class: "line-actions" },
								can(project, Permission.EXPENSE_EDIT) && row.status !== "canceled"
									? el(
											"div",
											{ class: "line-actions" },
											action(t("ui.edit"), async () => editor(project, true, row, reload)),
											row.status === "active" || row.status === "paused"
												? action(t(row.status === "active" ? "expenses.pause" : "expenses.resume"), async () => {
														await Api.updateExpenseSchedule(uuid, row.uuid, { status: row.status === "active" ? "paused" : "active" });
														await loadSchedules();
													})
												: null,
											action(t("expenses.cancel"), async () => {
												if (await confirmDialog({ title: t("expenses.cancel"), body: t("expenses.cancel_body"), confirmLabel: t("expenses.cancel") })) {
													await Api.updateExpenseSchedule(uuid, row.uuid, { status: "canceled" });
													await loadSchedules();
												}
											})
										)
									: null
							)
						)
					),
					PAGE_SIZE,
					schedulesPage
				)
			);
		} catch (error) {
			reportError(error);
		}
	};
	const reload = async () => {
		await Promise.all([load(), loadSchedules()]);
	};
	for (const filter of [status, from, to])
		filter.addEventListener("change", () => {
			controls.reset();
			void load();
		});
	await reload();
	const opened = new URLSearchParams(window.location.search).get("open");
	if (opened && can(project, Permission.EXPENSE_EDIT))
		setTimeout(() => {
			Api.expense(uuid, opened)
				.then((row) => editor(project, false, row, reload))
				.catch(reportError);
		}, 0);
	return projectLayout(
		project,
		el(
			"div",
			{ class: "stack" },
			el(
				"div",
				{ class: "toolbar" },
				el("h2", { class: "toolbar-title" }, t("nav.expenses")),
				can(project, Permission.EXPENSE_CREATE)
					? el(
							"div",
							{ class: "line-actions" },
							addExpense,
							action(t("expenses.import"), async () => importEinvoice(project, reload)),
							action(t("expenses.import_csv"), async () => importCsv(project, reload)),
							action(t("expenses.add_recurring"), async () => editor(project, true, null, reload))
						)
					: null
			),
			el("div", { class: "grid" }, field(t("expenses.status"), status), field(t("expenses.from"), from), field(t("expenses.to"), to)),
			body,
			controls.element,
			el("h2", {}, t("expenses.recurring")),
			schedulesBody
		)
	);
}
