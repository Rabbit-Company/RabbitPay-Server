import { pagedTable } from "../pagination";
import { LICENSE_VENDOR } from "../../../server/license-vendor";
import { Api, type EmailServer, type Project, type ProjectLicense } from "../api";
import { el, field, input } from "../dom";
import { formatBytes, formatDate } from "../money";
import { confirmDialog, reportError, toast } from "../ui";
import { can, Permission } from "../access";
import { invalidateProject, loadProject, projectLayout } from "./project";
import { t, tn } from "../i18n";
import { convertToWebp, ImageTooLargeError, ImageUnreadableError, toBase64 } from "../image";

export function describeLicense(
	license: Pick<ProjectLicense["licenses"][number], "type" | "transactions" | "duration_days" | "storage_gb" | "employees">
): string {
	if (license.type === "transactions") return t("license.grants_payments", { count: (license.transactions ?? 0).toLocaleString() });
	if (license.type === "storage") {
		return t("license.grants_storage", { size: `${(license.storage_gb ?? 0).toLocaleString()} GB`, days: tn("count.days", license.duration_days ?? 0) });
	}
	if (license.type === "store") return t("license.grants_store", { days: tn("count.days", license.duration_days ?? 0) });
	if (license.type === "workforce") return t("license.grants_workforce", { days: tn("count.days", license.duration_days ?? 0) });
	if (license.type === "accounting") return t("license.grants_accounting", { days: tn("count.days", license.duration_days ?? 0) });
	if (license.type === "employees") {
		return t("license.grants_employees", { employees: tn("count.employees", license.employees ?? 0), days: tn("count.days", license.duration_days ?? 0) });
	}
	return t("license.grants_white_label", { days: tn("count.days", license.duration_days ?? 0) });
}

const MAX_LOGO_BYTES = 150 * 1024;

function usageMeter(used: number, total: number): HTMLElement {
	const share = total <= 0 ? 100 : Math.min((used / total) * 100, 100);
	const bar = el("div", { class: "meter-fill" });
	bar.style.width = `${share}%`;
	return el("div", { class: `meter ${share >= 100 ? "meter-full" : share >= 80 ? "meter-high" : ""}` }, bar);
}

function usageCard(state: ProjectLicense): HTMLElement {
	if (!state.enforced) {
		return el("div", { class: "card" }, el("h2", {}, t("nav.payments")), el("p", {}, t("license.no_limits")));
	}

	const freeLeft = Math.max(state.free_allowance - state.free_used, 0);
	const remaining = state.remaining ?? 0;

	return el(
		"div",
		{ class: "card stack" },
		el("h2", {}, t("license.payments_this_month")),
		el(
			"div",
			{ class: "totals usage-totals" },
			el(
				"div",
				{ class: "totals-row" },
				el("span", {}, t("license.free_used")),
				el("span", { class: "mono" }, t("license.of", { used: state.free_used.toLocaleString(), total: state.free_allowance.toLocaleString() }))
			),
			usageMeter(state.free_used, state.free_allowance),
			el("div", { class: "totals-row" }, el("span", {}, t("license.paid_used")), el("span", { class: "mono" }, state.paid_used.toLocaleString())),
			el(
				"div",
				{ class: "totals-row" },
				el("span", {}, t("license.paid_balance")),
				el("span", { class: state.paid_balance < 0 ? "mono warn-text" : "mono" }, state.paid_balance.toLocaleString())
			),
			el(
				"div",
				{ class: "totals-row grand" },
				el("span", {}, t("license.payments_left")),
				el("span", { class: "mono" }, Math.max(remaining, 0).toLocaleString())
			)
		),
		el(
			"p",
			{ class: "muted" },
			t("license.usage_note", {
				allowance: state.free_allowance.toLocaleString(),
				date: formatDate(state.resets_at),
				left: freeLeft.toLocaleString(),
			})
		),
		remaining <= 0 ? el("p", { class: "warn" }, t("license.none_left")) : null,
		state.paid_balance < 0 ? el("p", { class: "muted" }, t("license.negative_balance", { count: Math.abs(state.paid_balance).toLocaleString() })) : null
	);
}

function storageCard(state: ProjectLicense): HTMLElement {
	const limit = state.storage_limit;
	const remaining = state.storage_remaining;
	return el(
		"div",
		{ class: "card stack" },
		el("h2", {}, t("license.storage")),
		el(
			"div",
			{ class: "totals usage-totals" },
			el("div", { class: "totals-row" }, el("span", {}, t("license.storage_used")), el("span", { class: "mono" }, formatBytes(state.storage_used))),
			limit === null
				? el("div", { class: "totals-row grand" }, el("span", {}, t("license.storage_limit")), el("span", { class: "mono" }, t("license.unlimited")))
				: el(
						"div",
						{},
						el(
							"div",
							{ class: "totals-row" },
							el("span", {}, t("license.storage_included")),
							el("span", { class: "mono" }, formatBytes(state.storage_included))
						),
						...state.storage_grants.map((grant) =>
							el(
								"div",
								{ class: "totals-row" },
								el("span", {}, t("license.storage_key_until", { date: formatDate(grant.until) })),
								el("span", { class: "mono" }, `${grant.storage_gb.toLocaleString()} GB`)
							)
						),
						usageMeter(state.storage_used, limit),
						el(
							"div",
							{ class: "totals-row grand" },
							el("span", {}, t("license.storage_left")),
							el("span", { class: "mono" }, formatBytes(Math.max(remaining ?? 0, 0)))
						)
					)
		),
		el("p", { class: "muted" }, t("license.storage_hint")),
		remaining !== null && remaining <= 0 ? el("p", { class: "warn" }, t("license.storage_full")) : null
	);
}

function redeemCard(uuid: string, state: ProjectLicense, onRedeemed: (state: ProjectLicense) => void): HTMLElement {
	const code = input("text", {
		placeholder: state.license_issuer ? "RPAY-XXXXX-XXXXX-XXXXX-XXXXX" : "RPAY2.",
		required: true,
		autocomplete: "off",
		maxlength: "2000",
	});
	const submit = el("button", { class: "button primary", type: "submit" }, t("license.redeem"));

	return el(
		"form",
		{
			class: "card stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					const state = await Api.redeemLicense(uuid, code.value);
					const latest = state.licenses[0];
					toast(latest ? t("license.redeemed_toast", { grants: describeLicense(latest) }) : t("license.redeemed"), "success");
					code.value = "";
					onRedeemed(state);
				} catch (error) {
					reportError(error);
				} finally {
					submit.disabled = false;
				}
			},
		},
		el("h2", {}, t("license.redeem_title")),
		el("p", { class: "muted" }, t("license.redeem_hint")),
		state.license_issuer
			? null
			: el(
					"p",
					{ class: "muted" },
					t("license.buy_for_server", { vendor: LICENSE_VENDOR.name }),
					" ",
					el("a", { href: LICENSE_VENDOR.url, target: "_blank", rel: "noopener" }, LICENSE_VENDOR.url.replace(/^https:\/\//, "")),
					" | ",
					el("a", { href: `mailto:${LICENSE_VENDOR.email}` }, LICENSE_VENDOR.email)
				),
		state.license_issuer ? null : el("p", {}, t("license.server_id"), " ", el("code", { class: "mono" }, state.server_id)),
		el("div", { class: "toolbar redeem-row" }, code, submit)
	);
}

function logoSection(uuid: string, state: ProjectLicense, savedLogo: boolean, editable: boolean, refresh: () => void): HTMLElement {
	const picker = input("file");
	picker.accept = "image/*";
	picker.hidden = true;

	let preview: HTMLElement = el("p", { class: "muted" }, savedLogo && !state.white_label ? t("license.logo_kept") : t("license.no_logo"));
	if (state.logo) {
		const image = el("img", { class: "brand-logo-preview" });
		image.src = state.logo;
		image.alt = t("license.logo_alt");
		preview = image;
	}

	picker.addEventListener("change", async () => {
		const file = picker.files?.[0];
		picker.value = "";
		if (!file) return;
		try {
			const converted = await convertToWebp(file, MAX_LOGO_BYTES);
			await Api.uploadLogo(uuid, await toBase64(converted));
			toast(t("license.logo_uploaded"), "success");
			refresh();
		} catch (error) {
			if (error instanceof ImageUnreadableError) toast(t("license.logo_unreadable"), "error");
			else if (error instanceof ImageTooLargeError) toast(t("license.logo_too_big"), "error");
			else reportError(error);
		}
	});

	const upload = el(
		"button",
		{ class: "button ghost", type: "button", disabled: !editable || !state.white_label, onClick: () => picker.click() },
		state.logo ? t("license.replace_logo") : t("license.upload_logo")
	);
	const remove = state.logo
		? el(
				"button",
				{
					class: "button ghost",
					type: "button",
					disabled: !editable,
					onClick: async () => {
						try {
							await Api.removeLogo(uuid);
							toast(t("license.logo_removed"), "success");
							refresh();
						} catch (error) {
							reportError(error);
						}
					},
				},
				t("members.remove")
			)
		: null;

	return el(
		"div",
		{ class: "stack" },
		el("h3", {}, t("license.logo")),
		el("p", { class: "muted" }, t("license.logo_hint")),
		preview,
		el("div", { class: "line-actions" }, upload, remove, picker)
	);
}

function emailServerSection(
	uuid: string,
	project: Project,
	state: ProjectLicense,
	current: EmailServer | null,
	editable: boolean,
	refresh: () => void
): HTMLElement {
	const host = input("text", { value: current?.host ?? "", placeholder: "smtp.example.com", required: true });
	const port = input("number", { value: String(current?.port ?? 587), min: "1", max: "65535", step: "1", required: true });
	const secure = input("checkbox");
	secure.checked = current?.secure ?? false;
	const username = input("text", { value: current?.username ?? "", autocomplete: "off" });
	const password = input("password", { placeholder: current?.password_set ? t("processors.secret_set") : "", autocomplete: "new-password" });
	const from = input("email", { value: current?.from_address ?? "", placeholder: "billing@yourcompany.com", required: true });
	const testTo = input("email", { placeholder: t("license.test_placeholder") });
	const save = el("button", { class: "button primary", type: "submit" }, t("license.save_email_server"));
	const enabled = editable && state.white_label;

	for (const control of [host, port, secure, username, password, from, save]) control.disabled = !enabled;

	const test = el(
		"button",
		{
			class: "button ghost",
			type: "button",
			disabled: !enabled || current === null,
			onClick: async () => {
				test.disabled = true;
				try {
					const result = await Api.testEmailServer(uuid, testTo.value.trim());
					toast(t("license.test_sent", { to: result.to }), "success");
				} catch (error) {
					reportError(error);
				} finally {
					test.disabled = false;
				}
			},
		},
		t("license.send_test")
	);

	const remove =
		current && editable
			? el(
					"button",
					{
						class: "button ghost",
						type: "button",
						onClick: async () => {
							const confirmed = await confirmDialog({
								title: t("license.remove_server_title"),
								body: t("license.remove_server_body"),
								confirmLabel: t("members.remove"),
								destructive: true,
							});
							if (!confirmed) return;
							try {
								await Api.removeEmailServer(uuid);
								invalidateProject(uuid);
								toast(t("license.server_removed"), "success");
								refresh();
							} catch (error) {
								reportError(error);
							}
						},
					},
					t("members.remove")
				)
			: null;

	return el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				save.disabled = true;
				try {
					await Api.saveEmailServer(uuid, {
						host: host.value.trim(),
						port: Number(port.value),
						secure: secure.checked,
						username: username.value.trim(),
						password: password.value,
						from_address: from.value.trim(),
					});
					invalidateProject(uuid);
					toast(t("license.server_saved"), "success");
					refresh();
				} catch (error) {
					reportError(error);
				} finally {
					save.disabled = false;
				}
			},
		},
		el("h3", {}, t("license.email_server")),
		el("p", { class: "muted" }, t("license.email_server_hint", { project: project.public_name })),
		el(
			"div",
			{ class: "form-grid" },
			field(t("license.smtp_host"), host),
			field(t("license.port"), port, t("license.port_hint")),
			field(t("login.username"), username, t("license.username_hint")),
			field(t("login.password"), password),
			field(t("license.from_address"), from)
		),
		el("label", { class: "switch" }, secure, el("span", {}, t("license.implicit_tls"))),
		el("div", { class: "form-actions" }, save, remove),
		current ? el("div", { class: "toolbar" }, testTo, test) : null
	);
}

function whiteLabelCard(uuid: string, project: Project, state: ProjectLicense, server: EmailServer | null, refresh: () => void): HTMLElement {
	const editable = can(project, Permission.PROJECT_EDIT);

	const status = !state.enforced
		? el("p", {}, t("license.white_label_included"))
		: state.white_label
			? el("p", {}, el("span", { class: "pill pill-active" }, t("status.active")), ` ${t("license.until", { date: formatDate(state.white_label_until) })}`)
			: el(
					"p",
					{ class: "warn" },
					state.white_label_until ? t("license.white_label_ended", { date: formatDate(state.white_label_until) }) : t("license.white_label_offer")
				);

	return el(
		"div",
		{ class: "card stack" },
		el("h2", {}, t("license.white_label")),
		status,
		el("div", { class: "divider" }),
		logoSection(uuid, state, project.has_logo, editable, refresh),
		el("div", { class: "divider" }),
		editable ? emailServerSection(uuid, project, state, server, editable, refresh) : el("p", { class: "muted" }, t("license.email_server_permission"))
	);
}

function storeCard(uuid: string, state: ProjectLicense): HTMLElement {
	const status = !state.enforced
		? el("p", {}, t("license.store_included"))
		: state.store
			? el("p", {}, el("span", { class: "pill pill-active" }, t("status.active")), ` ${t("license.until", { date: formatDate(state.store_until) })}`)
			: el("p", { class: "warn" }, state.store_until ? t("license.store_ended", { date: formatDate(state.store_until) }) : t("license.store_offer"));

	return el(
		"div",
		{ class: "card stack" },
		el("h2", {}, t("license.store")),
		status,
		el("p", { class: "muted" }, t("license.store_hint")),
		el("div", { class: "line-actions" }, el("a", { class: "button ghost", href: `/projects/${uuid}/store` }, t("license.store_open")))
	);
}

function seatsSection(state: ProjectLicense): HTMLElement {
	const limit = state.employees_limit ?? 0;
	const row = (label: string, value: string) => el("div", { class: "totals-row" }, el("span", {}, label), el("span", { class: "mono" }, value));
	return el(
		"div",
		{ class: "stack" },
		el("h3", {}, t("license.employees")),
		el(
			"div",
			{ class: "totals usage-totals" },
			row(t("license.employees_used"), t("license.of", { used: state.employees_used.toLocaleString(), total: limit.toLocaleString() })),
			usageMeter(state.employees_used, limit),
			row(t("license.employees_included"), tn("count.employees", state.employees_included)),
			...state.employee_seats.map((seat) => row(t("license.employees_seat_until", { date: formatDate(seat.until) }), tn("count.employees", seat.employees)))
		),
		el("p", { class: "muted" }, t("license.employees_hint")),
		state.employees_used > limit ? el("p", { class: "warn" }, t("license.employees_exceeded")) : null
	);
}

function workforceCard(uuid: string, state: ProjectLicense): HTMLElement {
	const status = !state.enforced
		? el("p", {}, t("license.workforce_included"))
		: state.workforce
			? el("p", {}, el("span", { class: "pill pill-active" }, t("status.active")), ` ${t("license.until", { date: formatDate(state.workforce_until) })}`)
			: el(
					"p",
					{ class: "warn" },
					state.workforce_until ? t("license.workforce_ended", { date: formatDate(state.workforce_until) }) : t("license.workforce_offer")
				);

	return el(
		"div",
		{ class: "card stack" },
		el("h2", {}, t("license.workforce")),
		status,
		el("p", { class: "muted" }, t("license.workforce_hint")),
		el("div", { class: "line-actions" }, el("a", { class: "button ghost", href: `/projects/${uuid}/timesheet` }, t("license.workforce_open"))),
		state.employees_limit === null ? null : el("div", { class: "divider" }),
		state.employees_limit === null ? null : seatsSection(state)
	);
}

function accountingCard(uuid: string, state: ProjectLicense): HTMLElement {
	const status = !state.enforced
		? el("p", {}, t("license.accounting_included"))
		: state.accounting
			? el("p", {}, el("span", { class: "pill pill-active" }, t("status.active")), ` ${t("license.until", { date: formatDate(state.accounting_until) })}`)
			: el(
					"p",
					{ class: "warn" },
					state.accounting_until ? t("license.accounting_ended", { date: formatDate(state.accounting_until) }) : t("license.accounting_offer")
				);

	return el(
		"div",
		{ class: "card stack" },
		el("h2", {}, t("license.accounting")),
		status,
		el("p", { class: "muted" }, t("license.accounting_hint")),
		el("div", { class: "line-actions" }, el("a", { class: "button ghost", href: `/projects/${uuid}/accounting` }, t("license.accounting_open")))
	);
}

function historyCard(state: ProjectLicense): HTMLElement {
	if (state.licenses.length === 0) return el("div", {});

	return el(
		"div",
		{ class: "card" },
		el("h2", {}, t("license.history")),
		pagedTable(
			[t("items.column_key"), t("license.column_grants"), t("license.column_redeemed"), t("invoices.email_column_by")],
			state.licenses.map((license) =>
				el(
					"tr",
					{},
					el("td", { class: "mono" }, license.code),
					el("td", {}, describeLicense(license)),
					el("td", {}, formatDate(license.redeemed_at)),
					el("td", {}, license.redeemed_by ?? "")
				)
			)
		)
	);
}

export async function licenseView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid, true);
	const editable = can(project, Permission.PROJECT_EDIT);
	const content = el("div", { class: "stack" });

	const refresh = async () => {
		try {
			project.has_logo = (await loadProject(uuid, true)).has_logo;
			const [state, server] = await Promise.all([Api.license(uuid), editable ? Api.emailServer(uuid) : Promise.resolve(null)]);
			render(state, server);
		} catch (error) {
			reportError(error);
		}
	};

	const render = (state: ProjectLicense, server: EmailServer | null) => {
		content.replaceChildren(
			usageCard(state),
			storageCard(state),
			editable
				? redeemCard(uuid, state, () => {
						invalidateProject(uuid);
						void refresh();
					})
				: el("div", {}),
			whiteLabelCard(uuid, project, state, server, () => void refresh()),
			storeCard(uuid, state),
			workforceCard(uuid, state),
			accountingCard(uuid, state),
			historyCard(state)
		);
	};

	const [state, server] = await Promise.all([Api.license(uuid), editable ? Api.emailServer(uuid) : Promise.resolve(null)]);
	render(state, server);

	return projectLayout(project, content);
}
