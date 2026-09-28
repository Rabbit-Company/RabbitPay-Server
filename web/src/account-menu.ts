import { el } from "./dom";
import { t } from "./i18n";
import { languageSwitcher } from "./language";
import { dropdown, menuItem, type MenuLink } from "./menu";
import { themeSwitcher } from "./theme-switcher";

export type { MenuLink };

function setting(label: string, control: HTMLElement): HTMLElement {
	return el("div", { class: "menu-setting" }, el("span", {}, label), control);
}

export function accountMenu(username: string, sections: { links: MenuLink[]; compactOnly?: boolean }[], signOut: () => void): HTMLElement {
	const initial = (username.trim()[0] ?? "?").toUpperCase();

	const trigger = el(
		"button",
		{ class: "menu-trigger", type: "button" },
		el("span", { class: "avatar" }, initial),
		el("span", { class: "menu-trigger-name" }, username),
		el("span", { class: "menu-chevron" })
	);
	trigger.setAttribute("aria-label", t("app.account_menu"));

	return dropdown(trigger, (close) => [
		el(
			"div",
			{ class: "menu-identity" },
			el("span", { class: "avatar large" }, initial),
			el("div", {}, el("span", { class: "muted" }, t("app.signed_in_as")), el("strong", {}, username))
		),
		...sections.map((section) =>
			el("div", { class: `menu-section${section.compactOnly ? " compact-only" : ""}` }, ...section.links.map((link) => menuItem(link, close)))
		),
		el("div", { class: "menu-section" }, setting(t("app.theme"), themeSwitcher()), setting(t("app.language"), languageSwitcher())),
		el("div", { class: "menu-section" }, menuItem({ label: t("app.sign_out"), danger: true, onSelect: signOut }, close)),
	]);
}
