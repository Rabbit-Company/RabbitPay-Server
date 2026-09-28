import { el, table } from "./dom";
import { t } from "./i18n";
import { reportError } from "./ui";
import { PageState } from "../../server/page-state";

export const PAGE_SIZE = 50;

export function pagination(load: () => Promise<void> | void, size = PAGE_SIZE, state = new PageState(size)) {
	let displayedOffset = state.offset;
	const label = el("span", { class: "muted" });
	label.setAttribute("aria-live", "polite");
	const previous = el("button", { class: "button ghost small", type: "button" }, t("pagination.previous"));
	const next = el("button", { class: "button ghost small", type: "button" }, t("pagination.next"));
	const element = el("nav", { class: "toolbar" }, label, el("div", { class: "line-actions" }, previous, next));
	element.setAttribute("aria-label", t("pagination.label"));
	const sync = () => {
		element.hidden = state.total === 0;
		label.textContent = t("pagination.range", { from: state.total ? state.offset + 1 : 0, to: Math.min(state.offset + size, state.total), total: state.total });
		previous.disabled = !state.previous;
		next.disabled = !state.next;
	};
	const move = async (direction: number) => {
		if (direction < 0 ? !state.previous : !state.next) return;
		const offset = state.offset;
		state.offset += direction * size;
		previous.disabled = true;
		next.disabled = true;
		try {
			await load();
		} catch (error) {
			state.offset = offset;
			reportError(error);
		} finally {
			sync();
		}
	};
	previous.addEventListener("click", () => void move(-1));
	next.addEventListener("click", () => void move(1));
	sync();
	return {
		element,
		state,
		reset() {
			state.reset();
			displayedOffset = 0;
			sync();
		},
		fail() {
			state.offset = displayedOffset;
			sync();
		},
		update(total: number) {
			const changed = state.update(total);
			if (!changed) displayedOffset = state.offset;
			sync();
			return changed;
		},
	};
}

export function pagedList<T>(items: T[], render: (page: T[]) => HTMLElement, size = PAGE_SIZE, state = new PageState(size)): HTMLElement {
	state.update(items.length);
	if (items.length <= size) return render(items);
	const body = el("div", {});
	const controls = pagination(
		() => {
			body.replaceChildren(render(items.slice(controls.state.offset, controls.state.offset + size)));
		},
		size,
		state
	);
	controls.update(items.length);
	body.replaceChildren(render(items.slice(state.offset, state.offset + size)));
	return el("div", { class: "stack" }, body, controls.element);
}

export function pagedTable(headers: string[], rows: HTMLElement[], size = PAGE_SIZE, state = new PageState(size)): HTMLElement {
	return pagedList(rows, (page) => table(headers, page), size, state);
}

export function remoteTable(
	headers: string[],
	fetchPage: (offset: number, size: number) => Promise<{ rows: HTMLElement[]; total: number }>,
	empty: string,
	initial?: { rows: HTMLElement[]; total: number }
): HTMLElement {
	const body = el("div", {});
	const controls = pagination(() => load());
	const render = (page: { rows: HTMLElement[]; total: number }) => {
		body.replaceChildren(page.rows.length ? table(headers, page.rows) : el("p", { class: "muted" }, empty));
	};
	const load = async (): Promise<void> => {
		const round = controls.state.begin();
		try {
			const page = await fetchPage(controls.state.offset, PAGE_SIZE);
			if (!controls.state.current(round)) return;
			if (controls.update(page.total)) return await load();
			render(page);
		} catch (error) {
			if (controls.state.current(round)) {
				controls.fail();
				reportError(error);
				if (body.querySelector(".spinner")) body.replaceChildren(el("p", { class: "muted" }, t("ui.load_failed")));
			}
		}
	};
	if (initial) {
		controls.update(initial.total);
		render(initial);
	} else {
		body.appendChild(el("div", { class: "spinner" }, el("span", {})));
		void load();
	}
	return el("div", { class: "stack" }, body, controls.element);
}
