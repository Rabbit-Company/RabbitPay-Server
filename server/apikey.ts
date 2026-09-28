import { timingSafeEqual } from "node:crypto";
import type { Context, Middleware } from "@rabbit-company/web";
import Database from "./database/database";
import Utils from "./utils";
import Validate from "./validate";
import { ErrorCode } from "./errors";
import { Logger } from "./logger";
import type { AppState, ProjectRow } from "./database/models";

export function secureEquals(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

export default class ApiKey {
	static async resolve(key: string): Promise<{ project: ProjectRow; slot: "primary" | "secondary" } | null> {
		const candidates = (await Database`
			SELECT * FROM projects WHERE (apikey = ${key} OR apikey2 = ${key}) AND status = 'active'
		`) as ProjectRow[];

		for (const project of candidates) {
			if (secureEquals(project.apikey, key)) return { project, slot: "primary" };
			if (secureEquals(project.apikey2, key)) return { project, slot: "secondary" };
		}

		return null;
	}

	static required(): Middleware<AppState> {
		return async (ctx, next) => {
			const key = Utils.getBearerToken(ctx.req);
			if (key === null) return Utils.fail(ctx, ErrorCode.BEARER_TOKEN_MISSING);
			if (!Validate.token(key)) return Utils.fail(ctx, ErrorCode.INVALID_API_SECRET_KEY);

			const resolved = await ApiKey.resolve(key);
			if (resolved === null) {
				Logger.audit(`[APIKEY] Rejected key from ${Utils.clientIp(ctx)} on ${new URL(ctx.req.url).pathname}`);
				return Utils.fail(ctx, ErrorCode.INVALID_API_SECRET_KEY);
			}

			ctx.set("project", resolved.project);
			ctx.set("apiKeySlot", resolved.slot);

			return await next();
		};
	}

	static project(ctx: Context<AppState>): ProjectRow {
		const project = ctx.get("project");
		if (!project) throw new Error("ApiKey.project() used outside an API key route");
		return project;
	}
}
