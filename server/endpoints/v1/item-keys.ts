import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { Permission } from "../../roles";
import { loadInvoice } from "../../invoice-service";
import { canEmail } from "../../email/mailer";
import { deliverSoon } from "../../email/outbox";
import { emailCount, findEmail, prepareKeysEmail, queueKeysEmail } from "../../email/messages";
import { groupKeys, heldKeysOf, recipientFor } from "../../key-delivery";
import { emptyStock, parseKeys, presentKey, stockFor } from "../../item-keys";
import type { CatalogItemRow, ItemKeyRow, ItemKeyStatus } from "../../database/models";

interface KeysBody {
	keys?: string | string[];
}

interface KeysEmailBody {
	to?: string | null;
}

const KEY_STATUSES: ItemKeyStatus[] = ["available", "reserved", "delivered"];
const MAX_KEY_EMAILS = 10;

async function findKeyItem(projectId: string, itemId: string): Promise<CatalogItemRow | undefined> {
	const [item] = (await Database`SELECT * FROM catalog_items WHERE uuid = ${itemId} AND project = ${projectId}`) as CatalogItemRow[];
	return item;
}

Server.app.get("/api/v1/projects/:uuid/items/:item/keys", Auth.required(), Permissions.require(Permission.ITEM_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();

	const itemId = ctx.params["item"];
	if (!Validate.uuid(itemId)) return Utils.fail(ctx, ErrorCode.INVALID_ITEM_ID);

	const item = await findKeyItem(project.uuid, itemId);
	if (!item) return Utils.fail(ctx, ErrorCode.ITEM_NOT_FOUND);

	const limit = Math.min(Math.max(Number(query.get("limit")) || 200, 1), 1000);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);
	const status = query.get("status");
	if (status !== null && !KEY_STATUSES.includes(status as ItemKeyStatus)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	const statusFilter = status === null ? Database`` : Database`AND k.status = ${status}`;

	const keys = (await Database`
		SELECT k.*, i.reference AS invoice_reference FROM item_keys k LEFT JOIN invoices i ON i.uuid = k.invoice
		WHERE k.item = ${itemId} ${statusFilter}
		ORDER BY k.sequence ASC, k.uuid ASC LIMIT ${limit} OFFSET ${offset}
	`) as (ItemKeyRow & { invoice_reference: string | null })[];

	const [counted] = (await Database`SELECT COUNT(*) AS count FROM item_keys k WHERE k.item = ${itemId} ${statusFilter}`) as { count: number }[];

	return Utils.ok(ctx, {
		total: Number(counted.count),
		keys: keys.map((key) => ({ ...presentKey(key), invoice_reference: key.invoice_reference })),
		stock: (await stockFor(project.uuid, [itemId])).get(itemId) ?? emptyStock(),
		limit,
		offset,
	});
});

Server.app.post("/api/v1/projects/:uuid/items/:item/keys", Auth.required(), Permissions.require(Permission.ITEM_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	const itemId = ctx.params["item"];
	if (!Validate.uuid(itemId)) return Utils.fail(ctx, ErrorCode.INVALID_ITEM_ID);

	const item = await findKeyItem(project.uuid, itemId);
	if (!item) return Utils.fail(ctx, ErrorCode.ITEM_NOT_FOUND);

	let data: KeysBody;
	try {
		data = await ctx.body<KeysBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const parsed = parseKeys(data.keys);
	if (parsed === null || parsed.length === 0) return Utils.fail(ctx, ErrorCode.INVALID_ITEM_KEYS);

	const existing = new Set(((await Database`SELECT secret FROM item_keys WHERE item = ${itemId}`) as { secret: string }[]).map((row) => row.secret));
	const fresh = parsed.filter((secret) => !existing.has(secret));
	const timestamp = Date.now();

	await Database.begin(async (tx) => {
		const [last] = (await tx`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM item_keys WHERE item = ${itemId}`) as { sequence: number }[];

		for (let index = 0; index < fresh.length; index++) {
			await tx`
				INSERT INTO item_keys(uuid, project, item, secret, sequence, status, created, created_by)
				VALUES(${crypto.randomUUID()}, ${project.uuid}, ${itemId}, ${fresh[index]}, ${Number(last.sequence) + index + 1}, 'available',
					${timestamp}, ${account.username})
			`;
		}

		if (!item.delivers_keys) await tx`UPDATE catalog_items SET delivers_keys = 1, updated = ${timestamp} WHERE uuid = ${itemId}`;
	});

	await Audit.record(ctx, {
		project: project.uuid,
		action: "item.keys_added",
		entityType: "item",
		entityId: itemId,
		newValue: { name: item.name, added: fresh.length, duplicates: parsed.length - fresh.length },
	});
	Logger.audit(`[KEYS] ${account.username} added ${fresh.length} keys to ${item.name} on ${project.uuid}`);

	return Utils.ok(
		ctx,
		{
			added: fresh.length,
			duplicates: parsed.length - fresh.length,
			stock: (await stockFor(project.uuid, [itemId])).get(itemId) ?? emptyStock(),
		},
		201
	);
});

Server.app.delete("/api/v1/projects/:uuid/items/:item/keys/:key", Auth.required(), Permissions.require(Permission.ITEM_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	const itemId = ctx.params["item"];
	const keyId = ctx.params["key"];
	if (!Validate.uuid(itemId)) return Utils.fail(ctx, ErrorCode.INVALID_ITEM_ID);
	if (!Validate.uuid(keyId)) return Utils.fail(ctx, ErrorCode.ITEM_KEY_NOT_FOUND);

	const [key] = (await Database`
		SELECT * FROM item_keys WHERE uuid = ${keyId} AND item = ${itemId} AND project = ${project.uuid}
	`) as ItemKeyRow[];
	if (!key) return Utils.fail(ctx, ErrorCode.ITEM_KEY_NOT_FOUND);
	if (key.status !== "available") return Utils.fail(ctx, ErrorCode.ITEM_KEY_IN_USE);

	await Database`DELETE FROM item_keys WHERE uuid = ${keyId} AND status = 'available'`;

	await Audit.record(ctx, {
		project: project.uuid,
		action: "item.key_removed",
		entityType: "item",
		entityId: itemId,
		oldValue: { key: keyId },
	});
	Logger.audit(`[KEYS] ${account.username} removed a key from ${itemId} on ${project.uuid}`);

	return Utils.ok(ctx, { stock: (await stockFor(project.uuid, [itemId])).get(itemId) ?? emptyStock() });
});

Server.app.get("/api/v1/projects/:uuid/invoices/:invoice/keys", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);

	const held = await heldKeysOf(invoiceId, "reserved");
	const delivered = await heldKeysOf(invoiceId, "delivered");

	return Utils.ok(ctx, {
		reserved: held.map((key) => ({ ...presentKey(key), item_name: key.item_name })),
		delivered: delivered.map((key) => ({ ...presentKey(key), item_name: key.item_name })),
	});
});

Server.app.post("/api/v1/projects/:uuid/invoices/:invoice/keys/email", Auth.required(), Permissions.require(Permission.INVOICE_SEND), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	if (!canEmail(project)) return Utils.fail(ctx, ErrorCode.EMAIL_NOT_CONFIGURED);

	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const invoice = await loadInvoice(project.uuid, invoiceId);
	if (!invoice) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);

	let data: KeysEmailBody;
	try {
		data = (await ctx.body<KeysEmailBody>()) ?? {};
	} catch {
		data = {};
	}

	const delivered = await heldKeysOf(invoiceId, "delivered");
	if (delivered.length === 0) return Utils.fail(ctx, ErrorCode.ITEM_KEY_NOT_FOUND);
	if ((await emailCount(invoiceId, ["keys"])) >= MAX_KEY_EMAILS) return Utils.fail(ctx, ErrorCode.EMAIL_LIMIT_REACHED);

	const recipient = typeof data.to === "string" && data.to.trim() !== "" ? data.to.trim() : ((await recipientFor(invoice)) ?? "");
	if (!recipient) return Utils.fail(ctx, ErrorCode.EMAIL_RECIPIENT_MISSING);
	if (!Validate.email(recipient)) return Utils.fail(ctx, ErrorCode.INVALID_EMAIL);

	const prepared = await prepareKeysEmail(project, invoice, groupKeys(delivered));
	const uuid = await queueKeysEmail(Database, project, invoice, { prepared, to: recipient, sentBy: account.username });
	deliverSoon();

	await Audit.record(ctx, {
		project: project.uuid,
		action: "invoice.keys_emailed",
		entityType: "invoice",
		entityId: invoiceId,
		newValue: { reference: invoice.reference, recipient, keys: delivered.length },
	});
	Logger.audit(`[KEYS] ${account.username} emailed ${delivered.length} keys for ${invoice.reference} to ${recipient}`);

	return Utils.ok(ctx, await findEmail(uuid), 201);
});
