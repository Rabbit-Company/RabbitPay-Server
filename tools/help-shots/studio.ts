import { join } from "node:path";
import { translate, type UiKey, type UiLanguage } from "../../web/src/i18n/dictionary";
import type { Box, Browser, Theme } from "./browser";
import type { HelpFurs } from "./furs";

export type ShotRecord = readonly [width: number, height: number, version: string];

export interface ShotOptions {
	target?: string | string[];
	padding?: number;
	mark?: string | string[];
	full?: boolean;
	scroll?: string;
	keepToasts?: boolean;
}

const THEMES: Theme[] = ["dark", "light"];
const PUBLIC_ADDRESS = "https://rabbitpay.net";
const MARK_CLASS = "help-shot-mark";
const BACKDROP_CLASS = "help-shot-backdrop";
const MARK_STYLE =
	"position:absolute;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:3px solid #ff3d71;border-radius:10px;box-shadow:0 0 0 4px rgba(255,61,113,0.28)";

function list(value: string | string[] | undefined): string[] {
	return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function union(boxes: Box[]): Box {
	const left = Math.min(...boxes.map((box) => box.x));
	const top = Math.min(...boxes.map((box) => box.y));
	const right = Math.max(...boxes.map((box) => box.x + box.width));
	const bottom = Math.max(...boxes.map((box) => box.y + box.height));
	return { x: left, y: top, width: right - left, height: bottom - top };
}

export class Studio {
	readonly shots = new Map<string, ShotRecord>();

	constructor(
		readonly browser: Browser,
		readonly base: string,
		readonly out: string,
		readonly language: UiLanguage,
		readonly module: string,
		readonly mailbox: string[] = [],
		readonly database = "",
		readonly furs: HelpFurs | null = null
	) {}

	linkFromEmail(path: string): string {
		const pattern = new RegExp(`${path}#token=([A-Za-z0-9]+)`);
		for (const message of [...this.mailbox].reverse()) {
			const found = message
				.replace(/=\r?\n/g, "")
				.replace(/=3D/g, "=")
				.match(pattern);
			if (found) return `${path}#token=${found[1]}`;
		}
		throw new Error(`No email with a ${path} link has arrived`);
	}

	t(key: UiKey, params?: Record<string, string | number>): string {
		return translate(this.language, key, params);
	}

	async open(path: string, settle?: number) {
		await this.browser.goto(`${this.base}${path}`, settle);
	}

	async clearToasts() {
		await this.browser.eval(`document.querySelectorAll(".toast").forEach((node) => node.remove())`);
	}

	private async showPublicAddress() {
		await this.browser.eval(
			`(() => { const local = ${JSON.stringify(this.base)}; const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.nodeValue.includes(local)) node.nodeValue = node.nodeValue.replaceAll(local, "${PUBLIC_ADDRESS}"); for (const field of document.querySelectorAll("input, textarea")) if (field.value.includes(local)) field.value = field.value.replaceAll(local, "${PUBLIC_ADDRESS}"); })()`
		);
	}

	private async showProductionFurs() {
		const test = JSON.stringify(this.t("fiscal.environment_test"));
		const production = JSON.stringify(this.t("fiscal.environment_production"));
		await this.browser.eval(
			`(() => { document.querySelectorAll(".doc-fiscal-test").forEach((node) => node.remove()); for (const pill of document.querySelectorAll(".fiscal-pills .pill")) if (pill.textContent === ${test}) pill.textContent = ${production}; })()`
		);
	}

	private async clip(options: ShotOptions): Promise<Box> {
		const page = await this.browser.pageSize();
		if (options.full) return { x: 0, y: 0, ...page };
		const targets = list(options.target);
		if (targets.length === 0) {
			return await this.browser.eval<Box>(`({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight })`);
		}
		const padding = options.padding ?? 16;
		const area = union(await Promise.all(targets.map((target) => this.browser.box(target))));
		const x = Math.max(0, Math.floor(area.x - padding));
		const y = Math.max(0, Math.floor(area.y - padding));
		return {
			x,
			y,
			width: Math.min(page.width, Math.ceil(area.x + area.width + padding)) - x,
			height: Math.min(page.height, Math.ceil(area.y + area.height + padding)) - y,
		};
	}

	private async mark(specs: string[]) {
		for (const spec of specs) {
			const box = await this.browser.box(spec);
			await this.browser.eval(
				`(() => { const mark = document.createElement("div"); mark.className = "${MARK_CLASS}"; mark.style.cssText = "${MARK_STYLE};left:${box.x - 6}px;top:${box.y - 6}px;width:${box.width + 12}px;height:${box.height + 12}px"; document.body.appendChild(mark); })()`
			);
		}
	}

	async shot(page: string, name: string, options: ShotOptions = {}) {
		if (!options.keepToasts) await this.clearToasts();
		await this.showPublicAddress();
		await this.showProductionFurs();
		const overlay = await this.browser.exists(".overlay");
		const stretched = overlay || options.full || list(options.target).length > 0;
		if (overlay) {
			const needed = await this.browser.eval<number>(`Math.max(...[...document.querySelectorAll(".overlay .dialog")].map((node) => node.scrollHeight)) + 96`);
			await this.browser.stretch(Math.max(needed, this.browser.size.height));
		} else if (stretched) {
			await this.browser.eval(`scrollTo(0, 0)`);
			await this.browser.stretch((await this.browser.pageSize()).height);
		} else if (options.scroll) await this.browser.scrollTo(options.scroll);
		const plain = overlay && list(options.target).length > 0;
		if (plain) {
			await this.browser.eval(
				`(() => { const style = document.createElement("style"); style.className = "${BACKDROP_CLASS}"; style.textContent = ".overlay { background: var(--bg) !important; backdrop-filter: none !important; }"; document.head.appendChild(style); })()`
			);
		}
		await this.mark(list(options.mark));
		const clip = await this.clip(options);
		const key = `${this.language}/${this.module}/${page}/${name}`;
		let version = "";
		for (const theme of THEMES) {
			await this.browser.theme(theme);
			const file = join(this.out, "help", this.language, theme, this.module, page, `${name}.webp`);
			await this.browser.capture(file, clip);
			if (theme === "dark")
				version = Bun.hash(await Bun.file(file).arrayBuffer())
					.toString(36)
					.slice(0, 8);
		}
		await this.browser.theme("dark");
		await this.browser.eval(`document.querySelectorAll(".${MARK_CLASS}, .${BACKDROP_CLASS}").forEach((node) => node.remove())`);
		if (stretched) await this.browser.stretch(null);
		this.shots.set(key, [Math.round(clip.width), Math.round(clip.height), version]);
		console.log(`  ${key} (${Math.round(clip.width)} x ${Math.round(clip.height)})`);
	}
}
