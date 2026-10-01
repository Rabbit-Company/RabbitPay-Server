import { Server } from "../../server";
import Auth from "../../auth";
import Utils from "../../utils";
import { Settings } from "../../settings";
import { lookupVat, searchRegistry } from "../../registry/lookup";

Server.app.get("/api/v1/registry/companies", Auth.required(), async (ctx) => {
	const query = (ctx.query().get("q") ?? "").trim().slice(0, 120);
	if (Settings.registry?.enabled === false || query.length < 2) return Utils.ok(ctx, { results: [] });
	return Utils.ok(ctx, { results: await searchRegistry(query) });
});

Server.app.get("/api/v1/registry/vat/:number", Auth.required(), async (ctx) => {
	return Utils.ok(ctx, { result: await lookupVat(ctx.params.number.slice(0, 40)) });
});
