export interface Route {
	pattern: string;
	render: (params: Record<string, string>) => Promise<HTMLElement> | HTMLElement;
	requiresAuth: boolean;
}

const routes: Route[] = [];
let outlet: HTMLElement | null = null;
let notFound: () => HTMLElement = () => document.createElement("div");
let guard: () => boolean = () => true;
let afterRender: () => void = () => {};
let leaveHandlers: (() => void)[] = [];
let renderRound = 0;

export function define(pattern: string, render: Route["render"], requiresAuth = true) {
	routes.push({ pattern, render, requiresAuth });
}

export function configure(options: { outlet: HTMLElement; notFound: () => HTMLElement; guard: () => boolean; afterRender: () => void }) {
	outlet = options.outlet;
	notFound = options.notFound;
	guard = options.guard;
	afterRender = options.afterRender;
}

function match(pattern: string, path: string): Record<string, string> | null {
	const patternParts = pattern.split("/").filter(Boolean);
	const pathParts = path.split("/").filter(Boolean);
	if (patternParts.length !== pathParts.length) return null;

	const params: Record<string, string> = {};
	for (let index = 0; index < patternParts.length; index++) {
		const expected = patternParts[index];
		const actual = pathParts[index];

		if (expected.startsWith(":")) params[expected.slice(1)] = decodeURIComponent(actual);
		else if (expected !== actual) return null;
	}

	return params;
}

export function navigate(path: string, replace = false) {
	if (replace) history.replaceState({}, "", path);
	else history.pushState({}, "", path);
	void render();
}

export function onLeave(handler: () => void) {
	leaveHandlers.push(handler);
}

function leaveCurrentView() {
	const handlers = leaveHandlers;
	leaveHandlers = [];
	for (const handler of handlers) handler();
}

export function currentPath(): string {
	return window.location.pathname;
}

export async function render() {
	if (!outlet) return;
	const round = ++renderRound;

	const path = currentPath();
	leaveCurrentView();

	for (const route of routes) {
		const params = match(route.pattern, path);
		if (params === null) continue;

		if (route.requiresAuth && !guard()) {
			navigate("/login", true);
			return;
		}

		try {
			const view = await route.render(params);
			if (round !== renderRound) return;
			outlet.replaceChildren(view);
		} catch (error) {
			if (round !== renderRound) return;
			outlet.replaceChildren(errorView(error));
		}

		afterRender();
		window.scrollTo(0, 0);
		return;
	}

	outlet.replaceChildren(notFound());
	afterRender();
}

let errorView: (error: unknown) => HTMLElement = () => document.createElement("div");

export function setErrorView(view: (error: unknown) => HTMLElement) {
	errorView = view;
}

export function start() {
	window.addEventListener("popstate", () => void render());

	document.addEventListener("click", (event) => {
		const target = (event.target as HTMLElement)?.closest("a");
		if (!target) return;

		const href = target.getAttribute("href");
		if (!href || !href.startsWith("/") || target.hasAttribute("download") || target.getAttribute("target") === "_blank") return;

		event.preventDefault();
		navigate(href);
	});

	void render();
}
