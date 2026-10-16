import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Palette {
	sky: string;
	sea: string;
	deep: string;
	sun: string;
	land: string;
	ink: string;
	paper: string;
	wall: string;
}

export const HARBOUR: Palette = {
	sky: "#f6d7b0",
	sea: "#3f7c8c",
	deep: "#22495a",
	sun: "#ef8a5b",
	land: "#2f3e46",
	ink: "#1d2a30",
	paper: "#fbf6ee",
	wall: "#e9e4dc",
};

export const LINDEN: Palette = {
	sky: "#e8efd9",
	sea: "#6f9a5b",
	deep: "#3d6b3a",
	sun: "#e6b84f",
	land: "#2e4a2b",
	ink: "#24301f",
	paper: "#fbf8ef",
	wall: "#e7e9e1",
};

function svg(width: number, height: number, body: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

function waves(palette: Palette, x: number, y: number, width: number, height: number): string {
	const rows = 5;
	return Array.from({ length: rows }, (_, row) => {
		const top = y + (height / rows) * row;
		const amplitude = 10 + row * 3;
		const steps = 8;
		const path = Array.from({ length: steps + 1 }, (_, step) => {
			const px = x + (width / steps) * step;
			const py = top + (step % 2 === 0 ? 0 : amplitude);
			return `${step === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`;
		}).join(" ");
		const colour = row % 2 === 0 ? palette.sea : palette.deep;
		return `<path d="${path} L${x + width},${y + height} L${x},${y + height} Z" fill="${colour}" opacity="${0.55 + row * 0.1}"/>`;
	}).join("");
}

function harbourScene(palette: Palette, x: number, y: number, width: number, height: number, night = false): string {
	const horizon = y + height * 0.58;
	const sky = night ? palette.deep : palette.sky;
	const sun = night ? palette.paper : palette.sun;
	const boat = (bx: number, scale: number) =>
		`<g transform="translate(${bx},${horizon - 6 * scale}) scale(${scale})"><path d="M-30,0 L30,0 L20,12 L-20,12 Z" fill="${palette.ink}"/><path d="M0,0 L0,-46 L24,-6 Z" fill="${palette.paper}"/><path d="M-2,0 L-2,-40 L-22,-6 Z" fill="${palette.sun}" opacity="0.9"/></g>`;
	const lighthouse = `<g transform="translate(${x + width * 0.78},${horizon})"><rect x="-10" y="-120" width="20" height="120" fill="${palette.paper}"/><rect x="-10" y="-100" width="20" height="14" fill="${palette.sun}"/><rect x="-10" y="-62" width="20" height="14" fill="${palette.sun}"/><rect x="-14" y="-136" width="28" height="18" fill="${palette.ink}"/>${night ? `<path d="M0,-128 L-160,-170 L-160,-90 Z" fill="${palette.sun}" opacity="0.35"/>` : ""}</g>`;
	return [
		`<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${sky}"/>`,
		`<circle cx="${x + width * 0.34}" cy="${y + height * 0.36}" r="${Math.min(width, height) * 0.13}" fill="${sun}" opacity="${night ? 0.95 : 1}"/>`,
		`<path d="M${x},${horizon} L${x + width * 0.22},${horizon - height * 0.12} L${x + width * 0.42},${horizon} Z" fill="${palette.land}" opacity="0.85"/>`,
		lighthouse,
		waves(palette, x, horizon, width, y + height - horizon),
		boat(x + width * 0.55, 1.1),
		boat(x + width * 0.2, 0.7),
	].join("");
}

function lindenTree(palette: Palette, cx: number, top: number, size: number, ground: number): string {
	const leaf = (lx: number, ly: number, scale: number, rotate: number, colour: string) =>
		`<path transform="translate(${lx},${ly}) rotate(${rotate}) scale(${scale})" d="M0,-30 C22,-30 30,-6 0,22 C-30,-6 -22,-30 0,-30 Z" fill="${colour}"/>`;
	const crown = top + size * 0.38;
	const leaves = Array.from({ length: 26 }, (_, index) => {
		const angle = (index / 26) * Math.PI * 2;
		const radius = size * (0.12 + (index % 3) * 0.05);
		return leaf(
			cx + Math.cos(angle) * radius,
			crown + Math.sin(angle) * radius * 0.8,
			(size / 400) * (1.2 + (index % 4) * 0.25),
			(index * 47) % 360,
			index % 2 === 0 ? palette.sea : palette.deep
		);
	}).join("");
	return `<rect x="${cx - size * 0.03}" y="${top + size * 0.42}" width="${size * 0.06}" height="${ground - top - size * 0.42}" fill="${palette.land}"/>${leaves}`;
}

function lindenScene(palette: Palette, x: number, y: number, width: number, height: number, night = false): string {
	const ground = y + height * 0.72;
	const size = Math.min(width, height);
	const count = Math.max(1, Math.round(width / height));
	const trees = Array.from({ length: count }, (_, index) => {
		const scale = count === 1 ? 1 : index % 2 === 0 ? 0.8 : 0.62;
		const treeSize = size * scale;
		return lindenTree(palette, x + width * (0.5 + (index - (count - 1) / 2) * 0.2), ground - treeSize * 0.72, treeSize, ground);
	}).join("");
	return [
		`<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${night ? palette.deep : palette.sky}"/>`,
		`<circle cx="${x + width * (count === 1 ? 0.78 : 0.9)}" cy="${y + height * 0.18}" r="${size * 0.07}" fill="${night ? palette.paper : palette.sun}"/>`,
		trees,
		`<rect x="${x}" y="${ground}" width="${width}" height="${y + height - ground}" fill="${palette.land}" opacity="0.9"/>`,
		`<path d="M${x},${ground} Q${x + width * 0.5},${ground - 24} ${x + width},${ground}" fill="${palette.sea}" opacity="0.6"/>`,
	].join("");
}

type Scene = (palette: Palette, x: number, y: number, width: number, height: number, night?: boolean) => string;

function sceneFor(motif: "harbour" | "linden"): Scene {
	return motif === "harbour" ? harbourScene : lindenScene;
}

export function framedPrint(palette: Palette, motif: "harbour" | "linden", night = false): string {
	const scene = sceneFor(motif);
	return svg(
		1200,
		1200,
		[
			`<rect width="1200" height="1200" fill="${palette.wall}"/>`,
			`<rect x="0" y="980" width="1200" height="220" fill="${palette.wall}" opacity="0.6"/>`,
			`<rect x="0" y="1010" width="1200" height="190" fill="#c9b8a3"/>`,
			`<rect x="330" y="150" width="540" height="740" fill="#000" opacity="0.12" transform="translate(14,18)"/>`,
			`<rect x="330" y="150" width="540" height="740" fill="${palette.ink}"/>`,
			`<rect x="352" y="172" width="496" height="696" fill="${palette.paper}"/>`,
			scene(palette, 400, 220, 400, 520, night),
			`<rect x="400" y="770" width="160" height="6" fill="${palette.ink}" opacity="0.7"/>`,
			`<rect x="400" y="790" width="100" height="6" fill="${palette.ink}" opacity="0.4"/>`,
			`<path d="M120,1010 C120,900 170,860 220,860 C270,860 300,900 300,1010 Z" fill="#7d8c6a"/>`,
			`<rect x="150" y="990" width="120" height="40" rx="6" fill="#b5865a"/>`,
		].join("")
	);
}

export function printDetail(palette: Palette, motif: "harbour" | "linden", night = false): string {
	const scene = sceneFor(motif);
	return svg(
		1200,
		1200,
		[
			`<rect width="1200" height="1200" fill="#d8d2c8"/>`,
			`<g transform="rotate(-6 600 600)"><rect x="210" y="120" width="780" height="980" fill="#000" opacity="0.15" transform="translate(16,20)"/><rect x="210" y="120" width="780" height="980" fill="${palette.paper}"/>`,
			scene(palette, 270, 180, 660, 760, night),
			`<rect x="270" y="980" width="260" height="10" fill="${palette.ink}" opacity="0.7"/><rect x="270" y="1008" width="160" height="10" fill="${palette.ink}" opacity="0.4"/></g>`,
		].join("")
	);
}

export function stickerSheet(palette: Palette, motif: "harbour" | "linden"): string {
	const sticker = (cx: number, cy: number, r: number, inner: string) =>
		`<g><circle cx="${cx + 6}" cy="${cy + 8}" r="${r}" fill="#000" opacity="0.12"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="#ffffff"/><circle cx="${cx}" cy="${cy}" r="${r - 14}" fill="${palette.sky}"/>${inner}</g>`;
	const scene = sceneFor(motif);
	const clip = (id: string, cx: number, cy: number, r: number) => `<clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="${r - 14}"/></clipPath>`;
	const spots = [
		[360, 380, 230],
		[820, 340, 180],
		[760, 780, 230],
		[330, 860, 170],
	] as const;
	return svg(
		1200,
		1200,
		[
			`<rect width="1200" height="1200" fill="${palette.wall}"/>`,
			`<defs>${spots.map(([cx, cy, r], index) => clip(`c${index}`, cx, cy, r)).join("")}</defs>`,
			...spots.map(([cx, cy, r], index) =>
				sticker(cx, cy, r, `<g clip-path="url(#c${index})">${scene(palette, cx - r, cy - r, r * 2, r * 2, index % 2 === 1)}</g>`)
			),
		].join("")
	);
}

export function toteBag(palette: Palette, motif: "harbour" | "linden"): string {
	const scene = sceneFor(motif);
	return svg(
		1200,
		1200,
		[
			`<rect width="1200" height="1200" fill="${palette.wall}"/>`,
			`<path d="M470,330 C470,170 730,170 730,330" fill="none" stroke="#d9cbb2" stroke-width="34"/>`,
			`<path d="M330,330 L870,330 L910,1060 L290,1060 Z" fill="#000" opacity="0.1" transform="translate(16,18)"/>`,
			`<path d="M330,330 L870,330 L910,1060 L290,1060 Z" fill="#efe6d3"/>`,
			`<clipPath id="art"><rect x="420" y="470" width="360" height="420" rx="8"/></clipPath>`,
			`<g clip-path="url(#art)">${scene(palette, 420, 470, 360, 420)}</g>`,
		].join("")
	);
}

export function mug(palette: Palette, motif: "harbour" | "linden"): string {
	const scene = sceneFor(motif);
	return svg(
		1200,
		1200,
		[
			`<rect width="1200" height="1200" fill="${palette.wall}"/>`,
			`<ellipse cx="600" cy="980" rx="330" ry="40" fill="#000" opacity="0.12"/>`,
			`<path d="M820,470 C1000,470 1000,800 820,800" fill="none" stroke="#ffffff" stroke-width="60"/>`,
			`<rect x="330" y="360" width="520" height="620" rx="40" fill="#ffffff"/>`,
			`<clipPath id="wrap"><rect x="380" y="460" width="420" height="380" rx="10"/></clipPath>`,
			`<g clip-path="url(#wrap)">${scene(palette, 380, 460, 420, 380)}</g>`,
			`<ellipse cx="590" cy="370" rx="260" ry="34" fill="#f1f1f1"/>`,
		].join("")
	);
}

export function cardSet(palette: Palette, motif: "harbour" | "linden"): string {
	const scene = sceneFor(motif);
	const card = (x: number, y: number, rotate: number, night: boolean, id: string) =>
		`<g transform="rotate(${rotate} ${x + 190} ${y + 260})"><rect x="${x}" y="${y}" width="380" height="520" fill="#000" opacity="0.12" transform="translate(10,14)"/><rect x="${x}" y="${y}" width="380" height="520" fill="${palette.paper}"/><clipPath id="${id}"><rect x="${x + 30}" y="${y + 30}" width="320" height="400"/></clipPath><g clip-path="url(#${id})">${scene(palette, x + 30, y + 30, 320, 400, night)}</g></g>`;
	return svg(
		1200,
		1200,
		[
			`<rect width="1200" height="1200" fill="${palette.wall}"/>`,
			card(170, 320, -10, false, "a"),
			card(420, 260, 4, true, "b"),
			card(650, 360, 12, false, "c"),
		].join("")
	);
}

export function logo(palette: Palette, motif: "harbour" | "linden"): string {
	const mark =
		motif === "harbour"
			? `<circle cx="200" cy="200" r="150" fill="${palette.deep}"/><circle cx="200" cy="170" r="54" fill="${palette.sun}"/><path d="M70,250 Q135,215 200,250 T330,250 L330,300 Q200,360 70,300 Z" fill="${palette.sea}"/>`
			: `<circle cx="200" cy="200" r="150" fill="${palette.deep}"/><path d="M200,90 C270,90 300,160 200,270 C100,160 130,90 200,90 Z" fill="${palette.sea}"/><rect x="190" y="230" width="20" height="90" fill="${palette.sun}"/>`;
	return svg(400, 400, mark);
}

export function hero(palette: Palette, motif: "harbour" | "linden"): string {
	const scene = sceneFor(motif);
	return svg(1600, 700, scene(palette, 0, 0, 1600, 700));
}

export async function writeArtwork(directory: string, name: string, content: string): Promise<string> {
	mkdirSync(directory, { recursive: true });
	const source = join(directory, `${name}.svg`);
	const png = join(directory, `${name}.png`);
	const webp = join(directory, `${name}.webp`);
	await Bun.write(source, content);
	const render = Bun.spawnSync(["rsvg-convert", "-o", png, source]);
	if (render.exitCode !== 0) throw new Error(`rsvg-convert failed for ${name}: ${render.stderr.toString()}`);
	const encode = Bun.spawnSync(["cwebp", "-quiet", "-q", "86", png, "-o", webp]);
	if (encode.exitCode !== 0) throw new Error(`cwebp failed for ${name}: ${encode.stderr.toString()}`);
	return webp;
}
