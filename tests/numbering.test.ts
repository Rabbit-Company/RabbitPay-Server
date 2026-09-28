import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.numbering.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { dayKey, draftReference, invoiceNumber, isDraftReference, isInvoiceNumber, nextInvoiceNumber, sequenceOf, MAX_PER_DAY } =
	await import("../server/invoice-numbers");
const { describeInvoiceFormat, parseInvoiceFormat, periodKey, renderInvoiceNumber } = await import("../server/invoice-format");

await Server.configure();

const password = (seed: string) => new Bun.CryptoHasher("blake2b512").update(seed).digest("hex");

interface ApiResponse {
	status: number;
	error: number;
	info: string;
	data?: any;
}

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<ApiResponse> {
	const headers: Record<string, string> = {};
	if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
	if (options.body !== undefined) headers["Content-Type"] = "application/json";

	const res = await Server.app.handle(
		new Request(`http://127.0.0.1${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
	);

	const json = (await res.json()) as { error: number; info: string; data?: unknown };
	return { status: res.status, ...json };
}

let ownerToken = "";
let apiKey = "";
let projectUuid = "";
let otherProjectUuid = "";

const dueDate = () => Date.now() + 7 * 24 * 60 * 60 * 1000;
const item = { description: "Work", quantity: 1, unit_price: 10000, tax_rate: 0 };

async function createDraft(project = projectUuid) {
	const res = await call("POST", `/api/v1/projects/${project}/invoices`, { token: ownerToken, body: { due_date: dueDate(), items: [item] } });
	return res.data;
}

async function issue(invoiceId: string, project = projectUuid) {
	const res = await call("POST", `/api/v1/projects/${project}/invoices/${invoiceId}/open`, { token: ownerToken });
	return res.data;
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();

	await call("POST", "/api/v1/auth/register", { body: { username: "num-owner", email: "num@example.com", password: password("num-owner") } });
	ownerToken = (await call("POST", "/api/v1/auth/login", { body: { username: "num-owner", password: password("num-owner") } })).data.token;

	const project = await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "num-shop", currency: "EUR" } });
	projectUuid = project.data.uuid;
	apiKey = project.data.apikey;

	otherProjectUuid = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "num-other", currency: "EUR" } })).data.uuid;
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.numbering.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("the shape of a number", () => {
	test("is the date followed by six digits", () => {
		expect(invoiceNumber("260916", 1)).toBe("260916000001");
		expect(invoiceNumber("260916", 42)).toBe("260916000042");
		expect(invoiceNumber("260916", MAX_PER_DAY)).toBe("260916999999");
	});

	test("reads the day from the date it was issued", () => {
		expect(dayKey(new Date(2026, 8, 16, 13, 0).getTime())).toBe("260916");
		expect(dayKey(new Date(2026, 0, 1, 0, 0).getTime())).toBe("260101");
		expect(dayKey(new Date(2030, 11, 31, 23, 59).getTime())).toBe("301231");
	});

	test("is always twelve digits", () => {
		expect(invoiceNumber(dayKey(Date.now()), 1)).toHaveLength(12);
		expect(isInvoiceNumber("260916000001")).toBe(true);
		expect(isInvoiceNumber("26091600001")).toBe(false);
		expect(isInvoiceNumber("DRAFT-ABCD")).toBe(false);
	});

	test("can be read back apart", () => {
		expect(sequenceOf("260916000042")).toBe(42);
		expect(sequenceOf("DRAFT-ABCD")).toBeNull();
	});

	test("marks a draft as one", () => {
		const reference = draftReference();
		expect(isDraftReference(reference)).toBe(true);
		expect(isInvoiceNumber(reference)).toBe(false);
	});
});

describe("a draft", () => {
	test("does not take a number, since it is not an invoice yet", async () => {
		const draft = await createDraft();

		expect(draft.status).toBe("draft");
		expect(isDraftReference(draft.reference)).toBe(true);
	});

	test("takes the next number when it is issued", async () => {
		const draft = await createDraft();
		const issued = await issue(draft.uuid);

		expect(issued.status).toBe("open");
		expect(isInvoiceNumber(issued.reference)).toBe(true);
		expect(issued.reference.startsWith(dayKey(Date.now()))).toBe(true);
	});

	test("leaves no gap in the series when it is deleted instead", async () => {
		const first = await issue((await createDraft()).uuid);

		const throwaway = await createDraft();
		await call("DELETE", `/api/v1/projects/${projectUuid}/invoices/${throwaway.uuid}`, { token: ownerToken });

		const second = await issue((await createDraft()).uuid);

		expect(sequenceOf(second.reference)!).toBe(sequenceOf(first.reference)! + 1);
	});
});

describe("the series", () => {
	test("counts up one at a time", async () => {
		const references: string[] = [];
		for (let index = 0; index < 5; index++) references.push((await issue((await createDraft()).uuid)).reference);

		const sequences = references.map((reference) => sequenceOf(reference)!);
		for (let index = 1; index < sequences.length; index++) expect(sequences[index]).toBe(sequences[index - 1] + 1);
	});

	test("is kept apart per project", async () => {
		const mine = await issue((await createDraft()).uuid);

		const theirDraft = await call("POST", `/api/v1/projects/${otherProjectUuid}/invoices`, { token: ownerToken, body: { due_date: dueDate(), items: [item] } });
		const theirs = await issue(theirDraft.data.uuid, otherProjectUuid);

		expect(sequenceOf(theirs.reference)).toBe(1);
		expect(sequenceOf(mine.reference)!).toBeGreaterThan(1);
	});

	test("starts again at one on a new day", async () => {
		const tomorrow = Date.now() + 24 * 60 * 60 * 1000;

		const first = await Database.begin(async (tx) => await nextInvoiceNumber(tx, projectUuid, tomorrow));
		const second = await Database.begin(async (tx) => await nextInvoiceNumber(tx, projectUuid, tomorrow));

		expect(first).toBe(invoiceNumber(dayKey(tomorrow), 1));
		expect(second).toBe(invoiceNumber(dayKey(tomorrow), 2));
	});

	test("gives every invoice its own number when several are issued at once", async () => {
		const created = await Promise.all([...Array(12)].map(() => createDraft()));
		const drafts = created.filter((draft) => draft && draft.uuid);
		expect(drafts).toHaveLength(created.length);

		const issued = await Promise.all(drafts.map((draft) => issue(draft.uuid)));
		const references = issued.map((invoice) => invoice.reference);

		expect(new Set(references).size).toBe(references.length);
		for (const reference of references) expect(isInvoiceNumber(reference)).toBe(true);

		const sequences = references.map((reference) => sequenceOf(reference)!).sort((left, right) => left - right);
		for (let index = 1; index < sequences.length; index++) expect(sequences[index]).toBe(sequences[index - 1] + 1);
	});

	test("refuses to hand out more than the format can hold in a day", async () => {
		const day = dayKey(Date.now());
		await Database`INSERT INTO invoice_sequences(project, day, next_number) VALUES(${otherProjectUuid}, ${day}, ${MAX_PER_DAY + 1})
			ON CONFLICT(project, day) DO UPDATE SET next_number = ${MAX_PER_DAY + 1}`;

		await expect(Database.begin(async (tx) => await nextInvoiceNumber(tx, otherProjectUuid, Date.now()))).rejects.toThrow("exhausted");

		await Database`DELETE FROM invoice_sequences WHERE project = ${otherProjectUuid} AND day = ${day}`;
	});
});

describe("an invoice raised through the machine API", () => {
	test("is numbered straight away when it is issued open", async () => {
		const res = await call("POST", "/api/v1/pay/invoices", {
			token: apiKey,
			body: { due_date: dueDate(), items: [item] },
		});

		expect(res.data.status).toBe("open");
		expect(isInvoiceNumber(res.data.reference)).toBe(true);
	});

	test("stays unnumbered when it asks for a draft", async () => {
		const res = await call("POST", "/api/v1/pay/invoices", {
			token: apiKey,
			body: { due_date: dueDate(), items: [item], status: "draft" },
		});

		expect(res.data.status).toBe("draft");
		expect(isDraftReference(res.data.reference)).toBe(true);
	});
});

describe("the supply date", () => {
	const supplied = new Date(2026, 8, 10, 12, 0).getTime();

	test("is empty unless it is given", async () => {
		const draft = await createDraft();
		expect(draft.supply_date).toBeNull();
	});

	test("is kept when it is given", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { due_date: dueDate(), supply_date: supplied, items: [item] },
		});

		expect(res.data.supply_date).toBe(supplied);
	});

	test("can be set later on a draft", async () => {
		const draft = await createDraft();
		const updated = await call("PATCH", `/api/v1/projects/${projectUuid}/invoices/${draft.uuid}`, { token: ownerToken, body: { supply_date: supplied } });

		expect(updated.data.supply_date).toBe(supplied);
	});

	test("can be cleared again", async () => {
		const draft = await createDraft();
		await call("PATCH", `/api/v1/projects/${projectUuid}/invoices/${draft.uuid}`, { token: ownerToken, body: { supply_date: supplied } });
		const cleared = await call("PATCH", `/api/v1/projects/${projectUuid}/invoices/${draft.uuid}`, { token: ownerToken, body: { supply_date: null } });

		expect(cleared.data.supply_date).toBeNull();
	});

	test("survives an edit that does not mention it", async () => {
		const draft = await createDraft();
		await call("PATCH", `/api/v1/projects/${projectUuid}/invoices/${draft.uuid}`, { token: ownerToken, body: { supply_date: supplied } });
		const edited = await call("PATCH", `/api/v1/projects/${projectUuid}/invoices/${draft.uuid}`, { token: ownerToken, body: { notes: "unrelated" } });

		expect(edited.data.supply_date).toBe(supplied);
	});

	test("is refused when it is not a timestamp", async () => {
		const res = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { due_date: dueDate(), supply_date: "yesterday", items: [item] },
		});

		expect(res.error).toBe(1061);
	});

	test("reaches the printable document", async () => {
		const created = await call("POST", `/api/v1/projects/${projectUuid}/invoices`, {
			token: ownerToken,
			body: { due_date: dueDate(), supply_date: supplied, items: [item] },
		});
		await issue(created.data.uuid);

		const res = await call("GET", `/api/v1/projects/${projectUuid}/invoices/${created.data.uuid}/document`, { token: ownerToken });
		expect(res.data.invoice.supply_date).toBe(supplied);
	});
});

describe("a draft reference", () => {
	test("is made without any server only helper, so the interface can read it too", async () => {
		const source = await Bun.file(`${import.meta.dir}/../server/invoice-numbers.ts`).text();

		expect(source).not.toContain('from "./utils"');
		expect(source).not.toContain("Bun.");
	});

	test("avoids the characters people misread when typing it back", () => {
		const references = [...Array(200)].map(() => draftReference().slice(6));

		for (const suffix of references) {
			expect(suffix).toHaveLength(8);
			expect(suffix).not.toMatch(/[IO01]/);
		}
	});

	test("does not repeat itself", () => {
		const seen = new Set([...Array(500)].map(() => draftReference()));
		expect(seen.size).toBe(500);
	});
});

function parsed(source: string) {
	const result = parseInvoiceFormat(source);
	if (!result.ok) throw new Error(result.error);
	return result.format;
}

describe("a custom number format", () => {
	const september = new Date(2026, 8, 17, 10, 0).getTime();

	test("renders the date parts and pads the number", () => {
		expect(renderInvoiceNumber(parsed("YYMMDDXXXXXX"), september, 2)).toBe("260917000002");
		expect(renderInvoiceNumber(parsed("XXX/YY"), september, 1)).toBe("001/26");
		expect(renderInvoiceNumber(parsed("yyyymmddxxx"), september, 45)).toBe("20260917045");
		expect(renderInvoiceNumber(parsed("INV-YYYY-XXXX"), september, 12)).toBe("INV-2026-0012");
		expect(renderInvoiceNumber(parsed("XXXXX"), september, 7)).toBe("00007");
	});

	test("starts again for the smallest date part it contains", () => {
		expect(parsed("YYMMDDXXX").period).toBe("day");
		expect(parsed("YYYY-MM-XXX").period).toBe("month");
		expect(parsed("XXX/YY").period).toBe("year");
		expect(parsed("R-XXXX").period).toBe("never");

		expect(periodKey(parsed("YYMMDDXXXXXX"), september)).toBe(dayKey(september));
		expect(periodKey(parsed("YYMMXX"), september)).toBe("M202609");
		expect(periodKey(parsed("XXX/YY"), september)).toBe("Y2026");
		expect(periodKey(parsed("XXX/YYYY"), september)).toBe("Y2026");
		expect(periodKey(parsed("XXX"), september)).toBe("ALL");
	});

	test("says how many invoices fit", () => {
		expect(parsed("XXX/YY").capacity).toBe(999);
		expect(describeInvoiceFormat(parsed("XXX/YY"))).toBe("Up to 999 invoices a year. Numbering starts again at 1 on 1 January.");
		expect(describeInvoiceFormat(parsed("YYMMDDXXXXXX"))).toContain("999,999 invoices a day");
	});

	test("refuses formats that cannot work", () => {
		const errors: Record<string, string> = {
			"": "Enter a format",
			YYMMDD: "Add X",
			"XXX/Y": "YY or YYYY",
			"XXX/YYY": "YY or YYYY",
			"MXXX-YY": "MM",
			DDXXX: "month",
			MMXXX: "year",
			"XX-YY-XX": "only appear once",
			"YY-XXX-YY": "only appear once",
			XXXXXXXXXX: "at most 9",
			"XXX YY": "cannot be used",
			"RAČUN-XXX": "cannot be used",
			DRAFTXXX: "DRAFT",
			XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX: "at most 30",
		};
		for (const [format, message] of Object.entries(errors)) {
			const result = parseInvoiceFormat(format);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain(message);
		}
		expect(parseInvoiceFormat(42).ok).toBe(false);
	});
});

describe("choosing a project's number format", () => {
	let numberedProject = "";
	const base = () => `/api/v1/projects/${numberedProject}`;

	beforeAll(async () => {
		numberedProject = (await call("POST", "/api/v1/projects", { token: ownerToken, body: { name: "num-format", currency: "EUR" } })).data.uuid;
	});

	test("defaults to the daily format", async () => {
		const res = await call("GET", `${base()}/invoice-numbering`, { token: ownerToken });
		expect(res.data).toMatchObject({ format: "YYMMDDXXXXXX", period: "day", next_number: 1, capacity: 999999 });
		expect(res.data.next_reference).toBe(invoiceNumber(dayKey(Date.now()), 1));
	});

	test("previews another format without saving it", async () => {
		const res = await call("GET", `${base()}/invoice-numbering?format=${encodeURIComponent("XXX/YY")}`, { token: ownerToken });
		expect(res.data).toMatchObject({ format: "XXX/YY", period: "year", next_number: 1 });
		expect((await call("GET", `${base()}/invoice-numbering?format=XX-DD`, { token: ownerToken })).error).toBe(1106);
		expect((await call("GET", base(), { token: ownerToken })).data.invoice_format).toBe("YYMMDDXXXXXX");
	});

	test("continues a series from where the client left off", async () => {
		const saved = await call("PUT", `${base()}/invoice-numbering`, { token: ownerToken, body: { format: "xxx/yy", next_number: 42 } });
		const year = String(new Date().getFullYear() % 100).padStart(2, "0");
		expect(saved.data).toMatchObject({ format: "XXX/YY", next_number: 42, next_reference: `042/${year}` });

		const first = await issue((await createDraft(numberedProject)).uuid, numberedProject);
		const second = await call("POST", `${base()}/invoices`, {
			token: ownerToken,
			body: { due_date: dueDate(), status: "open", items: [item] },
		});
		expect(first.reference).toBe(`042/${year}`);
		expect(second.data.reference).toBe(`043/${year}`);
	});

	test("skips numbers that were already used when the counter is set back", async () => {
		const year = String(new Date().getFullYear() % 100).padStart(2, "0");
		await call("PUT", `${base()}/invoice-numbering`, { token: ownerToken, body: { next_number: 42 } });
		const third = await issue((await createDraft(numberedProject)).uuid, numberedProject);
		expect(third.reference).toBe(`044/${year}`);
	});

	test("refuses a next number the format cannot hold", async () => {
		const tooBig = await call("PUT", `${base()}/invoice-numbering`, { token: ownerToken, body: { format: "XX/YY", next_number: 100 } });
		expect(tooBig.error).toBe(1106);
		expect(tooBig.info).toContain("1 to 99");
		expect((await call("PUT", `${base()}/invoice-numbering`, { token: ownerToken, body: { next_number: 0 } })).error).toBe(1106);
		expect((await call("PUT", `${base()}/invoice-numbering`, { token: ownerToken, body: { format: "YYMM" } })).error).toBe(1106);
		expect((await call("GET", base(), { token: ownerToken })).data.invoice_format).toBe("XXX/YY");
	});

	test("stops when the period is used up instead of repeating a number", async () => {
		await call("PUT", `${base()}/invoice-numbering`, { token: ownerToken, body: { format: "X-YY", next_number: 9 } });
		const last = await issue((await createDraft(numberedProject)).uuid, numberedProject);
		expect(last.reference).toStartWith("9-");

		const draft = await createDraft(numberedProject);
		const refused = await call("POST", `${base()}/invoices/${draft.uuid}/open`, { token: ownerToken });
		expect(refused.error).toBe(1107);
		expect(refused.status).toBe(409);
		expect(isDraftReference((await call("GET", `${base()}/invoices/${draft.uuid}`, { token: ownerToken })).data.reference)).toBe(true);
	});

	test("gives credit notes the same format with CN in front", async () => {
		await call("PUT", `${base()}/invoice-numbering`, { token: ownerToken, body: { format: "XXX/YY", next_number: 50 } });
		const invoice = await issue((await createDraft(numberedProject)).uuid, numberedProject);
		const note = await call("POST", `${base()}/invoices/${invoice.uuid}/credit-notes`, { token: ownerToken, body: { reason: "Mistake" } });
		const year = String(new Date().getFullYear() % 100).padStart(2, "0");
		expect(note.data.reference).toBe(`CN001/${year}`);
	});

	test("only lets owners and admins change it", async () => {
		await call("POST", "/api/v1/auth/register", { body: { username: "num-viewer", email: "num-viewer@example.com", password: password("num-viewer") } });
		const viewer = (await call("POST", "/api/v1/auth/login", { body: { username: "num-viewer", password: password("num-viewer") } })).data.token;
		await call("POST", `${base()}/members`, { token: ownerToken, body: { email: "num-viewer@example.com", role: "viewer" } });

		expect((await call("GET", `${base()}/invoice-numbering`, { token: viewer })).error).toBe(0);
		expect((await call("PUT", `${base()}/invoice-numbering`, { token: viewer, body: { format: "XXXX" } })).error).toBe(9999);
	});
});
