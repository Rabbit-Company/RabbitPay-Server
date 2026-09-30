type Child = Node | string | number | null | undefined | false;
import { statusLabel } from "./i18n";

interface ElementProps {
	class?: string;
	id?: string;
	type?: string;
	value?: string;
	placeholder?: string;
	href?: string;
	target?: string;
	rel?: string;
	title?: string;
	src?: string;
	alt?: string;
	disabled?: boolean;
	required?: boolean;
	min?: string;
	max?: string;
	step?: string;
	rows?: string;
	maxlength?: string;
	autocomplete?: string;
	dataset?: Record<string, string>;
	onClick?: (event: MouseEvent) => void;
	onSubmit?: (event: SubmitEvent) => void;
	onInput?: (event: Event) => void;
	onChange?: (event: Event) => void;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: ElementProps = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);

	for (const [key, value] of Object.entries(props)) {
		if (value === undefined || value === null || value === false) continue;

		if (key === "class") node.className = String(value);
		else if (key === "dataset") Object.assign(node.dataset, value);
		else if (key === "onClick") node.addEventListener("click", value as EventListener);
		else if (key === "onSubmit") node.addEventListener("submit", value as EventListener);
		else if (key === "onInput") node.addEventListener("input", value as EventListener);
		else if (key === "onChange") node.addEventListener("change", value as EventListener);
		else if (key === "disabled" || key === "required") (node as HTMLInputElement)[key] = true;
		else node.setAttribute(key, String(value));
	}

	append(node, children);
	return node;
}

export function append(parent: Node, children: Child[]) {
	for (const child of children) {
		if (child === null || child === undefined || child === false) continue;
		parent.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
	}
}

export function replaceContent(parent: Element, ...children: Child[]) {
	clear(parent);
	append(parent, children);
}

export function clear(node: Element) {
	while (node.firstChild) node.removeChild(node.firstChild);
}

export function field(label: string, input: HTMLElement, hint?: string) {
	return el("label", { class: "field" }, el("span", { class: "field-label" }, label), input, hint && el("span", { class: "field-hint" }, hint));
}

export function input(type: string, props: ElementProps = {}) {
	return el("input", { type, ...props });
}

export function select(options: { value: string; label: string }[], selected?: string) {
	const node = el("select", {});
	for (const option of options) {
		const child = el("option", { value: option.value }, option.label);
		if (option.value === selected) child.selected = true;
		node.appendChild(child);
	}
	return node;
}

export function button(label: string, onClick: () => void, variant = "primary") {
	return el("button", { class: `button ${variant}`, type: "button", onClick });
}

export function statusPill(status: string) {
	return el("span", { class: `pill pill-${status}` }, statusLabel(status));
}

export function emptyState(message: string, action?: HTMLElement) {
	return el("div", { class: "empty" }, el("p", {}, message), action);
}

export type TableHeader = string | { label: string; class: string };

export function table(headers: TableHeader[], rows: HTMLElement[]) {
	const head = el("tr", {}, ...headers.map((header) => (typeof header === "string" ? el("th", {}, header) : el("th", { class: header.class }, header.label))));
	return el("div", { class: "table-wrap" }, el("table", {}, el("thead", {}, head), el("tbody", {}, ...rows)));
}

export function spinner() {
	return el("div", { class: "spinner" }, el("span", {}));
}

export function saveFile(blob: Blob, name: string) {
	const url = URL.createObjectURL(blob);
	const link = el("a", { href: url });
	link.download = name;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
