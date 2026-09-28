import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.metrics.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { updateSettings } = await import("../server/settings");
const { default: TaskMetrics } = await import("../server/tasks/metrics");

await Server.configure();

async function metrics(token?: string): Promise<Response> {
	const headers = token === undefined ? undefined : { Authorization: `Bearer ${token}` };
	return await Server.app.handle(new Request("http://127.0.0.1/metrics", { headers }));
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();
	await TaskMetrics.run();
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${import.meta.dir}/.metrics.sqlite${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("metrics authentication", () => {
	test("leaves metrics open only when the token is none", async () => {
		await updateSettings({ "metrics.method": 2, "metrics.token": "none" });
		expect((await metrics()).status).toBe(200);
	});

	test("requires the configured bearer token when metrics are enabled", async () => {
		await updateSettings({ "metrics.method": 2, "metrics.token": "metrics-test-token" });

		expect((await metrics()).status).toBe(401);
		expect((await metrics("wrong-token")).status).toBe(401);
		expect((await metrics("metrics-test-token")).status).toBe(200);
	});

	test("returns not found without authentication when metrics are disabled", async () => {
		await updateSettings({ "metrics.method": 0, "metrics.token": "metrics-test-token" });
		expect((await metrics()).status).toBe(404);
	});
});
