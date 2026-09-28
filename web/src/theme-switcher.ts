import { el } from "./dom";
import { t } from "./i18n";
import { setTheme, themePreference, THEME_PREFERENCES, type ThemePreference } from "./theme";

const ICONS: Record<ThemePreference, string> = {
	system:
		'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
	light:
		'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
	dark: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z"/></svg>',
};

const LABELS: Record<ThemePreference, "app.theme_system" | "app.theme_light" | "app.theme_dark"> = {
	system: "app.theme_system",
	light: "app.theme_light",
	dark: "app.theme_dark",
};

export function themeSwitcher(): HTMLElement {
	const group = el("div", { class: "theme-switcher" });
	group.setAttribute("role", "radiogroup");
	group.setAttribute("aria-label", t("app.theme"));

	const options = THEME_PREFERENCES.map((preference) => {
		const option = el("button", { class: "theme-option", type: "button", title: t(LABELS[preference]) });
		option.innerHTML = ICONS[preference];
		option.setAttribute("role", "radio");
		option.setAttribute("aria-label", t(LABELS[preference]));
		option.addEventListener("click", () => {
			setTheme(preference);
			sync();
		});
		group.append(option);
		return option;
	});

	const sync = () => {
		const current = themePreference();
		THEME_PREFERENCES.forEach((preference, index) => {
			const checked = preference === current;
			options[index]!.setAttribute("aria-checked", String(checked));
			options[index]!.tabIndex = checked ? 0 : -1;
		});
	};

	group.addEventListener("keydown", (event) => {
		if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
		event.preventDefault();
		const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
		const index = (THEME_PREFERENCES.indexOf(themePreference()) + step + THEME_PREFERENCES.length) % THEME_PREFERENCES.length;
		setTheme(THEME_PREFERENCES[index]!);
		sync();
		options[index]!.focus();
	});

	sync();
	return group;
}
