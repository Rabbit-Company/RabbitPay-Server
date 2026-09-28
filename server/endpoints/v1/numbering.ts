import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { Permission } from "../../roles";
import { describeInvoiceFormat, formatsCanCollide, parseInvoiceFormat, renderInvoiceNumber, type InvoiceFormat } from "../../invoice-format";
import {
	CREDIT_NOTE_PREFIX,
	isNumberSeries,
	NUMBER_SERIES,
	sequenceKey,
	setNextNumber,
	storedFormatOf,
	storedNextNumber,
	type NumberSeries,
} from "../../invoice-numbers";
import { creditorReference } from "../../payments/reference";
import type { ProjectRow } from "../../database/models";

interface NumberingBody {
	series?: unknown;
	format?: unknown;
	next_number?: unknown;
}

const DOCUMENTS: Record<NumberSeries, string> = { invoice: "invoices", order: "orders", proforma: "pro forma invoices" };

const SERIES_NAMES: Record<NumberSeries, string> = { invoice: "invoices", order: "store orders", proforma: "pro forma invoices" };

async function numberingState(project: ProjectRow, series: NumberSeries, format: InvoiceFormat, now = Date.now()) {
	const next = await storedNextNumber(Database, project.uuid, sequenceKey(series, format, now, project.timezone));
	const sample = next <= format.capacity ? renderInvoiceNumber(format, now, next, project.timezone) : null;
	return {
		series,
		format: format.source,
		period: format.period,
		digits: format.digits,
		capacity: format.capacity,
		next_number: next,
		next_reference: sample,
		bank_reference: sample !== null && creditorReference(sample) !== null,
		description: describeInvoiceFormat(format, DOCUMENTS[series]),
	};
}

function collision(project: ProjectRow, series: NumberSeries, format: InvoiceFormat): string | null {
	const others: { name: string; source: string }[] = NUMBER_SERIES.filter((other) => other !== series).map((other) => ({
		name: SERIES_NAMES[other],
		source: storedFormatOf(project, other),
	}));
	const invoiceSource = series === "invoice" ? format.source : project.invoice_format;
	others.push({ name: "credit notes", source: `${CREDIT_NOTE_PREFIX}${invoiceSource}` });

	for (const other of others) {
		if (series === "invoice" && other.name === "credit notes") continue;
		const parsed = parseInvoiceFormat(other.source);
		if (parsed.ok && formatsCanCollide(format, parsed.format)) {
			return `This format can produce the same numbers as ${other.name} (${parsed.format.source}). Add letters or change the length so they stay apart.`;
		}
	}
	return null;
}

function seriesOf(value: unknown): NumberSeries | null {
	if (value === undefined || value === null || value === "") return "invoice";
	return isNumberSeries(value) ? value : null;
}

Server.app.get("/api/v1/projects/:uuid/invoice-numbering", Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const series = seriesOf(ctx.query().get("series"));
	if (series === null) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_FORMAT);
	const parsed = parseInvoiceFormat(ctx.query().get("format") ?? storedFormatOf(project, series));
	if (!parsed.ok) return Utils.failWithReason(ctx, ErrorCode.INVALID_INVOICE_FORMAT, parsed.error);

	return Utils.ok(ctx, await numberingState(project, series, parsed.format));
});

Server.app.put("/api/v1/projects/:uuid/invoice-numbering", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);

	let data: NumberingBody;
	try {
		data = await ctx.body<NumberingBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const series = seriesOf(data.series);
	if (series === null) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_FORMAT);
	const previous = storedFormatOf(project, series);
	const parsed = parseInvoiceFormat(data.format ?? previous);
	if (!parsed.ok) return Utils.failWithReason(ctx, ErrorCode.INVALID_INVOICE_FORMAT, parsed.error);
	const format = parsed.format;

	const clash = collision(project, series, format);
	if (clash) return Utils.failWithReason(ctx, ErrorCode.INVALID_INVOICE_FORMAT, clash);

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
		if (series === "order") await tx`UPDATE projects SET order_format = ${format.source}, updated = ${now} WHERE uuid = ${project.uuid}`;
		else if (series === "proforma") await tx`UPDATE projects SET proforma_format = ${format.source}, updated = ${now} WHERE uuid = ${project.uuid}`;
		else await tx`UPDATE projects SET invoice_format = ${format.source}, updated = ${now} WHERE uuid = ${project.uuid}`;
		if (typeof next === "number") await setNextNumber(tx, project.uuid, sequenceKey(series, format, now, project.timezone), next);
	});

	await Audit.record(ctx, {
		project: project.uuid,
		action: "invoice_numbering.updated",
		entityType: "project",
		entityId: project.uuid,
		oldValue: { series, format: previous },
		newValue: { series, format: format.source, next_number: next ?? null },
	});
	const from = typeof next === "number" ? ` from ${next}` : "";
	Logger.audit(`[NUMBERING] ${Auth.account(ctx).username} set ${series} numbers on ${project.uuid} to ${format.source}${from}`);

	const [updated] = (await Database`SELECT * FROM projects WHERE uuid = ${project.uuid}`) as ProjectRow[];
	return Utils.ok(ctx, await numberingState(updated, series, format, now));
});
