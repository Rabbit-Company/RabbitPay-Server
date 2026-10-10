import type { SQL } from "bun";
import Database from "../database/database";
import Permissions from "../permissions";
import Utils from "../utils";
import Vault from "../crypto/vault";
import { Logger } from "../logger";
import { Permission } from "../roles";
import { Realtime, type RealtimeEvent } from "../realtime";
import { PresenceBoard, type Presence } from "./presence";
import { repeatOf } from "./recurrence";
import { membersWithEmail, personName } from "./people";
import { nameAccounts } from "../accounts";
import { discardFiles, finishOpenUpload, presentFile, removeFile, replaceInFirstPart } from "../files";
import { UPLOAD_EXPIRY_MS } from "../file-limits";
import { MAX_GROUP_NAME_LENGTH, MAX_GROUP_PEOPLE, MAX_MESSAGE_FILES, MAX_MESSAGE_LENGTH, MAX_MESSAGE_PAGE, MESSAGE_PAGE } from "./chat-limits";
import type {
	CallOutcome,
	ChatConversationRow,
	ChatFileRow,
	ChatMeetingRow,
	ChatMessageRow,
	ChatParticipantRow,
	ProjectFileRow,
	ProjectMemberRow,
} from "../database/models";

export { MAX_GROUP_NAME_LENGTH, MAX_GROUP_PEOPLE, MAX_MESSAGE_FILES, MAX_MESSAGE_LENGTH, MAX_MESSAGE_PAGE, MESSAGE_PAGE };

export interface ChatPerson {
	account: string;
	name: string;
	presence: Presence;
}

export interface PresentedMessage {
	uuid: string;
	conversation: string;
	number: number;
	author: string | null;
	author_name: string;
	body: string | null;
	created: number;
	edited_at: number | null;
	deleted: boolean;
	files: ReturnType<typeof presentFile>[];
	call: { outcome: CallOutcome; seconds: number; video: boolean } | null;
}

export const MAX_MEETING_MINUTES = 24 * 60;
export const MIN_MEETING_MINUTES = 5;

export function presentMeeting(meeting: ChatMeetingRow | undefined) {
	if (!meeting) return null;
	return {
		starts_at: Number(meeting.starts_at),
		duration_minutes: Number(meeting.duration_minutes),
		guests: meeting.guest_token_hash !== null,
		repeat: repeatOf(meeting),
	};
}

export function readMeetingTimes(data: Record<string, unknown>, previous?: ChatMeetingRow): { starts_at: number; duration_minutes: number } | null {
	const startsAt = data.starts_at ?? (previous ? Number(previous.starts_at) : undefined);
	const minutes = data.duration_minutes ?? (previous ? Number(previous.duration_minutes) : undefined);
	if (typeof startsAt !== "number" || !Number.isSafeInteger(startsAt) || startsAt <= 0) return null;
	if (typeof minutes !== "number" || !Number.isSafeInteger(minutes) || minutes < MIN_MEETING_MINUTES || minutes > MAX_MEETING_MINUTES) return null;
	return { starts_at: startsAt, duration_minutes: minutes };
}

export async function newGuestToken(): Promise<{ token: string; sealed: string; hash: string }> {
	const token = Utils.generateRandomText(48);
	return { token, sealed: Vault.encrypt(token), hash: await Utils.generateHash(token, "sha256") };
}

export async function meetingByGuestToken(token: string): Promise<{ meeting: ChatMeetingRow; conversation: ChatConversationRow } | null> {
	if (!/^[A-Za-z0-9]{48}$/.test(token)) return null;
	const [meeting] = (await Database`
		SELECT * FROM chat_meetings WHERE guest_token_hash = ${await Utils.generateHash(token, "sha256")}
	`) as ChatMeetingRow[];
	if (!meeting) return null;
	const [conversation] = (await Database`SELECT * FROM chat_conversations WHERE uuid = ${meeting.conversation}`) as ChatConversationRow[];
	return conversation ? { meeting, conversation } : null;
}

const RECORDING_GRACE_MS = 5 * 60 * 1000;

let groupCallInfo: (conversation: string) => unknown = () => null;

export function provideGroupCallInfo(provider: (conversation: string) => unknown) {
	groupCallInfo = provider;
}

export async function directKey(projectId: string, first: string, second: string): Promise<string> {
	return await Utils.generateHash(`${projectId}:${[first, second].sort().join(":")}`, "sha256");
}

export async function chatMembers(projectId: string): Promise<ProjectMemberRow[]> {
	const members = (await Database`
		${membersWithEmail()} WHERE pm.project_id = ${projectId} AND pm.status = 'active' AND pm.account_username IS NOT NULL
	`) as ProjectMemberRow[];
	return members.filter((member) => Permissions.isActive(member) && Permissions.has(member, Permission.CHAT_USE));
}

export async function chatPeople(projectId: string): Promise<ChatPerson[]> {
	return (await chatMembers(projectId))
		.map((member) => ({ account: member.account_username!, name: personName(member), presence: PresenceBoard.of(member.account_username!) }))
		.sort((first, second) => first.name.localeCompare(second.name));
}

async function announcePresence(username: string, presence: Presence) {
	try {
		const projects = (await Database`
			SELECT project_id FROM project_members WHERE account_username = ${username} AND status = 'active'
		`) as { project_id: string }[];
		const colleagues = new Set<string>();
		for (const { project_id } of projects) {
			const people = await chatPeople(project_id);
			if (people.some((person) => person.account === username)) for (const person of people) colleagues.add(person.account);
		}
		colleagues.delete(username);
		Realtime.send(colleagues, { type: "chat.presence", account: username, presence });
	} catch (error) {
		Logger.warn(`[CHAT] Could not announce presence of ${username}: ${error}`);
	}
}

PresenceBoard.onChange((username, presence) => void announcePresence(username, presence));

export function readMessageBody(value: unknown, mayBeEmpty = false): string | null {
	if (value === undefined && mayBeEmpty) return "";
	if (typeof value !== "string") return null;
	const body = value.trim();
	return (body.length > 0 || mayBeEmpty) && body.length <= MAX_MESSAGE_LENGTH ? body : null;
}

export function readFileIds(value: unknown): string[] | null {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_MESSAGE_FILES || value.some((file) => typeof file !== "string")) return null;
	return [...new Set(value as string[])];
}

export function readGroupName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const name = value.trim();
	return name.length > 0 && name.length <= MAX_GROUP_NAME_LENGTH ? name : null;
}

export function readAccounts(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length > MAX_GROUP_PEOPLE) return null;
	if (value.some((account) => typeof account !== "string" || account === "")) return null;
	return [...new Set(value as string[])];
}

function openBody(row: ChatMessageRow): string | null {
	if (row.body === null || row.deleted_at !== null) return null;
	try {
		return Vault.decrypt(row.body);
	} catch (error) {
		Logger.error(`[CHAT] Message ${row.uuid} could not be decrypted: ${error}`);
		return null;
	}
}

function presentMessage(row: ChatMessageRow, files: ProjectFileRow[]): PresentedMessage {
	return {
		uuid: row.uuid,
		conversation: row.conversation,
		number: Number(row.number),
		author: row.author,
		author_name: row.author_name,
		body: openBody(row),
		created: Number(row.created),
		edited_at: row.edited_at === null ? null : Number(row.edited_at),
		deleted: row.deleted_at !== null,
		files: row.deleted_at === null ? files.map(presentFile) : [],
		call: row.call_outcome === null ? null : { outcome: row.call_outcome, seconds: Number(row.call_seconds ?? 0), video: Boolean(row.call_video) },
	};
}

export async function filesOfMessages(messages: string[]): Promise<Map<string, ProjectFileRow[]>> {
	const grouped = new Map<string, ProjectFileRow[]>();
	if (messages.length === 0) return grouped;
	const rows = (await Database`
		SELECT f.*, cf.message AS chat_message FROM chat_files cf JOIN project_files f ON f.uuid = cf.file
		WHERE cf.message IN ${Database(messages)} AND f.status = 'ready' ORDER BY cf.created ASC, f.uuid ASC
	`) as (ProjectFileRow & { chat_message: string })[];
	for (const row of rows) grouped.set(row.chat_message, [...(grouped.get(row.chat_message) ?? []), row]);
	return grouped;
}

export async function presentMessages(projectId: string, rows: ChatMessageRow[]): Promise<PresentedMessage[]> {
	const files = await filesOfMessages(rows.filter((row) => row.deleted_at === null).map((row) => row.uuid));
	const presented = rows.map((row) => presentMessage(row, files.get(row.uuid) ?? []));
	await nameAccounts(
		presented.flatMap((message) => message.files),
		projectId
	);
	return presented;
}

export async function presentMessageById(projectId: string, uuid: string): Promise<PresentedMessage | null> {
	const rows = (await Database`SELECT * FROM chat_messages WHERE uuid = ${uuid}`) as ChatMessageRow[];
	return (await presentMessages(projectId, rows))[0] ?? null;
}

export async function chatFileOf(fileId: string): Promise<ChatFileRow | null> {
	const [link] = (await Database`SELECT * FROM chat_files WHERE file = ${fileId}`) as ChatFileRow[];
	return link ?? null;
}

export async function stagedFiles(conversation: string, username: string, ids: string[]): Promise<ProjectFileRow[] | null> {
	if (ids.length === 0) return [];
	const rows = (await Database`
		SELECT f.* FROM project_files f JOIN chat_files cf ON cf.file = f.uuid
		WHERE cf.conversation = ${conversation} AND cf.message IS NULL AND f.uuid IN ${Database(ids)}
			AND f.created_by = ${username} AND f.status = 'ready' AND f.removed_at IS NULL
	`) as ProjectFileRow[];
	return rows.length === ids.length ? rows : null;
}

export async function removeMessageFiles(message: string, username: string) {
	for (const file of (await filesOfMessages([message])).get(message) ?? []) {
		if (file.removed_at === null) await removeFile(file, username);
	}
}

export async function filesOfConversation(conversation: string): Promise<ProjectFileRow[]> {
	return (await Database`
		SELECT f.* FROM project_files f JOIN chat_files cf ON cf.file = f.uuid WHERE cf.conversation = ${conversation}
	`) as ProjectFileRow[];
}

export async function discardUnsentChatFiles(now = Date.now()): Promise<number> {
	const unsent = (await Database`
		SELECT f.* FROM project_files f JOIN chat_files cf ON cf.file = f.uuid
		WHERE cf.message IS NULL AND cf.recording = 0 AND f.created < ${now - UPLOAD_EXPIRY_MS} LIMIT 500
	`) as ProjectFileRow[];
	await discardFiles(unsent);
	return unsent.length;
}

const DURATION_PLACEHOLDER = new Uint8Array([0xec, 0x89, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const MAX_DURATION_OFFSET = 65_536;
const MAX_RECORDING_MS = 7 * 24 * 60 * 60 * 1000;

export async function stampRecordingDuration(file: ProjectFileRow, offset: unknown, milliseconds: unknown): Promise<boolean> {
	if (file.content_type !== "video/webm") return false;
	if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_DURATION_OFFSET) return false;
	if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > MAX_RECORDING_MS) return false;
	const duration = new Uint8Array(DURATION_PLACEHOLDER.length);
	duration.set([0x44, 0x89, 0x88]);
	new DataView(duration.buffer).setFloat64(3, milliseconds);
	return await replaceInFirstPart(file, offset, DURATION_PLACEHOLDER, duration);
}

export async function finishRecording(file: ProjectFileRow, conversation: ChatConversationRow, author: { username: string; name: string }): Promise<boolean> {
	const finished = await finishOpenUpload(file);
	if (!finished) {
		await discardFiles([file]);
		return false;
	}
	const inserted = await insertMessage(conversation, author, "", [file.uuid]);
	const message = await presentMessageById(conversation.project, inserted.uuid);
	if (message) await notify(conversation, { type: "chat.message", message });
	return true;
}

export async function finishStaleRecordings(isRunning: (conversation: string) => boolean, now = Date.now()): Promise<number> {
	const open = (await Database`
		SELECT f.*, cf.conversation AS chat_conversation FROM project_files f JOIN chat_files cf ON cf.file = f.uuid
		WHERE cf.recording = 1 AND cf.message IS NULL AND f.created < ${now - RECORDING_GRACE_MS} LIMIT 100
	`) as (ProjectFileRow & { chat_conversation: string })[];
	let finished = 0;
	for (const file of open) {
		if (isRunning(file.chat_conversation)) continue;
		const [conversation] = (await Database`SELECT * FROM chat_conversations WHERE uuid = ${file.chat_conversation}`) as ChatConversationRow[];
		const names = await nameAccounts([{ created_by: file.created_by }], conversation?.project ?? null);
		const name = (names[0] as { created_by_name?: string | null }).created_by_name ?? "";
		if (!conversation || file.created_by === null) await discardFiles([file]);
		else if (await finishRecording(file, conversation, { username: file.created_by, name })) finished++;
	}
	return finished;
}

export async function announceFileChange(fileId: string) {
	const link = await chatFileOf(fileId);
	if (!link || link.message === null) return;
	const [conversation] = (await Database`SELECT * FROM chat_conversations WHERE uuid = ${link.conversation}`) as ChatConversationRow[];
	if (!conversation) return;
	const message = await presentMessageById(conversation.project, link.message);
	if (message) await notify(conversation, { type: "chat.message_changed", message });
}

export async function findConversation(
	projectId: string,
	uuid: string,
	username: string
): Promise<{ conversation: ChatConversationRow; participant: ChatParticipantRow } | null> {
	const [conversation] = (await Database`SELECT * FROM chat_conversations WHERE uuid = ${uuid} AND project = ${projectId}`) as ChatConversationRow[];
	if (!conversation) return null;
	const [participant] = (await Database`
		SELECT * FROM chat_participants WHERE conversation = ${uuid} AND account = ${username}
	`) as ChatParticipantRow[];
	return participant ? { conversation, participant } : null;
}

export async function participantsOf(conversations: string[]): Promise<Map<string, ChatParticipantRow[]>> {
	const grouped = new Map<string, ChatParticipantRow[]>();
	if (conversations.length === 0) return grouped;
	const rows = (await Database`
		SELECT * FROM chat_participants WHERE conversation IN ${Database(conversations)} ORDER BY joined ASC, account ASC
	`) as ChatParticipantRow[];
	for (const row of rows) grouped.set(row.conversation, [...(grouped.get(row.conversation) ?? []), row]);
	return grouped;
}

export async function recipientsOf(conversation: Pick<ChatConversationRow, "uuid" | "project">): Promise<string[]> {
	const rows = (await Database`
		SELECT pm.* FROM chat_participants cp
		JOIN project_members pm ON pm.account_username = cp.account AND pm.project_id = ${conversation.project}
		WHERE cp.conversation = ${conversation.uuid} AND pm.status = 'active'
	`) as ProjectMemberRow[];
	return rows.filter((member) => Permissions.isActive(member) && Permissions.has(member, Permission.CHAT_USE)).map((member) => member.account_username!);
}

export async function notify(conversation: Pick<ChatConversationRow, "uuid" | "project">, event: RealtimeEvent, also: string[] = []) {
	Realtime.send([...(await recipientsOf(conversation)), ...also], { ...event, project: conversation.project, conversation: conversation.uuid });
}

async function unreadCounts(conversations: string[], username: string): Promise<Map<string, number>> {
	if (conversations.length === 0) return new Map();
	const rows = (await Database`
		SELECT m.conversation, COUNT(*) AS count FROM chat_messages m
		JOIN chat_participants cp ON cp.conversation = m.conversation AND cp.account = ${username}
		WHERE m.conversation IN ${Database(conversations)} AND m.number > cp.read_number AND m.deleted_at IS NULL
			AND (m.call_outcome IS NULL OR m.call_outcome = 'missed')
			AND (m.author IS NULL OR m.author != ${username})
		GROUP BY m.conversation
	`) as { conversation: string; count: number }[];
	return new Map(rows.map((row) => [row.conversation, Number(row.count)]));
}

export async function unreadTotal(projectId: string, username: string): Promise<{ messages: number; conversations: number }> {
	const rows = (await Database`
		SELECT c.uuid FROM chat_conversations c JOIN chat_participants cp ON cp.conversation = c.uuid AND cp.account = ${username}
		WHERE c.project = ${projectId} AND c.last_number > cp.read_number
	`) as { uuid: string }[];
	const counts = await unreadCounts(
		rows.map((row) => row.uuid),
		username
	);
	return { messages: [...counts.values()].reduce((sum, count) => sum + count, 0), conversations: counts.size };
}

export async function presentConversations(projectId: string, conversations: ChatConversationRow[], username: string) {
	const ids = conversations.map((conversation) => conversation.uuid);
	const [participants, unread, people] = await Promise.all([participantsOf(ids), unreadCounts(ids, username), chatPeople(projectId)]);
	const meetings = new Map(
		(ids.length === 0 ? [] : ((await Database`SELECT * FROM chat_meetings WHERE conversation IN ${Database(ids)}`) as ChatMeetingRow[])).map((meeting) => [
			meeting.conversation,
			meeting,
		])
	);
	const lastMessages =
		ids.length === 0
			? []
			: ((await Database`
					SELECT m.* FROM chat_messages m JOIN chat_conversations c ON c.uuid = m.conversation AND c.last_number = m.number
					WHERE c.uuid IN ${Database(ids)}
				`) as ChatMessageRow[]);
	const lastByConversation = new Map((await presentMessages(projectId, lastMessages)).map((message) => [message.conversation, message]));
	const active = new Map(people.map((person) => [person.account, person]));
	const everyone = [...participants.values()].flat().map((participant) => participant.account);
	const missing = everyone.filter((account) => !active.has(account));
	const names =
		missing.length === 0
			? []
			: ((await Database`
					${membersWithEmail()} WHERE pm.project_id = ${projectId} AND pm.account_username IN ${Database([...new Set(missing)])}
				`) as ProjectMemberRow[]);
	const formerNames = new Map(names.map((member) => [member.account_username!, personName(member)]));

	return conversations.map((conversation) => {
		const own = (participants.get(conversation.uuid) ?? []).find((participant) => participant.account === username);
		const last = lastByConversation.get(conversation.uuid);
		return {
			uuid: conversation.uuid,
			kind: conversation.kind,
			name: conversation.name,
			participants: (participants.get(conversation.uuid) ?? []).map((participant) => ({
				account: participant.account,
				name: active.get(participant.account)?.name ?? formerNames.get(participant.account) ?? "",
				admin: Boolean(participant.admin),
				active: active.has(participant.account),
				presence: active.get(participant.account)?.presence ?? "offline",
			})),
			admin: Boolean(own?.admin),
			read_number: Number(own?.read_number ?? 0),
			last_number: Number(conversation.last_number),
			last_message: last ?? null,
			last_message_at: conversation.last_message_at === null ? null : Number(conversation.last_message_at),
			unread: unread.get(conversation.uuid) ?? 0,
			call: groupCallInfo(conversation.uuid),
			meeting: presentMeeting(meetings.get(conversation.uuid)),
			created: Number(conversation.created),
			updated: Number(conversation.updated),
		};
	});
}

export async function presentConversation(conversation: ChatConversationRow, username: string) {
	const [fresh] = (await Database`SELECT * FROM chat_conversations WHERE uuid = ${conversation.uuid}`) as ChatConversationRow[];
	return (await presentConversations(conversation.project, [fresh ?? conversation], username))[0];
}

export async function insertMessage(
	conversation: ChatConversationRow,
	author: { username: string; name: string },
	body: string,
	files: string[] = [],
	call: { outcome: CallOutcome; seconds: number; video: boolean } | null = null
): Promise<ChatMessageRow> {
	const uuid = crypto.randomUUID();
	const now = Date.now();
	const sealed = Vault.encrypt(body);
	await Database.begin(async (tx) => {
		await tx`UPDATE chat_conversations SET last_number = last_number + 1, last_message_at = ${now}, updated = ${now} WHERE uuid = ${conversation.uuid}`;
		const [{ last_number }] = (await tx`SELECT last_number FROM chat_conversations WHERE uuid = ${conversation.uuid}`) as { last_number: number }[];
		await tx`
			INSERT INTO chat_messages(uuid, conversation, number, author, author_name, body, created, call_outcome, call_seconds, call_video)
			VALUES(${uuid}, ${conversation.uuid}, ${Number(last_number)}, ${author.username}, ${author.name}, ${sealed}, ${now},
				${call?.outcome ?? null}, ${call?.seconds ?? null}, ${call ? (call.video ? 1 : 0) : null})
		`;
		if (files.length > 0) await tx`UPDATE chat_files SET message = ${uuid} WHERE file IN ${tx(files)} AND conversation = ${conversation.uuid}`;
		await tx`UPDATE chat_participants SET read_number = ${Number(last_number)} WHERE conversation = ${conversation.uuid} AND account = ${author.username}`;
	});
	const [message] = (await Database`SELECT * FROM chat_messages WHERE uuid = ${uuid}`) as ChatMessageRow[];
	return message;
}

export async function addParticipants(sql: SQL, conversation: string, accounts: string[], admin: boolean, readNumber: number, joined = Date.now()) {
	for (const account of accounts) {
		await sql`
			INSERT INTO chat_participants(conversation, account, admin, read_number, joined)
			VALUES(${conversation}, ${account}, ${admin ? 1 : 0}, ${readNumber}, ${joined})
		`;
	}
}

export async function removeParticipant(conversation: ChatConversationRow, account: string): Promise<"removed" | "closed"> {
	const files = await filesOfConversation(conversation.uuid);
	const outcome = await removeParticipantRow(conversation, account);
	if (outcome === "closed") await discardFiles(files);
	return outcome;
}

async function removeParticipantRow(conversation: ChatConversationRow, account: string): Promise<"removed" | "closed"> {
	return await Database.begin(async (tx) => {
		await tx`DELETE FROM chat_participants WHERE conversation = ${conversation.uuid} AND account = ${account}`;
		const left = (await tx`
			SELECT * FROM chat_participants WHERE conversation = ${conversation.uuid} ORDER BY joined ASC, account ASC
		`) as ChatParticipantRow[];
		if (left.length === 0) {
			await tx`DELETE FROM chat_conversations WHERE uuid = ${conversation.uuid}`;
			return "closed" as const;
		}
		if (!left.some((participant) => Boolean(participant.admin))) {
			await tx`UPDATE chat_participants SET admin = 1 WHERE conversation = ${conversation.uuid} AND account = ${left[0].account}`;
		}
		await tx`UPDATE chat_conversations SET updated = ${Date.now()} WHERE uuid = ${conversation.uuid}`;
		return "removed" as const;
	});
}
