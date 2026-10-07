import { el } from "./dom";

export interface MenuLink {
	label: string;
	href?: string;
	hint?: string;
	danger?: boolean;
	current?: boolean;
	newTab?: boolean;
	onSelect?: () => void;
}

let sequence = 0;

export function menuItem(link: MenuLink, close: () => void): HTMLElement {
	const content = [el("span", {}, link.label), link.hint ? el("kbd", {}, link.hint) : null];
	const className = `menu-item${link.danger ? " danger" : ""}`;
	const item = link.href
		? el("a", { class: className, href: link.href, ...(link.newTab ? { target: "_blank", rel: "noopener" } : {}) }, ...content)
		: el("button", { class: className, type: "button" }, ...content);
	item.setAttribute("role", "menuitem");
	item.tabIndex = -1;
	if (link.current) item.setAttribute("aria-current", "page");
	item.addEventListener("click", () => {
		close();
		link.onSelect?.();
	});
	return item;
}

export function dropdown(trigger: HTMLButtonElement, build: (close: () => void) => HTMLElement[], panelClass = ""): HTMLElement {
	const id = `menu-${++sequence}`;
	trigger.setAttribute("aria-haspopup", "menu");
	trigger.setAttribute("aria-expanded", "false");
	trigger.setAttribute("aria-controls", id);

	const panel = el("div", { class: `menu-panel ${panelClass}`.trim(), id });
	panel.setAttribute("role", "menu");
	panel.hidden = true;

	const items = () => [...panel.querySelectorAll<HTMLElement>(".menu-item")].filter((item) => item.offsetParent !== null);

	function onOutside(event: PointerEvent) {
		if (!wrapper.contains(event.target as Node)) close();
	}

	function open() {
		panel.hidden = false;
		trigger.setAttribute("aria-expanded", "true");
		document.addEventListener("pointerdown", onOutside);
	}

	function close() {
		panel.hidden = true;
		trigger.setAttribute("aria-expanded", "false");
		document.removeEventListener("pointerdown", onOutside);
	}

	panel.append(...build(close));

	trigger.addEventListener("click", () => (panel.hidden ? open() : close()));
	trigger.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowDown") return;
		event.preventDefault();
		open();
		items()[0]?.focus();
	});

	panel.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			close();
			trigger.focus();
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const list = items();
		const index = list.indexOf(document.activeElement as HTMLElement);
		if (index === -1) return;
		event.preventDefault();
		list[(index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
	});

	const wrapper = el("div", { class: "menu" }, trigger, panel);
	wrapper.addEventListener("focusout", (event) => {
		if (!panel.hidden && event.relatedTarget instanceof Node && !wrapper.contains(event.relatedTarget)) close();
	});
	return wrapper;
}

export function actionMenu(label: string, sections: MenuLink[][]): HTMLElement | null {
	const filled = sections.filter((section) => section.length > 0);
	if (filled.length === 0) return null;
	const trigger = el("button", { class: "button ghost menu-button", type: "button" }, el("span", {}, label), el("span", { class: "menu-chevron" }));
	return dropdown(
		trigger,
		(close) => filled.map((links) => el("div", { class: "menu-section" }, ...links.map((link) => menuItem(link, close)))),
		"menu-panel-actions"
	);
}

let closeFloating: (() => void) | null = null;

export function floatingMenu(position: { x: number; y: number }, sections: MenuLink[][], returnFocus?: HTMLElement) {
	closeFloating?.();
	const filled = sections.filter((section) => section.length > 0);
	if (filled.length === 0) return;

	const panel = el("div", { class: "menu-panel menu-panel-actions menu-panel-floating" });
	panel.setAttribute("role", "menu");
	const items = () => [...panel.querySelectorAll<HTMLElement>(".menu-item")];

	const onOutside = (event: Event) => {
		if (!panel.contains(event.target as Node)) close();
	};
	const onKey = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			close();
			returnFocus?.focus();
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const list = items();
		const index = list.indexOf(document.activeElement as HTMLElement);
		event.preventDefault();
		list[(index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
	};
	function close() {
		panel.remove();
		document.removeEventListener("pointerdown", onOutside, true);
		document.removeEventListener("keydown", onKey, true);
		window.removeEventListener("scroll", close, true);
		window.removeEventListener("resize", close);
		window.removeEventListener("popstate", close);
		closeFloating = null;
	}
	closeFloating = close;

	panel.append(...filled.map((links) => el("div", { class: "menu-section" }, ...links.map((link) => menuItem(link, close)))));
	document.body.appendChild(panel);
	const box = panel.getBoundingClientRect();
	panel.style.left = `${Math.max(8, Math.min(position.x, window.innerWidth - box.width - 8))}px`;
	panel.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - box.height - 8))}px`;

	document.addEventListener("pointerdown", onOutside, true);
	document.addEventListener("keydown", onKey, true);
	window.addEventListener("scroll", close, true);
	window.addEventListener("resize", close);
	window.addEventListener("popstate", close);
	items()[0]?.focus();
}
