import { Api, ApiError, storeSession, type LegalInfo, type RegistrationMode, type SecondFactor, type SecondFactorChallenge } from "../api";
import { el, field, input } from "../dom";
import { navigate } from "../router";
import { reportError, toast } from "../ui";
import { authBrand, authFooter, authPage, passwordField } from "../auth-page";
import { t } from "../i18n";
import { formatDate } from "../money";
import { checkPendingTerms, legalInfo, legalLinks, requiresTerms, resetLegalInfo } from "./legal";
import { getSecurityKey, securityKeyCancelled, securityKeysSupported, type SecurityKeyRequestOptions } from "../webauthn";

type Mode = "login" | "register";

function returnPath(value: string | null): string {
	if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
	return value;
}

async function currentLegal(): Promise<LegalInfo | null> {
	try {
		return await legalInfo();
	} catch {
		return null;
	}
}

function acceptanceText(legal: LegalInfo): (string | HTMLElement)[] {
	const link = (href: string, label: string) => el("a", { href, target: "_blank", rel: "noopener" }, label);
	const parts: (string | HTMLElement)[] = [t(legal.business_only ? "legal.accept_business" : "legal.accept"), " ", link("/terms", t("legal.terms_link")), "."];
	if (legal.upcoming_terms) {
		parts.push(
			" ",
			t("legal.accept_upcoming", { date: formatDate(legal.upcoming_terms.effective) }),
			" ",
			link("/terms?upcoming=1", t("legal.read_upcoming")),
			"."
		);
	}
	if (legal.privacy || legal.upcoming_privacy) parts.push(" ", t("legal.read_privacy"), " ", link("/privacy", t("legal.privacy_link")), ".");
	return parts;
}

async function registrationMode(): Promise<RegistrationMode> {
	try {
		return (await Api.registration()).mode;
	} catch {
		return "open";
	}
}

export async function loginView(): Promise<HTMLElement> {
	const params = new URLSearchParams(window.location.search);
	const next = returnPath(params.get("next"));
	const invitedEmail = params.get("email") ?? "";
	const invitation = next.match(/^\/invite\/([A-Za-z0-9]{64})$/)?.[1];
	const [registration, initialLegal] = await Promise.all([registrationMode(), currentLegal()]);
	let legal = initialLegal;
	const canRegister = registration !== "closed";
	const needsInviteCode = registration === "invite" && !invitation;
	const slot = el("div", { class: "auth-slot" });
	let mode: Mode = canRegister && params.get("mode") === "register" ? "register" : "login";

	const email = input("email", { placeholder: "you@example.com", autocomplete: "username", required: true, maxlength: "254", value: invitedEmail });
	const password = input("password", { placeholder: t("login.password_placeholder"), required: true });
	const passwordInput = passwordField(password);
	const inviteCode = input("text", { placeholder: "JOIN-XXXXX-XXXXX-XXXXX", autocomplete: "off", required: true, value: params.get("invite") ?? "" });

	const switchTo = (target: Mode) => {
		if (target === mode) return;
		mode = target;
		const query = new URLSearchParams(window.location.search);
		if (mode === "register") query.set("mode", "register");
		else query.delete("mode");
		const search = query.toString();
		history.replaceState(history.state, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
		slot.replaceChildren(render());
	};

	const tab = (target: Mode, label: string) => {
		const node = el("button", { class: "auth-tab", type: "button", onClick: () => switchTo(target) }, label);
		node.setAttribute("role", "tab");
		node.setAttribute("aria-selected", String(mode === target));
		return node;
	};

	const render = () => {
		password.autocomplete = mode === "login" ? "current-password" : "new-password";
		const code = input("text", { autocomplete: "one-time-code", placeholder: t("login.two_factor_placeholder") });
		code.inputMode = "numeric";
		code.maxLength = 11;
		const codeField = field(t("login.two_factor_code"), code, t("login.two_factor_hint"));
		codeField.hidden = true;

		const acceptTerms = input("checkbox", { required: true });
		const acceptField = legal && requiresTerms(legal) ? el("label", { class: "legal-accept" }, acceptTerms, el("span", {}, ...acceptanceText(legal))) : null;

		const signIn = async (factor?: SecondFactor) => {
			const session = await Api.login(email.value.trim(), password.value, factor);
			storeSession(session.token, session);
			navigate(next);
			void checkPendingTerms();
		};

		const freshChallenge = async (): Promise<SecurityKeyRequestOptions | null> => {
			try {
				await signIn();
				return null;
			} catch (error) {
				if (error instanceof ApiError && error.code === 1133) return (error.data as SecondFactorChallenge).webauthn;
				throw error;
			}
		};

		const keyButton = el("button", { class: "button ghost wide", type: "button" }, t("login.use_security_key"));
		keyButton.hidden = true;
		const useSecurityKey = async (options: SecurityKeyRequestOptions | null, automatic: boolean) => {
			keyButton.disabled = true;
			try {
				const request = options ?? (await freshChallenge());
				if (request) await signIn({ credential: await getSecurityKey(request) });
			} catch (error) {
				if (!securityKeyCancelled(error)) reportError(error);
				else if (!automatic) toast(t("security_key.cancelled"), "info");
			} finally {
				keyButton.disabled = false;
			}
		};
		keyButton.addEventListener("click", () => void useSecurityKey(null, false));

		const tabs = canRegister ? el("div", { class: "auth-tabs" }, tab("login", t("login.sign_in")), tab("register", t("login.register"))) : null;
		tabs?.setAttribute("role", "tablist");

		const submit = el("button", { class: "button primary wide", type: "submit" }, mode === "login" ? t("login.sign_in") : t("login.create_account"));

		const form = el(
			"form",
			{
				class: "auth-card",
				onSubmit: async (event) => {
					event.preventDefault();
					submit.disabled = true;

					try {
						if (mode === "register") {
							await Api.register(email.value.trim(), password.value, {
								invite: needsInviteCode ? inviteCode.value.trim() : undefined,
								invitation,
								...(legal && requiresTerms(legal) && acceptTerms.checked ? { accept_terms: true as const, legal_versions: legal.required_versions } : {}),
							});
							toast(t("login.account_created"), "success");
						}

						const value = code.value.trim();
						await signIn(value ? { code: value } : undefined);
					} catch (error) {
						if (error instanceof ApiError && error.code === 1235) {
							resetLegalInfo();
							legal = await currentLegal();
							slot.replaceChildren(render());
							reportError(error);
						} else if (error instanceof ApiError && error.code === 1133) {
							const challenge = error.data as SecondFactorChallenge;
							const withKey = challenge.webauthn !== null && securityKeysSupported();
							codeField.hidden = false;
							code.required = !withKey;
							keyButton.hidden = !withKey;
							if (withKey) void useSecurityKey(challenge.webauthn, true);
							else {
								code.focus();
								toast(t("login.two_factor_required"), "info");
							}
						} else reportError(error);
					} finally {
						submit.disabled = false;
					}
				},
			},
			authBrand(),
			el("h1", {}, mode === "login" ? t("login.title_sign_in") : t("login.title_register")),
			el(
				"p",
				{ class: "auth-subtitle" },
				next.startsWith("/invite/")
					? mode === "login"
						? t("login.subtitle_invite_sign_in")
						: t("login.subtitle_invite_register")
					: mode === "login"
						? t("login.subtitle_sign_in")
						: t("login.subtitle_register")
			),
			tabs,
			field(t("login.email"), email),
			mode === "register" && needsInviteCode ? field(t("login.invite_code"), inviteCode, t("login.invite_code_hint")) : null,
			field(t("login.password"), passwordInput, mode === "register" ? t("login.password_hint") : undefined),
			mode === "register" ? acceptField : null,
			mode === "login" ? codeField : null,
			submit,
			mode === "login" ? keyButton : null
		);

		return form;
	};

	slot.appendChild(render());
	const links = legal ? legalLinks(legal) : [];
	return authPage(
		slot,
		el(
			"div",
			{},
			authFooter(t("login.customer_prompt"), t("portal.title"), "/customer/login"),
			links.length ? el("nav", { class: "auth-legal" }, ...links) : null
		)
	);
}
