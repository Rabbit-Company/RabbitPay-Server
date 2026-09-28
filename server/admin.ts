import type { Middleware } from "@rabbit-company/web";
import Utils from "./utils";
import { ErrorCode } from "./errors";
import type { AppState } from "./database/models";

export default class Admin {
	static required(): Middleware<AppState> {
		return async (ctx, next) => {
			const account = ctx.get("account");
			if (!account) return Utils.fail(ctx, ErrorCode.BEARER_TOKEN_MISSING);
			if (Number(account.admin) !== 1) return Utils.fail(ctx, ErrorCode.ADMIN_REQUIRED);
			return await next();
		};
	}
}
