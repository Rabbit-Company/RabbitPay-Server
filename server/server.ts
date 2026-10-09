import { Web } from "@rabbit-company/web";
import { Logger } from "./logger";
import { logger } from "@rabbit-company/web-middleware/logger";
import { cors } from "@rabbit-company/web-middleware/cors";
import { bodyLimit } from "@rabbit-company/web-middleware/body-limit";
import Metrics from "./metrics";
import { Settings } from "./settings";
import Utils from "./utils";
import { ErrorCode } from "./errors";
import * as WebInterface from "./web";
import { clientIpMiddleware } from "./client-ip";
import { NumberingExhausted } from "./invoice-numbers";
import { DocumentArchiveDamaged } from "./document-storage";
import { Realtime } from "./realtime";
import type { AppState } from "./database/models";

const STORE_IMAGE_UPLOAD = /^\/api\/v1\/projects\/[^/]+\/store\/(?:images\/(?:logo|hero)|products\/[^/]+\/images)$/;
const ACCOUNTING_IMPORT =
	/^\/api\/v1\/projects\/[^/]+\/(?:(?:recorded-invoices\/import|accounting\/bank-statements|expenses\/import|expenses\/import-csv)(?:\/preview)?|(?:recorded-invoices|expenses)\/[^/]+\/attachment)$/;
const FILE_PART_UPLOAD = /^\/api\/v1\/projects\/[^/]+\/(?:files|chat\/recordings)\/[^/]+\/parts\/\d+$/;

export namespace Server {
	export const app = new Web<AppState>();

	let configured = false;

	export async function configure() {
		if (configured) return;
		configured = true;

		app.use(async (ctx, next) => {
			const start = process.hrtime();
			const method = Metrics.methodLabel(ctx.req.method);

			if (Settings.metrics.method >= 1) {
				Metrics.http_requests_total.labels({ method }).inc();
			}

			try {
				await next();
			} catch (err) {
				if (err instanceof NumberingExhausted) return Utils.jsonError(ErrorCode.INVOICE_NUMBERS_EXHAUSTED);
				if (err instanceof DocumentArchiveDamaged) {
					Logger.error(`[DOCUMENTS] ${err.message}`);
					return Utils.jsonError(ErrorCode.DOCUMENT_ARCHIVE_DAMAGED);
				}
				Logger.error(`[GENERAL] ${err}`);
				return Utils.jsonError(ErrorCode.UNKNOWN_ERROR);
			}

			const end = process.hrtime(start);
			if (Settings.metrics.method >= 2) {
				Metrics.http_request_duration.labels({ method }).observe(end[0] * 1000 + end[1] / 1000000);
			}
		});

		app.use(clientIpMiddleware());

		app.use(
			bodyLimit({
				maxSize: 256 * 1024,
				skip: (ctx) => {
					const path = new URL(ctx.req.url).pathname;
					return STORE_IMAGE_UPLOAD.test(path) || ACCOUNTING_IMPORT.test(path) || FILE_PART_UPLOAD.test(path);
				},
			})
		);

		app.use(async (ctx, next) => {
			ctx.body = async <T>() => {
				if (!ctx.req.body) return {} as T;
				const contentType = ctx.req.headers.get("content-type") ?? "";
				if (contentType.includes("application/x-www-form-urlencoded")) {
					const formData = await ctx.req.formData();
					return Object.fromEntries(formData.entries()) as T;
				}
				return (contentType.includes("application/json") ? await ctx.req.json() : {}) as T;
			};
			return await next();
		});

		app.use(
			logger({
				logger: Logger,
				logResponses: false,
			})
		);

		app.use(
			cors({
				origin: "*",
				credentials: true,
				allowHeaders: ["*"],
				allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
				maxAge: 86400,
			})
		);

		app.onNotFound(async (ctx) => {
			const url = new URL(ctx.req.url);
			if (url.pathname.startsWith("/api/") || url.pathname === "/metrics") return Utils.jsonError(ErrorCode.INVALID_ENDPOINT);

			const page = await WebInterface.serve(url, ctx.req.method, ctx.req.headers.get("host"));
			return page ?? Utils.jsonError(ErrorCode.INVALID_ENDPOINT);
		});

		app.onError((err) => {
			if (err instanceof NumberingExhausted) return Utils.jsonError(ErrorCode.INVOICE_NUMBERS_EXHAUSTED);
			if (err instanceof DocumentArchiveDamaged) {
				Logger.error(`[DOCUMENTS] ${err.message}`);
				return Utils.jsonError(ErrorCode.DOCUMENT_ARCHIVE_DAMAGED);
			}
			Logger.error(`[GENERAL] Unhandled error: ${err?.stack || err}`);
			return Utils.jsonError(ErrorCode.UNKNOWN_ERROR);
		});

		await import("./endpoints/index");

		Logger.info(`[HS] Registered ${app.getRoutes().length} routes`);
	}

	let listening: Awaited<ReturnType<typeof app.listen>> | null = null;
	let stopping = false;

	export function isStopping(): boolean {
		return stopping;
	}

	export async function initialize(hostname: string, port: number) {
		await configure();

		listening = await app.listen({
			hostname: hostname,
			port: port,
		});
	}

	export async function stop() {
		stopping = true;
		if (listening === null) return;
		const server = listening;
		listening = null;
		Realtime.closeAll();
		await server.stop();
	}
}
