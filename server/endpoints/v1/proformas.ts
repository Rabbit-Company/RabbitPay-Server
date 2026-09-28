import { Server } from "../../server";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import Database from "../../database/database";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { Permission } from "../../roles";
import { loadInvoice, loadItems, present } from "../../invoice-service";
import { NumberingExhausted } from "../../invoice-numbers";
import { awaitsStorePayment } from "../../payments/recorded";
import { createProforma, documentDetails, isProformaSettlement, proformaFor } from "../../proformas";
import type { Context } from "@rabbit-company/web";
import type { AppState, ProformaSettlement } from "../../database/models";

interface ProformaBody {
	settlement?: unknown;
}

async function readBody(ctx: Context<AppState>): Promise<ProformaBody> {
	try {
		return ((await ctx.body<ProformaBody>()) ?? {}) as ProformaBody;
	} catch {
		return {};
	}
}

Server.app.post("/api/v1/projects/:uuid/invoices/:invoice/proforma", Auth.required(), Permissions.require(Permission.INVOICE_SEND), async (ctx) => {
	const project = Permissions.project(ctx);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
	if (invoice.status !== "draft" || invoice.document_type !== "invoice") return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_STATUS);
	if ((await proformaFor(invoiceId)) || (await awaitsStorePayment(invoice))) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_STATUS);

	const data = await readBody(ctx);
	if (data.settlement !== undefined && !isProformaSettlement(data.settlement)) return Utils.fail(ctx, ErrorCode.INVALID_PROFORMA);
	const settlement = (data.settlement as ProformaSettlement | undefined) ?? project.proforma_settlement;

	let proforma;
	try {
		proforma = await createProforma(project, invoice, settlement);
	} catch (err) {
		if (err instanceof NumberingExhausted) return Utils.failWithReason(ctx, ErrorCode.INVALID_INVOICE_FORMAT, err.message);
		throw err;
	}

	await Audit.record(ctx, {
		project: project.uuid,
		action: "proforma.issued",
		entityType: "invoice",
		entityId: invoiceId,
		oldValue: { reference: invoice.reference },
		newValue: { reference: proforma.reference, settlement },
	});
	Logger.audit(`[PROFORMA] Issued ${proforma.reference} on ${project.uuid}`);

	const updated = (await loadInvoice(project.uuid, invoiceId))!;
	return Utils.ok(ctx, { ...present(updated, await loadItems(invoiceId)), ...(await documentDetails(updated)) }, 201);
});

Server.app.patch("/api/v1/projects/:uuid/invoices/:invoice/proforma", Auth.required(), Permissions.require(Permission.INVOICE_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	const proforma = invoice ? await proformaFor(invoiceId) : null;
	if (!invoice || !proforma) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
	if (invoice.status !== "draft" || invoice.paid_amount > 0 || invoice.advanced_amount > 0) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_EDITABLE);

	const data = await readBody(ctx);
	if (!isProformaSettlement(data.settlement)) return Utils.fail(ctx, ErrorCode.INVALID_PROFORMA);

	await Database`UPDATE proformas SET settlement = ${data.settlement}, updated = ${Date.now()} WHERE invoice = ${invoiceId}`;
	await Audit.record(ctx, {
		project: project.uuid,
		action: "proforma.updated",
		entityType: "invoice",
		entityId: invoiceId,
		oldValue: { settlement: proforma.settlement },
		newValue: { settlement: data.settlement },
	});

	return Utils.ok(ctx, { ...present(invoice, await loadItems(invoiceId)), ...(await documentDetails(invoice)) });
});
