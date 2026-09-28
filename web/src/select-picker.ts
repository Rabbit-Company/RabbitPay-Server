import { el } from "./dom";

interface OpenPicker {
	select: HTMLSelectElement;
	list: HTMLElement;
	rows: HTMLElement[];
	indexes: number[];
	active: number;
}

const OPEN_KEYS = new Set([" ", "Enter", "F4"]);
const TYPEAHEAD_RESET_MS = 700;

let current: OpenPicker | null = null;
let lastPointer = "mouse";
let typed = "";
let typedAt = 0;

function enhanced(target: EventTarget | null): target is HTMLSelectElement {
	return target instanceof HTMLSelectElement && !target.multiple && target.size <= 1 && !target.disabled && target.dataset.native === undefined;
}

function place(picker: OpenPicker) {
	const rect = picker.select.getBoundingClientRect();
	const below = window.innerHeight - rect.bottom;
	const above = rect.top;
	const upward = below < 220 && above > below;
	const room = Math.max((upward ? above : below) - 12, 120);
	const list = picker.list;

	list.style.left = `${rect.left}px`;
	list.style.width = `${rect.width}px`;
	list.style.maxHeight = `${Math.min(room, 320)}px`;
	list.style.top = upward ? "" : `${rect.bottom + 4}px`;
	list.style.bottom = upward ? `${window.innerHeight - rect.top + 4}px` : "";

	const overflow = list.getBoundingClientRect().right - (window.innerWidth - 8);
	if (overflow > 0) list.style.left = `${Math.max(rect.left - overflow, 8)}px`;
}

function follow() {
	if (!current) return;
	if (!current.select.isConnected) close();
	else place(current);
}

function close() {
	if (!current) return;
	current.list.remove();
	current.select.setAttribute("aria-expanded", "false");
	current = null;
	window.removeEventListener("scroll", follow, true);
	window.removeEventListener("resize", follow);
}

function highlight(picker: OpenPicker, position: number) {
	if (picker.rows.length === 0) return;
	picker.active = Math.min(Math.max(position, 0), picker.rows.length - 1);
	picker.rows.forEach((row, index) => row.classList.toggle("active", index === picker.active));
	picker.rows[picker.active].scrollIntoView({ block: "nearest" });
}

function choose(picker: OpenPicker, position: number) {
	const select = picker.select;
	const index = picker.indexes[position];
	close();
	select.focus();
	if (index === undefined || index === select.selectedIndex) return;
	select.selectedIndex = index;
	select.dispatchEvent(new Event("input", { bubbles: true }));
	select.dispatchEvent(new Event("change", { bubbles: true }));
}

function open(select: HTMLSelectElement) {
	close();
	const list = el("div", { class: "combo-list select-list" });
	list.setAttribute("role", "listbox");
	const picker: OpenPicker = { select, list, rows: [], indexes: [], active: -1 };

	Array.from(select.options).forEach((option, index) => {
		if (option.hidden) return;
		const selected = index === select.selectedIndex;
		const row = el(
			"div",
			{ class: `combo-option${selected ? " selected" : ""}${option.disabled ? " disabled" : ""}` },
			el("span", { class: "combo-label" }, option.label)
		);
		row.setAttribute("role", "option");
		row.setAttribute("aria-selected", String(selected));
		if (option.disabled) {
			row.setAttribute("aria-disabled", "true");
			list.appendChild(row);
			return;
		}
		const position = picker.rows.length;
		row.addEventListener("mousemove", () => {
			if (picker.active !== position) highlight(picker, position);
		});
		row.addEventListener("click", () => choose(picker, position));
		picker.rows.push(row);
		picker.indexes.push(index);
		list.appendChild(row);
	});

	list.addEventListener("mousedown", (event) => event.preventDefault());
	(select.closest(".sf") ?? document.body).appendChild(list);
	select.setAttribute("aria-expanded", "true");
	current = picker;
	window.addEventListener("scroll", follow, true);
	window.addEventListener("resize", follow);
	place(picker);
	highlight(picker, Math.max(picker.indexes.indexOf(select.selectedIndex), 0));
}

function typeahead(picker: OpenPicker, key: string) {
	const now = Date.now();
	typed = now - typedAt > TYPEAHEAD_RESET_MS ? key : typed + key;
	typedAt = now;
	const needle = typed.toLocaleLowerCase();
	const labels = picker.indexes.map((index) => picker.select.options[index].label.toLocaleLowerCase());
	const start = typed.length === 1 ? picker.active + 1 : picker.active;
	for (let step = 0; step < labels.length; step++) {
		const position = (start + step) % labels.length;
		if (labels[position].startsWith(needle)) {
			highlight(picker, position);
			return;
		}
	}
}

function onPointerDown(event: PointerEvent) {
	lastPointer = event.pointerType;
}

function onMouseDown(event: MouseEvent) {
	if (current && !current.list.contains(event.target as Node) && event.target !== current.select) close();
	if (event.button !== 0 || lastPointer !== "mouse" || !enhanced(event.target)) return;
	event.preventDefault();
	const select = event.target;
	if (current?.select === select) {
		close();
		select.focus();
		return;
	}
	select.focus();
	open(select);
}

function onKeyDown(event: KeyboardEvent) {
	const picker = current;
	if (!picker || event.target !== picker.select) {
		if (!enhanced(event.target)) return;
		if (OPEN_KEYS.has(event.key) || (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp"))) {
			event.preventDefault();
			event.stopPropagation();
			open(event.target);
		}
		return;
	}

	const page = Math.max(Math.floor(picker.list.clientHeight / 36), 1);
	const moves: Record<string, number> = {
		ArrowDown: picker.active + 1,
		ArrowUp: picker.active - 1,
		PageDown: picker.active + page,
		PageUp: picker.active - page,
		Home: 0,
		End: picker.rows.length - 1,
	};

	if (event.key in moves && !event.altKey) {
		event.preventDefault();
		event.stopPropagation();
		highlight(picker, moves[event.key]);
		return;
	}
	if (event.key === "Enter" || event.key === " " || (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp"))) {
		event.preventDefault();
		event.stopPropagation();
		if (event.key === " " && Date.now() - typedAt < TYPEAHEAD_RESET_MS) {
			typeahead(picker, " ");
			return;
		}
		choose(picker, picker.active);
		return;
	}
	if (event.key === "Escape") {
		event.preventDefault();
		event.stopPropagation();
		close();
		return;
	}
	if (event.key === "Tab") {
		close();
		return;
	}
	if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
		event.preventDefault();
		event.stopPropagation();
		typeahead(picker, event.key);
	}
}

function onFocusOut(event: FocusEvent) {
	if (current && event.target === current.select) close();
}

export function installSelectPicker() {
	document.addEventListener("pointerdown", onPointerDown, true);
	document.addEventListener("mousedown", onMouseDown, true);
	document.addEventListener("keydown", onKeyDown, true);
	document.addEventListener("focusout", onFocusOut, true);
}
