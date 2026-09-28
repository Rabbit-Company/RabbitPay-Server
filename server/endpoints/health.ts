import { Server } from "../server";
import Database from "../database/database";

Server.app.get("/api/health", async (ctx) => {
	if (Server.isStopping()) return ctx.json({ status: "stopping" }, 503);

	try {
		await Database`SELECT 1`;
	} catch {
		return ctx.json({ status: "database_unavailable" }, 503);
	}

	return ctx.json({ status: "ok" }, 200, { "Cache-Control": "no-store" });
});
