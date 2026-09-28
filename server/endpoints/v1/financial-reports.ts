import { Server } from "../../server";
import Auth from "../../auth";
import Permissions from "../../permissions";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { financialReport, financialReportCsv } from "../../financial-report";
import { reportRoutes } from "../../report-routes";
import { savedReport } from "../../report-service";
import type { FinancialReport } from "../../expense-types";

reportRoutes("/api/v1/projects/:uuid/reports/financial", "financial", (ctx) => {
	const query = ctx.query();
	const year = new Date().getUTCFullYear();
	const from = Number(query.get("from") ?? Date.UTC(year, 0, 1));
	const to = Number(query.get("to") ?? Date.UTC(year + 1, 0, 1) - 1);
	const group = query.get("group") ?? "month";
	if (
		!Number.isSafeInteger(from) ||
		!Number.isSafeInteger(to) ||
		from < 0 ||
		to < from ||
		to > Date.UTC(9999, 11, 31) ||
		to - from > 100 * 366 * 86400000 ||
		!["month", "year"].includes(group)
	)
		return Utils.fail(ctx, ErrorCode.INVALID_REPORT_PERIOD);
	return () => financialReport(Permissions.project(ctx).uuid, from, to, group as "month" | "year");
});

Server.app.get("/api/v1/projects/:uuid/reports/financial/export", Auth.required(), Permissions.require(Permission.REPORT_EXPORT), async (ctx) => {
	const state = await savedReport<FinancialReport>(Permissions.project(ctx).uuid, "financial");
	if (!state.report) return Utils.fail(ctx, ErrorCode.REPORT_NOT_GENERATED);
	return new Response(financialReportCsv(state.report), {
		headers: { "Content-Type": "text/csv;charset=utf-8", "Content-Disposition": 'attachment; filename="financial-report.csv"' },
	});
});
