import { beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { prepareTest } from "./environment";

process.env.RABBITPAY_RENDER_WORKERS = "2";
await prepareTest();

const { initialize } = await import("../server/database/database");
const { default: RenderPool } = await import("../server/render-pool");
const { previewDocument } = await import("../server/invoice-preview");
const { DEFAULT_INVOICE_DESIGN } = await import("../server/invoice-design");
const { renderInvoicePdf, renderCreditNotePdf } = await import("../server/invoice-pdf");
import type { ProjectRow } from "../server/database/models";

const project = {
	uuid: crypto.randomUUID(),
	name: "Render d.o.o.",
	display_name: null,
	language: "sl",
	vat_status: "registered",
	tax_country: "SI",
	currency: "EUR",
	date_format: "DD.MM.YYYY",
	time_format: "24h",
	timezone: "Europe/Ljubljana",
	logo_updated: null,
} as unknown as ProjectRow;

function isPdf(data: Uint8Array): boolean {
	const text = new TextDecoder("latin1").decode(data);
	return text.startsWith("%PDF-") && text.trimEnd().endsWith("%%EOF");
}

beforeAll(async () => {
	await initialize();
});

describe("render worker", () => {
	test("imports no database, settings or wallet code", async () => {
		const build = await Bun.build({ entrypoints: [`${import.meta.dir}/../server/render-worker.ts`], target: "bun", metafile: true });
		expect(build.success).toBe(true);
		const inputs = Object.keys(build.metafile!.inputs);
		expect(inputs.some((input) => input.endsWith("render-worker.ts"))).toBe(true);
		const forbidden = inputs.filter((input) =>
			/server\/(database|settings|logger|branding|company|crypto|payments\/methods)|node_modules\/(ethereumjs|bip32|bitcoinjs|tiny-secp256k1|nodemailer)/.test(
				input
			)
		);
		expect(forbidden).toEqual([]);
	});
});

describe("render pool", () => {
	test("renders more documents than it has workers", async () => {
		expect(RenderPool.workers()).toBe(2);
		const invoice = await previewDocument(project, DEFAULT_INVOICE_DESIGN, "invoice");
		const note = await previewDocument(project, DEFAULT_INVOICE_DESIGN, "credit_note");
		if (invoice.kind === "credit_note" || note.kind !== "credit_note") throw new Error("Unexpected preview kinds");

		const results = await Promise.all(
			Array.from({ length: 6 }, (_, index) =>
				index % 2 === 0 ? renderInvoicePdf(invoice.document, null, { payLink: true }) : renderCreditNotePdf(note.document, null)
			)
		);
		expect(results.every(isPdf)).toBe(true);
		expect(RenderPool.waiting()).toBe(0);
	});

	test("starts its workers inside the compiled server binary", async () => {
		const root = `${import.meta.dir}/..`;
		const scratch = `${import.meta.dir}/.render-binary`;
		const script = ((await Bun.file(`${root}/package.json`).json()) as { scripts: { build: string } }).scripts.build;
		expect(script).toContain("server/index.ts");
		await Bun.write(
			`${root}/server/.render-probe.ts`,
			`import RenderPool from "./render-pool";
RenderPool.render({ kind: "invoice", document: {} as never, logo: null, payLink: false }).then(
	() => console.log("rendered"),
	(error) => console.log("rejected:" + error.message)
).finally(() => process.exit(0));
`
		);
		try {
			const command = script.replace("server/index.ts", "server/.render-probe.ts").replace("./rabbitpay-server", `${scratch}/probe`);
			const built = Bun.spawnSync(["sh", "-c", command], { cwd: root, stderr: "pipe" });
			expect(built.exitCode).toBe(0);
			const run = Bun.spawnSync([`${scratch}/probe`], { cwd: "/", env: { ...process.env, RABBITPAY_RENDER_WORKERS: "1" }, stdout: "pipe" });
			const output = run.stdout.toString();
			expect(output).toContain("rejected:");
			expect(output).not.toContain("The render worker failed");
			expect(output).not.toContain("ModuleNotFound");
		} finally {
			rmSync(`${root}/server/.render-probe.ts`, { force: true });
			rmSync(scratch, { recursive: true, force: true });
		}
	}, 60_000);

	test("reports a failed render and keeps working", async () => {
		await expect(RenderPool.render({ kind: "invoice", document: {} as never, logo: null, payLink: false })).rejects.toThrow();
		const invoice = await previewDocument(project, DEFAULT_INVOICE_DESIGN, "receipt");
		if (invoice.kind === "credit_note") throw new Error("Unexpected preview kind");
		expect(isPdf(await renderInvoicePdf(invoice.document, null, { payLink: false }))).toBe(true);
	});
});
