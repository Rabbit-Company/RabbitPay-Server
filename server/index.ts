import "./require-master-key.ts";
import Database, { initialize as initializeDatabase } from "./database/database.ts";
import { Logger } from "./logger";
import { Settings } from "./settings.ts";
import { Server } from "./server.ts";
import Cache from "./cache/index.ts";
import Scheduler from "./scheduler.ts";
import { isLicenseIssuer, issuerKeyMismatch } from "./license-signing.ts";

const SHUTDOWN_TIMEOUT_MS = 25 * 1000;

await Cache.initialize();
await initializeDatabase();
await Scheduler.initialize();

if (issuerKeyMismatch())
	Logger.error("[LICENSE] RABBITPAY_LICENSE_SIGNING_KEY does not match the built-in license public key, so this server cannot issue licenses");
else if (isLicenseIssuer()) Logger.info("[LICENSE] This server is the license issuer");

const hostname = Settings.server?.hostname || "0.0.0.0";
const port = Settings.server?.port || 8085;

await Server.initialize(hostname, port);

Logger.info(`[HS] HTTP Server listening on port ${hostname}:${port}`);

let shuttingDown = false;

async function shutdown(signal: string) {
	if (shuttingDown) {
		Logger.warn(`[HS] Received ${signal} again, exiting immediately`);
		process.exit(1);
	}
	shuttingDown = true;
	Logger.info(`[HS] Received ${signal}, shutting down`);

	const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
	const serverStopped = Promise.race([Server.stop().then(() => true), Bun.sleep(SHUTDOWN_TIMEOUT_MS).then(() => false)]);
	const tasksFinished = await Scheduler.stop(SHUTDOWN_TIMEOUT_MS);
	const requestsFinished = await Promise.race([serverStopped, Bun.sleep(Math.max(deadline - Date.now(), 0)).then(() => false)]);

	if (!tasksFinished) Logger.warn(`[HS] ${Scheduler.running()} background tasks were still running at the shutdown deadline`);
	if (!requestsFinished) Logger.warn("[HS] Some HTTP requests were still open at the shutdown deadline");

	await Database.close().catch((err) => Logger.error(`[DB] Could not close the database: ${err}`));
	Logger.info("[HS] Shutdown complete");
	process.exit(tasksFinished && requestsFinished ? 0 : 1);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
