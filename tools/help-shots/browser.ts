import { mkdirSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type Theme = "dark" | "light";

const FINDER = `
if (window.Notification) Object.defineProperty(window.Notification, "permission", { get: () => "default" });
window.__helpShots = {
	visible(node) {
		return !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
	},
	scope() {
		const overlays = [...document.querySelectorAll(".overlay")];
		return overlays[overlays.length - 1] ?? document;
	},
	text(node) {
		return (node.textContent ?? "").replace(/\\s+/g, " ").trim();
	},
	all(spec, root) {
		const chain = spec.split(" >> ");
		if (chain.length > 1) {
			let scopes = [root ?? null];
			for (const part of chain) scopes = scopes.flatMap((scope) => this.all(part, scope));
			return scopes;
		}
		const split = spec.indexOf(":");
		const kind = split === -1 ? "" : spec.slice(0, split);
		const value = spec.slice(split + 1);
		const scope = root ?? this.scope();
		const pick = (selector, matches) => [...scope.querySelectorAll(selector)].filter((node) => this.visible(node) && matches(node));
		if (kind === "button") return pick("button, a.button, summary, [role=tab], [role=menuitem]", (node) => this.text(node) === value);
		if (kind === "menu") return pick(".menu-item", (node) => this.text(node).startsWith(value));
		if (kind === "link") return pick("a", (node) => this.text(node) === value);
		if (kind === "tab") return pick("a.tab, .tabs a, .tabs button, .segment", (node) => this.text(node) === value);
		if (kind === "field" || kind === "fieldbox") {
			const labels = pick("label.field, .field", (node) => this.text(node.querySelector(".field-label") ?? node.firstChild ?? node) === value);
			return kind === "fieldbox" ? labels : labels.map((label) => label.querySelector("input, select, textarea")).filter(Boolean);
		}
		if (kind === "processor") return pick(".processor", (node) => this.text(node.querySelector(".switch span") ?? node) === value);
		if (kind === "card") return pick(".card", (node) => [...node.querySelectorAll("h2, h3")].some((heading) => this.text(heading) === value));
		if (kind === "text") {
			const hits = pick("*", (node) => this.text(node).includes(value));
			return hits.filter((node) => !hits.some((other) => other !== node && node.contains(other)));
		}
		return [...(root ?? document).querySelectorAll(spec)].filter((node) => this.visible(node));
	},
	find(spec) {
		const node = this.all(spec)[0];
		if (!node) throw new Error("Nothing on the page matches " + spec);
		return node;
	},
	box(spec, inPage) {
		const rect = this.find(spec).getBoundingClientRect();
		return { x: rect.x + (inPage ? scrollX : 0), y: rect.y + (inPage ? scrollY : 0), width: rect.width, height: rect.height };
	},
};
`;

function chromePath(): string {
	if (Bun.env.HELP_SHOTS_CHROME) return Bun.env.HELP_SHOTS_CHROME;
	const root = join(homedir(), ".cache/ms-playwright");
	const shell = readdirSync(root)
		.filter((name) => name.startsWith("chromium_headless_shell-"))
		.sort()
		.pop();
	if (!shell) throw new Error("No headless Chrome found. Set HELP_SHOTS_CHROME to a Chrome or Chromium binary.");
	return join(root, shell, "chrome-headless-shell-linux64/chrome-headless-shell");
}

export class Browser {
	private socket!: WebSocket;
	private sequence = 1;
	private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	private listeners = new Map<string, ((params: any) => void)[]>();
	private process!: ReturnType<typeof Bun.spawn>;
	private session = "";
	size = { width: 1280, height: 800, scale: 2 };

	static async launch(port = 9333): Promise<Browser> {
		const browser = new Browser();
		browser.process = Bun.spawn(
			[
				chromePath(),
				`--remote-debugging-port=${port}`,
				`--user-data-dir=${join(tmpdir(), `rabbitpay-help-shots-${Date.now()}`)}`,
				"--hide-scrollbars",
				"--no-first-run",
				"--disable-gpu",
				"--font-render-hinting=none",
				"about:blank",
			],
			{ stdout: "ignore", stderr: "ignore" }
		);
		let endpoint = "";
		for (let attempt = 0; attempt < 80 && !endpoint; attempt++) {
			await Bun.sleep(100);
			try {
				endpoint = ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
			} catch {
				endpoint = "";
			}
		}
		if (!endpoint) throw new Error("Chrome did not start");

		browser.socket = new WebSocket(endpoint);
		await new Promise<void>((resolve, reject) => {
			browser.socket.onopen = () => resolve();
			browser.socket.onerror = () => reject(new Error("Could not reach Chrome"));
		});
		browser.socket.onmessage = (event) => {
			const message = JSON.parse(String(event.data));
			if (!message.id) {
				for (const listener of browser.listeners.get(message.method) ?? []) listener(message.params);
				return;
			}
			const waiter = browser.pending.get(message.id);
			browser.pending.delete(message.id);
			if (message.error) waiter?.reject(new Error(message.error.message));
			else waiter?.resolve(message.result);
		};

		const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" }, false);
		browser.session = (await browser.send("Target.attachToTarget", { targetId, flatten: true }, false)).sessionId;
		await browser.send("Page.enable");
		await browser.send("Runtime.enable");
		await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: FINDER });
		await browser
			.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite", "notifications"] }, false)
			.catch(() => null);
		return browser;
	}

	send(method: string, params: Record<string, unknown> = {}, inSession = true): Promise<any> {
		const id = this.sequence++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params, ...(inSession ? { sessionId: this.session } : {}) }));
		});
	}

	on(method: string, listener: (params: any) => void) {
		this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
	}

	async serveLocally(origin: string, directory: string) {
		await this.send("Fetch.enable", { patterns: [{ urlPattern: `${origin}/*` }] });
		this.on("Fetch.requestPaused", async ({ requestId, request }) => {
			const file = Bun.file(join(directory, decodeURIComponent(new URL(request.url).pathname)));
			if (!(await file.exists())) {
				await this.send("Fetch.fulfillRequest", { requestId, responseCode: 404 });
				return;
			}
			await this.send("Fetch.fulfillRequest", {
				requestId,
				responseCode: 200,
				responseHeaders: [{ name: "Content-Type", value: file.type }],
				body: Buffer.from(await file.arrayBuffer()).toString("base64"),
			});
		});
	}

	async viewport(width: number, height: number, scale = 2, mobile = false) {
		this.size = { width, height, scale };
		await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile });
	}

	async stretch(height: number | null) {
		const { width, scale } = this.size;
		await this.send("Emulation.setDeviceMetricsOverride", { width, height: height ?? this.size.height, deviceScaleFactor: scale, mobile: false });
		await Bun.sleep(200);
	}

	async theme(theme: Theme) {
		await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
		await Bun.sleep(120);
	}

	async goto(url: string, settle = 700) {
		const loaded = new Promise<void>((resolve) => this.on("Page.loadEventFired", () => resolve()));
		await this.send("Page.navigate", { url });
		await Promise.race([loaded, Bun.sleep(15000)]);
		await Bun.sleep(settle);
	}

	async wait(ms = 400) {
		await Bun.sleep(ms);
	}

	async eval<T = unknown>(expression: string): Promise<T> {
		const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
		return result.result.value as T;
	}

	async exists(spec: string): Promise<boolean> {
		return await this.eval<boolean>(`window.__helpShots.all(${JSON.stringify(spec)}).length > 0`);
	}

	async waitFor(spec: string, timeout = 10000) {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			if (await this.exists(spec)) return;
			await Bun.sleep(100);
		}
		throw new Error(`Timed out waiting for ${spec}`);
	}

	async box(spec: string, inPage = true): Promise<Box> {
		return await this.eval<Box>(`window.__helpShots.box(${JSON.stringify(spec)}, ${inPage})`);
	}

	async scrollTo(spec: string) {
		await this.eval(`window.__helpShots.find(${JSON.stringify(spec)}).scrollIntoView({ block: "center" })`);
		await Bun.sleep(150);
	}

	async hover(spec: string) {
		await this.scrollTo(spec);
		const box = await this.box(spec, false);
		await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + box.width / 2, y: box.y + box.height / 2 });
		await Bun.sleep(150);
	}

	async click(spec: string, settle = 350) {
		await this.waitFor(spec);
		await this.scrollTo(spec);
		const box = await this.box(spec, false);
		const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, button: "left", clickCount: 1 };
		await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
		await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point });
		await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point });
		await Bun.sleep(settle);
	}

	async type(text: string) {
		await this.send("Input.insertText", { text });
		await Bun.sleep(120);
	}

	async press(key: string, keyCode: number) {
		const event = { key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
		await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...event });
		await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
		await Bun.sleep(150);
	}

	async fill(spec: string, text: string) {
		await this.click(spec, 100);
		await this.eval(`(() => { const node = window.__helpShots.find(${JSON.stringify(spec)}); node.focus(); node.select?.(); })()`);
		if (text === "") await this.press("Backspace", 8);
		else await this.type(text);
	}

	async choose(spec: string, value: string) {
		await this.waitFor(spec);
		await this.eval(
			`(() => { const node = window.__helpShots.find(${JSON.stringify(spec)}); const wanted = ${JSON.stringify(value)}; const option = [...node.options].find((entry) => entry.value === wanted || entry.textContent.trim() === wanted); if (!option) throw new Error("No option " + wanted); node.value = option.value; node.dispatchEvent(new Event("input", { bubbles: true })); node.dispatchEvent(new Event("change", { bubbles: true })); })()`
		);
		await Bun.sleep(250);
	}

	async pick(spec: string, query: string, option = query) {
		await this.fill(spec, query);
		const choice = `.combo-option >> text:${option}`;
		await this.waitFor(choice);
		await this.click(choice);
	}

	async blur() {
		await this.eval(`document.activeElement?.blur?.()`);
		await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
		await Bun.sleep(100);
	}

	async pageSize(): Promise<{ width: number; height: number }> {
		return await this.eval(`({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })`);
	}

	async capture(path: string, clip?: Box) {
		mkdirSync(dirname(path), { recursive: true });
		const params: Record<string, unknown> = { format: "webp", quality: 92, captureBeyondViewport: clip !== undefined };
		if (clip) params.clip = { ...clip, scale: 1 };
		const { data } = await this.send("Page.captureScreenshot", params);
		await Bun.write(path, Buffer.from(data, "base64"));
	}

	async close() {
		await this.send("Browser.close", {}, false).catch(() => null);
		this.process.kill();
	}
}
