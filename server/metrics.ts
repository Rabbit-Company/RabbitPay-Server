import { Counter, Histogram, Registry } from "@rabbit-company/openmetrics-client";

namespace Metrics {
	export const registry = new Registry({ prefix: "rabbitpay" });

	export const http_requests_total = new Counter({
		name: "http_requests",
		help: "Total HTTP requests",
		labelNames: ["method"] as const,
		registry: registry,
	});

	export const http_request_duration = new Histogram({
		name: "http_request_duration",
		help: "Duration of HTTP requests in milliseconds",
		labelNames: ["method"] as const,
		buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
		registry: registry,
	});

	const KNOWN_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

	export function methodLabel(method: string): string {
		return KNOWN_METHODS.has(method) ? method : "OTHER";
	}
}

export default Metrics;
