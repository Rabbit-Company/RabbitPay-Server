import { el } from "./dom";
import { t } from "./i18n";
import { icon } from "./storefront/icons";
import { modal, toast } from "./ui";

const COPIED_MS = 1500;

function toolButton(name: string, label: string, onClick: (button: HTMLButtonElement) => void): HTMLButtonElement {
	const button = el("button", { class: "code-tool", type: "button", title: label }, icon(name, 15));
	button.setAttribute("aria-label", label);
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick(button);
	});
	return button;
}

function copyButton(code: () => string): HTMLButtonElement {
	return toolButton("copy", t("code.copy"), async (button) => {
		try {
			await navigator.clipboard.writeText(code());
			button.replaceChildren(icon("check", 15));
			button.classList.add("done");
			button.title = t("code.copied");
			setTimeout(() => {
				button.replaceChildren(icon("copy", 15));
				button.classList.remove("done");
				button.title = t("code.copy");
			}, COPIED_MS);
		} catch {
			toast(t("ui.copy_failed"), "error");
		}
	});
}

function openLarge(block: HTMLPreElement) {
	const large = block.cloneNode(true) as HTMLPreElement;
	large.className = "code-large";
	modal(
		t("code.title"),
		el(
			"div",
			{ class: "code-block" },
			large,
			el(
				"div",
				{ class: "code-tools" },
				copyButton(() => block.textContent ?? "")
			)
		),
		undefined,
		"dialog-large"
	);
}

function codeBlock(block: HTMLPreElement): HTMLElement {
	return el(
		"div",
		{ class: "code-block" },
		block,
		el(
			"div",
			{ class: "code-tools" },
			copyButton(() => block.textContent ?? ""),
			toolButton("expand", t("code.enlarge"), () => openLarge(block))
		)
	);
}

export function withCodeTools(root: HTMLElement) {
	for (const block of root.querySelectorAll("pre")) {
		const holder = document.createElement("div");
		block.replaceWith(holder);
		holder.replaceWith(codeBlock(block));
	}
}
