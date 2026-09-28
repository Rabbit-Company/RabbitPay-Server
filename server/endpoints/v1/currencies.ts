import { Server } from "../../server";
import Auth from "../../auth";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { convert, currencyRates } from "../../rates/forex";

Server.app.get("/api/v1/currencies", Auth.required(), async (ctx) => {
	return Utils.ok(ctx, await currencyRates());
});

Server.app.get("/api/v1/currencies/convert", Auth.required(), async (ctx) => {
	const query = ctx.query();

	const from = (query.get("from") ?? "").toUpperCase();
	const to = (query.get("to") ?? "").toUpperCase();
	const amount = Number(query.get("amount") ?? "1");

	if (!Validate.currency(from) || !Validate.currency(to)) return Utils.fail(ctx, ErrorCode.INVALID_CURRENCY);
	if (!Number.isFinite(amount)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_AMOUNT);

	const quoted = await currencyRates();
	if (!quoted.live) return Utils.fail(ctx, ErrorCode.RATE_UNAVAILABLE);

	const result = convert(amount, from, to, quoted.rates);
	if (result === null) return Utils.fail(ctx, ErrorCode.CURRENCY_NOT_SUPPORTED);

	return Utils.ok(ctx, { from, to, amount, result, rate: convert(1, from, to, quoted.rates) });
});
