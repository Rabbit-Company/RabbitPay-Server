import { projectPath } from "../actions";
import type { Session } from "../demo";
import type { Guide } from "../run";
import type { Studio } from "../studio";

const WEBHOOK = {
	en: "https://shop.harbourlane.example/rabbitpay/webhook",
	sl: "https://trgovina.podlipo.example/rabbitpay/webhook",
};

async function overview(studio: Studio, session: Session) {
	await studio.open(projectPath(session), 1500);
	await studio.shot("index", "nav", { target: ".project-nav", padding: 12, mark: `.project-nav a[href$="/settings"]` });
}

function signaturePath(): [number, number][][] {
	const strokes: [number, number][][] = [];
	const first: [number, number][] = [];
	for (let step = 0; step <= 60; step++) {
		const t = step / 60;
		first.push([0.08 + t * 0.42, 0.62 - Math.sin(t * Math.PI * 3) * 0.22 - t * 0.08]);
	}
	strokes.push(first);
	const second: [number, number][] = [];
	for (let step = 0; step <= 80; step++) {
		const t = step / 80;
		second.push([0.52 + t * 0.4 + Math.sin(t * Math.PI * 6) * 0.03, 0.58 - Math.cos(t * Math.PI * 6) * 0.14 + t * 0.04]);
	}
	strokes.push(second);
	strokes.push([
		[0.12, 0.8],
		[0.5, 0.76],
		[0.88, 0.8],
	]);
	return strokes;
}

async function drawSignature(studio: Studio, spec: string) {
	const { browser } = studio;
	await browser.scrollTo(spec);
	const box = await browser.box(spec, false);
	for (const stroke of signaturePath()) {
		const [startX, startY] = stroke[0]!;
		const at = (x: number, y: number) => ({ x: box.x + x * box.width, y: box.y + y * box.height });
		await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at(startX, startY) });
		await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...at(startX, startY) });
		for (const [x, y] of stroke.slice(1)) {
			await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, ...at(x, y) });
		}
		const [endX, endY] = stroke[stroke.length - 1]!;
		await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...at(endX, endY) });
	}
	await browser.wait(300);
}

async function documents(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "documents";
	await studio.open(projectPath(session, "/settings"), 2500);
	await studio.shot(page, "invoice", { target: `card:${studio.t("payments.invoice")}`, padding: 16 });
	await studio.open(projectPath(session, "/members"), 2000);
	await browser.click(`button:${studio.t("members.edit_profile")}`, 1200);
	if (await browser.exists(".dialog")) {
		await drawSignature(studio, ".dialog canvas");
		await studio.shot(page, "identity", { target: ".dialog", padding: 32 });
		await browser.click(".dialog >> button[type=submit]", 1500);
		if (await browser.exists(".dialog")) await browser.click(".dialog .icon-button");
	}
}

async function color(studio: Studio, session: Session) {
	const { browser } = studio;
	await studio.open(projectPath(session, "/settings"), 2500);
	const card = `card:${studio.t("settings.accent_color")}`;
	await browser.click(`${card} >> .swatch:nth-child(4)`, 500);
	await studio.shot("brand-color", "card", { target: card, padding: 16 });
}

async function developers(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "api-keys-and-webhooks";
	await studio.open(projectPath(session, "/settings"), 2500);
	await studio.shot(page, "keys", { target: `card:${studio.t("settings.api_keys")}`, padding: 16 });
	const webhooks = `card:${studio.t("settings.webhooks")}`;
	await browser.fill(`${webhooks} >> input`, WEBHOOK[studio.language as "en" | "sl"]);
	await browser.click(`${webhooks} >> button:${studio.t("settings.save_webhook_url")}`, 1500);
	await studio.shot(page, "webhooks", { target: webhooks, padding: 16 });
	await browser.click(`${webhooks} >> button:${studio.t("settings.rotate")}`, 800);
	if (await browser.exists(".dialog")) {
		await studio.shot(page, "rotate", { target: ".dialog", padding: 32 });
		await browser.click(`.dialog >> button:${studio.t("ui.cancel")}`, 600);
	}
	await browser.fill(`${webhooks} >> input`, "");
	await browser.click(`${webhooks} >> button:${studio.t("settings.save_webhook_url")}`, 1200);
}

async function remove(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "delete-project";
	await studio.open(projectPath(session, "/settings"), 2500);
	await studio.shot(page, "card", { target: ".card.danger-zone", padding: 16 });
	await browser.click(".card.danger-zone button.danger", 800);
	if (await browser.exists(".dialog")) {
		await studio.shot(page, "confirm", { target: ".dialog", padding: 32 });
		await browser.click(`.dialog >> button:${studio.t("ui.cancel")}`, 600);
	}
}

export const settings: Guide = {
	module: "settings",
	steps: [
		["overview", overview],
		["documents", documents],
		["color", color],
		["developers", developers],
		["remove", remove],
	],
};
