import { bearerAuth } from "@rabbit-company/web-middleware/bearer-auth";
import { Server } from "../server";
import { Registry } from "@rabbit-company/openmetrics-client";
import { Settings } from "../settings";
import Utils from "../utils";
import { Error } from "../errors";
import Cache from "../cache";
import { secureEquals } from "../apikey";

Server.app.use(
	"GET",
	"/metrics",
	bearerAuth({
		skip() {
			return Settings.metrics.method <= 0 || Settings.metrics.token === "none";
		},
		validate(token) {
			return secureEquals(Settings.metrics.token, token);
		},
	})
);

Server.app.get("/metrics", async (ctx) => {
	if (Settings.metrics.method <= 0) return Utils.jsonError(Error.INVALID_ENDPOINT);

	return ctx.text(await Cache.getString(`metrics_cache`), 200, { "Content-Type": Registry.contentType });
});
