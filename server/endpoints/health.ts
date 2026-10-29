import { Server } from "../server";
import Database from "../database/database";

const noStore = { "Cache-Control": "no-store" };

async function databaseResponds(): Promise<boolean> {
	try {
		await Database`SELECT 1`;
		return true;
	} catch {
		return false;
	}
}

Server.app.get("/api/health", async (ctx) => {
	if (Server.isStopping()) return ctx.json({ status: "stopping" }, 503, noStore);
	if (!(await databaseResponds())) return ctx.json({ status: "database_unavailable" }, 503, noStore);
	return ctx.json({ status: "ok" }, 200, noStore);
});

Server.app.get("/api/health/server", (ctx) => {
	if (Server.isStopping()) return ctx.json({ status: "stopping" }, 503, noStore);
	return ctx.json({ status: "ok" }, 200, noStore);
});

Server.app.get("/api/health/database", async (ctx) => {
	if (!(await databaseResponds())) return ctx.json({ status: "database_unavailable" }, 503, noStore);
	return ctx.json({ status: "ok" }, 200, noStore);
});
