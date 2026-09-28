import type { Context, Middleware } from "@rabbit-company/web";
import Cache from "./cache";
import Database, { dialect } from "./database/database";
import Utils from "./utils";
import Validate from "./validate";
import { ErrorCode } from "./errors";
import { Settings } from "./settings";
import type { AppState } from "./database/models";

export const CUSTOMER_LINK_TTL = 15 * 60 * 1000;

export default class CustomerAuth {
	static ttlSeconds(): number {
		return Settings.security?.session_ttl || 3600;
	}

	private static async cacheKey(token: string): Promise<string> {
		return `customer_session_${await Utils.generateHash(token, "sha256")}`;
	}

	static async createSession(email: string, ip: string): Promise<string | null> {
		const token = Utils.generateRandomText(128);
		const ttl = CustomerAuth.ttlSeconds();
		const stored = await Cache.setString(await CustomerAuth.cacheKey(token), JSON.stringify({ email, ip, created: Date.now() }), ttl, ttl);
		return stored ? token : null;
	}

	static async consumeLink(token: string): Promise<string | null> {
		const hash = await Utils.generateHash(token, "sha256");
		return await Database.begin(async (tx) => {
			const now = Date.now();
			const [link] = (await tx`SELECT email FROM customer_login_links WHERE token_hash = ${hash} AND expires_at > ${now}`) as { email: string }[];
			if (!link) return null;
			const deleted = await tx`DELETE FROM customer_login_links WHERE token_hash = ${hash} AND expires_at > ${now}`;
			if (deleted.count !== 1) return null;
			if (dialect === "mysql") {
				await tx`INSERT INTO customer_accounts(email, created, accessed) VALUES(${link.email}, ${now}, ${now})
					ON DUPLICATE KEY UPDATE accessed = ${now}`;
			} else {
				await tx`INSERT INTO customer_accounts(email, created, accessed) VALUES(${link.email}, ${now}, ${now})
					ON CONFLICT(email) DO UPDATE SET accessed = ${now}`;
			}
			return link.email;
		});
	}

	static async destroySession(token: string): Promise<boolean> {
		return await Cache.deleteString(await CustomerAuth.cacheKey(token));
	}

	static required(): Middleware<AppState> {
		return async (ctx, next) => {
			ctx.header("Cache-Control", "no-store");
			const token = Utils.getBearerToken(ctx.req);
			if (!token) return Utils.fail(ctx, ErrorCode.BEARER_TOKEN_MISSING);
			if (!Validate.token(token)) return Utils.fail(ctx, ErrorCode.INVALID_TOKEN);
			const key = await CustomerAuth.cacheKey(token);
			const raw = await Cache.getString(key);
			if (!raw) return Utils.fail(ctx, ErrorCode.TOKEN_EXPIRED);
			let session: NonNullable<AppState["customerSession"]>;
			try {
				session = JSON.parse(raw);
			} catch {
				return Utils.fail(ctx, ErrorCode.TOKEN_EXPIRED);
			}
			if (!Validate.email(session.email)) return Utils.fail(ctx, ErrorCode.TOKEN_EXPIRED);
			const [account] = await Database`SELECT email FROM customer_accounts WHERE email = ${session.email}`;
			if (!account) return Utils.fail(ctx, ErrorCode.TOKEN_EXPIRED);
			const ttl = CustomerAuth.ttlSeconds();
			await Cache.setString(key, raw, ttl, ttl);
			ctx.set("customerSession", session);
			ctx.set("customerSessionToken", token);
			return await next();
		};
	}

	static email(ctx: Context<AppState>): string {
		const session = ctx.get("customerSession");
		if (!session) throw new Error("Customer session is required");
		return session.email;
	}
}
