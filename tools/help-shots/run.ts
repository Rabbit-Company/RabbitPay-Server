import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { UiLanguage } from "../../web/src/i18n/dictionary";
import { HELP_SHOTS } from "../../server/help-shots";
import { Browser } from "./browser";
import { signIn } from "./actions";
import { DEMOS, type Session } from "./demo";
import { startScratchServer } from "./scratch-server";
import { startMailSink } from "./mail-sink";
import { prepareServer } from "./setup";
import { Studio, type ShotRecord } from "./studio";
import { gettingStarted } from "./guides/getting-started";

export type Step = (studio: Studio, session: Session) => Promise<void>;

export interface Guide {
	module: string;
	steps: [name: string, run: Step][];
}

const GUIDES: Guide[] = [gettingStarted];
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

const mail = startMailSink(port + 1000);
const server = await startScratchServer(work, port, mail.port, !reuse);
const browser = await Browser.launch();
const shots = new Map<string, ShotRecord>();

try {
	if (!reuse) await prepareServer(server);
	for (const language of languages) {
		const saved = Bun.file(resolve(work, `session-${language}.json`));
		const session: Session = reuse && (await saved.exists()) ? await saved.json() : { demo: DEMOS[language], totpSecret: null, project: null };
		await browser.viewport(1120, 760);
		await browser.theme("dark");
		await browser.send("Emulation.setLocaleOverride", { locale: DEMOS[language].locale });
		await browser.send("Emulation.setTimezoneOverride", { timezoneId: DEMOS[language].timezone });
		await browser.goto(`${server.base}/login`);
		await browser.eval(`(() => { localStorage.clear(); localStorage.setItem("rabbitpay.language", "${language}"); })()`);
		for (const guide of GUIDES) {
			const studio = new Studio(browser, server.base, out, language, guide.module, mail.messages);
			if (reuse) await signIn(studio, session);
			for (const [name, run] of guide.steps) {
				if (only.length > 0 && !only.includes(name) && !only.includes(`${guide.module}/${name}`)) continue;
				console.log(`${language} | ${guide.module} | ${name}`);
				await run(studio, session);
				await Bun.write(saved, JSON.stringify(session, null, "\t"));
			}
			for (const [key, shot] of studio.shots) shots.set(key, shot);
		}
	}
	await writeManifest(shots);
	console.log(`Saved ${shots.size * 2} images under ${out}`);
} finally {
	await browser.close();
	mail.stop();
	if (process.argv.includes("--keep")) console.log(`Scratch server still running on ${server.base}, database ${server.database}`);
	else await server.stop();
}
process.exit(0);
