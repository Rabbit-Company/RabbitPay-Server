import { el } from "./dom";
import { t } from "./i18n";
import { navigate } from "./router";
import { modal } from "./ui";

type CreateAction = "new-invoice" | "new-customer" | "new-item" | "new-expense" | "new-recurring";

interface CreateShortcut {
	key: string;
	action: CreateAction;
	path: string;
	label: () => string;
}

const createShortcuts: CreateShortcut[] = [
	{ key: "F2", action: "new-invoice", path: "/invoices/new", label: () => t("shortcuts.new_invoice") },
	{ key: "F3", action: "new-customer", path: "/customers", label: () => t("shortcuts.new_customer") },
	{ key: "F4", action: "new-item", path: "/items", label: () => t("shortcuts.new_item") },
	{ key: "F6", action: "new-expense", path: "/expenses", label: () => t("shortcuts.new_expense") },
	{ key: "F7", action: "new-recurring", path: "/recurring/new", label: () => t("shortcuts.new_recurring") },
];

let pendingAction: CreateAction | null = null;
let shortcutDialogOpen = false;

function projectContext(): { uuid: string; actions: Set<string> } | null {
	const page = document.querySelector<HTMLElement>("[data-project-uuid]");
	if (!page?.dataset.projectUuid) return null;
	return {
		uuid: page.dataset.projectUuid,
		actions: new Set((page.dataset.shortcutActions ?? "").split(" ").filter(Boolean)),
	};
}

function availableCreateShortcuts(): CreateShortcut[] {
	const context = projectContext();
	if (!context) return [];
	return createShortcuts.filter((shortcut) => context.actions.has(shortcut.action));
}

function visible(element: HTMLElement): boolean {
	return !element.hidden && element.getAttribute("aria-hidden") !== "true" && !element.closest("[hidden]");
}

function searchControl(): HTMLElement | null {
	const selectors = ["[data-shortcut-search]", 'input[type="search"]', ".toolbar .combo-input", ".toolbar select"];
	for (const selector of selectors) {
		const control = [...document.querySelectorAll<HTMLElement>(selector)].find((candidate) => visible(candidate) && !candidate.matches(":disabled"));
		if (control) return control;
	}
	return null;
}

function activeForm(): HTMLFormElement | null {
	const active = document.activeElement as HTMLElement | null;
	const nearest = active?.closest<HTMLFormElement>("form");
	if (nearest) return nearest;
	const overlay = [...document.querySelectorAll<HTMLElement>(".overlay")].at(-1);
	if (overlay) return overlay.querySelector<HTMLFormElement>("form");
	return document.querySelector<HTMLFormElement>("main form");
}

const TAB_SELECTOR = '.tab:not([href$="/pos"])';

function projectTabs(): HTMLAnchorElement[] {
	return [...document.querySelectorAll<HTMLAnchorElement>(`.tabs ${TAB_SELECTOR}, .project-nav ${TAB_SELECTOR}`)].filter(visible);
}

function projectGroups(): HTMLAnchorElement[][] {
	return [...document.querySelectorAll<HTMLElement>(".project-nav .nav-group")]
		.map((group) => [...group.querySelectorAll<HTMLAnchorElement>(TAB_SELECTOR)].filter(visible))
		.filter((links) => links.length > 0);
}

function shortcutRows(): HTMLElement[] {
	const rows: [string, string][] = [["F1", t("shortcuts.open")]];
	for (const shortcut of availableCreateShortcuts()) rows.push([shortcut.key, shortcut.label()]);
	if (searchControl()) rows.push(["/", t("shortcuts.focus_search")]);
	if (activeForm()) rows.push(["Ctrl + Enter", t("shortcuts.submit")]);
	if (projectTabs().length > 1) {
		rows.push(["Ctrl + ←", t("shortcuts.previous_tab")], ["Ctrl + →", t("shortcuts.next_tab")]);
	}
	if (projectGroups().length > 1) {
		rows.push(["Ctrl + ↑", t("shortcuts.previous_group")], ["Ctrl + ↓", t("shortcuts.next_group")]);
	}
	rows.push(["Escape", t("shortcuts.close")], ["Tab", t("shortcuts.next")], ["Shift + Tab", t("shortcuts.previous")]);
	return rows.map(([key, label]) => el("div", { class: "shortcut-row" }, el("kbd", {}, key), el("span", {}, label)));
}

export function showShortcutModal() {
	if (shortcutDialogOpen) return;
	shortcutDialogOpen = true;
	modal(t("shortcuts.title"), el("div", { class: "shortcut-list" }, ...shortcutRows()), () => {
		shortcutDialogOpen = false;
	});
}

function focusPageInput() {
	if (document.querySelector(".overlay")) return;
	const container = document.querySelector<HTMLElement>("[data-page-autofocus]");
	const control = container?.querySelector<HTMLElement>(
		'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"]'
	);
	if (!control) return;
	control.focus();
	if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) control.select();
}

function runCreateShortcut(shortcut: CreateShortcut) {
	const context = projectContext();
	if (!context || !context.actions.has(shortcut.action)) return;

	const local = document.querySelector<HTMLElement>(`[data-shortcut-action="${shortcut.action}"]`);
	if (local && visible(local) && !local.matches(":disabled")) {
		local.focus();
		local.click();
		return;
	}

	pendingAction = shortcut.action;
	navigate(`/projects/${context.uuid}${shortcut.path}`);
}

function onKeyDown(event: KeyboardEvent) {
	if (event.defaultPrevented || event.isComposing) return;

	if (event.key === "F1" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
		event.preventDefault();
		showShortcutModal();
		return;
	}

	if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === "Enter") {
		const form = activeForm();
		if (!form) return;
		event.preventDefault();
		form.requestSubmit();
		return;
	}

	if (document.querySelector(".overlay")) return;

	if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
		const target = event.target as HTMLElement | null;
		if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
		const tabs = projectTabs();
		const current = tabs.findIndex((tab) => tab.classList.contains("active"));
		const next = current + (event.key === "ArrowLeft" ? -1 : 1);
		if (current < 0 || next < 0 || next >= tabs.length) return;
		event.preventDefault();
		const href = tabs[next].getAttribute("href");
		if (href) navigate(href);
		return;
	}

	if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
		const target = event.target as HTMLElement | null;
		if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
		const groups = projectGroups();
		const current = groups.findIndex((links) => links.some((link) => link.classList.contains("active")));
		const next = current + (event.key === "ArrowUp" ? -1 : 1);
		if (current < 0 || next < 0 || next >= groups.length) return;
		event.preventDefault();
		const href = groups[next][0].getAttribute("href");
		if (href) navigate(href);
		return;
	}

	if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey) {
		const target = event.target as HTMLElement | null;
		if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
		const control = searchControl();
		if (!control) return;
		event.preventDefault();
		control.focus();
		if (control instanceof HTMLInputElement) control.select();
		return;
	}

	if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
	const shortcut = createShortcuts.find((candidate) => candidate.key === event.key);
	if (!shortcut) return;
	event.preventDefault();
	runCreateShortcut(shortcut);
}

export function installKeyboardShortcuts() {
	document.addEventListener("keydown", onKeyDown);
}

export function handleShortcutRender() {
	if (pendingAction) {
		const action = pendingAction;
		pendingAction = null;
		const target = document.querySelector<HTMLElement>(`[data-shortcut-action="${action}"]`);
		if (target && visible(target) && !target.matches(":disabled")) {
			target.focus();
			target.click();
			return;
		}
	}
	focusPageInput();
}
