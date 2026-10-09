import type { Context } from "@rabbit-company/web";
import { bodyLimit } from "@rabbit-company/web-middleware/body-limit";
import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Cache from "../../cache";
import Permissions from "../../permissions";
import Utils from "../../utils";
import { accountNames, okWithNames } from "../../accounts";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { fileStorageFor, hasFileStorageCapacity } from "../../licensing";
import { requireWorkforce } from "../../workforce/access";
import {
	acceptsPart,
	beginUpload,
	discardFiles,
	FALLBACK_CONTENT_TYPE,
	fileResponse,
	fileSizeCeiling,
	findFile,
	maxFileBytes,
	presentFile,
	readFileRequest,
	removeFile,
	storePart,
} from "../../files";
import { DOWNLOAD_LINK_SECONDS, FILE_MB_BYTES, FILE_PART_BYTES, isPlayableVideo, PLAYBACK_LINK_SECONDS } from "../../file-limits";
import { dropFromExplorer, fileView, memberFileUsage, pathNames, projectFolders, ticketLinked } from "../../file-explorer";
import { announceFileChange, chatFileOf } from "../../workforce/chat";
import type { AppState, ChatConversationRow, ChatParticipantRow, ProjectFileRow, ProjectMemberRow, ProjectRow, TicketRow } from "../../database/models";

const base = "/api/v1/projects/:uuid";
const partBody = bodyLimit<AppState>({ maxSize: FILE_PART_BYTES, message: "The file part is too large." });
const FILE_SORTS = ["size", "created"] as const;
const DOWNLOAD_TOKEN = /^[0-9a-f]{64}$/;

async function body(ctx: Context<AppState>): Promise<Record<string, unknown> | null> {
	try {
		const value = await ctx.body<Record<string, unknown>>();
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

async function requestedFile(ctx: Context<AppState>): Promise<ProjectFileRow | null> {
	if (!Validate.uuid(ctx.params.file)) return null;
	return await findFile(Permissions.project(ctx).uuid, ctx.params.file);
}

function fileLimits(project: ProjectRow) {
	return {
		max_file_bytes: maxFileBytes(project),
		max_file_bytes_ceiling: fileSizeCeiling(),
		max_member_file_bytes: project.max_member_file_bytes === null ? null : Number(project.max_member_file_bytes),
	};
}

interface FileAccess {
	view: boolean;
	remove: boolean;
	linked: boolean;
	chat: boolean;
}

async function chatFileAccess(ctx: Context<AppState>, file: ProjectFileRow, conversationId: string): Promise<FileAccess> {
	const member = Permissions.member(ctx);
	const username = Auth.account(ctx).username;
	const [conversation] = (await Database`SELECT * FROM chat_conversations WHERE uuid = ${conversationId}`) as ChatConversationRow[];
	const [participant] = Permissions.has(member, Permission.CHAT_USE)
		? ((await Database`SELECT * FROM chat_participants WHERE conversation = ${conversationId} AND account = ${username}`) as ChatParticipantRow[])
		: [];
	const view = participant !== undefined;
	const moderates = view && conversation?.kind === "group" && Boolean(participant.admin);
	const remove = (view && file.created_by === username) || moderates || Permissions.has(member, Permission.PROJECT_EDIT);
	return { view, remove, linked: true, chat: true };
}

async function fileAccess(ctx: Context<AppState>, file: ProjectFileRow): Promise<FileAccess> {
	const member = Permissions.member(ctx);
	const username = Auth.account(ctx).username;
	const chatLink = await chatFileOf(file.uuid);
	if (chatLink) return await chatFileAccess(ctx, file, chatLink.conversation);
	const linked = await ticketLinked(file.uuid);
	if (Permissions.has(member, Permission.PROJECT_EDIT)) return { view: true, remove: true, linked, chat: false };

	const own = file.created_by === username;
	let view = own || (linked && Permissions.has(member, Permission.TICKET_VIEW));
	let remove = own || (linked && Permissions.has(member, Permission.TICKET_MANAGE));
	if (file.explorer && Permissions.has(member, Permission.FILE_USE)) {
		const explorer = await fileView(file, username);
		view ||= explorer.view;
		remove ||= explorer.manages;
	}
	return { view, remove: remove && view, linked, chat: false };
}

function megabytesToBytes(value: unknown): number | null | undefined {
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) return undefined;
	return value * FILE_MB_BYTES;
}

function downloadKey(token: string): string {
	return `file-download:${token}`;
}

Server.app.post(`${base}/tickets/:ticket/files`, Auth.required(), Permissions.require(Permission.TICKET_WORK), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	if (!Validate.uuid(ctx.params.ticket)) return Utils.fail(ctx, ErrorCode.TICKET_NOT_FOUND);
	const [ticket] = (await Database`SELECT * FROM tickets WHERE uuid = ${ctx.params.ticket} AND project = ${project.uuid}`) as TicketRow[];
	if (!ticket) return Utils.fail(ctx, ErrorCode.TICKET_NOT_FOUND);
	const request = readFileRequest(await body(ctx));
	if (!request) return Utils.fail(ctx, ErrorCode.INVALID_FILE);
	if (request.size > maxFileBytes(project)) return Utils.fail(ctx, ErrorCode.FILE_TOO_LARGE);
	if (!(await hasFileStorageCapacity(project.uuid, request.size))) return Utils.fail(ctx, ErrorCode.FILE_STORAGE_LIMIT_REACHED);

	const file = await beginUpload(project.uuid, request, Auth.account(ctx).username);
	await Database`INSERT INTO ticket_files(ticket, file, created) VALUES(${ticket.uuid}, ${file.uuid}, ${Date.now()})`;
	return Utils.ok(ctx, { ...presentFile(file), parts: Number(file.parts), part_bytes: FILE_PART_BYTES }, 201);
});

Server.app.put(`${base}/files/:file/parts/:index`, partBody, Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const file = await requestedFile(ctx);
	if (!file) return Utils.fail(ctx, ErrorCode.FILE_NOT_FOUND);
	if (file.created_by !== Auth.account(ctx).username) return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);
	const index = /^\d{1,9}$/.test(ctx.params.index) ? Number(ctx.params.index) : -1;
	const bytes = new Uint8Array(await ctx.req.arrayBuffer());
	if (!acceptsPart(file, index, bytes.length)) return Utils.fail(ctx, ErrorCode.INVALID_FILE_PART);

	const stored = await storePart(file, index, bytes);
	if (stored.status === "ready" && file.status !== "ready") {
		const links = (await Database`SELECT ticket FROM ticket_files WHERE file = ${file.uuid}`) as { ticket: string }[];
		for (const link of links) {
			await Database`UPDATE tickets SET updated = ${Date.now()} WHERE uuid = ${link.ticket}`;
			await Audit.record(ctx, {
				project: project.uuid,
				action: "ticket.file_attached",
				entityType: "ticket",
				entityId: link.ticket,
				newValue: { file: file.uuid, file_name: file.file_name, byte_size: Number(file.byte_size) },
			});
		}
	}
	return await okWithNames(ctx, presentFile(stored));
});

Server.app.get(`${base}/files`, Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();
	const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);
	const sort = query.get("sort") ?? "size";
	if (!FILE_SORTS.includes(sort as (typeof FILE_SORTS)[number])) return Utils.fail(ctx, ErrorCode.INVALID_FILE);
	const orderBy = sort === "size" ? Database`byte_size DESC, created DESC, uuid ASC` : Database`created DESC, uuid ASC`;

	const rows = (await Database`
		SELECT * FROM project_files WHERE project = ${project.uuid} AND removed_at IS NULL AND status = 'ready'
		ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}
	`) as ProjectFileRow[];
	const [total] = (await Database`
		SELECT COUNT(*) AS count FROM project_files WHERE project = ${project.uuid} AND removed_at IS NULL AND status = 'ready'
	`) as { count: number }[];
	const links = rows.length
		? ((await Database`
				SELECT tf.file, t.uuid, t.number, t.title FROM ticket_files tf JOIN tickets t ON t.uuid = tf.ticket
				WHERE tf.file IN ${Database(rows.map((row) => row.uuid))} ORDER BY t.number ASC
			`) as (Pick<TicketRow, "uuid" | "number" | "title"> & { file: string })[])
		: [];
	const folders = rows.some((row) => row.explorer) ? await projectFolders(project.uuid) : [];
	const chatRows = rows.length
		? ((await Database`SELECT file FROM chat_files WHERE file IN ${Database(rows.map((row) => row.uuid))}`) as { file: string }[])
		: [];
	const inChat = new Set(chatRows.map((row) => row.file));
	return await okWithNames(ctx, {
		files: rows.map((row) => ({
			...presentFile(inChat.has(row.uuid) ? { ...row, file_name: "", content_type: FALLBACK_CONTENT_TYPE } : row),
			chat: inChat.has(row.uuid),
			tickets: links.filter((link) => link.file === row.uuid).map((link) => ({ uuid: link.uuid, number: link.number, title: link.title })),
			location: row.explorer ? pathNames(folders, row.folder) : null,
		})),
		total: Number(total.count),
		limit,
		offset,
		...fileLimits(project),
		...(await fileStorageFor(project.uuid)),
	});
});

Server.app.put(`${base}/files/settings`, Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const data = await body(ctx);
	const megabytes = data?.max_file_mb ?? Math.floor(maxFileBytes(project) / FILE_MB_BYTES);
	if (typeof megabytes !== "number" || !Number.isSafeInteger(megabytes) || megabytes < 1 || megabytes * FILE_MB_BYTES > fileSizeCeiling()) {
		return Utils.fail(ctx, ErrorCode.INVALID_FILE_SETTINGS);
	}
	const perMember = data?.max_member_file_mb === undefined ? project.max_member_file_bytes : megabytesToBytes(data.max_member_file_mb);
	if (perMember === undefined) return Utils.fail(ctx, ErrorCode.INVALID_FILE_SETTINGS);
	const bytes = megabytes * FILE_MB_BYTES;
	await Database`UPDATE projects SET max_file_bytes = ${bytes}, max_member_file_bytes = ${perMember}, updated = ${Date.now()} WHERE uuid = ${project.uuid}`;
	await Audit.record(ctx, {
		project: project.uuid,
		action: "file.settings_updated",
		entityType: "project",
		entityId: project.uuid,
		oldValue: { max_file_bytes: maxFileBytes(project), max_member_file_bytes: project.max_member_file_bytes },
		newValue: { max_file_bytes: bytes, max_member_file_bytes: perMember },
	});
	return Utils.ok(ctx, fileLimits({ ...project, max_file_bytes: bytes, max_member_file_bytes: perMember }));
});

function usesFiles(member: ProjectMemberRow): boolean {
	return Permissions.has(member, Permission.FILE_USE);
}

Server.app.get(`${base}/file-limits`, Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const members = (
		(await Database`
			SELECT * FROM project_members WHERE project_id = ${project.uuid} AND status = 'active' AND account_username IS NOT NULL
		`) as ProjectMemberRow[]
	).filter(usesFiles);
	const overrides = (await Database`SELECT account, max_bytes FROM file_member_limits WHERE project = ${project.uuid}`) as {
		account: string;
		max_bytes: number;
	}[];
	const names = await accountNames(
		members.map((member) => member.account_username),
		project.uuid
	);
	const people = [];
	for (const member of members) {
		const username = member.account_username!;
		const override = overrides.find((row) => row.account === username);
		people.push({
			username,
			name: names.get(username) ?? username,
			used: await memberFileUsage(project.uuid, username),
			max_bytes: override ? Number(override.max_bytes) : null,
		});
	}
	return Utils.ok(ctx, { people: people.sort((first, second) => second.used - first.used || first.name.localeCompare(second.name)), ...fileLimits(project) });
});

Server.app.put(`${base}/file-limits/:username`, Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const username = ctx.params.username;
	const [member] = await Database`
		SELECT uuid FROM project_members WHERE project_id = ${project.uuid} AND account_username = ${username} AND status = 'active'
	`;
	if (!member) return Utils.fail(ctx, ErrorCode.EMPLOYEE_NOT_FOUND);
	const bytes = megabytesToBytes((await body(ctx))?.max_mb);
	if (bytes === undefined) return Utils.fail(ctx, ErrorCode.INVALID_FILE_SETTINGS);
	await Database.begin(async (tx) => {
		await tx`DELETE FROM file_member_limits WHERE project = ${project.uuid} AND account = ${username}`;
		if (bytes !== null) await tx`INSERT INTO file_member_limits(project, account, max_bytes) VALUES(${project.uuid}, ${username}, ${bytes})`;
	});
	await Audit.record(ctx, {
		project: project.uuid,
		action: "file.member_limit_updated",
		entityType: "project",
		entityId: project.uuid,
		newValue: { username, max_bytes: bytes },
	});
	return Utils.ok(ctx, { username, max_bytes: bytes });
});

Server.app.get(`${base}/files/:file`, Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const file = await requestedFile(ctx);
	if (!file || file.status !== "ready" || !(await fileAccess(ctx, file)).view) return Utils.fail(ctx, ErrorCode.FILE_NOT_FOUND);
	if (file.removed_at !== null) return Utils.fail(ctx, ErrorCode.FILE_REMOVED);
	return fileResponse(file);
});

Server.app.post(`${base}/files/:file/link`, Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const file = await requestedFile(ctx);
	if (!file || file.status !== "ready" || !(await fileAccess(ctx, file)).view) return Utils.fail(ctx, ErrorCode.FILE_NOT_FOUND);
	if (file.removed_at !== null) return Utils.fail(ctx, ErrorCode.FILE_REMOVED);
	const inline = (await body(ctx))?.inline === true && isPlayableVideo(file);
	const seconds = inline ? PLAYBACK_LINK_SECONDS : DOWNLOAD_LINK_SECONDS;
	const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
	await Cache.setString(downloadKey(token), JSON.stringify({ project: file.project, file: file.uuid, inline, seconds }), seconds, seconds);
	return Utils.ok(ctx, { path: `/api/v1/file-downloads/${token}`, expires_in: seconds });
});

Server.app.get("/api/v1/file-downloads/:token", async (ctx) => {
	const stored = DOWNLOAD_TOKEN.test(ctx.params.token) ? await Cache.getString(downloadKey(ctx.params.token), DOWNLOAD_LINK_SECONDS) : null;
	if (!stored) return Utils.fail(ctx, ErrorCode.FILE_NOT_FOUND);
	const link = JSON.parse(stored) as { project: string; file: string; inline: boolean; seconds: number };
	const file = await findFile(link.project, link.file);
	if (!file || file.status !== "ready") return Utils.fail(ctx, ErrorCode.FILE_NOT_FOUND);
	if (file.removed_at !== null) return Utils.fail(ctx, ErrorCode.FILE_REMOVED);
	if (link.inline) await Cache.setString(downloadKey(ctx.params.token), stored, link.seconds, link.seconds);
	return fileResponse(file, { range: ctx.req.headers.get("range"), inline: link.inline });
});

Server.app.delete(`${base}/files/:file`, Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const file = await requestedFile(ctx);
	if (!file) return Utils.fail(ctx, ErrorCode.FILE_NOT_FOUND);
	const account = Auth.account(ctx);
	const access = await fileAccess(ctx, file);
	if (!access.view && !access.remove) return Utils.fail(ctx, ErrorCode.FILE_NOT_FOUND);
	if (!access.remove) return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);
	const visible = access.view ? file : { ...file, file_name: "", content_type: FALLBACK_CONTENT_TYPE };
	if (file.removed_at !== null) return Utils.fail(ctx, ErrorCode.FILE_REMOVED);
	if (file.status === "uploading" || (access.chat && (await chatFileOf(file.uuid))?.message === null)) {
		await discardFiles([file]);
		return Utils.ok(ctx);
	}
	if (!access.linked) {
		await dropFromExplorer([file], account.username);
		await Audit.record(ctx, {
			project: project.uuid,
			action: "file.removed",
			entityType: "file",
			entityId: file.uuid,
			oldValue: { file_name: file.file_name, byte_size: Number(file.byte_size), created_by: file.created_by },
		});
		return await okWithNames(ctx, { ...presentFile(file), removed: true, removed_by: account.username, removed_at: Date.now() });
	}

	const removed = await removeFile(file, account.username);
	if (!removed) return Utils.fail(ctx, ErrorCode.FILE_REMOVED);
	await Audit.record(ctx, {
		project: project.uuid,
		action: access.chat ? "file.chat_attachment_removed" : "file.removed",
		entityType: "file",
		entityId: file.uuid,
		oldValue: { file_name: access.chat ? null : file.file_name, byte_size: Number(file.byte_size), created_by: file.created_by },
	});
	if (access.chat) await announceFileChange(file.uuid);
	return await okWithNames(ctx, presentFile({ ...visible, removed_at: removed.removed_at, removed_by: removed.removed_by }));
});
