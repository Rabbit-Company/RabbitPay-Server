import { Server } from "../../server";
import Auth from "../../auth";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { loadInvoice } from "../../invoice-service";
import { invoiceDocument } from "../../invoice-document";
import { invoicePdf, pdfResponse } from "../../invoice-pdf";
import { eslogResponse, eslogVersions, presentVersions } from "../../eslog-archive";

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
