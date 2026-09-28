import { Api, type Account, type SecondFactor, type SecurityKey, type TwoFactorSetup } from "../api";
import { el, field, input, saveFile } from "../dom";
import { t } from "../i18n";
import { formatDate } from "../money";
import { modal, reportError, toast } from "../ui";
import { legalInfo } from "./legal";
import { createSecurityKey, getSecurityKey, securityKeyCancelled, securityKeysSupported } from "../webauthn";

type Reload = (recoveryCodes?: string[] | null) => Promise<void>;

async function copyText(value: string) {
	try {
		await navigator.clipboard.writeText(value);
		toast(t("ui.copied"), "success");
	} catch {
		toast(t("ui.copy_failed"), "error");
	}
}

function reportFailure(error: unknown) {
	if (securityKeyCancelled(error)) toast(t("security_key.cancelled"), "info");
	else reportError(error);
}

function factorField(account: Account) {
	const withKey = account.security_keys.length > 0 && securityKeysSupported();
	const code = input("text", { autocomplete: "one-time-code", required: !withKey });
	code.maxLength = 11;
	const label = account.authenticator_enabled ? t("account.code_or_recovery") : t("account.recovery_code");

	return {
		element: field(label, code, withKey ? t("account.factor_key_hint") : undefined),
		async value(): Promise<SecondFactor> {
			const value = code.value.trim();
			if (value || !withKey) return { code: value };
			return { credential: await getSecurityKey(await Api.securityKeyChallenge()) };
		},
	};
}

function recoveryPanel(codes: string[]): HTMLElement {
	return el(
		"section",
		{ class: "card recovery-card" },
		el("h2", {}, t("account.recovery_title")),
		el("p", { class: "warn" }, t("account.recovery_once")),
		el("div", { class: "recovery-codes" }, ...codes.map((code) => el("code", { class: "mono" }, code))),
		el("button", { class: "button ghost", type: "button", onClick: () => void copyText(codes.join("\n")) }, t("account.copy_recovery"))
	);
}

function statusPanel(account: Account): HTMLElement {
	const enabled = account.two_factor_enabled;
	return el(
		"section",
		{ class: "card" },
		el(
			"div",
			{ class: "security-head" },
			el("h2", {}, t("account.two_factor_title")),
			el("span", { class: `pill ${enabled ? "pill-active" : "pill-pending"}` }, enabled ? t("account.enabled_status") : t("account.disabled_status"))
		),
		el("p", { class: "muted" }, enabled ? t("account.enabled_body") : t("account.disabled_body"))
	);
}

function verifyDialog(title: string, body: string, confirmLabel: string, account: Account, action: (password: string, factor: SecondFactor) => Promise<void>) {
	const password = input("password", { autocomplete: "current-password", required: true });
	const factor = factorField(account);
	const submit = el("button", { class: "button danger", type: "submit" }, confirmLabel);

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					await action(password.value, await factor.value());
					dialog.close();
				} catch (error) {
					reportFailure(error);
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, body),
		field(t("login.password"), password),
		factor.element,
		el("div", { class: "dialog-actions" }, submit)
	);

	const dialog = modal(title, form);
}

function securityKeyRow(key: SecurityKey, account: Account, reload: Reload): HTMLElement {
	const used = key.last_used === null ? t("security_key.never_used") : t("security_key.last_used", { date: formatDate(key.last_used) });
	const remove = () =>
		verifyDialog(
			t("security_key.remove_title", { name: key.name }),
			t("security_key.remove_body"),
			t("security_key.remove"),
			account,
			async (password, factor) => {
				await Api.removeSecurityKey(key.uuid, password, factor);
				toast(t("security_key.removed"), "success");
				await reload();
			}
		);

	return el(
		"li",
		{ class: "security-key" },
		el("div", {}, el("strong", {}, key.name), el("div", { class: "muted" }, `${t("security_key.added", { date: formatDate(key.created) })} | ${used}`)),
		el("button", { class: "button ghost small", type: "button", onClick: remove }, t("security_key.remove"))
	);
}

function securityKeysPanel(account: Account, reload: Reload): HTMLElement {
	const keys = account.security_keys;
	const list = keys.length
		? el("ul", { class: "security-keys" }, ...keys.map((key) => securityKeyRow(key, account, reload)))
		: el("p", { class: "muted" }, t("security_key.none"));

	if (!securityKeysSupported()) {
		return el("section", { class: "card stack" }, el("h2", {}, t("security_key.title")), list, el("p", { class: "warn" }, t("security_key.unsupported")));
	}

	const name = input("text", { value: t("security_key.default_name"), required: true, maxlength: "64", autocomplete: "off" });
	const password = input("password", { autocomplete: "current-password", required: true });
	const submit = el("button", { class: "button primary", type: "submit" }, t("security_key.add"));

	return el(
		"section",
		{ class: "card stack" },
		el("h2", {}, t("security_key.title")),
		el("p", { class: "muted" }, t("security_key.body")),
		list,
		el(
			"form",
			{
				class: "stack",
				onSubmit: async (event) => {
					event.preventDefault();
					submit.disabled = true;
					try {
						const credential = await createSecurityKey(await Api.securityKeyOptions());
						const result = await Api.addSecurityKey(password.value, name.value.trim(), credential);
						toast(t("security_key.added_toast"), "success");
						await reload(result.recovery_codes);
					} catch (error) {
						reportFailure(error);
						submit.disabled = false;
					}
				},
			},
			el("h3", {}, t("security_key.add_title")),
			el("div", { class: "form-grid" }, field(t("security_key.name"), name), field(t("login.password"), password)),
			el("div", {}, submit)
		)
	);
}

function setupPanel(setup: TwoFactorSetup, reload: Reload): HTMLElement {
	const qr = el("div", { class: "qr two-factor-qr" });
	qr.innerHTML = setup.qr_svg;
	const code = input("text", { autocomplete: "one-time-code", placeholder: "123456", required: true });
	code.inputMode = "numeric";
	code.maxLength = 6;
	const password = input("password", { autocomplete: "current-password", required: true });
	const submit = el("button", { class: "button primary", type: "submit" }, t("account.enable"));

	return el(
		"section",
		{ class: "card" },
		el("h2", {}, t("account.setup_title")),
		el("p", { class: "muted" }, t("account.setup_body", { minutes: Math.floor(setup.expires_in / 60) })),
		el(
			"div",
			{ class: "two-factor-setup" },
			qr,
			el(
				"div",
				{ class: "stack" },
				el("div", {}, el("span", { class: "field-label" }, t("account.manual_secret")), el("code", { class: "secret mono" }, setup.secret)),
				el("button", { class: "button ghost", type: "button", onClick: () => void copyText(setup.secret) }, t("account.copy_secret")),
				el(
					"form",
					{
						onSubmit: async (event) => {
							event.preventDefault();
							submit.disabled = true;
							try {
								const result = await Api.enableTwoFactor(password.value, code.value.trim());
								toast(t("account.enabled"), "success");
								await reload(result.recovery_codes);
							} catch (error) {
								reportError(error);
								submit.disabled = false;
							}
						},
					},
					field(t("login.password"), password),
					field(t("account.authenticator_code"), code),
					el("div", { class: "form-actions" }, el("button", { class: "button ghost", type: "button", onClick: () => void reload() }, t("ui.cancel")), submit)
				)
			)
		)
	);
}

function authenticatorPanel(account: Account, reload: Reload): HTMLElement {
	if (account.authenticator_enabled) {
		const remove = () =>
			verifyDialog(
				t("account.remove_authenticator_title"),
				t("account.remove_authenticator_body"),
				t("account.remove_authenticator"),
				account,
				async (password, factor) => {
					await Api.removeAuthenticator(password, factor);
					toast(t("account.authenticator_removed"), "success");
					await reload();
				}
			);
		return el(
			"section",
			{ class: "card stack" },
			el(
				"div",
				{ class: "security-head" },
				el("h2", {}, t("account.authenticator_title")),
				el("span", { class: "pill pill-active" }, t("account.enabled_status"))
			),
			el("p", { class: "muted" }, t("account.authenticator_enabled_body")),
			el("div", {}, el("button", { class: "button ghost", type: "button", onClick: remove }, t("account.remove_authenticator")))
		);
	}

	const panel = el("section", { class: "card stack" });
	const setup = el("button", { class: "button primary", type: "button" }, t("account.setup"));
	setup.addEventListener("click", async () => {
		setup.disabled = true;
		try {
			panel.replaceWith(setupPanel(await Api.setupTwoFactor(), reload));
		} catch (error) {
			reportError(error);
			setup.disabled = false;
		}
	});
	panel.append(el("h2", {}, t("account.authenticator_title")), el("p", { class: "muted" }, t("account.authenticator_body")), el("div", {}, setup));
	return panel;
}

function recoveryCodesPanel(account: Account, reload: Reload): HTMLElement {
	const withKey = account.security_keys.length > 0 && securityKeysSupported();
	const code = input("text", { autocomplete: "one-time-code", placeholder: "123456", required: !withKey });
	code.inputMode = "numeric";
	code.maxLength = 6;
	const submit = el("button", { class: "button ghost", type: "submit" }, t("account.regenerate"));

	return el(
		"form",
		{
			class: "card stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					const value = code.value.trim();
					const factor: SecondFactor = value || !withKey ? { code: value } : { credential: await getSecurityKey(await Api.securityKeyChallenge()) };
					const result = await Api.regenerateRecoveryCodes(factor);
					toast(t("account.recovery_regenerated"), "success");
					await reload(result.recovery_codes);
				} catch (error) {
					reportFailure(error);
					submit.disabled = false;
				}
			},
		},
		el("h2", {}, t("account.recovery_regenerate_title")),
		el("p", { class: "muted" }, t("account.recovery_regenerate_body")),
		account.authenticator_enabled ? field(t("account.authenticator_code"), code, withKey ? t("account.factor_key_hint") : undefined) : null,
		el("div", {}, submit)
	);
}

function disablePanel(account: Account, reload: Reload): HTMLElement {
	const disable = () =>
		verifyDialog(t("account.disable_title"), t("account.disable_body"), t("account.disable"), account, async (password, factor) => {
			await Api.disableTwoFactor(password, factor);
			toast(t("account.disabled"), "success");
			await reload();
		});
	return el(
		"section",
		{ class: "card stack" },
		el("h2", {}, t("account.disable_title")),
		el("p", { class: "muted" }, t("account.disable_intro")),
		el("div", {}, el("button", { class: "button danger", type: "button", onClick: disable }, t("account.disable")))
	);
}

function dataPanel(contact: string | null): HTMLElement {
	const download = el("button", { class: "button ghost", type: "button" }, t("account.download_data"));
	download.addEventListener("click", async () => {
		download.disabled = true;
		try {
			const file = await Api.exportData();
			saveFile(file.blob, file.name);
		} catch (error) {
			reportError(error);
		} finally {
			download.disabled = false;
		}
	});

	return el(
		"section",
		{ class: "card stack" },
		el("h2", {}, t("account.data_title")),
		el("p", { class: "muted" }, t("account.data_body")),
		el("div", {}, download),
		contact
			? el("p", { class: "muted" }, t("account.delete_request"), " ", el("a", { href: `mailto:${contact}` }, contact), ".")
			: el("p", { class: "muted" }, t("account.delete_request_admin"))
	);
}

export async function accountView(): Promise<HTMLElement> {
	const [initial, legal] = await Promise.all([Api.me(), legalInfo().catch(() => null)]);
	const contact = legal?.operator?.email ?? null;
	const content = el("div", { class: "stack account-security" });

	const show = (account: Account, recoveryCodes: string[] | null) => {
		content.replaceChildren(
			statusPanel(account),
			recoveryCodes ? recoveryPanel(recoveryCodes) : "",
			securityKeysPanel(account, reload),
			authenticatorPanel(account, reload),
			account.two_factor_enabled ? recoveryCodesPanel(account, reload) : "",
			account.two_factor_enabled ? disablePanel(account, reload) : "",
			dataPanel(contact)
		);
	};

	const reload: Reload = async (recoveryCodes = null) => {
		try {
			show(await Api.me(), recoveryCodes);
		} catch (error) {
			reportError(error);
		}
	};

	show(initial, null);

	return el(
		"div",
		{ class: "page" },
		el(
			"div",
			{ class: "page-head" },
			el("div", {}, el("h1", {}, t("account.title")), el("p", { class: "muted" }, t("account.intro", { username: initial.username, email: initial.email })))
		),
		content
	);
}
