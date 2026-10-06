import { rateLimit } from "@rabbit-company/web-middleware/rate-limit";
import { Server } from "../../server";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { helpArticle, helpIndex, isHelpLanguage } from "../../help";

const HELP_CACHE = "public, max-age=300";
const publicLimit = rateLimit({ windowMs: 60 * 1000, max: 120, message: "Too many requests. Please slow down." });

Server.app.get("/api/v1/help/:language", publicLimit, async (ctx) => {
	const language = ctx.params["language"];
	if (!isHelpLanguage(language)) return Utils.fail(ctx, ErrorCode.INVALID_ENDPOINT);
	ctx.header("Cache-Control", HELP_CACHE);
	return Utils.ok(ctx, helpIndex(language));
});

Server.app.get("/api/v1/help/:language/:article", publicLimit, async (ctx) => {
	const language = ctx.params["language"];
	const article = isHelpLanguage(language) ? helpArticle(language, ctx.params["article"]) : null;
	if (article === null) return Utils.fail(ctx, ErrorCode.INVALID_ENDPOINT);
	ctx.header("Cache-Control", HELP_CACHE);
	return Utils.ok(ctx, article);
});
