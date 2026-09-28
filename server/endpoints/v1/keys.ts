import { Server } from "../../server";
import Database from "../../database/database";
import { integerFields } from "../../database/numbers";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { Permission } from "../../roles";
import Validate from "../../validate";

interface RotateBody {
	slot?: "primary" | "secondary";
}

interface WebhookUrlBody {
	url?: string | null;
}

Server.app.get("/api/v1/projects/:uuid/keys", Auth.required(), Permissions.require(Permission.API_KEYS), async (ctx) => {
	const project = Permissions.project(ctx);

	return Utils.ok(ctx, {
		primary: Utils.maskSecret(project.apikey),
		secondary: Utils.maskSecret(project.apikey2),
		webhook_secret: project.webhook_secret ? Utils.maskSecret(project.webhook_secret) : null,
		updated: project.updated,
	});
});

Server.app.post("/api/v1/projects/:uuid/keys/webhook-secret", Auth.required(), Permissions.require(Permission.API_WEBHOOKS), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	const replacement = Utils.generateRandomText(64);
	await Database`UPDATE projects SET webhook_secret = ${replacement}, updated = ${Date.now()} WHERE uuid = ${project.uuid}`;

	await Audit.record(ctx, {
		project: project.uuid,
		action: "project.webhook_secret.rotated",
		entityType: "project",
		entityId: project.uuid,
	});
	Logger.audit(`[KEYS] Rotated webhook secret for project ${project.uuid} by ${account.username}`);

	return Utils.ok(ctx, { webhook_secret: replacement, info: "Store this secret now, it will not be shown in full again." });
});

Server.app.put("/api/v1/projects/:uuid/webhook-url", Auth.required(), Permissions.require(Permission.API_WEBHOOKS), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	let data: WebhookUrlBody;
	try {
		data = await ctx.body<WebhookUrlBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (data?.url === undefined) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	const url = typeof data.url === "string" && data.url.trim() !== "" ? data.url.trim() : null;
	if (data.url !== null && typeof data.url !== "string") return Utils.fail(ctx, ErrorCode.INVALID_WEBHOOK_URL);
	if (url !== null && !Validate.webhookUrl(url)) return Utils.fail(ctx, ErrorCode.INVALID_WEBHOOK_URL);

	await Database`UPDATE projects SET webhook_url = ${url}, updated = ${Date.now()} WHERE uuid = ${project.uuid}`;

	await Audit.record(ctx, {
		project: project.uuid,
		action: "project.webhook_url.updated",
		entityType: "project",
		entityId: project.uuid,
		oldValue: { webhook_url: project.webhook_url },
		newValue: { webhook_url: url },
	});
	Logger.audit(`[KEYS] ${account.username} set the webhook URL for project ${project.uuid}`);

	return Utils.ok(ctx, { webhook_url: url });
});

Server.app.get("/api/v1/projects/:uuid/webhooks", Auth.required(), Permissions.require(Permission.API_WEBHOOKS), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();

	const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);

	const deliveries = (await Database`
		SELECT uuid, event_type, target_url, status, attempts, response_status, last_error, next_attempt_at, created, delivered_at
		FROM webhook_deliveries WHERE project = ${project.uuid} ORDER BY created DESC, uuid ASC LIMIT ${limit} OFFSET ${offset}
	`) as Record<string, unknown>[];

	const [counts] = (await Database`
		SELECT
			COUNT(*) AS total,
			COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
			COALESCE(SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered,
			COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
		FROM webhook_deliveries WHERE project = ${project.uuid}
	`) as Record<string, number>[];

	const { total, ...deliveryCounts } = integerFields([counts], "total", "pending", "delivered", "failed")[0];
	return Utils.ok(ctx, { deliveries, counts: deliveryCounts, total: Number(total), limit, offset });
});

Server.app.post("/api/v1/projects/:uuid/keys/rotate", Auth.required(), Permissions.require(Permission.API_KEYS), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	let data: RotateBody;
	try {
		data = await ctx.body<RotateBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const slot = data.slot ?? "primary";
	if (slot !== "primary" && slot !== "secondary") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	const replacement = Utils.generateRandomText(128);
	const timestamp = Date.now();

	if (slot === "primary") {
		await Database`UPDATE projects SET apikey = ${replacement}, updated = ${timestamp} WHERE uuid = ${project.uuid}`;
	} else {
		await Database`UPDATE projects SET apikey2 = ${replacement}, updated = ${timestamp} WHERE uuid = ${project.uuid}`;
	}

	await Audit.record(ctx, {
		project: project.uuid,
		action: "project.apikey.rotated",
		entityType: "project",
		entityId: project.uuid,
		newValue: { slot },
	});
	Logger.audit(`[KEYS] Rotated ${slot} API key for project ${project.uuid} by ${account.username}`);

	return Utils.ok(ctx, {
		slot,
		key: replacement,
		info: "Store this key now, it will not be shown in full again.",
	});
});
