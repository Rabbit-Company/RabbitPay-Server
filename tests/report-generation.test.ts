import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { unlinkSync } from "node:fs";
import { prepareTest } from "./environment";

const databasePath = `${import.meta.dir}/.report-generation.sqlite`;
await prepareTest(`sqlite://${databasePath}`);
const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { MemoryAdapter } = await import("../server/cache/adapters/memory.adapter");
const { default: Auth } = await import("../server/auth");
const { Settings, updateSettings } = await import("../server/settings");
const { generateReport, savedReport } = await import("../server/report-service");
const { ErrorCode } = await import("../server/errors");
await Server.configure();

let owner = "";
let viewer = "";
let outsider = "";
let sequence = 0;
const from = Date.UTC(2025, 0, 1);
const to = Date.UTC(2026, 0, 1) - 1;

async function call(method: string, path: string, body?: unknown, token = owner) {
	const response = await Server.app.handle(
		new Request(`http://localhost${path}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	);
	return { status: response.status, headers: response.headers, ...((await response.json()) as { error: number; data: any }) };
}

async function account(name: string) {
	const password = new Bun.CryptoHasher("blake2b512").update(name).digest("hex");
	await call("POST", "/api/v1/auth/register", { username: name, email: `${name}@example.com`, password });
	return (await call("POST", "/api/v1/auth/login", { username: name, password })).data.token as string;
}

async function project() {
	return (await call("POST", "/api/v1/projects", { name: `report-test-${++sequence}`, currency: "EUR" })).data.uuid as string;
}

beforeAll(async () => {
	await initialize();
	await Cache.initialize();
	owner = await account("report-owner");
	viewer = await account("report-viewer");
	outsider = await account("report-outsider");
});

beforeEach(async () => {
	await updateSettings({ "reports.cooldown_minutes": 10 });
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-wal", "-shm"]) {
		try {
			unlinkSync(databasePath + suffix);
		} catch {
			void 0;
		}
	}
});

describe("explicit report generation", () => {
	test("reading each new report leaves its snapshot empty", async () => {
		const uuid = await project();
		for (const path of ["reports/financial", "reports/vat", "items/stats"]) {
			const result = await call("GET", `/api/v1/projects/${uuid}/${path}`);
			expect(result.status).toBe(200);
			expect(result.data.report).toBeNull();
			expect(result.data.generating).toBe(false);
		}
		const [row] = await Database`SELECT COUNT(*) AS total FROM report_snapshots WHERE project = ${uuid}`;
		expect(row.total).toBe(0);
	});

	test("all report types require generation and carry generation times", async () => {
		const uuid = await project();
		for (const path of ["reports/financial", "reports/vat", "items/stats"]) {
			const generated = await call("POST", `/api/v1/projects/${uuid}/${path}?from=${from}&to=${to}`);
			expect(generated.status).toBe(200);
			expect(generated.data.generated_at).toBeGreaterThan(0);
			expect(generated.data.next_generation_at - generated.data.generated_at).toBe(600000);
			const read = await call("GET", `/api/v1/projects/${uuid}/${path}`);
			expect(read.data.report).toEqual(generated.data);
			expect(read.data.generating).toBe(false);
		}
	});

	test("another user and different filters cannot bypass the cooldown", async () => {
		const uuid = await project();
		await call("POST", `/api/v1/projects/${uuid}/members`, { email: "report-viewer@example.com", role: "viewer" });
		for (const path of ["reports/financial", "reports/vat", "items/stats"]) {
			const initial = await call("POST", `/api/v1/projects/${uuid}/${path}?from=${from}&to=${to}`);
			const repeated = await call("POST", `/api/v1/projects/${uuid}/${path}?from=0&group=year`, undefined, viewer);
			expect(repeated.status).toBe(429);
			expect(repeated.error).toBe(ErrorCode.REPORT_COOLDOWN);
			expect(repeated.data.report).toEqual(initial.data);
			expect(Number(repeated.headers.get("Retry-After"))).toBeGreaterThan(0);
			const read = await call("GET", `/api/v1/projects/${uuid}/${path}?from=0`, undefined, viewer);
			expect(read.data.report.from).toBe(from);
			expect(read.data.report.generated_at).toBe(initial.data.generated_at);
		}
	});

	test("companies have independent cooldowns and report snapshots", async () => {
		const first = await project();
		const second = await project();
		await generateReport(first, "financial", async () => ({ amount: 10 }));
		await generateReport(second, "financial", async () => ({ amount: 20 }));
		expect((await savedReport<{ amount: number }>(first, "financial")).report?.amount).toBe(10);
		expect((await savedReport<{ amount: number }>(second, "financial")).report?.amount).toBe(20);
	});

	test("saved results do not change when expenses change", async () => {
		const uuid = await project();
		const path = `/api/v1/projects/${uuid}`;
		await call("POST", `${path}/expenses`, { description: "Hosting", category: "Hosting", currency: "EUR", total_amount: 10000, expense_date: from });
		const generated = await call("POST", `${path}/reports/financial?from=${from}&to=${to}`);
		await call("POST", `${path}/expenses`, { description: "Rent", category: "Rent", currency: "EUR", total_amount: 25000, expense_date: from });
		const read = await call("GET", `${path}/reports/financial`);
		expect(read.data.report.totals[0].expenses).toBe(10000);
		expect(read.data.report.generated_at).toBe(generated.data.generated_at);
		const exportResponse = await Server.app.handle(
			new Request(`http://localhost${path}/reports/financial/export`, { headers: { Authorization: `Bearer ${owner}` } })
		);
		expect(exportResponse.status).toBe(200);
		const csv = await exportResponse.text();
		expect(csv).toContain("2025-01,EUR,0,10000");
		expect(csv).not.toContain("35000");
		expect((await savedReport(uuid, "financial")).report?.generated_at).toBe(generated.data.generated_at);
	});

	test("financial export cannot trigger initial generation", async () => {
		const uuid = await project();
		const result = await call("GET", `/api/v1/projects/${uuid}/reports/financial/export`);
		expect(result.status).toBe(409);
		expect(result.error).toBe(ErrorCode.REPORT_NOT_GENERATED);
		expect((await savedReport(uuid, "financial")).report).toBeNull();
	});

	test("snapshot reads and generation keep project authorization", async () => {
		const uuid = await project();
		await generateReport(uuid, "financial", async () => ({ confidential: true }));
		for (const method of ["GET", "POST"]) {
			for (const path of ["reports/financial", "reports/vat", "items/stats"]) {
				const result = await call(method, `/api/v1/projects/${uuid}/${path}`, undefined, outsider);
				expect(result.status).toBe(403);
				expect(result.data).toBeUndefined();
			}
		}
		await call("POST", `/api/v1/projects/${uuid}/members`, { email: "report-viewer@example.com", role: "cashier" });
		expect((await call("GET", `/api/v1/projects/${uuid}/reports/financial`, undefined, viewer)).status).toBe(403);
		expect((await call("POST", `/api/v1/projects/${uuid}/reports/financial`, undefined, viewer)).status).toBe(403);
	});

	test("invalid periods do not create a claim or start a cooldown", async () => {
		const uuid = await project();
		for (const path of ["reports/financial", "reports/vat", "items/stats"]) {
			expect((await call("POST", `/api/v1/projects/${uuid}/${path}?from=20&to=10`)).status).toBe(400);
		}
		const [row] = await Database`SELECT COUNT(*) AS total FROM report_snapshots WHERE project = ${uuid}`;
		expect(row.total).toBe(0);
		expect((await call("POST", `/api/v1/projects/${uuid}/reports/financial`)).status).toBe(200);
	});
});

describe("durable report claims", () => {
	test("concurrent generators only calculate once", async () => {
		const uuid = await project();
		let started!: () => void;
		let finish!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const wait = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let calls = 0;
		const pending = generateReport(uuid, "financial", async () => {
			calls++;
			started();
			await wait;
			return { amount: 1 };
		});
		await ready;
		expect((await savedReport(uuid, "financial")).generating).toBe(true);
		try {
			await expect(
				generateReport(uuid, "financial", async () => {
					calls++;
					return { amount: 2 };
				})
			).rejects.toMatchObject({ code: ErrorCode.REPORT_GENERATING });
			expect(calls).toBe(1);
		} finally {
			finish();
		}
		await pending;
		expect((await savedReport<{ amount: number }>(uuid, "financial")).report?.amount).toBe(1);
	});

	test("a claim from a separate database connection prevents generation", async () => {
		const uuid = await project();
		const separate = new SQL(`sqlite://${databasePath}`);
		try {
			await separate`INSERT INTO report_snapshots(project, kind, claim_token, claimed_at) VALUES(${uuid}, 'financial', 'another-worker', ${Date.now()})`;
			let called = false;
			await expect(
				generateReport(uuid, "financial", async () => {
					called = true;
					return {};
				})
			).rejects.toMatchObject({ code: ErrorCode.REPORT_GENERATING });
			expect(called).toBe(false);
			await separate`UPDATE report_snapshots SET claim_token = NULL, claimed_at = NULL WHERE project = ${uuid}`;
			expect((await generateReport(uuid, "financial", async () => ({ amount: 3 }))).amount).toBe(3);
			const [persisted] = await separate`SELECT data, generated_at FROM report_snapshots WHERE project = ${uuid}`;
			expect(JSON.parse(persisted.data).amount).toBe(3);
			expect(persisted.generated_at).toBeGreaterThan(0);
		} finally {
			await separate.close();
		}
	});

	test("failed regeneration preserves the previous report and releases its claim", async () => {
		const uuid = await project();
		await updateSettings({ "reports.cooldown_minutes": 0 });
		const original = await generateReport(uuid, "vat", async () => ({ amount: 1 }));
		await expect(
			generateReport(uuid, "vat", async () => {
				throw new Error("Calculation failed");
			})
		).rejects.toThrow("Calculation failed");
		const state = await savedReport<{ amount: number }>(uuid, "vat");
		expect(state.report?.amount).toBe(1);
		expect(state.report?.generated_at).toBe(original.generated_at);
		expect(state.generating).toBe(false);
		expect((await generateReport(uuid, "vat", async () => ({ amount: 2 }))).amount).toBe(2);
	});

	test("failed initial generation does not impose a cooldown", async () => {
		const uuid = await project();
		await expect(
			generateReport(uuid, "items", async () => {
				throw new Error("Unavailable");
			})
		).rejects.toThrow("Unavailable");
		expect((await savedReport(uuid, "items")).report).toBeNull();
		expect((await generateReport(uuid, "items", async () => ({ amount: 2 }))).amount).toBe(2);
	});

	test("expired claims can be recovered after a worker stops", async () => {
		const uuid = await project();
		await Database`INSERT INTO report_snapshots(project, kind, claim_token, claimed_at) VALUES(${uuid}, 'financial', 'stopped-worker', ${Date.now() - 3600001})`;
		expect((await savedReport(uuid, "financial")).generating).toBe(false);
		expect((await generateReport(uuid, "financial", async () => ({ recovered: true }))).recovered).toBe(true);
	});

	test("a generator that loses its claim cannot overwrite another worker", async () => {
		const uuid = await project();
		await expect(
			generateReport(uuid, "financial", async () => {
				await Database`UPDATE report_snapshots SET claim_token = 'replacement-worker' WHERE project = ${uuid}`;
				return { amount: 1 };
			})
		).rejects.toMatchObject({ code: ErrorCode.REPORT_GENERATING });
		const [row] = await Database`SELECT data, claim_token FROM report_snapshots WHERE project = ${uuid}`;
		expect(row.data).toBeNull();
		expect(row.claim_token).toBe("replacement-worker");
	});

	test("snapshots and cooldowns survive replacement of application caches", async () => {
		const uuid = await project();
		const generated = await call("POST", `/api/v1/projects/${uuid}/reports/financial`);
		Cache.local.adapter = new MemoryAdapter("restarted-local");
		Cache.external.adapter = new MemoryAdapter("restarted-shared");
		owner = (await Auth.createSession("report-owner", "127.0.0.1"))!;
		viewer = (await Auth.createSession("report-viewer", "127.0.0.1"))!;
		outsider = (await Auth.createSession("report-outsider", "127.0.0.1"))!;
		const read = await call("GET", `/api/v1/projects/${uuid}/reports/financial`);
		expect(read.data.report.generated_at).toBe(generated.data.generated_at);
		expect((await call("POST", `/api/v1/projects/${uuid}/reports/financial`)).status).toBe(429);
	});

	test("the exact cooldown boundary permits regeneration", async () => {
		const uuid = await project();
		const clock = spyOn(Date, "now");
		try {
			clock.mockReturnValue(1800000000000);
			const initial = await generateReport(uuid, "items", async () => ({ version: 1 }));
			clock.mockReturnValue(initial.generated_at + 599999);
			await expect(generateReport(uuid, "items", async () => ({ version: 2 }))).rejects.toMatchObject({ code: ErrorCode.REPORT_COOLDOWN });
			clock.mockReturnValue(initial.generated_at + 600000);
			expect((await generateReport(uuid, "items", async () => ({ version: 2 }))).version).toBe(2);
		} finally {
			clock.mockRestore();
		}
	});
});

describe("instance report settings", () => {
	test("defaults to ten minutes and is exposed in admin settings", async () => {
		expect(Settings.reports.cooldown_minutes).toBe(10);
		const result = await call("GET", "/api/v1/admin/settings");
		expect(result.data.values["reports.cooldown_minutes"]).toBe(10);
	});

	test("only an instance administrator can change the cooldown", async () => {
		expect((await call("PATCH", "/api/v1/admin/settings", { values: { "reports.cooldown_minutes": 20 } }, viewer)).status).toBe(403);
		const result = await call("PATCH", "/api/v1/admin/settings", { values: { "reports.cooldown_minutes": 20 } });
		expect(result.status).toBe(200);
		expect(result.data.values["reports.cooldown_minutes"]).toBe(20);
		expect(result.data.restart_required).toEqual([]);
	});

	test("changing the setting updates existing snapshots and enforcement", async () => {
		const uuid = await project();
		const initial = await generateReport(uuid, "financial", async () => ({ version: 1 }));
		await updateSettings({ "reports.cooldown_minutes": 20 });
		expect((await savedReport(uuid, "financial")).next_generation_at).toBe(initial.generated_at + 1200000);
		await expect(generateReport(uuid, "financial", async () => ({ version: 2 }))).rejects.toMatchObject({ code: ErrorCode.REPORT_COOLDOWN });
		await updateSettings({ "reports.cooldown_minutes": 0 });
		expect((await generateReport(uuid, "financial", async () => ({ version: 2 }))).version).toBe(2);
	});

	test("rejects invalid cooldown settings", async () => {
		for (const value of [-1, 1441, "invalid", true]) {
			expect((await call("PATCH", "/api/v1/admin/settings", { values: { "reports.cooldown_minutes": value } })).status).toBe(400);
		}
		expect(Settings.reports.cooldown_minutes).toBe(10);
	});
});
