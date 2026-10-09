import { el, select } from "./dom";
import { t } from "./i18n";
import type { RecordingSize } from "./call-recorder";
import { icon } from "./storefront/icons";

export interface CallControlOptions {
	tone?: "neutral" | "active" | "off" | "danger" | "accept";
	pressed?: boolean;
	disabled?: boolean;
	badge?: boolean;
	extraClass?: string;
}

export function callControl(name: string, label: string, onClick: () => void, options: CallControlOptions = {}): HTMLElement {
	const button = el(
		"button",
		{ class: `call-control tone-${options.tone ?? "neutral"}${options.extraClass ? ` ${options.extraClass}` : ""}`, type: "button", title: label, onClick },
		icon(name, 20, "call-control-icon"),
		options.badge ? el("span", { class: "call-control-badge" }) : null
	);
	button.setAttribute("aria-label", label);
	if (options.pressed !== undefined) button.setAttribute("aria-pressed", String(options.pressed));
	button.disabled = options.disabled === true;
	return button;
}

export function controlPick(
	label: string,
	options: { value: string; label: string }[],
	chosen: string,
	disabled: boolean,
	choose: (value: string) => void
): HTMLElement {
	const pick = select(options, chosen);
	pick.setAttribute("aria-label", label);
	pick.disabled = disabled;
	const holder = el("label", { class: "call-control call-control-pick" }, icon("down", 14, "call-control-icon"), pick);
	const name = () => {
		holder.title = `${label} | ${options.find((option) => option.value === pick.value)?.label ?? ""}`;
	};
	pick.addEventListener("change", () => {
		choose(pick.value);
		name();
	});
	name();
	return holder;
}

export function qualityPick<Size extends RecordingSize>(
	label: string,
	sizes: Size[],
	chosen: Size,
	disabled: boolean,
	choose: (size: Size) => void
): HTMLElement {
	return controlPick(
		label,
		sizes.map((size) => ({ value: size, label: t(`files.recording_size_${size}`) })),
		chosen,
		disabled,
		(value) => choose(value as Size)
	);
}

export function splitControl(main: HTMLElement, pick: HTMLElement): HTMLElement {
	return el("div", { class: "call-control-split" }, main, pick);
}
