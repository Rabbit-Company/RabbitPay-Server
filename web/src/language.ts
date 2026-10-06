import { el } from "./dom";
import { language, setLanguage, t, UI_LANGUAGES, type UiLanguage } from "./i18n";
import { render } from "./router";

let sequence = 0;

export function languageSwitcher(onChange: (next: UiLanguage) => void = () => void render()): HTMLElement {
	const id = `language-${++sequence}`;
	const current = language();
	const currentLabel = UI_LANGUAGES.find((option) => option.value === current)?.label ?? current;

	const trigger = el("button", { class: "language-trigger", type: "button", title: t("app.language") }, currentLabel);
	trigger.setAttribute("aria-label", t("app.language"));
	trigger.setAttribute("aria-haspopup", "listbox");
	trigger.setAttribute("aria-expanded", "false");
	trigger.setAttribute("aria-controls", `${id}-list`);

	const list = el("div", { class: "combo-list language-list", id: `${id}-list` });
	list.setAttribute("role", "listbox");
	list.hidden = true;

	const rows = UI_LANGUAGES.map((option) => {
		const row = el("div", { class: `combo-option${option.value === current ? " selected" : ""}` }, el("span", { class: "combo-label" }, option.label));
		row.setAttribute("role", "option");
		row.setAttribute("aria-selected", String(option.value === current));
		row.addEventListener("mousedown", (event) => event.preventDefault());
		row.addEventListener("mouseenter", () => highlight(rows.indexOf(row)));
		row.addEventListener("click", () => choose(option.value as UiLanguage));
		list.append(row);
		return row;
	});

	let active = -1;

	function highlight(index: number) {
		active = index;
		rows.forEach((row, position) => row.classList.toggle("active", position === index));
	}

	function onOutside(event: PointerEvent) {
		if (!wrapper.contains(event.target as Node)) close();
	}

	function open() {
		list.hidden = false;
		trigger.setAttribute("aria-expanded", "true");
		highlight(
			Math.max(
				0,
				UI_LANGUAGES.findIndex((option) => option.value === current)
			)
		);
		document.addEventListener("pointerdown", onOutside);
	}

	function close() {
		list.hidden = true;
		trigger.setAttribute("aria-expanded", "false");
		highlight(-1);
		document.removeEventListener("pointerdown", onOutside);
	}

	function choose(value: UiLanguage) {
		close();
		trigger.focus();
		if (value === current) return;
		setLanguage(value);
		onChange(value);
	}

	trigger.addEventListener("click", () => (list.hidden ? open() : close()));
	trigger.addEventListener("blur", close);
	trigger.addEventListener("keydown", (event) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (list.hidden) return open();
			const step = event.key === "ArrowDown" ? 1 : -1;
			highlight((active + step + rows.length) % rows.length);
		} else if ((event.key === "Enter" || event.key === " ") && !list.hidden && active >= 0) {
			event.preventDefault();
			choose(UI_LANGUAGES[active]!.value as UiLanguage);
		} else if (event.key === "Escape" && !list.hidden) {
			event.preventDefault();
			close();
		}
	});

	const wrapper = el("div", { class: "language" }, trigger, list);
	return wrapper;
}
