import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { Permission } from "../../roles";
import { describeInvoiceFormat, parseInvoiceFormat, periodKey, renderInvoiceNumber, type InvoiceFormat } from "../../invoice-format";
import { setNextNumber, storedNextNumber } from "../../invoice-numbers";

interface NumberingBody {
	format?: unknown;
	next_number?: unknown;
}

async function numberingState(projectId: string, format: InvoiceFormat, timezone: string, now = Date.now()) {
	const next = await storedNextNumber(Database, projectId, periodKey(format, now, timezone));
	return {
		format: format.source,
		period: format.period,
		digits: format.digits,
		capacity: format.capacity,
		next_number: next,
		next_reference: next <= format.capacity ? renderInvoiceNumber(format, now, next, timezone) : null,
		description: describeInvoiceFormat(format),
	};
}

Server.app.get("/api/v1/projects/:uuid/invoice-numbering", Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const parsed = parseInvoiceFormat(ctx.query().get("format") ?? project.invoice_format);
	if (!parsed.ok) return Utils.failWithReason(ctx, ErrorCode.INVALID_INVOICE_FORMAT, parsed.error);

	return Utils.ok(ctx, await numberingState(project.uuid, parsed.format, project.timezone));
});

Server.app.put("/api/v1/projects/:uuid/invoice-numbering", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);

	let data: NumberingBody;
	try {
		data = await ctx.body<NumberingBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const parsed = parseInvoiceFormat(data.format ?? project.invoice_format);
	if (!parsed.ok) return Utils.failWithReason(ctx, ErrorCode.INVALID_INVOICE_FORMAT, parsed.error);
	const format = parsed.format;

	const next = data.next_number;
	if (next !== undefined && (typeof next !== "number" || !Number.isInteger(next) || next < 1 || next > format.capacity)) {
		return Utils.failWithReason(
			ctx,
			ErrorCode.INVALID_INVOICE_FORMAT,
			`The next number must be a whole number from 1 to ${format.capacity.toLocaleString("en")}.`
		);
	}

	const now = Date.now();
	await Database.begin(async (tx) => {
		await tx`UPDATE projects SET invoice_format = ${format.source}, updated = ${now} WHERE uuid = ${project.uuid}`;
		if (typeof next === "number") await setNextNumber(tx, project.uuid, periodKey(format, now, project.timezone), next);
	});

	await Audit.record(ctx, {
		project: project.uuid,
		action: "invoice_numbering.updated",
		entityType: "project",
		entityId: project.uuid,
		oldValue: { format: project.invoice_format },
		newValue: { format: format.source, next_number: next ?? null },
	});
	Logger.audit(`[NUMBERING] ${Auth.account(ctx).username} set ${project.uuid} to ${format.source}${typeof next === "number" ? ` from ${next}` : ""}`);

	return Utils.ok(ctx, await numberingState(project.uuid, format, project.timezone, now));
});
