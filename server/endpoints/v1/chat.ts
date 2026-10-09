import type { Context } from "@rabbit-company/web";
import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import Vault from "../../crypto/vault";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { Realtime } from "../../realtime";
import { hasFileStorageCapacity } from "../../licensing";
import { bodyLimit } from "@rabbit-company/web-middleware/body-limit";
import {
	acceptsAppendedPart,
	appendPart,
	beginOpenUpload,
	beginUpload,
	fileSizeCeiling,
	findFile,
	removeFile,
	maxFileBytes,
	presentFile,
	readFileRequest,
} from "../../files";
import { FILE_PART_BYTES } from "../../file-limits";
import { rateLimit } from "@rabbit-company/web-middleware/rate-limit";
import { displayNameOf } from "../../company";
import { workforceActive } from "../../licensing";
import { memberHasRoom } from "../../file-explorer";
import { requireWorkforce } from "../../workforce/access";
import { personName } from "../../workforce/people";
import {
	addParticipants,
	chatPeople,
	directKey,
	announceFileChange,
	findConversation,
	finishRecording,
	stampRecordingDuration,
	insertMessage,
	MAX_GROUP_PEOPLE,
	meetingByGuestToken,
	newGuestToken,
	readMeetingTimes,
	MAX_MESSAGE_PAGE,
	MESSAGE_PAGE,
	notify,
	presentConversation,
	presentConversations,
	presentMessageById,
	presentMessages,
	readAccounts,
	readFileIds,
	readGroupName,
	readMessageBody,
	recipientsOf,
	removeMessageFiles,
	removeParticipant,
	stagedFiles,
	unreadTotal,
} from "../../workforce/chat";
import { Calls, CLIENT_FORMAT, GroupCalls, iceServers } from "../../workforce/calls";
import { mediaNodes } from "../../workforce/media-nodes";
import { Settings } from "../../settings";
import { accountNames } from "../../accounts";
import type { AppState, ChatConversationRow, ChatMeetingRow, ChatMessageRow, ChatParticipantRow, ProjectFileRow, ProjectRow } from "../../database/models";

const base = "/api/v1/projects/:uuid/chat";
const chat = [Auth.required(), Permissions.require(Permission.CHAT_USE), requireWorkforce()] as const;

async function body(ctx: Context<AppState>): Promise<Record<string, unknown> | null> {
	try {
		const value = await ctx.body<Record<string, unknown>>();
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

async function audit(ctx: Context<AppState>, action: string, entityId: string, value?: unknown) {
	await Audit.record(ctx, { project: Permissions.project(ctx).uuid, action, entityType: "conversation", entityId, newValue: value });
}

async function joined(ctx: Context<AppState>): Promise<{ conversation: ChatConversationRow; participant: ChatParticipantRow } | null> {
	if (!Validate.uuid(ctx.params.conversation)) return null;
	return await findConversation(Permissions.project(ctx).uuid, ctx.params.conversation, Auth.account(ctx).username);
}

async function requestedMessage(ctx: Context<AppState>, conversation: ChatConversationRow): Promise<ChatMessageRow | null> {
	if (!Validate.uuid(ctx.params.message)) return null;
	const [message] = (await Database`
		SELECT * FROM chat_messages WHERE uuid = ${ctx.params.message} AND conversation = ${conversation.uuid}
	`) as ChatMessageRow[];
	return message ?? null;
}

async function allChatPeople(projectId: string, accounts: string[]): Promise<boolean> {
	const allowed = new Set((await chatPeople(projectId)).map((person) => person.account));
	return accounts.every((account) => allowed.has(account));
}

Server.app.get(`${base}/people`, ...chat, async (ctx) => {
	return Utils.ok(ctx, { people: await chatPeople(Permissions.project(ctx).uuid) });
});

Server.app.get(`${base}/unread`, ...chat, async (ctx) => {
	return Utils.ok(ctx, await unreadTotal(Permissions.project(ctx).uuid, Auth.account(ctx).username));
});

Server.app.get(`${base}/conversations`, ...chat, async (ctx) => {
	const project = Permissions.project(ctx);
	const username = Auth.account(ctx).username;
	const conversations = (await Database`
		SELECT c.* FROM chat_conversations c JOIN chat_participants cp ON cp.conversation = c.uuid AND cp.account = ${username}
		WHERE c.project = ${project.uuid} ORDER BY COALESCE(c.last_message_at, c.created) DESC, c.uuid ASC
	`) as ChatConversationRow[];
	return Utils.ok(ctx, {
		conversations: await presentConversations(project.uuid, conversations, username),
		max_file_bytes: maxFileBytes(project),
		group_calls: mediaNodes().length > 0,
	});
});

Server.app.post(`${base}/conversations`, ...chat, async (ctx) => {
	const project = Permissions.project(ctx);
	const username = Auth.account(ctx).username;
	const data = await body(ctx);
	if (!data) return Utils.fail(ctx, ErrorCode.INVALID_CONVERSATION);
	const now = Date.now();

	if (data.kind === "direct") {
		const other = data.account;
		if (typeof other !== "string" || other === username) return Utils.fail(ctx, ErrorCode.INVALID_CONVERSATION);
		if (!(await allChatPeople(project.uuid, [other]))) return Utils.fail(ctx, ErrorCode.CHAT_MEMBER_NOT_FOUND);

		const key = await directKey(project.uuid, username, other);
		const existing = async () => ((await Database`SELECT * FROM chat_conversations WHERE direct_key = ${key}`) as ChatConversationRow[])[0];
		let conversation = await existing();
		const created = !conversation;
		if (!conversation) {
			const uuid = crypto.randomUUID();
			try {
				await Database.begin(async (tx) => {
					await tx`
						INSERT INTO chat_conversations(uuid, project, kind, direct_key, created_by, created, updated)
						VALUES(${uuid}, ${project.uuid}, 'direct', ${key}, ${username}, ${now}, ${now})
					`;
					await addParticipants(tx, uuid, [username, other], false, 0);
				});
			} catch (error) {
				if (!(await existing())) throw error;
			}
			conversation = await existing();
		}
		if (created) await notify(conversation, { type: "chat.conversation" });
		return Utils.ok(ctx, await presentConversation(conversation, username), created ? 201 : 200);
	}

	if (data.kind !== "group") return Utils.fail(ctx, ErrorCode.INVALID_CONVERSATION);
	const name = readGroupName(data.name);
	const accounts = readAccounts(data.accounts)?.filter((account) => account !== username);
	if (name === null || !accounts || accounts.length === 0 || accounts.length >= MAX_GROUP_PEOPLE) return Utils.fail(ctx, ErrorCode.INVALID_CONVERSATION);
	if (!(await allChatPeople(project.uuid, accounts))) return Utils.fail(ctx, ErrorCode.CHAT_MEMBER_NOT_FOUND);

	const uuid = crypto.randomUUID();
	await Database.begin(async (tx) => {
		await tx`
			INSERT INTO chat_conversations(uuid, project, kind, name, created_by, created, updated)
			VALUES(${uuid}, ${project.uuid}, 'group', ${name}, ${username}, ${now}, ${now})
		`;
		await addParticipants(tx, uuid, [username], true, 0);
		await addParticipants(tx, uuid, accounts, false, 0);
	});
	const [conversation] = (await Database`SELECT * FROM chat_conversations WHERE uuid = ${uuid}`) as ChatConversationRow[];
	await audit(ctx, "chat.group_created", uuid, { name, accounts });
	await notify(conversation, { type: "chat.conversation" });
	return Utils.ok(ctx, await presentConversation(conversation, username), 201);
});

Server.app.get(`${base}/conversations/:conversation`, ...chat, async (ctx) => {
	const found = await joined(ctx);
	if (!found) return Utils.fail(ctx, ErrorCode.CONVERSATION_NOT_FOUND);
	return Utils.ok(ctx, await presentConversation(found.conversation, Auth.account(ctx).username));
});

Server.app.patch(`${base}/conversations/:conversation`, ...chat, async (ctx) => {
	const found = await joined(ctx);
	if (!found) return Utils.fail(ctx, ErrorCode.CONVERSATION_NOT_FOUND);
	if (found.conversation.kind !== "group") return Utils.fail(ctx, ErrorCode.INVALID_CONVERSATION);
	if (!found.participant.admin) return Utils.fail(ctx, ErrorCode.CONVERSATION_ADMIN_REQUIRED);
	const name = readGroupName((await body(ctx))?.name);
	if (name === null) return Utils.fail(ctx, ErrorCode.INVALID_CONVERSATION);

	await Database`UPDATE chat_conversations SET name = ${name}, updated = ${Date.now()} WHERE uuid = ${found.conversation.uuid}`;
	await audit(ctx, "chat.group_renamed", found.conversation.uuid, { name });
	await notify(found.conversation, { type: "chat.conversation" });
	return Utils.ok(ctx, await presentConversation(found.conversation, Auth.account(ctx).username));
});

Server.app.post(`${base}/conversations/:conversation/participants`, ...chat, async (ctx) => {
	const found = await joined(ctx);
	if (!found) return Utils.fail(ctx, ErrorCode.CONVERSATION_NOT_FOUND);
	if (found.conversation.kind !== "group") return Utils.fail(ctx, ErrorCode.INVALID_CONVERSATION);
	if (!found.participant.admin) return Utils.fail(ctx, ErrorCode.CONVERSATION_ADMIN_REQUIRED);
	const accounts = readAccounts((await body(ctx))?.accounts);
	if (!accounts || accounts.length === 0) return Utils.fail(ctx, ErrorCode.INVALID_CONVERSATION);
	if (!(await allChatPeople(Permissions.project(ctx).uuid, accounts))) return Utils.fail(ctx, ErrorCode.CHAT_MEMBER_NOT_FOUND);

	const current = (await Database`SELECT account FROM chat_participants WHERE conversation = ${found.conversation.uuid}`) as { account: string }[];
	const present = new Set(current.map((participant) => participant.account));
	const added = accounts.filter((account) => !present.has(account));
	if (present.size + added.length > MAX_GROUP_PEOPLE) return Utils.fail(ctx, ErrorCode.INVALID_CONVERSATION);

	await Database.begin(async (tx) => {
		const [{ last_number }] = (await tx`SELECT last_number FROM chat_conversations WHERE uuid = ${found.conversation.uuid}`) as { last_number: number }[];
		await addParticipants(tx, found.conversation.uuid, added, false, Number(last_number));
		await tx`UPDATE chat_conversations SET updated = ${Date.now()} WHERE uuid = ${found.conversation.uuid}`;
	});
	if (added.length > 0) {
		await audit(ctx, "chat.group_people_added", found.conversation.uuid, { accounts: added });
		await notify(found.conversation, { type: "chat.conversation" });
	}
	return Utils.ok(ctx, await presentConversation(found.conversation, Auth.account(ctx).username));
});

Server.app.delete(`${base}/conversations/:conversation/participants/:account`, ...chat, async (ctx) => {
	const found = await joined(ctx);
	if (!found) return Utils.fail(ctx, ErrorCode.CONVERSATION_NOT_FOUND);
	if (found.conversation.kind !== "group") return Utils.fail(ctx, ErrorCode.INVALID_CONVERSATION);
	const username = Auth.account(ctx).username;
	const account = ctx.params.account;
	if (account !== username && !found.participant.admin) return Utils.fail(ctx, ErrorCode.CONVERSATION_ADMIN_REQUIRED);
	const [target] = await Database`SELECT account FROM chat_participants WHERE conversation = ${found.conversation.uuid} AND account = ${account}`;
	if (!target) return Utils.fail(ctx, ErrorCode.CHAT_MEMBER_NOT_FOUND);

	const before = await recipientsOf(found.conversation);
	const outcome = await removeParticipant(found.conversation, account);
	await audit(ctx, account === username ? "chat.group_left" : "chat.group_person_removed", found.conversation.uuid, { account });
	Realtime.send(before, { type: "chat.conversation", project: found.conversation.project, conversation: found.conversation.uuid });
	return Utils.ok(ctx, { closed: outcome === "closed" });
});

Server.app.get(`${base}/conversations/:conversation/messages`, ...chat, async (ctx) => {
	const found = await joined(ctx);
	if (!found) return Utils.fail(ctx, ErrorCode.CONVERSATION_NOT_FOUND);
	const query = ctx.query();
	const limit = Math.min(Math.max(Number(query.get("limit")) || MESSAGE_PAGE, 1), MAX_MESSAGE_PAGE);
	const before = Number(query.get("before"));
	const beforeFilter = Number.isSafeInteger(before) && before > 0 ? Database`AND number < ${before}` : Database``;

	const rows = (await Database`
		SELECT * FROM chat_messages WHERE conversation = ${found.conversation.uuid} ${beforeFilter} ORDER BY number DESC LIMIT ${limit + 1}
	`) as ChatMessageRow[];
	const page = rows.slice(0, limit).reverse();
	return Utils.ok(ctx, { messages: await presentMessages(found.conversation.project, page), has_more: rows.length > limit });
});

Server.app.post(`${base}/conversations/:conversation/files`, ...chat, async (ctx) => {
	const project = Permissions.project(ctx);
	const found = await joined(ctx);
	if (!found) return Utils.fail(ctx, ErrorCode.CONVERSATION_NOT_FOUND);
	const request = readFileRequest(await body(ctx));
	if (!request) return Utils.fail(ctx, ErrorCode.INVALID_FILE);
	if (request.size > maxFileBytes(project)) return Utils.fail(ctx, ErrorCode.FILE_TOO_LARGE);
	if (!(await hasFileStorageCapacity(project.uuid, request.size))) return Utils.fail(ctx, ErrorCode.FILE_STORAGE_LIMIT_REACHED);
	if (!(await memberHasRoom(project, Auth.account(ctx).username, request.size))) return Utils.fail(ctx, ErrorCode.FILE_MEMBER_LIMIT_REACHED);

	const file = await beginUpload(project.uuid, request, Auth.account(ctx).username);
	await Database`INSERT INTO chat_files(file, conversation, created) VALUES(${file.uuid}, ${found.conversation.uuid}, ${Date.now()})`;
	return Utils.ok(ctx, { ...presentFile(file), parts: Number(file.parts), part_bytes: FILE_PART_BYTES }, 201);
});

Server.app.post(`${base}/conversations/:conversation/messages`, ...chat, async (ctx) => {
	const found = await joined(ctx);
	if (!found) return Utils.fail(ctx, ErrorCode.CONVERSATION_NOT_FOUND);
	const data = await body(ctx);
	const username = Auth.account(ctx).username;
	const fileIds = readFileIds(data?.files);
	if (fileIds === null || fileIds.some((file) => !Validate.uuid(file))) return Utils.fail(ctx, ErrorCode.INVALID_CHAT_MESSAGE);
	const text = readMessageBody(data?.body, fileIds.length > 0);
	if (text === null) return Utils.fail(ctx, ErrorCode.INVALID_CHAT_MESSAGE);
	if ((await stagedFiles(found.conversation.uuid, username, fileIds)) === null) return Utils.fail(ctx, ErrorCode.FILE_NOT_FOUND);

	const inserted = await insertMessage(found.conversation, { username, name: personName(Permissions.member(ctx)) }, text, fileIds);
	const message = (await presentMessageById(found.conversation.project, inserted.uuid))!;
	await notify(found.conversation, { type: "chat.message", message });
	return Utils.ok(ctx, message, 201);
});

Server.app.patch(`${base}/conversations/:conversation/messages/:message`, ...chat, async (ctx) => {
	const found = await joined(ctx);
	if (!found) return Utils.fail(ctx, ErrorCode.CONVERSATION_NOT_FOUND);
	const message = await requestedMessage(ctx, found.conversation);
	if (!message || message.deleted_at !== null || message.call_outcome !== null) return Utils.fail(ctx, ErrorCode.CHAT_MESSAGE_NOT_FOUND);
	if (message.author !== Auth.account(ctx).username) return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);
	const [attached] = await Database`SELECT file FROM chat_files WHERE message = ${message.uuid} LIMIT 1`;
	const text = readMessageBody((await body(ctx))?.body ?? null, attached !== undefined);
	if (text === null) return Utils.fail(ctx, ErrorCode.INVALID_CHAT_MESSAGE);

	await Database`UPDATE chat_messages SET body = ${Vault.encrypt(text)}, edited_at = ${Date.now()} WHERE uuid = ${message.uuid}`;
	const presented = (await presentMessageById(found.conversation.project, message.uuid))!;
	await notify(found.conversation, { type: "chat.message_changed", message: presented });
	return Utils.ok(ctx, presented);
});

Server.app.delete(`${base}/conversations/:conversation/messages/:message`, ...chat, async (ctx) => {
	const found = await joined(ctx);
	if (!found) return Utils.fail(ctx, ErrorCode.CONVERSATION_NOT_FOUND);
	const message = await requestedMessage(ctx, found.conversation);
	if (!message || message.deleted_at !== null || message.call_outcome !== null) return Utils.fail(ctx, ErrorCode.CHAT_MESSAGE_NOT_FOUND);
	const own = message.author === Auth.account(ctx).username;
	const moderates = found.conversation.kind === "group" && Boolean(found.participant.admin);
	if (!own && !moderates) return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);

	await removeMessageFiles(message.uuid, Auth.account(ctx).username);
	await Database`UPDATE chat_messages SET body = NULL, deleted_at = ${Date.now()} WHERE uuid = ${message.uuid}`;
	const presented = (await presentMessageById(found.conversation.project, message.uuid))!;
	await notify(found.conversation, { type: "chat.message_changed", message: presented });
	return Utils.ok(ctx, presented);
});

Server.app.post(`${base}/conversations/:conversation/read`, ...chat, async (ctx) => {
	const found = await joined(ctx);
	if (!found) return Utils.fail(ctx, ErrorCode.CONVERSATION_NOT_FOUND);
	const requested = (await body(ctx))?.number;
	if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 0) return Utils.fail(ctx, ErrorCode.INVALID_CHAT_MESSAGE);

	const username = Auth.account(ctx).username;
	const [fresh] = (await Database`SELECT last_number FROM chat_conversations WHERE uuid = ${found.conversation.uuid}`) as { last_number: number }[];
	const readNumber = Math.max(Number(found.participant.read_number), Math.min(requested, Number(fresh.last_number)));
	await Database`
		UPDATE chat_participants SET read_number = ${readNumber}
		WHERE conversation = ${found.conversation.uuid} AND account = ${username} AND read_number < ${readNumber}
	`;
	Realtime.send([username], { type: "chat.read", project: found.conversation.project, conversation: found.conversation.uuid, read_number: readNumber });
	return Utils.ok(ctx, { read_number: readNumber });
});

Server.app.post(`${base}/conversations/:conversation/calls`, ...chat, async (ctx) => {
	const found = await joined(ctx);
	if (!found) return Utils.fail(ctx, ErrorCode.CONVERSATION_NOT_FOUND);
	const data = await body(ctx);
	const client = data?.client;
	if (found.conversation.kind !== "direct" || typeof client !== "string" || !CLIENT_FORMAT.test(client)) return Utils.fail(ctx, ErrorCode.INVALID_CALL);

	const username = Auth.account(ctx).username;
	const people = await chatPeople(found.conversation.project);
	const [other] = (await Database`
		SELECT account FROM chat_participants WHERE conversation = ${found.conversation.uuid} AND account != ${username}
	`) as { account: string }[];
	const callee = people.find((person) => person.account === other?.account);
	if (!callee) return Utils.fail(ctx, ErrorCode.CHAT_MEMBER_NOT_FOUND);

	const caller = { username, name: personName(Permissions.member(ctx)), client };
	const receiver = { username: callee.account, name: callee.name, client: null };
	const video = data?.video === true;
	const call = await Calls.start(found.conversation, caller, receiver, video);
	if (call === "busy") return Utils.fail(ctx, ErrorCode.CALL_BUSY);
	if (call === "offline") {
		await Calls.recordUnreachable(found.conversation, caller, receiver, video);
		return Utils.fail(ctx, ErrorCode.CALL_PERSON_OFFLINE);
	}
	return Utils.ok(ctx, { call: call.uuid, ice_servers: iceServers(username), ring_seconds: Settings.calls.ring_seconds }, 201);
});

Server.app.post(`${base}/calls/:call/accept`, ...chat, async (ctx) => {
	const client = (await body(ctx))?.client;
	if (typeof client !== "string" || !CLIENT_FORMAT.test(client)) return Utils.fail(ctx, ErrorCode.INVALID_CALL);
	const username = Auth.account(ctx).username;
	const waiting = Calls.find(ctx.params.call);
	if (!waiting || waiting.conversation.project !== Permissions.project(ctx).uuid) return Utils.fail(ctx, ErrorCode.CALL_NOT_FOUND);
	const call = Calls.accept(ctx.params.call, username, client);
	if (!call) return Utils.fail(ctx, ErrorCode.CALL_NOT_FOUND);
	return Utils.ok(ctx, { call: call.uuid, ice_servers: iceServers(username) });
});

Server.app.post(`${base}/calls/:call/end`, ...chat, async (ctx) => {
	const call = Calls.find(ctx.params.call);
	if (!call || call.conversation.project !== Permissions.project(ctx).uuid) return Utils.fail(ctx, ErrorCode.CALL_NOT_FOUND);
	if (!(await Calls.end(call.uuid, Auth.account(ctx).username))) return Utils.fail(ctx, ErrorCode.CALL_NOT_FOUND);
	return Utils.ok(ctx);
});

Server.app.post(`${base}/conversations/:conversation/group-call`, ...chat, async (ctx) => {
	const found = await joined(ctx);
	if (!found) return Utils.fail(ctx, ErrorCode.CONVERSATION_NOT_FOUND);
	if (found.conversation.kind !== "group") return Utils.fail(ctx, ErrorCode.INVALID_CALL);
	const party = { username: Auth.account(ctx).username, name: personName(Permissions.member(ctx)), client: null };
	const result = await GroupCalls.join(found.conversation, party);
	if (result === "unavailable" || result === "closed") return Utils.fail(ctx, ErrorCode.GROUP_CALLS_UNAVAILABLE);
	if (result === "full") return Utils.fail(ctx, ErrorCode.CALL_FULL);
	ctx.header("Cache-Control", "no-store");
	return Utils.ok(ctx, { call: result.call.uuid, url: result.call.node, token: result.token, screen_share: screenShareLimits() });
});

Server.app.post(`${base}/conversations/:conversation/group-call/leave`, ...chat, async (ctx) => {
	const found = await joined(ctx);
	if (!found) return Utils.fail(ctx, ErrorCode.CONVERSATION_NOT_FOUND);
	await GroupCalls.leave(found.conversation.uuid, Auth.account(ctx).username);
	return Utils.ok(ctx);
});

const guestLimit = rateLimit({ windowMs: 60 * 1000, max: 30, message: "Too many requests. Please slow down." });
const GUEST_ID = /^[A-Za-z0-9]{24}$/;
const MAX_GUEST_NAME_LENGTH = 60;

async function meetingOf(conversation: string): Promise<ChatMeetingRow | null> {
	const [meeting] = (await Database`SELECT * FROM chat_meetings WHERE conversation = ${conversation}`) as ChatMeetingRow[];
	return meeting ?? null;
}

function guestUrl(token: string): string {
	return `${Utils.publicUrl()}/meet/${token}`;
}

Server.app.post(`${base}/meetings`, ...chat, async (ctx) => {
	const project = Permissions.project(ctx);
	const username = Auth.account(ctx).username;
	const data = await body(ctx);
	const name = readGroupName(data?.title);
	const times = data ? readMeetingTimes(data) : null;
	const accounts = readAccounts(data?.accounts ?? [])?.filter((account) => account !== username);
	if (name === null || times === null || !accounts || accounts.length >= MAX_GROUP_PEOPLE) return Utils.fail(ctx, ErrorCode.INVALID_MEETING);
	if (!(await allChatPeople(project.uuid, accounts))) return Utils.fail(ctx, ErrorCode.CHAT_MEMBER_NOT_FOUND);

	const uuid = crypto.randomUUID();
	const now = Date.now();
	const guest = data?.guests === true ? await newGuestToken() : null;
	await Database.begin(async (tx) => {
		await tx`
			INSERT INTO chat_conversations(uuid, project, kind, name, created_by, created, updated)
			VALUES(${uuid}, ${project.uuid}, 'group', ${name}, ${username}, ${now}, ${now})
		`;
		await addParticipants(tx, uuid, [username], true, 0);
		await addParticipants(tx, uuid, accounts, false, 0);
		await tx`
			INSERT INTO chat_meetings(conversation, starts_at, duration_minutes, guest_token, guest_token_hash, created, updated)
			VALUES(${uuid}, ${times.starts_at}, ${times.duration_minutes}, ${guest?.sealed ?? null}, ${guest?.hash ?? null}, ${now}, ${now})
		`;
	});
	const [conversation] = (await Database`SELECT * FROM chat_conversations WHERE uuid = ${uuid}`) as ChatConversationRow[];
	await audit(ctx, "chat.meeting_scheduled", uuid, { name, accounts, ...times, guests: guest !== null });
	await notify(conversation, { type: "chat.conversation" });
	return Utils.ok(ctx, await presentConversation(conversation, username), 201);
});

Server.app.patch(`${base}/conversations/:conversation/meeting`, ...chat, async (ctx) => {
	const found = await joined(ctx);
	if (!found) return Utils.fail(ctx, ErrorCode.CONVERSATION_NOT_FOUND);
	const meeting = await meetingOf(found.conversation.uuid);
	if (!meeting) return Utils.fail(ctx, ErrorCode.INVALID_MEETING);
	if (!found.participant.admin) return Utils.fail(ctx, ErrorCode.CONVERSATION_ADMIN_REQUIRED);
	const data = await body(ctx);
	const times = data ? readMeetingTimes(data, meeting) : null;
	if (times === null || (data?.guests !== undefined && typeof data.guests !== "boolean")) return Utils.fail(ctx, ErrorCode.INVALID_MEETING);

	const wantsGuests = data?.guests === undefined ? meeting.guest_token_hash !== null : data.guests;
	const reset = data?.reset_guest_link === true;
	const guest = wantsGuests && (meeting.guest_token_hash === null || reset) ? await newGuestToken() : null;
	const sealed = !wantsGuests ? null : (guest?.sealed ?? meeting.guest_token);
	const hash = !wantsGuests ? null : (guest?.hash ?? meeting.guest_token_hash);
	await Database`
		UPDATE chat_meetings SET starts_at = ${times.starts_at}, duration_minutes = ${times.duration_minutes}, guest_token = ${sealed},
			guest_token_hash = ${hash}, updated = ${Date.now()}
		WHERE conversation = ${found.conversation.uuid}
	`;
	await audit(ctx, "chat.meeting_updated", found.conversation.uuid, { ...times, guests: wantsGuests, guest_link_reset: guest !== null });
	await notify(found.conversation, { type: "chat.conversation" });
	return Utils.ok(ctx, await presentConversation(found.conversation, Auth.account(ctx).username));
});

Server.app.get(`${base}/conversations/:conversation/meeting/guest-link`, ...chat, async (ctx) => {
	const found = await joined(ctx);
	if (!found) return Utils.fail(ctx, ErrorCode.CONVERSATION_NOT_FOUND);
	const meeting = await meetingOf(found.conversation.uuid);
	if (!meeting) return Utils.fail(ctx, ErrorCode.INVALID_MEETING);
	ctx.header("Cache-Control", "no-store");
	return Utils.ok(ctx, { url: meeting.guest_token === null ? null : guestUrl(Vault.decrypt(meeting.guest_token)) });
});

async function guestMeeting(token: string): Promise<{ meeting: ChatMeetingRow; conversation: ChatConversationRow; project: ProjectRow } | null> {
	const found = await meetingByGuestToken(token);
	if (!found) return null;
	const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${found.conversation.project} AND status != 'deleted'`) as ProjectRow[];
	return project && workforceActive(project) ? { ...found, project } : null;
}

Server.app.get("/api/v1/public/meetings/:token", guestLimit, async (ctx) => {
	const found = await guestMeeting(ctx.params.token);
	if (!found) return Utils.fail(ctx, ErrorCode.MEETING_NOT_FOUND);
	ctx.header("Cache-Control", "no-store");
	return Utils.ok(ctx, {
		title: found.conversation.name,
		organisation: displayNameOf(found.project),
		starts_at: Number(found.meeting.starts_at),
		duration_minutes: Number(found.meeting.duration_minutes),
		active: GroupCalls.infoOf(found.conversation.uuid) !== null,
	});
});

Server.app.post("/api/v1/public/meetings/:token/join", guestLimit, async (ctx) => {
	const found = await guestMeeting(ctx.params.token);
	if (!found) return Utils.fail(ctx, ErrorCode.MEETING_NOT_FOUND);
	const given = (await body(ctx))?.name;
	const name = typeof given === "string" ? given.trim().replace(/\s+/g, " ") : "";
	if (name === "" || name.length > MAX_GUEST_NAME_LENGTH) return Utils.fail(ctx, ErrorCode.INVALID_MEETING);

	const guest = Utils.generateRandomText(24);
	const result = await GroupCalls.join(found.conversation, { username: `guest-${guest}`, name, client: null }, false);
	if (result === "closed") return Utils.fail(ctx, ErrorCode.MEETING_NOT_STARTED);
	if (result === "unavailable") return Utils.fail(ctx, ErrorCode.GROUP_CALLS_UNAVAILABLE);
	if (result === "full") return Utils.fail(ctx, ErrorCode.CALL_FULL);
	ctx.header("Cache-Control", "no-store");
	return Utils.ok(ctx, { call: result.call.uuid, url: result.call.node, token: result.token, guest, screen_share: screenShareLimits() });
});

Server.app.post("/api/v1/public/meetings/:token/leave", guestLimit, async (ctx) => {
	const found = await guestMeeting(ctx.params.token);
	if (!found) return Utils.fail(ctx, ErrorCode.MEETING_NOT_FOUND);
	const guest = (await body(ctx))?.guest;
	if (typeof guest === "string" && GUEST_ID.test(guest)) await GroupCalls.leave(found.conversation.uuid, `guest-${guest}`);
	return Utils.ok(ctx);
});

const recordingPart = bodyLimit<AppState>({ maxSize: FILE_PART_BYTES, message: "The recording part is too large." });
const RECORDING_TYPES = ["video/webm", "video/mp4"];

function screenShareLimits() {
	return {
		height: Settings.calls.screen_share_max_height,
		frames_per_second: Settings.calls.screen_share_max_frames_per_second,
		kbps: Settings.calls.screen_share_max_kbps,
	};
}

function recordingLimits() {
	return {
		height: Settings.calls.recording_max_height,
		frames_per_second: Settings.calls.recording_max_frames_per_second,
		video_kbps: Settings.calls.recording_max_video_kbps,
		audio_kbps: Settings.calls.recording_audio_kbps,
	};
}

function recordingStamp(timezone: string): string {
	const format = (zone: string) => new Intl.DateTimeFormat("sv-SE", { timeZone: zone, dateStyle: "short", timeStyle: "short" }).format(new Date());
	try {
		return format(timezone).replace(":", ".");
	} catch {
		return format("UTC").replace(":", ".");
	}
}

async function openRecording(ctx: Context<AppState>) {
	if (!Validate.uuid(ctx.params.file)) return null;
	const project = Permissions.project(ctx);
	const username = Auth.account(ctx).username;
	const [link] = (await Database`SELECT conversation FROM chat_files WHERE file = ${ctx.params.file} AND recording = 1 AND message IS NULL`) as {
		conversation: string;
	}[];
	const file = link ? await findFile(project.uuid, ctx.params.file) : null;
	if (!link || !file || file.created_by !== username || file.status !== "uploading") return null;
	const found = await findConversation(project.uuid, link.conversation, username);
	return found ? { file, conversation: found.conversation } : null;
}

Server.app.post(`${base}/conversations/:conversation/recordings`, ...chat, async (ctx) => {
	const project = Permissions.project(ctx);
	const found = await joined(ctx);
	if (!found) return Utils.fail(ctx, ErrorCode.CONVERSATION_NOT_FOUND);
	if (found.conversation.kind !== "group") return Utils.fail(ctx, ErrorCode.INVALID_CALL);
	const requested = (await body(ctx))?.type;
	const type = typeof requested === "string" && RECORDING_TYPES.includes(requested.split(";")[0]) ? requested.split(";")[0] : RECORDING_TYPES[0];
	if (!(await hasFileStorageCapacity(project.uuid, FILE_PART_BYTES))) return Utils.fail(ctx, ErrorCode.FILE_STORAGE_LIMIT_REACHED);
	if (!(await memberHasRoom(project, Auth.account(ctx).username, FILE_PART_BYTES))) return Utils.fail(ctx, ErrorCode.FILE_MEMBER_LIMIT_REACHED);

	const stamp = recordingStamp(project.timezone);
	const name = `${found.conversation.name ?? "Call"} ${stamp}.${type === "video/mp4" ? "mp4" : "webm"}`.replace(/[\\/]/g, " ");
	const file = await beginOpenUpload(project.uuid, name, type, Auth.account(ctx).username);
	await Database`INSERT INTO chat_files(file, conversation, recording, created) VALUES(${file.uuid}, ${found.conversation.uuid}, 1, ${Date.now()})`;
	await audit(ctx, "chat.recording_started", found.conversation.uuid, { file: file.uuid });
	return Utils.ok(ctx, { ...presentFile(file), part_bytes: FILE_PART_BYTES, max_bytes: fileSizeCeiling(), limits: recordingLimits() }, 201);
});

Server.app.put(`${base}/recordings/:file/parts/:index`, recordingPart, ...chat, async (ctx) => {
	const open = await openRecording(ctx);
	if (!open) return Utils.fail(ctx, ErrorCode.RECORDING_NOT_FOUND);
	const index = /^\d{1,6}$/.test(ctx.params.index) ? Number(ctx.params.index) : -1;
	const bytes = new Uint8Array(await ctx.req.arrayBuffer());
	if (!acceptsAppendedPart(open.file, index, bytes.length)) return Utils.fail(ctx, ErrorCode.INVALID_FILE_PART);
	if (Number(open.file.byte_size) + bytes.length > fileSizeCeiling()) return Utils.fail(ctx, ErrorCode.FILE_TOO_LARGE);
	if (!(await hasFileStorageCapacity(open.file.project, bytes.length))) return Utils.fail(ctx, ErrorCode.FILE_STORAGE_LIMIT_REACHED);
	if (!(await memberHasRoom(Permissions.project(ctx), Auth.account(ctx).username, bytes.length))) return Utils.fail(ctx, ErrorCode.FILE_MEMBER_LIMIT_REACHED);
	const stored = await appendPart(open.file, index, bytes);
	if (!stored) return Utils.fail(ctx, ErrorCode.INVALID_FILE_PART);
	return Utils.ok(ctx, { byte_size: Number(stored.byte_size), parts: Number(stored.parts) });
});

Server.app.post(`${base}/recordings/:file/finish`, ...chat, async (ctx) => {
	const open = await openRecording(ctx);
	if (!open) return Utils.fail(ctx, ErrorCode.RECORDING_NOT_FOUND);
	const sent = await body(ctx);
	if (sent?.duration_ms !== undefined) await stampRecordingDuration(open.file, sent.duration_offset, sent.duration_ms).catch(() => false);
	const kept = await finishRecording(open.file, open.conversation, { username: Auth.account(ctx).username, name: personName(Permissions.member(ctx)) });
	await audit(ctx, "chat.recording_finished", open.conversation.uuid, { file: open.file.uuid, kept, byte_size: Number(open.file.byte_size) });
	return Utils.ok(ctx, { kept });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ATTACHMENT_AGE_DAYS = 3650;
const REMOVAL_BATCH = 200;

Server.app.get(`${base}/attachments`, ...chat, async (ctx) => {
	const project = Permissions.project(ctx);
	const username = Auth.account(ctx).username;
	const query = ctx.query();
	const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);
	const sent = Database`
		FROM project_files f JOIN chat_files cf ON cf.file = f.uuid JOIN chat_conversations c ON c.uuid = cf.conversation
		WHERE f.project = ${project.uuid} AND f.created_by = ${username} AND cf.message IS NOT NULL AND f.removed_at IS NULL AND f.status = 'ready'
	`;
	const rows = (await Database`
		SELECT f.*, c.uuid AS conversation_uuid, c.kind AS conversation_kind, c.name AS conversation_name ${sent}
		ORDER BY f.created DESC, f.uuid ASC LIMIT ${limit} OFFSET ${offset}
	`) as (ProjectFileRow & { conversation_uuid: string; conversation_kind: string; conversation_name: string | null })[];
	const [totals] = (await Database`SELECT COUNT(*) AS count, COALESCE(SUM(f.byte_size), 0) AS bytes ${sent}`) as { count: number; bytes: number }[];

	const directs = rows.filter((row) => row.conversation_kind === "direct").map((row) => row.conversation_uuid);
	const others = directs.length
		? ((await Database`
				SELECT conversation, account FROM chat_participants WHERE conversation IN ${Database([...new Set(directs)])} AND account != ${username}
			`) as { conversation: string; account: string }[])
		: [];
	const names = await accountNames(
		others.map((other) => other.account),
		project.uuid
	);
	const otherOf = new Map(others.map((other) => [other.conversation, names.get(other.account) ?? ""]));
	return Utils.ok(ctx, {
		files: rows.map((row) => ({
			...presentFile(row),
			conversation: row.conversation_uuid,
			conversation_name: row.conversation_kind === "group" ? (row.conversation_name ?? "") : (otherOf.get(row.conversation_uuid) ?? ""),
		})),
		total: Number(totals.count),
		total_bytes: Number(totals.bytes),
		limit,
		offset,
		recording_limits: recordingLimits(),
	});
});

Server.app.post(`${base}/attachments/remove`, ...chat, async (ctx) => {
	const project = Permissions.project(ctx);
	const username = Auth.account(ctx).username;
	const data = await body(ctx);
	const days = data?.older_than_days;
	if (typeof days !== "number" || !Number.isSafeInteger(days) || days < 0 || days > MAX_ATTACHMENT_AGE_DAYS) return Utils.fail(ctx, ErrorCode.INVALID_FILE);
	const everyone = data?.everyone === true;
	if (everyone && !Permissions.has(Permissions.member(ctx), Permission.PROJECT_EDIT)) return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);

	const before = Date.now() - days * DAY_MS;
	const owner = everyone ? Database`` : Database`AND f.created_by = ${username}`;
	let removed = 0;
	let bytes = 0;
	for (;;) {
		const batch = (await Database`
			SELECT f.* FROM project_files f JOIN chat_files cf ON cf.file = f.uuid
			WHERE f.project = ${project.uuid} AND cf.message IS NOT NULL AND f.removed_at IS NULL AND f.status = 'ready' AND f.created <= ${before} ${owner}
			LIMIT ${REMOVAL_BATCH}
		`) as ProjectFileRow[];
		if (batch.length === 0) break;
		for (const file of batch) {
			if (!(await removeFile(file, username))) continue;
			removed++;
			bytes += Number(file.byte_size);
			await announceFileChange(file.uuid);
		}
	}
	await Audit.record(ctx, {
		project: project.uuid,
		action: "file.chat_attachments_removed",
		entityType: "project",
		entityId: project.uuid,
		newValue: { older_than_days: days, everyone, removed, bytes },
	});
	return Utils.ok(ctx, { removed, bytes });
});
