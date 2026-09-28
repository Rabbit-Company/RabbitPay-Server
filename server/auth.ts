import type { Context, Middleware } from "@rabbit-company/web";
import Cache from "./cache";
import Database from "./database/database";
import Utils from "./utils";
import Validate from "./validate";
import { ErrorCode } from "./errors";
import { Settings } from "./settings";
import type { AccountRow, AppState, Session } from "./database/models";

export default class Auth {
	static ttlSeconds(): number {
		return Settings.security?.session_ttl || 3600;
	}

	private static async cacheKey(token: string): Promise<string> {
		return `session_${await Utils.generateHash(token, "sha256")}`;
	}

	static async createSession(username: string, ip: string): Promise<string | null> {
		const token = Utils.generateRandomText(128);
		const session: Session = { username, ip, created: Date.now() };

		const ttl = Auth.ttlSeconds();
		const stored = await Cache.setString(await Auth.cacheKey(token), JSON.stringify(session), ttl, ttl);
		if (!stored) return null;

		return token;
	}

	static async getSession(token: string): Promise<Session | null> {
		const key = await Auth.cacheKey(token);
		const raw = await Cache.getString(key);
		if (raw === null) return null;

		let session: Session;
		try {
			session = JSON.parse(raw) as Session;
		} catch {
			return null;
		}

		const ttl = Auth.ttlSeconds();
		await Cache.setString(key, raw, ttl, ttl);

		return session;
	}

	static async destroySession(token: string): Promise<boolean> {
		return await Cache.deleteString(await Auth.cacheKey(token));
	}

	static required(): Middleware<AppState> {
		return async (ctx, next) => {
			const token = Utils.getBearerToken(ctx.req);
			if (token === null) return Utils.fail(ctx, ErrorCode.BEARER_TOKEN_MISSING);
			if (!Validate.token(token)) return Utils.fail(ctx, ErrorCode.INVALID_TOKEN);

			const session = await Auth.getSession(token);
			if (session === null) return Utils.fail(ctx, ErrorCode.TOKEN_EXPIRED);

			const [account] = (await Database`SELECT * FROM accounts WHERE username = ${session.username}`) as AccountRow[];
			if (!account || Number(account.created) > session.created) return Utils.fail(ctx, ErrorCode.TOKEN_EXPIRED);
			if (account.status !== "active") return Utils.fail(ctx, ErrorCode.ACCOUNT_SUSPENDED);

			ctx.set("session", session);
			ctx.set("sessionToken", token);
			ctx.set("account", account);

			await Database`UPDATE accounts SET accessed = ${Date.now()} WHERE username = ${account.username}`;

			return await next();
		};
	}

	static account(ctx: Context<AppState>): AccountRow {
		const account = ctx.get("account");
		if (!account) throw new Error("Auth.account() used on an unauthenticated route");
		return account;
	}
}
