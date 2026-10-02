import { pagination, PAGE_SIZE } from "../pagination";
import { Api, type CompanyLookup, type Company, type NumberSeries, type ProformaSettlement, type Project } from "../api";
import { companySearch, watchVatNumber } from "../company-lookup";
import { el, field, input, select, table } from "../dom";
import { navigate } from "../router";
import { confirmDialog, modal, reportError, secretReveal, toast } from "../ui";
import { invalidateProject, loadProject, projectLayout } from "./project";
import { processorsSection } from "./processors";
import { currencyLabel, currencyOptions, currencyRates } from "../currencies";
import { DATE_FORMATS, TIME_FORMATS, formatDate, formatDateTime, type DateFormat, type TimeFormat } from "../../../server/formats";
import { LANGUAGES, t as documentWord, type Language } from "../../../server/i18n";
import { DISCLOSURE_BLANK, disclosureGaps } from "../../../server/company-disclosure";
import { statusLabel, t, type UiKey } from "../i18n";
import { vatStatusHint, vatStatusOptions } from "../options";
import { ACCENT_PRESETS, BRAND_BLUE } from "../../../server/colors";
import { applyAccent } from "../theme";
import { countryCodeFor, countryOptions } from "../countries";
import { defaultExemptionNote, defaultTaxCurrency, isEuCountry, requiredTaxCurrency, splitVatNumber } from "../../../server/tax";
import { combobox, staticCombobox } from "../combobox";
import { can, Permission } from "../access";
import {
	DEFAULT_INVOICE_FORMAT,
	DEFAULT_ORDER_FORMAT,
	DEFAULT_PROFORMA_FORMAT,
	describeInvoiceFormat,
	parseInvoiceFormat,
	renderInvoiceNumber,
} from "../../../server/invoice-format";
import { creditorReference } from "../../../server/payments/reference";
import { fiscalSection } from "./fiscal";
import { signingSection } from "./einvoice";
import { invoiceDesignSection } from "./invoice-design";
import { emailDesignSection } from "./email-design";

function keyRow(uuid: string, label: string, slot: "primary" | "secondary", masked: string, onRotated: () => void) {
	return el(
		"div",
		{ class: "key-row" },
		el("div", {}, el("strong", {}, label), el("div", { class: "mono muted" }, masked)),
		el(
			"button",
			{
				class: "button ghost",
				type: "button",
				onClick: async () => {
					const confirmed = await confirmDialog({
						title: t("settings.rotate_title", { key: label.toLowerCase() }),
						body: t("settings.rotate_body", { key: label.toLowerCase() }),
						confirmLabel: t("settings.rotate_key"),
						destructive: true,
					});
					if (!confirmed) return;

					try {
						const result = await Api.rotateKey(uuid, slot);
						modal(t("settings.key_rotated"), el("div", { class: "stack" }, secretReveal(t("settings.new_key", { key: label.toLowerCase() }), result.key)));
						onRotated();
					} catch (error) {
						reportError(error);
					}
				},
			},
			t("settings.rotate")
		)
	);
}

function companyFields(vatStatus: string | null): { key: keyof Company; label: string; hint?: string }[] {
	const vatRegistered = vatStatus === "registered";
	return [
		{ key: "legal_name", label: t("settings.legal_name"), hint: t("settings.legal_name_hint") },
		{ key: "address_line1", label: t("customers.address") },
		{ key: "address_line2", label: t("settings.address_line2") },
		{ key: "postal_code", label: t("customers.postal_code") },
		{ key: "city", label: t("customers.city") },
		{ key: "state", label: t("settings.state") },
		{ key: "country", label: t("customers.country") },
		{
			key: "vat_number",
			label: t("customers.vat_number"),
			hint: t(vatRegistered ? "settings.vat_number_hint_registered" : "settings.vat_number_hint_unregistered"),
		},
		{ key: "tax_number", label: t("settings.tax_number") },
		{ key: "registration_number", label: t("settings.registration_number"), hint: t("settings.registration_number_hint") },
		{ key: "email", label: t("customers.email") },
		{ key: "phone", label: t("customers.phone") },
		{ key: "website", label: t("settings.website") },
	];
}

function companySection(uuid: string, vatStatus: string | null, documentLanguage: Language): HTMLElement {
	const container = el("div", { class: "stack" });

	const load = async () => {
		let company: Company;
		try {
			company = await Api.company(uuid);
		} catch {
			container.replaceChildren(el("p", { class: "muted" }, t("settings.company_permission")));
			return;
		}

		const inputs = new Map<keyof Company, HTMLInputElement | HTMLTextAreaElement>();
		const country = staticCombobox(countryOptions(), countryCodeFor(company.country), {
			placeholder: t("country.search"),
			emptyText: t("country.no_match"),
		});

		const lookup = companySearch();
		const legalName = combobox({
			search: (query) => lookup.search(query),
			selected: company.legal_name ? { value: company.legal_name, label: company.legal_name } : null,
			freeText: true,
			placeholder: t("customers.name_lookup"),
		});
		const fill = (found: CompanyLookup) => {
			legalName.select({ value: found.name, label: found.name });
			const values: Partial<Record<keyof Company, string | null>> = {
				address_line1: found.address_line1,
				postal_code: found.postal_code,
				city: found.city,
				vat_number: found.vat_number,
				tax_number: found.tax_number,
				registration_number: found.registration_number,
			};
			for (const [key, value] of Object.entries(values) as [keyof Company, string | null][]) {
				const control = inputs.get(key);
				if (control && value) control.value = value;
			}
			if (found.country) country.select(countryOptions().find((option) => option.value === found.country) ?? null);
			toast(t("lookup.filled", { source: t(found.source === "furs" ? "lookup.source_furs" : "lookup.source_vies"), name: found.name }));
		};
		legalName.onChange((option) => {
			const found = lookup.found(option);
			if (found) fill(found);
		});

		const controls = companyFields(vatStatus).map((definition) => {
			if (definition.key === "country") return field(definition.label, country.element, definition.hint);
			if (definition.key === "legal_name") {
				inputs.set("legal_name", legalName.input);
				return field(definition.label, legalName.element, definition.hint);
			}
			const control = input("text", { value: company[definition.key] ?? "" });
			inputs.set(definition.key, control);
			if (definition.key === "vat_number" || definition.key === "tax_number") watchVatNumber(control, fill, () => !legalName.value.trim());
			return field(definition.label, control, definition.hint);
		});

		const footer = el("textarea", { rows: "3", placeholder: t("settings.footer_placeholder") }) as HTMLTextAreaElement;
		footer.value = company.footer_note ?? "";
		inputs.set("footer_note", footer);

		const disclosure = el("div", { class: "stack" });
		const refreshDisclosure = () => {
			const gaps = disclosureGaps({
				country: country.value || null,
				legal_name: legalName.value,
				registration_number: inputs.get("registration_number")?.value ?? null,
				footer_note: footer.value,
			});
			const notes: HTMLElement[] = [];
			if (gaps.registrationNumber) notes.push(el("p", { class: "warn" }, t("settings.disclosure_registration")));
			if (gaps.registerEntry || gaps.shareCapital) {
				const suggested = [
					gaps.registerEntry ? documentWord(documentLanguage, "company.disclosure.register") : null,
					gaps.shareCapital ? documentWord(documentLanguage, "company.disclosure.capital") : null,
				]
					.filter(Boolean)
					.join(" ");
				notes.push(
					el("p", { class: "warn" }, t(gaps.form === "capital_company" ? "settings.disclosure_capital_company" : "settings.disclosure_company")),
					el(
						"button",
						{
							class: "button ghost small",
							type: "button",
							onClick: () => {
								footer.value = [footer.value.trim(), suggested].filter(Boolean).join("\n");
								refreshDisclosure();
								footer.focus();
							},
						},
						t("settings.disclosure_add")
					)
				);
			}
			if (gaps.unfinished) notes.push(el("p", { class: "warn" }, t("settings.disclosure_unfinished", { blank: DISCLOSURE_BLANK })));
			disclosure.replaceChildren(...notes);
			disclosure.hidden = notes.length === 0;
		};
		footer.addEventListener("input", refreshDisclosure);
		legalName.input.addEventListener("input", refreshDisclosure);
		legalName.onChange(refreshDisclosure);
		country.onChange(refreshDisclosure);
		inputs.get("registration_number")?.addEventListener("input", refreshDisclosure);
		refreshDisclosure();

		const save = el("button", { class: "button primary", type: "submit" }, t("settings.save_company"));

		container.replaceChildren(
			el(
				"form",
				{
					onSubmit: async (event) => {
						event.preventDefault();
						save.disabled = true;

						const details: Partial<Company> = {};
						for (const [key, control] of inputs) details[key] = control.value.trim() || null;
						details.country = country.value || null;

						try {
							await Api.saveCompany(uuid, details);
							toast(t("settings.company_saved"), "success");
						} catch (error) {
							reportError(error);
						} finally {
							save.disabled = false;
						}
					},
				},
				el("div", { class: "form-grid" }, ...controls),
				field(t("settings.invoice_footer"), footer, t("settings.invoice_footer_hint")),
				disclosure,
				el("div", { class: "form-actions" }, save)
			)
		);
	};

	void load();
	return container;
}

function invoiceSection(uuid: string, project: Project): HTMLElement {
	const now = Date.now();

	const dateFormat = select(
		DATE_FORMATS.map((entry) => ({ value: entry.value, label: `${entry.label}  (${entry.example})` })),
		project.date_format
	);
	const timeFormat = select(TIME_FORMATS, project.time_format);
	const timezone = input("text", { value: project.timezone, required: true, maxlength: "100" });
	timezone.spellcheck = false;
	const language = select(LANGUAGES, project.language);
	const issuerDetails = input("checkbox");
	issuerDetails.checked = project.invoice_issuer_details;

	const preview = el("p", { class: "muted" });

	const refreshPreview = () => {
		const shown = formatDate(now, dateFormat.value as DateFormat);
		const stamped = formatDateTime(now, dateFormat.value as DateFormat, timeFormat.value as TimeFormat);
		const chosen = language.value as Language;

		preview.replaceChildren(
			t("settings.format_preview", {
				date: shown,
				time: stamped,
				title: documentWord(chosen, "invoice.title"),
				total: documentWord(chosen, "invoice.total"),
				outstanding: documentWord(chosen, "invoice.outstanding"),
			})
		);
	};

	dateFormat.addEventListener("change", refreshPreview);
	timeFormat.addEventListener("change", refreshPreview);
	language.addEventListener("change", refreshPreview);
	refreshPreview();

	const save = el("button", { class: "button primary", type: "submit" }, t("settings.save_invoice"));

	return el(
		"form",
		{
			onSubmit: async (event) => {
				event.preventDefault();
				save.disabled = true;

				try {
					await Api.updateProject(uuid, {
						date_format: dateFormat.value,
						time_format: timeFormat.value,
						timezone: timezone.value.trim(),
						language: language.value,
						invoice_issuer_details: issuerDetails.checked,
					});
					invalidateProject(uuid);
					toast(t("settings.invoice_saved"), "success");
				} catch (error) {
					reportError(error);
				} finally {
					save.disabled = false;
				}
			},
		},
		el(
			"div",
			{ class: "form-grid" },
			field(t("app.language"), language, t("settings.document_language_hint")),
			field(t("settings.date_format"), dateFormat),
			field(t("settings.time_format"), timeFormat),
			field(t("settings.timezone"), timezone, t("settings.timezone_hint"))
		),
		preview,
		el(
			"div",
			{ class: "field" },
			el("label", { class: "switch" }, issuerDetails, el("span", {}, t("settings.issuer_details_switch"))),
			el("span", { class: "field-hint" }, t("settings.issuer_details_hint"))
		),
		el("div", { class: "form-actions" }, save)
	);
}

const SERIES_DEFAULTS: Record<NumberSeries, string> = {
	invoice: DEFAULT_INVOICE_FORMAT,
	proforma: DEFAULT_PROFORMA_FORMAT,
	order: DEFAULT_ORDER_FORMAT,
};

const SERIES_DOCUMENTS: Record<NumberSeries, string> = { invoice: "invoices", proforma: "pro forma invoices", order: "orders" };

const SERIES_NEXT: Record<NumberSeries, UiKey> = {
	invoice: "settings.next_invoice_will_be",
	proforma: "settings.next_proforma_will_be",
	order: "settings.next_order_will_be",
};

function formatExamples(series: NumberSeries) {
	if (series === "proforma") {
		return [
			{ format: DEFAULT_PROFORMA_FORMAT, note: t("settings.example_proforma_default") },
			{ format: "PR-XXXXXX", note: t("settings.example_restarts_never") },
			{ format: "PR/XXX/YY", note: t("settings.example_restarts_yearly") },
		];
	}
	if (series === "order") {
		return [
			{ format: DEFAULT_ORDER_FORMAT, note: t("settings.example_order_default") },
			{ format: "#YYXXXXXX", note: t("settings.example_restarts_yearly") },
			{ format: "NAR-XXXXXXX", note: t("settings.example_restarts_never") },
		];
	}
	return [
		{ format: "YYMMDDXXXXXX", note: t("settings.example_default") },
		{ format: "XXX/YY", note: t("settings.example_yearly") },
		{ format: "YYYY-XXXX", note: t("settings.example_year_prefix") },
		{ format: '"INV"-YYMM-XXXX', note: t("settings.example_monthly") },
		{ format: "XXXXXX", note: t("settings.example_never") },
	];
}

function settlementSection(uuid: string, project: Project): HTMLElement {
	const editable = can(project, Permission.PROJECT_EDIT);
	const choice = select(
		[
			{ value: "invoice", label: t("settings.settlement_invoice") },
			{ value: "advance", label: t("settings.settlement_advance") },
		],
		project.proforma_settlement
	);
	choice.disabled = !editable;
	choice.addEventListener("change", async () => {
		try {
			await Api.updateProject(uuid, { proforma_settlement: choice.value as ProformaSettlement });
			project.proforma_settlement = choice.value as ProformaSettlement;
			invalidateProject(uuid);
			toast(t("settings.settlement_saved"), "success");
		} catch (error) {
			choice.value = project.proforma_settlement;
			reportError(error);
		}
	});
	return field(t("settings.proforma_settlement"), choice, t("settings.proforma_settlement_hint"));
}

async function numberingSection(uuid: string, project: Project, series: NumberSeries): Promise<HTMLElement> {
	const editable = can(project, Permission.PROJECT_EDIT);
	let saved = await Api.invoiceNumbering(uuid, undefined, series);

	const format = input("text", { value: saved.format, maxlength: "30", autocomplete: "off" });
	const next = input("number", { min: "1", step: "1", value: String(saved.next_number), required: true });
	const preview = el("p", {});
	const capacity = el("p", { class: "muted" });
	const bankWarning = el("p", { class: "muted" }, t("settings.no_bank_reference"));
	const save = el("button", { class: "button primary", type: "submit" }, t("settings.save_numbering"));
	let requested = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const refresh = () => {
		const parsed = parseInvoiceFormat(format.value);
		if (!parsed.ok) {
			preview.className = "warn";
			preview.textContent = parsed.error;
			capacity.hidden = true;
			save.disabled = true;
			return;
		}

		const sequence = Number(next.value);
		const validNext = Number.isInteger(sequence) && sequence >= 1 && sequence <= parsed.format.capacity;
		next.max = String(parsed.format.capacity);
		capacity.textContent = describeInvoiceFormat(parsed.format, SERIES_DOCUMENTS[series]);
		capacity.hidden = false;

		if (!validNext) {
			preview.className = "warn";
			preview.textContent = t("settings.next_range", { max: parsed.format.capacity.toLocaleString() });
			save.disabled = true;
			return;
		}

		const sample = renderInvoiceNumber(parsed.format, Date.now(), sequence, project.timezone);
		preview.className = "";
		preview.replaceChildren(`${t(SERIES_NEXT[series])} `, el("strong", { class: "mono" }, sample), ".");
		bankWarning.hidden = creditorReference(sample) !== null;
		save.disabled = !editable;
	};

	const loadNextFor = (value: string) => {
		clearTimeout(timer);
		const parsed = parseInvoiceFormat(value);
		if (!parsed.ok) return;
		timer = setTimeout(async () => {
			const request = ++requested;
			try {
				const state = await Api.invoiceNumbering(uuid, parsed.format.source, series);
				if (request !== requested) return;
				next.value = String(state.next_number);
				refresh();
			} catch {
				void 0;
			}
		}, 400);
	};

	format.addEventListener("input", () => {
		refresh();
		loadNextFor(format.value);
	});
	next.addEventListener("input", refresh);
	refresh();

	format.disabled = !editable;
	next.disabled = !editable;

	const examples = el(
		"ul",
		{ class: "format-examples" },
		...formatExamples(series).map((example) =>
			el(
				"li",
				{},
				el(
					"button",
					{
						class: "link-button mono",
						type: "button",
						disabled: !editable,
						onClick: () => {
							format.value = example.format;
							refresh();
							loadNextFor(example.format);
						},
					},
					example.format
				),
				` ${example.note}`
			)
		)
	);

	return el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				save.disabled = true;
				try {
					saved = await Api.saveInvoiceNumbering(uuid, { series, format: format.value, next_number: Number(next.value) });
					format.value = saved.format;
					next.value = String(saved.next_number);
					invalidateProject(uuid);
					toast(t("settings.numbering_saved"), "success");
				} catch (error) {
					reportError(error);
				} finally {
					refresh();
				}
			},
		},
		el(
			"div",
			{ class: "form-grid" },
			field(t("settings.format"), format, t("settings.format_hint", { format: SERIES_DEFAULTS[series] })),
			field(t("settings.next_number"), next, t("settings.next_number_hint"))
		),
		preview,
		bankWarning,
		capacity,
		el("p", { class: "muted" }, t("settings.examples")),
		examples,
		series === "invoice" ? el("p", { class: "muted" }, t("settings.credit_note_numbers")) : null,
		editable ? el("div", { class: "form-actions" }, save) : el("p", { class: "muted" }, t("settings.owners_only"))
	);
}

async function taxSection(uuid: string, project: Project): Promise<HTMLElement> {
	const known = await currencyRates();
	const company = await Api.company(uuid).catch(() => null);

	const country = staticCombobox(countryOptions(), project.tax_country ?? "", {
		placeholder: t("country.search"),
		emptyText: t("country.no_match"),
	});
	const status = select([{ value: "", label: t("settings.not_set") }, ...vatStatusOptions()], project.vat_status ?? "");
	const oss = input("checkbox");
	oss.checked = project.oss_registered;

	const startCurrency = project.tax_currency ?? defaultTaxCurrency(project.tax_country) ?? project.currency;
	const currency = staticCombobox(currencyOptions(known.currencies, startCurrency), startCurrency, {
		required: true,
		placeholder: t("currency.search"),
		emptyText: t("currency.no_match"),
	});
	let currencyTouched = project.tax_currency !== null;
	currency.onChange(() => {
		currencyTouched = true;
	});

	const note = el("textarea", { rows: "2", maxlength: "500" });
	note.value = project.vat_exemption_note ?? "";

	const statusHint = el("span", { class: "field-hint" });
	const ossField = el("label", { class: "switch" }, oss, el("span", {}, t("settings.oss_switch")));
	const ossBox = el("div", { class: "field" }, ossField, el("span", { class: "field-hint" }, t("settings.oss_hint")));
	const noteBox = field(t("settings.exemption_note"), note, t("settings.exemption_note_hint"));
	const advice = el("div", {});
	const currencyHint = el("span", { class: "field-hint" });

	const refresh = () => {
		const code = country.value || null;
		const chosen = status.value;

		statusHint.textContent = chosen ? vatStatusHint(chosen) : t("settings.vat_status_hint");
		ossBox.hidden = !(chosen === "registered" && isEuCountry(code));
		noteBox.hidden = chosen !== "small_business";
		note.placeholder = defaultExemptionNote(code, project.language);

		const required = requiredTaxCurrency(code);
		currencyHint.textContent = required ? t("settings.reporting_currency_required", { currency: required }) : t("settings.reporting_currency_hint");
		if (required && currency.value !== required) currency.select({ value: required, label: currencyLabel(required) });

		if (!currencyTouched && !required) {
			const suggested = defaultTaxCurrency(code);
			if (suggested)
				currency.select(currency.selected && currency.selected.value === suggested ? currency.selected : { value: suggested, label: currencyLabel(suggested) });
		}

		const notes: HTMLElement[] = [];
		if (chosen === "registered" && !company?.vat_number) {
			notes.push(el("p", { class: "warn" }, t("settings.add_vat_number")));
		}
		if (chosen === "registered" && company?.vat_number && code && isEuCountry(code) && !splitVatNumber(company.vat_number, code)) {
			notes.push(el("p", { class: "warn" }, t("settings.vat_not_eu")));
		}
		if (chosen === "small_business") {
			notes.push(el("p", { class: "muted" }, t("settings.small_business_note")));
		}
		advice.replaceChildren(...notes);
	};

	status.addEventListener("change", refresh);
	country.onChange(refresh);
	currency.onChange(refresh);
	refresh();

	const save = el("button", { class: "button primary", type: "submit" }, t("settings.save_tax"));

	return el(
		"form",
		{
			onSubmit: async (event) => {
				event.preventDefault();
				save.disabled = true;

				try {
					const updated = await Api.updateProject(uuid, {
						tax_country: country.value || null,
						vat_status: status.value || null,
						oss_registered: !ossBox.hidden && oss.checked,
						tax_currency: currency.value || null,
						vat_exemption_note: note.value.trim() || null,
					});
					Object.assign(project, updated);
					invalidateProject(uuid);
					toast(t("settings.tax_saved"), "success");
				} catch (error) {
					reportError(error);
				} finally {
					save.disabled = false;
				}
			},
		},
		el(
			"div",
			{ class: "form-grid" },
			field(t("settings.tax_country"), country.element, t("settings.tax_country_hint")),
			el("label", { class: "field" }, el("span", { class: "field-label" }, t("settings.vat_status")), status, statusHint)
		),
		el(
			"div",
			{ class: "form-grid" },
			el("label", { class: "field" }, el("span", { class: "field-label" }, t("settings.reporting_currency")), currency.element, currencyHint),
			ossBox
		),
		noteBox,
		advice,
		el("div", { class: "form-actions" }, save)
	);
}

function terminalSection(uuid: string, project: Project): HTMLElement {
	const editable = can(project, Permission.PROJECT_EDIT);
	const customAmounts = input("checkbox");
	customAmounts.checked = project.pos_custom_amounts;
	customAmounts.disabled = !editable;

	const hint = el("p", { class: "muted" });
	const refreshHint = () => {
		hint.textContent = customAmounts.checked ? t("settings.custom_amounts_on") : t("settings.custom_amounts_off");
	};
	refreshHint();

	customAmounts.addEventListener("change", async () => {
		refreshHint();
		customAmounts.disabled = true;
		try {
			await Api.updateProject(uuid, { pos_custom_amounts: customAmounts.checked });
			invalidateProject(uuid);
			toast(customAmounts.checked ? t("settings.custom_amounts_enabled") : t("settings.custom_amounts_disabled"), "success");
		} catch (error) {
			customAmounts.checked = !customAmounts.checked;
			refreshHint();
			reportError(error);
		} finally {
			customAmounts.disabled = false;
		}
	});

	return el(
		"div",
		{ class: "stack" },
		el("label", { class: "switch" }, customAmounts, el("span", {}, t("settings.custom_amounts_switch"))),
		hint,
		editable ? null : el("p", { class: "muted" }, t("settings.owners_only"))
	);
}

function emailSection(uuid: string, project: Project): HTMLElement {
	if (!project.email_enabled) {
		return el(
			"div",
			{ class: "stack" },
			el("p", { class: "muted" }, t("settings.email_not_set_up")),
			el("a", { class: "button ghost", href: `/projects/${uuid}/license` }, t("settings.license_link"))
		);
	}

	const editable = can(project, Permission.PROJECT_EDIT);
	const attach = input("checkbox");
	attach.checked = project.email_attach_invoice;
	const attachEslog = input("checkbox");
	attachEslog.checked = project.email_attach_eslog;
	const payLink = input("checkbox");
	payLink.checked = project.email_pay_link;
	const portalLink = input("checkbox");
	portalLink.checked = project.email_portal_link;
	const reminders = input("checkbox");
	reminders.checked = project.email_reminders;
	const before = input("number", { min: "0", max: "30", step: "1", value: String(project.reminder_days_before), required: true });
	const after = input("number", { min: "0", max: "60", step: "1", value: String(project.reminder_days_after), required: true });
	const save = el("button", { class: "button primary", type: "submit" }, t("settings.save_email"));

	const timing = el(
		"div",
		{ class: "form-grid" },
		field(t("settings.days_before"), before, t("settings.days_before_hint")),
		field(t("settings.days_after"), after, t("settings.days_after_hint"))
	);

	const sync = () => {
		timing.hidden = !reminders.checked;
	};
	reminders.addEventListener("change", sync);
	sync();

	for (const control of [attach, attachEslog, payLink, portalLink, reminders, before, after, save]) control.disabled = !editable;

	return el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				save.disabled = true;
				try {
					await Api.updateProject(uuid, {
						email_attach_invoice: attach.checked,
						email_attach_eslog: attachEslog.checked,
						email_pay_link: payLink.checked,
						email_portal_link: portalLink.checked,
						email_reminders: reminders.checked,
						reminder_days_before: Number(before.value),
						reminder_days_after: Number(after.value),
					});
					invalidateProject(uuid);
					toast(t("settings.email_saved"), "success");
				} catch (error) {
					reportError(error);
				} finally {
					save.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, t("settings.email_intro")),
		el("label", { class: "switch" }, attach, el("span", {}, t("settings.attach_invoice_switch"))),
		el("label", { class: "switch" }, attachEslog, el("span", {}, t("settings.attach_eslog_switch"))),
		el("p", { class: "field-hint" }, t("settings.attach_eslog_hint")),
		el("label", { class: "switch" }, payLink, el("span", {}, t("settings.pay_link_switch"))),
		el("label", { class: "switch" }, portalLink, el("span", {}, t("settings.portal_link_switch"))),
		el("p", { class: "muted" }, t("settings.portal_link_hint")),
		el("p", { class: "muted" }, t("settings.invoice_email_note")),
		el("label", { class: "switch" }, reminders, el("span", {}, t("settings.reminders_switch"))),
		timing,
		el("p", { class: "muted" }, t("settings.reminders_note")),
		editable ? el("div", { class: "form-actions" }, save) : el("p", { class: "muted" }, t("settings.owners_only"))
	);
}

function appearanceSection(uuid: string, project: Project): HTMLElement {
	let chosen: string | null = project.accent_color;

	const picker = input("color", { value: chosen ?? BRAND_BLUE });
	const current = el("code", { class: "mono" });
	const save = el("button", { class: "button primary", type: "submit" }, t("settings.save_color"));

	const swatches = ACCENT_PRESETS.map((preset) =>
		el("button", {
			class: "swatch",
			type: "button",
			title: preset.label,
			dataset: { color: preset.value },
			onClick: () => choose(preset.value),
		})
	);

	const choose = (color: string | null) => {
		chosen = color;
		picker.value = color ?? BRAND_BLUE;
		current.textContent = color ?? t("settings.default_blue");
		for (const swatch of swatches) swatch.classList.toggle("selected", swatch.dataset.color === (color ?? BRAND_BLUE));
		applyAccent(color);
	};

	for (const swatch of swatches) swatch.style.background = swatch.dataset.color ?? "";
	picker.addEventListener("input", () => choose(picker.value.toLowerCase()));
	choose(chosen);

	const preview = el(
		"div",
		{ class: "accent-preview" },
		el("button", { class: "button primary", type: "button" }, t("settings.preview_pay")),
		el("button", { class: "button secondary", type: "button" }, t("processor.bitcoin")),
		el("span", { class: "pill pill-open" }, t("status.open")),
		el("a", { href: "#", onClick: (event) => event.preventDefault() }, t("settings.preview_link"))
	);

	return el(
		"form",
		{
			onSubmit: async (event) => {
				event.preventDefault();
				save.disabled = true;

				try {
					await Api.updateProject(uuid, { accent_color: chosen });
					project.accent_color = chosen;
					invalidateProject(uuid);
					toast(t("settings.color_saved"), "success");
				} catch (error) {
					reportError(error);
				} finally {
					save.disabled = false;
				}
			},
		},
		el("div", { class: "swatches" }, ...swatches, el("label", { class: "swatch-custom", title: t("settings.pick_color") }, picker)),
		el("p", { class: "muted" }, `${t("settings.selected")} `, current),
		preview,
		el("div", { class: "form-actions" }, el("button", { class: "button ghost", type: "button", onClick: () => choose(null) }, t("settings.use_default")), save)
	);
}

export async function settingsView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid, true);
	const editable = can(project, Permission.PROJECT_EDIT);
	const managesKeys = can(project, Permission.API_KEYS);
	const managesWebhooks = can(project, Permission.API_WEBHOOKS);
	const companyBox = editable ? companySection(uuid, project.vat_status, project.language as Language) : null;

	const name = input("text", { value: project.name, required: true });
	const displayName = input("text", { value: project.display_name ?? "", placeholder: project.name, maxlength: "120" });

	const known = await currencyRates();
	const currency = staticCombobox(currencyOptions(known.currencies, project.currency), project.currency, {
		required: true,
		placeholder: t("currency.search"),
		emptyText: t("currency.no_match"),
	});
	const saveButton = el("button", { class: "button primary", type: "submit" }, t("ui.save"));

	const detailsForm = el(
		"form",
		{
			onSubmit: async (event) => {
				event.preventDefault();
				saveButton.disabled = true;

				try {
					await Api.updateProject(uuid, {
						name: name.value.trim(),
						display_name: displayName.value.trim() || null,
						currency: currency.value || project.currency,
					});
					invalidateProject(uuid);
					toast(t("settings.project_updated"), "success");
				} catch (error) {
					reportError(error);
				} finally {
					saveButton.disabled = false;
				}
			},
		},
		el(
			"div",
			{ class: "form-grid" },
			field(t("projects.name"), name, t("settings.project_name_hint")),
			field(t("settings.display_name"), displayName, t("settings.display_name_hint")),
			field(t("settings.primary_currency"), currency.element, t("settings.primary_currency_hint"))
		),
		el("div", { class: "form-actions" }, saveButton)
	);

	const keysBox = el("div", { class: "stack" });

	const loadKeys = async () => {
		try {
			const keys = await Api.keys(uuid);
			keysBox.replaceChildren(
				el("p", { class: "muted" }, t("settings.keys_changed", { date: formatDateTime(keys.updated) })),
				keyRow(uuid, t("projects.primary_key"), "primary", keys.primary, loadKeys),
				keyRow(uuid, t("projects.secondary_key"), "secondary", keys.secondary, loadKeys)
			);
		} catch (error) {
			keysBox.replaceChildren(el("p", { class: "muted" }, t("settings.keys_permission")));
		}
	};

	if (managesKeys) void loadKeys();

	const webhooksBox = el("div", { class: "stack" });
	const webhookUrl = input("url", { value: project.webhook_url ?? "", placeholder: "https://example.com/webhooks/rabbitpay" });
	const saveWebhookUrl = el("button", { class: "button primary", type: "submit" }, t("settings.save_webhook_url"));
	const webhookUrlForm = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				saveWebhookUrl.disabled = true;
				try {
					const saved = await Api.setWebhookUrl(uuid, webhookUrl.value.trim() || null);
					webhookUrl.value = saved.webhook_url ?? "";
					invalidateProject(uuid);
					toast(saved.webhook_url ? t("settings.webhook_url_saved") : t("settings.webhook_url_cleared"), "success");
				} catch (error) {
					reportError(error);
				} finally {
					saveWebhookUrl.disabled = false;
				}
			},
		},
		field(t("settings.webhook_url"), webhookUrl, t("settings.webhook_url_hint")),
		el("div", { class: "form-actions" }, saveWebhookUrl)
	);

	const webhookPages = pagination(() => loadWebhooks());
	const loadWebhooks = async (): Promise<void> => {
		const round = webhookPages.state.begin();
		try {
			const [keys, log] = await Promise.all([Api.keys(uuid), Api.webhookDeliveries(uuid, { limit: PAGE_SIZE, offset: webhookPages.state.offset })]);

			if (!webhookPages.state.current(round)) return;
			if (webhookPages.update(log.total)) return await loadWebhooks();

			const secretRow = el(
				"div",
				{ class: "key-row" },
				el("div", {}, el("strong", {}, t("settings.signing_secret")), el("div", { class: "mono muted" }, keys.webhook_secret ?? t("settings.not_set"))),
				el(
					"button",
					{
						class: "button ghost",
						type: "button",
						onClick: async () => {
							const confirmed = await confirmDialog({
								title: t("settings.rotate_secret_title"),
								body: t("settings.rotate_secret_body"),
								confirmLabel: t("settings.rotate_secret"),
								destructive: true,
							});
							if (!confirmed) return;

							try {
								const result = await Api.rotateWebhookSecret(uuid);
								modal(t("settings.secret_rotated"), el("div", { class: "stack" }, secretReveal(t("settings.new_secret"), result.webhook_secret)));
								if (managesWebhooks) void loadWebhooks();
							} catch (error) {
								reportError(error);
							}
						},
					},
					t("settings.rotate")
				)
			);

			const recent =
				log.deliveries.length === 0
					? el("p", { class: "muted" }, t("settings.no_deliveries"))
					: table(
							[t("settings.column_event"), t("payments.status"), t("settings.column_tries"), t("settings.column_response"), t("payments.column_when")],
							log.deliveries.map((delivery) =>
								el(
									"tr",
									{},
									el("td", { class: "mono" }, delivery.event_type),
									el(
										"td",
										{},
										el(
											"span",
											{ class: `pill pill-${delivery.status === "delivered" ? "paid" : delivery.status === "failed" ? "canceled" : "open"}` },
											statusLabel(delivery.status)
										)
									),
									el("td", {}, String(delivery.attempts)),
									el("td", {}, delivery.response_status === null ? (delivery.last_error ?? "-") : String(delivery.response_status)),
									el("td", {}, formatDateTime(delivery.created))
								)
							)
						);

			webhooksBox.replaceChildren(
				el("p", { class: "muted" }, t("settings.webhooks_intro", { delivered: log.counts.delivered, pending: log.counts.pending, failed: log.counts.failed })),
				secretRow,
				recent,
				webhookPages.element
			);
		} catch (error) {
			if (!webhookPages.state.current(round)) return;
			webhookPages.fail();
			if (webhooksBox.childElementCount > 0) {
				reportError(error);
				return;
			}
			webhooksBox.replaceChildren(el("p", { class: "muted" }, t("settings.webhooks_permission")));
		}
	};

	void loadWebhooks();

	const dangerZone = el(
		"div",
		{ class: "card danger-zone" },
		el("h2", {}, t("settings.delete_project")),
		el("p", { class: "muted" }, t("settings.delete_project_note")),
		el(
			"button",
			{
				class: "button danger",
				type: "button",
				onClick: async () => {
					const confirmed = await confirmDialog({
						title: t("settings.delete_project"),
						body: t("settings.delete_project_body", { project: project.name }),
						confirmLabel: t("settings.delete_project"),
						destructive: true,
					});
					if (!confirmed) return;

					try {
						await Api.deleteProject(uuid);
						invalidateProject(uuid);
						toast(t("settings.project_deleted"), "success");
						navigate("/");
					} catch (error) {
						reportError(error);
					}
				},
			},
			t("settings.delete_this_project")
		)
	);

	const projectCards = editable
		? [
				el("div", { class: "card" }, el("h2", {}, t("customer.details")), detailsForm),
				el("div", { class: "card" }, el("h2", {}, t("settings.company")), el("p", { class: "muted" }, t("settings.company_intro")), companyBox),
				el(
					"div",
					{ class: "card" },
					el("h2", {}, t("payments.invoice")),
					el("p", { class: "muted" }, t("settings.invoice_intro")),
					invoiceSection(uuid, project)
				),
				el("div", { class: "card", id: "invoice-design" }, el("h2", {}, t("design.title")), await invoiceDesignSection(uuid, project)),
				el("div", { class: "card", id: "email-design" }, el("h2", {}, t("emails.title")), await emailDesignSection(uuid, project)),
				el(
					"div",
					{ class: "card stack", id: "numbering" },
					el("h2", {}, t("settings.document_numbers")),
					el("p", { class: "muted" }, t("settings.numbering_intro")),
					el("h3", {}, t("settings.invoice_numbers")),
					await numberingSection(uuid, project, "invoice"),
					el("div", { class: "divider" }),
					el("h3", {}, t("settings.proforma_numbers")),
					el("p", { class: "muted" }, t("settings.proforma_intro")),
					settlementSection(uuid, project),
					await numberingSection(uuid, project, "proforma"),
					el("div", { class: "divider" }),
					el("h3", {}, t("settings.order_numbers")),
					el("p", { class: "muted" }, t("settings.order_intro")),
					await numberingSection(uuid, project, "order")
				),
				el("div", { class: "card" }, el("h2", {}, t("settings.tax")), el("p", { class: "muted" }, t("settings.tax_intro")), await taxSection(uuid, project)),
				project.tax_country === "SI"
					? el("div", { class: "card", id: "fiscal" }, el("h2", {}, t("fiscal.title")), el("p", { class: "muted" }, t("fiscal.intro")), fiscalSection(uuid))
					: null,
				el("div", { class: "card", id: "einvoice" }, el("h2", {}, t("einvoice.title")), el("p", { class: "muted" }, t("einvoice.intro")), signingSection(uuid)),
				el(
					"div",
					{ class: "card" },
					el("h2", {}, t("settings.accent_color")),
					el("p", { class: "muted" }, t("settings.accent_intro")),
					appearanceSection(uuid, project)
				),
				el("div", { class: "card" }, el("h2", {}, t("settings.email")), emailSection(uuid, project)),
				el("div", { class: "card" }, el("h2", {}, t("nav.terminal")), terminalSection(uuid, project)),
				el("div", { class: "card" }, el("h2", {}, t("overview.methods_title")), processorsSection(uuid)),
			]
		: [];

	const content = el(
		"div",
		{ class: "stack" },
		...projectCards,
		managesKeys ? el("div", { class: "card" }, el("h2", {}, t("settings.api_keys")), el("p", { class: "muted" }, t("settings.api_keys_intro")), keysBox) : null,
		managesWebhooks ? el("div", { class: "card" }, el("h2", {}, t("settings.webhooks")), webhookUrlForm, webhooksBox) : null,
		can(project, Permission.PROJECT_DELETE) ? dangerZone : null
	);

	return projectLayout(project, content);
}
