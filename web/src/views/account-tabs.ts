import { el } from "../dom";
import { t } from "../i18n";

export type AccountTab = "security" | "notifications";

const TABS: { tab: AccountTab; href: string; label: "notifications.tab_security" | "notifications.title" }[] = [
	{ tab: "security", href: "/account", label: "notifications.tab_security" },
	{ tab: "notifications", href: "/account/notifications", label: "notifications.title" },
];

export function accountTabs(active: AccountTab): HTMLElement {
	return el(
		"nav",
		{ class: "tabs" },
		...TABS.map((entry) => el("a", { class: `tab${entry.tab === active ? " active" : ""}`, href: entry.href }, t(entry.label)))
	);
}
