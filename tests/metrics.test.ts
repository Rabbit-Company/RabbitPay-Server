import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";

import { prepareTest } from "./environment";
await prepareTest(`sqlite://${import.meta.dir}/.metrics.sqlite`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { updateSettings } = await import("../server/settings");
const { default: TaskMetrics } = await import("../server/tasks/metrics");
const { default: Metrics } = await import("../server/metrics");

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

describe("metrics content", () => {
	async function scrape(): Promise<string> {
		await TaskMetrics.run();
		return await (await metrics("metrics-test-token")).text();
	}

	test("labels request timings with the route pattern and status class", async () => {
		await updateSettings({ "metrics.method": 2, "metrics.token": "metrics-test-token" });
		await Server.app.handle(new Request("http://127.0.0.1/api/v1/projects/0f8e6c1a-route-label/keys"));

		const text = await scrape();
		expect(text).toContain('rabbitpay_http_request_duration_count{method="GET",route="/api/v1/projects/:uuid/keys",status="4xx"}');
		expect(text).not.toContain("0f8e6c1a-route-label");
	});

	test("labels a request without a matched route as other", () => {
		expect(Metrics.routeLabel(undefined)).toBe("other");
		expect(Metrics.routeLabel("/api/v1/projects/:uuid/keys")).toBe("/api/v1/projects/:uuid/keys");
	});

	test("labels a parameter value equal to a path segment by its route pattern", async () => {
		await updateSettings({ "metrics.method": 2 });
		await Server.app.handle(new Request("http://127.0.0.1/api/v1/projects/v1/keys"));

		const text = await scrape();
		expect(text).not.toContain('route="/api/v1/projects/v1/keys"');
		expect(text).toContain('route="/api/v1/projects/:uuid/keys"');
	});

	test("counts database queries made inside a request at the full level", async () => {
		await updateSettings({ "metrics.method": 3 });
		const { usage } = await Metrics.measureRequest(async () => {
			await Database`SELECT 1`;
			await Database`SELECT 2`;
		});
		expect(usage.queries).toBe(2);
		expect(usage.databaseMs).toBeGreaterThan(0);

		const text = await scrape();
		expect(text).toContain("rabbitpay_database_query_duration_count");
		expect(text).toContain('rabbitpay_event_loop_delay{quantile="0.99"}');
	});

	test("skips database timing below the full level", async () => {
		await updateSettings({ "metrics.method": 2 });
		const { usage } = await Metrics.measureRequest(async () => {
			await Database`SELECT 1`;
		});
		expect(usage.queries).toBe(0);
	});
});
