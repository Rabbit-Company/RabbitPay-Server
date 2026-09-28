import type { Context } from "@rabbit-company/web";
import { Server } from "./server";
import Auth from "./auth";
import Permissions from "./permissions";
import { Permission } from "./roles";
import Utils from "./utils";
import Errors from "./errors";
import { generateReport, ReportUnavailable, savedReport } from "./report-service";
import type { ReportKind } from "./report-types";
import type { AppState } from "./database/models";

export function reportRoutes<T>(path: string, kind: ReportKind, prepare: (ctx: Context<AppState>) => Response | (() => Promise<T>)) {
	for (const method of ["get", "post"] as const) {
		Server.app[method](path, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
			const build = prepare(ctx);
			if (build instanceof Response) return build;
			const project = Permissions.project(ctx).uuid;
			if (method === "get") return Utils.ok(ctx, await savedReport<T>(project, kind));
			try {
				return Utils.ok(ctx, await generateReport(project, kind, build));
			} catch (error) {
				if (!(error instanceof ReportUnavailable)) throw error;
				const state = await savedReport<T>(project, kind);
				ctx.header("Retry-After", String(Math.max(1, Math.ceil((state.next_generation_at - state.server_time) / 1000))));
				return ctx.json({ ...Errors.getJson(error.code), data: state }, Errors.get(error.code).httpCode);
			}
		});
	}
}
