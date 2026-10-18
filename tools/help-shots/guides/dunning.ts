import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectApi, projectPath } from "../actions";
import { DEMOS, type Session } from "../demo";
import type { Guide } from "../run";
import type { Studio } from "../studio";
import { createInvoice, pay } from "./invoices";
import { slovenianSession } from "./slovenia";

const PAGE = "dunning";
const CONTENT = ".project-content";
const FILES = join(tmpdir(), "rabbitpay-help-shots-files", "dunning");
const DAY = 24 * 60 * 60 * 1000;

const OLD_INVOICE = { reference: "2024-117", issued: 700, due: 670, amount: "500", open: "200" };

function local(session: Session): Session {
	return slovenianSession(session);
}

function customer(session: Session): string {
	return local(session).customers![0]!;
}

function backdate(studio: Studio, invoice: string, issuedDaysAgo: number) {
	const database = new Database(studio.database);
	database.run("PRAGMA busy_timeout = 10000");
	database.query("UPDATE invoices SET issued_at = ? WHERE uuid = ?").run(Date.now() - issuedDaysAgo * DAY, invoice);
	database.close();
}

function localDate(daysAgo: number): string {
	return new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);
}

async function prepare(studio: Studio, session: Session) {
	const scoped = local(session);
	await studio.open(projectPath(scoped), 800);
	const processors = await projectApi<{ processor: string; enabled: boolean }[]>(studio, scoped, "GET", "/processors");
	if (!processors.find((entry) => entry.processor === "bank_transfer")?.enabled) {
		await projectApi(studio, scoped, "PUT", "/processors/bank_transfer", {
			enabled: true,
			config: { iban: DEMOS.sl.iban, bic: DEMOS.sl.bic, bank_name: DEMOS.sl.bank, account_holder: scoped.demo.company.legalName },
		});
	}
	const late = [
		{ customer: 0, lines: [{ item: 0, quantity: 1 }], issued: 125, due: -95, paid: 0 },
		{ customer: 0, lines: [{ item: 1, quantity: 10 }], issued: 70, due: -40, paid: 0.5 },
		{ customer: 0, lines: [{ item: 2, quantity: 1 }], issued: 42, due: -12, paid: 0 },
		{ customer: 1, lines: [{ item: 1, quantity: 6 }], issued: 50, due: -20, paid: 0 },
	];
	for (const entry of late) {
		const invoice = await createInvoice(studio, scoped, scoped.customers![entry.customer]!, entry.lines, { due: entry.due });
		backdate(studio, invoice.uuid, entry.issued);
		if (entry.paid > 0) await pay(studio, scoped, invoice.uuid, Math.round(invoice.total_amount * entry.paid), "SEPA 5120");
	}
}

async function overview(studio: Studio, session: Session) {
	const { browser } = studio;
	await studio.open(projectPath(local(session), "/dunning"), 1200);
	await studio.shot(PAGE, "overview", { target: CONTENT, mark: `button:${studio.t("dunning.send_first")}` });
	await browser.click(`button:${studio.t("dunning.new")}`, 500);
	await studio.shot(PAGE, "pick-customer", { target: ".overlay .dialog" });
	await browser.press("Escape", 27);
}

async function documents(studio: Studio, session: Session) {
	const { browser } = studio;
	await studio.open(projectPath(local(session), `/dunning/new?customer=${customer(session)}`), 1200);
	await studio.shot(PAGE, "documents", { target: `card:${studio.t("dunning.documents_title")}` });

	await browser.click(`button:${studio.t("dunning.manual_open_dialog")}`, 500);
	await browser.fill(`field:${studio.t("dunning.manual_reference")}`, OLD_INVOICE.reference);
	await browser.eval(
		`(() => { const set = (label, value) => { const field = [...document.querySelectorAll(".overlay label.field")].find((node) => node.querySelector(".field-label").textContent === label).querySelector("input"); field.value = value; field.dispatchEvent(new Event("input", { bubbles: true })); }; set(${JSON.stringify(studio.t("dunning.manual_issued"))}, "${localDate(OLD_INVOICE.issued)}"); set(${JSON.stringify(studio.t("dunning.manual_due"))}, "${localDate(OLD_INVOICE.due)}"); set(${JSON.stringify(studio.t("dunning.manual_amount", { currency: "EUR" }))}, "${OLD_INVOICE.amount}"); set(${JSON.stringify(studio.t("dunning.manual_open", { currency: "EUR" }))}, "${OLD_INVOICE.open}"); })()`
	);
	await browser.blur();
	await studio.shot(PAGE, "manual", { target: ".overlay .dialog" });
	await browser.click(`.overlay >> button:${studio.t("dunning.manual_add")}`, 500);
	await studio.shot(PAGE, "documents-manual", { target: `card:${studio.t("dunning.documents_title")}`, mark: `text:${OLD_INVOICE.reference}` });

	await browser.click(`switch:${studio.t("dunning.interest_switch")}`, 300);
	await browser.click(`switch:${studio.t("dunning.compensation_switch")}`, 300);
	await studio.shot(PAGE, "options", { target: `card:${studio.t("dunning.letter_title")}` });
	await studio.shot(PAGE, "summary", { target: `card:${studio.t("dunning.summary_title")}` });

	await browser.click(`button:${studio.t("dunning.issue")}`, 500);
	await browser.click(`.overlay >> button:${studio.t("dunning.issue")}`, 2000);
	await browser.waitFor(".overlay .dialog");
	await studio.shot(PAGE, "email", { target: ".overlay .dialog" });
	await browser.click(`.overlay >> button:${studio.t("dunning.email_send")}`, 2000);
}

async function letter(studio: Studio, session: Session) {
	const scoped = local(session);
	const { letters } = await projectApi<{ letters: { uuid: string }[] }>(studio, scoped, "GET", "/dunning");
	const latest = letters[0]!.uuid;
	await studio.open(projectPath(scoped, `/dunning/${latest}`), 1500);
	await studio.shot(PAGE, "letter", { target: CONTENT });

	mkdirSync(FILES, { recursive: true });
	const pdf = join(FILES, `${studio.language}.pdf`);
	const encoded = await studio.browser.eval<string>(
		`fetch("/api/v1/projects/${scoped.project}/dunning/${latest}/pdf", { headers: { Authorization: "Bearer " + localStorage.getItem("rabbitpay.token") } }).then((response) => response.arrayBuffer()).then((buffer) => { const bytes = new Uint8Array(buffer); let text = ""; for (let index = 0; index < bytes.length; index += 8192) text += String.fromCharCode(...bytes.subarray(index, index + 8192)); return btoa(text); })`
	);
	await Bun.write(pdf, Buffer.from(encoded, "base64"));
	const prefix = join(FILES, studio.language);
	const converted = Bun.spawnSync(["pdftoppm", "-r", "110", "-png", "-f", "1", "-l", "1", "-singlefile", pdf, prefix]);
	if (converted.exitCode !== 0)
		throw new Error(`pdftoppm could not turn the dunning letter into an image. Install poppler-utils. ${converted.stderr.toString()}`);
	const image = Buffer.from(await Bun.file(`${prefix}.png`).arrayBuffer()).toString("base64");
	await studio.browser.eval(
		`(() => { document.open(); document.write('<!doctype html><html><body style="margin:0;background:#d9dde3"><div id="sheet" style="display:inline-block;padding:28px"><img src="data:image/png;base64,${image}" style="display:block;width:760px;box-shadow:0 2px 14px rgba(0,0,0,0.25)"></div></body></html>'); document.close(); })()`
	);
	await studio.browser.wait(600);
	await studio.shot(PAGE, "pdf", { target: "#sheet", padding: 0 });
}

async function next(studio: Studio, session: Session) {
	await studio.open(projectPath(local(session), "/dunning"), 1200);
	await studio.shot(PAGE, "next-level", {
		target: `card:${studio.t("dunning.debtors_title")}`,
		mark: `button:${studio.t("dunning.send_second")}`,
	});
}

function passDeadline(studio: Studio, letter: string) {
	const database = new Database(studio.database);
	database.run("PRAGMA busy_timeout = 10000");
	database.query("UPDATE dunning_letters SET issue_date = ?, deadline_date = ? WHERE uuid = ?").run(localDate(12), localDate(4), letter);
	database.close();
}

async function enforcement(studio: Studio, session: Session) {
	const { browser } = studio;
	const scoped = local(session);
	const candidates = await projectApi<{ invoices: { uuid: string }[] }>(studio, scoped, "GET", `/dunning/candidates?customer=${customer(session)}`);
	const final = await projectApi<{ uuid: string }>(studio, scoped, "POST", "/dunning", {
		customer: customer(session),
		level: 3,
		invoices: candidates.invoices.map((invoice) => invoice.uuid),
		interest: true,
		compensation: true,
	});
	passDeadline(studio, final.uuid);

	await studio.open(projectPath(scoped, `/dunning/${final.uuid}`), 1500);
	await studio.shot(PAGE, "enforcement-next", {
		target: `card:${studio.t("enforcement.next_step")}`,
		mark: `button:${studio.t("enforcement.prepare")}`,
	});

	await browser.click(`button:${studio.t("enforcement.prepare")}`, 1500);
	await browser.waitFor(`card:${studio.t("enforcement.claims_title")}`);
	await studio.shot(PAGE, "enforcement-claims", { target: `card:${studio.t("enforcement.claims_title")}` });
	await studio.shot(PAGE, "enforcement-options", { target: `card:${studio.t("enforcement.options_title")}` });
	await studio.shot(PAGE, "enforcement-summary", {
		target: `card:${studio.t("enforcement.summary_title")}`,
		mark: `button:${studio.t("enforcement.create")}`,
	});

	await browser.click(`button:${studio.t("enforcement.create")}`, 500);
	await browser.click(`.overlay >> button:${studio.t("enforcement.create")}`, 2000);
	await browser.waitFor(`card:${studio.t("enforcement.steps_title")}`);
	await studio.shot(PAGE, "enforcement-proposal", { target: CONTENT, mark: `button:${studio.t("enforcement.download_xml")}` });

	await browser.click(`button:${studio.t("enforcement.filing_mark")}`, 500);
	await browser.fill(`field:${studio.t("enforcement.court_case")}`, "VL 48211/2026");
	await browser.blur();
	await studio.shot(PAGE, "enforcement-filing", { target: ".overlay .dialog" });
	await browser.click(`.overlay >> button:${studio.t("enforcement.filing_save")}`, 1500);

	await studio.open(projectPath(scoped, "/dunning"), 1200);
	await studio.shot(PAGE, "enforcement-list", { target: `card:${studio.t("enforcement.list_title")}` });
}

export const dunning: Guide = {
	module: "dunning",
	help: "invoices",
	steps: [
		["prepare", prepare],
		["overview", overview],
		["documents", documents],
		["letter", letter],
		["next", next],
		["enforcement", enforcement],
	],
};
