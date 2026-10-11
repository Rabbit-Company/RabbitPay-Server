import { el, clear } from "./dom";
import { ApiError } from "./api";
import { errorText, t } from "./i18n";
import { icon } from "./storefront/icons";

let toastHost: HTMLElement | null = null;
let dialogSequence = 0;

const focusableSelector = [
	"a[href]",
	'button:not([disabled]):not([tabindex="-1"])',
	'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"])',
	'select:not([disabled]):not([tabindex="-1"])',
	'textarea:not([disabled]):not([tabindex="-1"])',
	'[tabindex]:not([tabindex="-1"])',
].join(",");

function topOverlay(): HTMLElement | null {
	return [...document.querySelectorAll<HTMLElement>(".overlay")].at(-1) ?? null;
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
	return [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter(
		(element) => !element.hidden && element.getAttribute("aria-hidden") !== "true" && !element.closest("[hidden]")
	);
}

function handleDialogKey(event: KeyboardEvent, overlay: HTMLElement, dialog: HTMLElement, close: () => void) {
	if (topOverlay() !== overlay) return;
	if (event.key === "Escape") {
		event.preventDefault();
		event.stopImmediatePropagation();
		close();
		return;
	}
	if (event.key !== "Tab") return;

	const focusable = focusableElements(dialog);
	if (focusable.length === 0) {
		event.preventDefault();
		dialog.focus();
		return;
	}

	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
		event.preventDefault();
		first.focus();
	}
}

function prepareDialog(dialog: HTMLElement, title: HTMLElement) {
	const titleId = `dialog-title-${++dialogSequence}`;
	title.id = titleId;
	dialog.setAttribute("role", "dialog");
	dialog.setAttribute("aria-modal", "true");
	dialog.setAttribute("aria-labelledby", titleId);
	dialog.tabIndex = -1;
}

function focusDialog(dialog: HTMLElement) {
	(focusableElements(dialog)[0] ?? dialog).focus();
}

function host(): HTMLElement {
	if (!toastHost) {
		toastHost = el("div", { class: "toasts" });
		document.body.appendChild(toastHost);
	}
	return toastHost;
}

export function accountName(name: string | null | undefined, id: string | null | undefined): string | null {
	return name || (id ? t("ui.deleted_user") : null);
}

export function toast(message: string, variant: "success" | "error" | "info" = "info") {
	const node = el("div", { class: `toast toast-${variant}` }, message);
	host().appendChild(node);

	setTimeout(() => {
		node.classList.add("leaving");
		setTimeout(() => node.remove(), 200);
	}, 4200);
}

const NOTICE_TOAST_MS = 7000;

export function noticeToast(title: string, body: string, onOpen: (() => void) | null) {
	const node = el(onOpen ? "button" : "div", { class: "toast toast-info toast-notice" }, el("strong", {}, title), el("span", {}, body));
	const leave = () => {
		node.classList.add("leaving");
		setTimeout(() => node.remove(), 200);
	};
	if (onOpen) {
		node.setAttribute("type", "button");
		node.addEventListener("click", () => {
			node.remove();
			onOpen();
		});
	}
	host().appendChild(node);
	setTimeout(leave, NOTICE_TOAST_MS);
}

export function reportError(error: unknown) {
	if (error instanceof ApiError) {
		toast(errorText(error.code, error.message), "error");
		return;
	}
	toast(t("ui.error_generic"), "error");
}

export function confirmDialog(options: { title: string; body: string; confirmLabel: string; destructive?: boolean }): Promise<boolean> {
	return new Promise((resolve) => {
		const overlay = el("div", { class: "overlay" });
		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

		const close = (result: boolean) => {
			overlay.remove();
			document.removeEventListener("keydown", onKey);
			resolve(result);
			if (previousFocus?.isConnected) previousFocus.focus();
		};

		const onKey = (event: KeyboardEvent) => {
			handleDialogKey(event, overlay, dialog, () => close(false));
		};
		const title = el("h2", {}, options.title);

		const dialog = el(
			"div",
			{ class: "dialog" },
			title,
			el("p", {}, options.body),
			el(
				"div",
				{ class: "dialog-actions" },
				el("button", { class: "button ghost", type: "button", onClick: () => close(false) }, t("ui.cancel")),
				el("button", { class: `button ${options.destructive ? "danger" : "primary"}`, type: "button", onClick: () => close(true) }, options.confirmLabel)
			)
		);

		prepareDialog(dialog, title);
		document.addEventListener("keydown", onKey);
		overlay.appendChild(dialog);
		document.body.appendChild(overlay);
		focusDialog(dialog);
	});
}

export function modal(title: string, content: HTMLElement, onClose?: () => void, size = "dialog-wide"): { close: () => void } {
	const overlay = el("div", { class: "overlay" });
	const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

	const close = () => {
		if (!overlay.isConnected) return;
		overlay.remove();
		document.removeEventListener("keydown", onKey);
		onClose?.();
		if (previousFocus?.isConnected) previousFocus.focus();
	};

	const onKey = (event: KeyboardEvent) => {
		handleDialogKey(event, overlay, dialog, close);
	};
	const heading = el("h2", {}, title);
	const closeButton = el("button", { class: "icon-button", type: "button", title: t("ui.close"), onClick: close }, icon("close", 16));
	closeButton.tabIndex = -1;

	const dialog = el("div", { class: `dialog ${size}` }, el("div", { class: "dialog-head" }, heading, closeButton), content);

	prepareDialog(dialog, heading);
	document.addEventListener("keydown", onKey);
	overlay.appendChild(dialog);
	document.body.appendChild(overlay);
	focusDialog(dialog);

	return { close };
}

export function secretReveal(label: string, secret: string): HTMLElement {
	const value = el("code", { class: "secret" }, secret);

	const copy = el(
		"button",
		{
			class: "button ghost",
			type: "button",
			onClick: async () => {
				try {
					await navigator.clipboard.writeText(secret);
					toast(t("ui.copied"), "success");
				} catch {
					toast(t("ui.copy_failed"), "error");
				}
			},
		},
		t("ui.copy")
	);

	return el("div", { class: "secret-reveal" }, el("p", { class: "warn" }, `${label} is shown once and cannot be retrieved again. Store it now.`), value, copy);
}

export async function withLoading<T>(container: HTMLElement, work: () => Promise<T>, render: (result: T) => HTMLElement) {
	clear(container);
	container.appendChild(el("div", { class: "spinner" }, el("span", {})));

	try {
		const result = await work();
		clear(container);
		container.appendChild(render(result));
	} catch (error) {
		clear(container);
		const message = error instanceof ApiError ? error.message : t("ui.load_failed");
		container.appendChild(el("div", { class: "empty" }, el("p", {}, message)));
	}
}

export function pdfPreviewButton(label: string, load: () => Promise<Blob | null>): HTMLButtonElement {
	const button = el("button", { class: "button ghost", type: "button" }, label);
	button.addEventListener("click", async () => {
		button.disabled = true;
		const opened = window.open("", "_blank");
		try {
			const blob = await load();
			if (!blob) {
				opened?.close();
				return;
			}
			const url = URL.createObjectURL(blob);
			if (opened) opened.location.href = url;
			else window.location.href = url;
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
		} catch (error) {
			opened?.close();
			reportError(error);
		} finally {
			button.disabled = false;
		}
	});
	return button;
}
