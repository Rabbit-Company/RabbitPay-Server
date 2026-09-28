import { accentTextFor, isAccentColor } from "../../server/colors";

export type ThemePreference = "system" | "light" | "dark";

export const THEME_PREFERENCES: ThemePreference[] = ["system", "light", "dark"];

const THEME_KEY = "rabbitpay.theme";

function isThemePreference(value: unknown): value is ThemePreference {
	return THEME_PREFERENCES.includes(value as ThemePreference);
}

export function themePreference(): ThemePreference {
	try {
		const stored = localStorage.getItem(THEME_KEY);
		return isThemePreference(stored) ? stored : "system";
	} catch {
		return "system";
	}
}

export function applyTheme(preference: ThemePreference = themePreference()) {
	const root = document.documentElement;
	if (preference === "system") delete root.dataset.theme;
	else root.dataset.theme = preference;
}

export function setTheme(preference: ThemePreference) {
	try {
		if (preference === "system") localStorage.removeItem(THEME_KEY);
		else localStorage.setItem(THEME_KEY, preference);
	} catch {
		void 0;
	}
	applyTheme(preference);
}

export function applyAccent(color: string | null | undefined) {
	const style = document.documentElement.style;

	if (!isAccentColor(color)) {
		style.removeProperty("--accent");
		style.removeProperty("--accent-text");
		return;
	}

	style.setProperty("--accent", color);
	style.setProperty("--accent-text", accentTextFor(color));
}
