import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectApi, projectPath } from "../actions";
import { framedPrint, HARBOUR, hero, LINDEN, writeArtwork } from "../artwork";
import type { Session } from "../demo";
import type { Guide } from "../run";
import type { Studio } from "../studio";
import { slovenianSession } from "./slovenia";

const CONTENT = ".project-content";
const FILES = join(tmpdir(), "rabbitpay-help-shots-files", "explorer");

const FOLDERS = {
	en: { clients: "Clients", brand: "Brand guide", photos: "Photos", photo: "studio-poster", banner: "campaign-banner" },
	sl: { clients: "Stranke", brand: "Celostna podoba", photos: "Fotografije", photo: "plakat-studio", banner: "pasica-akcija" },
};

function folders(studio: Studio) {
	return FOLDERS[studio.language as "en" | "sl"];
}

async function prepare(studio: Studio, session: Session) {
	const local = slovenianSession(session);
	await studio.open(projectPath(local), 800);
	const names = folders(studio);
	const created: Record<string, string> = {};
	for (const key of ["clients", "brand", "photos"] as const) {
		const folder = await projectApi<{ uuid: string }>(studio, local, "POST", "/explorer/folders", { name: names[key], parent: null });
		created[key] = folder.uuid;
	}
	session.marks = { ...session.marks, photosFolder: created.photos!, brandFolder: created.brand! };
	const palette = studio.language === "sl" ? LINDEN : HARBOUR;
	const motif = studio.language === "sl" ? "linden" : "harbour";
	await writeArtwork(join(FILES, studio.language), names.photo, framedPrint(palette, motif));
	await writeArtwork(join(FILES, studio.language), names.banner, hero(palette, motif));
}

async function upload(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "keep-files";
	const names = folders(studio);
	await studio.open(projectPath(local), 1500);
	await studio.shot(page, "nav", { target: ".project-nav", padding: 12, mark: `.project-nav a[href$="/files"]` });
	await studio.open(projectPath(local, `/files/folders/${session.marks!.photosFolder}`), 2000);
	for (const name of [names.photo, names.banner]) {
		await browser.chooseFile(`button:${studio.t("explorer.upload")}`, join(FILES, studio.language, `${name}.webp`));
		await browser.wait(2500);
	}
	await studio.shot(page, "folder", { target: CONTENT, mark: `button:${studio.t("explorer.upload")}` });
	await studio.open(projectPath(local, "/files"), 2000);
	await studio.shot(page, "root", { target: CONTENT });
}

async function share(studio: Studio, session: Session) {
	const { browser } = studio;
	const local = slovenianSession(session);
	const page = "share";
	await studio.open(projectPath(local, "/files"), 2000);
	await browser.click(`${CONTENT} tbody tr:has(a[href*="/files/folders/"]) .explorer-more`, 600);
	await browser.click(`menu:${studio.t("explorer.share")}`, 800);
	if (await browser.exists(".dialog")) {
		await studio.shot(page, "dialog", { target: ".dialog", padding: 32 });
		await browser.click(".dialog .icon-button");
	}
	await studio.open(projectPath(local, "/file-storage"), 2500);
	await studio.shot("storage", "limits", { target: CONTENT });
	await studio.open(projectPath(local, "/files/chat-attachments"), 2000);
	await studio.shot("storage", "chat-attachments", { target: CONTENT });
}

export const files: Guide = {
	module: "files",
	steps: [
		["prepare", prepare],
		["upload", upload],
		["share", share],
	],
};
