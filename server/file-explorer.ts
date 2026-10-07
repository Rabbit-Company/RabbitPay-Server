import Database from "./database/database";
import { discardFiles, removeFile } from "./files";
import type { FileFolderRow, FolderAccess, ProjectFileRow, ProjectRow } from "./database/models";

export const FOLDER_ACCESS: FolderAccess[] = ["private", "everyone", "members"];
export const MAX_FOLDER_DEPTH = 20;
export const MAX_FOLDER_NAME_LENGTH = 120;
export const MAX_FOLDER_MEMBERS = 500;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface FolderView {
	folder: FileFolderRow;
	path: FileFolderRow[];
	fullPath: FileFolderRow[];
	shared: Map<string, string[]>;
	manages: boolean;
}

export interface FileView {
	view: boolean;
	manages: boolean;
	members: string[];
	folder: FolderView | null;
}

interface Shareable {
	created_by: string | null;
	access: FolderAccess;
}

export function folderNameOf(value: unknown): string | null {
	if (typeof value !== "string" || CONTROL_CHARACTERS.test(value) || /[\\/]/.test(value)) return null;
	const name = value.trim();
	return name && name.length <= MAX_FOLDER_NAME_LENGTH ? name : null;
}

export async function findFolder(projectId: string, uuid: string): Promise<FileFolderRow | null> {
	const [folder] = (await Database`SELECT * FROM file_folders WHERE uuid = ${uuid} AND project = ${projectId}`) as FileFolderRow[];
	return folder ?? null;
}

export async function folderPath(folder: FileFolderRow): Promise<FileFolderRow[]> {
	const path = [folder];
	while (path[0].parent !== null && path.length <= MAX_FOLDER_DEPTH + 1) {
		const parent = await findFolder(folder.project, path[0].parent);
		if (!parent) break;
		path.unshift(parent);
	}
	return path;
}

export async function sharedWith(folderIds: string[]): Promise<Map<string, string[]>> {
	const shared = new Map<string, string[]>();
	if (folderIds.length === 0) return shared;
	const rows = (await Database`SELECT folder, account FROM file_folder_members WHERE folder IN ${Database(folderIds)} ORDER BY account ASC`) as {
		folder: string;
		account: string;
	}[];
	for (const row of rows) shared.set(row.folder, [...(shared.get(row.folder) ?? []), row.account]);
	return shared;
}

export function reaches(item: Shareable, members: string[], username: string): boolean {
	if (item.created_by === username || item.access === "everyone") return true;
	return item.access === "members" && members.includes(username);
}

export async function folderView(projectId: string, uuid: string, username: string, seesAll = false): Promise<FolderView | null> {
	const folder = await findFolder(projectId, uuid);
	if (!folder) return null;
	const fullPath = await folderPath(folder);
	const shared = await sharedWith(fullPath.map((step) => step.uuid));
	const first = seesAll ? 0 : fullPath.findIndex((step) => reaches(step, shared.get(step.uuid) ?? [], username));
	if (first < 0) return null;
	return { folder, path: fullPath.slice(first), fullPath, shared, manages: seesAll || fullPath.some((step) => step.created_by === username) };
}

export async function fileMembers(fileIds: string[]): Promise<Map<string, string[]>> {
	const members = new Map<string, string[]>();
	if (fileIds.length === 0) return members;
	const rows = (await Database`SELECT file, account FROM file_members WHERE file IN ${Database(fileIds)} ORDER BY account ASC`) as {
		file: string;
		account: string;
	}[];
	for (const row of rows) members.set(row.file, [...(members.get(row.file) ?? []), row.account]);
	return members;
}

export async function fileView(file: ProjectFileRow, username: string, seesAll = false): Promise<FileView> {
	const members = (await fileMembers([file.uuid])).get(file.uuid) ?? [];
	const folder = file.folder === null ? null : await folderView(file.project, file.folder, username, seesAll);
	const own = file.created_by === username;
	return {
		view: seesAll || folder !== null || reaches(file, members, username),
		manages: seesAll || own || (folder?.manages ?? false),
		members,
		folder,
	};
}

export interface ExplorerTop {
	folders: FileFolderRow[];
	files: ProjectFileRow[];
	shared: Map<string, string[]>;
	fileShared: Map<string, string[]>;
	visible: Set<string>;
	owned: Set<string>;
	all: FileFolderRow[];
}

export async function explorerTop(projectId: string, username: string, seesAll = false): Promise<ExplorerTop> {
	const all = await projectFolders(projectId);
	const byId = new Map(all.map((folder) => [folder.uuid, folder]));
	const shared = await sharedWith(all.map((folder) => folder.uuid));
	const reached = new Set<string>();
	const owned = new Set<string>();
	const settle = (folder: FileFolderRow, depth = 0): void => {
		const parent = folder.parent && depth <= MAX_FOLDER_DEPTH ? byId.get(folder.parent) : undefined;
		if (parent && !reached.has(parent.uuid) && !owned.has(parent.uuid)) settle(parent, depth + 1);
		if (reaches(folder, shared.get(folder.uuid) ?? [], username) || (parent && reached.has(parent.uuid))) reached.add(folder.uuid);
		if (seesAll || folder.created_by === username || (parent && owned.has(parent.uuid))) owned.add(folder.uuid);
	};
	for (const folder of all) settle(folder);
	const visible = seesAll ? new Set(all.map((folder) => folder.uuid)) : reached;

	const candidates = (await Database`
		SELECT * FROM project_files WHERE project = ${projectId} AND explorer = 1 AND status = 'ready' AND removed_at IS NULL
			AND (created_by = ${username} OR access != 'private') ORDER BY file_name ASC, uuid ASC
	`) as ProjectFileRow[];
	const fileShared = await fileMembers(candidates.map((file) => file.uuid));
	return {
		folders: all.filter((folder) => reached.has(folder.uuid) && (folder.parent === null || !reached.has(folder.parent))),
		files: candidates.filter((file) => (file.folder === null || !reached.has(file.folder)) && reaches(file, fileShared.get(file.uuid) ?? [], username)),
		shared,
		fileShared,
		visible,
		owned,
		all,
	};
}

export interface FileOwner {
	username: string | null;
	name: string | null;
	email: string | null;
}

export async function fileOwners(projectId: string, usernames: (string | null)[]): Promise<Map<string | null, FileOwner>> {
	const owners = new Map<string | null, FileOwner>();
	const wanted = [...new Set(usernames.filter((username): username is string => username !== null))];
	if (usernames.includes(null)) owners.set(null, { username: null, name: null, email: null });
	if (wanted.length === 0) return owners;
	const rows = (await Database`
		SELECT a.username, a.email, pm.full_name FROM accounts a
		LEFT JOIN project_members pm ON pm.account_username = a.username AND pm.project_id = ${projectId}
		WHERE a.username IN ${Database(wanted)}
	`) as { username: string; email: string; full_name: string | null }[];
	for (const row of rows) owners.set(row.username, { username: row.username, name: row.full_name?.trim() || null, email: row.email });
	return owners;
}

export async function everyonesTop(projectId: string, username: string): Promise<{ folders: FileFolderRow[]; files: ProjectFileRow[] }> {
	const folders = (await Database`
		SELECT * FROM file_folders WHERE project = ${projectId} AND parent IS NULL AND (created_by IS NULL OR created_by != ${username})
		ORDER BY name ASC, uuid ASC
	`) as FileFolderRow[];
	const files = (await Database`
		SELECT * FROM project_files WHERE project = ${projectId} AND explorer = 1 AND status = 'ready' AND removed_at IS NULL AND folder IS NULL
			AND (created_by IS NULL OR created_by != ${username}) ORDER BY file_name ASC, uuid ASC
	`) as ProjectFileRow[];
	return { folders, files };
}

export async function projectFolders(projectId: string): Promise<FileFolderRow[]> {
	return (await Database`SELECT * FROM file_folders WHERE project = ${projectId} ORDER BY name ASC, uuid ASC`) as FileFolderRow[];
}

export function foldersWithin(folders: FileFolderRow[], uuid: string): string[] {
	const within = [uuid];
	for (let index = 0; index < within.length; index++) {
		for (const folder of folders) if (folder.parent === within[index]) within.push(folder.uuid);
	}
	return within;
}

export function depthBelow(folders: FileFolderRow[], uuid: string): number {
	const children = folders.filter((folder) => folder.parent === uuid);
	return children.length === 0 ? 0 : 1 + Math.max(...children.map((child) => depthBelow(folders, child.uuid)));
}

export function pathNames(folders: FileFolderRow[], uuid: string | null): string[] {
	const byId = new Map(folders.map((folder) => [folder.uuid, folder]));
	const names: string[] = [];
	for (let current = uuid ? byId.get(uuid) : undefined; current && names.length <= MAX_FOLDER_DEPTH + 1; ) {
		names.unshift(current.name);
		current = current.parent ? byId.get(current.parent) : undefined;
	}
	return names;
}

export async function memberFileUsage(projectId: string, username: string): Promise<number> {
	const [row] = (await Database`
		SELECT COALESCE(SUM(byte_size), 0) AS used FROM project_files
		WHERE project = ${projectId} AND explorer = 1 AND removed_at IS NULL AND created_by = ${username}
	`) as { used: number }[];
	return Number(row.used);
}

export async function memberFileLimit(project: Pick<ProjectRow, "uuid" | "max_member_file_bytes">, username: string): Promise<number | null> {
	const [override] = (await Database`SELECT max_bytes FROM file_member_limits WHERE project = ${project.uuid} AND account = ${username}`) as {
		max_bytes: number;
	}[];
	if (override) return Number(override.max_bytes);
	return project.max_member_file_bytes === null ? null : Number(project.max_member_file_bytes);
}

export async function ticketLinked(fileId: string): Promise<boolean> {
	const [link] = await Database`SELECT ticket FROM ticket_files WHERE file = ${fileId} LIMIT 1`;
	return link !== undefined;
}

export async function dropFromExplorer(files: ProjectFileRow[], username: string) {
	const discarded: ProjectFileRow[] = [];
	for (const file of files) {
		if (await ticketLinked(file.uuid)) await removeFile(file, username);
		else discarded.push(file);
	}
	await discardFiles(discarded);
}

export async function deleteFolder(folder: FileFolderRow, username: string): Promise<number> {
	const within = foldersWithin(await projectFolders(folder.project), folder.uuid);
	const files = (await Database`SELECT * FROM project_files WHERE folder IN ${Database(within)}`) as ProjectFileRow[];
	await dropFromExplorer(files, username);
	await Database`DELETE FROM file_folders WHERE uuid = ${folder.uuid}`;
	return files.length;
}
