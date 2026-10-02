import type { Context } from "@rabbit-company/web";
import { bodyLimit } from "@rabbit-company/web-middleware/body-limit";
import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { accountingActive } from "../../licensing";
import { accountingPeriodLocked } from "../../accounting-periods";
import { createHash } from "node:crypto";
import { documentStorage } from "../../document-storage";
import { hasStorageCapacity } from "../../licensing";
import {
	insertRecordedInvoice,
	recordedTaxPoint,
	loadRecordedInvoice,
	recordedInvoiceInput,
	referenceTaken,
	replaceRecordedInvoice,
	validRecordedInvoice,
} from "../../accounting/recorded-invoices";
import { parseRecordedInvoices, type ImportResult } from "../../accounting/recorded-import";
import type { ProjectRow } from "../../database/models";
import type { AppState, RecordedInvoiceAttachmentRow, RecordedInvoiceLineRow, RecordedInvoiceRow } from "../../database/models";

const base = "/api/v1/projects/:uuid/recorded-invoices";

async function body(ctx: Context<AppState>): Promise<Record<string, unknown> | null> {
	try {
		const value = await ctx.body<Record<string, unknown>>();
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

async function audit(ctx: Context<AppState>, action: string, uuid: string, value?: unknown, previous?: unknown) {
	await Audit.record(ctx, {
		project: Permissions.project(ctx).uuid,
		action,
		entityType: "recorded_invoice",
		entityId: uuid,
		newValue: value,
		oldValue: previous,
	});
}

Server.app.get(base, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const query = ctx.query();
	const limit = Number(query.get("limit") ?? 50);
	const offset = Number(query.get("offset") ?? 0);
	const from = Number(query.get("from") ?? 0);
	const to = Number(query.get("to") ?? Number.MAX_SAFE_INTEGER);
	if (![limit, offset, from, to].every(Number.isSafeInteger) || limit < 1 || limit > 200 || offset < 0 || from < 0 || to < from)
		return Utils.fail(ctx, ErrorCode.INVALID_RECORDED_INVOICE);
	const project = Permissions.project(ctx).uuid;
	const rows = (await Database`
		SELECT * FROM recorded_invoices WHERE project = ${project} AND issued_at BETWEEN ${from} AND ${to}
		ORDER BY issued_at DESC, reference DESC LIMIT ${limit} OFFSET ${offset}
	`) as RecordedInvoiceRow[];
	const [count] = (await Database`
		SELECT COUNT(*) AS total FROM recorded_invoices WHERE project = ${project} AND issued_at BETWEEN ${from} AND ${to}
	`) as { total: number }[];
	const lines = rows.length
		? ((await Database`
				SELECT * FROM recorded_invoice_lines WHERE recorded_invoice IN ${Database(rows.map((row) => row.uuid))} ORDER BY sort_order
			`) as RecordedInvoiceLineRow[])
		: [];
	const attachments = rows.length
		? ((await Database`
				SELECT recorded_invoice, file_name, content_type, byte_size, sha256, created FROM recorded_invoice_attachments
				WHERE recorded_invoice IN ${Database(rows.map((row) => row.uuid))}
			`) as Omit<RecordedInvoiceAttachmentRow, "storage_key">[])
		: [];
	return Utils.ok(ctx, {
		recorded_invoices: rows.map((row) => ({
			...row,
			lines: lines.filter((line) => line.recorded_invoice === row.uuid),
			attachment: attachments.find((attachment) => attachment.recorded_invoice === row.uuid) ?? null,
		})),
		total: Number(count.total),
		limit,
		offset,
	});
});

async function importPlan(project: ProjectRow, content: string): Promise<ImportResult> {
	const result = parseRecordedInvoices(content, project);
	const seen = new Set<string>();
	const documents = [];
	for (const document of result.documents) {
		const key = `${document.input.document_type}|${document.input.reference}`;
		if (seen.has(key)) {
			result.errors.push({ row: document.rows[0], column: "number", reference: document.input.reference, code: "duplicate_in_file" });
			continue;
		}
		seen.add(key);
		if (await referenceTaken(project.uuid, document.input)) {
			result.errors.push({ row: document.rows[0], column: "number", reference: document.input.reference, code: "already_recorded" });
			continue;
		}
		if (
			(await accountingPeriodLocked(project.uuid, document.input.issued_at)) ||
			(await accountingPeriodLocked(project.uuid, recordedTaxPoint(project, document.input)))
		) {
			result.errors.push({ row: document.rows[0], column: "issue_date", reference: document.input.reference, code: "period_locked" });
			continue;
		}
		documents.push(document);
	}
	return { documents, errors: result.errors.sort((a, b) => (a.row ?? 0) - (b.row ?? 0)) };
}

export const importBody = bodyLimit<AppState>({ maxSize: 5 * 1024 * 1024, message: "The file is too large." });

async function importContent(ctx: Context<AppState>): Promise<string | null> {
	const raw = await body(ctx);
	return typeof raw?.content === "string" ? raw.content : null;
}

Server.app.post(`${base}/import/preview`, importBody, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	if (!accountingActive(project)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_LICENSE_REQUIRED);
	const content = await importContent(ctx);
	if (content === null) return Utils.fail(ctx, ErrorCode.INVALID_RECORDED_INVOICE);
	return Utils.ok(ctx, await importPlan(project, content));
});

Server.app.post(`${base}/import`, importBody, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	if (!accountingActive(project)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_LICENSE_REQUIRED);
	const content = await importContent(ctx);
	if (content === null) return Utils.fail(ctx, ErrorCode.INVALID_RECORDED_INVOICE);
	const plan = await importPlan(project, content);
	if (plan.errors.length > 0 || plan.documents.length === 0)
		return Utils.failWithReason(ctx, ErrorCode.INVALID_RECORDED_INVOICE, "Fix the rows with errors before importing. Nothing was imported.", plan);
	const author = Auth.account(ctx).username;
	const created = await Database.begin(async (tx) => {
		const ids: string[] = [];
		for (const document of plan.documents) ids.push(await insertRecordedInvoice(tx, project, document.input, author));
		return ids;
	});
	await audit(ctx, "recorded_invoice.imported", created[0], { count: created.length, references: plan.documents.map((document) => document.input.reference) });
	return Utils.ok(ctx, { imported: created.length }, 201);
});

Server.app.get(`${base}/buyers`, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx).uuid;
	const recorded = (await Database`
		SELECT buyer_name AS name, buyer_vat_number AS vat_number, buyer_country AS country, MAX(issued_at) AS last_used FROM recorded_invoices
		WHERE project = ${project} GROUP BY buyer_name, buyer_vat_number, buyer_country ORDER BY last_used DESC LIMIT 500
	`) as { name: string; vat_number: string | null; country: string | null }[];
	const customers = (await Database`
		SELECT name, vat_number, country FROM customers WHERE project = ${project} AND name IS NOT NULL ORDER BY name LIMIT 1000
	`) as { name: string; vat_number: string | null; country: string | null }[];
	const seen = new Set<string>();
	const buyers = [...recorded, ...customers].filter((buyer) => {
		const key = `${buyer.name.trim().toLowerCase()}|${buyer.vat_number ?? ""}`;
		if (!buyer.name.trim() || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return Utils.ok(ctx, { buyers: buyers.map(({ name, vat_number, country }) => ({ name, vat_number, country })) });
});

Server.app.get(`${base}/:record`, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const record = await loadRecordedInvoice(Permissions.project(ctx).uuid, ctx.params.record);
	if (!record) return Utils.fail(ctx, ErrorCode.RECORDED_INVOICE_NOT_FOUND);
	return Utils.ok(ctx, record);
});

Server.app.post(base, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	if (!accountingActive(project)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_LICENSE_REQUIRED);
	const raw = await body(ctx);
	if (!raw) return Utils.fail(ctx, ErrorCode.INVALID_RECORDED_INVOICE);
	const data = recordedInvoiceInput({ currency: project.tax_currency ?? project.currency, ...raw });
	if (!validRecordedInvoice(data, project.tax_currency ?? project.currency)) return Utils.fail(ctx, ErrorCode.INVALID_RECORDED_INVOICE);
	if ((await accountingPeriodLocked(project.uuid, data.issued_at)) || (await accountingPeriodLocked(project.uuid, recordedTaxPoint(project, data)))) {
		return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);
	}
	if (await referenceTaken(project.uuid, data)) return Utils.fail(ctx, ErrorCode.RECORDED_INVOICE_EXISTS);
	const uuid = await Database.begin(async (tx) => insertRecordedInvoice(tx, project, data, Auth.account(ctx).username));
	const created = await loadRecordedInvoice(project.uuid, uuid);
	await audit(ctx, "recorded_invoice.created", uuid, created);
	return Utils.ok(ctx, created, 201);
});

Server.app.patch(`${base}/:record`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	if (!accountingActive(project)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_LICENSE_REQUIRED);
	const previous = await loadRecordedInvoice(project.uuid, ctx.params.record);
	if (!previous) return Utils.fail(ctx, ErrorCode.RECORDED_INVOICE_NOT_FOUND);
	const raw = await body(ctx);
	if (!raw) return Utils.fail(ctx, ErrorCode.INVALID_RECORDED_INVOICE);
	const data = recordedInvoiceInput(raw, previous);
	if (!validRecordedInvoice(data, project.tax_currency ?? project.currency)) return Utils.fail(ctx, ErrorCode.INVALID_RECORDED_INVOICE);
	for (const date of [previous.issued_at, previous.tax_point_date, data.issued_at, recordedTaxPoint(project, data)]) {
		if (await accountingPeriodLocked(project.uuid, date)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);
	}
	if (await referenceTaken(project.uuid, data, previous.uuid)) return Utils.fail(ctx, ErrorCode.RECORDED_INVOICE_EXISTS);
	await Database.begin(async (tx) => replaceRecordedInvoice(tx, project, previous.uuid, data));
	const updated = await loadRecordedInvoice(project.uuid, previous.uuid);
	await audit(ctx, "recorded_invoice.updated", previous.uuid, updated, previous);
	return Utils.ok(ctx, updated);
});

Server.app.delete(`${base}/:record`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	if (!accountingActive(project)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_LICENSE_REQUIRED);
	const previous = await loadRecordedInvoice(project.uuid, ctx.params.record);
	if (!previous) return Utils.fail(ctx, ErrorCode.RECORDED_INVOICE_NOT_FOUND);
	if ((await accountingPeriodLocked(project.uuid, previous.issued_at)) || (await accountingPeriodLocked(project.uuid, previous.tax_point_date))) {
		return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);
	}
	const [attachment] = (await Database`SELECT * FROM recorded_invoice_attachments WHERE recorded_invoice = ${previous.uuid}`) as RecordedInvoiceAttachmentRow[];
	await Database`DELETE FROM recorded_invoices WHERE uuid = ${previous.uuid}`;
	if (attachment) await documentStorage().remove(attachment.storage_key);
	await audit(ctx, "recorded_invoice.deleted", previous.uuid, undefined, previous);
	return Utils.ok(ctx);
});

const ATTACHMENT_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/tiff", "application/xml", "text/xml"]);
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

Server.app.put(`${base}/:record/attachment`, importBody, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	if (!accountingActive(project)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_LICENSE_REQUIRED);
	const record = await loadRecordedInvoice(project.uuid, ctx.params.record);
	if (!record) return Utils.fail(ctx, ErrorCode.RECORDED_INVOICE_NOT_FOUND);
	if ((await accountingPeriodLocked(project.uuid, record.issued_at)) || (await accountingPeriodLocked(project.uuid, record.tax_point_date))) {
		return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);
	}
	const raw = await body(ctx);
	const name = typeof raw?.name === "string" ? raw.name.trim() : "";
	const type = raw?.type;
	const encoded = raw?.data;
	if (!name || name.length > 250 || typeof type !== "string" || !ATTACHMENT_TYPES.has(type) || typeof encoded !== "string")
		return Utils.fail(ctx, ErrorCode.INVALID_RECORDED_ATTACHMENT);
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES || bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/\s|=+$/g, ""))
		return Utils.fail(ctx, ErrorCode.INVALID_RECORDED_ATTACHMENT);
	const [previous] = (await Database`SELECT * FROM recorded_invoice_attachments WHERE recorded_invoice = ${record.uuid}`) as RecordedInvoiceAttachmentRow[];
	if (!(await hasStorageCapacity(project.uuid, bytes.length, previous?.byte_size ?? 0))) return Utils.fail(ctx, ErrorCode.STORAGE_LIMIT_REACHED);
	const key = `recorded-invoices/${project.uuid}/${record.uuid}/${crypto.randomUUID()}`;
	await documentStorage().put(key, bytes, type);
	const value = { file_name: name, content_type: type, byte_size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), created: Date.now() };
	await Database.begin(async (tx) => {
		await tx`DELETE FROM recorded_invoice_attachments WHERE recorded_invoice = ${record.uuid}`;
		await tx`
			INSERT INTO recorded_invoice_attachments(recorded_invoice, storage_key, file_name, content_type, byte_size, sha256, created)
			VALUES(${record.uuid}, ${key}, ${value.file_name}, ${value.content_type}, ${value.byte_size}, ${value.sha256}, ${value.created})
		`;
	});
	if (previous) await documentStorage().remove(previous.storage_key);
	await audit(ctx, "recorded_invoice.attachment_updated", record.uuid, value, previous);
	return Utils.ok(ctx, value);
});

Server.app.get(`${base}/:record/attachment`, Auth.required(), Permissions.require(Permission.REPORT_VIEW), async (ctx) => {
	const [attachment] = (await Database`
		SELECT a.* FROM recorded_invoice_attachments a JOIN recorded_invoices r ON r.uuid = a.recorded_invoice
		WHERE a.recorded_invoice = ${ctx.params.record} AND r.project = ${Permissions.project(ctx).uuid}
	`) as RecordedInvoiceAttachmentRow[];
	if (!attachment) return Utils.fail(ctx, ErrorCode.RECORDED_ATTACHMENT_NOT_FOUND);
	const bytes = await documentStorage().get(attachment.storage_key);
	const fallback = attachment.file_name.replace(/[^A-Za-z0-9._-]/g, "_") || "attachment";
	return new Response(bytes, {
		headers: {
			"Content-Type": attachment.content_type,
			"Content-Length": String(bytes.length),
			"Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(attachment.file_name)}`,
			"X-Content-Type-Options": "nosniff",
		},
	});
});

Server.app.delete(`${base}/:record/attachment`, Auth.required(), Permissions.require(Permission.LEDGER_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	if (!accountingActive(project)) return Utils.fail(ctx, ErrorCode.ACCOUNTING_LICENSE_REQUIRED);
	const record = await loadRecordedInvoice(project.uuid, ctx.params.record);
	if (!record) return Utils.fail(ctx, ErrorCode.RECORDED_INVOICE_NOT_FOUND);
	if ((await accountingPeriodLocked(project.uuid, record.issued_at)) || (await accountingPeriodLocked(project.uuid, record.tax_point_date))) {
		return Utils.fail(ctx, ErrorCode.ACCOUNTING_PERIOD_LOCKED);
	}
	const [attachment] = (await Database`SELECT * FROM recorded_invoice_attachments WHERE recorded_invoice = ${record.uuid}`) as RecordedInvoiceAttachmentRow[];
	if (!attachment) return Utils.fail(ctx, ErrorCode.RECORDED_ATTACHMENT_NOT_FOUND);
	await Database`DELETE FROM recorded_invoice_attachments WHERE recorded_invoice = ${record.uuid}`;
	await documentStorage().remove(attachment.storage_key);
	await audit(ctx, "recorded_invoice.attachment_removed", record.uuid, undefined, attachment);
	return Utils.ok(ctx);
});
