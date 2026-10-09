import { el } from "./dom";
import { icon } from "./storefront/icons";

export interface CallControlOptions {
	tone?: "neutral" | "active" | "off" | "danger" | "accept";
	pressed?: boolean;
	disabled?: boolean;
	badge?: boolean;
}

export function callControl(name: string, label: string, onClick: () => void, options: CallControlOptions = {}): HTMLElement {
	const button = el(
		"button",
		{ class: `call-control tone-${options.tone ?? "neutral"}`, type: "button", title: label, onClick },
		icon(name, 20, "call-control-icon"),
		options.badge ? el("span", { class: "call-control-badge" }) : null
	);
	button.setAttribute("aria-label", label);
	if (options.pressed !== undefined) button.setAttribute("aria-pressed", String(options.pressed));
	button.disabled = options.disabled === true;
	return button;
}
