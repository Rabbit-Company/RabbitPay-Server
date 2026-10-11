import { Server } from "../../server";
import Auth from "../../auth";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { Realtime } from "../../realtime";
import { isNotificationChannel, isNotificationKind } from "../../notifications/kinds";
import { canReceiveEmail, changeable, preferencesOf, resetPreferences, savePreferences, type PreferenceChange } from "../../notifications/preferences";
import { forgetPushEndpoint, pushDevices, pushKeys, removePushDevice, removePushSubscription, savePushSubscription } from "../../notifications/push";
import { rateLimit } from "@rabbit-company/web-middleware/rate-limit";
import { onChatMessage } from "../../workforce/chat";
import { pushChatMessage } from "../../workforce/notifications";

const path = "/api/v1/auth/notifications";
const pushPath = "/api/v1/auth/push";
const forgetPath = "/api/v1/push/forget";
const forgetLimit = rateLimit({ windowMs: 60 * 1000, max: 30, message: "Too many requests. Please slow down." });
const MAX_CHANGES = 100;
export const PREFERENCES_CHANGED_EVENT = "notifications.changed";

function readChanges(value: unknown): PreferenceChange[] | null {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHANGES) return null;
	const changes: PreferenceChange[] = [];
	for (const entry of value as Record<string, unknown>[]) {
		if (entry === null || typeof entry !== "object") return null;
		const { kind, channel, enabled } = entry;
		if (!isNotificationKind(kind) || !isNotificationChannel(channel) || typeof enabled !== "boolean" || !changeable(kind, channel)) return null;
		changes.push({ kind, channel, enabled });
	}
	return changes;
}

async function presented(username: string) {
	return { preferences: await preferencesOf(username), email_ready: await canReceiveEmail(username) };
}

async function respond(ctx: Parameters<typeof Auth.account>[0]) {
	const username = Auth.account(ctx).username;
	Realtime.send([username], { type: PREFERENCES_CHANGED_EVENT });
	return Utils.ok(ctx, await presented(username));
}

Server.app.get(path, Auth.required(), async (ctx) => {
	return Utils.ok(ctx, await presented(Auth.account(ctx).username));
});

Server.app.patch(path, Auth.required(), async (ctx) => {
	const data = await ctx.body<{ changes?: unknown }>().catch(() => null);
	const changes = readChanges(data?.changes);
	if (changes === null) return Utils.fail(ctx, ErrorCode.INVALID_NOTIFICATION_PREFERENCE);
	await savePreferences(Auth.account(ctx).username, changes);
	return await respond(ctx);
});

Server.app.delete(path, Auth.required(), async (ctx) => {
	await resetPreferences(Auth.account(ctx).username);
	return await respond(ctx);
});

onChatMessage(pushChatMessage);

Server.app.get(pushPath, Auth.required(), async (ctx) => {
	return Utils.ok(ctx, { public_key: (await pushKeys()).publicKey, devices: await pushDevices(Auth.account(ctx).username) });
});

Server.app.put(pushPath, Auth.required(), async (ctx) => {
	const data = await ctx.body<{ endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; language?: unknown }>().catch(() => null);
	const saved = await savePushSubscription(Auth.account(ctx).username, {
		endpoint: data?.endpoint,
		p256dh: data?.keys?.p256dh,
		auth: data?.keys?.auth,
		language: data?.language,
		userAgent: ctx.req.headers.get("user-agent"),
	});
	return saved ? Utils.ok(ctx) : Utils.fail(ctx, ErrorCode.INVALID_PUSH_SUBSCRIPTION);
});

Server.app.delete(pushPath, Auth.required(), async (ctx) => {
	const data = await ctx.body<{ endpoint?: unknown; device?: unknown }>().catch(() => null);
	const username = Auth.account(ctx).username;
	await removePushSubscription(username, data?.endpoint);
	await removePushDevice(username, data?.device);
	return Utils.ok(ctx, { devices: await pushDevices(username) });
});

Server.app.post(forgetPath, forgetLimit, async (ctx) => {
	const data = await ctx.body<{ endpoint?: unknown }>().catch(() => null);
	await forgetPushEndpoint(data?.endpoint);
	return Utils.ok(ctx);
});
