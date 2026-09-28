export const BRAND_BLUE = "#4f46e5";

export const ACCENT_PRESETS: { value: string; label: string }[] = [
	{ value: "#4f46e5", label: "Blue" },
	{ value: "#2563eb", label: "Sky" },
	{ value: "#0d9488", label: "Teal" },
	{ value: "#16a34a", label: "Green" },
	{ value: "#d97706", label: "Amber" },
	{ value: "#dc2626", label: "Red" },
	{ value: "#db2777", label: "Pink" },
	{ value: "#7c3aed", label: "Violet" },
	{ value: "#1f2937", label: "Graphite" },
];

export function isAccentColor(value: unknown): value is string {
	return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function channel(hex: string, offset: number): number {
	const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
	return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

export function luminance(hex: string): number {
	return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

export function accentTextFor(hex: string): string {
	const light = luminance(hex);
	const againstWhite = 1.05 / (light + 0.05);
	const againstDark = (light + 0.05) / 0.05;

	return againstWhite >= againstDark ? "#ffffff" : "#111827";
}
