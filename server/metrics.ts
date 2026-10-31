import { AsyncLocalStorage } from "node:async_hooks";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Counter, Gauge, Histogram, Registry } from "@rabbit-company/openmetrics-client";

namespace Metrics {
	export const BASIC = 1;
	export const DETAILED = 2;
	export const FULL = 3;

	export const registry = new Registry({ prefix: "rabbitpay" });

	export const http_requests_total = new Counter({
		name: "http_requests",
		help: "Total HTTP requests",
		labelNames: ["method", "status"] as const,
		registry: registry,
	});

	export const http_request_duration = new Histogram({
		name: "http_request_duration",
		help: "Duration of HTTP requests in milliseconds",
		labelNames: ["method", "route", "status"] as const,
		buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
		registry: registry,
	});

	export const database_query_duration = new Histogram({
		name: "database_query_duration",
		help: "Duration of database queries in milliseconds",
		buckets: [0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
		registry: registry,
	});

	export const database_queries_per_request = new Histogram({
		name: "database_queries_per_request",
		help: "Database queries made while handling one HTTP request",
		labelNames: ["method", "route"] as const,
		buckets: [1, 2, 5, 10, 20, 50, 100, 250, 500],
		registry: registry,
	});

	export const database_time_per_request = new Histogram({
		name: "database_time_per_request",
		help: "Time spent waiting for the database while handling one HTTP request in milliseconds",
		labelNames: ["method", "route"] as const,
		buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
		registry: registry,
	});

	export const event_loop_delay = new Gauge({
		name: "event_loop_delay",
		help: "Event loop delay since the previous metrics refresh in milliseconds",
		labelNames: ["quantile"] as const,
		registry: registry,
	});

	const KNOWN_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

	export function methodLabel(method: string): string {
		return KNOWN_METHODS.has(method) ? method : "OTHER";
	}

	export function statusLabel(status: number): string {
		return `${Math.floor(status / 100)}xx`;
	}

	export function routeLabel(route: string | undefined): string {
		return route ?? "other";
	}

	let currentLevel: () => number = () => 0;

	export function configure(level: () => number) {
		currentLevel = level;
	}

	export function level(): number {
		return currentLevel();
	}

	interface RequestUsage {
		queries: number;
		databaseMs: number;
	}

	const requestUsage = new AsyncLocalStorage<RequestUsage>();

	export async function measureRequest<T>(work: () => Promise<T>): Promise<{ result: T; usage: RequestUsage }> {
		const usage: RequestUsage = { queries: 0, databaseMs: 0 };
		const result = await requestUsage.run(usage, work);
		return { result, usage };
	}

	export function observeQuery(milliseconds: number) {
		if (currentLevel() < FULL) return;
		database_query_duration.observe(milliseconds);
		const usage = requestUsage.getStore();
		if (!usage) return;
		usage.queries++;
		usage.databaseMs += milliseconds;
	}

	const loopDelay = monitorEventLoopDelay({ resolution: 20 });
	let loopDelayEnabled = false;

	export function collectEventLoop() {
		if (!loopDelayEnabled) {
			loopDelay.enable();
			loopDelayEnabled = true;
		} else {
			event_loop_delay.labels({ quantile: "0.5" }).set(loopDelay.percentile(50) / 1e6);
			event_loop_delay.labels({ quantile: "0.99" }).set(loopDelay.percentile(99) / 1e6);
			event_loop_delay.labels({ quantile: "1" }).set(loopDelay.max / 1e6);
			loopDelay.reset();
		}
	}
}

export default Metrics;
