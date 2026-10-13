import { rateLimit } from "@rabbit-company/web-middleware/rate-limit";
import { Server } from "../../server";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { helpDocument, helpIndex, helpSearch, isHelpLanguage } from "../../help";

const HELP_CACHE = "public, max-age=300";
const MAX_QUERY_LENGTH = 100;
const publicLimit = rateLimit({ windowMs: 60 * 1000, max: 120, message: "Too many requests. Please slow down." });

Server.app.get("/api/v1/help/:language", publicLimit, async (ctx) => {
	const language = ctx.params["language"];
	if (!isHelpLanguage(language)) return Utils.fail(ctx, ErrorCode.INVALID_ENDPOINT);
	ctx.header("Cache-Control", HELP_CACHE);
	return Utils.ok(ctx, helpIndex(language));
});

Server.app.get("/api/v1/help/:language/search", publicLimit, async (ctx) => {
	const language = ctx.params["language"];
	if (!isHelpLanguage(language)) return Utils.fail(ctx, ErrorCode.INVALID_ENDPOINT);
	const query = (ctx.query().get("q") ?? "").slice(0, MAX_QUERY_LENGTH);
	ctx.header("Cache-Control", HELP_CACHE);
	return Utils.ok(ctx, helpSearch(language, query));
});

Server.app.get("/api/v1/help/:language/:module", publicLimit, async (ctx) => {
	const language = ctx.params["language"];
	const document = isHelpLanguage(language) ? helpDocument(language, ctx.params["module"], null) : null;
	if (document === null) return Utils.fail(ctx, ErrorCode.INVALID_ENDPOINT);
	ctx.header("Cache-Control", HELP_CACHE);
	return Utils.ok(ctx, document);
});

Server.app.get("/api/v1/help/:language/:module/:page", publicLimit, async (ctx) => {
	const language = ctx.params["language"];
	const document = isHelpLanguage(language) ? helpDocument(language, ctx.params["module"], ctx.params["page"]) : null;
	if (document === null) return Utils.fail(ctx, ErrorCode.INVALID_ENDPOINT);
	ctx.header("Cache-Control", HELP_CACHE);
	return Utils.ok(ctx, document);
});
