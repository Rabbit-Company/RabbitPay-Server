import type { Middleware } from "@rabbit-company/web";
import { ipExtract, IP_EXTRACTION_PRESETS, type IpExtractionPreset } from "@rabbit-company/web-middleware/ip-extract";
import { burrowgateOrigin } from "@rabbit-company/web-middleware/burrowgate";
import { Settings } from "./settings";
import { Logger } from "./logger";
import type { AppState } from "./database/models";

export const UNGUARDED_PATHS = new Set(["/api/health"]);

export function trustedProxies(): string[] {
	return (Settings.server?.trusted_proxies ?? "")
		.split(/[\s,]+/)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function preset(): IpExtractionPreset {
	const configured = Settings.server?.proxy;
	return configured && configured in IP_EXTRACTION_PRESETS ? configured : "direct";
}

export function clientIpMiddleware(): Middleware<AppState> {
	const selected = preset();
	const secret = Settings.server?.burrowgate_secret ?? "";

	if (selected === "burrowgate" && secret !== "") {
		Logger.info("[HS] Client IPs come from signed BurrowGate headers, requests that bypass BurrowGate are rejected");
		return burrowgateOrigin<AppState>({
			secret,
			skip: (ctx) => UNGUARDED_PATHS.has(new URL(ctx.req.url).pathname),
			originUser: (ctx) => ctx.get("account")?.username,
		});
	}

	const proxies = trustedProxies();
	if (selected === "development") Logger.warn("[HS] Client IP source is development, any client can spoof its IP address");
	if ((selected === "nginx" || selected === "burrowgate") && proxies.length === 0) {
		Logger.warn(`[HS] Client IP source is ${selected} without trusted proxies, clients that reach the server directly can spoof their IP address`);
	}

	const config = IP_EXTRACTION_PRESETS[selected];
	return ipExtract<AppState>(proxies.length > 0 && config.trustProxy ? { ...config, trustedProxies: proxies } : config);
}
