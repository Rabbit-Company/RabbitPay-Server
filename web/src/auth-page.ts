import { el } from "./dom";
import { logo } from "./logo";
import { languageSwitcher } from "./language";
import { themeSwitcher } from "./theme-switcher";
import { t } from "./i18n";

const EYE_OPEN =
	'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_CLOSED =
	'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-2.9 3.8M6.6 6.6C3.7 8.5 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/></svg>';

export function authPage(card: HTMLElement, footer?: HTMLElement | null): HTMLElement {
	return el("div", { class: "auth" }, el("div", { class: "auth-bar" }, themeSwitcher(), languageSwitcher()), el("div", { class: "auth-main" }, card, footer));
}

export function authBrand(): HTMLElement {
	return el("div", { class: "auth-brand" }, logo(), el("span", {}, "RabbitPay"));
}

export function authFooter(prompt: string, label: string, href: string): HTMLElement {
	return el("p", { class: "auth-footer" }, el("span", {}, prompt), el("a", { href }, label));
}

export function passwordField(password: HTMLInputElement): HTMLElement {
	const toggle = el("button", { class: "password-toggle", type: "button" });

	const show = (visible: boolean) => {
		password.type = visible ? "text" : "password";
		toggle.innerHTML = visible ? EYE_CLOSED : EYE_OPEN;
		toggle.setAttribute("aria-label", t(visible ? "login.hide_password" : "login.show_password"));
		toggle.setAttribute("aria-pressed", String(visible));
		toggle.title = t(visible ? "login.hide_password" : "login.show_password");
	};

	toggle.addEventListener("click", () => {
		show(password.type === "password");
		password.focus();
	});
	show(false);

	return el("div", { class: "password-field" }, password, toggle);
}
