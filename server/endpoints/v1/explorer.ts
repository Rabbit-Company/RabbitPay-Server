import type { Context } from "@rabbit-company/web";
import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import { okWithNames } from "../../accounts";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { fileStorageFor, hasFileStorageCapacity } from "../../licensing";
import { beginUpload, fileNameOf, maxFileBytes, presentFile, readFileRequest } from "../../files";
import { FILE_PART_BYTES } from "../../file-limits";
import {
	deleteFolder,
	depthBelow,
	everyonesTop,
	explorerTop,
	fileOwners,
	fileMembers,
	fileView,
	findFolder,
	FOLDER_ACCESS,
	folderNameOf,
	foldersWithin,
	folderView,
	MAX_FOLDER_DEPTH,
	MAX_FOLDER_MEMBERS,
	memberFileLimit,
	memberFileUsage,
	projectFolders,
	sharedWith,
	type FolderView,
} from "../../file-explorer";
import type { AppState, FileFolderRow, FolderAccess, ProjectFileRow } from "../../database/models";

const base = "/api/v1/projects/:uuid/explorer";
const uses = [Auth.required(), Permissions.require(Permission.FILE_USE)] as const;

interface Sharing {
	access: FolderAccess;
	members: string[];
}

async function body(ctx: Context<AppState>): Promise<Record<string, unknown> | null> {
	try {
		const value = await ctx.body<Record<string, unknown>>();
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

function isAdmin(ctx: Context<AppState>): boolean {
	return Permissions.has(Permissions.member(ctx), Permission.PROJECT_EDIT);
}

async function folderAt(ctx: Context<AppState>, uuid: unknown): Promise<FolderView | null> {
	if (typeof uuid !== "string" || !Validate.uuid(uuid)) return null;
	return await folderView(Permissions.project(ctx).uuid, uuid, Auth.account(ctx).username, isAdmin(ctx));
}

function presentFolder(folder: FileFolderRow, members: string[], manages: boolean) {
	return {
		uuid: folder.uuid,
		name: folder.name,
		parent: folder.parent,
		access: folder.access,
		members,
		created_by: folder.created_by,
		created: Number(folder.created),
		updated: Number(folder.updated),
		can_manage: manages,
	};
}

function presentExplorerFile(file: ProjectFileRow, members: string[], manages: boolean) {
	return { ...presentFile(file), folder: file.folder, access: file.access, members, can_manage: manages };
}

async function activeAccounts(projectId: string, usernames: string[]): Promise<string[]> {
	if (usernames.length === 0) return [];
	const rows = (await Database`
		SELECT account_username FROM project_members
		WHERE project_id = ${projectId} AND status = 'active' AND account_username IN ${Database(usernames)} ORDER BY account_username ASC
	`) as { account_username: string }[];
	return rows.map((row) => row.account_username);
}

async function readSharing(projectId: string, data: Record<string, unknown>, current: Sharing): Promise<Sharing | null | undefined> {
	if (data.access === undefined && data.members === undefined) return undefined;
	if (data.access !== undefined && !FOLDER_ACCESS.includes(data.access as FolderAccess)) return null;
	const access = (data.access as FolderAccess | undefined) ?? current.access;
	const wanted = data.members ?? (access === "members" ? current.members : []);
	if (!Array.isArray(wanted) || wanted.length > MAX_FOLDER_MEMBERS || !wanted.every((entry) => typeof entry === "string")) return null;
	return { access, members: access === "members" ? await activeAccounts(projectId, [...new Set(wanted as string[])]) : [] };
}

const SCOPES = ["shared", "all"] as const;
type Scope = (typeof SCOPES)[number];
const NO_OWNER = "-";

function ownerKey(username: string | null): string {
	return username ?? NO_OWNER;
}

Server.app.get(base, ...uses, async (ctx) => {
	const project = Permissions.project(ctx);
	const username = Auth.account(ctx).username;
	const admin = isAdmin(ctx);
	const query = ctx.query();
	const requested = query.get("folder");
	const scope = query.get("scope") as Scope | null;
	const ownerFilter = query.get("owner");
	if (scope !== null && (!SCOPES.includes(scope) || (scope === "all" && !admin))) return Utils.fail(ctx, ErrorCode.FOLDER_NOT_FOUND);
	const view = requested === null ? null : await folderAt(ctx, requested);
	if (requested !== null && !view) return Utils.fail(ctx, ErrorCode.FOLDER_NOT_FOUND);

	let folders: ReturnType<typeof presentFolder>[] = [];
	let files: ReturnType<typeof presentExplorerFile>[] = [];
	let people: { username: string; name: string | null; email: string | null; items: number }[] | null = null;
	let origin: { scope: Scope; owner: { username: string; name: string | null; email: string | null } } | null = null;
	let path = view?.path ?? [];
	let sharedPeople = 0;
	let everyonePeople: number | null = null;

	if (view) {
		const children = (await Database`
			SELECT * FROM file_folders WHERE project = ${project.uuid} AND parent = ${view.folder.uuid} ORDER BY name ASC, uuid ASC
		`) as FileFolderRow[];
		const inside = (await Database`
			SELECT * FROM project_files WHERE project = ${project.uuid} AND explorer = 1 AND status = 'ready' AND removed_at IS NULL
				AND folder = ${view.folder.uuid} ORDER BY file_name ASC, uuid ASC
		`) as ProjectFileRow[];
		const childShared = await sharedWith(children.map((child) => child.uuid));
		const insideShared = await fileMembers(inside.map((file) => file.uuid));
		folders = children.map((child) => presentFolder(child, childShared.get(child.uuid) ?? [], view.manages || child.created_by === username));
		files = inside.map((file) => presentExplorerFile(file, insideShared.get(file.uuid) ?? [], view.manages || file.created_by === username));

		const own = admin ? await folderView(project.uuid, view.folder.uuid, username) : view;
		path = own?.path ?? view.fullPath;
		if (path[0].created_by !== username) {
			const owner = (await fileOwners(project.uuid, [path[0].created_by])).get(path[0].created_by)!;
			origin = { scope: own ? "shared" : "all", owner: { ...owner, username: ownerKey(owner.username) } };
		}
	} else {
		const top = await explorerTop(project.uuid, username, admin);
		const everyone = admin ? await everyonesTop(project.uuid, username) : null;
		const sharedFolders = top.folders.filter((folder) => folder.created_by !== username);
		const sharedFiles = top.files.filter((file) => file.created_by !== username);
		sharedPeople = new Set([...sharedFolders, ...sharedFiles].map((item) => item.created_by)).size;
		everyonePeople = everyone ? new Set([...everyone.folders, ...everyone.files].map((item) => item.created_by)).size : null;

		const listed =
			scope === "shared"
				? { folders: sharedFolders, files: sharedFiles }
				: scope === "all"
					? everyone!
					: { folders: top.folders.filter((folder) => folder.created_by === username), files: top.files.filter((file) => file.created_by === username) };
		const owners =
			scope === null
				? null
				: await fileOwners(
						project.uuid,
						[...listed.folders, ...listed.files].map((item) => item.created_by)
					);

		if (scope !== null && ownerFilter === null) {
			people = [...owners!.values()]
				.map((owner) => ({
					...owner,
					username: ownerKey(owner.username),
					items: [...listed.folders, ...listed.files].filter((item) => item.created_by === owner.username).length,
				}))
				.sort((first, second) => (first.name ?? first.email ?? "").localeCompare(second.name ?? second.email ?? ""));
		} else {
			const wanted = ownerFilter === NO_OWNER ? null : ownerFilter;
			const ofOwner = <Item extends { created_by: string | null }>(items: Item[]) =>
				scope === null ? items : items.filter((item) => item.created_by === wanted);
			if (scope !== null) {
				const owner = owners!.get(wanted);
				if (!owner) return Utils.fail(ctx, ErrorCode.FOLDER_NOT_FOUND);
				origin = { scope, owner: { ...owner, username: ownerKey(owner.username) } };
			}
			const fileShared = scope === "all" ? await fileMembers(listed.files.map((file) => file.uuid)) : top.fileShared;
			folders = ofOwner(listed.folders).map((folder) => presentFolder(folder, top.shared.get(folder.uuid) ?? [], top.owned.has(folder.uuid)));
			files = ofOwner(listed.files).map((file) => presentExplorerFile(file, fileShared.get(file.uuid) ?? [], admin || file.created_by === username));
		}
	}
	const storage = await fileStorageFor(project.uuid);

	return await okWithNames(ctx, {
		folder: view ? presentFolder(view.folder, view.shared.get(view.folder.uuid) ?? [], view.manages) : null,
		scope: view ? null : scope,
		origin,
		people,
		shared_people: sharedPeople,
		everyone_people: everyonePeople,
		path: path.map((step) => ({ uuid: step.uuid, name: step.name })),
		sharing: view
			? view.path
					.filter((step) => step.access !== "private")
					.map((step) => ({ uuid: step.uuid, name: step.name, access: step.access, members: view.shared.get(step.uuid) ?? [] }))
			: [],
		folders,
		files,
		used: await memberFileUsage(project.uuid, username),
		limit: await memberFileLimit(project, username),
		file_storage_remaining: storage.file_storage_remaining,
		max_file_bytes: maxFileBytes(project),
	});
});

Server.app.get(`${base}/folders`, ...uses, async (ctx) => {
	const top = await explorerTop(Permissions.project(ctx).uuid, Auth.account(ctx).username, isAdmin(ctx));
	const byId = new Map(top.all.map((folder) => [folder.uuid, folder]));
	const pathOf = (folder: FileFolderRow): string[] => {
		const parent = folder.parent ? byId.get(folder.parent) : undefined;
		return parent && top.visible.has(parent.uuid) ? [...pathOf(parent), folder.name] : [folder.name];
	};
	return Utils.ok(
		ctx,
		top.all
			.filter((folder) => top.visible.has(folder.uuid))
			.map((folder) => ({ uuid: folder.uuid, parent: folder.parent, path: pathOf(folder) }))
			.sort((first, second) => first.path.join("/").localeCompare(second.path.join("/")))
	);
});

Server.app.post(`${base}/folders`, ...uses, async (ctx) => {
	const project = Permissions.project(ctx);
	const data = await body(ctx);
	const name = folderNameOf(data?.name);
	if (name === null) return Utils.fail(ctx, ErrorCode.INVALID_FOLDER);
	const parent = data?.parent === undefined || data.parent === null ? null : await folderAt(ctx, data.parent);
	if (data?.parent !== undefined && data.parent !== null && !parent) return Utils.fail(ctx, ErrorCode.FOLDER_NOT_FOUND);
	if (parent && parent.fullPath.length >= MAX_FOLDER_DEPTH) return Utils.fail(ctx, ErrorCode.INVALID_FOLDER_MOVE);

	const uuid = crypto.randomUUID();
	const now = Date.now();
	await Database`
		INSERT INTO file_folders(uuid, project, parent, name, access, created_by, created, updated)
		VALUES(${uuid}, ${project.uuid}, ${parent?.folder.uuid ?? null}, ${name}, 'private', ${Auth.account(ctx).username}, ${now}, ${now})
	`;
	return await okWithNames(ctx, presentFolder((await findFolder(project.uuid, uuid))!, [], true), 201);
});

Server.app.patch(`${base}/folders/:folder`, ...uses, async (ctx) => {
	const project = Permissions.project(ctx);
	const view = await folderAt(ctx, ctx.params.folder);
	if (!view) return Utils.fail(ctx, ErrorCode.FOLDER_NOT_FOUND);
	const data = await body(ctx);
	if (!data) return Utils.fail(ctx, ErrorCode.INVALID_FOLDER);
	if (!view.manages) return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);

	const name = data.name === undefined ? view.folder.name : folderNameOf(data.name);
	if (name === null) return Utils.fail(ctx, ErrorCode.INVALID_FOLDER);

	let parent = view.folder.parent;
	if (data.parent !== undefined && data.parent !== view.folder.parent) {
		if (data.parent === null) parent = null;
		else {
			const target = await folderAt(ctx, data.parent);
			if (!target) return Utils.fail(ctx, ErrorCode.FOLDER_NOT_FOUND);
			const folders = await projectFolders(project.uuid);
			if (foldersWithin(folders, view.folder.uuid).includes(target.folder.uuid)) return Utils.fail(ctx, ErrorCode.INVALID_FOLDER_MOVE);
			if (target.fullPath.length + 1 + depthBelow(folders, view.folder.uuid) > MAX_FOLDER_DEPTH) return Utils.fail(ctx, ErrorCode.INVALID_FOLDER_MOVE);
			parent = target.folder.uuid;
		}
	}

	const current = { access: view.folder.access, members: view.shared.get(view.folder.uuid) ?? [] };
	const sharing = await readSharing(project.uuid, data, current);
	if (sharing === null) return Utils.fail(ctx, ErrorCode.INVALID_FOLDER);
	const next = sharing ?? current;

	await Database.begin(async (tx) => {
		await tx`UPDATE file_folders SET name = ${name}, parent = ${parent}, access = ${next.access}, updated = ${Date.now()} WHERE uuid = ${view.folder.uuid}`;
		if (sharing) {
			await tx`DELETE FROM file_folder_members WHERE folder = ${view.folder.uuid}`;
			for (const account of sharing.members) await tx`INSERT INTO file_folder_members(folder, account) VALUES(${view.folder.uuid}, ${account})`;
		}
	});
	if (sharing) {
		await Audit.record(ctx, {
			project: project.uuid,
			action: "folder.shared",
			entityType: "folder",
			entityId: view.folder.uuid,
			oldValue: current,
			newValue: sharing,
		});
	}
	return await okWithNames(ctx, presentFolder({ ...view.folder, name, parent, access: next.access }, next.members, true));
});

Server.app.delete(`${base}/folders/:folder`, ...uses, async (ctx) => {
	const project = Permissions.project(ctx);
	const view = await folderAt(ctx, ctx.params.folder);
	if (!view) return Utils.fail(ctx, ErrorCode.FOLDER_NOT_FOUND);
	if (!view.manages) return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);
	const files = await deleteFolder(view.folder, Auth.account(ctx).username);
	await Audit.record(ctx, {
		project: project.uuid,
		action: "folder.deleted",
		entityType: "folder",
		entityId: view.folder.uuid,
		oldValue: { name: view.folder.name, path: view.fullPath.map((step) => step.name), files },
	});
	return Utils.ok(ctx, { files });
});

Server.app.post(`${base}/files`, ...uses, async (ctx) => {
	const project = Permissions.project(ctx);
	const username = Auth.account(ctx).username;
	const data = await body(ctx);
	const request = readFileRequest(data);
	if (!request) return Utils.fail(ctx, ErrorCode.INVALID_FILE);
	const folder = data?.folder === undefined || data.folder === null ? null : await folderAt(ctx, data.folder);
	if (data?.folder !== undefined && data.folder !== null && !folder) return Utils.fail(ctx, ErrorCode.FOLDER_NOT_FOUND);
	if (request.size > maxFileBytes(project)) return Utils.fail(ctx, ErrorCode.FILE_TOO_LARGE);
	const limit = await memberFileLimit(project, username);
	if (limit !== null && (await memberFileUsage(project.uuid, username)) + request.size > limit) {
		return Utils.fail(ctx, ErrorCode.FILE_MEMBER_LIMIT_REACHED);
	}
	if (!(await hasFileStorageCapacity(project.uuid, request.size))) return Utils.fail(ctx, ErrorCode.FILE_STORAGE_LIMIT_REACHED);

	const file = await beginUpload(project.uuid, request, username, { explorer: true, folder: folder?.folder.uuid ?? null });
	return Utils.ok(ctx, { ...presentFile(file), parts: Number(file.parts), part_bytes: FILE_PART_BYTES }, 201);
});

Server.app.patch(`${base}/files/:file`, ...uses, async (ctx) => {
	const project = Permissions.project(ctx);
	const username = Auth.account(ctx).username;
	if (!Validate.uuid(ctx.params.file)) return Utils.fail(ctx, ErrorCode.FILE_NOT_FOUND);
	const [file] = (await Database`
		SELECT * FROM project_files WHERE uuid = ${ctx.params.file} AND project = ${project.uuid} AND explorer = 1 AND status = 'ready' AND removed_at IS NULL
	`) as ProjectFileRow[];
	if (!file) return Utils.fail(ctx, ErrorCode.FILE_NOT_FOUND);
	const access = await fileView(file, username, isAdmin(ctx));
	if (!access.view) return Utils.fail(ctx, ErrorCode.FILE_NOT_FOUND);
	if (!access.manages) return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);

	const data = await body(ctx);
	const name = data?.name === undefined ? file.file_name : fileNameOf(data.name);
	if (!data || name === null) return Utils.fail(ctx, ErrorCode.INVALID_FILE);
	let folder = file.folder;
	if (data.folder !== undefined && data.folder !== file.folder) {
		if (data.folder === null) {
			if (file.created_by !== username) return Utils.fail(ctx, ErrorCode.INSUFFICIENT_PERMISSIONS);
			folder = null;
		} else {
			const target = await folderAt(ctx, data.folder);
			if (!target) return Utils.fail(ctx, ErrorCode.FOLDER_NOT_FOUND);
			folder = target.folder.uuid;
		}
	}
	const current = { access: file.access, members: access.members };
	const sharing = await readSharing(project.uuid, data, current);
	if (sharing === null) return Utils.fail(ctx, ErrorCode.INVALID_FOLDER);
	const next = sharing ?? current;

	await Database.begin(async (tx) => {
		await tx`UPDATE project_files SET file_name = ${name}, folder = ${folder}, access = ${next.access} WHERE uuid = ${file.uuid}`;
		if (sharing) {
			await tx`DELETE FROM file_members WHERE file = ${file.uuid}`;
			for (const account of sharing.members) await tx`INSERT INTO file_members(file, account) VALUES(${file.uuid}, ${account})`;
		}
	});
	if (sharing) {
		await Audit.record(ctx, {
			project: project.uuid,
			action: "file.shared",
			entityType: "file",
			entityId: file.uuid,
			oldValue: current,
			newValue: sharing,
		});
	}
	return await okWithNames(ctx, presentExplorerFile({ ...file, file_name: name, folder, access: next.access }, next.members, true));
});
