import { Api, type FiscalDocument, type FiscalPremise, type FiscalPremiseInput, type FiscalSettings } from "../api";
import { el, field, input, select, table } from "../dom";
import { formatDate, formatDateTime, formatMoney } from "../money";
import { confirmDialog, reportError, toast } from "../ui";
import { t } from "../i18n";

const MARK = /^[0-9A-Za-z]{1,20}$/;

export async function base64Of(file: File): Promise<string> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function pill(label: string, tone: "paid" | "pending" | "canceled" | "neutral"): HTMLElement {
	return el("span", { class: tone === "neutral" ? "pill" : `pill pill-${tone}` }, label);
}

function statusPill(status: FiscalDocument["status"]): HTMLElement {
	if (status === "verified") return pill(t("fiscal.status_verified"), "paid");
	if (status === "rejected") return pill(t("fiscal.status_rejected"), "canceled");
	return pill(t("fiscal.status_pending"), "pending");
}

function premiseSummary(premise: FiscalPremise): string {
	if (premise.kind === "movable") return t(`fiscal.type_${premise.premise_type ?? "C"}` as "fiscal.type_C");
	const house = [premise.house_number, premise.house_number_additional].filter(Boolean).join("");
	return `${premise.street} ${house}, ${premise.postal_code} ${premise.city}`;
}

export function fiscalSection(uuid: string): HTMLElement {
	const container = el("div", { class: "stack" });

	const render = (settings: FiscalSettings) => {
		container.replaceChildren(
			statusLine(settings),
			certificateBlock(settings),
			premisesBlock(settings),
			devicesBlock(settings),
			operatorsBlock(settings),
			documentsBlock()
		);
	};

	const refresh = async () => {
		try {
			render(await Api.fiscal(uuid));
		} catch (error) {
			reportError(error);
		}
	};

	const statusLine = (settings: FiscalSettings): HTMLElement => {
		const notices = [
			!settings.active ? el("p", { class: "warn" }, t("fiscal.blocked")) : null,
			settings.late > 0 ? el("p", { class: "warn" }, t("fiscal.late")) : null,
			settings.due_soon > 0 ? el("p", { class: "warn" }, t("fiscal.due_soon")) : null,
			settings.rejected > 0 ? el("p", { class: "warn" }, t("fiscal.rejected_notice")) : null,
			settings.active && !settings.operator_tax_number && settings.operators.some((operator) => operator.tax_number === null)
				? el("p", { class: "warn" }, t("fiscal.operators_missing"))
				: null,
		];
		return el(
			"div",
			{ class: "stack fiscal-status" },
			el(
				"div",
				{ class: "fiscal-pills" },
				settings.active ? pill(t("fiscal.active"), "paid") : pill(t("fiscal.inactive"), "canceled"),
				settings.certificate ? pill(t(settings.environment === "test" ? "fiscal.environment_test" : "fiscal.environment_production"), "neutral") : null,
				settings.pending > 0 ? pill(t("fiscal.waiting", { count: String(settings.pending) }), "pending") : null
			),
			...notices
		);
	};

	const certificateBlock = (settings: FiscalSettings): HTMLElement => {
		const file = input("file");
		file.accept = ".p12,.pfx,application/x-pkcs12";
		file.required = true;
		const password = input("password", { autocomplete: "off", required: true });
		const submit = el("button", { class: "button primary", type: "submit" }, settings.certificate ? t("fiscal.replace") : t("fiscal.upload"));

		const form = el(
			"form",
			{
				class: "stack",
				onSubmit: async (event) => {
					event.preventDefault();
					const chosen = file.files?.[0];
					if (!chosen) return;
					submit.disabled = true;
					try {
						render(await Api.uploadFiscalCertificate(uuid, await base64Of(chosen), password.value));
						toast(t("fiscal.uploaded"), "success");
					} catch (error) {
						reportError(error);
						submit.disabled = false;
					}
				},
			},
			el("div", { class: "form-grid" }, field(t("fiscal.certificate_file"), file), field(t("fiscal.certificate_password"), password)),
			el("div", { class: "form-actions" }, submit)
		);

		const check = el("button", { class: "button ghost", type: "button" }, t("fiscal.check"));
		check.addEventListener("click", async () => {
			check.disabled = true;
			try {
				await Api.fiscalEcho(uuid);
				toast(t("fiscal.check_ok"), "success");
			} catch (error) {
				reportError(error);
			} finally {
				check.disabled = false;
			}
		});

		const remove = el("button", { class: "button danger", type: "button" }, t("fiscal.remove_cert"));
		remove.addEventListener("click", async () => {
			const confirmed = await confirmDialog({
				title: t("fiscal.remove_title"),
				body: t("fiscal.remove_body"),
				confirmLabel: t("fiscal.remove_cert"),
				destructive: true,
			});
			if (!confirmed) return;
			try {
				render(await Api.removeFiscalCertificate(uuid));
			} catch (error) {
				reportError(error);
			}
		});

		const current = settings.certificate
			? el(
					"div",
					{ class: "fiscal-facts" },
					el("p", {}, el("span", { class: "muted" }, `${t("fiscal.holder")}: `), settings.certificate.holder ?? ""),
					el("p", {}, el("span", { class: "muted" }, `${t("fiscal.tax_number")}: `), String(settings.certificate.tax_number ?? "")),
					settings.certificate.valid_to
						? el("p", {}, el("span", { class: "muted" }, `${t("fiscal.valid_to")}: `), formatDate(settings.certificate.valid_to))
						: null,
					el("div", { class: "form-actions" }, check, remove)
				)
			: null;

		return el(
			"section",
			{ class: "fiscal-step" },
			el("h3", {}, t("fiscal.step_certificate")),
			el("p", { class: "muted" }, t("fiscal.certificate_hint")),
			current,
			settings.certificate ? el("details", {}, el("summary", {}, t("fiscal.replace")), form) : form
		);
	};

	const premisesBlock = (settings: FiscalSettings): HTMLElement => {
		const open = settings.premises.filter((premise) => premise.environment === settings.environment && premise.closed_at === null);
		const rows = open.map((premise) => {
			const close = el("button", { class: "button ghost small", type: "button" }, t("fiscal.close"));
			close.addEventListener("click", async () => {
				const confirmed = await confirmDialog({
					title: t("fiscal.close_title", { premise: premise.premise_id }),
					body: t("fiscal.close_body"),
					confirmLabel: t("fiscal.close"),
					destructive: true,
				});
				if (!confirmed) return;
				try {
					render(await Api.closeFiscalPremise(uuid, premise.premise_id));
				} catch (error) {
					reportError(error);
				}
			});
			return el(
				"tr",
				{},
				el("td", { class: "mono" }, premise.premise_id),
				el("td", {}, premiseSummary(premise)),
				el("td", {}, formatDate(premise.registered_at)),
				el("td", {}, close)
			);
		});

		return el(
			"section",
			{ class: "fiscal-step" },
			el("h3", {}, t("fiscal.step_premise")),
			el("p", { class: "muted" }, t("fiscal.premise_hint")),
			rows.length > 0
				? table([t("fiscal.premise_id"), t("fiscal.address"), t("fiscal.registered_on"), ""], rows)
				: el("p", { class: "muted" }, t("fiscal.no_premises")),
			settings.certificate ? premiseForm() : null
		);
	};

	const premiseForm = (): HTMLElement => {
		const premiseId = input("text", { required: true, maxlength: "20", placeholder: "SPLET" });
		const kind = select([
			{ value: "real_estate", label: t("fiscal.kind_real_estate") },
			{ value: "movable", label: t("fiscal.kind_movable") },
		]);
		const type = select(
			["A", "B", "C"].map((value) => ({ value, label: t(`fiscal.type_${value}` as "fiscal.type_A") })),
			"C"
		);
		const number = (max: number) => input("number", { min: "0", max: String(max), step: "1" });
		const cadastral = number(9999);
		const building = number(99999);
		const section = number(9999);
		const street = input("text", { maxlength: "100" });
		const house = input("text", { maxlength: "10" });
		const additional = input("text", { maxlength: "10" });
		const community = input("text", { maxlength: "100" });
		const city = input("text", { maxlength: "100" });
		const postal = input("text", { maxlength: "4", placeholder: "1000" });
		postal.inputMode = "numeric";

		const buildingFields = el(
			"div",
			{ class: "stack" },
			el(
				"div",
				{ class: "form-grid three" },
				field(t("fiscal.cadastral"), cadastral),
				field(t("fiscal.building"), building),
				field(t("fiscal.section"), section)
			),
			el(
				"div",
				{ class: "form-grid three" },
				field(t("fiscal.street"), street),
				field(t("fiscal.house"), house),
				field(t("fiscal.house_additional"), additional)
			),
			el("div", { class: "form-grid three" }, field(t("fiscal.community"), community), field(t("fiscal.postal"), postal), field(t("fiscal.city"), city))
		);
		const movableFields = field(t("fiscal.premise_type"), type);
		const requiredFields = [cadastral, building, section, street, house, community, city, postal];

		const sync = () => {
			const movable = kind.value === "movable";
			buildingFields.hidden = movable;
			movableFields.hidden = !movable;
			for (const control of requiredFields) control.required = !movable;
		};
		kind.addEventListener("change", sync);
		sync();

		const submit = el("button", { class: "button primary", type: "submit" }, t("fiscal.register"));
		const form = el(
			"form",
			{
				class: "stack",
				onSubmit: async (event) => {
					event.preventDefault();
					if (!MARK.test(premiseId.value.trim())) {
						toast(t("fiscal.premise_id_hint"), "error");
						return;
					}
					const body: FiscalPremiseInput =
						kind.value === "movable"
							? { premise_id: premiseId.value.trim(), kind: "movable", premise_type: type.value as "A" | "B" | "C" }
							: {
									premise_id: premiseId.value.trim(),
									kind: "real_estate",
									cadastral_number: Number(cadastral.value),
									building_number: Number(building.value),
									building_section_number: Number(section.value),
									street: street.value.trim(),
									house_number: house.value.trim(),
									...(additional.value.trim() ? { house_number_additional: additional.value.trim() } : {}),
									community: community.value.trim(),
									city: city.value.trim(),
									postal_code: postal.value.trim(),
								};
					submit.disabled = true;
					try {
						render(await Api.registerFiscalPremise(uuid, body));
						toast(t("fiscal.registered"), "success");
					} catch (error) {
						reportError(error);
						submit.disabled = false;
					}
				},
			},
			el("div", { class: "form-grid" }, field(t("fiscal.premise_id"), premiseId, t("fiscal.premise_id_hint")), field(t("fiscal.kind"), kind)),
			buildingFields,
			movableFields,
			el("div", { class: "form-actions" }, submit)
		);
		return el("details", {}, el("summary", {}, t("fiscal.add_premise")), form);
	};

	const devicesBlock = (settings: FiscalSettings): HTMLElement => {
		const open = settings.premises.filter((premise) => premise.environment === settings.environment && premise.closed_at === null);
		const options = open.map((premise) => ({ value: premise.premise_id, label: premise.premise_id }));
		const onlinePremise = select(options, settings.online_premise ?? options[0]?.value);
		const onlineDevice = input("text", { maxlength: "20", value: settings.online_device ?? "SPLET" });
		const posPremise = select([{ value: "", label: t("fiscal.same_as_invoices") }, ...options], settings.pos_premise ?? "");
		const posDevice = input("text", { maxlength: "20", value: settings.pos_device ?? "BLAG1" });
		const operator = input("text", { maxlength: "8", value: settings.operator_tax_number ? String(settings.operator_tax_number) : "" });
		operator.inputMode = "numeric";
		const enabled = input("checkbox");
		enabled.checked = settings.enabled;

		const syncTerminal = () => {
			posDevice.disabled = posPremise.value === "";
		};
		posPremise.addEventListener("change", syncTerminal);
		syncTerminal();

		const submit = el("button", { class: "button primary", type: "submit" }, t("fiscal.save"));
		const form = el(
			"form",
			{
				class: "stack",
				onSubmit: async (event) => {
					event.preventDefault();
					const invalidDevice = !MARK.test(onlineDevice.value.trim()) || (posPremise.value !== "" && !MARK.test(posDevice.value.trim()));
					if (invalidDevice) {
						toast(t("fiscal.device_hint"), "error");
						return;
					}
					const operatorValue = operator.value.trim();
					if (operatorValue && !/^\d{8}$/.test(operatorValue)) {
						toast(t("fiscal.operator_hint"), "error");
						return;
					}
					submit.disabled = true;
					try {
						render(
							await Api.updateFiscal(uuid, {
								online_premise: onlinePremise.value || null,
								online_device: onlineDevice.value.trim(),
								pos_premise: posPremise.value || null,
								pos_device: posPremise.value ? posDevice.value.trim() : null,
								operator_tax_number: operatorValue ? Number(operatorValue) : null,
								enabled: enabled.checked,
							})
						);
						toast(t("fiscal.saved"), "success");
					} catch (error) {
						reportError(error);
						submit.disabled = false;
					}
				},
			},
			el("h4", {}, t("fiscal.online")),
			el("div", { class: "form-grid" }, field(t("fiscal.premise"), onlinePremise), field(t("fiscal.device"), onlineDevice, t("fiscal.device_hint"))),
			el("h4", {}, t("fiscal.terminal")),
			el("div", { class: "form-grid" }, field(t("fiscal.premise"), posPremise), field(t("fiscal.device"), posDevice)),
			field(t("fiscal.operator"), operator, t("fiscal.operator_hint")),
			el("label", { class: "switch" }, enabled, el("span", {}, t("fiscal.enable"))),
			el("div", { class: "form-actions" }, submit)
		);

		return el(
			"section",
			{ class: "fiscal-step" },
			el("h3", {}, t("fiscal.step_devices")),
			el("p", { class: "muted" }, t("fiscal.devices_hint")),
			options.length > 0 ? form : el("p", { class: "muted" }, t("fiscal.devices_need_premise"))
		);
	};

	const operatorsBlock = (settings: FiscalSettings): HTMLElement => {
		const rows = settings.operators.map((operator) => {
			const taxNumber = input("text", { maxlength: "8", value: operator.tax_number ? String(operator.tax_number) : "", placeholder: "12345678" });
			taxNumber.inputMode = "numeric";
			const save = el("button", { class: "button ghost small", type: "button" }, t("fiscal.save"));
			save.addEventListener("click", async () => {
				const value = taxNumber.value.trim();
				if (value && !/^\d{8}$/.test(value)) {
					toast(t("fiscal.operator_hint"), "error");
					return;
				}
				save.disabled = true;
				try {
					render(await Api.setFiscalOperator(uuid, operator.username, value ? Number(value) : null));
					toast(t("fiscal.operator_saved", { name: operator.name }), "success");
				} catch (error) {
					reportError(error);
					save.disabled = false;
				}
			});
			return el(
				"tr",
				{},
				el("td", {}, operator.name, operator.name !== operator.email ? el("div", { class: "muted" }, operator.email) : null),
				el("td", {}, operator.tax_number === null ? pill(t("fiscal.operator_none"), "pending") : pill(t("fiscal.operator_set"), "paid")),
				el("td", {}, taxNumber),
				el("td", {}, save)
			);
		});
		return el(
			"section",
			{ class: "fiscal-step" },
			el("h3", {}, t("fiscal.step_operators")),
			el("p", { class: "muted" }, t("fiscal.operators_hint")),
			table([t("fiscal.column_person"), t("fiscal.column_status"), t("fiscal.tax_number"), ""], rows)
		);
	};

	const documentsBlock = (): HTMLElement => {
		const body = el("div", {}, el("p", { class: "muted" }, t("fiscal.loading")));
		const load = async () => {
			try {
				const { documents } = await Api.fiscalDocuments(uuid);
				if (documents.length === 0) {
					body.replaceChildren(el("p", { class: "muted" }, t("fiscal.no_documents")));
					return;
				}
				body.replaceChildren(
					table(
						[t("fiscal.column_invoice"), t("fiscal.column_issued"), t("fiscal.column_amount"), t("fiscal.column_status"), t("fiscal.column_detail"), ""],
						documents.map((document) => {
							const retry =
								document.status === "verified"
									? null
									: el(
											"button",
											{
												class: "button ghost small",
												type: "button",
												onClick: async () => {
													try {
														await Api.retryFiscalDocument(uuid, document.uuid);
														await load();
													} catch (error) {
														reportError(error);
													}
												},
											},
											t("fiscal.retry")
										);
							const detail =
								document.status === "verified"
									? el("span", { class: "mono" }, document.eor ?? "")
									: el(
											"span",
											{ class: document.status === "rejected" ? "warn" : "muted" },
											[document.error_code, document.last_error].filter(Boolean).join(" ")
										);
							return el(
								"tr",
								{},
								el("td", { class: "mono" }, document.reference),
								el("td", {}, formatDateTime(document.issued_at)),
								el("td", { class: "numeric" }, formatMoney(document.amount, "EUR")),
								el("td", {}, statusPill(document.status)),
								el("td", {}, detail),
								el("td", {}, retry)
							);
						})
					)
				);
			} catch (error) {
				reportError(error);
			}
		};
		void load();
		return el("section", { class: "fiscal-step" }, el("h3", {}, t("fiscal.step_documents")), body);
	};

	void refresh();
	return container;
}
