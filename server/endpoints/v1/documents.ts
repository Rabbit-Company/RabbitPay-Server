import type { Context } from "@rabbit-company/web";
import { rateLimit } from "@rabbit-company/web-middleware/rate-limit";
import { Server } from "../../server";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { loadInvoice } from "../../invoice-service";
import { invoiceDocument } from "../../invoice-document";
import { downloadResponse, invoicePdf, pdfResponse } from "../../invoice-pdf";
import {
	INVOICE_EXPORT_LIMIT,
	InvoiceNumberUnknown,
	invoiceArchive,
	invoiceExportSelection,
	invoiceExportSummary,
	invoicesForExport,
} from "../../invoice-export";
import { eslogResponse, eslogVersions, presentVersions } from "../../eslog-archive";
import type { AppState } from "../../database/models";

const archiveLimit = rateLimit({ windowMs: 60 * 1000, max: 10, message: "Too many downloads. Please slow down." });

Server.app.get("/api/v1/projects/:uuid/invoices/:invoice/document", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);

	return Utils.ok(ctx, await invoiceDocument(project, invoice));
});

Server.app.get("/api/v1/projects/:uuid/invoices/:invoice/pdf", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);

	return pdfResponse(await invoicePdf(project, invoice, { payLink: Boolean(project.email_pay_link) }));
});

Server.app.get("/api/v1/projects/:uuid/invoices/:invoice/eslog", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
	if (invoice.status === "draft" || invoice.issued_at === null) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_STATUS);

	return await eslogResponse(ctx, { kind: "invoice", project, invoice });
});

Server.app.get("/api/v1/projects/:uuid/invoices/:invoice/eslog/versions", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);

	return Utils.ok(ctx, { versions: presentVersions(await eslogVersions({ kind: "invoice", project, invoice })) });
});

function exportFailure(ctx: Context<AppState>, error: unknown): Response {
	if (error instanceof InvoiceNumberUnknown) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
	throw error;
}

Server.app.get("/api/v1/projects/:uuid/invoice-export", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const selection = invoiceExportSelection(ctx.query());
	if (!selection) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_EXPORT);

	try {
		return Utils.ok(ctx, await invoiceExportSummary(project, selection));
	} catch (error) {
		return exportFailure(ctx, error);
	}
});

Server.app.get("/api/v1/projects/:uuid/invoice-export/zip", archiveLimit, Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const selection = invoiceExportSelection(ctx.query());
	if (!selection) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_EXPORT);

	let invoices;
	try {
		invoices = await invoicesForExport(project, selection);
	} catch (error) {
		return exportFailure(ctx, error);
	}
	if (invoices.length === 0) return Utils.fail(ctx, ErrorCode.INVOICE_EXPORT_EMPTY);
	if (invoices.length > INVOICE_EXPORT_LIMIT) return Utils.fail(ctx, ErrorCode.INVOICE_EXPORT_TOO_LARGE);

	const archive = await invoiceArchive(project, invoices);
	await Audit.record(ctx, {
		project: project.uuid,
		action: "invoices.exported",
		entityType: "invoice",
		newValue: { ...selection, count: invoices.length, first: invoices[0].reference, last: invoices[invoices.length - 1].reference },
	});
	return downloadResponse(archive, "application/zip");
});
