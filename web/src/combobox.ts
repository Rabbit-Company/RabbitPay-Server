import { el } from "./dom";
import { t } from "./i18n";
import { filterOptions, type ComboOption } from "../../server/option-search";

export interface ComboAction {
	label: (query: string) => string;
	run: (query: string) => Promise<ComboOption | null>;
}

export interface ComboboxConfig {
	options?: ComboOption[];
	search?: (query: string) => Promise<ComboOption[]>;
	selected?: ComboOption | null;
	placeholder?: string;
	freeText?: boolean;
	required?: boolean;
	emptyText?: string;
	action?: ComboAction;
	class?: string;
	limit?: number;
}

export interface Combobox {
	element: HTMLElement;
	input: HTMLInputElement;
	readonly value: string;
	readonly selected: ComboOption | null;
	select(option: ComboOption | null): void;
	onChange(listener: (option: ComboOption | null) => void): void;
	setOptions(options: ComboOption[]): void;
}

let sequence = 0;

export function combobox(config: ComboboxConfig): Combobox {
	const id = `combo-${++sequence}`;
	const limit = config.limit ?? 50;
	let options = config.options ?? [];
	let selected: ComboOption | null = config.selected ?? null;
	let shown: ComboOption[] = [];
	let active = -1;
	let open = false;
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let searchRound = 0;
	let quietFocus = false;
	const listeners: ((option: ComboOption | null) => void)[] = [];

	const input = el("input", {
		type: "text",
		class: "combo-input",
		placeholder: config.placeholder,
		autocomplete: "off",
		required: config.required,
	});
	input.setAttribute("role", "combobox");
	input.setAttribute("aria-autocomplete", "list");
	input.setAttribute("aria-expanded", "false");
	input.setAttribute("aria-controls", `${id}-list`);
	input.spellcheck = false;

	const list = el("div", { class: "combo-list", id: `${id}-list` });
	list.setAttribute("role", "listbox");
	list.hidden = true;

	const element = el("div", { class: `combo ${config.class ?? ""}`.trim() }, input, list);

	const emit = () => {
		for (const listener of listeners) listener(selected);
	};

	const displayed = () => (selected ? selected.label : "");

	const place = () => {
		const rect = input.getBoundingClientRect();
		const below = window.innerHeight - rect.bottom;
		const above = rect.top;
		const upward = below < 220 && above > below;
		const room = Math.max((upward ? above : below) - 12, 120);

		list.style.left = `${rect.left}px`;
		list.style.width = `${rect.width}px`;
		list.style.maxHeight = `${Math.min(room, 280)}px`;
		list.style.top = upward ? "" : `${rect.bottom + 4}px`;
		list.style.bottom = upward ? `${window.innerHeight - rect.top + 4}px` : "";

		const overflow = list.getBoundingClientRect().right - (window.innerWidth - 8);
		if (overflow > 0) list.style.left = `${Math.max(rect.left - overflow, 8)}px`;
	};

	const follow = () => {
		if (!open) return;
		if (!input.isConnected) {
			close();
			return;
		}
		place();
	};

	const close = () => {
		window.removeEventListener("scroll", follow, true);
		window.removeEventListener("resize", follow);
		open = false;
		active = -1;
		list.hidden = true;
		input.setAttribute("aria-expanded", "false");
		input.removeAttribute("aria-activedescendant");
	};

	const highlight = (index: number) => {
		const rows = list.querySelectorAll<HTMLElement>(".combo-option");
		if (rows.length === 0) {
			active = -1;
			return;
		}

		active = (index + rows.length) % rows.length;
		rows.forEach((row, position) => row.classList.toggle("active", position === active));
		const current = rows[active];
		input.setAttribute("aria-activedescendant", current.id);
		current.scrollIntoView({ block: "nearest" });
	};

	const choose = (option: ComboOption | null) => {
		selected = option;
		input.value = option ? option.label : config.freeText ? input.value : "";
		close();
		emit();
	};

	const runAction = async (query: string) => {
		if (!config.action) return;
		close();
		const created = await config.action.run(query);
		if (created) {
			options = [created, ...options.filter((option) => option.value !== created.value)];
			choose(created);
		}
		quietFocus = true;
		input.focus();
	};

	const render = (query: string) => {
		const rows: HTMLElement[] = shown.map((option, index) => {
			const row = el(
				"div",
				{ class: `combo-option${selected?.value === option.value ? " selected" : ""}`, id: `${id}-option-${index}` },
				el("span", { class: "combo-label" }, option.label),
				option.hint ? el("span", { class: "combo-hint" }, option.hint) : null
			);
			row.setAttribute("role", "option");
			row.setAttribute("aria-selected", String(selected?.value === option.value));
			row.addEventListener("mousedown", (event) => event.preventDefault());
			row.addEventListener("click", (event) => {
				event.preventDefault();
				choose(option);
			});
			row.addEventListener("mousemove", () => {
				if (active !== index) highlight(index);
			});
			return row;
		});

		if (config.action) {
			const trimmed = query.trim();
			const row = el("div", { class: "combo-option combo-action", id: `${id}-option-${shown.length}` }, config.action.label(trimmed));
			row.setAttribute("role", "option");
			row.addEventListener("mousedown", (event) => event.preventDefault());
			row.addEventListener("click", (event) => {
				event.preventDefault();
				void runAction(trimmed);
			});
			rows.push(row);
		}

		if (rows.length === 0) {
			if (config.freeText) {
				close();
				return;
			}
			rows.push(el("div", { class: "combo-empty" }, config.emptyText ?? t("ui.no_matches")));
		}

		list.replaceChildren(...rows);
		list.hidden = false;
		if (!open) {
			window.addEventListener("scroll", follow, true);
			window.addEventListener("resize", follow);
		}
		open = true;
		place();
		input.setAttribute("aria-expanded", "true");

		if (config.freeText) {
			active = -1;
			input.removeAttribute("aria-activedescendant");
			return;
		}

		const current = shown.findIndex((option) => option.value === selected?.value);
		highlight(query.trim() === "" || input.value === displayed() ? Math.max(current, 0) : 0);
	};

	const refresh = (query: string) => {
		if (!config.search) {
			shown = filterOptions(options, query, limit);
			render(query);
			return;
		}

		clearTimeout(searchTimer);
		const round = ++searchRound;
		searchTimer = setTimeout(async () => {
			try {
				const found = await config.search!(query.trim());
				if (round !== searchRound || document.activeElement !== input) return;
				options = found;
				shown = found.slice(0, limit);
				render(query);
			} catch {
				if (round === searchRound) close();
			}
		}, 180);
	};

	const queryFromInput = () => (input.value === displayed() ? "" : input.value);

	input.addEventListener("focus", () => {
		if (quietFocus) {
			quietFocus = false;
			return;
		}
		if (!config.freeText) input.select();
		refresh(queryFromInput());
	});

	input.addEventListener("click", () => {
		if (!open && document.activeElement === input) refresh(queryFromInput());
	});

	input.addEventListener("input", () => {
		if (config.freeText && selected && input.value !== selected.label) {
			selected = null;
			emit();
		}
		refresh(input.value);
	});

	input.addEventListener("blur", () => {
		close();
		if (config.freeText) return;
		if (input.value.trim() === "" && selected && !config.required) {
			choose(null);
			return;
		}
		input.value = displayed();
	});

	input.addEventListener("keydown", (event) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (!open) {
				refresh(queryFromInput());
				return;
			}
			if (active < 0) highlight(event.key === "ArrowDown" ? 0 : -1);
			else highlight(active + (event.key === "ArrowDown" ? 1 : -1));
			return;
		}

		if (event.key === "Enter" && open && active >= 0) {
			event.preventDefault();
			if (active < shown.length) choose(shown[active]);
			else void runAction(input.value.trim());
			return;
		}

		if (event.key === "Enter" && open) {
			event.preventDefault();
			close();
			return;
		}

		if (event.key === "Escape" && open) {
			event.preventDefault();
			event.stopPropagation();
			close();
			if (!config.freeText) input.value = displayed();
			return;
		}

		if (event.key === "Tab") close();
	});

	input.value = displayed();

	return {
		element,
		input,
		get value() {
			return config.freeText ? input.value : (selected?.value ?? "");
		},
		get selected() {
			return selected;
		},
		select(option) {
			selected = option;
			input.value = option ? option.label : "";
		},
		onChange(listener) {
			listeners.push(listener);
		},
		setOptions(next) {
			options = next;
			if (selected) selected = next.find((option) => option.value === selected!.value) ?? selected;
		},
	};
}

export type { ComboOption };

export function staticCombobox(options: ComboOption[], value: string, extra: Omit<ComboboxConfig, "options" | "selected"> = {}): Combobox {
	return combobox({ ...extra, options, selected: options.find((option) => option.value === value) ?? null });
}
