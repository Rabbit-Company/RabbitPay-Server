import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { UiLanguage } from "../../web/src/i18n/dictionary";
import { HELP_SHOTS } from "../../server/help-shots";
import { Browser } from "./browser";
import { signIn } from "./actions";
import { DEMOS, type Session } from "./demo";
import { startScratchServer } from "./scratch-server";
import { startMailSink } from "./mail-sink";
import { startViesMock } from "./vies-mock";
import { startHelpFurs } from "./furs";
import { prepareServer } from "./setup";
import { Studio, type ShotRecord } from "./studio";
import { gettingStarted } from "./guides/getting-started";
import { invoices } from "./guides/invoices";
import { payments } from "./guides/payments";
import { expenses } from "./guides/expenses";
import { slovenia } from "./guides/slovenia";
import { terminal } from "./guides/terminal";
import { store } from "./guides/store";
import { inventory } from "./guides/inventory";
import { customerPortal } from "./guides/customer-portal";
import { workforce } from "./guides/workforce";
import { chat } from "./guides/chat";
import { calendar } from "./guides/calendar";
import { files } from "./guides/files";

export type Step = (studio: Studio, session: Session) => Promise<void>;

export interface Guide {
	module: string;
	steps: [name: string, run: Step][];
}

const GUIDES: Guide[] = [gettingStarted, invoices, payments, expenses, slovenia, terminal, store, inventory, customerPortal, workforce, chat, calendar, files];
const REPOSITORY = resolve(import.meta.dir, "../..");
const MANIFEST = resolve(REPOSITORY, "server/help-shots.ts");

function option(name: string, fallback: string): string {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

async function writeManifest(shots: Map<string, ShotRecord>) {
	const entries = [...new Map([...Object.entries(HELP_SHOTS), ...shots])].sort(([left], [right]) => left.localeCompare(right));
	const lines = entries.map(([key, [width, height, version]]) => `\t"${key}": [${width}, ${height}, "${version}"],`);
	await Bun.write(
		MANIFEST,
		`export const HELP_SHOTS: Record<string, readonly [width: number, height: number, version: string]> = {\n${lines.join("\n")}\n};\n`
	);
}

const out = resolve(option("out", resolve(REPOSITORY, "cdn")));
const port = Number(option("port", "8096"));
const languages = option("languages", "en,sl").split(",") as UiLanguage[];
const work = resolve(option("work", resolve(tmpdir(), "rabbitpay-help-shots")));
const only = option("steps", "").split(",").filter(Boolean);
const reuse = process.argv.includes("--reuse");
const from = option("from", "");
const to = option("to", "");
const snapshots = resolve(work, "..", "rabbitpay-help-shots-snapshots");

function chosenGuides(): Guide[] {
	const first = from === "" ? 0 : GUIDES.findIndex((guide) => guide.module === from);
	const last = to === "" ? GUIDES.length - 1 : GUIDES.findIndex((guide) => guide.module === to);
	if (first < 0 || last < 0) throw new Error(`Unknown module. Choose from ${GUIDES.map((guide) => guide.module).join(", ")}`);
	return GUIDES.slice(first, last + 1);
}

function copyState(source: string, target: string) {
	mkdirSync(target, { recursive: true });
	for (const name of readdirSync(source)) {
		if (name.startsWith("help-shots.sqlite") || name.startsWith("session-")) cpSync(resolve(source, name), resolve(target, name));
	}
	if (existsSync(resolve(source, "documents"))) cpSync(resolve(source, "documents"), resolve(target, "documents"), { recursive: true });
}

const guides = chosenGuides();
const previous = GUIDES[GUIDES.indexOf(guides[0]) - 1];
const resumed = reuse || previous !== undefined;
if (previous && !reuse) {
	const snapshot = resolve(snapshots, previous.module);
	if (!existsSync(snapshot)) throw new Error(`No snapshot after ${previous.module} yet. Run it once with --to ${previous.module}.`);
	rmSync(work, { recursive: true, force: true });
	copyState(snapshot, work);
}

const mail = startMailSink(port + 1000);
const vies = startViesMock(port + 2000, resolve(work, "help-shots.sqlite"));
const furs = await startHelpFurs(port + 3000, resolve(work, "help-shots.sqlite"));
const services = { mailPort: mail.port, viesPort: vies.port, environment: furs.environment };
let server = await startScratchServer(work, port, services, !resumed);
let browser = await Browser.launch();
const shots = new Map<string, ShotRecord>();

try {
	if (!resumed) await prepareServer(server);
	for (const guide of guides) {
		for (const language of languages) {
			const saved = Bun.file(resolve(work, `session-${language}.json`));
			await browser.close();
			browser = await Browser.launch(9333, DEMOS[language].locale);
			const session: Session = (await saved.exists()) ? await saved.json() : { demo: DEMOS[language], totpSecret: null, project: null };
			session.demo = {
				...DEMOS[language],
				company: { ...DEMOS[language].company, taxNumber: session.demo.company.taxNumber, vatNumber: session.demo.company.vatNumber },
			};
			await browser.viewport(1280, 800);
			await browser.theme("dark");
			await browser.send("Emulation.setLocaleOverride", { locale: DEMOS[language].locale });
			await browser.send("Emulation.setTimezoneOverride", { timezoneId: DEMOS[language].timezone });
			await browser.goto(`${server.base}/login`);
			await browser.eval(`(() => { localStorage.clear(); localStorage.setItem("rabbitpay.language", "${language}"); })()`);
			const studio = new Studio(browser, server.base, out, language, guide.module, mail.messages, server.database, furs);
			if (session.project !== null) await signIn(studio, session);
			for (const [name, run] of guide.steps) {
				if (only.length > 0 && !only.includes(name) && !only.includes(`${guide.module}/${name}`)) continue;
				console.log(`${language} | ${guide.module} | ${name}`);
				await run(studio, session);
				await Bun.write(saved, JSON.stringify(session, null, "\t"));
			}
			for (const [key, shot] of studio.shots) shots.set(key, shot);
		}
		if (only.length === 0 && languages.length === Object.keys(DEMOS).length && server.owned) {
			await server.stop();
			copyState(work, resolve(snapshots, guide.module));
			server = await startScratchServer(work, port, services, false);
		}
	}
	await writeManifest(shots);
	console.log(`Saved ${shots.size * 2} images under ${out}`);
} finally {
	await browser.close();
	mail.stop();
	vies.stop();
	furs.mock.stop();
	if (process.argv.includes("--keep")) console.log(`Scratch server still running on ${server.base}, database ${server.database}`);
	else await server.stop();
}
process.exit(0);
