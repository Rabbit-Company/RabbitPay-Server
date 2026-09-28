import { SupportedCryptoAlgorithms } from "bun";
import type { Context } from "@rabbit-company/web";
import Errors, { ErrorCode } from "./errors";
import { Settings } from "./settings";

export default class Utils {
	static jsonError(error: ErrorCode) {
		return new Response(JSON.stringify(Errors.getJson(error)), {
			headers: { "Content-Type": "application/json" },
			status: Errors.get(error).httpCode,
			statusText: Errors.get(error).message,
		});
	}

	static ok(ctx: Context<any, any>, data?: unknown, statusCode = 200) {
		const body: { error: number; info: string; data?: unknown } = Errors.getJson(ErrorCode.SUCCESS);
		if (data !== undefined) body.data = data;
		return ctx.json(body, statusCode);
	}

	static fail(ctx: Context<any, any>, error: ErrorCode) {
		return ctx.json(Errors.getJson(error), Errors.get(error).httpCode);
	}

	static failWithReason(ctx: Context<any, any>, error: ErrorCode, reason: string, data?: unknown) {
		return ctx.json({ ...Errors.getJson(error), info: reason, ...(data === undefined ? {} : { data }) }, Errors.get(error).httpCode);
	}

	static async generateHash(message: string, algorithm: SupportedCryptoAlgorithms) {
		const hasher = new Bun.CryptoHasher(algorithm);
		hasher.update(message);
		return hasher.digest("hex");
	}

	static getBearerToken(req: Request): string | null {
		const authHeader = req.headers.get("authorization");
		if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
		return authHeader.slice("Bearer ".length).trim() || null;
	}

	static basicAuthentication(req: Request): { user: string; pass: string } | null {
		const Authorization = req.headers.get("Authorization") || "";
		const [scheme, encoded] = Authorization.split(" ");
		if (!encoded || scheme !== "Basic") return null;

		let decoded: string;
		try {
			const buffer = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
			decoded = new TextDecoder().decode(buffer).normalize();
		} catch {
			return null;
		}

		const index = decoded.indexOf(":");
		if (index === -1 || /[\0-\x1F\x7F]/.test(decoded)) return null;

		return { user: decoded.substring(0, index), pass: decoded.substring(index + 1) };
	}

	static generateRandomText(length: number): string {
		const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
		const keyArray = new Uint8Array(length);
		crypto.getRandomValues(keyArray);

		let apiKey = "";
		for (let i = 0; i < keyArray.length; i++) {
			const index = keyArray[i] % charset.length;
			apiKey += charset[index];
		}

		return apiKey;
	}

	static maskSecret(secret: string, visible = 4): string {
		if (secret.length <= visible) return "*".repeat(secret.length);
		return `${"*".repeat(8)}${secret.slice(-visible)}`;
	}

	static publicUrl(): string {
		return (Settings.server?.public_url || "http://localhost:8085").replace(/\/+$/, "");
	}

	static clientIp(ctx: Context<any, any>): string {
		return ctx.clientIp || "";
	}

	static userAgent(ctx: Context<any, any>): string {
		return ctx.req.headers.get("user-agent") || "";
	}
}
